/**
 * Render-cap truncation.
 *
 * A query result larger than the render cap keeps the nodes nearest to the
 * query's anchors: a breadth-first search (BFS) from the anchors in the
 * query direction, one depth at a time, ties broken by ID. Every kept node
 * then has a kept path to an anchor. Results without anchors (paths,
 * boundaries, unfiltered views) keep the most connected nodes instead.
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
 * Keep at most `budget` nodes of `graph`. With seeds, BFS from the anchors
 * present in the graph; anchors beyond the budget are dropped in rank
 * order. Nodes the BFS cannot reach are omitted even when the budget is not
 * used up, since they have no kept path to an anchor. Without seeds (or
 * when no anchor is in the graph), keep the most connected nodes.
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
    ? bfsFromAnchors(graph, anchors, seeds.direction, budget)
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

function bfsFromAnchors(
  graph: D3Graph,
  anchors: string[],
  direction: TruncationDirection,
  budget: number,
): Set<string> {
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

  const kept = new Set(anchors.slice(0, budget));
  let frontier = [...kept];
  while (frontier.length > 0 && kept.size < budget) {
    const level = new Set<string>();
    for (const id of frontier) {
      for (const n of next.get(id) ?? []) if (!kept.has(n)) level.add(n);
    }
    const sorted = [...level].sort(compareIds).slice(0, budget - kept.size);
    for (const id of sorted) kept.add(id);
    frontier = sorted;
  }
  return kept;
}

function mostConnected(nodes: D3Node[], budget: number): Set<string> {
  const degree = (n: D3Node) => (n.dependents?.length || 0) + (n.dependencies?.length || 0);
  return new Set([...nodes]
    .sort((a, b) => degree(b) - degree(a) || compareIds(a.id, b.id))
    .slice(0, budget)
    .map(n => n.id));
}
