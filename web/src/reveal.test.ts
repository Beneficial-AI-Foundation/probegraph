import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RevealCounter, classifyReveal, finishReveal, revealActions, revealMessage, searchIntent, withAnchor,
  type RevealContext, type RevealSteps,
} from './reveal';
import { applyFilters } from './filters';
import { exactIntent, focusIntent, idPathsIntent, textIntent, type QueryIntent } from './intent';
import { parseAndNormalizeGraph } from './graph-loader';
import { defaultFilters } from './url-state';
import { detectProjectLanguage, type D3Graph, type FilterOptions } from './types';

// Described in graph-loader.test.ts
const graph = parseAndNormalizeGraph(
  JSON.parse(readFileSync(resolve(__dirname, 'test-data/probe-lean-extract-cut.json'), 'utf8')),
);
const language = detectProjectLanguage(graph);

// Callees of oppUniKemCKA.initA: initA -> StA -> StateA
const INIT_A = 'probe:oppUniKemCKA.initA';
const query = exactIntent([INIT_A], 'callees', 'initA', { type: 'search' });

/**
 * The viewer drawing `query` with types shown and the filters in `over`:
 * every node of the result, or only `rendered`.
 */
function context(over: Partial<FilterOptions> = {}, rendered?: string[], intent: QueryIntent = query): RevealContext {
  const filters = { ...defaultFilters(), showTypes: true, ...over, intent, maxDepth: null };
  const result = applyFilters(graph, filters, language).nodes.map(n => n.id);
  return {
    graph, otherLayer: null, filters, language,
    rendered: new Set(rendered ?? result),
    capped: rendered !== undefined && rendered.length < result.length,
  };
}

describe('classifyReveal', () => {
  it('finds a node the query draws shown', () => {
    expect(classifyReveal(context(), 'probe:oppUniKemCKA.StateA')).toEqual({ reason: 'shown' });
  });

  it('finds a node the query does not reach outside the intent', () => {
    expect(classifyReveal(context(), 'probe:kemCKA.initA')).toEqual({ reason: 'outside-intent' });
  });

  it('names the filter that hides a node', () => {
    expect(classifyReveal(context({ showTypes: false }), 'probe:oppUniKemCKA.StateB'))
      .toEqual({ reason: 'filtered', filteredBy: ['showTypes'] });
  });

  it('finds an anchor a filter hides filtered, not outside the intent', () => {
    expect(classifyReveal(context({ excludeNamePatterns: 'initA' }), INIT_A))
      .toEqual({ reason: 'filtered', filteredBy: ['excludeNamePatterns'] });
  });

  it('finds a node of the result that the cap dropped truncated', () => {
    const ctx = context({}, [INIT_A, 'probe:oppUniKemCKA.StateA']);
    expect(classifyReveal(ctx, 'probe:oppUniKemCKA.StA')).toEqual({ reason: 'truncated' });
  });

  it('finds a node of the result that an uncapped view left out outside the intent', () => {
    // The seeded entry-point view draws less than the result without a cap
    const ctx = { ...context({}, [INIT_A]), capped: false };
    expect(classifyReveal(ctx, 'probe:oppUniKemCKA.StA')).toEqual({ reason: 'outside-intent' });
  });

  it('finds a source with no path to the sinks on no path', () => {
    // initA reaches StateA; kemCKA.initA reaches neither
    const KEM = 'probe:kemCKA.initA';
    const paths = idPathsIntent([INIT_A, KEM], ['probe:oppUniKemCKA.StateA'], 'initA, initA', 'StateA', { type: 'search' });
    expect(classifyReveal(context({}, undefined, paths), INIT_A)).toEqual({ reason: 'shown' });
    expect(classifyReveal(context({}, undefined, paths), KEM)).toEqual({ reason: 'no-path' });
  });

  it('finds a node no query draws filtered, not on no path, when it is no source or sink', () => {
    // Build artifacts are left out of every query
    const KEM = 'probe:kemCKA.initA';
    const paths = idPathsIntent([INIT_A], ['probe:oppUniKemCKA.StateA'], 'initA', 'StateA', { type: 'search' });
    const built = { ...graph, nodes: graph.nodes.map(n => n.id === KEM ? { ...n, relative_path: 'target/gen.lean' } : n) };
    expect(classifyReveal({ ...context({}, undefined, paths), graph: built }, KEM))
      .toEqual({ reason: 'filtered', filteredBy: [] });
  });

  it('finds a node of the inactive layer on the other layer', () => {
    // The blueprint layer is active and does not have the declaration
    const blueprint: D3Graph = { nodes: [], links: [], metadata: graph.metadata };
    const ctx = { ...context(), graph: blueprint, otherLayer: graph, rendered: new Set<string>() };
    expect(classifyReveal(ctx, INIT_A)).toEqual({ reason: 'other-layer' });
  });

  it('finds a node of neither layer missing', () => {
    expect(classifyReveal(context(), 'probe:nowhere')).toEqual({ reason: 'missing' });
  });
});

describe('searchIntent', () => {
  it('replaces the intent with the node and its neighbourhood', () => {
    expect(searchIntent(query, 'probe:x', 'x', { kind: 'replace' }))
      .toMatchObject({ kind: 'ids', ids: ['probe:x'], dir: 'both', label: 'x', origin: { type: 'search' } });
  });

  it('adds a source to an exact source set', () => {
    expect(searchIntent(query, 'probe:x', 'x', { kind: 'anchor', role: 'source' }))
      .toMatchObject({ ids: [INIT_A, 'probe:x'], dir: 'callees', label: 'initA, x' });
  });

  it('starts a paths intent with a sink next to a source set, and the reverse', () => {
    expect(searchIntent(query, 'probe:x', 'x', { kind: 'anchor', role: 'sink' }))
      .toEqual(idPathsIntent([INIT_A], ['probe:x'], 'initA', 'x', { type: 'search' }));
    const sinks = exactIntent(['probe:y'], 'callers', 'y', { type: 'guide' });
    expect(searchIntent(sinks, 'probe:x', 'x', { kind: 'anchor', role: 'source' }))
      .toEqual(idPathsIntent(['probe:x'], ['probe:y'], 'x', 'y', { type: 'search' }));
  });

  it('adds to either set of a paths intent, once', () => {
    const paths = idPathsIntent([INIT_A], ['probe:y'], 'initA', 'y', { type: 'search' });
    expect(searchIntent(paths, 'probe:x', 'x', { kind: 'anchor', role: 'source' }))
      .toEqual(idPathsIntent([INIT_A, 'probe:x'], ['probe:y'], 'initA, x', 'y', { type: 'search' }));
    expect(searchIntent(paths, 'probe:x', 'x', { kind: 'anchor', role: 'sink' }))
      .toEqual(idPathsIntent([INIT_A], ['probe:y', 'probe:x'], 'initA', 'y, x', { type: 'search' }));
    expect(searchIntent(paths, 'probe:y', 'y', { kind: 'anchor', role: 'sink' })).toBe(paths);
  });

  it('starts a source set after a neighbourhood', () => {
    const both = exactIntent(['probe:y'], 'both', 'y', { type: 'search' });
    expect(searchIntent(both, 'probe:x', 'x', { kind: 'anchor', role: 'source' }))
      .toEqual(exactIntent(['probe:x'], 'callees', 'x', { type: 'search' }));
  });

  it('starts a source set after a text query', () => {
    expect(searchIntent(textIntent('init', ''), 'probe:x', 'x', { kind: 'anchor', role: 'source' }))
      .toMatchObject({ ids: ['probe:x'], dir: 'callees' });
  });
});

describe('withAnchor', () => {
  it('keeps an intent that already anchors the node', () => {
    expect(withAnchor(query, INIT_A, 'initA')).toBe(query);
  });

  it('has nothing to add to for text and focus intents', () => {
    expect(withAnchor(textIntent('init', ''), 'probe:x', 'x')).toBeNull();
    expect(withAnchor(focusIntent('f.json', [INIT_A], 'f'), 'probe:x', 'x')).toBeNull();
  });
});

describe('revealActions', () => {
  it('relaxes exactly the filters that hide the node', () => {
    expect(revealActions({ reason: 'filtered', filteredBy: ['showTypes'] }, query, 'probe:x', 'x', 10, 200))
      .toEqual([{ kind: 'relax', keys: ['showTypes'] }]);
  });

  it('offers nothing when no filter set draws the node', () => {
    expect(revealActions({ reason: 'filtered', filteredBy: [] }, query, 'probe:x', 'x', 10, 200)).toEqual([]);
  });

  it('offers an anchor, a query on the node and a raised cap for a truncated node', () => {
    const actions = revealActions({ reason: 'truncated' }, query, 'probe:x', 'x', 300, 200);
    expect(actions.map(a => a.kind)).toEqual(['anchor', 'replace', 'raise-cap']);
    expect((actions[0] as { intent: QueryIntent }).intent).toMatchObject({ ids: [INIT_A, 'probe:x'] });
    expect((actions[1] as { intent: QueryIntent }).intent)
      .toMatchObject({ ids: ['probe:x'], dir: 'both', origin: { type: 'search' } });
    expect(actions[2]).toEqual({ kind: 'raise-cap', cap: 300 });
  });

  it('always offers a query on the node, even above the raised cap and outside an exact set', () => {
    expect(revealActions({ reason: 'truncated' }, textIntent('init', ''), 'probe:x', 'x', 5000, 200).map(a => a.kind))
      .toEqual(['replace']);
  });

  it('offers no anchor when the anchors would not fit in the cap', () => {
    const full = exactIntent(['probe:a', 'probe:b'], 'callees', 'a, b', { type: 'search' });
    expect(revealActions({ reason: 'truncated' }, full, 'probe:x', 'x', 5000, 2).map(a => a.kind))
      .toEqual(['replace']);
  });

  it('offers no anchor for a node that is already one', () => {
    expect(revealActions({ reason: 'truncated' }, query, INIT_A, 'initA', 5000, 200).map(a => a.kind))
      .toEqual(['replace']);
  });

  it('offers to query a node on no path instead', () => {
    expect(revealActions({ reason: 'no-path' }, query, 'probe:x', 'x', 10, 200))
      .toEqual([{ kind: 'replace', intent: exactIntent(['probe:x'], 'both', 'x', { type: 'search' }) }]);
    expect(revealMessage('x', { reason: 'no-path' }, 200)).toBe('x is on no path between the sources and the sinks');
  });
});

describe('revealMessage', () => {
  it('names the filters by their panel names', () => {
    expect(revealMessage('StateB', { reason: 'filtered', filteredBy: ['showTypes', 'includeFiles'] }, 200))
      .toBe('StateB is hidden by the Type and file filters');
  });

  it('is empty for a node that is drawn', () => {
    expect(revealMessage('x', { reason: 'shown' }, 200)).toBe('');
  });
});

describe('finishReveal', () => {
  /** A step that resolves when the test says so. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
  }

  /** Steps that settle at once, are untouched, and log each centring as `name`. */
  function steps(name: string, log: string[], over: Partial<RevealSteps> = {}): RevealSteps {
    return {
      settle: async () => {},
      untouched: () => true,
      center: async () => { log.push(name); return true; },
      settleFully: async () => {},
      ...over,
    };
  }

  it('centres, then centres again once the layout stops', async () => {
    const counter = new RevealCounter();
    const centred: string[] = [];
    const full = deferred<void>();
    const a = finishReveal(counter, counter.start(), steps('A', centred, { settleFully: () => full.promise }));
    await new Promise(r => setTimeout(r));
    expect(centred).toEqual(['A']);
    full.resolve();
    expect(await a).toBe(true);
    expect(centred).toEqual(['A', 'A']);
  });

  it('drops the first of two reveals in a row once the second starts', async () => {
    const counter = new RevealCounter();
    const centred: string[] = [];
    const settleA = deferred<void>();
    const a = finishReveal(counter, counter.start(), steps('A', centred, { settle: () => settleA.promise }));
    // B is selected while A's layout settles
    const b = finishReveal(counter, counter.start(), steps('B', centred));
    expect(await b).toBe(true);
    settleA.resolve();
    expect(await a).toBe(false);
    expect(centred).toEqual(['B', 'B']);
  });

  it('reports a reveal overtaken during its camera move as not centred', async () => {
    const counter = new RevealCounter();
    const move = deferred<boolean>();
    const a = finishReveal(counter, counter.start(), steps('A', [], { center: () => move.promise }));
    await Promise.resolve();
    counter.start();
    move.resolve(true);
    expect(await a).toBe(false);
  });

  it('does not centre once something else moved the camera', async () => {
    const counter = new RevealCounter();
    const centred: string[] = [];
    expect(await finishReveal(counter, counter.start(), steps('A', centred, { untouched: () => false }))).toBe(false);
    expect(centred).toEqual([]);
  });

  it('skips the second centring when the camera moved after the first', async () => {
    const counter = new RevealCounter();
    const centred: string[] = [];
    let touched = false;
    const full = deferred<void>();
    const a = finishReveal(counter, counter.start(), steps('A', centred, {
      untouched: () => !touched,
      settleFully: () => full.promise,
    }));
    await new Promise(r => setTimeout(r));
    touched = true;
    full.resolve();
    expect(await a).toBe(true);
    expect(centred).toEqual(['A']);
  });

  it('drops a reveal when a graph loads', async () => {
    const counter = new RevealCounter();
    const token = counter.start();
    counter.invalidate();
    const centred: string[] = [];
    expect(await finishReveal(counter, token, steps('A', centred))).toBe(false);
    expect(centred).toEqual([]);
  });
});
