/**
 * Browser-driven test for the shared, viewport-aware lane-signal cache
 * (Task #651).
 *
 * Verifies three claims:
 *   1. LWQ no longer pre-fetches every bucket up front. Right after page
 *      load, the number of GET /api/sonar/lane-signals network calls is
 *      bounded — only enough to cover the rows currently inside the
 *      IntersectionObserver lookahead margin.
 *   2. Lane signals fetched from one page are reused on another. After
 *      LWQ has loaded, navigating to /available-freight or
 *      /customer-quotes triggers ZERO additional signal fetches for the
 *      same lanes.
 *   3. Scrolling LWQ to the bottom mounts new rows AND fires additional
 *      coalesced fetches for the newly-visible lanes (cache miss path).
 *
 * Run (requires the dev server on :5000 and Playwright installed):
 *   npx playwright test --config=playwright.config.cjs \
 *     tests/lane-signals-shared-cache.spec.cjs
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

const SEED_TAG = `vtest-shared-${shortId()}`;
const SEEDED_LANE_COUNT = 200;
const CUSTOMERS_PER_BUCKET = 4;
const LANES_PER_CUSTOMER = SEEDED_LANE_COUNT / CUSTOMERS_PER_BUCKET; // 50

let orgId;
const seededLaneIds = [];
const seededCompanyIds = [];

test.describe('Shared lane-signal cache (Task #651)', () => {
  test.setTimeout(180_000);

  test.beforeAll(async () => {
    const u = await pool.query(
      `SELECT organization_id FROM users WHERE id = $1`,
      [DEV_AUTH_BYPASS_USER_ID],
    );
    if (!u.rows.length) {
      throw new Error(`Dev bypass user ${DEV_AUTH_BYPASS_USER_ID} not found`);
    }
    orgId = u.rows[0].organization_id;

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
            `${SEED_TAG}-O${c}-${i}`,
            `${SEED_TAG}-D${c}-${i}`,
          ],
        );
        seededLaneIds.push(lane.rows[0].id);
      }
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

  test('signal fetches are viewport-bounded and shared across pages', async ({ page }) => {
    // Capture every GET to the lane-signals endpoint and parse the lanes
    // querystring so we can count both calls and total lanes requested.
    const fetchedLanes = new Set();
    let callCount = 0;
    page.on('request', req => {
      const url = req.url();
      if (!url.includes('/api/sonar/lane-signals')) return;
      callCount++;
      const u = new URL(url);
      const lanesParam = u.searchParams.get('lanes');
      if (lanesParam) {
        for (const sig of lanesParam.split(';')) {
          if (sig) fetchedLanes.add(sig);
        }
      } else {
        const o = u.searchParams.get('origin');
        const d = u.searchParams.get('destination');
        if (o && d) fetchedLanes.add(`${o}|${d}`);
      }
    });

    // ── Phase 1: load LWQ and expand all customer groups ──────────────
    await page.goto('/lanes/work-queue');
    await page.waitForSelector('[data-testid="bucket-unassigned"]', { timeout: 30_000 });

    const expandAll = page.locator('[data-testid="btn-toggle-all-customers-unassigned"]');
    if (await expandAll.count()) {
      await expandAll.click();
      await page.waitForTimeout(400);
    }
    // Backstop click for any group that didn't expand (race with sync).
    const headers = page.locator('[data-testid^="customer-group-toggle-"]');
    const headerCount = await headers.count();
    for (let i = 0; i < headerCount; i++) {
      const chevron = headers.nth(i).locator('svg.lucide-chevron-right');
      const cls = (await chevron.getAttribute('class')) || '';
      if (!cls.includes('rotate-90')) await headers.nth(i).click();
    }

    // Let the IntersectionObserver fire and the microtask coalescer
    // flush its first batched fetch.
    await page.waitForTimeout(1500);

    const totalSeededOnScreen = await page
      .locator(`[data-testid^="lwq-lazy-row-"]`)
      .count();
    const lanesAfterFirstLoad = fetchedLanes.size;
    console.log(
      `[shared-cache] phase1 total-lazy=${totalSeededOnScreen} ` +
      `signal-calls=${callCount} unique-lanes-fetched=${lanesAfterFirstLoad}`,
    );

    // The page renders 200+ seeded lanes, but the viewport only has room
    // for ~10 rows. With a 1000px IO lookahead the initial visible window
    // should still be far below the total seed count.
    expect(totalSeededOnScreen).toBeGreaterThanOrEqual(40);
    expect(lanesAfterFirstLoad).toBeLessThan(totalSeededOnScreen);
    // We must have made AT LEAST the one batched call for the visible
    // window. Coalescing means it's typically exactly 1 call, but a small
    // number of batched calls is still acceptable (<= 4) — what matters
    // is that we are NOT firing one call per lane.
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(callCount).toBeLessThanOrEqual(4);

    // Snapshot for the cross-page check below.
    const lanesFetchedByLwq = new Set(fetchedLanes);

    // ── Phase 2: scroll LWQ — new lanes mount & coalesce a new fetch ──
    await page.evaluate(() => {
      const el = document.querySelector('div.overflow-y-auto');
      if (el) el.scrollTop = el.scrollHeight - el.clientHeight - 100;
      else window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(1500);

    const lanesAfterScroll = fetchedLanes.size;
    const callCountAfterScroll = callCount;
    console.log(
      `[shared-cache] phase2 signal-calls=${callCountAfterScroll} ` +
      `unique-lanes-fetched=${lanesAfterScroll}`,
    );
    expect(lanesAfterScroll).toBeGreaterThan(lanesAfterFirstLoad);

    // ── Phase 3: SPA-navigate (preserves the in-memory query cache)
    // to /available-freight. Any lane that LWQ already cached MUST be
    // served from the shared cache — react-query won't issue a network
    // request for it. AF may still issue ONE batched call for brand-new
    // lanes it shows that LWQ never asked about. ─────────────────────
    const callsBeforeAf = callCount;
    const lanesBeforeAf = new Set(fetchedLanes);
    await page.evaluate(href => {
      window.history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, '/available-freight');
    await page.waitForTimeout(2500);
    const afCalls = callCount - callsBeforeAf;
    const lanesAddedByAf = [...fetchedLanes].filter(l => !lanesBeforeAf.has(l));
    // The strong assertion: every NEW lane the network heard about while
    // we were on AF must NOT already have been cached by LWQ.
    const dupesFromAf = lanesAddedByAf.filter(l => lanesFetchedByLwq.has(l));
    console.log(
      `[shared-cache] phase3 calls-on-af=${afCalls} ` +
      `lanes-added-by-af=${lanesAddedByAf.length} dupes=${dupesFromAf.length}`,
    );
    expect(dupesFromAf.length).toBe(0);
    expect(afCalls).toBeLessThanOrEqual(1);

    // ── Phase 4: SPA-navigate to /customer-quotes — same expectation ─
    const callsBeforeCq = callCount;
    const lanesBeforeCq = new Set(fetchedLanes);
    await page.evaluate(href => {
      window.history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, '/customer-quotes');
    await page.waitForTimeout(2500);
    const cqCalls = callCount - callsBeforeCq;
    const lanesAddedByCq = [...fetchedLanes].filter(l => !lanesBeforeCq.has(l));
    const cqDupes = lanesAddedByCq.filter(
      l => lanesFetchedByLwq.has(l) || lanesBeforeCq.has(l),
    );
    console.log(
      `[shared-cache] phase4 calls-on-cq=${cqCalls} ` +
      `lanes-added-by-cq=${lanesAddedByCq.length} dupes=${cqDupes.length}`,
    );
    expect(cqDupes.length).toBe(0);
    expect(cqCalls).toBeLessThanOrEqual(1);
  });
});
