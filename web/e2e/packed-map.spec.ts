/**
 * E2E tests for the Packed Map view (docs/plans/packed-map.md, Phase 2):
 * selection, the shared click and wheel camera, `?packed=` and the empty
 * state. Uses the tracked multi-crate fixture graph_backup_dalek.json.
 * Clicks on SVG circles are dispatched, as in hierarchy.spec.ts.
 */

import { test, expect, type Page } from '@playwright/test';

const BASE = '/probegraph/?json=./graph_backup_dalek.json';
const VIEW_URL = `${BASE}&view=packed-map`;

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
    await page.goto(VIEW_URL);
    await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 30000 });
    await page.locator('#show-exec-functions').uncheck();
    await expect(page.locator('.pm-empty')).toHaveText('No Rust functions match the filters.');
    await expect(page.locator('.pm-fn')).toHaveCount(0);
    await expect(page.locator('#view-packed-map')).toBeVisible();
  });
});
