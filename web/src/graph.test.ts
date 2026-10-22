/**
 * Unit tests for the fit-to-view camera computation (graph.ts):
 * fitting small graphs, the minimum-scale floor on large graphs, and the
 * focus-node fallback when the whole graph cannot fit at a readable scale.
 * Also the layer layout: folding long layouts into bands.
 */

import { describe, it, expect } from 'vitest';
import { chooseFold, computeCenterTransform, computeFitTransform, layerPositions, LayoutInfo } from './graph';
import { D3Node } from './types';

const WIDTH = 1000;
const HEIGHT = 800;

describe('computeFitTransform', () => {
  it('returns null for empty input', () => {
    expect(computeFitTransform([], WIDTH, HEIGHT)).toBeNull();
  });

  it('returns null when no node has a position', () => {
    expect(computeFitTransform([{}, { x: undefined, y: undefined }], WIDTH, HEIGHT)).toBeNull();
  });

  it('returns null for a degenerate viewport', () => {
    expect(computeFitTransform([{ x: 0, y: 0 }], 0, HEIGHT)).toBeNull();
  });

  it('centers a small graph at the maximum scale without zooming in past it', () => {
    // Bounding box 100x100 plus margins fits easily in 1000x800
    const nodes = [
      { x: 100, y: 100 },
      { x: 200, y: 200 },
    ];
    const t = computeFitTransform(nodes, WIDTH, HEIGHT)!;
    expect(t.k).toBe(1);
    // Bbox center (150, 150) should map to the viewport center
    expect(t.x + t.k * 150).toBeCloseTo(WIDTH / 2);
    expect(t.y + t.k * 150).toBeCloseTo(HEIGHT / 2);
  });

  it('fits a moderately large graph at its exact fit scale', () => {
    // Bbox 1880x100 + 2*60 margin = 2000 wide -> fit scale 1000/2000 = 0.5
    const nodes = [
      { x: 0, y: 0 },
      { x: 1880, y: 100 },
    ];
    const t = computeFitTransform(nodes, WIDTH, HEIGHT)!;
    expect(t.k).toBeCloseTo(0.5);
    expect(t.x + t.k * 940).toBeCloseTo(WIDTH / 2);
    expect(t.y + t.k * 50).toBeCloseTo(HEIGHT / 2);
  });

  it('clamps the scale to the floor on a very large graph', () => {
    const nodes = [
      { x: 0, y: 0 },
      { x: 10000, y: 10000 },
    ];
    const t = computeFitTransform(nodes, WIDTH, HEIGHT)!;
    expect(t.k).toBe(0.4);
    // Without a focus node, still centers the bounding box (best effort)
    expect(t.x + t.k * 5000).toBeCloseTo(WIDTH / 2);
    expect(t.y + t.k * 5000).toBeCloseTo(HEIGHT / 2);
  });

  it('centers on the focus node when the graph cannot fit at the floor scale', () => {
    const nodes = [
      { x: 0, y: 0 },
      { x: 10000, y: 10000 },
      { x: 7000, y: 3000 },
    ];
    const focus = nodes[2];
    const t = computeFitTransform(nodes, WIDTH, HEIGHT, focus)!;
    expect(t.k).toBe(0.4);
    expect(t.x + t.k * 7000).toBeCloseTo(WIDTH / 2);
    expect(t.y + t.k * 3000).toBeCloseTo(HEIGHT / 2);
  });

  it('ignores the focus node when the graph fits without clamping', () => {
    const nodes = [
      { x: 100, y: 100 },
      { x: 300, y: 300 },
    ];
    const t = computeFitTransform(nodes, WIDTH, HEIGHT, nodes[0])!;
    // Fit succeeded, so the camera centers the bbox, not the focus node
    expect(t.x + t.k * 200).toBeCloseTo(WIDTH / 2);
    expect(t.y + t.k * 200).toBeCloseTo(HEIGHT / 2);
  });

  it('skips nodes without positions when computing the bounding box', () => {
    const nodes = [
      { x: 100, y: 100 },
      {},
      { x: 200, y: 200 },
    ];
    const t = computeFitTransform(nodes, WIDTH, HEIGHT)!;
    expect(t.x + t.k * 150).toBeCloseTo(WIDTH / 2);
    expect(t.y + t.k * 150).toBeCloseTo(HEIGHT / 2);
  });

  it('keeps long labels at the edge inside the view', () => {
    const nodes = [{ x: 0, y: 0 }, { x: 800, y: 0 }];
    const named = nodes.map(n => ({ ...n, display_name: 'a'.repeat(40) }));
    const plain = computeFitTransform(nodes, WIDTH, HEIGHT)!;
    const t = computeFitTransform(named, WIDTH, HEIGHT)!;
    expect(t.k).toBeLessThan(plain.k);
    // Half of a 40-character label is 120, so the labels run from -120 to 920
    expect(t.x + t.k * -120).toBeCloseTo(t.k * 20);
    expect(t.x + t.k * 920).toBeCloseTo(WIDTH - t.k * 20);
  });
});

/** A layout with `sizes[d]` nodes at depth d, named `d.i`. */
function layoutOf(sizes: number[]): LayoutInfo {
  const nodesByDepth = new Map<number, D3Node[]>();
  const depths = new Map<string, number>();
  sizes.forEach((size, depth) => {
    const layer = Array.from({ length: size }, (_, i) => ({ id: `${depth}.${i}` }) as D3Node);
    layer.forEach(n => depths.set(n.id, depth));
    nodesByDepth.set(depth, layer);
  });
  return { depths, maxDepth: sizes.length - 1, maxLayerWidth: Math.max(...sizes), nodesByDepth };
}

describe('chooseFold', () => {
  it('keeps a layout that fits in one band', () => {
    expect(chooseFold([1, 1, 1], 800, 600).bands).toBe(1);
    // Two tall layers: folding would only make it taller
    expect(chooseFold([3, 21], 800, 600).bands).toBe(1);
  });

  it('folds a long chain until it fits at full scale', () => {
    // 15 layers at 200 apart need 2920 wide; four bands of four fit in 800
    expect(chooseFold(new Array(15).fill(1), 800, 618)).toEqual({ bands: 4, layersPerBand: 4 });
  });

  it('does not count bands that would stay empty', () => {
    // 5 layers, 3 bands of 2 would draw the same as 3 bands; 4 bands of 2 never
    for (let bands = 1; bands <= 5; bands++) {
      const fold = chooseFold(new Array(5).fill(1), 400 * bands, 2000);
      expect(Math.ceil(5 / fold.layersPerBand)).toBe(fold.bands);
    }
  });
});

describe('layerPositions', () => {
  it('spreads one band over the view as before', () => {
    const p = layerPositions(layoutOf([1, 2]), 800, 600, { bands: 1, layersPerBand: 2 });
    expect(p.get('0.0')).toEqual({ x: 100, y: 300 });
    expect(p.get('1.0')).toEqual({ x: 700, y: 100 + 400 / 3 });
    expect(p.get('1.1')).toEqual({ x: 700, y: 100 + 800 / 3 });
  });

  it('runs odd bands right to left, each as tall as its widest layer', () => {
    const p = layerPositions(layoutOf([1, 3, 1, 1, 1, 1]), 800, 600, { bands: 2, layersPerBand: 3 });
    const x = (id: string) => p.get(id)!.x;
    const y = (id: string) => p.get(id)!.y;
    expect([x('0.0'), x('1.0'), x('2.0')]).toEqual([100, 300, 500]);
    expect([x('3.0'), x('4.0'), x('5.0')]).toEqual([500, 300, 100]);
    // Band 0 has three rows; its one-node layers sit on the middle row
    expect([y('1.0'), y('1.1'), y('1.2')]).toEqual([100, 160, 220]);
    expect(y('0.0')).toBe(160);
    // Band 1 starts one gap below band 0's last row
    expect(y('3.0')).toBe(220 + 100);
  });
});

describe('computeCenterTransform', () => {
  it('maps the node to the viewport centre at the given scale', () => {
    const t = computeCenterTransform({ x: 1500, y: -40 }, WIDTH, HEIGHT, 1)!;
    expect(t.k).toBe(1);
    expect(t.x + t.k * 1500).toBeCloseTo(WIDTH / 2);
    expect(t.y + t.k * -40).toBeCloseTo(HEIGHT / 2);
  });

  it('returns null for a node without a position or an empty viewport', () => {
    expect(computeCenterTransform({}, WIDTH, HEIGHT)).toBeNull();
    expect(computeCenterTransform({ x: 0, y: 0 }, WIDTH, 0)).toBeNull();
  });
});
