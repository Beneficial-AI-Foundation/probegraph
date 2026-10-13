/**
 * Reachability on the SCC-condensed dependency graph.
 *
 * Links point caller -> dependency. Strongly connected components (SCCs,
 * groups of declarations that all reach each other) are condensed into one
 * vertex each, which turns the graph into a DAG (directed acyclic graph).
 * On that DAG, per-component sets are unions of bitsets in topological
 * order, so a diamond never counts a node twice.
 *
 * Used by the Guide (dependent counts, layers) and meant to be reused by
 * the trust-base and frontier work (docs/plans/trust-and-frontier.md) and
 * the `rank by dependents` query (docs/plans/graph-search.md, Phase 2).
 *
 * Pure module (no DOM), unit-tested in the node environment.
 */

import type { D3Graph, D3Node } from './types';

// ============================================================================
// Bitset
// ============================================================================

/** Fixed-size set of small non-negative integers. */
export class Bitset {
  readonly size: number;
  private readonly words: Uint32Array;

  constructor(size: number) {
    this.size = size;
    this.words = new Uint32Array((size + 31) >>> 5);
  }

  add(i: number): void {
    this.words[i >>> 5] |= 1 << (i & 31);
  }

  has(i: number): boolean {
    return (this.words[i >>> 5] & (1 << (i & 31))) !== 0;
  }

  /** Add every member of `other` (same size). */
  union(other: Bitset): void {
    const w = this.words;
    const o = other.words;
    for (let k = 0; k < w.length; k++) w[k] |= o[k];
  }

  /** Members in increasing order. */
  forEach(fn: (i: number) => void): void {
    const w = this.words;
    for (let k = 0; k < w.length; k++) {
      let word = w[k];
      while (word !== 0) {
        const bit = 31 - Math.clz32(word & -word);
        fn((k << 5) + bit);
        word &= word - 1;
      }
    }
  }

  count(): number {
    let n = 0;
    for (const word of this.words) {
      let v = word - ((word >>> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      n += Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
    }
    return n;
  }
}

// ============================================================================
// Condensation
// ============================================================================

/**
 * The SCC-condensed DAG. Component indices are in topological order:
 * every caller component comes before its dependency components.
 */
export interface Condensation {
  /** Component index of each node ID. */
  componentOf: Map<string, number>;
  /** Members of each component, sorted by ID. */
  members: string[][];
  /** Direct dependency components of each component (no self, no repeats, ascending). */
  dependencies: number[][];
  /** Direct dependent (caller) components of each component (no self, no repeats, ascending). */
  dependents: number[][];
}

/**
 * Condense a dependency relation. Dependencies outside `nodeIds` are
 * ignored. Deterministic: the result depends only on the relation, not on
 * the input order.
 */
export function condense(
  nodeIds: Iterable<string>,
  dependenciesOf: (id: string) => Iterable<string>,
): Condensation {
  const ids = [...new Set(nodeIds)].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const adj: number[][] = ids.map(id => {
    const out = new Set<number>();
    for (const dep of dependenciesOf(id)) {
      const j = index.get(dep);
      if (j !== undefined) out.add(j);
    }
    return [...out].sort((a, b) => a - b);
  });

  // Iterative Tarjan. Components are emitted dependencies first.
  const n = ids.length;
  const order = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const emitted: number[][] = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (order[root] !== -1) continue;
    const work: [node: number, next: number][] = [[root, 0]];
    order[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame[0];
      if (frame[1] < adj[v].length) {
        const w = adj[v][frame[1]++];
        if (order[w] === -1) {
          order[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], order[w]);
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low[parent] = Math.min(low[parent], low[v]);
      }
      if (low[v] === order[v]) {
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp.push(w);
        } while (w !== v);
        emitted.push(comp);
      }
    }
  }

  // Reverse the emission order: callers first
  const c = emitted.length;
  const compOfIndex = new Int32Array(n);
  const members: string[][] = [];
  for (let k = 0; k < c; k++) {
    const comp = emitted[c - 1 - k];
    for (const v of comp) compOfIndex[v] = k;
    members.push(comp.map(v => ids[v]).sort());
  }

  const depSets: Set<number>[] = Array.from({ length: c }, () => new Set());
  for (let v = 0; v < n; v++) {
    const cv = compOfIndex[v];
    for (const w of adj[v]) {
      const cw = compOfIndex[w];
      if (cw !== cv) depSets[cv].add(cw);
    }
  }
  const dependencies = depSets.map(s => [...s].sort((a, b) => a - b));
  const dependents: number[][] = Array.from({ length: c }, () => []);
  for (let k = 0; k < c; k++) for (const d of dependencies[k]) dependents[d].push(k);

  const componentOf = new Map<string, number>();
  for (let v = 0; v < n; v++) componentOf.set(ids[v], compOfIndex[v]);
  return { componentOf, members, dependencies, dependents };
}

/** Condense a graph's node-level `dependencies` (the full relation, all link roles). */
export function condenseGraph(graph: D3Graph): Condensation {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  return condense(byId.keys(), id => byId.get(id)!.dependencies ?? []);
}

// ============================================================================
// Reachability and levels
// ============================================================================

/**
 * Reverse reachability: for each component, the components that reach it
 * (its transitive dependents), excluding itself. Bitsets over component
 * indices.
 */
export function dependentClosure(c: Condensation): Bitset[] {
  const count = c.members.length;
  const sets: Bitset[] = [];
  // Callers come first, so every caller's set is final when it is read
  for (let k = 0; k < count; k++) {
    const set = new Bitset(count);
    for (const p of c.dependents[k]) {
      set.union(sets[p]);
      set.add(p);
    }
    sets.push(set);
  }
  return sets;
}

/** Number of declarations in a set of components (an SCC of five counts five). */
export function memberCount(c: Condensation, set: Bitset): number {
  let n = 0;
  set.forEach(k => { n += c.members[k].length; });
  return n;
}

/**
 * Level of each component: 0 when it has no dependencies, otherwise one
 * more than its highest dependency. Members of one SCC share a level.
 */
export function dependencyLevels(c: Condensation): number[] {
  const levels = new Array<number>(c.members.length).fill(0);
  // Dependencies come last, so walk backwards
  for (let k = c.members.length - 1; k >= 0; k--) {
    let level = 0;
    for (const d of c.dependencies[k]) level = Math.max(level, levels[d] + 1);
    levels[k] = level;
  }
  return levels;
}

// ============================================================================
// Dependent counts
// ============================================================================

export interface GraphReachability {
  condensation: Condensation;
  /** Transitive dependents of each component (see dependentClosure). */
  dependentSets: Bitset[];
  /** Unique transitive dependents of each node. */
  dependentCounts: Map<string, number>;
}

const reachabilityCache = new WeakMap<D3Graph, GraphReachability>();

/**
 * Condensation, reverse-reachability bitsets and dependent counts of a
 * graph, computed once per graph object. The graph's dependencies must not
 * change after the first call.
 */
export function graphReachability(graph: D3Graph): GraphReachability {
  const cached = reachabilityCache.get(graph);
  if (cached) return cached;
  const condensation = condenseGraph(graph);
  const dependentSets = dependentClosure(condensation);
  const perComponent = dependentSets.map(set => memberCount(condensation, set));
  const dependentCounts = new Map<string, number>();
  for (const [id, k] of condensation.componentOf) dependentCounts.set(id, perComponent[k]);
  const result = { condensation, dependentSets, dependentCounts };
  reachabilityCache.set(graph, result);
  return result;
}

/**
 * Unique transitive dependents of each node: the nodes that reach it. For
 * A -> B -> C the counts are A 0, B 1, C 2. Members of one SCC share a
 * count and do not count each other.
 */
export function transitiveDependentCounts(graph: D3Graph): Map<string, number> {
  return graphReachability(graph).dependentCounts;
}

export interface DependentRank {
  node: D3Node;
  count: number;
}

/**
 * Candidates ranked by unique transitive dependents, ties by ID. Counts use
 * every node of the graph; `isCandidate` only selects what is ranked.
 */
export function rankByTransitiveDependents(
  graph: D3Graph,
  isCandidate: (node: D3Node) => boolean,
  limit: number,
): DependentRank[] {
  const counts = transitiveDependentCounts(graph);
  return graph.nodes
    .filter(isCandidate)
    .map(node => ({ node, count: counts.get(node.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || compareIds(a.node.id, b.node.id))
    .slice(0, limit);
}

/** ID order for ties: plain code-unit order, the same in every locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
