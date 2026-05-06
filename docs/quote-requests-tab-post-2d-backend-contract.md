# Quote Requests post-2d — backend implementation contract (Task #849)

**Status:** Locked. Source of truth for the backend slice that unblocks
Task #850 (UI build).

**Companion docs:** `docs/quote-requests-tab-post-2d-spec.md` (UX/IA
spec), `.local/tasks/quote-leak-forward-closure-phase-2b.md` (Phase 2b
plan that this contract assumes is live).

This doc resolves the 3 BLOCKING schema questions from the spec's §9,
then defines every new endpoint, schema migration, state transition,
and event-writing rule the post-2d UI depends on. The UI build (#850)
must execute against this contract; deviations require an explicit
amendment back into this file.

---

## 0. Frame

Phase 2b–2d are assumed live. The post-2d Quote Requests tab is a
read/write surface over `quote_opportunities` exclusively. This
contract adds the minimum backend the UI needs:

- 3 schema migrations (enum extensions + 1 column).
- 4 new endpoints (`attach-to`, `send-to-leak`, `snooze`, `automation-counters`).
- 1 new endpoint (`send-thread-reply`) which is a near-prereq — the UI
  Send-Quote action depends on it. Marked separately because it has
  scope outside the Quote Requests tab.
- 1 list-endpoint extension (snooze filter, new source values, new
  outcome value).
- Audit rules (event writes, mutex semantics) for each new write path.

Nothing in the existing read endpoints (`GET .../list`,
`GET .../quote/:id`, `GET .../snapshot`, `GET .../funnel`,
`GET .../pricing-intelligence`, `GET .../quote/:id/recommendation`,
`GET .../action-queue`) needs to change to support the new tab. The UI
reuses them as-is.

---

## 1. BLOCKING schema decisions — RESOLVED

### 1.1 `QUOTE_SOURCES` — extend (Q11)

**Decision:** Extend to
`['email', 'email_signal', 'tms', 'crm', 'manual', 'import', 'spot_search']`.

**Rationale:**
- The Confidence card (spec §4.3) renders only for `source='email_signal'`.
  Folding into `email` removes the only switch the UI uses to decide
  whether to show confidence/extraction metadata.
- The source filter (spec §3.4) needs both values to be selectable
  independently — autopilot-classified vs human-typed-into-list.
- `spot_search` already exists in the codebase as a logical concept
  (Spot Quote Search → Quote Builder card writes via
  `POST /api/customer-quotes/spot/create`); the source string is just
  not enumerated. Lifting it into the enum makes per-source filtering
  honest.

**Backfill rule (one-time, run inside `runMigrations`):**
```sql
UPDATE quote_opportunities qo
SET source = 'email_signal'
WHERE qo.source = 'email'
  AND EXISTS (
    SELECT 1
    FROM email_signals es
    WHERE es.linked_opportunity_id = qo.id
       OR (es.message_id IN (
            SELECT em.id FROM email_messages em
            WHERE em.provider_message_id = qo.source_reference
              AND em.org_id = qo.organization_id
          ))
  );

UPDATE quote_opportunities
SET source = 'spot_search'
WHERE source = 'manual'
  AND source_reference LIKE 'spot:%';
```

The backfill is idempotent and wrapped in a guard:
`if (await alreadyBackfilled('quote_sources_v2_post2d')) return;`
following the pattern already used in `runMigrations` for the
freshness backfill.

**Validator update:** the Zod schema in `createQuoteSchema` /
`updateQuoteSchema` (server/routes/customerQuotes.ts:231) already
reads `z.enum(QUOTE_SOURCES)` — no code change needed beyond the
enum extension itself.

---

### 1.2 `CAPTURE_LEAK_REVIEW_DECISIONS` — extend (Q12)

**Decision:** Extend to
`['not_quote', 'ignored', 'attached', 'returned_to_queue', 'duplicate', 'not_a_request']`.

**Rationale:**
- `returned_to_queue` is the audit row for §5.6 (Send to leak queue) —
  a rep declares "this opp shouldn't have been auto-created, put the
  underlying signal back in the leak queue for review." Without it,
  the leak queue can't tell a returned-to-queue row from a
  reviewed-and-dismissed row.
- `duplicate` is the audit row for §5.7 (Mark duplicate) — distinct
  from `attached` because the source opp was a real customer request
  that just happened to overlap with a canonical opp; analytics may
  want to count it differently from auto-attach noise.
- `not_a_request` is the audit row for §5.13 (Override autopilot) —
  the rep is teaching the system that this autopilot decision was
  wrong. Distinct from `not_quote` (which an admin uses on
  capture-leak-queue rows that never made it to an opp).

**`buildLeakCandidateIds` semantics update**
(server/services/customerQuotes.ts:4929): the chokepoint currently
excludes any `(messageId, leakType)` with ANY review row. New rule —
exclude rows where `decision IN ('not_quote', 'ignored', 'attached',
'duplicate', 'not_a_request')`. Rows where
`decision = 'returned_to_queue'` are SURFACED so they re-appear in the
admin's leak queue.

**Guardrail test** (extends `tests/code-quality-guardrails.test.ts`):
- Section 16 (new): assert `CAPTURE_LEAK_REVIEW_DECISIONS` contains
  the full 6-value set; fail if anyone shrinks it.
- Assert the chokepoint's predicate explicitly handles all 6 values
  (a switch-with-exhaustive-check pattern is acceptable evidence).

---

### 1.3 `quote_opportunities.outcomeStatus` — add `'attached'` (Q13)

**Decision:** Extend `QUOTE_OUTCOME_STATUSES` to add `'attached'`:
```ts
['pending', 'quoted', 'won', 'lost_price', 'lost_service',
 'lost_timing', 'lost_incumbent', 'no_response', 'expired',
 'won_low_margin', 'attached']
```

**Rationale:**
- `attach-to` and `mark-duplicate` close the source opp by re-routing
  its activity onto a target opp. The source opp must be filtered out
  of active queries (the row is no longer the broker's responsibility)
  while the audit trail survives.
- Re-using `no_response` would pollute `lost-rate` analytics: today
  every analytics query that bands by outcome treats `no_response`
  as an unforced loss. An attached row is a re-classification, not a
  lost deal.

**Analytics audit (REQUIRED — included in sprint S8):**
- Search every query that filters on `outcomeStatus`. For each one,
  decide whether `'attached'` belongs in the bucket:
  - **Win-rate / lost-rate** denominators → EXCLUDE (re-routing).
  - **Aging / "still open"** filters → EXCLUDE (closed).
  - **Audit / activity feeds** → INCLUDE (it happened).
  - **List endpoint default** → EXCLUDE unless `?includeAttached=1`.
- Files that need an explicit pass:
  `server/services/customerQuotes.ts` (listQuotes, getSnapshot,
  getFunnelDiagnostics, getActionQueue, exportCsv),
  `server/services/quotePatternAlerts.ts`,
  `server/services/quoteRecency.ts`, every `outcomeStatus` reference
  in `server/routes/`.
- Guardrail (new section in `tests/code-quality-guardrails.test.ts`):
  fail if any analytics query uses `outcomeStatus IN (...)` without
  explicitly listing `'attached'` in or out — forces the implementer
  to make a deliberate choice.

**Existing `won_low_margin` precedent:** the codebase already added
`won_low_margin` mid-life. Same pattern applies for `attached`.

---

## 2. Schema migrations — full DDL

All migrations land in **one PR** (S1), gated by Drizzle's
schema-drift guard at boot. Order:

```ts
// shared/schema.ts — single edit, three lines

export const QUOTE_OUTCOME_STATUSES = [
  "pending", "quoted", "won",
  "lost_price", "lost_service", "lost_timing", "lost_incumbent",
  "no_response", "expired", "won_low_margin",
  "attached",                                   // NEW (§1.3)
] as const;

export const QUOTE_SOURCES = [
  "email", "email_signal",                       // email_signal NEW (§1.1)
  "tms", "crm", "manual", "import",
  "spot_search",                                 // NEW (§1.1)
] as const;

export const CAPTURE_LEAK_REVIEW_DECISIONS = [
  "not_quote", "ignored", "attached",
  "returned_to_queue", "duplicate", "not_a_request",  // NEW (§1.2)
] as const;
```

```ts
// shared/schema.ts — quoteOpportunities table, add column
snoozedUntil: timestamp("snoozed_until"),       // nullable, NEW (§5.4 "Snooze")
```

Drizzle index addition (same migration):
```ts
// quoteOpportunities indexes block
snoozedIdx: index("quote_opportunities_snoozed_idx")
  .on(t.organizationId, t.snoozedUntil)
  .where(sql`snoozed_until IS NOT NULL`),       // partial index
```

Push via `npm run db:push --force` per the database safety rules. No
manual SQL migration files. The schema-drift guard at boot will catch
any human mistakes in deployment.

**Backfills** (run inside `runMigrations`, idempotent, behind a
one-shot guard row in `migration_marks`):
1. `quote_sources_v2_post2d` — backfill `email` → `email_signal` per §1.1.
2. No backfill needed for `CAPTURE_LEAK_REVIEW_DECISIONS` (forward-only).
3. No backfill needed for `outcomeStatus='attached'` (forward-only).

---

## 3. Endpoint catalog — full request/response shapes

### 3.1 `POST /api/customer-quotes/quote/:id/attach-to` (NEW)

**Purpose:** Spec §5.4 (Attach) and §5.7 (Mark duplicate). Collapses
one `quote_opportunities` row into another within the same org.

**Permission:** `admin | director | sales_director`. Returns `403`
otherwise. (Manual override of autopilot, restricted to elevated
roles per spec's permission table.)

**Request:**
```ts
{
  targetOppId: string,            // required, must be in same org
  decision: "attached" | "duplicate",  // audit-row decision value
  note?: string                   // max 500 chars, optional
}
```

**Response (201):**
```ts
{
  status: "attached",
  fromOppId: string,
  targetOppId: string,
  capturedReviewIds: string[]     // [auditRowId, …] — usually len 1
}
```

**Error responses:**
- `400 invalid_body` — schema validation failure.
- `403 forbidden` — role gate.
- `404 source_not_found` — `:id` missing or in different org.
- `404 target_not_found` — `targetOppId` missing or in different org.
- `409 already_closed` — source opp's `outcomeStatus` is already a
  terminal value EXCEPT `'attached'` (`won|lost_*|no_response|expired`);
  cannot re-attach. Returns `{ status: "already_closed", currentOutcome }`.
- `409 self_attach` — `:id === targetOppId`.
- `500 internal_error`.

**Re-attach correction path (NEW — addresses architect feedback):**
A previously-attached opp (`outcomeStatus='attached'`) IS re-attachable to a
different target by `admin | director | sales_director` ONLY. Reps cannot
re-attach. The use case is fixing a wrong attach without falling back to
manual SQL. Mechanics:
- Permission: elevated roles only (the standard endpoint role gate).
- Side-effect set is identical to a fresh attach EXCEPT the
  `quote_events` row on the source opp is `event_type='opp_reattached_out'`
  and the payload includes `previousTargetOppId` (read from the source
  opp's most recent `opp_attached_out` event).
- The previous target opp gets a `quote_events` row of
  `event_type='opp_reattached_away'` so its timeline reflects the
  removal.
- The 6th step (`publishLiveSync`) fires for all three opps
  (source, prev-target, new-target).
- AC8 (NEW): re-attach flow round-trips — source's timeline now shows
  `opp_attached_out` then `opp_reattached_out`; prev-target shows
  `opp_attached_in` then `opp_reattached_away`; new-target shows a
  fresh `opp_attached_in`.

**Side effects (must be transactional — all-or-nothing):**
1. `UPDATE quote_opportunities SET outcome_status='attached',
   outcome_reason_id=NULL WHERE id = :id`.
2. `UPDATE email_signals SET linked_opportunity_id = :targetOppId
   WHERE linked_opportunity_id = :id`.
3. `INSERT INTO quote_events (quote_id=:targetOppId,
   event_type='opp_attached_in',
   actor='manual_leak_attach',
   occurred_at=now(),
   payload={ fromOppId, decision, note, byUserId })`.
4. `INSERT INTO quote_events (quote_id=:id,
   event_type='opp_attached_out',
   actor='manual_leak_attach',
   occurred_at=now(),
   payload={ targetOppId, decision, note, byUserId })`.
5. For every distinct inbound `email_messages.id` linked to the
   source opp (via `email_signals.message_id` where
   `linked_opportunity_id` was just re-pointed):
   `INSERT INTO capture_leak_reviews (organization_id, message_id,
   leak_type='missed_inbound', decision=:decision,
   decided_by_user_id=:userId, note)
   ON CONFLICT (organization_id, message_id, leak_type) DO UPDATE
   SET decision=EXCLUDED.decision, updated_at=now(),
       decided_by_user_id=EXCLUDED.decided_by_user_id,
       note=EXCLUDED.note`.
6. `publishLiveSync(orgId, "customer_quote", :id)` and `... :targetOppId`.
7. `clearStaleFollowUpCache(orgId)`.

**Concurrency:** Wrap steps 1–5 in the existing in-process mutex used
by `attachOrphanOutboundToQuote` (server/services/customerQuotes.ts).
Key: `attach:${orgId}:${sourceOppId}:${targetOppId}`. Mutex prevents
the duplicate-attach race that today's leak-attach guards against.

**Acceptance criteria:**
- AC1: Round-trip — `POST attach-to` then `GET /quote/:id` shows
  `outcomeStatus='attached'` and the timeline includes
  `opp_attached_out`. `GET /quote/:targetOppId` timeline includes
  `opp_attached_in`.
- AC2: Re-attach to SAME target — second POST with the identical
  `(id, targetOppId)` returns `409 already_closed` with
  `currentOutcome='attached'`. No duplicate `quote_events` rows.
  Re-attach to a DIFFERENT target by an elevated role succeeds and
  follows the correction-path mechanics above (AC8).
- AC3: Concurrent POSTs serialized — two simultaneous requests with
  the same `(id, targetOppId)` produce exactly one set of writes.
- AC4: Different-org cross-attach — `POST` with `targetOppId` from a
  different org returns `404 target_not_found` (not `403`, to avoid
  org-existence leaks).
- AC5: Source opp's `email_signals` rows now point at the target opp;
  the source opp has zero rows in `email_signals.linked_opportunity_id`.
- AC6: All inbound messages for the source opp now have a
  `capture_leak_reviews` row with the requested decision.
- AC7: Rep role gets `403`; admin/director/sales_director succeed.

---

### 3.2 `POST /api/customer-quotes/quote/:id/send-to-leak` (NEW)

**Purpose:** Spec §5.6 (Send to leak queue) and §5.13 (Override
autopilot). Closes an opp and writes a `returned_to_queue` audit row
so the underlying signal resurfaces in the admin leak queue.

**Permission:** Assigned rep, the rep's manager, admin, director,
sales_director. Reps cannot send other reps' opps. Returns `403`
otherwise.

**Request:**
```ts
{
  reason: "not_a_request"           // override autopilot path (§5.13)
        | "unparseable"              // routes to admin queue (§5.6)
        | "wrong_party"              // signal misclassified
        | "duplicate_email"          // dup of another already-tracked signal
        | "other",                   // catch-all + free-text required
  note?: string,                     // max 500 chars; required when reason='other'
  // §5.13 only:
  suppressSender?: boolean           // default false; when true writes a
                                     // quote_sender_mappings suppression row
}
```

**Response (200):**
```ts
{
  status: "sent_to_leak",
  oppId: string,
  decision: "not_a_request" | "returned_to_queue",
  capturedReviewIds: string[],
  senderSuppressed: boolean         // true only when suppressSender=true succeeded
}
```

**Decision-value mapping:**
- `reason='not_a_request'` → audit `decision='not_a_request'`.
- All other reasons → audit `decision='returned_to_queue'`.

**Error responses:** `400 invalid_body`, `403 forbidden`,
`404 not_found`, `409 already_closed` (same shape as 3.1), `500`.

**Side effects (transactional):**
1. `UPDATE quote_opportunities
   SET outcome_status='no_response',
       outcome_reason_id=<id of 'sent_to_leak_queue' reason; create if
                           missing in `quote_outcome_reasons` for this org>
   WHERE id=:id`.
2. `INSERT INTO quote_events (quote_id=:id,
   event_type='sent_to_leak',
   actor='rep_send_to_leak',
   occurred_at=now(),
   payload={ reason, note, byUserId })`.
3. For every inbound `email_messages.id` linked via `email_signals` to
   this opp: upsert `capture_leak_reviews` with
   `decision = ('not_a_request' | 'returned_to_queue')` per the
   mapping above. Same upsert pattern as 3.1 step 5.
4. If `reason='not_a_request'` AND `suppressSender=true`: write a
   `quote_sender_mappings` suppression row for the inbound sender.
   Reuse the existing `quoteSenderMappings.ts` helper; `senderSuppressed`
   in the response reflects whether that write succeeded (it can fail
   silently if the sender doesn't resolve; do not fail the whole call).
5. **When `decision='returned_to_queue'`** — restore the signal to
   "leaked" so it re-surfaces in the leak queue and the leakage-stats
   diagnostic. The opp's `linked_opportunity_id` and `source_reference`
   are BOTH cleared, otherwise the existing leakage-stats classifier
   (which checks both `email_signals.linked_opportunity_id IS NOT NULL`
   AND `quote_opportunities.source_reference = email_messages.provider_message_id`
   per `server/routes/conversationsLeakage.ts:87-93`) would still
   classify the row under `with_opportunity`:
   ```sql
   UPDATE email_signals
   SET linked_opportunity_id = NULL
   WHERE linked_opportunity_id = :id;

   UPDATE quote_opportunities
   SET source_reference = NULL
   WHERE id = :id;
   ```
   Plus the leakage-stats classifier MUST be amended (see §3.7) so a
   `capture_leak_reviews` row with `decision='returned_to_queue'` does
   NOT count under `inLeakQueue` — the signal needs to fall all the
   way through to `leaked`.

   **When `decision='not_a_request'`** — leave both
   `linked_opportunity_id` and `source_reference` intact. The signal
   continues to count under `with_opportunity` (the rep is declaring
   the request out-of-scope, not abandoning it).
6. `publishLiveSync(orgId, "customer_quote", :id)`.
7. `clearStaleFollowUpCache(orgId)`.

**Concurrency:** Same in-process mutex used by attach. Key:
`send-to-leak:${orgId}:${oppId}`.

**Acceptance criteria:**
- AC1: `reason='returned_to_queue'`-style call (i.e. anything except
  `not_a_request`) — the underlying inbound signal reappears in
  `GET /api/admin/conversations/leakage-stats` `bucket='leaked'` for
  the next call (the leak-queue chokepoint surfaces it again). Verified
  by `tests/conversations-leakage-stats.test.ts` extension.
- AC2: `reason='not_a_request'` — leakage-stats shows the signal under
  `with_opportunity` (not leaked), opp shows `outcomeStatus='no_response'`,
  `outcome_reason_id` resolves to a 'sent_to_leak_queue' label, audit
  row has `decision='not_a_request'`.
- AC3: `suppressSender=true` writes one `quote_sender_mappings` row;
  next inbound from that sender does NOT auto-create an opp (verified
  in `tests/quote-opportunity-from-signal.test.ts`).
- AC4: Concurrent calls serialized; exactly one set of writes.
- AC5: Reps cannot send other reps' opps (`403`); managers can; admin
  can.
- AC6: Re-call on already-closed opp returns `409 already_closed`.

---

### 3.3 `PATCH /api/customer-quotes/quote/:id/snooze` (NEW)

**Purpose:** Spec §5.8 (Snooze) and §5.9 (Reopen). Hides a row from
the default Quote Requests list until a future time.

**Permission:** Assigned rep, that rep's manager, admin, director,
sales_director. Returns `403` for other reps. Snooze is intentionally
operator self-care, not data hiding from peers — managers can
unsnooze a rep's row.

**Request:**
```ts
{
  snoozedUntil: string | null      // ISO-8601 in UTC, or null to unsnooze.
                                   // Must be in the future; max 14d out.
}
```

**Response (200):**
```ts
{
  status: "snoozed" | "unsnoozed",
  oppId: string,
  snoozedUntil: string | null
}
```

**Error responses:** `400 invalid_body` (non-ISO date, past date, >14d
out), `403 forbidden`, `404 not_found`, `500`.

**Side effects:**
1. `UPDATE quote_opportunities SET snoozed_until=:snoozedUntil
   WHERE id=:id AND organization_id=:orgId`.
2. `INSERT INTO quote_events (quote_id=:id,
   event_type='snoozed' | 'unsnoozed',
   actor='rep_snooze',
   occurred_at=now(),
   payload={ snoozedUntil, byUserId })`.
3. `publishLiveSync(orgId, "customer_quote", :id)`.

**No mutex needed** — snooze is idempotent on the column value; last
write wins, which is the user's expectation when toggling.

**Acceptance criteria:**
- AC1: Set snooze to `T+1h` — `GET .../list` (default filter) does NOT
  include the row. `GET .../list?includeSnoozed=1` does include it.
  After T+1h, the row reappears in default list (no auto-update — the
  next list query computes against `now()`).
- AC2: Set snooze to `null` — row reappears in default list immediately.
- AC3: Past or >14d-future date returns `400`.
- AC4: Rep cannot snooze another rep's opp; manager can; admin can.
- AC5: Drawer header `GET .../quote/:id` includes the `snoozedUntil`
  field even when defaulted out of list.

---

### 3.4 `GET /api/quote-requests/automation-counters` (NEW, sibling to leakage-stats)

**Purpose:** Spec §5.10 — read-side surfacing of Phase 2b's closure
counters, with rep-readable role gating (the underlying
leakage-stats endpoint is admin-only).

**Permission:** Any role with quote-opportunities access
(`isQuoteOpportunitiesRole(role)` from
`shared/quoteOpportunitiesRoles.ts`). Reps see counters for their own
org.

**Request (query):**
```ts
{
  window: "today" | "last_24h" | "last_7d"   // default "today"
}
```

**Response (200):**
```ts
{
  generatedAt: string,           // ISO-8601
  organizationId: string,
  window: { label, startIso, endIso },
  counters: {
    created: number,             // closure.created from Phase 2b
    attached: number,            // closure.attached
    skippedInternal: number,     // closure.skipped_internal
    skippedLowConfidence: number,// closure.skipped_low_confidence
    // dry-run counters; populated only when QUOTE_LEAK_FORWARD_CLOSURE_ENABLED=false
    wouldCreate?: number,
    wouldAttach?: number
  },
  closureFlagEnabled: boolean,   // pass-through of
                                 // QUOTE_LEAK_FORWARD_CLOSURE_ENABLED
  leakQueueDeepLink: "/admin/integrations-health#leak-tile"
}
```

**Implementation note:** This endpoint internally calls the same
counter computation that Phase 2b extends `/api/admin/conversations/
leakage-stats` with — extract the closure-counter aggregation into a
shared service function (`computeClosureCounters(orgId, window)` in
`server/services/quoteLeakageClosureCounters.ts`) and have both
endpoints call it. **DO NOT** duplicate the SQL.

**Why a sibling endpoint instead of opening up leakage-stats:** the
leakage-stats response also includes `topLeakingDomains` and the raw
24h/7d windows that contain `withOpportunity` / `inLeakQueue` /
`leaked` — those are admin-only operational telemetry. Reps see only
the four closure counters, no domain breakdown.

**Error responses:** `400 invalid_window`, `403 forbidden`, `500`.

**Acceptance criteria:**
- AC1: Rep call with `window=today` returns 200 with the four
  counters, no `topLeakingDomains` field.
- AC2: Counter values exactly match the corresponding values in
  `GET /api/admin/conversations/leakage-stats` for the same window
  (admin-side regression test asserts equality).
- AC3: `closureFlagEnabled=false` causes `wouldCreate` / `wouldAttach`
  to be present; `closureFlagEnabled=true` omits them.
- AC4: Cross-org isolation — two orgs, different counts; each sees
  only their own.
- AC5: 60s polling from the UI does not regress dashboard p95 (a
  cache layer of 30s in-memory is acceptable; explicit
  `Cache-Control: max-age=30` header).

---

### 3.5 `POST /api/email-conversations/:threadId/reply` (NEW — predecessor)

**Purpose:** Spec §5.5 (Send quote reply). Sends an outbound email on
an existing conversation thread, writes the timeline event, and lets
the existing autopilot flip the opp from `pending` to `quoted`.

**Scope note:** This endpoint is needed for the post-2d UI but its
surface area extends beyond the Quote Requests tab — the Conversations
inbox will eventually want it too. Implement as part of S6 in this
sprint, but design it to be reused by Conversations later.

**Permission:** Any user with access to the thread's org. Send
permission additionally requires the thread to be visible under the
visibility model (the same predicate Conversations uses to render
the thread).

**Request:**
```ts
{
  subject?: string,            // defaults to "Re: <thread.subject>"
  bodyText: string,            // required, max 100k chars
  bodyHtml?: string,           // optional sanitized HTML
  inReplyToMessageId?: string, // email_messages.id; defaults to the
                               // most recent inbound on the thread
  attachments?: Array<{        // optional, max 10
    filename: string,
    contentBase64: string,     // max 10 MB total across all attachments
    mimeType: string
  }>,
  draftSource?: "ai" | "manual" | "template",  // analytics tag,
                                                // default "manual"
  linkedQuoteId?: string       // optional quote_opportunities.id —
                               // when set, writes the timeline event
                               // against this opp and may flip its
                               // outcomeStatus per autopilot rules
}
```

**Response (201):**
```ts
{
  status: "sent",
  messageId: string,             // email_messages.id of the outbound row
  providerMessageId: string,     // for tracking on the provider side
  threadId: string,
  linkedQuoteId: string | null,
  outboundQuoteEventId: string | null  // populated when linkedQuoteId set
}
```

**Error responses:** `400 invalid_body`, `403 forbidden`,
`404 thread_not_found`, `413 attachments_too_large`,
`502 send_failed` (provider-side failure, retriable),
`500 internal_error`.

**Side effects:**
1. Resolve the sending mailbox: pick the `monitored_mailboxes` row
   that owns this thread (today the resolution lives in the
   Conversations service; reuse it).
2. Call the existing send service — `sendOutlookEmail` for Graph-backed
   mailboxes, `sendEmail` (Resend/SMTP) as a fallback for non-Graph
   mailboxes. Wrap both with a `sendThreadReply()` adapter in
   `server/services/emailThreadReply.ts` so future surfaces have one
   call site.
3. Insert an `email_messages` row with `direction='outbound'`,
   `thread_id=:threadId`, `provider_message_id` from the send result,
   `provider_sent_at = now()`, `from_email` = mailbox address,
   `to_email` = the previous inbound's `from_email` (or
   `inReplyToMessageId.from_email`).
4. If `linkedQuoteId` is set:
   - Insert `quote_events (quote_id=:linkedQuoteId,
     event_type='outbound_reply', actor='rep_reply', occurred_at=now(),
     payload={ messageId, providerMessageId, draftSource, byUserId })`.
   - **Inline outcome flip (NEW — addresses architect feedback):** if
     the opp's current `outcomeStatus='pending'`, flip it to `'quoted'`
     in the same transaction:
     ```sql
     UPDATE quote_opportunities
     SET outcome_status = 'quoted'
     WHERE id = :linkedQuoteId
       AND organization_id = :orgId
       AND outcome_status = 'pending';
     ```
     The conditional WHERE clause is the idempotency guard — if the
     row already moved to a downstream state (won/lost/etc.), the
     update is a no-op. The autopilot's outbound-reply observer in
     `server/services/quoteEmailIngestion.ts` continues to run for
     emails sent through OTHER paths (e.g., direct mailbox replies)
     but is now a backup, not the primary mechanism, for replies sent
     through this endpoint. This eliminates the up-to-30s "stuck at
     pending" UX hazard the rep would otherwise see.
5. `publishLiveSync(orgId, "email_thread", :threadId)` and, when
   `linkedQuoteId` set, `publishLiveSync(orgId, "customer_quote",
   :linkedQuoteId)`.

**Acceptance criteria:**
- AC1: Send with `linkedQuoteId` on a `pending` opp — opp's
  `outcomeStatus` is `'quoted'` IMMEDIATELY in the response from
  `GET /quote/:id` after the send (no autopilot tick required).
  Timeline includes `outbound_reply`. Cross-tab live-sync fires.
- AC2: Send without `linkedQuoteId` — outbound row persists, thread
  refreshes, no opp side effects.
- AC3: Send to a thread whose mailbox can't be resolved → `502
  send_failed` with a clear message; no partial writes.
- AC4: 10 attachments at 1MB each succeeds; 10MB+1 attachments fail
  with `413` BEFORE the send call.
- AC5: Cross-org thread access → `404 thread_not_found` (not 403,
  to avoid org-existence leaks).
- AC6: Attempt to send to a deleted/hidden thread → `404`.

---

### 3.7 Leakage-stats classifier — amendment (NEW, addresses architect feedback)

The Phase 2a classifier in `server/routes/conversationsLeakage.ts`
(both `computeWindow` and `computeTopLeakingDomains`) currently
counts ANY `capture_leak_reviews` row as `in_leak_queue`. Once §1.2
adds `returned_to_queue` to the decision enum, that row is now
explicit operator intent of "send this back to leaked status," so it
must NOT count as `in_leak_queue`. Required amendment to both CTEs:

```sql
-- BEFORE (line ~94-98 and ~166-170)
WHEN EXISTS (
  SELECT 1 FROM capture_leak_reviews clr
  WHERE clr.organization_id = ${orgId}
    AND clr.message_id = e.message_id
) THEN 'in_leak_queue'

-- AFTER
WHEN EXISTS (
  SELECT 1 FROM capture_leak_reviews clr
  WHERE clr.organization_id = ${orgId}
    AND clr.message_id = e.message_id
    AND clr.decision <> 'returned_to_queue'
) THEN 'in_leak_queue'
```

**Test extension** (`tests/conversations-leakage-stats.test.ts`):
- New scenario: a signal is reviewed with `decision='returned_to_queue'`.
  Expectation — bucket flips to `leaked`, NOT `in_leak_queue`.
- Existing assertions for `not_quote`/`ignored`/`attached`/`duplicate`/
  `not_a_request` continue to expect `in_leak_queue`.

This amendment lands in S2 (alongside `attach-to`) because both
endpoints write to `capture_leak_reviews` with the new decision values
and both depend on the corrected classifier semantics.

---

### 3.6 `GET /api/customer-quotes/list` — extension (existing endpoint)

**Purpose:** Surface the new `snoozed_until` column and accept the new
source/outcome enum values without breaking existing callers.

**New query params:**
- `includeSnoozed=1` (default `0`) — when `0`, filter out rows where
  `snoozed_until > now()`. When `1`, include them with a flag.
- `source=email_signal,spot_search,…` — already accepts arbitrary
  values via the existing filter parser; document the new valid
  options in the route's JSDoc.

**Response shape addition (per row):**
```ts
{
  // … existing row fields unchanged …
  snoozedUntil: string | null,   // ISO when snoozed, null otherwise
  isSnoozed: boolean             // server-computed: snoozed_until > now()
}
```

**Default-filter rule changes:**
- `outcomeStatus` default filter excludes `'attached'` (per §1.3
  audit). Existing callers requesting "active" rows continue to get
  what they expect.
- An explicit `outcomeStatus=attached` filter request is honored.

**Acceptance criteria:**
- AC1: Default `GET /list` excludes both snoozed and attached rows.
- AC2: `?includeSnoozed=1` includes snoozed rows with `isSnoozed=true`.
- AC3: `?outcomeStatus=attached` returns attached rows only.
- AC4: Existing `customer-quotes.tsx` page (still active until §8.4
  redirect lands) continues to render correctly — backward-compat
  smoke test in `tests/freight-capture-funnel.test.ts`.

---

## 4. Disposition / state model

`outcomeStatus` is the canonical state field on `quote_opportunities`.
Snooze is an orthogonal modifier (a row can be `pending` AND snoozed).

### 4.1 State diagram

```
                                        ┌─────────────┐
                                        │  attached   │ (from §3.1)
                                        └─────────────┘
                                               ▲
                                               │ POST attach-to
                                               │ (terminal)
   ┌──────────┐                          ┌─────┴────────────┐
   │ pending  │── PATCH .../mark-outcome │      quoted      │
   │          │     {outcomeStatus=…}   →│                  │── PATCH ── won
   └──────────┘                          └──────────────────┘             │
        │                                          │                      ▼
        │ POST send-to-leak                        │ no reply         ┌─────┐
        │ (reason=returned_to_queue)               │ within window    │ won │
        ▼                                          ▼                  └─────┘
   ┌──────────────┐                      ┌──────────────────┐
   │ no_response  │                      │   no_response    │
   │ (terminal —  │                      │   (terminal)     │
   │  outcome_    │                      └──────────────────┘
   │  reason_id=  │
   │  sent_to_    │                      lost_price | lost_service |
   │  leak_queue) │                      lost_timing | lost_incumbent
   └──────────────┘                      lost expired | won_low_margin
                                         (all terminal)
```

### 4.2 Snooze (orthogonal)

```
   snoozed_until = NULL  ── PATCH .../snooze ─→  snoozed_until = T_future
                                                          │
                                                          │ wall clock ≥ T
                                                          ▼
   snoozed_until = NULL  ←── (no event; default list filter just stops
                              hiding the row)

   PATCH .../snooze {snoozedUntil: null}  ←── manual unsnooze (any time)
```

Snooze does NOT change `outcomeStatus`. A `pending` snoozed row is
still `pending`; the list endpoint just hides it by default.

### 4.3 Terminal vs non-terminal — guard rules

**Terminal:** `won`, `lost_*`, `no_response`, `expired`,
`won_low_margin`, `attached`.

**Guards:**
- `POST .../attach-to`, `POST .../send-to-leak` reject (`409
  already_closed`) when source opp is in any terminal state.
- `PATCH .../snooze` is allowed in any state — snoozing a closed row is
  a no-op for the rep but allowed (don't throw); the list filter
  already hides closed rows from the default Quote Requests view via
  the `outcomeStatus` default filter (§3.6).
- `PATCH .../mark-outcome` (existing endpoint) already enforces its own
  transitions; we do not change them. Reps can still flip a `pending`
  to `won` via the existing path — this contract does not displace
  that.

### 4.4 Source enum (canonical values)

| Source         | Created by                                         |
|----------------|----------------------------------------------------|
| `email`        | Pre-2b raw inbound; legacy backfill for non-signal-linked rows |
| `email_signal` | Phase 2b autopilot (signal → opp closure path)     |
| `tms`          | TMS/load-board ingestion                           |
| `crm`          | CRM/account-record creation                        |
| `manual`       | Operator typed into the legacy form                |
| `import`       | Bulk import (XLSX/CSV)                             |
| `spot_search`  | Spot Quote Search → Quote Builder (existing path)  |

---

## 5. Event-writing model

| Surface that writes      | Table                  | Key fields                                                                                  | Wins/Loses race against |
|--------------------------|------------------------|---------------------------------------------------------------------------------------------|--------------------------|
| Phase 2b closure svc     | `quote_opportunities` (insert) | source='email_signal', source_reference=email_messages.provider_message_id              | partial-uniq idx on `(org, source_reference) WHERE source_reference IS NOT NULL` |
| Phase 2b closure svc     | `email_signals` (update) | linked_opportunity_id = new opp id                                                          | (advisory) — last write wins; mutex in service |
| Phase 2b closure svc     | (no quote_events row for skipped) | counters live in service-local store, exposed via leakage-stats                  | n/a                      |
| `attach-to` endpoint     | `quote_opportunities` (update) | outcome_status='attached'                                                              | mutex `attach:${org}:${src}:${tgt}` |
| `attach-to` endpoint     | `email_signals` (update) | linked_opportunity_id := targetOppId                                                       | (above mutex)            |
| `attach-to` endpoint     | `quote_events` (insert) | event_type='opp_attached_in/out', actor='manual_leak_attach'                                | (above mutex)            |
| `attach-to` endpoint     | `capture_leak_reviews` (upsert) | decision='attached'\|'duplicate', leak_type='missed_inbound'                          | unique idx (org, msg, leak_type) |
| `send-to-leak` endpoint  | `quote_opportunities` (update) | outcome_status='no_response', outcome_reason_id='sent_to_leak_queue'                 | mutex `send-to-leak:${org}:${opp}` |
| `send-to-leak` endpoint  | `quote_events` (insert) | event_type='sent_to_leak', actor='rep_send_to_leak'                                         | (above mutex)            |
| `send-to-leak` endpoint  | `capture_leak_reviews` (upsert) | decision='returned_to_queue' or 'not_a_request'                                       | unique idx                |
| `send-to-leak` endpoint  | `email_signals` (update, conditional) | linked_opportunity_id := NULL (only when decision='returned_to_queue')          | (above mutex)            |
| `send-to-leak` endpoint  | `quote_sender_mappings` (insert, conditional) | suppression row when suppressSender=true                                | unique idx (org, sender_email or domain) — handled by helper |
| `snooze` endpoint        | `quote_opportunities` (update) | snoozed_until column                                                                   | none (idempotent)         |
| `snooze` endpoint        | `quote_events` (insert) | event_type='snoozed' or 'unsnoozed', actor='rep_snooze'                                     | none                      |
| `send-thread-reply` ep.  | `email_messages` (insert) | direction='outbound', provider_message_id from send result                                 | unique idx (org, provider_message_id) |
| `send-thread-reply` ep.  | `quote_events` (insert, conditional) | event_type='outbound_reply', actor='rep_reply' (only when linkedQuoteId set)         | none                      |

### 5.1 `quote_events` invariants (enforced by schema today)

- `quote_id` is `NOT NULL` and FK-cascade to `quote_opportunities`.
  → A `quote_events` row exists ONLY when there's a real opp behind it.
- Phase 2b skipped-* counters CANNOT live in this table. They live in
  the closure service's per-window counter store, exposed via
  leakage-stats and the new automation-counters endpoint.

### 5.2 `capture_leak_reviews` invariants

- Unique on `(organization_id, message_id, leak_type)`. Upserts (not
  inserts) when re-reviewing the same row — the latest decision wins.
- After §1.2's enum extension, `decision` can be any of
  `not_quote | ignored | attached | returned_to_queue | duplicate | not_a_request`.
- The chokepoint `buildLeakCandidateIds` SURFACES rows where
  `decision='returned_to_queue'`; SUPPRESSES all others.

### 5.3 `email_signals.linked_opportunity_id` invariants

- Set by Phase 2b closure when a signal materializes an opp.
- Re-pointed by `attach-to` (signal now links to target opp).
- Cleared by `send-to-leak` when `decision='returned_to_queue'` (the
  signal is back to "leaked" and should re-show in leakage-stats).
- Left intact by `send-to-leak` when `decision='not_a_request'` (the
  signal had a real opp; rep just declared it out of scope).

---

## 6. Permission rules — endpoint × role matrix

| Endpoint                              | rep (own) | rep (other) | manager | admin/director/sales_director | notes                              |
|---------------------------------------|:---------:|:-----------:|:-------:|:----------------------------:|------------------------------------|
| `GET /api/customer-quotes/list`       | ✓         | ✓           | ✓       | ✓                             | existing — no change               |
| `GET .../quote/:id`                   | ✓         | ✓           | ✓       | ✓                             | existing — no change               |
| `POST .../quote` (create)             | ✓         | n/a         | ✓       | ✓                             | existing — no change               |
| `PATCH .../quote/:id` (edit)          | ✓         | —           | ✓       | ✓                             | existing — no change               |
| `POST .../quote/:id/attach-to` NEW    | —         | —           | —       | ✓                             | elevated only (manual override of autopilot) |
| `POST .../quote/:id/send-to-leak` NEW | ✓         | —           | ✓       | ✓                             | reps can escalate their own opp    |
| `PATCH .../quote/:id/snooze` NEW      | ✓         | —           | ✓       | ✓                             | manager can unsnooze a rep's row   |
| `GET /api/quote-requests/automation-counters` NEW | ✓ | ✓ | ✓ | ✓                  | rep-readable telemetry             |
| `POST /api/email-conversations/:threadId/reply` NEW | ✓         | —           | ✓       | ✓                             | own/manager/admin only (matches spec §5.5); reps cannot send replies on other reps' threads even if the thread is visible. The thread-visibility predicate is a NECESSARY but not SUFFICIENT condition — ownership is the second gate. |

**Role-resolution contract:**
- "Rep (own)" = the requesting user is the assigned `repId` on the
  opportunity.
- "Rep (other)" = the opp's `repId` resolves to a different user.
- "Manager" = the requesting user is in the org-hierarchy chain above
  the opp's rep (resolved via the existing
  `resolveFunnelRepScope` helper).
- "Admin/director/sales_director" = `user.role` matches one of the
  three.

All new endpoints reuse `requireUser` middleware then perform the
role check inline; no new middleware required. Each endpoint logs the
acting `userId` in the `quote_events.payload.byUserId` field for
audit.

### 6.1 Existing endpoints — security gap to close in S1 (NEW, addresses architect feedback)

The architect review surfaced that the existing
`PATCH /api/customer-quotes/quote/:id` (server/routes/customerQuotes.ts:263)
and `POST /api/customer-quotes/quote/:id/mark-outcome` (line 1177) gate
ONLY on `requireUser` + org-membership — they do NOT enforce the
rep-own/manager/admin matrix that the post-2d UI assumes. This means
today any rep in an org can mutate any other rep's opp by guessing or
listing the id.

**Required fix in S1 (before any UI work uses these endpoints):**
- Add an inline ownership check at the top of both handlers:
  ```ts
  const opp = await getQuoteOpportunity(user.organizationId, oppId);
  if (!opp) return res.status(404).json({ error: "Not found" });
  const isElevated = ["admin", "director", "sales_director"].includes(user.role);
  const isOwner = opp.repId === user.id || (opp.repId && (await isManagerOf(user.id, opp.repId)));
  if (!isElevated && !isOwner) {
    return res.status(403).json({ error: "Forbidden" });
  }
  ```
- Reuse `resolveFunnelRepScope` for the manager check (same helper the
  list endpoint uses).
- Audit the existing `bulk-reassign-customer` and `bulk-status`
  endpoints for the same gap; harden as needed.
- Add a guardrail test (`tests/customer-quotes-permissions.test.ts`,
  NEW): assert non-owner reps get `403` on PATCH and mark-outcome.

This work is added to S1 (schema migrations PR) so the contract's
matrix is real before anyone leans on it. Skipping this would make
the post-2d UI a broken-access-control vector.

---

## 7. Canonical vs denormalized fields

### 7.1 Canonical (single source of truth)

| Field                         | Lives in                                  | Read via                       |
|-------------------------------|-------------------------------------------|--------------------------------|
| Quote opportunity identity    | `quote_opportunities.id`                  | `GET .../quote/:id`            |
| Outcome status                | `quote_opportunities.outcome_status`      | same                           |
| Outcome reason                | `quote_opportunities.outcome_reason_id` → `quote_outcome_reasons.label` | same |
| Source classification         | `quote_opportunities.source`              | same                           |
| Source reference (provider msg id) | `quote_opportunities.source_reference` | same                          |
| Snooze state                  | `quote_opportunities.snoozed_until`       | same                           |
| Pricing                       | `quote_opportunities.quoted_amount`       | same                           |
| Customer link                 | `quote_opportunities.customer_id` → `quote_customers` | same               |
| Rep assignment                | `quote_opportunities.rep_id` → `quote_reps` | same                         |
| Lane                          | origin/dest city/state columns on `quote_opportunities` | same             |
| Equipment                     | `quote_opportunities.equipment`           | same                           |
| Signal extraction confidence  | `email_signals.confidence` (per-signal)   | embedded in `getQuoteDetail` for `source='email_signal'` |
| Email thread for the opp      | `email_signals.message_id` → `email_messages.thread_id` | embedded in `getQuoteDetail` |
| Activity timeline             | `quote_events` (append-only)              | embedded in `getQuoteDetail`   |

### 7.2 Denormalized (computed on read; UI must not write)

| Field                  | Computed how                                                                                  | Surface                       |
|------------------------|-----------------------------------------------------------------------------------------------|-------------------------------|
| `isSnoozed`            | `snoozed_until > now()`                                                                       | `GET .../list` per row        |
| `isPastSla`            | `requestDate < now() - sla_threshold_hours` (existing logic)                                  | `GET .../list` per row        |
| `isFreeEmailSender`    | inbound message domain ∈ free-mail set (existing logic)                                       | `GET .../list` per row        |
| `confidence`           | most recent linked `email_signals.confidence` (max if multiple)                               | `GET .../quote/:id`           |
| Last activity label    | top-of-stack `quote_events` row formatted by event_type → human string                        | `GET .../list` per row        |
| KPI strip counts       | aggregate over the same `outcomeStatus` filters as the list                                   | `GET .../snapshot` (existing) |
| Automation counters    | `computeClosureCounters(orgId, window)` (shared svc, see §3.4)                                | `GET .../automation-counters` |

The UI MUST treat denormalized fields as read-only. Mutations always
target the canonical column.

---

## 8. Sprint plan (sequenced for #850 unblock)

Each slice is a separate PR, lands in order. Each PR independently
ships green CI. The UI build (#850) can begin against any slice as
soon as that slice is merged — listed in dependency order.

| # | PR title                                                                              | Days | Unblocks UI work                                                                  |
|---|---------------------------------------------------------------------------------------|------|-----------------------------------------------------------------------------------|
| S1| Schema migrations + backfill (§1.1, §1.2, §1.3, §2)                                   | 1    | All UI work that filters on the new enum values (source filter, attached outcome) |
| S2| `POST .../quote/:id/attach-to` (§3.1)                                                 | 1    | Attach + Mark-duplicate kebab actions (spec §5.4, §5.7)                           |
| S3| `POST .../quote/:id/send-to-leak` (§3.2)                                              | 1    | Send-to-leak + Override-autopilot actions (§5.6, §5.13)                           |
| S4| `PATCH .../quote/:id/snooze` (§3.3) + list-endpoint snooze filter (§3.6 partial)      | 1    | Snooze action, snoozed-row banner, "Include snoozed" filter (§5.8, §5.9)         |
| S5| `GET /api/quote-requests/automation-counters` (§3.4)                                  | 1    | Automation strip on list + drawer (§3.10)                                         |
| S6| `POST /api/email-conversations/:threadId/reply` + adapter (§3.5)                      | 2    | Send-quote action (§5.5) — biggest single-PR scope; involves provider plumbing    |
| S7| List-endpoint full extension (`includeSnoozed`, `source` docs, `outcomeStatus` defaults) (§3.6) | 0.5  | UI list filters, "include attached" toggle                                |
| S8| Analytics audit for `outcomeStatus='attached'` (§1.3) + tests pass                    | 1    | Closes the LOOP — guarantees no analytics surface double-counts re-routings        |

**Sprint total:** ~8.5 days of backend work. Order is sequential
within S1–S6 (S1 first, S6 anywhere after); S7 and S8 can run in
parallel with S6.

**S1 acceptance gate (blocks all other slices):**
- Schema-drift guard reports zero drift after migration.
- Backfill runs idempotent (re-running `runMigrations` is a no-op).
- Existing tests pass (`tests/code-quality-guardrails.test.ts`,
  `tests/conversations-leakage-stats.test.ts`,
  `tests/conversations-freshness-regression.test.ts`,
  `tests/storage-integration.test.ts`).
- New guardrails in `tests/code-quality-guardrails.test.ts`:
  - QUOTE_OUTCOME_STATUSES contains `'attached'`.
  - QUOTE_SOURCES contains `'email_signal'` and `'spot_search'`.
  - CAPTURE_LEAK_REVIEW_DECISIONS contains the full 6-value set.
  - Every analytics query that filters on `outcomeStatus` lists
    `'attached'` explicitly (in or out).

**Per-slice acceptance criteria:** see §3 for AC1–AC6 per endpoint;
S1 has the additional list above; S8 has the analytics-audit
checklist as its definition of done.

---

## 9. Out of scope for #849

These are deliberately deferred to keep the contract sized for one
sprint:
- **Saved views** (spec §3.5) — adds a `quote_saved_views` table; not
  blocking the UI build because the UI can ship with hard-coded views
  first. Add as a #849 follow-up.
- **Bulk operations** (multi-select, bulk-snooze, bulk-send-to-leak) —
  the existing bulk-status / bulk-reassign endpoints cover the must-haves;
  bulk versions of the new endpoints can come in a v2.
- **CSV export** — existing `GET .../export.csv` works fine for the
  current row shape; will need an additive column when `snoozed_until`
  graduates from "operator self-care" to "audit-relevant," but not
  blocking.
- **The Quote Analytics surface** (spec §9 Q7) — separate route
  `/analytics/quotes`, separate task.

---

## 10. Sign-off checklist for Task #849

- [x] User has ratified the 3 RESOLVED schema decisions (§1.1, §1.2, §1.3).
- [x] User has approved the 8-slice sprint plan (§8) and timing.
- [x] All 5 new endpoints have agreed-upon URLs and shapes (§3).
- [x] The state model in §4 reflects the team's mental model
      (esp. the orthogonal-snooze decision).
- [x] The event-writing model in §5 has no missing rows for surfaces
      the UI will touch.
- [x] The permission matrix in §6 matches the spec's permission table
      (§5 of the spec doc).
- [x] User has approved the §6.1 security-gap fix in S1 (existing
      PATCH/mark-outcome ownership enforcement). This is a real
      security risk in today's codebase, surfaced by the architect
      review of this contract.
- [x] User has approved the §3.1 re-attach correction path
      (elevated-only) and the §3.5 inline pending→quoted flip.

**LOCKED — 2026-04-30.** All eight items ratified by user. This
contract is the source of truth for Task #850 (UI build) and every
backend slice in §8. Any deviation from the shapes, state model,
event-writing rules, or permission matrix above must be re-ratified
before implementation.

---

## 11. Amendment log

| Date       | Section(s)              | Change                                                                                                                                                       | Trigger              |
|------------|-------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------|
| Initial    | All                     | First full draft of the contract.                                                                                                                            | Task #849 kickoff    |
| Initial+1  | §3.1                    | Added re-attach correction path (elevated-only) so wrong attaches can be repaired without manual SQL.                                                        | Architect review     |
| Initial+1  | §3.2                    | When `decision='returned_to_queue'`, ALSO clear `quote_opportunities.source_reference` (not just `email_signals.linked_opportunity_id`) so the leakage-stats classifier reclassifies the signal as `leaked`.| Architect review     |
| Initial+1  | §3.5                    | Inline `pending→quoted` flip when `linkedQuoteId` is set, eliminating the up-to-30s autopilot lag the rep would otherwise see. AC1 updated.                  | Architect review     |
| Initial+1  | §3.7 (NEW)              | Document the required leakage-stats classifier amendment (`AND clr.decision <> 'returned_to_queue'` in both CTEs) plus test extension. Lands in S2.          | Architect review     |
| Initial+1  | §6, §6.1 (NEW)          | Reconcile §3.5 permission row to "own/manager/admin only" (was "rep other if visible"). Added §6.1 documenting the existing security gap on PATCH/mark-outcome and folding the fix into S1. | Architect review     |
| 2026-04-30 | §10                     | All 8 sign-off items ratified by user. Contract locked as source of truth for Task #850 and all backend slices in §8.                                                                       | User ratification    |
