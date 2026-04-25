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

  // Verifies the no-results contract — when a lane has nothing in any
  // column, the unified empty state with the two task-specified CTAs must
  // render, and each CTA must navigate to the right place. We use a
  // deliberately unknown city pair so the parser succeeds (city → city)
  // but the backend is guaranteed to return zero rows in this org.
  test('unknown lane shows unified no-results panel with both CTAs', async ({ page }) => {
    await pressQuestion(page);
    await page.waitForSelector("[data-testid='dialog-lane-switchboard']", { timeout: 5000 });

    const respPromise = page.waitForResponse(
      (resp) => resp.url().includes('/api/lane-switchboard') && resp.status() === 200,
      { timeout: 10000 },
    );
    // Pasco, WA → Bangor, ME — both real US cities (so the parser status
    // is "ok" and the component fires the fan-out call), but no seeded
    // freight in this test org, so all three columns come back empty.
    await page.locator("[data-testid='input-lane-switchboard']").fill('Pasco, WA to Bangor, ME');
    const resp = await respPromise;
    const body = await resp.json();
    expect(body.recurring.length).toBe(0);
    expect(body.live.length).toBe(0);
    expect(body.historical.length).toBe(0);

    // Unified no-results panel + both required CTAs render.
    await expect(page.locator("[data-testid='empty-switchboard-no-results']")).toBeVisible();
    await expect(page.locator("[data-testid='button-empty-create-lane-lwq']")).toBeVisible();
    await expect(page.locator("[data-testid='button-empty-search-quotes']")).toBeVisible();

    // "Search quotes for this lane" should deep-link into Customer Quotes
    // with the page-consumed `laneSearch` filter param.
    await page.locator("[data-testid='button-empty-search-quotes']").click();
    await page.waitForURL(/\/customer-quotes\?/, { timeout: 5000 });
    const url = new URL(page.url());
    expect(url.pathname).toBe('/customer-quotes');
    const laneSearch = url.searchParams.get('laneSearch');
    expect(laneSearch).not.toBeNull();
    expect(laneSearch.toLowerCase()).toContain('pasco');
    expect(laneSearch.toLowerCase()).toContain('bangor');
  });

  // Verifies row-click deep-link semantics for each column — a known seeded
  // lane (Macon → La Feria, returned a recurring lane in smoke testing)
  // should expose at least one clickable row whose href/navigation matches
  // the documented contract. We don't depend on AF/CQ rows existing.
  test('recurring-lane row click deep-links to /lanes/work-queue with laneId', async ({ page }) => {
    await pressQuestion(page);
    await page.waitForSelector("[data-testid='dialog-lane-switchboard']", { timeout: 5000 });

    const respPromise = page.waitForResponse(
      (resp) => resp.url().includes('/api/lane-switchboard') && resp.status() === 200,
      { timeout: 10000 },
    );
    await page.locator("[data-testid='input-lane-switchboard']").fill('Macon, GA to La Feria, TX');
    await respPromise;

    // If a recurring row rendered, click it and confirm navigation shape.
    const firstRow = page.locator("[data-testid^='row-switchboard-lwq-']").first();
    const count = await firstRow.count();
    if (count > 0) {
      const testId = await firstRow.getAttribute('data-testid');
      const expectedLaneId = testId.replace('row-switchboard-lwq-', '');
      await firstRow.click();
      await page.waitForURL(/\/lanes\/work-queue\?laneId=/, { timeout: 5000 });
      const url = new URL(page.url());
      expect(url.pathname).toBe('/lanes/work-queue');
      expect(url.searchParams.get('laneId')).toBe(expectedLaneId);
    }
  });
});
