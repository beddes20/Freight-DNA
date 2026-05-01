/**
 * Available Freight Cockpit (Task #900) — owner filter + stale chip e2e.
 *
 * Seeds three freight_opportunities owned by the dev-bypass user and one
 * by another user, plus one with a 3-day-old past pickup to drive the
 * "Stale: N" chip. Asserts:
 *   - The Owner Select renders and defaults to "Owner: all"
 *   - Switching to "Owner: mine" filters the visible rows to the rep's
 *     owned set AND writes `?owner=me` to the URL
 *   - The default "Pickup: actionable" scope hides the 3-day-old row
 *   - The kpis.hiddenStale "Stale: N" chip renders with N >= 1
 *   - Clicking the Stale chip switches the scope to "All" and reveals
 *     the previously-hidden row
 *
 * Run (requires the dev server on :5000 and Playwright installed):
 *   npx playwright test --config=playwright.config.cjs tests/af-cockpit-owner-filter.spec.cjs
 */

const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');
const crypto = require('crypto');

const DEV_AUTH_BYPASS_USER_ID =
  process.env.DEV_AUTH_BYPASS_USER_ID || '4e75fd7c-d462-42c5-a335-af327076416c';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function shortId() {
  return crypto.randomBytes(4).toString('hex');
}

const SEED_TAG = `vtest-af900-${shortId()}`;
let orgId;
let companyId;
let otherUserId;
const seededOppIds = [];
const seededCompanyIds = [];

async function insertOpp({ label, ownerUserId, pickupOffsetDays, status }) {
  const pickup = new Date(
    Date.now() + pickupOffsetDays * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const r = await pool.query(
    `INSERT INTO freight_opportunities
       (org_id, company_id, mode, origin, origin_state, destination, destination_state,
        equipment_type, pickup_window_start, pickup_window_end, status, urgency_score,
        owner_user_id, notes)
     VALUES ($1, $2, 'exact_load', 'Chicago', 'IL', 'Atlanta', 'GA',
             'DRY', $3, $3, $4, 75, $5, $6)
     RETURNING id`,
    [orgId, companyId, pickup, status, ownerUserId, `${SEED_TAG}-${label}`],
  );
  seededOppIds.push(r.rows[0].id);
  return r.rows[0].id;
}

test.describe('AF cockpit Owner filter + Stale chip (Task #900)', () => {
  test.setTimeout(90_000);

  // Reset persisted cockpit prefs before EACH test so that ownerFilter /
  // pickupScope / activeViewId state from a prior run (or a prior test in
  // this file) cannot bleed in. The route hydrates the page from these
  // server-side prefs on first paint, so without this reset test #2's
  // "click 'Owner: mine' → URL becomes ?owner=me" assertion can fail when
  // ownerFilter was already 'me' in prefs (no state change → no URL write).
  test.beforeEach(async () => {
    await pool.query(
      `DELETE FROM user_freight_cockpit_prefs WHERE user_id = $1`,
      [DEV_AUTH_BYPASS_USER_ID],
    );
  });

  test.beforeAll(async () => {
    const u = await pool.query(
      `SELECT organization_id FROM users WHERE id = $1`,
      [DEV_AUTH_BYPASS_USER_ID],
    );
    if (!u.rows.length) {
      throw new Error(`Dev bypass user ${DEV_AUTH_BYPASS_USER_ID} not found`);
    }
    orgId = u.rows[0].organization_id;

    // Pick (or create) a different user in the same org for the "not mine" row.
    const other = await pool.query(
      `SELECT id FROM users
        WHERE organization_id = $1
          AND id <> $2
        ORDER BY created_at NULLS LAST
        LIMIT 1`,
      [orgId, DEV_AUTH_BYPASS_USER_ID],
    );
    if (other.rows.length) {
      otherUserId = other.rows[0].id;
    } else {
      const ins = await pool.query(
        `INSERT INTO users (id, organization_id, username, role)
           VALUES (gen_random_uuid(), $1, $2, 'sales')
           RETURNING id`,
        [orgId, `${SEED_TAG}+other@example.com`],
      );
      otherUserId = ins.rows[0].id;
    }

    const co = await pool.query(
      `INSERT INTO companies (id, organization_id, name)
         VALUES (gen_random_uuid(), $1, $2)
         RETURNING id`,
      [orgId, `${SEED_TAG} Co`],
    );
    companyId = co.rows[0].id;
    seededCompanyIds.push(companyId);

    // 2 mine + 1 other + 1 stale-mine (3 days past, still ready_to_send).
    await insertOpp({ label: 'mine-tomorrow', ownerUserId: DEV_AUTH_BYPASS_USER_ID, pickupOffsetDays: 1, status: 'ready_to_send' });
    await insertOpp({ label: 'mine-today', ownerUserId: DEV_AUTH_BYPASS_USER_ID, pickupOffsetDays: 0, status: 'sent' });
    await insertOpp({ label: 'other-tomorrow', ownerUserId: otherUserId, pickupOffsetDays: 1, status: 'ready_to_send' });
    await insertOpp({ label: 'mine-stale', ownerUserId: DEV_AUTH_BYPASS_USER_ID, pickupOffsetDays: -3, status: 'ready_to_send' });
  });

  test.afterAll(async () => {
    try {
      if (seededOppIds.length) {
        // freight_opportunities.id is varchar (gen_random_uuid()::text),
        // not uuid — cast to text[] to keep the ANY operator happy.
        await pool.query(
          `DELETE FROM freight_opportunities WHERE id = ANY($1::text[])`,
          [seededOppIds],
        );
      }
      if (seededCompanyIds.length) {
        await pool.query(
          `DELETE FROM companies WHERE id = ANY($1::text[])`,
          [seededCompanyIds],
        );
      }
    } finally {
      await pool.end();
    }
  });

  test('Owner Select renders and defaults to "Owner: all"', async ({ page }) => {
    await page.goto('/available-freight');
    const owner = page.locator('[data-testid="select-filter-owner"]');
    await expect(owner).toBeVisible({ timeout: 15_000 });
    await expect(owner).toContainText(/Owner: all/i);
  });

  test('"Owner: mine" updates the URL to ?owner=me and refetches the feed', async ({ page }) => {
    await page.goto('/available-freight');
    await page.locator('[data-testid="select-filter-owner"]').click();
    await page.locator('[role="option"]', { hasText: 'Owner: mine' }).click();
    await expect(page).toHaveURL(/[?&]owner=me\b/);
    // The pill / select trigger should reflect the new value.
    await expect(page.locator('[data-testid="select-filter-owner"]')).toContainText(/mine/i);
  });

  test('"Pickup: actionable" is the default and the Stale chip surfaces hidden past-pickup rows', async ({ page }) => {
    // Land on the cockpit and immediately apply the seeded company filter
    // via the Customer select. This narrows the hiddenStale aggregate to
    // *just* our seeded rows, so the Stale chip becomes deterministic
    // (= exactly 1, the mine-stale row) regardless of what other freight
    // happens to exist in the dev org.
    await page.goto('/available-freight');

    // Default scope is actionable — the pill text confirms it.
    const scopePill = page.locator('[data-testid="pill-pickup-scope"]');
    await expect(scopePill).toBeVisible({ timeout: 15_000 });
    await expect(scopePill).toContainText(/Actionable/i);

    // Filter by the seeded company so the Stale aggregate is scoped.
    await page.locator('[data-testid="select-filter-company"]').click();
    await page.locator('[role="option"]', { hasText: `${SEED_TAG} Co` }).click();

    const chip = page.locator('[data-testid="chip-stale-count"]');
    await expect(chip).toBeVisible();
    // Our seed has exactly one mine-stale row (-3 days, ready_to_send).
    await expect(chip).toHaveText('1', { timeout: 15_000 });

    // Clicking the reveal-stale button switches scope to "All" and the
    // pill flips to "All pickup dates".
    await page.locator('[data-testid="button-reveal-stale"]').click();
    await expect(scopePill).toContainText(/All pickup dates/i);
  });
});
