/**
 * E2E test for the VS Code webview protocol (docs/guides/vscode-extension.md).
 *
 * The page gets a stubbed acquireVsCodeApi that records what the viewer posts;
 * the test plays the extension by posting messages to the window.
 */

import { test, expect, type Page } from '@playwright/test';

// quicksort example: partition calls len and swap; quicksort calls partition,
// len and split_at_mut; test_quicksort calls quicksort.
function node(id: string, name: string, lines?: [number, number]) {
  return {
    id, display_name: name, symbol: id,
    relative_path: lines ? 'src/lib.rs' : '', file_name: lines ? 'lib.rs' : '',
    parent_folder: lines ? 'src' : '', start_line: lines?.[0] ?? 0, end_line: lines?.[1] ?? 0,
    is_libsignal: false, dependencies: [], dependents: [], kind: 'exec',
  };
}

const GRAPH = {
  nodes: [
    node('qs/partition()', 'partition', [14, 26]),
    node('qs/quicksort()', 'quicksort', [4, 12]),
    node('qs/test_quicksort()', 'test_quicksort', [33, 37]),
    node('core/len()', 'len'),
    node('core/swap()', 'swap'),
    node('core/split_at_mut()', 'split_at_mut'),
  ],
  links: [
    { source: 'qs/partition()', target: 'core/len()', type: 'inner' },
    { source: 'qs/partition()', target: 'core/swap()', type: 'inner' },
    { source: 'qs/quicksort()', target: 'core/len()', type: 'inner' },
    { source: 'qs/quicksort()', target: 'qs/partition()', type: 'inner' },
    { source: 'qs/quicksort()', target: 'core/split_at_mut()', type: 'inner' },
    { source: 'qs/test_quicksort()', target: 'qs/quicksort()', type: 'inner' },
  ],
  metadata: { total_nodes: 6, total_edges: 6, project_root: '/ws', generated_at: '2026-10-01T00:00:00Z' },
};

async function openWebview(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __sent: unknown[]; acquireVsCodeApi: () => unknown };
    w.__sent = [];
    let state: unknown;
    w.acquireVsCodeApi = () => ({
      postMessage: (m: unknown) => w.__sent.push(m),
      getState: () => state,
      setState: (s: unknown) => { state = s; },
    });
  });
  await page.goto('/probegraph/');
}

const sent = (page: Page) =>
  page.evaluate(() => (window as unknown as { __sent: { type: string }[] }).__sent);

const post = (page: Page, message: unknown) =>
  page.evaluate((m) => window.postMessage(m, '*'), message);

async function clickNode(page: Page, name: string) {
  await page.evaluate((n) => {
    const circle = [...document.querySelectorAll('#graph-container svg circle')]
      .find((c) => (c as unknown as { __data__?: { display_name: string } }).__data__?.display_name === n);
    circle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, name);
}

test.describe('VS Code webview', () => {
  test('announces itself and switches to VS Code mode', async ({ page }) => {
    await openWebview(page);
    await expect.poll(() => sent(page)).toContainEqual({ type: 'ready' });
    await expect(page.locator('.header h1')).toHaveText('Call Graph Explorer');
    await expect(page.locator('.file-input-container')).toBeHidden();
  });

  test('loadGraph with a selected node shows its neighbourhood', async ({ page }) => {
    await openWebview(page);
    await expect.poll(() => sent(page)).toContainEqual({ type: 'ready' });
    await post(page, {
      type: 'loadGraph', graph: GRAPH,
      initialQuery: { source: 'partition', sink: 'partition', depth: 3 },
      selectedNodeId: 'qs/partition()',
    });
    await expect(page.locator('#query-label')).toContainText('neighborhood of partition');
    // partition, its callees len and swap, its caller quicksort, and test_quicksort
    await expect(page.locator('#graph-container svg circle')).toHaveCount(5);
  });

  test('Open in Editor posts navigate with the node location', async ({ page }) => {
    await openWebview(page);
    await expect.poll(() => sent(page)).toContainEqual({ type: 'ready' });
    await post(page, { type: 'loadGraph', graph: GRAPH, selectedNodeId: 'qs/partition()' });
    await expect(page.locator('#graph-container svg circle').first()).toBeAttached();

    await clickNode(page, 'partition');
    const button = page.locator('#navigate-to-source-btn');
    await expect(button).toHaveText('Open in Editor');
    await button.click();
    await expect.poll(() => sent(page)).toContainEqual({
      type: 'navigate', relativePath: 'src/lib.rs', startLine: 14, endLine: 26, displayName: 'partition',
    });
  });

  test('setQuery replaces the query', async ({ page }) => {
    await openWebview(page);
    await expect.poll(() => sent(page)).toContainEqual({ type: 'ready' });
    await post(page, {
      type: 'loadGraph', graph: GRAPH,
      initialQuery: { source: '', sink: '', depth: 3 },
      selectedNodeId: 'qs/partition()',
    });
    await expect(page.locator('#graph-container svg circle').first()).toBeAttached();

    await post(page, { type: 'setQuery', source: 'test_quicksort', sink: '' });
    await expect(page.locator('#query-label')).toContainText('test_quicksort');
    await expect(page.locator('#source-input')).toHaveValue('test_quicksort');
    // The depth from loadGraph stays: test_quicksort → quicksort →
    // partition, len, split_at_mut → swap
    await expect(page.locator('#graph-container svg circle')).toHaveCount(6);
  });

  test.describe('with revisions', () => {
    // GRAPH plus a spec function, which the default filters hide
    const WITH_SPEC = {
      ...GRAPH,
      nodes: [...GRAPH.nodes, { ...node('qs/sorted()', 'sorted', [40, 44]), kind: 'spec', mode: 'spec' }],
    };
    const select = (nodeId: string, depth = 1) => ({ nodeId, direction: 'both', depth });
    const drawn = (page: Page) => page.evaluate(() =>
      [...document.querySelectorAll('#graph-container svg circle')]
        .map((c) => (c as unknown as { __data__?: { id: string } }).__data__?.id).sort());
    const results = async (page: Page) =>
      (await sent(page)).filter((m) => m.type === 'selectResult');

    async function load(page: Page, selection?: unknown) {
      await openWebview(page);
      await expect.poll(() => sent(page)).toContainEqual({ type: 'ready' });
      await post(page, { type: 'loadGraph', revision: 1, requestId: 1, graph: WITH_SPEC, selection });
      await expect.poll(() => sent(page)).toContainEqual({ type: 'graphLoaded', revision: 1, nodes: 7 });
    }

    test('loadGraph with a selection draws it and reports shown', async ({ page }) => {
      await load(page, select('qs/partition()'));
      await expect.poll(() => results(page)).toEqual([
        { type: 'selectResult', revision: 1, requestId: 1, status: 'shown' },
      ]);
      // depth 1: partition, its callees len and swap, its caller quicksort
      await expect.poll(() => drawn(page)).toEqual(['core/len()', 'core/swap()', 'qs/partition()', 'qs/quicksort()']);
    });

    test('selectNode moves the selection and ignores other revisions', async ({ page }) => {
      await load(page, select('qs/partition()'));
      await post(page, { type: 'selectNode', revision: 0, requestId: 2, selection: select('qs/test_quicksort()') });
      await post(page, { type: 'selectNode', revision: 1, requestId: 3, selection: select('qs/test_quicksort()') });
      await expect.poll(() => results(page)).toEqual([
        { type: 'selectResult', revision: 1, requestId: 1, status: 'shown' },
        { type: 'selectResult', revision: 1, requestId: 3, status: 'shown' },
      ]);
      await expect.poll(() => drawn(page)).toEqual(['qs/quicksort()', 'qs/test_quicksort()']);
    });

    test('an editor selection unhides a node hidden by shift-click', async ({ page }) => {
      await load(page, select('qs/quicksort()'));
      await expect.poll(() => drawn(page)).toContain('qs/partition()');
      await page.evaluate(() => {
        const circle = [...document.querySelectorAll('#graph-container svg circle')]
          .find((c) => (c as unknown as { __data__?: { id: string } }).__data__?.id === 'qs/partition()');
        circle!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      });
      await expect.poll(() => drawn(page)).not.toContain('qs/partition()');

      await post(page, { type: 'selectNode', revision: 1, requestId: 2, selection: select('qs/partition()') });
      await expect.poll(() => results(page)).toContainEqual({ type: 'selectResult', revision: 1, requestId: 2, status: 'shown' });
      await expect.poll(() => drawn(page)).toContain('qs/partition()');
    });

    test('a spec function with Spec off is reported filtered, and an unknown id missing', async ({ page }) => {
      await load(page);
      await post(page, { type: 'selectNode', revision: 1, requestId: 2, selection: select('qs/sorted()') });
      await post(page, { type: 'selectNode', revision: 1, requestId: 3, selection: select('qs/gone()') });
      await expect.poll(() => results(page)).toEqual([
        { type: 'selectResult', revision: 1, requestId: 2, status: 'filtered', filteredBy: ['showSpecFunctions'] },
        { type: 'selectResult', revision: 1, requestId: 3, status: 'missing' },
      ]);
    });

    test('relaxFilters turns the named filters on for the loaded revision only', async ({ page }) => {
      await load(page, select('qs/sorted()'));
      await expect.poll(() => results(page)).toEqual([
        { type: 'selectResult', revision: 1, requestId: 1, status: 'filtered', filteredBy: ['showSpecFunctions'] },
      ]);
      await post(page, { type: 'relaxFilters', revision: 0, keys: ['showSpecFunctions'] });
      await expect(page.locator('#show-spec-functions')).not.toBeChecked();
      await post(page, { type: 'relaxFilters', revision: 1, keys: ['showSpecFunctions'] });
      await expect(page.locator('#show-spec-functions')).toBeChecked();
      await expect.poll(() => drawn(page)).toContain('qs/sorted()');
    });
  });

  test('refresh is answered with requestRefresh', async ({ page }) => {
    await openWebview(page);
    await expect.poll(() => sent(page)).toContainEqual({ type: 'ready' });
    await post(page, { type: 'refresh' });
    await expect.poll(() => sent(page)).toContainEqual({ type: 'requestRefresh' });
  });
});
