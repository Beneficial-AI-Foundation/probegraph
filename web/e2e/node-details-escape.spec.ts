import { test, expect, type Page } from '@playwright/test';

// Graph strings come from third-party extracts; the details panel must show
// them as text, never parse them as markup.
const NAME = '<img src=x onerror="window.__pwned=1">name';
const PATH = 'Evil/<b id="injected">P</b>.lean';
// The loader keeps only the text after the last `/` as the file name.
const FILE_PATH = 'Evil/<img id="file-injected" src=x>.lean';
// Ends up in data-node-id attributes; quotes must not break out of them.
const SPEC_ID = `probe:spec" data-x='1' &amp;`;
const INJECTED = 'img, #injected, #file-injected, #kind-injected, #mapping-injected, [data-x]';

const atoms = {
  'probe:evil': {
    kind: 'theorem',
    'display-name': NAME,
    dependencies: ['probe:other'],
    'code-text': { 'lines-start': 1, 'lines-end': 2 },
    'code-path': PATH,
    'code-module': 'Evil',
    specs: [SPEC_ID],
    'translation-name': SPEC_ID,
    'translation-path': '<b id="mapping-injected">M</b>',
  },
  'probe:other': {
    kind: '<i id="kind-injected">def</i>',
    'display-name': NAME + '2',
    dependencies: [],
    'code-text': { 'lines-start': 3, 'lines-end': 4 },
    'code-path': FILE_PATH,
    'code-module': 'Evil',
  },
  [SPEC_ID]: {
    kind: 'theorem',
    'display-name': 'spec',
    dependencies: [],
    'code-text': { 'lines-start': 5, 'lines-end': 6 },
    'code-path': 'Evil/Spec.lean',
    'code-module': 'Evil',
  },
};

async function loadGraph(page: Page, graph: unknown): Promise<void> {
  await page.locator('#file-input').setInputFiles({
    name: 'evil.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(graph)),
  });
}

test('node details render graph strings as text', async ({ page }) => {
  await page.goto('/probegraph/');
  await loadGraph(page, atoms);

  const nodes = page.locator('circle.node');
  await expect(nodes).toHaveCount(3, { timeout: 15000 });
  const info = page.locator('#node-info');
  const heading = info.locator('h3');
  // The force layout keeps circles moving; a real click waits for them to settle.
  const select = (i: number) => nodes.nth(i).dispatchEvent('click');

  // Each click must show a new heading, so a stale panel cannot pass.
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    await select(i);
    for (const prev of seen) await expect(heading).not.toHaveText(prev);
    seen.push((await heading.textContent()) ?? '');
    await expect(info.locator(INJECTED)).toHaveCount(0);
  }
  expect([...seen].sort()).toEqual([NAME, NAME + '2', 'spec'].sort());

  // On the node with the spec and mapping, the ids round-trip through the
  // attribute and the spec link navigates to the spec node.
  await select(seen.indexOf(NAME));
  await expect(heading).toHaveText(NAME);
  await expect(info).toContainText(PATH);
  await expect(info).toContainText('<b id="mapping-injected">M</b>');
  const links = info.locator('.navigate-to-node');
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) {
    expect(await link.getAttribute('data-node-id')).toBe(SPEC_ID);
  }
  await links.last().click();
  await expect(heading).toHaveText('spec');

  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('graph metadata and URL queries render as text', async ({ page }) => {
  const markup = '<img id="url-injected" src=x>';
  await page.goto(`/probegraph/?source=${encodeURIComponent(markup)}`);
  await loadGraph(page, {
    nodes: [{
      id: 'a', display_name: 'a', symbol: 'a', full_path: 'a.rs', relative_path: 'a.rs',
      file_name: 'a.rs', parent_folder: '', crate_name: '', is_libsignal: false,
      dependencies: [], dependents: [], kind: 'exec',
    }],
    links: [],
    metadata: {
      total_nodes: 1, total_edges: 0,
      project_root: '<img id="root-injected" src=x>',
    },
  });

  await expect(page.locator('#stats')).toContainText('<img id="root-injected" src=x>', { timeout: 15000 });
  await expect(page.locator('#query-label')).toContainText(markup);
  await expect(page.locator('#root-injected, #url-injected')).toHaveCount(0);
});
