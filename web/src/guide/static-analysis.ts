/**
 * Static graph analysis module.
 *
 * Produces a GraphSummary with stats, rankings, and suggested queries
 * displayed as onboarding content in the guide panel.
 */

import type { D3Graph, D3Link, D3Node, ProjectLanguage } from '../types';
import { detectProjectLanguage, isVerifiedStatus } from '../types';
import { getLinkId } from '../query';
import type {
  GraphSummary, CrateSummary, GroupBoundary, VerificationBreakdown,
  KindBreakdown, NodeRank, SuggestedQuery,
} from './types';

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
  const topConnected = computeTopConnected(candidates, 5);
  const unverifiedHotspots = computeUnverifiedHotspots(candidates, nodes, 5);
  const failedNodes = nodes
    .filter(n => n.verification_status === 'failed')
    .map(nodeToRank)
    .sort((a, b) => b.dependentCount - a.dependentCount);

  const suggestedQueries = generateSuggestedQueries(
    lang, crates, boundary, verification, topConnected, unverifiedHotspots, failedNodes,
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
    topConnected,
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

function computeTopConnected(nodes: D3Node[], limit: number): NodeRank[] {
  return [...nodes]
    .sort((a, b) => (b.dependents?.length || 0) - (a.dependents?.length || 0) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(nodeToRank);
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
  topConnected: NodeRank[],
  unverifiedHotspots: NodeRank[],
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

  if (topConnected.length > 0) {
    const top = topConnected[0];
    const hasMoreCallers = top.dependentCount >= top.dependencyCount;
    queries.push({
      label: `Explore ${top.displayName} (most connected)`,
      description: hasMoreCallers
        ? `${top.dependentCount} callers -- central to the graph`
        : `${top.dependencyCount} callees -- central to the graph`,
      action: hasMoreCallers
        ? { type: 'setSink', id: top.id, label: top.displayName }
        : { type: 'setSource', id: top.id, label: top.displayName },
    });
  }

  if (unverifiedHotspots.length > 0) {
    const top = unverifiedHotspots[0];
    queries.push({
      label: `Verify next: ${top.displayName}`,
      description: `Unverified but called by verified functions`,
      action: { type: 'setSink', id: top.id, label: top.displayName },
    });
  }

  if (boundary) {
    const noun = lang === 'lean' ? 'Namespace' : 'Crate';
    queries.push({
      label: `${noun} boundary: ${boundary.source} → ${boundary.target}`,
      description: `${boundary.edgeCount} edges, the most between any two ${noun.toLowerCase()}s`,
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
      label: 'View crate/namespace map',
      description: `High-level view of ${crates.length} ${lang === 'lean' ? 'namespaces' : 'crates'}`,
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
  const langLabel = summary.projectLanguage === 'lean' ? 'Lean 4'
    : summary.projectLanguage === 'verus' ? 'Verus/Rust' : 'unknown language';

  lines.push(`This is a ${langLabel} project with ${summary.totalNodes} functions across ${summary.crates.length} ${summary.projectLanguage === 'lean' ? 'namespaces' : 'crates'} and ${summary.files.length} files.`);
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
    lines.push(`Top ${summary.projectLanguage === 'lean' ? 'namespaces' : 'crates'}: ${topCrates.map(c => `${c.name} (${c.nodeCount})`).join(', ')}.`);
  }

  // Kinds
  const kindEntries = Object.entries(summary.kinds).sort((a, b) => b[1] - a[1]);
  if (kindEntries.length > 0) {
    lines.push(`Declaration kinds: ${kindEntries.map(([k, n]) => `${n} ${k}`).join(', ')}.`);
  }

  // Most connected
  if (summary.topConnected.length > 0) {
    lines.push('');
    if (summary.roleFilterActive) {
      lines.push('Caller counts include statement and body/proof dependencies; the Statement deps / Body/proof deps boxes do not change them.');
    }
    lines.push(`Most connected functions: ${summary.topConnected.map(n => `${n.displayName} (${n.dependentCount} callers)`).join(', ')}.`);
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
