import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// probe-leanblueprint project-template extract: 9 node atoms, 9 Lean atoms
const FIXTURE = JSON.parse(readFileSync(
  new URL('../src/test-data/blueprint-project-template.json', import.meta.url), 'utf8'));

// Padded past the 10 MiB auto-load cap, so the viewer defers the load
function serveLarge(page: Page, extract: unknown): Promise<void> {
  const body = JSON.stringify(extract) + ' '.repeat(11 * 1024 * 1024);
  return page.route(url => url.pathname === '/large.json', route => route.fulfill({ body, contentType: 'application/json' }));
}

async function includeFiles(page: Page, pattern: string): Promise<void> {
  await page.goto('/probegraph/?json=/large.json');
  await expect(page.locator('#load-graph-btn')).toBeVisible({ timeout: 15000 });
  await page.locator('#include-files').fill(pattern);
  await page.locator('#include-files').press('Enter');
}

const nodes = (page: Page) => page.locator('circle.node');
const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

test('Include Files on a deferred graph loads the code layer with the filter', async ({ page }) => {
  await serveLarge(page, FIXTURE);
  await includeFiles(page, 'Collatz.lean');
  await expect(page.locator('#layer-code')).toHaveClass(/active/, { timeout: 15000 });
  await expect(nodes(page)).toHaveCount(3);
  await expect(page.locator('#include-files')).toHaveValue('Collatz.lean');
  expect(param(page, 'files')).toBe('Collatz.lean');
  expect(param(page, 'layer')).toBe('code');
});

test('a shared link to a deferred graph shows its query and loads it', async ({ page }) => {
  await serveLarge(page, FIXTURE);
  await page.goto('/probegraph/?json=/large.json&layer=code&files=Collatz.lean&source=collatz_conjecture');
  await expect(page.locator('#load-graph-btn')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#source-input')).toHaveValue('collatz_conjecture');
  await expect(page.locator('#include-files')).toHaveValue('Collatz.lean');

  await page.locator('#load-graph-btn').click();
  await expect(page.locator('#layer-code')).toHaveClass(/active/, { timeout: 15000 });
  await expect(page.locator('#source-input')).toHaveValue('collatz_conjecture');
  await expect(nodes(page)).toHaveCount(2);
  expect(param(page, 'source')).toBe('collatz_conjecture');
  expect(param(page, 'files')).toBe('Collatz.lean');
});

test('an ambiguous Include Files pattern finishes loading the graph after the choice', async ({ page }) => {
  const extract = structuredClone(FIXTURE);
  extract.data['probe:collatzStep']['code-path'] = 'ProjectTemplate/Other/Collatz.lean';
  await serveLarge(page, extract);
  await includeFiles(page, 'Collatz.lean');
  const dropdown = page.locator('#file-disambiguation-dropdown');
  await expect(dropdown.locator('.dropdown-item')).toHaveCount(2, { timeout: 15000 });
  await dropdown.locator('.btn-all').click();

  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  await expect(nodes(page)).toHaveCount(3);
  expect(param(page, 'layer')).toBe('code');
  expect(param(page, 'files')).toContain('Other/Collatz.lean');
  // The code layer's filter panels are rendered, and switching layers works
  await expect(page.locator('#show-exec-functions')).toBeChecked();
  await page.locator('#layer-blueprint').click();
  await expect(nodes(page)).toHaveCount(9);
  await page.goBack();
  await expect(nodes(page)).toHaveCount(3);
});
