/**
 * The search box in the header: lexical search (search.ts) over both
 * layers, a result list, and a reveal of the chosen hit. See
 * docs/plans/graph-search.md, Phase 1, and the "Search box" section of
 * docs/guides/viewer.md.
 *
 * Keys in the search box: Enter reveals the top hit, ArrowDown moves to
 * the result list, Escape closes it, and Alt+Enter moves the focus to the
 * first button of the reveal's toast. In the list, ArrowUp and ArrowDown
 * move between rows and Escape goes back to the box. `/` anywhere outside
 * a text field focuses the box.
 */

import { buildSearchIndex, search, type SearchIndex } from './search';
import { statusColor } from './theme';
import type { D3Graph, D3Node } from './types';

/** What a row's button asks for; the `anchor` policies of revealNode. */
export type SearchAction = 'reveal' | 'source' | 'sink';

export interface SearchBoxDeps {
  /** The loaded layers; null before a graph loads */
  layers(): { code: D3Graph; blueprint: D3Graph | null } | null;
  reveal(id: string, action: SearchAction): void;
}

const RESULT_LIMIT = 20;

export class SearchBox {
  private index: SearchIndex | null = null;
  private blueprintIds = new Set<string>();
  private hits: D3Node[] = [];

  constructor(
    private readonly input: HTMLInputElement,
    private readonly list: HTMLElement,
    private readonly deps: SearchBoxDeps,
  ) {
    input.addEventListener('focus', () => this.ensureIndex());
    input.addEventListener('input', () => this.update());
    input.addEventListener('keydown', e => this.onInputKey(e));
    list.addEventListener('keydown', e => this.onListKey(e));
    list.addEventListener('click', e => this.onListClick(e));
    // Keep the focus in the box on a click, so the focusout below does not
    // close the list before the click lands (Safari does not focus buttons)
    list.addEventListener('mousedown', e => e.preventDefault());
    // Close the list when the focus leaves the box and the list
    const container = input.parentElement!;
    container.addEventListener('focusout', e => {
      if (!container.contains(e.relatedTarget as Node | null)) this.close();
    });
    document.addEventListener('keydown', e => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) return;
      e.preventDefault();
      input.focus();
      input.select();
    });
  }

  /** A new graph: the next focus or query builds the index again. */
  invalidate(): void {
    this.index = null;
    this.blueprintIds.clear();
    this.close();
  }

  private ensureIndex(): SearchIndex | null {
    if (this.index) return this.index;
    const layers = this.deps.layers();
    if (!layers) return null;
    const { code, blueprint } = layers;
    this.blueprintIds = new Set(blueprint?.nodes.map(n => n.id));
    this.index = buildSearchIndex({
      nodes: [...code.nodes, ...blueprint?.nodes ?? []],
      links: [...code.links, ...blueprint?.links ?? []],
    });
    return this.index;
  }

  private update(): void {
    const query = this.input.value;
    if (!query.trim()) {
      this.close();
      return;
    }
    const index = this.ensureIndex();
    // One more than shown, to know whether there are more
    const hits = index ? search(index, query, RESULT_LIMIT + 1).map(h => h.node) : [];
    this.hits = hits.slice(0, RESULT_LIMIT);
    this.render(index === null, hits.length > RESULT_LIMIT);
  }

  private render(noGraph: boolean, more: boolean): void {
    this.list.replaceChildren();
    if (noGraph || this.hits.length === 0) {
      this.list.appendChild(note(noGraph ? 'Load a graph to search it' : 'No matches'));
    }
    const twoLayers = this.blueprintIds.size > 0;
    for (const node of this.hits) this.list.appendChild(this.row(node, twoLayers));
    if (more) this.list.appendChild(note(`First ${RESULT_LIMIT} matches. Add words to narrow the search.`));
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  }

  private row(node: D3Node, twoLayers: boolean): HTMLElement {
    const li = document.createElement('li');
    li.className = 'search-result';
    li.dataset.id = node.id;

    const main = button('search-result-main', 'reveal', `Show ${node.display_name} in the Call Graph`);
    const name = span('search-result-name', node.display_name);
    const status = node.verification_status ?? 'unknown';
    const dot = span('legend-dot', '');
    dot.style.background = statusColor(status);
    const meta = span('search-result-meta', '');
    if (twoLayers && this.blueprintIds.has(node.id)) meta.append(span('search-result-layer', 'blueprint'));
    meta.append(span('', node.kind), dot, span('', status));
    const where = span('search-result-path', node.relative_path || node.id);
    where.title = node.relative_path || node.id;
    main.append(name, meta, where);

    li.append(
      main,
      button('search-result-anchor', 'source', `Add ${node.display_name} to the sources: show what it calls`, 'as source'),
      button('search-result-anchor', 'sink', `Add ${node.display_name} to the sinks: show what calls it`, 'as sink'),
    );
    return li;
  }

  private close(): void {
    this.list.hidden = true;
    this.list.replaceChildren();
    this.hits = [];
    this.input.setAttribute('aria-expanded', 'false');
  }

  private run(id: string, action: SearchAction): void {
    this.input.focus();
    this.close();
    this.deps.reveal(id, action);
  }

  private onInputKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      document.querySelector<HTMLButtonElement>('#toast-container .toast-action')?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.list.hidden) this.update();
      const top = this.hits[0];
      if (top) this.run(top.id, 'reveal');
    } else if (e.key === 'ArrowDown') {
      if (this.list.hidden) this.update();
      const first = this.list.querySelector<HTMLButtonElement>('.search-result-main');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === 'Escape' && !this.list.hidden) {
      e.preventDefault();
      this.close();
    }
  }

  private onListKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      // Focus first: removing the focused button would drop the focus
      this.input.focus();
      this.close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    // The same button in the next or previous row; up from the first row is the box
    const rows = [...this.list.querySelectorAll<HTMLElement>('.search-result')];
    const row = target.closest<HTMLElement>('.search-result');
    const i = row ? rows.indexOf(row) : -1;
    const next = rows[e.key === 'ArrowDown' ? i + 1 : i - 1];
    if (!next) {
      if (e.key === 'ArrowUp') this.input.focus();
      return;
    }
    const action = target.dataset.action ?? 'reveal';
    next.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.focus();
  }

  private onListClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('button[data-action]');
    const id = target?.closest<HTMLElement>('.search-result')?.dataset.id;
    if (target && id) this.run(id, target.dataset.action as SearchAction);
  }
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
    || (target.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range', 'file'].includes((target as HTMLInputElement).type));
}

function button(className: string, action: SearchAction, title: string, text = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.dataset.action = action;
  b.title = title;
  b.textContent = text;
  return b;
}

function span(className: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  if (className) s.className = className;
  s.textContent = text;
  return s;
}

function note(text: string): HTMLElement {
  const li = document.createElement('li');
  li.className = 'search-note';
  li.textContent = text;
  return li;
}
