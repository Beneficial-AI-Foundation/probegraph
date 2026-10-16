/**
 * E2E tests for the search box and the reveal it runs
 * (docs/plans/graph-search.md, Phases 0 and 1): the result list and its
 * keys, the toast actions, their history entries, the raised render cap
 * and centring.
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

async function open(page: Page, query: string, body: unknown = graph()): Promise<void> {
  await page.route('**/reveal.json', (route: Route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }));
  await page.goto(`/probegraph/?json=reveal.json${query}`);
  await expect(page.locator('#stats')).toContainText('Total Nodes', { timeout: 15000 });
}

type Action = 'reveal' | 'source' | 'sink';

/** The search box button for `id` and `action`; the search for its ID lists it first. */
function resultButton(page: Page, id: string, action: Action = 'reveal') {
  return page.locator(`.search-result[data-id="${id}"] [data-action="${action}"]`);
}

/** Search for `id` and click the row's button for `action`. */
async function reveal(page: Page, id: string, action: Action = 'reveal'): Promise<void> {
  await page.locator('#search-input').fill(id);
  await resultButton(page, id, action).click();
}

/** Search for `id`; the row's button is clicked inside a page.evaluate. */
async function listResult(page: Page, id: string): Promise<void> {
  await page.locator('#search-input').fill(id);
  await expect(resultButton(page, id)).toBeVisible();
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

test.describe('search box', () => {
  test('lists hits with kind, status and path, and Enter reveals the top one', async ({ page }) => {
    await open(page, A_CALLEES);
    await page.locator('#search-input').fill('h');
    const first = page.locator('.search-result').first();
    await expect(first).toHaveAttribute('data-id', 'probe:h');
    await expect(first).toContainText('exec');
    await expect(first).toContainText('unknown');
    await expect(first).toContainText('src/h.rs');
    await expect(page.locator('#search-status')).toHaveText(/^\d+ match(es)?$/);

    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-results')).toBeHidden();
    await expect(page.locator('#search-status')).toHaveText('');
    await expect(page.locator('#search-input')).toBeFocused();
    expect(new URL(page.url()).searchParams.get('id')).toBe('probe:h');
    await expect(page.locator('#node-info')).toContainText('src/h.rs');
  });

  test('shows the first 20 hits and says there are more', async ({ page }) => {
    await open(page, '');
    await page.locator('#search-input').fill('l');
    await expect(page.locator('.search-result')).toHaveCount(20);
    await expect(page.locator('.search-note')).toContainText('First 20 matches');
    await expect(page.locator('#search-status')).toHaveText('First 20 matches');
  });

  test('says when nothing matches', async ({ page }) => {
    await open(page, '');
    await page.locator('#search-input').fill('zzz');
    await expect(page.locator('.search-note')).toHaveText('No matches');
    await expect(page.locator('.search-result')).toHaveCount(0);
    // The note is not focusable, so the live region announces it
    await expect(page.locator('#search-status')).toHaveText('No matches');
  });

  test('arrow keys move through the rows and Escape goes back to the box', async ({ page }) => {
    await open(page, A_CALLEES);
    await page.locator('#search-input').fill('l1');
    await page.locator('#search-input').press('ArrowDown');
    await expect(resultButton(page, 'probe:l1')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(resultButton(page, 'probe:l1', 'source')).toBeFocused();
    // Down keeps the column
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.search-result').nth(1).locator('[data-action="source"]')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#search-input')).toBeFocused();
    await page.locator('#search-input').press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-input')).toBeFocused();
    await expect(page.locator('#search-results')).toBeHidden();
  });

  test('as source joins the source set, and as sink adds a sink set for the paths', async ({ page }) => {
    await open(page, A_CALLEES);
    await reveal(page, 'probe:h', 'source');
    await expect.poll(() => new URL(page.url()).searchParams.getAll('id')).toEqual(['probe:a', 'probe:h']);
    expect(new URL(page.url()).searchParams.get('dir')).toBe('callees');
    await reveal(page, 'probe:b', 'sink');
    await expect.poll(() => new URL(page.url()).searchParams.getAll('sink-id')).toEqual(['probe:b']);
    const params = new URL(page.url()).searchParams;
    expect(params.getAll('source-id')).toEqual(['probe:a', 'probe:h']);
    expect(params.has('id')).toBe(false);
    // h reaches no sink, so only the path a -> b is drawn
    await expect.poll(() => shownIds(page)).toEqual(['probe:a', 'probe:b']);
    await expect(page.locator('#query-label')).toHaveText('query: paths a, h → b');
    await expect(page.locator('#source-input')).toHaveValue('a, h');
    await expect(page.locator('#sink-input')).toHaveValue('b');

    // The URL alone restores the query
    await page.reload();
    await expect.poll(() => shownIds(page)).toEqual(['probe:a', 'probe:b']);
    await expect(page.locator('#query-label')).toHaveText('query: paths a, h → b');

    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.getAll('id')).toEqual(['probe:a', 'probe:h']);
  });

  test('a sink with no path from the sources offers to query it instead', async ({ page }) => {
    await open(page, A_CALLEES);
    await reveal(page, 'probe:t', 'sink');
    await expect(page.locator('.toast-with-actions')).toContainText('t is on no path between the sources and the sinks');
    await toastAction(page, 'Query this node instead').click();
    // Its caller s is a spec function, hidden by default
    await expect.poll(() => shownIds(page)).toEqual(['probe:t']);
    expect(new URL(page.url()).searchParams.get('dir')).toBe('both');
  });

  test('Alt+Enter moves the focus to the first toast action', async ({ page }) => {
    await open(page, A_CALLEES);
    await page.locator('#search-input').fill('probe:s');
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('.toast-with-actions')).toContainText('s is hidden by the Spec filter');
    await page.locator('#search-input').press('Alt+Enter');
    await expect(toastAction(page, 'Show it')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => shownIds(page)).toEqual(['probe:s', 'probe:t']);
  });

  test('/ focuses the box, but not while typing in another field', async ({ page }) => {
    await open(page, '');
    await page.locator('#source-input').fill('a/b');
    await expect(page.locator('#source-input')).toHaveValue('a/b');
    await page.locator('#graph-container').click();
    await page.keyboard.press('/');
    await expect(page.locator('#search-input')).toBeFocused();
    await expect(page.locator('#search-input')).toHaveValue('');
  });

  test('Escape that closes the list does not reach the views', async ({ page }) => {
    await open(page, A_CALLEES);
    // The Hierarchy and Crate Map collapse on an Escape that reaches the document
    await page.evaluate(() => {
      (window as unknown as { escapes: number }).escapes = 0;
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') (window as unknown as { escapes: number }).escapes++;
      });
    });
    const escapes = () => page.evaluate(() => (window as unknown as { escapes: number }).escapes);
    await page.locator('#search-input').fill('h');
    await page.locator('#search-input').press('Escape');
    await expect(page.locator('#search-results')).toBeHidden();
    await page.locator('#search-input').fill('h');
    await page.locator('#search-input').press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-results')).toBeHidden();
    expect(await escapes()).toBe(0);
  });

  test('Enter and ArrowDown while an input method composes do nothing', async ({ page }) => {
    await open(page, A_CALLEES);
    await page.locator('#search-input').fill('h');
    await expect(resultButton(page, 'probe:h')).toBeVisible();
    await page.locator('#search-input').evaluate((input: HTMLInputElement) => {
      for (const key of ['ArrowDown', 'Enter']) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true }));
      }
    });
    await expect(page.locator('#search-input')).toBeFocused();
    await expect(page.locator('#search-results')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('id')).toBe('probe:a');
  });

  test('the list stays inside a narrow window, and after a resize', async ({ page }) => {
    // The left and right edges; polled, since the resize event can come
    // after setViewportSize returns
    const edges = async () => Promise.all(
      [page.locator('#search-results'), resultButton(page, 'probe:h', 'sink')].map(async el => {
        const box = (await el.boundingBox())!;
        return [box.x, box.x + box.width];
      }));
    const inside = (width: number) => expect.poll(async () =>
      (await edges()).every(([left, right]) => left >= 0 && right <= width)).toBe(true);
    await page.setViewportSize({ width: 1024, height: 768 });
    await open(page, A_CALLEES);
    await page.locator('#search-input').fill('h');
    await inside(1024);
    // The box ends nearer the left edge than the list is wide
    await page.setViewportSize({ width: 640, height: 768 });
    await inside(640);
  });

  test('a new graph is searched, not the old one', async ({ page }) => {
    await open(page, '');
    await page.locator('#search-input').fill('probe:l5');
    await expect(resultButton(page, 'probe:l5')).toBeVisible();
    await page.locator('#file-input').setInputFiles({
      name: 'reveal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph(['probe:m0']))),
    });
    await expect.poll(() => shownIds(page)).toEqual(['probe:a', 'probe:b', 'probe:h', 'probe:m0']);
    await page.locator('#search-input').fill('probe:l5');
    await expect(page.locator('.search-note')).toHaveText('No matches');
    await page.locator('#search-input').fill('m0');
    await expect(resultButton(page, 'probe:m0')).toBeVisible();
  });
});

test.describe('revealNode from search', () => {
  test('Show it relaxes the filter and queries the hit, and one Back undoes both', async ({ page }) => {
    await open(page, A_CALLEES);
    await expect.poll(() => shownIds(page)).toEqual(['probe:a', 'probe:b']);

    await reveal(page, 'probe:s');
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
    await reveal(page, 'probe:s');
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
    await reveal(page, 'probe:a', 'source');
    await expect(page.locator('#node-info')).toContainText('src/a.rs');
    expect(await historyLength(page)).toBe(before);
    await expect(page.locator('.toast-with-actions')).toHaveCount(0);
  });

  test('a truncated hit can be queried instead', async ({ page }) => {
    await open(page, H_CALLEES);
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const shown = new Set(await shownIds(page));
    const cut = LEAVES.find(l => !shown.has(l))!;

    await reveal(page, cut);
    await expect(page.locator('.toast-with-actions')).toContainText('beyond the 200-node render limit');
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

    await reveal(page, cut);
    await expect(page.locator('.toast-with-actions')).toContainText('beyond the 200-node render limit');
    await toastAction(page, 'Draw all 301 nodes').click();
    await expect.poll(async () => (await shownIds(page)).length).toBe(301);

    // A new query, then Back to the same one: the cap is not raised again
    await reveal(page, 'probe:a');
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

    await reveal(page, cut);
    await expect(page.locator('.toast-with-actions')).toContainText('beyond the 200-node render limit');
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
    await reveal(page, cut);
    await expect(page.locator('.toast-with-actions')).toContainText('beyond the 200-node render limit');
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
    await reveal(page, leaf);
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
    await reveal(page, leaf);
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
    await reveal(page, leaf);
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
    await listResult(page, leaf);
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
      document.querySelector<HTMLButtonElement>(
        `.search-result[data-id="${nodeId}"] [data-action="reveal"]`)!.click();
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
    await listResult(page, leaf);
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
      document.querySelector<HTMLButtonElement>(
        `.search-result[data-id="${nodeId}"] [data-action="reveal"]`)!.click();
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
    await reveal(page, 'probe:h');
    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await page.goBack();
    await expect(page.locator('#view-file-map')).toHaveClass(/active/);
    expect(page.url()).toBe(fileMapUrl);
  });

  test('a reveal that unhides the hit and queries it keeps the hidden node for Back', async ({ page }) => {
    await open(page, `${A_CALLEES}&hide=${encodeURIComponent('probe:h')}`);
    const hiddenUrl = page.url();
    await reveal(page, 'probe:h');
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
    await listResult(page, 'probe:b');
    await page.evaluate(() => {
      const input = document.getElementById('source-input') as HTMLInputElement;
      input.value = 'h';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector<HTMLButtonElement>(
        '.search-result[data-id="probe:b"] [data-action="reveal"]')!.click();
    });
    await page.waitForTimeout(800);
    await expect(page.locator('.toast-with-actions')).toHaveCount(0);
    expect(await shownIds(page)).toContain('probe:b');
  });

  test('the toast stays while it has the keyboard focus', async ({ page }) => {
    await open(page, A_CALLEES);
    await expect(page.locator('#toast-container')).toHaveAttribute('aria-live', 'polite');
    await reveal(page, 'probe:s');
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

  await page.locator('#search-input').fill('probe:blueprint:addition_assoc');
  await expect(page.locator('.search-result').first().locator('.search-result-layer')).toHaveText('blueprint');
  await reveal(page, 'probe:blueprint:addition_assoc');
  await expect(page.locator('#layer-blueprint')).toHaveClass(/active/);
  await page.goBack();
  await expect(page.locator('#layer-code')).toHaveClass(/active/);
  expect(page.url()).toBe(codeUrl);
});

