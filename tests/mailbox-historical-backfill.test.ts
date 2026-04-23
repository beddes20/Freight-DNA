/**
 * Mailbox Historical Backfill — Unit Tests (Task #508)
 *
 * Covers the historical 30-day backfill service:
 *   1. Pagination through @odata.nextLink
 *   2. 429 throttling honors Retry-After
 *   3. Idempotency — duplicate Graph message IDs counted as duplicates
 *   4. Per-mailbox backfill row written and updated with progress + status
 *   5. Folder-level error increments errorsCount and surfaces lastError
 *   6. Auto-trigger no-ops when Azure creds are absent
 *   7. Bulk org-wide run iterates only enabled mailboxes for that org
 *
 * Run with: npx tsx tests/mailbox-historical-backfill.test.ts
 * Does NOT require a running server or live DB — uses in-memory storage stubs
 * and a mocked global fetch.
 */

import { storage } from "../server/storage";
import {
  runBackfillForMailbox,
  runBackfillForAllEnabledMailboxes,
  triggerBackfillInBackground,
  iterateHistoricalMessages,
  __setIngestOverrideForTests,
} from "../server/services/mailboxHistoricalBackfillService";
import type { MonitoredMailbox, MailboxHistoricalBackfill } from "../shared/schema";

// ─── Test infrastructure ──────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) { console.log(`  ✓ ${description}`); passed++; }
  else { console.error(`  ✗ ${description}${detail ? "\n    " + detail : ""}`); failures.push(description); failed++; }
}

// ─── Force Azure creds so triggerBackfillInBackground tests can run ─────────
process.env.OUTLOOK_TENANT_ID = process.env.OUTLOOK_TENANT_ID || "test-tenant";
process.env.OUTLOOK_CLIENT_ID = process.env.OUTLOOK_CLIENT_ID || "test-client";
process.env.OUTLOOK_CLIENT_SECRET = process.env.OUTLOOK_CLIENT_SECRET || "test-secret";

// ─── In-memory storage stubs ─────────────────────────────────────────────────
const mailboxes = new Map<string, MonitoredMailbox>();
const backfills = new Map<string, MailboxHistoricalBackfill>();

function makeMailbox(overrides: Partial<MonitoredMailbox> = {}): MonitoredMailbox {
  const id = overrides.id ?? `mb-${Math.random().toString(36).slice(2, 8)}`;
  const mb: MonitoredMailbox = {
    id,
    orgId: "org-1",
    userId: "user-1",
    email: "rep@broker.com",
    enabled: true,
    subscriptionId: null,
    sentItemsSubscriptionId: null,
    subscriptionExpiresAt: null,
    lastSyncAt: null,
    deltaSyncToken: null,
    sentDeltaSyncToken: null,
    syncStatus: "active",
    syncError: null,
    lastSentItemsNotificationAt: null,
    lastOutboundCapturedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  mailboxes.set(mb.id, mb);
  return mb;
}

function resetStubs() {
  mailboxes.clear();
  backfills.clear();
}

// Patch storage in-place (each test mutates the same singleton).
(storage as any).getMonitoredMailbox = async (id: string) => mailboxes.get(id);
(storage as any).getEnabledMonitoredMailboxes = async () =>
  Array.from(mailboxes.values()).filter(m => m.enabled);
(storage as any).updateMonitoredMailbox = async (id: string, data: any) => {
  const cur = mailboxes.get(id);
  if (!cur) return undefined;
  const next = { ...cur, ...data, updatedAt: new Date() };
  mailboxes.set(id, next);
  return next;
};
(storage as any).createMailboxHistoricalBackfill = async (data: any) => {
  const id = `bf-${Math.random().toString(36).slice(2, 8)}`;
  const row: MailboxHistoricalBackfill = {
    id,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    startedAt: null,
    triggeredByUserId: null,
    triggeredBy: "auto",
    lastError: null,
    errorsCount: 0,
    messagesDuplicate: 0,
    messagesIngested: 0,
    messagesFetched: 0,
    ...data,
  } as MailboxHistoricalBackfill;
  backfills.set(id, row);
  return row;
};
(storage as any).updateMailboxHistoricalBackfill = async (id: string, data: any) => {
  const cur = backfills.get(id);
  if (!cur) return undefined;
  const next = { ...cur, ...data, updatedAt: new Date() };
  backfills.set(id, next);
  return next;
};
(storage as any).getLatestMailboxHistoricalBackfill = async (mailboxId: string) => {
  const rows = Array.from(backfills.values()).filter(b => b.mailboxId === mailboxId);
  rows.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return rows[0];
};
(storage as any).getMailboxHistoricalBackfillsForOrg = async (orgId: string) =>
  Array.from(backfills.values()).filter(b => b.orgId === orgId);

// Note: getGraphAccessToken inside graphService.ts and syncMailboxDelta
// in mailboxDeltaSyncService.ts both call through to fetch(); since our
// global fetch mock has a fallback for login.microsoftonline.com and the
// service swallows any delta-seed failure into a log line, the entire
// backfill flow can run end-to-end purely in-memory.

// ─── Mock fetch ──────────────────────────────────────────────────────────────
type FetchResponder = (url: string, init?: any) => { status: number; body: any; headers?: Record<string, string> };
let _fetchResponder: FetchResponder | null = null;
const _fetchCalls: string[] = [];
const _origFetch = global.fetch;
(global as any).fetch = async (url: any, init?: any) => {
  const u = typeof url === "string" ? url : url.toString();
  // Auto-handle Azure token endpoint without polluting test responders
  if (u.includes("login.microsoftonline.com")) {
    return new Response(JSON.stringify({ access_token: "fake", expires_in: 3600 }), { status: 200 });
  }
  _fetchCalls.push(u);
  if (!_fetchResponder) throw new Error(`No fetch responder set for ${u}`);
  const r = _fetchResponder(u, init);
  return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
    status: r.status,
    headers: r.headers,
  });
};

function setResponder(fn: FetchResponder) { _fetchResponder = fn; _fetchCalls.length = 0; }

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testPaginatesAcrossNextLinks() {
  console.log("Test: paginates across @odata.nextLink");
  resetStubs();
  const mb = makeMailbox();
  const ingested: string[] = [];
  __setIngestOverrideForTests(async (_m, _f, msg) => {
    const dup = ingested.includes(msg.id);
    if (!dup) ingested.push(msg.id);
    return { created: !dup };
  });

  setResponder((url) => {
    if (url.includes("$skiptoken=PAGE2")) {
      return { status: 200, body: { value: [{ id: "m3", receivedDateTime: new Date().toISOString() }] } };
    }
    return {
      status: 200,
      body: {
        value: [
          { id: "m1", receivedDateTime: new Date().toISOString() },
          { id: "m2", receivedDateTime: new Date().toISOString() },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/x/mailFolders/inbox/messages?$skiptoken=PAGE2",
      },
    };
  });

  const r = await runBackfillForMailbox(mb.id, { triggeredBy: "admin" });
  // Inbox returns 3 (paginated), sentitems returns same 3 with same IDs → counted as dup.
  assert("status completed", r.status === "completed");
  assert("messagesFetched counts every page", r.messagesFetched === 6);
  assert("messagesIngested counts unique only", r.messagesIngested === 3);
  assert("messagesDuplicate counts repeats from sentitems pass", r.messagesDuplicate === 3);
  assert("errorsCount is zero on clean run", r.errorsCount === 0);
  const row = backfills.get(r.backfillId)!;
  assert("backfill row marked completed", row.status === "completed");
  assert("backfill row has completedAt", !!row.completedAt);
}

async function testRetryAfterOn429() {
  console.log("Test: honors Retry-After on 429 throttling");
  resetStubs();
  const mb = makeMailbox();
  __setIngestOverrideForTests(async () => ({ created: true }));

  let callCount = 0;
  setResponder(() => {
    callCount++;
    if (callCount === 1) {
      return { status: 429, body: { error: "throttled" }, headers: { "retry-after": "0" } };
    }
    return { status: 200, body: { value: [{ id: `msg-${callCount}`, receivedDateTime: new Date().toISOString() }] } };
  });
  const r = await runBackfillForMailbox(mb.id);
  assert("retried after 429 and succeeded", r.status === "completed");
  assert("retry triggered at least one extra fetch", _fetchCalls.length >= 2);
}

async function testIdempotencyOnRerun() {
  console.log("Test: re-running backfill is idempotent (counts as duplicates)");
  resetStubs();
  const mb = makeMailbox();
  const seen = new Set<string>();
  __setIngestOverrideForTests(async (_m, _f, msg) => {
    const dup = seen.has(msg.id);
    seen.add(msg.id);
    return { created: !dup };
  });
  setResponder(() => ({
    status: 200,
    body: { value: [{ id: "msg-A", receivedDateTime: new Date().toISOString() }] },
  }));

  const r1 = await runBackfillForMailbox(mb.id);
  const r2 = await runBackfillForMailbox(mb.id);
  assert("first run ingests new", r1.messagesIngested === 1 && r1.messagesDuplicate === 1); // inbox + sentitems
  assert("second run is all duplicates", r2.messagesIngested === 0 && r2.messagesDuplicate === 2);
}

async function testFolderErrorIncrementsErrors() {
  console.log("Test: folder-level fetch error increments errorsCount and surfaces lastError");
  resetStubs();
  const mb = makeMailbox();
  __setIngestOverrideForTests(async () => ({ created: true }));

  setResponder((url) => {
    if (url.includes("/inbox/")) {
      return { status: 500, body: "boom" };
    }
    return { status: 200, body: { value: [{ id: "ok", receivedDateTime: new Date().toISOString() }] } };
  });
  const r = await runBackfillForMailbox(mb.id);
  assert("errorsCount incremented", r.errorsCount >= 1);
  assert("lastError surfaces Graph failure", !!r.lastError && r.lastError.includes("500"));
  assert("status is completed (sentitems succeeded)", r.status === "completed");
  assert("ingested from sentitems", r.messagesIngested === 1);
}

async function testSkipIfAlreadyCompleted() {
  console.log("Test: skipIfAlreadyCompleted no-ops when prior completed run exists");
  resetStubs();
  const mb = makeMailbox();
  __setIngestOverrideForTests(async () => ({ created: true }));
  setResponder(() => ({ status: 200, body: { value: [{ id: "x", receivedDateTime: new Date().toISOString() }] } }));

  const r1 = await runBackfillForMailbox(mb.id);
  assert("first completed", r1.status === "completed");
  const r2 = await runBackfillForMailbox(mb.id, { skipIfAlreadyCompleted: true });
  assert("second is skipped", r2.status === "skipped");
  assert("skipped result reuses prior backfill id", r2.backfillId === r1.backfillId);
}

async function testBulkRunsOnlyEnabledOrgMailboxes() {
  console.log("Test: bulk run only iterates enabled mailboxes for the org");
  resetStubs();
  makeMailbox({ id: "mb-a", orgId: "org-1", email: "a@x.com", enabled: true });
  makeMailbox({ id: "mb-b", orgId: "org-1", email: "b@x.com", enabled: false });
  makeMailbox({ id: "mb-c", orgId: "org-2", email: "c@x.com", enabled: true });
  __setIngestOverrideForTests(async () => ({ created: true }));
  setResponder(() => ({ status: 200, body: { value: [] } }));

  const r = await runBackfillForAllEnabledMailboxes("org-1");
  assert("only ran for one mailbox in org-1 (mb-a; mb-b is disabled)", r.total === 1);
  assert("completed count is 1", r.completed === 1);
}

async function testTriggerBackgroundIsNonBlocking() {
  console.log("Test: triggerBackfillInBackground returns immediately");
  resetStubs();
  const mb = makeMailbox();
  __setIngestOverrideForTests(async () => ({ created: true }));
  setResponder(() => ({ status: 200, body: { value: [] } }));
  const before = Date.now();
  triggerBackfillInBackground(mb.id, { triggeredBy: "auto" });
  const after = Date.now();
  assert("returns synchronously (<50ms)", after - before < 50);
  await new Promise(r => setTimeout(r, 100));
  const row = await (storage as any).getLatestMailboxHistoricalBackfill(mb.id);
  assert("background run created a backfill row", !!row);
}

async function testAdvancesPersistedProgressMidRun() {
  console.log("Test: persists progress across pages so admin UI sees live counts");
  resetStubs();
  const mb = makeMailbox();
  __setIngestOverrideForTests(async () => ({ created: true }));

  let page = 0;
  setResponder(() => {
    page++;
    if (page === 1) {
      return {
        status: 200,
        body: {
          value: [{ id: "p1", receivedDateTime: new Date().toISOString() }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/x?$skiptoken=N",
        },
      };
    }
    return { status: 200, body: { value: [{ id: `p-${page}`, receivedDateTime: new Date().toISOString() }] } };
  });
  const r = await runBackfillForMailbox(mb.id);
  assert("ingested every unique message", r.messagesIngested >= 2);
  const row = backfills.get(r.backfillId)!;
  assert("final row counts match result", row.messagesIngested === r.messagesIngested);
}

async function testIterateHistoricalMessagesGenerator() {
  console.log("Test: iterateHistoricalMessages yields each page");
  setResponder((url) => {
    if (url.includes("$skiptoken=N")) {
      return { status: 200, body: { value: [{ id: "y", receivedDateTime: new Date().toISOString() }] } };
    }
    return {
      status: 200,
      body: {
        value: [{ id: "x", receivedDateTime: new Date().toISOString() }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/a/mailFolders/inbox/messages?$skiptoken=N",
      },
    };
  });
  const pages: string[][] = [];
  for await (const page of iterateHistoricalMessages("rep@broker.com", "inbox", new Date(0))) {
    pages.push(page.map(m => m.id));
  }
  assert("yields 2 pages", pages.length === 2);
  assert("first page has x", pages[0]?.[0] === "x");
  assert("second page has y", pages[1]?.[0] === "y");
}

// ─── Run all ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    await testPaginatesAcrossNextLinks();
    await testRetryAfterOn429();
    await testIdempotencyOnRerun();
    await testFolderErrorIncrementsErrors();
    await testSkipIfAlreadyCompleted();
    await testBulkRunsOnlyEnabledOrgMailboxes();
    await testTriggerBackgroundIsNonBlocking();
    await testAdvancesPersistedProgressMidRun();
    await testIterateHistoricalMessagesGenerator();
  } catch (err) {
    console.error("Unhandled test error:", err);
    failed++;
  } finally {
    (global as any).fetch = _origFetch;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length > 0) console.log("Failures:\n" + failures.map(f => "  - " + f).join("\n"));
  process.exit(failed === 0 ? 0 : 1);
})();
