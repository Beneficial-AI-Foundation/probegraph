/**
 * Which graph node an editor cursor is on. Used by the VS Code extension; no
 * DOM or editor APIs, so both sides can share it.
 *
 * Graph paths are `relative_path` values with `/` separators, relative to the
 * analysed project root. Mapping an editor file to its graph path is the
 * caller's job.
 */

import { BLUEPRINT_LANGUAGE, type D3Graph, type D3Node } from './types';

export interface LocationIndex {
  /** Nodes with a source location, by graph path. */
  byFile: Map<string, D3Node[]>;
}

/** The declaration enclosing the cursor, from the editor's document symbols. */
export interface EditorSymbol {
  /** As written; a dotted Lean name (`Foo.bar`) is split into containers and `bar`. */
  name: string;
  /** Enclosing symbol names, outermost first (namespaces, `impl` blocks, types). */
  containers: string[];
}

export interface CursorQuery {
  graphPath: string;
  /** 1-based */
  line: number;
  symbol?: EditorSymbol;
}

export type Resolution =
  | { kind: 'match'; node: D3Node; evidence: 'symbol' | 'symbol+line' | 'line' }
  | { kind: 'ambiguous'; candidates: D3Node[] }
  | {
      kind: 'not-indexed';
      /**
       * file: the graph has nothing in this file. line: nothing covers the
       * line. symbol: the enclosing declaration's name is not in the graph
       * (renamed or added since extraction).
       */
      reason: 'file' | 'symbol' | 'line';
    };

export function buildLocationIndex(graph: D3Graph): LocationIndex {
  const byFile = new Map<string, D3Node[]>();
  for (const node of graph.nodes) {
    if (!node.relative_path || !(typeof node.start_line === 'number' && node.start_line > 0)) continue;
    if (node.language === BLUEPRINT_LANGUAGE) continue;
    const list = byFile.get(node.relative_path);
    if (list) list.push(node);
    else byFile.set(node.relative_path, [node]);
  }
  return { byFile };
}

export function nodesInFile(index: LocationIndex, graphPath: string): D3Node[] {
  return index.byFile.get(graphPath) ?? [];
}

const startOf = (n: D3Node) => n.start_line!;
const endOf = (n: D3Node) => Math.max(n.end_line ?? n.start_line!, n.start_line!);
const span = (n: D3Node) => endOf(n) - startOf(n);

/** Hidden and generated nodes, only when nothing else is there. */
function preferVisible(nodes: D3Node[]): D3Node[] {
  const visible = nodes.filter(n => !n.is_hidden && !n.is_generated);
  return visible.length > 0 ? visible : nodes;
}

/** The nodes with the smallest range. */
function innermost(nodes: D3Node[]): D3Node[] {
  const min = Math.min(...nodes.map(span));
  return nodes.filter(n => span(n) === min);
}

const identifiers = (s: string) => s.match(/[\p{L}_][\p{L}\p{N}_']*/gu) ?? [];

/** Identifier tokens of container names, e.g. `impl Trait for Type<T>` → Trait, Type, T. */
function containerTokens(containers: string[]): string[] {
  const tokens = containers.flatMap(identifiers);
  return tokens.filter(t => t !== 'impl' && t !== 'for' && t !== 'where');
}

/** Keep the candidates whose ID mentions the most container tokens. */
function byContainers(nodes: D3Node[], containers: string[]): D3Node[] {
  const tokens = containerTokens(containers);
  if (tokens.length === 0 || nodes.length < 2) return nodes;
  const score = (n: D3Node) => {
    const id = new Set(identifiers(n.id));
    return tokens.filter(t => id.has(t)).length;
  };
  const best = Math.max(...nodes.map(score));
  return nodes.filter(n => score(n) === best);
}

/** Rust display names are qualified (`Type::method`); editors report `method`. */
const shortName = (n: D3Node) => n.display_name.split('::').pop()!;

function splitDotted(symbol: EditorSymbol): EditorSymbol {
  const parts = symbol.name.split('.').filter(p => p !== '');
  if (parts.length < 2) return symbol;
  return { name: parts[parts.length - 1], containers: [...symbol.containers, ...parts.slice(0, -1)] };
}

function decide(candidates: D3Node[], evidence: 'symbol' | 'symbol+line' | 'line'): Resolution {
  return candidates.length === 1
    ? { kind: 'match', node: candidates[0], evidence }
    : { kind: 'ambiguous', candidates };
}

/**
 * Resolve the cursor to a node. Never guesses across files or by name over
 * the whole graph: with a symbol, its name must match; without one, the
 * innermost range containing the line decides.
 */
export function resolveCursor(index: LocationIndex, query: CursorQuery): Resolution {
  const inFile = nodesInFile(index, query.graphPath);
  if (inFile.length === 0) return { kind: 'not-indexed', reason: 'file' };

  const containing = inFile.filter(n => startOf(n) <= query.line && query.line <= endOf(n));

  if (query.symbol) {
    const { name, containers } = splitDotted(query.symbol);
    const named = (nodes: D3Node[]) => preferVisible(nodes.filter(n => shortName(n) === name));

    if (containing.length > 0) {
      // A line match under another name is the old declaration: renamed or replaced
      const matches = named(containing);
      if (matches.length === 0) return { kind: 'not-indexed', reason: 'symbol' };
      return decide(byContainers(innermost(matches), containers), 'symbol+line');
    }
    // Lines shifted since extraction: the name decides within the file
    const matches = named(inFile);
    if (matches.length === 0) return { kind: 'not-indexed', reason: 'symbol' };
    return decide(byContainers(matches, containers), 'symbol');
  }

  if (containing.length === 0) return { kind: 'not-indexed', reason: 'line' };
  return decide(innermost(preferVisible(containing)), 'line');
}
