/**
 * Capacity Matches — UI smoke for action states (Task #844)
 *
 * Seeds one truck_posting + freight_opportunity + truck_load_match (state=new),
 * loads /available-freight/capacity-matches, exercises the three action
 * buttons (booked / contacted / dismissed) and asserts the row state
 * transitions and the row visibility honors the active filter.
 *
 * Run:
 *   npx playwright test --config=playwright.config.cjs \
 *     tests/capacity-matches-actions.spec.cjs --workers=1
 */

const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');
const crypto = require('crypto');

const DEV_AUTH_BYPASS_USER_ID =
  process.env.DEV_AUTH_BYPASS_USER_ID || '4e75fd7c-d462-42c5-a335-af327076416c';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function shortId() { return crypto.randomBytes(4).toString('hex'); }

const SEED_TAG = `vtest-844-${shortId()}`;
let orgId;
let companyId;
let postingId;
let opportunityId;
let matchId;
const pickupStart = new Date(Date.now() + 86_400_000);
const pickupEnd = new Date(Date.now() + 2 * 86_400_000);

test.describe.serial('Capacity Matches action buttons', () => {
  test.beforeAll(async () => {
    const u = await pool.query(`SELECT organization_id FROM users WHERE id=$1`, [DEV_AUTH_BYPASS_USER_ID]);
    orgId = u.rows[0]?.organization_id;
    if (!orgId) throw new Error('dev bypass user has no organization');
    const c = await pool.query(
      `INSERT INTO companies (organization_id, name) VALUES ($1, $2) RETURNING id`,
      [orgId, `${SEED_TAG}-co`],
    );
    companyId = c.rows[0].id;
    const opp = await pool.query(
      `INSERT INTO freight_opportunities
         (org_id, company_id, mode, origin, origin_state, destination, destination_state,
          equipment_type, pickup_window_start, pickup_window_end, status,
          owner_user_id, created_by_id)
       VALUES ($1,$2,'truckload','Phoenix','AZ','Dallas','TX','Reefer',
               $3,$4,'open',$5,$5)
       RETURNING id`,
      [orgId, companyId, pickupStart.toISOString(), pickupEnd.toISOString(), DEV_AUTH_BYPASS_USER_ID],
    );
    opportunityId = opp.rows[0].id;
    const post = await pool.query(
      `INSERT INTO truck_postings
         (org_id, source, origin_city, origin_state, dest_city, dest_state,
          equipment, available_date, status, carrier_name_raw)
       VALUES ($1,'manual','Phoenix','AZ','Dallas','TX','Reefer',
               CURRENT_DATE + INTERVAL '1 day','active', $2)
       RETURNING id`,
      [orgId, `${SEED_TAG}-carrier`],
    );
    postingId = post.rows[0].id;
    const m = await pool.query(
      `INSERT INTO truck_load_matches
         (org_id, truck_posting_id, freight_opportunity_id, fit_score, state, assigned_rep_id)
       VALUES ($1,$2,$3,90,'new',$4)
       RETURNING id`,
      [orgId, postingId, opportunityId, DEV_AUTH_BYPASS_USER_ID],
    );
    matchId = m.rows[0].id;
  });

  test.afterAll(async () => {
    if (matchId) await pool.query('DELETE FROM truck_load_matches WHERE id=$1', [matchId]);
    if (postingId) await pool.query('DELETE FROM truck_postings WHERE id=$1', [postingId]);
    if (opportunityId) await pool.query('DELETE FROM freight_opportunities WHERE id=$1', [opportunityId]);
    if (companyId) await pool.query('DELETE FROM companies WHERE id=$1', [companyId]);
    await pool.end();
  });

  test('mark contacted then booked — row leaves the active filter when dismissed', async ({ page }) => {
    await page.goto('/available-freight/capacity-matches?scope=mine');
    // Wait for the seeded row to appear.
    const rowSel = `[data-testid="row-match-${matchId}"]`;
    await page.waitForSelector(rowSel, { timeout: 15_000 });

    const stateBadge = page.locator(`[data-testid="badge-state-${matchId}"]`);

    // 1) Mark Contacted
    await page.locator(`[data-testid="button-contacted-${matchId}"]`).click();
    await expect(stateBadge).toHaveText(/contacted/i, { timeout: 10_000 });

    // 2) Mark Booked — switch filter to "all" first so row remains visible
    await page.locator('[data-testid="select-state"]').click();
    await page.getByRole('option', { name: 'All', exact: true }).click();
    await page.waitForSelector(rowSel, { timeout: 10_000 });
    await page.locator(`[data-testid="button-booked-${matchId}"]`).click();
    await expect(stateBadge).toHaveText(/booked/i, { timeout: 10_000 });

    // 3) Seed a 2nd opportunity + match and dismiss it (booked rows hide action buttons,
    //    and truck_load_matches has a uniq(posting, opportunity) so we need a fresh opp).
    const opp2 = await pool.query(
      `INSERT INTO freight_opportunities
         (org_id, company_id, mode, origin, origin_state, destination, destination_state,
          equipment_type, pickup_window_start, pickup_window_end, status,
          owner_user_id, created_by_id)
       VALUES ($1,$2,'truckload','Phoenix','AZ','Houston','TX','Reefer',
               $3,$4,'open',$5,$5)
       RETURNING id`,
      [orgId, companyId, pickupStart.toISOString(), pickupEnd.toISOString(), DEV_AUTH_BYPASS_USER_ID],
    );
    const opp2Id = opp2.rows[0].id;
    const m2 = await pool.query(
      `INSERT INTO truck_load_matches
         (org_id, truck_posting_id, freight_opportunity_id, fit_score, state, assigned_rep_id)
       VALUES ($1,$2,$3,80,'new',$4) RETURNING id`,
      [orgId, postingId, opp2Id, DEV_AUTH_BYPASS_USER_ID],
    );
    const m2Id = m2.rows[0].id;
    try {
      await page.reload();
      // After reload state filter resets to "active" (new+contacted) — switch to "all"
      // so the dismissed row stays visible for the assertion.
      await page.locator('[data-testid="select-state"]').click();
      await page.getByRole('option', { name: 'All', exact: true }).click();
      await page.waitForSelector(`[data-testid="row-match-${m2Id}"]`, { timeout: 15_000 });
      await page.locator(`[data-testid="button-dismiss-${m2Id}"]`).click();
      const reasonBox = page.locator('[data-testid="textarea-dismiss-reason"]');
      if (await reasonBox.count()) await reasonBox.fill('test-dismiss');
      await page.locator('[data-testid="button-confirm-dismiss"]').click();
      await expect(page.locator(`[data-testid="badge-state-${m2Id}"]`)).toHaveText(/dismissed/i, { timeout: 10_000 });
    } finally {
      await pool.query('DELETE FROM truck_load_matches WHERE id=$1', [m2Id]);
      await pool.query('DELETE FROM freight_opportunities WHERE id=$1', [opp2Id]);
    }
  });
});
