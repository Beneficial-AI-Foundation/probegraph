/**
 * Unit tests for the Packed Map data model (packed-map.ts): the `exec`
 * rule, the graph restriction, connectivity, the pack input tree and the
 * keyboard order.
 */

import { describe, it, expect } from 'vitest';
import * as d3 from 'd3';
import {
  isPackedMapNode, hasPackedMapNodes, restrictToPackedNodes, connectivity, buildPackData, nextFocusIndex, functionOrder,
  PackDatum,
} from './packed-map';
import { D3Graph, D3Node, D3Link } from './types';

function node(id: string, crate: string, relativePath: string, kind?: string): D3Node {
  return {
    id,
    display_name: id,
    symbol: id,
    full_path: `/repo/${relativePath}`,
    relative_path: relativePath,
    file_name: relativePath.split('/').pop() || '',
    parent_folder: '',
    crate_name: crate,
    is_libsignal: true,
    dependencies: [],
    dependents: [],
    kind: kind as string,
  };
}

function graph(nodes: D3Node[], links: Array<[string, string]>): D3Graph {
  const d3links: D3Link[] = links.map(([source, target]) => ({ source, target, type: 'inner' }));
  return {
    nodes,
    links: d3links,
    metadata: { total_nodes: nodes.length, total_edges: d3links.length, project_root: '/repo', generated_at: '' },
  };
}

function leaves(d: PackDatum): PackDatum[] {
  return d.kind === 'fn' ? [d] : (d.children ?? []).flatMap(leaves);
}

function find(d: PackDatum, id: string): PackDatum | undefined {
  if (d.id === id) return d;
  for (const c of d.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return undefined;
}

describe('isPackedMapNode', () => {
  it('keeps exec and nodes with no kind (older graphs)', () => {
    expect(isPackedMapNode(node('a', 'c', 'src/a.rs', 'exec'))).toBe(true);
    expect(isPackedMapNode(node('b', 'c', 'src/a.rs', undefined))).toBe(true);
    expect(isPackedMapNode(node('c', 'c', 'src/a.rs', ''))).toBe(true);
  });

  it('drops proofs, specs and Lean kinds', () => {
    expect(isPackedMapNode(node('a', 'c', 'src/a.rs', 'proof'))).toBe(false);
    expect(isPackedMapNode(node('b', 'c', 'src/a.rs', 'spec'))).toBe(false);
    expect(isPackedMapNode(node('c', 'c', 'A/B.lean', 'theorem'))).toBe(false);
  });

  it('hasPackedMapNodes is false for a graph with no Rust code', () => {
    expect(hasPackedMapNodes(graph([node('t', 'A', 'A/B.lean', 'theorem')], []))).toBe(false);
    expect(hasPackedMapNodes(graph([node('f', 'c', 'src/a.rs', 'exec')], []))).toBe(true);
    expect(hasPackedMapNodes(null)).toBe(false);
  });
});

describe('restrictToPackedNodes', () => {
  it('drops non-exec nodes and every link that touches them', () => {
    const g = graph(
      [node('f', 'c', 'src/a.rs', 'exec'), node('g', 'c', 'src/a.rs', 'exec'), node('p', 'c', 'src/a.rs', 'proof')],
      [['f', 'g'], ['f', 'p'], ['p', 'g']],
    );
    const r = restrictToPackedNodes(g);
    expect(r.nodes.map(n => n.id)).toEqual(['f', 'g']);
    expect(r.links).toHaveLength(1);
    expect(r.metadata).toBe(g.metadata);
  });

  it('returns the same graph when everything is exec', () => {
    const g = graph([node('f', 'c', 'src/a.rs', 'exec')], []);
    expect(restrictToPackedNodes(g)).toBe(g);
  });

  it('handles links whose endpoints are node objects', () => {
    const f = node('f', 'c', 'src/a.rs', 'exec');
    const p = node('p', 'c', 'src/a.rs', 'proof');
    const g: D3Graph = { ...graph([f, p], []), links: [{ source: f, target: p, type: 'inner' }] };
    expect(restrictToPackedNodes(g).links).toHaveLength(0);
  });
});

describe('connectivity', () => {
  it('counts distinct neighbors in both directions, ignoring self-calls', () => {
    const g = graph(
      [node('a', 'c', 'src/a.rs'), node('b', 'c', 'src/a.rs'), node('c', 'c', 'src/a.rs')],
      [['a', 'b'], ['b', 'a'], ['a', 'b'], ['a', 'a'], ['c', 'a']],
    );
    const deg = connectivity(g);
    expect(deg.get('a')).toBe(2);
    expect(deg.get('b')).toBe(1);
    expect(deg.get('c')).toBe(1);
  });

  it('ignores links to nodes outside the graph', () => {
    const g = graph([node('a', 'c', 'src/a.rs')], [['a', 'gone']]);
    expect(connectivity(g).get('a')).toBe(0);
  });
});

describe('buildPackData', () => {
  it('nests crate, directory, file and function, with prefixed ids', () => {
    const g = graph(
      [node('f', 'core', 'src/backend/field.rs'), node('g', 'core', 'src/backend/field.rs')],
      [['f', 'g']],
    );
    const root = buildPackData(g);
    expect(root.kind).toBe('root');
    expect(root.children!.map(c => c.id)).toEqual(['g:core']);
    const ids = leaves(root).map(l => l.id).sort();
    expect(ids).toEqual(['f:f', 'f:g']);
    expect(find(root, 'f:f')!.value).toBe(2);
  });

  it('keeps functions with no path directly under their crate', () => {
    const g = graph([node('f', 'core', 'src/a.rs'), node('loose', 'core', '')], []);
    const crate = buildPackData(g).children![0];
    expect(crate.children!.some(c => c.id === 'f:loose')).toBe(true);
    expect(leaves(crate)).toHaveLength(2);
  });

  it('gives groups no own value, so d3 sums leaves only', () => {
    const g = graph([node('f', 'core', 'src/a.rs'), node('g', 'core', 'src/b.rs')], [['f', 'g']]);
    const root = buildPackData(g);
    const groups: PackDatum[] = [];
    const walk = (d: PackDatum) => { if (d.kind !== 'fn') groups.push(d); d.children?.forEach(walk); };
    walk(root);
    expect(groups.every(d => d.value === 0)).toBe(true);
    expect(leaves(root).reduce((s, l) => s + l.value, 0)).toBe(4);
  });

  it('keeps a group id and a function id with the same text apart', () => {
    const g = graph([node('core', 'core', 'src/a.rs')], []);
    const root = buildPackData(g);
    expect(find(root, 'g:core')!.kind).toBe('crate');
    expect(find(root, 'f:core')!.kind).toBe('fn');
  });

  it('returns an empty root for an empty graph', () => {
    expect(buildPackData(graph([], [])).children).toEqual([]);
  });
});

describe('nextFocusIndex', () => {
  it('moves one step with the arrow keys and stops at both ends', () => {
    expect(nextFocusIndex(1, 'ArrowRight', 3)).toBe(2);
    expect(nextFocusIndex(1, 'ArrowDown', 3)).toBe(2);
    expect(nextFocusIndex(2, 'ArrowRight', 3)).toBe(2);
    expect(nextFocusIndex(1, 'ArrowLeft', 3)).toBe(0);
    expect(nextFocusIndex(1, 'ArrowUp', 3)).toBe(0);
    expect(nextFocusIndex(0, 'ArrowLeft', 3)).toBe(0);
  });

  it('jumps to the ends with Home and End', () => {
    expect(nextFocusIndex(1, 'Home', 3)).toBe(0);
    expect(nextFocusIndex(1, 'End', 3)).toBe(2);
  });

  it('ignores other keys and an empty map', () => {
    expect(nextFocusIndex(1, 'a', 3)).toBeNull();
    expect(nextFocusIndex(0, 'ArrowRight', 0)).toBeNull();
  });
});

describe('functionOrder', () => {
  it('lists the functions of one crate together, at any directory depth', () => {
    // A breadth-first order would put b1 (depth 2) between a1 and a2 (depth 3 and more)
    const g = graph([
      node('a1', 'a', 'src/x/y/deep.rs'),
      node('a2', 'a', 'src/top.rs'),
      node('b1', 'b', ''),
      node('b2', 'b', 'src/z/w/deep.rs'),
    ], []);
    const order = functionOrder(d3.hierarchy(buildPackData(g))).map(d => d.data.node!.crate_name);
    expect(order).toHaveLength(4);
    expect(order[0]).toBe(order[1]);
    expect(order[2]).toBe(order[3]);
    expect(order[0]).not.toBe(order[2]);
  });
});
