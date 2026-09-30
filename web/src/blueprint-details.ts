/**
 * Node-details section for probe-leanblueprint fields: the blueprint entry
 * itself on the blueprint layer, a one-line pointer to the owning entry on
 * the code layer. Every value comes from a third-party extract and is
 * escaped; `statementText` is markup and is shown as plain text.
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

const list = (label: string, items: string[]) =>
  `<div class="node-detail"><strong>${label} (${items.length}):</strong>
    <ul class="node-list">${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`;

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
    parts.push(list('Bound declarations', info.bindings.map(id => ctx.codeName(id) ?? id)));
  }
  if (info.missingDecls?.length) parts.push(list('Missing declarations', info.missingDecls));
  if (info.upstreamDecls?.length) parts.push(list('Upstream declarations', info.upstreamDecls));
  return parts.join('');
}

/** The owning blueprint entry of a code-layer atom. */
export function blueprintBackrefHtml(info: BlueprintInfo): string {
  const title = info.title ? `${escapeHtml(info.title)} ` : '';
  return row('Blueprint', `${title}<code>${escapeHtml(info.label)}</code>`);
}
