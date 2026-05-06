# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/lane-system-e2e.spec.cjs >> Cross-tab breadcrumb contract >> available-freight → lane-work-queue: breadcrumb renders + back-link restores fromQuery
- Location: tests/lane-system-e2e.spec.cjs:243:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('[data-testid="breadcrumb-cross-tab-lane-work-queue"]')
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
  - waiting for locator('[data-testid="breadcrumb-cross-tab-lane-work-queue"]')

```

# Test source

```ts
  150 |     // Task #889 — for the cockpit-keyboard test, also seed a freight
  151 |     // opportunity that shares the lane signature so BOTH faces of the
  152 |     // cockpit (recurring + live) have data to render. Status must be one
  153 |     // of OPEN_OPP_STATUSES (see server/routes/laneCockpit.ts) for the
  154 |     // live half to surface it.
  155 |     let oppId = null;
  156 |     if (withLiveOpp) {
  157 |       const pickup = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  158 |       const r = await pool.query(
  159 |         `INSERT INTO freight_opportunities
  160 |            (org_id, company_id, mode, origin, origin_state, destination, destination_state,
  161 |             equipment_type, pickup_window_start, pickup_window_end, status, urgency_score,
  162 |             owner_user_id, notes)
  163 |          VALUES ($1, $2, 'exact_load', $3, 'GA', $4, 'TX', 'Reefer', $5, $5,
  164 |                  'ready_to_send', 999, $6, $7)
  165 |          RETURNING id`,
  166 |         [orgId, company.id, origin, destination, pickup, DEV_AUTH_BYPASS_USER_ID,
  167 |          `e2e-cockpit-${stamp}`],
  168 |       );
  169 |       oppId = r.rows[0].id;
  170 |     }
  171 |     // Canonical lane signature the cockpit endpoint expects: the same
  172 |     // lower-cased pipe-joined string the LWQ + AF pages build before
  173 |     // calling /api/lanes/cockpit.
  174 |     const signature = [
  175 |       origin.toLowerCase(),
  176 |       'ga',
  177 |       destination.toLowerCase(),
  178 |       'tx',
  179 |       'reefer',
  180 |     ].join('|');
  181 |     return { laneId, origin, destination, companyName, oppId, signature };
  182 |   }
  183 | 
  184 |   const assignSeed = await seedLane('a');
  185 |   const reassignSeed = await seedLane('r');
  186 |   // Task #889 — dedicated lane + matching live opp for the L-key test.
  187 |   // Kept separate from the assign/reassign seeds so those tests can
  188 |   // freely mutate ownership without affecting the cockpit assertions.
  189 |   const cockpitSeed = await seedLane('c', { withLiveOpp: true });
  190 | 
  191 |   seeded = {
  192 |     orgId,
  193 |     companyId: company.id,
  194 |     otherUser, // { id, name, role }
  195 |     assign: assignSeed,
  196 |     reassign: reassignSeed,
  197 |     cockpit: cockpitSeed,
  198 |   };
  199 | });
  200 | 
  201 | test.afterAll(async () => {
  202 |   // NOTE: do NOT call `pool.end()` here. Playwright shares a single test file
  203 |   // across multiple workers in this run, and worker-process reuse can lead
  204 |   // to a second `beforeAll` invocation on the same module instance. Ending
  205 |   // the pool would crash subsequent setup with "Cannot use a pool after
  206 |   // calling end on the pool". The worker process exits cleanly without the
  207 |   // explicit close.
  208 |   // Task #889 — drop the matching live opp first so the deletion of its
  209 |   // recurring lane below doesn't leave an orphan freight_opportunity
  210 |   // hanging around.
  211 |   const oppIds = [seeded?.cockpit?.oppId].filter(Boolean);
  212 |   for (const oppId of oppIds) {
  213 |     await pool.query(`DELETE FROM freight_opportunities WHERE id = $1`, [oppId]).catch(() => {});
  214 |   }
  215 |   const laneIds = [
  216 |     seeded?.assign?.laneId,
  217 |     seeded?.reassign?.laneId,
  218 |     seeded?.cockpit?.laneId,
  219 |   ].filter(Boolean);
  220 |   for (const laneId of laneIds) {
  221 |     // outreach logs cascade off the lane via FK ON DELETE SET NULL — clean
  222 |     // them explicitly so re-runs of the suite don't leave inbox spam behind.
  223 |     await pool.query(`DELETE FROM carrier_outreach_logs WHERE lane_id = $1`, [laneId]);
  224 |     await pool.query(`DELETE FROM tasks WHERE lane_context->>'laneId' = $1`, [laneId]).catch(() => {});
  225 |     await pool.query(`DELETE FROM notifications WHERE related_id = $1`, [laneId]).catch(() => {});
  226 |     await pool.query(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]);
  227 |   }
  228 |   // pool.end() intentionally skipped — see comment above.
  229 | });
  230 | 
  231 | async function gotoAuth(page, url) {
  232 |   // Each test asserts its own page-mounted signal (breadcrumb element,
  233 |   // page testid, or query response) — no need to block on a generic
  234 |   // sidebar selector here, which only adds serial wait overhead under
  235 |   // parallel worker contention.
  236 |   await page.goto(url, { waitUntil: 'domcontentloaded' });
  237 | }
  238 | 
  239 | test.describe('Cross-tab breadcrumb contract', () => {
  240 |   test.setTimeout(60_000);
  241 | 
  242 |   for (const { source, target } of CROSS_PAIRS) {
  243 |     test(`${source} → ${target}: breadcrumb renders + back-link restores fromQuery`, async ({ page }) => {
  244 |       // A representative non-trivial source query so we can verify it round-trips.
  245 |       const sourceQuery = 'highFreq=1&customer=AcmeCo';
  246 |       const url = `${SURFACES[target]}?from=${source}&fromQuery=${encodeURIComponent(sourceQuery)}`;
  247 |       await gotoAuth(page, url);
  248 | 
  249 |       const crumb = page.locator(`[data-testid="breadcrumb-cross-tab-${target}"]`);
> 250 |       await expect(crumb).toBeVisible({ timeout: 15_000 });
      |                           ^ Error: expect(locator).toBeVisible() failed
  251 | 
  252 |       const back = page.locator(`[data-testid="breadcrumb-link-${source}"]`);
  253 |       await expect(back).toBeVisible();
  254 |       const href = await back.getAttribute('href');
  255 |       expect(href).not.toBeNull();
  256 |       // The back href is `${sourcePath}?${fromQuery}` exactly — no extra
  257 |       // `from=`/`fromQuery=` should leak back onto the source URL.
  258 |       expect(href).toContain(SURFACES[source]);
  259 |       expect(href).toContain(sourceQuery);
  260 |       expect(href).not.toContain('from=');
  261 |       expect(href).not.toContain('fromQuery=');
  262 | 
  263 |       // The trailing crumb is the current surface — non-clickable label.
  264 |       const current = page.locator(`[data-testid="breadcrumb-current-${target}"]`);
  265 |       await expect(current).toBeVisible();
  266 |     });
  267 |   }
  268 | 
  269 |   for (const slug of Object.keys(SURFACES)) {
  270 |     test(`${slug}: direct visit (no ?from=) renders no breadcrumb`, async ({ page }) => {
  271 |       await gotoAuth(page, SURFACES[slug]);
  272 |       // Allow a short settle so a slow mount doesn't false-pass; we don't
  273 |       // need full networkidle because the breadcrumb mounts synchronously
  274 |       // from window.location.search and never depends on data fetches.
  275 |       await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
  276 |       const crumb = page.locator(`[data-testid="breadcrumb-cross-tab-${slug}"]`);
  277 |       expect(await crumb.count()).toBe(0);
  278 |     });
  279 |   }
  280 | });
  281 | 
  282 | test.describe('Lane Work Queue filter persistence', () => {
  283 |   test.setTimeout(45_000);
  284 | 
  285 |   test('?highFreq=1&manual=1&customer=X lights the matching filter pills', async ({ page }) => {
  286 |     // Either seeded customer is fine — chips render purely off URL state.
  287 |     const customer = seeded.assign.companyName;
  288 |     await gotoAuth(
  289 |       page,
  290 |       `/lanes/work-queue?highFreq=1&manual=1&customer=${encodeURIComponent(customer)}`,
  291 |     );
  292 | 
  293 |     // The active-filter chips only render when the filter is set, so their
  294 |     // mere presence proves the URL was honored on first paint.
  295 |     await expect(page.locator('[data-testid="chip-filter-high-freq"]')).toBeVisible({ timeout: 10_000 });
  296 |     await expect(page.locator('[data-testid="chip-filter-manual"]')).toBeVisible();
  297 |     await expect(page.locator('[data-testid="chip-filter-customer"]')).toBeVisible();
  298 |     await expect(page.locator('[data-testid="btn-clear-all-filters"]')).toBeVisible();
  299 | 
  300 |     // Clearing wipes the URL — verifies the bidirectional URL ↔ state sync.
  301 |     await page.locator('[data-testid="btn-clear-all-filters"]').click();
  302 |     await expect.poll(() => new URL(page.url()).search, { timeout: 5_000 }).toBe('');
  303 |     expect(await page.locator('[data-testid="chip-filter-high-freq"]').count()).toBe(0);
  304 |     expect(await page.locator('[data-testid="chip-filter-manual"]').count()).toBe(0);
  305 |     expect(await page.locator('[data-testid="chip-filter-customer"]').count()).toBe(0);
  306 |   });
  307 | });
  308 | 
  309 | test.describe('Lane assignment + SSE cross-tab sync', () => {
  310 |   // Each test owns its own seeded lane (`seeded.assign` vs `seeded.reassign`)
  311 |   // so they can safely run in parallel workers.
  312 |   test.setTimeout(60_000);
  313 | 
  314 |   test('assigning a lane in one tab updates a second LWQ tab via SSE', async ({ browser }) => {
  315 |     // Two independent contexts → two independent SSE subscriptions, one shared
  316 |     // org channel. Same dev-bypass user on both so they receive the broadcast.
  317 |     const ctxA = await browser.newContext();
  318 |     const ctxB = await browser.newContext();
  319 |     const pageA = await ctxA.newPage();
  320 |     const pageB = await ctxB.newPage();
  321 | 
  322 |     const lane = seeded.assign;
  323 |     try {
  324 |       // Filter both pages to the seeded customer so the seeded lane is the
  325 |       // only one in view — keeps assertions quick and deterministic.
  326 |       const lwqUrl = `/lanes/work-queue?mode=triage&customer=${encodeURIComponent(lane.companyName)}`;
  327 |       await gotoAuth(pageA, lwqUrl);
  328 |       await gotoAuth(pageB, lwqUrl);
  329 | 
  330 |       // Pre-condition: the seeded customer's group must show up under
  331 |       // `bucket-unassigned` on both tabs (lane has no owner yet). The
  332 |       // group is the unique marker because we seeded a stamped customer
  333 |       // name with a single lane.
  334 |       const unassignedGroupOnA = pageA.locator(
  335 |         `[data-testid="bucket-unassigned"] [data-testid="customer-group-${lane.companyName}"]`,
  336 |       );
  337 |       const unassignedGroupOnB = pageB.locator(
  338 |         `[data-testid="bucket-unassigned"] [data-testid="customer-group-${lane.companyName}"]`,
  339 |       );
  340 |       await expect(unassignedGroupOnA).toBeVisible({ timeout: 15_000 });
  341 |       await expect(unassignedGroupOnB).toBeVisible({ timeout: 15_000 });
  342 | 
  343 |       // Expand the group on page A so we can click the row's assign dropdown.
  344 |       // (Page B doesn't need to be expanded — we assert at the group level.)
  345 |       await pageA
  346 |         .locator(`[data-testid="customer-group-toggle-${lane.companyName}"]`)
  347 |         .first()
  348 |         .click();
  349 |       const rowA = pageA.locator(`[data-testid="work-queue-row-${lane.laneId}"]`);
  350 |       await expect(rowA).toBeVisible({ timeout: 10_000 });
```