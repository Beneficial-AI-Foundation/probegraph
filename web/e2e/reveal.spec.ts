/**
 * E2E tests for the search half of revealNode (docs/plans/graph-search.md,
 * Phase 0): the toast actions, their history entries, the raised render
 * cap and centring. Nothing in the UI calls it before the search box
 * (Phase 1), so the tests use the dev-only window.__revealNode hook.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';

// h calls 300 leaves, which is over the 200-node render cap. a calls b.
// s is a spec function (hidden by default) that calls t.
const LEAVES = Array.from({ length: 300 }, (_, i) => `probe:l${i}`);

function graph(leaves = LEAVES) {
  const LINKS: [string, string][] = [
    ...leaves.map(l => ['probe:h', l] as [string, string]),
    ['probe:a', 'probe:b'],
    ['probe:s', 'probe:t'],
  ];
  const ids = ['probe:h', ...leaves, 'probe:a', 'probe:b', 'probe:s', 'probe:t'];
  const nodes = ids.map(id => {
    const name = id.slice('probe:'.length);
    return {
      id, display_name: name, symbol: id,
      full_path: `/r/${name}.rs`, relative_path: `src/${name}.rs`, file_name: `${name}.rs`,
      parent_folder: 'src', crate_name: '', is_libsignal: false,
      kind: name === 's' ? 'spec' : 'exec', ...(name === 's' ? { mode: 'spec' } : {}),
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

type Policy = { kind: 'replace' } | { kind: 'anchor'; role: 'source' | 'sink' };

async function open(page: Page, query: string, body: unknown = graph()): Promise<void> {
  await page.route('**/reveal.json', (route: Route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }));
  await page.goto(`/probegraph/?json=reveal.json${query}`);
  await expect(page.locator('#stats')).toContainText('Total Nodes', { timeout: 15000 });
}

function reveal(page: Page, id: string, opts: { policy: Policy; offer?: boolean; center?: boolean }) {
  return page.evaluate(([nodeId, o]) =>
    (window as unknown as { __revealNode: (id: string, o: unknown) => { reason: string } })
      .__revealNode(nodeId, o).reason, [id, opts] as const);
}

async function shownIds(page: Page): Promise<string[]> {
  return (await page.locator('circle.node').evaluateAll(
    els => els.map(el => (el as any).__data__?.id as string),
  )).sort();
}

const transform = (page: Page) => page.locator('#graph-container svg > g').getAttribute('transform');
const historyLength = (page: Page) => page.evaluate(() => window.history.length);
const toastAction = (page: Page, label: string) => page.locator('.toast-action', { hasText: label });

/** Distance in pixels from the node's circle to the middle of the graph. */
function offCentre(page: Page, id: string): Promise<number> {
  return page.evaluate(nodeId => {
    const svg = document.querySelector('#graph-container svg')!.getBoundingClientRect();
    const circle = [...document.querySelectorAll('circle.node')]
      .find(c => (c as any).__data__?.id === nodeId)!.getBoundingClientRect();
    const dx = circle.x + circle.width / 2 - (svg.x + svg.width / 2);
    const dy = circle.y + circle.height / 2 - (svg.y + svg.height / 2);
    return Math.hypot(dx, dy);
  }, id);
}

const A_CALLEES = `&id=${encodeURIComponent('probe:a')}&dir=callees&label=a`;
const H_CALLEES = `&id=${encodeURIComponent('probe:h')}&dir=callees&label=h&depth=1`;

test.describe('revealNode from search', () => {
  test('Show it relaxes the filter and queries the hit, and one Back undoes both', async ({ page }) => {
    await open(page, A_CALLEES);
    await expect.poll(() => shownIds(page)).toEqual(['probe:a', 'probe:b']);

    expect(await reveal(page, 'probe:s', { policy: { kind: 'replace' }, offer: true })).toBe('filtered');
    await expect(page.locator('.toast-with-actions')).toContainText('s is hidden by the Spec filter');
    const before = await historyLength(page);
    await toastAction(page, 'Show it').click();

    await expect.poll(() => shownIds(page)).toEqual(['probe:s', 'probe:t']);
    await expect(page.locator('#show-spec-functions')).toBeChecked();
    expect(await historyLength(page)).toBe(before + 1);

    await page.goBack();
    await expect.poll(() => shownIds(page)).toEqual(['probe:a', 'probe:b']);
    await expect(page.locator('#show-spec-functions')).not.toBeChecked();
  });

  test('a toast action after the query changed does nothing', async ({ page }) => {
    await open(page, A_CALLEES);
    expect(await reveal(page, 'probe:s', { policy: { kind: 'replace' }, offer: true })).toBe('filtered');
    await page.locator('#source-input').fill('h');
    await page.locator('#source-input').press('Enter');
    await expect.poll(() => new URL(page.url()).searchParams.has('id')).toBe(false);

    await toastAction(page, 'Show it').click();
    await expect(page.locator('.toast')).toContainText('The view changed, so this action no longer applies');
    await expect(page.locator('#show-spec-functions')).not.toBeChecked();
  });

  test('an anchor reveal of a node already anchored adds no history entry', async ({ page }) => {
    await open(page, A_CALLEES);
    const before = await historyLength(page);
    expect(await reveal(page, 'probe:a', { policy: { kind: 'anchor', role: 'source' } })).toBe('shown');
    expect(await historyLength(page)).toBe(before);
  });

  test('a truncated hit can be queried instead', async ({ page }) => {
    await open(page, H_CALLEES);
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const shown = new Set(await shownIds(page));
    const cut = LEAVES.find(l => !shown.has(l))!;

    expect(await reveal(page, cut, { policy: { kind: 'replace' }, offer: true })).toBe('truncated');
    await expect(toastAction(page, 'Keep it in the query')).toBeVisible();
    await expect(toastAction(page, 'Draw all 301 nodes')).toBeVisible();
    await toastAction(page, 'Query this node instead').click();
    await expect.poll(() => shownIds(page)).toEqual(['probe:h', cut].sort());
  });

  test('a raised cap draws the hit and ends with its query', async ({ page }) => {
    await open(page, H_CALLEES);
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const shown = new Set(await shownIds(page));
    const cut = LEAVES.find(l => !shown.has(l))!;

    expect(await reveal(page, cut, { policy: { kind: 'replace' }, offer: true })).toBe('truncated');
    await toastAction(page, 'Draw all 301 nodes').click();
    await expect.poll(async () => (await shownIds(page)).length).toBe(301);

    // A new query, then Back to the same one: the cap is not raised again
    expect(await reveal(page, 'probe:a', { policy: { kind: 'replace' } })).toBe('shown');
    await expect.poll(() => shownIds(page)).toEqual(['probe:a', 'probe:b']);
    await page.goBack();
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
  });

  test('a cap raised with no query ends when a query is run and cleared', async ({ page }) => {
    // With no query the filters let 303 nodes through, and the cap draws 200
    await open(page, '');
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const shown = new Set(await shownIds(page));
    const cut = LEAVES.find(l => !shown.has(l))!;

    expect(await reveal(page, cut, { policy: { kind: 'replace' }, offer: true })).toBe('truncated');
    await toastAction(page, 'Draw all 303 nodes').click();
    await expect.poll(async () => (await shownIds(page)).length).toBe(303);

    await page.locator('#source-input').fill('l1');
    await expect.poll(async () => (await shownIds(page)).length).toBeLessThan(200);
    await page.locator('#source-input').fill('');
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
  });

  test('a cap raised before a graph load does not carry over', async ({ page }) => {
    await open(page, '');
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const shown = new Set(await shownIds(page));
    const cut = LEAVES.find(l => !shown.has(l))!;
    expect(await reveal(page, cut, { policy: { kind: 'replace' }, offer: true })).toBe('truncated');
    await toastAction(page, 'Draw all 303 nodes').click();
    await expect.poll(async () => (await shownIds(page)).length).toBe(303);

    await page.locator('#file-input').setInputFiles({
      name: 'reveal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph())),
    });
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
  });

  test('centres on the hit once the layout settles', async ({ page }) => {
    await open(page, H_CALLEES);
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const leaf = (await shownIds(page)).find(id => id !== 'probe:h')!;
    expect(await reveal(page, leaf, { policy: { kind: 'replace' }, center: true })).toBe('shown');
    await expect.poll(() => offCentre(page, leaf), { timeout: 5000 }).toBeLessThan(20);
    // The layout runs about 5 s; the reveal centres again when it stops,
    // so the node is still in the middle afterwards
    await page.waitForTimeout(7000);
    expect(await offCentre(page, leaf)).toBeLessThan(20);
  });

  test('a pan by the user while the layout settles wins over centring', async ({ page }) => {
    await open(page, H_CALLEES);
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const leaf = (await shownIds(page)).find(id => id !== 'probe:h')!;
    // Wait for the load's fit to end, so the wheel is the last camera move
    await page.waitForTimeout(600);
    const box = (await page.locator('#graph-container svg').boundingBox())!;
    const before = await transform(page);
    // The layout still runs (about 5 s), so the reveal waits to centre
    expect(await reveal(page, leaf, { policy: { kind: 'replace' }, center: true })).toBe('shown');
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(300);
    const afterWheel = await transform(page);
    expect(afterWheel).not.toBe(before);
    await page.waitForTimeout(2500);
    expect(await transform(page)).toBe(afterWheel);
  });

  test('Reset View while the layout settles wins over centring', async ({ page }) => {
    await open(page, H_CALLEES);
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const leaf = (await shownIds(page)).find(id => id !== 'probe:h')!;
    expect(await reveal(page, leaf, { policy: { kind: 'replace' }, center: true })).toBe('shown');
    await page.locator('#reset-view').click();
    // The fit takes 400 ms; the reveal would centre at 1.5 s
    await page.waitForTimeout(600);
    const afterReset = await transform(page);
    await page.waitForTimeout(2500);
    expect(await transform(page)).toBe(afterReset);
  });
  test('a query change during the centring move stops it', async ({ page }) => {
    await open(page, H_CALLEES);
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const leaf = (await shownIds(page)).find(id => id !== 'probe:h')!;
    // Once the layout stops, the reveal starts its camera move at once
    await page.waitForTimeout(7000);
    const before = await transform(page);
    // A deeper query on h draws the same nodes, so it starts no fit. It
    // comes 100 ms into the 400 ms move.
    const stoppedAt = await page.evaluate(async nodeId => {
      // On a slow runner the layout can still run, and the reveal then
      // waits up to 1.5 s before its move starts
      const g = document.querySelector('#graph-container svg > g')!;
      const at = g.getAttribute('transform');
      const moveStarted = async () => {
        const deadline = performance.now() + 3000;
        while (g.getAttribute('transform') === at) {
          if (performance.now() > deadline) throw new Error('the centring move did not start');
          await new Promise(r => requestAnimationFrame(r));
        }
      };
      (window as unknown as { __revealNode: (id: string, o: unknown) => unknown })
        .__revealNode(nodeId, { policy: { kind: 'replace' }, center: true });
      await moveStarted();
      await new Promise(r => setTimeout(r, 100));
      const slider = document.getElementById('depth-limit') as HTMLInputElement;
      slider.value = '2';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => requestAnimationFrame(r));
      return document.querySelector('#graph-container svg > g')!.getAttribute('transform');
    }, leaf);
    expect(stoppedAt).not.toBe(before);
    await page.waitForTimeout(800);
    expect(new URL(page.url()).searchParams.get('depth')).toBe('2');
    expect(await offCentre(page, leaf)).toBeGreaterThan(20);
    expect(await transform(page)).toBe(stoppedAt);
  });

  test('a query that draws other nodes during the centring move still fits them', async ({ page }) => {
    await open(page, H_CALLEES);
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const leaf = (await shownIds(page)).find(id => id !== 'probe:h')!;
    await page.waitForTimeout(7000);
    // A query on a draws other nodes, so it starts a fit. It comes 100 ms
    // into the 400 ms move.
    const stoppedAt = await page.evaluate(async nodeId => {
      // On a slow runner the layout can still run, and the reveal then
      // waits up to 1.5 s before its move starts
      const g = document.querySelector('#graph-container svg > g')!;
      const at = g.getAttribute('transform');
      const moveStarted = async () => {
        const deadline = performance.now() + 3000;
        while (g.getAttribute('transform') === at) {
          if (performance.now() > deadline) throw new Error('the centring move did not start');
          await new Promise(r => requestAnimationFrame(r));
        }
      };
      (window as unknown as { __revealNode: (id: string, o: unknown) => unknown })
        .__revealNode(nodeId, { policy: { kind: 'replace' }, center: true });
      await moveStarted();
      await new Promise(r => setTimeout(r, 100));
      const input = document.getElementById('source-input') as HTMLInputElement;
      input.value = 'a';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => requestAnimationFrame(r));
      return document.querySelector('#graph-container svg > g')!.getAttribute('transform');
    }, leaf);
    await expect.poll(() => shownIds(page)).toEqual(['probe:a', 'probe:b']);
    await page.waitForTimeout(800);
    expect(await transform(page)).not.toBe(stoppedAt);
  });

  test('a reveal from the File Map and its new query are one history entry', async ({ page }) => {
    await open(page, A_CALLEES);
    await page.locator('#view-file-map').click();
    await expect(page.locator('#view-file-map')).toHaveClass(/active/);
    const fileMapUrl = page.url();

    // a does not reach h, so the reveal queries h
    expect(await reveal(page, 'probe:h', { policy: { kind: 'replace' } })).toBe('shown');
    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await page.goBack();
    await expect(page.locator('#view-file-map')).toHaveClass(/active/);
    expect(page.url()).toBe(fileMapUrl);
  });

  test('a reveal that unhides the hit and queries it keeps the hidden node for Back', async ({ page }) => {
    await open(page, `${A_CALLEES}&hide=${encodeURIComponent('probe:h')}`);
    const hiddenUrl = page.url();
    expect(await reveal(page, 'probe:h', { policy: { kind: 'replace' } })).toBe('shown');
    expect(new URL(page.url()).searchParams.getAll('hide')).toEqual([]);
    await page.goBack();
    expect(page.url()).toBe(hiddenUrl);
  });

  test('a reveal while typing on a large graph applies the typed query first', async ({ page }) => {
    // Over 2000 nodes, so source/sink typing is applied after 300 ms
    const leaves = Array.from({ length: 2100 }, (_, i) => `probe:l${i}`);
    await open(page, A_CALLEES, graph(leaves));
    await expect.poll(() => shownIds(page)).toEqual(['probe:a', 'probe:b']);
    // h does not reach b, so the reveal must query b instead
    const reason = await page.evaluate(() => {
      const input = document.getElementById('source-input') as HTMLInputElement;
      input.value = 'h';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return (window as unknown as { __revealNode: (id: string, o: unknown) => { reason: string } })
        .__revealNode('probe:b', { policy: { kind: 'replace' } }).reason;
    });
    expect(reason).toBe('shown');
    await page.waitForTimeout(800);
    expect(await shownIds(page)).toContain('probe:b');
  });

  test('the toast stays while it has the keyboard focus', async ({ page }) => {
    await open(page, A_CALLEES);
    await expect(page.locator('#toast-container')).toHaveAttribute('aria-live', 'polite');
    expect(await reveal(page, 'probe:s', { policy: { kind: 'replace' }, offer: true })).toBe('filtered');
    await toastAction(page, 'Show it').focus();
    await page.waitForTimeout(9000);
    await expect(toastAction(page, 'Show it')).toBeVisible();
  });
});

// probe-leanblueprint project-template extract: 9 blueprint atoms, 9 Lean atoms
const BLUEPRINT = readFileSync(new URL('../src/test-data/blueprint-project-template.json', import.meta.url));

test('a reveal on the other layer and its new query are one history entry', async ({ page }) => {
  await page.goto('/probegraph/');
  await page.locator('#file-input').setInputFiles({
    name: 'extract.json', mimeType: 'application/json', buffer: BLUEPRINT,
  });
  await expect(page.locator('circle.node')).toHaveCount(9, { timeout: 15000 });
  // A blueprint query that does not reach addition_assoc, kept by the layer
  await page.locator('#source-input').fill('collatz_step');
  await expect.poll(async () => (await shownIds(page)).includes('probe:blueprint:addition_assoc')).toBe(false);
  await page.locator('#layer-code').click();
  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  const codeUrl = page.url();

  expect(await reveal(page, 'probe:blueprint:addition_assoc', { policy: { kind: 'replace' } })).toBe('shown');
  await expect(page.locator('#layer-blueprint')).toHaveClass(/active/);
  await page.goBack();
  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  expect(page.url()).toBe(codeUrl);
});

