/**
 * Unit tests for witness edges (witness.ts): the fixed order of the links
 * behind an aggregated edge, the tooltip text and the details panel. Also
 * checks that the two aggregations (buildCrateGraph, computeCut) keep every
 * link, so the count and the list agree.
 */

import { describe, it, expect } from 'vitest';
import {
  WITNESS_LIST_CAP, WITNESS_TOOLTIP_CAP, WitnessCall,
  TWO_WAY_SHIFT, callCountText, sortWitnesses, twoWayShift, witnessNameOf, witnessPanelHtml, witnessTooltip, witnessTypeLabel, witnessesOf,
} from './witness';
import { buildCrateGraph } from './crate-map';
import { buildHierarchyTree, computeCut } from './hierarchy';
import { D3Graph, D3Link, D3Node } from './types';

function node(id: string, crate: string, displayName = id): D3Node {
  return {
    id,
    display_name: displayName,
    symbol: id,
    full_path: `/repo/${crate}/src/lib.rs`,
    relative_path: `${crate}/src/lib.rs`,
    file_name: 'lib.rs',
    parent_folder: '',
    crate_name: crate,
    is_libsignal: true,
    dependencies: [],
    dependents: [],
    kind: 'exec',
  };
}

function graph(nodes: D3Node[], links: Array<[string, string, string?]>): D3Graph {
  const d3links: D3Link[] = links.map(([source, target, type]) => ({ source, target, type: type || 'inner' }));
  return { nodes, links: d3links, metadata: { total_nodes: nodes.length, total_edges: d3links.length } } as D3Graph;
}

const call = (sourceId: string, targetId: string, type = 'inner'): WitnessCall => ({ sourceId, targetId, type });
const self = (id: string) => id;
/** Visible text, each tag read as a space. */
const text = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

describe('sortWitnesses', () => {
  it('orders by caller name, then callee name', () => {
    const calls = [call('b', 'x'), call('a', 'z'), call('a', 'y')];
    expect(sortWitnesses(calls, self).map(c => `${c.sourceId}>${c.targetId}`)).toEqual(['a>y', 'a>z', 'b>x']);
  });

  it('gives the same order for every order of the input', () => {
    const calls = [call('b', 'x'), call('a', 'z'), call('a', 'y', 'precondition'), call('a', 'y')];
    const expected = sortWitnesses(calls, self);
    expect(sortWitnesses([...calls].reverse(), self)).toEqual(expected);
    expect(sortWitnesses([calls[2], calls[0], calls[3], calls[1]], self)).toEqual(expected);
  });

  it('breaks a tie between equal names by id, then by type', () => {
    const nameOf = () => 'new';
    const calls = [call('m2::new', 't'), call('m1::new', 't', 'precondition'), call('m1::new', 't', 'inner')];
    expect(sortWitnesses(calls, nameOf)).toEqual([
      call('m1::new', 't', 'inner'), call('m1::new', 't', 'precondition'), call('m2::new', 't'),
    ]);
  });

  it('does not change its input', () => {
    const calls = [call('b', 'x'), call('a', 'y')];
    sortWitnesses(calls, self);
    expect(calls[0].sourceId).toBe('b');
  });
});

describe('witnessesOf', () => {
  it('merges the links of one caller and callee into one witness', () => {
    const calls = [call('b', 'x'), call('a', 'y', 'precondition'), call('a', 'y'), call('a', 'y')];
    expect(witnessesOf(calls, self)).toEqual([
      { sourceId: 'a', targetId: 'y', types: ['inner', 'precondition'] },
      { sourceId: 'b', targetId: 'x', types: ['inner'] },
    ]);
  });

  it('counts an empty type as a body call', () => {
    const calls = [call('a', 'y', ''), call('a', 'y', 'spec')];
    expect(witnessesOf(calls, self)).toEqual([{ sourceId: 'a', targetId: 'y', types: ['inner', 'spec'] }]);
    expect(witnessTooltip('A', 'B', calls, self)).toContain('a → y (call, spec)');
  });

  it('counts the legacy type "calls" as a body call', () => {
    const calls = [call('a', 'y', 'calls'), call('a', 'y'), call('b', 'x', 'calls')];
    expect(witnessesOf(calls, self)).toEqual([
      { sourceId: 'a', targetId: 'y', types: ['inner'] },
      { sourceId: 'b', targetId: 'x', types: ['inner'] },
    ]);
    expect(witnessTooltip('A', 'B', calls, self).split('\n').slice(1, 3)).toEqual(['a → y', 'b → x']);
  });

  it('names the link types, except for body calls only', () => {
    expect(witnessTypeLabel(['inner'])).toBe('');
    expect(witnessTypeLabel(['precondition'])).toBe('requires');
    expect(witnessTypeLabel(['inner', 'spec'])).toBe('call, spec');
    expect(witnessTypeLabel(['mapping', 'postcondition'])).toBe('mapping, ensures');
    // A type with no label stands for itself, also a name that Object has
    expect(witnessTypeLabel(['constructor'])).toBe('constructor');
  });
});

describe('witnessNameOf', () => {
  it('uses the display name, and the id when the node is missing', () => {
    const nameOf = witnessNameOf(new Map([['a::f', node('a::f', 'a', 'f')]]));
    expect(nameOf('a::f')).toBe('f');
    expect(nameOf('gone')).toBe('gone');
  });
});

describe('witnessTooltip', () => {
  it('shows the count and the first witnesses', () => {
    const calls = [call('d', 'w'), call('c', 'x'), call('b', 'y', 'precondition'), call('a', 'z'), call('a', 'z', 'spec')];
    expect(witnessTooltip('A', 'B', calls, self).split('\n')).toEqual([
      'A → B: 5 calls',
      'a → z (call, spec)',
      'b → y (requires)',
      'c → x',
      `and ${4 - WITNESS_TOOLTIP_CAP} more`,
      'Click for the list',
    ]);
  });

  it('uses the singular and no "more" line for one call', () => {
    expect(callCountText(1)).toBe('1 call');
    expect(witnessTooltip('A', 'B', [call('a', 'z')], self).split('\n'))
      .toEqual(['A → B: 1 call', 'a → z', 'Click for the list']);
  });
});

describe('witnessPanelHtml', () => {
  const many = Array.from({ length: WITNESS_LIST_CAP + 5 }, (_, i) =>
    call(`f${String(i).padStart(2, '0')}`, 'g'));

  it('lists caller and callee as links to the two nodes', () => {
    const html = witnessPanelHtml('A', 'B', [call('a::f', 'b::g', 'postcondition')], self);
    expect(text(html)).toContain('A → B');
    expect(text(html)).toContain('1 call behind this edge');
    expect(text(html)).toContain('a::f → b::g (ensures)');
    expect(html).toContain('class="witness-node" data-node-id="a::f"');
    expect(html).toContain('class="witness-node" data-node-id="b::g"');
    expect(html).not.toContain('witness-show-all');
  });

  it('caps the list and offers the rest', () => {
    const html = witnessPanelHtml('A', 'B', many, self);
    expect(html.match(/<li>/g)).toHaveLength(WITNESS_LIST_CAP);
    expect(text(html)).toContain(`${many.length} calls behind this edge`);
    expect(text(html)).toContain(`Show all ${many.length}`);
    expect(html).toContain('data-node-id="f00"');
    expect(html).not.toContain(`data-node-id="f${WITNESS_LIST_CAP}"`);
  });

  it('counts the links and the pairs when they differ', () => {
    const html = witnessPanelHtml('A', 'B', [call('a', 'z'), call('a', 'z', 'precondition'), call('b', 'z')], self);
    expect(text(html)).toContain('3 calls behind this edge, between 2 pairs of functions');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(text(html)).toContain('a → z (call, requires)');
  });

  it('lists every witness with no cap', () => {
    const html = witnessPanelHtml('A', 'B', many, self, Infinity);
    expect(html.match(/<li>/g)).toHaveLength(many.length);
    expect(html).not.toContain('witness-show-all');
  });

  it('escapes names and ids', () => {
    const html = witnessPanelHtml('<A>', 'B', [call('a"<x>', 'g')], self);
    expect(html).toContain('&lt;A&gt;');
    expect(html).toContain('data-node-id="a&quot;&lt;x&gt;"');
    expect(html).not.toContain('<x>');
  });

  it('escapes a link type from the graph file', () => {
    const html = witnessPanelHtml('A', 'B', [call('a', 'g', '<img src=x onerror=alert(1)>')], self);
    expect(html).toContain('<em>(&lt;img src=x onerror=alert(1)&gt;)</em>');
    expect(html).not.toContain('<img');
  });
});

describe('twoWayShift', () => {
  it('moves the two directions of a two-way edge to opposite sides', () => {
    const shiftOf = twoWayShift([
      { source: 'a', target: 'b' }, { source: 'b', target: 'a' }, { source: 'a', target: 'c' },
    ]);
    expect(shiftOf('a', 'b')).toBe(-TWO_WAY_SHIFT);
    expect(shiftOf('b', 'a')).toBe(TWO_WAY_SHIFT);
    expect(shiftOf('a', 'c')).toBe(0);
  });
});

describe('aggregated edges keep their witnesses', () => {
  const nodes = [node('a::f', 'a'), node('a::g', 'a'), node('b::h', 'b'), node('b::k', 'b')];
  const links: Array<[string, string, string?]> = [
    ['a::g', 'b::k'], ['a::f', 'b::h'], ['a::f', 'b::h', 'precondition'], ['a::f', 'a::g'], ['b::h', 'a::g'],
  ];

  it('Crate Map: one edge per crate pair with every link between the two', () => {
    const cg = buildCrateGraph(graph(nodes, links));
    const edge = cg.edges.find(e => e.source === 'a' && e.target === 'b')!;
    expect(edge.callCount).toBe(3);
    expect(edge.calls).toHaveLength(edge.callCount);
    expect(sortWitnesses(edge.calls, self)[0]).toEqual(call('a::f', 'b::h', 'inner'));
    // The same first witness when the graph lists its links in another order
    const reversed = buildCrateGraph(graph(nodes, [...links].reverse()));
    const again = reversed.edges.find(e => e.source === 'a' && e.target === 'b')!;
    expect(sortWitnesses(again.calls, self)).toEqual(sortWitnesses(edge.calls, self));
  });

  it('Hierarchy: one edge per pair of collapsed groups with every link between the two', () => {
    const g = graph(nodes, links);
    const cut = computeCut(buildHierarchyTree(g), g, new Set());
    const edge = cut.edges.find(e => e.source === 'a' && e.target === 'b')!;
    expect(edge.callCount).toBe(3);
    expect(edge.calls).toHaveLength(edge.callCount);
    expect(sortWitnesses(edge.calls, self).map(c => `${c.sourceId}>${c.targetId}:${c.type}`))
      .toEqual(['a::f>b::h:inner', 'a::f>b::h:precondition', 'a::g>b::k:inner']);
  });
});
