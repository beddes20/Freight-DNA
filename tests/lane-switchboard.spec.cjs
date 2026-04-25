/**
 * E2E test for the Global Lane Switchboard (Task #652).
 *
 * Verifies:
 *   - The `?` (Shift+/) shortcut opens the palette from any page.
 *   - The `/` shortcut still focuses global search and does NOT open
 *     the switchboard (no shortcut collision).
 *   - Typing a lane signature shows the parsed-lane hint.
 *   - The endpoint is hit and the three columns render.
 *   - Esc closes the palette.
 *
 * Run: npx playwright test --config=playwright.config.cjs tests/lane-switchboard.spec.cjs
 */

const { test, expect } = require('@playwright/test');

test.describe('Global Lane Switchboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for app shell — global search input is in the top header.
    await page.waitForSelector("[data-testid='input-global-search']", { timeout: 15000 });
    // Give React effects (the keyboard-shortcut listener) time to attach.
    await page.waitForTimeout(500);
  });

  // Helper — fire the `?` key on document directly so we don't depend on
  // Playwright's interpretation of Shift+/. This still drives the
  // production handler since `useGlobalKeyboardShortcuts` listens on
  // `document`'s "keydown" event.
  async function pressQuestion(page) {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: '?',
        code: 'Slash',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
  }
  async function pressSlash(page) {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: '/',
        code: 'Slash',
        bubbles: true,
        cancelable: true,
      }));
    });
  }

  test('? opens the switchboard, / focuses global search (no collision)', async ({ page }) => {
    // First confirm the dialog is closed.
    await expect(page.locator("[data-testid='dialog-lane-switchboard']")).toHaveCount(0);

    // Press `/` — should focus global search, NOT open switchboard.
    await pressSlash(page);
    await page.waitForTimeout(200);
    await expect(page.locator("[data-testid='dialog-lane-switchboard']")).toHaveCount(0);
    await expect(page.locator("[data-testid='input-global-search']")).toBeFocused();

    // Blur global search so the next keystroke isn't typed into it.
    await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
    await page.waitForTimeout(100);

    // Press `?` (Shift+/) — should open the switchboard.
    await pressQuestion(page);
    await page.waitForSelector("[data-testid='dialog-lane-switchboard']", { timeout: 5000 });
    await expect(page.locator("[data-testid='input-lane-switchboard']")).toBeFocused();

    // Esc closes it.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(page.locator("[data-testid='dialog-lane-switchboard']")).toHaveCount(0);
  });

  test('typing a lane parses and renders the three columns', async ({ page }) => {
    await pressQuestion(page);
    await page.waitForSelector("[data-testid='dialog-lane-switchboard']", { timeout: 5000 });

    // Wait for the network call when we type a parseable lane.
    const respPromise = page.waitForResponse(
      (resp) => resp.url().includes('/api/lane-switchboard') && resp.status() === 200,
      { timeout: 10000 },
    );

    await page.locator("[data-testid='input-lane-switchboard']").fill('ATL → DAL');

    const resp = await respPromise;
    const body = await resp.json();
    expect(body.parsed.originCity.toLowerCase()).toBe('atlanta');
    expect(body.parsed.destCity.toLowerCase()).toBe('dallas');

    // Parsed-lane hint should be shown.
    await expect(page.locator("[data-testid='text-switchboard-parsed']")).toBeVisible();

    // All three column containers should render.
    await expect(page.locator("[data-testid='column-switchboard-recurring']")).toBeVisible();
    await expect(page.locator("[data-testid='column-switchboard-live']")).toBeVisible();
    await expect(page.locator("[data-testid='column-switchboard-historical']")).toBeVisible();
  });
});
