/**
 * Unit tests for entry-point seeding (graph-utils.ts):
 * seed tier computation, budgeted BFS expansion, refusal reporting.
 *
 * The final describe block is a golden check against the sm-import-test
 * merged fixture as measured through parseAndNormalizeGraph(); it is skipped
 * when the fixture is not checked out next to this repo.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeSeedTiers, expandFromSeeds, markStubCrates, SeedBudget } from './graph-utils';
import { computeTopologicalDepth } from './graph';
import { parseAndNormalizeGraph } from './graph-loader';
import { D3Graph, D3Node, D3Link } from './types';

function createNode(id: string, kind: string = 'exec'): D3Node {
  return {
    id,
    display_name: id,
    symbol: id,
    full_path: `/path/to/${id}.rs`,
    relative_path: `src/${id}.rs`,
    file_name: 'test.rs',
    parent_folder: 'src',
    crate_name: 'test',
    is_libsignal: true,
    dependencies: [],
    dependents: [],
    kind,
  };
}

function createGraph(nodeSpecs: Array<[string, string?]>, links: Array<[string, string, string?]>): D3Graph {
  const nodes = nodeSpecs.map(([id, kind]) => createNode(id, kind));
  const d3links: D3Link[] = links.map(([source, target, type]) => ({ source, target, type: type || 'inner' }));
  return {
    nodes,
    links: d3links,
    metadata: { total_nodes: nodes.length, total_edges: d3links.length, project_root: '/test', generated_at: '2024-01-01' },
  };
}

const WIDE_BUDGET: SeedBudget = { maxNodes: 1000, maxLinks: 10000 };

describe('computeSeedTiers', () => {
  it('finds in-degree-0 nodes as sources', () => {
    const g = createGraph(
      [['a'], ['b'], ['c'], ['d']],
      [['a', 'c'], ['b', 'c'], ['c', 'd']],
    );
    const tiers = computeSeedTiers(g);
    expect(tiers).toHaveLength(1);
    expect(tiers[0].name).toBe('sources');
    expect(tiers[0].seeds.sort()).toEqual(['a', 'b']);
  });

  it('counts in-degree over all link types, not just inner calls', () => {
    // b is only targeted by a spec link; it must not be a source
    const g = createGraph(
      [['a'], ['b']],
      [['a', 'b', 'spec']],
    );
    const tiers = computeSeedTiers(g);
    expect(tiers[0].seeds).toEqual(['a']);
  });

  it('ignores self-loops for in-degree: a self-recursive root is still a seed', () => {
    const g = createGraph(
      [['a'], ['b']],
      [['a', 'a'], ['a', 'b']],
    );
    const tiers = computeSeedTiers(g);
    expect(tiers[0].seeds).toEqual(['a']);
  });

  it('offers a source-defs tier only as a strict non-empty subset', () => {
    const g = createGraph(
      [['t1', 'theorem'], ['d1', 'def'], ['x']],
      [['t1', 'x'], ['d1', 'x']],
    );
    const tiers = computeSeedTiers(g);
    expect(tiers.map(t => t.name)).toEqual(['sources', 'source-defs']);
    expect(tiers[1].seeds).toEqual(['d1']);
  });

  it('skips the source-defs tier when no source has a definition kind (SCIP graphs)', () => {
    const g = createGraph(
      [['a'], ['b'], ['c']],
      [['a', 'c'], ['b', 'c']],
    );
    const tiers = computeSeedTiers(g);
    expect(tiers.map(t => t.name)).toEqual(['sources']);
  });

  it('skips the source-defs tier when it equals the sources tier', () => {
    const g = createGraph(
      [['d1', 'def'], ['d2', 'def'], ['x']],
      [['d1', 'x'], ['d2', 'x']],
    );
    const tiers = computeSeedTiers(g);
    expect(tiers.map(t => t.name)).toEqual(['sources']);
  });

  it('puts explicit entry points ahead of the topological tiers', () => {
    // b has in-degree 1: entry points need not be sources (public-API
    // translations and blueprint declarations usually have callers)
    const g = createGraph(
      [['a'], ['b'], ['c']],
      [['a', 'b'], ['b', 'c']],
    );
    g.nodes.find(n => n.id === 'b')!.is_entry_point = true;
    const tiers = computeSeedTiers(g);
    expect(tiers.map(t => t.name)).toEqual(['entry-points', 'sources']);
    expect(tiers[0].seeds).toEqual(['b']);
    expect(tiers[1].seeds).toEqual(['a']);
  });

  it('offers no entry-points tier when no node is flagged', () => {
    const g = createGraph([['a'], ['b']], [['a', 'b']]);
    expect(computeSeedTiers(g).map(t => t.name)).toEqual(['sources']);
  });
});

describe('expandFromSeeds', () => {
  it('expands seeds by one layer and returns the induced view', () => {
    // a -> b -> c; a -> d; shortcut a -> c
    const g = createGraph(
      [['a'], ['b'], ['c'], ['d']],
      [['a', 'b'], ['b', 'c'], ['a', 'd'], ['a', 'c']],
    );
    const r = expandFromSeeds(g, ['a'], 1, WIDE_BUDGET);
    if (!r.ok) throw new Error('expected ok');
    expect([...r.nodeIds].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(r.depth).toBe(1);
    // Induced count, not BFS tree count: includes the b->c edge between
    // depth-1 nodes and the a->c shortcut
    expect(r.linkCount).toBe(4);
    expect(r.nodeDepths.get('a')).toBe(0);
    expect(r.nodeDepths.get('b')).toBe(1);
    expect(r.nodeDepths.get('c')).toBe(1);
  });

  it('counts parallel links individually in the budget', () => {
    const g = createGraph(
      [['a'], ['b']],
      [['a', 'b', 'inner'], ['a', 'b', 'spec'], ['a', 'b', 'mapping']],
    );
    const ok = expandFromSeeds(g, ['a'], 1, { maxNodes: 10, maxLinks: 3 });
    expect(ok.ok).toBe(true);
    const refused = expandFromSeeds(g, ['a'], 1, { maxNodes: 10, maxLinks: 2 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.failedBudget).toBe('links');
      expect(refused.refusal.links).toBe(3);
    }
  });

  it('fails with a refusal naming the budget when depth 1 does not fit', () => {
    const g = createGraph(
      [['a'], ['b'], ['c'], ['d']],
      [['a', 'b'], ['a', 'c'], ['a', 'd']],
    );
    const r = expandFromSeeds(g, ['a'], 1, { maxNodes: 3, maxLinks: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.failedBudget).toBe('nodes');
      expect(r.refusal.depth).toBe(1);
      expect(r.refusal.nodes).toBe(4);
    }
  });

  it('fails when the seed set alone exceeds the budget', () => {
    const g = createGraph(
      [['a'], ['b'], ['c']],
      [],
    );
    const r = expandFromSeeds(g, ['a', 'b', 'c'], 1, { maxNodes: 2, maxLinks: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.failedBudget).toBe('nodes');
  });

  it('returns the largest admissible depth with refusal info when the requested depth breaks the budget', () => {
    // chain a -> b -> c -> d -> e, budget allows 3 nodes (depth 2 has 3)
    const g = createGraph(
      [['a'], ['b'], ['c'], ['d'], ['e']],
      [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']],
    );
    const r = expandFromSeeds(g, ['a'], 4, { maxNodes: 3, maxLinks: 100 });
    if (!r.ok) throw new Error('expected ok');
    expect(r.depth).toBe(2);
    expect(r.requestedDepth).toBe(4);
    expect([...r.nodeIds].sort()).toEqual(['a', 'b', 'c']);
    expect(r.linkCount).toBe(2);
    // The rejected layer must be rolled back from the depths map
    expect(r.nodeDepths.has('d')).toBe(false);
    expect(r.refusal).toBeDefined();
    expect(r.refusal!.depth).toBe(3);
    expect(r.refusal!.failedBudget).toBe('nodes');
  });

  it('reports saturation and honors the requested depth when reachability is exhausted', () => {
    const g = createGraph(
      [['a'], ['b']],
      [['a', 'b']],
    );
    const r = expandFromSeeds(g, ['a'], 5, WIDE_BUDGET);
    if (!r.ok) throw new Error('expected ok');
    expect(r.saturated).toBe(true);
    expect(r.depth).toBe(5);
    expect([...r.nodeIds].sort()).toEqual(['a', 'b']);
  });

  it('terminates with finite depths on cyclic graphs', () => {
    // root -> x, x <-> y mutual recursion, x -> x self-loop
    const g = createGraph(
      [['root'], ['x'], ['y']],
      [['root', 'x'], ['x', 'y'], ['y', 'x'], ['x', 'x']],
    );
    const r = expandFromSeeds(g, ['root'], 10, WIDE_BUDGET);
    if (!r.ok) throw new Error('expected ok');
    expect(r.nodeDepths.get('root')).toBe(0);
    expect(r.nodeDepths.get('x')).toBe(1);
    expect(r.nodeDepths.get('y')).toBe(2);
    // All 4 links (including the cycle-closing and self edges) are induced
    expect(r.linkCount).toBe(4);
  });

  it('deduplicates seeds and ignores seeds not present in the graph', () => {
    const g = createGraph(
      [['a'], ['b']],
      [['a', 'b']],
    );
    const r = expandFromSeeds(g, ['a', 'a', 'ghost'], 1, WIDE_BUDGET);
    if (!r.ok) throw new Error('expected ok');
    expect([...r.nodeIds].sort()).toEqual(['a', 'b']);
  });
});

describe('computeTopologicalDepth (renderer fallback)', () => {
  it('terminates with finite depths on cyclic graphs', () => {
    // root -> x, x <-> y mutual recursion; without the depth cap this looped
    // forever, so seeded views bypass it — but selection/paths views do not.
    const g = createGraph(
      [['root'], ['x'], ['y']],
      [['root', 'x'], ['x', 'y'], ['y', 'x']],
    );
    const depths = computeTopologicalDepth(g.nodes, g.links);
    expect(depths.size).toBe(3);
    for (const d of depths.values()) {
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeLessThanOrEqual(g.nodes.length);
    }
    expect(depths.get('root')).toBe(0);
  });

  it('terminates on a rootless pure cycle', () => {
    const g = createGraph(
      [['x'], ['y'], ['z']],
      [['x', 'y'], ['y', 'z'], ['z', 'x']],
    );
    const depths = computeTopologicalDepth(g.nodes, g.links);
    expect(depths.size).toBe(3);
  });

  it('still computes longest-path layering on a DAG', () => {
    // a -> b -> c plus shortcut a -> c: c must sit at depth 2, not 1
    const g = createGraph(
      [['a'], ['b'], ['c']],
      [['a', 'b'], ['b', 'c'], ['a', 'c']],
    );
    const depths = computeTopologicalDepth(g.nodes, g.links);
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('c')).toBe(2);
  });
});

// ============================================================================
// Golden fixture: sm-import-test merged graph through the web loader.
// Numbers measured 2026-09-22; re-pin when the fixture or loader changes.
// ============================================================================

const SM_IMPORT_PATH = resolve(
  __dirname,
  '../../../sm-import-test/.verilib/probes/merged_smimporttest_securemessaging.json',
);

describe.skipIf(!existsSync(SM_IMPORT_PATH))('Golden: sm-import-test merged graph', () => {
  it('seeds 133 sources and expands to 648 nodes / 4514 links at depth 1', () => {
    const graph = parseAndNormalizeGraph(JSON.parse(readFileSync(SM_IMPORT_PATH, 'utf8')));
    expect(graph.nodes.length).toBe(1547);
    expect(graph.links.length).toBe(22479);

    const tiers = computeSeedTiers(graph);
    expect(tiers[0].name).toBe('sources');
    expect(tiers[0].seeds.length).toBe(133);

    const r = expandFromSeeds(graph, tiers[0].seeds, 1, { maxNodes: 2000, maxLinks: 10000 });
    if (!r.ok) throw new Error('expected ok');
    expect(r.nodeIds.size).toBe(648);
    expect(r.linkCount).toBe(4514);
    expect(r.depth).toBe(1);
  });
});

// ============================================================================
// Golden fixture: merged Aeneas output extracted with --with-public-api.
// Validates the Phase 2 entry-point derivation on real data: 146 public-API
// Rust atoms, 100 of which have translation-name mappings that all resolve to
// Lean atoms (the Aeneas join), and no blueprint attributes.
// Numbers measured 2026-09-22; re-pin when the fixture or loader changes.
// ============================================================================

const AENEAS_PATH = resolve(
  __dirname,
  '../../../probe-aeneas/examples/aeneas_curve25519-dalek_4.2.0.json',
);

describe.skipIf(!existsSync(AENEAS_PATH))('Golden: Aeneas curve25519-dalek 4.2.0 merged graph', () => {
  it('derives 246 entry points (146 public API + 100 Lean translation targets)', () => {
    const graph = parseAndNormalizeGraph(JSON.parse(readFileSync(AENEAS_PATH, 'utf8')));
    expect(graph.nodes.length).toBe(2292);

    const entryPoints = graph.nodes.filter(n => n.is_entry_point);
    expect(entryPoints.length).toBe(246);
    expect(entryPoints.filter(n => n.language === 'rust').length).toBe(146);
    expect(entryPoints.filter(n => n.language === 'lean').length).toBe(100);
    // The Aeneas join flags Lean atoms that are never public API themselves
    expect(entryPoints.filter(n => n.language === 'lean' && n.is_public_api).length).toBe(0);

    const tiers = computeSeedTiers(graph);
    expect(tiers[0].name).toBe('entry-points');
    expect(tiers[0].seeds.length).toBe(246);

    const r = expandFromSeeds(graph, tiers[0].seeds, 1, { maxNodes: 2000, maxLinks: 10000 });
    if (!r.ok) throw new Error('expected ok');
    expect(r.depth).toBe(1);
    expect(r.nodeIds.size).toBe(526);
    expect(r.linkCount).toBe(1837);
  });
});

describe('markStubCrates', () => {
  const node = (id: string, crate: string, path: string, language?: string): D3Node =>
    ({ ...createNode(id), crate_name: crate, relative_path: path, language });
  const graphOf = (nodes: D3Node[]): D3Graph =>
    ({ nodes, links: [], metadata: { total_nodes: nodes.length, total_edges: 0, project_root: '/', generated_at: '' } });
  const stubIds = (g: D3Graph) => g.nodes.filter(n => n.in_stub_crate).map(n => n.id);

  it('marks every node of a crate with no source path', () => {
    const g = graphOf([node('a', 'app', 'src/a.rs'), node('x', 'dep', ''), node('y', 'dep', '')]);
    markStubCrates(g);
    expect(stubIds(g)).toEqual(['x', 'y']);
  });

  it('keeps a crate with at least one source path whole', () => {
    const g = graphOf([node('a', 'app', 'src/a.rs'), node('b', 'app', '')]);
    markStubCrates(g);
    expect(stubIds(g)).toEqual([]);
  });

  it('marks nothing when no node has a source path', () => {
    const g = graphOf([node('x', 'dep', ''), node('y', 'other', '')]);
    markStubCrates(g);
    expect(stubIds(g)).toEqual([]);
  });

  it('never marks blueprint nodes', () => {
    const g = graphOf([node('a', 'app', 'src/a.rs'), node('bp', 'Blueprint', '', 'blueprint')]);
    markStubCrates(g);
    expect(stubIds(g)).toEqual([]);
  });
});
