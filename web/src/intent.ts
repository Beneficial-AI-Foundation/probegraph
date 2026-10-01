/**
 * Query intent: what the graph is "about".
 *
 * One value replaces the old source/sink strings, focus set, VS Code exact
 * node override and crate-dropdown boundary. Every writer replaces the whole
 * intent, so no part of a previous query leaks into the next one.
 * See docs/archive/query-intent.md.
 *
 * Pure module (no DOM), unit-tested in the node environment.
 */

export type IdDirection = 'none' | 'callers' | 'callees' | 'both';

/** An ID set loaded from a ?focus= URL. */
export type FocusOrigin = { type: 'focus'; url: string };

/** An exact ID set chosen by a viewer action. */
export type ExactOrigin =
  | { type: 'guide' }
  | { type: 'vscode' }
  | { type: 'drilldown' };

export type FocusIntent = {
  kind: 'ids'; ids: string[]; dir: 'none'; label: string; origin: FocusOrigin;
};

export type ExactIntent = {
  kind: 'ids'; ids: [string, ...string[]]; dir: IdDirection; label: string; origin: ExactOrigin;
};

export type QueryIntent =
  | { kind: 'none' }
  | { kind: 'text'; source: string; sink: string }
  | FocusIntent
  | ExactIntent
  | { kind: 'boundary'; sourceGroup: string; targetGroup: string };

export const NONE_INTENT: QueryIntent = { kind: 'none' };

/** Text intent from the two inputs; `none` if both are blank. */
export function textIntent(source: string, sink: string): QueryIntent {
  if (source.trim() === '' && sink.trim() === '') return NONE_INTENT;
  return { kind: 'text', source, sink };
}

/** Focus intent; an empty `ids` shows nothing (not "no restriction"). */
export function focusIntent(url: string, ids: string[], label: string): FocusIntent {
  return { kind: 'ids', ids: [...ids], dir: 'none', label, origin: { type: 'focus', url } };
}

/** Exact intent; `none` when no IDs are given (a non-focus ID set is never empty). */
export function exactIntent(
  ids: string[], dir: IdDirection, label: string, origin: ExactOrigin,
): QueryIntent {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return NONE_INTENT;
  return { kind: 'ids', ids: unique as [string, ...string[]], dir, label, origin };
}

export function boundaryIntent(sourceGroup: string, targetGroup: string): QueryIntent {
  return { kind: 'boundary', sourceGroup, targetGroup };
}

export function isFocusIntent(intent: QueryIntent): intent is FocusIntent {
  return intent.kind === 'ids' && intent.origin.type === 'focus';
}

/**
 * Directional queries traverse from their selectors; for them the include
 * file filter narrows the result after traversal instead of restricting it.
 */
export function isDirectionalIntent(intent: QueryIntent): boolean {
  switch (intent.kind) {
    case 'text': return intent.source.trim() !== '' || intent.sink.trim() !== '';
    case 'ids': return intent.dir !== 'none';
    case 'boundary': return true;
    case 'none': return false;
  }
}

/** IDs the result must keep even without visible links (exact and focus sets). */
export function anchorIds(intent: QueryIntent): string[] {
  return intent.kind === 'ids' ? intent.ids : [];
}

/** Contents of the source and sink inputs for an intent. */
export interface IntentInputs {
  source: string;
  sink: string;
  /** Inputs showing an exact label rather than a search string. */
  sourceExact: boolean;
  sinkExact: boolean;
}

export function inputsForIntent(intent: QueryIntent): IntentInputs {
  const empty = { source: '', sink: '', sourceExact: false, sinkExact: false };
  switch (intent.kind) {
    case 'text':
      return { ...empty, source: intent.source, sink: intent.sink };
    case 'ids':
      switch (intent.dir) {
        case 'callees': return { ...empty, source: intent.label, sourceExact: true };
        case 'callers': return { ...empty, sink: intent.label, sinkExact: true };
        case 'both':
          return { source: intent.label, sink: intent.label, sourceExact: true, sinkExact: true };
        case 'none': return empty;
      }
      return empty;
    default:
      return empty;
  }
}

/**
 * Intent after the user edits one input. The other input is dropped when it
 * shows an exact label, so the label never becomes a substring pattern
 * (callers of X plus a typed source would otherwise run paths to "*X*").
 */
export function intentAfterInputEdit(
  current: QueryIntent,
  edited: 'source' | 'sink',
  sourceValue: string,
  sinkValue: string,
): QueryIntent {
  const { sourceExact, sinkExact } = inputsForIntent(current);
  const source = edited === 'sink' && sourceExact ? '' : sourceValue;
  const sink = edited === 'source' && sinkExact ? '' : sinkValue;
  return textIntent(source, sink);
}

/** Intent for a VS Code loadGraph message with an exact node. */
export function vscodeIntent(
  nodeId: string, label: string, hasSource: boolean, hasSink: boolean,
): QueryIntent {
  const dir: IdDirection = hasSource && hasSink ? 'both'
    : hasSource ? 'callees'
    : hasSink ? 'callers'
    : 'none';
  return exactIntent([nodeId], dir, label, { type: 'vscode' });
}

/**
 * Intent for a VS Code setQuery message. After a text intent an omitted side
 * keeps its string; after any other intent it is empty (a label is not a query).
 */
export function vscodeSetQueryIntent(
  current: QueryIntent, source: string | undefined, sink: string | undefined,
): QueryIntent {
  const keep = current.kind === 'text' ? current : { source: '', sink: '' };
  return textIntent(source ?? keep.source, sink ?? keep.sink);
}
