/**
 * Node-details section for probe-leanblueprint fields: the blueprint entry
 * itself on the blueprint layer, pointers to its entries on the code layer.
 * Bound declarations and entries link across layers. Every value comes from
 * a third-party extract and is escaped; `statementText` is markup and is
 * shown as plain text.
 */
import { BlueprintInfo } from './types';
import { escapeHtml } from './html';

/**
 * Issue URL for `issue` in `repo`, or null unless `repo` is exactly an
 * `https://github.com/<owner>/<repo>` URL and `issue` a positive integer.
 */
export function githubIssueUrl(repo: string | undefined, issue: string | undefined): string | null {
  if (!repo || !issue || !/^[1-9][0-9]*$/.test(issue)) return null;
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  const m = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return `https://github.com/${m[1]}/${m[2]}/issues/${issue}`;
}

export interface BlueprintDetailsContext {
  /** Repository URL of the Lean source, for issue links. */
  repo?: string;
  /** Display name of a code-layer atom, for bound declarations. */
  codeName: (id: string) => string | undefined;
}

const row = (label: string, value: string) =>
  `<div class="node-detail"><strong>${label}:</strong> ${value}</div>`;

const listHtml = (label: string, itemsHtml: string[]) =>
  `<div class="node-detail"><strong>${label} (${itemsHtml.length}):</strong>
    <ul class="node-list">${itemsHtml.map(i => `<li>${i}</li>`).join('')}</ul></div>`;

const list = (label: string, items: string[]) => listHtml(label, items.map(escapeHtml));

/**
 * Link to `id` on the other layer; main.ts handles `.navigate-to-layer`
 * clicks. `textHtml` must already be escaped.
 */
const layerLink = (layer: 'blueprint' | 'code', id: string, textHtml: string) =>
  `<a href="#" class="navigate-to-layer" data-layer="${layer}" data-node-id="${escapeHtml(id)}" style="cursor:pointer; text-decoration:underline;">${textHtml}</a>`;

/** Status with its source; `declared` statuses can overclaim (probe-leanblueprint spec). */
function status(value: string | undefined, source: string | undefined): string {
  if (!value) return '<em>unknown</em>';
  const declared = source === 'declared'
    ? ' <span title="Declared in the blueprint source, not derived from the Lean code" style="color:var(--pg-text-faint)">(declared)</span>'
    : '';
  return `${escapeHtml(value)}${declared}`;
}

/** Details of a blueprint node atom. */
export function blueprintNodeDetailsHtml(info: BlueprintInfo, ctx: BlueprintDetailsContext): string {
  const parts: string[] = [];
  const heading = [info.title, info.chapter, info.group].filter(Boolean).map(escapeHtml).join(' · ');
  if (heading) parts.push(`<div class="node-detail" style="color:var(--pg-text-muted)">${heading}</div>`);
  parts.push(row('Statement', status(info.statementStatus, info.statusSource)));
  parts.push(row('Proof', status(info.proofStatus, info.statusSource)));
  if (info.nodeClass) parts.push(row('Class', escapeHtml(info.nodeClass)));
  if (info.mismatch) {
    parts.push(row('Status mismatch', `<span style="color:var(--pg-status-failed)">${escapeHtml(info.mismatch)}</span>`));
  }
  const issueUrl = githubIssueUrl(ctx.repo, info.githubIssue);
  if (issueUrl) {
    parts.push(row('Issue', `<a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(info.githubIssue)}</a>`));
  } else if (info.githubIssue) {
    parts.push(row('Issue', escapeHtml(info.githubIssue)));
  }
  if (info.statementText) {
    parts.push(`<div class="node-detail"><strong>Statement text:</strong>
      <div class="code-block" style="white-space:pre-wrap">${escapeHtml(info.statementText)}</div></div>`);
  }
  if (info.bindings?.length) {
    parts.push(listHtml('Bound declarations', info.bindings.map(id =>
      layerLink('code', id, escapeHtml(ctx.codeName(id) ?? id)))));
  }
  if (info.missingDecls?.length) parts.push(list('Missing declarations', info.missingDecls));
  if (info.upstreamDecls?.length) parts.push(list('Upstream declarations', info.upstreamDecls));
  return parts.join('');
}

/** A blueprint-layer entry pointing at a code-layer atom. */
export interface BlueprintEntryRef {
  id: string;
  info: BlueprintInfo;
}

const entryText = (info: BlueprintInfo) =>
  `${info.title ? `${escapeHtml(info.title)} ` : ''}<code>${escapeHtml(info.label)}</code>`;

/**
 * The blueprint entries of a code-layer atom, each linked to its node:
 * those binding it and the one its `blueprint-label` names. Under label
 * collisions these can be several. With none on the blueprint layer, the
 * atom's own label is shown unlinked.
 */
export function blueprintBackrefHtml(info: BlueprintInfo | undefined, entries: BlueprintEntryRef[]): string {
  if (entries.length === 0) return info ? row('Blueprint', entryText(info)) : '';
  const links = entries.map(e => layerLink('blueprint', e.id, entryText(e.info)));
  return links.length === 1 ? row('Blueprint', links[0]) : listHtml('Blueprint entries', links);
}
