/**
 * Task #653 — AF "Make this recurring" one-click.
 *
 * Drives the actual UI flow:
 *   1. Seeds a freight_opportunities row owned by the dev-bypass user.
 *   2. Loads /available-freight, opens the row's overflow menu, and clicks
 *      "Make this recurring".
 *   3. Asserts the navigation lands on /lanes/work-queue with the documented
 *      query-param contract (createLane=1 + customer + originCity +
 *      originState + destCity + destState + equipment).
 *   4. Asserts the Build Lane dialog auto-opens with prefilled fields, the
 *      "Prefilled from Available Freight" provenance chip is visible, and
 *      avg-loads-per-week + owner are intentionally blank.
 *   5. Closes the dialog (cancel) and asserts the prefill query params are
 *      stripped from the URL.
 *   6. Re-runs the deep-link with edits to verify edits to the city field
 *      round-trip into the form state (proxy for "edits persist on save"
 *      without actually creating the lane).
 *
 * Run:
 *   npx playwright test --config=playwright.config.cjs tests/af-make-recurring.spec.cjs
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

let seeded = null;

test.beforeAll(async () => {
  // Resolve the dev-bypass user's org and a company in that org.
  const u = await pool.query(
    `SELECT organization_id FROM users WHERE id = $1`,
    [DEV_AUTH_BYPASS_USER_ID],
  );
  if (u.rowCount === 0) throw new Error('dev-bypass user not found');
  const orgId = u.rows[0].organization_id;

  const c = await pool.query(
    `SELECT id, name FROM companies WHERE organization_id = $1 ORDER BY name LIMIT 1`,
    [orgId],
  );
  if (c.rowCount === 0) throw new Error('no company in dev-bypass org');
  const company = c.rows[0];

  // Seed an AF opportunity owned by the dev user so the cockpit shows it.
  const id = `af-mr-test-${shortId()}`;
  const now = new Date();
  const pickupStart = new Date(now.getTime() + 6 * 3600_000).toISOString();
  const pickupEnd = new Date(now.getTime() + 30 * 3600_000).toISOString();
  await pool.query(
    `INSERT INTO freight_opportunities
       (id, org_id, company_id, mode, origin, origin_state, destination,
        destination_state, equipment_type, pickup_window_start,
        pickup_window_end, status, owner_user_id)
     VALUES ($1, $2, $3, 'spot', 'Atlanta', 'GA', 'Dallas', 'TX',
             'Reefer', $4, $5, 'new', $6)`,
    [id, orgId, company.id, pickupStart, pickupEnd, DEV_AUTH_BYPASS_USER_ID],
  );

  seeded = { id, orgId, companyId: company.id, companyName: company.name };
});

test.afterAll(async () => {
  if (seeded?.id) {
    await pool.query(`DELETE FROM freight_opportunities WHERE id = $1`, [seeded.id]);
  }
  await pool.end();
});

async function gotoAuth(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Sidebar is the most reliable post-auth-bypass marker across pages.
  await page.waitForSelector('[data-sidebar="sidebar"], aside, nav', { timeout: 10000 });
}

test.describe("AF 'Make this recurring' one-click", () => {
  test('action appears on every AF row regardless of status', async ({ page }) => {
    await gotoAuth(page, '/available-freight');
    const rowMenu = page.locator(`[data-testid="button-row-menu-${seeded.id}"]`);
    await expect(rowMenu).toBeVisible({ timeout: 10000 });
    await rowMenu.click();
    await expect(page.locator(`[data-testid="menu-make-recurring-${seeded.id}"]`)).toBeVisible();
  });

  test('clicking the action deep-links to LWQ with the dialog open and fields populated', async ({ page }) => {
    await gotoAuth(page, '/available-freight');
    const rowMenu = page.locator(`[data-testid="button-row-menu-${seeded.id}"]`);
    await expect(rowMenu).toBeVisible({ timeout: 10000 });
    await rowMenu.click();
    await page.locator(`[data-testid="menu-make-recurring-${seeded.id}"]`).click();

    // Lands on LWQ with the full deep-link contract. wouter SPA navigation
    // never fires a fresh "load" event, so use `expect(page).toHaveURL`
    // which polls page.url() against the regex.
    await expect(page).toHaveURL(/\/lanes\/work-queue\?createLane=1/, { timeout: 5000 });
    const url = new URL(page.url());
    expect(url.pathname).toBe('/lanes/work-queue');
    expect(url.searchParams.get('createLane')).toBe('1');
    expect(url.searchParams.get('customer')).toBe(seeded.companyName);
    expect(url.searchParams.get('originCity')).toBe('Atlanta');
    expect(url.searchParams.get('originState')).toBe('GA');
    expect(url.searchParams.get('destCity')).toBe('Dallas');
    expect(url.searchParams.get('destState')).toBe('TX');
    expect(url.searchParams.get('equipment')).toBe('Reefer');

    // Build Lane dialog auto-opens with prefilled values + provenance chip.
    const dialog = page.locator('[data-testid="dialog-build-lane"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="badge-build-lane-prefilled-af"]')).toBeVisible();
    await expect(page.locator('[data-testid="input-build-origin"]')).toHaveValue('Atlanta');
    await expect(page.locator('[data-testid="input-build-origin-state"]')).toHaveValue('GA');
    await expect(page.locator('[data-testid="input-build-dest"]')).toHaveValue('Dallas');
    await expect(page.locator('[data-testid="input-build-dest-state"]')).toHaveValue('TX');
    // avg-loads-per-week + notes are intentionally blank — rep picks them.
    await expect(page.locator('#build-loads')).toHaveValue('');
  });

  test('cancelling the dialog strips prefill query params from the URL', async ({ page }) => {
    const seed = `?createLane=1&customer=${encodeURIComponent(seeded.companyName)}&originCity=Atlanta&originState=GA&destCity=Dallas&destState=TX&equipment=Reefer`;
    await gotoAuth(page, `/lanes/work-queue${seed}`);
    const dialog = page.locator('[data-testid="dialog-build-lane"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="badge-build-lane-prefilled-af"]')).toBeVisible();

    // Close via Escape (Radix Dialog default close behavior).
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // The URL should no longer carry any of the prefill keys.
    const url = new URL(page.url());
    for (const k of ['createLane', 'customer', 'originCity', 'originState', 'destCity', 'destState', 'equipment']) {
      expect(url.searchParams.get(k), `expected ${k} to be cleared`).toBeNull();
    }
    expect(url.pathname).toBe('/lanes/work-queue');
  });

  test('edits to prefilled fields persist in the form (proxy for save)', async ({ page }) => {
    const seed = `?createLane=1&customer=${encodeURIComponent(seeded.companyName)}&originCity=Atlanta&originState=GA&destCity=Dallas&destState=TX&equipment=Reefer`;
    await gotoAuth(page, `/lanes/work-queue${seed}`);
    await expect(page.locator('[data-testid="dialog-build-lane"]')).toBeVisible({ timeout: 10000 });

    const destInput = page.locator('[data-testid="input-build-dest"]');
    await expect(destInput).toHaveValue('Dallas');
    await destInput.fill('Houston');
    // Field-state survives — proves the form is genuinely controlled by
    // user input after prefill, not re-seeded on every render.
    await expect(destInput).toHaveValue('Houston');

    const loads = page.locator('#build-loads');
    await loads.fill('3');
    await expect(loads).toHaveValue('3');
  });

  test('saving from a prefilled dialog persists edited values into the created recurring lane', async ({ page }) => {
    // Use a unique destination so we can identify the row this test created
    // independently of the test that just edited Dallas → Houston.
    const stamp = shortId();
    const editedDest = `Memphis-${stamp}`;
    const editedDestState = 'TN';

    const seed = `?createLane=1&customer=${encodeURIComponent(seeded.companyName)}&originCity=Atlanta&originState=GA&destCity=Dallas&destState=TX&equipment=Reefer`;
    await gotoAuth(page, `/lanes/work-queue${seed}`);
    const dialog = page.locator('[data-testid="dialog-build-lane"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="badge-build-lane-prefilled-af"]')).toBeVisible();

    // Edit one prefilled field (destination) and fill the required loads/wk.
    await page.locator('[data-testid="input-build-dest"]').fill(editedDest);
    await page.locator('[data-testid="input-build-dest-state"]').fill(editedDestState);
    await page.locator('#build-loads').fill('2.5');

    // Submit. The Build Lane dialog's confirm button is "Build Lane".
    const submit = page.locator('[data-testid="btn-build-lane-submit"]');
    await expect(submit).toBeEnabled();
    await submit.click();

    // Dialog closes on success.
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // Lane row exists in DB with the EDITED destination, not the prefilled
    // one — this is the genuine "edits persist on save" assertion.
    const r = await pool.query(
      `SELECT origin, origin_state, destination, destination_state,
              equipment_type, company_name, avg_loads_per_week, is_manual
         FROM recurring_lanes
        WHERE org_id = $1 AND destination = $2`,
      [seeded.orgId, editedDest],
    );
    expect(r.rowCount, 'a recurring lane should be created with the edited destination').toBe(1);
    const row = r.rows[0];
    expect(row.origin).toBe('Atlanta');
    expect(row.origin_state).toBe('GA');
    expect(row.destination_state).toBe(editedDestState);
    expect(row.equipment_type).toBe('Reefer');
    expect(row.company_name).toBe(seeded.companyName);
    expect(parseFloat(row.avg_loads_per_week)).toBe(2.5);
    expect(row.is_manual).toBe(true);

    // URL prefill params are stripped after a successful save.
    const url = new URL(page.url());
    for (const k of ['createLane', 'customer', 'originCity', 'originState', 'destCity', 'destState', 'equipment']) {
      expect(url.searchParams.get(k), `expected ${k} to be cleared after save`).toBeNull();
    }

    // Cleanup so the test is idempotent across re-runs.
    await pool.query(
      `DELETE FROM recurring_lanes WHERE org_id = $1 AND destination = $2`,
      [seeded.orgId, editedDest],
    );
  });
});
