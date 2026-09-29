/**
 * Guide panel -- DOM rendering for the Guide tab in the right sidebar.
 *
 * Shows a static graph overview (from static-analysis.ts) with suggested
 * queries that execute directly against the viewer state. No LLM involved.
 */

import type { GraphSummary, SuggestedAction, GuideActions } from './types';
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
    // Directional actions need unlimited depth so BFS finds all reachable nodes
    const needsUnlimitedDepth = action.type === 'setSource' || action.type === 'setSink'
      || action.type === 'setSourceAndSink' || action.type === 'setCrateBoundary';
    if (needsUnlimitedDepth) {
      this.actions.setDepth(null);
    }

    switch (action.type) {
      case 'setSource':
        this.actions.setSource(action.query);
        this.actions.applyFiltersAndUpdate();
        break;
      case 'setSink':
        this.actions.setSink(action.query);
        this.actions.applyFiltersAndUpdate();
        break;
      case 'setSourceAndSink':
        this.actions.setSource(action.source);
        this.actions.setSink(action.sink);
        this.actions.applyFiltersAndUpdate();
        break;
      case 'filterVerification':
        this.actions.setFilters({
          showVerifiedNodes: action.statuses.includes('verified'),
          showFailedNodes: action.statuses.includes('failed'),
          showUnverifiedNodes: action.statuses.includes('unverified'),
        });
        this.actions.applyFiltersAndUpdate();
        break;
      case 'setCrateBoundary':
        this.actions.setSource(`crate:${action.source}`);
        this.actions.setSink(`crate:${action.target}`);
        this.actions.applyFiltersAndUpdate();
        break;
      case 'switchView':
        this.actions.switchView(action.view);
        break;
    }

    // Show feedback and switch to the graph view so the user sees the result
    showToast(label);
    if (action.type !== 'switchView') {
      this.switchTab('node-details');
    }
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
