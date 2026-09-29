/**
 * Static graph analysis module.
 *
 * Produces a GraphSummary with stats, rankings, and suggested queries
 * displayed as onboarding content in the guide panel.
 */

import type { D3Graph, D3Node, ProjectLanguage } from '../types';
import { detectProjectLanguage, isVerifiedStatus } from '../types';
import type {
  GraphSummary, CrateSummary, VerificationBreakdown,
  KindBreakdown, NodeRank, SuggestedQuery,
} from './types';

export function buildGraphSummary(graph: D3Graph): GraphSummary {
  const lang = detectProjectLanguage(graph);
  const nodes = graph.nodes;
  const links = graph.links;

  const crates = computeCrates(nodes);
  const files = computeFiles(nodes);
  const verification = computeVerification(nodes);
  const kinds = computeKinds(nodes);
  const topConnected = computeTopConnected(nodes, 5);
  const unverifiedHotspots = computeUnverifiedHotspots(nodes, graph, 5);
  const failedNodes = nodes
    .filter(n => n.verification_status === 'failed')
    .map(nodeToRank)
    .sort((a, b) => b.dependentCount - a.dependentCount);

  const suggestedQueries = generateSuggestedQueries(
    lang, crates, verification, topConnected, unverifiedHotspots, failedNodes,
  );

  return {
    projectLanguage: lang,
    totalNodes: nodes.length,
    totalEdges: links.length,
    crates,
    files,
    verification,
    kinds,
    topConnected,
    unverifiedHotspots,
    failedNodes,
    suggestedQueries,
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

function computeFiles(nodes: D3Node[]): string[] {
  const files = new Set<string>();
  for (const n of nodes) {
    const f = n.relative_path || n.file_name;
    if (f) files.add(f);
  }
  return [...files].sort();
}

function computeVerification(nodes: D3Node[]): VerificationBreakdown {
  const result: VerificationBreakdown = { verified: 0, failed: 0, unverified: 0 };
  for (const n of nodes) {
    switch (n.verification_status) {
      case 'verified':
      case 'transitively-verified':
      case 'trusted':
        result.verified++; break;
      case 'failed': result.failed++; break;
      default: result.unverified++; break;
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
    .sort((a, b) => (b.dependents?.length || 0) - (a.dependents?.length || 0))
    .slice(0, limit)
    .map(nodeToRank);
}

/**
 * Find unverified nodes that have the most verified callers.
 * These are high-priority verification targets.
 */
function computeUnverifiedHotspots(
  nodes: D3Node[],
  _graph: D3Graph,
  limit: number,
): NodeRank[] {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const hotspots: Array<NodeRank & { verifiedCallerCount: number }> = [];
  for (const n of nodes) {
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
    .sort((a, b) => b.verifiedCallerCount - a.verifiedCallerCount)
    .slice(0, limit);
}

function generateSuggestedQueries(
  lang: ProjectLanguage,
  crates: CrateSummary[],
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

  if (crates.length >= 2) {
    const [c1, c2] = crates;
    queries.push({
      label: `Crate boundary: ${c1.name} / ${c2.name}`,
      description: `See how the two largest modules interact`,
      action: { type: 'setCrateBoundary', source: c1.name, target: c2.name },
    });
  }

  if (verification.verified > 0 && verification.unverified > 0) {
    queries.push({
      label: 'Show only verified functions',
      description: `${verification.verified} verified out of ${verification.verified + verification.failed + verification.unverified}`,
      action: { type: 'filterVerification', statuses: ['verified'] },
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
  const total = v.verified + v.failed + v.unverified;
  if (v.verified > 0 || v.failed > 0) {
    const pct = total > 0 ? Math.round((v.verified / total) * 100) : 0;
    lines.push(`Verification: ${v.verified} verified (${pct}%), ${v.failed} failed, ${v.unverified} unverified/unknown.`);
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
