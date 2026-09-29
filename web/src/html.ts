/**
 * Escape a graph-provided value for interpolation into HTML text or a quoted
 * attribute. `null`/`undefined` become the empty string; numbers are
 * stringified, since extract fields typed as numbers are not validated.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
