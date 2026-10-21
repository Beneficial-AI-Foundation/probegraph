/**
 * Query words: the filter words (`kind:theorem`, `module:field`,
 * `is:unused`, ...) that the search box and the Source and Sink inputs
 * read, and the `paths` and `top` verbs of the search box. See
 * docs/archive/graph-search.md, Phase 2, and the "Query words" part of
 * docs/guides/viewer.md.
 *
 * A text is split at white space. A word `key:value` with a known key is a
 * filter word; every other word is a plain word. The value of a filter word
 * can list alternatives with commas (`status:failed,unverified`). A node
 * passes the filter words when it passes each of them.
 *
 * Pure module (no DOM), unit-tested in the node environment.
 */

import { asSubstringGlob, globToRegex, pathPatternToRegex } from './filters';
import {
  condensedSize, dependencyLevels, graphCondensation, rankByTransitiveDependents, type DependentRank,
} from './reachability';
import type { D3Graph, D3Link, D3Node, VerificationStatus } from './types';
import { isVerificationStatus } from './status-filter';
import { proofFrontier } from './trust-base';

export const FILTER_KEYS = ['crate', 'kind', 'status', 'module', 'file', 'level', 'is'] as const;
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
    case 'is': return 'is:unused';
  }
}

function valueError(key: FilterKey, value: string): string | null {
  if (key === 'status' && !isVerificationStatus(value.toLowerCase())) {
    return `status:${value} is not a status. Use verified, transitively-verified, trusted, failed or unverified`;
  }
  if (key === 'level' && !/^\d+$/.test(value)) {
    return `level:${value} is not a level. Use a whole number, for example level:0`;
  }
  if (key === 'is' && !(IS_NAMES as readonly string[]).includes(value.toLowerCase())) {
    return `is:${value} is not known. Use ${IS_NAMES.join(', ')}`;
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
  /** The layer graph that holds the node; undefined if none does */
  layerOf(id: string): D3Graph | undefined;
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

/**
 * Context for one layer graph, or for both. The levels and the facts of
 * the `is:` words are computed per graph on the first word that needs them.
 */
export function graphWordContext(...graphs: D3Graph[]): WordContext {
  if (graphs.length === 1) return { layerOf: () => graphs[0] };
  let owner: Map<string, D3Graph> | null = null;
  return {
    layerOf(id) {
      if (!owner) {
        owner = new Map();
        for (const g of graphs) for (const n of g.nodes) owner.set(n.id, g);
      }
      return owner.get(id);
    },
  };
}

/** Dependency level of a node in its layer; undefined if unknown. */
function levelOf(node: D3Node, context: WordContext): number | undefined {
  const graph = context.layerOf(node.id);
  return graph && graphLevels(graph).get(node.id);
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
      return node => levelOf(node, context) === level;
    }
    case 'is': {
      const test = IS_PREDICATES[value.toLowerCase() as IsName];
      return node => {
        const graph = context.layerOf(node.id);
        return graph !== undefined && test(node, layerFacts(graph));
      };
    }
  }
}

// ============================================================================
// `is:` words
// ============================================================================

/** The names `is:` takes. */
export const IS_NAMES = ['unfinished', 'assumption', 'unused', 'surface', 'frontier'] as const;
export type IsName = typeof IS_NAMES[number];

/** What the `is:` words read from a node's layer. */
interface LayerFacts {
  /** Nodes that another node of the layer depends on */
  used: Set<string>;
  /** Nodes with a `requires` or `ensures` dependency */
  withContract: Set<string>;
  /** Which `is:surface` rule the layer gets */
  surface: 'verus' | 'aeneas' | null;
  /** Whether a node is ready work (trust-base.ts proofFrontier), computed on first use */
  ready(id: string): boolean;
}

const factsCache = new WeakMap<D3Graph, LayerFacts>();

function layerFacts(graph: D3Graph): LayerFacts {
  let facts = factsCache.get(graph);
  if (!facts) {
    const ids = new Set(graph.nodes.map(n => n.id));
    const used = new Set<string>();
    // The node-level dependencies, as the levels and dependent counts read them
    for (const n of graph.nodes) {
      for (const dep of n.dependencies ?? []) if (dep !== n.id && ids.has(dep)) used.add(dep);
    }
    const withContract = new Set<string>();
    for (const link of graph.links) {
      if (link.type === 'precondition' || link.type === 'postcondition') withContract.add(endId(link.source));
    }
    // probe-verus tags its exec functions `rust` and its proof and spec
    // functions `verus`; an Aeneas join has `rust` and `lean` nodes
    const languages = new Set(graph.nodes.map(n => n.language));
    const surface = languages.has('verus') ? 'verus'
      : languages.has('rust') && languages.has('lean') ? 'aeneas'
      : null;
    facts = { used, withContract, surface, ready: id => proofFrontier(graph).isReady(id) };
    factsCache.set(graph, facts);
  }
  return facts;
}

function endId(end: D3Link['source']): string {
  return typeof end === 'string' ? end : end.id;
}

/** Unfinished work: the declaration itself is not done. Axioms are assumptions, not blockers. */
export function isUnfinished(n: D3Node): boolean {
  return (n.verification_status === 'unverified' || n.verification_status === 'failed') && n.kind !== 'axiom';
}

/** Accepted assumptions: axioms and the rest of the trust base. */
export function isAssumption(n: D3Node): boolean {
  return n.kind === 'axiom' || n.verification_status === 'trusted';
}

const IS_PREDICATES: Record<IsName, (node: D3Node, facts: LayerFacts) => boolean> = {
  unfinished: isUnfinished,
  assumption: isAssumption,
  // Generated and hidden declarations are often used by attribute (`@[step]`)
  unused: (n, facts) => !facts.used.has(n.id) && !n.is_entry_point && !n.is_generated && !n.is_hidden,
  surface: (n, facts) => {
    if (!n.is_public_api) return false;
    switch (facts.surface) {
      case 'verus': return n.kind === 'exec' && !facts.withContract.has(n.id);
      case 'aeneas': return n.language === 'rust' && !n.mapping_id;
      case null: return false;
    }
  },
  frontier: (n, facts) => facts.ready(n.id),
};

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

/** `top [N] by dependents [filter words]`: a ranked node list. */
export interface TopQuery {
  verb: 'top';
  n: number;
  filters: FilterWord[];
}

export type VerbQuery = PathsQuery | TopQuery;

export const PATHS_FORM = 'paths from <words> to <words>';
export const TOP_FORM = 'top [N] by dependents [filter words]';

/** N of `top` when the text gives none, and the largest N: the render limit. */
export const TOP_DEFAULT = 10;
export const TOP_MAX = 200;

/**
 * The verb query of a search box text: null when the text does not start
 * with a verb, an error when it starts with one but does not parse. Only a
 * text that starts with `paths from`, or with `top` and then a number,
 * `by` or nothing, counts as a verb, so a search for a declaration named
 * `paths` or `top_level` stays a search.
 */
export function parseVerbQuery(text: string): Parsed<VerbQuery> | null {
  const words = text.split(/\s+/).filter(w => w !== '');
  const first = words[0]?.toLowerCase();
  if (first === 'top' && (words.length === 1 || /^\d+$/.test(words[1]) || words[1].toLowerCase() === 'by')) {
    return parseTop(words.slice(1));
  }
  if (words.length < 2 || first !== 'paths' || words[1].toLowerCase() !== 'from') {
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

function parseTop(words: string[]): Parsed<TopQuery> {
  let n = TOP_DEFAULT;
  if (words.length > 0 && /^\d+$/.test(words[0])) {
    n = Number(words[0]);
    if (n < 1 || n > TOP_MAX) return { ok: false, error: `top takes a number from 1 to ${TOP_MAX}` };
    words = words.slice(1);
  }
  if (words.length < 2 || words[0].toLowerCase() !== 'by' || words[1].toLowerCase() !== 'dependents') {
    return { ok: false, error: `Not a query yet: ${TOP_FORM}` };
  }
  const parsed = parseWords(words.slice(2).join(' '));
  if (!parsed.ok) return parsed;
  if (parsed.value.plain.length > 0) {
    return { ok: false, error: 'top takes filter words only, for example module:field' };
  }
  return { ok: true, value: { verb: 'top', n, filters: parsed.value.filters } };
}

export function formatVerbQuery(q: VerbQuery): string {
  switch (q.verb) {
    case 'paths': return `paths from ${q.from} to ${q.to}`;
    case 'top': return [`top ${q.n} by dependents`, formatWords({ plain: [], filters: q.filters })]
      .filter(s => s !== '').join(' ');
  }
}

/** A `top` result: the ranked rows, and how many declarations pass the filter words. */
export type TopResult =
  | { ok: true; rows: DependentRank[]; total: number }
  | { ok: false; components: number; links: number };

/**
 * Run `top` on one layer graph, as the Guide lists rank: unique transitive
 * dependents over every node and dependency of the layer, ties by ID.
 * When the graph is too large for the counts, the size of its condensation.
 */
export function runTop(graph: D3Graph, q: TopQuery, context: WordContext = graphWordContext(graph)): TopResult {
  const passes = compileFilterWords(q.filters, context);
  const rows = rankByTransitiveDependents(graph, passes, q.n);
  if (!rows) return { ok: false, ...condensedSize(graphCondensation(graph)) };
  return { ok: true, rows, total: graph.nodes.filter(passes).length };
}
