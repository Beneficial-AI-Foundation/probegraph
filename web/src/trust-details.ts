/**
 * Node-details section for the trust base (docs/archive/trust-and-frontier.md,
 * Phase 1): what the node rests on, as a summary line that expands into the
 * assumptions, unfinished and unknown declarations, each with its witness
 * path, and the missing dependency targets. Phase 2 adds the "Ready work"
 * line on the nodes of the proof frontier.
 *
 * The graph must be the full code layer (`state.fullGraph`), so a display
 * filter cannot remove an entry. Links use `.navigate-to-node`, and the
 * "show path" buttons `.trust-path` (from `data-from` to `data-to`);
 * main.ts handles both. Every value from the extract is escaped.
 */
import { escapeHtml } from './html';
import { proofFrontier, trustAnalysis, witnesses, type FrontierCounts } from './trust-base';
import { BLUEPRINT_LANGUAGE, type D3Graph, type D3Node } from './types';

/** Entries shown per list; the rest is a count. */
export const TRUST_LIST_CAP = 50;

/** Witness paths with more nodes in between than this are shortened in the middle. */
const WITNESS_MAX_STEPS = 6;

const statusCache = new WeakMap<D3Graph, boolean>();

/** Whether any node of the graph has a verification status. */
function hasStatuses(graph: D3Graph): boolean {
  let has = statusCache.get(graph);
  if (has === undefined) {
    has = graph.nodes.some(n => n.verification_status !== undefined || n.untracked === true);
    statusCache.set(graph, has);
  }
  return has;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One sentence that names all three counts, never one total. */
export function trustSummary(assumptions: number, unfinished: number, unknown: number): string {
  const parts = [
    plural(assumptions, 'assumption', 'assumptions'),
    plural(unfinished, 'unfinished declaration', 'unfinished declarations'),
  ];
  if (unknown > 0) parts.push(plural(unknown, 'untracked declaration', 'untracked declarations'));
  return `Rests on ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * "Ready work" line for a node of the proof frontier, or '' for any other
 * node (the same cases as trustDetailsHtml, plus every node that is not ready).
 */
export function readyWorkHtml(graph: D3Graph, node: D3Node): string {
  if (node.language === BLUEPRINT_LANGUAGE || !hasStatuses(graph)) return '';
  const row = proofFrontier(graph).rowOf(node.id);
  if (!row) return '';
  return `<div class="node-detail ready-work"><strong>Ready work:</strong> ${escapeHtml(readyWorkText(row.members.length, row.counts))}</div>`;
}

/** "would make 1 more ready, 1 unfinished depends on it", with the cycle and size cases. */
export function readyWorkText(members: number, counts: FrontierCounts | null): string {
  const cycle = members > 1 ? `ready together with the ${plural(members - 1, 'other', 'others')} in its cycle, ` : '';
  if (!counts) return `${cycle || 'all its dependencies are done, '}counts not computed (the graph is too large)`;
  const depend = counts.affected === 1 ? 'depends' : 'depend';
  return `${cycle}would make ${counts.unblocks} more ready, ${counts.affected} unfinished ${depend} on it`;
}

/**
 * Trust-base section for `node`, or '' when it does not apply: a blueprint
 * entry, a node outside `graph`, or a graph with no verification data.
 * `open` keeps the lists expanded.
 */
export function trustDetailsHtml(graph: D3Graph, node: D3Node, open: boolean): string {
  if (node.language === BLUEPRINT_LANGUAGE || !hasStatuses(graph)) return '';
  const analysis = trustAnalysis(graph);
  if (!analysis) {
    return `<div class="node-detail"><strong>Rests on:</strong>
      <em>not computed, the graph is too large</em></div>`;
  }
  const base = analysis.baseOf(node.id);
  if (!base) return '';

  const summary = escapeHtml(trustSummary(base.assumptions.length, base.unfinished.length, base.unknown.length));
  const listed = base.assumptions.length + base.unfinished.length + base.unknown.length;
  if (listed + base.missing.length === 0) {
    return `<div class="node-detail trust-base"><strong>Trust base:</strong> ${summary}</div>`;
  }
  // Node details re-render on hover, so the lists and their witness BFS
  // wait until the section is open; main.ts re-renders on the first toggle
  if (!open) {
    return `<div class="node-detail"><details class="trust-base" data-lazy>
    <summary><strong>Trust base:</strong> ${summary}</summary></details></div>`;
  }

  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const shown = (ids: string[]) => ids.slice(0, TRUST_LIST_CAP);
  const paths = listed === 0 ? new Map<string, string[] | null>() : witnesses(graph, node.id, [
    ...shown(base.assumptions), ...shown(base.unfinished), ...shown(base.unknown),
  ]);
  const name = (id: string) => escapeHtml(byId.get(id)?.display_name ?? id);

  const link = (id: string) =>
    `<a href="#" class="navigate-to-node" data-node-id="${escapeHtml(id)}" title="${escapeHtml(id)}" style="cursor:pointer; text-decoration:underline;">${name(id)}</a>`;

  const pathButton = (id: string) => id === node.id ? '' :
    ` <button type="button" class="trust-path" data-from="${escapeHtml(node.id)}" data-to="${escapeHtml(id)}" title="Draw the shortest chain from ${name(node.id)} to ${name(id)} in the Call Graph">show path</button>`;

  const via = (id: string): string => {
    if (id === node.id) return ' <em>(this declaration)</em>';
    const path = paths.get(id);
    if (!path) return '';
    const between = path.slice(1, -1);
    const title = escapeHtml(path.map(p => byId.get(p)?.display_name ?? p).join(' → '));
    let text: string;
    if (between.length === 0) {
      text = 'direct dependency';
    } else if (between.length <= WITNESS_MAX_STEPS) {
      text = `via ${between.map(name).join(' → ')}`;
    } else {
      const skipped = between.length - 5;
      text = `via ${between.slice(0, 3).map(name).join(' → ')} → … ${skipped} more … → ${between.slice(-2).map(name).join(' → ')}`;
    }
    return `<div class="trust-witness" title="${title}">${text}</div>`;
  };

  const reason = (id: string) => {
    const r = byId.get(id)?.trusted_reason;
    return r ? ` <span class="trust-reason">(${escapeHtml(r)})</span>` : '';
  };

  const list = (label: string, ids: string[], extra: (id: string) => string = () => '') => {
    if (ids.length === 0) return '';
    const rest = ids.length - TRUST_LIST_CAP;
    const items = shown(ids).map(id => `<li>${link(id)}${extra(id)}${pathButton(id)}${via(id)}</li>`).join('');
    const more = rest > 0 ? `<li><em>and ${rest} more</em></li>` : '';
    return `<div class="trust-list"><strong>${label} (${ids.length}):</strong>
      <ul class="node-list">${items}${more}</ul></div>`;
  };

  const unknownNote = base.unknown.length > 0
    ? `<div class="trust-note">External closure unavailable: what the untracked declarations rest on is not in the extract.</div>`
    : '';
  const missingItems = shown(base.missing).map(t => `<li>${escapeHtml(t)}</li>`).join('');
  const missingMore = base.missing.length > TRUST_LIST_CAP
    ? `<li><em>and ${base.missing.length - TRUST_LIST_CAP} more</em></li>`
    : '';
  const missing = base.missing.length > 0
    ? `<div class="trust-list"><strong>Missing targets (${base.missing.length}):</strong>
        <div class="trust-note">Dependencies that are not in the extract. Listed for information; they block nothing.</div>
        <ul class="node-list">${missingItems}${missingMore}</ul></div>`
    : '';

  const body = list('Assumptions', base.assumptions, reason)
    + list('Unfinished', base.unfinished)
    + list('Untracked', base.unknown)
    + unknownNote
    + missing;
  return `<div class="node-detail"><details class="trust-base" open>
    <summary><strong>Trust base:</strong> ${summary}</summary>${body}</details></div>`;
}
