// Task #969 — Customer Quotes trust hardening (defect 1).
//
// Pins the JSON shape produced by `buildAttributionResponse` (the pure
// helper that powers `GET /api/customer-quotes/quote/:id/attribution`)
// against fixture rows so future drift in the SELECT projection or the
// rule-inference helper breaks loudly.
//
// We test the helper directly rather than mounting the Express handler
// so the test stays free of Clerk middleware + database setup. The
// route handler now does only `db.execute(...) → buildAttributionResponse(row)`,
// so the helper carries the full response contract.

import {
  buildAttributionResponse,
  buildForceReprocessBody,
} from "../server/routes/customerQuotes";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function expectEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label} — expected ${b} got ${a}`);
    failures.push(label);
    failed++;
  }
}

console.log("══════════════════════════════════════════════════════════════");
console.log("  buildAttributionResponse — JSON shape contract");
console.log("══════════════════════════════════════════════════════════════");

console.log("── account_owner rule (full email source + matched contact) ──");
{
  const row = {
    quote_id: "quote-with-email",
    source_reference: "msg-providerid-001",
    created_at: "2026-04-01T12:00:00.000Z",
    customer_id: "cust-1",
    customer_name: "Acme Logistics",
    rep_id: "rep-1",
    rep_name: "Pat Rep",
    rep_email: "pat@broker.example",
    message_id: "msg-1",
    sender_email: "ops@acme.example",
    sender_name: "Acme Ops",
    recipient_email: "quotes@broker.example",
    subject: "RFQ — Chicago to Dallas",
    sent_at: "2026-04-01T11:55:00.000Z",
    received_at: "2026-04-01T11:56:00.000Z",
    contact_id: "ct-1",
    contact_name: "Lee Buyer",
    contact_email: "ops@acme.example",
    contact_title: "Logistics Manager",
  };
  const r = buildAttributionResponse(row);
  expectEq("ok=true", r.ok, true);
  expectEq("quoteId echoed", r.quoteId, "quote-with-email");
  expectEq("rule.name=account_owner", r.rule.name, "account_owner");
  expectEq(
    "rule.description (account_owner)",
    r.rule.description,
    "Rep owns the customer-facing inbox this inbound email was sent to.",
  );
  expectEq("rule.decidedAt = received_at", r.rule.decidedAt, "2026-04-01T11:56:00.000Z");
  expectEq(
    "rule.inputs.recipientEmail",
    r.rule.inputs?.recipientEmail,
    "quotes@broker.example",
  );
  expectEq(
    "rule.inputs.inboundMessageId",
    r.rule.inputs?.inboundMessageId,
    "msg-1",
  );
  expectEq("rule.inputs.senderEmail", r.rule.inputs?.senderEmail, "ops@acme.example");
  expectEq("customer.id", r.customer?.id, "cust-1");
  expectEq("customer.name", r.customer?.name, "Acme Logistics");
  expectEq("rep.name", r.rep?.name, "Pat Rep");
  expectEq("rep.email", r.rep?.email, "pat@broker.example");
  expectEq("contact.id", r.contact?.id, "ct-1");
  expectEq("contact.name", r.contact?.name, "Lee Buyer");
  expectEq("contact.title", r.contact?.title, "Logistics Manager");
  expectEq("contact.email", r.contact?.email, "ops@acme.example");
  expectEq("sender.subject", r.sender?.subject, "RFQ — Chicago to Dallas");
  expectEq("sender.recipientEmail", r.sender?.recipientEmail, "quotes@broker.example");
  expectEq("sender.email", r.sender?.email, "ops@acme.example");
  expectEq("sender.sentAt", r.sender?.sentAt, "2026-04-01T11:55:00.000Z");
}

console.log("── decidedAt fallback chain (received_at → sent_at → created_at) ──");
{
  // No received_at — decidedAt should fall back to sent_at.
  const r1 = buildAttributionResponse({
    quote_id: "q1",
    source_reference: "ref",
    created_at: "2026-01-01T00:00:00.000Z",
    customer_id: null, customer_name: null,
    rep_id: "r1", rep_name: "X", rep_email: null,
    message_id: "m1", sender_email: null, sender_name: null, recipient_email: null,
    subject: null, sent_at: "2026-04-01T11:55:00.000Z", received_at: null,
    contact_id: null, contact_name: null, contact_email: null, contact_title: null,
  });
  expectEq("falls back to sent_at when received_at null", r1.rule.decidedAt, "2026-04-01T11:55:00.000Z");
}

console.log("── fallback rule (manual quote, no email source) ──");
{
  const row = {
    quote_id: "quote-manual",
    source_reference: null,
    created_at: "2026-04-02T09:00:00.000Z",
    customer_id: null, customer_name: null,
    rep_id: "rep-2", rep_name: "Sam Rep", rep_email: null,
    message_id: null,
    sender_email: null, sender_name: null, recipient_email: null,
    subject: null, sent_at: null, received_at: null,
    contact_id: null, contact_name: null, contact_email: null, contact_title: null,
  };
  const r = buildAttributionResponse(row);
  expectEq("rule.name=fallback", r.rule.name, "fallback");
  expectEq("rule.inputs is null", r.rule.inputs, null);
  expectEq(
    "rule.description (fallback)",
    r.rule.description,
    "No automated assignment rule fired; rep was set manually.",
  );
  expectEq(
    "rule.decidedAt falls back to created_at",
    r.rule.decidedAt,
    "2026-04-02T09:00:00.000Z",
  );
  expectEq("customer is null", r.customer, null);
  expectEq("contact is null", r.contact, null);
  expectEq("sender is null", r.sender, null);
  expectEq("rep still present", r.rep?.name, "Sam Rep");
}

console.log("── contact null when CRM has no matching email ──");
{
  // Has an inbound source but no contact joined (sender email isn't
  // in the contacts table). `inbox_recipient` rule still fires; the
  // contact section just goes null so the drawer can render the
  // "no CRM contact matched" empty state.
  const row = {
    quote_id: "q-no-contact",
    source_reference: "ref",
    created_at: "2026-04-03T00:00:00.000Z",
    customer_id: "c1", customer_name: "Cust",
    rep_id: "r1", rep_name: "Rep", rep_email: "r@b.example",
    message_id: "m1",
    sender_email: "stranger@unknown.example",
    sender_name: "Stranger",
    recipient_email: "in@b.example",
    subject: "Hello",
    sent_at: "2026-04-03T00:00:00.000Z",
    received_at: "2026-04-03T00:01:00.000Z",
    contact_id: null, contact_name: null, contact_email: null, contact_title: null,
  };
  const r = buildAttributionResponse(row);
  expectEq("rule still account_owner", r.rule.name, "account_owner");
  expectEq("contact is null", r.contact, null);
  expectEq("sender still present", r.sender?.email, "stranger@unknown.example");
}

console.log("══════════════════════════════════════════════════════════════");
console.log("  buildForceReprocessBody — toast-routing contract (unhappy paths)");
console.log("══════════════════════════════════════════════════════════════");

// The rep-side mutations in `thread-row.tsx` and `thread-detail-pane.tsx`
// rely on every handled outcome being delivered as a 200-status JSON
// body so the `onSuccess` switch can route "unparseable" → "View drops
// queue" toast and "not_found" → "no inbound" toast. These assertions
// pin that contract: the helper that builds the body must always
// echo back `status` so the client can switch on it.

console.log("── unparseable carries reason + null quoteId ──");
{
  const body = buildForceReprocessBody(
    { status: "unparseable", reason: "AI fallback returned no quote shape" },
    "msg-42",
  );
  expectEq("status=unparseable", body.status, "unparseable");
  expectEq("quoteId=null", body.quoteId, null);
  expectEq("reason echoed", body.reason, "AI fallback returned no quote shape");
  expectEq("messageId echoed", body.messageId, "msg-42");
}

console.log("── not_found preserves null messageId for threadId-no-inbound ──");
{
  // The threadId-resolves-to-zero-inbounds branch invokes the helper
  // with messageId=null. The toast then routes to "No inbound to
  // reprocess" without trying to deep-link.
  const body = buildForceReprocessBody({ status: "not_found" }, null);
  expectEq("status=not_found", body.status, "not_found");
  expectEq("messageId=null", body.messageId, null);
  expectEq("quoteId=null", body.quoteId, null);
  expectEq("reason=null", body.reason, null);
}

console.log("── created carries quoteId for the deep link ──");
{
  const body = buildForceReprocessBody(
    { status: "created", quoteId: "q-new-001" },
    "msg-42",
  );
  expectEq("status=created", body.status, "created");
  expectEq("quoteId echoed", body.quoteId, "q-new-001");
}

console.log("── wrong_direction returns 200 body status ──");
{
  const body = buildForceReprocessBody({ status: "wrong_direction" }, "msg-42");
  expectEq("status=wrong_direction", body.status, "wrong_direction");
  expectEq("quoteId=null", body.quoteId, null);
}

console.log("──────────────────────────────────────────────────────────────");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════════════");
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
