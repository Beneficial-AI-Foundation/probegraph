/**
 * E2E test for the trust base in node details
 * (docs/plans/trust-and-frontier.md, Phase 1): the summary line, the lists
 * with witnesses, the links, the "show path" button and the kept expanded
 * state.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// top -> mid -> low -> ax; low is unfinished, ax an axiom. top also names
// a dependency that is not in the extract.
const atom = (name: string, over: Record<string, unknown>) => ({
  kind: 'theorem', language: 'lean', 'display-name': name, dependencies: [],
  'code-text': { 'lines-start': 1, 'lines-end': 2 }, 'code-path': `T/${name}.lean`, 'code-module': 'T',
  ...over,
});
const atoms = {
  'probe:top': atom('top', { dependencies: ['probe:mid', 'probe:Gone.ctor'], 'verification-status': 'verified' }),
  'probe:mid': atom('mid', { dependencies: ['probe:low'], 'verification-status': 'verified' }),
  'probe:low': atom('low', { dependencies: ['probe:ax'], 'verification-status': 'unverified' }),
  'probe:ax': atom('ax', { kind: 'axiom', 'verification-status': 'trusted', 'trusted-reason': 'axiom' }),
};

async function select(page: Page, name: string): Promise<void> {
  await page.locator('#search-input').fill(name);
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('#node-info h3')).toHaveText(name);
}

test('node details list what a declaration rests on', async ({ page }) => {
  await page.route('**/trust.json', (route: Route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(atoms) }));
  await page.goto('/probegraph/?json=trust.json');
  await expect(page.locator('#stats')).toContainText('Total Nodes', { timeout: 15000 });

  await select(page, 'top');
  const trust = page.locator('#node-info details.trust-base');
  await expect(trust.locator('summary'))
    .toHaveText('Trust base: Rests on 1 assumption and 1 unfinished declaration');
  await expect(trust).not.toHaveAttribute('open', '');

  // Opening by keyboard renders the lists and keeps the focus on the summary
  await trust.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(trust).toHaveAttribute('open', '');
  await expect(trust.locator('summary')).toBeFocused();
  await expect(trust).toContainText('ax (axiom)');
  await expect(trust).toContainText('via mid → low');
  await expect(trust).toContainText('Missing targets (1)');
  await expect(trust).toContainText('probe:Gone.ctor');

  // Show path draws the paths in the Call Graph and keeps the panel
  const shown = () => page.locator('circle.node').evaluateAll(
    els => els.map(el => (el as any).__data__?.id as string).sort());
  const before = page.url();
  await trust.locator('li', { hasText: 'ax' }).locator('button.trust-path').click();
  await expect(page).toHaveURL(/source-id=probe%3Atop.*sink-id=probe%3Aax|source-id=probe:top.*sink-id=probe:ax/);
  await expect.poll(shown).toEqual(['probe:ax', 'probe:low', 'probe:mid', 'probe:top']);
  await expect(page.locator('#node-info h3')).toHaveText('top');
  await page.goBack();
  await expect(page).toHaveURL(before);
  await select(page, 'top');

  // An entry link shows its details, and the lists stay expanded
  await trust.locator('a.navigate-to-node', { hasText: 'low' }).click();
  await expect(page.locator('#node-info h3')).toHaveText('low');
  await expect(trust).toHaveAttribute('open', '');
  await expect(trust).toContainText('low (this declaration)');
});
