# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/lane-system-e2e.spec.cjs >> Lane assignment + SSE cross-tab sync >> assigning a lane in one tab updates a second LWQ tab via SSE
- Location: tests/lane-system-e2e.spec.cjs:314:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('[data-testid="bucket-unassigned"] [data-testid="customer-group-E2E Customer ec4f7e65-a"]')
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
  - waiting for locator('[data-testid="bucket-unassigned"] [data-testid="customer-group-E2E Customer ec4f7e65-a"]')

```

# Test source

```ts
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
  250 |       await expect(crumb).toBeVisible({ timeout: 15_000 });
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
> 340 |       await expect(unassignedGroupOnA).toBeVisible({ timeout: 15_000 });
      |                                        ^ Error: expect(locator).toBeVisible() failed
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
  351 | 
  352 |       // Page A: open the assign dropdown and pick the OTHER user. The
  353 |       // dev-bypass user is `admin` so the manager-only assign-to-other path
  354 |       // is allowed.
  355 |       const assignBtn = pageA.locator(`[data-testid="btn-assign-to-${lane.laneId}"]`);
  356 |       await expect(assignBtn).toBeVisible({ timeout: 10_000 });
  357 |       await assignBtn.click();
  358 |       const option = pageA.locator(
  359 |         `[data-testid="assign-option-${lane.laneId}-${seeded.otherUser.id}"]`,
  360 |       );
  361 |       await expect(option).toBeVisible({ timeout: 5_000 });
  362 |       await option.click();
  363 | 
  364 |       // Page B's SSE subscription should receive the `recurring_lane`
  365 |       // broadcast and invalidate the work-queue query. Once the refetch
  366 |       // resolves, the seeded customer's group is no longer in the
  367 |       // unassigned bucket — the lane has moved out to the new owner's
  368 |       // assigned-untouched bucket. No manual reload required.
  369 |       await expect
  370 |         .poll(() => unassignedGroupOnB.count(), {
  371 |           timeout: 20_000,
  372 |           message: 'page B never observed the lane leave the unassigned bucket after SSE',
  373 |         })
  374 |         .toBe(0);
  375 | 
  376 |       // Sanity — same on page A (the local mutation onSuccess invalidates
  377 |       // the same query, so this should resolve immediately).
  378 |       await expect.poll(() => unassignedGroupOnA.count(), { timeout: 10_000 }).toBe(0);
  379 |     } finally {
  380 |       await ctxA.close();
  381 |       await ctxB.close();
  382 |       // Clean the lane back to unassigned so the suite is repeatable.
  383 |       await pool.query(
  384 |         `UPDATE recurring_lanes SET owner_user_id = NULL, assigned_at = NULL,
  385 |                                     assigned_by_user_id = NULL WHERE id = $1`,
  386 |         [lane.laneId],
  387 |       );
  388 |     }
  389 |   });
  390 | 
  391 |   test('reassignment PATCH surfaces a "Lane reassigned" row in an open Lane Inbox via SSE', async ({ browser }) => {
  392 |     const ctxA = await browser.newContext();
  393 |     const pageA = await ctxA.newPage();
  394 |     const lane = seeded.reassign;
  395 | 
  396 |     try {
  397 |       // Pre-condition: lane already has an owner so PATCH can detect a
  398 |       // genuine ownership *change* (which is what writes the "reassignment"
  399 |       // outreach log + fires the SSE).
  400 |       await pool.query(
  401 |         `UPDATE recurring_lanes SET owner_user_id = $2 WHERE id = $1`,
  402 |         [lane.laneId, DEV_AUTH_BYPASS_USER_ID],
  403 |       );
  404 | 
  405 |       // Page A: Lane Inbox open. The page testid renders only after the
  406 |       // initial inbox query resolves, so seeing it implies the React Query
  407 |       // observer is mounted and ready to receive the SSE-driven invalidation
  408 |       // that the PATCH will trigger downstream.
  409 |       await gotoAuth(pageA, '/lane-inbox');
  410 |       await expect(
  411 |         pageA.locator('[data-testid="page-lane-inbox"]'),
  412 |       ).toBeVisible({ timeout: 30_000 });
  413 | 
  414 |       // Issue the reassignment PATCH from a *separate* request context so we
  415 |       // genuinely simulate "another tab / another rep" doing the change.
  416 |       // Same dev-bypass user → same org → SSE channel reaches page A.
  417 |       const requestCtx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  418 |       const patchResp = await requestCtx.patch(
  419 |         `/api/recurring-lanes/${lane.laneId}`,
  420 |         { data: { ownerUserId: seeded.otherUser.id } },
  421 |       );
  422 |       expect(
  423 |         patchResp.ok(),
  424 |         `PATCH /api/recurring-lanes/${lane.laneId} failed (${patchResp.status()})`,
  425 |       ).toBe(true);
  426 |       await requestCtx.dispose();
  427 | 
  428 |       // Confirm the audit log was written server-side (defense in depth — if
  429 |       // the inbox poll never appears we want to know whether the write
  430 |       // happened or the SSE pipe is broken).
  431 |       await expect.poll(async () => {
  432 |         const r = await pool.query(
  433 |           `SELECT COUNT(*)::int AS n FROM carrier_outreach_logs
  434 |             WHERE lane_id = $1 AND outreach_mode = 'reassignment'`,
  435 |           [lane.laneId],
  436 |         );
  437 |         return r.rows[0].n;
  438 |       }, { timeout: 5_000 }).toBeGreaterThan(0);
  439 | 
  440 |       // Page A's open Lane Inbox should refetch via SSE (the recurring_lane
```