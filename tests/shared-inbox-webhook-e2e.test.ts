/**
 * Shared Inbox Webhook — End-to-End Tests (Task #549)
 *
 * Drives the full Graph → outlook-reply webhook → email_messages →
 * carrier_outreach_logs reply pipeline using in-memory storage stubs and
 * a stubbed Graph fetch. No live DB, no live Graph, no live Express.
 *
 * Coverage:
 *   1. Happy path:   Valid clientState + matching In-Reply-To header →
 *                    outreach log gets `replyReceivedAt`/`replySnippet` set,
 *                    inbound email_messages row is created.
 *   2. Idempotent:   Re-delivering the same Graph notification does NOT
 *                    create a second email_messages row (upsert on
 *                    providerMessageId) and does NOT clobber the existing
 *                    reply (already-replied logs are skipped).
 *   3. Wrong secret: Notification with a clientState that doesn't match
 *                    OUTLOOK_WEBHOOK_SECRET is rejected — no outreach log
 *                    is updated and no email_messages row is created.
 *   4. Missing secret: With OUTLOOK_WEBHOOK_SECRET unset, the entire batch
 *                    is refused (Task #549 hardening).
 *   5. Thread + LWQ:  Reply also flips `email_conversation_threads` to
 *                    `waiting_on_us` with `lastIncomingAt` set, AND the
 *                    Available Freight lane work queue projection (outreach
 *                    logs filtered by laneId + replyReceivedAt) surfaces
 *                    the reply for the lane.
 *
 * Run with: npx tsx tests/shared-inbox-webhook-e2e.test.ts
 */

import { storage } from "../server/storage";
import { processOutlookReplyNotifications } from "../server/routes/laneCarrierOutreach";
import type {
  CarrierOutreachLog,
  EmailConversationThread,
  EmailMessage,
  User,
} from "../shared/schema";

// ─── Test infrastructure ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}${detail ? "\n    " + detail : ""}`);
    failures.push(description);
    failed++;
  }
}

// ─── Required env baseline (the real route reads these synchronously) ───────
process.env.OUTLOOK_WEBHOOK_SECRET = "test-webhook-secret-549";
process.env.OUTLOOK_REPLY_EMAIL = "replies@broker.test";

// ─── In-memory storage stubs ────────────────────────────────────────────────
const outreachLogs = new Map<string, CarrierOutreachLog>();
const emailMessages: EmailMessage[] = [];
const users = new Map<string, User>();
// Thread store keyed by `${orgId}::${threadId}`. Mirrors the prod table.
const threadStore = new Map<string, EmailConversationThread>();

function makeUser(overrides: Partial<User> = {}): User {
  const id = overrides.id ?? `user-${Math.random().toString(36).slice(2, 8)}`;
  const u = {
    id,
    username: "replies@broker.test",
    organizationId: "org-1",
    name: "Shared Replies",
    role: "user",
    avatarColor: null,
    createdAt: new Date(),
    ...overrides,
  } as unknown as User;
  users.set(u.id, u);
  return u;
}

function makeOutreachLog(overrides: Partial<CarrierOutreachLog> = {}): CarrierOutreachLog {
  const id = overrides.id ?? `log-${Math.random().toString(36).slice(2, 8)}`;
  const log = {
    id,
    orgId: "org-1",
    laneId: "lane-1",
    companyId: null,
    carrierIds: ["carrier-1"],
    carrierNames: ["ACME Trucking"],
    actorUserId: "user-1",
    ownerUserId: "user-1",
    overseerUserId: null,
    outreachMode: "lane_building",
    emailDrafts: [],
    timestamp: new Date(Date.now() - 60_000),
    sentAt: new Date(Date.now() - 60_000),
    deliveryStatus: "sent",
    failureReason: null,
    recipients: null,
    procurementTaskId: null,
    procurementLane: null,
    threadId: "outbound-msg-id-1@broker.test",
    replyReceivedAt: null,
    replySnippet: null,
    direction: "outbound",
    providerMessageId: null,
    conversationId: null,
    fromEmail: null,
    toEmail: null,
    subject: null,
    bodyPreview: null,
    rawPayloadRef: null,
    receivedAt: null,
    processStatus: null,
    matchedCarrierId: null,
    matchedLaneId: null,
    matchConfidence: null,
    ...overrides,
  } as unknown as CarrierOutreachLog;
  outreachLogs.set(log.id, log);
  return log;
}

function resetStubs() {
  outreachLogs.clear();
  emailMessages.length = 0;
  users.clear();
  threadStore.clear();
}

// LWQ projection used by the Available Freight lane work queue: which
// outreach logs for this lane have a recorded reply. Mirrors the SQL
// projection in `/api/recurring-lanes/...` rep-performance views.
function laneOutreachLogsWithReplies(orgId: string, laneId: string) {
  return Array.from(outreachLogs.values()).filter(
    l => l.orgId === orgId && l.laneId === laneId && l.replyReceivedAt !== null,
  );
}

// Patch storage in place. Each test resets the maps and re-registers users.
(storage as any).getUserByUsername = async (username: string): Promise<User | undefined> => {
  for (const u of users.values()) if (u.username === username) return u;
  return undefined;
};

(storage as any).getCarrierOutreachLogByThreadId = async (threadId: string) => {
  for (const log of outreachLogs.values()) {
    if (log.threadId === threadId) return log;
  }
  return undefined;
};

(storage as any).getCarrierOutreachLogsByOrgAndThreadIds = async (
  orgId: string,
  threadIds: string[],
) => {
  const set = new Set(threadIds);
  return Array.from(outreachLogs.values()).filter(
    l => l.orgId === orgId && l.threadId !== null && set.has(l.threadId),
  );
};

(storage as any).getCarrierOutreachLogBySubjectFallback = async (
  _orgId: string,
  _normalizedSubject: string,
) => undefined;

(storage as any).recordOutreachReply = async (
  logId: string,
  snippet: string,
  receivedAt: Date,
) => {
  const log = outreachLogs.get(logId);
  if (!log) throw new Error(`outreach log not found: ${logId}`);
  log.replyReceivedAt = receivedAt;
  log.replySnippet = snippet;
  return log;
};

(storage as any).getEmailConversationThreadByThreadId = async (
  orgId: string,
  threadId: string,
): Promise<EmailConversationThread | undefined> => {
  return threadStore.get(`${orgId}::${threadId}`);
};

(storage as any).upsertEmailConversationThread = async (data: {
  orgId: string;
  threadId: string;
  linkedAccountId: string | null;
  linkedCarrierId: string | null;
  update: Partial<EmailConversationThread>;
}) => {
  const key = `${data.orgId}::${data.threadId}`;
  const existing = threadStore.get(key);
  const now = new Date();
  const merged: EmailConversationThread = {
    id: existing?.id ?? `thread-${threadStore.size + 1}`,
    orgId: data.orgId,
    threadId: data.threadId,
    linkedAccountId: data.linkedAccountId ?? existing?.linkedAccountId ?? null,
    linkedCarrierId: data.linkedCarrierId ?? existing?.linkedCarrierId ?? null,
    ownerUserId: existing?.ownerUserId ?? null,
    waitingState: existing?.waitingState ?? "waiting_on_them",
    responsePriority: existing?.responsePriority ?? "normal",
    lastMessageId: existing?.lastMessageId ?? null,
    lastIncomingAt: existing?.lastIncomingAt ?? null,
    lastOutgoingAt: existing?.lastOutgoingAt ?? null,
    waitingSinceAt: existing?.waitingSinceAt ?? null,
    overdueAt: existing?.overdueAt ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...data.update,
  } as EmailConversationThread;
  threadStore.set(key, merged);
  return merged;
};

(storage as any).upsertInboundEmailMessage = async (data: any) => {
  // Idempotency by providerMessageId — mirrors the production behaviour.
  if (data.providerMessageId) {
    const existing = emailMessages.find(m => m.providerMessageId === data.providerMessageId);
    if (existing) return { message: existing, created: false };
  }
  const msg = {
    id: `msg-${emailMessages.length + 1}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  } as EmailMessage;
  emailMessages.push(msg);
  return { message: msg, created: true };
};

// ─── Stubbed Graph fetch — returns a canned message for the matched ID ──────
type GraphMsg = {
  id: string;
  internetMessageId?: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string; name?: string } }>;
  conversationId?: string;
  receivedDateTime?: string;
};

let graphMessages = new Map<string, GraphMsg>();
let graphFetchCalls = 0;

const stubFetch: typeof fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  graphFetchCalls++;
  const url = typeof input === "string" ? input : input.toString();
  const idMatch = url.match(/\/messages\/([^?]+)/);
  if (!idMatch) {
    return new Response("not found", { status: 404 });
  }
  const id = decodeURIComponent(idMatch[1]);
  const msg = graphMessages.get(id);
  if (!msg) return new Response("not found", { status: 404 });
  return new Response(JSON.stringify(msg), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as unknown as typeof fetch;

const stubAccessToken = async () => "fake-access-token";

// ─── Tests ──────────────────────────────────────────────────────────────────

async function testHappyPath() {
  console.log("\n[1] Happy path: valid clientState + In-Reply-To match");
  resetStubs();
  graphMessages = new Map();
  graphFetchCalls = 0;
  makeUser();
  const log = makeOutreachLog({
    threadId: "outbound-msg-id-1@broker.test",
    laneId: "lane-1",
  });

  graphMessages.set("graph-msg-resource-id-1", {
    id: "graph-msg-resource-id-1",
    internetMessageId: "<carrier-reply-1@carrier.test>",
    internetMessageHeaders: [
      { name: "In-Reply-To", value: "<outbound-msg-id-1@broker.test>" },
      { name: "References", value: "<outbound-msg-id-1@broker.test>" },
    ],
    subject: "Re: Lane availability",
    bodyPreview: "Yes we can cover that lane at $1850 all-in.",
    body: { contentType: "text", content: "Yes we can cover that lane at $1850 all-in." },
    from: { emailAddress: { address: "ops@carrier.test", name: "Carrier Ops" } },
    toRecipients: [{ emailAddress: { address: "replies@broker.test" } }],
    conversationId: "graph-conv-1",
    receivedDateTime: new Date().toISOString(),
  });

  const result = await processOutlookReplyNotifications(
    [
      {
        clientState: process.env.OUTLOOK_WEBHOOK_SECRET,
        resourceData: { id: "graph-msg-resource-id-1" },
      },
    ],
    { fetchImpl: stubFetch, accessTokenFn: stubAccessToken },
  );

  assert("returns received=1, processed=1", "received" in result && result.received === 1 && result.processed === 1,
    `got ${JSON.stringify(result)}`);
  assert("outreach log replyReceivedAt is now set", log.replyReceivedAt !== null);
  assert("outreach log replySnippet is recorded",
    typeof log.replySnippet === "string" && log.replySnippet.length > 0);
  assert("inbound email_messages row was created", emailMessages.length === 1);
  assert("inbound row has correct providerMessageId",
    emailMessages[0]?.providerMessageId === "carrier-reply-1@carrier.test");
  assert("inbound row is linked to the outreach log",
    emailMessages[0]?.linkedOutreachLogId === log.id);
  assert("inbound row threadId comes from conversationId",
    emailMessages[0]?.threadId === "graph-conv-1");
  assert("Graph message was fetched exactly once", graphFetchCalls === 1, `got ${graphFetchCalls}`);
}

async function testIdempotentRedelivery() {
  console.log("\n[2] Idempotent re-delivery: same Graph notification twice");
  resetStubs();
  graphMessages = new Map();
  graphFetchCalls = 0;
  makeUser();
  const log = makeOutreachLog({ threadId: "outbound-msg-id-2@broker.test" });

  graphMessages.set("graph-msg-resource-id-2", {
    id: "graph-msg-resource-id-2",
    internetMessageId: "<carrier-reply-2@carrier.test>",
    internetMessageHeaders: [
      { name: "In-Reply-To", value: "<outbound-msg-id-2@broker.test>" },
    ],
    subject: "Re: Lane availability",
    bodyPreview: "Confirmed.",
    body: { contentType: "text", content: "Confirmed." },
    from: { emailAddress: { address: "ops@carrier.test" } },
    toRecipients: [{ emailAddress: { address: "replies@broker.test" } }],
    conversationId: "graph-conv-2",
    receivedDateTime: new Date().toISOString(),
  });

  const notification = {
    clientState: process.env.OUTLOOK_WEBHOOK_SECRET,
    resourceData: { id: "graph-msg-resource-id-2" },
  };

  const r1 = await processOutlookReplyNotifications([notification], {
    fetchImpl: stubFetch,
    accessTokenFn: stubAccessToken,
  });
  const firstReplyAt = log.replyReceivedAt;

  const r2 = await processOutlookReplyNotifications([notification], {
    fetchImpl: stubFetch,
    accessTokenFn: stubAccessToken,
  });

  assert("first delivery: processed=1", "processed" in r1 && r1.processed === 1);
  assert("second delivery: processed=0 (already-replied skip)",
    "processed" in r2 && r2.processed === 0, `got ${JSON.stringify(r2)}`);
  assert("email_messages row count stays at 1 after re-delivery",
    emailMessages.length === 1, `got ${emailMessages.length}`);
  assert("outreach log replyReceivedAt is unchanged after re-delivery",
    log.replyReceivedAt === firstReplyAt);
}

async function testWrongClientStateRejected() {
  console.log("\n[3] Wrong clientState: notification rejected, no side effects");
  resetStubs();
  graphMessages = new Map();
  graphFetchCalls = 0;
  makeUser();
  const log = makeOutreachLog({ threadId: "outbound-msg-id-3@broker.test" });

  graphMessages.set("graph-msg-resource-id-3", {
    id: "graph-msg-resource-id-3",
    internetMessageId: "<carrier-reply-3@carrier.test>",
    internetMessageHeaders: [
      { name: "In-Reply-To", value: "<outbound-msg-id-3@broker.test>" },
    ],
    subject: "Re: Lane availability",
    bodyPreview: "Forged reply.",
    body: { contentType: "text", content: "Forged reply." },
    from: { emailAddress: { address: "spoof@evil.test" } },
    toRecipients: [{ emailAddress: { address: "replies@broker.test" } }],
    conversationId: "graph-conv-3",
    receivedDateTime: new Date().toISOString(),
  });

  const result = await processOutlookReplyNotifications(
    [
      {
        clientState: "this-is-not-the-real-secret",
        resourceData: { id: "graph-msg-resource-id-3" },
      },
    ],
    { fetchImpl: stubFetch, accessTokenFn: stubAccessToken },
  );

  assert("received=1 but processed=0",
    "received" in result && result.received === 1 && result.processed === 0,
    `got ${JSON.stringify(result)}`);
  assert("Graph fetch was NOT called for forged notification", graphFetchCalls === 0,
    `got ${graphFetchCalls}`);
  assert("outreach log was NOT marked as replied", log.replyReceivedAt === null);
  assert("no email_messages row was created", emailMessages.length === 0);
}

async function testMissingSecretRefusesBatch() {
  console.log("\n[4] Missing OUTLOOK_WEBHOOK_SECRET refuses entire batch");
  resetStubs();
  graphMessages = new Map();
  graphFetchCalls = 0;
  makeUser();
  const log = makeOutreachLog({ threadId: "outbound-msg-id-4@broker.test" });

  const savedSecret = process.env.OUTLOOK_WEBHOOK_SECRET;
  delete process.env.OUTLOOK_WEBHOOK_SECRET;
  try {
    const result = await processOutlookReplyNotifications(
      [
        {
          clientState: "anything",
          resourceData: { id: "graph-msg-resource-id-4" },
        },
      ],
      { fetchImpl: stubFetch, accessTokenFn: stubAccessToken },
    );
    assert("returns skipped marker", "skipped" in result,
      `got ${JSON.stringify(result)}`);
    assert("Graph fetch was NOT called when secret missing",
      graphFetchCalls === 0, `got ${graphFetchCalls}`);
    assert("outreach log untouched", log.replyReceivedAt === null);
    assert("no email_messages row created", emailMessages.length === 0);
  } finally {
    process.env.OUTLOOK_WEBHOOK_SECRET = savedSecret;
  }
}

async function testThreadAndLaneWorkQueueProjection() {
  console.log("\n[5] Reply also updates email_conversation_threads + surfaces in LWQ");
  resetStubs();
  graphMessages = new Map();
  graphFetchCalls = 0;
  makeUser();
  const log = makeOutreachLog({
    threadId: "outbound-msg-id-5@broker.test",
    laneId: "lane-555",
    carrierIds: ["carrier-555"],
  });

  graphMessages.set("graph-msg-resource-id-5", {
    id: "graph-msg-resource-id-5",
    internetMessageId: "<carrier-reply-5@carrier.test>",
    internetMessageHeaders: [
      { name: "In-Reply-To", value: "<outbound-msg-id-5@broker.test>" },
    ],
    subject: "Re: Lane availability",
    bodyPreview: "Yes, available all next week.",
    body: { contentType: "text", content: "Yes, available all next week." },
    from: { emailAddress: { address: "ops@carrier.test", name: "Carrier Ops" } },
    toRecipients: [{ emailAddress: { address: "replies@broker.test" } }],
    conversationId: "graph-conv-5",
    receivedDateTime: new Date().toISOString(),
  });

  // Pre-condition: no thread row, no LWQ reply for this lane.
  assert("pre: no thread row exists for graph-conv-5",
    threadStore.size === 0);
  assert("pre: LWQ projection shows zero replied logs for lane-555",
    laneOutreachLogsWithReplies("org-1", "lane-555").length === 0);

  const result = await processOutlookReplyNotifications(
    [
      {
        clientState: process.env.OUTLOOK_WEBHOOK_SECRET,
        resourceData: { id: "graph-msg-resource-id-5" },
      },
    ],
    { fetchImpl: stubFetch, accessTokenFn: stubAccessToken },
  );

  assert("returns processed=1", "processed" in result && result.processed === 1,
    `got ${JSON.stringify(result)}`);

  // ── email_conversation_threads assertions ──────────────────────────────────
  const thread = threadStore.get("org-1::graph-conv-5");
  assert("thread row was upserted for org-1::graph-conv-5", thread !== undefined);
  assert("thread waitingState flipped to waiting_on_us",
    thread?.waitingState === "waiting_on_us",
    `got ${thread?.waitingState}`);
  assert("thread lastIncomingAt is set",
    thread?.lastIncomingAt instanceof Date && !Number.isNaN(thread!.lastIncomingAt.getTime()));
  assert("thread waitingSinceAt is set (SLA clock starts)",
    thread?.waitingSinceAt instanceof Date && !Number.isNaN(thread!.waitingSinceAt.getTime()));
  assert("thread is linked to the carrier from the outreach log",
    thread?.linkedCarrierId === "carrier-555");

  // ── Idempotent re-delivery: thread should NOT be touched again ─────────────
  const firstUpdatedAt = thread?.updatedAt;
  await new Promise(r => setTimeout(r, 5));
  const r2 = await processOutlookReplyNotifications(
    [
      {
        clientState: process.env.OUTLOOK_WEBHOOK_SECRET,
        resourceData: { id: "graph-msg-resource-id-5" },
      },
    ],
    { fetchImpl: stubFetch, accessTokenFn: stubAccessToken },
  );
  assert("second delivery: processed=0 (no thread re-upsert)",
    "processed" in r2 && r2.processed === 0,
    `got ${JSON.stringify(r2)}`);
  const threadAfter = threadStore.get("org-1::graph-conv-5");
  assert("thread updatedAt is unchanged after duplicate notification",
    threadAfter?.updatedAt === firstUpdatedAt);

  // ── Available Freight LWQ projection ───────────────────────────────────────
  const lwqRows = laneOutreachLogsWithReplies("org-1", "lane-555");
  assert("LWQ projection now surfaces 1 replied outreach log for lane-555",
    lwqRows.length === 1, `got ${lwqRows.length}`);
  assert("LWQ row corresponds to the matched outreach log",
    lwqRows[0]?.id === log.id);
  assert("LWQ row has reply snippet projected from the inbound message",
    typeof lwqRows[0]?.replySnippet === "string" && lwqRows[0]!.replySnippet!.length > 0);
}

// ─── Driver ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Shared Inbox Webhook — E2E Tests (Task #549)");
  console.log("══════════════════════════════════════════════════════════════");

  await testHappyPath();
  await testIdempotentRedelivery();
  await testWrongClientStateRejected();
  await testMissingSecretRefusesBatch();
  await testThreadAndLaneWorkQueueProjection();

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("\nFailing assertions:");
    for (const f of failures) console.error(`  • ${f}`);
    process.exit(1);
  }
  console.log("══════════════════════════════════════════════════════════════");
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
