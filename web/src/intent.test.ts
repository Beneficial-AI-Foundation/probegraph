/**
 * Unit tests for the query intent (intent.ts), its URL codec (url-state.ts)
 * and its compilation (compileQuery / executeQuery).
 */

import { describe, it, expect } from 'vitest';
import {
  QueryIntent, NONE_INTENT, textIntent, focusIntent, exactIntent, boundaryIntent,
  inputsForIntent, intentAfterInputEdit, vscodeIntent, vscodeSetQueryIntent,
  isDirectionalIntent,
} from './intent';
import { URLViewState, defaultFilters, readURLState, writeURLState } from './url-state';
import { exactStatusFilter } from './status-filter';
import { compileQuery, executeQuery } from './query';
import { D3Graph, D3Node, FilterOptions } from './types';

// ============================================================================
// Test Helpers
// ============================================================================

function createNode(id: string, display_name: string, crate_name = 'test', relative_path = `src/${id}.rs`): D3Node {
  return {
    id,
    display_name,
    symbol: id,
    full_path: `/path/${relative_path}`,
    relative_path,
    file_name: relative_path.split('/').pop()!,
    parent_folder: 'src',
    crate_name,
    is_libsignal: false,
    dependencies: [],
    dependents: [],
    kind: 'exec',
  };
}

/**
 * a → b → c ← d, e isolated. a and d share a display name.
 * a, b in crate x; c, d, e in crate xy.
 */
function graph(): D3Graph {
  const nodes = [
    createNode('a', 'dup', 'x'),
    createNode('b', 'func_b', 'x', 'lib/b.rs'),
    createNode('c', 'func_c', 'xy'),
    createNode('d', 'dup', 'xy'),
    createNode('e', 'lonely', 'xy'),
  ];
  return {
    nodes,
    links: [
      { source: 'a', target: 'b', type: 'inner' },
      { source: 'b', target: 'c', type: 'inner' },
      { source: 'd', target: 'c', type: 'inner' },
    ],
    metadata: { total_nodes: 5, total_edges: 3, project_root: '/t', generated_at: '' },
  };
}

function viewState(filters: FilterOptions, overrides: Partial<URLViewState> = {}): URLViewState {
  return {
    filters,
    view: 'callgraph',
    sourceCrate: '',
    targetCrate: '',
    hierarchyExpanded: [],
    pendingFocusUrl: null,
    entrypointsUrl: null,
    projectLanguage: 'verus',
    ...overrides,
  };
}

function filtersWith(overrides: Partial<FilterOptions>): FilterOptions {
  return { ...defaultFilters(), ...overrides };
}

function write(filters: FilterOptions, overrides: Partial<URLViewState> = {}, base = ''): URLSearchParams {
  const params = new URLSearchParams(base);
  writeURLState(params, viewState(filters, overrides));
  return params;
}

function roundTrip(filters: FilterOptions): FilterOptions {
  return readURLState(write(filters), defaultFilters(), graph()).filters;
}

function resultIds(filters: FilterOptions, g: D3Graph = graph()): string[] {
  return executeQuery(compileQuery(filters), g).nodes.map(n => n.id).sort();
}

// ============================================================================
// Intent constructors and transitions
// ============================================================================

describe('intent constructors', () => {
  it('textIntent is none when both sides are blank', () => {
    expect(textIntent('  ', '')).toEqual(NONE_INTENT);
    expect(textIntent('foo', '')).toEqual({ kind: 'text', source: 'foo', sink: '' });
  });

  it('exactIntent dedupes IDs and is none when empty', () => {
    expect(exactIntent([], 'callers', 'x', { type: 'guide' })).toEqual(NONE_INTENT);
    const i = exactIntent(['a', 'a', 'b'], 'callers', 'x', { type: 'guide' });
    expect(i.kind === 'ids' && i.ids).toEqual(['a', 'b']);
  });

  it('directional: text with a selector, ids with a direction, boundary', () => {
    expect(isDirectionalIntent(NONE_INTENT)).toBe(false);
    expect(isDirectionalIntent(textIntent('a', ''))).toBe(true);
    expect(isDirectionalIntent(focusIntent('f.json', ['a'], 'f'))).toBe(false);
    expect(isDirectionalIntent(exactIntent(['a'], 'none', 'a', { type: 'vscode' }))).toBe(false);
    expect(isDirectionalIntent(exactIntent(['a'], 'callers', 'a', { type: 'guide' }))).toBe(true);
    expect(isDirectionalIntent(boundaryIntent('x', 'y'))).toBe(true);
  });
});

describe('inputs for non-text intents', () => {
  const callers = exactIntent(['a'], 'callers', 'dup', { type: 'guide' });
  const both = exactIntent(['a'], 'both', 'dup', { type: 'vscode' });

  it('callers puts the label in the sink only, marked exact', () => {
    expect(inputsForIntent(callers)).toEqual({ source: '', sink: 'dup', sourceExact: false, sinkExact: true });
  });

  it('focus and boundary labels never sit in an input', () => {
    expect(inputsForIntent(focusIntent('f.json', ['a'], 'focus'))).toMatchObject({ source: '', sink: '' });
    expect(inputsForIntent(boundaryIntent('x', 'y'))).toMatchObject({ source: '', sink: '' });
  });

  it('editing over an exact intent gives a text intent', () => {
    expect(intentAfterInputEdit(callers, 'sink', '', 'dupx')).toEqual(textIntent('', 'dupx'));
  });

  it('editing one side of an exact both intent drops the other side', () => {
    expect(intentAfterInputEdit(both, 'source', 'dupx', 'dup')).toEqual(textIntent('dupx', ''));
    expect(intentAfterInputEdit(both, 'sink', 'dup', 'dupx')).toEqual(textIntent('', 'dupx'));
  });

  it('editing the empty side of callers/callees drops the exact label', () => {
    const callees = exactIntent(['a'], 'callees', 'dup', { type: 'guide' });
    expect(intentAfterInputEdit(callers, 'source', 'mul', 'dup')).toEqual(textIntent('mul', ''));
    expect(intentAfterInputEdit(callees, 'sink', 'dup', 'mul')).toEqual(textIntent('', 'mul'));
  });

  it('editing a text intent keeps both sides', () => {
    expect(intentAfterInputEdit(textIntent('a', 'b'), 'source', 'ab', 'b')).toEqual(textIntent('ab', 'b'));
  });
});

describe('VS Code intents', () => {
  it('direction follows source/sink presence', () => {
    const dir = (src: boolean, snk: boolean) => {
      const i = vscodeIntent('a', 'dup', src, snk);
      return i.kind === 'ids' ? i.dir : null;
    };
    expect(dir(true, false)).toBe('callees');
    expect(dir(false, true)).toBe('callers');
    expect(dir(true, true)).toBe('both');
    expect(dir(false, false)).toBe('none');
  });

  it('setQuery keeps an omitted side only after a text intent', () => {
    expect(vscodeSetQueryIntent(textIntent('a', 'b'), 'c', undefined)).toEqual(textIntent('c', 'b'));
    const exact = vscodeIntent('a', 'dup', true, true);
    expect(vscodeSetQueryIntent(exact, 'c', undefined)).toEqual(textIntent('c', ''));
  });
});

// ============================================================================
// URL codec
// ============================================================================

describe('URL round trip per intent kind', () => {
  const cases: [string, QueryIntent][] = [
    ['none', NONE_INTENT],
    ['text', textIntent('foo', 'crate:bar')],
    ['exact callers', exactIntent(['a'], 'callers', 'dup', { type: 'guide' })],
    ['exact both, IDs with commas', exactIntent(['scip:x/y,z', 'b'], 'both', 'two', { type: 'guide' })],
    ['exact none', exactIntent(['a'], 'none', 'dup', { type: 'guide' })],
    ['boundary', boundaryIntent('SrcTranslated/Funs.lean', 'Spqr/Specs')],
  ];
  for (const [name, intent] of cases) {
    it(name, () => {
      expect(roundTrip(filtersWith({ intent })).intent).toEqual(intent);
    });
  }

  it('focus intent writes focus=<url>, not its IDs, and reads back as a pending focus URL', () => {
    const params = write(filtersWith({ intent: focusIntent('sets/f.json', ['a', 'b'], 'f') }));
    expect(params.get('focus')).toBe('sets/f.json');
    expect(params.getAll('id')).toEqual([]);
    const parsed = readURLState(params, defaultFilters(), graph());
    expect(parsed.filters.intent).toEqual(NONE_INTENT);
    expect(parsed.focusUrl).toBe('sets/f.json');
  });

  it('a pending focus load keeps focus= while the intent is none', () => {
    const params = write(defaultFilters(), { pendingFocusUrl: 'sets/f.json' });
    expect(params.get('focus')).toBe('sets/f.json');
  });

  it('boundary no longer writes crate: source/sink', () => {
    const params = write(filtersWith({ intent: boundaryIntent('x', 'y') }));
    expect(params.has('source')).toBe(false);
    expect(params.has('sink')).toBe(false);
  });
});

describe('URL round trip for state outside the intent', () => {
  it('depth: finite, default and unlimited', () => {
    expect(write(filtersWith({ maxDepth: 1 })).has('depth')).toBe(false);
    expect(write(filtersWith({ maxDepth: null })).get('depth')).toBe('0');
    expect(roundTrip(filtersWith({ maxDepth: null })).maxDepth).toBeNull();
    expect(roundTrip(filtersWith({ maxDepth: 4 })).maxDepth).toBe(4);
    expect(roundTrip(filtersWith({ maxDepth: 1 })).maxDepth).toBe(1);
  });

  it('selection, hidden nodes and language toggles', () => {
    const f = roundTrip(filtersWith({
      selectedNodes: new Set(['a', 'scip:p,q']),
      hiddenNodes: new Set(['d']),
      showRustNodes: false,
      showLeanNodes: false,
    }));
    expect([...f.selectedNodes].sort()).toEqual(['a', 'scip:p,q']);
    expect([...f.hiddenNodes]).toEqual(['d']);
    expect(f.showRustNodes).toBe(false);
    expect(f.showLeanNodes).toBe(false);
  });

  it('exact status set: written as status=, read back with the toggles derived from it', () => {
    const exact = filtersWith(exactStatusFilter(['transitively-verified', 'failed']));
    expect(write(exact).get('status')).toBe('transitively-verified,failed');
    const f = roundTrip(exact);
    expect(f.exactStatuses).toEqual(['transitively-verified', 'failed']);
    expect([f.showVerifiedNodes, f.showFailedNodes, f.showUnverifiedNodes]).toEqual([true, true, false]);
    expect(write(defaultFilters()).has('status')).toBe(false);
    // Unknown values are dropped; nothing valid left means no exact set
    const read = (q: string) => readURLState(new URLSearchParams(q), defaultFilters(), graph()).filters;
    expect(read('status=trusted,bogus').exactStatuses).toEqual(['trusted']);
    expect(read('status=bogus').exactStatuses).toBeNull();
  });

  it('every param goes back to default when its filter does (delete before set)', () => {
    const nonDefault = filtersWith({
      intent: textIntent('foo', 'bar'),
      selectedNodes: new Set(['a']),
      hiddenNodes: new Set(['d']),
      includeFiles: 'a.rs',
      maxDepth: 3,
      showExecFunctions: false, showProofFunctions: false, showSpecFunctions: true,
      showAxioms: false, showTypes: true, showProjections: true, showInstances: true,
      showInnerCalls: false, showPreconditionCalls: true, showPostconditionCalls: true,
      showMappingLinks: false, showSpecLinks: false,
      showStatementDeps: false, showBodyDeps: false,
      showLibsignal: false, showNonLibsignal: false,
      showRustNodes: false, showLeanNodes: false,
      showVerifiedNodes: false, showFailedNodes: false, showUnverifiedNodes: false,
      exactStatuses: ['trusted'],
      excludeNamePatterns: '*_x', excludePathPatterns: '*/specs/*',
    });
    const dirty = write(nonDefault, { view: 'hierarchy', hierarchyExpanded: ['x'], sourceCrate: 'x', targetCrate: 'y' });
    // Legacy and focus params a hand-edited URL may carry
    dirty.set('hidden', 'dup');
    dirty.set('focus', 'f.json');
    const clean = write(defaultFilters(), {}, dirty.toString() + '&json=g.json');
    expect([...clean.keys()]).toEqual(['json']);
  });
});

describe('URL reading', () => {
  it('edge role boxes round-trip on Lean graphs', () => {
    const f = filtersWith({ showStatementDeps: false, showBodyDeps: true });
    const params = write(f, { projectLanguage: 'lean' });
    expect(params.get('statement')).toBe('0');
    expect(params.has('body')).toBe(false);
    const parsed = readURLState(params, defaultFilters(), graph()).filters;
    expect([parsed.showStatementDeps, parsed.showBodyDeps]).toEqual([false, true]);
  });

  it('precedence: id > focus > boundary > source/sink', () => {
    const all = 'id=a&dir=callers&label=dup&focus=f.json&boundary-source=x&boundary-target=y&source=s';
    const read = (q: string) => readURLState(new URLSearchParams(q), defaultFilters(), graph());
    expect(read(all).filters.intent).toEqual(exactIntent(['a'], 'callers', 'dup', { type: 'guide' }));
    expect(read(all).focusUrl).toBeNull();
    const noId = all.replace('id=a&', '');
    expect(read(noId).filters.intent).toEqual(NONE_INTENT);
    expect(read(noId).focusUrl).toBe('f.json');
    const noFocus = noId.replace('focus=f.json&', '');
    expect(read(noFocus).filters.intent).toEqual(boundaryIntent('x', 'y'));
    expect(read(noFocus.replace('boundary-source=x&', '')).filters.intent).toEqual(textIntent('s', ''));
  });

  it('old links: crate params with crate: source/sink load as a text intent', () => {
    const parsed = readURLState(
      new URLSearchParams('source-crate=x&target-crate=xy&source=crate:x&sink=crate:xy'),
      defaultFilters(), graph(),
    );
    expect(parsed.filters.intent).toEqual(textIntent('crate:x', 'crate:xy'));
    expect(parsed.sourceCrate).toBe('x');
  });

  it('crate params alone only set the highlight, no boundary query', () => {
    const parsed = readURLState(new URLSearchParams('source-crate=x&target-crate=xy'), defaultFilters(), graph());
    expect(parsed.filters.intent).toEqual(NONE_INTENT);
  });

  it('legacy hidden= resolves display names to the first match', () => {
    const parsed = readURLState(new URLSearchParams('hidden=dup,func_c'), defaultFilters(), graph());
    expect([...parsed.filters.hiddenNodes].sort()).toEqual(['a', 'c']);
  });

  it('hide= is read as IDs, not display names', () => {
    const parsed = readURLState(new URLSearchParams('hide=dup'), defaultFilters(), graph());
    expect([...parsed.filters.hiddenNodes]).toEqual(['dup']);
  });

  it('legacy view=blueprint opens the File Map', () => {
    const read = (q: string) => readURLState(new URLSearchParams(q), defaultFilters(), graph()).view;
    expect(read('view=blueprint')).toBe('file-map');
    expect(read('view=file-map')).toBe('file-map');
    expect(write(defaultFilters(), { view: 'file-map' }).get('view')).toBe('file-map');
  });

  it('builds from defaults, not from the previous state', () => {
    const defaults = defaultFilters();
    const parsed = readURLState(new URLSearchParams('sel=a'), defaults, graph());
    expect(defaults.selectedNodes.size).toBe(0);
    expect(parsed.filters.selectedNodes).not.toBe(defaults.selectedNodes);
  });
});

// ============================================================================
// Compiling
// ============================================================================

describe('compileQuery from the intent', () => {
  const all = { maxDepth: null, showSpecFunctions: true };

  it('none -> noTraversal; with a finite-depth selection -> depthFromSelected', () => {
    expect(compileQuery(filtersWith({})).query.type).toBe('noTraversal');
    expect(compileQuery(filtersWith({ selectedNodes: new Set(['a']) })).query.type).toBe('depthFromSelected');
  });

  it('a selection does not compile while an intent is set', () => {
    const q = compileQuery(filtersWith({ intent: textIntent('func_b', ''), selectedNodes: new Set(['a']) })).query;
    expect(q.type).toBe('callees');
  });

  it('exact callers/callees/both use nodeIds matchers, not display names', () => {
    const callers = filtersWith({ ...all, intent: exactIntent(['a'], 'callers', 'dup', { type: 'guide' }) });
    expect(compileQuery(callers).query).toMatchObject({ type: 'callers', to: { kind: 'nodeIds' } });
    expect(resultIds(filtersWith({ ...all, intent: exactIntent(['a'], 'callees', 'dup', { type: 'guide' }) })))
      .toEqual(['a', 'b', 'c']);
    // 'dup' as text matches a and d
    expect(resultIds(filtersWith({ ...all, intent: textIntent('dup', '') }))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('exact both -> neighborhood', () => {
    const f = filtersWith({ maxDepth: 1, intent: exactIntent(['b'], 'both', 'func_b', { type: 'vscode' }) });
    expect(compileQuery(f).query.type).toBe('neighborhood');
    expect(resultIds(f)).toEqual(['a', 'b', 'c']);
  });

  it('exact none restricts to the IDs and keeps isolated anchors', () => {
    expect(resultIds(filtersWith({ intent: exactIntent(['e'], 'none', 'lonely', { type: 'vscode' }) }))).toEqual(['e']);
  });

  it('an exact directional anchor without visible links still shows', () => {
    expect(resultIds(filtersWith({ ...all, intent: exactIntent(['e'], 'callers', 'lonely', { type: 'guide' }) })))
      .toEqual(['e']);
  });

  it('focus set restricts; an empty focus set shows nothing', () => {
    expect(resultIds(filtersWith({ intent: focusIntent('f.json', ['a', 'e'], 'f') }))).toEqual(['a', 'e']);
    expect(resultIds(filtersWith({ intent: focusIntent('f.json', [], 'f') }))).toEqual([]);
  });

  it('boundary matches groups exactly; text crate: queries keep substring matching', () => {
    const exact = filtersWith({ intent: boundaryIntent('x', 'xy') });
    expect(compileQuery(exact).query).toMatchObject({ type: 'crateBoundary', exact: true });
    expect(resultIds(exact)).toEqual(['b', 'c']);
    expect(resultIds(filtersWith({ intent: boundaryIntent('xy', 'x') }))).toEqual([]);
    expect(resultIds(filtersWith({ intent: boundaryIntent('x', 'x') }))).toEqual(['a', 'b']);
    // As text, 'x' is a substring of 'xy', so every edge qualifies
    const sub = filtersWith({ intent: textIntent('crate:x', 'crate:*x*') });
    expect(compileQuery(sub).query).toMatchObject({ type: 'crateBoundary', exact: false });
    expect(resultIds(sub)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('directional queries filter files after traversal and keep the anchors', () => {
    const f = filtersWith({ ...all, includeFiles: 'b.rs', intent: exactIntent(['a'], 'callees', 'dup', { type: 'guide' }) });
    const compiled = compileQuery(f);
    expect(compiled.traversalPredicates.includeFilePatterns).toEqual([]);
    expect(compiled.resultFilePatterns.length).toBe(1);
    // a is outside b.rs but stays as the anchor; c is dropped after traversal
    expect(executeQuery(compiled, graph()).nodes.map(n => n.id).sort()).toEqual(['a', 'b']);
  });

  it('non-directional queries restrict by file before traversal', () => {
    const f = filtersWith({ includeFiles: 'c.rs', intent: exactIntent(['a', 'c'], 'none', 'two', { type: 'guide' }) });
    expect(compileQuery(f).traversalPredicates.includeFilePatterns.length).toBe(1);
    expect(compileQuery(f).resultFilePatterns).toEqual([]);
  });
});
