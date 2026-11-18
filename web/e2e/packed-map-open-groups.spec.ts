/**
 * E2E tests for opening a Packed Map group in another view
 * (docs/plans/packed-map.md, Phase 5): a crate in the Crate Map, a
 * directory in the Hierarchy, a file in the Call Graph, the `O` key, and
 * a real pointer double-click while the first click's zoom runs.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';

const LEAN = JSON.parse(readFileSync(new URL('../src/test-data/probe-lean-packed-map.json', import.meta.url), 'utf8'));

/**
 * Two crates with the same `src/lib.rs`. In alpha, `src/backend` holds the
 * directory `serial` and the file `iso2.rs`, whose function has no links.
 * The Packed Map draws it, the Hierarchy drops it, so there `src/backend`
 * is compressed into `src/backend/serial`. `field.rs` also holds a spec
 * function, which the default filters hide.
 */
const NODES: Array<[string, string, string, string?]> = [
  ['f1', 'alpha', 'src/backend/serial/field.rs'],
  ['f2', 'alpha', 'src/backend/serial/field.rs'],
  ['fspec', 'alpha', 'src/backend/serial/field.rs', 'spec'],
  ['iso2', 'alpha', 'src/backend/iso2.rs'],
  ['iso', 'alpha', 'src/iso.rs'],
  ['l1', 'alpha', 'src/lib.rs'],
  ['b1', 'beta', 'src/lib.rs'],
  ['b2', 'beta', 'src/b2.rs'],
];
const LINKS: [string, string][] = [['f2', 'f1'], ['f1', 'l1'], ['l1', 'b1'], ['b2', 'b1'], ['fspec', 'f1']];

/** The crate comes from the id (extractCrateName), not from `crate_name`. */
const CRATE = new Map(NODES.map(([name, crate]) => [name, crate]));
const id = (name: string) => `probe:${CRATE.get(name)}/${name}`;

function graph() {
  const nodes = NODES.map(([name, crate, path, kind]) => ({
    id: id(name), display_name: name, symbol: id(name),
    full_path: `/r/${crate}/${path}`, relative_path: path, file_name: path.split('/').pop(),
    parent_folder: path.split('/').slice(-2, -1)[0], crate_name: crate, is_libsignal: false, kind: kind ?? 'exec',
    dependencies: LINKS.filter(([s]) => s === name).map(([, t]) => id(t)),
    dependents: LINKS.filter(([, t]) => t === name).map(([s]) => id(s)),
  }));
  return {
    nodes,
    links: LINKS.map(([s, t]) => ({ source: id(s), target: id(t), type: 'inner' })),
    metadata: { total_nodes: nodes.length, total_edges: LINKS.length, project_root: '/r', generated_at: '2026-01-01' },
  };
}

async function openMap(page: Page): Promise<void> {
  await page.route('**/groups.json', (route: Route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(graph()) }));
  await page.goto('/probegraph/?json=groups.json&view=packed-map');
  await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 15000 });
}

function group(page: Page, id: string) {
  return page.locator(`.pm-group[data-group-id="${id}"]`);
}

async function shownIds(page: Page): Promise<string[]> {
  return (await page.locator('circle.node').evaluateAll(
    els => els.map(el => (el as any).__data__?.id as string),
  )).sort();
}

/** Click a group and double-click it, as the browser sends the events. */
async function dispatchDoubleClick(page: Page, id: string): Promise<void> {
  const g = group(page, id);
  await g.dispatchEvent('click', { detail: 1 });
  await g.dispatchEvent('click', { detail: 2 });
  await g.dispatchEvent('dblclick', { detail: 2 });
}

/** A screen point on the group's own circle: not on a function or a nested group. */
async function pointOnGroup(page: Page, id: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((groupId) => {
    const el = document.querySelector(`.pm-group[data-group-id="${groupId}"] > circle`)!;
    const box = el.getBoundingClientRect();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const r = box.width / 2;
    for (let f = 0.95; f > 0.3; f -= 0.05) {
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 16) {
        const x = cx + f * r * Math.cos(a);
        const y = cy + f * r * Math.sin(a);
        if (document.elementFromPoint(x, y) === el) return { x, y };
      }
    }
    return null;
  }, id);
  expect(point, `a free point on ${id}`).not.toBeNull();
  return point!;
}

test.describe('Packed Map: open a group in another view', () => {
  test('a directory opens the Hierarchy expanded to it, and Back returns', async ({ page }) => {
    await openMap(page);
    // Not compressed in the Packed Map: iso2.rs sits next to serial
    await expect(group(page, 'alpha/src/backend')).toBeAttached();
    await dispatchDoubleClick(page, 'alpha/src/backend');

    await expect(page.locator('#view-hierarchy')).toHaveClass(/active/);
    // The Hierarchy has no iso2 (no links), so backend is merged into serial
    await expect.poll(() => new URL(page.url()).searchParams.get('expanded'))
      .toBe('alpha,alpha/src,alpha/src/backend/serial');
    // Three containers, with field.rs collapsed inside serial
    await expect(page.locator('.hm-container')).toHaveCount(3);
    await expect(page.locator('.hm-group text', { hasText: /^field\.rs$/ })).toBeVisible();

    await page.goBack();
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);
    expect(new URL(page.url()).searchParams.get('packed')).toBe('alpha/src/backend');

    await page.goForward();
    await expect(page.locator('#view-hierarchy')).toHaveClass(/active/);
    expect(new URL(page.url()).searchParams.get('expanded')).toBe('alpha,alpha/src,alpha/src/backend/serial');
  });

  test('a file opens the Call Graph with its declarations, apart from the same path in another crate', async ({ page }) => {
    await openMap(page);
    await dispatchDoubleClick(page, 'alpha/src/lib.rs');

    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect(page.locator('#source-input')).toHaveValue('file src/lib.rs');
    await expect.poll(() => new URL(page.url()).searchParams.getAll('id')).toEqual([id('l1')]);
    // l1 and what it calls
    await expect.poll(() => shownIds(page)).toEqual([id('l1'), id('b1')]);

    await page.goBack();
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);
    await expect(page.locator('#source-input')).toHaveValue('');
  });

  test('a file whose declaration has no links still shows it', async ({ page }) => {
    await openMap(page);
    await dispatchDoubleClick(page, 'alpha/src/iso.rs');
    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect.poll(() => shownIds(page)).toEqual([id('iso')]);
  });

  test('a file with a declaration the filters hide says so in a toast', async ({ page }) => {
    await openMap(page);
    await dispatchDoubleClick(page, 'alpha/src/backend/serial/field.rs');
    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect.poll(() => shownIds(page)).toEqual([id('f1'), id('f2'), id('l1')]);
    await expect(page.locator('#toast-container'))
      .toContainText('1 of 3 declarations in src/backend/serial/field.rs are not drawn: 1 hidden by the filters');
  });

  test('a crate opens the Crate Map with the crate selected', async ({ page }) => {
    await openMap(page);
    await dispatchDoubleClick(page, 'beta');

    await expect(page.locator('#view-crate-map')).toHaveClass(/active/);
    await expect(page.locator('.cm-crate-group[data-crate="beta"] .cm-crate-box')).toHaveAttribute('stroke-width', '3');
    await expect(page.locator('#node-info h3')).toHaveText('beta');
    // Not a boundary source
    expect(new URL(page.url()).searchParams.get('source_crate')).toBeNull();

    await page.goBack();
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);
    expect(new URL(page.url()).searchParams.get('packed')).toBe('beta');
  });

  test('a pointer double-click while the zoom runs opens the first group, and Back returns to it', async ({ page }) => {
    await openMap(page);
    const target = 'alpha/src/backend';
    const { x, y } = await pointOnGroup(page, target);
    await page.mouse.click(x, y);
    // The zoom to the group is running: the second click lands on a moved map
    await page.waitForTimeout(150);
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });

    await expect(page.locator('#view-hierarchy')).toHaveClass(/active/);
    await expect.poll(() => new URL(page.url()).searchParams.get('expanded'))
      .toBe('alpha,alpha/src,alpha/src/backend/serial');
    await page.goBack();
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);
    expect(new URL(page.url()).searchParams.get('packed')).toBe(target);
  });

  test('O opens the zoomed group, and does nothing with no zoomed group', async ({ page }) => {
    await openMap(page);
    const svg = page.locator('.packed-map-svg');
    await svg.focus();
    await page.keyboard.press('o');
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);

    await group(page, 'beta').dispatchEvent('click');
    await expect.poll(() => new URL(page.url()).searchParams.get('packed')).toBe('beta');
    await svg.focus();
    await page.keyboard.press('o');
    await expect(page.locator('#view-crate-map')).toHaveClass(/active/);
    await expect(page.locator('#node-info h3')).toHaveText('beta');
  });

  test('Lean: a file two levels deep is a namespace and opens the Namespace Map', async ({ page }) => {
    await page.route('**/lean.json', (route: Route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(LEAN) }));
    await page.goto('/probegraph/?json=lean.json&view=packed-map');
    await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 15000 });
    await expect(page.locator('.pm-legend'))
      .toContainText('Double-click group: open a namespace in the Namespace Map, a directory in the Hierarchy, a file in the Call Graph');

    await dispatchDoubleClick(page, 'Demo/Basic.lean');
    await expect(page.locator('#view-crate-map')).toHaveClass(/active/);
    await expect(page.locator('#view-crate-map')).toHaveText('Namespace Map');
    await expect(page.locator('.cm-crate-group[data-crate="Demo/Basic.lean"] .cm-crate-box'))
      .toHaveAttribute('stroke-width', '3');
  });
});
