/**
 * Unit tests for the Guide's static analysis and result toast.
 */

import { describe, it, expect } from 'vitest';
import { buildGraphSummary, formatSummaryText } from './static-analysis';
import { guideTransition, resultMessage } from './guide-panel';
import type { SuggestedAction } from './types';
import { D3Graph, D3Link, D3Node, VerificationStatus } from '../types';

function node(id: string, crate: string, kind: string, status?: VerificationStatus): D3Node {
  return {
    id, display_name: id, symbol: id, full_path: `/p/${id}.lean`, relative_path: `${crate}/${id}.lean`,
    file_name: `${id}.lean`, parent_folder: crate, crate_name: crate, is_libsignal: true,
    dependencies: [], dependents: [], kind, verification_status: status, language: 'lean',
  };
}

/** Links point caller -> callee; fills dependencies/dependents to match. */
function graph(nodes: D3Node[], links: D3Link[]): D3Graph {
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const l of links) {
    byId.get(l.source as string)!.dependencies.push(l.target as string);
    byId.get(l.target as string)!.dependents.push(l.source as string);
  }
  return {
    nodes, links,
    metadata: { total_nodes: nodes.length, total_edges: links.length, project_root: '/t', generated_at: '' },
  };
}

/**
 * Group B is the largest, but only A -> B carries links: B never calls A.
 * S is a structure with the most callers; t1 the most connected theorem.
 */
function fixture(): D3Graph {
  const nodes = [
    node('a1', 'A', 'theorem', 'transitively-verified'),
    node('a2', 'A', 'theorem', 'transitively-verified'),
    node('b1', 'B', 'def', 'verified'),
    node('b2', 'B', 'def', 'trusted'),
    node('b3', 'B', 'def', 'unverified'),
    node('b4', 'B', 'def', 'transitively-verified'),
    node('S', 'B', 'structure', 'transitively-verified'),
    node('t1', 'B', 'theorem', 'transitively-verified'),
  ];
  return graph(nodes, [
    { source: 'a1', target: 'b1', type: 'inner' },
    { source: 'a2', target: 'b1', type: 'inner' },
    { source: 'a1', target: 'S', type: 'inner' },
    { source: 'a2', target: 'S', type: 'inner' },
    { source: 'b1', target: 'S', type: 'inner' },
    { source: 'b2', target: 'S', type: 'inner' },
    { source: 'b1', target: 't1', type: 'inner' },
    { source: 'b2', target: 't1', type: 'inner' },
    { source: 'b4', target: 't1', type: 'inner' },
    { source: 'b1', target: 'b3', type: 'inner' },
  ]);
}

const notStructure = { isCandidate: (n: D3Node) => n.kind !== 'structure', isLinkShown: () => true };

function action(g: D3Graph, type: SuggestedAction['type'], vis = notStructure) {
  return buildGraphSummary(g, vis).suggestedQueries.find(q => q.action.type === type)?.action;
}

describe('crate boundary chip', () => {
  it('picks the directed pair with the most links, not the two largest groups', () => {
    const s = buildGraphSummary(fixture(), notStructure);
    expect(s.crates[0].name).toBe('B');
    expect(s.boundary).toEqual({ source: 'A', target: 'B', edgeCount: 2 });
    expect(action(fixture(), 'setCrateBoundary')).toEqual({ type: 'setCrateBoundary', source: 'A', target: 'B' });
  });

  it('counts only links between candidates, of shown link types', () => {
    const all = { isCandidate: () => true, isLinkShown: () => true };
    expect(buildGraphSummary(fixture(), all).boundary?.edgeCount).toBe(4);
    const noInner = { isCandidate: () => true, isLinkShown: (l: D3Link) => l.type !== 'inner' };
    expect(buildGraphSummary(fixture(), noInner).boundary).toBeNull();
  });

  it('skips the unknown fallback group', () => {
    const g = fixture();
    // u1..u3 in 'unknown' call b1: the busiest pair if counted
    for (const id of ['u1', 'u2', 'u3']) {
      g.nodes.push(node(id, 'unknown', 'def'));
      g.links.push({ source: id, target: 'b1', type: 'inner' });
    }
    expect(buildGraphSummary(g, notStructure).boundary).toEqual({ source: 'A', target: 'B', edgeCount: 2 });
  });
});

describe('most connected chip', () => {
  it('names only nodes the kind filters show', () => {
    expect(action(fixture(), 'setSink', { isCandidate: () => true, isLinkShown: () => true }))
      .toMatchObject({ id: 'S' });
    expect(action(fixture(), 'setSink')).toMatchObject({ id: 't1' });
  });
});

describe('blueprint layer text', () => {
  it('names entries and chapters', () => {
    const g = fixture();
    for (const n of g.nodes) n.language = 'blueprint';
    const s = buildGraphSummary(g, notStructure);
    expect(formatSummaryText(s)).toContain(`This is a blueprint with ${g.nodes.length} entries across 2 chapters.`);
    expect(formatSummaryText(s)).toContain('Top chapters:');
    expect(s.suggestedQueries.map(q => q.label)).toContain('Chapter boundary: A → B');
  });
});

describe('edge role note', () => {
  const all = { isCandidate: () => true, isLinkShown: () => true };
  const note = 'the Statement deps / Body/proof deps boxes do not change them';
  it('says rankings use the full relation while a role box is off', () => {
    expect(formatSummaryText(buildGraphSummary(fixture(), { ...all, roleFilterActive: true }))).toContain(note);
    expect(formatSummaryText(buildGraphSummary(fixture(), all))).not.toContain(note);
  });
});

describe('verification counts and chip', () => {
  it('counts each status separately, over the full graph', () => {
    // S is not a candidate but still counted
    const v = buildGraphSummary(fixture(), notStructure).verification;
    expect(v).toEqual({ verified: 1, transitivelyVerified: 5, trusted: 1, failed: 0, unverified: 1, unknown: 0 });
    expect(formatSummaryText(buildGraphSummary(fixture()))).toContain(
      'Verification: 5 transitively verified, 1 verified (locally only), 1 trusted, 1 unverified.');
  });

  it('selects transitively verified when the graph has it', () => {
    expect(action(fixture(), 'filterVerification')).toEqual({ type: 'filterVerification', statuses: ['transitively-verified'] });
  });

  it('falls back to verified for extracts without transitive status', () => {
    const g = fixture();
    for (const n of g.nodes) if (n.verification_status === 'transitively-verified') n.verification_status = 'verified';
    expect(action(g, 'filterVerification')).toEqual({ type: 'filterVerification', statuses: ['verified'] });
  });

  it('the transition selects exactly the chip statuses', () => {
    const t = guideTransition({ type: 'filterVerification', statuses: ['transitively-verified'] }, 'x');
    expect(t.status).toEqual(['transitively-verified']);
  });
});

describe('result toast', () => {
  const sink: SuggestedAction = { type: 'setSink', id: 'id:GF16', label: 'GF16' };

  it('reports the count and the query', () => {
    expect(resultMessage(sink, 'chip', { shown: 180, total: 180, missingAnchor: false, seeded: false, tooLarge: false }))
      .toBe('180 nodes: callers of GF16');
  });

  it('notes truncation by the render cap', () => {
    expect(resultMessage(sink, 'chip', { shown: 200, total: 950, missingAnchor: false, seeded: false, tooLarge: false }))
      .toBe('200 nodes: callers of GF16 (truncated from 950)');
  });

  it('names the entry points view on a large graph without a query', () => {
    const verified: SuggestedAction = { type: 'filterVerification', statuses: ['transitively-verified'] };
    expect(resultMessage(verified, 'chip', { shown: 419, total: 419, missingAnchor: false, seeded: true, tooLarge: false }))
      .toBe('419 nodes: transitively-verified only (entry points view)');
  });

  it('says when a large graph renders nothing without a query', () => {
    const verified: SuggestedAction = { type: 'filterVerification', statuses: ['verified'] };
    expect(resultMessage(verified, 'Show only verified', { shown: 0, total: 0, missingAnchor: false, seeded: false, tooLarge: true }))
      .toBe('Show only verified: the graph is too large to show without a query');
  });

  it('says when the filters hide the target', () => {
    expect(resultMessage(sink, 'chip', { shown: 0, total: 0, missingAnchor: true, seeded: false, tooLarge: false }))
      .toBe('GF16 is hidden by the current filters');
  });

  it('aggregated views only repeat the label', () => {
    expect(resultMessage({ type: 'switchView', view: 'crate-map' }, 'View map', null)).toBe('View map');
  });
});
