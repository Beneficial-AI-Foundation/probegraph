/**
 * Render-cap truncation.
 *
 * A query result larger than the render cap keeps the nodes nearest to the
 * query's anchors, ties broken by ID. The distance is the query's own
 * traversal depth (`anchorDepths`) when it has one, else a breadth-first
 * search (BFS) from the anchors over the result's links in the query
 * direction (exact sets). Results without anchors (paths, boundaries,
 * unfiltered views) keep the most connected nodes instead.
 *
 * Display filters (status, language, origin, files, edge types) run after
 * the traversal and can remove the nodes between a kept node and its
 * anchor. Such a node is still kept by its traversal depth, so it can show
 * without a visible link to the anchor. Ranking only by visible links would
 * drop it, and a filter that cuts the anchor off would leave the anchor
 * alone on screen with the budget unused.
 *
 * Pure module (no DOM), unit-tested in the node environment.
 */

import type { D3Graph, D3Node } from './types';
import { getLinkId, type GraphQuery } from './query';
import { compareIds } from './reachability';

/** Which links the BFS follows: to callers (target -> source), to callees, or both. */
export type TruncationDirection = 'callers' | 'callees' | 'both';

export interface TruncationSeeds {
  /** In rank order; with more anchors than the budget, the first ones are kept. */
  anchors: string[];
  direction: TruncationDirection;
}

export interface TruncationResult {
  graph: D3Graph;
  /** Nodes of the input not kept. */
  omitted: number;
  /** Anchors present in the input, and how many of them were kept. */
  anchorsTotal: number;
  anchorsShown: number;
}

/**
 * Anchors and direction for a query result, or null when the query has no
 * anchors. Exact ID intents give their IDs in intent order; text selectors
 * give the matched nodes (depth 0 in the result), by ID.
 */
export function truncationSeeds(
  query: GraphQuery,
  intentAnchors: Iterable<string>,
  result: D3Graph,
): TruncationSeeds | null {
  const fromIntent = [...intentAnchors];
  const matched = () => fromIntent.length > 0 ? fromIntent
    : [...(result.nodeDepths ?? [])].filter(([, d]) => d === 0).map(([id]) => id).sort(compareIds);
  switch (query.type) {
    case 'callers': return { anchors: matched(), direction: 'callers' };
    case 'callees': return { anchors: matched(), direction: 'callees' };
    case 'neighborhood': return { anchors: matched(), direction: 'both' };
    case 'depthFromSelected':
      return { anchors: [...query.selectedNodes].sort(compareIds), direction: 'both' };
    case 'noTraversal':
      return fromIntent.length > 0 ? { anchors: fromIntent, direction: 'both' } : null;
    case 'paths':
    case 'crateBoundary':
      return null;
  }
}

/**
 * Keep at most `budget` nodes of `graph`. With seeds, keep the anchors
 * present in the graph (anchors beyond the budget are dropped in rank
 * order), then the nearest nodes, then, if room is left, the most connected
 * of the nodes with no distance. Without seeds (or when no anchor is in the
 * graph), keep the most connected nodes.
 */
export function truncateToBudget(
  graph: D3Graph,
  budget: number,
  seeds: TruncationSeeds | null,
): TruncationResult {
  const present = new Set(graph.nodes.map(n => n.id));
  const anchors = seeds ? [...new Set(seeds.anchors)].filter(id => present.has(id)) : [];
  if (graph.nodes.length <= budget) {
    return { graph, omitted: 0, anchorsTotal: anchors.length, anchorsShown: anchors.length };
  }

  const kept = seeds && anchors.length > 0
    ? nearestToAnchors(graph, anchors, seeds.direction, budget)
    : mostConnected(graph.nodes, budget);

  const nodes = graph.nodes.filter(n => kept.has(n.id));
  const links = graph.links.filter(l => {
    const { sourceId, targetId } = getLinkId(l);
    return kept.has(sourceId) && kept.has(targetId);
  });
  return {
    graph: { ...graph, nodes, links },
    omitted: graph.nodes.length - nodes.length,
    anchorsTotal: anchors.length,
    anchorsShown: anchors.filter(id => kept.has(id)).length,
  };
}

function nearestToAnchors(
  graph: D3Graph,
  anchors: string[],
  direction: TruncationDirection,
  budget: number,
): Set<string> {
  const kept = new Set(anchors.slice(0, budget));
  if (kept.size >= budget) return kept;
  const depth = graph.anchorDepths ?? bfsDepths(graph, anchors, direction);
  const rest = graph.nodes.filter(n => !kept.has(n.id));
  const reached = rest
    .filter(n => depth.has(n.id))
    .sort((a, b) => depth.get(a.id)! - depth.get(b.id)! || compareIds(a.id, b.id));
  for (const n of reached) {
    if (kept.size >= budget) return kept;
    kept.add(n.id);
  }
  const unreached = rest.filter(n => !depth.has(n.id));
  for (const id of mostConnected(unreached, budget - kept.size)) kept.add(id);
  return kept;
}

/** Depth of each node a BFS from the anchors reaches over the graph's links. */
function bfsDepths(graph: D3Graph, anchors: string[], direction: TruncationDirection): Map<string, number> {
  const next = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    const list = next.get(from);
    if (list) list.push(to); else next.set(from, [to]);
  };
  for (const link of graph.links) {
    const { sourceId, targetId } = getLinkId(link);
    if (direction !== 'callers') add(sourceId, targetId);
    if (direction !== 'callees') add(targetId, sourceId);
  }

  const depth = new Map(anchors.map(id => [id, 0]));
  const queue = [...anchors];
  for (let i = 0; i < queue.length; i++) {
    const d = depth.get(queue[i])! + 1;
    for (const n of next.get(queue[i]) ?? []) {
      if (!depth.has(n)) { depth.set(n, d); queue.push(n); }
    }
  }
  return depth;
}

function mostConnected(nodes: D3Node[], budget: number): Set<string> {
  const degree = (n: D3Node) => (n.dependents?.length || 0) + (n.dependencies?.length || 0);
  return new Set([...nodes]
    .sort((a, b) => degree(b) - degree(a) || compareIds(a.id, b.id))
    .slice(0, budget)
    .map(n => n.id));
}
