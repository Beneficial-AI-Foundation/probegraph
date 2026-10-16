/**
 * Query words: the filter words (`kind:theorem`, `module:field`, ...) that
 * the search box and the Source and Sink inputs read, and the `paths` verb
 * of the search box. See docs/plans/graph-search.md, Phase 2, and the
 * "Query words" part of docs/guides/viewer.md.
 *
 * A text is split at white space. A word `key:value` with a known key is a
 * filter word; every other word is a plain word. The value of a filter word
 * can list alternatives with commas (`status:failed,unverified`). A node
 * passes the filter words when it passes each of them.
 *
 * Pure module (no DOM), unit-tested in the node environment.
 */

import { asSubstringGlob, globToRegex, pathPatternToRegex } from './filters';
import { dependencyLevels, graphCondensation } from './reachability';
import type { D3Graph, D3Node, VerificationStatus } from './types';
import { isVerificationStatus } from './status-filter';

export const FILTER_KEYS = ['crate', 'kind', 'status', 'module', 'file', 'level'] as const;
export type FilterKey = typeof FILTER_KEYS[number];

export interface FilterWord {
  key: FilterKey;
  /** Alternatives; the node passes when one of them matches */
  values: string[];
}

export interface Words {
  /** Plain words, in order */
  plain: string[];
  filters: FilterWord[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// A known key, a colon, and a value that does not start with a colon, so
// `crate::decompress` stays a plain word
const FILTER_WORD = new RegExp(`^(${FILTER_KEYS.join('|')}):(?!:)(.*)$`, 'i');

/** `kind:lemma` means either of these kinds. */
const LEMMA_KINDS = ['proof', 'theorem'];

/** Split a text into plain words and filter words. */
export function parseWords(text: string): Parsed<Words> {
  const plain: string[] = [];
  const filters: FilterWord[] = [];
  for (const word of text.split(/\s+/).filter(w => w !== '')) {
    const m = FILTER_WORD.exec(word);
    if (!m) {
      plain.push(word);
      continue;
    }
    const key = m[1].toLowerCase() as FilterKey;
    const values = m[2].split(',').filter(v => v !== '');
    if (values.length === 0) return { ok: false, error: `${key}: needs a value, for example ${example(key)}` };
    for (const value of values) {
      const error = valueError(key, value);
      if (error) return { ok: false, error };
    }
    filters.push({ key, values });
  }
  return { ok: true, value: { plain, filters } };
}

function example(key: FilterKey): string {
  switch (key) {
    case 'crate': return 'crate:dalek';
    case 'kind': return 'kind:theorem';
    case 'status': return 'status:failed';
    case 'module': return 'module:field';
    case 'file': return 'file:edwards.rs';
    case 'level': return 'level:0';
  }
}

function valueError(key: FilterKey, value: string): string | null {
  if (key === 'status' && !isVerificationStatus(value.toLowerCase())) {
    return `status:${value} is not a status. Use verified, transitively-verified, trusted, failed or unverified`;
  }
  if (key === 'level' && !/^\d+$/.test(value)) {
    return `level:${value} is not a level. Use a whole number, for example level:0`;
  }
  return null;
}

/** The text of `words`, filter words after the plain words. */
export function formatWords(words: Words): string {
  return [...words.plain, ...words.filters.map(f => `${f.key}:${f.values.join(',')}`)].join(' ');
}

// ============================================================================
// Predicates
// ============================================================================

/** What a filter word needs from the graph. */
export interface WordContext {
  /** Dependency level of a node (see `graphLevels`); undefined if unknown */
  levelOf(id: string): number | undefined;
}

const levelCache = new WeakMap<D3Graph, Map<string, number>>();

/**
 * Dependency level of every node, as in the Guide Dependency levels strip:
 * every node and dependency of the graph, cycles merged.
 */
export function graphLevels(graph: D3Graph): Map<string, number> {
  let levels = levelCache.get(graph);
  if (!levels) {
    const condensation = graphCondensation(graph);
    const byComponent = dependencyLevels(condensation);
    levels = new Map();
    condensation.members.forEach((members, k) => {
      for (const id of members) levels!.set(id, byComponent[k]);
    });
    levelCache.set(graph, levels);
  }
  return levels;
}

/** Context for one graph; levels are computed on the first `level:` word. */
export function graphWordContext(...graphs: D3Graph[]): WordContext {
  let levels: Map<string, number>[] | null = null;
  return {
    levelOf(id) {
      levels ??= graphs.map(graphLevels);
      for (const map of levels) {
        const level = map.get(id);
        if (level !== undefined) return level;
      }
      return undefined;
    },
  };
}

/** Node predicate for filter words; every word must pass. */
export function compileFilterWords(
  filters: FilterWord[],
  context: WordContext,
): (node: D3Node) => boolean {
  const tests = filters.map(f => {
    const alternatives = f.values.map(v => compileValue(f.key, v, context));
    return (node: D3Node) => alternatives.some(test => test(node));
  });
  return node => tests.every(test => test(node));
}

function compileValue(key: FilterKey, value: string, context: WordContext): (node: D3Node) => boolean {
  switch (key) {
    case 'crate': {
      const regex = globToRegex(asSubstringGlob(value));
      return node => regex.test(node.crate_name);
    }
    case 'kind': {
      if (value.toLowerCase() === 'lemma') return node => LEMMA_KINDS.includes(node.kind);
      const regex = globToRegex(value);
      return node => regex.test(node.kind);
    }
    case 'status': {
      const status = value.toLowerCase() as VerificationStatus;
      return node => (node.verification_status ?? 'unverified') === status;
    }
    case 'module': {
      const query = moduleSegments(value);
      return node => containsRun(moduleSegments(withoutExtension(node.relative_path ?? '')), query);
    }
    case 'file': {
      // As Include Files: a pattern with a slash matches the path
      if (value.includes('/')) {
        const regex = pathPatternToRegex(value);
        return node => regex.test(node.relative_path ?? '');
      }
      const regex = globToRegex(value);
      return node => regex.test(node.file_name ?? '');
    }
    case 'level': {
      const level = Number(value);
      return node => context.levelOf(node.id) === level;
    }
  }
}

/** Lowercase segments of a module path; `/`, `.` and `::` all separate. */
export function moduleSegments(path: string): string[] {
  return path.toLowerCase().split(/::|[/.]/).filter(s => s !== '');
}

/** A file path without the extension of its last part. */
function withoutExtension(path: string): string {
  return path.replace(/\.[^./]*$/, '');
}

/** Whether `run` appears in `segments` as consecutive whole segments. */
function containsRun(segments: string[], run: string[]): boolean {
  if (run.length === 0) return false;
  for (let i = 0; i + run.length <= segments.length; i++) {
    if (run.every((s, j) => segments[i + j] === s)) return true;
  }
  return false;
}

// ============================================================================
// Verbs
// ============================================================================

/** `paths from <words> to <words>`: Source and Sink as text. */
export interface PathsQuery {
  verb: 'paths';
  from: string;
  to: string;
}

export type VerbQuery = PathsQuery;

export const PATHS_FORM = 'paths from <words> to <words>';

/**
 * The verb query of a search box text: null when the text does not start
 * with a verb, an error when it starts with one but does not parse. Only a
 * text that starts with `paths from` counts as a verb, so a search for a
 * declaration named `paths` stays a search.
 */
export function parseVerbQuery(text: string): Parsed<VerbQuery> | null {
  const words = text.split(/\s+/).filter(w => w !== '');
  if (words.length < 2 || words[0].toLowerCase() !== 'paths' || words[1].toLowerCase() !== 'from') {
    return null;
  }
  const rest = words.slice(2);
  const to = rest.findIndex(w => w.toLowerCase() === 'to');
  const from = rest.slice(0, Math.max(to, 0));
  const sink = to < 0 ? [] : rest.slice(to + 1);
  if (from.length === 0 || sink.length === 0) {
    return { ok: false, error: `Not a query yet: ${PATHS_FORM}` };
  }
  for (const side of [from, sink]) {
    const parsed = parseWords(side.join(' '));
    if (!parsed.ok) return parsed;
  }
  return { ok: true, value: { verb: 'paths', from: from.join(' '), to: sink.join(' ') } };
}

export function formatVerbQuery(q: VerbQuery): string {
  return `paths from ${q.from} to ${q.to}`;
}
