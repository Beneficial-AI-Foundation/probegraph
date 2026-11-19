import { test, expect } from '@playwright/test';

// The fold buttons shrink a sidebar to a strip, give the graph the space,
// and keep the state across a reload
test.describe('sidebar folds', () => {
  test('fold buttons and [ ] keys fold the sidebars, and the state survives a reload', async ({ page }) => {
    await page.goto('/probegraph/');
    await page.evaluate(() => localStorage.removeItem('probegraph.foldedSidebars'));
    await page.reload();
    await page.waitForSelector('#graph-container svg');

    const left = page.locator('#sidebar-left');
    const right = page.locator('#sidebar-right');
    const graphWidth = async () => (await page.locator('#graph-container').boundingBox())!.width;
    const before = await graphWidth();

    await page.locator('#fold-left').click();
    await expect(left).toHaveClass(/folded/);
    await expect(page.locator('#fold-left')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#sidebar-left-content')).toBeHidden();
    // The view gets the new size
    await expect.poll(async () => {
      const viewBox = await page.locator('#graph-container svg').first().getAttribute('viewBox');
      return Math.abs(Number(viewBox?.split(' ')[2]) - await graphWidth()) < 1;
    }).toBe(true);
    expect(await graphWidth()).toBeGreaterThan(before + 200);

    // A key in a text field types; outside one it toggles
    await page.locator('#search-input').focus();
    await page.keyboard.press(']');
    await expect(right).not.toHaveClass(/folded/);
    await page.locator('#search-input').blur();
    await page.keyboard.press(']');
    await expect(right).toHaveClass(/folded/);

    await page.reload();
    await expect(left).toHaveClass(/folded/);
    await expect(right).toHaveClass(/folded/);

    // The strip opens the panel again
    await page.locator('#fold-left').click();
    await page.keyboard.press(']');
    await expect(left).not.toHaveClass(/folded/);
    await expect(right).not.toHaveClass(/folded/);
    await expect(page.locator('#sidebar-left-content')).toBeVisible();
  });
});
