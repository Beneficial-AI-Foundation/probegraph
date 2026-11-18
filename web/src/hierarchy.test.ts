/**
 * Unit tests for the hierarchy drill-down model (hierarchy.ts):
 * tree construction (crate prefix stripping, chain compression, rollups)
 * and cut computation (aggregation, expansion, orphaned/stale state).
 */

import { describe, it, expect } from 'vitest';
import {
  buildHierarchyTree, computeCut, pruneExpanded, descendantGroupIds,
  expandedForReveal, fileGroupIdOf, HierarchyGroup,
} from './hierarchy';
import { D3Graph, D3Node, D3Link, VerificationStatus } from './types';

function createNode(
  id: string,
  crate: string,
  relativePath: string,
  status?: VerificationStatus,
): D3Node {
  return {
    id,
    display_name: id,
    symbol: id,
    full_path: `/repo/${relativePath}`,
    relative_path: relativePath,
    file_name: relativePath.split('/').pop() || '',
    parent_folder: '',
    crate_name: crate,
    is_libsignal: true,
    dependencies: [],
    dependents: [],
    kind: 'exec',
    verification_status: status,
  };
}

function createGraph(nodes: D3Node[], links: Array<[string, string, string?]>): D3Graph {
  const d3links: D3Link[] = links.map(([source, target, type]) => ({ source, target, type: type || 'inner' }));
  return {
    nodes,
    links: d3links,
    metadata: { total_nodes: nodes.length, total_edges: d3links.length, project_root: '/repo', generated_at: '2026-01-01' },
  };
}

function findGroup(roots: HierarchyGroup[], id: string): HierarchyGroup | undefined {
  for (const root of roots) {
    if (root.id === id) return root;
    const found = findGroup(root.children, id);
    if (found) return found;
  }
  return undefined;
}

describe('buildHierarchyTree', () => {
  it('groups nodes by crate at the top level', () => {
    const g = createGraph([
      createNode('a', 'alpha', 'src/a.rs'),
      createNode('b', 'beta', 'src/b.rs'),
    ], []);
    const tree = buildHierarchyTree(g);
    expect(tree.roots.map(r => r.label).sort()).toEqual(['alpha', 'beta']);
    expect(tree.roots.every(r => r.kind === 'crate')).toBe(true);
  });

  it('strips the crate prefix from relative paths', () => {
    const g = createGraph([
      createNode('a', 'alpha', 'alpha/src/a.rs'),
    ], []);
    const tree = buildHierarchyTree(g);
    const crate = tree.roots[0];
    // "alpha/" is stripped: the child under the crate is "src", not "alpha".
    expect(crate.children).toHaveLength(1);
    expect(crate.children[0].label).toBe('src');
  });

  it('strips multi-segment crate prefixes (Lean two-segment crate names)', () => {
    const g = createGraph([
      createNode('a', 'ArkLib/Data', 'ArkLib/Data/Poly/basic.lean'),
    ], []);
    const tree = buildHierarchyTree(g);
    const crate = tree.roots[0];
    expect(crate.label).toBe('ArkLib/Data');
    expect(crate.children[0].label).toBe('Poly');
  });

  it('compresses single-child directory chains and keeps the deepest id', () => {
    const g = createGraph([
      createNode('a', 'alpha', 'src/backend/serial/field.rs'),
      createNode('b', 'alpha', 'src/backend/serial/scalar.rs'),
    ], []);
    const tree = buildHierarchyTree(g);
    const crate = tree.roots[0];
    // src/backend/serial compresses into one dir group with the deepest id.
    expect(crate.children).toHaveLength(1);
    const dir = crate.children[0];
    expect(dir.label).toBe('src/backend/serial');
    expect(dir.id).toBe('alpha/src/backend/serial');
    expect(dir.children.map(c => c.label).sort()).toEqual(['field.rs', 'scalar.rs']);
  });

  it('does not compress a directory that contains a file', () => {
    const g = createGraph([
      createNode('a', 'alpha', 'src/lib.rs'),
      createNode('b', 'alpha', 'src/backend/field.rs'),
    ], []);
    const tree = buildHierarchyTree(g);
    const crate = tree.roots[0];
    expect(crate.children).toHaveLength(1);
    const src = crate.children[0];
    expect(src.label).toBe('src');
    expect(src.children.map(c => c.label).sort()).toEqual(['backend', 'lib.rs']);
  });

  it('computes fn/file/verified rollups bottom-up', () => {
    const g = createGraph([
      createNode('a', 'alpha', 'src/a.rs', 'verified'),
      createNode('b', 'alpha', 'src/a.rs', 'failed'),
      createNode('c', 'alpha', 'src/sub/c.rs', 'trusted'),
    ], []);
    const tree = buildHierarchyTree(g);
    const crate = tree.roots[0];
    expect(crate.fnCount).toBe(3);
    expect(crate.fileCount).toBe(2);
    expect(crate.verifiedCount).toBe(2); // verified + trusted
    const file = findGroup(tree.roots, 'alpha/src/a.rs');
    expect(file?.fnCount).toBe(2);
    expect(file?.verifiedCount).toBe(1);
    expect(file?.nodeIds.sort()).toEqual(['a', 'b']);
  });

  it('attaches nodes directly to the crate when the path equals the crate label', () => {
    // Lean crate names derived from the first two path segments can equal the
    // full relative path of a root-level file.
    const g = createGraph([
      createNode('a', 'HeaderLinter/Basic.lean', 'HeaderLinter/Basic.lean'),
    ], []);
    const tree = buildHierarchyTree(g);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].children).toHaveLength(0);
    expect(tree.roots[0].nodeIds).toEqual(['a']);
  });

  it('attaches nodes without a path directly to the crate group', () => {
    const node = createNode('a', 'alpha', '');
    node.file_name = '';
    const tree = buildHierarchyTree(createGraph([node], []));
    expect(tree.roots[0].nodeIds).toEqual(['a']);
    expect(tree.roots[0].fnCount).toBe(1);
  });
});

describe('pruneExpanded / descendantGroupIds', () => {
  it('drops ids that are not in the tree', () => {
    const tree = buildHierarchyTree(createGraph([createNode('a', 'alpha', 'src/a.rs')], []));
    const pruned = pruneExpanded(['alpha', 'alpha/src/a.rs', 'gone/never'], tree);
    expect([...pruned].sort()).toEqual(['alpha', 'alpha/src/a.rs']);
  });

  it('lists a group and all groups below it', () => {
    const tree = buildHierarchyTree(createGraph([
      createNode('a', 'alpha', 'src/a.rs'),
      createNode('b', 'alpha', 'src/sub/b.rs'),
    ], []));
    const ids = descendantGroupIds(tree.roots[0]).sort();
    expect(ids).toEqual([
      'alpha', 'alpha/src', 'alpha/src/a.rs', 'alpha/src/sub', 'alpha/src/sub/b.rs',
    ]);
  });
});

describe('computeCut', () => {
  const nodes = [
    createNode('a1', 'alpha', 'src/a.rs', 'verified'),
    createNode('a2', 'alpha', 'src/a.rs'),
    createNode('a3', 'alpha', 'src/sub/c.rs'),
    createNode('b1', 'beta', 'src/b.rs'),
  ];
  const graph = createGraph(nodes, [
    ['a1', 'a2'],           // intra-file
    ['a1', 'b1'],           // cross-crate
    ['a2', 'b1'],           // cross-crate (same aggregate as above)
    ['a3', 'a1', 'spec'],   // intra-crate, cross-file
  ]);
  const tree = buildHierarchyTree(graph);

  it('renders one member per crate with aggregated edges when nothing is expanded', () => {
    const cut = computeCut(tree, graph, new Set());
    expect(cut.members.map(m => m.id).sort()).toEqual(['alpha', 'beta']);
    expect(cut.containers).toHaveLength(0);
    // Intra-crate links collapse into the same member and are dropped.
    expect(cut.edges).toHaveLength(1);
    expect(cut.edges[0]).toMatchObject({ source: 'alpha', target: 'beta', callCount: 2 });
    expect(cut.assignment.get('a3')).toBe('alpha');
  });

  it('replaces an expanded crate by its children inside a container', () => {
    const cut = computeCut(tree, graph, new Set(['alpha', 'alpha/src']));
    expect(cut.containers.map(c => c.group.id)).toEqual(['alpha', 'alpha/src']);
    expect(cut.containers[1].containerId).toBe('alpha');
    const memberIds = cut.members.map(m => m.id).sort();
    expect(memberIds).toEqual(['alpha/src/a.rs', 'alpha/src/sub', 'beta']);
    const fileMember = cut.members.find(m => m.id === 'alpha/src/a.rs');
    expect(fileMember?.containerId).toBe('alpha/src');
    // a.rs → beta aggregates both cross-crate calls; sub → a.rs keeps its type.
    const edgeBeta = cut.edges.find(e => e.target === 'beta');
    expect(edgeBeta).toMatchObject({ source: 'alpha/src/a.rs', callCount: 2 });
    const edgeSpec = cut.edges.find(e => e.source === 'alpha/src/sub');
    expect(edgeSpec).toMatchObject({ target: 'alpha/src/a.rs', callCount: 1 });
    expect(edgeSpec?.calls[0].type).toBe('spec');
  });

  it('shows function members when a file group is expanded', () => {
    const cut = computeCut(tree, graph, new Set(['alpha', 'alpha/src', 'alpha/src/a.rs']));
    const fnMembers = cut.members.filter(m => m.kind === 'fn');
    expect(fnMembers.map(m => m.id).sort()).toEqual(['a1', 'a2']);
    expect(fnMembers[0].containerId).toBe('alpha/src/a.rs');
    expect(cut.assignment.get('a1')).toBe('a1');
    // The a1 → a2 intra-file call is now visible.
    const intra = cut.edges.find(e => e.source === 'a1' && e.target === 'a2');
    expect(intra?.callCount).toBe(1);
  });

  it('ignores an expanded id whose ancestor is collapsed', () => {
    const cut = computeCut(tree, graph, new Set(['alpha/src/a.rs']));
    expect(cut.members.map(m => m.id).sort()).toEqual(['alpha', 'beta']);
    expect(cut.containers).toHaveLength(0);
  });
});

describe('fileGroupIdOf', () => {
  it('gives the id of the file group in the tree', () => {
    const node = createNode('a', 'alpha', 'src/backend/serial/field.rs');
    const tree = buildHierarchyTree(createGraph([node], []));
    const id = fileGroupIdOf(node);
    expect(id).toBe('alpha/src/backend/serial/field.rs');
    expect(tree.groupById.get(id!)?.nodeIds).toEqual(['a']);
  });

  it('keeps two crates with the same relative path apart', () => {
    const a = createNode('a', 'alpha', 'src/lib.rs');
    const b = createNode('b', 'beta', 'src/lib.rs');
    expect(fileGroupIdOf(a)).toBe('alpha/src/lib.rs');
    expect(fileGroupIdOf(b)).toBe('beta/src/lib.rs');
  });

  it('strips the crate prefix and keeps spaces and commas', () => {
    expect(fileGroupIdOf(createNode('a', 'ArkLib/Data', 'ArkLib/Data/Poly/my file,v2.lean')))
      .toBe('ArkLib/Data/Poly/my file,v2.lean');
  });

  it('is null for a node without a path below its crate', () => {
    // A Lean file two levels deep is its own crate group
    expect(fileGroupIdOf(createNode('a', 'Spqr/Types.lean', 'Spqr/Types.lean'))).toBeNull();
    expect(fileGroupIdOf({ ...createNode('b', 'alpha', ''), file_name: '' })).toBeNull();
  });
});

describe('expandedForReveal', () => {
  const graph = createGraph([
    createNode('a', 'alpha', 'src/backend/serial/field.rs'),
    createNode('b', 'alpha', 'src/lib.rs'),
    createNode('c', 'beta', 'src/b.rs'),
  ], []);
  const tree = buildHierarchyTree(graph);

  it('expands a group found in the tree and its ancestors', () => {
    const expanded = expandedForReveal(tree, 'alpha/src/backend/serial');
    expect([...expanded].sort()).toEqual(['alpha', 'alpha/src', 'alpha/src/backend/serial']);
    // The cut shows the directory's file, with its sibling and the other crate collapsed
    const cut = computeCut(tree, graph, expanded);
    expect(cut.containers.map(c => c.group.id)).toEqual(['alpha', 'alpha/src', 'alpha/src/backend/serial']);
    expect(cut.members.map(m => m.id).sort())
      .toEqual(['alpha/src/backend/serial/field.rs', 'alpha/src/lib.rs', 'beta']);
  });

  it('expands the group that compression merged the directory into', () => {
    // 'alpha/src/backend' is merged into 'alpha/src/backend/serial' here
    expect(tree.groupById.has('alpha/src/backend')).toBe(false);
    const expanded = expandedForReveal(tree, 'alpha/src/backend');
    expect([...expanded].sort()).toEqual(['alpha', 'alpha/src', 'alpha/src/backend/serial']);
  });

  it('does not take a sibling whose name starts with the id', () => {
    const t = buildHierarchyTree(createGraph([
      createNode('a', 'alpha', 'src/backend2/x.rs'),
      createNode('b', 'alpha', 'src/lib.rs'),
    ], []));
    expect(expandedForReveal(t, 'alpha/src/backend').size).toBe(0);
  });

  it('is empty for a directory with no node left', () => {
    expect(expandedForReveal(tree, 'alpha/tests').size).toBe(0);
  });
});
