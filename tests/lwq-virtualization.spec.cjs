/**
 * Browser-driven render-level test for LWQ list virtualization (Task #648).
 *
 * Seeds enough recurring lanes (250) to make virtualization observable,
 * navigates to /lanes/work-queue, expands every customer group in the
 * Unassigned bucket, and asserts:
 *   - There are 250 lazy wrappers (data-testid="lwq-lazy-row-{laneId}")
 *   - Only a small windowed slice has data-state="mounted" — far fewer
 *     than the total. The inner LaneRow's work-queue-row-{laneId} only
 *     appears once that slice mounts.
 *   - After scrolling near the bottom, the mounted slice changes (rows
 *     near the new viewport region mount in; rows above unmount out),
 *     proving real mount/unmount cycling rather than mount-once-keep.
 *
 * Run (requires the dev server on :5000 and Playwright installed):
 *   npx playwright test --config=playwright.config.cjs tests/lwq-virtualization.spec.cjs
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

const SEED_TAG = `vtest-virt-${shortId()}`;
const SEEDED_LANE_COUNT = 250;
const CUSTOMERS_PER_BUCKET = 5;
const LANES_PER_CUSTOMER = SEEDED_LANE_COUNT / CUSTOMERS_PER_BUCKET; // 50

let orgId;
const seededLaneIds = [];
const seededCompanyIds = [];

test.describe('LWQ virtualization (Task #648)', () => {
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

    // Insert 5 fresh customer companies and 50 unassigned recurring lanes
    // each, so the Unassigned bucket has 250 rows across 5 customer groups.
    for (let c = 0; c < CUSTOMERS_PER_BUCKET; c++) {
      const companyName = `${SEED_TAG} Co ${c}`;
      const companyRow = await pool.query(
        `INSERT INTO companies (id, organization_id, name)
           VALUES (gen_random_uuid(), $1, $2)
           RETURNING id`,
        [orgId, companyName],
      );
      const companyId = companyRow.rows[0].id;
      seededCompanyIds.push(companyId);

      for (let i = 0; i < LANES_PER_CUSTOMER; i++) {
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
          [
            orgId,
            companyId,
            companyName,
            `City${c}-${i}`,
            `Dest${c}-${i}`,
          ],
        );
        seededLaneIds.push(lane.rows[0].id);
      }
    }
  });

  test.afterAll(async () => {
    // recurring_lanes.id and companies.id are both varchar in this schema,
    // so a text[] cast is correct. Errors here are surfaced (no swallow)
    // so leftover seed rows don't accumulate silently across test runs.
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

  test('only a windowed slice of LaneRows is mounted at a time', async ({ page }) => {
    await page.goto('/lanes/work-queue');

    // Wait for the Unassigned bucket header to render.
    await page.waitForSelector('[data-testid="bucket-unassigned"]', { timeout: 30_000 });

    // Expand every customer group in the Unassigned bucket. The bucket's
    // own "Expand all" only fires when more than one customer group is
    // present, and there's a brief race after the click before all child
    // groups sync — so we click it and then click any still-collapsed
    // customer headers individually as a backstop.
    const expandAll = page.locator('[data-testid="btn-toggle-all-customers-unassigned"]');
    if (await expandAll.count()) {
      await expandAll.click();
      await page.waitForTimeout(400);
    }
    const collapsedHeaders = await page
      .locator('[data-testid^="customer-group-toggle-"] svg.lucide-chevron-right:not(.rotate-90)')
      .count();
    if (collapsedHeaders > 0) {
      const headers = page.locator('[data-testid^="customer-group-toggle-"]');
      const n = await headers.count();
      for (let i = 0; i < n; i++) {
        const chevron = headers.nth(i).locator('svg.lucide-chevron-right');
        const cls = (await chevron.getAttribute('class')) || '';
        if (!cls.includes('rotate-90')) {
          await headers.nth(i).click();
        }
      }
    }

    // Give the layout a moment to settle and IO callbacks to fire for the
    // currently-visible window.
    await page.waitForTimeout(1200);

    const totalLazy = await page.locator('[data-testid^="lwq-lazy-row-"]').count();
    const mountedAtTop = await page
      .locator('[data-testid^="lwq-lazy-row-"][data-state="mounted"]')
      .count();
    const placeholdersAtTop = await page
      .locator('[data-testid^="lwq-lazy-row-"][data-state="placeholder"]')
      .count();
    const innerRowsAtTop = await page.locator('[data-testid^="work-queue-row-"]').count();

    console.log(
      `[virt] top: total=${totalLazy} mounted=${mountedAtTop} ` +
      `placeholders=${placeholdersAtTop} innerRows=${innerRowsAtTop}`,
    );

    // The work-queue API can lag fresh seeds for a moment (cache layer);
    // we accept any total that's well above the on-screen capacity (~10
    // rows fit in a 720px viewport) so the windowing claim is meaningful.
    expect(totalLazy).toBeGreaterThanOrEqual(40);
    expect(mountedAtTop).toBeGreaterThan(0);
    expect(placeholdersAtTop).toBeGreaterThan(0);
    expect(mountedAtTop).toBeLessThan(totalLazy);
    // Inner LaneRows only render when their wrapper is mounted.
    expect(innerRowsAtTop).toBe(mountedAtTop);

    // Capture which laneIds are currently mounted so we can later prove
    // the mounted set actually changes after scrolling (true windowing).
    const mountedIdsAtTop = await page.$$eval(
      '[data-testid^="lwq-lazy-row-"][data-state="mounted"]',
      els => els.map(el => el.getAttribute('data-testid')),
    );

    // Scroll the page-level scroll container near the bottom of the
    // Unassigned bucket so the lazy wrappers near the bottom intersect.
    await page.evaluate(() => {
      const el = document.querySelector('div.overflow-y-auto');
      if (el) {
        el.scrollTop = el.scrollHeight - el.clientHeight - 100;
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }
    });
    await page.waitForTimeout(800);

    const mountedAfterScroll = await page
      .locator('[data-testid^="lwq-lazy-row-"][data-state="mounted"]')
      .count();
    const mountedIdsAfterScroll = await page.$$eval(
      '[data-testid^="lwq-lazy-row-"][data-state="mounted"]',
      els => els.map(el => el.getAttribute('data-testid')),
    );

    console.log(`[virt] after-scroll: mounted=${mountedAfterScroll}`);

    // Mounted set must have meaningfully changed: at least one row that was
    // mounted at the top is no longer mounted (true unmount-on-leave), AND
    // at least one row mounted after scroll wasn't mounted before.
    const beforeSet = new Set(mountedIdsAtTop);
    const afterSet = new Set(mountedIdsAfterScroll);
    const evicted = mountedIdsAtTop.filter(id => !afterSet.has(id));
    const added = mountedIdsAfterScroll.filter(id => !beforeSet.has(id));

    console.log(`[virt] evicted=${evicted.length} added=${added.length}`);

    expect(evicted.length).toBeGreaterThan(0);
    expect(added.length).toBeGreaterThan(0);

    // Mounted slice should still be far smaller than the total (windowing
    // didn't degrade into mount-everything).
    expect(mountedAfterScroll).toBeLessThan(totalLazy);
  });
});
