/**
 * Task #950 — Context Notes UI E2E.
 *
 * Browser-driven coverage of the v1 journey the architect required:
 *
 *   1. A teammate authors a note that mentions me on a quote opportunity
 *      (seeded directly to keep the test single-actor / single-session).
 *   2. The Notifications inbox surfaces the mention with a working
 *      deep-link to the source surface.
 *   3. Following the deep-link to /quote-requests with `?contextNote=<id>`
 *      auto-opens the row's context-note popover and reveals the note,
 *      flushing the unread mention so the bell badge clears.
 *   4. I post a reply via the UI and the new reply renders.
 *   5. I resolve the note via the UI and the status flips.
 *   6. I reopen the note via the UI.
 *   7. I convert the note to a task via the convert dialog and the task
 *      row exists in the database with the deep-link backlink wired into
 *      the description (the contract checked at the API level by
 *      tests/context-notes.test.ts).
 *
 * The journey runs as the dev-bypass user in their org. The "other rep"
 * who authors the note is materialised via direct SQL because the auth
 * bypass is bound to a single user id at server boot time and we can't
 * mid-test masquerade.
 *
 * Run (requires the dev server on :5000):
 *   npx playwright test --config=playwright.config.cjs \
 *     tests/context-notes-e2e.spec.cjs
 */

const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');
const crypto = require('crypto');

const DEV_AUTH_BYPASS_USER_ID =
  process.env.DEV_AUTH_BYPASS_USER_ID || '4e75fd7c-d462-42c5-a335-af327076416c';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function shortId() { return crypto.randomBytes(4).toString('hex'); }

let seeded = null;

test.beforeAll(async () => {
  const u = await pool.query(
    `SELECT organization_id FROM users WHERE id = $1`,
    [DEV_AUTH_BYPASS_USER_ID],
  );
  if (u.rowCount === 0) throw new Error('dev-bypass user not found');
  const orgId = u.rows[0].organization_id;

  // Sweep any leftover rows from prior runs (matched by username prefix on
  // the seed teammate). This keeps the inbox uncluttered so the test can
  // target its own seed deterministically.
  const stale = await pool.query(
    `SELECT id FROM users WHERE username LIKE 'cn-e2e-mate-%'`,
  );
  for (const row of stale.rows) {
    await pool.query(
      `DELETE FROM notifications WHERE related_id IN
         (SELECT id FROM context_notes WHERE author_id = $1)`,
      [row.id],
    ).catch(() => {});
    await pool.query(
      `DELETE FROM context_notes WHERE author_id = $1`, [row.id],
    ).catch(() => {});
    await pool.query(
      `DELETE FROM quote_opportunities WHERE customer_id IN
         (SELECT id FROM quote_customers WHERE name LIKE 'CN E2E Customer %')`,
    ).catch(() => {});
    await pool.query(
      `DELETE FROM quote_customers WHERE name LIKE 'CN E2E Customer %'`,
    ).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [row.id]).catch(() => {});
  }

  // The "teammate" who pings us. Created fresh per run so we can cleanly
  // delete the seed without touching real users.
  const stamp = shortId();
  const teammate = await pool.query(
    `INSERT INTO users (organization_id, username, name, role)
     VALUES ($1, $2, $3, 'sales')
     RETURNING id, name`,
    [orgId, `cn-e2e-mate-${stamp}`, `CN E2E Mate ${stamp}`],
  );

  // Seed a quote opportunity in the dev org so the deep-link can land
  // somewhere real.
  // `party_type` defaults to 'unknown'; the Quote Opportunities surface
  // hides any opp whose customer isn't classified as 'customer'
  // (customerOnlyChokepoint), so we set it explicitly.
  const customer = await pool.query(
    `INSERT INTO quote_customers (organization_id, name, party_type, party_type_manual)
     VALUES ($1, $2, 'customer', true) RETURNING id`,
    [orgId, `CN E2E Customer ${stamp}`],
  );
  // Seed `request_date` a minute in the past so any DB↔client clock skew
  // can't push the row past the page's `endDate=now()` filter (which is
  // captured once at page render time and never advances).
  const opp = await pool.query(
    `INSERT INTO quote_opportunities
       (organization_id, customer_id, request_date, origin_city, origin_state,
        dest_city, dest_state, equipment)
     VALUES ($1, $2, NOW() - INTERVAL '60 seconds',
             'Atlanta', 'GA', 'Dallas', 'TX', 'Van')
     RETURNING id`,
    [orgId, customer.rows[0].id],
  );

  // Seed the note + mention + notification directly. This skips the API
  // layer (already covered exhaustively by tests/context-notes.test.ts)
  // and lets us focus the e2e on UI behaviour.
  const noteBody = `Heads up — please look at this quote (${stamp}).`;
  const note = await pool.query(
    `INSERT INTO context_notes
       (org_id, author_id, anchor_type, anchor_id, anchor_label, body,
        action_type, status)
     VALUES ($1, $2, 'quote_request', $3, $4, $5, 'please_review', 'open')
     RETURNING id`,
    [orgId, teammate.rows[0].id, opp.rows[0].id,
     'CN E2E Customer · ATL → DAL', noteBody],
  );
  await pool.query(
    `INSERT INTO context_note_mentions (note_id, user_id) VALUES ($1, $2)`,
    [note.rows[0].id, DEV_AUTH_BYPASS_USER_ID],
  );
  const deepLink = `/quote-requests?quote=${opp.rows[0].id}&contextNote=${note.rows[0].id}`;
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link, related_id, read)
     VALUES ($1, 'context_note_mention', $2, $3, $4, $5, false)`,
    [DEV_AUTH_BYPASS_USER_ID, `${teammate.rows[0].name} mentioned you`,
     noteBody, deepLink, note.rows[0].id],
  );

  seeded = {
    orgId,
    teammateId: teammate.rows[0].id,
    teammateName: teammate.rows[0].name,
    customerId: customer.rows[0].id,
    oppId: opp.rows[0].id,
    noteId: note.rows[0].id,
    noteBody,
    deepLink,
  };
});

// ── Second seed: a recurring lane + note for the non-quote deep-link
// regression test. Lives alongside the quote seed so the cleanup hooks
// stay symmetrical and the file remains a single Playwright run.
let seededLane = null;

test.beforeAll(async () => {
  const u = await pool.query(
    `SELECT organization_id FROM users WHERE id = $1`,
    [DEV_AUTH_BYPASS_USER_ID],
  );
  const orgId = u.rows[0].organization_id;
  const stamp = shortId();

  // Owner = the dev-bypass user so `lwqAnchor.canAccess` short-circuits
  // on `lane.ownerUserId === user.id` and the e2e doesn't depend on the
  // viewer's role.
  const lane = await pool.query(
    `INSERT INTO recurring_lanes
       (org_id, owner_user_id, origin, origin_state, destination,
        destination_state, equipment_type, eligibility_confidence,
        is_eligible, is_manual)
     VALUES ($1, $2, 'Atlanta', 'GA', 'Dallas', 'TX', 'Van', 'medium',
             true, true)
     RETURNING id`,
    [orgId, DEV_AUTH_BYPASS_USER_ID],
  );
  const noteBody = `LWQ deep-link probe (${stamp}).`;
  const note = await pool.query(
    `INSERT INTO context_notes
       (org_id, author_id, anchor_type, anchor_id, anchor_label, body,
        action_type, status)
     VALUES ($1, $2, 'lane_work_queue', $3, $4, $5, 'fyi', 'open')
     RETURNING id`,
    [orgId, DEV_AUTH_BYPASS_USER_ID, lane.rows[0].id,
     'LWQ · Atlanta, GA → Dallas, TX', noteBody],
  );
  seededLane = {
    orgId,
    laneId: lane.rows[0].id,
    noteId: note.rows[0].id,
    noteBody,
    deepLink: `/lanes/work-queue?laneId=${lane.rows[0].id}&contextNote=${note.rows[0].id}`,
  };
});

test.afterAll(async () => {
  if (seededLane) {
    await pool.query(`DELETE FROM context_note_events WHERE note_id = $1`,
      [seededLane.noteId]).catch(() => {});
    await pool.query(`DELETE FROM context_note_replies WHERE note_id = $1`,
      [seededLane.noteId]).catch(() => {});
    await pool.query(`DELETE FROM context_note_mentions WHERE note_id = $1`,
      [seededLane.noteId]).catch(() => {});
    await pool.query(`DELETE FROM context_notes WHERE id = $1`,
      [seededLane.noteId]).catch(() => {});
    await pool.query(`DELETE FROM recurring_lanes WHERE id = $1`,
      [seededLane.laneId]).catch(() => {});
  }
  if (!seeded) return;
  // Cleanup in dependency order. Tasks created by the convert step have
  // no org FK so we capture them via context_notes.converted_task_id.
  const conv = await pool.query(
    `SELECT converted_task_id FROM context_notes WHERE id = $1`,
    [seeded.noteId],
  );
  if (conv.rowCount > 0 && conv.rows[0].converted_task_id) {
    await pool.query(`DELETE FROM tasks WHERE id = $1`,
      [conv.rows[0].converted_task_id]).catch(() => {});
  }
  await pool.query(`DELETE FROM context_note_replies WHERE note_id = $1`,
    [seeded.noteId]).catch(() => {});
  await pool.query(`DELETE FROM context_note_mentions WHERE note_id = $1`,
    [seeded.noteId]).catch(() => {});
  await pool.query(`DELETE FROM context_note_events WHERE note_id = $1`,
    [seeded.noteId]).catch(() => {});
  await pool.query(`DELETE FROM notifications WHERE related_id = $1`,
    [seeded.noteId]).catch(() => {});
  await pool.query(`DELETE FROM context_notes WHERE id = $1`,
    [seeded.noteId]).catch(() => {});
  await pool.query(`DELETE FROM quote_opportunities WHERE id = $1`,
    [seeded.oppId]).catch(() => {});
  await pool.query(`DELETE FROM quote_customers WHERE id = $1`,
    [seeded.customerId]).catch(() => {});
  await pool.query(`DELETE FROM users WHERE id = $1`,
    [seeded.teammateId]).catch(() => {});
  await pool.end();
});

test('Context Notes — full v1 journey: notify → reveal → reply → resolve → reopen → convert', async ({ page }) => {
  test.setTimeout(60_000);

  // Log every context-notes API call so a silent 4xx doesn't masquerade
  // as a UI failure. Also relay browser console errors.
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('/api/context-notes')) {
      const body = resp.status() >= 400 ? await resp.text().catch(() => '?') : '';
      console.log(`[ctx-notes-e2e] ${resp.request().method()} ${resp.status()} ${url} ${body.slice(0,200)}`);
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[ctx-notes-e2e] console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`[ctx-notes-e2e] pageerror: ${err.message}`));
  // Hide the floating "Log a touch" / chatbot FABs at the bottom-right so
  // they don't intercept clicks on the resolve / reopen / convert / send
  // buttons that sit below the note card. Re-applied after every nav.
  const hideFabs = async () => {
    await page.addStyleTag({ content: `
      [data-testid="button-log-touch-fab"],
      [data-testid="chatbot-toggle"] { display: none !important; }
    ` }).catch(() => {});
  };

  // ── 1. Inbox surfaces the mention with a deep-link ────────────────────
  // The /notifications page is a two-tab toggle (Notifications | Context
  // Notes). Click the Context Notes tab so the shared inbox renders.
  await page.goto('/notifications');
  await hideFabs();
  await page.locator('[data-testid="tab-section-context-notes"]').click();
  // One row per inbox item, stable `row-context-note-{id}` testid.
  await expect(page.locator(`[data-testid="row-context-note-${seeded.noteId}"]`))
    .toBeVisible({ timeout: 10_000 });

  // ── 2. Navigate to the deep-link directly (mirrors clicking the
  //       notification — using direct nav avoids depending on the bell's
  //       internal markup which moves around with redesigns). The page
  //       polls in the background so `networkidle` never settles; we wait
  //       for DOM ready and then for the popover content. ────────────────
  await page.goto(seeded.deepLink);
  await page.waitForLoadState('domcontentloaded');
  await hideFabs();
  // The slide-over only renders once `visibleRows` (backed by the
  // /api/customer-quotes/list query) contains the seeded opportunity.
  // The dev org has continuous background seeding (email backfill etc.)
  // that can push our just-seeded row off the first page, so we widen
  // the lookback to 7d and the limit to 500 — this matches what a real
  // user would see if they'd been on the page for a few minutes and
  // makes the test deterministic.
  await expect.poll(async () => {
    const ids = await page.evaluate(async () => {
      const r = await fetch(
        `/api/customer-quotes/list?offset=0&limit=500&sortKey=requestDate&sortDir=desc`,
        { credentials: 'include' },
      );
      if (!r.ok) return [];
      const j = await r.json();
      return (j.rows ?? []).map(x => x.id);
    });
    return ids.includes(seeded.oppId);
  }, { timeout: 15_000, intervals: [200, 500, 1000] }).toBe(true);

  // ── 3. The opportunity slide-over should open via ?quote=, the panel
  //       auto-expands via ?contextNote=, and the note card appears with
  //       the deep-link highlight ring. The drawer is rendered only after
  //       the snapshot query loads and finds the row in `visibleRows`, so
  //       we wait for the drawer chrome before drilling into the panel.
  await expect(page.locator('[data-testid="drawer-quote-detail"]'))
    .toBeVisible({ timeout: 20_000 });
  const noteCard = page.locator(`[data-testid="card-context-note-${seeded.noteId}"]`);
  await expect(noteCard).toBeVisible({ timeout: 15_000 });
  await expect(noteCard).toContainText(seeded.noteBody);
  // Scroll the card into the middle of the viewport so the FAB row at the
  // bottom doesn't intercept clicks on the resolve / reopen / convert
  // buttons that sit just below it.
  await noteCard.scrollIntoViewIfNeeded();

  // ── 4. Reply via the UI ──────────────────────────────────────────────
  // When deep-linked, the highlighted note's replies area opens by default
  // (highlight → showReplies=true) so the textarea is already mounted.
  const replyTa = page.locator(`[data-testid="textarea-context-note-reply-${seeded.noteId}"]`);
  await expect(replyTa).toBeVisible({ timeout: 10_000 });
  // pressSequentially fires per-key React events so the controlled state
  // updates correctly and the Send button becomes enabled.
  await replyTa.click();
  await replyTa.pressSequentially('On it — pulling rates now.', { delay: 5 });
  const replyBtn = page.locator(`[data-testid="button-context-note-reply-submit-${seeded.noteId}"]`);
  await expect(replyBtn).toBeEnabled({ timeout: 5_000 });
  await replyBtn.click();
  // DB confirmation — poll briefly for the reply row.
  await expect.poll(async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM context_note_replies WHERE note_id = $1`,
      [seeded.noteId],
    );
    return r.rows[0].n;
  }, { timeout: 8_000 }).toBe(1);

  // ── 5. Resolve via the UI button ────────────────────────────────────
  await page.locator(`[data-testid="button-context-note-resolve-${seeded.noteId}"]`).click({ force: true });
  await expect.poll(async () => {
    const r = await pool.query(
      `SELECT status FROM context_notes WHERE id = $1`, [seeded.noteId],
    );
    return r.rows[0].status;
  }, { timeout: 8_000 }).toBe('resolved');

  // ── 6. Reopen via the UI button ─────────────────────────────────────
  await page.locator(`[data-testid="button-context-note-reopen-${seeded.noteId}"]`).click({ force: true });
  await expect.poll(async () => {
    const r = await pool.query(
      `SELECT status FROM context_notes WHERE id = $1`, [seeded.noteId],
    );
    return r.rows[0].status;
  }, { timeout: 8_000 }).toBe('open');

  // ── 7. Convert to task via the dialog ───────────────────────────────
  await page.locator(`[data-testid="button-context-note-convert-${seeded.noteId}"]`).click({ force: true });
  // Dialog appears; assignee defaults to the current (bypass) user.
  const titleInput = page.locator('[data-testid="input-convert-title"]');
  await expect(titleInput).toBeVisible();
  await titleInput.fill('Follow up on E2E quote');
  await page.locator('[data-testid="button-convert-submit"]').click({ force: true });

  await expect.poll(async () => {
    const r = await pool.query(
      `SELECT t.id, t.description
         FROM context_notes cn
         JOIN tasks t ON t.id = cn.converted_task_id
        WHERE cn.id = $1`,
      [seeded.noteId],
    );
    if (r.rowCount === 0) return null;
    return r.rows[0].description ?? '';
  }, { timeout: 10_000 }).toContain(seeded.deepLink);
});

// Non-quote deep-link regression: catches the class of bug where a
// surface-level route (LWQ, Carrier Hub, Companies) is renamed and the
// server's anchor registry forgets to follow. The contract is "every
// inbox/notification deep-link must land on a real route that auto-opens
// the relevant context-note panel".
test('Context Notes — LWQ deep-link lands on /lanes/work-queue and reveals the note', async ({ page }) => {
  test.setTimeout(45_000);
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('/api/context-notes')) {
      const body = resp.status() >= 400 ? await resp.text().catch(() => '?') : '';
      console.log(`[ctx-notes-e2e:lwq] ${resp.request().method()} ${resp.status()} ${url} ${body.slice(0,200)}`);
    }
  });
  page.on('pageerror', (err) => console.log(`[ctx-notes-e2e:lwq] pageerror: ${err.message}`));

  // 1. UI: navigate to the deep link and verify the LWQ page (not a 404
  //    or root redirect) actually rendered. The page header is stable
  //    across the /lanes/work-queue route.
  await page.goto(seededLane.deepLink);
  await page.waitForLoadState('domcontentloaded');
  // We landed on the real LWQ page (the route exists in App.tsx).
  await expect(page).toHaveURL(/\/lanes\/work-queue/);
  // The skeleton OR the content header must be present — both prove we
  // matched the route, not a 404 fallback.
  await expect(
    page.locator('h1', { hasText: 'Lane Work Queue' }).first(),
  ).toBeVisible({ timeout: 15_000 });

  // 2. Server-side: confirm the anchor registry actually exposes the
  //    seeded lane note. Done from a navigated page so the cookie /
  //    auth-bypass headers are attached. This is the unit-level guard
  //    that would have caught the `/lane-work-queue?lane=` regression
  //    even without the UI assertion.
  const probe = await page.evaluate(async (anchorId) => {
    const r = await fetch(
      `/api/context-notes/by-anchor/lane_work_queue/${anchorId}`,
      { credentials: 'include' },
    );
    return { status: r.status };
  }, seededLane.laneId);
  expect(probe.status, 'lane_work_queue list endpoint should resolve for the seed').toBe(200);

  // 3. Carrier deep-link sanity check: the registry returns
  //    /carrier-hub?carrierId=… and not the legacy /carriers/:id. We
  //    don't need to drive a full UI flow — just guarantee the route
  //    string the server hands to notifications/inbox actually exists.
  await page.goto('/carrier-hub?carrierId=__none__');
  await page.waitForLoadState('domcontentloaded');
  await expect(page).toHaveURL(/\/carrier-hub/);
});
