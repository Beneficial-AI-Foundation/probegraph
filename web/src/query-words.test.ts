import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compileFilterWords, formatVerbQuery, formatWords, graphLevels, graphWordContext,
  moduleSegments, parseVerbQuery, parseWords, runTop, type FilterWord, type TopQuery,
} from './query-words';
import { buildGraphSummary } from './guide/static-analysis';
import { compileQuery, executeQuery } from './query';
import { textIntent } from './intent';
import { parseAndNormalizeGraph } from './graph-loader';
import { defaultFilters } from './url-state';
import { buildSearchIndex, search } from './search';
import { detectProjectLanguage, type D3Graph, type D3Node, type FilterOptions } from './types';

function node(id: string, over: Partial<D3Node> = {}): D3Node {
  return {
    id, display_name: id, symbol: id, full_path: '', relative_path: '', file_name: '',
    parent_folder: '', crate_name: '', is_libsignal: false, dependencies: [], dependents: [],
    kind: 'def', ...over,
  };
}

function graph(nodes: D3Node[], links: [string, string][] = []): D3Graph {
  for (const [s, t] of links) {
    nodes.find(n => n.id === s)!.dependencies.push(t);
    nodes.find(n => n.id === t)!.dependents.push(s);
  }
  return {
    nodes,
    links: links.map(([source, target]) => ({ source, target, type: 'inner' })),
    metadata: { total_nodes: nodes.length, total_edges: links.length, project_root: '', generated_at: '' },
  };
}

function filters(text: string): FilterWord[] {
  const parsed = parseWords(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value.filters;
}

/** IDs of the nodes of `g` that pass the filter words of `text`. */
function matching(g: D3Graph, text: string): string[] {
  const passes = compileFilterWords(filters(text), graphWordContext(g));
  return g.nodes.filter(passes).map(n => n.id);
}

describe('parseWords', () => {
  it('splits plain words from filter words, with comma alternatives', () => {
    expect(parseWords('lagrange  basis kind:theorem status:failed,unverified')).toEqual({
      ok: true,
      value: {
        plain: ['lagrange', 'basis'],
        filters: [
          { key: 'kind', values: ['theorem'] },
          { key: 'status', values: ['failed', 'unverified'] },
        ],
      },
    });
  });

  it('reads keys in any case and leaves other colons alone', () => {
    expect(parseWords('KIND:def edwards::decompress crate::foo probe:x')).toEqual({
      ok: true,
      value: { plain: ['edwards::decompress', 'crate::foo', 'probe:x'], filters: [{ key: 'kind', values: ['def'] }] },
    });
  });

  it('rejects an empty value, an unknown status and a level that is not a number', () => {
    expect(parseWords('kind:')).toEqual({ ok: false, error: 'kind: needs a value, for example kind:theorem' });
    expect(parseWords('status:done')).toMatchObject({ ok: false, error: expect.stringContaining('status:done is not a status') });
    expect(parseWords('level:x')).toMatchObject({ ok: false, error: expect.stringContaining('level:x is not a level') });
  });

  it('round-trips through formatWords', () => {
    for (const text of ['a b kind:lemma', 'module:field.rs file:*.lean level:0,1', 'crate:dalek status:trusted']) {
      const parsed = parseWords(text);
      expect(parsed.ok && parseWords(formatWords(parsed.value))).toEqual(parsed);
    }
  });
});

describe('filter words', () => {
  const g = graph([
    node('t', { kind: 'theorem', verification_status: 'verified', relative_path: 'SecureMessaging/AEAD/Defs.lean', file_name: 'Defs.lean' }),
    node('p', { kind: 'proof', verification_status: 'failed', relative_path: 'src/backend/serial/u64/field.rs', file_name: 'field.rs', crate_name: 'curve25519-dalek' }),
    node('d', { kind: 'def', relative_path: 'blueprint/Addition' }),
  ], [['t', 'p'], ['p', 'd']]);

  it('kind: matches the kind, and lemma means proof or theorem', () => {
    expect(matching(g, 'kind:theorem')).toEqual(['t']);
    expect(matching(g, 'kind:lemma')).toEqual(['t', 'p']);
    expect(matching(g, 'kind:def,proof')).toEqual(['p', 'd']);
  });

  it('status: is exact, and no status counts as unverified', () => {
    expect(matching(g, 'status:verified')).toEqual(['t']);
    expect(matching(g, 'status:unverified')).toEqual(['d']);
  });

  it('module: matches whole consecutive segments of the file path, without the extension', () => {
    expect(moduleSegments('a::B/c.d')).toEqual(['a', 'b', 'c', 'd']);
    expect(matching(g, 'module:SecureMessaging.AEAD')).toEqual(['t']);
    expect(matching(g, 'module:aead.defs')).toEqual(['t']);
    expect(matching(g, 'module:serial::u64::field')).toEqual(['p']);
    expect(matching(g, 'module:blueprint/Addition')).toEqual(['d']);
    // Not a whole segment, not consecutive, or the extension
    expect(matching(g, 'module:AEA')).toEqual([]);
    expect(matching(g, 'module:serial.field')).toEqual([]);
    expect(matching(g, 'module:lean')).toEqual([]);
  });

  it('file: is a glob on the file name, or on the path with a slash', () => {
    expect(matching(g, 'file:field.rs')).toEqual(['p']);
    expect(matching(g, 'file:*.lean')).toEqual(['t']);
    expect(matching(g, 'file:u64/field.rs')).toEqual(['p']);
  });

  it('crate: is a substring of the crate name', () => {
    expect(matching(g, 'crate:dalek')).toEqual(['p']);
  });

  it('level: uses the dependency levels of the Guide strip', () => {
    expect(Object.fromEntries(graphLevels(g))).toEqual({ d: 0, p: 1, t: 2 });
    expect(matching(g, 'level:0')).toEqual(['d']);
    expect(matching(g, 'level:1,2')).toEqual(['t', 'p']);
  });

  it('every word must pass', () => {
    expect(matching(g, 'kind:lemma status:failed')).toEqual(['p']);
    expect(matching(g, 'kind:lemma level:0')).toEqual([]);
  });

  it('merges cycles into one level', () => {
    const cyc = graph([node('a'), node('b'), node('c')], [['a', 'b'], ['b', 'a'], ['b', 'c']]);
    expect(Object.fromEntries(graphLevels(cyc))).toEqual({ a: 1, b: 1, c: 0 });
  });
});

describe('parseVerbQuery', () => {
  it('parses paths from <words> to <words>', () => {
    expect(parseVerbQuery('paths from module:edwards kind:exec to module:field')).toEqual({
      ok: true, value: { verb: 'paths', from: 'module:edwards kind:exec', to: 'module:field' },
    });
    expect(parseVerbQuery('Paths FROM encode TO decode')).toEqual({
      ok: true, value: { verb: 'paths', from: 'encode', to: 'decode' },
    });
  });

  it('is not a verb unless the text starts with paths from', () => {
    expect(parseVerbQuery('paths')).toBeNull();
    expect(parseVerbQuery('paths_from x')).toBeNull();
    expect(parseVerbQuery('find paths from a to b')).toBeNull();
  });

  it('gives an error for a missing side or a bad filter word', () => {
    const notYet = { ok: false, error: 'Not a query yet: paths from <words> to <words>' };
    expect(parseVerbQuery('paths from module:a')).toEqual(notYet);
    expect(parseVerbQuery('paths from to b')).toEqual(notYet);
    expect(parseVerbQuery('paths from a to')).toEqual(notYet);
    expect(parseVerbQuery('paths from a to status:done')).toMatchObject({ ok: false, error: expect.stringContaining('status:done') });
  });

  it('round-trips through formatVerbQuery', () => {
    const text = 'paths from module:edwards kind:exec to module:field';
    const parsed = parseVerbQuery(text);
    expect(parsed?.ok && formatVerbQuery(parsed.value)).toBe(text);
  });
});

describe('top', () => {
  const top = (n: number, words = '') => ({ verb: 'top', n, filters: words ? filters(words) : [] });

  it('parses top [N] by dependents [filter words]', () => {
    expect(parseVerbQuery('top 5 by dependents is:unfinished')).toEqual({ ok: true, value: top(5, 'is:unfinished') });
    expect(parseVerbQuery('TOP BY Dependents')).toEqual({ ok: true, value: top(10) });
    expect(parseVerbQuery('top 200 by dependents kind:lemma module:field'))
      .toEqual({ ok: true, value: top(200, 'kind:lemma module:field') });
  });

  it('is not a verb unless top is followed by a number, by, or nothing', () => {
    expect(parseVerbQuery('top_level')).toBeNull();
    expect(parseVerbQuery('top level')).toBeNull();
    expect(parseVerbQuery('stop 5 by dependents')).toBeNull();
  });

  it('gives an error for a bad N, a missing ranking or a plain word', () => {
    const notYet = { ok: false, error: 'Not a query yet: top [N] by dependents [filter words]' };
    expect(parseVerbQuery('top')).toEqual(notYet);
    expect(parseVerbQuery('top 5')).toEqual(notYet);
    expect(parseVerbQuery('top by callers')).toEqual(notYet);
    const range = { ok: false, error: 'top takes a number from 1 to 200' };
    expect(parseVerbQuery('top 0 by dependents')).toEqual(range);
    expect(parseVerbQuery('top 201 by dependents')).toEqual(range);
    expect(parseVerbQuery('top 5 by dependents field'))
      .toEqual({ ok: false, error: 'top takes filter words only, for example module:field' });
    expect(parseVerbQuery('top by dependents is:done')).toMatchObject({ ok: false, error: expect.stringContaining('is:done') });
  });

  it('round-trips through formatVerbQuery, with N written out', () => {
    for (const text of ['top 5 by dependents is:unfinished kind:lemma', 'top 10 by dependents']) {
      const parsed = parseVerbQuery(text);
      expect(parsed?.ok && formatVerbQuery(parsed.value)).toBe(text);
    }
    const parsed = parseVerbQuery('top by dependents');
    expect(parsed?.ok && formatVerbQuery(parsed.value)).toBe('top 10 by dependents');
  });

  it('ranks by unique transitive dependents, ties by ID, and counts the matches', () => {
    // c <- b <- a, and d <- a: c has two dependents, b and d one each
    const g = graph([node('a'), node('b'), node('c'), node('d', { kind: 'theorem' })],
      [['a', 'b'], ['b', 'c'], ['a', 'd']]);
    const result = runTop(g, top(2) as TopQuery);
    expect(result.ok && result.rows.map(r => [r.node.id, r.count])).toEqual([['c', 2], ['b', 1]]);
    expect(result.ok && result.total).toBe(4);
    const lemmas = runTop(g, top(5, 'kind:lemma') as TopQuery);
    expect(lemmas.ok && lemmas.rows.map(r => r.node.id)).toEqual(['d']);
  });

  it('gives the same rows as the Guide list it fills the search box with', () => {
    const g = parseAndNormalizeGraph(JSON.parse(readFileSync(
      resolve(__dirname, 'test-data/spqr-aeneas-search-cut.json'), 'utf8')));
    // The cut has no statuses: give every third node one
    const statuses = ['unverified', 'trusted', 'verified'] as const;
    g.nodes.forEach((n, i) => { n.verification_status = statuses[i % 3]; });
    const summary = buildGraphSummary(g);
    for (const list of [summary.unfinished, summary.assumptions, summary.keystones]) {
      const parsed = parseVerbQuery(list.query);
      if (!parsed?.ok || parsed.value.verb !== 'top') throw new Error(list.query);
      const result = runTop(g, parsed.value);
      expect(result.ok && result.rows.map(r => r.node.id)).toEqual(list.rows.map(r => r.id));
    }
    // The cut has unfinished nodes and lemmas, so the check is not vacuous
    expect(summary.unfinished.rows.length).toBe(5);
    expect(summary.assumptions.rows.length).toBe(5);
    expect(summary.keystones.rows.length).toBe(5);
  });
});

describe('is: words', () => {
  it('is:unfinished and is:assumption follow the Guide', () => {
    const g = graph([
      node('u', { verification_status: 'unverified' }),
      node('f', { verification_status: 'failed' }),
      node('none'),
      node('ax', { kind: 'axiom', verification_status: 'unverified' }),
      node('t', { verification_status: 'trusted' }),
    ]);
    expect(matching(g, 'is:unfinished')).toEqual(['u', 'f']);
    expect(matching(g, 'is:assumption')).toEqual(['ax', 't']);
    // status:unverified counts a node without a status, is:unfinished does not
    expect(matching(g, 'status:unverified')).toEqual(['u', 'none', 'ax']);
  });

  it('is:unused leaves out entry points, generated and hidden nodes, and self-calls', () => {
    const g = graph([
      node('caller', { kind: 'theorem' }),
      node('callee', { kind: 'theorem' }),
      node('entry', { is_entry_point: true }),
      node('step', { kind: 'theorem', is_generated: true }),
      node('aux', { is_hidden: true }),
      node('rec'),
    ], [['caller', 'callee'], ['rec', 'rec']]);
    // A lemma that only calls others is still unused
    expect(matching(g, 'is:unused')).toEqual(['caller', 'rec']);
  });

  it('is:unused counts callers on every link, whatever the edge filters show', () => {
    const g = graph([node('spec', { kind: 'spec' }), node('lemma', { kind: 'proof' })], [['spec', 'lemma']]);
    g.links[0].type = 'postcondition';
    expect(matching(g, 'is:unused')).toEqual(['spec']);
  });

  it('is:surface in Verus: public exec functions without requires or ensures', () => {
    const g = graph([
      node('open', { kind: 'exec', language: 'rust', is_public_api: true }),
      node('ensured', { kind: 'exec', language: 'rust', is_public_api: true }),
      node('private', { kind: 'exec', language: 'rust' }),
      node('lemma', { kind: 'proof', language: 'verus', is_public_api: true }),
      node('spec', { kind: 'spec', language: 'verus' }),
    ], [['ensured', 'spec']]);
    g.links[0].type = 'postcondition';
    expect(matching(g, 'is:surface')).toEqual(['open']);
  });

  it('is:surface in Aeneas: public Rust functions without a Lean translation', () => {
    const g = graph([
      node('open', { kind: 'exec', language: 'rust', is_public_api: true }),
      node('mapped', { kind: 'exec', language: 'rust', is_public_api: true, mapping_id: 'L.mapped' }),
      node('L.mapped', { kind: 'def', language: 'lean' }),
    ]);
    expect(matching(g, 'is:surface')).toEqual(['open']);
  });

  it('is:surface lists nothing without Verus or Lean nodes', () => {
    const g = graph([node('f', { kind: 'exec', language: 'rust', is_public_api: true })]);
    expect(matching(g, 'is:surface')).toEqual([]);
  });

  it('is:frontier lists the unfinished nodes whose dependencies are all done', () => {
    const g = graph([
      node('ready', { verification_status: 'unverified' }),
      node('blocked', { verification_status: 'failed' }),
      node('clean', { verification_status: 'transitively-verified' }),
      node('admit', { verification_status: 'trusted' }),
      node('caller', { verification_status: 'verified' }),
    ], [['ready', 'clean'], ['ready', 'admit'], ['blocked', 'ready'], ['caller', 'blocked']]);
    expect(matching(g, 'is:frontier')).toEqual(['ready']);
  });

  it('reads the facts of the node layer when given two layers', () => {
    const code = graph([node('a'), node('b')], [['a', 'b']]);
    const blueprint = graph([node('x'), node('b2')], [['x', 'b2']]);
    const passes = compileFilterWords(filters('is:unused'), graphWordContext(code, blueprint));
    expect([...code.nodes, ...blueprint.nodes].filter(passes).map(n => n.id)).toEqual(['a', 'x']);
  });
});

describe('Source and Sink with filter words', () => {
  const run = (g: D3Graph, source: string, sink: string, over: Partial<FilterOptions> = {}) => {
    const f: FilterOptions = {
      ...defaultFilters(), showTypes: true, showProjections: true, ...over, intent: textIntent(source, sink),
    };
    return executeQuery(compileQuery(f, detectProjectLanguage(g)), g).nodes.map(n => n.id).sort();
  };

  it('runs paths between two modules', () => {
    const g = graph([
      node('e1', { relative_path: 'src/edwards.rs' }),
      node('mid', { relative_path: 'src/scalar.rs' }),
      node('f1', { relative_path: 'src/backend/field.rs' }),
      node('other', { relative_path: 'src/ristretto.rs' }),
    ], [['e1', 'mid'], ['mid', 'f1'], ['other', 'f1']]);
    expect(run(g, 'module:edwards', 'module:field')).toEqual(['e1', 'f1', 'mid']);
    // Plain words narrow the side as before: a substring of the display name
    expect(run(g, 'e1 module:edwards', 'module:field')).toEqual(['e1', 'f1', 'mid']);
    expect(run(g, 'zz module:edwards', 'module:field')).toEqual([]);
  });

  it('runs paths between two modules of the Lean fixture', () => {
    const lean = parseAndNormalizeGraph(
      JSON.parse(readFileSync(resolve(__dirname, 'test-data/probe-lean-extract-cut.json'), 'utf8')),
    );
    expect(run(lean, 'module:SCKA.OppUniKEM kind:def', 'module:SCKA kind:structure')).toEqual([
      'probe:oppUniKemCKA.StA', 'probe:oppUniKemCKA.StB', 'probe:oppUniKemCKA.StateA',
      'probe:oppUniKemCKA.StateB', 'probe:oppUniKemCKA.initA', 'probe:oppUniKemCKA.initB',
    ]);
    expect(run(lean, 'module:CKA.FromKEM', 'module:OppUniKEM')).toEqual([]);
  });

  it('keeps one crate word on each side as the crate boundary query', () => {
    const g = graph([
      node('a1', { crate_name: 'a' }), node('a2', { crate_name: 'a' }), node('b1', { crate_name: 'b' }),
    ], [['a1', 'a2'], ['a2', 'b1']]);
    expect(run(g, 'crate:a', 'crate:b')).toEqual(['a2', 'b1']);
    // An empty comma value is dropped, as in the search box
    expect(run(g, 'crate:a,', 'crate:,b')).toEqual(['a2', 'b1']);
    // With another word it is a paths query
    expect(run(g, 'crate:a kind:def', 'crate:b')).toEqual(['a1', 'a2', 'b1']);
  });

  it('reads a text whose filter word does not parse as a plain pattern', () => {
    const g = graph([node('x'), node('y')], [['x', 'y']]);
    expect(run(g, 'status:done', '')).toEqual([]);
  });
});

describe('search with filter words', () => {
  const g = graph([
    node('A.lagrange_basis', { display_name: 'lagrange_basis', kind: 'theorem' }),
    node('A.lagrange_def', { display_name: 'lagrange_def', kind: 'def' }),
    node('B.other', { display_name: 'other', kind: 'theorem' }),
  ]);
  const index = buildSearchIndex(g);
  const ids = (query: string, accept?: (n: D3Node) => boolean) =>
    search(index, query, 20, accept).map(h => h.node.id);

  it('keeps only the hits the filter words accept', () => {
    const theorem = compileFilterWords(filters('kind:theorem'), graphWordContext(g));
    expect(ids('lagrange')).toEqual(['A.lagrange_basis', 'A.lagrange_def']);
    expect(ids('lagrange', theorem)).toEqual(['A.lagrange_basis']);
  });

  it('lists every accepted node by ID when the query has no words', () => {
    const theorem = compileFilterWords(filters('kind:theorem'), graphWordContext(g));
    expect(ids('', theorem)).toEqual(['A.lagrange_basis', 'B.other']);
    expect(ids('')).toEqual([]);
  });
});
