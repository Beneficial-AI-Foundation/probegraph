import { describe, it, expect } from 'vitest';
import { escapeHtml } from './html';

describe('escapeHtml', () => {
  it('escapes markup and both quote styles', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe(
      '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;',
    );
  });

  it('maps null and undefined to the empty string', () => {
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
  });

  it('stringifies non-string values', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});
