/**
 * Task #703 — Lane System E2E suite.
 *
 * Browser-driven coverage for the four cross-linked lane surfaces:
 *
 *   • Available Freight   (/available-freight)
 *   • Lane Work Queue     (/lanes/work-queue)
 *   • Carrier Hub         (/carrier-hub)
 *   • Lane Inbox          (/lane-inbox)
 *
 * The suite verifies:
 *
 *   1. Cross-tab breadcrumb contract — every surface renders
 *      `<CrossTabBreadcrumb />` when arrived at with `?from=<slug>` (and an
 *      optional `?fromQuery=<encoded>`), exposes a back-link tagged with the
 *      source slug, and rebuilds the source URL with the captured query so
 *      filter / scroll context is restored on click.
 *
 *   2. Direct visits (no `?from=` param) render nothing — confirming the
 *      helper does not insert a stray empty bar.
 *
 *   3. Lane Work Queue filter persistence — direct-linking with
 *      `?highFreq=1&manual=1&customer=Acme` lights the matching filter pills
 *      on first paint (rep-to-rep handoffs).
 *
 *   4. Lane assignment + SSE — assigning a lane in one Lane Work Queue tab
 *      makes a second tab refetch and the lane appear under the new owner's
 *      bucket without a manual reload (driven by the `recurring_lane`
 *      live-sync topic).
 *
 *   5. Lane reassignment + SSE — issuing the reassignment PATCH publishes a
 *      `recurring_lane` event AND writes a `reassignment` outreach log; an
 *      open Lane Inbox tab refetches and surfaces the "Lane reassigned"
 *      row without a reload.
 *
 * Run (requires the dev server on :5000 and Playwright installed):
 *   npx playwright test --config=playwright.config.cjs tests/lane-system-e2e.spec.cjs
 */

const { test, expect, request: playwrightRequest } = require('@playwright/test');
const { Pool } = require('pg');
const crypto = require('crypto');

// Parallelize within this spec — direct-URL navigation tests are independent
// of each other and the SSE tests use isolated browser contexts. Without
// this, every case serializes through one worker and the suite blows past
// the 60s CI budget.
test.describe.configure({ mode: 'parallel' });

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5000';
const DEV_AUTH_BYPASS_USER_ID =
  process.env.DEV_AUTH_BYPASS_USER_ID || '4e75fd7c-d462-42c5-a335-af327076416c';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function shortId() {
  return crypto.randomBytes(4).toString('hex');
}

// Slugs used in the breadcrumb chip plus the live route paths they map to.
// Kept in lockstep with `client/src/components/freight/cross-tab-breadcrumb.tsx`.
const SURFACES = {
  'available-freight': '/available-freight',
  'lane-work-queue':   '/lanes/work-queue',
  'carrier-hub':       '/carrier-hub',
  'lane-inbox':        '/lane-inbox',
};

const CROSS_PAIRS = [
  { source: 'available-freight', target: 'lane-work-queue' },
  { source: 'lane-work-queue',   target: 'available-freight' },
  { source: 'lane-work-queue',   target: 'carrier-hub' },
  { source: 'carrier-hub',       target: 'lane-inbox' },
  { source: 'lane-inbox',        target: 'available-freight' },
  { source: 'lane-inbox',        target: 'lane-work-queue' },
];

let seeded = null;

test.beforeAll(async () => {
  // Resolve the dev-bypass user's org and a company in that org so seeds
  // attach to the same workspace the in-app session will see.
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

  // Pick another assignable user (different from the bypass user) so we can
  // exercise an owner change in the Lane Work Queue assign dropdown.
  const others = await pool.query(
    `SELECT id, name, role FROM users
       WHERE organization_id = $1
         AND id <> $2
         AND role IN ('account_manager', 'logistics_manager', 'logistics_coordinator', 'sales')
       ORDER BY name LIMIT 1`,
    [orgId, DEV_AUTH_BYPASS_USER_ID],
  );
  if (others.rowCount === 0) throw new Error('no second assignable user in dev org');
  const otherUser = others.rows[0];

  // Seed an unassigned recurring lane the rep can self-assign in the UI.
  // We use a stamped, suite-unique `company_name` (free-text on the lane
  // and cache rows) so the seeded lane lands in its OWN customer group in
  // the LWQ — keeps assertions isolated from any other manual lanes that
  // may already exist for the real company. The `company_id` still points
  // to a real company so any FK joins continue to work.
  // The Lane Work Queue reads from `lane_summary_cache` on the fast path —
  // without a matching cache row the lane never surfaces, even when its
  // recurring_lanes row is fully populated. Insert both.
  // We seed two independent lanes — one per SSE test scenario — so the two
  // assignment tests can execute in PARALLEL workers without trampling each
  // other's state. Each lane lives in its OWN stamped customer group so
  // assertions stay isolated from each other and from any pre-existing
  // manual lanes for the real company.
  async function seedLane(suffix) {
    const stamp = `${shortId()}-${suffix}`;
    const laneId = `lane-e2e-${stamp}`;
    const origin = `OriginCity-${stamp}`;
    const destination = `DestCity-${stamp}`;
    const companyName = `E2E Customer ${stamp}`;
    await pool.query(
      `INSERT INTO recurring_lanes
         (id, org_id, company_id, company_name, origin, origin_state,
          destination, destination_state, equipment_type, avg_loads_per_week,
          is_eligible, is_manual)
       VALUES ($1, $2, $3, $4, $5, 'GA', $6, 'TX', 'Reefer', 3, true, true)`,
      [laneId, orgId, company.id, companyName, origin, destination],
    );
    await pool.query(
      `INSERT INTO lane_summary_cache
         (lane_id, org_id, company_id, company_name, origin, origin_state,
          destination, destination_state, equipment_type, avg_loads_per_week,
          is_eligible, is_manual, lane_score, priority,
          carriers_contacted_count, contactable_count, total_bench_count,
          historical_count, missing_contact_count)
       VALUES ($1, $2, $3, $4, $5, 'GA', $6, 'TX', 'Reefer', 3,
               true, true, 100, 100, 0, 5, 5, 0, 0)`,
      [laneId, orgId, company.id, companyName, origin, destination],
    );
    return { laneId, origin, destination, companyName };
  }

  const assignSeed = await seedLane('a');
  const reassignSeed = await seedLane('r');

  seeded = {
    orgId,
    companyId: company.id,
    otherUser, // { id, name, role }
    assign: assignSeed,
    reassign: reassignSeed,
  };
});

test.afterAll(async () => {
  // NOTE: do NOT call `pool.end()` here. Playwright shares a single test file
  // across multiple workers in this run, and worker-process reuse can lead
  // to a second `beforeAll` invocation on the same module instance. Ending
  // the pool would crash subsequent setup with "Cannot use a pool after
  // calling end on the pool". The worker process exits cleanly without the
  // explicit close.
  const laneIds = [seeded?.assign?.laneId, seeded?.reassign?.laneId].filter(Boolean);
  for (const laneId of laneIds) {
    // outreach logs cascade off the lane via FK ON DELETE SET NULL — clean
    // them explicitly so re-runs of the suite don't leave inbox spam behind.
    await pool.query(`DELETE FROM carrier_outreach_logs WHERE lane_id = $1`, [laneId]);
    await pool.query(`DELETE FROM tasks WHERE lane_context->>'laneId' = $1`, [laneId]).catch(() => {});
    await pool.query(`DELETE FROM notifications WHERE related_id = $1`, [laneId]).catch(() => {});
    await pool.query(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]);
  }
  // pool.end() intentionally skipped — see comment above.
});

async function gotoAuth(page, url) {
  // Each test asserts its own page-mounted signal (breadcrumb element,
  // page testid, or query response) — no need to block on a generic
  // sidebar selector here, which only adds serial wait overhead under
  // parallel worker contention.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

test.describe('Cross-tab breadcrumb contract', () => {
  test.setTimeout(60_000);

  for (const { source, target } of CROSS_PAIRS) {
    test(`${source} → ${target}: breadcrumb renders + back-link restores fromQuery`, async ({ page }) => {
      // A representative non-trivial source query so we can verify it round-trips.
      const sourceQuery = 'highFreq=1&customer=AcmeCo';
      const url = `${SURFACES[target]}?from=${source}&fromQuery=${encodeURIComponent(sourceQuery)}`;
      await gotoAuth(page, url);

      const crumb = page.locator(`[data-testid="breadcrumb-cross-tab-${target}"]`);
      await expect(crumb).toBeVisible({ timeout: 15_000 });

      const back = page.locator(`[data-testid="breadcrumb-link-${source}"]`);
      await expect(back).toBeVisible();
      const href = await back.getAttribute('href');
      expect(href).not.toBeNull();
      // The back href is `${sourcePath}?${fromQuery}` exactly — no extra
      // `from=`/`fromQuery=` should leak back onto the source URL.
      expect(href).toContain(SURFACES[source]);
      expect(href).toContain(sourceQuery);
      expect(href).not.toContain('from=');
      expect(href).not.toContain('fromQuery=');

      // The trailing crumb is the current surface — non-clickable label.
      const current = page.locator(`[data-testid="breadcrumb-current-${target}"]`);
      await expect(current).toBeVisible();
    });
  }

  for (const slug of Object.keys(SURFACES)) {
    test(`${slug}: direct visit (no ?from=) renders no breadcrumb`, async ({ page }) => {
      await gotoAuth(page, SURFACES[slug]);
      // Allow a short settle so a slow mount doesn't false-pass; we don't
      // need full networkidle because the breadcrumb mounts synchronously
      // from window.location.search and never depends on data fetches.
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
      const crumb = page.locator(`[data-testid="breadcrumb-cross-tab-${slug}"]`);
      expect(await crumb.count()).toBe(0);
    });
  }
});

test.describe('Lane Work Queue filter persistence', () => {
  test.setTimeout(45_000);

  test('?highFreq=1&manual=1&customer=X lights the matching filter pills', async ({ page }) => {
    // Either seeded customer is fine — chips render purely off URL state.
    const customer = seeded.assign.companyName;
    await gotoAuth(
      page,
      `/lanes/work-queue?highFreq=1&manual=1&customer=${encodeURIComponent(customer)}`,
    );

    // The active-filter chips only render when the filter is set, so their
    // mere presence proves the URL was honored on first paint.
    await expect(page.locator('[data-testid="chip-filter-high-freq"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="chip-filter-manual"]')).toBeVisible();
    await expect(page.locator('[data-testid="chip-filter-customer"]')).toBeVisible();
    await expect(page.locator('[data-testid="btn-clear-all-filters"]')).toBeVisible();

    // Clearing wipes the URL — verifies the bidirectional URL ↔ state sync.
    await page.locator('[data-testid="btn-clear-all-filters"]').click();
    await expect.poll(() => new URL(page.url()).search, { timeout: 5_000 }).toBe('');
    expect(await page.locator('[data-testid="chip-filter-high-freq"]').count()).toBe(0);
    expect(await page.locator('[data-testid="chip-filter-manual"]').count()).toBe(0);
    expect(await page.locator('[data-testid="chip-filter-customer"]').count()).toBe(0);
  });
});

test.describe('Lane assignment + SSE cross-tab sync', () => {
  // Each test owns its own seeded lane (`seeded.assign` vs `seeded.reassign`)
  // so they can safely run in parallel workers.
  test.setTimeout(60_000);

  test('assigning a lane in one tab updates a second LWQ tab via SSE', async ({ browser }) => {
    // Two independent contexts → two independent SSE subscriptions, one shared
    // org channel. Same dev-bypass user on both so they receive the broadcast.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const lane = seeded.assign;
    try {
      // Filter both pages to the seeded customer so the seeded lane is the
      // only one in view — keeps assertions quick and deterministic.
      const lwqUrl = `/lanes/work-queue?customer=${encodeURIComponent(lane.companyName)}`;
      await gotoAuth(pageA, lwqUrl);
      await gotoAuth(pageB, lwqUrl);

      // Pre-condition: the seeded customer's group must show up under
      // `bucket-unassigned` on both tabs (lane has no owner yet). The
      // group is the unique marker because we seeded a stamped customer
      // name with a single lane.
      const unassignedGroupOnA = pageA.locator(
        `[data-testid="bucket-unassigned"] [data-testid="customer-group-${lane.companyName}"]`,
      );
      const unassignedGroupOnB = pageB.locator(
        `[data-testid="bucket-unassigned"] [data-testid="customer-group-${lane.companyName}"]`,
      );
      await expect(unassignedGroupOnA).toBeVisible({ timeout: 15_000 });
      await expect(unassignedGroupOnB).toBeVisible({ timeout: 15_000 });

      // Expand the group on page A so we can click the row's assign dropdown.
      // (Page B doesn't need to be expanded — we assert at the group level.)
      await pageA
        .locator(`[data-testid="customer-group-toggle-${lane.companyName}"]`)
        .first()
        .click();
      const rowA = pageA.locator(`[data-testid="work-queue-row-${lane.laneId}"]`);
      await expect(rowA).toBeVisible({ timeout: 10_000 });

      // Page A: open the assign dropdown and pick the OTHER user. The
      // dev-bypass user is `admin` so the manager-only assign-to-other path
      // is allowed.
      const assignBtn = pageA.locator(`[data-testid="btn-assign-to-${lane.laneId}"]`);
      await expect(assignBtn).toBeVisible({ timeout: 10_000 });
      await assignBtn.click();
      const option = pageA.locator(
        `[data-testid="assign-option-${lane.laneId}-${seeded.otherUser.id}"]`,
      );
      await expect(option).toBeVisible({ timeout: 5_000 });
      await option.click();

      // Page B's SSE subscription should receive the `recurring_lane`
      // broadcast and invalidate the work-queue query. Once the refetch
      // resolves, the seeded customer's group is no longer in the
      // unassigned bucket — the lane has moved out to the new owner's
      // assigned-untouched bucket. No manual reload required.
      await expect
        .poll(() => unassignedGroupOnB.count(), {
          timeout: 20_000,
          message: 'page B never observed the lane leave the unassigned bucket after SSE',
        })
        .toBe(0);

      // Sanity — same on page A (the local mutation onSuccess invalidates
      // the same query, so this should resolve immediately).
      await expect.poll(() => unassignedGroupOnA.count(), { timeout: 10_000 }).toBe(0);
    } finally {
      await ctxA.close();
      await ctxB.close();
      // Clean the lane back to unassigned so the suite is repeatable.
      await pool.query(
        `UPDATE recurring_lanes SET owner_user_id = NULL, assigned_at = NULL,
                                    assigned_by_user_id = NULL WHERE id = $1`,
        [lane.laneId],
      );
    }
  });

  test('reassignment PATCH surfaces a "Lane reassigned" row in an open Lane Inbox via SSE', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const lane = seeded.reassign;

    try {
      // Pre-condition: lane already has an owner so PATCH can detect a
      // genuine ownership *change* (which is what writes the "reassignment"
      // outreach log + fires the SSE).
      await pool.query(
        `UPDATE recurring_lanes SET owner_user_id = $2 WHERE id = $1`,
        [lane.laneId, DEV_AUTH_BYPASS_USER_ID],
      );

      // Page A: Lane Inbox open. The page testid renders only after the
      // initial inbox query resolves, so seeing it implies the React Query
      // observer is mounted and ready to receive the SSE-driven invalidation
      // that the PATCH will trigger downstream.
      await gotoAuth(pageA, '/lane-inbox');
      await expect(
        pageA.locator('[data-testid="page-lane-inbox"]'),
      ).toBeVisible({ timeout: 30_000 });

      // Issue the reassignment PATCH from a *separate* request context so we
      // genuinely simulate "another tab / another rep" doing the change.
      // Same dev-bypass user → same org → SSE channel reaches page A.
      const requestCtx = await playwrightRequest.newContext({ baseURL: BASE_URL });
      const patchResp = await requestCtx.patch(
        `/api/recurring-lanes/${lane.laneId}`,
        { data: { ownerUserId: seeded.otherUser.id } },
      );
      expect(
        patchResp.ok(),
        `PATCH /api/recurring-lanes/${lane.laneId} failed (${patchResp.status()})`,
      ).toBe(true);
      await requestCtx.dispose();

      // Confirm the audit log was written server-side (defense in depth — if
      // the inbox poll never appears we want to know whether the write
      // happened or the SSE pipe is broken).
      await expect.poll(async () => {
        const r = await pool.query(
          `SELECT COUNT(*)::int AS n FROM carrier_outreach_logs
            WHERE lane_id = $1 AND outreach_mode = 'reassignment'`,
          [lane.laneId],
        );
        return r.rows[0].n;
      }, { timeout: 5_000 }).toBeGreaterThan(0);

      // Page A's open Lane Inbox should refetch via SSE (the recurring_lane
      // topic invalidates the inbox query) and surface a new "Lane
      // reassigned" row WITHOUT a manual reload. The lane-inbox payload
      // uses `outreach:<logId>` ids — match by row title.
      const reassignedRow = pageA
        .locator('[data-testid^="row-inbox-outreach:"]')
        .filter({ hasText: 'Lane reassigned' });
      await expect(reassignedRow.first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctxA.close();
      await pool.query(`DELETE FROM carrier_outreach_logs WHERE lane_id = $1`, [lane.laneId]);
      await pool.query(
        `UPDATE recurring_lanes SET owner_user_id = NULL, assigned_at = NULL,
                                    assigned_by_user_id = NULL WHERE id = $1`,
        [lane.laneId],
      );
    }
  });
});
