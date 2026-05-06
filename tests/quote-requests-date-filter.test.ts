/**
 * Task #858 / #859 — Quote Requests date filter anchors on real email activity.
 *
 * Seeds two pricing-request threads into the live session org:
 *   A: last_incoming_at = today,        last_email_at = today,        updated_at = now
 *   B: last_incoming_at = today - 10d,  last_email_at = today - 10d,  updated_at = now (sweep bump)
 * Asserts that today-window queries return A and exclude B against both
 * the storage SQL (direct DB predicate) and the live route layer.
 *
 * Task #859 collapsed the storage GREATEST(last_incoming_at,
 * last_outgoing_at) predicate to a direct read of the denormalized
 * `last_email_at` column, so this test now both seeds that column and
 * checks the same column from the API response.
 *
 * Run with: npx tsx tests/quote-requests-date-filter.test.ts
 */

import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required to run this test");
  process.exit(1);
}

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:5000";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  \u2713 ${description}`);
    passed++;
  } else {
    console.error(`  \u2717 ${description}${detail ? `\n    ${detail}` : ""}`);
    failures.push(`${description}${detail ? ` \u2014 ${detail}` : ""}`);
    failed++;
  }
}

interface ApiThread {
  id: string;
  threadId: string | null;
  orgId: string;
  updatedAt: string;
  lastIncomingAt: string | null;
  lastOutgoingAt: string | null;
  lastEmailAt: string | null;
}

// ── Local-day helpers ────────────────────────────────────────────────────────
// Mirror the YYYY-MM-DD-from-local-clock logic the conversations page uses
// in `fmtLocalDate`, plus a "noon today, local" instant for the seed.

function fmtLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function localNoonToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
}

function localNoonDaysAgo(days: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12, 0, 0, 0);
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

// Resolve the dev session's orgId — the list endpoint scopes by
// req.user.organizationId, so we seed into the session org and tag rows
// with a unique thread_id prefix for surgical cleanup.
async function resolveSessionOrgId(): Promise<string | null> {
  try {
    const r = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const body = (await r.json()) as { organizationId?: string };
    return body.organizationId ?? null;
  } catch {
    return null;
  }
}

async function seedThread(
  pool: Pool,
  orgId: string,
  threadIdSuffix: string,
  lastIncomingAt: Date,
  updatedAt: Date,
): Promise<{ id: string; threadId: string }> {
  const threadId = `task858-${threadIdSuffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Task #859 — also seed `last_email_at` so the new denormalized
  // column matches the per-direction column for the assertions below.
  const r = await pool.query<{ id: string }>(
    `INSERT INTO email_conversation_threads
       (org_id, thread_id, waiting_state, response_priority,
        last_incoming_at, last_email_at, updated_at, created_at)
     VALUES ($1, $2, 'waiting_on_us', 'normal', $3, $3, $4, NOW())
     RETURNING id`,
    [orgId, threadId, lastIncomingAt.toISOString(), updatedAt.toISOString()],
  );
  return { id: r.rows[0].id, threadId };
}

async function seedMessageWithQuoteSignal(
  pool: Pool,
  orgId: string,
  threadId: string,
  providerSentAt: Date,
): Promise<void> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO email_messages
       (org_id, thread_id, direction, from_email, to_email, subject, body,
        provider_message_id, provider_sent_at, created_at)
     VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8, NOW())
     RETURNING id`,
    [
      orgId,
      threadId,
      "shipper@example.com",
      "rep@brokerage.example",
      "Quote please?",
      "Need pricing on a load.",
      `task858-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      providerSentAt.toISOString(),
    ],
  );
  await pool.query(
    `INSERT INTO email_signals
       (message_id, intent_type, actor_type, confidence, created_at)
     VALUES ($1, 'pricing_request', 'customer', 90, NOW())`,
    [m.rows[0].id],
  );
}

// Surgical cleanup keyed off our unique `task858-*` thread_id prefix —
// we seed into the live session org and can't drop that.
async function cleanupTestRows(pool: Pool, orgId: string, threadIds: string[]): Promise<void> {
  if (threadIds.length === 0) return;
  // Delete signals via message FK CASCADE; explicitly nuke messages first
  // since email_signals.messageId has ON DELETE CASCADE on email_messages.
  await pool.query(
    `DELETE FROM email_messages WHERE org_id = $1 AND thread_id = ANY($2::text[])`,
    [orgId, threadIds],
  );
  await pool.query(
    `DELETE FROM email_conversation_threads WHERE org_id = $1 AND thread_id = ANY($2::text[])`,
    [orgId, threadIds],
  );
}

// ── API call helpers ─────────────────────────────────────────────────────────

async function callList(qs: string): Promise<{ status: number; threads: ApiThread[]; count: number | undefined }> {
  const r = await fetch(`${BASE_URL}/api/internal/conversations?${qs}`, {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) return { status: r.status, threads: [], count: undefined };
  const body = (await r.json()) as { threads?: ApiThread[]; count?: number };
  return {
    status: r.status,
    threads: Array.isArray(body.threads) ? body.threads : [],
    count: typeof body.count === "number" ? body.count : undefined,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  let orgId: string | null = null;
  const seededThreadIds: string[] = [];

  try {
    console.log("\n── Quote Requests date filter — Today honors real email activity ──\n");

    // The list endpoint scopes to req.user.organizationId, so we must
    // seed into the dev session's org for the route-layer assertions to
    // see our fixtures. Fail loudly if no session is available.
    const sessionOrg = await resolveSessionOrgId();
    if (!sessionOrg) {
      console.error("  ! /api/auth/me did not return an organizationId — this test requires a live dev session");
      process.exit(1);
    }
    orgId = sessionOrg;
    console.log(`  · seeding into live session org ${orgId}`);
    const todayLocalStr = fmtLocalDate(new Date());
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    // Thread A — real inbound today, last_incoming_at = today_local_noon.
    const aLastIncoming = localNoonToday();
    const aUpdated = new Date();
    const a = await seedThread(pool, orgId, "today", aLastIncoming, aUpdated);
    seededThreadIds.push(a.threadId);
    await seedMessageWithQuoteSignal(pool, orgId, a.threadId, aLastIncoming);

    // Thread B — legacy row whose updated_at was bumped to today by a
    // background sweep, but whose actual last_incoming_at was 10 days ago.
    const bLastIncoming = localNoonDaysAgo(10);
    const bUpdated = new Date();
    const b = await seedThread(pool, orgId, "legacy", bLastIncoming, bUpdated);
    seededThreadIds.push(b.threadId);
    await seedMessageWithQuoteSignal(pool, orgId, b.threadId, bLastIncoming);

    // Sanity — both seeded threads exist in the DB and have the expected
    // shape (filtered to *just* our test fixtures via thread_id prefix
    // since when seeding into the session org there are many other rows).
    const sanity = await pool.query<{ thread_id: string; last_incoming_at: Date; updated_at: Date }>(
      `SELECT thread_id, last_incoming_at, updated_at
         FROM email_conversation_threads
        WHERE org_id = $1 AND thread_id = ANY($2::text[])
        ORDER BY thread_id`,
      [orgId, seededThreadIds],
    );
    assert(
      "seed: two threads inserted",
      sanity.rows.length === 2,
      `Got ${sanity.rows.length} thread rows`,
    );

    // ── DB-level invariant — the production predicate (Task #859) excludes B.
    // Reads the denormalized `last_email_at` column directly (the storage
    // layer no longer recomputes GREATEST(...) per query). Scope to our
    // seeded thread_ids so other live rows in the session org don't
    // pollute the assertion.
    const dbCheck = await pool.query<{ thread_id: string }>(
      `SELECT thread_id
         FROM email_conversation_threads
        WHERE org_id = $1
          AND thread_id = ANY($4::text[])
          AND archived_at IS NULL
          AND last_email_at >= $2
          AND last_email_at <= $3`,
      [
        orgId,
        // Match the route layer's "today @ rep-local midnight" boundary
        // approximately by using the local Date(year, month, day) instant.
        new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 0, 0, 0).toISOString(),
        new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 23, 59, 59, 999).toISOString(),
        seededThreadIds,
      ],
    );
    const dbReturned = dbCheck.rows.map(r => r.thread_id).sort();
    assert(
      "DB predicate: last_email_at BETWEEN today bounds returns only Thread A",
      dbReturned.length === 1 && dbReturned[0] === a.threadId,
      `Expected [${a.threadId}], got [${dbReturned.join(", ")}]`,
    );

    // ── Task #859 NULL-safe seed expression — fences the
    // `conversationThreadBackfillService` insert SQL. Bare
    // `GREATEST(a, b)` returns NULL in Postgres if either side is NULL;
    // a single-direction thread (only inbound OR only outbound history)
    // would then land with `last_email_at = NULL` and silently disappear
    // from the storage date filter. Assert the production
    // `GREATEST(COALESCE(...), COALESCE(...))` shape returns the live
    // direction column for both single-direction cases and matches
    // GREATEST() when both directions are present.
    const inOnly = await pool.query<{ v: Date | null }>(
      `SELECT GREATEST(
                COALESCE($1::timestamp, $2::timestamp),
                COALESCE($2::timestamp, $1::timestamp)
              ) AS v`,
      [new Date("2026-01-15T10:00:00Z").toISOString(), null],
    );
    assert(
      "NULL-safe GREATEST(COALESCE...) — inbound-only thread yields the inbound timestamp",
      inOnly.rows[0].v !== null && new Date(inOnly.rows[0].v as Date).toISOString() === "2026-01-15T10:00:00.000Z",
      `Expected 2026-01-15T10:00:00.000Z, got ${inOnly.rows[0].v}`,
    );
    const outOnly = await pool.query<{ v: Date | null }>(
      `SELECT GREATEST(
                COALESCE($1::timestamp, $2::timestamp),
                COALESCE($2::timestamp, $1::timestamp)
              ) AS v`,
      [null, new Date("2026-02-20T14:30:00Z").toISOString()],
    );
    assert(
      "NULL-safe GREATEST(COALESCE...) — outbound-only thread yields the outbound timestamp",
      outOnly.rows[0].v !== null && new Date(outOnly.rows[0].v as Date).toISOString() === "2026-02-20T14:30:00.000Z",
      `Expected 2026-02-20T14:30:00.000Z, got ${outOnly.rows[0].v}`,
    );
    const both = await pool.query<{ v: Date | null }>(
      `SELECT GREATEST(
                COALESCE($1::timestamp, $2::timestamp),
                COALESCE($2::timestamp, $1::timestamp)
              ) AS v`,
      [new Date("2026-03-01T08:00:00Z").toISOString(), new Date("2026-03-05T12:00:00Z").toISOString()],
    );
    assert(
      "NULL-safe GREATEST(COALESCE...) — both directions present yields the larger timestamp",
      both.rows[0].v !== null && new Date(both.rows[0].v as Date).toISOString() === "2026-03-05T12:00:00.000Z",
      `Expected 2026-03-05T12:00:00.000Z, got ${both.rows[0].v}`,
    );

    // ── Live endpoint — exercises route-layer tz resolution + storage SQL.
    const qsBase = new URLSearchParams({
      dateFrom: todayLocalStr,
      dateTo: todayLocalStr,
      tz,
      limit: "100",
    });
    const quoteRequestsQs = new URLSearchParams(qsBase);
    quoteRequestsQs.set("signal", "quote_request");

    // Walk the cursor — the dev org has hundreds of today-window
    // pricing-request threads and a single page (cap 100) isn't
    // guaranteed to contain our seeded fixture.
    async function walkAndCollect(baseQs: URLSearchParams): Promise<{ status: number; ours: ApiThread[] }> {
      const collected: ApiThread[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let lastStatus = 0;
      do {
        const qs = new URLSearchParams(baseQs);
        if (cursor) qs.set("cursor", cursor);
        const resp = await callList(qs.toString());
        lastStatus = resp.status;
        if (resp.status !== 200) break;
        for (const t of resp.threads) {
          if (t.threadId === a.threadId || t.threadId === b.threadId) collected.push(t);
        }
        const nextRaw = await fetch(
          `${BASE_URL}/api/internal/conversations?${qs.toString()}`,
          { headers: { Accept: "application/json" } },
        ).then(r => r.json()).catch(() => ({} as { nextCursor?: string | null }));
        cursor = (nextRaw as { nextCursor?: string | null }).nextCursor ?? null;
        pages++;
      } while (cursor && pages < 25 && !(collected.some(t => t.threadId === a.threadId) && collected.some(t => t.threadId === b.threadId)));
      return { status: lastStatus, ours: collected };
    }

    const qr = await walkAndCollect(quoteRequestsQs);
    assert(
      "Live endpoint reachable (200 OK)",
      qr.status === 200,
      `GET /api/internal/conversations returned ${qr.status}; this test requires a live dev session`,
    );

    const ours = qr.ours;
    const ids = ours.map(t => t.threadId).filter((x): x is string => !!x).sort();

    assert(
      "Quote requests + Today: returns Thread A (today's real inbound)",
      ids.includes(a.threadId),
      `Got [${ids.join(", ")}]`,
    );
    assert(
      "Quote requests + Today: excludes Thread B (legacy row whose updated_at was bumped today)",
      !ids.includes(b.threadId),
      `Thread B leaked into the Today bucket — date filter is still anchored on the wrong column. Got [${ids.join(", ")}]`,
    );

    const a0 = ours.find(t => t.threadId === a.threadId);
    if (a0) {
      const lastEmail = a0.lastEmailAt ? new Date(a0.lastEmailAt) : null;
      const todayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 0, 0, 0);
      const todayEnd = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 23, 59, 59, 999);
      assert(
        "Thread A: API-shipped lastEmailAt is inside today's local window",
        !!lastEmail && lastEmail >= todayStart && lastEmail <= todayEnd,
        `lastEmailAt=${a0.lastEmailAt}, todayStart=${todayStart.toISOString()}, todayEnd=${todayEnd.toISOString()}`,
      );
    }

    // All-conversations (no signal=) must use the same anchor. Walk the
    // cursor — the dev org has many today-window rows; cap at 25 pages.
    let allIds: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs = new URLSearchParams(qsBase);
      if (cursor) qs.set("cursor", cursor);
      const resp = await callList(qs.toString());
      for (const t of resp.threads) {
        if (t.threadId && (t.threadId === a.threadId || t.threadId === b.threadId)) {
          allIds.push(t.threadId);
        }
      }
      const nextRaw = await fetch(
        `${BASE_URL}/api/internal/conversations?${qs.toString()}`,
        { headers: { Accept: "application/json" } },
      ).then(r => r.json()).catch(() => ({} as { nextCursor?: string | null }));
      cursor = (nextRaw as { nextCursor?: string | null }).nextCursor ?? null;
      pages++;
    } while (cursor && pages < 25 && !(allIds.includes(a.threadId) && allIds.includes(b.threadId)));
    assert(
      "All conversations + Today: same anchor — A in, B out",
      allIds.includes(a.threadId) && !allIds.includes(b.threadId),
      `Got [${allIds.join(", ")}] after walking ${pages} page(s)`,
    );

    // ── Task #861 — All conversations bucket sends sort=recency, and the
    // recency sort must anchor on `last_email_at` so today's freshest
    // real email lands on page 1 instead of being buried behind older
    // threads whose `updated_at` was bumped today by a sweep. We seed
    // two fixtures here:
    //   D — a "freshest real email" thread with last_email_at = now
    //       (and updated_at deliberately *older* than the dev org's
    //       sweep-bumped rows). Under the old updated_at-anchored sort
    //       D would never reach page 1 of a 990-row org. Under the
    //       Task #861 fix it must land on page 1 (and at the top).
    //   C — a distractor with last_email_at = 2d ago but updated_at =
    //       now+1s (the "background sweep just touched the row"
    //       scenario). The Today date filter must keep C out, even
    //       though its updated_at is the freshest in the org.
    const dLastEmail = new Date();
    // updated_at deliberately stale (an hour ago) to prove the sort
    // is no longer keyed on it.
    const dUpdated = new Date(Date.now() - 60 * 60 * 1000);
    const d = await seedThread(pool, orgId, "freshest-email", dLastEmail, dUpdated);
    seededThreadIds.push(d.threadId);
    await seedMessageWithQuoteSignal(pool, orgId, d.threadId, dLastEmail);

    const cLastIncoming = localNoonDaysAgo(2);
    const cUpdated = new Date(Date.now() + 1000);
    const c = await seedThread(pool, orgId, "fresh-update-stale-email", cLastIncoming, cUpdated);
    seededThreadIds.push(c.threadId);
    await seedMessageWithQuoteSignal(pool, orgId, c.threadId, cLastIncoming);

    const recencyTodayQs = new URLSearchParams(qsBase);
    recencyTodayQs.set("sort", "recency");
    recencyTodayQs.set("limit", "100");
    const recencyTodayPage1 = await callList(recencyTodayQs.toString());
    assert(
      "All conversations + Today (sort=recency): page 1 returns a well-formed response (threads array + numeric count)",
      Array.isArray(recencyTodayPage1.threads) && typeof recencyTodayPage1.count === "number",
      `response shape: threads=${typeof recencyTodayPage1.threads}, count=${typeof recencyTodayPage1.count}`,
    );
    const recencyTodayIds = recencyTodayPage1.threads.map(t => t.threadId).filter((x): x is string => !!x);
    assert(
      "All conversations + Today (sort=recency): page 1 contains today's freshest seeded thread D",
      recencyTodayIds.includes(d.threadId),
      `Thread D (lastEmailAt=now) missing from page 1 — sort is still anchored on updated_at, today's real activity got buried. Page-1 size=${recencyTodayPage1.threads.length}`,
    );
    // Thread D was seeded with last_email_at = now, which is the
    // freshest in the org. Under the new sort it must rank #1.
    assert(
      "All conversations + Today (sort=recency): freshest-real-email thread D sits at position 1",
      recencyTodayPage1.threads[0]?.threadId === d.threadId,
      `Page-1 head = ${recencyTodayPage1.threads[0]?.threadId} (lastEmailAt=${recencyTodayPage1.threads[0]?.lastEmailAt}); expected D=${d.threadId}`,
    );
    assert(
      "All conversations + Today (sort=recency): page 1 excludes Thread C (lastEmailAt 2d ago, updated_at fresh)",
      !recencyTodayIds.includes(c.threadId),
      `Thread C leaked into Today — date filter should be cutting it. Page 1 ids include C=${recencyTodayIds.includes(c.threadId)}`,
    );

    // Sort-direction invariant — within page 1, every neighbor pair
    // must be ordered (lastEmailAt DESC NULLS LAST, id DESC). If a row
    // with a stale lastEmailAt sits above a row with a fresher one, the
    // sort regressed back to updated_at.
    let sortOk = true;
    let sortDetail = "";
    for (let i = 1; i < recencyTodayPage1.threads.length; i++) {
      const prev = recencyTodayPage1.threads[i - 1];
      const cur = recencyTodayPage1.threads[i];
      const prevLea = prev.lastEmailAt ? new Date(prev.lastEmailAt).getTime() : -Infinity;
      const curLea = cur.lastEmailAt ? new Date(cur.lastEmailAt).getTime() : -Infinity;
      if (prevLea < curLea) {
        sortOk = false;
        sortDetail = `position ${i - 1} lastEmailAt=${prev.lastEmailAt} ranks above position ${i} lastEmailAt=${cur.lastEmailAt}`;
        break;
      }
      if (prevLea === curLea && prev.id < cur.id) {
        sortOk = false;
        sortDetail = `position ${i - 1} id=${prev.id} ranks above position ${i} id=${cur.id} at the same lastEmailAt`;
        break;
      }
    }
    assert(
      "All conversations + Today (sort=recency): page 1 is monotonic by (lastEmailAt DESC NULLS LAST, id DESC)",
      sortOk,
      sortDetail,
    );

    // Cursor walk under the new key — paging through Today must keep the
    // same descending lastEmailAt invariant across the page boundary.
    const recencyTodayPage1Raw = await fetch(
      `${BASE_URL}/api/internal/conversations?${recencyTodayQs.toString()}`,
      { headers: { Accept: "application/json" } },
    ).then(r => r.json()).catch(() => ({} as { nextCursor?: string | null }));
    const nextCursor = (recencyTodayPage1Raw as { nextCursor?: string | null }).nextCursor ?? null;
    if (nextCursor) {
      assert(
        "Cursor format: nextCursor uses the new 'recency2|...' key",
        nextCursor.startsWith("recency2|"),
        `Got cursor=${nextCursor}`,
      );
      const recencyTodayPage2Qs = new URLSearchParams(recencyTodayQs);
      recencyTodayPage2Qs.set("cursor", nextCursor);
      const page2 = await callList(recencyTodayPage2Qs.toString());
      const lastOfPage1 = recencyTodayPage1.threads[recencyTodayPage1.threads.length - 1];
      const firstOfPage2 = page2.threads[0];
      if (lastOfPage1 && firstOfPage2) {
        const lastLea = lastOfPage1.lastEmailAt ? new Date(lastOfPage1.lastEmailAt).getTime() : -Infinity;
        const firstLea = firstOfPage2.lastEmailAt ? new Date(firstOfPage2.lastEmailAt).getTime() : -Infinity;
        const monotonic = lastLea > firstLea
          || (lastLea === firstLea && lastOfPage1.id > firstOfPage2.id);
        assert(
          "Cursor walk: page 2 starts strictly after page 1 by (lastEmailAt DESC, id DESC)",
          monotonic,
          `page1 last lastEmailAt=${lastOfPage1.lastEmailAt} id=${lastOfPage1.id}; page2 first lastEmailAt=${firstOfPage2.lastEmailAt} id=${firstOfPage2.id}`,
        );
      }
    }
  } finally {
    if (orgId) {
      try {
        await cleanupTestRows(pool, orgId, seededThreadIds);
      } catch (err) {
        console.error("  ! cleanup failed:", err);
      }
    }
    await pool.end();
  }

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────────────────────\n`);
  if (failures.length > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
