/**
 * Guide panel -- DOM rendering for the Guide tab in the right sidebar.
 *
 * Shows a static graph overview (from static-analysis.ts) with suggested
 * queries that execute directly against the viewer state. No LLM involved.
 */

import type { GraphSummary, SuggestedAction, GuideActions, GuideResult, GuideTransition } from './types';
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

    chipsEl.innerHTML = '';
    for (const q of summary.suggestedQueries) {
      const chip = document.createElement('button');
      chip.className = 'guide-chip';
      chip.innerHTML = `<span class="chip-label">${escapeHtml(q.label)}</span><span class="chip-desc">${escapeHtml(q.description)}</span>`;
      chip.addEventListener('click', () => this.executeAction(q.action, q.label));
      chipsEl.appendChild(chip);
    }
  }

  private executeAction(action: SuggestedAction, label: string): void {
    // Stay on the Guide tab; the toast reports what the graph now shows
    const result = this.actions.apply(guideTransition(action, label));
    showToast(resultMessage(action, label, result));
  }
}

/** What the graph shows after an action, e.g. "180 nodes: callers of GF16". */
export function resultMessage(action: SuggestedAction, label: string, result: GuideResult | null): string {
  if (!result || action.type === 'switchView') return label;
  if (result.tooLarge) return `${label}: the graph is too large to show without a query`;
  if (result.missingAnchor && (action.type === 'setSource' || action.type === 'setSink')) {
    return `${action.label} is hidden by the current filters`;
  }
  const noun = result.shown === 1 ? 'node' : 'nodes';
  const note = result.seeded ? ' (entry points view)'
    : result.shown < result.total ? ` (truncated from ${result.total})` : '';
  return `${result.shown} ${noun}: ${describeAction(action)}${note}`;
}

function describeAction(action: Exclude<SuggestedAction, { type: 'switchView' }>): string {
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
export function guideTransition(action: SuggestedAction, label: string): GuideTransition {
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
function showToast(message: string): void {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}
