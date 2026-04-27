/**
 * Browser-driven AI Engagement persistence test for non-NBA surfaces (Task #700).
 *
 * Companion to `ai-engagement-nba-persistence.spec.cjs`. Walks two
 * additional AI surfaces and verifies that their telemetry events
 * persist to the `ai_engagement_events` table:
 *
 *   1. `daily_priorities` — visiting `/daily-priorities` should emit
 *      a single `impression` event for the surface.
 *   2. `valueiq` — visiting `/valueiq` and switching tabs should emit
 *      both an `impression` (mount) and a `click` (tab switch) event
 *      for the surface.
 *
 * This proves the telemetry pipeline is uniform across surfaces and
 * not NBA-specific.
 *
 * Run (requires the dev server on :5000 + Playwright + DATABASE_URL):
 *   npx playwright test --config=playwright.config.cjs \
 *     tests/ai-engagement-multi-surface-persistence.spec.cjs
 */

const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');

const DEV_AUTH_BYPASS_USER_ID =
  process.env.DEV_AUTH_BYPASS_USER_ID || '4e75fd7c-d462-42c5-a335-af327076416c';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5000';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function countRows(userId, surface, eventType) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ai_engagement_events
       WHERE user_id = $1 AND surface = $2 AND event_type = $3`,
    [userId, surface, eventType],
  );
  return r.rows[0]?.n ?? 0;
}

async function pollFor(predicate, attempts = 12, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return false;
}

test.describe('AI Engagement — non-NBA surfaces persist telemetry (Task #700)', () => {
  test.setTimeout(120_000);

  test.afterAll(async () => {
    await pool.end();
  });

  test('Daily Priorities impression + ValueIQ impression+click land in DB', async ({ page }) => {
    const u = await pool.query(`SELECT id FROM users WHERE id = $1`, [DEV_AUTH_BYPASS_USER_ID]);
    if (!u.rows.length) {
      throw new Error(`Dev bypass user ${DEV_AUTH_BYPASS_USER_ID} not found in DB`);
    }

    // ── Daily Priorities ──────────────────────────────────────────────────────
    const beforeDpImpr = await countRows(DEV_AUTH_BYPASS_USER_ID, 'daily_priorities', 'impression');
    await page.goto(`${BASE_URL}/daily-priorities`);
    // Wait for the page to render so the impression useEffect fires.
    await page.waitForSelector('[data-testid^="nba-card-"], [data-testid="empty-daily-priorities"]', {
      timeout: 25_000,
    }).catch(() => {});
    // Even if no card data exists, the impression useEffect runs on mount.
    // Hold for the batched flush window.
    await page.waitForTimeout(7_000);

    const dpOk = await pollFor(async () => {
      const after = await countRows(DEV_AUTH_BYPASS_USER_ID, 'daily_priorities', 'impression');
      return after > beforeDpImpr;
    });
    expect(dpOk, 'expected daily_priorities impression event to land in DB').toBeTruthy();

    // ── ValueIQ — impression on mount + click on tab change ──────────────────
    const beforeViqImpr = await countRows(DEV_AUTH_BYPASS_USER_ID, 'valueiq', 'impression');
    const beforeViqClick = await countRows(DEV_AUTH_BYPASS_USER_ID, 'valueiq', 'click');

    await page.goto(`${BASE_URL}/valueiq`);
    // Wait for either of the known ValueIQ tabs to mount so the
    // impression useEffect has a chance to fire.
    await page
      .waitForSelector('[data-testid="tab-insights"], [data-testid="tab-threads"], [data-testid="tab-library"]', {
        timeout: 25_000,
      })
      .catch(() => {});

    // Trigger a tab change to fire the click event.
    const threadsTab = page.locator('[data-testid="tab-threads"]');
    if (await threadsTab.count()) {
      await threadsTab.click().catch(() => {});
    }

    // Hold for the batched flush window.
    await page.waitForTimeout(7_000);

    const viqOk = await pollFor(async () => {
      const afterImpr = await countRows(DEV_AUTH_BYPASS_USER_ID, 'valueiq', 'impression');
      const afterClick = await countRows(DEV_AUTH_BYPASS_USER_ID, 'valueiq', 'click');
      return afterImpr > beforeViqImpr && afterClick > beforeViqClick;
    });
    expect(viqOk, 'expected valueiq impression + click events to land in DB').toBeTruthy();
  });
});
