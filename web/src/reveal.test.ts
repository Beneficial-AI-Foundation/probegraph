import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RevealCounter, classifyReveal, finishReveal, revealActions, revealMessage, searchIntent, withAnchor,
  type RevealContext,
} from './reveal';
import { applyFilters } from './filters';
import { exactIntent, focusIntent, textIntent, type QueryIntent } from './intent';
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
function context(over: Partial<FilterOptions> = {}, rendered?: string[]): RevealContext {
  const filters = { ...defaultFilters(), showTypes: true, ...over, intent: query, maxDepth: null };
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

  it('starts a sink set after a source set', () => {
    expect(searchIntent(query, 'probe:x', 'x', { kind: 'anchor', role: 'sink' }))
      .toMatchObject({ ids: ['probe:x'], dir: 'callers', label: 'x' });
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

  it('drops the first of two reveals in a row once the second starts', async () => {
    const counter = new RevealCounter();
    const centred: string[] = [];
    const settleA = deferred<void>();
    const a = finishReveal(counter, counter.start(), {
      settle: () => settleA.promise,
      center: async () => { centred.push('A'); return true; },
    });
    // B is selected while A's layout settles
    const b = finishReveal(counter, counter.start(), {
      settle: async () => {},
      center: async () => { centred.push('B'); return true; },
    });
    expect(await b).toBe(true);
    settleA.resolve();
    expect(await a).toBe(false);
    expect(centred).toEqual(['B']);
  });

  it('reports a reveal overtaken during its camera move as not centred', async () => {
    const counter = new RevealCounter();
    const move = deferred<boolean>();
    const a = finishReveal(counter, counter.start(), { settle: async () => {}, center: () => move.promise });
    await Promise.resolve();
    counter.start();
    move.resolve(true);
    expect(await a).toBe(false);
  });

  it('drops a reveal when a graph loads', async () => {
    const counter = new RevealCounter();
    const token = counter.start();
    counter.invalidate();
    let centred = false;
    expect(await finishReveal(counter, token, {
      settle: async () => {},
      center: async () => { centred = true; return true; },
    })).toBe(false);
    expect(centred).toBe(false);
  });
});
