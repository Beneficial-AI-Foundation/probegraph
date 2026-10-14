/**
 * Static graph analysis module.
 *
 * Produces a GraphSummary with stats, rankings, and suggested queries
 * displayed as onboarding content in the guide panel.
 */

import type { D3Graph, D3Link, D3Node, ProjectLanguage } from '../types';
import { crateNoun, detectProjectLanguage, getKindSetsForLanguage, isVerifiedStatus } from '../types';
import { getLinkId } from '../query';
import {
  dependencyLevels, graphCondensation, rankByTransitiveDependents, reachabilityFits,
} from '../reachability';
import type {
  GraphSummary, CrateSummary, GroupBoundary, VerificationBreakdown,
  KindBreakdown, NodeRank, SuggestedQuery, RankedAnswer, RankedList, LevelStat,
} from './types';

/** Rows per ranked list. */
export const RANKED_LIST_LENGTH = 5;

/** What the current filters show; the rankings and chips only name these. */
export interface SummaryVisibility {
  isCandidate: (node: D3Node) => boolean;  // kind filters
  isLinkShown: (link: D3Link) => boolean;  // link type filters
  roleFilterActive?: boolean;  // a statement / body-or-proof box is off
}

const SHOW_ALL: SummaryVisibility = { isCandidate: () => true, isLinkShown: () => true };

/** Counts always use the full graph; `visibility` only restricts rankings and chips. */
export function buildGraphSummary(graph: D3Graph, visibility: SummaryVisibility = SHOW_ALL): GraphSummary {
  const { isCandidate } = visibility;
  const lang = detectProjectLanguage(graph);
  const nodes = graph.nodes;
  const links = graph.links;
  const candidates = nodes.filter(isCandidate);

  const crates = computeCrates(nodes);
  const boundary = computeBoundary(graph, visibility);
  const files = computeFiles(nodes);
  const verification = computeVerification(nodes);
  const kinds = computeKinds(nodes);
  const ranked = computeRankedLists(graph, lang, isCandidate);
  const levels = computeLevels(graph);
  const unverifiedHotspots = computeUnverifiedHotspots(candidates, nodes, 5);
  const failedNodes = nodes
    .filter(n => n.verification_status === 'failed')
    .map(nodeToRank)
    .sort((a, b) => b.dependentCount - a.dependentCount);

  const suggestedQueries = generateSuggestedQueries(
    lang, crates, boundary, verification, failedNodes,
  );

  return {
    projectLanguage: lang,
    totalNodes: nodes.length,
    totalEdges: links.length,
    crates,
    boundary,
    files,
    verification,
    kinds,
    ...ranked,
    levels,
    unverifiedHotspots,
    failedNodes,
    suggestedQueries,
    roleFilterActive: visibility.roleFilterActive ?? false,
  };
}

function computeCrates(nodes: D3Node[]): CrateSummary[] {
  const map = new Map<string, { nodeCount: number; files: Set<string>; isExternal: boolean }>();
  for (const n of nodes) {
    const name = n.crate_name || 'unknown';
    if (!map.has(name)) map.set(name, { nodeCount: 0, files: new Set(), isExternal: !n.is_libsignal });
    const entry = map.get(name)!;
    entry.nodeCount++;
    if (n.file_name) entry.files.add(n.relative_path || n.file_name);
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, nodeCount: v.nodeCount, fileCount: v.files.size, isExternal: v.isExternal }))
    .sort((a, b) => b.nodeCount - a.nodeCount);
}

/**
 * Directed group pair with the most shown links between candidate nodes,
 * ties broken by name. Links point caller -> callee, so `source` is the
 * callers' group. Null when no link crosses groups.
 */
function computeBoundary(graph: D3Graph, { isCandidate, isLinkShown }: SummaryVisibility): GroupBoundary | null {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const counts = new Map<string, GroupBoundary>();
  for (const link of graph.links) {
    if (!isLinkShown(link)) continue;
    const { sourceId, targetId } = getLinkId(link);
    const s = nodeMap.get(sourceId);
    const t = nodeMap.get(targetId);
    if (!s || !t || !isCandidate(s) || !isCandidate(t)) continue;
    // 'unknown' is the fallback name, not a group the dropdowns offer
    if (s.crate_name === t.crate_name || s.crate_name === 'unknown' || t.crate_name === 'unknown') continue;
    const key = `${s.crate_name}\0${t.crate_name}`;
    const entry = counts.get(key) ?? { source: s.crate_name, target: t.crate_name, edgeCount: 0 };
    entry.edgeCount++;
    counts.set(key, entry);
  }
  let best: GroupBoundary | null = null;
  for (const b of counts.values()) {
    if (!best || b.edgeCount > best.edgeCount
      || (b.edgeCount === best.edgeCount && (b.source < best.source
        || (b.source === best.source && b.target < best.target)))) {
      best = b;
    }
  }
  return best;
}

function computeFiles(nodes: D3Node[]): string[] {
  const files = new Set<string>();
  for (const n of nodes) {
    const f = n.relative_path || n.file_name;
    if (f) files.add(f);
  }
  return [...files].sort();
}

function computeVerification(nodes: D3Node[]): VerificationBreakdown {
  const result: VerificationBreakdown = {
    verified: 0, transitivelyVerified: 0, trusted: 0, failed: 0, unverified: 0, unknown: 0,
  };
  for (const n of nodes) {
    switch (n.verification_status) {
      case 'verified': result.verified++; break;
      case 'transitively-verified': result.transitivelyVerified++; break;
      case 'trusted': result.trusted++; break;
      case 'failed': result.failed++; break;
      case 'unverified': result.unverified++; break;
      default: result.unknown++; break;
    }
  }
  return result;
}

function computeKinds(nodes: D3Node[]): KindBreakdown {
  const result: KindBreakdown = {};
  for (const n of nodes) {
    const kind = n.kind || 'unknown';
    result[kind] = (result[kind] || 0) + 1;
  }
  return result;
}

function nodeToRank(n: D3Node): NodeRank {
  return {
    id: n.id,
    displayName: n.display_name,
    crateName: n.crate_name,
    kind: n.kind || 'unknown',
    verificationStatus: n.verification_status,
    dependentCount: n.dependents?.length || 0,
    dependencyCount: n.dependencies?.length || 0,
  };
}

/** Unfinished work: the declaration itself is not done. Axioms are assumptions, not blockers. */
export function isUnfinished(n: D3Node): boolean {
  return (n.verification_status === 'unverified' || n.verification_status === 'failed') && n.kind !== 'axiom';
}

/** Accepted assumptions: axioms and the rest of the trust base. */
export function isAssumption(n: D3Node): boolean {
  return n.kind === 'axiom' || n.verification_status === 'trusted';
}

/**
 * The Guide's ranked lists, by unique transitive dependents over the full
 * graph, ties by ID. `isCandidate` (the kind filters) restricts the rows,
 * never the counts. When the graph is too large (reachabilityFits), the
 * counts are not computed: the lists are empty and `rankingsSkipped` gives
 * the size of the condensed graph.
 */
function computeRankedLists(
  graph: D3Graph,
  lang: ProjectLanguage,
  isCandidate: (node: D3Node) => boolean,
): Pick<GraphSummary, 'unfinished' | 'assumptions' | 'keystones' | 'keystonesAreLemmas' | 'rankingsSkipped'> {
  const { proofKinds } = getKindSetsForLanguage(lang);
  // Graphs without proofs (plain Rust) rank every node instead
  const keystonesAreLemmas = graph.nodes.some(n => proofKinds.has(n.kind));
  const isKeystone = keystonesAreLemmas ? (n: D3Node) => proofKinds.has(n.kind) : () => true;
  const condensation = graphCondensation(graph);
  const rankingsSkipped = reachabilityFits(condensation) ? null : {
    components: condensation.members.length,
    links: condensation.dependencies.reduce((sum, deps) => sum + deps.length, 0),
  };
  const list = (pred: (n: D3Node) => boolean): RankedList => {
    const select = (n: D3Node) => isCandidate(n) && pred(n);
    const rows: RankedAnswer[] = (rankByTransitiveDependents(graph, select, RANKED_LIST_LENGTH) ?? [])
      .map(({ node, count }) => ({ ...nodeToRank(node), transitiveDependentCount: count }));
    addContext(rows, graph);
    return { rows, total: graph.nodes.filter(select).length };
  };
  return {
    unfinished: list(isUnfinished),
    assumptions: list(isAssumption),
    keystones: list(isKeystone),
    keystonesAreLemmas,
    rankingsSkipped,
  };
}

/** Rows that share a display name show their module or path. */
function addContext(rows: RankedAnswer[], graph: D3Graph): void {
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.displayName, (seen.get(r.displayName) ?? 0) + 1);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  for (const r of rows) {
    if (seen.get(r.displayName)! < 2) continue;
    const n = byId.get(r.id)!;
    r.context = n.relative_path || n.crate_name || r.id;
  }
}

/** Node and status counts per topological level of the condensed graph. */
function computeLevels(graph: D3Graph): LevelStat[] {
  const condensation = graphCondensation(graph);
  const levels = dependencyLevels(condensation);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const stats: LevelStat[] = [];
  for (let k = 0; k < levels.length; k++) {
    const level = levels[k];
    while (stats.length <= level) {
      stats.push({ level: stats.length, nodes: 0, verified: 0, transitivelyVerified: 0, trusted: 0 });
    }
    const s = stats[level];
    for (const id of condensation.members[k]) {
      s.nodes++;
      switch (byId.get(id)!.verification_status) {
        case 'verified': s.verified++; break;
        case 'transitively-verified': s.transitivelyVerified++; break;
        case 'trusted': s.trusted++; break;
      }
    }
  }
  return stats;
}

/**
 * Find unverified candidates that have the most verified callers (callers
 * counted over all nodes). These are high-priority verification targets.
 */
function computeUnverifiedHotspots(
  candidates: D3Node[],
  nodes: D3Node[],
  limit: number,
): NodeRank[] {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const hotspots: Array<NodeRank & { verifiedCallerCount: number }> = [];
  for (const n of candidates) {
    if (isVerifiedStatus(n.verification_status) || n.verification_status === 'failed') continue;
    let verifiedCallers = 0;
    for (const depId of n.dependents || []) {
      const caller = nodeMap.get(depId);
      if (isVerifiedStatus(caller?.verification_status)) verifiedCallers++;
    }
    if (verifiedCallers > 0) {
      hotspots.push({ ...nodeToRank(n), verifiedCallerCount: verifiedCallers });
    }
  }

  return hotspots
    .sort((a, b) => b.verifiedCallerCount - a.verifiedCallerCount || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function generateSuggestedQueries(
  lang: ProjectLanguage,
  crates: CrateSummary[],
  boundary: GroupBoundary | null,
  verification: VerificationBreakdown,
  failedNodes: NodeRank[],
): SuggestedQuery[] {
  const queries: SuggestedQuery[] = [];

  if (failedNodes.length > 0) {
    queries.push({
      label: `Show ${failedNodes.length} failed verification${failedNodes.length > 1 ? 's' : ''}`,
      description: `Focus on functions that failed verification`,
      action: { type: 'filterVerification', statuses: ['failed'] },
    });
  }

  if (boundary) {
    const noun = crateNoun(lang);
    queries.push({
      label: `${noun.charAt(0).toUpperCase() + noun.slice(1)} boundary: ${boundary.source} → ${boundary.target}`,
      description: `${boundary.edgeCount} edges, the most between any two ${noun}s`,
      action: { type: 'setCrateBoundary', source: boundary.source, target: boundary.target },
    });
  }

  // Transitively verified is the strongest status; extracts without the
  // enrichment step (or older ones) only have locally verified
  const total = verificationTotal(verification);
  const transitive = verification.transitivelyVerified > 0;
  const selected = transitive ? verification.transitivelyVerified : verification.verified;
  if (selected > 0 && selected < total) {
    queries.push({
      label: transitive ? 'Show only transitively verified' : 'Show only verified',
      description: transitive
        ? `${selected} of ${total}, with every dependency verified or trusted`
        : `${selected} of ${total}`,
      action: { type: 'filterVerification', statuses: [transitive ? 'transitively-verified' : 'verified'] },
    });
  }

  if (crates.length > 1) {
    queries.push({
      label: lang === 'blueprint' ? 'View chapter map' : 'View crate/namespace map',
      description: `High-level view of ${crates.length} ${crateNoun(lang)}s`,
      action: { type: 'switchView', view: 'crate-map' },
    });
  }

  return queries;
}

function verificationTotal(v: VerificationBreakdown): number {
  return v.verified + v.transitivelyVerified + v.trusted + v.failed + v.unverified + v.unknown;
}

/**
 * Format a graph summary as human-readable text for the guide panel.
 */
export function formatSummaryText(summary: GraphSummary): string {
  const lines: string[] = [];
  const lang = summary.projectLanguage;
  const groups = `${crateNoun(lang)}s`;
  if (lang === 'blueprint') {
    lines.push(`This is a blueprint with ${summary.totalNodes} entries across ${summary.crates.length} ${groups}.`);
  } else {
    const langLabel = lang === 'lean' ? 'Lean 4'
      : lang === 'verus' ? 'Verus/Rust' : 'unknown language';
    lines.push(`This is a ${langLabel} project with ${summary.totalNodes} functions across ${summary.crates.length} ${groups} and ${summary.files.length} files.`);
  }
  lines.push('');

  // Verification
  const v = summary.verification;
  if (v.unknown < verificationTotal(v)) {
    const parts: [number, string][] = [
      [v.transitivelyVerified, 'transitively verified'],
      [v.verified, v.transitivelyVerified > 0 ? 'verified (locally only)' : 'verified'],
      [v.trusted, 'trusted'],
      [v.failed, 'failed'],
      [v.unverified, 'unverified'],
      [v.unknown, 'without status'],
    ];
    lines.push(`Verification: ${parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`).join(', ')}.`);
  }

  // Crates
  if (summary.crates.length > 0) {
    const topCrates = summary.crates.slice(0, 5);
    lines.push(`Top ${groups}: ${topCrates.map(c => `${c.name} (${c.nodeCount})`).join(', ')}.`);
  }

  // Kinds
  const kindEntries = Object.entries(summary.kinds).sort((a, b) => b[1] - a[1]);
  if (kindEntries.length > 0) {
    lines.push(`Declaration kinds: ${kindEntries.map(([k, n]) => `${n} ${k}`).join(', ')}.`);
  }

  if (summary.roleFilterActive) {
    lines.push('');
    lines.push('Dependent counts include statement and body/proof dependencies; the Statement deps / Body/proof deps boxes do not change them.');
  }

  // Failed
  if (summary.failedNodes.length > 0) {
    lines.push(`Failed verifications: ${summary.failedNodes.map(n => n.displayName).join(', ')}.`);
  }

  // Hotspots
  if (summary.unverifiedHotspots.length > 0) {
    lines.push(`Unverified hotspots (called by verified code): ${summary.unverifiedHotspots.map(n => n.displayName).join(', ')}.`);
  }

  return lines.join('\n');
}
