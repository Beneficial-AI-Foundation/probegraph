/**
 * Selections the VS Code extension sends for the declaration at the cursor,
 * and why one is not drawn.
 */

import { compileQuery, executeQuery } from './query';
import { vscodeIntent } from './intent';
import type { D3Graph, FilterOptions, ProjectLanguage } from './types';

export type EditorDirection = 'both' | 'callees' | 'callers' | 'none';

export interface EditorSelection {
  nodeId: string;
  direction: EditorDirection;
  /** Always finite: an editor selection never asks for the whole graph */
  depth: number;
}

export type SelectStatus = 'shown' | 'filtered' | 'missing';

export function editorSelectionIntent(selection: EditorSelection, label: string) {
  const { direction } = selection;
  return vscodeIntent(
    selection.nodeId, label,
    direction === 'both' || direction === 'callees',
    direction === 'both' || direction === 'callers',
  );
}

/** Node filters an editor selection leaves alone, and the setting that lets everything through. */
const NODE_FILTER_RELAXATIONS: { [K in keyof FilterOptions]?: FilterOptions[K] } = {
  showExecFunctions: true,
  showProofFunctions: true,
  showSpecFunctions: true,
  showAxioms: true,
  showTypes: true,
  showProjections: true,
  showInstances: true,
  showRustNodes: true,
  showLeanNodes: true,
  showLibsignal: true,
  showNonLibsignal: true,
  showVerifiedNodes: true,
  showFailedNodes: true,
  showUnverifiedNodes: true,
  exactStatuses: null,
  excludeNamePatterns: '',
  excludePathPatterns: '',
  includeFiles: '',
};

/**
 * The filter values that let everything through for `keys`, for a host that
 * wants to undo what hid a selection. Keys that are not node filters are
 * ignored.
 */
export function relaxations(keys: string[]): Partial<FilterOptions> {
  const out: Partial<FilterOptions> = {};
  for (const key of keys) {
    if (key in NODE_FILTER_RELAXATIONS) {
      (out as Record<string, unknown>)[key] = NODE_FILTER_RELAXATIONS[key as keyof FilterOptions];
    }
  }
  return out;
}

/**
 * The node filters that each, relaxed on its own, would draw the node under
 * these filters. Empty when no single filter is responsible.
 */
export function filtersHiding(
  graph: D3Graph, filters: FilterOptions, language: ProjectLanguage, nodeId: string,
): (keyof FilterOptions)[] {
  const drawn = (f: FilterOptions) =>
    executeQuery(compileQuery(f, language), graph).nodes.some(n => n.id === nodeId);
  if (drawn(filters)) return [];
  const hiding: (keyof FilterOptions)[] = [];
  for (const [key, open] of Object.entries(NODE_FILTER_RELAXATIONS) as [keyof FilterOptions, unknown][]) {
    if (filters[key] === open) continue;
    if (drawn({ ...filters, [key]: open })) hiding.push(key);
  }
  return hiding;
}
