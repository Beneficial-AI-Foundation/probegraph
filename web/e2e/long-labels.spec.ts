/**
 * E2E test for long labels: once the Call Graph simulation settles, the
 * labels of two linked nodes in one band do not overlap. The link force
 * used to pull the nodes inside their label width.
 */

import { test, expect, type Route } from '@playwright/test';

const names = ['a', 'b'].map(c => c.repeat(60));
const atoms = Object.fromEntries(names.map((name, i) => [`probe:${name}`, {
  kind: 'theorem', language: 'lean', 'display-name': name,
  dependencies: i === 0 ? [`probe:${names[1]}`] : [],
  'code-text': { 'lines-start': 1, 'lines-end': 2 }, 'code-path': `T/${i}.lean`, 'code-module': 'T',
  'verification-status': 'verified',
}]));

test('the labels of two linked nodes stay apart after the layout settles', async ({ page }) => {
  // The sidebars take 640 px: this leaves 800 px for the graph, enough to
  // draw both labels side by side in one band
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/labels.json', (route: Route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(atoms) }));
  await page.goto('/probegraph/?json=labels.json');
  await expect(page.locator('circle.node')).toHaveCount(2, { timeout: 15000 });

  // Gap between the two labels, in layout units, once the nodes stop moving
  const gap = () => page.evaluate(() => {
    const [a, b] = [...document.querySelectorAll<SVGTextElement>('#graph-container text.label')]
      .map(t => ({ x: Number(t.getAttribute('x')), width: t.getBBox().width }))
      .sort((p, q) => p.x - q.x);
    return Math.round(b.x - b.width / 2 - (a.x + a.width / 2));
  });
  let last = NaN;
  await expect.poll(async () => { const g = await gap(); const still = g === last; last = g; return still; },
    { timeout: 15000, intervals: [500] }).toBe(true);
  expect(last).toBeGreaterThan(0);
});
