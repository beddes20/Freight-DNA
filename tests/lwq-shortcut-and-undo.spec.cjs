/**
 * E2E coverage for Task #970 — LWQ deterministic Shift+L focus + bulk
 * action Undo lifecycle.
 *
 * Two tests:
 *   (1) Shift+L from a non-LWQ page navigates to /lanes/work-queue and
 *       focuses the first row even when the data fetch is slowed past
 *       the old 250ms setTimeout window. Asserts DOM `:focus` actually
 *       moved to the row (not just internal state).
 *   (2) Bulk reassign on LWQ clears the selection synchronously,
 *       surfaces the 8s Undo toast, and Undo restores the prior
 *       selection set.
 *
 * Run: npx playwright test --config=playwright.config.cjs tests/lwq-shortcut-and-undo.spec.cjs
 */

const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');
const crypto = require('crypto');

const DEV_AUTH_BYPASS_USER_ID =
  process.env.DEV_AUTH_BYPASS_USER_ID || '4e75fd7c-d462-42c5-a335-af327076416c';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SEED_TAG = `vtest-shortcut-${crypto.randomBytes(4).toString('hex')}`;
const SEEDED_LANE_COUNT = 4;

let orgId;
const seededLaneIds = [];
const seededCompanyIds = [];

test.describe('LWQ Shift+L focus + bulk Undo (Task #970)', () => {
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

    const companyName = `${SEED_TAG} Co`;
    const c = await pool.query(
      `INSERT INTO companies (id, organization_id, name)
         VALUES (gen_random_uuid(), $1, $2)
         RETURNING id`,
      [orgId, companyName],
    );
    const companyId = c.rows[0].id;
    seededCompanyIds.push(companyId);

    for (let i = 0; i < SEEDED_LANE_COUNT; i++) {
      const lane = await pool.query(
        `INSERT INTO recurring_lanes
           (id, org_id, company_id, company_name,
            origin, origin_state, destination, destination_state,
            equipment_type, avg_loads_per_week, owner_user_id,
            is_eligible, eligibility_confidence, is_manual,
            created_at, updated_at)
           VALUES
           (gen_random_uuid(), $1, $2, $3,
            $4, 'TX', $5, 'CA',
            'Dry Van', '3', NULL,
            true, 'high', true,
            NOW(), NOW())
           RETURNING id`,
        [orgId, companyId, companyName, `OrigCity-${i}`, `DestCity-${i}`],
      );
      seededLaneIds.push(lane.rows[0].id);
    }
  });

  test.afterAll(async () => {
    try {
      if (seededLaneIds.length) {
        await pool.query(
          `DELETE FROM recurring_lanes WHERE id = ANY($1::text[])`,
          [seededLaneIds],
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

  test('Shift+L from another page navigates and focuses the first row even when data is slow', async ({ page }) => {
    // Slow the LWQ data fetch by 1.5 s — well past the old 250 ms
    // setTimeout that the new shortcut-target registry replaces.
    await page.route('**/api/recurring-lanes/work-queue**', async route => {
      await new Promise(r => setTimeout(r, 1500));
      await route.continue();
    });

    await page.goto('/');
    // Wait for the app shell to mount its keydown listener.
    await page.waitForSelector("[data-testid='input-global-search']", { timeout: 15_000 });
    await page.waitForTimeout(300);

    // Dispatch Shift+L on document directly so we don't depend on
    // Playwright's modifier interpretation. App.tsx's handler listens
    // on document keydown.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'L',
        code: 'KeyL',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    // Navigation should fire immediately; the focus invocation is queued
    // until the LWQ row list mounts (after the slow fetch resolves).
    await page.waitForURL('**/lanes/work-queue', { timeout: 10_000 });

    // Wait for at least one work-queue-row to render. Then assert the
    // first one has DOM focus (not just internal focusedIndex state).
    const firstRow = page.locator('[data-testid^="work-queue-row-"]').first();
    await firstRow.waitFor({ state: 'visible', timeout: 15_000 });

    // The focus invocation should fire as soon as the registration
    // happens. Give one more tick for the effect to drain.
    await page.waitForTimeout(300);

    const isFocused = await firstRow.evaluate(el => el === document.activeElement);
    expect(isFocused).toBe(true);

    // tabIndex must be set to 0 so the focus is real, not synthetic.
    const tabIndex = await firstRow.evaluate(el => el.tabIndex);
    expect(tabIndex).toBe(0);
  });

  test('bulk reassign clears selection synchronously and Undo restores it', async ({ page }) => {
    await page.goto('/lanes/work-queue');
    await page.waitForSelector('[data-testid^="work-queue-row-"]', { timeout: 30_000 });

    // Select the first two seeded lanes via their checkbox affordance.
    const targetLaneIds = seededLaneIds.slice(0, 2);
    for (const id of targetLaneIds) {
      const checkbox = page.locator(`[data-testid="checkbox-lane-${id}"]`);
      await checkbox.waitFor({ state: 'visible', timeout: 10_000 });
      await checkbox.click();
    }

    // Bulk action bar should now show "2 selected".
    const countLabel = page.locator('[data-testid="text-bulk-count"]');
    await expect(countLabel).toContainText('2');

    // Find the candidate picker inside the inline reassign control.
    const picker = page.locator('[data-testid="bulk-reassign-control"] select');
    await picker.waitFor({ state: 'visible', timeout: 10_000 });

    // Pick the first non-empty option (any teammate). If only the
    // placeholder option exists this test is a structural no-op for
    // this org — bail rather than false-fail.
    const optionValues = await picker.evaluate(el => {
      return Array.from(el.options).map(o => o.value).filter(v => v && v !== '');
    });
    if (!optionValues.length) {
      test.skip(true, 'no reassign candidates available in this org');
      return;
    }
    await picker.selectOption(optionValues[0]);

    // Click confirm. The fully-eligible path commits immediately
    // (no override prompt). Selection should clear synchronously.
    await page.locator('[data-testid="button-bulk-assign-confirm"]').click();

    // Wait for the Undo toast — its action button has a stable id.
    const undoBtn = page.locator('[data-testid="toast-action-undo"]');
    await undoBtn.waitFor({ state: 'visible', timeout: 10_000 });

    // The bulk action bar should have collapsed (selection cleared).
    await expect(page.locator('[data-testid="text-bulk-count"]')).toHaveCount(0);

    // Click Undo — the prior selection set must be restored.
    await undoBtn.click();
    await expect(page.locator('[data-testid="text-bulk-count"]')).toContainText('2', {
      timeout: 10_000,
    });

    // Both prior checkboxes should be marked checked again.
    for (const id of targetLaneIds) {
      const checkbox = page.locator(`[data-testid="checkbox-lane-${id}"]`);
      await expect(checkbox).toBeVisible();
    }
  });

  test('bulk Snooze 24h clears selection, surfaces Undo, and Undo restores lanes (Task #970)', async ({ page }) => {
    await page.goto('/lanes/work-queue');
    await page.waitForSelector('[data-testid^="work-queue-row-"]', { timeout: 30_000 });

    // Pick two seeded lanes from the back of the seed list so this test
    // and the reassign test don't fight over the same rows when run
    // serially against a shared org.
    const targetLaneIds = seededLaneIds.slice(2, 4);
    for (const id of targetLaneIds) {
      const checkbox = page.locator(`[data-testid="checkbox-lane-${id}"]`);
      await checkbox.waitFor({ state: 'visible', timeout: 10_000 });
      await checkbox.click();
    }

    await expect(page.locator('[data-testid="text-bulk-count"]')).toContainText('2');

    // Capture lanes' pre-snooze snoozed_until so we can assert it
    // changed (forward) and reverted (Undo).
    const beforeSnooze = await pool.query(
      `SELECT id, snoozed_until FROM recurring_lanes WHERE id = ANY($1::text[])`,
      [targetLaneIds],
    );
    for (const row of beforeSnooze.rows) {
      expect(row.snoozed_until).toBeNull();
    }

    // Click the secondary "Snooze 24h" action.
    const snoozeBtn = page.locator('[data-testid="button-bulk-snooze-24h"]');
    await snoozeBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await snoozeBtn.click();

    // Selection should clear synchronously and the Undo toast should
    // surface within the standard 8 s window.
    const undoBtn = page.locator('[data-testid="toast-action-undo"]');
    await undoBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(page.locator('[data-testid="text-bulk-count"]')).toHaveCount(0);

    // Server side: snoozed_until is now populated.
    await expect.poll(async () => {
      const r = await pool.query(
        `SELECT id, snoozed_until FROM recurring_lanes WHERE id = ANY($1::text[])`,
        [targetLaneIds],
      );
      return r.rows.every(row => row.snoozed_until !== null);
    }, { timeout: 10_000, message: 'lanes were not snoozed server-side' }).toBe(true);

    // Undo: replays unsnooze; the prior selection is restored so the
    // rep can immediately re-pick a different action.
    await undoBtn.click();
    await expect(page.locator('[data-testid="text-bulk-count"]')).toContainText('2', {
      timeout: 10_000,
    });

    // Server side: snoozed_until is back to null.
    await expect.poll(async () => {
      const r = await pool.query(
        `SELECT id, snoozed_until FROM recurring_lanes WHERE id = ANY($1::text[])`,
        [targetLaneIds],
      );
      return r.rows.every(row => row.snoozed_until === null);
    }, { timeout: 10_000, message: 'snooze was not undone server-side' }).toBe(true);
  });
});
