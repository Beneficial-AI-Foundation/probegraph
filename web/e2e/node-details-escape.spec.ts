import { test, expect } from '@playwright/test';

// Graph strings come from third-party extracts; the details panel must show
// them as text, never parse them as markup.
const NAME = '<img src=x onerror="window.__pwned=1">name';
const PATH = 'Evil/<b id="injected">P</b>.lean';

const atoms = {
  'probe:evil': {
    kind: 'theorem',
    'display-name': NAME,
    dependencies: ['probe:other'],
    'code-text': { 'lines-start': 1, 'lines-end': 2 },
    'code-path': PATH,
    'code-module': 'Evil',
  },
  'probe:other': {
    kind: '<i id="kind-injected">def</i>',
    'display-name': NAME + '2',
    dependencies: [],
    'code-text': { 'lines-start': 3, 'lines-end': 4 },
    'code-path': PATH,
    'code-module': 'Evil',
  },
};

test('node details render graph strings as text', async ({ page }) => {
  await page.goto('/probegraph/');
  await page.locator('#file-input').setInputFiles({
    name: 'evil.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(atoms)),
  });

  const nodes = page.locator('circle.node');
  await expect(nodes).toHaveCount(2, { timeout: 15000 });
  for (let i = 0; i < 2; i++) {
    await nodes.nth(i).click();
    const info = page.locator('#node-info');
    await expect(info.locator('h3')).toHaveText(new RegExp(`^${NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}2?$`));
    await expect(info).toContainText(PATH);
    await expect(info.locator('img, #injected, #kind-injected')).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});
