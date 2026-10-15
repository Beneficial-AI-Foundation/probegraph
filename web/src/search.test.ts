import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSearchIndex, search, tokenize } from './search';
import { parseAndNormalizeGraph } from './graph-loader';
import type { D3Link, D3Node } from './types';

function node(id: string, display_name = id.split(/[.:/]/).pop()!): D3Node {
  return {
    id, display_name, symbol: id, full_path: '', relative_path: '', file_name: '',
    parent_folder: '', crate_name: '', is_libsignal: false, kind: 'theorem',
    dependencies: [], dependents: [],
  } as D3Node;
}

const ids = (nodes: D3Node[], query: string, links: D3Link[] = []) =>
  search(buildSearchIndex({ nodes, links }), query).map(h => h.node.id);

describe('tokenize', () => {
  it('splits snake case and digits', () => {
    expect(tokenize('mul_by_pow_2')).toEqual(['mul', 'by', 'pow', '2']);
    expect(tokenize('send_ct2_chunk')).toEqual(['send', 'ct', '2', 'chunk']);
  });

  it('splits camel case and upper-case runs', () => {
    expect(tokenize('natToBinaryPoly')).toEqual(['nat', 'to', 'binary', 'poly']);
    expect(tokenize('GF16')).toEqual(['gf', '16']);
    expect(tokenize('HTTPServer')).toEqual(['http', 'server']);
    expect(tokenize('CoreOpsArithMulShared0GF16GF16')).toEqual(
      ['core', 'ops', 'arith', 'mul', 'shared', '0', 'gf', '16', 'gf', '16'],
    );
  });

  it('splits dotted, Rust and SCIP paths', () => {
    expect(tokenize('probe:spqr.chain.Chain.new')).toEqual(['probe', 'spqr', 'chain', 'chain', 'new']);
    expect(tokenize('Ct2Sampled::send_ct2_chunk')).toEqual(['ct', '2', 'sampled', 'send', 'ct', '2', 'chunk']);
    expect(tokenize('spqr/1.5.0/chain/&KeyHistory#impl<u32>#[KeyHistory]gc()')).toEqual(
      ['spqr', '1', '5', '0', 'chain', 'key', 'history', 'impl', 'u', '32', 'key', 'history', 'gc'],
    );
  });

  it('drops Lean guillemets and keeps non-Latin letters', () => {
    expect(tokenize('«Spqr».Chain.«term_+_»')).toEqual(['spqr', 'chain', 'term']);
    expect(tokenize('MlkemParams.dᵤ_le_12')).toEqual(['mlkem', 'params', 'd', 'ᵤ', 'le', '12']);
  });

  it('returns nothing for punctuation only', () => {
    expect(tokenize('  ::_. ')).toEqual([]);
  });
});

describe('search', () => {
  it('needs every query token to match some field', () => {
    const nodes = [node('A.send_key'), node('A.send_ct')];
    expect(ids(nodes, 'send key')).toEqual(['A.send_key']);
    expect(ids(nodes, 'send nothing')).toEqual([]);
    expect(ids(nodes, ' :: ')).toEqual([]);
  });

  it('ranks an exact token over a prefix over a substring', () => {
    const nodes = [node('A.subkeyed'), node('A.keyed'), node('A.key')];
    expect(ids(nodes, 'key')).toEqual(['A.key', 'A.keyed', 'A.subkeyed']);
  });

  it('ranks a name match over a path match over a statement match', () => {
    const nodes = [
      node('Chain.other_lemma'),
      node('Misc.uses_lemma'),
      node('Misc.chain_lemma'),
      node('Misc.Chain', 'Chain'),
    ];
    // uses_lemma mentions Chain in its statement
    const links: D3Link[] = [{ source: 'Misc.uses_lemma', target: 'Misc.Chain', type: 'inner', role: 'type' }];
    expect(ids(nodes, 'chain lemma', links)).toEqual(['Misc.chain_lemma', 'Chain.other_lemma', 'Misc.uses_lemma']);
  });

  it('indexes statement names from type links and Verus pre/postconditions only', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d'), node('Target', 'xyzzy')];
    const links: D3Link[] = [
      { source: 'a', target: 'Target', type: 'inner', role: 'both' },
      { source: 'b', target: 'Target', type: 'precondition' },
      { source: 'c', target: 'Target', type: 'postcondition' },
      { source: 'd', target: 'Target', type: 'inner', role: 'term' },
    ];
    expect(ids(nodes, 'xyzzy', links)).toEqual(['Target', 'a', 'b', 'c']);
  });

  it('puts the whole query equal to the ID first, then equal to the display name', () => {
    const nodes = [node('probe:X.new_spec'), node('probe:X.new'), node('Y.new_thing', 'X.new'), node('Z.x_new')];
    expect(ids(nodes, 'probe:X.new')[0]).toBe('probe:X.new');
    // Without the probe: scheme; Y.new_thing has the query as its display name
    expect(ids(nodes, 'x.new').slice(0, 2)).toEqual(['probe:X.new', 'Y.new_thing']);
    // x_new has the same tokens as X.new, but neither its ID nor its name equals the query
    expect(ids(nodes, 'X.new')).toEqual(['probe:X.new', 'Y.new_thing', 'Z.x_new', 'probe:X.new_spec']);
  });

  it('finds a camel-case name or ID typed in lowercase', () => {
    const nodes = [node('probe:spqr.chain.KeyHistory'), node('probe:spqr.math.natToBinaryPoly')];
    expect(ids(nodes, 'keyhistory')).toEqual(['probe:spqr.chain.KeyHistory']);
    expect(ids(nodes, 'nattobinarypoly')).toEqual(['probe:spqr.math.natToBinaryPoly']);
    expect(ids(nodes, 'natToBinarypoly')).toEqual(['probe:spqr.math.natToBinaryPoly']);
    expect(ids(nodes, 'spqr.chain.keyhistory')).toEqual(['probe:spqr.chain.KeyHistory']);
    expect(ids(nodes, 'probe:spqr.chain.keyhistory')).toEqual(['probe:spqr.chain.KeyHistory']);
  });

  it('indexes statement names outside the graph by their ID', () => {
    const nodes = [node('a'), { ...node('b'), statement_externals: ['probe:Lean.ParserDescr'] }];
    expect(ids(nodes, 'parser descr')).toEqual(['b']);
    const lean = parseAndNormalizeGraph(
      JSON.parse(readFileSync(resolve(__dirname, 'test-data', 'probe-lean-extract-cut.json'), 'utf8')),
    );
    expect(search(buildSearchIndex(lean), 'stateTrun ParserDescr').map(h => h.node.id))
      .toEqual(['probe:Parser.Attr.stateTrun', 'probe:Parser.Attr.stateTrun_proc']);
  });

  it('ranks by the position in the name, also for a segment match or a repeated word', () => {
    expect(ids([node('A.old_keyhistory_gc'), node('A.KeyHistory_gc')], 'keyhistory gc'))
      .toEqual(['A.KeyHistory_gc', 'A.old_keyhistory_gc']);
    expect(ids([node('A.foo_foo_foo_key'), node('A.bar_baz_key')], 'key'))
      .toEqual(['A.bar_baz_key', 'A.foo_foo_foo_key']);
    // A word and a segment match at the same cost: the earlier one counts
    expect(ids([node('A.old_keyhole'), node('A.KeyHistory_keyhole')], 'keyh'))
      .toEqual(['A.KeyHistory_keyhole', 'A.old_keyhole']);
    expect(ids([node('A.old_keyhistory'), node('A.KeyHistory_keyhistory')], 'keyhistory'))
      .toEqual(['A.KeyHistory_keyhistory', 'A.old_keyhistory']);
  });

  it('breaks ties by name position, then name length, then ID', () => {
    const nodes = [node('A.spec_of_key'), node('A.key_spec_long'), node('B.key_spec'), node('A.key_spec')];
    expect(ids(nodes, 'key spec')).toEqual(['A.key_spec', 'B.key_spec', 'A.key_spec_long', 'A.spec_of_key']);
  });

  it('stops at the limit', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => node(`A.lemma_${i}`));
    const index = buildSearchIndex({ nodes, links: [] });
    expect(search(index, 'lemma')).toHaveLength(20);
    expect(search(index, 'lemma', 3)).toHaveLength(3);
  });
});

// Queries a user would type for SPQR, written before the ranking, with the
// declarations they mean. The graph is the full SPQR extract (Rust and Lean)
// with only names, kinds and paths, so every atom stays a distractor. It has
// no dependencies, so statement names play no part.
describe('SPQR query fixture', () => {
  const load = (f: string) => JSON.parse(readFileSync(resolve(__dirname, 'test-data', f), 'utf8'));
  const graph = parseAndNormalizeGraph(load('spqr-aeneas-search-cut.json'));
  const queries: { query: string; expected: string[] }[] = load('spqr-search-queries.json');
  const index = buildSearchIndex(graph);

  it.each(queries)('finds $query in the top 5', ({ query, expected }) => {
    const top = search(index, query, 5).map(h => h.node.id);
    expect(top.filter(id => expected.includes(id))).not.toEqual([]);
  });
});
