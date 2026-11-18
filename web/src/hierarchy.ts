/**
 * Hierarchy drill-down model for the Hierarchy view.
 *
 * The full graph is organized into a tree: crate → directory → file →
 * function. At any moment the view renders a *cut* through that tree: every
 * function belongs to exactly one visible cut member (either itself, when its
 * file is expanded, or its nearest collapsed ancestor group), and links are
 * aggregated between cut members with call counts. Expanding or collapsing a
 * group moves the cut locally; unexpanded regions stay on screen as
 * aggregates instead of being dropped.
 */

import { D3Graph, D3Node, isVerifiedStatus } from './types';

export type GroupKind = 'crate' | 'dir' | 'file';

export interface HierarchyGroup {
  /** Stable path id: crate label plus uncompressed path segments, '/'-joined. */
  id: string;
  /** Display label; directory chains with single children are compressed ("src/backend"). */
  label: string;
  kind: GroupKind;
  parentId: string | null;
  children: HierarchyGroup[];
  /** Function node ids directly in this group (file groups only). */
  nodeIds: string[];
  // Rollups over the whole subtree:
  fnCount: number;
  fileCount: number;
  /** Functions whose status `isDone` accepts (default: isVerifiedStatus). */
  verifiedCount: number;
}

export interface HierarchyTree {
  roots: HierarchyGroup[];
  groupById: Map<string, HierarchyGroup>;
}

export interface CutMember {
  /** Group id for collapsed groups, function node id for functions. */
  id: string;
  kind: 'group' | 'fn';
  group?: HierarchyGroup;
  node?: D3Node;
  /** Nearest expanded ancestor group id, for compound (nested-box) rendering. */
  containerId: string | null;
}

export interface CutEdge {
  source: string;
  target: string;
  callCount: number;
  calls: Array<{ sourceId: string; targetId: string; type: string }>;
}

export interface HierarchyCut {
  members: CutMember[];
  edges: CutEdge[];
  /** Expanded groups rendered as containers, outermost first. */
  containers: Array<{ group: HierarchyGroup; containerId: string | null }>;
  /** Function node id → cut member id it is represented by. */
  assignment: Map<string, string>;
}

// ============================================================================
// Tree construction
// ============================================================================

interface BuildGroup {
  id: string;
  label: string;
  kind: GroupKind;
  children: Map<string, BuildGroup>;
  nodeIds: string[];
}

/**
 * The directory and file segments of a node's path below its crate. When
 * the relative path starts with the crate label's own segments (common in
 * Rust workspaces and Lean two-segment crate names), that prefix is
 * stripped so the crate level is not duplicated as directories.
 */
function pathSegments(node: D3Node, crate: string): string[] {
  const relPath = node.relative_path || node.file_name || '';
  const segments = relPath.split('/').filter(Boolean);
  const crateSegments = crate.split('/').filter(Boolean);
  if (segments.length >= crateSegments.length
      && crateSegments.every((s, i) => segments[i] === s)) {
    return segments.slice(crateSegments.length);
  }
  return segments;
}

/**
 * Id of the file group that holds `node` in `buildHierarchyTree`, or null
 * when the node has no path below its crate (it sits in the crate group).
 * Directory compression never changes a file id, so the id is the same in
 * every tree built from a graph with this node.
 */
export function fileGroupIdOf(node: D3Node): string | null {
  const crate = node.crate_name || 'unknown';
  const segments = pathSegments(node, crate);
  return segments.length === 0 ? null : [crate, ...segments].join('/');
}

/**
 * Build the crate → directory → file → function hierarchy from a graph.
 *
 * Grouping uses `crate_name` for the top level and the node's
 * `relative_path` for the directory chain and file. When the relative path
 * starts with the crate label's own segments (common in Rust workspaces and
 * Lean two-segment crate names), that prefix is stripped so the crate level
 * is not duplicated as directories.
 *
 * `isDone` picks the nodes that `verifiedCount` counts. The Packed Map
 * passes a stricter test for Lean nodes (packedArcStatus).
 */
export function buildHierarchyTree(
  graph: D3Graph,
  isDone: (node: D3Node) => boolean = node => isVerifiedStatus(node.verification_status),
): HierarchyTree {
  const rootMap = new Map<string, BuildGroup>();

  for (const node of graph.nodes) {
    const crate = node.crate_name || 'unknown';
    let crateGroup = rootMap.get(crate);
    if (!crateGroup) {
      crateGroup = { id: crate, label: crate, kind: 'crate', children: new Map(), nodeIds: [] };
      rootMap.set(crate, crateGroup);
    }

    const segments = pathSegments(node, crate);
    if (segments.length === 0) {
      // No usable path: attach the function directly to the crate group.
      crateGroup.nodeIds.push(node.id);
      continue;
    }

    let current = crateGroup;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isFile = i === segments.length - 1;
      const childId = `${current.id}/${seg}`;
      let child = current.children.get(seg);
      if (!child) {
        child = { id: childId, label: seg, kind: isFile ? 'file' : 'dir', children: new Map(), nodeIds: [] };
        current.children.set(seg, child);
      }
      current = child;
    }
    current.nodeIds.push(node.id);
  }

  const nodeById = new Map<string, D3Node>();
  for (const node of graph.nodes) nodeById.set(node.id, node);

  const groupById = new Map<string, HierarchyGroup>();

  function finalize(bg: BuildGroup, parentId: string | null): HierarchyGroup {
    // Compress single-child directory chains: a dir whose only content is
    // one child dir merges into it, keeping the deepest id (stable in URLs).
    let label = bg.label;
    let inner = bg;
    while (inner.kind === 'dir' && inner.nodeIds.length === 0 && inner.children.size === 1) {
      const only = [...inner.children.values()][0];
      if (only.kind !== 'dir') break;
      label = `${label}/${only.label}`;
      inner = only;
    }

    const group: HierarchyGroup = {
      id: inner.id,
      label,
      kind: bg.kind,
      parentId,
      children: [],
      nodeIds: inner.nodeIds,
      fnCount: inner.nodeIds.length,
      fileCount: inner.kind === 'file' ? 1 : 0,
      verifiedCount: 0,
    };
    for (const id of inner.nodeIds) {
      const node = nodeById.get(id);
      if (node && isDone(node)) group.verifiedCount++;
    }

    const childGroups = [...inner.children.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(c => finalize(c, group.id));
    for (const child of childGroups) {
      group.children.push(child);
      group.fnCount += child.fnCount;
      group.fileCount += child.fileCount;
      group.verifiedCount += child.verifiedCount;
    }

    groupById.set(group.id, group);
    return group;
  }

  const roots = [...rootMap.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(r => finalize(r, null));

  return { roots, groupById };
}

/**
 * The expanded set that shows group `id` open, with its ancestors as
 * containers and everything else collapsed. The id comes from another tree
 * (the Packed Map), which can compress directories differently:
 *
 * 1. If `tree` has the id: the id and its ancestors.
 * 2. Else, if compression merged the directory into a deeper one: that
 *    group (the shortest id starting with `id + '/'`) and its ancestors.
 * 3. Else (no node of the directory is left): an empty set.
 */
export function expandedForReveal(tree: HierarchyTree, id: string): Set<string> {
  let target = tree.groupById.get(id);
  if (!target) {
    const prefix = `${id}/`;
    for (const [groupId, group] of tree.groupById) {
      if (groupId.startsWith(prefix) && (!target || groupId.length < target.id.length)) target = group;
    }
  }
  const chain: string[] = [];
  for (let group = target; group; group = group.parentId ? tree.groupById.get(group.parentId) : undefined) {
    chain.push(group.id);
  }
  // Outermost first, as a user expands them (and as ?expanded= reads)
  return new Set(chain.reverse());
}

// ============================================================================
// Cut computation
// ============================================================================

/** Drop expanded ids that no longer exist in the tree (stale URL state). */
export function pruneExpanded(expanded: Iterable<string>, tree: HierarchyTree): Set<string> {
  const result = new Set<string>();
  for (const id of expanded) {
    if (tree.groupById.has(id)) result.add(id);
  }
  return result;
}

/** Ids of a group and all groups below it (for collapsing a whole subtree). */
export function descendantGroupIds(group: HierarchyGroup): string[] {
  const ids: string[] = [group.id];
  for (const child of group.children) ids.push(...descendantGroupIds(child));
  return ids;
}

/**
 * Compute the visible cut for a set of expanded group ids.
 *
 * An expanded group is rendered as a container and contributes its children
 * to the cut; a collapsed group is a cut member aggregating its whole
 * subtree. A group is only treated as expanded when its parent chain is also
 * expanded (an orphaned id, e.g. after collapsing an ancestor, is ignored).
 */
export function computeCut(
  tree: HierarchyTree,
  graph: D3Graph,
  expanded: Set<string>,
): HierarchyCut {
  const members: CutMember[] = [];
  const containers: HierarchyCut['containers'] = [];
  const assignment = new Map<string, string>();
  const nodeById = new Map<string, D3Node>();
  for (const node of graph.nodes) nodeById.set(node.id, node);

  function assignSubtree(group: HierarchyGroup, memberId: string): void {
    for (const id of group.nodeIds) assignment.set(id, memberId);
    for (const child of group.children) assignSubtree(child, memberId);
  }

  function visit(group: HierarchyGroup, containerId: string | null): void {
    const isExpandable = group.children.length > 0 || group.nodeIds.length > 0;
    if (expanded.has(group.id) && isExpandable) {
      containers.push({ group, containerId });
      for (const id of group.nodeIds) {
        const node = nodeById.get(id);
        if (!node) continue;
        members.push({ id, kind: 'fn', node, containerId: group.id });
        assignment.set(id, id);
      }
      for (const child of group.children) visit(child, group.id);
    } else {
      members.push({ id: group.id, kind: 'group', group, containerId });
      assignSubtree(group, group.id);
    }
  }

  for (const root of tree.roots) visit(root, null);

  // Aggregate links between cut members.
  const edgeMap = new Map<string, CutEdge>();
  for (const link of graph.links) {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    const sm = assignment.get(sourceId);
    const tm = assignment.get(targetId);
    if (!sm || !tm || sm === tm) continue;

    const key = `${sm}\0${tm}`;
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { source: sm, target: tm, callCount: 0, calls: [] };
      edgeMap.set(key, edge);
    }
    edge.callCount++;
    edge.calls.push({
      sourceId,
      targetId,
      type: typeof link.type === 'string' ? link.type : 'inner',
    });
  }

  return { members, edges: [...edgeMap.values()], containers, assignment };
}
