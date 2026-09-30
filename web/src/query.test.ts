/**
 * Unit tests for the composable query pipeline (query.ts).
 *
 * Each operator is tested in isolation on small hand-crafted graphs.
 * Tier 1 tests from the plan.
 */

import { describe, it, expect } from 'vitest';
import {
  selectNodes,
  traverseForward,
  traverseBackward,
  traverseBidirectional,
  findPaths,
  crateBoundary,
  filterLinksByType,
  linkTypeShown,
  depthFilterLinks,
  removeIsolated,
  resolveNodeMatcher,
  compileQuery,
  compileSeededDisplayPredicate,
  TraversalPredicates,
} from './query';
import { D3Graph, D3Node, D3Link, FilterOptions, LinkRole } from './types';
import { NONE_INTENT, textIntent } from './intent';

// ============================================================================
// Test Helpers
// ============================================================================

function createNode(props: {
  id: string;
  display_name: string;
  file_name?: string;
  parent_folder?: string;
  relative_path?: string;
  crate_name?: string;
  kind?: string;
  is_libsignal?: boolean;
}): D3Node {
  return {
    id: props.id,
    display_name: props.display_name,
    symbol: props.id,
    full_path: `/path/to/${props.display_name}.rs`,
    relative_path: props.relative_path || `src/${props.display_name}.rs`,
    file_name: props.file_name || 'test.rs',
    parent_folder: props.parent_folder || 'src',
    crate_name: props.crate_name || 'test',
    is_libsignal: props.is_libsignal ?? true,
    dependencies: [],
    dependents: [],
    kind: props.kind || 'exec',
  };
}

function createLink(source: string, target: string, type: string = 'inner'): D3Link {
  return { source, target, type };
}

function createGraph(
  nodes: D3Node[],
  links: D3Link[],
): D3Graph {
  return {
    nodes,
    links,
    metadata: { total_nodes: nodes.length, total_edges: links.length, project_root: '/test', generated_at: '2024-01-01' },
  };
}

function createFilters(overrides: Partial<FilterOptions> = {}): FilterOptions {
  return {
    showLibsignal: true,
    showNonLibsignal: true,
    showInnerCalls: true,
    showPreconditionCalls: true,
    showPostconditionCalls: true,
    showMappingLinks: true,
    showSpecLinks: true,
    showStatementDeps: true,
    showBodyDeps: true,
    showExecFunctions: true,
    showProofFunctions: true,
    showSpecFunctions: true,
    showAxioms: true,
    showTypes: true,
    showProjections: true,
    showInstances: true,
    showRustNodes: true,
    showLeanNodes: true,
    showVerifiedNodes: true,
    showFailedNodes: true,
    showUnverifiedNodes: true,
    exactStatuses: null,
    excludeNamePatterns: '',
    excludePathPatterns: '',
    includeFiles: '',
    maxDepth: null,
    intent: NONE_INTENT,
    selectedNodes: new Set(),
    expandedNodes: new Set(),
    hiddenNodes: new Set(),
    ...overrides,
  };
}

/** A → B → C linear graph */
function linearGraph(): D3Graph {
  return createGraph(
    [
      createNode({ id: 'a', display_name: 'func_a' }),
      createNode({ id: 'b', display_name: 'func_b' }),
      createNode({ id: 'c', display_name: 'func_c' }),
    ],
    [createLink('a', 'b'), createLink('b', 'c')],
  );
}

/**
 * Diamond: A → B, A → C, B → D, C → D
 */
function diamondGraph(): D3Graph {
  return createGraph(
    [
      createNode({ id: 'a', display_name: 'start' }),
      createNode({ id: 'b', display_name: 'left' }),
      createNode({ id: 'c', display_name: 'right' }),
      createNode({ id: 'd', display_name: 'end' }),
    ],
    [
      createLink('a', 'b'),
      createLink('a', 'c'),
      createLink('b', 'd'),
      createLink('c', 'd'),
    ],
  );
}

/** Default traversal predicates that accept everything. */
function acceptAll(): TraversalPredicates {
  return {
    kindFilter: () => true,
    excludeNamePatterns: [],
    excludePathPatterns: [],
    includeFilePatterns: [],
    hiddenNodes: new Set(),
    excludeBuildArtifacts: false,
  };
}

// ============================================================================
// selectNodes
// ============================================================================

describe('selectNodes', () => {
  it('keeps all nodes when predicate accepts everything', () => {
    const g = linearGraph();
    const result = selectNodes(g, acceptAll());
    expect(result.nodes.length).toBe(3);
    expect(result.links.length).toBe(2);
  });

  it('removes nodes that fail kindFilter', () => {
    const g = createGraph(
      [
        createNode({ id: 'a', display_name: 'exec_fn', kind: 'exec' }),
        createNode({ id: 'b', display_name: 'proof_fn', kind: 'proof' }),
        createNode({ id: 'c', display_name: 'spec_fn', kind: 'spec' }),
      ],
      [createLink('a', 'b'), createLink('a', 'c')],
    );
    const pred: TraversalPredicates = {
      ...acceptAll(),
      kindFilter: (n) => n.kind !== 'proof',
    };
    const result = selectNodes(g, pred);
    expect(result.nodes.map(n => n.id).sort()).toEqual(['a', 'c']);
    // link a→b removed because b is gone; a→c remains
    expect(result.links.length).toBe(1);
  });

  it('excludes hidden nodes', () => {
    const g = linearGraph();
    const pred: TraversalPredicates = {
      ...acceptAll(),
      hiddenNodes: new Set(['b']),
    };
    const result = selectNodes(g, pred);
    expect(result.nodes.map(n => n.id).sort()).toEqual(['a', 'c']);
    expect(result.links.length).toBe(0);
  });

  it('excludes build artifact nodes', () => {
    const g = createGraph(
      [
        createNode({ id: 'a', display_name: 'fn_a', relative_path: 'src/main.rs' }),
        createNode({ id: 'b', display_name: 'fn_b', relative_path: 'target/debug/build.rs' }),
      ],
      [createLink('a', 'b')],
    );
    const pred: TraversalPredicates = {
      ...acceptAll(),
      excludeBuildArtifacts: true,
    };
    const result = selectNodes(g, pred);
    expect(result.nodes.map(n => n.id)).toEqual(['a']);
  });
});

// ============================================================================
// traverseForward
// ============================================================================

describe('traverseForward', () => {
  it('A→B→C: depth 1 from A returns {A, B}', () => {
    const g = linearGraph();
    const result = traverseForward(g, new Set(['a']), 1);
    expect([...result.nodeIds].sort()).toEqual(['a', 'b']);
    expect(result.calleeDepths!.get('a')).toBe(0);
    expect(result.calleeDepths!.get('b')).toBe(1);
  });

  it('A→B→C: depth null (unlimited) from A returns {A, B, C}', () => {
    const g = linearGraph();
    const result = traverseForward(g, new Set(['a']), null);
    expect([...result.nodeIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('A→B→C: depth 0 from A returns just {A}', () => {
    const g = linearGraph();
    const result = traverseForward(g, new Set(['a']), 0);
    expect([...result.nodeIds]).toEqual(['a']);
  });

  it('diamond: depth 2 from A reaches D via both paths', () => {
    const g = diamondGraph();
    const result = traverseForward(g, new Set(['a']), 2);
    expect([...result.nodeIds].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ============================================================================
// traverseBackward
// ============================================================================

describe('traverseBackward', () => {
  it('A→B→C: depth 1 from C returns {B, C}', () => {
    const g = linearGraph();
    const result = traverseBackward(g, new Set(['c']), 1);
    expect([...result.nodeIds].sort()).toEqual(['b', 'c']);
    expect(result.callerDepths!.get('c')).toBe(0);
    expect(result.callerDepths!.get('b')).toBe(1);
  });

  it('A→B→C: unlimited from C returns {A, B, C}', () => {
    const g = linearGraph();
    const result = traverseBackward(g, new Set(['c']), null);
    expect([...result.nodeIds].sort()).toEqual(['a', 'b', 'c']);
  });
});

// ============================================================================
// traverseBidirectional
// ============================================================================

describe('traverseBidirectional', () => {
  it('A→B→C: from B at depth 1 returns {A, B, C}', () => {
    const g = linearGraph();
    const result = traverseBidirectional(g, new Set(['b']), 1);
    expect([...result.nodeIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('A→B→C: from B at depth 0 returns just {B}', () => {
    const g = linearGraph();
    const result = traverseBidirectional(g, new Set(['b']), 0);
    expect([...result.nodeIds]).toEqual(['b']);
  });

  it('diamond: from B at depth 1 returns A, B, D (not C)', () => {
    const g = diamondGraph();
    const result = traverseBidirectional(g, new Set(['b']), 1);
    // B's neighbors: A (backward) and D (forward)
    expect([...result.nodeIds].sort()).toEqual(['a', 'b', 'd']);
  });
});

// ============================================================================
// findPaths
// ============================================================================

describe('findPaths', () => {
  it('diamond: source→sink finds all path nodes', () => {
    const g = diamondGraph();
    const result = findPaths(g, new Set(['a']), new Set(['d']));
    expect([...result.nodeIds].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('linear: reverse direction returns empty', () => {
    const g = linearGraph();
    const result = findPaths(g, new Set(['c']), new Set(['a']));
    expect(result.nodeIds.size).toBe(0);
  });

  it('linear: A to C returns all three', () => {
    const g = linearGraph();
    const result = findPaths(g, new Set(['a']), new Set(['c']));
    expect([...result.nodeIds].sort()).toEqual(['a', 'b', 'c']);
  });
});

// ============================================================================
// crateBoundary
// ============================================================================

describe('crateBoundary', () => {
  const twoCrateGraph = () => createGraph(
    [
      createNode({ id: 'a1', display_name: 'fn_a1', crate_name: 'crateA' }),
      createNode({ id: 'a2', display_name: 'fn_a2', crate_name: 'crateA' }),
      createNode({ id: 'b1', display_name: 'fn_b1', crate_name: 'crateB' }),
      createNode({ id: 'b2', display_name: 'fn_b2', crate_name: 'crateB' }),
    ],
    [
      createLink('a1', 'b1'), // cross-crate
      createLink('a2', 'b2'), // cross-crate
      createLink('a1', 'a2'), // intra-crate
      createLink('b1', 'b2'), // intra-crate
    ],
  );

  it('returns only cross-crate edges from A to B', () => {
    const result = crateBoundary(twoCrateGraph(), 'crateA', 'crateB');
    expect([...result.nodeIds].sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(result.boundaryLinkPairs!.size).toBe(2);
  });

  it('reverse direction (B→A) returns empty', () => {
    const result = crateBoundary(twoCrateGraph(), 'crateB', 'crateA');
    expect(result.nodeIds.size).toBe(0);
  });
});

// ============================================================================
// filterLinksByType
// ============================================================================

describe('linkTypeShown for spec links', () => {
  const allOn = {
    showInnerCalls: true, showPreconditionCalls: true, showPostconditionCalls: true,
    showMappingLinks: true, showSpecLinks: true, showStatementDeps: true, showBodyDeps: true,
  };
  const spec = (role?: LinkRole): D3Link => ({ source: 'thm', target: 'def', type: 'spec', ...(role && { role }) });

  // [role, showSpecLinks, showStatementDeps, showBodyDeps, shown]
  it.each([
    [undefined, true, false, false, true],
    [undefined, false, true, true, false],
    ['type', true, true, true, true],
    ['type', true, false, true, false],
    ['type', false, true, true, false],
    ['term', true, true, false, false],
    ['term', true, false, true, true],
    ['both', true, false, true, true],
    ['both', true, true, false, true],
    ['both', true, false, false, false],
  ] as [LinkRole | undefined, boolean, boolean, boolean, boolean][])(
    'role %s, spec=%s statement=%s body=%s -> %s',
    (role, showSpecLinks, showStatementDeps, showBodyDeps, shown) => {
      expect(linkTypeShown(spec(role), { ...allOn, showSpecLinks, showStatementDeps, showBodyDeps }))
        .toBe(shown);
    },
  );
});

describe('filterLinksByType', () => {
  const links: D3Link[] = [
    createLink('a', 'b', 'inner'),
    createLink('a', 'c', 'precondition'),
    createLink('a', 'd', 'postcondition'),
  ];

  it('keeps all when all types enabled', () => {
    const result = filterLinksByType(links, {
      showInnerCalls: true,
      showPreconditionCalls: true,
      showPostconditionCalls: true,
      showMappingLinks: true,
      showSpecLinks: true,
      showStatementDeps: true,
      showBodyDeps: true,
    });
    expect(result.length).toBe(3);
  });

  it('hides precondition links', () => {
    const result = filterLinksByType(links, {
      showInnerCalls: true,
      showPreconditionCalls: false,
      showPostconditionCalls: true,
      showMappingLinks: true,
      showSpecLinks: true,
      showStatementDeps: true,
      showBodyDeps: true,
    });
    expect(result.length).toBe(2);
    expect(result.every(l => l.type !== 'precondition')).toBe(true);
  });

  it('only inner calls', () => {
    const result = filterLinksByType(links, {
      showInnerCalls: true,
      showPreconditionCalls: false,
      showPostconditionCalls: false,
      showMappingLinks: true,
      showSpecLinks: true,
      showStatementDeps: true,
      showBodyDeps: true,
    });
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('inner');
  });

  it('handles legacy "calls" type as inner', () => {
    const legacy = [createLink('a', 'b', 'calls')];
    const result = filterLinksByType(legacy, {
      showInnerCalls: false,
      showPreconditionCalls: true,
      showPostconditionCalls: true,
      showMappingLinks: true,
      showSpecLinks: true,
      showStatementDeps: true,
      showBodyDeps: true,
    });
    expect(result.length).toBe(0);
  });

  it('filters mapping links', () => {
    const mixedLinks = [
      createLink('a', 'b', 'inner'),
      createLink('a', 'c', 'mapping'),
      createLink('d', 'c', 'spec'),
    ];
    const result = filterLinksByType(mixedLinks, {
      showInnerCalls: true,
      showPreconditionCalls: true,
      showPostconditionCalls: true,
      showMappingLinks: false,
      showSpecLinks: true,
      showStatementDeps: true,
      showBodyDeps: true,
    });
    expect(result.length).toBe(2);
    expect(result.every(l => l.type !== 'mapping')).toBe(true);
  });

  it('filters spec links', () => {
    const mixedLinks = [
      createLink('a', 'b', 'inner'),
      createLink('a', 'c', 'mapping'),
      createLink('d', 'c', 'spec'),
    ];
    const result = filterLinksByType(mixedLinks, {
      showInnerCalls: true,
      showPreconditionCalls: true,
      showPostconditionCalls: true,
      showMappingLinks: true,
      showSpecLinks: false,
      showStatementDeps: true,
      showBodyDeps: true,
    });
    expect(result.length).toBe(2);
    expect(result.every(l => l.type !== 'spec')).toBe(true);
  });
});

// ============================================================================
// depthFilterLinks
// ============================================================================

describe('depthFilterLinks', () => {
  it('keeps depth-consistent callee links (source_depth + 1 = target_depth)', () => {
    const links: D3Link[] = [
      createLink('a', 'b'), // a=0, b=1 -> keep
      createLink('a', 'c'), // a=0, c=2 -> remove (shortcut)
      createLink('b', 'c'), // b=1, c=2 -> keep
    ];
    const depths = new Map([['a', 0], ['b', 1], ['c', 2]]);
    const result = depthFilterLinks(links, depths, undefined);
    expect(result.length).toBe(2);
    const pairs = result.map(l => `${l.source}->${l.target}`);
    expect(pairs).toContain('a->b');
    expect(pairs).toContain('b->c');
    expect(pairs).not.toContain('a->c');
  });

  it('keeps depth-consistent caller links (target_depth + 1 = source_depth)', () => {
    const links: D3Link[] = [
      createLink('a', 'b'), // callerDepths: b=0, a=1 -> target_depth(b=0) + 1 = source_depth(a=1) -> keep
      createLink('c', 'b'), // callerDepths: b=0, c not in map -> skip
    ];
    const callerDepths = new Map([['b', 0], ['a', 1]]);
    const result = depthFilterLinks(links, undefined, callerDepths);
    expect(result.length).toBe(1);
  });
});

// ============================================================================
// removeIsolated
// ============================================================================

describe('removeIsolated', () => {
  it('removes disconnected nodes', () => {
    const nodes = [
      createNode({ id: 'a', display_name: 'a' }),
      createNode({ id: 'b', display_name: 'b' }),
      createNode({ id: 'c', display_name: 'c' }),
    ];
    const links: D3Link[] = [createLink('a', 'b')];
    const result = removeIsolated(nodes, links);
    expect(result.map(n => n.id).sort()).toEqual(['a', 'b']);
  });

  it('keeps focus set nodes even if isolated', () => {
    const nodes = [
      createNode({ id: 'a', display_name: 'a' }),
      createNode({ id: 'b', display_name: 'b' }),
      createNode({ id: 'c', display_name: 'c' }),
    ];
    const links: D3Link[] = [createLink('a', 'b')];
    const result = removeIsolated(nodes, links, new Set(['c']));
    expect(result.map(n => n.id).sort()).toEqual(['a', 'b', 'c']);
  });
});

// ============================================================================
// resolveNodeMatcher
// ============================================================================

describe('resolveNodeMatcher', () => {
  const graph = linearGraph();
  const allIds = new Set(graph.nodes.map(n => n.id));

  it('pattern matcher resolves against display_name', () => {
    const result = resolveNodeMatcher(
      { kind: 'pattern', query: 'func_a' },
      graph, allIds,
    );
    expect([...result]).toEqual(['a']);
  });

  it('pattern matcher filters to traversable set', () => {
    const traversable = new Set(['b', 'c']); // a is NOT traversable
    const result = resolveNodeMatcher(
      { kind: 'pattern', query: 'func_a' },
      graph, traversable,
    );
    expect(result.size).toBe(0);
  });

  it('crate matcher matches crate_name', () => {
    const g = createGraph(
      [
        createNode({ id: 'x', display_name: 'fn', crate_name: 'mylib' }),
        createNode({ id: 'y', display_name: 'fn2', crate_name: 'other' }),
      ],
      [],
    );
    const result = resolveNodeMatcher(
      { kind: 'crate', pattern: 'mylib' },
      g, new Set(['x', 'y']),
    );
    expect([...result]).toEqual(['x']);
  });

  it('nodeIds matcher passes through IDs directly', () => {
    const result = resolveNodeMatcher(
      { kind: 'nodeIds', ids: new Set(['a', 'c']) },
      graph, allIds,
    );
    expect([...result].sort()).toEqual(['a', 'c']);
  });
});

// ============================================================================
// compileQuery dispatch table
// ============================================================================

describe('compileQuery', () => {
  it('source only -> callees', () => {
    const compiled = compileQuery(createFilters({ intent: textIntent('foo', ''), maxDepth: 2 }));
    expect(compiled.query.type).toBe('callees');
    if (compiled.query.type === 'callees') {
      expect(compiled.query.maxDepth).toBe(2);
    }
  });

  it('sink only -> callers', () => {
    const compiled = compileQuery(createFilters({ intent: textIntent('', 'bar'), maxDepth: 1 }));
    expect(compiled.query.type).toBe('callers');
  });

  it('same source and sink -> neighborhood', () => {
    const compiled = compileQuery(createFilters({ intent: textIntent('foo', 'foo') }));
    expect(compiled.query.type).toBe('neighborhood');
  });

  it('different source and sink -> paths', () => {
    const compiled = compileQuery(createFilters({ intent: textIntent('foo', 'bar') }));
    expect(compiled.query.type).toBe('paths');
  });

  it('both crate queries -> crateBoundary', () => {
    const compiled = compileQuery(createFilters({
      intent: textIntent('crate:A', 'crate:B'),
    }));
    expect(compiled.query.type).toBe('crateBoundary');
    if (compiled.query.type === 'crateBoundary') {
      expect(compiled.query.sourceCrate).toBe('a');
      expect(compiled.query.targetCrate).toBe('b');
    }
  });

  it('selectedNodes + maxDepth + no query -> depthFromSelected', () => {
    const compiled = compileQuery(createFilters({
      selectedNodes: new Set(['x']),
      maxDepth: 3,
    }));
    expect(compiled.query.type).toBe('depthFromSelected');
    if (compiled.query.type === 'depthFromSelected') {
      expect(compiled.query.maxDepth).toBe(3);
    }
  });

  it('selectedNodes + maxDepth + includeFiles -> noTraversal (includeFiles takes priority)', () => {
    const compiled = compileQuery(createFilters({
      selectedNodes: new Set(['x']),
      maxDepth: 3,
      includeFiles: 'foo.rs',
    }));
    expect(compiled.query.type).toBe('noTraversal');
  });

  it('no query -> noTraversal', () => {
    const compiled = compileQuery(createFilters());
    expect(compiled.query.type).toBe('noTraversal');
  });

  it('traversal predicates respect kind filters', () => {
    const compiled = compileQuery(
      createFilters({ showProofFunctions: false }),
      'verus',
    );
    const proofNode = createNode({ id: 'p', display_name: 'p', kind: 'proof' });
    const execNode = createNode({ id: 'e', display_name: 'e', kind: 'exec' });
    expect(compiled.traversalPredicates.kindFilter(proofNode)).toBe(false);
    expect(compiled.traversalPredicates.kindFilter(execNode)).toBe(true);
  });

  it('display predicates carry libsignal flags', () => {
    const compiled = compileQuery(createFilters({
      showLibsignal: false,
      showNonLibsignal: true,
    }));
    expect(compiled.displayPredicates.showLibsignal).toBe(false);
    expect(compiled.displayPredicates.showNonLibsignal).toBe(true);
  });
});

// ============================================================================
// TraversalResult depth threading
// ============================================================================

describe('TraversalResult depth threading', () => {
  it('forward traversal produces monotonically increasing calleeDepths', () => {
    const g = linearGraph();
    const result = traverseForward(g, new Set(['a']), null);
    expect(result.calleeDepths!.get('a')).toBe(0);
    expect(result.calleeDepths!.get('b')).toBe(1);
    expect(result.calleeDepths!.get('c')).toBe(2);
  });

  it('backward traversal produces monotonically increasing callerDepths', () => {
    const g = linearGraph();
    const result = traverseBackward(g, new Set(['c']), null);
    expect(result.callerDepths!.get('c')).toBe(0);
    expect(result.callerDepths!.get('b')).toBe(1);
    expect(result.callerDepths!.get('a')).toBe(2);
  });

  it('diamond graph: forward from A, node D has depth 2', () => {
    const g = diamondGraph();
    const result = traverseForward(g, new Set(['a']), null);
    expect(result.calleeDepths!.get('a')).toBe(0);
    expect(result.calleeDepths!.get('d')).toBe(2);
    // B and C both at depth 1
    expect(result.calleeDepths!.get('b')).toBe(1);
    expect(result.calleeDepths!.get('c')).toBe(1);
  });
});

// ============================================================================
// compileSeededDisplayPredicate (display-only filters for the seeded view)
// ============================================================================

describe('compileSeededDisplayPredicate', () => {
  const mkNode = (over: Partial<D3Node> = {}): D3Node => ({
    ...createNode({ id: 'n', display_name: 'func_n' }),
    ...over,
  });

  it('passes a plain node with default filters', () => {
    const pass = compileSeededDisplayPredicate(createFilters());
    expect(pass(mkNode())).toBe(true);
  });

  it('drops hidden nodes', () => {
    const pass = compileSeededDisplayPredicate(createFilters({ hiddenNodes: new Set(['n']) }));
    expect(pass(mkNode())).toBe(false);
  });

  it('honors kind flags', () => {
    const pass = compileSeededDisplayPredicate(
      createFilters({ showProofFunctions: false }), 'verus',
    );
    expect(pass(mkNode({ kind: 'proof' }))).toBe(false);
    expect(pass(mkNode({ kind: 'exec' }))).toBe(true);
  });

  it('filters axioms via showAxioms, independent of the Verus spec flag', () => {
    const noAxioms = compileSeededDisplayPredicate(
      createFilters({ showAxioms: false, showSpecFunctions: true }), 'lean',
    );
    expect(noAxioms(mkNode({ kind: 'axiom' }))).toBe(false);
    const axiomsOn = compileSeededDisplayPredicate(
      createFilters({ showAxioms: true, showSpecFunctions: false }), 'lean',
    );
    expect(axiomsOn(mkNode({ kind: 'axiom' }))).toBe(true);
    // Verus spec functions still follow showSpecFunctions, not showAxioms
    const noSpec = compileSeededDisplayPredicate(
      createFilters({ showSpecFunctions: false, showAxioms: true }), 'verus',
    );
    expect(noSpec(mkNode({ kind: 'spec' }))).toBe(false);
  });

  it('filters types, projections and instances via their own flags', () => {
    const hideAll = compileSeededDisplayPredicate(
      createFilters({ showTypes: false, showProjections: false, showInstances: false }), 'lean',
    );
    expect(hideAll(mkNode({ kind: 'structure' }))).toBe(false);
    expect(hideAll(mkNode({ kind: 'inductive' }))).toBe(false);
    expect(hideAll(mkNode({ kind: 'class' }))).toBe(false);
    expect(hideAll(mkNode({ kind: 'projection' }))).toBe(false);
    expect(hideAll(mkNode({ kind: 'instance' }))).toBe(false);
    // These stay in the definitions bucket
    expect(hideAll(mkNode({ kind: 'def' }))).toBe(true);
    expect(hideAll(mkNode({ kind: 'abbrev' }))).toBe(true);
    expect(hideAll(mkNode({ kind: 'opaque' }))).toBe(true);
    const showAll = compileSeededDisplayPredicate(
      createFilters({ showTypes: true, showProjections: true, showInstances: true }), 'lean',
    );
    expect(showAll(mkNode({ kind: 'structure' }))).toBe(true);
    expect(showAll(mkNode({ kind: 'projection' }))).toBe(true);
    expect(showAll(mkNode({ kind: 'instance' }))).toBe(true);
  });

  it('honors libsignal origin toggles', () => {
    const noLib = compileSeededDisplayPredicate(createFilters({ showLibsignal: false }));
    expect(noLib(mkNode({ is_libsignal: true }))).toBe(false);
    expect(noLib(mkNode({ is_libsignal: false }))).toBe(true);
    const noExt = compileSeededDisplayPredicate(createFilters({ showNonLibsignal: false }));
    expect(noExt(mkNode({ is_libsignal: false }))).toBe(false);
  });

  it('honors exclude name and path patterns', () => {
    const byName = compileSeededDisplayPredicate(createFilters({ excludeNamePatterns: 'func_*' }));
    expect(byName(mkNode())).toBe(false);
    const byPath = compileSeededDisplayPredicate(createFilters({ excludePathPatterns: '*specs*' }));
    expect(byPath(mkNode({ id: 'probe:foo/specs/n' }))).toBe(false);
    expect(byPath(mkNode({ id: 'probe:foo/src/n' }))).toBe(true);
  });

  it('always drops build-artifact nodes', () => {
    const pass = compileSeededDisplayPredicate(createFilters());
    expect(pass(mkNode({ relative_path: 'target/debug/gen.rs' }))).toBe(false);
    expect(pass(mkNode({ relative_path: 'crate/build/gen.rs' }))).toBe(false);
  });

  it('honors verification-status flags, treating missing status as unverified', () => {
    const noVerified = compileSeededDisplayPredicate(createFilters({ showVerifiedNodes: false }));
    expect(noVerified(mkNode({ verification_status: 'verified' }))).toBe(false);
    expect(noVerified(mkNode({ verification_status: 'trusted' }))).toBe(false);
    expect(noVerified(mkNode())).toBe(true);
    const noUnverified = compileSeededDisplayPredicate(createFilters({ showUnverifiedNodes: false }));
    expect(noUnverified(mkNode())).toBe(false);
    expect(noUnverified(mkNode({ verification_status: 'failed' }))).toBe(true);
  });
});
