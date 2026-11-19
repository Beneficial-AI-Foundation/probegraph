/**
 * E2E tests for the Packed Map view (docs/plans/packed-map.md, Phase 2):
 * selection, the shared click and wheel camera, `?packed=` and the empty
 * state, and opening a function in the Call Graph. Uses the tracked
 * multi-crate fixture graph_backup_dalek.json, and a served graph for the
 * Call Graph tests.
 * Clicks on SVG circles are dispatched, as in hierarchy.spec.ts.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

const BASE = '/probegraph/?json=./graph_backup_dalek.json';
const VIEW_URL = `${BASE}&view=packed-map`;
/**
 * The fixture is mixed: Rust `exec` functions and Lean declarations. Tests
 * of Rust groups or of the Rust empty state turn Lean off.
 */
const RUST_VIEW_URL = `${VIEW_URL}&lean=0`;

interface Camera { k: number; x: number; y: number }

/** The camera transform on the pack layer (identity when none is set). */
async function camera(page: Page): Promise<Camera> {
  const attr = await page.locator('.pm-camera').getAttribute('transform');
  if (!attr) return { k: 1, x: 0, y: 0 };
  const t = /translate\(([-\d.e]+),\s*([-\d.e]+)\)\s*scale\(([-\d.e]+)\)/.exec(attr);
  expect(t, `unexpected transform ${attr}`).not.toBeNull();
  return { x: Number(t![1]), y: Number(t![2]), k: Number(t![3]) };
}

/** Wait until the click zoom transition is over (the camera stops moving). */
async function settle(page: Page): Promise<Camera> {
  let last = await camera(page);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const now = await camera(page);
    if (now.k === last.k && now.x === last.x && now.y === last.y) return now;
    last = now;
  }
  return last;
}

/** The first crate (groups are drawn parents first). */
async function firstCrateId(page: Page): Promise<string> {
  const id = await page.locator('.pm-group').first().getAttribute('data-group-id');
  expect(id).toBeTruthy();
  return id!;
}

/** The deepest group inside the first crate. */
async function nestedGroupId(page: Page): Promise<string> {
  const crate = await firstCrateId(page);
  const nested = await page.evaluate((crateId) => {
    const ids = [...document.querySelectorAll('.pm-group')].map(g => g.getAttribute('data-group-id')!);
    const inside = ids.filter(id => id.startsWith(crateId + '/'));
    inside.sort((a, b) => b.split('/').length - a.split('/').length);
    return inside[0] ?? null;
  }, crate);
  expect(nested, 'fixture crate has a nested group').not.toBeNull();
  return nested!;
}

test.describe('Packed Map view', () => {
  test('switches to the view and selects a function', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('#view-packed-map').click();
    await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 30000 });
    expect(page.url()).toContain('view=packed-map');

    const fn = page.locator('.pm-fn').first();
    const name = await fn.locator('title').textContent();
    await fn.dispatchEvent('click');
    await expect(page.locator('#node-info')).toContainText(name!, { timeout: 10000 });
    await expect(fn).toHaveAttribute('stroke', /.+/);
  });

  test('click zoom then wheel zoom continues from the same camera', async ({ page }) => {
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-group').first()).toBeAttached({ timeout: 30000 });
    const nested = await nestedGroupId(page);

    await page.locator(`.pm-group[data-group-id="${nested}"]`).dispatchEvent('click');
    const zoomed = await settle(page);
    expect(zoomed.k).toBeGreaterThan(1.5);
    expect(new URL(page.url()).searchParams.get('packed')).toBe(nested);
    await expect(page.locator('.packed-map-svg')).toHaveAttribute('data-packed-focus', nested);

    // A wheel step at the center keeps the pack point under the pointer:
    // the zoom starts from the click zoom's transform, not from the old one
    const box = (await page.locator('.packed-map-svg').boundingBox())!;
    const px = box.width / 2, py = box.height / 2;
    await page.mouse.move(box.x + px, box.y + py);
    await page.mouse.wheel(0, -100);
    const wheeled = await settle(page);
    expect(wheeled.k / zoomed.k).toBeGreaterThan(1);
    expect(wheeled.k / zoomed.k).toBeLessThan(2);
    // The SVG viewBox can differ from the CSS box: compare in pack coordinates
    const scale = await page.evaluate(() => {
      const svg = document.querySelector('.packed-map-svg') as SVGSVGElement;
      return svg.viewBox.baseVal.width / svg.getBoundingClientRect().width;
    });
    const before = { x: (px * scale - zoomed.x) / zoomed.k, y: (py * scale - zoomed.y) / zoomed.k };
    const after = { x: (px * scale - wheeled.x) / wheeled.k, y: (py * scale - wheeled.y) / wheeled.k };
    // Within 2 screen px
    expect(Math.abs(after.x - before.x) * wheeled.k).toBeLessThan(2);
    expect(Math.abs(after.y - before.y) * wheeled.k).toBeLessThan(2);

    // Each Esc zooms out to the parent, up to the whole project
    let focus = nested;
    for (let depth = nested.split('/').length; depth > 0 && focus; depth--) {
      await page.keyboard.press('Escape');
      await settle(page);
      const parent = (await page.locator('.packed-map-svg').getAttribute('data-packed-focus')) ?? '';
      expect(focus.startsWith(parent)).toBe(true);
      expect(parent).not.toBe(focus);
      focus = parent;
    }
    expect(focus).toBe('');
    expect((await camera(page)).k).toBeCloseTo(1, 5);
    expect(new URL(page.url()).searchParams.has('packed')).toBe(false);
  });

  test('a background click zooms out one level', async ({ page }) => {
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-group').first()).toBeAttached({ timeout: 30000 });
    const nested = await nestedGroupId(page);

    await page.locator(`.pm-group[data-group-id="${nested}"]`).dispatchEvent('click');
    await settle(page);
    await expect(page.locator('.packed-map-svg')).toHaveAttribute('data-packed-focus', nested);

    await page.locator('.packed-map-svg').dispatchEvent('click');
    await settle(page);
    const parentFocus = await page.locator('.packed-map-svg').getAttribute('data-packed-focus');
    expect(nested.startsWith(parentFocus!)).toBe(true);
    expect(parentFocus).toBeTruthy();
    expect(parentFocus).not.toBe(nested);
  });

  test('reload restores ?packed=, a stale id shows the whole project', async ({ page }) => {
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-group').first()).toBeAttached({ timeout: 30000 });
    const nested = await nestedGroupId(page);
    await page.locator(`.pm-group[data-group-id="${nested}"]`).dispatchEvent('click');
    const zoomed = await settle(page);
    expect(zoomed.k).toBeGreaterThan(1);
    // replaceState: the zoom adds no history entry
    const historyLength = await page.evaluate(() => history.length);

    await page.goto(page.url());
    await expect(page.locator('.pm-group').first()).toBeAttached({ timeout: 30000 });
    await expect(page.locator('.packed-map-svg')).toHaveAttribute('data-packed-focus', nested);
    // The same group fills the view; the layout can differ by a pixel or two
    const restored = await camera(page);
    expect(Math.abs(restored.k / zoomed.k - 1)).toBeLessThan(0.05);
    expect(historyLength).toBe(2);

    await page.goto(`${VIEW_URL}&packed=${encodeURIComponent('no-such-group/x')}`);
    await expect(page.locator('.pm-group').first()).toBeAttached({ timeout: 30000 });
    await expect(page.locator('.packed-map-svg')).toHaveAttribute('data-packed-focus', '');
    expect((await camera(page)).k).toBeCloseTo(1, 5);
    await expect.poll(() => new URL(page.url()).searchParams.has('packed')).toBe(false);
  });

  test('a window resize keeps the focused group centered in the new size', async ({ page }) => {
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-group').first()).toBeAttached({ timeout: 30000 });
    const nested = await nestedGroupId(page);
    await page.locator(`.pm-group[data-group-id="${nested}"]`).dispatchEvent('click');
    await settle(page);

    const size = page.viewportSize()!;
    await page.setViewportSize({ width: Math.round(size.width * 0.7), height: size.height });
    await expect.poll(() => page.evaluate(() => {
      const svg = document.querySelector('.packed-map-svg') as SVGSVGElement;
      return Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width);
    })).toBeLessThan(1);

    // The group's center is at the center of the new viewBox
    const cam = await camera(page);
    const { cx, cy, w, h } = await page.evaluate((id) => {
      const g = document.querySelector(`.pm-group[data-group-id="${id}"]`)!;
      const m = /translate\(([-\d.e]+),\s*([-\d.e]+)\)/.exec(g.getAttribute('transform')!)!;
      const vb = (document.querySelector('.packed-map-svg') as SVGSVGElement).viewBox.baseVal;
      return { cx: Number(m[1]), cy: Number(m[2]), w: vb.width, h: vb.height };
    }, nested);
    expect(Math.abs(cam.k * cx + cam.x - w / 2)).toBeLessThan(1);
    expect(Math.abs(cam.k * cy + cam.y - h / 2)).toBeLessThan(1);
  });

  test('Back to a stale ?packed= with the same filters drops the id', async ({ page }) => {
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-group').first()).toBeAttached({ timeout: 30000 });

    const focus = await page.evaluate(async () => {
      const stale = new URL(location.href);
      stale.searchParams.set('packed', 'no-such-group/x');
      const here = location.href;
      history.pushState({ pushed: true }, '', stale);
      history.pushState({ pushed: true }, '', here);
      const changed = new Promise<unknown>(resolve => {
        window.addEventListener('packed-focus-changed',
          (e) => resolve((e as CustomEvent).detail.focus), { once: true });
        setTimeout(() => resolve('no event'), 5000);
      });
      history.back();
      return changed;
    });
    expect(focus).toBeNull();
    await expect(page.locator('.packed-map-svg')).toHaveAttribute('data-packed-focus', '');
    await expect.poll(() => new URL(page.url()).searchParams.has('packed')).toBe(false);
  });

  test('after a resize, Back to a stale ?packed= fits the whole project', async ({ page }) => {
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-group').first()).toBeAttached({ timeout: 30000 });
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: Math.round(size.width * 0.6), height: Math.round(size.height * 0.8) });
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const stale = new URL(location.href);
      stale.searchParams.set('packed', 'no-such-group/x');
      const here = location.href;
      history.pushState({ pushed: true }, '', stale);
      history.pushState({ pushed: true }, '', here);
      history.back();
    });
    await expect.poll(() => new URL(page.url()).searchParams.has('packed')).toBe(false);
    await settle(page);

    // Every crate circle is inside the view
    const outside = await page.evaluate(() => {
      const view = document.querySelector('.packed-map-svg')!.getBoundingClientRect();
      return [...document.querySelectorAll('.pm-group')]
        .filter(g => !g.getAttribute('data-group-id')!.includes('/'))
        .map(g => g.querySelector('circle')!.getBoundingClientRect())
        .filter(r => r.left < view.left - 2 || r.right > view.right + 2 || r.top < view.top - 2 || r.bottom > view.bottom + 2)
        .length;
    });
    expect(outside).toBe(0);
  });

  test('a mixed graph draws the Lean side too, also with Rust off', async ({ page }) => {
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 30000 });
    await expect(page.locator('.pm-legend')).toHaveAttribute('data-language', 'mixed');
    await expect(page.locator('.pm-legend-scope')).toContainText('Lean declarations without hidden ones');
    const both = await page.locator('.pm-fn').count();

    await page.locator('#show-rust-nodes').uncheck();
    await expect(page.locator('.pm-fn').first()).toBeAttached();
    const lean = await page.locator('.pm-fn').count();
    expect(lean).toBeGreaterThan(0);
    expect(lean).toBeLessThan(both);
    // Only Lean declarations are left. In this fixture a Rust id has a
    // `/` after the crate (probe:<crate>/<version>/...), a Lean id does not.
    const ids = await page.evaluate(() => [...document.querySelectorAll('.pm-fn')]
      .map(c => c.getAttribute('data-node-id')!));
    expect(ids.filter(id => id.includes('/'))).toEqual([]);

    await page.locator('#show-lean-nodes').uncheck();
    await expect(page.locator('.pm-empty')).toHaveText('No Rust functions or Lean declarations match the filters.');
  });

  test('keyboard: Plus zooms in toward the function in the ring, Minus zooms out', async ({ page }) => {
    await page.goto(RUST_VIEW_URL);
    await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 30000 });
    const map = page.locator('.packed-map-svg');
    await expect(map).toHaveAttribute('aria-label', /Plus zooms in/);
    await map.focus();
    await page.keyboard.press('ArrowRight');
    await expect(map).toHaveAttribute('aria-activedescendant', /pm-fn-/);

    // Each Plus goes one level down a chain of nested group ids
    const chain: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('+');
      await settle(page);
      const focus = (await map.getAttribute('data-packed-focus')) ?? '';
      if (chain.length > 0 && focus === chain[chain.length - 1]) break;
      if (chain.length > 0) expect(focus.startsWith(chain[chain.length - 1] + '/')).toBe(true);
      chain.push(focus);
    }
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0]).not.toContain('/');
    await expect(page.locator('.pm-live')).toContainText('Zoomed to');
    expect(new URL(page.url()).searchParams.get('packed')).toBe(chain[chain.length - 1]);

    // The function in the ring is inside the zoomed group
    const ring = await map.getAttribute('aria-activedescendant');
    const inView = await page.evaluate((id) => {
      const r = document.getElementById(id!)!.getBoundingClientRect();
      const v = document.querySelector('.packed-map-svg')!.getBoundingClientRect();
      return r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom;
    }, ring);
    expect(inView).toBe(true);

    await page.keyboard.press('-');
    await settle(page);
    const parent = (await map.getAttribute('data-packed-focus')) ?? '';
    expect(parent).toBe(chain.length > 1 ? chain[chain.length - 2] : '');
  });

  test('after a shrink below the old zoom limit, a wheel step out zooms out', async ({ page }) => {
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-group').first()).toBeAttached({ timeout: 30000 });
    // At 1280 x 500 the whole-pack camera scale is about 0.42
    await page.setViewportSize({ width: 1280, height: 500 });
    await expect.poll(async () => (await camera(page)).k).toBeLessThan(0.5);
    const before = await camera(page);

    const box = (await page.locator('.packed-map-svg').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 100);
    const after = await settle(page);
    expect(after.k).toBeLessThan(before.k);
  });

  test('a new layout drops the hover of a function whose circle was redrawn', async ({ page }) => {
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 30000 });
    const { hovered, other } = await page.evaluate(() => {
      const fns = [...document.querySelectorAll('.pm-fn')];
      fns.sort((a, b) => Number(b.getAttribute('r')) - Number(a.getAttribute('r')));
      const name = (el: Element) => el.querySelector('title')!.textContent!;
      const top = fns[0];
      const o = fns.find(el => name(el) !== name(top) && !name(el).includes('*'))!;
      return { hovered: top.getAttribute('data-node-id')!, other: name(o) };
    });
    await page.locator(`.pm-fn[data-node-id="${hovered}"]`).dispatchEvent('mouseenter');
    expect(await page.locator('.pm-edge').count()).toBeGreaterThan(0);

    // Excluding another function draws a new layout; the hovered one stays
    const count = await page.locator('.pm-fn').count();
    await page.locator('#exclude-name-patterns').fill(other);
    await expect.poll(() => page.locator('.pm-fn').count()).toBeLessThan(count);
    await expect(page.locator(`.pm-fn[data-node-id="${hovered}"]`)).toBeAttached();
    // Nothing is selected and the pointer entered no new circle: no edges
    await expect(page.locator('.pm-edge')).toHaveCount(0);
  });

  test('labels: group labels at the start, function labels after zooming in', async ({ page }) => {
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-group').first()).toBeAttached({ timeout: 30000 });
    await expect(page.locator('.pm-label-group').first()).toBeAttached();

    // Zoom to the deepest group with functions until function labels show
    const fileId = await page.evaluate(() => {
      const fn = document.querySelector('.pm-fn')!;
      const r = Number(fn.getAttribute('r'));
      let best: { id: string; r: number } | null = null;
      for (const g of document.querySelectorAll('.pm-group')) {
        const c = g.querySelector('circle')!;
        const gr = Number(c.getAttribute('r'));
        if (gr > r && (!best || gr < best.r)) best = { id: g.getAttribute('data-group-id')!, r: gr };
      }
      return best!.id;
    });
    await page.locator(`.pm-group[data-group-id="${fileId}"]`).dispatchEvent('click');
    await settle(page);
    await expect(page.locator('.pm-label-fn').first()).toBeAttached();
  });

  test('hovering a function draws its edges, which take no pointer events', async ({ page }) => {
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 30000 });
    // The most connected function: the largest circle
    const id = await page.evaluate(() => {
      let best: Element | null = null;
      for (const c of document.querySelectorAll('.pm-fn')) {
        if (!best || Number(c.getAttribute('r')) > Number(best.getAttribute('r'))) best = c;
      }
      return best!.getAttribute('data-node-id');
    });
    const fn = page.locator(`.pm-fn[data-node-id="${id}"]`);
    await fn.dispatchEvent('mouseenter');
    expect(await page.locator('.pm-edge').count()).toBeGreaterThan(0);
    await expect(page.locator('.pm-overlay')).toHaveAttribute('pointer-events', 'none');
    await fn.dispatchEvent('mouseleave');
    await expect(page.locator('.pm-edge')).toHaveCount(0);

    // The selected function keeps its edges
    await fn.dispatchEvent('click');
    expect(await page.locator('.pm-edge').count()).toBeGreaterThan(0);
  });

  test('Exec unchecked gives the empty state', async ({ page }) => {
    await page.goto(RUST_VIEW_URL);
    await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 30000 });
    const nested = await nestedGroupId(page);
    await page.locator(`.pm-group[data-group-id="${nested}"]`).dispatchEvent('click');
    await settle(page);
    expect(new URL(page.url()).searchParams.get('packed')).toBe(nested);

    await page.locator('#show-exec-functions').uncheck();
    // The text follows the graph's language (mixed), not the Lean filter
    await expect(page.locator('.pm-empty')).toHaveText('No Rust functions or Lean declarations match the filters.');
    await expect(page.locator('.pm-fn')).toHaveCount(0);
    await expect(page.locator('#view-packed-map')).toBeVisible();
    // The zoomed group is gone with the functions: the URL drops it
    expect(new URL(page.url()).searchParams.has('packed')).toBe(false);

    // Exec back on: the whole project, not the old zoom
    await page.locator('#show-exec-functions').check();
    await expect(page.locator('.pm-fn').first()).toBeAttached();
    await expect(page.locator('.packed-map-svg')).toHaveAttribute('data-packed-focus', '');
    expect((await camera(page)).k).toBeCloseTo(1, 5);
  });
});

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
    // Programmatic: the circles are small, and a coordinate click can miss
    await page.locator(`.pm-fn[data-node-id="${left}"]`).dispatchEvent('dblclick');

    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect(page.locator('.pm-fn')).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(left);
    await expect.poll(() => shownIds(page)).toEqual(['probe:h', left]);
    await expect(page.locator('#node-info h3')).toHaveText(left.slice('probe:'.length));

    // The direction buttons narrow the query; node details keep the function
    await expect(page.locator('#query-direction')).toBeVisible();
    await page.locator('#query-dir-callees').check();
    await expect.poll(() => shownIds(page)).toEqual([left]);
    expect(new URL(page.url()).searchParams.get('dir')).toBe('callees');
    await expect(page.locator('#node-info h3')).toHaveText(left.slice('probe:'.length));
    await page.goBack();
    await expect.poll(() => shownIds(page)).toEqual(['probe:h', left]);
    expect(new URL(page.url()).searchParams.get('dir')).toBe('both');

    await page.goBack();
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);
    await expect(page.locator('.pm-fn').first()).toBeVisible();
    expect(new URL(page.url()).searchParams.get('id')).toBeNull();
    await expect(page.locator('#query-direction')).toBeHidden();
  });

  test('double-click queries a function the capped overview draws, and Back returns', async ({ page }) => {
    // The overview is no query to keep, also when it draws the function
    await open(page, '', '');
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const ids = new Set(await shownIds(page));
    const leaf = LEAVES.find(l => ids.has(l))!;
    await page.locator('#view-packed-map').click();
    await expect(page.locator('.pm-fn').first()).toBeVisible();
    await page.locator(`.pm-fn[data-node-id="${leaf}"]`).dispatchEvent('dblclick');

    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect(page.locator('#node-info h3')).toHaveText(leaf.slice('probe:'.length));
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(leaf);
    await expect.poll(() => shownIds(page)).toEqual(['probe:h', leaf]);

    await page.goBack();
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);
    await expect(page.locator('.pm-fn').first()).toBeVisible();
  });

  test('double-click keeps a query that reaches the function', async ({ page }) => {
    await open(page, '&id=probe:a&dir=callees');
    await expect(page.locator('.pm-fn').first()).toBeVisible();
    await expect(page.locator('.pm-fn')).toHaveCount(2);
    await page.locator('.pm-fn[data-node-id="probe:b"]').dispatchEvent('dblclick');

    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect.poll(() => shownIds(page)).toEqual(['probe:a', 'probe:b']);
    expect(new URL(page.url()).searchParams.get('id')).toBe('probe:a');
    await expect(page.locator('#node-info h3')).toHaveText('b');
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
    await expect(page.locator('#node-info h3')).toHaveText(focused.slice('probe:'.length));
  });

  test('a selection query stays when the cap leaves the function out', async ({ page }) => {
    // sel=h at depth 1 is a query of 301 nodes: the cap draws 200
    const query = '&sel=probe:h&depth=1';
    await open(page, query, '');
    await expect.poll(async () => (await shownIds(page)).length).toBe(200);
    const drawn = new Set(await shownIds(page));
    const left = LEAVES.find(l => !drawn.has(l))!;
    await page.locator('#view-packed-map').click();
    await expect(page.locator('.pm-fn').first()).toBeVisible();
    await page.locator(`.pm-fn[data-node-id="${left}"]`).dispatchEvent('dblclick');

    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect(page.locator('.toast').last()).toContainText('Query this node instead');
    const params = new URL(page.url()).searchParams;
    expect([params.get('sel'), params.get('id')]).toEqual(['probe:h', null]);
  });

  test('a reveal that keeps the query cancels a pending focus load', async ({ page }) => {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/focus.json', async (route: Route) => {
      await released;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ focus_nodes: ['probe:a'], metadata: { description: 'focus a' } }),
      });
    });
    // A clicked node: the reveal keeps a query that draws the function
    await open(page, '&sel=probe:a&focus=focus.json');
    await expect(page.locator('.pm-fn').first()).toBeVisible();
    // b is drawn as a callee of the clicked a: the reveal keeps the query
    await page.locator('.pm-fn[data-node-id="probe:b"]').dispatchEvent('dblclick');
    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
    await expect(page.locator('#node-info h3')).toHaveText('b');
    expect(new URL(page.url()).searchParams.get('sel')).toBe('probe:a');
    expect(new URL(page.url()).searchParams.get('id')).toBeNull();

    release();
    await page.waitForTimeout(500);
    expect(await shownIds(page)).toContain('probe:b');
    await expect(page.locator('#query-label')).not.toContainText('focus a');
    expect(new URL(page.url()).searchParams.get('focus')).toBeNull();
  });
});

// 100 roots -> 5 children -> 2 grandchildren -> 12 leaves: 13,600 nodes, a
// large graph. Its seeded view refuses depth 3 (over 2,000 nodes) and draws
// depth 2, which leaves the leaves out.
function largeGraph() {
  const node = (id: string) => ({
    id, display_name: id, symbol: id,
    full_path: `/l/${id}.rs`, relative_path: `src/${id}.rs`, file_name: `${id}.rs`,
    parent_folder: 'src', crate_name: 'l', is_libsignal: false, kind: 'exec',
    dependencies: [] as string[], dependents: [] as string[],
  });
  const nodes = [];
  const links = [];
  for (let i = 0; i < 100; i++) {
    nodes.push(node(`r${i}`));
    for (let j = 0; j < 5; j++) {
      const child = `c${i * 5 + j}`;
      nodes.push(node(child));
      links.push({ source: `r${i}`, target: child, type: 'inner' });
      for (let k = 0; k < 2; k++) {
        const grand = `g${(i * 5 + j) * 2 + k}`;
        nodes.push(node(grand));
        links.push({ source: child, target: grand, type: 'inner' });
        for (let l = 0; l < 12; l++) {
          const leaf = `x${((i * 5 + j) * 2 + k) * 12 + l}`;
          nodes.push(node(leaf));
          links.push({ source: grand, target: leaf, type: 'inner' });
        }
      }
    }
  }
  return {
    nodes, links,
    metadata: { total_nodes: nodes.length, total_edges: links.length, project_root: '/l', generated_at: '2026-01-01' },
  };
}

test('Packed Map: the query of a function opened from a large graph keeps the depth', async ({ page }) => {
  await page.route('**/large.json', (route: Route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(largeGraph()) }));
  await page.goto('/probegraph/?json=large.json&view=packed-map&depth=3');
  await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 30000 });
  // x0 is three calls below r0: the seeded view at depth 2 leaves it out
  await page.locator('.pm-fn[data-node-id="x0"]').dispatchEvent('dblclick');

  await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
  await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe('x0');
  expect(new URL(page.url()).searchParams.get('depth')).toBe('3');
  await expect(page.locator('#depth-value')).toHaveText('3');
  // Callers up to r0, three levels up
  await expect.poll(async () => (await shownIds(page)).includes('r0')).toBe(true);
});
