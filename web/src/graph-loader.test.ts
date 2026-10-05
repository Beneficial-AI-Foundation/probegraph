import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { convertAtomDictToD3Graph, parseAndNormalizeGraph, pickSourceConfig, validateGraph } from './graph-loader';
import { D3Graph, ProbeAtom, SourceConfig } from './types';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(__dirname, 'test-data', name), 'utf8'));

const atom = (over: Partial<ProbeAtom>): ProbeAtom => ({
  "display-name": 'x',
  dependencies: [],
  "code-text": null,
  "code-path": 'X.lean',
  "code-module": 'X',
  kind: 'theorem',
  language: 'lean',
  ...over,
});

describe('convertAtomDictToD3Graph external dependencies', () => {
  const atoms: Record<string, ProbeAtom> = {
    'probe:caller': atom({
      "display-name": 'caller',
      dependencies: ['probe:helper'],
      "term-dependencies-external": ['probe:other.theorem', 'probe:Unresolved.name'],
      "type-dependencies-external": ['probe:other.Type'],
    }),
    'probe:helper': atom({ "display-name": 'helper' }),
    'probe:other.theorem': atom({ "display-name": 'other.theorem', "code-module": 'Other' }),
    'probe:other.Type': atom({ "display-name": 'other.Type', "code-module": 'Other' }),
  };
  const graph = convertAtomDictToD3Graph(atoms);

  it('adds edges for external deps that resolve in the graph', () => {
    const targets = graph.links
      .filter(l => l.source === 'probe:caller')
      .map(l => l.target)
      .sort();
    expect(targets).toEqual(['probe:helper', 'probe:other.Type', 'probe:other.theorem']);
  });

  it('drops external deps that do not resolve', () => {
    expect(graph.links.some(l => l.target === 'probe:Unresolved.name')).toBe(false);
  });

  it('includes resolved externals in node dependencies and dependents', () => {
    const caller = graph.nodes.find(n => n.id === 'probe:caller')!;
    expect([...caller.dependencies].sort())
      .toEqual(['probe:helper', 'probe:other.Type', 'probe:other.theorem']);
    const target = graph.nodes.find(n => n.id === 'probe:other.theorem')!;
    expect(target.dependents).toEqual(['probe:caller']);
  });

  it('does not duplicate an edge already present in dependencies', () => {
    const dup: Record<string, ProbeAtom> = {
      'probe:a': atom({
        dependencies: ['probe:b'],
        "term-dependencies-external": ['probe:b'],
      }),
      'probe:b': atom({}),
    };
    const g = convertAtomDictToD3Graph(dup);
    expect(g.links.filter(l => l.source === 'probe:a' && l.target === 'probe:b')).toHaveLength(1);
  });
});

describe('convertAtomDictToD3Graph edge types across languages', () => {
  const rustExec = (over: Partial<ProbeAtom>) => atom({
    kind: 'exec', language: 'rust', "code-path": 'src/edwards.rs', ...over,
  });
  const verusSpec = (over: Partial<ProbeAtom>) => atom({
    kind: 'spec', language: 'verus', "code-path": 'src/specs.rs', ...over,
  });

  it('keeps requires/ensures locations between rust exec and verus spec atoms', () => {
    const atoms: Record<string, ProbeAtom> = {
      'probe:neg': rustExec({
        dependencies: ['probe:well_formed', 'probe:edwards_neg'],
        "dependencies-with-locations": [
          { "code-name": 'probe:well_formed', line: 1, location: 'precondition' },
          { "code-name": 'probe:well_formed', line: 2, location: 'postcondition' },
          { "code-name": 'probe:edwards_neg', line: 3, location: 'inner' },
        ],
      }),
      'probe:well_formed': verusSpec({}),
      'probe:edwards_neg': verusSpec({}),
    };
    const types = convertAtomDictToD3Graph(atoms).links
      .map(l => `${l.target} ${l.type}`)
      .sort();
    expect(types).toEqual([
      'probe:edwards_neg inner',
      'probe:well_formed postcondition',
      'probe:well_formed precondition',
    ]);
  });

  it('still maps rust exec atoms to lean translations', () => {
    const atoms: Record<string, ProbeAtom> = {
      'probe:neg': rustExec({
        dependencies: ['probe:Lean.neg'],
        "dependencies-with-locations": [
          { "code-name": 'probe:Lean.neg', line: 1, location: 'inner' },
        ],
      }),
      'probe:Lean.neg': atom({ kind: 'def', language: 'lean' }),
    };
    expect(convertAtomDictToD3Graph(atoms).links.map(l => l.type)).toEqual(['mapping']);
  });
});

describe('convertAtomDictToD3Graph entry points', () => {
  const atoms: Record<string, ProbeAtom> = {
    // Public-API Rust atom with a Lean translation: both are entry points
    'probe:pub_fn': atom({
      "display-name": 'pub_fn', kind: 'exec', language: 'rust',
      "is-public-api": true,
      "translation-name": 'probe:pub_fn_lean',
    }),
    'probe:pub_fn_lean': atom({ "display-name": 'pub_fn_lean', kind: 'def' }),
    // Public-API atom whose translation target is not in the graph
    'probe:pub_orphan': atom({
      "display-name": 'pub_orphan', kind: 'exec', language: 'rust',
      "is-public-api": true,
      "translation-name": 'probe:missing',
    }),
    // Private Rust atom with a translation: neither is an entry point
    'probe:private_fn': atom({
      "display-name": 'private_fn', kind: 'exec', language: 'rust',
      "is-public-api": false,
      "translation-name": 'probe:private_fn_lean',
    }),
    'probe:private_fn_lean': atom({ "display-name": 'private_fn_lean', kind: 'def' }),
    // @[blueprint] Lean atom
    'probe:blueprint_thm': atom({
      "display-name": 'blueprint_thm',
      attributes: ['simp', 'blueprint'],
    }),
    // Other attributes do not qualify
    'probe:simp_thm': atom({ "display-name": 'simp_thm', attributes: ['simp'] }),
  };
  const graph = convertAtomDictToD3Graph(atoms);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));

  it('flags public-API atoms as entry points', () => {
    expect(byId.get('probe:pub_fn')!.is_entry_point).toBe(true);
    expect(byId.get('probe:pub_orphan')!.is_entry_point).toBe(true);
  });

  it('flags the Lean translation target of a public-API atom (Aeneas join)', () => {
    expect(byId.get('probe:pub_fn_lean')!.is_entry_point).toBe(true);
  });

  it('does not flag private atoms or their translations', () => {
    expect(byId.get('probe:private_fn')!.is_entry_point).toBeUndefined();
    expect(byId.get('probe:private_fn_lean')!.is_entry_point).toBeUndefined();
  });

  it('flags blueprint-attributed atoms and only those', () => {
    expect(byId.get('probe:blueprint_thm')!.is_entry_point).toBe(true);
    expect(byId.get('probe:simp_thm')!.is_entry_point).toBeUndefined();
  });

  it('tolerates malformed attributes without crashing or flagging', () => {
    const malformed: Record<string, ProbeAtom> = {
      'probe:bad': atom({ "display-name": 'bad', attributes: 'blueprint' as unknown as string[] }),
    };
    const g = convertAtomDictToD3Graph(malformed);
    expect(g.nodes[0].is_entry_point).toBeUndefined();
  });

  it('carries is_public_api and attributes through conversion', () => {
    expect(byId.get('probe:pub_fn')!.is_public_api).toBe(true);
    expect(byId.get('probe:private_fn')!.is_public_api).toBe(false);
    expect(byId.get('probe:blueprint_thm')!.attributes).toEqual(['simp', 'blueprint']);
    expect(byId.get('probe:pub_fn_lean')!.attributes).toBeUndefined();
  });
});

describe('pickSourceConfig', () => {
  const configs: SourceConfig[] = [
    {
      github_url: 'https://github.com/org/importer',
      ref: 'aaa', path_prefix: '', language: 'lean', package: 'Importer',
    },
    {
      github_url: 'https://github.com/org/imported',
      ref: 'bbb', path_prefix: '', language: 'lean', package: 'Imported',
    },
    {
      github_url: 'https://github.com/org/rust-crate',
      ref: 'ccc', path_prefix: 'rust-crate', language: 'rust', package: 'rust-crate',
    },
  ];

  it('matches the package of the node path root, not the first same-language input', () => {
    expect(pickSourceConfig(configs, 'lean', 'Imported/Sub/File.lean')?.github_url)
      .toBe('https://github.com/org/imported');
  });

  it('strips .lean from a root-level file when matching', () => {
    expect(pickSourceConfig(configs, 'lean', 'Importer.lean')?.github_url)
      .toBe('https://github.com/org/importer');
  });

  it('falls back to the first language match when no package matches', () => {
    expect(pickSourceConfig(configs, 'lean', 'Other/File.lean')?.github_url)
      .toBe('https://github.com/org/importer');
  });

  it('only considers configs of the node language', () => {
    expect(pickSourceConfig(configs, 'rust', 'src/lib.rs')?.github_url)
      .toBe('https://github.com/org/rust-crate');
    expect(pickSourceConfig(configs, undefined, 'Imported/File.lean')).toBeUndefined();
  });
});

describe('convertAtomDictToD3Graph statement / body-or-proof roles', () => {
  const roleOf = (g: ReturnType<typeof convertAtomDictToD3Graph>, s: string, t: string) =>
    g.links.filter(l => l.source === s && l.target === t).map(l => l.role);

  it('tags inner links type, term or both from the split arrays', () => {
    const g = convertAtomDictToD3Graph({
      'probe:a': atom({
        dependencies: ['probe:t', 'probe:p', 'probe:b', 'probe:none'],
        "type-dependencies": ['probe:t', 'probe:b'],
        "term-dependencies": ['probe:p', 'probe:b'],
      }),
      'probe:t': atom({}),
      'probe:p': atom({}),
      'probe:b': atom({}),
      'probe:none': atom({}),
    });
    expect(roleOf(g, 'probe:a', 'probe:t')).toEqual(['type']);
    expect(roleOf(g, 'probe:a', 'probe:p')).toEqual(['term']);
    expect(roleOf(g, 'probe:a', 'probe:b')).toEqual(['both']);
    // In dependencies but in neither array: no role
    expect(roleOf(g, 'probe:a', 'probe:none')).toEqual([undefined]);
    expect(g.links.every(l => l.type === 'inner')).toBe(true);
  });

  it('merges a repeated dependency into one link', () => {
    const g = convertAtomDictToD3Graph({
      'probe:a': atom({
        dependencies: ['probe:b', 'probe:b'],
        "type-dependencies": ['probe:b'],
        "term-dependencies": ['probe:b'],
      }),
      'probe:b': atom({}),
    });
    expect(roleOf(g, 'probe:a', 'probe:b')).toEqual(['both']);
    const node = (id: string) => g.nodes.find(n => n.id === id)!;
    expect(node('probe:a').dependencies).toEqual(['probe:b']);
    expect(node('probe:b').dependents).toEqual(['probe:a']);
  });

  it('tags inner links from dependencies-with-locations, but not pre/postcondition links', () => {
    const g = convertAtomDictToD3Graph({
      'probe:a': atom({
        dependencies: ['probe:t', 'probe:p'],
        "dependencies-with-locations": [
          { "code-name": 'probe:t', location: 'inner', line: 1 },
          { "code-name": 'probe:p', location: 'precondition', line: 2 },
        ],
        "type-dependencies": ['probe:t', 'probe:p'],
        "term-dependencies": [],
      }),
      'probe:t': atom({}),
      'probe:p': atom({}),
    });
    const links = (t: string) => g.links
      .filter(l => l.source === 'probe:a' && l.target === t)
      .map(l => [l.type, l.role]);
    expect(links('probe:t')).toEqual([['inner', 'type']]);
    expect(links('probe:p')).toEqual([['precondition', undefined]]);
  });

  it('merges repeated call sites into one link per target and type', () => {
    const g = convertAtomDictToD3Graph({
      'probe:a': atom({
        dependencies: ['probe:b'],
        "dependencies-with-locations": [
          { "code-name": 'probe:b', location: 'inner', line: 1 },
          { "code-name": 'probe:b', location: 'inner', line: 5 },
          { "code-name": 'probe:b', location: 'precondition', line: 2 },
        ],
      }),
      'probe:b': atom({}),
    });
    expect(g.links.map(l => l.type).sort()).toEqual(['inner', 'precondition']);
  });

  it('gives no role when a split array is absent, and reads empty arrays as no edges of that role', () => {
    const g = convertAtomDictToD3Graph({
      'probe:absent': atom({ dependencies: ['probe:x'], "type-dependencies": ['probe:x'] }),
      'probe:empty': atom({
        dependencies: ['probe:x'],
        "type-dependencies": [],
        "term-dependencies": ['probe:x'],
      }),
      'probe:x': atom({}),
    });
    expect(roleOf(g, 'probe:absent', 'probe:x')).toEqual([undefined]);
    expect(roleOf(g, 'probe:empty', 'probe:x')).toEqual(['term']);
  });

  it('classifies resolved externals from the external split arrays', () => {
    const g = convertAtomDictToD3Graph({
      'probe:a': atom({
        "type-dependencies-external": ['probe:other.Type', 'probe:other.both'],
        "term-dependencies-external": ['probe:other.thm', 'probe:other.both'],
      }),
      // probe-lean omits an external array when it is empty
      'probe:only-term': atom({ "term-dependencies-external": ['probe:other.thm'] }),
      'probe:only-type': atom({ "type-dependencies-external": ['probe:other.Type'] }),
      'probe:other.Type': atom({}),
      'probe:other.thm': atom({}),
      'probe:other.both': atom({}),
    });
    expect(roleOf(g, 'probe:a', 'probe:other.Type')).toEqual(['type']);
    expect(roleOf(g, 'probe:a', 'probe:other.thm')).toEqual(['term']);
    expect(roleOf(g, 'probe:a', 'probe:other.both')).toEqual(['both']);
    expect(roleOf(g, 'probe:only-term', 'probe:other.thm')).toEqual(['term']);
    expect(roleOf(g, 'probe:only-type', 'probe:other.Type')).toEqual(['type']);
  });

  it('combines the internal and external roles of a name in both splits', () => {
    const g = convertAtomDictToD3Graph({
      'probe:a': atom({
        dependencies: ['probe:x'],
        "type-dependencies": ['probe:x'],
        "term-dependencies": [],
        "term-dependencies-external": ['probe:x'],
      }),
      'probe:x': atom({}),
    });
    expect(roleOf(g, 'probe:a', 'probe:x')).toEqual(['both']);
  });

  it('gives a spec link the role of the parallel inner link', () => {
    const g = convertAtomDictToD3Graph({
      'probe:thm': atom({
        dependencies: ['probe:def'],
        "type-dependencies": ['probe:def'],
        "term-dependencies": [],
      }),
      // @[primary_spec] fallback: the spec comes from the proof
      'probe:fallback': atom({
        dependencies: ['probe:def'],
        "type-dependencies": [],
        "term-dependencies": ['probe:def'],
      }),
      'probe:nosplit': atom({ dependencies: ['probe:def'] }),
      'probe:def': atom({ kind: 'def', specs: ['probe:thm', 'probe:fallback', 'probe:nosplit'] }),
    });
    const links = (s: string) => g.links
      .filter(l => l.source === s && l.target === 'probe:def')
      .map(l => [l.type, l.role]).sort();
    expect(links('probe:thm')).toEqual([['inner', 'type'], ['spec', 'type']]);
    expect(links('probe:fallback')).toEqual([['inner', 'term'], ['spec', 'term']]);
    expect(links('probe:nosplit')).toEqual([['inner', undefined], ['spec', undefined]]);
  });

  it('takes the spec role from external arrays when the def was external to the theorem', () => {
    // After a merge of overlapping inputs: thm kept from a project without def
    const g = convertAtomDictToD3Graph({
      'probe:thm': atom({
        "type-dependencies": [],
        "term-dependencies": [],
        "type-dependencies-external": ['probe:def'],
      }),
      'probe:def': atom({ kind: 'def', specs: ['probe:thm'] }),
    });
    const links = g.links.filter(l => l.source === 'probe:thm' && l.target === 'probe:def');
    expect(links.map(l => [l.type, l.role]).sort()).toEqual([['inner', 'type'], ['spec', 'type']]);
  });
});

// Cut from secure-messaging's probe-lean extract at 061a94e: OppUniKEM StateA,
// StateB (with their projections) and nearby defs, kemCKA's first four atoms,
// and two Parser.Attr atoms sharing a range
const leanExtract = fixture('probe-lean-extract-cut.json');
// Cut from secure-messaging's merged_etm_libsignal.json: libsignal's
// identity_key.rs, the two SessionStructure::from impls, three Lean atoms
const mergedExtract = fixture('probe-merged-rust-lean-cut.json');

describe('parseAndNormalizeGraph flags and provenance', () => {
  const graph = parseAndNormalizeGraph(leanExtract);
  const node = (id: string) => graph.nodes.find(n => n.id === id)!;

  it('keeps is-hidden and is-lean-generated', () => {
    expect(node('probe:oppUniKemCKA.StateB.t')).toMatchObject({ is_hidden: true, is_generated: true });
    expect(node('probe:oppUniKemCKA.StateB').is_hidden).toBeUndefined();
    expect(node('probe:oppUniKemCKA.StateB').is_generated).toBeUndefined();
  });

  it('records when and at which commit the extract was made', () => {
    expect(graph.metadata.extracted_at).toBe('2026-09-30T11:36:52Z');
    expect(graph.metadata.source_commit).toBe('061a94e67c2369c1612ca243a15e3ea1f2aef1ff');
  });

  it('records neither for a merge, whose inputs have different commits', () => {
    const merged = parseAndNormalizeGraph(mergedExtract);
    expect(merged.metadata.extracted_at).toBeUndefined();
    expect(merged.metadata.source_commit).toBeUndefined();
    expect(merged.metadata.source_configs).toHaveLength(2);
  });
});

describe('validateGraph', () => {
  const valid = (): D3Graph => parseAndNormalizeGraph(leanExtract);

  it('accepts real extracts', () => {
    expect(validateGraph(valid())).toEqual([]);
    expect(validateGraph(parseAndNormalizeGraph(mergedExtract))).toEqual([]);
  });

  it('rejects JSON that is not a graph', () => {
    expect(validateGraph(parseAndNormalizeGraph({ name: 'package.json' }))).toEqual([
      'no nodes array: not a format probegraph reads',
    ]);
    expect(validateGraph(null)).toEqual(['not an object']);
  });

  it('reports duplicate and missing ids', () => {
    const g = valid();
    g.nodes.push({ ...g.nodes[0] }, { ...g.nodes[0], id: '' });
    expect(validateGraph(g)).toEqual([`duplicate node id ${g.nodes[0].id}`, `node ${g.nodes.length - 1} has no id`]);
  });

  it('reports links that mostly point nowhere', () => {
    const g = valid();
    g.links = g.links.map(l => ({ ...l, target: 'probe:gone' }));
    expect(validateGraph(g)).toEqual([`${g.links.length} of ${g.links.length} links have an unknown endpoint`]);
  });
});
