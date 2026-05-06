/**
 * Browser-driven AI Engagement persistence test (Task #700).
 *
 * Verifies that NBA card impressions and clicks emitted by the client
 * telemetry helper actually land in the `ai_engagement_events` table,
 * tagged to the right org/user/surface/eventType.
 *
 * Steps:
 *   1. Snapshot pre-existing telemetry rows for the dev-bypass user.
 *   2. Visit `/daily-priorities`, wait for at least one NBA card to render.
 *   3. Click the company link on the first card so the NBA card emits
 *      both an `impression` (mount) and a `click` (interaction) event.
 *   4. Wait for the client batch flush window (~6s) so events POST to
 *      `/api/ai-engagement/events`.
 *   5. Read `ai_engagement_events` again and assert at least one new row
 *      with surface = 'nba_card' for both 'impression' and 'click'.
 *
 * Run (requires the dev server on :5000 + Playwright + DATABASE_URL):
 *   npx playwright test --config=playwright.config.cjs tests/ai-engagement-nba-persistence.spec.cjs
 */

const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');

const DEV_AUTH_BYPASS_USER_ID =
  process.env.DEV_AUTH_BYPASS_USER_ID || '4e75fd7c-d462-42c5-a335-af327076416c';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5000';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function countRows(userId, eventType) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ai_engagement_events
       WHERE user_id = $1 AND surface = 'nba_card' AND event_type = $2`,
    [userId, eventType],
  );
  return r.rows[0]?.n ?? 0;
}

test.describe('AI Engagement — NBA telemetry lands in DB (Task #700)', () => {
  test.setTimeout(90_000);

  test.afterAll(async () => {
    await pool.end();
  });

  test('NBA impression + click events persist to ai_engagement_events', async ({ page }) => {
    // Sanity: bypass user must exist
    const u = await pool.query(`SELECT id FROM users WHERE id = $1`, [DEV_AUTH_BYPASS_USER_ID]);
    if (!u.rows.length) {
      throw new Error(`Dev bypass user ${DEV_AUTH_BYPASS_USER_ID} not found in DB`);
    }

    const beforeImpressions = await countRows(DEV_AUTH_BYPASS_USER_ID, 'impression');
    const beforeClicks = await countRows(DEV_AUTH_BYPASS_USER_ID, 'click');

    await page.goto(`${BASE_URL}/daily-priorities`);

    // Wait for at least one NBA card to render. NbaCard exposes
    // data-testid="nba-card-{id}" for every rendered card.
    const firstCard = page.locator('[data-testid^="nba-card-"]').first();
    await firstCard.waitFor({ state: 'visible', timeout: 25_000 });

    // Click the company link inside the card to trigger an explicit
    // 'click' telemetry event (NbaCard wires recordAiEvent to the link).
    const companyLink = firstCard.locator('[data-testid^="nba-card-company-link-"]').first();
    if (await companyLink.count()) {
      // Hold Cmd/Ctrl so the link is "clicked" but the page doesn't navigate
      // away — we still want to read ai_engagement_events on the same page.
      await companyLink.click({ modifiers: ['Meta'] }).catch(() => companyLink.click({ modifiers: ['Control'] }));
    } else {
      // If the deep-link variant isn't present, fall back to a generic
      // click on the card body which still emits the 'click' event.
      await firstCard.click();
    }

    // Wait long enough for the batched telemetry to flush (FLUSH_INTERVAL_MS
    // is 5_000ms in client/src/lib/aiTelemetry.ts; add a buffer).
    await page.waitForTimeout(7_000);

    // Poll the DB for up to 10s in case the request is mid-flight.
    let afterImpressions = beforeImpressions;
    let afterClicks = beforeClicks;
    for (let i = 0; i < 10; i++) {
      afterImpressions = await countRows(DEV_AUTH_BYPASS_USER_ID, 'impression');
      afterClicks = await countRows(DEV_AUTH_BYPASS_USER_ID, 'click');
      if (afterImpressions > beforeImpressions && afterClicks > beforeClicks) break;
      await page.waitForTimeout(1_000);
    }

    expect(afterImpressions).toBeGreaterThan(beforeImpressions);
    expect(afterClicks).toBeGreaterThan(beforeClicks);
  });
});
