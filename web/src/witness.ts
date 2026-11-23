/**
 * Witness edges: the function-level links behind one aggregated edge.
 *
 * The Crate Map and the Hierarchy draw one line between two groups for many
 * links. A witness is one caller and one callee behind that line, with the
 * links of the pair merged, so the user can see what the line stands for.
 * This module orders the links, and renders the tooltip text and the details
 * panel. It has no d3 and no state, so the two views share it.
 */

import { escapeHtml } from './html';
import type { D3Node } from './types';

/** One function-level link of an aggregated edge (`CrateEdge`, `CutEdge`). */
export interface WitnessCall { sourceId: string; targetId: string; type: string }

/** Witnesses in the edge tooltip. */
export const WITNESS_TOOLTIP_CAP = 3;
/** Witnesses in the details panel before "Show all". */
export const WITNESS_LIST_CAP = 10;

type NameOf = (id: string) => string;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The links of one aggregated edge in a fixed order: by caller name, then
 * callee name, then the ids and the link type. The order does not depend on
 * the order of the graph's links, so the first witness is the same on every
 * render. Code-unit comparison, not locale, for the same reason.
 */
export function sortWitnesses<T extends WitnessCall>(calls: ReadonlyArray<T>, nameOf: NameOf): T[] {
  return [...calls].sort((a, b) =>
    compare(nameOf(a.sourceId), nameOf(b.sourceId))
    || compare(nameOf(a.targetId), nameOf(b.targetId))
    || compare(a.sourceId, b.sourceId)
    || compare(a.targetId, b.targetId)
    || compare(a.type, b.type));
}

/** Display names from a node map; an id with no node stands for itself. */
export function witnessNameOf(nodeById: ReadonlyMap<string, D3Node>): NameOf {
  return id => nodeById.get(id)?.display_name || id;
}

/** One witness: a caller and a callee, with the types of the links between the two. */
export interface Witness { sourceId: string; targetId: string; types: string[] }

/**
 * The witnesses of one aggregated edge: its links in the order of
 * `sortWitnesses`, with the links of one caller and callee merged into one
 * witness. A function that calls another and also names it in a `requires`
 * clause is one witness with two types. The legacy type `calls` counts as
 * `inner`, as in the link filter (`linkTypeShown`).
 */
export function witnessesOf(calls: ReadonlyArray<WitnessCall>, nameOf: NameOf): Witness[] {
  const out: Witness[] = [];
  for (const call of sortWitnesses(calls, nameOf)) {
    const type = call.type === 'calls' ? 'inner' : call.type;
    const last = out[out.length - 1];
    if (last && last.sourceId === call.sourceId && last.targetId === call.targetId) {
      if (!last.types.includes(type)) last.types.push(type);
    } else {
      out.push({ sourceId: call.sourceId, targetId: call.targetId, types: [type] });
    }
  }
  return out;
}

const TYPE_LABELS = new Map([
  ['inner', 'call'],
  ['precondition', 'requires'],
  ['postcondition', 'ensures'],
]);

/**
 * The words after a witness, for example "requires" or "call, spec". Empty
 * for a witness with body calls only, which is the usual case. A type with
 * no label stands for itself. It comes from the graph file, so escape the
 * result before it goes into HTML.
 */
export function witnessTypeLabel(types: ReadonlyArray<string>): string {
  if (types.every(type => type === 'inner')) return '';
  return types.map(type => TYPE_LABELS.get(type) ?? type).join(', ');
}

export function callCountText(count: number): string {
  return `${count} call${count === 1 ? '' : 's'}`;
}

/** Pixels between a two-way edge and the middle line of its two boxes. */
export const TWO_WAY_SHIFT = 7;

/**
 * Vertical shift of each edge, in pixels. If the edge in the opposite
 * direction also exists, the two curves run between the same two boxes and
 * cover each other, so only one takes the hover and the click. The shift
 * moves one up and the other down. An edge with no opposite edge gets 0.
 */
export function twoWayShift(
  edges: ReadonlyArray<{ source: string; target: string }>,
): (source: string, target: string) => number {
  const keys = new Set(edges.map(e => `${e.source}\0${e.target}`));
  return (source, target) => {
    if (!keys.has(`${target}\0${source}`)) return 0;
    return source < target ? -TWO_WAY_SHIFT : TWO_WAY_SHIFT;
  };
}

/**
 * Tooltip of an aggregated edge: the two groups, the count, and the first
 * witnesses, one per line.
 */
export function witnessTooltip(
  sourceLabel: string, targetLabel: string,
  calls: ReadonlyArray<WitnessCall>, nameOf: NameOf,
): string {
  const witnesses = witnessesOf(calls, nameOf);
  const lines = [`${sourceLabel} → ${targetLabel}: ${callCountText(calls.length)}`];
  for (const w of witnesses.slice(0, WITNESS_TOOLTIP_CAP)) {
    const type = witnessTypeLabel(w.types);
    lines.push(`${nameOf(w.sourceId)} → ${nameOf(w.targetId)}${type ? ` (${type})` : ''}`);
  }
  const rest = witnesses.length - WITNESS_TOOLTIP_CAP;
  if (rest > 0) lines.push(`and ${rest} more`);
  lines.push('Click for the list');
  return lines.join('\n');
}

function witnessLink(id: string, nameOf: NameOf): string {
  return `<a href="#" class="witness-node" data-node-id="${escapeHtml(id)}" title="${escapeHtml(id)}" style="cursor:pointer; text-decoration:underline;">${escapeHtml(nameOf(id))}</a>`;
}

/**
 * Details panel of an aggregated edge: the two groups, the count, and the
 * witnesses (`witnessesOf`) as "caller → callee" rows. Each name is a `.witness-node` link
 * (see `bindWitnessPanel`). The panel lists the first `limit` witnesses,
 * and a `.witness-show-all` button when there are more.
 */
export function witnessPanelHtml(
  sourceLabel: string, targetLabel: string,
  calls: ReadonlyArray<WitnessCall>, nameOf: NameOf,
  limit: number = WITNESS_LIST_CAP,
): string {
  const witnesses = witnessesOf(calls, nameOf);
  const shown = witnesses.slice(0, limit);
  const rows = shown.map(w => {
    const type = witnessTypeLabel(w.types);
    return `<li>${witnessLink(w.sourceId, nameOf)} → ${witnessLink(w.targetId, nameOf)}${type ? ` <em>(${escapeHtml(type)})</em>` : ''}</li>`;
  }).join('');
  const more = witnesses.length > shown.length
    ? `<p><button type="button" class="witness-show-all">Show all ${witnesses.length}</button></p>`
    : '';
  const pairs = witnesses.length === calls.length ? ''
    : `, between <strong>${witnesses.length}</strong> pair${witnesses.length === 1 ? '' : 's'} of functions`;
  return `
    <div class="cm-info witness-panel">
      <h3>${escapeHtml(sourceLabel)} → ${escapeHtml(targetLabel)}</h3>
      <p><strong>${calls.length}</strong> call${calls.length === 1 ? '' : 's'} behind this edge${pairs}</p>
      <h4>Witnesses (caller → callee):</h4>
      <ul class="witness-list">${rows}</ul>
      ${more}
      <p class="cm-hint"><em>Click a name to select that function</em></p>
    </div>
  `;
}

/**
 * Wire a panel from `witnessPanelHtml`: a name calls `onSelect` with its
 * node id, and "Show all" calls `onShowAll`.
 */
export function bindWitnessPanel(
  root: HTMLElement,
  onSelect: (id: string) => void,
  onShowAll: () => void,
): void {
  root.querySelectorAll<HTMLElement>('.witness-node').forEach(el => {
    el.addEventListener('click', event => {
      event.preventDefault();
      const id = el.dataset.nodeId;
      if (id) onSelect(id);
    });
  });
  root.querySelector('.witness-show-all')?.addEventListener('click', onShowAll);
}
