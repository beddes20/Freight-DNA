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
//
// Task #994 — added a SECOND test block at the bottom of this file
// that exercises the actual attribution SQL (fetchAttributionRow)
// against a live PostgreSQL database. The Task #969 helper-only
// coverage was insufficient: the SELECT itself referenced
// `ct.organization_id` (a column that does not exist on `contacts`,
// which is org-scoped via `companies.organization_id`), so the
// endpoint returned 500 in production while every helper assertion
// stayed green. The new block inserts a minimum row set, runs the
// real SQL, and asserts (a) contact match, (b) cross-tenant
// isolation, (c) missing-contact graceful return, (d) the previously
// failing column reference no longer raises.

import {
  buildAttributionResponse,
  buildForceReprocessBody,
  fetchAttributionRow,
} from "../server/routes/customerQuotes";
import { db } from "../server/storage";
import {
  organizations,
  companies,
  contacts,
  emailMessages,
  quoteCustomers,
  quoteOpportunities,
} from "../shared/schema";
import { eq, inArray } from "drizzle-orm";

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

// ════════════════════════════════════════════════════════════════════════
// Task #994 — SQL-level regression coverage for the attribution SELECT.
// ════════════════════════════════════════════════════════════════════════
//
// Runs the actual `fetchAttributionRow` query against a live Postgres
// dev database (DATABASE_URL must be set). Inserts a minimum row set,
// asserts the join behavior, then cleans up everything it created.
//
// What this pins that the helper tests above do NOT:
//   • The SELECT compiles and returns the projection AttributionRow
//     expects — no `column ... does not exist` errors at execution.
//   • The contacts join is org-scoped via `companies.organization_id`
//     (the original bug used `ct.organization_id`, which Postgres
//     rejected at execution time).
//   • A contact in another org's company with the same email never
//     leaks into the attribution payload.
//   • The LEFT JOIN semantics still hold when no contact matches
//     (the quote row + its email row return; contact_id is NULL).
//   • The WHERE clause's organizationId filter prevents cross-tenant
//     reads of the quote itself.

async function runSqlRegressionBlock(): Promise<void> {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  fetchAttributionRow — live-SQL regression (Task #994)");
  console.log("══════════════════════════════════════════════════════════════");

  const ts = Date.now();
  const orgIdsToCleanup: string[] = [];
  const quoteIdsToCleanup: string[] = [];
  const customerIdsToCleanup: string[] = [];
  const messageIdsToCleanup: string[] = [];
  const contactIdsToCleanup: string[] = [];
  const companyIdsToCleanup: string[] = [];

  try {
    // ── Seed two orgs so cross-tenant isolation is testable.
    const [orgA] = await db
      .insert(organizations)
      .values({ name: `Attribution Test Org A ${ts}`, slug: `attr-a-${ts}` })
      .returning();
    const [orgB] = await db
      .insert(organizations)
      .values({ name: `Attribution Test Org B ${ts}`, slug: `attr-b-${ts}` })
      .returning();
    orgIdsToCleanup.push(orgA.id, orgB.id);

    // Two CRM companies (one per org) plus a contact in EACH whose email
    // matches the inbound sender. Cross-tenant isolation MUST suppress
    // orgB's contact even though the email matches.
    const SENDER_EMAIL = `sender-${ts}@acme.example`;

    const [companyA] = await db
      .insert(companies)
      .values({ organizationId: orgA.id, name: `Acme Logistics A ${ts}` })
      .returning();
    const [companyB] = await db
      .insert(companies)
      .values({ organizationId: orgB.id, name: `Acme Logistics B ${ts}` })
      .returning();
    companyIdsToCleanup.push(companyA.id, companyB.id);

    const [contactA] = await db
      .insert(contacts)
      .values({
        companyId: companyA.id,
        name: "Lee Buyer",
        email: SENDER_EMAIL,
        title: "Logistics Manager",
      })
      .returning();
    const [contactB] = await db
      .insert(contacts)
      .values({
        companyId: companyB.id,
        name: "Imposter Buyer",
        email: SENDER_EMAIL,
        title: "Should Not Match",
      })
      .returning();
    contactIdsToCleanup.push(contactA.id, contactB.id);

    // Inbound email addressed to orgA's quote inbox.
    const PROVIDER_MSG_ID = `provider-msg-${ts}`;
    const [emailA] = await db
      .insert(emailMessages)
      .values({
        orgId: orgA.id,
        providerMessageId: PROVIDER_MSG_ID,
        direction: "inbound",
        fromEmail: SENDER_EMAIL,
        toEmail: "quotes@broker.example",
        subject: "RFQ — Chicago to Dallas",
      })
      .returning();
    messageIdsToCleanup.push(emailA.id);

    // Two quote_customers (one per org) — required by the FK on
    // quote_opportunities.customer_id.
    const [qCustomerA] = await db
      .insert(quoteCustomers)
      .values({ organizationId: orgA.id, name: `QCust A ${ts}` })
      .returning();
    const [qCustomerB] = await db
      .insert(quoteCustomers)
      .values({ organizationId: orgB.id, name: `QCust B ${ts}` })
      .returning();
    customerIdsToCleanup.push(qCustomerA.id, qCustomerB.id);

    // Quote that points at the inbound email via source_reference.
    // (The email join key is provider_message_id OR id.)
    const [quoteWithEmail] = await db
      .insert(quoteOpportunities)
      .values({
        organizationId: orgA.id,
        customerId: qCustomerA.id,
        requestDate: new Date(),
        originCity: "Chicago",
        originState: "IL",
        destCity: "Dallas",
        destState: "TX",
        equipment: "VAN",
        source: "email",
        sourceReference: PROVIDER_MSG_ID,
      })
      .returning();
    quoteIdsToCleanup.push(quoteWithEmail.id);

    // Quote with NO source email — exercises the LEFT JOIN-no-match path
    // (drawer must still render; sender + contact go null).
    const [quoteManual] = await db
      .insert(quoteOpportunities)
      .values({
        organizationId: orgA.id,
        customerId: qCustomerA.id,
        requestDate: new Date(),
        originCity: "Reno",
        originState: "NV",
        destCity: "Boise",
        destState: "ID",
        equipment: "VAN",
        source: "manual",
        sourceReference: null,
      })
      .returning();
    quoteIdsToCleanup.push(quoteManual.id);

    // ── (a) Email-source quote returns the matching contact, scoped to org.
    console.log("── (a) email-source quote — contact in org matches ──");
    const rowA = await fetchAttributionRow(quoteWithEmail.id, orgA.id);
    expectEq("row returned", rowA !== null, true);
    expectEq("quote_id echoed", rowA?.quote_id, quoteWithEmail.id);
    expectEq("message_id matched", rowA?.message_id, emailA.id);
    expectEq("sender_email matched", rowA?.sender_email, SENDER_EMAIL);
    expectEq("recipient_email matched", rowA?.recipient_email, "quotes@broker.example");
    expectEq("contact matched in-org only", rowA?.contact_id, contactA.id);
    expectEq("contact_email echoed", rowA?.contact_email, SENDER_EMAIL);
    expectEq("contact_title echoed", rowA?.contact_title, "Logistics Manager");
    // sender_name is intentionally NULL in the projection (no from_name
    // column on email_messages today). Pin that so future drift is loud.
    expectEq("sender_name is null (no from_name column)", rowA?.sender_name, null);
    // received_at is COALESCE'd to created_at; just assert presence.
    expectEq("received_at present (created_at proxy)", typeof rowA?.received_at === "string" || rowA?.received_at instanceof Date, true);

    // ── (b) Cross-tenant isolation — contactB (orgB) must not leak.
    console.log("── (b) cross-tenant — orgB contact with same email is excluded ──");
    expectEq("contactB is NOT contactA", contactA.id !== contactB.id, true);
    expectEq("rowA.contact_id is exactly contactA.id, never contactB.id", rowA?.contact_id !== contactB.id, true);

    // Also: the WHERE clause's org filter must hide the quote itself
    // when a different org asks for it.
    const crossOrgRow = await fetchAttributionRow(quoteWithEmail.id, orgB.id);
    expectEq("cross-org fetch returns null (no quote leak)", crossOrgRow, null);

    // ── (c) Quote with no email source — LEFT JOIN-no-match still returns row.
    console.log("── (c) manual quote — no email + no contact, drawer still renders ──");
    const rowManual = await fetchAttributionRow(quoteManual.id, orgA.id);
    expectEq("manual quote row returned", rowManual !== null, true);
    expectEq("manual quote_id echoed", rowManual?.quote_id, quoteManual.id);
    expectEq("manual message_id is null", rowManual?.message_id, null);
    expectEq("manual sender_email is null", rowManual?.sender_email, null);
    expectEq("manual contact_id is null", rowManual?.contact_id, null);

    // ── (d) The previously-failing column reference no longer raises.
    // (Implicit: every fetch above completed without throwing. Make it
    // explicit so the test name is grep-able when the bug is reintroduced.)
    console.log("── (d) `column ct.organization_id does not exist` regression ──");
    expectEq("fetchAttributionRow does not throw on join", true, true);

    // End-to-end pure pipeline: feed the live SQL row through the
    // builder so we also pin that the projection keys still align with
    // the helper's destructuring.
    if (rowA) {
      const built = buildAttributionResponse(rowA);
      expectEq("e2e: rule.name", built.rule.name, "account_owner");
      expectEq("e2e: contact.id", built.contact?.id, contactA.id);
      expectEq("e2e: sender.recipientEmail", built.sender?.recipientEmail, "quotes@broker.example");
    }
  } finally {
    // Cleanup — order matters because of FKs. quote_opportunities →
    // quote_customers → email_messages → contacts → companies → orgs.
    if (quoteIdsToCleanup.length) {
      await db.delete(quoteOpportunities).where(inArray(quoteOpportunities.id, quoteIdsToCleanup));
    }
    if (customerIdsToCleanup.length) {
      await db.delete(quoteCustomers).where(inArray(quoteCustomers.id, customerIdsToCleanup));
    }
    if (messageIdsToCleanup.length) {
      await db.delete(emailMessages).where(inArray(emailMessages.id, messageIdsToCleanup));
    }
    if (contactIdsToCleanup.length) {
      await db.delete(contacts).where(inArray(contacts.id, contactIdsToCleanup));
    }
    if (companyIdsToCleanup.length) {
      await db.delete(companies).where(inArray(companies.id, companyIdsToCleanup));
    }
    for (const orgId of orgIdsToCleanup) {
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
  }
}

async function main(): Promise<void> {
  await runSqlRegressionBlock();

  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════════════");
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error in attribution test harness:", err);
  process.exit(1);
});
