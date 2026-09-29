/**
 * Tests for the call graph filtering logic.
 * 
 * These tests focus on user-facing behavior, not implementation details.
 * A failing test should indicate a real bug that affects users.
 */

import { describe, it, expect } from 'vitest';
import { globToRegex, asSubstringGlob, matchesQuery, applyFilters, pathPatternToRegex } from './filters';
import { D3Graph, D3Node, D3Link, FilterOptions, LinkRole } from './types';
import { getLinkId, roleFilteredGraph } from './query';
import { expandFromSeeds } from './graph-utils';
import { NONE_INTENT, textIntent } from './intent';

// ============================================================================
// Test Helpers
// ============================================================================

/** Create a minimal D3Node for testing */
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

/** Create a minimal D3Link for testing */
function createLink(source: string, target: string, type: string = 'inner'): D3Link {
  return { source, target, type };
}

/** Create default filter options */
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

/** Create a simple test graph: A → B → C */
function createLinearGraph(): D3Graph {
  return {
    nodes: [
      createNode({ id: 'a', display_name: 'func_a', file_name: 'module_a.rs' }),
      createNode({ id: 'b', display_name: 'func_b', file_name: 'module_b.rs' }),
      createNode({ id: 'c', display_name: 'func_c', file_name: 'module_c.rs' }),
    ],
    links: [
      createLink('a', 'b'),
      createLink('b', 'c'),
    ],
    metadata: { total_nodes: 3, total_edges: 2, project_root: '/test', generated_at: '2024-01-01' },
  };
}

/**
 * Create a diamond graph for path testing:
 *     A
 *    / \
 *   B   C
 *    \ /
 *     D
 */
function createDiamondGraph(): D3Graph {
  return {
    nodes: [
      createNode({ id: 'a', display_name: 'start' }),
      createNode({ id: 'b', display_name: 'left_path' }),
      createNode({ id: 'c', display_name: 'right_path' }),
      createNode({ id: 'd', display_name: 'end' }),
    ],
    links: [
      createLink('a', 'b'),
      createLink('a', 'c'),
      createLink('b', 'd'),
      createLink('c', 'd'),
    ],
    metadata: { total_nodes: 4, total_edges: 4, project_root: '/test', generated_at: '2024-01-01' },
  };
}

// ============================================================================
// Category 1: Glob Pattern Matching
// ============================================================================

describe('Glob Pattern Matching', () => {
  describe('globToRegex', () => {
    it('wildcard * matches any characters including empty', () => {
      const regex = globToRegex('*foo*');
      expect(regex.test('foo')).toBe(true);
      expect(regex.test('xfooy')).toBe(true);
      expect(regex.test('before_foo_after')).toBe(true);
    });

    it('pattern without wildcards requires exact match', () => {
      const regex = globToRegex('foo');
      expect(regex.test('foo')).toBe(true);
      expect(regex.test('xfooy')).toBe(false);
      expect(regex.test('foobar')).toBe(false);
    });

    it('regex special characters are escaped properly', () => {
      // foo.bar should match "foo.bar", not "fooXbar"
      const regex = globToRegex('foo.bar');
      expect(regex.test('foo.bar')).toBe(true);
      expect(regex.test('fooXbar')).toBe(false);
    });

    it('matching is case-insensitive', () => {
      const regex = globToRegex('FooBar');
      expect(regex.test('foobar')).toBe(true);
      expect(regex.test('FOOBAR')).toBe(true);
      expect(regex.test('FooBar')).toBe(true);
    });

    it('? matches exactly one character', () => {
      const regex = globToRegex('fo?');
      expect(regex.test('foo')).toBe(true);
      expect(regex.test('fox')).toBe(true);
      expect(regex.test('fo')).toBe(false);
      expect(regex.test('fooo')).toBe(false);
    });

    it('prefix pattern works', () => {
      const regex = globToRegex('lemma_*');
      expect(regex.test('lemma_foo')).toBe(true);
      expect(regex.test('lemma_')).toBe(true);
      expect(regex.test('not_lemma_foo')).toBe(false);
    });

    it('suffix pattern works', () => {
      const regex = globToRegex('*_comm');
      expect(regex.test('lemma_comm')).toBe(true);
      expect(regex.test('add_comm')).toBe(true);
      expect(regex.test('comm_extra')).toBe(false);
    });
  });

  describe('asSubstringGlob', () => {
    it('wraps plain text with wildcards', () => {
      expect(asSubstringGlob('decompress')).toBe('*decompress*');
    });

    it('does not modify patterns already containing *', () => {
      expect(asSubstringGlob('*decompress')).toBe('*decompress');
      expect(asSubstringGlob('decompress*')).toBe('decompress*');
      expect(asSubstringGlob('*decompress*')).toBe('*decompress*');
    });

    it('does not modify patterns containing ?', () => {
      expect(asSubstringGlob('decomp?ess')).toBe('decomp?ess');
    });
  });
});

// ============================================================================
// Category 2: Path-Qualified Queries
// ============================================================================

describe('Path-Qualified Queries', () => {
  const nodeInEdwards = createNode({
    id: 'edwards::decompress',
    display_name: 'decompress',
    file_name: 'edwards.rs',
    parent_folder: 'curve',
  });

  const nodeInRistretto = createNode({
    id: 'ristretto::compress',
    display_name: 'compress',
    file_name: 'ristretto.rs',
    parent_folder: 'curve',
  });

  it('path::function syntax matches function in specific file', () => {
    expect(matchesQuery(nodeInEdwards, 'edwards::decompress')).toBe(true);
    expect(matchesQuery(nodeInEdwards, 'ristretto::decompress')).toBe(false);
  });

  it('path part matches file name without .rs extension', () => {
    // "edwards" should match "edwards.rs"
    expect(matchesQuery(nodeInEdwards, 'edwards::decompress')).toBe(true);
  });

  it('path part can use wildcards', () => {
    expect(matchesQuery(nodeInEdwards, 'ed*::decompress')).toBe(true);
    expect(matchesQuery(nodeInEdwards, '*wards::decompress')).toBe(true);
  });

  it('function part can use wildcards', () => {
    expect(matchesQuery(nodeInEdwards, 'edwards::*')).toBe(true);
    expect(matchesQuery(nodeInEdwards, 'edwards::*compress')).toBe(true);
  });

  it('simple query without :: uses display_name matching', () => {
    expect(matchesQuery(nodeInEdwards, 'decompress')).toBe(true);
    expect(matchesQuery(nodeInEdwards, '*compress')).toBe(true);
    expect(matchesQuery(nodeInRistretto, 'compress')).toBe(true);
  });
});

// ============================================================================
// Category 2b: Type::method display names (enriched from probe-verus)
// ============================================================================

describe('Type::method display name queries', () => {
  const nodeWithTypeMethod = createNode({
    id: 'probe:crate/1.0/edwards/CompressedEdwardsY#ct_eq().',
    display_name: 'CompressedEdwardsY::ct_eq',
    file_name: 'edwards.rs',
    parent_folder: 'src',
  });

  const nodeWithAdd = createNode({
    id: 'probe:crate/1.0/edwards/&EdwardsPoint#Add<&EdwardsPoint>#add().',
    display_name: 'EdwardsPoint::add',
    file_name: 'edwards.rs',
    parent_folder: 'src',
  });

  it('exact Type::method query matches display_name', () => {
    expect(matchesQuery(nodeWithTypeMethod, 'CompressedEdwardsY::ct_eq')).toBe(true);
    expect(matchesQuery(nodeWithAdd, 'EdwardsPoint::add')).toBe(true);
  });

  it('Type::method query does not false-match other types', () => {
    expect(matchesQuery(nodeWithTypeMethod, 'EdwardsPoint::ct_eq')).toBe(false);
    expect(matchesQuery(nodeWithAdd, 'CompressedEdwardsY::add')).toBe(false);
  });

  it('path::function matches Type::method when function part is a substring of display_name', () => {
    // "edwards::ct_eq" should match: file "edwards.rs" matches path, and "ct_eq" is a
    // substring of display_name "CompressedEdwardsY::ct_eq"
    expect(matchesQuery(nodeWithTypeMethod, 'edwards::ct_eq')).toBe(true);
    expect(matchesQuery(nodeWithAdd, 'edwards::add')).toBe(true);
  });

  it('wildcard glob on Type::method display_name works', () => {
    expect(matchesQuery(nodeWithTypeMethod, '*::ct_eq')).toBe(true);
    expect(matchesQuery(nodeWithTypeMethod, 'Compressed*::ct_eq')).toBe(true);
    expect(matchesQuery(nodeWithAdd, '*Point::add')).toBe(true);
  });
});

// ============================================================================
// Category 2c: Substring matching for verus-analyzer display names
// ============================================================================

describe('Substring matching (verus-analyzer style display names)', () => {
  const edwardsDecompress = createNode({
    id: 'probe:curve25519-dalek/4.1.3/edwards/CompressedEdwardsY#decompress().',
    display_name: 'CompressedEdwardsY::decompress',
    file_name: 'edwards.rs',
    parent_folder: 'src',
  });

  const ristrettoDecompress = createNode({
    id: 'probe:curve25519-dalek/4.1.3/ristretto/CompressedRistretto#decompress().',
    display_name: 'CompressedRistretto::decompress',
    file_name: 'ristretto.rs',
    parent_folder: 'src',
  });

  it('plain query matches as substring of Type::method display_name', () => {
    expect(matchesQuery(edwardsDecompress, 'decompress')).toBe(true);
    expect(matchesQuery(ristrettoDecompress, 'decompress')).toBe(true);
  });

  it('path-qualified query matches when func part is substring', () => {
    expect(matchesQuery(edwardsDecompress, 'edwards::decompress')).toBe(true);
    expect(matchesQuery(ristrettoDecompress, 'ristretto::decompress')).toBe(true);
  });

  it('path-qualified query does not match wrong file', () => {
    expect(matchesQuery(edwardsDecompress, 'ristretto::decompress')).toBe(false);
    expect(matchesQuery(ristrettoDecompress, 'edwards::decompress')).toBe(false);
  });

  it('explicit wildcards still provide anchored control', () => {
    // "Compressed*" starts-with anchor works
    expect(matchesQuery(edwardsDecompress, 'Compressed*')).toBe(true);
    // "decompress*" should match because display_name ends with "decompress"
    expect(matchesQuery(edwardsDecompress, '*decompress')).toBe(true);
    // "Ristretto*" should not match EdwardsY
    expect(matchesQuery(edwardsDecompress, 'Ristretto*')).toBe(false);
  });
});

// ============================================================================
// Category 2d: Lean dotted-path queries and .lean extension handling
// ============================================================================

describe('Lean dotted-path queries', () => {
  const scalarAddSpec = createNode({
    id: 'probe:curve25519_dalek.backend.serial.u64.scalar.Scalar52.add_spec',
    display_name: 'add_spec',
    file_name: 'Funs.lean',
    parent_folder: 'Curve25519Dalek',
  });

  const edwardsAddSpec = createNode({
    id: 'probe:curve25519_dalek.edwards.EdwardsPoint.Insts.CoreOpsArithAddEdwardsPointEdwardsPoint.add_spec',
    display_name: 'add_spec',
    file_name: 'Funs.lean',
    parent_folder: 'Curve25519Dalek',
  });

  const fieldAddSpec = createNode({
    id: 'probe:curve25519_dalek.Shared0FieldElement51.Insts.CoreOpsArithAddSharedAFieldElement51FieldElement51.add_spec',
    display_name: 'add_spec',
    file_name: 'Add.lean',
    parent_folder: 'FieldElement51',
  });

  it('dotted module path disambiguates same-name functions', () => {
    expect(matchesQuery(scalarAddSpec, 'Scalar52.add_spec')).toBe(true);
    expect(matchesQuery(edwardsAddSpec, 'Scalar52.add_spec')).toBe(false);
    expect(matchesQuery(fieldAddSpec, 'Scalar52.add_spec')).toBe(false);
  });

  it('longer dotted path narrows further', () => {
    expect(matchesQuery(scalarAddSpec, 'u64.scalar.Scalar52.add_spec')).toBe(true);
    expect(matchesQuery(edwardsAddSpec, 'u64.scalar.Scalar52.add_spec')).toBe(false);
  });

  it('dotted query with wildcards works', () => {
    // Explicit wildcards produce anchored matches, so prefix with * for substring
    expect(matchesQuery(scalarAddSpec, '*Scalar52.*')).toBe(true);
    expect(matchesQuery(edwardsAddSpec, '*EdwardsPoint.*add_spec')).toBe(true);
    expect(matchesQuery(fieldAddSpec, '*FieldElement51*.add_spec')).toBe(true);
  });

  it('plain query without dots matches all same-name nodes via display_name', () => {
    expect(matchesQuery(scalarAddSpec, 'add_spec')).toBe(true);
    expect(matchesQuery(edwardsAddSpec, 'add_spec')).toBe(true);
    expect(matchesQuery(fieldAddSpec, 'add_spec')).toBe(true);
  });

  it('plain query without dots does NOT match against id', () => {
    expect(matchesQuery(scalarAddSpec, 'Scalar52')).toBe(false);
    expect(matchesQuery(edwardsAddSpec, 'EdwardsPoint')).toBe(false);
  });

  it('path::func syntax with .lean extension stripping works', () => {
    expect(matchesQuery(scalarAddSpec, 'Funs::add_spec')).toBe(true);
    expect(matchesQuery(fieldAddSpec, 'Add::add_spec')).toBe(true);
  });

  it('path::func syntax matches parent_folder for Lean files', () => {
    expect(matchesQuery(fieldAddSpec, 'FieldElement51::add_spec')).toBe(true);
    expect(matchesQuery(scalarAddSpec, 'Curve25519Dalek::add_spec')).toBe(true);
  });
});

// ============================================================================
// Category 3: Graph Traversal (Source/Sink/Paths)
// ============================================================================

describe('Graph Traversal', () => {
  describe('Source query (shows callees)', () => {
    it('returns source node and its immediate callees at depth 1', () => {
      const graph = createLinearGraph();
      const filters = createFilters({ intent: textIntent('func_a', ''), maxDepth: 1 });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name).sort();
      
      expect(nodeNames).toContain('func_a');
      expect(nodeNames).toContain('func_b');
      // func_c is at depth 2, should NOT be included
      expect(nodeNames).not.toContain('func_c');
    });

    it('returns deeper callees when depth allows', () => {
      const graph = createLinearGraph();
      const filters = createFilters({ intent: textIntent('func_a', ''), maxDepth: 2 });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name).sort();
      
      expect(nodeNames).toContain('func_a');
      expect(nodeNames).toContain('func_b');
      expect(nodeNames).toContain('func_c');
    });
  });

  describe('Sink query (shows callers)', () => {
    it('returns sink node and its immediate callers at depth 1', () => {
      const graph = createLinearGraph();
      const filters = createFilters({ intent: textIntent('', 'func_c'), maxDepth: 1 });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name).sort();
      
      expect(nodeNames).toContain('func_c');
      expect(nodeNames).toContain('func_b');
      // func_a is at depth 2, should NOT be included
      expect(nodeNames).not.toContain('func_a');
    });
  });

  describe('Source → Sink path finding', () => {
    it('finds all nodes on path between source and sink', () => {
      const graph = createDiamondGraph();
      const filters = createFilters({ intent: textIntent('start', 'end') });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name).sort();
      
      // All nodes should be on some path from start to end
      expect(nodeNames).toContain('start');
      expect(nodeNames).toContain('end');
      // Both paths should be included
      expect(nodeNames).toContain('left_path');
      expect(nodeNames).toContain('right_path');
    });

    it('returns empty when no path exists', () => {
      const graph = createLinearGraph();
      // Try to find path from C to A (wrong direction)
      const filters = createFilters({ intent: textIntent('func_c', 'func_a') });
      
      const result = applyFilters(graph, filters);
      
      // No path from C to A, so should be empty or just source/sink
      expect(result.nodes.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Same source and sink (neighborhood mode)', () => {
    it('shows both callers and callees of the node', () => {
      const graph = createLinearGraph();
      // B is in the middle, should show A (caller) and C (callee)
      const filters = createFilters({ intent: textIntent('func_b', 'func_b'), maxDepth: 1 });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name).sort();
      
      expect(nodeNames).toContain('func_a'); // caller
      expect(nodeNames).toContain('func_b'); // self
      expect(nodeNames).toContain('func_c'); // callee
    });
  });
});

// ============================================================================
// Category 4: Edge Cases That Could Crash
// ============================================================================

describe('Edge Cases', () => {
  it('empty graph returns empty result without crashing', () => {
    const emptyGraph: D3Graph = {
      nodes: [],
      links: [],
      metadata: { total_nodes: 0, total_edges: 0, project_root: '/test', generated_at: '2024-01-01' },
    };
    const filters = createFilters({ intent: textIntent('anything', '') });
    
    const result = applyFilters(emptyGraph, filters);
    
    expect(result.nodes).toHaveLength(0);
    expect(result.links).toHaveLength(0);
  });

  it('query matching nothing returns empty result without crashing', () => {
    const graph = createLinearGraph();
    const filters = createFilters({ intent: textIntent('nonexistent_function', '') });
    
    const result = applyFilters(graph, filters);
    
    expect(result.nodes).toHaveLength(0);
  });

  it('graph with cycle terminates without infinite loop', () => {
    // A → B → C → A (cycle)
    const cyclicGraph: D3Graph = {
      nodes: [
        createNode({ id: 'a', display_name: 'func_a' }),
        createNode({ id: 'b', display_name: 'func_b' }),
        createNode({ id: 'c', display_name: 'func_c' }),
      ],
      links: [
        createLink('a', 'b'),
        createLink('b', 'c'),
        createLink('c', 'a'), // Creates cycle
      ],
      metadata: { total_nodes: 3, total_edges: 3, project_root: '/test', generated_at: '2024-01-01' },
    };
    const filters = createFilters({ intent: textIntent('func_a', ''), maxDepth: 10 });
    
    // This should complete without hanging
    const result = applyFilters(cyclicGraph, filters);
    
    // All nodes should be reachable
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it('self-referential node without other connections is treated as isolated', () => {
    // A node that only calls itself with no other connections is considered isolated
    // and removed from the filtered graph. This is expected behavior.
    const selfRefGraph: D3Graph = {
      nodes: [
        createNode({ id: 'recursive', display_name: 'recursive_fn' }),
      ],
      links: [
        createLink('recursive', 'recursive'), // Calls itself
      ],
      metadata: { total_nodes: 1, total_edges: 1, project_root: '/test', generated_at: '2024-01-01' },
    };
    const filters = createFilters({ intent: textIntent('recursive_fn', ''), maxDepth: 5 });
    
    const result = applyFilters(selfRefGraph, filters);
    
    // Self-referential nodes are filtered out as isolated (no connections to OTHER nodes)
    expect(result.nodes).toHaveLength(0);
  });

  it('self-referential node WITH other connections is preserved', () => {
    // When a recursive function has other callers/callees, it should be shown
    const graph: D3Graph = {
      nodes: [
        createNode({ id: 'caller', display_name: 'caller_fn' }),
        createNode({ id: 'recursive', display_name: 'recursive_fn' }),
      ],
      links: [
        createLink('caller', 'recursive'),
        createLink('recursive', 'recursive'), // Self-loop
      ],
      metadata: { total_nodes: 2, total_edges: 2, project_root: '/test', generated_at: '2024-01-01' },
    };
    const filters = createFilters({ intent: textIntent('', 'recursive_fn'), maxDepth: 1 });
    
    const result = applyFilters(graph, filters);
    const nodeNames = result.nodes.map(n => n.display_name);
    
    expect(nodeNames).toContain('recursive_fn');
    expect(nodeNames).toContain('caller_fn');
  });
});

// ============================================================================
// Category 5: Filter Behavior
// ============================================================================

describe('Filter Behavior', () => {
  describe('Kind filters', () => {
    it('hiding spec functions removes them from results', () => {
      const graph: D3Graph = {
        nodes: [
          createNode({ id: 'exec_fn', display_name: 'exec_fn', kind: 'exec' }),
          createNode({ id: 'spec_fn', display_name: 'spec_fn', kind: 'spec' }),
          createNode({ id: 'proof_fn', display_name: 'proof_fn', kind: 'proof' }),
        ],
        links: [
          createLink('exec_fn', 'spec_fn'),
          createLink('exec_fn', 'proof_fn'),
        ],
        metadata: { total_nodes: 3, total_edges: 2, project_root: '/test', generated_at: '2024-01-01' },
      };
      
      const filters = createFilters({
        intent: textIntent('exec_fn', ''),
        maxDepth: 1,
        showSpecFunctions: false,
      });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name);
      
      expect(nodeNames).toContain('exec_fn');
      expect(nodeNames).toContain('proof_fn');
      expect(nodeNames).not.toContain('spec_fn');
    });
  });

  describe('Hidden nodes', () => {
    it('hidden nodes are excluded from results', () => {
      const graph = createLinearGraph();
      const filters = createFilters({
        intent: textIntent('func_a', ''),
        maxDepth: 2,
        hiddenNodes: new Set(['b']), // Hide func_b
      });
      
      const result = applyFilters(graph, filters);
      const nodeIds = result.nodes.map(n => n.id);
      
      expect(nodeIds).not.toContain('b');
    });
  });

  describe('Exclude patterns', () => {
    it('exclude name pattern removes matching functions', () => {
      const graph: D3Graph = {
        nodes: [
          createNode({ id: 'main', display_name: 'main' }),
          createNode({ id: 'lemma_comm', display_name: 'lemma_comm' }),
          createNode({ id: 'helper', display_name: 'helper' }),
        ],
        links: [
          createLink('main', 'lemma_comm'),
          createLink('main', 'helper'),
        ],
        metadata: { total_nodes: 3, total_edges: 2, project_root: '/test', generated_at: '2024-01-01' },
      };
      
      const filters = createFilters({
        intent: textIntent('main', ''),
        maxDepth: 1,
        excludeNamePatterns: '*_comm',
      });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name);
      
      expect(nodeNames).toContain('main');
      expect(nodeNames).toContain('helper');
      expect(nodeNames).not.toContain('lemma_comm');
    });
  });

  describe('Include files filter', () => {
    it('only includes functions from specified files', () => {
      const graph: D3Graph = {
        nodes: [
          createNode({ id: 'a', display_name: 'func_a', file_name: 'edwards.rs' }),
          createNode({ id: 'b', display_name: 'func_b', file_name: 'ristretto.rs' }),
          createNode({ id: 'c', display_name: 'func_c', file_name: 'edwards.rs' }),
        ],
        links: [
          createLink('a', 'b'),
          createLink('a', 'c'),
        ],
        metadata: { total_nodes: 3, total_edges: 2, project_root: '/test', generated_at: '2024-01-01' },
      };
      
      const filters = createFilters({
        intent: textIntent('func_a', ''),
        maxDepth: 1,
        includeFiles: 'edwards.rs',
      });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name);
      
      expect(nodeNames).toContain('func_a');
      expect(nodeNames).toContain('func_c');
      expect(nodeNames).not.toContain('func_b'); // In ristretto.rs
    });

    it('shows edges between files when using includeFiles alone (no source/sink)', () => {
      // Simulates: hazmat.rs has ExpandedSecretKey::from_bytes which calls Scalar::from_bytes_mod_order in scalar.rs
      const graph: D3Graph = {
        nodes: [
          createNode({ id: 'hazmat_from_bytes', display_name: 'from_bytes', file_name: 'hazmat.rs' }),
          createNode({ id: 'scalar_from_bytes_mod_order', display_name: 'from_bytes_mod_order', file_name: 'scalar.rs' }),
          createNode({ id: 'other_func', display_name: 'other_func', file_name: 'other.rs' }),
          createNode({ id: 'another_func', display_name: 'another_func', file_name: 'another.rs' }),
        ],
        links: [
          createLink('hazmat_from_bytes', 'scalar_from_bytes_mod_order'),  // hazmat.rs -> scalar.rs
          createLink('other_func', 'hazmat_from_bytes'),  // other.rs -> hazmat.rs
          createLink('another_func', 'other_func'),  // another.rs -> other.rs
        ],
        metadata: { total_nodes: 4, total_edges: 3, project_root: '/test', generated_at: '2024-01-01' },
      };
      
      // Filter to only show hazmat.rs and scalar.rs (no source/sink query)
      const filters = createFilters({
        includeFiles: 'hazmat.rs, scalar.rs',
      });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name);
      
      // Should include both nodes from the specified files
      expect(nodeNames).toContain('from_bytes');
      expect(nodeNames).toContain('from_bytes_mod_order');
      // Should NOT include nodes from other files
      expect(nodeNames).not.toContain('other_func');
      expect(nodeNames).not.toContain('another_func');
      // Should have the edge between them
      expect(result.links.length).toBe(1);
      expect(result.links[0].source).toBe('hazmat_from_bytes');
      expect(result.links[0].target).toBe('scalar_from_bytes_mod_order');
    });

    it('supports multiple file patterns with glob wildcards', () => {
      const graph: D3Graph = {
        nodes: [
          createNode({ id: 'a', display_name: 'func_a', file_name: 'hazmat.rs' }),
          createNode({ id: 'b', display_name: 'func_b', file_name: 'scalar.rs' }),
          createNode({ id: 'c', display_name: 'func_c', file_name: 'edwards.rs' }),
          createNode({ id: 'd', display_name: 'func_d', file_name: 'ristretto.rs' }),
        ],
        links: [
          createLink('a', 'b'),
          createLink('c', 'd'),
        ],
        metadata: { total_nodes: 4, total_edges: 2, project_root: '/test', generated_at: '2024-01-01' },
      };
      
      // Use glob pattern to match files ending with .rs that start with 'h' or 's'
      const filters = createFilters({
        includeFiles: 'h*.rs, s*.rs',
      });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name);
      
      expect(nodeNames).toContain('func_a');  // hazmat.rs
      expect(nodeNames).toContain('func_b');  // scalar.rs
      expect(nodeNames).not.toContain('func_c');  // edwards.rs - no edge within included files
      expect(nodeNames).not.toContain('func_d');  // ristretto.rs - no edge within included files
    });

    it('clicking nodes does NOT apply depth filtering when includeFiles is active', () => {
      // This tests that the Include Files filter behaves like Source/Sink:
      // clicking a node should NOT narrow the graph to just that node's neighborhood
      const graph: D3Graph = {
        nodes: [
          createNode({ id: 'a', display_name: 'func_a', file_name: 'hazmat.rs' }),
          createNode({ id: 'b', display_name: 'func_b', file_name: 'hazmat.rs' }),
          createNode({ id: 'c', display_name: 'func_c', file_name: 'hazmat.rs' }),
          createNode({ id: 'd', display_name: 'func_d', file_name: 'other.rs' }),
        ],
        links: [
          createLink('a', 'b'),  // a -> b
          createLink('b', 'c'),  // b -> c (depth 2 from a)
          createLink('d', 'a'),  // d -> a (from other file)
        ],
        metadata: { total_nodes: 4, total_edges: 3, project_root: '/test', generated_at: '2024-01-01' },
      };
      
      // Include Files is set, and we "click" on node 'a' (simulate by adding to selectedNodes)
      const filters = createFilters({
        includeFiles: 'hazmat.rs',
        selectedNodes: new Set(['a']),  // Simulating a click on node 'a'
        maxDepth: 1,  // Would normally limit to depth 1 from clicked node
      });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name);
      
      // Even though maxDepth=1 and we clicked 'a', all hazmat.rs nodes should remain
      // because Include Files is active (clicking shouldn't narrow the view)
      expect(nodeNames).toContain('func_a');
      expect(nodeNames).toContain('func_b');
      expect(nodeNames).toContain('func_c');  // Would be excluded if depth filtering was applied (depth 2)
      expect(nodeNames).not.toContain('func_d');  // Excluded because it's in other.rs
      // Should have edges a->b and b->c (within hazmat.rs)
      expect(result.links.length).toBe(2);
    });
  });

  describe('Path pattern disambiguation', () => {
    it('pathPatternToRegex matches paths ending with pattern', () => {
      const regex = pathPatternToRegex('ifma/edwards.rs');
      
      // Should match paths ending with /ifma/edwards.rs
      expect(regex.test('curve25519-dalek/src/backend/vector/ifma/edwards.rs')).toBe(true);
      expect(regex.test('some/other/ifma/edwards.rs')).toBe(true);
      
      // Should match exact path
      expect(regex.test('ifma/edwards.rs')).toBe(true);
      
      // Should NOT match different paths
      expect(regex.test('curve25519-dalek/src/edwards.rs')).toBe(false);
      expect(regex.test('avx2/edwards.rs')).toBe(false);
    });

    it('pathPatternToRegex handles ** glob patterns', () => {
      const regex = pathPatternToRegex('**/backend/**/edwards.rs');
      
      // Should match any path with backend and something after it before edwards.rs
      expect(regex.test('curve25519-dalek/src/backend/vector/ifma/edwards.rs')).toBe(true);
      expect(regex.test('curve25519-dalek/src/backend/vector/avx2/edwards.rs')).toBe(true);
      expect(regex.test('some/backend/x/edwards.rs')).toBe(true);
      
      // Should NOT match paths without backend
      expect(regex.test('curve25519-dalek/src/edwards.rs')).toBe(false);
      
      // Test simpler ** pattern
      const regex2 = pathPatternToRegex('**/edwards.rs');
      expect(regex2.test('curve25519-dalek/src/edwards.rs')).toBe(true);
      expect(regex2.test('backend/vector/ifma/edwards.rs')).toBe(true);
      expect(regex2.test('edwards.rs')).toBe(true);
    });

    it('path patterns in includeFiles disambiguate duplicate filenames', () => {
      // Simulates the real scenario: multiple edwards.rs files in different paths
      // Each file has internal edges so nodes aren't isolated when filtered
      const graph: D3Graph = {
        nodes: [
          createNode({ 
            id: 'src_edwards_func1', 
            display_name: 'decompress', 
            file_name: 'edwards.rs',
            relative_path: 'curve25519-dalek/src/edwards.rs'
          }),
          createNode({ 
            id: 'src_edwards_func2', 
            display_name: 'compress', 
            file_name: 'edwards.rs',
            relative_path: 'curve25519-dalek/src/edwards.rs'
          }),
          createNode({ 
            id: 'ifma_edwards_func1', 
            display_name: 'mul_by_pow_2', 
            file_name: 'edwards.rs',
            relative_path: 'curve25519-dalek/src/backend/vector/ifma/edwards.rs'
          }),
          createNode({ 
            id: 'ifma_edwards_func2', 
            display_name: 'double', 
            file_name: 'edwards.rs',
            relative_path: 'curve25519-dalek/src/backend/vector/ifma/edwards.rs'
          }),
          createNode({ 
            id: 'avx2_edwards_func', 
            display_name: 'neg', 
            file_name: 'edwards.rs',
            relative_path: 'curve25519-dalek/src/backend/vector/avx2/edwards.rs'
          }),
        ],
        links: [
          // Internal edges within each file
          createLink('src_edwards_func1', 'src_edwards_func2'),
          createLink('ifma_edwards_func1', 'ifma_edwards_func2'),
          // Cross-file edges
          createLink('ifma_edwards_func1', 'src_edwards_func1'),
          createLink('avx2_edwards_func', 'src_edwards_func1'),
        ],
        metadata: { total_nodes: 5, total_edges: 4, project_root: '/test', generated_at: '2024-01-01' },
      };
      
      // Filter to only the ifma edwards.rs using path pattern
      const filters = createFilters({
        includeFiles: 'ifma/edwards.rs',
      });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name);
      
      // Should only include the ifma edwards.rs functions (they have an edge between them)
      expect(nodeNames).toContain('mul_by_pow_2');
      expect(nodeNames).toContain('double');
      // Should NOT include other edwards.rs files
      expect(nodeNames).not.toContain('decompress');
      expect(nodeNames).not.toContain('compress');
      expect(nodeNames).not.toContain('neg');
      // Should have 1 edge (the internal ifma edge)
      expect(result.links.length).toBe(1);
    });

    it('simple filename pattern still matches all files with that name', () => {
      const graph: D3Graph = {
        nodes: [
          createNode({ 
            id: 'src_edwards_func', 
            display_name: 'decompress', 
            file_name: 'edwards.rs',
            relative_path: 'curve25519-dalek/src/edwards.rs'
          }),
          createNode({ 
            id: 'ifma_edwards_func', 
            display_name: 'mul_by_pow_2', 
            file_name: 'edwards.rs',
            relative_path: 'curve25519-dalek/src/backend/vector/ifma/edwards.rs'
          }),
          createNode({ 
            id: 'scalar_func', 
            display_name: 'from_bytes', 
            file_name: 'scalar.rs',
            relative_path: 'curve25519-dalek/src/scalar.rs'
          }),
        ],
        links: [
          createLink('src_edwards_func', 'ifma_edwards_func'),
          createLink('src_edwards_func', 'scalar_func'),
        ],
        metadata: { total_nodes: 3, total_edges: 2, project_root: '/test', generated_at: '2024-01-01' },
      };
      
      // Filter with just filename (no path) - should match ALL edwards.rs files
      const filters = createFilters({
        includeFiles: 'edwards.rs',
      });
      
      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name);
      
      // Should include BOTH edwards.rs functions
      expect(nodeNames).toContain('decompress');
      expect(nodeNames).toContain('mul_by_pow_2');
      // Should NOT include scalar.rs
      expect(nodeNames).not.toContain('from_bytes');
    });
  });
});

// ============================================================================
// Crate-Level Queries
// ============================================================================

describe('Crate-level source/sink queries', () => {
  /** Create a two-crate graph:
   *   crateA::fn_a1 → crateB::fn_b1
   *   crateA::fn_a2 → crateB::fn_b2
   *   crateA::fn_a3 → crateA::fn_a1  (intra-crate, should not appear in boundary)
   *   crateB::fn_b1 → crateB::fn_b2  (intra-crate)
   */
  function createTwoCrateGraph(): D3Graph {
    return {
      nodes: [
        createNode({ id: 'a1', display_name: 'fn_a1', crate_name: 'crateA' }),
        createNode({ id: 'a2', display_name: 'fn_a2', crate_name: 'crateA' }),
        createNode({ id: 'a3', display_name: 'fn_a3', crate_name: 'crateA' }),
        createNode({ id: 'b1', display_name: 'fn_b1', crate_name: 'crateB' }),
        createNode({ id: 'b2', display_name: 'fn_b2', crate_name: 'crateB' }),
      ],
      links: [
        createLink('a1', 'b1'),
        createLink('a2', 'b2'),
        createLink('a3', 'a1'),
        createLink('b1', 'b2'),
      ],
      metadata: { total_nodes: 5, total_edges: 4, project_root: '/test', generated_at: '2024-01-01' },
    };
  }

  describe('matchesQuery with crate: prefix', () => {
    it('matches nodes by crate name', () => {
      const node = createNode({ id: 'x', display_name: 'foo', crate_name: 'curve25519-dalek' });
      expect(matchesQuery(node, 'crate:curve25519-dalek')).toBe(true);
      expect(matchesQuery(node, 'crate:vstd')).toBe(false);
    });

    it('supports glob wildcards in crate name', () => {
      const node = createNode({ id: 'x', display_name: 'foo', crate_name: 'libsignal-protocol' });
      expect(matchesQuery(node, 'crate:libsignal-*')).toBe(true);
      expect(matchesQuery(node, 'crate:*protocol')).toBe(true);
      expect(matchesQuery(node, 'crate:curve*')).toBe(false);
    });

    it('uses substring matching by default', () => {
      const node = createNode({ id: 'x', display_name: 'foo', crate_name: 'libsignal-protocol' });
      expect(matchesQuery(node, 'crate:signal')).toBe(true);
    });
  });

  describe('direct crate boundary mode', () => {
    it('shows only cross-crate edges from source to sink crate', () => {
      const graph = createTwoCrateGraph();
      const filters = createFilters({
        intent: textIntent('crate:crateA', 'crate:crateB'),
      });

      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name).sort();

      // Should include boundary functions: a1→b1, a2→b2
      expect(nodeNames).toContain('fn_a1');
      expect(nodeNames).toContain('fn_a2');
      expect(nodeNames).toContain('fn_b1');
      expect(nodeNames).toContain('fn_b2');
      // Should NOT include a3 (only has intra-crate edges)
      expect(nodeNames).not.toContain('fn_a3');
    });

    it('shows directional boundary (A→B not B→A)', () => {
      const graph = createTwoCrateGraph();
      // Reverse direction: source=crateB, sink=crateA
      const filters = createFilters({
        intent: textIntent('crate:crateB', 'crate:crateA'),
      });

      const result = applyFilters(graph, filters);
      // No edges go from crateB to crateA in the test graph
      expect(result.nodes.length).toBe(0);
    });

    it('returns only cross-crate links', () => {
      const graph = createTwoCrateGraph();
      const filters = createFilters({
        intent: textIntent('crate:crateA', 'crate:crateB'),
      });

      const result = applyFilters(graph, filters);

      // Should only have 2 links: a1→b1, a2→b2
      expect(result.links.length).toBe(2);
      const linkPairs = result.links.map(l => {
        const s = typeof l.source === 'string' ? l.source : l.source.id;
        const t = typeof l.target === 'string' ? l.target : l.target.id;
        return `${s}->${t}`;
      }).sort();
      expect(linkPairs).toEqual(['a1->b1', 'a2->b2']);
    });
  });

  describe('single crate as source or sink', () => {
    it('crate as source shows callees from that crate', () => {
      const graph = createTwoCrateGraph();
      const filters = createFilters({
        intent: textIntent('crate:crateA', ''),
        maxDepth: 1,
      });

      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name).sort();

      // All crateA nodes plus their direct callees
      expect(nodeNames).toContain('fn_a1');
      expect(nodeNames).toContain('fn_b1');
    });

    it('crate as sink shows callers of that crate', () => {
      const graph = createTwoCrateGraph();
      const filters = createFilters({
        intent: textIntent('', 'crate:crateB'),
        maxDepth: 1,
      });

      const result = applyFilters(graph, filters);
      const nodeNames = result.nodes.map(n => n.display_name).sort();

      // crateB nodes plus their direct callers
      expect(nodeNames).toContain('fn_b1');
      expect(nodeNames).toContain('fn_a1');
    });
  });
});
describe('Statement / body-or-proof edge filter', () => {
  const role = (source: string, target: string, r: LinkRole, type = 'inner'): D3Link =>
    ({ source, target, type, role: r });
  const pairs = (g: D3Graph) =>
    g.links.map(l => `${getLinkId(l).sourceId}>${getLinkId(l).targetId}:${l.type}:${l.role ?? '-'}`).sort();
  const ids = (g: D3Graph) => g.nodes.map(n => n.id).sort();

  // x -type-> t, x -term-> p, x -both-> b, x -> u (no role)
  const star: D3Graph = {
    nodes: ['x', 't', 'p', 'b', 'u'].map(id => createNode({ id, display_name: id })),
    links: [
      role('x', 't', 'type'), role('x', 'p', 'term'), role('x', 'b', 'both'), createLink('x', 'u'),
    ],
    metadata: { total_nodes: 5, total_edges: 4, project_root: '/test', generated_at: '2024-01-01' },
  };

  it.each([
    [true, true, ['b', 'p', 't', 'u', 'x']],
    [true, false, ['b', 't', 'u', 'x']],
    [false, true, ['b', 'p', 'u', 'x']],
    [false, false, ['u', 'x']],
  ])('statement=%s body=%s shows %j', (showStatementDeps, showBodyDeps, expected) => {
    const result = applyFilters(star, createFilters({
      showStatementDeps, showBodyDeps, intent: textIntent('x', ''),
    }));
    expect(ids(result)).toEqual(expected);
  });

  it('hides every inner link when body calls are off, whatever the role', () => {
    const result = applyFilters(star, createFilters({ showInnerCalls: false }));
    expect(result.links).toEqual([]);
  });

  // a -term-> b -type-> c
  const bridge: D3Graph = {
    nodes: ['a', 'b', 'c'].map(id => createNode({ id, display_name: `n_${id}` })),
    links: [role('a', 'b', 'term'), role('b', 'c', 'type')],
    metadata: { total_nodes: 3, total_edges: 2, project_root: '/test', generated_at: '2024-01-01' },
  };

  it('restricts query traversal: with body/proof off, a does not reach c', () => {
    // a has no statement link, so nothing is reached (isolated a is dropped)
    const off = createFilters({ showBodyDeps: false, intent: textIntent('n_a', '') });
    expect(ids(applyFilters(bridge, off))).toEqual([]);
    const callers = createFilters({ showBodyDeps: false, intent: textIntent('', 'n_c') });
    expect(ids(applyFilters(bridge, callers))).toEqual(['b', 'c']);
    const paths = createFilters({ showBodyDeps: false, intent: textIntent('n_a', 'n_c') });
    expect(ids(applyFilters(bridge, paths))).toEqual([]);
    const on = createFilters({ intent: textIntent('n_a', '') });
    expect(ids(applyFilters(bridge, on))).toEqual(['a', 'b', 'c']);
  });

  it('restricts seed expansion: with body/proof off, seed a does not reach c', () => {
    const budget = { maxNodes: 100, maxLinks: 100 };
    const off = expandFromSeeds(
      roleFilteredGraph(bridge, { showStatementDeps: true, showBodyDeps: false }), ['a'], 2, budget,
    );
    expect(off.ok && [...off.nodeIds].sort()).toEqual(['a']);
    const on = expandFromSeeds(
      roleFilteredGraph(bridge, { showStatementDeps: true, showBodyDeps: true }), ['a'], 2, budget,
    );
    expect(on.ok && [...on.nodeIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps roles in the result and parallel inner and spec links apart', () => {
    const g: D3Graph = {
      nodes: ['thm', 'def'].map(id => createNode({ id, display_name: id })),
      links: [role('thm', 'def', 'term'), createLink('thm', 'def', 'spec')],
      metadata: { total_nodes: 2, total_edges: 2, project_root: '/test', generated_at: '2024-01-01' },
    };
    expect(pairs(applyFilters(g, createFilters()))).toEqual(['thm>def:inner:term', 'thm>def:spec:-']);
    // The spec link is governed by its own toggle, not the role boxes
    const bodyOff = applyFilters(g, createFilters({ showBodyDeps: false }));
    expect(pairs(bodyOff)).toEqual(['thm>def:spec:-']);
  });
});
