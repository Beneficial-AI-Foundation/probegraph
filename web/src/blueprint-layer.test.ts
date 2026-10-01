import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAndNormalizeGraph, convertAtomDictToD3Graph } from './graph-loader';
import { compileQuery, executeQuery } from './query';
import { defaultFilters } from './url-state';
import { blueprintNodeDetailsHtml, blueprintBackrefHtml, githubIssueUrl } from './blueprint-details';
import { D3Graph, FilterOptions, ProbeAtom, detectProjectLanguage } from './types';
import { focusIntent } from './intent';

// probe-leanblueprint examples/verso-blueprint-project-template/extract.json
// at e1e5871: 9 node atoms (bound, planned-only, decl-missing), 9 Lean atoms
const FIXTURE = resolve(__dirname, 'test-data/blueprint-project-template.json');
const graph = parseAndNormalizeGraph(JSON.parse(readFileSync(FIXTURE, 'utf8')));
const layer = graph.blueprintLayer!;

const ids = (g: D3Graph) => g.nodes.map(n => n.id).sort();
const run = (over: Partial<FilterOptions> = {}, g: D3Graph = layer) =>
  executeQuery(compileQuery({ ...defaultFilters(), ...over }, detectProjectLanguage(g)), g);

describe('blueprint layer split', () => {
  it('keeps node atoms out of the code graph', () => {
    expect(graph.nodes.some(n => n.language === 'blueprint')).toBe(false);
    expect(graph.nodes).toHaveLength(9);
    expect(layer.nodes).toHaveLength(9);
    expect(layer.nodes.every(n => n.language === 'blueprint')).toBe(true);
    expect(detectProjectLanguage(layer)).toBe('blueprint');
    expect(detectProjectLanguage(graph)).toBe('lean');
  });

  it('draws uses edges between node atoms only, with statement uses as role type', () => {
    const nodeIds = new Set(layer.nodes.map(n => n.id));
    expect(layer.links.every(l => nodeIds.has(l.source as string) && nodeIds.has(l.target as string))).toBe(true);
    expect(layer.links.every(l => l.type === 'inner' && l.role === 'type')).toBe(true);
    expect(layer.links.filter(l => l.source === 'probe:blueprint:collatz_step').map(l => l.target).sort())
      .toEqual(['probe:blueprint:addition_spec', 'probe:blueprint:multiplication_spec']);
  });

  it('keeps bindings as node data, not links', () => {
    const step = layer.nodes.find(n => n.id === 'probe:blueprint:collatz_step')!;
    expect(step.blueprint?.bindings).toEqual(['probe:collatzStep', 'probe:collatzTerminatesAtOne']);
    expect(step.dependencies.some(d => d.startsWith('probe:collatz'))).toBe(false);
    expect(layer.links.some(l => l.target === 'probe:collatzStep')).toBe(false);
  });

  it('reads node fields and the owning label of bound Lean atoms', () => {
    const assoc = layer.nodes.find(n => n.id === 'probe:blueprint:addition_assoc')!.blueprint!;
    expect(assoc).toMatchObject({
      label: 'addition_assoc', title: 'Theorem 1.3', chapter: 'Addition',
      nodeClass: 'decl-missing', statementStatus: 'formalized', proofStatus: 'proved',
      upstreamDecls: ['Nat.add_assoc'], sourcePath: 'ProjectTemplate/Chapters/Addition.lean',
      sourceLines: { start: 62, end: 62 },
    });
    const decl = graph.nodes.find(n => n.id === 'probe:collatzStep')!;
    expect(decl.blueprint?.label).toBe('collatz_step');
    expect(decl.is_entry_point).toBe(true);
  });

  it('carries the envelope source config to both layers', () => {
    expect(layer.metadata.source_configs?.[0].github_url).toBe('https://github.com/leanprover/verso-blueprint');
    expect(graph.metadata.source_configs).toEqual(layer.metadata.source_configs);
  });

  it('merges statement and proof uses into roles', () => {
    const node = (over: Partial<ProbeAtom>): ProbeAtom => ({
      "display-name": 'n', dependencies: [], "code-text": null, "code-path": 'blueprint/C',
      "code-module": 'C', kind: 'blueprint-theorem', language: 'blueprint', ...over,
    });
    const g = convertAtomDictToD3Graph({
      'probe:blueprint:a': node({
        "blueprint-statement-uses": ['probe:blueprint:b', 'probe:blueprint:c', 'probe:blueprint:gone'],
        "blueprint-proof-uses": ['probe:blueprint:c', 'probe:blueprint:d'],
      }),
      'probe:blueprint:b': node({}),
      'probe:blueprint:c': node({}),
      'probe:blueprint:d': node({}),
    }).blueprintLayer!;
    expect(g.links.map(l => [l.target, l.role]).sort()).toEqual([
      ['probe:blueprint:b', 'type'], ['probe:blueprint:c', 'both'], ['probe:blueprint:d', 'term'],
    ]);
  });
});

describe('blueprint layer queries', () => {
  it('keeps isolated entries', () => {
    const shown = ids(run());
    expect(shown).toContain('probe:blueprint:addition_runtime_note');
    expect(shown).toContain('probe:blueprint:multiplication_assoc');
    expect(shown).toHaveLength(9);
  });

  it('keeps entries isolated by the role boxes', () => {
    expect(run({ showStatementDeps: false }).nodes).toHaveLength(9);
  });

  it('shows blueprint theorems with Definitions unchecked', () => {
    const kinds = new Set(run({ showExecFunctions: false }).nodes.map(n => n.kind));
    expect(kinds).toEqual(new Set(['blueprint-theorem']));
  });

  it('ignores the code-layer language boxes', () => {
    expect(run({ showRustNodes: false }).nodes).toHaveLength(9);
    expect(run({ showLeanNodes: false }).nodes).toHaveLength(9);
  });

  it('still drops isolated code atoms outside the anchors', () => {
    const intent = focusIntent('f', ['probe:blueprint:addition_spec', 'probe:blueprint:collatz_step'], 'f');
    expect(ids(run({ intent }))).toEqual(['probe:blueprint:addition_spec', 'probe:blueprint:collatz_step']);
    expect(ids(run({}, graph))).not.toContain('probe:nat_add_zero_right');
  });
});

describe('blueprint node details', () => {
  const ctx = { repo: 'https://github.com/o/r', codeName: (id: string) => ({ 'probe:x': 'x_decl' } as Record<string, string>)[id] };

  it('renders statement text and every field as text', () => {
    const html = blueprintNodeDetailsHtml({
      label: 'l', title: '<b>T</b>', statementText: '<img src=x onerror=alert(1)> $a<b$',
      mismatch: '<script>', missingDecls: ['<i>m</i>'], bindings: ['probe:x', 'probe:<y>'],
    }, ctx);
    expect(html).not.toMatch(/<(img|script|b>|i>)/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; $a&lt;b$');
    expect(html).toContain('x_decl');
    expect(html).toContain('probe:&lt;y&gt;');
    expect(blueprintBackrefHtml({ label: '<l>' }, [])).toContain('&lt;l&gt;');
    expect(blueprintBackrefHtml(undefined, [{ id: 'probe:blueprint:"', info: { label: '<l>' } }]))
      .toContain('data-node-id="probe:blueprint:&quot;"');
  });

  it('links bound declarations and the owning entry across layers', () => {
    const html = blueprintNodeDetailsHtml({ label: 'l', bindings: ['probe:x', 'probe:"y'] }, ctx);
    expect(html).toContain('data-layer="code" data-node-id="probe:x" style="cursor:pointer; text-decoration:underline;">x_decl</a>');
    expect(html).toContain('data-node-id="probe:&quot;y"');
    const entry = { id: 'probe:blueprint:l', info: { label: 'l', title: 'Theorem 1' } };
    expect(blueprintBackrefHtml(entry.info, [entry]))
      .toContain('data-layer="blueprint" data-node-id="probe:blueprint:l"');
    expect(blueprintBackrefHtml({ label: 'l' }, [])).not.toContain('<a ');
    expect(blueprintBackrefHtml(undefined, [])).toBe('');
  });

  it('lists every entry of a declaration bound by several', () => {
    const html = blueprintBackrefHtml({ label: 'a' }, [
      { id: 'probe:blueprint:a', info: { label: 'a' } },
      { id: 'probe:blueprint:b', info: { label: 'b' } },
    ]);
    expect(html).toContain('Blueprint entries (2)');
    expect(html).toContain('data-node-id="probe:blueprint:a"');
    expect(html).toContain('data-node-id="probe:blueprint:b"');
  });

  it('labels declared statuses', () => {
    expect(blueprintNodeDetailsHtml({ label: 'l', proofStatus: 'proved', statusSource: 'declared' }, ctx))
      .toContain('(declared)');
    expect(blueprintNodeDetailsHtml({ label: 'l', proofStatus: 'proved', statusSource: 'code-derived' }, ctx))
      .not.toContain('(declared)');
  });

  it('links issues only for github.com repos and positive integers', () => {
    expect(githubIssueUrl('https://github.com/o/r', '12')).toBe('https://github.com/o/r/issues/12');
    expect(githubIssueUrl('https://github.com/o/r.git', '12')).toBe('https://github.com/o/r/issues/12');
    expect(githubIssueUrl('https://github.com/o/r/', '12')).toBe('https://github.com/o/r/issues/12');
    for (const issue of ['0', '-1', '1.5', '12abc', ' 12', '012', '', undefined]) {
      expect(githubIssueUrl('https://github.com/o/r', issue)).toBeNull();
    }
    for (const repo of [
      'http://github.com/o/r', 'https://gitlab.com/o/r', 'https://github.com.evil.io/o/r',
      'https://evil.io/github.com/o/r', 'https://github.com/o', 'https://github.com/o/r/tree/x',
      'https://u@github.com/o/r', 'https://github.com/o/r?x=1', 'https://github.com/o/..',
      'javascript:alert(1)', 'github.com/o/r', '', undefined,
    ]) {
      expect(githubIssueUrl(repo, '12')).toBeNull();
    }
  });

  it('shows an unlinkable issue as text', () => {
    const html = blueprintNodeDetailsHtml({ label: 'l', githubIssue: '<12>' }, ctx);
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;12&gt;');
  });
});
