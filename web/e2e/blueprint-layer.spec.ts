import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// probe-leanblueprint project-template extract: 9 node atoms, 9 Lean atoms
const FIXTURE = readFileSync(new URL('../src/test-data/blueprint-project-template.json', import.meta.url));

async function loadFixture(page: Page): Promise<void> {
  await page.goto('/probegraph/');
  await page.locator('#file-input').setInputFiles({
    name: 'extract.json', mimeType: 'application/json', buffer: FIXTURE,
  });
}

const nodes = (page: Page) => page.locator('circle.node');
const layerParam = (page: Page) => new URL(page.url()).searchParams.get('layer');

test('opens on the blueprint layer and switches to code and back', async ({ page }) => {
  await loadFixture(page);
  await expect(page.locator('#layer-switcher')).toBeVisible();
  await expect(page.locator('#layer-blueprint')).toHaveClass(/active/);
  // Isolated entries (addition_runtime_note, multiplication_assoc) included
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  expect(layerParam(page)).toBeNull();

  await page.locator('#layer-code').click();
  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  expect(layerParam(page)).toBe('code');
  await expect(page.locator('#view-crate-map')).toHaveText(/Namespace Map/);

  await page.goBack();
  await expect(page.locator('#layer-blueprint')).toHaveClass(/active/);
  await expect(nodes(page)).toHaveCount(9);
  await expect(page.locator('#view-crate-map')).toHaveText(/Chapter Map/);
});

test('crate dropdowns and file list follow the layer', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  const options = () => page.locator('#source-crate-select option').allTextContents();
  const files = () => page.locator('#file-list .file-list-item').evaluateAll(
    els => els.map(el => el.getAttribute('data-path')));
  expect(await options()).toContain('blueprint/Addition');

  await page.locator('#layer-code').click();
  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  expect((await options()).some(o => o.startsWith('blueprint/'))).toBe(false);
  expect((await files()).some(p => p?.startsWith('blueprint/'))).toBe(false);
});

test('keeps each layer\'s filters across switches, including after back', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  await page.locator('#show-exec-functions').uncheck();
  await expect(nodes(page)).toHaveCount(5);

  await page.locator('#layer-code').click();
  await expect(page.locator('#show-exec-functions')).toBeChecked();
  await page.goBack();
  await expect(page.locator('#show-exec-functions')).not.toBeChecked();
  await expect(nodes(page)).toHaveCount(5);

  await page.locator('#layer-code').click();
  await expect(page.locator('#show-exec-functions')).toBeChecked();
  await page.locator('#layer-blueprint').click();
  await expect(page.locator('#show-exec-functions')).not.toBeChecked();
});

test('node details show the blueprint entry', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  const index = await nodes(page).evaluateAll(els =>
    els.findIndex(el => (el as unknown as { __data__: { id: string } }).__data__.id === 'probe:blueprint:collatz_step'));
  await nodes(page).nth(index).dispatchEvent('click');
  const info = page.locator('#node-info');
  await expect(info.locator('h3')).toHaveText('collatz_step');
  await expect(info).toContainText('Definition 3.2.1 · Collatz · collatz_core');
  await expect(info).toContainText('Statement: formalized');
  await expect(info).toContainText('Proof: proved');
  await expect(info).toContainText('Bound declarations (2):');
  await expect(info).toContainText('collatzTerminatesAtOne');
  await expect(info).toContainText('Collatz.lean (Line 35)');
  await expect(info).toContainText('Uses (2):');
  await expect(info).not.toContainText('External');
});
