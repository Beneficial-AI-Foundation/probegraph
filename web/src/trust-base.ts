/**
 * Trust base: for each node, the assumptions, unfinished declarations and
 * unknown closures it rests on (docs/plans/trust-and-frontier.md, Phase 1).
 *
 * The reference implementation is `scripts/trust_frontier.py`; this module
 * gives the same answers on the fixtures in
 * `src/test-data/trust-frontier.json`. Rules:
 *
 * - A `trusted` node is a leaf: its outgoing links are cut, and so are its
 *   missing targets.
 * - Assumption is `trusted`, unfinished is `unverified` or `failed`,
 *   unknown is `untracked`. A node with no status is neutral: the walk
 *   goes through it and it adds nothing.
 * - A `dependencies` target that is not in the graph does not block. It is
 *   listed under `missing`, for information.
 *
 * Callers pass the full code-layer graph (`state.fullGraph`), never a
 * filtered one, so a hidden link cannot remove an assumption.
 *
 * Pure module (no DOM), unit-tested in the node environment.
 */

import {
  Bitset, MAX_REACHABILITY_WORDS, compareIds, condense, type Condensation,
} from './reachability';
import type { D3Graph, D3Node } from './types';

/** The sets one node rests on, each sorted by ID. Never one count. */
export interface TrustBase {
  /** `trusted` nodes, the node itself included. */
  assumptions: string[];
  /** `unverified` and `failed` nodes, the node itself included. */
  unfinished: string[];
  /** `untracked` nodes: their closure is unknown. */
  unknown: string[];
  /** Dependency targets that are not in the graph. */
  missing: string[];
}

/** Theorems that rest on exactly the same nodes. */
export interface TheoremGroup {
  /** The shared trust base (assumptions, unfinished and unknown), sorted by ID. */
  base: string[];
  /** The theorems, sorted by ID. */
  theorems: string[];
}

export interface TrustAnalysis {
  /** Condensation of the graph with the links out of `trusted` nodes cut. */
  condensation: Condensation;
  /** Trust base of a node; null for an ID that is not in the graph. */
  baseOf(id: string): TrustBase | null;
  /** Theorems grouped by trust base, the theorem itself left out. Largest group first. */
  groups(): TheoremGroup[];
}

/** Lean theorems and Verus proof functions, the viewer's `kind:lemma`. */
const THEOREM_KINDS = new Set(['theorem', 'proof']);

export function isTrustAssumption(n: D3Node): boolean {
  return n.verification_status === 'trusted';
}

export function isTrustUnfinished(n: D3Node): boolean {
  return n.verification_status === 'unverified' || n.verification_status === 'failed';
}

export function isTrustUnknown(n: D3Node): boolean {
  return n.untracked === true;
}

/** Dependencies with the trust cut: none for a `trusted` node. */
function cutDependencies(n: D3Node): string[] {
  return isTrustAssumption(n) ? [] : n.dependencies;
}

const analysisCache = new WeakMap<D3Graph, TrustAnalysis | null>();

/**
 * Trust bases of every node of a graph, computed once per graph object.
 * Null when the bitsets do not fit in MAX_REACHABILITY_WORDS. The graph's
 * dependencies and statuses must not change after the first call.
 */
export function trustAnalysis(graph: D3Graph): TrustAnalysis | null {
  if (analysisCache.has(graph)) return analysisCache.get(graph)!;
  const result = analyze(graph);
  analysisCache.set(graph, result);
  return result;
}

function analyze(graph: D3Graph): TrustAnalysis | null {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const c = condense(byId.keys(), id => cutDependencies(byId.get(id)!));
  const count = c.members.length;

  // Bit indices: the nodes a base can hold, then the missing targets
  const baseIds = [...byId.values()]
    .filter(n => isTrustAssumption(n) || isTrustUnfinished(n) || isTrustUnknown(n))
    .map(n => n.id)
    .sort(compareIds);
  const missingIds = [...new Set(
    [...byId.values()].flatMap(n => (isTrustAssumption(n) ? [] : n.missing_dependencies ?? [])),
  )].sort(compareIds);
  const words = count * (Math.ceil(baseIds.length / 32) + Math.ceil(missingIds.length / 32));
  if (words > MAX_REACHABILITY_WORDS) return null;

  const baseIndex = new Map(baseIds.map((id, i) => [id, i]));
  const missingIndex = new Map(missingIds.map((id, i) => [id, i]));
  const bases: Bitset[] = new Array(count);
  const missing: Bitset[] = new Array(count);
  // Dependencies come after their callers, so walk backwards
  for (let k = count - 1; k >= 0; k--) {
    const base = new Bitset(baseIds.length);
    const miss = new Bitset(missingIds.length);
    for (const id of c.members[k]) {
      const i = baseIndex.get(id);
      if (i !== undefined) base.add(i);
      if (isTrustAssumption(byId.get(id)!)) continue;
      for (const t of byId.get(id)!.missing_dependencies ?? []) miss.add(missingIndex.get(t)!);
    }
    for (const d of c.dependencies[k]) {
      base.union(bases[d]);
      miss.union(missing[d]);
    }
    bases[k] = base;
    missing[k] = miss;
  }

  const ids = (set: Bitset, list: string[]) => {
    const out: string[] = [];
    set.forEach(i => out.push(list[i]));
    return out;
  };
  const baseNodes = (k: number) => ids(bases[k], baseIds).map(id => byId.get(id)!);

  return {
    condensation: c,
    baseOf(id) {
      const k = c.componentOf.get(id);
      if (k === undefined) return null;
      const nodes = baseNodes(k);
      return {
        assumptions: nodes.filter(isTrustAssumption).map(n => n.id),
        unfinished: nodes.filter(isTrustUnfinished).map(n => n.id),
        unknown: nodes.filter(isTrustUnknown).map(n => n.id),
        missing: ids(missing[k], missingIds),
      };
    },
    groups() {
      const byKey = new Map<string, TheoremGroup>();
      for (const n of [...byId.values()].sort((a, b) => compareIds(a.id, b.id))) {
        if (!THEOREM_KINDS.has(n.kind)) continue;
        const base = ids(bases[c.componentOf.get(n.id)!], baseIds).filter(id => id !== n.id);
        if (base.length === 0) continue;
        const key = base.join('\0');
        let group = byKey.get(key);
        if (!group) byKey.set(key, group = { base, theorems: [] });
        group.theorems.push(n.id);
      }
      return [...byKey.values()].sort((a, b) =>
        b.theorems.length - a.theorems.length || compareIdLists(a.base, b.base));
    },
  };
}

/** Element by element, a prefix first (the order of Python lists). */
function compareIdLists(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareIds(a[i], b[i]);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/**
 * Shortest paths from `start` to each target, on the graph with the trust
 * cut. One BFS that visits dependencies in ID order, so ties go to the
 * smaller ID at the first step where paths differ. A path lists `start`
 * first and the target last; null when the target is not reached. The
 * paths are on the original graph, not on the condensation.
 */
export function witnesses(
  graph: D3Graph,
  start: string,
  targets: Iterable<string>,
): Map<string, string[] | null> {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const parent = new Map<string, string | null>();
  if (byId.has(start)) {
    parent.set(start, null);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const deps = [...new Set(cutDependencies(byId.get(queue[i])!))]
        .filter(d => byId.has(d))
        .sort(compareIds);
      for (const d of deps) {
        if (parent.has(d)) continue;
        parent.set(d, queue[i]);
        queue.push(d);
      }
    }
  }
  const result = new Map<string, string[] | null>();
  for (const target of targets) {
    if (!parent.has(target)) {
      result.set(target, null);
      continue;
    }
    const path: string[] = [];
    for (let v: string | null = target; v !== null; v = parent.get(v)!) path.push(v);
    result.set(target, path.reverse());
  }
  return result;
}

/** Shortest path from `start` to `target` (see witnesses). */
export function witness(graph: D3Graph, start: string, target: string): string[] | null {
  return witnesses(graph, start, [target]).get(target)!;
}
