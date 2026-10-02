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
 * Node filters to relax so that the node is drawn under these filters: the
 * ones that each, relaxed on their own, would draw it (at most one, since
 * the node filters are conjunctive); or, when none does alone, a set that
 * together does, found greedily in `NODE_FILTER_RELAXATIONS` order (every
 * node filter relaxed, then each put back while the node stays drawn). The
 * set suffices; it is not necessarily the smallest. Empty when the node is
 * drawn already or when no node filter is responsible.
 */
export function filtersHiding(
  graph: D3Graph, filters: FilterOptions, language: ProjectLanguage, nodeId: string,
): (keyof FilterOptions)[] {
  const drawn = (f: FilterOptions) =>
    executeQuery(compileQuery(f, language), graph).nodes.some(n => n.id === nodeId);
  if (drawn(filters)) return [];
  const closed = (Object.entries(NODE_FILTER_RELAXATIONS) as [keyof FilterOptions, unknown][])
    .filter(([key, open]) => filters[key] !== open);
  const alone = closed.filter(([key, open]) => drawn({ ...filters, [key]: open })).map(([key]) => key);
  if (alone.length > 0) return alone;

  let relaxed: FilterOptions = { ...filters, ...NODE_FILTER_RELAXATIONS };
  if (!drawn(relaxed)) return [];
  const together: (keyof FilterOptions)[] = [];
  for (const [key] of closed) {
    const restored = { ...relaxed, [key]: filters[key] };
    if (drawn(restored)) {
      relaxed = restored;
    } else {
      together.push(key);
    }
  }
  return together;
}
