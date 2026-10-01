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
const shownNodeIds = (page: Page) => nodes(page).evaluateAll(els =>
  els.map(el => (el as unknown as { __data__: { id: string } }).__data__.id));
const nodeIndex = (page: Page, id: string) => nodes(page).evaluateAll((els, id) =>
  els.findIndex(el => (el as unknown as { __data__: { id: string } }).__data__.id === id), id);
const zoomTransform = (page: Page) => page.locator('#graph-container svg > g').first().getAttribute('transform');
const zoomScale = (transform: string | null) => Number(/scale\(([^)]+)\)/.exec(transform ?? '')?.[1] ?? 1);

test('a file picked while the default graph loads is not replaced by it', async ({ page }) => {
  let release!: () => void;
  const released = new Promise<void>(r => { release = r; });
  await page.route('**/graph.json', async route => {
    if (route.request().method() === 'GET') await released;
    await route.continue();
  });
  const defaultGraph = page.waitForResponse(r => r.url().endsWith('/graph.json') && r.request().method() === 'GET');
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  release();
  await defaultGraph;
  await page.waitForTimeout(1000);
  await expect(nodes(page)).toHaveCount(9);
  await expect(page.locator('#layer-switcher')).toBeVisible();
});

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

test('the Chapter Map legend names chapters', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  await page.locator('#view-crate-map').click();
  const legend = page.locator('.cm-legend');
  await expect(legend.locator('.cm-legend-header')).toContainText('Chapter Map');
  await expect(legend).toContainText('Cross-chapter calls');
  await expect(legend).not.toContainText(/crate/i);
});

test('the Crate Map legend follows a layer switch', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  await page.locator('#view-crate-map').click();
  const header = page.locator('.cm-legend .cm-legend-header');
  await expect(header).toContainText('Chapter Map');
  await page.locator('#layer-code').click();
  await expect(header).toContainText('Namespace Map');
  await page.locator('#layer-blueprint').click();
  await expect(header).toContainText('Chapter Map');
});

test('keeps each layer\'s Chapter Map boundary across switches', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  await page.locator('#view-crate-map').click();
  const src = page.locator('#source-crate-select');
  const tgt = page.locator('#target-crate-select');
  const firstChoice = (sel: typeof src, except = '') => sel.locator('option').evaluateAll(
    (els, except) => els.map(el => (el as HTMLOptionElement).value).find(v => v !== '' && v !== except) ?? '',
    except);
  const source = await firstChoice(src);
  await src.selectOption(source);
  const target = await firstChoice(tgt, source);
  expect(target).not.toBe('');
  await tgt.selectOption(target);
  await expect(src).toHaveValue(source);

  await page.locator('#layer-code').click();
  await expect(src).toHaveValue('');
  await expect(tgt).toHaveValue('');
  await page.locator('#layer-blueprint').click();
  await expect(src).toHaveValue(source);
  await expect(tgt).toHaveValue(target);
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

test('links a blueprint entry to its Lean declarations and back', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  // A Shift+click hidden target and a hidden target kind are turned back on
  await page.locator('#layer-code').click();
  await nodes(page).nth(await nodeIndex(page, 'probe:collatzStep')).dispatchEvent('click', { shiftKey: true });
  await expect(page.locator('#hidden-nodes-list')).toContainText('collatzStep');
  await page.locator('#show-exec-functions').uncheck();
  await page.locator('#layer-blueprint').click();

  const index = await nodes(page).evaluateAll(els =>
    els.findIndex(el => (el as unknown as { __data__: { id: string } }).__data__.id === 'probe:blueprint:collatz_step'));
  await nodes(page).nth(index).dispatchEvent('click');
  const info = page.locator('#node-info');
  await info.locator('a.navigate-to-layer', { hasText: /^collatzStep$/ }).click();

  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  await expect(page.locator('#show-exec-functions')).toBeChecked();
  await expect(info.locator('h3')).toHaveText('collatzStep');
  const params = new URL(page.url()).searchParams;
  expect(params.getAll('id')).toEqual(['probe:collatzStep']);
  expect(params.get('dir')).toBe('both');
  expect(params.has('depth')).toBe(false);  // 1 is the default
  const shownIds = await nodes(page).evaluateAll(els =>
    els.map(el => (el as unknown as { __data__: { id: string } }).__data__.id));
  expect(shownIds).toContain('probe:collatzStep');

  await info.locator('a.navigate-to-layer[data-layer="blueprint"]').click();
  await expect(page.locator('#layer-blueprint')).toHaveClass(/active/);
  await expect(info.locator('h3')).toHaveText('collatz_step');
  expect(new URL(page.url()).searchParams.getAll('id')).toEqual(['probe:blueprint:collatz_step']);

  // The graph's hover and click act on the blueprint layer, not the code one
  const blueprintIds = await shownNodeIds(page);
  expect(blueprintIds.every(id => id.startsWith('probe:blueprint:'))).toBe(true);
  const neighbour = await nodeIndex(page, blueprintIds.find(id => id !== 'probe:blueprint:collatz_step')!);
  await nodes(page).nth(neighbour).dispatchEvent('mouseenter');
  await nodes(page).nth(neighbour).dispatchEvent('mouseleave');
  await nodes(page).nth(neighbour).dispatchEvent('click');
  await expect(nodes(page)).toHaveCount(blueprintIds.length);
  expect((await shownNodeIds(page)).every(id => id.startsWith('probe:blueprint:'))).toBe(true);

  await page.goBack();
  await expect(page.locator('#layer-code')).toHaveClass(/active/);
});

test('double-clicking a blueprint entry opens its bound declarations', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  await nodes(page).nth(await nodeIndex(page, 'probe:blueprint:collatz_step')).dblclick();

  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  await expect(page.locator('.toast')).toContainText('collatz_step: 2 bound declarations');
  const params = new URL(page.url()).searchParams;
  expect(params.getAll('id')).toEqual(['probe:collatzStep', 'probe:collatzTerminatesAtOne']);
  expect(params.get('dir')).toBe('both');
  const shownIds = await nodes(page).evaluateAll(els =>
    els.map(el => (el as unknown as { __data__: { id: string } }).__data__.id));
  expect(shownIds).toEqual(expect.arrayContaining(['probe:collatzStep', 'probe:collatzTerminatesAtOne']));

  await page.goBack();
  await expect(page.locator('#layer-blueprint')).toHaveClass(/active/);
  await expect(nodes(page)).toHaveCount(9);
});

test('a slow double-click whose second click misses the moved node still drills down', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  await nodes(page).nth(await nodeIndex(page, 'probe:blueprint:collatz_step')).click();
  await page.waitForTimeout(300);
  // Only the second click of the double-click, landing on the background
  const svg = (await page.locator('#graph-container svg').boundingBox())!;
  await page.mouse.move(svg.x + 5, svg.y + 5);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });

  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  expect(new URL(page.url()).searchParams.getAll('id'))
    .toEqual(['probe:collatzStep', 'probe:collatzTerminatesAtOne']);
  // The first click's selection is not left on the blueprint layer,
  // in memory or in its history entry
  await page.goBack();
  await expect(page.locator('#layer-blueprint')).toHaveClass(/active/);
  await expect(nodes(page)).toHaveCount(9);
  expect(new URL(page.url()).searchParams.has('sel')).toBe(false);
  await page.goForward();
  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  await page.locator('#layer-blueprint').click();
  await expect(nodes(page)).toHaveCount(9);
});

test('double-clicking the background after clicking a node does not drill down', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  await nodes(page).nth(await nodeIndex(page, 'probe:blueprint:collatz_step')).click();
  await page.waitForTimeout(300);
  const svg = (await page.locator('#graph-container svg').boundingBox())!;
  await page.mouse.click(svg.x + 5, svg.y + 5, { clickCount: 2 });

  await page.waitForTimeout(300);
  await expect(page.locator('#layer-blueprint')).toHaveClass(/active/);
  expect(new URL(page.url()).searchParams.has('id')).toBe(false);
});

test('double-clicking a code-layer node zooms', async ({ page }) => {
  await loadFixture(page);
  await page.locator('#layer-code').click();
  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  await nodes(page).nth(await nodeIndex(page, 'probe:collatzStep')).dispatchEvent('click');
  // Let the re-query after the selection settle its camera fit
  await page.waitForTimeout(1000);
  const before = zoomScale(await zoomTransform(page));
  await nodes(page).nth(await nodeIndex(page, 'probe:collatzStep')).dispatchEvent('dblclick');

  await expect.poll(async () => zoomScale(await zoomTransform(page))).toBeCloseTo(2 * before);
  await expect(page.locator('#layer-code')).toHaveClass(/active/);
});

test('double-clicking an entry with no bound declarations stays on the blueprint layer', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  const before = page.url();
  await nodes(page).nth(await nodeIndex(page, 'probe:blueprint:addition_assoc')).dblclick();
  await expect(page.locator('.toast')).toContainText('addition_assoc: no bound declarations');
  await expect(page.locator('#layer-blueprint')).toHaveClass(/active/);
  expect(page.url()).toBe(before);
});

test('a slow double-click on an entry with no bound declarations leaves no selection', async ({ page }) => {
  await loadFixture(page);
  await expect(nodes(page)).toHaveCount(9, { timeout: 15000 });
  await nodes(page).nth(await nodeIndex(page, 'probe:blueprint:addition_assoc')).click();
  await page.waitForTimeout(300);
  const svg = (await page.locator('#graph-container svg').boundingBox())!;
  await page.mouse.move(svg.x + 5, svg.y + 5);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });

  await expect(page.locator('.toast')).toContainText('addition_assoc: no bound declarations');
  await expect(page.locator('#layer-blueprint')).toHaveClass(/active/);
  await expect(nodes(page)).toHaveCount(9);
  expect(new URL(page.url()).searchParams.has('sel')).toBe(false);
});

test('a Lean declaration links back to its blueprint entry', async ({ page }) => {
  await loadFixture(page);
  await page.locator('#layer-code').click();
  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  await nodes(page).nth(await nodeIndex(page, 'probe:collatzTerminatesAtOne')).dispatchEvent('click');
  const info = page.locator('#node-info');
  await expect(info.locator('h3')).toHaveText('collatzTerminatesAtOne');
  await info.locator('a.navigate-to-layer[data-layer="blueprint"]').click();
  await expect(page.locator('#layer-blueprint')).toHaveClass(/active/);
  await expect(info.locator('h3')).toHaveText('collatz_step');
});
