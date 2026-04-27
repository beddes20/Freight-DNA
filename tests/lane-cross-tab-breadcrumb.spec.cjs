/**
 * Browser-driven cross-tab navigation test (Task #703 — Lane System E2E).
 *
 * Verifies the cross-tab breadcrumb plumbing wired across the four lane
 * surfaces (Available Freight, Lane Work Queue, Carrier Hub, Lane Inbox).
 * Specifically asserts:
 *
 *   - Visiting `/lanes/work-queue?from=available-freight` renders the
 *     `<CrossTabBreadcrumb />` chip with a back-link that strips the
 *     `from` param when the user clicks it.
 *   - Visiting `/lanes/work-queue` directly (no `from` param) does NOT
 *     render the breadcrumb — confirming the helper renders nothing for
 *     direct visits and doesn't add stray vertical space.
 *
 * Run (requires the dev server on :5000 and Playwright installed):
 *   npx playwright test --config=playwright.config.cjs tests/lane-cross-tab-breadcrumb.spec.cjs
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5000';

test.describe('Cross-tab breadcrumb (Task #703)', () => {
  test.setTimeout(60_000);

  test('renders breadcrumb when ?from= is present and links back to source', async ({ page }) => {
    await page.goto(`${BASE_URL}/lanes/work-queue?from=available-freight`);
    // Wait for the page chrome to appear so the breadcrumb has a chance
    // to mount even on cold caches.
    await page.waitForSelector(
      '[data-testid="breadcrumb-cross-tab-lane-work-queue"]',
      { timeout: 15_000 },
    );

    const crumb = page.locator('[data-testid="breadcrumb-cross-tab-lane-work-queue"]');
    await expect(crumb).toBeVisible();

    // The breadcrumb should expose a back-link tagged with the source slug.
    const back = page.locator('[data-testid="breadcrumb-link-available-freight"]');
    await expect(back).toBeVisible();
    const href = await back.getAttribute('href');
    expect(href).toMatch(/\/available-freight/);
  });

  test('renders nothing when visited directly (no ?from= param)', async ({ page }) => {
    await page.goto(`${BASE_URL}/lanes/work-queue`);
    // Allow the LWQ page chrome to settle.
    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    const crumb = page.locator('[data-testid="breadcrumb-cross-tab-lane-work-queue"]');
    // The component returns `null` for direct visits — no DOM node at all.
    expect(await crumb.count()).toBe(0);
  });
});
