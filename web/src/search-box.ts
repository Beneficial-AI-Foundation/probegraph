/**
 * The search box in the header: lexical search (search.ts) over both
 * layers, a result list, and a reveal of the chosen hit. Filter words
 * (query-words.ts) narrow the hits, and a `paths from ... to ...` text
 * gets a first row that runs it as a Source and Sink query. A `top` query
 * and a text of filter words alone give a node list, which "Show all in
 * the Call Graph" draws as an exact ID set. See
 * docs/plans/graph-search.md, Phases 1 and 2, and the "Search box"
 * section of docs/guides/viewer.md.
 *
 * Keys in the search box: Enter runs the query, shows the node list in
 * the Call Graph, or reveals the top hit, ArrowDown moves to
 * the result list, Escape closes it, and Alt+Enter moves the focus to the
 * first button of the reveal's toast. In the list, ArrowUp and ArrowDown
 * move between rows and Escape goes back to the box. `/` anywhere outside
 * a text field focuses the box.
 */

import {
  compileFilterWords, formatVerbQuery, formatWords, graphWordContext, parseVerbQuery, parseWords, runTop, TOP_MAX,
  type PathsQuery, type TopQuery, type WordContext,
} from './query-words';
import { buildSearchIndex, search, type SearchIndex } from './search';
import { statusColor } from './theme';
import type { D3Graph, D3Node } from './types';
import type { Layer } from './url-state';

/** What a row's button asks for; the `anchor` policies of revealNode. */
export type SearchAction = 'reveal' | 'source' | 'sink';

export interface SearchBoxDeps {
  /** The loaded layers; null before a graph loads */
  layers(): { code: D3Graph; blueprint: D3Graph | null } | null;
  /** The layer the viewer shows */
  shownLayer(): Layer;
  reveal(id: string, action: SearchAction): void;
  /** Run a text query with these Source and Sink texts */
  runQuery(source: string, sink: string): void;
  /** Draw these nodes of `layer` in the Call Graph, labelled with the query text */
  showAll(ids: string[], layer: Layer, label: string): void;
}

const RESULT_LIMIT = 20;
/** Most nodes "Show all" draws: the render limit, so truncation never picks a subset. */
const SHOW_ALL_LIMIT = TOP_MAX;

/** What "Show all in the Call Graph" draws. */
interface ShowAll {
  ids: string[];
  layer: Layer;
  label: string;
}

/** The result list of one text, before rendering. */
interface Results {
  /** Every node of the list; the list shows the first RESULT_LIMIT */
  nodes: D3Node[];
  /** Whether more nodes matched than `nodes` holds (lexical search only) */
  more: boolean;
  /** Unique transitive dependents of each row, for a `top` list */
  counts?: Map<string, number>;
  /** A line above the rows, for a `top` list */
  heading?: string;
  /** The Show all button, or why there is none */
  showAll?: ShowAll | string;
  error: string | null;
}

export class SearchBox {
  private index: SearchIndex | null = null;
  private context: WordContext | null = null;
  private blueprintIds = new Set<string>();
  private hits: D3Node[] = [];
  /** The `paths` query of the text, run by its row and by Enter */
  private verb: PathsQuery | null = null;
  /** The Show all button of a node list, run by it and by Enter */
  private showAll: ShowAll | null = null;

  constructor(
    private readonly input: HTMLInputElement,
    private readonly list: HTMLElement,
    /** A live region that tells screen readers what the list shows */
    private readonly status: HTMLElement,
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
    window.addEventListener('resize', () => {
      if (!this.list.hidden) this.place();
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
    this.context = null;
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
    this.context = blueprint ? graphWordContext(code, blueprint) : graphWordContext(code);
    return this.index;
  }

  private update(): void {
    const query = this.input.value;
    if (!query.trim()) {
      this.close();
      return;
    }
    const index = this.ensureIndex();
    const verb = parseVerbQuery(query);
    const results = !index ? null
      : verb?.ok && verb.value.verb === 'top' ? this.topResults(verb.value)
      : this.searchResults(index, query, verb && !verb.ok ? verb.error : null);
    this.verb = index && verb?.ok && verb.value.verb === 'paths' ? verb.value : null;
    this.showAll = results && typeof results.showAll === 'object' ? results.showAll : null;
    this.hits = results?.nodes.slice(0, RESULT_LIMIT) ?? [];
    this.render(results);
  }

  /** Lexical hits; a text of filter words alone is a node list. */
  private searchResults(index: SearchIndex, query: string, verbError: string | null): Results {
    const words = parseWords(query);
    const error = verbError ?? (!words.ok ? words.error : null);
    if (!words.ok) return { nodes: [], more: false, error };
    const { plain, filters } = words.value;
    const accept = filters.length > 0 ? compileFilterWords(filters, this.context!) : undefined;
    if (plain.length > 0 || !accept) {
      // One more than shown, to know whether there are more
      const nodes = search(index, plain.join(' '), RESULT_LIMIT + 1, accept).map(h => h.node);
      return { nodes: nodes.slice(0, RESULT_LIMIT), more: nodes.length > RESULT_LIMIT, error };
    }
    const nodes = search(index, '', Infinity, accept).map(h => h.node);
    return { nodes, more: false, error, showAll: this.showAllFor(nodes, formatWords(words.value)) };
  }

  /**
   * Show all for a filter-word list: the matches on the shown layer, or on
   * the other layer when the shown one has none.
   */
  private showAllFor(nodes: D3Node[], label: string): ShowAll | string | undefined {
    if (nodes.length === 0) return undefined;
    const onBlueprint = (n: D3Node) => this.blueprintIds.has(n.id);
    const shown = this.shownLayer();
    let layer = shown;
    let ids = nodes.filter(n => onBlueprint(n) === (shown === 'blueprint')).map(n => n.id);
    if (ids.length === 0) {
      layer = shown === 'code' ? 'blueprint' : 'code';
      ids = nodes.map(n => n.id);
    }
    if (ids.length > SHOW_ALL_LIMIT) {
      return `${ids.length} matches, more than the ${SHOW_ALL_LIMIT}-node render limit. `
        + 'Add filter words to show them in the Call Graph.';
    }
    return { ids, layer, label };
  }

  /** The layer `top` ranks on: the shown one, if the graph has it. */
  private shownLayer(): Layer {
    return this.blueprintIds.size > 0 ? this.deps.shownLayer() : 'code';
  }

  private topResults(q: TopQuery): Results {
    const layers = this.deps.layers()!;
    const layer = this.shownLayer();
    const graph = layer === 'blueprint' ? layers.blueprint! : layers.code;
    const result = runTop(graph, q, this.context!);
    if (!result.ok) {
      const error = 'Dependent counts are not available for this graph, because it is too large. '
        + `After merging cycles it has ${result.components.toLocaleString('en-US')} components `
        + `and ${result.links.toLocaleString('en-US')} links`;
      return { nodes: [], more: false, error };
    }
    const nodes = result.rows.map(r => r.node);
    const counts = new Map(result.rows.map(r => [r.node.id, r.count]));
    const heading = result.total === 0 ? undefined
      : `Top ${nodes.length} of ${result.total} by unique transitive dependents`
        + (this.blueprintIds.size > 0 ? `, on the ${layer} layer` : '');
    const showAll = nodes.length > 0 ? { ids: nodes.map(n => n.id), layer, label: formatVerbQuery(q) } : undefined;
    return { nodes, more: false, counts, heading, showAll, error: null };
  }

  private render(results: Results | null): void {
    this.list.replaceChildren();
    if (!results) {
      this.list.appendChild(note('Load a graph to search it'));
      this.open('Load a graph to search it');
      return;
    }
    const { error, heading, counts } = results;
    if (this.verb) this.list.appendChild(queryRow(this.verb));
    if (error) this.list.appendChild(note(error, 'search-error'));
    if (heading) this.list.appendChild(note(heading, 'search-heading'));
    // Under a query row, "No matches" would read as a query without paths
    if (this.hits.length === 0 && !error && !this.verb) this.list.appendChild(note('No matches'));
    const twoLayers = this.blueprintIds.size > 0;
    for (const node of this.hits) this.list.appendChild(this.row(node, twoLayers, counts?.get(node.id)));
    const total = results.nodes.length;
    const cut = results.more || total > RESULT_LIMIT;
    if (results.more) this.list.appendChild(note(`First ${RESULT_LIMIT} matches. Add words to narrow the search.`));
    else if (cut) this.list.appendChild(note(`First ${RESULT_LIMIT} of ${total} matches.`));
    if (typeof results.showAll === 'string') this.list.appendChild(note(results.showAll));
    else if (this.showAll) this.list.appendChild(showAllRow(this.showAll.ids.length));

    const count = this.hits.length;
    const matches = count === 0 ? 'No matches'
      : results.more ? `First ${RESULT_LIMIT} matches`
      : cut ? `First ${RESULT_LIMIT} of ${total} matches`
      : `${count} ${count === 1 ? 'match' : 'matches'}`;
    this.open(this.verb ? (count === 0 ? 'Query ready. Press Enter to run it' : `Query ready. ${matches}`)
      : error ? `${error}. ${matches}`
      : heading ? `${heading}. Press Enter to show them in the Call Graph`
      : this.showAll ? `${matches}. Press Enter to show them in the Call Graph`
      : matches);
  }

  private open(status: string): void {
    this.list.hidden = false;
    this.place();
    this.status.textContent = status;
  }

  /**
   * Align the list's right edge with the box, but keep the whole list in
   * the window: on a narrow window the box ends too near the left edge.
   */
  private place(): void {
    const margin = 16;
    const box = this.list.offsetParent?.getBoundingClientRect();
    if (!box) return;
    const width = this.list.offsetWidth;
    const right = document.documentElement.clientWidth - margin;
    const left = Math.max(margin, Math.min(box.right - width, right - width));
    this.list.style.left = `${left - box.left}px`;
  }

  private row(node: D3Node, twoLayers: boolean, dependents?: number): HTMLElement {
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
    if (dependents !== undefined) {
      meta.append(span('search-result-count', `${dependents} ${dependents === 1 ? 'dependent' : 'dependents'}`));
    }
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
    this.verb = null;
    this.showAll = null;
    this.status.textContent = '';
  }

  private run(id: string, action: SearchAction): void {
    this.input.focus();
    this.close();
    this.deps.reveal(id, action);
  }

  private runVerb(verb: PathsQuery): void {
    this.input.focus();
    this.close();
    this.deps.runQuery(verb.from, verb.to);
  }

  private runShowAll(showAll: ShowAll): void {
    this.input.focus();
    this.close();
    this.deps.showAll(showAll.ids, showAll.layer, showAll.label);
  }

  /** Put a query into the box and open its result list, as a Guide button does. */
  fill(text: string): void {
    this.input.value = text;
    this.input.focus();
    this.update();
  }

  private onInputKey(e: KeyboardEvent): void {
    // Enter and the arrows belong to the input method while it composes
    if (e.isComposing) return;
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      document.querySelector<HTMLButtonElement>('#toast-container .toast-action')?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.list.hidden) this.update();
      const top = this.hits[0];
      if (this.verb) this.runVerb(this.verb);
      else if (this.showAll) this.runShowAll(this.showAll);
      else if (top) this.run(top.id, 'reveal');
    } else if (e.key === 'ArrowDown') {
      if (this.list.hidden) this.update();
      const first = this.list.querySelector<HTMLButtonElement>('.search-result button');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === 'Escape' && !this.list.hidden) {
      // Stop it here: the Hierarchy and Crate Map collapse on Escape
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  private onListKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
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
    // The query row has one button; from it or to it, go to the main button
    const action = target.dataset.action ?? 'reveal';
    (next.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
      ?? next.querySelector<HTMLButtonElement>('button'))?.focus();
  }

  private onListClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('button[data-action]');
    if (target?.dataset.action === 'query') {
      if (this.verb) this.runVerb(this.verb);
      return;
    }
    if (target?.dataset.action === 'show-all') {
      if (this.showAll) this.runShowAll(this.showAll);
      return;
    }
    const id = target?.closest<HTMLElement>('.search-result')?.dataset.id;
    if (target && id) this.run(id, target.dataset.action as SearchAction);
  }
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
    || (target.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range', 'file'].includes((target as HTMLInputElement).type));
}

/** The first row of a verb query: one button that runs it. */
function queryRow(verb: PathsQuery): HTMLElement {
  const li = document.createElement('li');
  li.className = 'search-result search-query';
  const text = formatVerbQuery(verb);
  const run = button('search-result-main', 'query', `Run ${text} in the Call Graph`);
  run.append(span('search-query-tag', 'query'), span('search-result-name', text));
  li.append(run);
  return li;
}

/** The last row of a node list: one button that draws it. */
function showAllRow(count: number): HTMLElement {
  const li = document.createElement('li');
  li.className = 'search-result search-show-all';
  const text = `Show all ${count} in the Call Graph`;
  const run = button('search-result-main', 'show-all', `${text}, as one query of exactly these nodes`);
  run.append(span('search-result-name', text));
  li.append(run);
  return li;
}

function button(
  className: string, action: SearchAction | 'query' | 'show-all', title: string, text = '',
): HTMLButtonElement {
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

function note(text: string, extraClass = ''): HTMLElement {
  const li = document.createElement('li');
  li.className = extraClass ? `search-note ${extraClass}` : 'search-note';
  li.textContent = text;
  return li;
}
