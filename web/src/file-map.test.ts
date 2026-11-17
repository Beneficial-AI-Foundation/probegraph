/**
 * Unit tests for the File Map layout (file-map.ts): the Rust world and
 * Lean world boxes of mixed projects.
 */

import { describe, it, expect } from 'vitest';
import { languageWorldOf, layoutFileMap } from './file-map';
import { D3Node, D3Link } from './types';

function node(id: string, relativePath: string, language?: string): D3Node {
  return {
    id,
    display_name: id,
    symbol: id,
    full_path: `/repo/${relativePath}`,
    relative_path: relativePath,
    file_name: relativePath.split('/').pop() || '',
    parent_folder: '',
    crate_name: 'c',
    is_libsignal: true,
    dependencies: [],
    dependents: [],
    kind: 'def',
    language,
  };
}

function link(source: string, target: string): D3Link {
  return { source, target, type: 'inner' };
}

/** Box of a laid-out dagre node: [left, top, right, bottom]. */
function box(g: any, id: string): [number, number, number, number] {
  const n = g.node(id);
  return [n.x - n.width / 2, n.y - n.height / 2, n.x + n.width / 2, n.y + n.height / 2];
}

function inside(inner: number[], outer: number[]): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function overlap(a: number[], b: number[]): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

const MIXED = [
  node('r1', 'src/a.rs', 'rust'),
  node('r2', 'src/a.rs', 'rust'),
  node('r3', 'src/b.rs', 'verus'),
  node('l1', 'Spec/A.lean', 'lean'),
  node('l2', 'Spec/B.lean', 'lean'),
];
const MIXED_LINKS = [link('r1', 'r2'), link('r2', 'r3'), link('l1', 'l2'), link('l1', 'r1')];

describe('languageWorldOf', () => {
  it('puts Lean nodes in the Lean world and every other language in Rust', () => {
    expect(languageWorldOf(node('a', 'x', 'lean'))).toBe('lean');
    expect(languageWorldOf(node('b', 'x', 'rust'))).toBe('rust');
    expect(languageWorldOf(node('c', 'x', 'verus'))).toBe('rust');
    expect(languageWorldOf(node('d', 'x'))).toBe('rust');
  });
});

describe('layoutFileMap', () => {
  it('nests each file box inside its world box when worlds are on', () => {
    const layout = layoutFileMap(MIXED, MIXED_LINKS, true);
    expect(layout.grouped).toBe(true);
    expect(layout.worlds).toEqual(['rust', 'lean']);

    const g = layout.graph;
    const rust = box(g, 'world:rust');
    const lean = box(g, 'world:lean');
    expect(overlap(rust, lean)).toBe(false);

    for (const key of layout.fileKeys) {
      const world = layout.fileWorlds.get(key)!;
      expect(g.parent(`file:${key}`)).toBe(`world:${world}`);
      expect(inside(box(g, `file:${key}`), box(g, `world:${world}`))).toBe(true);
    }
    for (const n of MIXED) {
      expect(inside(box(g, n.id), box(g, `world:${languageWorldOf(n)}`))).toBe(true);
    }
  });

  it('gives a path with both languages one file box in each world', () => {
    const nodes = [node('r', 'shared/x', 'rust'), node('l', 'shared/x', 'lean')];
    const layout = layoutFileMap(nodes, [], true);
    expect(layout.fileKeys.sort()).toEqual(['lean:shared/x', 'rust:shared/x']);
    expect(layout.filePaths.get('lean:shared/x')).toBe('shared/x');
  });

  it('only makes the worlds that have nodes', () => {
    const layout = layoutFileMap([node('l', 'A.lean', 'lean')], [], true);
    expect(layout.worlds).toEqual(['lean']);
    expect(layout.graph.hasNode('world:rust')).toBe(false);
  });

  it('keeps plain file boxes when worlds are off', () => {
    const layout = layoutFileMap(MIXED, MIXED_LINKS, false);
    expect(layout.worlds).toEqual([]);
    expect(layout.fileKeys).toEqual(['src/a.rs', 'src/b.rs', 'Spec/A.lean', 'Spec/B.lean']);
    expect(layout.graph.parent('file:src/a.rs')).toBeUndefined();
  });
});
