// Task #1151 — partial-failure UI for the two CQ bulk routes. Seeds one
// quote_opportunity, stubs the bulk endpoints with 403 + deniedIds, and
// asserts the precise partial-failure dialog renders for both routes.

const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');
const crypto = require('crypto');

const DEV_AUTH_BYPASS_USER_ID =
  process.env.DEV_AUTH_BYPASS_USER_ID || '4e75fd7c-d462-42c5-a335-af327076416c';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function shortId() {
  return crypto.randomBytes(4).toString('hex');
}

test.describe('Task #1151 — bulk-mutation partial-failure UI', () => {
  test.setTimeout(60_000);

  let orgId;
  let customerId;
  let quoteId;

  test.beforeAll(async () => {
    const u = await pool.query(
      `SELECT organization_id FROM users WHERE id = $1`,
      [DEV_AUTH_BYPASS_USER_ID],
    );
    if (!u.rows.length) {
      throw new Error(`Dev bypass user ${DEV_AUTH_BYPASS_USER_ID} not found`);
    }
    orgId = u.rows[0].organization_id;

    const customerName = `BulkPartialFail ${shortId()}`;
    const c = await pool.query(
      `INSERT INTO quote_customers (id, organization_id, name, created_at)
         VALUES (gen_random_uuid(), $1, $2, NOW())
         RETURNING id`,
      [orgId, customerName],
    );
    customerId = c.rows[0].id;

    const opp = await pool.query(
      `INSERT INTO quote_opportunities
         (organization_id, customer_id, request_date, origin_city, origin_state,
          dest_city, dest_state, equipment, outcome_status)
       VALUES ($1, $2, NOW(),
               'Atlanta', 'GA', 'Dallas', 'TX', 'Van', 'pending')
       RETURNING id`,
      [orgId, customerId],
    );
    quoteId = opp.rows[0].id;
  });

  test.afterAll(async () => {
    if (quoteId) {
      await pool.query(`DELETE FROM quote_events WHERE quote_id = $1`, [quoteId]).catch(() => {});
      await pool.query(`DELETE FROM quote_opportunities WHERE id = $1`, [quoteId]).catch(() => {});
    }
    if (customerId) {
      await pool.query(`DELETE FROM quote_customers WHERE id = $1`, [customerId]).catch(() => {});
    }
    await pool.end();
  });

  test('bulk-reassign-customer 403 with deniedIds renders the partial-failure dialog', async ({ page }) => {
    await page.route('**/api/customer-quotes/quotes/bulk-reassign-customer', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Forbidden — some quotes belong to other reps',
          deniedIds: [quoteId],
        }),
      });
    });

    await page.goto('/quote-requests');
    const row = page.locator(`[data-testid="row-quote-${quoteId}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    await page.locator(`[data-testid="checkbox-bulk-select-${quoteId}"]`).check();
    await expect(page.locator('[data-testid="bulk-action-bar"]')).toBeVisible();

    await page.click('[data-testid="button-bulk-reassign-customer"]');
    const reassignDialog = page.locator('[data-testid="dialog-bulk-reassign"]');
    await expect(reassignDialog).toBeVisible();

    // Pick the first available customer option and confirm. The stubbed
    // 403 must close the picker and pop the partial-failure dialog
    // surfacing the precise denied id (not a generic "Forbidden" toast).
    await page.click('[data-testid="select-bulk-reassign-target"]');
    const firstOption = page.locator('[data-testid^="select-bulk-reassign-option-"]').first();
    await firstOption.click();
    await page.click('[data-testid="button-bulk-reassign-confirm"]');

    const dialog = page.locator('[data-testid="dialog-bulk-error"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="bulk-error-denied"]')).toBeVisible();
    await page.click('[data-testid="button-bulk-error-toggle"]');
    await expect(page.locator(`[data-testid="bulk-error-id-${quoteId}"]`)).toBeVisible();
  });

  test('bulk-status 404 with missingIds renders the missing-id surface', async ({ page }) => {
    await page.route('**/api/customer-quotes/quotes/bulk-status', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'One or more quotes not found',
          missingIds: [quoteId],
        }),
      });
    });

    await page.goto('/quote-requests');
    const row = page.locator(`[data-testid="row-quote-${quoteId}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    await page.locator(`[data-testid="checkbox-bulk-select-${quoteId}"]`).check();
    await page.click('[data-testid="button-bulk-mark-pending"]');

    const dialog = page.locator('[data-testid="dialog-bulk-error"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="bulk-error-missing"]')).toBeVisible();
    await expect(page.locator('[data-testid="text-bulk-error-summary"]'))
      .toContainText(/could not be found/);
    await page.click('[data-testid="button-bulk-error-toggle"]');
    await expect(page.locator(`[data-testid="bulk-error-id-${quoteId}"]`)).toBeVisible();
  });

  test('bulk-status 403 with deniedIds renders the partial-failure dialog', async ({ page }) => {
    // Stub the bulk endpoint with the assertCanMutateQuotes 403 shape.
    // The seeded quote id is included in deniedIds so the dialog has a
    // concrete id to surface (and so the "1 of 1" framing is honest).
    await page.route('**/api/customer-quotes/quotes/bulk-status', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Forbidden — some quotes belong to other reps',
          deniedIds: [quoteId],
        }),
      });
    });

    await page.goto('/quote-requests');

    // Wait for the seeded row to render. The "today" default + age filter
    // covers a fresh seed; if the row doesn't surface (e.g. mineOnly
    // server-scoping), broaden by toggling the "all" status chip.
    const row = page.locator(`[data-testid="row-quote-${quoteId}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Tick the row's checkbox → bulk action bar appears.
    await page.locator(`[data-testid="checkbox-bulk-select-${quoteId}"]`).check();
    await expect(page.locator('[data-testid="bulk-action-bar"]')).toBeVisible();
    await expect(page.locator('[data-testid="text-bulk-selection-count"]'))
      .toHaveText(/1 selected/);

    // Trigger the bulk mutation. The stubbed 403 should pop the
    // partial-failure dialog with the precise denied-id surface — NOT a
    // generic "Forbidden" toast.
    await page.click('[data-testid="button-bulk-mark-ignored"]');

    const dialog = page.locator('[data-testid="dialog-bulk-error"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Title must name the precise count + cause.
    await expect(page.locator('[data-testid="text-bulk-error-title"]'))
      .toContainText(/1 of 1/);

    // The denied-id surface (not no_rep_mapping / not generic).
    await expect(page.locator('[data-testid="bulk-error-denied"]')).toBeVisible();
    await expect(page.locator('[data-testid="text-bulk-error-summary"]'))
      .toContainText(/1 of 1/);

    // Expand → the actual quote id is listed.
    await page.click('[data-testid="button-bulk-error-toggle"]');
    await expect(page.locator(`[data-testid="bulk-error-id-${quoteId}"]`))
      .toBeVisible();
  });

  test('bulk-status 403 with no rep mapping renders the no_rep_mapping branch', async ({ page }) => {
    await page.route('**/api/customer-quotes/quotes/bulk-status', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No rep mapping — cannot flip status' }),
      });
    });

    await page.goto('/quote-requests');
    const row = page.locator(`[data-testid="row-quote-${quoteId}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    await page.locator(`[data-testid="checkbox-bulk-select-${quoteId}"]`).check();
    await page.click('[data-testid="button-bulk-mark-ignored"]');

    const dialog = page.locator('[data-testid="dialog-bulk-error"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="text-bulk-error-title"]'))
      .toContainText(/not mapped to a quote rep/);
    await expect(page.locator('[data-testid="bulk-error-no-rep-mapping"]')).toBeVisible();
    await expect(page.locator('[data-testid="link-rep-mapping-admin"]')).toBeVisible();
  });
});
