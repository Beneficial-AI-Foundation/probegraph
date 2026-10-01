import { D3Graph, D3Node, D3Link } from './types';

function linkEndpoints(link: D3Link): [string, string] {
  const s = typeof link.source === 'string' ? link.source : link.source.id;
  const t = typeof link.target === 'string' ? link.target : link.target.id;
  return [s, t];
}

// ============================================================================
// Entry-point seeding for large graphs
// ============================================================================

/** In-degree-0 definition kinds used for the restricted fallback tier. */
const SOURCE_DEF_KINDS = new Set(['def', 'instance', 'abbrev', 'structure', 'inductive', 'opaque']);

export interface SeedTier {
  /** 'blueprint-param' is built in main.ts from the ?entrypoints= payload,
   *  ahead of the tiers computeSeedTiers() derives from the graph itself. */
  name: 'blueprint-param' | 'entry-points' | 'sources' | 'source-defs';
  seeds: string[];
}

/**
 * Compute the seed preference tiers for the seeded initial view.
 *
 * Adjacency is derived from the normalized link set (all link types: inner,
 * spec, mapping, resolved externals), NOT from the per-node
 * dependencies/dependents arrays, which omit mapping and spec links.
 * Self-loops do not count toward in-degree: a node whose only caller is
 * itself is still a root.
 *
 * Tiers, in preference order:
 *   1. 'entry-points': nodes flagged is_entry_point by the loader (public
 *      API, Aeneas mapping join, blueprint attribute). Unlike the fallback
 *      tiers these need not have in-degree 0: public-API translations and
 *      blueprint declarations usually have in-project callers.
 *   2. 'sources': all in-degree-0 nodes.
 *   3. 'source-defs': in-degree-0 nodes of definition kinds. Only offered
 *      when it is a strict, non-empty subset of tier 2 (SCIP graphs carry
 *      no kind field, so they never get this tier).
 */
export function computeSeedTiers(graph: D3Graph): SeedTier[] {
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) inDegree.set(node.id, 0);
  for (const link of graph.links) {
    const [s, t] = linkEndpoints(link);
    if (s === t) continue;
    if (inDegree.has(t)) inDegree.set(t, inDegree.get(t)! + 1);
  }

  const entryPoints: string[] = [];
  const sources: string[] = [];
  const sourceDefs: string[] = [];
  for (const node of graph.nodes) {
    if (node.is_entry_point) entryPoints.push(node.id);
    if (inDegree.get(node.id) !== 0) continue;
    sources.push(node.id);
    if (node.kind && SOURCE_DEF_KINDS.has(node.kind)) sourceDefs.push(node.id);
  }

  const tiers: SeedTier[] = [];
  if (entryPoints.length > 0) tiers.push({ name: 'entry-points', seeds: entryPoints });
  if (sources.length > 0) tiers.push({ name: 'sources', seeds: sources });
  if (sourceDefs.length > 0 && sourceDefs.length < sources.length) {
    tiers.push({ name: 'source-defs', seeds: sourceDefs });
  }
  return tiers;
}

export interface SeedBudget {
  maxNodes: number;
  maxLinks: number;
}

/** The first layer that violated the budget, for refusal messages. */
export interface SeedRefusal {
  depth: number;
  nodes: number;
  links: number;
  failedBudget: 'nodes' | 'links';
}

export interface SeedExpansion {
  ok: true;
  nodeIds: Set<string>;
  /** BFS depth per node; passed to the renderer as nodeDepths so it never
   *  falls back to computeTopologicalDepth(), which on cyclic subgraphs keeps
   *  re-raising depths up to its node-count cap and yields arbitrary layers. */
  nodeDepths: Map<string, number>;
  /** Induced link count (every link with both endpoints in the view, all
   *  types, parallel links counted individually). */
  linkCount: number;
  /** Achieved depth: the largest admissible layer <= requestedDepth. */
  depth: number;
  requestedDepth: number;
  /** True when BFS ran out of new nodes before requestedDepth. */
  saturated: boolean;
  /** Set when depth < requestedDepth because the next layer broke the budget. */
  refusal?: SeedRefusal;
}

export interface SeedExpansionFailure {
  ok: false;
  refusal: SeedRefusal;
}

/**
 * Expand seeds along outgoing edges in a single layered BFS, validating the
 * induced view (nodes AND links, counted over the full link set) against the
 * budget after each layer. Returns the view at the largest admissible depth
 * in [1, requestedDepth], or a failure when even depth 1 exceeds the budget.
 *
 * Counting and the returned view are the same induced result: the link count
 * is the number of graph links with both endpoints in the node set, not a
 * BFS tree-edge count.
 */
export function expandFromSeeds(
  graph: D3Graph,
  seeds: string[],
  requestedDepth: number,
  budget: SeedBudget,
): SeedExpansion | SeedExpansionFailure {
  const nodeIds = new Set(graph.nodes.map(n => n.id));

  const outgoing = new Map<string, string[]>();
  for (const link of graph.links) {
    const [s, t] = linkEndpoints(link);
    if (!nodeIds.has(s) || !nodeIds.has(t)) continue;
    let targets = outgoing.get(s);
    if (!targets) {
      targets = [];
      outgoing.set(s, targets);
    }
    targets.push(t);
  }

  const countInducedLinks = (inView: Set<string>): number => {
    let count = 0;
    for (const link of graph.links) {
      const [s, t] = linkEndpoints(link);
      if (inView.has(s) && inView.has(t)) count++;
    }
    return count;
  };

  const nodeDepths = new Map<string, number>();
  let frontier: string[] = [];
  for (const seed of seeds) {
    if (nodeIds.has(seed) && !nodeDepths.has(seed)) {
      nodeDepths.set(seed, 0);
      frontier.push(seed);
    }
  }

  const inView = new Set(frontier);
  let admissibleDepth = 0;
  let admissibleLinks = countInducedLinks(inView);
  let saturated = false;
  let refusal: SeedRefusal | undefined;

  // The seed set itself must fit: expansion can only grow the view.
  if (inView.size > budget.maxNodes || admissibleLinks > budget.maxLinks) {
    return {
      ok: false,
      refusal: {
        depth: 0,
        nodes: inView.size,
        links: admissibleLinks,
        failedBudget: inView.size > budget.maxNodes ? 'nodes' : 'links',
      },
    };
  }

  for (let depth = 1; depth <= requestedDepth; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const target of outgoing.get(id) || []) {
        if (!nodeDepths.has(target)) {
          nodeDepths.set(target, depth);
          inView.add(target);
          next.push(target);
        }
      }
    }
    if (next.length === 0) {
      saturated = true;
      break;
    }

    const links = countInducedLinks(inView);
    if (inView.size > budget.maxNodes || links > budget.maxLinks) {
      refusal = {
        depth,
        nodes: inView.size,
        links,
        failedBudget: inView.size > budget.maxNodes ? 'nodes' : 'links',
      };
      // Roll the rejected layer back
      for (const id of next) {
        nodeDepths.delete(id);
        inView.delete(id);
      }
      break;
    }

    admissibleDepth = depth;
    admissibleLinks = links;
    frontier = next;
  }

  // Seeded views are clamped to depth >= 1: seeds alone are not a view.
  if (admissibleDepth < 1 && !saturated) {
    return {
      ok: false,
      refusal: refusal ?? {
        depth: 1,
        nodes: inView.size,
        links: admissibleLinks,
        failedBudget: inView.size > budget.maxNodes ? 'nodes' : 'links',
      },
    };
  }

  // Saturation with no budget violation means every requested depth fits.
  const achievedDepth = saturated && !refusal ? requestedDepth : Math.max(admissibleDepth, 1);

  return {
    ok: true,
    nodeIds: inView,
    nodeDepths,
    linkCount: admissibleLinks,
    depth: achievedDepth,
    requestedDepth,
    saturated,
    refusal,
  };
}

/**
 * Compute the transitive reduction of a DAG.
 * Removes edge u->v if v is reachable from u via another path.
 */
export function transitiveReduction(nodes: D3Node[], links: D3Link[]): D3Link[] {
  const nodeIds = new Set(nodes.map(n => n.id));

  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) adj.set(id, new Set());

  for (const link of links) {
    const s = typeof link.source === 'string' ? link.source : link.source.id;
    const t = typeof link.target === 'string' ? link.target : link.target.id;
    if (nodeIds.has(s) && nodeIds.has(t)) {
      adj.get(s)!.add(t);
    }
  }

  const redundant = new Set<string>();

  for (const link of links) {
    const s = typeof link.source === 'string' ? link.source : link.source.id;
    const t = typeof link.target === 'string' ? link.target : link.target.id;
    if (!nodeIds.has(s) || !nodeIds.has(t)) continue;

    // BFS from s, skipping the direct s->t edge, to see if t is reachable
    const visited = new Set<string>();
    const queue: string[] = [];
    for (const next of adj.get(s)!) {
      if (next !== t) {
        queue.push(next);
        visited.add(next);
      }
    }

    let reachable = false;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === t) { reachable = true; break; }
      for (const next of adj.get(cur) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    if (reachable) {
      const key = `${s}\0${t}\0${(link as any).type || 'inner'}`;
      redundant.add(key);
    }
  }

  return links.filter(link => {
    const s = typeof link.source === 'string' ? link.source : link.source.id;
    const t = typeof link.target === 'string' ? link.target : link.target.id;
    const key = `${s}\0${t}\0${(link as any).type || 'inner'}`;
    return !redundant.has(key);
  });
}
