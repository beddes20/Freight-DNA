/**
 * Task #968 — Rep filter persistence (Playwright).
 *
 * The Conversations page persists the Rep filter per-user in two
 * places: the URL (?rep=…) for shareable/back-button friendliness, and
 * localStorage under `conversations:repFilter:<userId>` so the choice
 * survives a hard reload that loses the URL (e.g. clicking the sidebar
 * link). This spec exercises both seams against the running dev server.
 *
 * Run with:
 *   npx playwright test --config=playwright.config.cjs tests/conversations-task968-rep-filter.spec.cjs
 */

const { test, expect } = require('@playwright/test');

const DEV_USER = process.env.DEV_AUTH_BYPASS_USER_ID || '4e75fd7c-d462-42c5-a335-af327076416c';
const STORAGE_KEY = `conversations:repFilter:${DEV_USER}`;

test.describe('Task #968 — Conversations rep filter persistence', () => {
  test('URL ?rep=… seeds the filter and is mirrored to localStorage', async ({ page }) => {
    // Pre-clear the storage seam so the URL is unambiguously the source.
    await page.goto('/conversations');
    await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY);

    await page.goto('/conversations?rep=' + encodeURIComponent(DEV_USER));

    // The URL-driven init must write through to localStorage so a later
    // visit without ?rep= still respects the choice.
    await expect.poll(
      async () => page.evaluate((k) => window.localStorage.getItem(k), STORAGE_KEY),
      { timeout: 5000 },
    ).toBe(DEV_USER);
  });

  test('localStorage seed survives a navigation that loses the URL param', async ({ page }) => {
    await page.goto('/conversations');
    await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
      key: STORAGE_KEY, value: DEV_USER,
    });

    // Navigate away and back without ?rep= in the URL.
    await page.goto('/');
    await page.goto('/conversations');

    // Once user.id has hydrated, the page re-reads the persisted value
    // and re-applies it to the URL — fences the late-arriving useEffect
    // re-hydrate added in this task.
    await expect.poll(
      async () => new URL(page.url()).searchParams.get('rep'),
      { timeout: 8000 },
    ).toBe(DEV_USER);
  });
});
