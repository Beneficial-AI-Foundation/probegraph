/**
 * Unit tests for the Packed Map pure helpers (packed-map.ts): the `exec`
 * rule, the graph restriction, connectivity, the pack input tree, the
 * camera fit, the label rules, the edges and the keyboard order.
 */

import { describe, it, expect } from 'vitest';
import {
  isPackedMapNode, hasPackedMapNodes, restrictToPackedNodes, connectivity, buildPackData, PackDatum,
  fitCamera, visibleGroupLabels, fitLabel, edgesOf, nextFocusIndex, edgeCurve, edgeBends,
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

describe('fitCamera', () => {
  it('centers the circle and fits its diameter to the short side, less the margin', () => {
    const c = fitCamera(100, 50, 20, 800, 400, 0.05);
    expect(c.k).toBeCloseTo(360 / 40);
    expect(100 * c.k + c.x).toBeCloseTo(400);
    expect(50 * c.k + c.y).toBeCloseTo(200);
  });

  it('a zero radius gives scale 1', () => {
    expect(fitCamera(10, 10, 0, 100, 100).k).toBe(1);
  });
});

describe('visibleGroupLabels', () => {
  const groups = [
    { id: 'crate', r: 100, childIds: ['dir', 'small'] },
    { id: 'dir', r: 40, childIds: ['file'] },
    { id: 'file', r: 10, childIds: [] },
    { id: 'small', r: 5, childIds: [] },
  ];

  it('labels a large group with no large child group', () => {
    expect([...visibleGroupLabels(groups, 0.5, 30)]).toEqual(['crate']);
  });

  it('hides the parent label when a child label shows', () => {
    expect([...visibleGroupLabels(groups, 1, 30)]).toEqual(['dir']);
    expect([...visibleGroupLabels(groups, 4, 30)].sort()).toEqual(['file']);
  });

  it('a small sibling does not hide the parent', () => {
    expect(visibleGroupLabels([groups[0], groups[3]], 1, 30)).toEqual(new Set(['crate']));
  });

  it('no label below the threshold', () => {
    expect(visibleGroupLabels(groups, 0.1, 30).size).toBe(0);
  });
});

describe('fitLabel', () => {
  it('keeps a name that fits', () => {
    expect(fitLabel('abc', 100, 10)).toBe('abc');
  });

  it('cuts a long name and ends it with an ellipsis', () => {
    // 10 px font: 6 px per character, 30 px holds 5
    expect(fitLabel('abcdefgh', 30, 10)).toBe('abcd…');
  });

  it('gives nothing when one character and the ellipsis do not fit', () => {
    expect(fitLabel('abcdefgh', 8, 10)).toBe('');
  });
});

describe('edgesOf', () => {
  const links = [
    { source: 'a', target: 'b', type: 'inner' },
    { source: 'a', target: 'b', type: 'inner' },
    { source: 'a', target: 'b', type: 'precondition' },
    { source: 'c', target: 'a', type: 'inner' },
    { source: 'a', target: 'a', type: 'inner' },
    { source: 'a', target: 'gone', type: 'inner' },
    { source: 'b', target: 'c', type: 'inner' },
  ];

  it('keeps the calls to and from the function, one per type, among drawn functions', () => {
    expect(edgesOf(links, 'a', new Set(['a', 'b', 'c']))).toEqual([
      { source: 'a', target: 'b', type: 'inner' },
      { source: 'a', target: 'b', type: 'precondition' },
      { source: 'c', target: 'a', type: 'inner' },
    ]);
  });

  it('accepts resolved node endpoints', () => {
    const a = node('a', 'k', 'k/src/x.rs');
    const b = node('b', 'k', 'k/src/x.rs');
    expect(edgesOf([{ source: a, target: b, type: 'inner' }], 'b', new Set(['a', 'b'])))
      .toEqual([{ source: 'a', target: 'b', type: 'inner' }]);
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

describe('edgeCurve', () => {
  const at = (c: NonNullable<ReturnType<typeof edgeCurve>>, t: number) => {
    const u = 1 - t;
    return [u * u * c.sx + 2 * u * t * c.cx + t * t * c.tx, u * u * c.sy + 2 * u * t * c.cy + t * t * c.ty];
  };

  it('starts and ends on the circle boundaries, also for close circles', () => {
    // Copilot's example: radius 40, centers 85 px apart
    const a = { x: 0, y: 0, r: 40 };
    const b = { x: 85, y: 0, r: 40 };
    const c = edgeCurve(a, b, 0.2)!;
    expect(Math.hypot(c.sx - a.x, c.sy - a.y)).toBeCloseTo(40, 3);
    expect(Math.hypot(c.tx - b.x, c.ty - b.y)).toBeCloseTo(40, 3);
    // No point of the cut curve is inside either circle
    for (let t = 0.05; t < 1; t += 0.05) {
      const [x, y] = at(c, t);
      expect(Math.hypot(x - a.x, y - a.y)).toBeGreaterThan(40 - 1e-6);
      expect(Math.hypot(x - b.x, y - b.y)).toBeGreaterThan(40 - 1e-6);
    }
  });

  it('a larger bend gives a different curve', () => {
    const a = { x: 0, y: 0, r: 5 };
    const b = { x: 100, y: 0, r: 5 };
    const c1 = edgeCurve(a, b, 0.2)!;
    const c2 = edgeCurve(a, b, 0.35)!;
    expect(Math.abs(at(c1, 0.5)[1] - at(c2, 0.5)[1])).toBeGreaterThan(5);
  });

  it('null when the circles touch along the whole curve', () => {
    expect(edgeCurve({ x: 0, y: 0, r: 10 }, { x: 5, y: 0, r: 10 }, 0.2)).toBeNull();
  });
});

describe('edgeBends', () => {
  it('gives each call type between the same two functions its own bend', () => {
    expect(edgeBends([
      { source: 'a', target: 'b', type: 'inner' },
      { source: 'a', target: 'b', type: 'precondition' },
      { source: 'b', target: 'a', type: 'inner' },
      { source: 'c', target: 'a', type: 'inner' },
    ], 0.2, 0.15)).toEqual([0.2, 0.35, 0.2, 0.2]);
  });
});
