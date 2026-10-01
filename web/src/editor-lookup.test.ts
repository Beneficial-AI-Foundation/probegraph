import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildLocationIndex, nodesInFile, resolveCursor, type CursorQuery, type Resolution } from './editor-lookup';
import { parseAndNormalizeGraph } from './graph-loader';

const load = (path: string) =>
  buildLocationIndex(parseAndNormalizeGraph(JSON.parse(readFileSync(resolve(__dirname, path), 'utf8'))));

// Fixtures are described in graph-loader.test.ts
const lean = load('test-data/probe-lean-extract-cut.json');
const merged = load('test-data/probe-merged-rust-lean-cut.json');
const quicksort = load('../../vscode/test-fixtures/quicksort/.vscode/call_graph_index.json');

const OPP = 'SecureMessaging/SCKA/OppUniKEM/Construction.lean';
const KEM = 'SecureMessaging/CKA/FromKEM/Construction.lean';

/** The resolution with nodes replaced by their ids. */
function ids(r: Resolution) {
  if (r.kind === 'match') return { kind: r.kind, id: r.node.id, evidence: r.evidence };
  if (r.kind === 'ambiguous') return { kind: r.kind, ids: r.candidates.map(n => n.id).sort() };
  return r;
}
const at = (index: typeof lean, q: CursorQuery) => ids(resolveCursor(index, q));
const sym = (name: string, ...containers: string[]) => ({ name, containers });

describe('resolveCursor by line', () => {
  it('picks the innermost range', () => {
    expect(at(quicksort, { graphPath: 'src/lib.rs', line: 20 })).toEqual({ kind: 'match', id: expect.stringContaining('partition'), evidence: 'line' });
  });

  it('prefers a structure over its hidden generated projections', () => {
    // line 156 is the field `t : ℕ` inside `structure StateB`
    expect(at(lean, { graphPath: OPP, line: 156 })).toEqual({ kind: 'match', id: 'probe:oppUniKemCKA.StateB', evidence: 'line' });
  });

  it('is ambiguous for two declarations on the same range', () => {
    expect(at(lean, { graphPath: 'ToVCVio/Control/SimpAttr.lean', line: 26 })).toEqual({
      kind: 'ambiguous',
      ids: ['probe:Parser.Attr.stateTrun', 'probe:Parser.Attr.stateTrun_proc'],
    });
  });

  it('reports a line outside every declaration', () => {
    expect(at(lean, { graphPath: OPP, line: 165 })).toEqual({ kind: 'not-indexed', reason: 'line' });
  });
});

describe('resolveCursor files', () => {
  it('keeps files with the same name apart', () => {
    expect(at(lean, { graphPath: KEM, line: 83, symbol: sym('initA') })).toMatchObject({ id: 'probe:kemCKA.initA' });
    expect(at(lean, { graphPath: OPP, line: 186, symbol: sym('initA') })).toMatchObject({ id: 'probe:oppUniKemCKA.initA' });
  });

  it('does not match a path by its file name', () => {
    expect(at(lean, { graphPath: 'Construction.lean', line: 83 })).toEqual({ kind: 'not-indexed', reason: 'file' });
    expect(at(lean, { graphPath: 'Other/SCKA/OppUniKEM/Construction.lean', line: 156 })).toEqual({ kind: 'not-indexed', reason: 'file' });
  });

  it('indexes only nodes with a location', () => {
    expect(nodesInFile(quicksort, 'src/lib.rs').map(n => n.display_name).sort()).toEqual(['partition', 'quicksort', 'test_quicksort']);
    expect(nodesInFile(quicksort, '')).toEqual([]);
  });
});

describe('resolveCursor with the enclosing symbol', () => {
  it('confirms the line match by name', () => {
    expect(at(lean, { graphPath: OPP, line: 156, symbol: sym('StateB', 'oppUniKemCKA') })).toEqual({
      kind: 'match', id: 'probe:oppUniKemCKA.StateB', evidence: 'symbol+line',
    });
  });

  it('picks a declaration that shares its range by name', () => {
    expect(at(lean, { graphPath: 'ToVCVio/Control/SimpAttr.lean', line: 26, symbol: sym('stateTrun') })).toMatchObject({ id: 'probe:Parser.Attr.stateTrun' });
  });

  it('matches a hidden node when the symbol names it', () => {
    expect(at(lean, { graphPath: OPP, line: 156, symbol: sym('t', 'StateB') })).toMatchObject({ id: 'probe:oppUniKemCKA.StateB.t' });
  });

  it('finds a declaration by name after its lines moved', () => {
    expect(at(lean, { graphPath: OPP, line: 400, symbol: sym('initB') })).toEqual({
      kind: 'match', id: 'probe:oppUniKemCKA.initB', evidence: 'symbol',
    });
  });

  it('reports a renamed declaration instead of the old one on its lines', () => {
    expect(at(lean, { graphPath: OPP, line: 186, symbol: sym('initAlice') })).toEqual({ kind: 'not-indexed', reason: 'symbol' });
    expect(at(lean, { graphPath: OPP, line: 400, symbol: sym('initAlice') })).toEqual({ kind: 'not-indexed', reason: 'symbol' });
  });

  it('uses Lean namespaces and dotted names to choose between fields', () => {
    expect(at(lean, { graphPath: OPP, line: 400, symbol: sym('t') })).toEqual({
      kind: 'ambiguous', ids: ['probe:oppUniKemCKA.StateA.t', 'probe:oppUniKemCKA.StateB.t'],
    });
    expect(at(lean, { graphPath: OPP, line: 400, symbol: sym('t', 'oppUniKemCKA', 'StateA') })).toMatchObject({ id: 'probe:oppUniKemCKA.StateA.t' });
    expect(at(lean, { graphPath: OPP, line: 400, symbol: sym('StateA.t', 'oppUniKemCKA') })).toMatchObject({ id: 'probe:oppUniKemCKA.StateA.t' });
  });

  it('uses impl blocks to choose between Rust methods', () => {
    const tryFrom = (impl: string) => at(merged, { graphPath: 'src/identity_key.rs', line: 999, symbol: sym('try_from', impl) });
    expect(tryFrom('impl TryFrom<&[u8]> for IdentityKey')).toMatchObject({
      id: 'probe:libsignal-protocol/0.1.0/identity_key/impl<&[u8]>#[IdentityKey][`TryFrom<&[u8]>`]try_from()',
    });
    expect(tryFrom('impl TryFrom<&[u8]> for IdentityKeyPair')).toMatchObject({
      id: 'probe:libsignal-protocol/0.1.0/identity_key/impl<&[u8]>#[IdentityKeyPair][`TryFrom<&[u8]>`]try_from()',
    });
    expect(tryFrom('impl TryFrom<PrivateKey> for IdentityKeyPair')).toMatchObject({
      id: 'probe:libsignal-protocol/0.1.0/identity_key/impl<PrivateKey>#[IdentityKeyPair][`TryFrom<PrivateKey>`]try_from()',
    });
  });

  it('leaves impls that differ only by a reference to the line', () => {
    const from = (line: number) => at(merged, {
      graphPath: 'src/state/session.rs', line, symbol: sym('from', 'impl From<&SessionState> for SessionStructure'),
    });
    expect(from(999)).toMatchObject({ kind: 'ambiguous' });
    expect(from(638)).toEqual({
      kind: 'match',
      id: 'probe:libsignal-protocol/0.1.0/state/session/impl<&SessionState>#[SessionStructure][`From<&SessionState>`]from()',
      evidence: 'symbol+line',
    });
  });
});
