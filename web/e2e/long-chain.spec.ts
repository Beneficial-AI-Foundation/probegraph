/**
 * E2E test for long chain results (issue #113): the Call Graph folds a
 * chain of 15 layers into bands, so the whole result fits at a readable
 * scale instead of a line too small to read (scale 0.4 before the fold).
 */

import { test, expect, type Route } from '@playwright/test';

// n00 -> n01 -> ... -> n14
const names = Array.from({ length: 15 }, (_, i) => `n${String(i).padStart(2, '0')}`);
const atoms = Object.fromEntries(names.map((name, i) => [`probe:${name}`, {
  kind: 'theorem', language: 'lean', 'display-name': name,
  dependencies: i + 1 < names.length ? [`probe:${names[i + 1]}`] : [],
  'code-text': { 'lines-start': 1, 'lines-end': 2 }, 'code-path': `T/${name}.lean`, 'code-module': 'T',
  'verification-status': 'verified',
}]));

test('a long chain fits in the view at a readable scale', async ({ page }) => {
  await page.route('**/chain.json', (route: Route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(atoms) }));
  await page.goto('/probegraph/?json=chain.json&source=n00&sink=n14');
  await expect(page.locator('circle.node')).toHaveCount(15, { timeout: 15000 });

  // Once the camera and the layout settle, the scale is readable and every
  // node and label is inside the view
  const view = () => page.evaluate(() => {
    const transform = document.querySelector('#graph-container svg > g')!.getAttribute('transform') ?? '';
    const box = document.querySelector('#graph-container svg')!.getBoundingClientRect();
    const outside = [...document.querySelectorAll('#graph-container circle.node, #graph-container text.label')]
      .map(el => el.getBoundingClientRect())
      .filter(r => r.left < box.left || r.right > box.right || r.top < box.top || r.bottom > box.bottom)
      .length;
    return { readable: Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? 0) > 0.8, outside };
  });
  // Past the 400 ms camera move, which starts at scale 1
  await page.waitForTimeout(500);
  await expect.poll(view, { timeout: 10000 }).toEqual({ readable: true, outside: 0 });
});
