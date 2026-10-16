import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compileFilterWords, formatVerbQuery, formatWords, graphLevels, graphWordContext,
  moduleSegments, parseVerbQuery, parseWords, type FilterWord,
} from './query-words';
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
