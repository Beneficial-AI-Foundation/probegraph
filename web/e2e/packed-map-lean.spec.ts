/**
 * E2E tests for the Packed Map on pure Lean graphs (docs/plans/packed-map.md,
 * Phase 4). Uses the synthetic fixture src/test-data/probe-lean-packed-map.json,
 * a small Rust graph built here, and the blueprint project template.
 * Clicks on SVG circles are dispatched, as in packed-map.spec.ts.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';

const LEAN = JSON.parse(readFileSync(new URL('../src/test-data/probe-lean-packed-map.json', import.meta.url), 'utf8'));
const BLUEPRINT = readFileSync(new URL('../src/test-data/blueprint-project-template.json', import.meta.url));

/** The fixture with only its structure. */
function structuresOnly() {
  const data = Object.fromEntries(Object.entries(LEAN.data).filter(([, a]) => (a as { kind: string }).kind === 'structure'));
  return { ...LEAN, data };
}

/** A small Rust graph: f calls g. */
function rustGraph() {
  const nodes = ['f', 'g'].map(name => ({
    id: `probe:${name}`, display_name: name, symbol: `probe:${name}`,
    full_path: `/r/src/${name}.rs`, relative_path: `src/${name}.rs`, file_name: `${name}.rs`,
    parent_folder: 'src', crate_name: 'r', is_libsignal: false, kind: 'exec',
    dependencies: name === 'f' ? ['probe:g'] : [], dependents: name === 'g' ? ['probe:f'] : [],
  }));
  return {
    nodes,
    links: [{ source: 'probe:f', target: 'probe:g', type: 'inner' }],
    metadata: { total_nodes: 2, total_edges: 1, project_root: '/r', generated_at: '2026-01-01' },
  };
}

/** Declarations drawn with the default filters. */
const DEFAULT_DRAWN = [
  'add', 'add_comm', 'choice', 'clean_skip', 'hidden_sorry', 'lonely', 'trust_bad', 'trusted_def', 'uses_sorry',
];

async function serve(page: Page, name: string, body: unknown): Promise<void> {
  await page.route(`**/${name}`, (route: Route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }));
}

async function upload(page: Page, name: string, body: unknown): Promise<void> {
  await page.locator('#file-input').setInputFiles({
    name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(body)),
  });
}

async function drawnNames(page: Page): Promise<string[]> {
  return (await page.locator('.pm-fn').evaluateAll(
    els => els.map(el => el.getAttribute('data-node-id')!.replace('probe:Demo.', '')),
  )).sort();
}

/** Wait until the click zoom transition is over (the camera stops moving). */
async function settle(page: Page): Promise<void> {
  let last = await page.locator('.pm-camera').getAttribute('transform');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const now = await page.locator('.pm-camera').getAttribute('transform');
    if (now === last) return;
    last = now;
  }
}

test.describe('Packed Map on a pure Lean graph', () => {
  test('shows the button and draws the expected declarations', async ({ page }) => {
    await serve(page, 'lean.json', LEAN);
    await page.goto('/probegraph/?json=lean.json');
    await expect(page.locator('#view-packed-map')).toBeVisible({ timeout: 15000 });
    await page.locator('#view-packed-map').click();
    await expect(page.locator('.pm-fn')).toHaveCount(DEFAULT_DRAWN.length, { timeout: 15000 });
    expect(await drawnNames(page)).toEqual(DEFAULT_DRAWN);

    // One top-level circle per crate; a file two levels deep is its own crate
    const groups = await page.locator('.pm-group').evaluateAll(els => els.map(el => el.getAttribute('data-group-id')));
    expect(groups.sort()).toEqual(['Demo/Basic.lean', 'Demo/Proofs', 'Demo/Proofs/Spec.lean', 'Demo/Trust', 'Demo/Trust/Base.lean']);
    await expect(page.locator('.pm-group[data-group-id="Demo/Proofs"] > title'))
      .toHaveText('Demo/Proofs\n4 declarations, 1 transitively verified or trusted');

    const legend = page.locator('.pm-legend');
    await expect(legend).toHaveAttribute('data-language', 'lean');
    await expect(legend).toContainText('Lean declarations without hidden ones, as the Declaration Kind filters show');
    await expect(legend).toContainText('Declaration: 1 + dependency links after the filters');
    await expect(legend).toContainText('Verified: not known to be free of sorry');
    await expect(legend).toContainText('Arc: share transitively verified or trusted');
    await expect(legend).toContainText('Dependency');
    await expect(legend).not.toContainText('Body call');
    await expect(page.locator('.packed-map-svg')).toHaveAttribute('aria-label', /^Packed Map declarations\./);

    // Theorems off: the Theorem filter removes them from the map
    await page.locator('#show-proof-functions').uncheck();
    await expect(page.locator('.pm-fn')).toHaveCount(5);
    expect(await drawnNames(page)).toEqual(['add', 'choice', 'lonely', 'trust_bad', 'trusted_def']);
  });

  test('a graph with only structures keeps the button and shows the empty state', async ({ page }) => {
    await serve(page, 'structs.json', structuresOnly());
    await page.goto('/probegraph/?json=structs.json&view=packed-map');
    await expect(page.locator('.pm-empty')).toHaveText('No Lean declarations match the filters.', { timeout: 15000 });
    await expect(page.locator('#view-packed-map')).toBeVisible();
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);

    await page.locator('#show-types').check();
    await expect(page.locator('.pm-fn')).toHaveCount(1);
    await expect(page.locator('.pm-empty')).toHaveCount(0);
  });

  test('Verus, then Lean, then Verus with the view open gives the right legend each time', async ({ page }) => {
    await serve(page, 'rust.json', rustGraph());
    await page.goto('/probegraph/?json=rust.json&view=packed-map');
    const legend = page.locator('.pm-legend');
    await expect(page.locator('.pm-fn')).toHaveCount(2, { timeout: 15000 });
    await expect(legend).toHaveAttribute('data-language', 'verus');
    await expect(legend).toContainText('Body call');

    await upload(page, 'lean.json', LEAN);
    await expect(page.locator('.pm-fn')).toHaveCount(DEFAULT_DRAWN.length, { timeout: 15000 });
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);
    await expect(legend).toHaveAttribute('data-language', 'lean');
    await expect(legend).toContainText('Lean declarations without hidden ones');
    await expect(legend).not.toContainText('Body call');
    await expect(page.locator('.packed-map-svg')).toHaveAttribute('aria-label', /^Packed Map declarations\./);
    await expect(page.locator('.pm-group').first().locator('title')).toContainText('declarations');

    await upload(page, 'rust.json', rustGraph());
    await expect(page.locator('.pm-fn')).toHaveCount(2, { timeout: 15000 });
    await expect(legend).toHaveAttribute('data-language', 'verus');
    await expect(legend).toContainText('Rust (exec) functions only');
    await expect(legend).toContainText('Body call');
    await expect(page.locator('.packed-map-svg')).toHaveAttribute('aria-label', /^Packed Map functions\./);
    await expect(page.locator('.pm-group').first().locator('title')).toContainText('functions');
    // Only one legend
    await expect(legend).toHaveCount(1);
  });

  test('reload keeps the view and the zoomed group', async ({ page }) => {
    await serve(page, 'lean.json', LEAN);
    await page.goto('/probegraph/?json=lean.json&view=packed-map');
    await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 15000 });
    await page.locator('.pm-group[data-group-id="Demo/Proofs"]').dispatchEvent('click');
    await settle(page);
    expect(new URL(page.url()).searchParams.get('packed')).toBe('Demo/Proofs');

    await page.reload();
    await expect(page.locator('.pm-fn')).toHaveCount(DEFAULT_DRAWN.length, { timeout: 15000 });
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/);
    await expect(page.locator('.packed-map-svg')).toHaveAttribute('data-packed-focus', 'Demo/Proofs');
  });

  test('Back from the Call Graph returns to the Lean Packed Map', async ({ page }) => {
    await serve(page, 'lean.json', LEAN);
    await page.goto('/probegraph/?json=lean.json&view=packed-map');
    await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 15000 });
    await page.locator('.pm-fn[data-node-id="probe:Demo.add_comm"]').dispatchEvent('dblclick');
    await expect(page.locator('#view-callgraph')).toHaveClass(/active/, { timeout: 10000 });
    await expect(page.locator('circle.node').first()).toBeAttached({ timeout: 10000 });

    await page.goBack();
    await expect(page.locator('#view-packed-map')).toHaveClass(/active/, { timeout: 10000 });
    await expect(page.locator('.pm-fn')).toHaveCount(DEFAULT_DRAWN.length);
  });

  test('the blueprint layer hides the button; the Lean code layer shows it', async ({ page }) => {
    await page.goto('/probegraph/');
    await page.locator('#file-input').setInputFiles({
      name: 'extract.json', mimeType: 'application/json', buffer: BLUEPRINT,
    });
    await expect(page.locator('#layer-blueprint')).toHaveClass(/active/, { timeout: 15000 });
    await expect(page.locator('#view-packed-map')).toBeHidden();

    await page.locator('#layer-code').click();
    await expect(page.locator('#layer-code')).toHaveClass(/active/);
    await expect(page.locator('#view-packed-map')).toBeVisible();
    await page.locator('#view-packed-map').click();
    await expect(page.locator('.pm-fn').first()).toBeAttached({ timeout: 15000 });

    // Back to the blueprint layer: the view falls back to the Call Graph
    await page.locator('#layer-blueprint').click();
    await expect(page.locator('#view-packed-map')).toBeHidden();
    await expect(page.locator('#view-callgraph')).toHaveClass(/active/);
  });
});
