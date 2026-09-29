/**
 * E2E tests for the query intent (docs/plans/query-intent.md): Guide chips
 * replace the whole intent, browser history, and ?focus= load races.
 *
 * Graphs and focus sets are served through page.route, so the fixtures are
 * deterministic and nothing is written to public/.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// a → b → c ← d, e isolated. Crates x (a, b) and y (c, d, e).
// c has the most dependents, so the "most connected" chip is callers of c.
const IDS = ['a', 'b', 'c', 'd', 'e'].map(n => `probe:${n < 'c' ? 'x' : 'y'}/${n}`);
const [A, B, C, D, E] = IDS;
const LINKS: [string, string][] = [[A, B], [B, C], [D, C]];

function smallGraph() {
  const nodes = IDS.map(id => {
    const name = `func_${id.slice(-1)}`;
    return {
      id, display_name: name, symbol: id,
      full_path: `/t/${name}.rs`, relative_path: `src/${name}.rs`, file_name: `${name}.rs`,
      parent_folder: 'src', crate_name: '', is_libsignal: false, kind: 'exec',
      dependencies: LINKS.filter(([s]) => s === id).map(([, t]) => t),
      dependents: LINKS.filter(([, t]) => t === id).map(([s]) => s),
    };
  });
  return {
    nodes,
    links: LINKS.map(([source, target]) => ({ source, target, type: 'inner' })),
    metadata: { total_nodes: nodes.length, total_edges: LINKS.length, project_root: '/t', generated_at: '2026-01-01' },
  };
}

// Large graph for the seeded view: 100 roots → 5 children → 2 grandchildren
// → 12 leaves (13,600 nodes). The seeded view fits at depths 1 and 2.
function largeGraph() {
  const nodes: any[] = [];
  const links: { source: string; target: string; type: string }[] = [];
  const add = (id: string, parent?: string) => {
    nodes.push({
      id, display_name: id, symbol: id, full_path: `/s/${id}.rs`, relative_path: `src/${id}.rs`,
      file_name: `${id}.rs`, parent_folder: 'src', crate_name: '', is_libsignal: false, kind: 'exec',
      dependencies: [], dependents: parent ? [parent] : [],
    });
    if (parent) links.push({ source: parent, target: id, type: 'inner' });
  };
  for (let i = 0; i < 100; i++) {
    add(`r${i}`);
    for (let j = 0; j < 5; j++) {
      const c = `c${i * 5 + j}`; add(c, `r${i}`);
      for (let k = 0; k < 2; k++) {
        const g = `g${(i * 5 + j) * 2 + k}`; add(g, c);
        for (let l = 0; l < 12; l++) add(`x${((i * 5 + j) * 2 + k) * 12 + l}`, g);
      }
    }
  }
  return {
    nodes, links,
    metadata: { total_nodes: nodes.length, total_edges: links.length, project_root: '/s', generated_at: '2026-01-01' },
  };
}

const FOCUS = { focus_nodes: [A, E], metadata: { description: 'two nodes' } };

function json(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

/** Serve fixtures; `focusGate` holds the focus response until released. */
async function serve(page: Page, opts: { focusGate?: Promise<void>; entrypoints?: string[] } = {}): Promise<void> {
  await page.route('**/intent-small.json', route => json(route, smallGraph()));
  await page.route('**/intent-large.json', route => json(route, largeGraph()));
  await page.route('**/intent-focus.json', async route => {
    await opts.focusGate;
    await json(route, FOCUS);
  });
  await page.route('**/intent-entrypoints.json', route => {
    opts.entrypoints?.push(route.request().url());
    return json(route, {});
  });
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/probegraph/?json=intent-small.json${query}`);
  await expect(page.locator('#stats')).toContainText('Total Nodes', { timeout: 15000 });
}

/** IDs of the rendered nodes. */
async function shownIds(page: Page): Promise<string[]> {
  return (await page.locator('circle.node').evaluateAll(
    els => els.map(el => (el as any).__data__?.id as string),
  )).sort();
}

/** Click a node by ID (the force layout keeps circles moving, so no real click). */
async function clickNode(page: Page, id: string): Promise<void> {
  await page.evaluate(nodeId => {
    const el = [...document.querySelectorAll('circle.node')].find(c => (c as any).__data__?.id === nodeId);
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, id);
}

async function clickChip(page: Page, text: RegExp): Promise<void> {
  await page.locator('#tab-guide').click();
  await page.locator('.guide-chip').filter({ hasText: text }).click();
}

const MOST_CONNECTED = /^Explore func_c/;
const CALLERS_OF_C = [A, B, C, D].sort();

test.describe('Guide chips replace the intent', () => {
  test('after a focus set', async ({ page }) => {
    await serve(page);
    await open(page, '&focus=intent-focus.json');
    await expect(page.locator('#focus-indicator')).toBeVisible();
    await expect.poll(() => shownIds(page)).toEqual([A, E].sort());

    await clickChip(page, MOST_CONNECTED);
    await expect.poll(() => shownIds(page)).toEqual(CALLERS_OF_C);
    await expect(page.locator('#focus-indicator')).toBeHidden();
    const url = new URL(page.url());
    expect(url.searchParams.has('focus')).toBe(false);
    expect(url.searchParams.getAll('id')).toEqual([C]);
    expect(url.searchParams.get('dir')).toBe('callers');
  });

  test('after an exact ID intent', async ({ page }) => {
    await serve(page);
    await open(page, `&id=${encodeURIComponent(A)}&dir=callees&label=func_a&depth=0`);
    await expect.poll(() => shownIds(page)).toEqual([A, B, C].sort());
    await expect(page.locator('#source-input')).toHaveValue('func_a');

    await clickChip(page, MOST_CONNECTED);
    await expect.poll(() => shownIds(page)).toEqual(CALLERS_OF_C);
    await expect(page.locator('#source-input')).toHaveValue('');
    await expect(page.locator('#sink-input')).toHaveValue('func_c');
  });

  test('after a selected node with finite depth', async ({ page }) => {
    await serve(page);
    await open(page, `&sel=${encodeURIComponent(A)}`);
    await expect.poll(() => shownIds(page)).toEqual([A, B].sort());

    await clickChip(page, MOST_CONNECTED);
    await expect.poll(() => shownIds(page)).toEqual(CALLERS_OF_C);
    expect(new URL(page.url()).searchParams.has('sel')).toBe(false);
  });
});

test.describe('History', () => {
  test('back after a chip restores the previous query', async ({ page }) => {
    await serve(page);
    await open(page, '');
    await page.locator('#source-input').fill('func_b');
    await expect.poll(() => shownIds(page)).toEqual([B, C].sort());

    await clickChip(page, MOST_CONNECTED);
    await expect.poll(() => shownIds(page)).toEqual(CALLERS_OF_C);

    await page.goBack();
    await expect.poll(() => shownIds(page)).toEqual([B, C].sort());
    await expect(page.locator('#source-input')).toHaveValue('func_b');
    await expect(page.locator('#sink-input')).toHaveValue('');
  });

  test('typing over a chip pushes once; back returns to the chip', async ({ page }) => {
    await serve(page);
    await open(page, '');
    await clickChip(page, MOST_CONNECTED);
    await expect.poll(() => shownIds(page)).toEqual(CALLERS_OF_C);

    const sink = page.locator('#sink-input');
    await expect(sink).toHaveClass(/exact-query/);
    await sink.fill('func_b');
    await sink.press('End');
    await sink.pressSequentially('x');  // a second edit must not push again
    await sink.press('Backspace');
    await expect.poll(() => shownIds(page)).toEqual([A, B].sort());

    await page.goBack();
    await expect.poll(() => shownIds(page)).toEqual(CALLERS_OF_C);
    await expect(sink).toHaveValue('func_c');

    // Typing after back to the chip pushes again instead of overwriting it
    await sink.fill('func_a');
    await expect.poll(() => shownIds(page)).toEqual([]);
    await page.goBack();
    await expect.poll(() => shownIds(page)).toEqual(CALLERS_OF_C);
  });

  test('back from a chip to a seeded view after a depth change', async ({ page }) => {
    await serve(page);
    await page.goto('/probegraph/?json=intent-large.json');
    const depth = page.locator('#depth-value');
    await expect(page.locator('#stats')).toContainText('entry points, depth 1', { timeout: 30000 });

    await clickChip(page, /^Explore /);
    await expect(depth).toHaveText('All');
    await page.locator('#depth-limit').fill('5');
    await expect(depth).toHaveText('5');

    await page.goBack();
    await expect(page.locator('#stats')).toContainText('entry points, depth 1');
    await expect(depth).toHaveText('1');
  });
});

test.describe('Delayed ?focus= load', () => {
  test('a chip clicked during the load wins, and entry points resume', async ({ page }) => {
    let release!: () => void;
    const entrypoints: string[] = [];
    await serve(page, { focusGate: new Promise(r => { release = r; }), entrypoints });
    await open(page, '&focus=intent-focus.json&entrypoints=intent-entrypoints.json');
    expect(entrypoints).toEqual([]);  // deferred by ?focus=

    await clickChip(page, MOST_CONNECTED);
    await expect.poll(() => shownIds(page)).toEqual(CALLERS_OF_C);
    await expect.poll(() => entrypoints.length).toBe(1);

    release();
    await page.waitForResponse('**/intent-focus.json');
    await page.waitForTimeout(300);
    expect(await shownIds(page)).toEqual(CALLERS_OF_C);
    await expect(page.locator('#focus-indicator')).toBeHidden();
    expect(new URL(page.url()).searchParams.has('focus')).toBe(false);
  });

  test('a node click during the load wins', async ({ page }) => {
    let release!: () => void;
    await serve(page, { focusGate: new Promise(r => { release = r; }) });
    await open(page, '&focus=intent-focus.json');
    await expect.poll(() => shownIds(page)).toEqual(IDS.slice(0, 4).sort());

    await clickNode(page, A);
    await expect.poll(() => shownIds(page)).toEqual([A, B].sort());

    release();
    await page.waitForResponse('**/intent-focus.json');
    await page.waitForTimeout(300);
    expect(await shownIds(page)).toEqual([A, B].sort());
    await expect(page.locator('#focus-indicator')).toBeHidden();
  });

  test('a slider edit during the load keeps focus= in the URL', async ({ page }) => {
    let release!: () => void;
    await serve(page, { focusGate: new Promise(r => { release = r; }) });
    await open(page, '&focus=intent-focus.json');
    await page.locator('#depth-limit').fill('3');
    await expect(page.locator('#depth-value')).toHaveText('3');
    const url = new URL(page.url());
    expect(url.searchParams.get('focus')).toBe('intent-focus.json');
    expect(url.searchParams.get('depth')).toBe('3');

    release();
    await expect.poll(() => shownIds(page)).toEqual([A, E].sort());
  });
});

test('the query label renders URL params as text', async ({ page }) => {
  await serve(page);
  const label = '<img id="label-injected" src=x>';
  await open(page, `&id=${encodeURIComponent(A)}&dir=callees&label=${encodeURIComponent(label)}`);
  await expect(page.locator('#query-label')).toContainText(label);
  await expect(page.locator('#label-injected')).toHaveCount(0);
});

// Two unrelated boundaries: p → q and r → s
function boundaryGraph() {
  const pairs: [string, string][] = [['probe:p/f', 'probe:q/g'], ['probe:r/h', 'probe:s/k']];
  const nodes = pairs.flat().map(id => {
    const name = `func_${id.slice(-1)}`;
    return {
      id, display_name: name, symbol: id,
      full_path: `/t/${name}.rs`, relative_path: `src/${name}.rs`, file_name: `${name}.rs`,
      parent_folder: 'src', crate_name: '', is_libsignal: false, kind: 'exec',
      dependencies: pairs.filter(([s]) => s === id).map(([, t]) => t),
      dependents: pairs.filter(([, t]) => t === id).map(([s]) => s),
    };
  });
  return {
    nodes,
    links: pairs.map(([source, target]) => ({ source, target, type: 'inner' })),
    metadata: { total_nodes: nodes.length, total_edges: pairs.length, project_root: '/t', generated_at: '2026-01-01' },
  };
}

test.describe('Back restores the controls', () => {
  test('crate dropdowns follow the restored boundary', async ({ page }) => {
    await page.route('**/intent-boundary.json', route => json(route, boundaryGraph()));
    await page.goto('/probegraph/?json=intent-boundary.json&boundary-source=p&boundary-target=q');
    await expect(page.locator('#stats')).toContainText('Total Nodes', { timeout: 15000 });
    await expect(page.locator('#source-crate-select')).toHaveValue('p');

    // A chip pushes an entry; the dropdowns then select the other boundary
    await page.locator('#tab-guide').click();
    await page.locator('.guide-chip').first().click();
    await page.locator('#source-crate-select').selectOption('r');
    await page.locator('#target-crate-select').selectOption('s');
    expect(new URL(page.url()).searchParams.get('boundary-source')).toBe('r');

    // r is not a caller of q: the old DOM value must not clear the restored p
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get('boundary-source')).toBe('p');
    await expect(page.locator('#source-crate-select')).toHaveValue('p');
    await expect(page.locator('#target-crate-select')).toHaveValue('q');
  });

  test('Hierarchy expansion collapses back to an entry without expanded=', async ({ page }) => {
    await serve(page);
    await open(page, '&view=hierarchy');
    await expect(page.locator('.hm-group').first()).toBeVisible();
    await expect(page.locator('.hm-container')).toHaveCount(0);

    await clickChip(page, MOST_CONNECTED);
    await expect(page.locator('.hm-group').first()).toBeVisible();
    await page.locator('.hm-group').first().dispatchEvent('click');
    await expect(page.locator('.hm-container')).toHaveCount(1);
    expect(page.url()).toContain('expanded=');

    await page.goBack();
    await expect.poll(() => page.url()).not.toContain('expanded=');
    await expect(page.locator('.hm-container')).toHaveCount(0);
  });
});
