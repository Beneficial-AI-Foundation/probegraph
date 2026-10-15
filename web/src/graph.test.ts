/**
 * Unit tests for the fit-to-view camera computation (graph.ts):
 * fitting small graphs, the minimum-scale floor on large graphs, and the
 * focus-node fallback when the whole graph cannot fit at a readable scale.
 */

import { describe, it, expect } from 'vitest';
import { computeCenterTransform, computeFitTransform } from './graph';

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
