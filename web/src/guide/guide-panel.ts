/**
 * Guide panel -- DOM rendering for the Guide tab in the right sidebar.
 *
 * Shows a static graph overview (from static-analysis.ts): ranked lists
 * whose rows open a node's dependents by exact ID, a dependency levels
 * strip, and suggested queries that execute directly against the viewer state. No LLM
 * involved.
 */

import type {
  GraphSummary, SuggestedAction, GuideActions, GuideResult, GuideTransition, LevelStat, RankedList, StateAction,
} from './types';
import { NONE_INTENT, exactIntent, boundaryIntent } from '../intent';
import { escapeHtml } from '../html';
import { formatSummaryText } from './static-analysis';

export class GuidePanel {
  private actions: GuideActions;

  constructor(actions: GuideActions) {
    this.actions = actions;
    document.getElementById('tab-node-details')?.addEventListener('click', () => this.switchTab('node-details'));
    document.getElementById('tab-guide')?.addEventListener('click', () => this.switchTab('guide'));
  }

  switchTab(tab: 'node-details' | 'guide'): void {
    const nodeTab = document.getElementById('tab-node-details');
    const guideTab = document.getElementById('tab-guide');
    const nodePanel = document.getElementById('panel-node-details');
    const guidePanel = document.getElementById('panel-guide');

    if (!nodeTab || !guideTab || !nodePanel || !guidePanel) return;

    const showGuide = tab === 'guide';
    nodeTab.classList.toggle('active', !showGuide);
    guideTab.classList.toggle('active', showGuide);
    nodePanel.style.display = showGuide ? 'none' : '';
    guidePanel.style.display = showGuide ? '' : 'none';
  }

  renderSummary(summary: GraphSummary): void {
    const summaryEl = document.getElementById('guide-summary');
    const chipsEl = document.getElementById('guide-suggested-queries');
    if (!summaryEl || !chipsEl) return;

    summaryEl.textContent = formatSummaryText(summary);
    summaryEl.style.whiteSpace = 'pre-wrap';

    const lists = summary.rankingsSkipped !== null
      ? [rankingsSkippedSection(summary.rankingsSkipped)]
      : [
        this.rankedSection('Unfinished work', 'Unverified or failed, by unique transitive dependents', summary.unfinished),
        this.rankedSection('Assumptions', 'Axioms and trusted declarations, by unique transitive dependents', summary.assumptions),
        summary.keystonesAreLemmas
          ? this.rankedSection('Keystone lemmas', 'By unique transitive dependents', summary.keystones)
          : this.rankedSection('Most depended on', 'By unique transitive dependents', summary.keystones),
      ];
    document.getElementById('guide-answers')?.replaceChildren(...lists, levelsSection(summary.levels));

    chipsEl.innerHTML = '';
    for (const q of summary.suggestedQueries) {
      const chip = document.createElement('button');
      chip.className = 'guide-chip';
      chip.innerHTML = `<span class="chip-label">${escapeHtml(q.label)}</span><span class="chip-desc">${escapeHtml(q.description)}</span>`;
      chip.addEventListener('click', () => this.executeAction(q.action, q.label));
      chipsEl.appendChild(chip);
    }
  }

  /** A ranked list; each row opens the node's dependents by exact ID. */
  private rankedSection(title: string, description: string, list: RankedList): HTMLElement {
    const section = sectionElement(
      list.total > list.rows.length ? `${title} (top ${list.rows.length} of ${list.total})` : title,
      description,
    );
    const query = document.createElement('button');
    query.className = 'guide-query';
    query.textContent = 'query';
    query.title = `Put "${list.query}" into the search box`;
    query.addEventListener('click', () => this.executeAction({ type: 'fillSearch', query: list.query }, list.query));
    section.querySelector('.guide-section-title')!.append(' ', query);
    if (list.rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'guide-empty';
      empty.textContent = 'None among the shown declaration kinds.';
      section.appendChild(empty);
      return section;
    }
    for (const r of list.rows) {
      const row = document.createElement('button');
      row.className = 'guide-row';
      row.title = r.id;
      row.dataset.id = r.id;
      const name = document.createElement('span');
      name.className = 'guide-row-name';
      name.textContent = r.displayName;
      if (r.context) {
        const ctx = document.createElement('small');
        ctx.className = 'guide-row-context';
        ctx.textContent = r.context;
        name.append(' ', ctx);
      }
      const count = document.createElement('span');
      count.className = 'guide-row-count';
      count.textContent = String(r.transitiveDependentCount);
      count.title = `${r.transitiveDependentCount} unique transitive dependents`;
      row.append(name, count);
      const action: SuggestedAction = { type: 'setSink', id: r.id, label: r.displayName };
      row.addEventListener('click', () => this.executeAction(action, r.displayName));
      section.appendChild(row);
    }
    return section;
  }

  private executeAction(action: SuggestedAction, label: string): void {
    if (action.type === 'fillSearch') {
      this.actions.fillSearch(action.query);
      return;
    }
    // Stay on the Guide tab; the toast reports what the graph now shows
    const result = this.actions.apply(guideTransition(action, label));
    showToast(resultMessage(action, label, result));
  }
}

function sectionElement(title: string, description: string): HTMLElement {
  const section = document.createElement('section');
  section.className = 'guide-section';
  const heading = document.createElement('h3');
  heading.className = 'guide-section-title';
  heading.textContent = title;
  const desc = document.createElement('p');
  desc.className = 'guide-section-desc';
  desc.textContent = description;
  section.append(heading, desc);
  return section;
}

/** Replaces the ranked lists on graphs too large for dependent counts. */
function rankingsSkippedSection({ components, links }: { components: number; links: number }): HTMLElement {
  return sectionElement('Ranked lists',
    `Not computed: after merging cycles the graph has ${components.toLocaleString('en-US')} components `
    + `and ${links.toLocaleString('en-US')} links, above the size limit for counting dependents in the page.`);
}

const LEVEL_STATUSES = [
  ['transitivelyVerified', 'transitively-verified', 'transitively verified'],
  ['verified', 'verified', 'verified'],
  ['trusted', 'trusted', 'trusted'],
] as const;

/** Most rows the Dependency levels strip shows. The deeper levels share the last row. */
export const MAX_LEVEL_ROWS = 60;

export interface LevelRow {
  label: string;
  /** Level range, for the tooltip of a folded row; null for one level. */
  range: string | null;
  stat: LevelStat;
}

/**
 * The strip's rows: one per level, up to MAX_LEVEL_ROWS. A deeper graph
 * folds its top levels into the last row, so a long chain does not render
 * one row per node.
 */
export function levelRows(levels: LevelStat[]): LevelRow[] {
  const one = (stat: LevelStat): LevelRow => ({ label: `L${stat.level}`, range: null, stat });
  if (levels.length <= MAX_LEVEL_ROWS) return levels.map(one);
  const rest = levels.slice(MAX_LEVEL_ROWS - 1);
  const stat: LevelStat = { level: rest[0].level, nodes: 0, verified: 0, transitivelyVerified: 0, trusted: 0 };
  for (const l of rest) {
    stat.nodes += l.nodes;
    stat.verified += l.verified;
    stat.transitivelyVerified += l.transitivelyVerified;
    stat.trusted += l.trusted;
  }
  const last = rest[rest.length - 1].level;
  return [
    ...levels.slice(0, MAX_LEVEL_ROWS - 1).map(one),
    { label: `L${stat.level}+`, range: `Levels ${stat.level} to ${last}`, stat },
  ];
}

/** One row per topological level: node count and status shares. */
function levelsSection(levels: LevelStat[]): HTMLElement {
  const section = sectionElement('Dependency levels',
    'Level 0 holds the declarations that use nothing else in the project. Every other declaration '
    + 'sits one level above the highest one it uses, and a cycle counts as one. The bars show the '
    + 'transitively verified, verified and trusted share of each level. A low share near level 0 '
    + 'means that much of the project rests on unproven ground.');
  const strip = document.createElement('div');
  strip.className = 'guide-levels';
  for (const { label: text, range, stat } of levelRows(levels)) {
    const row = document.createElement('div');
    row.className = 'guide-level';
    row.dataset.level = String(stat.level);
    const label = document.createElement('span');
    label.className = 'guide-level-label';
    label.textContent = text;
    const count = document.createElement('span');
    count.className = 'guide-level-count';
    count.textContent = String(stat.nodes);
    const bar = document.createElement('span');
    bar.className = 'guide-level-bar';
    for (const [key, status] of LEVEL_STATUSES) {
      const seg = document.createElement('span');
      seg.className = `status-${status}`;
      seg.style.width = `${(100 * stat[key]) / stat.nodes}%`;
      bar.appendChild(seg);
    }
    const shares = document.createElement('span');
    shares.className = 'guide-level-shares';
    shares.textContent = levelShares(stat);
    row.title = range ? `${range}: ${shares.textContent}` : shares.textContent;
    row.append(label, count, bar, shares);
    strip.appendChild(row);
  }
  section.appendChild(strip);
  return section;
}

/** "80% transitively verified, 5% verified, 10% trusted" (zero shares omitted). */
export function levelShares(stat: LevelStat): string {
  const parts = LEVEL_STATUSES
    .filter(([key]) => stat[key] > 0)
    .map(([key, , text]) => `${Math.round((100 * stat[key]) / stat.nodes)}% ${text}`);
  return parts.length > 0 ? parts.join(', ') : 'none verified or trusted';
}

/** What the graph shows after an action, e.g. "180 nodes: callers of GF16". */
export function resultMessage(action: StateAction, label: string, result: GuideResult | null): string {
  if (!result || action.type === 'switchView') return label;
  if (result.tooLarge) return `${label}: the graph is too large to show without a query`;
  if (result.missingAnchor && (action.type === 'setSource' || action.type === 'setSink')) {
    return `${action.label} is hidden by the current filters`;
  }
  const noun = result.shown === 1 ? 'node' : 'nodes';
  const notes: string[] = [];
  if (result.seeded) {
    notes.push('entry points view');
  } else if (result.shown < result.total) {
    notes.push(`${result.total - result.shown} of ${result.total} not shown`);
    if (result.anchorsShown !== undefined && result.anchorsTotal !== undefined
      && result.anchorsShown < result.anchorsTotal) {
      notes.push(`first ${result.anchorsShown} of ${result.anchorsTotal} targets`);
    }
  }
  if (result.displayRemoved) notes.push(`${result.displayRemoved} removed by display filters`);
  const note = notes.length > 0 ? ` (${notes.join(', ')})` : '';
  return `${result.shown} ${noun}: ${describeAction(action)}${note}`;
}

function describeAction(action: Exclude<StateAction, { type: 'switchView' }>): string {
  switch (action.type) {
    case 'setSource': return `callees of ${action.label}`;
    case 'setSink': return `callers of ${action.label}`;
    case 'setCrateBoundary': return `${action.source} → ${action.target}`;
    case 'filterVerification': return `${action.statuses.join(', ')} only`;
  }
}

/**
 * Map a suggested action to one state transition. Directional actions use
 * unlimited depth so the BFS finds every reachable node.
 */
export function guideTransition(action: StateAction, label: string): GuideTransition {
  switch (action.type) {
    case 'setSource':
      return { intent: exactIntent([action.id], 'callees', action.label, { type: 'guide' }), status: null, depth: null, label };
    case 'setSink':
      return { intent: exactIntent([action.id], 'callers', action.label, { type: 'guide' }), status: null, depth: null, label };
    case 'setCrateBoundary':
      return { intent: boundaryIntent(action.source, action.target), status: null, depth: null, label };
    case 'filterVerification':
      return { intent: NONE_INTENT, status: [...action.statuses], label };
    case 'switchView':
      return { intent: NONE_INTENT, status: null, view: action.view, label };
  }
}

/**
 * Show a brief toast notification above the graph.
 */
export function showToast(message: string): void {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}
