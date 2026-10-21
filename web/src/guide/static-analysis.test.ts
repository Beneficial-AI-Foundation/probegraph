/**
 * Unit tests for the Guide's static analysis and result toast.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGraphSummary, formatSummaryText, idDifferences } from './static-analysis';
import {
  MAX_LEVEL_ROWS, frontierDescription, guideTransition, levelRows, levelShares, resultMessage, trustGroupCounts,
  trustGroupLabel, workGroupLabel,
} from './guide-panel';
import { convertAtomDictToD3Graph } from '../graph-loader';
import type { ProbeAtom } from '../types';
import type { FrontierList, SuggestedAction } from './types';
import { D3Graph, D3Link, D3Node, VerificationStatus } from '../types';
import { MAX_REACHABILITY_COMPONENTS, graphReachability, rankByTransitiveDependents } from '../reachability';

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

describe('search box chips and list queries', () => {
  const all = { isCandidate: () => true, isLinkShown: () => true };

  it('gives each ranked list its top query', () => {
    const s = buildGraphSummary(fixture(), all);
    expect([s.unfinished.query, s.assumptions.query, s.keystones.query]).toEqual([
      'top 5 by dependents is:unfinished', 'top 5 by dependents is:assumption', 'top 5 by dependents kind:lemma',
    ]);
    const noLemmas = graph([node('d', 'A', 'def')], []);
    expect(buildGraphSummary(noLemmas, all).keystones.query).toBe('top 5 by dependents');
  });

  it('adds an unused chip with its count, and no surface chip without public API data', () => {
    const chips = buildGraphSummary(fixture(), all).suggestedQueries.filter(q => q.action.type === 'fillSearch');
    // a1, a2, b2 and b4 have no callers
    expect(chips.map(q => [q.label, q.action])).toEqual([
      ['Unused declarations (4)', { type: 'fillSearch', query: 'is:unused' }],
    ]);
  });
});

describe('ranked lists', () => {
  const all = { isCandidate: () => true, isLinkShown: () => true };
  const rows = (list: { rows: { id: string; transitiveDependentCount: number }[] }) =>
    list.rows.map(r => [r.id, r.transitiveDependentCount]);

  it('ranks by unique transitive dependents, not direct callers', () => {
    // b3 has one direct caller (b1) but three transitive dependents
    const s = buildGraphSummary(fixture(), all);
    expect(rows(s.unfinished)).toEqual([['b3', 3]]);
    expect(rows(s.keystones)).toEqual([['t1', 5], ['a1', 0], ['a2', 0]]);
    expect(s.keystonesAreLemmas).toBe(true);
  });

  it('lists axioms and trusted nodes as assumptions, never as unfinished', () => {
    const g = fixture();
    // An axiom with an unfinished status is still an assumption
    g.nodes.push(node('ax', 'B', 'axiom', 'unverified'));
    g.links.push({ source: 'b3', target: 'ax', type: 'inner' });
    g.nodes.find(n => n.id === 'b3')!.dependencies.push('ax');
    g.nodes.find(n => n.id === 'ax')!.dependents.push('b3');
    const s = buildGraphSummary(g, all);
    expect(rows(s.assumptions)).toEqual([['ax', 4], ['b2', 0]]);
    expect(rows(s.unfinished)).toEqual([['b3', 3]]);
  });

  it('counts failed nodes as unfinished', () => {
    const g = fixture();
    g.nodes.find(n => n.id === 'b1')!.verification_status = 'failed';
    expect(rows(buildGraphSummary(g, all).unfinished)).toEqual([['b3', 3], ['b1', 2]]);
  });

  it('kind filters restrict the rows, not the counts', () => {
    // Hiding defs drops b3 from the rows but t1 still counts its def callers
    const noDefs = { isCandidate: (n: D3Node) => n.kind !== 'def', isLinkShown: () => true };
    const s = buildGraphSummary(fixture(), noDefs);
    expect(s.unfinished).toEqual({ rows: [], total: 0, query: 'top 5 by dependents is:unfinished' });
    expect(rows(s.keystones)[0]).toEqual(['t1', 5]);
  });

  it('keeps the top rows and reports the total', () => {
    const g = fixture();
    for (const id of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']) g.nodes.push(node(id, 'B', 'def', 'unverified'));
    const s = buildGraphSummary(g, all);
    expect(s.unfinished.total).toBe(7);
    expect(s.unfinished.rows.map(r => r.id)).toEqual(['b3', 'u1', 'u2', 'u3', 'u4']);
  });

  it('ranks every node on graphs without proof kinds', () => {
    const g = fixture();
    for (const n of g.nodes) { n.kind = 'exec'; n.language = 'rust'; }
    const s = buildGraphSummary(g, all);
    expect(s.keystonesAreLemmas).toBe(false);
    expect(rows(s.keystones).slice(0, 2)).toEqual([['t1', 5], ['S', 4]]);
  });

  it('shows module context for rows that share a name', () => {
    const g = fixture();
    g.nodes.find(n => n.id === 'a1')!.display_name = 'same';
    g.nodes.find(n => n.id === 'a2')!.display_name = 'same';
    const s = buildGraphSummary(g, all);
    expect(s.keystones.rows.map(r => r.context)).toEqual([undefined, 'A/a1.lean', 'A/a2.lean']);
  });
});

describe('dependency levels strip', () => {
  it('counts nodes and statuses per topological level', () => {
    const s = buildGraphSummary(fixture(), notStructure);
    expect(s.levels).toEqual([
      { level: 0, nodes: 3, verified: 0, transitivelyVerified: 2, trusted: 0 },  // S, t1, b3
      { level: 1, nodes: 3, verified: 1, transitivelyVerified: 1, trusted: 1 },  // b1, b2, b4
      { level: 2, nodes: 2, verified: 0, transitivelyVerified: 2, trusted: 0 },  // a1, a2
    ]);
    expect(levelShares(s.levels[1])).toBe('33% transitively verified, 33% verified, 33% trusted');
    expect(levelShares(s.levels[0])).toBe('67% transitively verified');
  });

  it('puts a cycle on one level', () => {
    const g = fixture();
    // b3 -> a1 closes a1 -> b1 -> b3 -> a1
    g.links.push({ source: 'b3', target: 'a1', type: 'inner' });
    g.nodes.find(n => n.id === 'b3')!.dependencies.push('a1');
    g.nodes.find(n => n.id === 'a1')!.dependents.push('b3');
    const s = buildGraphSummary(g);
    // L0: S, t1. L1: the cycle {a1, b1, b3}, b2, b4. L2: a2
    expect(s.levels.map(l => l.nodes)).toEqual([2, 5, 1]);
    expect(levelRows(s.levels).map(r => r.label)).toEqual(['L0', 'L1', 'L2']);
  });

  it('folds the levels beyond MAX_LEVEL_ROWS into the last row', () => {
    // A chain of MAX_LEVEL_ROWS + 10 nodes, every other one verified
    const n = MAX_LEVEL_ROWS + 10;
    const nodes = Array.from({ length: n }, (_, i) => node(`n${String(i).padStart(3, '0')}`, 'A', 'theorem',
      i % 2 === 0 ? 'verified' : 'unverified'));
    const links: D3Link[] = [];
    for (let i = 0; i + 1 < n; i++) links.push({ source: nodes[i].id, target: nodes[i + 1].id, type: 'inner' });
    const rows = levelRows(buildGraphSummary(graph(nodes, links)).levels);
    expect(rows.length).toBe(MAX_LEVEL_ROWS);
    const last = rows[rows.length - 1];
    expect(last.label).toBe(`L${MAX_LEVEL_ROWS - 1}+`);
    expect(last.range).toBe(`Levels ${MAX_LEVEL_ROWS - 1} to ${n - 1}`);
    expect([last.stat.nodes, last.stat.verified]).toEqual([11, 6]);
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

  it('reports the omitted count when the render cap applies', () => {
    expect(resultMessage(sink, 'chip', { shown: 200, total: 950, missingAnchor: false, seeded: false, tooLarge: false }))
      .toBe('200 nodes: callers of GF16 (750 of 950 not shown)');
  });

  it('says when only the first targets fit the render cap', () => {
    const r = { shown: 200, total: 950, anchorsShown: 200, anchorsTotal: 340, missingAnchor: false, seeded: false, tooLarge: false };
    expect(resultMessage(sink, 'chip', r)).toBe('200 nodes: callers of GF16 (750 of 950 not shown, first 200 of 340 targets)');
  });

  it('says when display filters removed nodes', () => {
    const r = { shown: 12, total: 12, displayRemoved: 3, missingAnchor: false, seeded: false, tooLarge: false };
    expect(resultMessage(sink, 'chip', r)).toBe('12 nodes: callers of GF16 (3 removed by display filters)');
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

describe('component limit', () => {
  it('skips the ranked lists above MAX_REACHABILITY_COMPONENTS but keeps the levels', () => {
    const nodes = Array.from({ length: MAX_REACHABILITY_COMPONENTS + 1 }, (_, i) => node(`n${i}`, 'A', 'theorem'));
    const g = graph(nodes, []);
    expect(graphReachability(g)).toBeNull();
    expect(rankByTransitiveDependents(g, () => true, 5)).toBeNull();
    const s = buildGraphSummary(g);
    expect(s.rankingsSkipped).toEqual({ components: MAX_REACHABILITY_COMPONENTS + 1, links: 0 });
    expect(s.keystones.rows).toEqual([]);
    expect(s.levels.map(l => l.nodes)).toEqual([MAX_REACHABILITY_COMPONENTS + 1]);
  });

  it('computes the ranked lists below the limit', () => {
    const nodes = Array.from({ length: 3 }, (_, i) => node(`n${i}`, 'A', 'theorem'));
    expect(buildGraphSummary(graph(nodes, [])).rankingsSkipped).toBeNull();
  });
});

describe('shared trust bases', () => {
  const atom = (over: Partial<ProbeAtom>): ProbeAtom => ({
    "display-name": 'x', dependencies: [], "code-text": null, "code-path": 'X.lean',
    "code-module": 'X', kind: 'theorem', language: 'lean', ...over,
  });
  // t1 and t2 rest on ax and u; t3 on ax only; d is a def on ax
  const g = convertAtomDictToD3Graph({
    t1: atom({ "display-name": 'T1', dependencies: ['u'], "verification-status": 'verified' }),
    t2: atom({ "display-name": 'T2', dependencies: ['u'], "verification-status": 'verified' }),
    t3: atom({ "display-name": 'T3', dependencies: ['ax'], "verification-status": 'transitively-verified' }),
    d: atom({ "display-name": 'D', kind: 'def', dependencies: ['ax'], "verification-status": 'transitively-verified' }),
    u: atom({ "display-name": 'U', kind: 'def', dependencies: ['ax'], "verification-status": 'unverified' }),
    ax: atom({ "display-name": 'AX', kind: 'axiom', "verification-status": 'trusted', "trusted-reason": 'axiom' }),
  });
  const all = { isCandidate: () => true, isLinkShown: () => true };

  it('lists the largest groups first, with the base counts and names', () => {
    expect(buildGraphSummary(g, all).trustGroups).toEqual({
      rows: [
        { theorems: ['t1', 't2'], base: ['ax', 'u'], assumptions: 1, unfinished: 1, unknown: 0, baseNames: ['U', 'AX'] },
        { theorems: ['t3'], base: ['ax'], assumptions: 1, unfinished: 0, unknown: 0, baseNames: ['AX'] },
      ],
      total: 2,
      all: 2,
    });
  });

  it('follows the kind filters, but counts every theorem', () => {
    const noT3 = { ...all, isCandidate: (n: D3Node) => n.id !== 't3' };
    const s = buildGraphSummary(g, noT3).trustGroups!;
    expect(s.rows.map(r => r.theorems)).toEqual([['t1', 't2']]);
    expect([s.total, s.all]).toEqual([1, 2]);
    const none = buildGraphSummary(g, { ...all, isCandidate: () => false }).trustGroups!;
    expect([none.rows.length, none.all]).toEqual([0, 2]);
  });

  it('is left out without verification data', () => {
    const plain = convertAtomDictToD3Graph({ a: atom({ dependencies: ['b'] }), b: atom({}) });
    expect(buildGraphSummary(plain, all).trustGroups).toBeNull();
  });

  it('draws the group as an exact set in the Call Graph', () => {
    const action: SuggestedAction = {
      type: 'showTrustGroup', ids: ['ax', 'u', 't1', 't2'], theorems: 2, base: 2, allChains: true,
    };
    const t = guideTransition(action, trustGroupLabel(2));
    expect(t.intent).toEqual({
      kind: 'ids', ids: ['ax', 'u', 't1', 't2'], dir: 'none', label: '2 theorems on a shared trust base', origin: { type: 'guide' },
    });
    expect(t.view).toBe('callgraph');
    const r = { shown: 200, total: 340, anchorsShown: 200, anchorsTotal: 340, missingAnchor: false, seeded: false, tooLarge: false };
    expect(resultMessage(action, 'x', r))
      .toBe('200 nodes: 2 theorems, the 2 declarations they rest on and the chains between (140 of 340 not shown)');
  });

  it('names the group nodes the filters removed', () => {
    const action: SuggestedAction = { type: 'showTrustGroup', ids: ['ax', 't1', 't2'], theorems: 2, base: 1, allChains: true };
    const r = { shown: 2, total: 2, missingAnchor: false, seeded: false, tooLarge: false, displayRemoved: 0 };
    expect(resultMessage(action, 'x', r))
      .toBe('2 nodes: 2 theorems, the declaration they rest on and the chains between (1 removed by filters)');
  });

  it('names one theorem, one base member and cut chains in the toast', () => {
    const action: SuggestedAction = { type: 'showTrustGroup', ids: ['ax', 't3'], theorems: 1, base: 1, allChains: false };
    const r = { shown: 2, total: 2, missingAnchor: false, seeded: false, tooLarge: false };
    expect(resultMessage(action, 'x', r))
      .toBe('2 nodes: 1 theorem, the declaration it rests on and some of the chains between');
  });

  it('names the counts on a row', () => {
    expect(trustGroupCounts(1, 0, 0)).toBe('1 assumption, 0 unfinished');
    expect(trustGroupCounts(6, 2, 1)).toBe('6 assumptions, 2 unfinished, 1 untracked');
    expect(trustGroupLabel(1)).toBe('1 theorem on a shared trust base');
  });
});

describe('frontier list', () => {
  const FIXTURES: { name: string; data: Record<string, ProbeAtom> }[] = JSON.parse(
    readFileSync(resolve(__dirname, '../test-data/trust-frontier.json'), 'utf8'),
  );
  const fixture = (name: string) => convertAtomDictToD3Graph(FIXTURES.find(f => f.name === name)!.data);
  const all = { isCandidate: () => true, isLinkShown: () => true };

  it('lists the ready rows with their counts', () => {
    // low is ready; once it is done, mid is done and top becomes ready
    expect(buildGraphSummary(fixture('contaminated-intermediary'), all).frontier).toEqual({
      rows: [{ members: ['low'], names: ['low'], counts: { unblocks: 1, affected: 1, dependents: 2 } }],
      ready: 1, groups: 1, unblockNothing: 0, unfinished: 2, all: 1, counted: true,
    });
  });

  it('opens a single member as the Sink and a cycle as an exact set with its callers', () => {
    const one = buildGraphSummary(fixture('chain'), all).frontier!.rows[0];
    expect(one.members).toEqual(['low']);
    const cycle = buildGraphSummary(fixture('unfinished-scc'), all).frontier!;
    expect(cycle.rows.map(r => r.members)).toEqual([['u1', 'u2']]);
    expect(cycle.ready).toBe(2);
    const label = workGroupLabel(cycle.rows[0].names);
    expect(label).toBe('u1 and 1 more');
    const action: SuggestedAction = { type: 'showWorkGroup', ids: ['u1', 'u2'], label };
    expect(guideTransition(action, label).intent).toEqual({
      kind: 'ids', ids: ['u1', 'u2'], dir: 'callers', label, origin: { type: 'guide' },
    });
    const r = { shown: 3, total: 3, missingAnchor: false, seeded: false, tooLarge: false };
    expect(resultMessage(action, label, r)).toBe('3 nodes: callers of u1 and 1 more');
    expect(resultMessage(action, label, { ...r, shown: 0, total: 0, missingAnchor: true }))
      .toBe('u1 and 1 more are hidden by the current filters');
  });

  it('follows the kind filters, but counts the whole graph', () => {
    const f = buildGraphSummary(fixture('contaminated-intermediary'), { ...all, isCandidate: () => false }).frontier!;
    expect([f.rows.length, f.ready, f.groups, f.all]).toEqual([0, 0, 0, 1]);
  });

  it('knows when nothing is ready and when nothing is unfinished', () => {
    // u waits on the untracked x
    const blocked = buildGraphSummary(fixture('missing-and-unknown'), all).frontier!;
    expect([blocked.all, blocked.unfinished]).toEqual([0, 1]);
    const finished = convertAtomDictToD3Graph({
      a: { ...FIXTURES[0].data.top, dependencies: [], "verification-status": 'transitively-verified' },
    });
    expect(buildGraphSummary(finished, all).frontier).toMatchObject({ rows: [], unfinished: 0, all: 0 });
  });

  it('is left out without verification data, and replaces the hotspots sentence', () => {
    const atom = (over: Partial<ProbeAtom>): ProbeAtom => ({
      "display-name": 'x', dependencies: [], "code-text": null, "code-path": 'X.lean',
      "code-module": 'X', kind: 'theorem', language: 'lean', ...over,
    });
    const plain = convertAtomDictToD3Graph({ a: atom({ dependencies: ['b'] }), b: atom({}) });
    expect(buildGraphSummary(plain, all).frontier).toBeNull();
    expect(formatSummaryText(buildGraphSummary(fixture('chain'), all))).not.toContain('hotspots');
  });

  it('says how flat the ranking is, and when the rows have no counts', () => {
    const list: FrontierList = { rows: [], ready: 57, groups: 57, unblockNothing: 56, unfinished: 58, all: 57, counted: true };
    expect(frontierDescription(list)).toContain('56 of 57 would make nothing else ready yet.');
    expect(frontierDescription({ ...list, unblockNothing: 20 })).not.toContain('nothing else ready');
    expect(frontierDescription({ ...list, counted: false }))
      .toContain('In ID order: the graph is too large to count what each row unblocks.');
  });
});

describe('row context', () => {
  it('keeps the part of the IDs that differs, cut at separators', () => {
    expect(idDifferences(['p:a.HeaderSent.Insts.M', 'p:a.HeaderReceived.Insts.M', 'p:a.Keys.Insts.M']))
      .toEqual(['HeaderSent', 'HeaderReceived', 'Keys']);
    expect(idDifferences(['crate/m/f()', 'crate/n/f()'])).toEqual(['m', 'n']);
  });
});
