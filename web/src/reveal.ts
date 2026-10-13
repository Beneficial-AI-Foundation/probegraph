/**
 * Revealing one node: why the Call Graph does not draw it, what can be done
 * about that, and the intent a reveal sets. Editor selections and search
 * share this path (revealNode in main.ts).
 *
 * Pure module (no DOM), unit-tested in the node environment.
 */

import { compileQuery, executeQuery } from './query';
import { anchorIds, exactIntent, isFocusIntent, type QueryIntent } from './intent';
import { filtersHiding, type EditorSelection } from './editor-selection';
import { describeFilters } from './filter-names';
import type { D3Graph, FilterOptions, ProjectLanguage } from './types';

/**
 * Why a node is or is not drawn, one action each:
 * - `missing`: not in either layer. No action.
 * - `other-layer`: in the layer not shown. Switch layer.
 * - `filtered`: a node filter hides it (`filteredBy`). Relax those filters.
 * - `outside-intent`: passes the filters, but the query does not reach it.
 *   Replace the intent, or add the node as an anchor.
 * - `truncated`: in the query result, dropped by the render cap. Make it an
 *   anchor, or raise the cap.
 * - `shown`: drawn. Centre on it.
 */
export type RevealReason = 'missing' | 'other-layer' | 'filtered' | 'outside-intent' | 'truncated' | 'shown';

export interface RevealResult {
  reason: RevealReason;
  /** For `filtered`: the node filters to relax; empty when none would draw it */
  filteredBy?: (keyof FilterOptions)[];
}

/** What the viewer draws now; every field comes from state, none from the DOM. */
export interface RevealContext {
  /** The active layer (state.fullGraph) */
  graph: D3Graph;
  /** The layer not shown, for graphs with two */
  otherLayer: D3Graph | null;
  filters: FilterOptions;
  language: ProjectLanguage;
  /** IDs of the nodes drawn (state.filteredGraph) */
  rendered: ReadonlySet<string>;
  /** The render cap dropped nodes from the query result */
  capped: boolean;
}

/** Why `id` is or is not drawn. */
export function classifyReveal(ctx: RevealContext, id: string): RevealResult {
  if (!ctx.graph.nodes.some(n => n.id === id)) {
    return { reason: ctx.otherLayer?.nodes.some(n => n.id === id) ? 'other-layer' : 'missing' };
  }
  if (ctx.rendered.has(id)) return { reason: 'shown' };

  const drawn = (f: FilterOptions) =>
    executeQuery(compileQuery(f, ctx.language), ctx.graph).nodes.some(n => n.id === id);
  // In the result but not drawn: the cap dropped it, or a view that is not
  // the query result (the seeded entry-point view) left it out
  if (drawn(ctx.filters)) return { reason: ctx.capped ? 'truncated' : 'outside-intent' };

  // An exact ID set without direction draws the node unless a filter hides it
  const anchored = anchorIds(ctx.filters.intent).includes(id);
  const alone = { ...ctx.filters, intent: exactIntent([id], 'none', id, { type: 'search' }) };
  if (!anchored && drawn(alone)) return { reason: 'outside-intent' };
  return {
    reason: 'filtered',
    filteredBy: filtersHiding(ctx.graph, anchored ? ctx.filters : alone, ctx.language, id),
  };
}

/**
 * Who asked for the reveal, which decides the intent it sets:
 * - `editor`: always the selection's exact intent, at its depth.
 * - `replace` (search): an exact intent on the node at the current depth,
 *   when the current query does not reach it.
 * - `anchor` (search, "as source" / "as sink"): the node joins the current
 *   exact source or sink set, or starts one.
 */
export type RevealPolicy =
  | { kind: 'editor'; selection: EditorSelection }
  | { kind: 'replace' }
  | { kind: 'anchor'; role: 'source' | 'sink' };

/**
 * The intent a search reveal sets. A source is the existing callees query
 * and a sink the existing callers query: an anchor joins an exact set with
 * the same direction, and otherwise starts a new one (a source set and a
 * sink set together would need a paths query on ID sets, which no intent
 * expresses).
 */
export function searchIntent(
  current: QueryIntent, id: string, label: string, policy: Exclude<RevealPolicy, { kind: 'editor' }>,
): QueryIntent {
  if (policy.kind === 'replace') return exactIntent([id], 'both', label, { type: 'search' });
  const dir = policy.role === 'source' ? 'callees' : 'callers';
  if (current.kind === 'ids' && !isFocusIntent(current) && current.dir === dir) {
    return withAnchor(current, id, label)!;
  }
  return exactIntent([id], dir, label, { type: 'search' });
}

/**
 * The current intent with `id` added to its exact ID set, which the render
 * cap keeps first; null when the intent has no exact set. A focus set is
 * left alone: its IDs come from the ?focus= URL.
 */
export function withAnchor(current: QueryIntent, id: string, label: string): QueryIntent | null {
  if (current.kind !== 'ids' || isFocusIntent(current)) return null;
  if (current.ids.includes(id)) return current;
  return exactIntent([...current.ids, id], current.dir, `${current.label}, ${label}`, current.origin);
}

/** The largest render cap a reveal offers to raise to. */
export const RAISED_RENDER_CAP = 1000;

/** An action the viewer offers for a node it does not draw; the user clicks it. */
export type RevealAction =
  | { kind: 'relax'; keys: (keyof FilterOptions)[] }
  | { kind: 'anchor'; intent: QueryIntent }
  | { kind: 'raise-cap'; cap: number };

/**
 * The actions for a reveal result. `resultSize` is the number of nodes in
 * the query result before the cap; the cap is raised only up to
 * RAISED_RENDER_CAP. `other-layer` and `outside-intent` have none here:
 * the reveal acts on them itself.
 */
export function revealActions(
  result: RevealResult, intent: QueryIntent, id: string, label: string, resultSize: number,
): RevealAction[] {
  switch (result.reason) {
    case 'filtered':
      return result.filteredBy?.length ? [{ kind: 'relax', keys: result.filteredBy }] : [];
    case 'truncated': {
      const actions: RevealAction[] = [];
      const anchored = withAnchor(intent, id, label);
      if (anchored) actions.push({ kind: 'anchor', intent: anchored });
      if (resultSize <= RAISED_RENDER_CAP) actions.push({ kind: 'raise-cap', cap: resultSize });
      return actions;
    }
    default:
      return [];
  }
}

export function actionLabel(action: RevealAction): string {
  switch (action.kind) {
    case 'relax': return 'Show it';
    case 'anchor': return 'Keep it in the query';
    case 'raise-cap': return `Draw all ${action.cap} nodes`;
  }
}

/** What to tell the user about a node the reveal did not draw; empty for `shown`. */
export function revealMessage(label: string, result: RevealResult, cap: number): string {
  switch (result.reason) {
    case 'missing': return `${label} is not in this graph`;
    case 'other-layer': return `${label} is on the other layer`;
    case 'filtered':
      return result.filteredBy?.length
        ? `${label} is hidden by ${describeFilters(result.filteredBy)}`
        : `${label} is not drawn even with every node filter off`;
    case 'outside-intent': return `${label} is outside the current query`;
    case 'truncated': return `${label} is beyond the ${cap}-node render limit`;
    case 'shown': return '';
  }
}

/**
 * Numbers reveals so that the later steps of one (layout settle, camera
 * transition end, the toast's action) do nothing once a newer reveal or a
 * graph load has started.
 */
export class RevealCounter {
  private current = 0;

  /** A new reveal; the token it returns is current until the next start or invalidate. */
  start(): number {
    return ++this.current;
  }

  /** A graph load: no reveal started before it is current any more. */
  invalidate(): void {
    this.current++;
  }

  isCurrent(token: number): boolean {
    return token === this.current;
  }
}

export interface RevealSteps {
  /** Resolves once the layout has a position for the node */
  settle: () => Promise<void>;
  /** Starts the camera move; resolves true when it ends, false if it was cut short */
  center: () => Promise<boolean>;
}

/**
 * The asynchronous end of a reveal: wait for the layout, then centre. Each
 * step drops out when `token` is no longer current, so a reveal that a newer
 * one overtook never moves the camera. Resolves true when it centred.
 */
export async function finishReveal(counter: RevealCounter, token: number, steps: RevealSteps): Promise<boolean> {
  await steps.settle();
  if (!counter.isCurrent(token)) return false;
  const ended = await steps.center();
  return ended && counter.isCurrent(token);
}
