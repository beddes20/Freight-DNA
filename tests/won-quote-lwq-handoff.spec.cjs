/**
 * Browser-driven end-to-end test for the won-quote → Lane Work Queue (LWQ)
 * handoff (Tasks #477 / #503).
 *
 * Drives the actual UI flow:
 *   - Open the New Quote dialog from /customer-quotes, fill it in, save.
 *   - Use the inline outcome picker on the new row to mark the quote "won".
 *   - The win-confirmation dialog appears with "Create LWQ lane" CHECKED by
 *     default → confirm → assert exactly one recurring_lanes row was created
 *     with source_quote_id pointing at the quote (and is_manual = true).
 *   - Re-mark the same quote won (toggle pending → won again) and assert no
 *     duplicate lane is inserted (idempotency of createLwqLaneFromWonQuote).
 *   - Create a second quote, mark won via the inline picker, but UNCHECK
 *     "Create LWQ lane" before confirming → assert no recurring_lanes row
 *     is inserted for that quote.
 *
 * Companion tests:
 *   - tests/won-quote-lwq-handoff.test.ts is a parallel API-level integration
 *     test of the same flow, useful as a fast smoke test in CI.
 *
 * Run (requires the dev server on :5000 and Playwright installed):
 *   npx playwright test --config=playwright.config.cjs tests/won-quote-lwq-handoff.spec.cjs
 *
 * Relies on VITE_DEV_AUTH_BYPASS=true / DEV_AUTH_BYPASS_USER_ID so the page
 * loads in an authenticated state without a Clerk login.
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

async function fillNewQuote(page, { customerName, originCity, originState, destCity, destState, quotedAmount, sourceRef }) {
  await page.click('[data-testid="button-new-quote"]');
  await expect(page.locator('[data-testid="new-quote-dialog"]')).toBeVisible();

  await page.click('[data-testid="new-customer"]');
  // The Radix Select renders options in a portal; pick by visible text.
  await page.getByRole('option', { name: customerName, exact: true }).click();

  await page.fill('[data-testid="new-origin-city"]', originCity);
  await page.fill('[data-testid="new-origin-state"]', originState);
  await page.fill('[data-testid="new-dest-city"]', destCity);
  await page.fill('[data-testid="new-dest-state"]', destState);
  await page.fill('[data-testid="new-quoted-amount"]', String(quotedAmount));
  await page.fill('[data-testid="new-source-ref"]', sourceRef);

  await page.click('[data-testid="button-new-save"]');
  await expect(page.locator('[data-testid="new-quote-dialog"]')).toBeHidden();
}

async function fetchQuoteIdByRef(customerId, sourceRef) {
  const r = await pool.query(
    `SELECT id FROM quote_opportunities
       WHERE customer_id = $1 AND source_reference = $2
       ORDER BY created_at DESC LIMIT 1`,
    [customerId, sourceRef],
  );
  if (!r.rows.length) throw new Error(`No quote found for ref ${sourceRef}`);
  return r.rows[0].id;
}

async function setOutcomeViaInlinePicker(page, quoteId, status) {
  // The detail drawer can intercept clicks on the row; close any open
  // drawer/dialog that isn't ours first.
  await page.keyboard.press('Escape').catch(() => {});
  await page.click(`[data-testid="inline-outcome-${quoteId}"]`);
  await page.click(`[data-testid="inline-outcome-option-${quoteId}-${status}"]`);
}

test.describe('Won-quote → LWQ handoff (Task #477 / #503)', () => {
  let orgId;
  let customerId;
  let customerName;
  const quoteIds = [];

  test.beforeAll(async () => {
    const u = await pool.query(
      `SELECT organization_id FROM users WHERE id = $1`,
      [DEV_AUTH_BYPASS_USER_ID],
    );
    if (!u.rows.length) {
      throw new Error(`Dev bypass user ${DEV_AUTH_BYPASS_USER_ID} not found`);
    }
    orgId = u.rows[0].organization_id;

    customerName = `LWQUiTest ${shortId()}`;
    const c = await pool.query(
      `INSERT INTO quote_customers (id, organization_id, name, created_at)
         VALUES (gen_random_uuid(), $1, $2, NOW())
         RETURNING id`,
      [orgId, customerName],
    );
    customerId = c.rows[0].id;
  });

  test.afterAll(async () => {
    if (quoteIds.length) {
      await pool.query(
        `DELETE FROM recurring_lanes WHERE source_quote_id = ANY($1::text[])`,
        [quoteIds],
      ).catch(() => {});
      await pool.query(
        `DELETE FROM quote_events WHERE quote_id = ANY($1::text[])`,
        [quoteIds],
      ).catch(() => {});
      await pool.query(
        `DELETE FROM quote_opportunities WHERE id = ANY($1::text[])`,
        [quoteIds],
      ).catch(() => {});
    }
    if (customerId) {
      await pool.query(`DELETE FROM quote_customers WHERE id = $1`, [customerId]).catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  test('creates exactly one LWQ lane when "Create LWQ lane" is checked, and is idempotent on re-won', async ({ page }) => {
    const refA = `ui-${shortId()}`;
    await page.goto('/customer-quotes');
    await expect(page.locator('[data-testid="header-customer-quotes"]')).toBeVisible();

    // Create Quote A through the New Quote dialog.
    await fillNewQuote(page, {
      customerName,
      originCity: 'Chicago', originState: 'IL',
      destCity: 'Dallas', destState: 'TX',
      quotedAmount: 2500,
      sourceRef: refA,
    });

    const quoteAId = await fetchQuoteIdByRef(customerId, refA);
    quoteIds.push(quoteAId);

    // Reload so the new pending row shows up reliably in the virtualized table.
    await page.reload();
    await expect(page.locator(`[data-testid="row-quote-${quoteAId}"]`)).toBeVisible();

    // Mark won via inline picker → confirm dialog with checkbox CHECKED by default.
    await setOutcomeViaInlinePicker(page, quoteAId, 'won');
    await expect(page.locator('[data-testid="win-outcome-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="checkbox-create-lwq-lane"]')).toBeChecked();
    await page.click('[data-testid="button-win-confirm"]');
    await expect(page.locator('[data-testid="win-outcome-dialog"]')).toBeHidden();

    // Allow the PATCH + lane insert to settle.
    await expect.poll(async () => {
      const r = await pool.query(
        `SELECT id, is_manual FROM recurring_lanes WHERE source_quote_id = $1`,
        [quoteAId],
      );
      return r.rows;
    }, { timeout: 5000 }).toHaveLength(1);

    const lanesA = await pool.query(
      `SELECT is_manual FROM recurring_lanes WHERE source_quote_id = $1`,
      [quoteAId],
    );
    expect(lanesA.rows[0].is_manual).toBe(true);

    // Idempotency: flip back to pending so the next "won" actually fires the
    // server-side handoff again, then re-mark won. The lane count must stay 1.
    await setOutcomeViaInlinePicker(page, quoteAId, 'pending');
    await expect(page.locator('[data-testid="win-outcome-dialog"]')).toBeHidden();

    await setOutcomeViaInlinePicker(page, quoteAId, 'won');
    await expect(page.locator('[data-testid="win-outcome-dialog"]')).toBeVisible();
    await page.click('[data-testid="button-win-confirm"]');
    await expect(page.locator('[data-testid="win-outcome-dialog"]')).toBeHidden();

    // Give the second handoff attempt a moment, then assert no duplicate lane.
    await page.waitForTimeout(500);
    const lanesAfter = await pool.query(
      `SELECT COUNT(*)::int AS n FROM recurring_lanes WHERE source_quote_id = $1`,
      [quoteAId],
    );
    expect(lanesAfter.rows[0].n).toBe(1);
  });

  test('does not create an LWQ lane when "Create LWQ lane" is unchecked', async ({ page }) => {
    const refB = `ui-${shortId()}`;
    await page.goto('/customer-quotes');
    await expect(page.locator('[data-testid="header-customer-quotes"]')).toBeVisible();

    await fillNewQuote(page, {
      customerName,
      originCity: 'Atlanta', originState: 'GA',
      destCity: 'Miami', destState: 'FL',
      quotedAmount: 1800,
      sourceRef: refB,
    });

    const quoteBId = await fetchQuoteIdByRef(customerId, refB);
    quoteIds.push(quoteBId);

    await page.reload();
    await expect(page.locator(`[data-testid="row-quote-${quoteBId}"]`)).toBeVisible();

    await setOutcomeViaInlinePicker(page, quoteBId, 'won');
    await expect(page.locator('[data-testid="win-outcome-dialog"]')).toBeVisible();

    // Default is checked — uncheck it before confirming.
    await page.click('[data-testid="checkbox-create-lwq-lane"]');
    await expect(page.locator('[data-testid="checkbox-create-lwq-lane"]')).not.toBeChecked();

    await page.click('[data-testid="button-win-confirm"]');
    await expect(page.locator('[data-testid="win-outcome-dialog"]')).toBeHidden();

    await page.waitForTimeout(500);
    const lanesB = await pool.query(
      `SELECT COUNT(*)::int AS n FROM recurring_lanes WHERE source_quote_id = $1`,
      [quoteBId],
    );
    expect(lanesB.rows[0].n).toBe(0);
  });
});
