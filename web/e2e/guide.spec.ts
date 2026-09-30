/**
 * E2E tests for the Guide chips on the default Lean graph (public/graph.json,
 * probe-lean). Expectations are read from the rendered nodes and the URL,
 * not from counts pinned to the dataset.
 */

import { test, expect, type Page } from '@playwright/test';

const TYPE_KINDS = ['structure', 'inductive', 'class'];

interface Shown {
  id: string;
  kind: string;
  crate: string;
  status: string | undefined;
}

async function open(page: Page): Promise<void> {
  await page.goto('/probegraph/?json=graph.json');
  await expect(page.locator('#stats')).toContainText('Total Nodes', { timeout: 30000 });
  await page.locator('#tab-guide').click();
}

async function shownNodes(page: Page): Promise<Shown[]> {
  return page.locator('circle.node').evaluateAll(els => els.map(el => {
    const d = (el as any).__data__;
    return { id: d.id, kind: d.kind, crate: d.crate_name, status: d.verification_status };
  }));
}

/** Rendered links as [source crate, target crate]. */
async function shownLinkGroups(page: Page): Promise<[string, string][]> {
  return page.locator('path.link').evaluateAll(els => els.map(el => {
    const d = (el as any).__data__;
    return [d.source.crate_name, d.target.crate_name] as [string, string];
  }));
}

function chip(page: Page, text: RegExp) {
  return page.locator('.guide-chip').filter({ hasText: text });
}

/** Click a chip and wait for its toast; the Guide tab must stay active. */
async function clickChip(page: Page, text: RegExp): Promise<string> {
  await page.locator('.toast').evaluateAll(els => els.forEach(el => el.remove()));
  await chip(page, text).click();
  const toast = page.locator('.toast').last();
  await expect(toast).toBeVisible();
  await expect(page.locator('#tab-guide')).toHaveClass(/active/);
  await expect(page.locator('#panel-guide')).toBeVisible();
  return (await toast.textContent()) ?? '';
}

function param(page: Page, key: string): string | null {
  return new URL(page.url()).searchParams.get(key);
}

test.describe('Guide on the Lean graph', () => {
  test('summary counts each verification status separately', async ({ page }) => {
    await open(page);
    const summary = page.locator('#guide-summary');
    await expect(summary).toContainText(/Verification: \d+ transitively verified, \d+ verified \(locally only\), \d+ trusted/);
    await expect(summary).not.toContainText(/verified out of/);
  });

  test('namespace boundary: the busiest directed pair, and it is not empty', async ({ page }) => {
    await open(page);
    const label = (await chip(page, /boundary/).locator('.chip-label').textContent())!;
    const [, source, target] = label.match(/boundary: (.+) → (.+)$/)!;

    const toast = await clickChip(page, /boundary/);
    expect(toast).toMatch(new RegExp(`^\\d+ nodes: `));
    expect(param(page, 'boundary-source')).toBe(source);
    expect(param(page, 'boundary-target')).toBe(target);

    await expect.poll(async () => (await shownNodes(page)).length).toBeGreaterThan(0);
    const nodes = await shownNodes(page);
    expect(nodes.every(n => n.crate === source || n.crate === target)).toBe(true);
    const links = await shownLinkGroups(page);
    expect(links.some(([s, t]) => s === source && t === target)).toBe(true);
  });

  test('most connected names a node the kind filters show, and follows them', async ({ page }) => {
    await open(page);
    const toast = await clickChip(page, /most connected/);
    const target = param(page, 'id')!;
    expect(param(page, 'dir')).toBe('callers');
    await expect.poll(async () => (await shownNodes(page)).map(n => n.id)).toContain(target);
    const node = (await shownNodes(page)).find(n => n.id === target)!;
    expect(TYPE_KINDS).not.toContain(node.kind);
    expect(toast).toMatch(/^\d+ nodes: callers of .+/);

    // Showing types re-ranks: the top node overall is a structure on this graph
    const before = await chip(page, /most connected/).textContent();
    await page.locator('#show-types').check();
    await expect(chip(page, /most connected/)).not.toHaveText(before!);
    await clickChip(page, /most connected/);
    const typeTarget = param(page, 'id')!;
    expect(typeTarget).not.toBe(target);
    await expect.poll(async () => (await shownNodes(page)).find(n => n.id === typeTarget)?.kind)
      .toMatch(new RegExp(`^(${TYPE_KINDS.join('|')})$`));
  });

  test('verified chip selects exactly transitively verified, after a boundary', async ({ page }) => {
    await open(page);
    await clickChip(page, /boundary/);
    await expect.poll(async () => (await shownNodes(page)).length).toBeGreaterThan(0);
    const boundaryIds = (await shownNodes(page)).map(n => n.id).sort();

    const toast = await clickChip(page, /Show only transitively verified/);
    expect(toast).toMatch(/^\d+ nodes: transitively-verified only \(entry points view\)$/);
    const url = new URL(page.url());
    expect(url.searchParams.get('status')).toBe('transitively-verified');
    expect(url.searchParams.has('boundary-source')).toBe(false);

    await expect.poll(async () => (await shownNodes(page)).length).toBeGreaterThan(0);
    const statuses = new Set((await shownNodes(page)).map(n => n.status));
    expect([...statuses]).toEqual(['transitively-verified']);
    const verified = page.locator('#show-verified-nodes');
    expect(await verified.evaluate(el => (el as HTMLInputElement).indeterminate)).toBe(true);
    await expect(page.locator('#show-failed-nodes')).not.toBeChecked();

    // Back restores the boundary with every status
    await page.goBack();
    await expect.poll(async () => (await shownNodes(page)).map(n => n.id).sort()).toEqual(boundaryIds);
    expect(param(page, 'status')).toBeNull();
    expect(await verified.evaluate(el => (el as HTMLInputElement).indeterminate)).toBe(false);
    await expect(verified).toBeChecked();
  });

  test('checking a status box after the chip keeps the exact selection', async ({ page }) => {
    await open(page);
    await clickChip(page, /Show only transitively verified/);
    await page.locator('#show-unverified-nodes').check();
    expect(param(page, 'status')).toBe('transitively-verified,unverified');
    await expect(page.locator('#show-unverified-nodes')).toBeChecked();
    const statuses = (await shownNodes(page)).map(n => n.status);
    expect(statuses.every(s => s === 'transitively-verified' || s === 'unverified')).toBe(true);
  });

  test('clicking the partly checked Verified box selects the whole group', async ({ page }) => {
    await open(page);
    await clickChip(page, /Show only transitively verified/);
    const verified = page.locator('#show-verified-nodes');
    expect(await verified.evaluate(el => (el as HTMLInputElement).indeterminate)).toBe(true);
    await expect(verified).not.toBeChecked();

    await verified.click();
    await expect(verified).toBeChecked();
    expect(await verified.evaluate(el => (el as HTMLInputElement).indeterminate)).toBe(false);
    expect(param(page, 'status')).toBeNull();
    await expect(page.locator('#show-failed-nodes')).not.toBeChecked();
  });

  test('body/proof box drops term links from the view, and survives a reload', async ({ page }) => {
    await open(page);
    await clickChip(page, /most connected/);
    const roles = () => page.locator('path.link').evaluateAll(els => els.map(el => {
      const d = (el as any).__data__;
      return `${d.type}:${d.role ?? '-'}`;
    }));
    await expect.poll(async () => (await roles()).some(r => r === 'inner:term')).toBe(true);

    await page.locator('#show-body-deps').uncheck();
    expect(param(page, 'body')).toBe('0');
    await expect.poll(async () => (await roles()).some(r => r === 'inner:term')).toBe(false);
    expect((await roles()).every(r => ['inner:type', 'inner:both', 'spec:type', 'spec:both'].includes(r))).toBe(true);
    await expect(page.locator('#guide-summary')).toContainText('boxes do not change them');

    await page.reload();
    await expect(page.locator('#stats')).toContainText('Total Nodes', { timeout: 30000 });
    await expect(page.locator('#show-body-deps')).not.toBeChecked();
    await expect(page.locator('#show-statement-deps')).toBeChecked();
  });

  test('statement box drops type-only spec links, Specifications still checked', async ({ page }) => {
    await open(page);
    await clickChip(page, /most connected/);
    const links = () => page.locator('path.link').evaluateAll(els => els.map(el => {
      const d = (el as any).__data__;
      return { pair: `${d.source.id}>${d.target.id}`, kind: `${d.type}:${d.role ?? '-'}` };
    }));
    const pairsOf = async (kind: string) =>
      (await links()).filter(l => l.kind === kind).map(l => l.pair);
    await expect.poll(async () => (await pairsOf('spec:type')).length).toBeGreaterThan(0);
    const typeOnly = await pairsOf('spec:type');
    const both = await pairsOf('spec:both');
    expect(both.length).toBeGreaterThan(0);

    await page.locator('#show-statement-deps').uncheck();
    expect(param(page, 'statement')).toBe('0');
    await expect(page.locator('#show-spec-links')).toBeChecked();
    await expect.poll(async () => (await links()).some(l => typeOnly.includes(l.pair))).toBe(false);
    const after = await pairsOf('spec:both');
    expect(both.some(p => after.includes(p))).toBe(true);
  });
});
