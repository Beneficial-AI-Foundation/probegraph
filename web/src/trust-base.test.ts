import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { convertAtomDictToD3Graph } from './graph-loader';
import type { Condensation } from './reachability';
import {
  MAX_FRONTIER_STEPS, MAX_TRUST_BASE_WORDS, frontierCountsFit, groupDrawing, isTrustAssumption, isTrustUnfinished,
  isTrustUnknown, proofFrontier, trustAnalysis, trustBaseFits, witness, witnesses,
} from './trust-base';
import type { D3Graph, ProbeAtom } from './types';

interface Fixture {
  name: string;
  data: Record<string, ProbeAtom>;
  expected: {
    trust_base?: Record<string, unknown>;
    witness?: [string, string, string[] | null][];
    groups?: unknown;
    frontier?: { members: string[]; unblocks: number; affected: number; dependents: number }[];
  };
}

// Shared with scripts/trust_frontier.py check. `done` is internal to the
// frontier, so only the script checks it.
const FIXTURES: Fixture[] = JSON.parse(
  readFileSync(resolve(__dirname, 'test-data/trust-frontier.json'), 'utf8'),
);

describe('trust base fixtures (scripts/trust_frontier.py)', () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      const g = convertAtomDictToD3Graph(fixture.data);
      const analysis = trustAnalysis(g)!;
      for (const [id, base] of Object.entries(fixture.expected.trust_base ?? {})) {
        expect(analysis.baseOf(id), id).toEqual(base);
      }
      for (const [start, target, path] of fixture.expected.witness ?? []) {
        expect(witness(g, start, target), `${start} -> ${target}`).toEqual(path);
      }
      if (fixture.expected.groups) {
        const groups = analysis.groups();
        expect(groups.map(g => ({ base: g.base(), theorems: g.theorems }))).toEqual(fixture.expected.groups);
        expect(groups.map(g => g.baseSize)).toEqual(groups.map(g => g.base().length));
      }
      if (fixture.expected.frontier) {
        expect(proofFrontier(g).rows().map(r => ({ members: r.members, ...r.counts })))
          .toEqual(fixture.expected.frontier);
      }
    });
  }
});

describe('trustAnalysis', () => {
  it('returns null for an unknown ID', () => {
    const g = convertAtomDictToD3Graph(FIXTURES[0].data);
    expect(trustAnalysis(g)!.baseOf('nope')).toBeNull();
  });

  it('is computed once per graph object', () => {
    const g = convertAtomDictToD3Graph(FIXTURES[0].data);
    expect(trustAnalysis(g)).toBe(trustAnalysis(g));
  });

  it('matches a BFS on the cut graph for random graphs', () => {
    const statuses = [undefined, 'verified', 'transitively-verified', 'trusted', 'unverified', 'failed'];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 48271) % 2147483647;  // Park-Miller: the product stays below 2^53
      return seed % n;
    };
    // The last rounds have more than 32 base nodes: bitsets of several words
    for (let round = 0; round < 50; round++) {
      const size = round < 40 ? 3 + rand(12) : 60 + rand(40);
      const ids = Array.from({ length: size }, (_, i) => `n${i}`);
      const atoms: Record<string, ProbeAtom> = {};
      for (const id of ids) {
        const deps = ids.filter(() => rand(4) === 0);
        if (rand(5) === 0) deps.push(`gone${rand(3)}`);
        const status = statuses[rand(statuses.length)];
        atoms[id] = {
          kind: rand(2) === 0 ? 'theorem' : 'def', language: 'lean', dependencies: deps,
          ...(status && { 'verification-status': status }),
          ...(rand(8) === 0 && { untracked: true }),
        } as ProbeAtom;
      }
      const g = convertAtomDictToD3Graph(atoms);
      const analysis = trustAnalysis(g)!;
      for (const id of ids) expect(analysis.baseOf(id), `round ${round} ${id}`).toEqual(bruteForce(g, id));
    }
  });
});

describe('trustBaseFits', () => {
  const sized = (components: number, edgesPer: number) => ({
    members: Array.from({ length: components }, () => ['']),
    dependencies: Array.from({ length: components }, () => new Array(edgesPer).fill(0)),
  } as unknown as Condensation);

  it('rejects bitsets that take too much memory', () => {
    const wordsPer = MAX_TRUST_BASE_WORDS / 1000;
    expect(trustBaseFits(sized(1000, 0), wordsPer)).toBe(true);
    expect(trustBaseFits(sized(1000, 0), wordsPer + 1)).toBe(false);
  });

  it('rejects too many condensed edges below the memory limit', () => {
    // (edges + components) * wordsPer against MAX_REACHABILITY_WORDS (250 million)
    expect(trustBaseFits(sized(1000, 19), 12_500)).toBe(true);
    expect(trustBaseFits(sized(1000, 20), 12_500)).toBe(false);
  });
});

describe('proofFrontier', () => {
  it('is computed once per graph object', () => {
    const g = convertAtomDictToD3Graph(FIXTURES[0].data);
    expect(proofFrontier(g)).toBe(proofFrontier(g));
  });

  it('tells the members of a row from the other nodes', () => {
    const fixture = FIXTURES.find(f => f.name === 'unfinished-scc')!;
    const frontier = proofFrontier(convertAtomDictToD3Graph(fixture.data));
    expect(frontier.rows().map(r => r.members)).toEqual([['u1', 'u2']]);
    for (const id of Object.keys(fixture.data)) expect(frontier.isReady(id), id).toBe(id === 'u1' || id === 'u2');
  });

  it('finds the row of a member', () => {
    const fixture = FIXTURES.find(f => f.name === 'unfinished-scc')!;
    const frontier = proofFrontier(convertAtomDictToD3Graph(fixture.data));
    expect(frontier.rowOf('u2')).toBe(frontier.rows()[0]);
    for (const id of Object.keys(fixture.data).filter(id => id !== 'u1' && id !== 'u2')) {
      expect(frontier.rowOf(id), id).toBeUndefined();
    }
  });

  it('matches the rules applied node by node for random graphs', () => {
    const statuses = [undefined, 'verified', 'transitively-verified', 'trusted', 'unverified', 'unverified', 'failed'];
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const size = 3 + rand(14);
      const ids = Array.from({ length: size }, (_, i) => `n${i}`);
      const atoms: Record<string, ProbeAtom> = {};
      for (const id of ids) {
        const status = statuses[rand(statuses.length)];
        atoms[id] = {
          kind: 'theorem', language: 'lean', dependencies: ids.filter(() => rand(5) === 0),
          ...(status && { 'verification-status': status }),
          ...(rand(10) === 0 && { untracked: true }),
        } as ProbeAtom;
      }
      const g = convertAtomDictToD3Graph(atoms);
      const rows = proofFrontier(g).rows().map(r => ({ members: r.members, ...r.counts }));
      expect(rows, `round ${round}`).toEqual(bruteForceFrontier(g));
    }
  });
});

describe('frontierCountsFit', () => {
  const sized = (components: number, edgesPer: number) => ({
    members: Array.from({ length: components }, () => ['']),
    dependencies: Array.from({ length: components }, () => new Array(edgesPer).fill(0)),
  } as unknown as Condensation);

  it('bounds rows x (components + links) by MAX_FRONTIER_STEPS', () => {
    // 10 million steps: 1000 rows over 1000 components with 9 links each
    expect(MAX_FRONTIER_STEPS).toBe(10_000_000);
    expect(frontierCountsFit(sized(1000, 9), 1000)).toBe(true);
    expect(frontierCountsFit(sized(1000, 9), 1001)).toBe(false);
  });
});

/**
 * The frontier from its definitions, node by node, with no condensation:
 * done is the largest fixed point, a work group is the unfinished members
 * of a cycle class, and the counts rerun done with the group forced done.
 */
function bruteForceFrontier(g: D3Graph) {
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const ids = [...byId.keys()];
  const deps = (id: string) => (isTrustAssumption(byId.get(id)!) ? [] : byId.get(id)!.dependencies);
  const reach = new Map(ids.map(start => {
    const seen = new Set<string>();
    const queue = [...deps(start)];
    while (queue.length > 0) {
      const v = queue.pop()!;
      if (seen.has(v)) continue;
      seen.add(v);
      queue.push(...deps(v));
    }
    return [start, seen];
  }));
  const classOf = (id: string) => ids.filter(o => o === id || (reach.get(id)!.has(o) && reach.get(o)!.has(id)));
  const unfinished = (id: string) => isTrustUnfinished(byId.get(id)!);
  const unknown = (id: string) => isTrustUnknown(byId.get(id)!);
  const doneSet = (forced: Set<string>) => {
    const done = new Set(ids.filter(id => isTrustAssumption(byId.get(id)!) || (!unfinished(id) && !unknown(id))));
    for (let changed = true; changed;) {
      changed = false;
      for (const id of [...done]) {
        if (isTrustAssumption(byId.get(id)!)) continue;
        if (deps(id).some(d => !done.has(d) && !forced.has(d))) {
          done.delete(id);
          changed = true;
        }
      }
    }
    return new Set([...done, ...forced]);
  };
  const isReady = (id: string, done: Set<string>) => {
    const cls = new Set(classOf(id));
    return unfinished(id) && ![...cls].some(unknown)
      && [...cls].every(m => deps(m).every(d => cls.has(d) || done.has(d)));
  };
  const done = doneSet(new Set());
  const rows: { members: string[]; unblocks: number; affected: number; dependents: number }[] = [];
  const placed = new Set<string>();
  for (const id of ids.sort()) {
    if (placed.has(id) || !isReady(id, done)) continue;
    const cls = classOf(id);
    cls.forEach(m => placed.add(m));
    const callers = ids.filter(o => !cls.includes(o) && reach.get(o)!.has(id));
    const after = doneSet(new Set(cls));
    rows.push({
      members: cls.filter(unfinished),
      unblocks: callers.filter(o => unfinished(o) && !isReady(o, done) && isReady(o, after)).length,
      affected: callers.filter(unfinished).length,
      dependents: callers.length,
    });
  }
  return rows.sort((a, b) => b.unblocks - a.unblocks || b.affected - a.affected || b.dependents - a.dependents
    || (a.members[0] < b.members[0] ? -1 : 1));
}

/** Trust base by BFS from one node on the graph with the trust cut. */
function bruteForce(g: D3Graph, start: string) {
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const seen = new Set([start]);
  const queue = [start];
  const missing = new Set<string>();
  while (queue.length > 0) {
    const n = byId.get(queue.pop()!)!;
    if (isTrustAssumption(n)) continue;
    for (const t of n.missing_dependencies ?? []) missing.add(t);
    for (const d of n.dependencies) {
      if (!seen.has(d)) {
        seen.add(d);
        queue.push(d);
      }
    }
  }
  const nodes = [...seen].sort().map(id => byId.get(id)!);
  return {
    assumptions: nodes.filter(isTrustAssumption).map(n => n.id),
    unfinished: nodes.filter(isTrustUnfinished).map(n => n.id),
    unknown: nodes.filter(isTrustUnknown).map(n => n.id),
    missing: [...missing].sort(),
  };
}

describe('witnesses', () => {
  const g = convertAtomDictToD3Graph(FIXTURES.find(f => f.name === 'chain')!.data);

  it('gives every target from one BFS', () => {
    expect(Object.fromEntries(witnesses(g, 'top', ['low', 'ax', 'top', 'nope']))).toEqual({
      low: ['top', 'mid', 'low'],
      ax: ['top', 'mid', 'low', 'ax'],
      top: ['top'],
      nope: null,
    });
  });

  it('stops once every target is reached', () => {
    const local = convertAtomDictToD3Graph(FIXTURES.find(f => f.name === 'chain')!.data);
    const read: string[] = [];
    for (const n of local.nodes) {
      const deps = n.dependencies;
      Object.defineProperty(n, 'dependencies', { get: () => { read.push(n.id); return deps; } });
    }
    expect(witnesses(local, 'top', ['mid']).get('mid')).toEqual(['top', 'mid']);
    expect(read).toEqual(['top']);
  });

  it('is null from a start that is not in the graph', () => {
    expect(witness(g, 'nope', 'ax')).toBeNull();
  });
});

describe('groupDrawing', () => {
  const graphOf = (name: string) => convertAtomDictToD3Graph(FIXTURES.find(f => f.name === name)!.data);

  it('computes the groups once per analysis', () => {
    const analysis = trustAnalysis(graphOf('chain'))!;
    expect(analysis.groups()).toBe(analysis.groups());
  });

  it('orders the base, then the theorems, then the chain nodes', () => {
    // top -> l -> b1 -> ax and top -> r -> b2 -> ax
    const g = graphOf('diamond-two-blockers');
    expect(groupDrawing(g, { base: ['ax', 'b1', 'b2'], theorems: ['top'] }, 200))
      .toEqual({ ids: ['ax', 'b1', 'b2', 'top', 'l', 'r'], complete: true });
  });

  it('lists a theorem on another theorem\'s chain once', () => {
    // top -> mid -> low -> ax; mid is on top's chain and in the group
    const g = graphOf('chain');
    expect(groupDrawing(g, { base: ['ax', 'low'], theorems: ['mid', 'top'] }, 200))
      .toEqual({ ids: ['ax', 'low', 'mid', 'top'], complete: true });
  });

  it('stops the chains after the step budget', () => {
    const g = graphOf('diamond-two-blockers');
    const group = { base: ['ax', 'b1', 'b2'], theorems: ['top'] };
    expect(groupDrawing(g, group, 200, 0)).toEqual({ ids: ['ax', 'b1', 'b2', 'top'], complete: false });
  });

  it('groups a long chain of unfinished theorems without listing every base', () => {
    // t0 -> t1 -> ... -> t2999, all unverified: 3000 groups of one theorem
    const n = 3000;
    const atoms: Record<string, ProbeAtom> = {};
    for (let i = 0; i < n; i++) {
      atoms[`t${i}`] = {
        'display-name': `t${i}`, dependencies: i + 1 < n ? [`t${i + 1}`] : [], 'code-text': null,
        'code-path': 'T.lean', 'code-module': 'T', kind: 'theorem', language: 'lean', 'verification-status': 'unverified',
      };
    }
    const groups = trustAnalysis(convertAtomDictToD3Graph(atoms))!.groups();
    expect(groups.length).toBe(n - 1);
    expect(groups[0].baseSize).toBe(n - 1);
    expect(groups[0].theorems).toEqual(['t0']);
  });

  it('stops the chains at the limit, but keeps the base and the theorems', () => {
    const g = graphOf('diamond-two-blockers');
    const group = { base: ['ax', 'b1', 'b2'], theorems: ['top'] };
    expect(groupDrawing(g, group, 5)).toEqual({ ids: ['ax', 'b1', 'b2', 'top', 'l'], complete: false });
    expect(groupDrawing(g, group, 2)).toEqual({ ids: ['ax', 'b1', 'b2', 'top'], complete: false });
    expect(groupDrawing(g, group, 6).complete).toBe(true);
  });
});
