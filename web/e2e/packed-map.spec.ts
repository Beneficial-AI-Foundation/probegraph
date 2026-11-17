/**
 * E2E tests for opening a Packed Map function in the Call Graph
 * (docs/plans/packed-map.md, "Open in the Call Graph"): double-click and
 * Shift+Enter, the query the reveal sets, and Back.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// h calls 300 leaves, which is over the 200-node render cap. a calls b.
const LEAVES = Array.from({ length: 300 }, (_, i) => `probe:l${i}`);
const LINKS: [string, string][] = [
  ...LEAVES.map(l => ['probe:h', l] as [string, string]),
  ['probe:a', 'probe:b'],
];

function graph() {
  const ids = ['probe:h', ...LEAVES, 'probe:a', 'probe:b'];
  const nodes = ids.map(id => {
    const name = id.slice('probe:'.length);
    return {
      id, display_name: name, symbol: id,
      full_path: `/r/${name}.rs`, relative_path: `src/${name}.rs`, file_name: `${name}.rs`,
      parent_folder: 'src', crate_name: 'r', is_libsignal: false, kind: 'exec',
      dependencies: LINKS.filter(([s]) => s === id).map(([, t]) => t),
      dependents: LINKS.filter(([, t]) => t === id).map(([s]) => s),
    };
  });
  return {
    nodes,
    links: LINKS.map(([source, target]) => ({ source, target, type: 'inner' })),
    metadata: { total_nodes: nodes.length, total_edges: LINKS.length, project_root: '/r', generated_at: '2026-01-01' },
  };
}

async function open(page: Page, query: string, view = '&view=packed-map'): Promise<void> {
  await page.route('**/packed.json', (route: Route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(graph()) }));
  await page.goto(`/probegraph/?json=packed.json${view}${query}`);
  await expect(page.locator('#stats')).toContainText('Total Nodes', { timeout: 15000 });
}

/** Tag every function circle with its node id, so tests can find it. */
async function tagCircles(page: Page): Promise<void> {
  await page.locator('.pm-fn').evaluateAll(els => els.forEach(el =>
    el.setAttribute('data-test-id', (el as any).__data__.data.node.id)));
}

async function shownIds(page: Page): Promise<string[]> {
  return (await page.locator('circle.node').evaluateAll(
    els => els.map(el => (el as any).__data__?.id as string),
  )).sort();
}

test.describe('Packed Map: open in the Call Graph', () => {
  test('double-click queries a function the capped Call Graph leaves out, and Back returns', async ({ page }) => {
    // The Call Graph draws 200 of the 302 nodes: pick a leaf it leaves out
    await open(page, '', '');
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const drawn = new Set(await shownIds(page));
    const left = LEAVES.find(l => !drawn.has(l))!;
    await page.locator('#view-packed-map').click();
    await expect(page.locator('.pm-fn').first()).toBeVisible();
    await tagCircles(page);
    // Programmatic: the circles are small, and a coordinate click can miss
    await page.locator(`.pm-fn[data-test-id="${left}"]`).dispatchEvent('dblclick');

    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect(page.locator('.pm-fn')).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(left);
    await expect.poll(() => shownIds(page)).toEqual(['probe:h', left]);
    await expect(page.locator('#node-info')).toContainText(left.slice('probe:'.length));

    await page.goBack();
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);
    await expect(page.locator('.pm-fn').first()).toBeVisible();
    expect(new URL(page.url()).searchParams.get('id')).toBeNull();
  });

  test('double-click on a function the Call Graph draws keeps the overview, and Back returns', async ({ page }) => {
    await open(page, '', '');
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const ids = new Set(await shownIds(page));
    const leaf = LEAVES.find(l => ids.has(l))!;
    await page.locator('#view-packed-map').click();
    await expect(page.locator('.pm-fn').first()).toBeVisible();
    await tagCircles(page);
    await page.locator(`.pm-fn[data-test-id="${leaf}"]`).dispatchEvent('dblclick');

    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect(page.locator('#node-info')).toContainText(leaf.slice('probe:'.length));
    expect(new URL(page.url()).searchParams.get('id')).toBeNull();
    expect(await shownIds(page)).toContain(leaf);

    await page.goBack();
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);
    await expect(page.locator('.pm-fn').first()).toBeVisible();
  });

  test('double-click keeps a query that reaches the function', async ({ page }) => {
    await open(page, '&id=probe:a&dir=callees');
    await expect(page.locator('.pm-fn').first()).toBeVisible();
    await tagCircles(page);
    await expect(page.locator('.pm-fn')).toHaveCount(2);
    await page.locator('.pm-fn[data-test-id="probe:b"]').dispatchEvent('dblclick');

    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect.poll(() => shownIds(page)).toEqual(['probe:a', 'probe:b']);
    expect(new URL(page.url()).searchParams.get('id')).toBe('probe:a');
    await expect(page.locator('#node-info')).toContainText('b');
  });

  test('Shift+Enter opens the function in the focus ring', async ({ page }) => {
    await open(page, '');
    await expect(page.locator('.pm-fn').first()).toBeVisible();
    await page.locator('.packed-map-svg').focus();
    await page.keyboard.press('End');
    const focused = await page.locator('.packed-map-svg').evaluate(svg => {
      const id = svg.getAttribute('aria-activedescendant')!;
      return (document.getElementById(id) as any).__data__.data.node.id as string;
    });

    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect.poll(async () => (await shownIds(page)).includes(focused)).toBe(true);
    await expect(page.locator('#node-info')).toContainText(focused.slice('probe:'.length));
  });
});
