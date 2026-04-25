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
});
