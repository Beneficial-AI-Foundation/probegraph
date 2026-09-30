import { describe, it, expect } from 'vitest';
import { convertAtomDictToD3Graph, pickSourceConfig } from './graph-loader';
import { ProbeAtom, SourceConfig } from './types';

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
});
