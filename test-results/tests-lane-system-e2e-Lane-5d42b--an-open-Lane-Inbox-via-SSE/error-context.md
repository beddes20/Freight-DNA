# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/lane-system-e2e.spec.cjs >> Lane assignment + SSE cross-tab sync >> reassignment PATCH surfaces a "Lane reassigned" row in an open Lane Inbox via SSE
- Location: tests/lane-system-e2e.spec.cjs:391:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('[data-testid="page-lane-inbox"]')
Expected: visible
Timeout: 30000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 30000ms
  - waiting for locator('[data-testid="page-lane-inbox"]')

```

# Test source

```ts
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
> 412 |       ).toBeVisible({ timeout: 30_000 });
      |         ^ Error: expect(locator).toBeVisible() failed
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
  441 |       // topic invalidates the inbox query) and surface a new "Lane
  442 |       // reassigned" row WITHOUT a manual reload. The lane-inbox payload
  443 |       // uses `outreach:<logId>` ids — match by row title.
  444 |       const reassignedRow = pageA
  445 |         .locator('[data-testid^="row-inbox-outreach:"]')
  446 |         .filter({ hasText: 'Lane reassigned' });
  447 |       await expect(reassignedRow.first()).toBeVisible({ timeout: 15_000 });
  448 |     } finally {
  449 |       await ctxA.close();
  450 |       await pool.query(`DELETE FROM carrier_outreach_logs WHERE lane_id = $1`, [lane.laneId]);
  451 |       await pool.query(
  452 |         `UPDATE recurring_lanes SET owner_user_id = NULL, assigned_at = NULL,
  453 |                                     assigned_by_user_id = NULL WHERE id = $1`,
  454 |         [lane.laneId],
  455 |       );
  456 |     }
  457 |   });
  458 | });
  459 | 
  460 | // Task #889 — Shift+L opens the Lane Cockpit overlay on both lane
  461 | // surfaces. The shared keyboard registry already has unit coverage for
  462 | // duplicate-detection and dispatch
  463 | // (`client/src/lib/__tests__/sharedLaneKeyboard.test.ts`); this is the
  464 | // missing end-to-end leg that exercises a real page: focus a row →
  465 | // press uppercase L → assert <LaneCockpitSheet> renders and BOTH faces
  466 | // (recurring + live) are wired up against the same lane signature.
  467 | test.describe('Lane Cockpit keyboard (Task #889)', () => {
  468 |   test.setTimeout(60_000);
  469 | 
  470 |   test('LWQ: Shift+L on the focused row opens the cockpit with both faces wired up', async ({ page }) => {
  471 |     const lane = seeded.cockpit;
  472 | 
  473 |     // Filter to the seeded customer so the lane is the only group on the
  474 |     // page — keeps the focus index deterministic regardless of how many
  475 |     // other manual lanes the dev-bypass org carries.
  476 |     await gotoAuth(
  477 |       page,
  478 |       `/lanes/work-queue?mode=triage&customer=${encodeURIComponent(lane.companyName)}`,
  479 |     );
  480 | 
  481 |     // Wait for the seeded lane row to render — it sits under the
  482 |     // `bucket-unassigned` group (no owner) and inside the stamped
  483 |     // customer group container. Task #1028 (LWQ C) puts Unassigned
  484 |     // behind the Triage mode, so we deep-link `?mode=triage`.
  485 |     const row = page.locator(`[data-testid="work-queue-row-${lane.laneId}"]`);
  486 |     // The customer group is collapsed by default; expand it so the row
  487 |     // mounts and the shared keyboard's `next` (j) handler can focus it.
  488 |     const groupToggle = page
  489 |       .locator(`[data-testid="customer-group-toggle-${lane.companyName}"]`)
  490 |       .first();
  491 |     await expect(groupToggle).toBeVisible({ timeout: 15_000 });
  492 |     await groupToggle.click();
  493 |     await expect(row).toBeVisible({ timeout: 10_000 });
  494 | 
  495 |     // Drop focus onto a neutral element first (the page body) so the
  496 |     // shared keyboard listener — which skips INPUT/TEXTAREA/SELECT —
  497 |     // actually fires. Clicking a generic surface area achieves this
  498 |     // without triggering the row's own onClick (which opens a drill).
  499 |     await page.locator('body').click({ position: { x: 5, y: 5 } });
  500 | 
  501 |     // Shared keyboard `next` handler — focuses index 0 (the seeded row).
  502 |     await page.keyboard.press('j');
  503 |     // Uppercase L → cockpit. Shift is the only modifier the registry
  504 |     // tolerates (the hook bails on meta/ctrl/alt).
  505 |     await page.keyboard.press('Shift+L');
  506 | 
  507 |     // The sheet itself + both panes must mount. `data-opened-from="lwq"`
  508 |     // proves the binding fired from this surface (vs e.g. a stale state
  509 |     // from a prior test).
  510 |     const sheet = page.locator('[data-testid="sheet-lane-cockpit"]');
  511 |     await expect(sheet).toBeVisible({ timeout: 10_000 });
  512 |     await expect(sheet).toHaveAttribute('data-opened-from', 'lwq');
```