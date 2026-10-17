/**
 * Lexical search over declarations: find a node by the words in its name,
 * its module path and the names its statement mentions.
 *
 * Every field is split into lowercase tokens (`mul_by_pow_2` -> mul, by,
 * pow, 2; camel case, dots, `::` and `/` split too). The name and path
 * also keep their unsplit segments (`KeyHistory` -> keyhistory). Statement
 * names are the names of the nodes a statement mentions, plus the IDs of
 * the ones outside the graph. A query is split the same way, and every
 * query token must match a token of some field. A match on the name ranks
 * above one on the module path, which ranks above one on a statement name;
 * within a field an exact token ranks above a prefix, and a prefix above a
 * substring. See docs/archive/graph-search.md, Phase 1.
 *
 * Pure module (no DOM), unit-tested in the node environment.
 */

import type { D3Link, D3Node } from './types';

// ============================================================================
// Tokens
// ============================================================================

// One word: an upper-case run not followed by lower case (GF in GF16, HTTP
// in HTTPServer), a capitalized or lower-case word, a digit run, or any
// other letters (Lean subscripts such as ᵤ)
const WORD = /\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{N}+|\p{L}+/gu;

/** Lowercase tokens of an identifier, module path or query. */
export function tokenize(text: string): string[] {
  return (text.match(WORD) ?? []).map(t => t.toLowerCase());
}

/** Runs of letters and digits, unsplit (`KeyHistory`, not Key and History). */
function segments(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** An ID without its URI-style scheme (`probe:`). */
function withoutScheme(id: string): string {
  return id.replace(/^[a-z][a-z0-9+.-]*:/i, '');
}

// ============================================================================
// Index
// ============================================================================

interface Entry {
  node: D3Node;
  /** Lowercase full ID, and the ID without its `probe:` scheme */
  id: string;
  bareId: string;
  name: string;
  /** Words of the name, in order */
  nameTokens: string[];
  /**
   * Lowercase segments of the name made of several words (keyhistory for
   * `KeyHistory`), so a camel-case name typed in lowercase still matches,
   * and the position of each segment's first word in `nameTokens`
   */
  nameSegments: string[];
  nameSegmentPositions: number[];
  pathTokens: string[];
  statementTokens: string[];
}

export interface SearchIndex {
  entries: Entry[];
}

/** Links from a declaration's statement: Lean type uses, Verus requires and ensures. */
function isStatementLink(link: D3Link): boolean {
  return link.role === 'type' || link.role === 'both'
    || link.type === 'precondition' || link.type === 'postcondition';
}

function endpointId(end: string | D3Node): string {
  return typeof end === 'string' ? end : end.id;
}

/** Build the index over the nodes of one or more layers. */
export function buildSearchIndex(graph: { nodes: D3Node[]; links: D3Link[] }): SearchIndex {
  const names = new Map(graph.nodes.map(n => [n.id, n.display_name]));
  const statementNames = new Map<string, Set<string>>();
  for (const link of graph.links) {
    if (!isStatementLink(link)) continue;
    const name = names.get(endpointId(link.target));
    if (name === undefined) continue;
    const source = endpointId(link.source);
    let set = statementNames.get(source);
    if (!set) statementNames.set(source, set = new Set());
    set.add(name);
  }
  // Statement names outside the graph have no node, so only their ID
  for (const node of graph.nodes) {
    if (!node.statement_externals) continue;
    let set = statementNames.get(node.id);
    if (!set) statementNames.set(node.id, set = new Set());
    for (const ext of node.statement_externals) set.add(withoutScheme(ext));
  }

  const entries = graph.nodes.map(node => {
    const id = node.id.toLowerCase();
    const nameSegments: string[] = [], nameSegmentPositions: number[] = [];
    let position = 0;
    for (const segment of segments(node.display_name)) {
      const words = tokenize(segment).length;
      if (words > 1) {
        nameSegments.push(segment.toLowerCase());
        nameSegmentPositions.push(position);
      }
      position += words;
    }
    const path = `${node.id} ${node.relative_path ?? ''}`;
    return {
      node,
      id,
      bareId: withoutScheme(id),
      name: node.display_name.toLowerCase(),
      nameTokens: tokenize(node.display_name),
      nameSegments,
      nameSegmentPositions,
      pathTokens: unique([...tokenize(path), ...segments(path).map(t => t.toLowerCase())]),
      statementTokens: unique([...statementNames.get(node.id) ?? []].flatMap(tokenize)),
    };
  });
  return { entries };
}

function unique(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

// ============================================================================
// Ranking
// ============================================================================

// A query token's cost in a field: exact token, prefix, substring
const EXACT = 0, PREFIX = 1, SUBSTRING = 2, NO_MATCH = Infinity;
// Added per field, so any name match beats any path match
const NAME = 0, PATH = 3, STATEMENT = 6;

/** Cost and token position of the best match of `term` in `tokens`. */
function matchIn(term: string, tokens: string[]): { cost: number; position: number } {
  let cost = NO_MATCH, position = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const c = t === term ? EXACT : t.startsWith(term) ? PREFIX : t.includes(term) ? SUBSTRING : NO_MATCH;
    if (c < cost) {
      cost = c;
      position = i;
      if (c === EXACT) break;
    }
  }
  return { cost, position };
}

/** Best match of `term` in the name, a word or a whole segment: lowest cost, then earliest. */
function matchName(term: string, entry: Entry): { cost: number; position: number } {
  const word = matchIn(term, entry.nameTokens);
  const segment = matchIn(term, entry.nameSegments);
  if (segment.cost === NO_MATCH) return word;
  const position = entry.nameSegmentPositions[segment.position];
  return segment.cost < word.cost || (segment.cost === word.cost && position < word.position)
    ? { cost: segment.cost, position }
    : word;
}

export interface SearchHit {
  node: D3Node;
  /** Lower is better; for tests and debugging */
  cost: number;
}

/** Ordering key; compared element by element, lower first. */
type RankKey = [whole: number, cost: number, position: number, length: number, id: string];

/**
 * Nodes matching `query`, best first, at most `limit`.
 *
 * The order: the whole query equal to the ID (with or without its
 * scheme), then equal to the display name, then the sum of the token
 * costs, then the position of the first query token in the name, then the
 * number of words in the name (a shorter name fits the query more
 * closely), then the ID.
 *
 * With `accept`, only the nodes it accepts. A query without words then
 * gives every accepted node, ordered by ID.
 */
export function search(
  index: SearchIndex, query: string, limit = 20, accept?: (node: D3Node) => boolean,
): SearchHit[] {
  const whole = query.trim().toLowerCase();
  const terms = unique(tokenize(query));
  if (terms.length === 0) {
    if (!accept) return [];
    return index.entries
      .filter(e => accept(e.node))
      .map(e => e.node)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .slice(0, limit)
      .map(node => ({ node, cost: 0 }));
  }

  const ranked: { hit: SearchHit; key: RankKey }[] = [];
  for (const entry of index.entries) {
    if (accept && !accept(entry.node)) continue;
    let cost = 0;
    let position = Infinity;
    for (const [i, term] of terms.entries()) {
      // The field costs do not overlap, so the first field that matches wins
      const name = matchName(term, entry);
      let best = NAME + name.cost;
      if (best === NO_MATCH) best = PATH + matchIn(term, entry.pathTokens).cost;
      if (best === NO_MATCH) best = STATEMENT + matchIn(term, entry.statementTokens).cost;
      if (best === NO_MATCH) {
        cost = NO_MATCH;
        break;
      }
      cost += best;
      if (i === 0 && name.cost !== NO_MATCH) position = name.position;
    }
    if (cost === NO_MATCH) continue;
    // An ID names one node, a display name can name several
    const exact = whole === entry.id || whole === entry.bareId ? 0 : whole === entry.name ? 1 : 2;
    ranked.push({
      hit: { node: entry.node, cost },
      key: [exact, cost, position, entry.nameTokens.length, entry.node.id],
    });
  }
  ranked.sort((a, b) => compareKeys(a.key, b.key));
  return ranked.slice(0, limit).map(r => r.hit);
}

function compareKeys(a: RankKey, b: RankKey): number {
  for (let i = 0; i < 4; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0 && !Number.isNaN(d)) return d;
  }
  return a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0;
}
