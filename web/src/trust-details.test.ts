import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { convertAtomDictToD3Graph } from './graph-loader';
import { TRUST_LIST_CAP, trustDetailsHtml, trustSummary } from './trust-details';
import type { D3Graph, ProbeAtom } from './types';

const FIXTURES: { name: string; data: Record<string, ProbeAtom> }[] = JSON.parse(
  readFileSync(resolve(__dirname, 'test-data/trust-frontier.json'), 'utf8'),
);
const fixture = (name: string) => convertAtomDictToD3Graph(FIXTURES.find(f => f.name === name)!.data);
const html = (g: D3Graph, id: string, open = true) =>
  trustDetailsHtml(g, g.nodes.find(n => n.id === id)!, open);
/** Visible text, each tag read as a space. */
const text = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const atom = (over: Partial<ProbeAtom>): ProbeAtom => ({
  "display-name": 'x', dependencies: [], "code-text": null, "code-path": 'X.lean',
  "code-module": 'X', kind: 'theorem', language: 'lean', ...over,
});

describe('trustSummary', () => {
  it('names the counts separately, in the singular where it applies', () => {
    expect(trustSummary(1, 0, 0)).toBe('Rests on 1 assumption and 0 unfinished declarations');
    expect(trustSummary(4, 2, 1))
      .toBe('Rests on 4 assumptions, 2 unfinished declarations and 1 untracked declaration');
  });
});

describe('trustDetailsHtml', () => {
  it('lists each entry with its witness path and the trusted reason', () => {
    const t = text(html(fixture('chain'), 'top'));
    expect(t).toContain('Trust base: Rests on 1 assumption and 1 unfinished declaration');
    expect(t).toContain('Assumptions (1): ax (axiom) show path via mid → low');
    expect(t).toContain('Unfinished (1): low show path via mid');
  });

  it('marks the node itself and a direct dependency', () => {
    const t = text(html(fixture('chain'), 'low'));
    expect(t).toContain('low (this declaration)');
    expect(t).toContain('ax (axiom) show path direct dependency');
  });

  it('links every entry to its details', () => {
    expect(html(fixture('chain'), 'top')).toContain('class="navigate-to-node" data-node-id="ax"');
  });

  it('shows untracked declarations, the closure note and the missing targets', () => {
    const g = fixture('missing-and-unknown');
    const u = text(html(g, 'u'));
    expect(u).toContain('Untracked (1): x');
    expect(u).toContain('External closure unavailable');
    const n = text(html(g, 'n'));
    expect(n).toContain('Missing targets (1):');
    expect(n).toContain('they block nothing. gone');
    expect(n).not.toContain('External closure unavailable');
  });

  it('offers a show-path button for every entry but the node itself', () => {
    const out = html(fixture('chain'), 'low');
    expect(out).toContain('class="trust-path" data-from="low" data-to="ax"');
    expect(out).not.toContain('data-to="low"');
  });

  it('keeps the expanded state the caller passes', () => {
    expect(html(fixture('chain'), 'top', true)).toContain('<details class="trust-base" open>');
    expect(html(fixture('chain'), 'top', false)).toContain('<details class="trust-base" data-lazy>');
  });

  it('leaves the lists out while collapsed', () => {
    const t = text(html(fixture('chain'), 'top', false));
    expect(t).toBe('Trust base: Rests on 1 assumption and 1 unfinished declaration');
  });

  it('is one line without anything to list', () => {
    const g = convertAtomDictToD3Graph({
      a: atom({ "verification-status": 'transitively-verified' }),
    });
    expect(html(g, 'a')).not.toContain('<details');
    expect(text(html(g, 'a'))).toBe('Trust base: Rests on 0 assumptions and 0 unfinished declarations');
  });

  it('shortens a long witness in the middle and keeps the full path in the title', () => {
    const g = fixture('long-witness');
    const start = g.nodes.find(n => n.dependencies.length > 0 && n.dependents.length === 0)!;
    const out = html(g, start.id);
    expect(text(out)).toMatch(/ → … \d+ more … → /);
    const title = /class="trust-witness" title="([^"]*)"/.exec(out)![1];
    expect(title.split(' → ')).toHaveLength(206);
  });

  it('caps each list', () => {
    const atoms: Record<string, ProbeAtom> = {};
    const ids = Array.from({ length: TRUST_LIST_CAP + 3 }, (_, i) => `ax${String(i).padStart(3, '0')}`);
    for (const id of ids) atoms[id] = atom({ kind: 'axiom', "verification-status": 'trusted' });
    atoms.top = atom({ dependencies: ids, "verification-status": 'transitively-verified' });
    const t = text(html(convertAtomDictToD3Graph(atoms), 'top'));
    expect(t).toContain(`Assumptions (${TRUST_LIST_CAP + 3})`);
    expect(t).toContain('and 3 more');
    expect(t).not.toContain(ids[ids.length - 1]);
  });

  it('escapes names from the extract', () => {
    const g = convertAtomDictToD3Graph({
      a: atom({ dependencies: ['b', '<gone>'] }),
      b: atom({ "display-name": '<img src=x>', "verification-status": 'trusted', "trusted-reason": '<r>' }),
    });
    const out = html(g, 'a');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<gone>');
    expect(out).not.toContain('<r>');
    expect(out).toContain('&lt;img src=x&gt;');
    expect(out).toContain('title="Draw the paths from x to &lt;img src=x&gt; in the Call Graph"');
  });

  it('is empty for a blueprint entry and on a graph without statuses', () => {
    const g = fixture('chain');
    expect(trustDetailsHtml(g, { ...g.nodes[0], language: 'blueprint' }, true)).toBe('');
    const plain = convertAtomDictToD3Graph({ a: atom({ dependencies: ['b'] }), b: atom({}) });
    expect(html(plain, 'a')).toBe('');
  });
});
