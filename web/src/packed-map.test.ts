/**
 * Unit tests for the Packed Map pure helpers (packed-map.ts): the candidate
 * rule, the graph restriction, connectivity, the pack input tree, the
 * camera fit, the label rules, the edges and the keyboard order. The Lean
 * tests (Phase 4) run the filter step on the synthetic fixture
 * test-data/probe-lean-packed-map.json, and the mixed tests (Phase 6) on
 * test-data/probe-aeneas-packed-map.json.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as d3 from 'd3';
import {
  isPackedMapCandidate, hasPackedMapNodes, restrictToPackedNodes, connectivity, buildPackData, PackDatum,
  fitCamera, visibleGroupLabels, fitLabel, edgesOf, nextFocusIndex, edgeCurve, edgeBends, functionOrder, zoomInTarget, minZoomScale,
  packedArcStatus, packedMapText, mixedEdgeType,
} from './packed-map';
import { D3Graph, D3Node, D3Link, FilterOptions, ProjectLanguage, detectProjectLanguage, extractCrateName } from './types';
import { parseAndNormalizeGraph } from './graph-loader';
import { applyFilters, ViewRestriction } from './filters';
import { defaultFilters } from './url-state';
import { textIntent } from './intent';

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

describe('isPackedMapCandidate', () => {
  it('Verus, mixed and unknown: keeps exec and nodes with no kind (older graphs)', () => {
    for (const lang of ['verus', 'mixed', 'unknown'] as ProjectLanguage[]) {
      expect(isPackedMapCandidate(node('a', 'c', 'src/a.rs', 'exec'), lang)).toBe(true);
      expect(isPackedMapCandidate(node('b', 'c', 'src/a.rs', undefined), lang)).toBe(true);
      expect(isPackedMapCandidate(node('c', 'c', 'src/a.rs', ''), lang)).toBe(true);
    }
  });

  it('Verus, mixed and unknown: drops proofs, specs and Lean kinds', () => {
    for (const lang of ['verus', 'mixed', 'unknown'] as ProjectLanguage[]) {
      expect(isPackedMapCandidate(node('a', 'c', 'src/a.rs', 'proof'), lang)).toBe(false);
      expect(isPackedMapCandidate(node('b', 'c', 'src/a.rs', 'spec'), lang)).toBe(false);
      expect(isPackedMapCandidate(node('c', 'c', 'A/B.lean', 'theorem'), lang)).toBe(false);
      expect(isPackedMapCandidate(node('d', 'c', 'A/B.lean', 'def'), lang)).toBe(false);
    }
  });

  it('Lean: every declaration without is_hidden, and a hidden one with a sorry', () => {
    const decl = (kind: string, hidden: boolean, status?: string): D3Node =>
      ({ ...node('x', 'A/B', 'A/B/C.lean', kind), is_hidden: hidden || undefined, verification_status: status as D3Node['verification_status'] });
    for (const kind of ['def', 'theorem', 'axiom', 'structure', 'projection', 'instance', 'abbrev', 'opaque']) {
      expect(isPackedMapCandidate(decl(kind, false), 'lean')).toBe(true);
      expect(isPackedMapCandidate(decl(kind, true, 'transitively-verified'), 'lean')).toBe(false);
      expect(isPackedMapCandidate(decl(kind, true, 'verified'), 'lean')).toBe(false);
      expect(isPackedMapCandidate(decl(kind, true, 'unverified'), 'lean')).toBe(true);
    }
  });

  it('blueprint: nothing', () => {
    expect(isPackedMapCandidate(node('a', 'c', 'blueprint/x', 'blueprint-theorem'), 'blueprint')).toBe(false);
    expect(isPackedMapCandidate(node('b', 'c', 'src/a.rs', 'exec'), 'blueprint')).toBe(false);
  });

  it('hasPackedMapNodes follows the language', () => {
    const lean = graph([node('t', 'A', 'A/B.lean', 'theorem')], []);
    expect(hasPackedMapNodes(lean, 'verus')).toBe(false);
    expect(hasPackedMapNodes(lean, 'lean')).toBe(true);
    expect(hasPackedMapNodes(lean, 'blueprint')).toBe(false);
    expect(hasPackedMapNodes(graph([node('f', 'c', 'src/a.rs', 'exec')], []), 'verus')).toBe(true);
    expect(hasPackedMapNodes(null, 'lean')).toBe(false);
  });
});

describe('restrictToPackedNodes', () => {
  it('drops non-exec nodes and every link that touches them', () => {
    const g = graph(
      [node('f', 'c', 'src/a.rs', 'exec'), node('g', 'c', 'src/a.rs', 'exec'), node('p', 'c', 'src/a.rs', 'proof')],
      [['f', 'g'], ['f', 'p'], ['p', 'g']],
    );
    const r = restrictToPackedNodes(g, 'verus');
    expect(r.nodes.map(n => n.id)).toEqual(['f', 'g']);
    expect(r.links).toHaveLength(1);
    expect(r.metadata).toBe(g.metadata);
  });

  it('returns the same graph when everything is exec', () => {
    const g = graph([node('f', 'c', 'src/a.rs', 'exec')], []);
    expect(restrictToPackedNodes(g, 'verus')).toBe(g);
  });

  it('handles links whose endpoints are node objects', () => {
    const f = node('f', 'c', 'src/a.rs', 'exec');
    const p = node('p', 'c', 'src/a.rs', 'proof');
    const g: D3Graph = { ...graph([f, p], []), links: [{ source: f, target: p, type: 'inner' }] };
    expect(restrictToPackedNodes(g, 'verus').links).toHaveLength(0);
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

describe('zoomInTarget', () => {
  const fn = ['core', 'core/src', 'core/src/a.rs'];

  it('from the whole project, the crate', () => {
    expect(zoomInTarget(fn, [])).toBe('core');
  });

  it('one level below the zoomed group, toward the function', () => {
    expect(zoomInTarget(fn, ['core'])).toBe('core/src');
    expect(zoomInTarget(fn, ['core', 'core/src'])).toBe('core/src/a.rs');
  });

  it('null at the function\'s own group', () => {
    expect(zoomInTarget(fn, fn)).toBeNull();
  });

  it('a zoomed group beside the function: the first group that contains the function', () => {
    expect(zoomInTarget(fn, ['core', 'core/tests'])).toBe('core/src');
    expect(zoomInTarget(fn, ['other'])).toBe('core');
  });

  it('a zoomed group below a function that sits on its crate: the crate', () => {
    expect(zoomInTarget(['core'], ['core', 'core/src'])).toBe('core');
  });
});

describe('minZoomScale', () => {
  it('0.5 before a layout', () => {
    expect(minZoomScale(800, 600, null)).toBe(0.5);
  });

  it('half the whole-pack fit, below any group fit after a shrink', () => {
    const layout = { width: 800, height: 600 };
    // 800 x 600 shrunk to 400 x 300: the whole pack fits at 0.5
    const min = minZoomScale(400, 300, layout);
    expect(min).toBeCloseTo(0.25);
    // Copilot's example: a radius-290 group fitted into 400 x 300
    expect(fitCamera(400, 300, 290, 400, 300).k).toBeGreaterThan(min);
  });
});

// ============================================================================
// Phase 4: pure Lean projects
// ============================================================================

/** Load a probe graph the way main.ts does: parse, then fill crate_name. */
function loadFixture(name: string): { graph: D3Graph; language: ProjectLanguage } {
  const graph = parseAndNormalizeGraph(JSON.parse(readFileSync(resolve(__dirname, 'test-data', name), 'utf8')));
  const language = detectProjectLanguage(graph);
  for (const n of graph.nodes) n.crate_name = extractCrateName(n, language);
  return { graph, language };
}

function packedView(language: ProjectLanguage): ViewRestriction {
  return { restrict: g => restrictToPackedNodes(g, language), inventory: true };
}

/** Ids of the nodes the Packed Map draws for `filters`, sorted, without the `probe:Demo.` prefix. */
function drawn(g: D3Graph, language: ProjectLanguage, filters: Partial<FilterOptions> = {}): string[] {
  const result = applyFilters(g, { ...defaultFilters(), ...filters }, language, packedView(language));
  return result.nodes.map(n => n.id.replace('probe:Demo.', '')).sort();
}

describe('Packed Map on a pure Lean graph (probe-lean-packed-map.json)', () => {
  const { graph: lean, language } = loadFixture('probe-lean-packed-map.json');

  it('detects a Lean graph and shows the button', () => {
    expect(language).toBe('lean');
    expect(hasPackedMapNodes(lean, language)).toBe(true);
  });

  it('default filters: every visible declaration, the hidden sorry, and the isolated definition', () => {
    expect(drawn(lean, language)).toEqual([
      'add', 'add_comm', 'choice', 'clean_skip', 'hidden_sorry', 'lonely', 'trust_bad', 'trusted_def', 'uses_sorry',
    ]);
  });

  it('Definitions off', () => {
    expect(drawn(lean, language, { showExecFunctions: false })).toEqual([
      'add_comm', 'choice', 'clean_skip', 'hidden_sorry', 'uses_sorry',
    ]);
  });

  it('Theorems off', () => {
    expect(drawn(lean, language, { showProofFunctions: false })).toEqual([
      'add', 'choice', 'lonely', 'trust_bad', 'trusted_def',
    ]);
  });

  it('Types on adds the structure', () => {
    expect(drawn(lean, language, { showTypes: true })).toEqual([
      'Point', 'add', 'add_comm', 'choice', 'clean_skip', 'hidden_sorry', 'lonely', 'trust_bad', 'trusted_def', 'uses_sorry',
    ]);
  });

  it('Projections on still leaves out the hidden projection', () => {
    expect(drawn(lean, language, { showProjections: true, showTypes: true })).not.toContain('Point.x');
  });

  it('a text query keeps the order: cleanup, then restriction', () => {
    // add has links, so it stays; lonely has none and the query does not reach it
    const ids = drawn(lean, language, { intent: textIntent('add_comm', '') });
    expect(ids).toEqual(['add', 'add_comm']);
  });

  it('groups a file two levels deep as a top-level circle, and deeper files under their crate', () => {
    const filtered = applyFilters(lean, defaultFilters(), language, packedView(language));
    const root = buildPackData(filtered, language);
    expect(root.children!.map(c => c.id)).toEqual(['g:Demo/Basic.lean', 'g:Demo/Proofs', 'g:Demo/Trust']);
    const basic = find(root, 'g:Demo/Basic.lean')!;
    expect(basic.kind).toBe('crate');
    expect(basic.children!.every(c => c.kind === 'fn')).toBe(true);
    expect(basic.children!.map(c => c.label).sort()).toEqual(['add', 'choice', 'lonely']);
    const proofs = find(root, 'g:Demo/Proofs')!;
    expect(proofs.children!.map(c => c.id)).toEqual(['g:Demo/Proofs/Spec.lean']);
    expect(find(root, 'g:Demo/Proofs/Spec.lean')!.kind).toBe('file');
  });

  it('the Lean arc counts only transitively-verified and trusted', () => {
    const filtered = applyFilters(lean, defaultFilters(), language, packedView(language));
    const counts = (lang: ProjectLanguage) => Object.fromEntries(
      buildPackData(filtered, lang).children!.map(c => [c.id, [c.group!.verifiedCount, c.group!.fnCount]]),
    );
    expect(counts('lean')).toEqual({
      'g:Demo/Basic.lean': [3, 3],
      'g:Demo/Proofs': [1, 4],
      'g:Demo/Trust': [1, 2],
    });
    // The Verus rule would count `verified` too
    expect(counts('verus')).toEqual({
      'g:Demo/Basic.lean': [3, 3],
      'g:Demo/Proofs': [3, 4],
      'g:Demo/Trust': [2, 2],
    });
  });

  it('sizes by dependency links after the filters', () => {
    const filtered = applyFilters(lean, defaultFilters(), language, packedView(language));
    const deg = connectivity(filtered);
    expect(deg.get('probe:Demo.lonely')).toBe(0);
    // add_comm, hidden_sorry, uses_sorry, clean_skip, trusted_def
    expect(deg.get('probe:Demo.add')).toBe(5);
    const noTheorems = applyFilters(lean, { ...defaultFilters(), showProofFunctions: false }, language, packedView(language));
    expect(connectivity(noTheorems).get('probe:Demo.add')).toBe(1);
  });

  it('a graph with only structures keeps the button; with Types off nothing is drawn', () => {
    const structs = { ...lean, nodes: lean.nodes.filter(n => n.kind === 'structure'), links: [] };
    expect(hasPackedMapNodes(structs, 'lean')).toBe(true);
    expect(drawn(structs, 'lean')).toEqual([]);
    expect(drawn(structs, 'lean', { showTypes: true })).toEqual(['Point']);
  });
});

describe('Packed Map on a mixed Aeneas graph (probe-aeneas-packed-map.json)', () => {
  const { graph: mixed, language } = loadFixture('probe-aeneas-packed-map.json');
  const rustF = 'probe:demo/1.0/a#f()';
  const rustG = 'probe:demo/1.0/a#g()';

  it('detects a mixed graph and shows the button', () => {
    expect(language).toBe('mixed');
    expect(hasPackedMapNodes(mixed, language)).toBe(true);
  });

  it('draws Rust exec functions and visible Lean declarations, and a hidden sorry', () => {
    expect(drawn(mixed, language)).toEqual(
      ['bad', 'f', 'f_spec', 'gen_sorry', 'trusted_ax', rustF, rustG].sort(),
    );
  });

  it('keeps a Rust proof out, also with Theorems on', () => {
    expect(drawn(mixed, language, { showProofFunctions: true })).not.toContain('probe:demo/1.0/a#p()');
  });

  it('draws a Lean inner and spec link as one dependency, and keeps the mapping', () => {
    const shown = applyFilters(mixed, defaultFilters(), language, packedView(language));
    const ids = new Set(shown.nodes.map(n => n.id));
    // The loader writes both an inner and a spec link between f_spec and f
    const types = shown.links
      .filter(l => [l.source, l.target].map(e => (typeof e === 'string' ? e : e.id)).sort().join() === 'probe:Demo.f,probe:Demo.f_spec')
      .map(l => l.type).sort();
    expect(types).toEqual(['inner', 'spec']);
    expect(edgesOf(shown.links, 'probe:Demo.f', ids, mixedEdgeType)).toEqual(expect.arrayContaining([
      { source: 'probe:Demo.f_spec', target: 'probe:Demo.f', type: 'inner' },
      { source: rustF, target: 'probe:Demo.f', type: 'mapping' },
    ]));
    expect(edgesOf(shown.links, 'probe:Demo.f', ids, mixedEdgeType)).toHaveLength(2);
  });

  it('sizes a node by its distinct drawn neighbors, mappings included', () => {
    const shown = applyFilters(mixed, defaultFilters(), language, packedView(language));
    const degree = connectivity(shown);
    // Rust f: caller g and its Lean translation f; the proof p is not drawn
    expect(degree.get(rustF)).toBe(2);
    // Lean f: f_spec (inner and spec count once) and Rust f
    expect(degree.get('probe:Demo.f')).toBe(2);
  });

  it('Rust off leaves the Lean declarations', () => {
    expect(drawn(mixed, language, { showRustNodes: false })).toEqual(
      ['bad', 'f', 'f_spec', 'gen_sorry', 'trusted_ax'],
    );
  });

  it('Lean off leaves the Rust functions', () => {
    expect(drawn(mixed, language, { showLeanNodes: false })).toEqual([rustF, rustG].sort());
  });

  it('groups Lean files by two path segments next to the Rust crate', () => {
    const shown = applyFilters(mixed, defaultFilters(), language, packedView(language));
    const top = (buildPackData(shown, language).children ?? []).map(c => c.label).sort();
    expect(top).toEqual(['Demo/Specs', 'SrcTranslated/Funs.lean', 'demo']);
  });

  it('the arc uses the rule of each node\'s language', () => {
    const shown = applyFilters(mixed, defaultFilters(), language, packedView(language));
    const root = buildPackData(shown, language);
    const counts = (label: string) => {
      const g = (root.children ?? []).find(c => c.label === label)!.group!;
      return [g.verifiedCount, g.fnCount];
    };
    // Rust: f is transitively verified, g has no status
    expect(counts('demo')).toEqual([1, 2]);
    // Lean f is transitively verified; gen_sorry is unverified
    expect(counts('SrcTranslated/Funs.lean')).toEqual([1, 2]);
    // f_spec is verified (reaches a sorry) and does not count; trusted_ax counts; bad does not
    expect(counts('Demo/Specs')).toEqual([1, 3]);
  });
});

describe('packedArcStatus', () => {
  const st = (verification_status: D3Node['verification_status'], language?: string) => ({ verification_status, language });

  it('Lean counts transitively-verified and trusted only', () => {
    expect(packedArcStatus(st('transitively-verified'), 'lean')).toBe(true);
    expect(packedArcStatus(st('trusted'), 'lean')).toBe(true);
    expect(packedArcStatus(st('verified'), 'lean')).toBe(false);
    expect(packedArcStatus(st('unverified'), 'lean')).toBe(false);
    expect(packedArcStatus(st(undefined), 'lean')).toBe(false);
  });

  it('Verus counts verified too, as before', () => {
    expect(packedArcStatus(st('verified'), 'verus')).toBe(true);
    expect(packedArcStatus(st('transitively-verified'), 'verus')).toBe(true);
    expect(packedArcStatus(st('trusted'), 'verus')).toBe(true);
    expect(packedArcStatus(st('failed'), 'verus')).toBe(false);
  });

  it('a mixed graph uses the rule of the node\'s language', () => {
    expect(packedArcStatus(st('verified', 'rust'), 'mixed')).toBe(true);
    expect(packedArcStatus(st('verified', 'lean'), 'mixed')).toBe(false);
    expect(packedArcStatus(st('trusted', 'lean'), 'mixed')).toBe(true);
  });
});

describe('packedMapText', () => {
  it('uses "declarations" for Lean, both words for mixed, and "functions" otherwise', () => {
    expect(packedMapText('lean').many).toBe('declarations');
    expect(packedMapText('lean').empty).toBe('No Lean declarations match the filters.');
    expect(packedMapText('lean').ariaLabel).toContain('Packed Map declarations');
    expect(packedMapText('verus').many).toBe('functions');
    expect(packedMapText('verus').empty).toBe('No Rust functions match the filters.');
    expect(packedMapText('mixed').many).toBe('functions and declarations');
    expect(packedMapText('mixed').empty).toBe('No Rust functions or Lean declarations match the filters.');
  });
});

describe('edgesOf with a type map', () => {
  it('merges an inner and a spec link between the same nodes into one dependency', () => {
    const links = [
      { source: 't', target: 'd', type: 'inner' },
      { source: 't', target: 'd', type: 'spec' },
    ];
    const ids = new Set(['t', 'd']);
    expect(edgesOf(links, 't', ids)).toHaveLength(2);
    expect(edgesOf(links, 't', ids, () => 'inner')).toEqual([{ source: 't', target: 'd', type: 'inner' }]);
  });
});

describe('mixedEdgeType', () => {
  it('draws a Lean spec link as a dependency and keeps the other types', () => {
    expect(mixedEdgeType('spec')).toBe('inner');
    for (const t of ['inner', 'precondition', 'postcondition', 'mapping']) expect(mixedEdgeType(t)).toBe(t);
  });
});

describe('Packed Map on a Rust graph after Phase 4', () => {
  // f's only link goes to the proof p; iso has no links; g calls h
  const rust = graph(
    [
      node('f', 'c', 'src/a.rs', 'exec'), node('p', 'c', 'src/a.rs', 'proof'),
      node('iso', 'c', 'src/a.rs', 'exec'), node('g', 'c', 'src/b.rs', 'exec'), node('h', 'c', 'src/b.rs', 'exec'),
    ],
    [['f', 'p'], ['g', 'h']],
  );
  const ids = (filters: Partial<FilterOptions>) =>
    applyFilters(rust, { ...defaultFilters(), ...filters }, 'verus', packedView('verus')).nodes.map(n => n.id).sort();

  it('without a query, draws exec functions with no links left (the inventory)', () => {
    expect(ids({})).toEqual(['f', 'g', 'h', 'iso']);
    // Before Phase 4 the cleanup dropped iso
    const old = restrictToPackedNodes(applyFilters(rust, defaultFilters(), 'verus'), 'verus');
    expect(old.nodes.map(n => n.id).sort()).toEqual(['f', 'g', 'h']);
  });

  it('a text query keeps an exec function whose only link goes to a proof', () => {
    expect(ids({ intent: textIntent('f', '') })).toEqual(['f']);
  });

  it('other views keep the cleanup', () => {
    expect(applyFilters(rust, defaultFilters(), 'verus').nodes.map(n => n.id).sort()).toEqual(['f', 'g', 'h', 'p']);
  });
});
