/**
 * Unit tests for the verification status filter (status-filter.ts) and its
 * use in the query pipeline.
 */

import { describe, it, expect } from 'vitest';
import {
  StatusFilter, compileStatusPredicate, exactStatusFilter, groupCheckState, withGroupChecked,
} from './status-filter';
import { defaultFilters } from './url-state';
import { focusIntent } from './intent';
import { applyFilters } from './filters';
import { compileSeededDisplayPredicate } from './query';
import { guideTransition } from './guide/guide-panel';
import { D3Graph, D3Node, VerificationStatus } from './types';

function node(id: string, status?: VerificationStatus): D3Node {
  return {
    id, display_name: id, symbol: id, full_path: `/p/${id}.lean`, relative_path: `${id}.lean`,
    file_name: `${id}.lean`, parent_folder: '', crate_name: 'm', is_libsignal: false,
    dependencies: [], dependents: [], kind: 'theorem', verification_status: status,
  };
}

const NODES = [
  node('v', 'verified'), node('tv', 'transitively-verified'), node('tr', 'trusted'),
  node('f', 'failed'), node('u', 'unverified'), node('none'),
];

function passing(f: StatusFilter): string[] {
  const p = compileStatusPredicate(f);
  return NODES.filter(n => !p || p(n)).map(n => n.id);
}

const ALL: StatusFilter = {
  showVerifiedNodes: true, showFailedNodes: true, showUnverifiedNodes: true, exactStatuses: null,
};

describe('status predicate', () => {
  it('no predicate when every group is shown', () => {
    expect(compileStatusPredicate(ALL)).toBeNull();
  });

  it('the Verified box covers verified, transitively verified and trusted', () => {
    expect(passing({ ...ALL, showFailedNodes: false, showUnverifiedNodes: false })).toEqual(['v', 'tv', 'tr']);
  });

  it('a node without a status counts as unverified', () => {
    expect(passing({ ...ALL, showVerifiedNodes: false, showFailedNodes: false })).toEqual(['u', 'none']);
  });

  it('an exact set overrides the boxes', () => {
    expect(passing(exactStatusFilter(['transitively-verified']))).toEqual(['tv']);
    expect(passing({ ...ALL, exactStatuses: ['trusted'] })).toEqual(['tr']);
  });
});

describe('checkbox state and edits', () => {
  it('a group partly in the exact set is partial', () => {
    const f = exactStatusFilter(['transitively-verified']);
    expect(groupCheckState(f, 'verified')).toBe('partial');
    expect(groupCheckState(f, 'failed')).toBe('off');
    expect(groupCheckState(exactStatusFilter(['verified', 'transitively-verified', 'trusted']), 'verified')).toBe('on');
  });

  it('checking another group keeps the exact selection of the rest', () => {
    const f = withGroupChecked(exactStatusFilter(['transitively-verified']), 'failed', true);
    expect(f.exactStatuses).toEqual(['transitively-verified', 'failed']);
    expect(passing(f)).toEqual(['tv', 'f']);
  });

  it('an edit that leaves only whole groups drops the exact set', () => {
    const checked = withGroupChecked(exactStatusFilter(['transitively-verified']), 'verified', true);
    expect(checked.exactStatuses).toBeNull();
    expect(passing(checked)).toEqual(['v', 'tv', 'tr']);
    const unchecked = withGroupChecked(exactStatusFilter(['transitively-verified', 'failed']), 'verified', false);
    expect(unchecked.exactStatuses).toBeNull();
    expect(passing(unchecked)).toEqual(['f']);
  });

  it('without an exact set an edit only flips the box', () => {
    expect(withGroupChecked(ALL, 'failed', false)).toEqual({ ...ALL, showFailedNodes: false });
  });
});

describe('exact status set in the pipeline', () => {
  const graph: D3Graph = {
    nodes: NODES,
    links: [],
    metadata: { total_nodes: NODES.length, total_edges: 0, project_root: '/t', generated_at: '' },
  };
  // A focus set keeps its nodes without links
  const filters = () => ({
    ...defaultFilters(),
    intent: focusIntent('f.json', NODES.map(n => n.id), 'all'),
    ...exactStatusFilter(['transitively-verified']),
  });

  it('query results and the seeded predicate apply the same exact set', () => {
    expect(applyFilters(graph, filters(), 'lean').nodes.map(n => n.id)).toEqual(['tv']);
    const seeded = compileSeededDisplayPredicate(filters(), 'lean');
    expect(NODES.filter(seeded).map(n => n.id)).toEqual(['tv']);
  });

  it('the Guide chip keeps a matching node whose links the filter removed', () => {
    // v calls tr; selecting only verified drops tr and the link, not v
    const v = { ...node('v', 'verified'), dependencies: ['tr'] };
    const tr = { ...node('tr', 'trusted'), dependents: ['v'] };
    const g: D3Graph = {
      nodes: [v, tr],
      links: [{ source: 'v', target: 'tr', type: 'inner' }],
      metadata: { total_nodes: 2, total_edges: 1, project_root: '/t', generated_at: '' },
    };
    const t = guideTransition({ type: 'filterVerification', statuses: ['verified'] }, 'x');
    const f = { ...defaultFilters(), intent: t.intent, ...exactStatusFilter(t.status!) };
    expect(applyFilters(g, f, 'lean').nodes.map(n => n.id)).toEqual(['v']);
  });
});
