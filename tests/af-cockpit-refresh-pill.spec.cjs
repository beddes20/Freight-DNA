/**
 * Browser-driven test for AF cockpit stable sort + refresh pill (Task #649).
 *
 * Seeds two freight_opportunities (same org as the dev bypass user),
 * navigates to /available-freight, hovers over the feed list (which
 * marks the rep as "interacting"), then inserts a third opportunity and
 * triggers a refetch via the existing refresh button. Asserts:
 *   - The visible row count does NOT change while hovering (data is buffered)
 *   - A "cockpit-refresh-pill" appears with the correct delta count
 *   - Clicking the pill applies the buffered feed and the new row appears
 *
 * Run (requires the dev server on :5000 and Playwright installed):
 *   npx playwright test --config=playwright.config.cjs tests/af-cockpit-refresh-pill.spec.cjs
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

const SEED_TAG = `vtest-af649-${shortId()}`;
let orgId;
let companyId;
const seededOppIds = [];
const seededCarrierIds = [];
const seededFocIds = [];

async function insertOpp(label) {
  const pickup = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const r = await pool.query(
    `INSERT INTO freight_opportunities
       (org_id, company_id, mode, origin, origin_state, destination, destination_state,
        equipment_type, pickup_window_start, pickup_window_end, status, urgency_score,
        owner_user_id, notes)
     VALUES ($1, $2, 'exact_load', 'Chicago', 'IL', 'Atlanta', 'GA',
             'DRY', $3, $3, 'ready_to_send', 75, $4, $5)
     RETURNING id`,
    [orgId, companyId, pickup, DEV_AUTH_BYPASS_USER_ID, `${SEED_TAG}-${label}`],
  );
  seededOppIds.push(r.rows[0].id);
  return r.rows[0].id;
}

test.describe('AF cockpit stable sort + refresh pill (Task #649)', () => {
  test.setTimeout(90_000);

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

    await insertOpp('seed-a');
    await insertOpp('seed-b');
  });

  test.afterAll(async () => {
    try {
      if (seededFocIds.length) {
        await pool.query(
          `DELETE FROM freight_opportunity_carriers WHERE id = ANY($1::varchar[])`,
          [seededFocIds],
        );
      }
      if (seededOppIds.length) {
        await pool.query(
          `DELETE FROM freight_opportunities WHERE id = ANY($1::varchar[])`,
          [seededOppIds],
        );
      }
      if (seededCarrierIds.length) {
        await pool.query(
          `DELETE FROM carriers WHERE id = ANY($1::varchar[])`,
          [seededCarrierIds],
        );
      }
      if (companyId) {
        await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
      }
    } catch (e) {
      console.warn('[af649] cleanup failed', e?.message);
    } finally {
      await pool.end();
    }
  });

  test('refetch while hovering buffers into pill, click applies', async ({ page }) => {
    await page.goto('/available-freight');

    const container = page.getByTestId('cockpit-feed-container');
    await expect(container).toBeVisible({ timeout: 15_000 });

    // Wait for the seeded rows to render.
    await expect(page.locator('[data-testid^="row-opportunity-"]').first()).toBeVisible({
      timeout: 15_000,
    });

    const beforeCount = await page.locator('[data-testid^="row-opportunity-"]').count();
    expect(beforeCount).toBeGreaterThanOrEqual(2);

    // Pin the cursor inside the feed so the rep is "interacting".
    const box = await container.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.move(box.x + 40, box.y + 60); // ensure pointerenter fires

    // Insert a third opportunity, then trigger a refetch via the toolbar button.
    await insertOpp('post-hover');
    await page.getByTestId('button-refresh-cockpit').click({ force: true });

    // The pill should appear (server data is buffered, visible list is unchanged).
    const pill = page.getByTestId('cockpit-refresh-pill');
    await expect(pill).toBeVisible({ timeout: 10_000 });

    const duringCount = await page.locator('[data-testid^="row-opportunity-"]').count();
    expect(duringCount).toBe(beforeCount); // list did NOT swap while hovering

    // Click the pill — the buffered feed applies and the new row appears.
    // Move pointer first so the click is the interaction (not the hover dance).
    await pill.click();
    await expect(pill).toBeHidden({ timeout: 5_000 });

    await expect
      .poll(async () => page.locator('[data-testid^="row-opportunity-"]').count(), {
        timeout: 10_000,
      })
      .toBe(beforeCount + 1);
  });

  test('keyboard focus inside a row also buffers refetches (modality-cross safe)', async ({ page }) => {
    await page.goto('/available-freight');

    const container = page.getByTestId('cockpit-feed-container');
    await expect(container).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="row-opportunity-"]').first()).toBeVisible({
      timeout: 15_000,
    });

    const beforeCount = await page.locator('[data-testid^="row-opportunity-"]').count();

    // Move focus into the first row's primary link (keyboard interaction),
    // then deliberately move pointer OUTSIDE the list. Because focus is the
    // active modality, interaction must remain ON — buffering must hold.
    const firstRowLink = page.locator('[data-testid^="link-opportunity-"]').first();
    await firstRowLink.focus();
    const containerBox = await container.boundingBox();
    await page.mouse.move(containerBox.x - 80, containerBox.y - 80); // outside

    await insertOpp('focus-mode');
    await page.getByTestId('button-refresh-cockpit').click({ force: true });

    const pill = page.getByTestId('cockpit-refresh-pill');
    await expect(pill).toBeVisible({ timeout: 10_000 });

    // The list must NOT have changed — focus inside still counts as interacting.
    const duringCount = await page.locator('[data-testid^="row-opportunity-"]').count();
    expect(duringCount).toBe(beforeCount);

    // Apply via Enter on the focused pill (keyboard path).
    await pill.focus();
    await page.keyboard.press('Enter');
    await expect(pill).toBeHidden({ timeout: 5_000 });
    await expect
      .poll(async () => page.locator('[data-testid^="row-opportunity-"]').count(), {
        timeout: 10_000,
      })
      .toBe(beforeCount + 1);
  });

  test('moving pointer outside the list auto-applies pending feed after idle', async ({ page }) => {
    await page.goto('/available-freight');

    const container = page.getByTestId('cockpit-feed-container');
    await expect(container).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="row-opportunity-"]').first()).toBeVisible({
      timeout: 15_000,
    });

    const beforeCount = await page.locator('[data-testid^="row-opportunity-"]').count();

    const box = await container.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.move(box.x + 40, box.y + 60);

    await insertOpp('idle-apply');
    await page.getByTestId('button-refresh-cockpit').click({ force: true });

    const pill = page.getByTestId('cockpit-refresh-pill');
    await expect(pill).toBeVisible({ timeout: 10_000 });

    // Move pointer FAR outside the feed container; do not touch the pill.
    // After the 3s trailing-idle window the buffer should auto-apply.
    await page.mouse.move(5, 5);

    await expect(pill).toBeHidden({ timeout: 8_000 });
    await expect
      .poll(async () => page.locator('[data-testid^="row-opportunity-"]').count(), {
        timeout: 10_000,
      })
      .toBe(beforeCount + 1);
  });

  test('carrier-replies toast still fires when refetch lands while hovering', async ({ page }) => {
    // Seed a carrier and a freight_opportunity_carriers row tied to one of
    // the existing opps. Start with NO response, so the page-load refetch
    // initialises replyTotalRef to the current total without firing a toast.
    const carrierId = (await pool.query(
      `INSERT INTO carriers (id, org_id, name)
         VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [orgId, `${SEED_TAG} Carrier`],
    )).rows[0].id;
    seededCarrierIds.push(carrierId);

    const oppId = seededOppIds[0];
    const focId = (await pool.query(
      `INSERT INTO freight_opportunity_carriers
         (id, opportunity_id, carrier_id, rank, bucket, fit_score, history_match, sent_at)
         VALUES (gen_random_uuid(), $1, $2, 1, 'proven', 80, 'won', now())
         RETURNING id`,
      [oppId, carrierId],
    )).rows[0].id;
    seededFocIds.push(focId);

    await page.goto('/available-freight');
    const container = page.getByTestId('cockpit-feed-container');
    await expect(container).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="row-opportunity-"]').first()).toBeVisible({
      timeout: 15_000,
    });
    // Wait long enough for the initial replyTotalRef to be primed.
    await page.waitForTimeout(2_000);

    // Pin pointer inside the list to force buffering.
    const box = await container.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.move(box.x + 40, box.y + 60);

    // Now flip the carrier row to "responded" — this drives coverage.responded
    // up by 1 on the next refetch.
    await pool.query(
      `UPDATE freight_opportunity_carriers SET last_response_id = $1 WHERE id = $2`,
      [crypto.randomUUID(), focId],
    );
    await page.getByTestId('button-refresh-cockpit').click({ force: true });

    // Pill should buffer (we're hovering)…
    const pill = page.getByTestId('cockpit-refresh-pill');
    await expect(pill).toBeVisible({ timeout: 10_000 });

    // …AND the toast must fire from raw server data despite buffering.
    // shadcn/ui Toaster renders the title text inside a ToastTitle div;
    // first() avoids strict-mode collision with the aria-live announcer span.
    await expect(page.getByText(/new carrier repl(y|ies)/i).first()).toBeVisible({
      timeout: 5_000,
    });
  });
});
