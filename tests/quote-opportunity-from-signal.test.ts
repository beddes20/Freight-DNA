/**
 * Task #847 — Quote leak forward closure (Phase 2b, dry-run first).
 *
 * Verifies the new `quoteOpportunityFromSignalService` decision tree:
 *
 *   1. skip-internal — sender domain matches an org's monitored mailbox
 *      or any internal user (drives the valuetruck.com false positive).
 *   2. skipped_low_confidence / would_skipped_low_confidence —
 *      confidence < CLOSURE_CONFIDENCE_FLOOR (or unresolvable
 *      free-mail sender) is parked in the existing capture leak queue
 *      (`capture_leak_reviews` row, decision='deferred',
 *      note='low_confidence: ...' or 'unresolvable_sender: ...').
 *   3. attach-to-existing — open `quote_opportunities` row for the same
 *      customer within last 14d → link signal via
 *      `email_signals.linked_opportunity_id`.
 *   4. create — insert draft `quote_opportunities` row with
 *      `source='email_signal'`, `source_reference=providerMessageId`.
 *      Partial unique index on
 *      `(organization_id, source_reference) WHERE source='email_signal'`
 *      makes this idempotent across concurrent ticks.
 *
 * Plus dry-run gating (`QUOTE_LEAK_FORWARD_CLOSURE_ENABLED=false`):
 * counters increment as `would_create` / `would_attach` /
 * `would_skipped_low_confidence`; no DB writes. Dry-run runs the
 * full attach-vs-create resolution (read-only customer + open-opp
 * lookup) so `would_attach` is NOT undercounted.
 */

import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required to run this test");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  \u2713 ${description}`);
    passed++;
  } else {
    console.log(`  \u2717 ${description}${detail ? ` \u2014 ${detail}` : ""}`);
    failed++;
    failures.push(`${description}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n\u2500\u2500 ${title} \u2500\u2500`);
}

interface Fixture {
  orgId: string;
  userId: string;
  internalDomain: string;
  customerDomain: string;
  customerEmail: string;
}

async function pickRealOrgWithUser(pool: Pool): Promise<Fixture | null> {
  // Reuse a real org + user so FKs (`monitored_mailboxes.org_id` /
  // `user_id`, `email_messages.org_id`, `quote_opportunities.organization_id`)
  // resolve. Every row we add is namespaced by a unique provider_message_id
  // (and a unique external customer domain) and torn down in finally{}.
  const r = await pool.query<{ organization_id: string; id: string }>(
    `SELECT u.organization_id, u.id
       FROM users u
      WHERE u.organization_id IS NOT NULL
      ORDER BY u.id
      LIMIT 1`,
  );
  if (r.rows.length === 0) return null;
  const orgId = r.rows[0].organization_id;
  const userId = r.rows[0].id;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const internalDomain = `task847-internal-${stamp}.example`;
  const customerDomain = `task847-external-${stamp}.example`;
  const customerEmail = `procurement@${customerDomain}`;
  return { orgId, userId, internalDomain, customerDomain, customerEmail };
}

async function ensureMonitoredMailbox(pool: Pool, fx: Fixture): Promise<void> {
  // Internal-domain skip is driven by the union of monitored_mailboxes.email
  // and users.username (both are sources of "this is one of our addresses").
  // Insert a monitored_mailbox row for the deterministic test domain so
  // the cache picks it up after _resetInternalDomainsCacheForTests().
  const localPart = `mailbox-${Date.now()}`;
  const email = `${localPart}@${fx.internalDomain}`;
  await pool.query(
    `INSERT INTO monitored_mailboxes (org_id, user_id, email, enabled)
     VALUES ($1, $2, $3, true)`,
    [fx.orgId, fx.userId, email],
  );
}

async function insertMessage(
  pool: Pool,
  fx: Fixture,
  args: {
    fromEmail: string;
    providerMessageId: string;
    direction?: "inbound" | "outbound";
    subject?: string;
    body?: string;
  },
): Promise<{ id: string }> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO email_messages
       (org_id, provider_message_id, thread_id, direction,
        from_email, to_email, subject, body, provider_sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING id`,
    [
      fx.orgId,
      args.providerMessageId,
      `thread-${args.providerMessageId}`,
      args.direction ?? "inbound",
      args.fromEmail,
      `rep-${Date.now()}@example.com`,
      args.subject ?? `Need a quote — ${fx.customerName}`,
      args.body ?? `Looking for pricing on a load. Sender: ${fx.customerName}`,
    ],
  );
  return { id: r.rows[0].id };
}

async function insertSignal(
  pool: Pool,
  args: { messageId: string; intentType: string; confidence: number; actorType?: string },
): Promise<{ id: string; linkedOpportunityId: string | null }> {
  const r = await pool.query<{ id: string; linked_opportunity_id: string | null }>(
    `INSERT INTO email_signals
       (message_id, intent_type, actor_type, confidence, extracted_data)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)
     RETURNING id, linked_opportunity_id`,
    [args.messageId, args.intentType, args.actorType ?? "customer", args.confidence],
  );
  return { id: r.rows[0].id, linkedOpportunityId: r.rows[0].linked_opportunity_id };
}

async function getSignalLink(pool: Pool, signalId: string): Promise<string | null> {
  const r = await pool.query<{ linked_opportunity_id: string | null }>(
    `SELECT linked_opportunity_id FROM email_signals WHERE id = $1`,
    [signalId],
  );
  return r.rows[0]?.linked_opportunity_id ?? null;
}

async function countOppsForRef(pool: Pool, orgId: string, ref: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM quote_opportunities
      WHERE organization_id = $1 AND source_reference = $2`,
    [orgId, ref],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function getLeakReview(
  pool: Pool,
  orgId: string,
  messageId: string,
): Promise<{ decision: string; note: string | null } | null> {
  const r = await pool.query<{ decision: string; note: string | null }>(
    `SELECT decision, note
       FROM capture_leak_reviews
      WHERE organization_id = $1 AND message_id = $2 AND leak_type = 'missed_inbound'`,
    [orgId, messageId],
  );
  return r.rows[0] ?? null;
}

async function findCustomerIdsByDomainPattern(
  pool: Pool,
  orgId: string,
  pattern: string,
): Promise<string[]> {
  // Returns every quote_customers id whose name was derived from a
  // test-scoped domain root (e.g. "Task847-External-1234567890").
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM quote_customers
       WHERE organization_id = $1
         AND lower(name) LIKE lower($2)`,
    [orgId, pattern],
  );
  return r.rows.map((x) => x.id);
}

async function cleanup(pool: Pool, fx: Fixture, providerMessageIds: string[]): Promise<void> {
  // FK-safe teardown.
  if (providerMessageIds.length > 0) {
    await pool.query(
      `DELETE FROM capture_leak_reviews
         WHERE organization_id = $1
           AND message_id IN (
             SELECT id FROM email_messages
              WHERE org_id = $1 AND provider_message_id = ANY($2::text[])
           )`,
      [fx.orgId, providerMessageIds],
    );
    await pool.query(
      `DELETE FROM email_signals
         WHERE message_id IN (
           SELECT id FROM email_messages
            WHERE org_id = $1 AND provider_message_id = ANY($2::text[])
         )`,
      [fx.orgId, providerMessageIds],
    );
    await pool.query(
      `DELETE FROM quote_opportunities
         WHERE organization_id = $1
           AND source = 'email_signal'
           AND source_reference = ANY($2::text[])`,
      [fx.orgId, providerMessageIds],
    );
    await pool.query(
      `DELETE FROM email_messages
         WHERE org_id = $1 AND provider_message_id = ANY($2::text[])`,
      [fx.orgId, providerMessageIds],
    );
  }
  // Drop every quote_customers row whose name was derived from our
  // unique test customer domain (the resolver title-cases the domain
  // root, so the timestamped slug is preserved in the row name and
  // gives us a stable cleanup pattern). Opps for those customers are
  // deleted first to satisfy the FK.
  const testCustomerIds = await findCustomerIdsByDomainPattern(
    pool, fx.orgId, `%${fx.customerDomain.split(".")[0]}%`,
  );
  if (testCustomerIds.length > 0) {
    await pool.query(
      `DELETE FROM quote_opportunities
         WHERE organization_id = $1 AND customer_id = ANY($2::text[])`,
      [fx.orgId, testCustomerIds],
    );
    await pool.query(
      `DELETE FROM quote_customers WHERE id = ANY($1::text[])`,
      [testCustomerIds],
    );
  }
  await pool.query(
    `DELETE FROM monitored_mailboxes
       WHERE org_id = $1 AND email LIKE $2`,
    [fx.orgId, `%@${fx.internalDomain}`],
  );
}

async function loadEmailMessage(pool: Pool, id: string): Promise<unknown> {
  const r = await pool.query(
    `SELECT id, org_id AS "orgId", provider_message_id AS "providerMessageId",
            thread_id AS "threadId", direction, from_email AS "fromEmail",
            to_email AS "toEmail", cc_email AS "ccEmail", subject, body,
            provider_sent_at AS "providerSentAt",
            created_at AS "createdAt"
       FROM email_messages WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function loadEmailSignal(pool: Pool, id: string): Promise<unknown> {
  const r = await pool.query(
    `SELECT id, message_id AS "messageId", intent_type AS "intentType",
            intent_subtype AS "intentSubtype", actor_type AS "actorType",
            confidence, extracted_data AS "extractedData",
            linked_opportunity_id AS "linkedOpportunityId",
            created_at AS "createdAt"
       FROM email_signals WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const providerMessageIds: string[] = [];
  let fx: Fixture | null = null;

  try {
    section("Fixture setup");
    fx = await pickRealOrgWithUser(pool);
    if (!fx) {
      console.log("  ! No org/user available — skipping test");
      process.exit(0);
    }
    console.log(`  \u2192 org=${fx.orgId} internalDomain=${fx.internalDomain} customerEmail=${fx.customerEmail}`);
    await ensureMonitoredMailbox(pool, fx);

    section("Partial unique index migration");
    const idxR = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'quote_opportunities_email_signal_source_ref_uidx'`,
    );
    assert("quote_opportunities_email_signal_source_ref_uidx exists",
      Number(idxR.rows[0]?.n ?? 0) === 1);

    const svc = await import("../server/services/quoteOpportunityFromSignalService");
    svc._resetInternalDomainsCacheForTests();
    svc._resetClosureCountersForTests();
    // The boot-time verifyClosureIdempotencyIndex() doesn't run when
    // we import the module directly; flip the gate manually so live
    // writes are allowed (the index existence assertion above is the
    // real verification).
    svc._resetIdempotencyIndexFlagForTests(true);

    // ── extractDomain robustness — anti-bypass regression suite ──────────
    // The first review caught that a bare slice on the From header
    // failed to recognize `Display Name <user@valuetruck.com>` as
    // internal. These cases lock in the multi-format parser.
    section("extractDomain — header-format robustness");
    {
      const cases: Array<[string | null | undefined, string | null]> = [
        ["user@valuetruck.com", "valuetruck.com"],
        ["Jane Doe <jane@valuetruck.com>", "valuetruck.com"],
        ["<jane@valuetruck.com>", "valuetruck.com"],
        ["  USER@HOST.TLD  ", "host.tld"],
        ['"Last, First" <fl@valuetruck.com>', "valuetruck.com"],
        ["jane@valuetruck.com;", "valuetruck.com"],
        ["plainstring", null],
        ["", null],
        [null, null],
        [undefined, null],
      ];
      for (const [input, expected] of cases) {
        const got = svc._extractDomainForTests(input);
        assert(
          `extractDomain(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`,
          got === expected,
          `got ${JSON.stringify(got)}`,
        );
      }
    }

    // ── isInternalDomain — display-name header path (the bypass) ─────────
    // Stand up a synthetic monitored mailbox at fx.internalDomain, then
    // assert that ALL three header forms (bare, display-name, angle)
    // are recognized as internal.
    section("isInternalDomain — recognises all stored From-header shapes");
    {
      svc._resetInternalDomainsCacheForTests();
      const variants = [
        `someone@${fx.internalDomain}`,
        `Some One <someone@${fx.internalDomain}>`,
        `<someone@${fx.internalDomain}>`,
      ];
      for (const v of variants) {
        const isInternal = await svc.isInternalDomain(fx.orgId, v);
        assert(`isInternalDomain('${v}') is true`, isInternal === true);
      }
      const ext = await svc.isInternalDomain(fx.orgId, `cust@${fx.customerDomain}`);
      assert(`isInternalDomain external sender is false`, ext === false);
    }

    // ── isInternalDomain — org-settings override (third source) ──────────
    section("isInternalDomain — picks up organizations.internal_domains");
    {
      const overrideDomain = `task847-orgsettings-${Date.now()}.example`;
      await pool.query(
        `UPDATE organizations
            SET internal_domains = COALESCE(internal_domains, ARRAY[]::text[]) || ARRAY[$2::text]
          WHERE id = $1`,
        [fx.orgId, overrideDomain],
      );
      try {
        svc._resetInternalDomainsCacheForTests();
        const recognised = await svc.isInternalDomain(
          fx.orgId, `someone@${overrideDomain}`,
        );
        assert(
          `org-settings entry alone is enough to mark a domain internal`,
          recognised === true,
        );
      } finally {
        await pool.query(
          `UPDATE organizations
              SET internal_domains = ARRAY(
                SELECT d FROM unnest(COALESCE(internal_domains, ARRAY[]::text[])) d
                 WHERE d <> $2
              )
            WHERE id = $1`,
          [fx.orgId, overrideDomain],
        );
      }
    }

    // ── live writes are gated on the idempotency-index flag ──────────────
    section("live writes refuse to run without verified index");
    {
      svc._resetIdempotencyIndexFlagForTests(false);
      const ref = `task847-noindex-${Date.now()}-guard`;
      providerMessageIds.push(ref);
      const m = await insertMessage(pool, fx, {
        fromEmail: fx.customerEmail, providerMessageId: ref,
      });
      const sig = await insertSignal(pool, {
        messageId: m.id, intentType: "pricing_request", confidence: 90,
      });
      process.env.QUOTE_LEAK_FORWARD_CLOSURE_ENABLED = "true";
      const msgRow = await loadEmailMessage(pool, m.id);
      const sigRow = await loadEmailSignal(pool, sig.id);
      const results = await svc.processQuoteSignalClosure(msgRow as never, [sigRow as never]);
      assert("outcome is skipped_not_eligible when flag is false",
        results[0]?.outcome === "skipped_not_eligible",
        `got ${results[0]?.outcome}`);
      assert("no opp written while flag is false",
        (await countOppsForRef(pool, fx.orgId, ref)) === 0);
      svc._resetIdempotencyIndexFlagForTests(true);
    }

    // ── Case 1: internal domain → skipped_internal (no writes) ───────────
    section("Case 1 — internal domain skip");
    {
      const ref = `task847-internal-${Date.now()}-1`;
      providerMessageIds.push(ref);
      const m = await insertMessage(pool, fx, {
        fromEmail: `someone@${fx.internalDomain}`,
        providerMessageId: ref,
      });
      const sig = await insertSignal(pool, {
        messageId: m.id, intentType: "pricing_request", confidence: 90,
      });
      process.env.QUOTE_LEAK_FORWARD_CLOSURE_ENABLED = "true";
      const msgRow = await loadEmailMessage(pool, m.id);
      const sigRow = await loadEmailSignal(pool, sig.id);
      const results = await svc.processQuoteSignalClosure(msgRow as never, [sigRow as never]);
      assert("returns one result", results.length === 1);
      assert("outcome is skipped_internal",
        results[0]?.outcome === "skipped_internal",
        `got ${results[0]?.outcome}`);
      assert("no opp written", (await countOppsForRef(pool, fx.orgId, ref)) === 0);
      assert("signal not linked", (await getSignalLink(pool, sig.id)) === null);
      assert("no leak-review row written for internal-skip",
        (await getLeakReview(pool, fx.orgId, m.id)) === null);
    }

    // ── Case 2: low confidence (live) → skipped_low_confidence ───────────
    // Leak-review row written so the signal stays visible to triage.
    section("Case 2 — low confidence → skipped_low_confidence (live)");
    {
      const ref = `task847-lowconf-live-${Date.now()}-2`;
      providerMessageIds.push(ref);
      const m = await insertMessage(pool, fx, {
        fromEmail: fx.customerEmail, providerMessageId: ref,
      });
      const sig = await insertSignal(pool, {
        messageId: m.id, intentType: "pricing_request",
        confidence: svc.CLOSURE_CONFIDENCE_FLOOR - 1,
      });
      process.env.QUOTE_LEAK_FORWARD_CLOSURE_ENABLED = "true";
      const msgRow = await loadEmailMessage(pool, m.id);
      const sigRow = await loadEmailSignal(pool, sig.id);
      const results = await svc.processQuoteSignalClosure(msgRow as never, [sigRow as never]);
      assert("outcome is skipped_low_confidence",
        results[0]?.outcome === "skipped_low_confidence", `got ${results[0]?.outcome}`);
      assert("no opp written for skipped_low_confidence path",
        (await countOppsForRef(pool, fx.orgId, ref)) === 0);
      assert("signal not linked for skipped_low_confidence path",
        (await getSignalLink(pool, sig.id)) === null);
      const review = await getLeakReview(pool, fx.orgId, m.id);
      assert("leak-review row written for skipped_low_confidence path", review !== null);
      assert(`leak-review decision is 'deferred' (got ${review?.decision})`,
        review?.decision === "deferred");
      assert(`leak-review note starts with 'low_confidence' (got ${review?.note})`,
        typeof review?.note === "string" && review.note.startsWith("low_confidence"));
    }

    // ── Case 3a: dry-run, no existing customer → would_create ────────────
    // Runs FIRST, before any live create has populated the customer row,
    // so the read-only customer lookup misses and we go down the create
    // branch.
    section("Case 3a — dry-run with no existing customer → would_create");
    {
      const ref = `task847-dryrun-create-${Date.now()}-3a`;
      providerMessageIds.push(ref);
      const m = await insertMessage(pool, fx, {
        fromEmail: fx.customerEmail, providerMessageId: ref,
      });
      const sig = await insertSignal(pool, {
        messageId: m.id, intentType: "pricing_request", confidence: 90,
      });
      process.env.QUOTE_LEAK_FORWARD_CLOSURE_ENABLED = "false";
      const msgRow = await loadEmailMessage(pool, m.id);
      const sigRow = await loadEmailSignal(pool, sig.id);
      const results = await svc.processQuoteSignalClosure(msgRow as never, [sigRow as never]);
      assert("dry-run outcome is would_create",
        results[0]?.outcome === "would_create",
        `got ${results[0]?.outcome}`);
      assert("dry-run wrote no opp",
        (await countOppsForRef(pool, fx.orgId, ref)) === 0);
      assert("dry-run did not link signal",
        (await getSignalLink(pool, sig.id)) === null);
      assert("dry-run wrote no leak-review row",
        (await getLeakReview(pool, fx.orgId, m.id)) === null);
      assert("dry-run wrote no quote_customers row for the test domain",
        (await findCustomerIdsByDomainPattern(
          pool, fx.orgId, `%${fx.customerDomain.split(".")[0]}%`,
        )).length === 0);
    }

    // ── Case 3c: dry-run + low confidence → would_skipped_low_confidence ─
    section("Case 3c — dry-run with low confidence → would_skipped_low_confidence");
    {
      const ref = `task847-dryrun-lowconf-${Date.now()}-3c`;
      providerMessageIds.push(ref);
      const m = await insertMessage(pool, fx, {
        fromEmail: fx.customerEmail, providerMessageId: ref,
      });
      const sig = await insertSignal(pool, {
        messageId: m.id, intentType: "pricing_request",
        confidence: svc.CLOSURE_CONFIDENCE_FLOOR - 1,
      });
      process.env.QUOTE_LEAK_FORWARD_CLOSURE_ENABLED = "false";
      const msgRow = await loadEmailMessage(pool, m.id);
      const sigRow = await loadEmailSignal(pool, sig.id);
      const results = await svc.processQuoteSignalClosure(msgRow as never, [sigRow as never]);
      assert("dry-run outcome is would_skipped_low_confidence",
        results[0]?.outcome === "would_skipped_low_confidence",
        `got ${results[0]?.outcome}`);
      assert("dry-run wrote no leak-review row",
        (await getLeakReview(pool, fx.orgId, m.id)) === null);
    }

    // ── Case 3d: free-mail / unresolvable sender → skipped_low_confidence
    // Anti-bypass test for the "Unknown — needs review" merge hazard.
    // A gmail.com sender with no business-domain match, no signature
    // company, and no usable display name MUST be queued for triage —
    // never attached to the shared Unknown customer (which would silently
    // merge unrelated quote requests onto the same open opp).
    section("Case 3d — free-mail unresolvable sender → skipped_low_confidence");
    {
      const ref = `task847-freemail-${Date.now()}-3d`;
      providerMessageIds.push(ref);
      const m = await insertMessage(pool, fx, {
        fromEmail: `randomperson-${Date.now()}@gmail.com`,
        providerMessageId: ref,
        // No subject/body that would let the resolver recover a company.
        subject: "Hi",
        body: "Hello",
      });
      const sig = await insertSignal(pool, {
        messageId: m.id, intentType: "pricing_request", confidence: 90,
      });
      process.env.QUOTE_LEAK_FORWARD_CLOSURE_ENABLED = "true";
      const msgRow = await loadEmailMessage(pool, m.id);
      const sigRow = await loadEmailSignal(pool, sig.id);
      const results = await svc.processQuoteSignalClosure(msgRow as never, [sigRow as never]);
      assert("outcome is skipped_low_confidence (free-mail unresolvable)",
        results[0]?.outcome === "skipped_low_confidence",
        `got ${results[0]?.outcome}`);
      assert("free-mail unresolvable: no opp written",
        (await countOppsForRef(pool, fx.orgId, ref)) === 0);
      assert("free-mail unresolvable: signal not linked",
        (await getSignalLink(pool, sig.id)) === null);
      const review = await getLeakReview(pool, fx.orgId, m.id);
      assert("free-mail unresolvable: leak-review row written", review !== null);
      assert(`free-mail unresolvable: note starts with 'unresolvable_sender' (got ${review?.note})`,
        typeof review?.note === "string" && review.note.startsWith("unresolvable_sender"));
    }

    // ── Case 3e: free-mail dry-run + unresolvable sender ─────────────────
    section("Case 3e — dry-run free-mail unresolvable → would_skipped_low_confidence");
    {
      const ref = `task847-dryrun-freemail-${Date.now()}-3e`;
      providerMessageIds.push(ref);
      const m = await insertMessage(pool, fx, {
        fromEmail: `randomperson-${Date.now()}@yahoo.com`,
        providerMessageId: ref,
        subject: "Hi",
        body: "Hello",
      });
      const sig = await insertSignal(pool, {
        messageId: m.id, intentType: "pricing_request", confidence: 90,
      });
      process.env.QUOTE_LEAK_FORWARD_CLOSURE_ENABLED = "false";
      const msgRow = await loadEmailMessage(pool, m.id);
      const sigRow = await loadEmailSignal(pool, sig.id);
      const results = await svc.processQuoteSignalClosure(msgRow as never, [sigRow as never]);
      assert("dry-run free-mail outcome is would_skipped_low_confidence",
        results[0]?.outcome === "would_skipped_low_confidence",
        `got ${results[0]?.outcome}`);
      assert("dry-run free-mail wrote no leak-review row",
        (await getLeakReview(pool, fx.orgId, m.id)) === null);
    }

    // ── Case 4: live → create, then replay → idempotent attach ───────────
    // Establishes the customer row + open opp that Case 3b's dry-run
    // attach lookup will find.
    section("Case 4 — create + idempotent replay");
    let createdOppId: string | null = null;
    {
      const ref = `task847-create-${Date.now()}-4`;
      providerMessageIds.push(ref);
      const m = await insertMessage(pool, fx, {
        fromEmail: fx.customerEmail, providerMessageId: ref,
      });
      const sig = await insertSignal(pool, {
        messageId: m.id, intentType: "pricing_request", confidence: 90,
      });
      process.env.QUOTE_LEAK_FORWARD_CLOSURE_ENABLED = "true";
      const msgRow = await loadEmailMessage(pool, m.id);
      const sigRow = await loadEmailSignal(pool, sig.id);
      const r1 = await svc.processQuoteSignalClosure(msgRow as never, [sigRow as never]);
      assert("first run outcome is created",
        r1[0]?.outcome === "created", `got ${r1[0]?.outcome}`);
      assert("first run wrote exactly one opp",
        (await countOppsForRef(pool, fx.orgId, ref)) === 1);
      createdOppId = r1[0]?.opportunityId ?? null;
      assert("created opp id surfaced",
        typeof createdOppId === "string" && !!createdOppId);
      assert("signal linked to created opp",
        (await getSignalLink(pool, sig.id)) === createdOppId);

      const sig2 = await insertSignal(pool, {
        messageId: m.id, intentType: "pricing_request", confidence: 90,
      });
      const sig2Row = await loadEmailSignal(pool, sig2.id);
      const r2 = await svc.processQuoteSignalClosure(msgRow as never, [sig2Row as never]);
      assert("replay outcome is attached",
        r2[0]?.outcome === "attached", `got ${r2[0]?.outcome}`);
      assert("replay attached to original opp id",
        r2[0]?.opportunityId === createdOppId);
      assert("replay did not duplicate the opp",
        (await countOppsForRef(pool, fx.orgId, ref)) === 1);
      assert("replay signal also linked to original opp",
        (await getSignalLink(pool, sig2.id)) === createdOppId);
    }

    // ── Case 3b: dry-run, existing open opp for customer → would_attach ──
    // Now that Case 4 has populated quote_customers + an open
    // quote_opportunities row for this customer, the dry-run resolver
    // must report would_attach (NOT would_create) — otherwise the
    // dashboard tile silently understates the attach branch.
    section("Case 3b — dry-run with existing open opp → would_attach");
    {
      const ref = `task847-dryrun-attach-${Date.now()}-3b`;
      providerMessageIds.push(ref);
      const m = await insertMessage(pool, fx, {
        fromEmail: fx.customerEmail, providerMessageId: ref,
      });
      const sig = await insertSignal(pool, {
        messageId: m.id, intentType: "pricing_request", confidence: 90,
      });
      process.env.QUOTE_LEAK_FORWARD_CLOSURE_ENABLED = "false";
      const msgRow = await loadEmailMessage(pool, m.id);
      const sigRow = await loadEmailSignal(pool, sig.id);
      const results = await svc.processQuoteSignalClosure(msgRow as never, [sigRow as never]);
      assert("dry-run outcome is would_attach",
        results[0]?.outcome === "would_attach",
        `got ${results[0]?.outcome}`);
      assert("dry-run would_attach reports the live-created opp id",
        results[0]?.opportunityId === createdOppId,
        `got ${results[0]?.opportunityId}`);
      assert("dry-run wrote no opp",
        (await countOppsForRef(pool, fx.orgId, ref)) === 0);
      assert("dry-run did not link signal",
        (await getSignalLink(pool, sig.id)) === null);
    }

    // ── Case 5: counters reflect every decision (per-window) ─────────────
    section("Case 5 — counter aggregation");
    {
      const counters = svc.getClosureCounters(fx.orgId, Date.now() - 24 * 60 * 60 * 1000);
      assert(`skippedInternal >= 1 (got ${counters.skippedInternal})`,
        counters.skippedInternal >= 1);
      // Live skipped_low_confidence is incremented by both Case 2
      // (low-confidence floor) and Case 3d (free-mail unresolvable).
      assert(`skippedLowConfidence >= 2 (got ${counters.skippedLowConfidence})`,
        counters.skippedLowConfidence >= 2);
      // Dry-run twin from Case 3c + Case 3e.
      assert(`wouldSkippedLowConfidence >= 2 (got ${counters.wouldSkippedLowConfidence})`,
        counters.wouldSkippedLowConfidence >= 2);
      assert(`wouldCreate >= 1 (got ${counters.wouldCreate})`,
        counters.wouldCreate >= 1);
      assert(`wouldAttach >= 1 (got ${counters.wouldAttach})`,
        counters.wouldAttach >= 1);
      assert(`created >= 1 (got ${counters.created})`,
        counters.created >= 1);
      assert(`attached >= 1 (got ${counters.attached})`,
        counters.attached >= 1);

      const future = svc.getClosureCounters(fx.orgId, Date.now() + 60_000);
      const allZero =
        future.created + future.attached + future.skippedLowConfidence +
        future.wouldCreate + future.wouldAttach + future.wouldSkippedLowConfidence +
        future.skippedInternal === 0;
      assert("future since-cutoff returns all zeros", allZero);
    }

    console.log(`\n\u2500\u2500 Results: ${passed} passed, ${failed} failed \u2500\u2500`);
    if (failed > 0) {
      console.log("\nFailures:");
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
  } finally {
    if (fx) await cleanup(pool, fx, providerMessageIds).catch((e) => console.error("cleanup error:", e));
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
