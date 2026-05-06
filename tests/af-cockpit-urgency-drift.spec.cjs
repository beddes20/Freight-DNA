/**
 * Task #971 (rework #4) — Acceptance test for the AF cockpit urgency
 * drift recompute. Verifies that advancing the simulated clock past an
 * urgency tier boundary (high → critical at pickup ≤12h) updates the
 * badge in place WITHOUT a server refetch and that the row reorders to
 * the top when the rep has the urgency sort selected.
 *
 * Uses Playwright's clock API (`page.clock.install` + `clock.runFor`)
 * so the in-page `setInterval(60_000)` actually fires after fast-forward.
 *
 * Run:
 *   npx playwright test --config=playwright.config.cjs \
 *     tests/af-cockpit-urgency-drift.spec.cjs --workers=1
 */

const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');
const crypto = require('crypto');

const DEV_AUTH_BYPASS_USER_ID =
  process.env.DEV_AUTH_BYPASS_USER_ID || '4e75fd7c-d462-42c5-a335-af327076416c';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
function shortId() { return crypto.randomBytes(4).toString('hex'); }
const SEED_TAG = `vtest-af971-drift-${shortId()}`;

let orgId;
let companyId;
const seededOppIds = [];

// Pin "now" so the seed pickup window is deterministic regardless of
// machine clock, and so the cockpit page sees a consistent time once
// `page.clock.install` is called.
const FIXED_NOW_MS = Date.UTC(2026, 4, 4, 12, 0, 0); // 2026-05-04T12:00:00Z

async function insertOpp(label, pickupOffsetHours) {
  const pickup = new Date(FIXED_NOW_MS + pickupOffsetHours * 60 * 60 * 1000).toISOString();
  // urgency_score must match what the server-side cockpit handler will
  // recompute; the route recomputes from scratch so any plausible seed
  // works — we just want the row to render with a recognizable id.
  const r = await pool.query(
    `INSERT INTO freight_opportunities
       (org_id, company_id, mode, origin, origin_state, destination, destination_state,
        equipment_type, pickup_window_start, pickup_window_end, status, urgency_score,
        owner_user_id, notes)
     VALUES ($1, $2, 'exact_load', 'Chicago', 'IL', 'Atlanta', 'GA',
             'DRY', $3, $3, 'ready_to_send', 60, $4, $5)
     RETURNING id`,
    [orgId, companyId, pickup, DEV_AUTH_BYPASS_USER_ID, `${SEED_TAG}-${label}`],
  );
  seededOppIds.push(r.rows[0].id);
  return r.rows[0].id;
}

test.describe('Task #971 — AF urgency drift updates without refetch', () => {
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    const u = await pool.query(
      `SELECT organization_id FROM users WHERE id = $1`,
      [DEV_AUTH_BYPASS_USER_ID],
    );
    if (!u.rows.length) {
      throw new Error(`Dev bypass user ${DEV_AUTH_BYPASS_USER_ID} not found`);
    }
    orgId = u.rows[0].organization_id;
    const co = await pool.query(
      `INSERT INTO companies (id, organization_id, name)
         VALUES (gen_random_uuid(), $1, $2)
         RETURNING id`,
      [orgId, `${SEED_TAG} Co`],
    );
    companyId = co.rows[0].id;
  });

  test.afterAll(async () => {
    try {
      if (seededOppIds.length) {
        await pool.query(
          `DELETE FROM freight_opportunities WHERE id = ANY($1::varchar[])`,
          [seededOppIds],
        );
      }
      if (companyId) {
        await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
      }
    } catch (e) {
      console.warn('[af971-drift] cleanup failed', e?.message);
    } finally {
      await pool.end();
    }
  });

  test('60s tick recomputes urgency in place and reorders under sort=urgency', async ({ page }) => {
    // Pickup 12h45m out at FIXED_NOW (just outside the ≤12h critical band).
    // After we fast-forward 60 minutes, pickup is 11h45m out → critical.
    const driftId = await insertOpp('drift', 12.75);
    // A clearly-stale-high row that will NOT cross the boundary, so it
    // remains below the drifted row once the latter escalates.
    const stableId = await insertOpp('stable', 30);

    // Pin the in-page clock BEFORE navigation so React/setInterval/Date
    // all observe the simulated time.
    await page.clock.install({ time: new Date(FIXED_NOW_MS) });

    // Track how many cockpit refetches the page issues during the
    // drift window. The acceptance contract says the urgency badge
    // updates WITHOUT a server fetch.
    let cockpitFetchCount = 0;
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/api/freight-opportunities/cockpit')) {
        cockpitFetchCount += 1;
      }
    });

    await page.goto('/available-freight?sort=urgency');

    const driftBadge = page.getByTestId(`badge-urgency-${driftId}`);
    await expect(driftBadge).toBeVisible({ timeout: 20_000 });

    // Initial state: drift row should be "high" (12h45m > 12h band).
    const initialText = (await driftBadge.textContent()) ?? '';
    expect(initialText.toLowerCase()).toContain('high');
    expect(initialText.toLowerCase()).not.toContain('critical');
    await expect(driftBadge).toHaveAttribute('data-urgency-drifted', 'false');

    // Snapshot the cockpit-fetch counter BEFORE we advance time. We
    // assert the counter doesn't move during the drift window.
    const fetchesBeforeAdvance = cockpitFetchCount;

    // Advance simulated time past the 60s setInterval tick so the
    // urgency drift recompute fires. 70 minutes is well past a single
    // tick AND moves pickup from 12h45m → 11h35m (well inside ≤12h).
    await page.clock.runFor(70 * 60 * 1000);

    // Badge must escalate to "critical" without any cockpit refetch.
    await expect(driftBadge).toHaveAttribute('data-urgency-drifted', 'true', { timeout: 5_000 });
    const driftedText = (await driftBadge.textContent()) ?? '';
    expect(driftedText.toLowerCase()).toContain('critical');

    expect(
      cockpitFetchCount,
      `expected zero cockpit refetches during drift window; saw ${cockpitFetchCount - fetchesBeforeAdvance} new`,
    ).toBe(fetchesBeforeAdvance);

    // Under sort=urgency the drift row must out-rank the stale-high row
    // after recompute. Compare DOM row order.
    const allRows = await page.locator('[data-testid^="row-opportunity-"]').evaluateAll(
      (els) => els.map((el) => el.getAttribute('data-testid')),
    );
    const driftIdx = allRows.indexOf(`row-opportunity-${driftId}`);
    const stableIdx = allRows.indexOf(`row-opportunity-${stableId}`);
    expect(driftIdx, 'drift row must be visible after recompute').toBeGreaterThanOrEqual(0);
    expect(stableIdx, 'stable-high row must be visible after recompute').toBeGreaterThanOrEqual(0);
    expect(
      driftIdx,
      `escalated row (idx=${driftIdx}) must come before stable-high row (idx=${stableIdx}) under sort=urgency`,
    ).toBeLessThan(stableIdx);
  });
});
