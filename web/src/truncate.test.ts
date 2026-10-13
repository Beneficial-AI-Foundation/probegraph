import { describe, it, expect } from 'vitest';
import { truncateToBudget, truncationSeeds, type TruncationDirection } from './truncate';
import { compileQuery, executeQuery, getLinkId } from './query';
import { exactIntent, textIntent } from './intent';
import { defaultFilters } from './url-state';
import type { D3Graph, D3Node, FilterOptions } from './types';

/** Graph from caller -> dependency pairs; every endpoint becomes a node. */
function graph(edges: [string, string][], extra: string[] = []): D3Graph {
  const ids = [...new Set([...edges.flat(), ...extra])];
  const nodes = ids.map(id => ({
    id, display_name: id, symbol: id, full_path: `/p/${id}.rs`, relative_path: `src/${id}.rs`,
    file_name: `${id}.rs`, parent_folder: 'src', crate_name: 'c', is_libsignal: true, kind: 'exec',
    language: 'rust', verification_status: 'verified' as const,
    dependencies: edges.filter(([s]) => s === id).map(([, t]) => t),
    dependents: edges.filter(([, t]) => t === id).map(([s]) => s),
  } as D3Node));
  return {
    nodes,
    links: edges.map(([source, target]) => ({ source, target, type: 'inner' as const })),
    metadata: { total_nodes: nodes.length, total_edges: edges.length, project_root: '', generated_at: '' },
  };
}

const ids = (g: D3Graph) => g.nodes.map(n => n.id).sort();

/** Every kept node reaches an anchor through kept links in the BFS direction. */
function everyNodeHasKeptPath(g: D3Graph, anchors: string[], direction: TruncationDirection): boolean {
  const next = new Map<string, string[]>();
  const add = (a: string, b: string) => next.set(a, [...(next.get(a) ?? []), b]);
  for (const l of g.links) {
    const { sourceId, targetId } = getLinkId(l);
    if (direction !== 'callers') add(sourceId, targetId);
    if (direction !== 'callees') add(targetId, sourceId);
  }
  const seen = new Set(anchors.filter(a => g.nodes.some(n => n.id === a)));
  const queue = [...seen];
  while (queue.length > 0) {
    for (const n of next.get(queue.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return g.nodes.every(n => seen.has(n.id));
}

/**
 * Callers of t: a wide hub h with many callers, and a chain t <- c1 <- c2 <- c3.
 * The hub callers have the most links, so truncation by connectivity keeps
 * them and drops the chain.
 */
function hubAndChain(): D3Graph {
  const edges: [string, string][] = [['h', 't'], ['c1', 't'], ['c2', 'c1'], ['c3', 'c2']];
  for (let i = 0; i < 12; i++) {
    const caller = `p${String(i).padStart(2, '0')}`;
    edges.push([caller, 'h']);
    edges.push([caller, `q${i}`]);  // gives each hub caller extra degree
  }
  return graph(edges);
}

function run(g: D3Graph, over: Partial<FilterOptions>) {
  const filters = { ...defaultFilters(), maxDepth: null, ...over };
  const compiled = compileQuery(filters, 'verus');
  const result = executeQuery(compiled, g);
  return { compiled, result };
}

describe('truncateToBudget', () => {
  it('keeps the anchor and nearest nodes, BFS by depth, ties by ID', () => {
    const { compiled, result } = run(hubAndChain(), { intent: exactIntent(['t'], 'callers', 't', { type: 'guide' }) });
    const seeds = truncationSeeds(compiled.query, compiled.anchorIds, result);
    expect(seeds).toEqual({ anchors: ['t'], direction: 'callers' });
    const cut = truncateToBudget(result, 5, seeds);
    // depth 1: c1, h. depth 2: c2, p00, p01, ... -> c2 and p00 by ID
    expect(ids(cut.graph)).toEqual(['c1', 'c2', 'h', 'p00', 't']);
    expect(cut.omitted).toBe(result.nodes.length - 5);
    expect(cut.anchorsShown).toBe(1);
    expect(everyNodeHasKeptPath(cut.graph, ['t'], 'callers')).toBe(true);
  });

  it('every kept node has a kept path to an anchor, at every budget', () => {
    const { compiled, result } = run(hubAndChain(), { intent: exactIntent(['t'], 'callers', 't', { type: 'guide' }) });
    const seeds = truncationSeeds(compiled.query, compiled.anchorIds, result)!;
    for (let budget = 1; budget < result.nodes.length; budget++) {
      const cut = truncateToBudget(result, budget, seeds);
      expect(cut.graph.nodes.length).toBe(budget);
      expect(cut.graph.nodes.some(n => n.id === 't')).toBe(true);
      expect(everyNodeHasKeptPath(cut.graph, ['t'], 'callers')).toBe(true);
    }
  });

  it('follows callees for callee queries and both directions for neighborhoods', () => {
    // a -> m -> z, and y -> m
    const g = graph([['a', 'm'], ['m', 'z'], ['y', 'm']]);
    expect(ids(truncateToBudget(g, 2, { anchors: ['m'], direction: 'callees' }).graph)).toEqual(['m', 'z']);
    expect(ids(truncateToBudget(g, 2, { anchors: ['m'], direction: 'callers' }).graph)).toEqual(['a', 'm']);
    expect(ids(truncateToBudget(g, 3, { anchors: ['m'], direction: 'both' }).graph)).toEqual(['a', 'm', 'y']);
  });

  it('keeps the first anchors by rank when there are more than the budget', () => {
    const g = graph([], ['n1', 'n2', 'n3', 'n4', 'n5']);
    const intent = exactIntent(['n4', 'n2', 'n5', 'n1', 'n3'], 'none', 'set', { type: 'guide' });
    const { compiled, result } = run(g, { intent });
    const cut = truncateToBudget(result, 3, truncationSeeds(compiled.query, compiled.anchorIds, result));
    expect(ids(cut.graph)).toEqual(['n2', 'n4', 'n5']);
    expect([cut.anchorsShown, cut.anchorsTotal, cut.omitted]).toEqual([3, 5, 2]);
  });

  it('uses the matched nodes of a text query as anchors', () => {
    const { compiled, result } = run(hubAndChain(), { intent: textIntent('', 'c1') });
    const seeds = truncationSeeds(compiled.query, compiled.anchorIds, result);
    expect(seeds).toEqual({ anchors: ['c1'], direction: 'callers' });
  });

  it('keeps nodes by traversal depth when display filters cut their path', () => {
    // Callers of t: z -> x -> m -> t and y -> t. The status filter removes m,
    // so x and z have no visible path to t. They are still ranked by their
    // traversal depth: y (1), then x (2), then z (3).
    const g = graph([['z', 'x'], ['x', 'm'], ['m', 't'], ['y', 't']]);
    g.nodes.find(n => n.id === 'm')!.verification_status = 'failed';
    const { compiled, result } = run(g, {
      intent: exactIntent(['t'], 'callers', 't', { type: 'guide' }), showFailedNodes: false,
    });
    expect(result.displayRemoved).toBe(1);
    expect(ids(result)).toEqual(['t', 'x', 'y', 'z']);
    const cut = truncateToBudget(result, 3, truncationSeeds(compiled.query, compiled.anchorIds, result));
    expect(ids(cut.graph)).toEqual(['t', 'x', 'y']);
    expect(cut.omitted).toBe(1);
  });

  it('fills the budget when a display filter cuts the anchor off', () => {
    // t <- m <- a_i <- b_i, with m hidden by the status filter. Ranking by
    // visible links alone would keep only t.
    const edges: [string, string][] = [['m', 't']];
    for (let i = 0; i < 30; i++) {
      const k = String(i).padStart(2, '0');
      edges.push([`a${k}`, 'm'], [`b${k}`, `a${k}`]);
    }
    const g = graph(edges);
    g.nodes.find(n => n.id === 'm')!.verification_status = 'failed';
    const { compiled, result } = run(g, {
      intent: exactIntent(['t'], 'callers', 't', { type: 'guide' }), showFailedNodes: false,
    });
    expect(result.nodes.length).toBe(61);
    const cut = truncateToBudget(result, 20, truncationSeeds(compiled.query, compiled.anchorIds, result));
    expect(cut.graph.nodes.length).toBe(20);
    // depth 2: a00..a29, ties by ID
    expect(ids(cut.graph)).toEqual([...Array.from({ length: 19 }, (_, i) => `a${String(i).padStart(2, '0')}`), 't']);
  });

  it('fills the rest of the budget with unreached nodes, most connected first', () => {
    // No traversal depths: BFS over links from m reaches z only; then the
    // unreached nodes by connectivity, ties by ID
    const g = graph([['m', 'z'], ['p', 'q'], ['p', 'r']], ['s']);
    const cut = truncateToBudget(g, 4, { anchors: ['m'], direction: 'callees' });
    expect(ids(cut.graph)).toEqual(['m', 'p', 'q', 'z']);
  });

  it('falls back to connectivity without anchors', () => {
    const { compiled, result } = run(hubAndChain(), {});
    expect(truncationSeeds(compiled.query, compiled.anchorIds, result)).toBeNull();
    const cut = truncateToBudget(result, 1, null);
    expect(ids(cut.graph)).toEqual(['h']);
  });

  it('returns the graph unchanged within the budget', () => {
    const g = graph([['a', 'b']]);
    const cut = truncateToBudget(g, 5, { anchors: ['b'], direction: 'callers' });
    expect(cut.graph).toBe(g);
    expect(cut.omitted).toBe(0);
  });
});

describe('displayRemoved', () => {
  it('is 0 for queries without traversal', () => {
    const g = graph([['a', 'b']]);
    g.nodes[0].verification_status = 'failed';
    expect(run(g, { showFailedNodes: false }).result.displayRemoved).toBe(0);
  });
});
