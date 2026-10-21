import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Bitset, MAX_REACHABILITY_COMPONENTS, MAX_REACHABILITY_WORDS, condense, dependencyLevels, extraMemberPlanes,
  rankByTransitiveDependents, reachabilityFits, transitiveDependentCounts, type Condensation,
} from './reachability';
import { parseAndNormalizeGraph } from './graph-loader';
import type { D3Graph, D3Node } from './types';

/** Graph from caller -> dependency pairs; every endpoint becomes a node. */
function graph(edges: [string, string][], extra: string[] = []): D3Graph {
  const ids = [...new Set([...edges.flat(), ...extra])];
  const nodes = ids.map(id => ({
    id, display_name: id, symbol: id, full_path: '', relative_path: '', file_name: '',
    parent_folder: '', crate_name: '', is_libsignal: true, kind: 'theorem',
    dependencies: edges.filter(([s]) => s === id).map(([, t]) => t),
    dependents: edges.filter(([, t]) => t === id).map(([s]) => s),
  } as D3Node));
  return {
    nodes,
    links: edges.map(([source, target]) => ({ source, target, type: 'inner' as const })),
    metadata: { total_nodes: nodes.length, total_edges: edges.length, project_root: '', generated_at: '' },
  };
}

const counts = (g: D3Graph) => Object.fromEntries(transitiveDependentCounts(g)!);

/**
 * Reference: the nodes that reach each node on the plain graph (BFS), minus
 * the node itself and its SCC peers (the nodes it also reaches).
 */
function bruteForce(g: D3Graph): Record<string, number> {
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const reach = (start: string, next: (n: D3Node) => string[]) => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      for (const p of next(byId.get(queue.pop()!)!)) {
        if (!byId.has(p) || seen.has(p)) continue;
        seen.add(p);
        queue.push(p);
      }
    }
    return seen;
  };
  const out: Record<string, number> = {};
  for (const n of g.nodes) {
    const callers = reach(n.id, m => m.dependents);
    const callees = reach(n.id, m => m.dependencies);
    out[n.id] = [...callers].filter(id => id !== n.id && !callees.has(id)).length;
  }
  return out;
}

describe('Bitset', () => {
  it('adds, unions, counts and lists members across word boundaries', () => {
    const a = new Bitset(70);
    const b = new Bitset(70);
    for (const i of [0, 31, 32]) a.add(i);
    for (const i of [31, 63, 69]) b.add(i);
    a.union(b);
    const seen: number[] = [];
    a.forEach(i => seen.push(i));
    expect(seen).toEqual([0, 31, 32, 63, 69]);
    expect(a.count()).toBe(5);
    expect(a.has(63)).toBe(true);
    expect(a.has(64)).toBe(false);
    expect(a.countShared(b)).toBe(3);
  });

  it('compares and hashes member lists with one member left out', () => {
    // Reference: the sorted lists, element by element, a prefix first
    const list = (members: number[], skip: number) => members.filter(i => i !== skip).sort((x, y) => x - y);
    const order = (x: number[], y: number[]) => {
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
      return Math.sign(x.length - y.length);
    };
    let seed = 7;
    const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let round = 0; round < 500; round++) {
      const members = [0, 1].map(() => [...new Set(Array.from({ length: random(6) }, () => random(70)))]);
      const [x, y] = members.map(m => { const s = new Bitset(70); m.forEach(i => s.add(i)); return s; });
      const [sx, sy] = members.map(m => (m.length > 0 && random(2) === 0 ? m[0] : -1));
      const expected = order(list(members[0], sx), list(members[1], sy));
      expect(Math.sign(x.compare(sx, y, sy))).toBe(expected);
      if (expected === 0) expect(x.hash(sx)).toBe(y.hash(sy));
    }
  });
});

describe('condense', () => {
  it('orders components callers first and merges cycles', () => {
    // a -> b <-> c -> d
    const c = condense(['d', 'c', 'b', 'a'], id => ({ a: ['b'], b: ['c'], c: ['b', 'd'], d: [] } as Record<string, string[]>)[id]);
    expect(c.members).toEqual([['a'], ['b', 'c'], ['d']]);
    expect(c.dependencies).toEqual([[1], [2], []]);
    expect(c.dependents).toEqual([[], [0], [1]]);
    expect(c.componentOf.get('c')).toBe(1);
  });

  it('ignores dependencies outside the node set and self-loops', () => {
    const c = condense(['a', 'b'], id => (id === 'a' ? ['a', 'b', 'external'] : []));
    expect(c.members).toEqual([['a'], ['b']]);
    expect(c.dependencies).toEqual([[1], []]);
  });

  it('handles long chains without recursion', () => {
    const ids = Array.from({ length: 20000 }, (_, i) => `n${String(i).padStart(5, '0')}`);
    const c = condense(ids, id => {
      const i = Number(id.slice(1));
      return i + 1 < ids.length ? [ids[i + 1]] : [];
    });
    expect(c.members.length).toBe(20000);
    expect(c.members[0]).toEqual(['n00000']);
  });
});

describe('transitiveDependentCounts', () => {
  it('counts the nodes that reach each node: A -> B -> C gives 0, 1, 2', () => {
    expect(counts(graph([['A', 'B'], ['B', 'C']]))).toEqual({ A: 0, B: 1, C: 2 });
  });

  it('does not count a node twice through a diamond', () => {
    // a -> b -> d, a -> c -> d, e -> d
    const g = graph([['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['e', 'd']]);
    expect(counts(g)).toEqual({ a: 0, b: 1, c: 1, d: 4, e: 0 });
  });

  it('gives SCC members one count, without counting each other', () => {
    // x -> s1, s1 <-> s2 <-> s3 (one SCC), s3 -> t
    const g = graph([['x', 's1'], ['s1', 's2'], ['s2', 's3'], ['s3', 's1'], ['s3', 't']]);
    expect(counts(g)).toEqual({ x: 0, s1: 1, s2: 1, s3: 1, t: 4 });
  });

  it('counts every member of a reachable SCC', () => {
    // five-member cycle above t
    const cyc: [string, string][] = [['c1', 'c2'], ['c2', 'c3'], ['c3', 'c4'], ['c4', 'c5'], ['c5', 'c1'], ['c1', 't']];
    expect(counts(graph(cyc)).t).toBe(5);
  });

  it('counts cycles of many sizes, across bitset words', () => {
    // A chain of 40 cycles of sizes 1 to 40: each counts every member above it
    const edges: [string, string][] = [];
    const sizes = Array.from({ length: 40 }, (_, i) => i + 1);
    const ids = sizes.map((size, i) => Array.from({ length: size }, (_, j) => `c${String(i).padStart(2, '0')}m${j}`));
    ids.forEach((members, i) => {
      if (members.length > 1) members.forEach((m, j) => edges.push([m, members[(j + 1) % members.length]]));
      if (i + 1 < ids.length) edges.push([members[0], ids[i + 1][0]]);
    });
    const got = counts(graph(edges, ids.flat()));
    let above = 0;
    ids.forEach((members, i) => {
      for (const m of members) expect(got[m]).toBe(above);
      above += sizes[i];
    });
  });

  it('ignores a self-loop', () => {
    expect(counts(graph([['a', 'a'], ['a', 'b']]))).toEqual({ a: 0, b: 1 });
  });

  it('matches a reverse BFS on the fixtures', () => {
    for (const name of ['probe-lean-extract-cut.json', 'probe-merged-rust-lean-cut.json']) {
      const g = parseAndNormalizeGraph(JSON.parse(readFileSync(resolve(__dirname, 'test-data', name), 'utf8')));
      expect(counts(g)).toEqual(bruteForce(g));
    }
  });

  it('matches a reverse BFS on random graphs with cycles', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 20; round++) {
      const ids = Array.from({ length: 40 }, (_, i) => `v${i}`);
      const edges: [string, string][] = [];
      for (let k = 0; k < 70; k++) edges.push([ids[Math.floor(rand() * 40)], ids[Math.floor(rand() * 40)]]);
      const g = graph(edges, ids);
      expect(counts(g)).toEqual(bruteForce(g));
    }
  });
});

describe('rankByTransitiveDependents', () => {
  it('breaks ties by ID', () => {
    const g = graph([['r', 'b'], ['r', 'a'], ['r', 'c']]);
    expect(rankByTransitiveDependents(g, () => true, 3)!.map(r => r.node.id)).toEqual(['a', 'b', 'c']);
  });

  it('restricts the candidates, not the counts', () => {
    // A -> B -> C: with A not a candidate, C still counts A
    const g = graph([['A', 'B'], ['B', 'C']]);
    const ranked = rankByTransitiveDependents(g, n => n.id !== 'A', 5);
    expect(ranked!.map(r => [r.node.id, r.count])).toEqual([['C', 2], ['B', 1]]);
  });
});

describe('reachabilityFits', () => {
  /** A condensation with only the sizes reachabilityFits reads. */
  const sized = (components: number, edgesPer: number, membersPer = 1) => ({
    members: Array.from({ length: components }, () => new Array(membersPer).fill('')),
    dependencies: Array.from({ length: components }, () => new Array(edgesPer).fill(0)),
  } as unknown as Condensation);
  // One union per edge, 1 + planes popcounts per component, ceil(C/32) words each
  const words = (components: number, edgesPer: number, planes = 0) =>
    (components * edgesPer + components * (1 + planes)) * Math.ceil(components / 32);
  const C = MAX_REACHABILITY_COMPONENTS;

  it('rejects too many components', () => {
    expect(reachabilityFits(sized(C, 1))).toBe(true);
    expect(reachabilityFits(sized(C + 1, 0))).toBe(false);
  });

  it('rejects too many condensed edges below the component limit', () => {
    expect(words(C, 19)).toBeLessThanOrEqual(MAX_REACHABILITY_WORDS);
    expect(reachabilityFits(sized(C, 19))).toBe(true);
    expect(words(C, 20)).toBeGreaterThan(MAX_REACHABILITY_WORDS);
    expect(reachabilityFits(sized(C, 20))).toBe(false);
  });

  it('counts the member-counting work of cycles', () => {
    // Cycles of 4 members: extra 3 needs 2 planes
    expect(extraMemberPlanes(sized(C, 17, 4))).toBe(2);
    expect(words(C, 17, 2)).toBeLessThanOrEqual(MAX_REACHABILITY_WORDS);
    expect(reachabilityFits(sized(C, 17, 4))).toBe(true);
    expect(words(C, 18, 2)).toBeGreaterThan(MAX_REACHABILITY_WORDS);
    expect(reachabilityFits(sized(C, 18, 4))).toBe(false);
  });
});

describe('dependencyLevels', () => {
  it('puts leaves at 0 and SCC members on one level', () => {
    // a -> b <-> c -> d, a -> d
    const c = condense(['a', 'b', 'c', 'd'], id => ({ a: ['b', 'd'], b: ['c'], c: ['b', 'd'], d: [] } as Record<string, string[]>)[id]);
    const levels = dependencyLevels(c);
    const of = (id: string) => levels[c.componentOf.get(id)!];
    expect([of('a'), of('b'), of('c'), of('d')]).toEqual([2, 1, 1, 0]);
  });
});
