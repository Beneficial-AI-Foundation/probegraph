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
  Bitset, MAX_REACHABILITY_WORDS, compareIds, condense, condensedSize, type Condensation,
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
  /** The theorems, sorted by ID. */
  theorems: string[];
  /** Size of the shared base. */
  baseSize: number;
  /**
   * The shared trust base (assumptions, unfinished and unknown), sorted by
   * ID. Built on each call: the bases of all groups together can be
   * quadratic in the graph size.
   */
  base(): string[];
}

export interface TrustAnalysis {
  /** Condensation of the graph with the links out of `trusted` nodes cut. */
  condensation: Condensation;
  /** Trust base of a node; null for an ID that is not in the graph. */
  baseOf(id: string): TrustBase | null;
  /**
   * Theorems grouped by trust base, the theorem itself left out. Largest
   * group first. Computed once and shared between calls.
   */
  groups(): readonly TheoremGroup[];
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

/**
 * Largest stored trust base, in 32-bit words: one base and one missing
 * bitset per component. 12.5 million words is 50 MB, the size of the
 * dependent-count closure at MAX_REACHABILITY_COMPONENTS.
 */
export const MAX_TRUST_BASE_WORDS = 12_500_000;

/**
 * Whether the trust bases of a condensation fit, with `wordsPer` words of
 * bitset per component: the storage in MAX_TRUST_BASE_WORDS, and the work
 * (one union per condensed edge, one pass per component) in
 * MAX_REACHABILITY_WORDS.
 */
export function trustBaseFits(c: Condensation, wordsPer: number): boolean {
  const { components, links } = condensedSize(c);
  return components * wordsPer <= MAX_TRUST_BASE_WORDS
    && (links + components) * wordsPer <= MAX_REACHABILITY_WORDS;
}

const analysisCache = new WeakMap<D3Graph, TrustAnalysis | null>();

/**
 * Trust bases of every node of a graph, computed once per graph object.
 * Null when the bitsets do not fit (trustBaseFits). The graph's
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
  if (!trustBaseFits(c, Math.ceil(baseIds.length / 32) + Math.ceil(missingIds.length / 32))) return null;

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
  // Computed on the first call: the graph does not change
  let groups: readonly TheoremGroup[] | null = null;

  // A group is the base of component `k` with the bit `skip` (the theorem
  // itself, -1 when it is not in a base) left out. Groups are matched by
  // bitset, never by ID list, so the work stays linear in the bitsets.
  interface Slot { k: number; skip: number; theorems: string[] }
  const slotGroup = ({ k, skip, theorems }: Slot): TheoremGroup => ({
    theorems,
    baseSize: bases[k].count() - (skip >= 0 ? 1 : 0),
    base: () => {
      const out: string[] = [];
      bases[k].forEach(i => { if (i !== skip) out.push(baseIds[i]); });
      return out;
    },
  });

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
      if (groups) return groups;
      const byHash = new Map<number, Slot[]>();
      const slots: Slot[] = [];
      for (const n of [...byId.values()].sort((a, b) => compareIds(a.id, b.id))) {
        if (!THEOREM_KINDS.has(n.kind)) continue;
        const k = c.componentOf.get(n.id)!;
        const skip = baseIndex.get(n.id) ?? -1;
        if (bases[k].count() === (skip >= 0 ? 1 : 0)) continue;
        const hash = bases[k].hash(skip);
        const bucket = byHash.get(hash) ?? [];
        let slot = bucket.find(s => bases[s.k].compare(s.skip, bases[k], skip) === 0);
        if (!slot) {
          slot = { k, skip, theorems: [] };
          bucket.push(slot);
          byHash.set(hash, bucket);
          slots.push(slot);
        }
        slot.theorems.push(n.id);
      }
      // Ties go by base ID list, a prefix first (the order of Python lists)
      groups = slots
        .sort((a, b) => b.theorems.length - a.theorems.length || bases[a.k].compare(a.skip, bases[b.k], b.skip))
        .map(slotGroup);
      return groups;
    },
  };
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
  const goals = [...targets];
  const { parent } = shortestTree(new Map(graph.nodes.map(n => [n.id, n])), start, goals, Infinity);
  const result = new Map<string, string[] | null>();
  for (const target of goals) {
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

/**
 * The BFS of `witnesses`: each reached node's parent, `start` mapped to
 * null. It stops once every goal is reached, or once it has looked at
 * more than `budget` dependency links (`exhausted`). A parent never changes
 * once set, so the paths to the reached nodes hold either way.
 */
function shortestTree(
  byId: Map<string, D3Node>,
  start: string,
  goals: readonly string[],
  budget: number,
): { parent: Map<string, string | null>; steps: number; exhausted: boolean } {
  const parent = new Map<string, string | null>();
  let steps = 0;
  if (!byId.has(start)) return { parent, steps, exhausted: false };
  parent.set(start, null);
  const remaining = new Set(goals.filter(t => t !== start));
  const queue = [start];
  for (let i = 0; i < queue.length && remaining.size > 0; i++) {
    const deps = cutDependencies(byId.get(queue[i])!);
    steps += deps.length;
    if (steps > budget) return { parent, steps, exhausted: true };
    for (const d of [...new Set(deps)].filter(d => byId.has(d)).sort(compareIds)) {
      if (parent.has(d)) continue;
      parent.set(d, queue[i]);
      remaining.delete(d);
      queue.push(d);
    }
  }
  return { parent, steps, exhausted: false };
}

/** Shortest path from `start` to `target` (see witnesses). */
export function witness(graph: D3Graph, start: string, target: string): string[] | null {
  return witnesses(graph, start, [target]).get(target)!;
}

/** The nodes to draw for a theorem group (groupDrawing). */
export interface GroupDrawing {
  ids: string[];
  /** False when the limit or the step budget stopped the chain search early. */
  complete: boolean;
}

/**
 * Dependency links the chain search of one group drawing looks at, in
 * total. A million links take tens of milliseconds, which keeps a row
 * click responsive on any graph.
 */
export const GROUP_DRAWING_STEPS = 1_000_000;

/**
 * The nodes to draw for a theorem group, in the order the render cap keeps
 * them: the base, then the theorems, then the nodes on the shortest chain
 * from each theorem to each base member (theorems by ID, base members in
 * order). Each node appears once, at its first place. The chains stop at
 * `limit` nodes, or after `budget` dependency links, so a large group does
 * not search past what the cap shows.
 */
export function groupDrawing(
  graph: D3Graph,
  group: { base: readonly string[]; theorems: readonly string[] },
  limit: number,
  budget = GROUP_DRAWING_STEPS,
): GroupDrawing {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const order = new Set([...group.base, ...group.theorems]);
  const cut = (): GroupDrawing => ({ ids: [...order], complete: false });
  for (const theorem of group.theorems) {
    if (order.size >= limit) return cut();
    const tree = shortestTree(byId, theorem, group.base, budget);
    budget -= tree.steps;
    // Walk each chain up from its base member to the part an earlier chain
    // of this theorem already walked, so each tree node is walked once
    const walked = new Set([theorem]);
    for (const target of group.base) {
      if (!tree.parent.has(target)) continue;
      const segment: string[] = [];
      for (let v = tree.parent.get(target)!; v !== null && !walked.has(v); v = tree.parent.get(v)!) segment.push(v);
      walked.add(target);
      for (const id of segment.reverse()) {
        walked.add(id);
        if (order.has(id)) continue;
        if (order.size >= limit) return cut();
        order.add(id);
      }
    }
    if (tree.exhausted) return cut();
  }
  return { ids: [...order], complete: true };
}
