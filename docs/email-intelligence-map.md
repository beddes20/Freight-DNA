# Email Intelligence Map — FreightDNA

> Read-only architecture analysis of how customer/carrier email learnings flow
> through FreightDNA today and where they actually change behavior. Compiled
> from a parallel code audit; no production access, no PII captured.
> Dev-only inspection, no scripts run.

---

## 1. Storage

### Email-content tables (in `shared/schema.ts`)

| Table | What we store | Mode | Key links |
|---|---|---|---|
| `email_messages` | `subject`, `body`, `from_email`, `to_email`, `cc_email`, `direction`, `thread_id`, `provider_message_id`, `provider_sent_at`, `ingested_via` | **Full body, truncated to 8 KB** + 255-char `body_preview` | `org_id`, `linked_account_id` (companies), `linked_carrier_id` (carriers), `linked_lane_id`, `linked_task_id`, `linked_nba_id` |
| `email_conversation_threads` | thread state — `waiting_state`, `response_priority`, `last_incoming_at`, `last_outgoing_at`, `snoozed_until`, `last_message_id` | metadata only | `linked_account_id`, `linked_carrier_id`, `owner_user_id` |
| `email_signals` | AI classification output — `intent_type`, `intent_subtype`, `confidence`, `extracted_data` (JSON) | extracted labels, no body | `message_id` → `email_messages` |
| `email_extracted_slots` | Lane / rate / equipment / dates with `evidence` and `confidence` | parsed entities | `message_id`, `linked_lane_id`, `linked_account_id` |
| `email_promises` / `email_questions` | promise text, question text, `due_at`, `status` | tracking | `message_id`, `rep_user_id` |
| `email_participants` | per-recipient metadata, role (from/to/cc/fwd) | metadata | `message_id`, `contact_id`, `company_id` |
| `quote_opportunities` | the quote row itself — `source='email'`, `source_reference=messageId`, `routing_status`, `notes`, `needs_new_contact_review` (JSON) | derived | `customer_id`, `rep_id`, `carrier_id` |
| `quote_pipeline_drops` | failed-to-capture snapshot — `subject`, `detail`, `sender_email`, `received_at`, `stage`, `reason_code`, `extracted_snapshot` (JSON) | failure forensics | `message_id`, `quote_id`, `resolved_by_id` |
| `capture_leak_reviews` | manager dispositions — `note`, `leak_type`, `decision` | review evidence | `message_id`, `decided_by_user_id` |
| `pod_intake_emails` | AR mailbox classification — `subject`, `body_text`, `body_preview`, `classification`, `forward_status`, `extracted_order_ids` | full body | `mailbox_id`, `dispatcher_user_id` |
| `monitored_mailboxes` | per-mailbox sync state — `subscription_id`, `delta_sync_token`, `health_status`, `monitor_mode` | sync metadata | `org_id`, `user_id` |

**Body re-fetch policy:** persisted bodies are authoritative. Graph re-fetch
only happens in storage-recovery paths (`mailboxDeltaSyncService` and
`conversationReplyCaptureService`) when a row was missed first time.

### Ingestion services

| File | Job | Writes to |
|---|---|---|
| `server/routes/graphWebhook.ts` (`processUserMailboxEmail`) | Single ingest chokepoint for webhook + delta-poll + backfill + reply self-heal | `email_messages`, `email_conversation_threads`, `carrier_outreach_logs`, `pod_intake_emails` |
| `server/services/mailboxDeltaSyncService.ts` | Periodic catch-up via Graph delta tokens | `email_messages`, `mailbox_sync_failures`, `monitored_mailboxes.delta_sync_token` |
| `server/services/mailboxHistoricalBackfillService.ts` | 30-day initial sync for new mailboxes | `email_messages` (via the same chokepoint) |
| `server/services/inlineEmailClassifier.ts` | In-process LLM classification dispatcher | `email_signals`, hands off to `quoteEmailIngestion` |
| `server/services/quoteEmailIngestion.ts` | Regex + LLM → quote rows + win/loss flips | `quote_opportunities`, `quote_events`, `quote_customers`, `quote_pipeline_drops` |
| `server/services/conversationReplyCaptureService.ts` | Self-heal sweep for missing Sent Items | `email_messages`, `conversation_thread_capture_audits`, `email_conversation_threads` |
| `server/services/podIntakeService.ts` | POD classification + forwarding | `pod_intake_emails` |
| `server/emailIntelligenceService.ts` (`extractEmailSignals`) | Master AI classifier | `email_signals` |

---

## 2. AI / Classification

| Function | File | Model | Input | Output | Where output is consumed |
|---|---|---|---|---|---|
| `extractEmailSignals` | `server/emailIntelligenceService.ts` | gpt-4o-mini | subject + from/to + direction + cleaned body (≤8 KB, HTML stripped, quoted history removed) | JSON: `signals[]` (intentType, intentSubtype, confidence 0–100, extractedData, reasoning), `actorType` (customer/carrier/internal), `summary` | **Persists to `email_signals`. Drives:** `quoteEmailIngestion` ingest path; `quote_opportunities.routing_status` (`auto_customer` / `auto_carrier` if conf ≥ 0.7, else `needs_routing`); `applyClosedWonToOpenQuote` / `applyClosedLostToOpenQuote` lifecycle flips; Conversations bucket placement; UI intent badges |
| `parseQuoteEmailAi` | `server/services/quoteEmailIngestion.ts` | gpt-4o-mini | subject + body (≤2 KB) | JSON: `isQuote`, `originCity/State`, `destCity/State`, `equipment`, `quotedAmount`, `pickupDate` | **Writes `quote_opportunities` lane fields**; if `isQuote=false` → recorded as `classifier_miss` in `quote_pipeline_drops`; renders in Quote Requests dashboard |
| `getOrGenerateThreadSummary` | `server/services/conversationThreadSummaryService.ts` | gpt-4o-mini (`AGENT_MODELS.fast`) | up to 12 latest messages (Subject, From, Direction, body ≤1.2 KB each) | 2–3 sentences | Cached in `conversation_thread_summaries` keyed by content hash; rendered in `ThreadDetailPane`; feeds Suggested Actions context |
| `refineWithAI` (Suggested Actions) | `server/services/conversationThreadSuggestionService.ts` | gpt-4o-mini | latest inbound (Subject, From, body ≤1.5 KB) + thread state + signals + **past rejections feedback** | JSON: `reason`, `recommendation` ∈ `draft_reply` / `quote_request_reply` / `mark_resolved` / `await_response` | Persisted in `conversation_thread_suggestions`; rendered as one-click action card; can override deterministic rule (e.g., OOO → mark resolved); learning loop captures user dismissals |

**Ranking note:** queue order is deterministic (`responsePriority` + `waitingSinceAt`); AI signals influence *suggestion text*, not list ordering.

---

## 3. Coaching

### Scoring / fit
| Surface | File:line | Email signals consumed | Definition | Audience |
|---|---|---|---|---|
| Quote response-time SLA | `server/services/customerQuotes.ts:1414` (`attachResponseTimes`) | `email_messages.provider_sent_at` (outbound) − `quote_opportunities.request_date` | Minutes from inbound request to first outbound rep reply on the same thread | Rep + manager |
| Quote win rate | `server/services/customerQuotes.ts:1845` (`getSnapshot`), `:4293` (`searchSpotQuote`) | `outcome_status` (won/lost flips set by AI win/loss detector or manual) | `won / (won+lost)` per lane / customer / rep | Rep (Pricing card) |
| Carrier fit (uses email-derived perf) | `server/services/copilot/copilotFitEngine.ts:18` | `carrier_scorecard_fact.performanceScore`, `onTimePct` | 0–100 lane fit score | Rep (DNA Copilot) |

### Attribution
| Surface | File:line | Logic | Audience |
|---|---|---|---|
| Account Owner fallback in Customer Quotes | `server/services/customerQuotes.ts:1164` (`enrich`, via `ownerRepNameByCustomerId` from `companies.ownerRepId`) | When last-toucher is ambiguous, display the canonical account owner | Rep (table cell) |
| "Why this rep?" attribution drawer | `server/routes/customerQuotes.ts:577` | Joins users + reps to explain the chain (last touch → account owner → customer owner) | Manager / admin |

### Alerts / dashboards / scorecards
| Surface | File | Email signals | "Leak" / metric definition | Audience |
|---|---|---|---|---|
| Manager Leak Console | `server/routes/leakConsole.ts`, schema `quote_pipeline_drops` (`shared/schema.ts:6593`) | `reason_code` (unparseable, not_a_leak, classifier_miss, low_confidence), `capture_leak_reviews.decision` | A quote-shaped inbound that did not produce an opportunity (low AI confidence or "orphan outbound" — rep replied to an email we never ingested as inbound) | Manager (`/leak-console`) |
| Quote Capture Funnel | `client/src/components/customer-quotes/FreightCaptureFunnel.tsx:223` | `replyRate`, `winRatePct`, `avgResponseTime` | Requests → Quotes → Wins funnel | Manager |
| Action Queue (SLA breaches) | `server/services/customerQuotes.ts:1547` (`getActionQueue`) | `sla_state` derived from `requestDate` | Quotes > 7 min old with no outbound reply | Rep |
| Pattern-shift alerts | `server/services/customerQuotes.ts:2159` | Per-rep / per-lane email volume + win-rate baselines | Notifies when win rate or response time deviates from 30-day baseline | Manager |

---

## 4. Execution — does email actually change state, or is it observation?

**Verdict: the system actively changes state from email signals — it is not observe-only.** Five concrete state-change paths:

| # | State change | File:line | Trigger | Automation |
|---|---|---|---|---|
| A | INSERT `quote_opportunities` from inbound email | `server/services/quoteEmailIngestion.ts:990` | Inbound on monitored mailbox + regex/LLM detects pricing intent | Fully automated (inline classifier or 2-min cron) |
| B | UPDATE `quote_opportunities.outcome_status='lost_*'` | `server/services/quoteEmailIngestion.ts:1497` | AI `closed_lost_indicator` or `isLostLanguage` regex | Fully automated |
| C | UPDATE `quote_opportunities.outcome_status='won'` | `server/services/quoteEmailIngestion.ts:1654` | AI `closed_won_indicator` or `isWonLanguage` regex | Fully automated |
| D | Set `quote_opportunities.rep_id` (ownership) | `server/services/quoteEmailIngestion.ts:993` (precedence at `:945`, `:956`, `:971`) | (1) inbox recipient → quoteReps row, else (2) `companies.ownerRepId` via sender domain, else (3) `quote_customers.ownerRepId` | Fully automated |
| E | Flip `routing_status` (`auto_customer` / `auto_carrier` / `needs_routing`) | `server/services/inlineEmailClassifier.ts:287-313` | AI confidence + `senderRoutingRules` overrides | Fully automated |
| F | INSERT `freight_opportunities` (Available Freight) — **Won Load Autopilot** | `server/services/customerQuotes.ts:3280`; notifications at `:3305` | Triggered by `applyClosedWonToOpenQuote`; created with `status='pending_approval'` for the rep to confirm/assign LM | Auto-create, manual confirm |

### Observe-only surfaces
- Capture Leak Queue (`CaptureLeakQueue.tsx`) — emails that *could* have been quotes
- `quote_pipeline_drops` console — why the system ignored an email
- Drift / capture-rate dashboards
- `mailboxWatchdogService.ts` — sync health

### What feeds into Available Freight (today)
Available Freight is fed **indirectly via Won quotes** (Won Load Autopilot) plus manual / OneDrive-financial uploads. **No direct path** from raw email → load.

---

## 5. Execution Gaps

Places where the system clearly *knows* something from email but does not act on it:

1. **Carrier-rate ingestion is one-sided.** Customer-side rate quotes (`quotedAmount`) flow into `quote_opportunities`. Carrier-side rate offers ("we'll cover it at $1850") get classified but never update a `targetBuyRate` or create a procurement-side carrier_quote event. (`server/services/quoteEmailIngestion.ts` lacks a `carrier_quote` branch.)
2. **`needs_routing` discards regex evidence.** When `looksLikeQuoteCandidate` matches but AI confidence < 0.4, the row lands in `needs_routing` empty — the regex-extracted lane / equipment hints are not passed through, so the rep retypes everything. (`server/services/inlineEmailClassifier.ts`)
3. **Contact / signature deltas don't update the CRM.** Email signatures contain new phone numbers, titles, and new contacts on existing accounts. The classifier extracts these per-quote but never writes back to the `contacts` table. (`server/services/quoteEmailIngestion.ts` needs a `syncContactEntities` helper.)
4. **"We're sending you the load" never auto-creates freight.** The Won Load Autopilot only fires from explicit win-language on a *prior open quote*. A first-touch tender email ("PO #123 attached, please cover Atlanta→Dallas Tuesday") with no prior quote doesn't create a `freight_opportunities` row — it sits in Conversations as a quote_request bucket entry only.
5. **Free-mail (Gmail/Yahoo) senders fail-safe to "Unknown."** `backfillFreeMailCustomerNames` (`quoteEmailIngestion.ts:1852`) deliberately suppresses auto-attribution for free-mail providers to avoid "Gmail Inc" appearing as a customer. Valid small-business inbound lands unattributed and visible only in admin / Needs Routing — pending a richer signature-based or thread-history attribution pass.
6. **Value Truck ingestion caveat.** Sections 1–3 above describe the contract; if the Value Truck mailbox isn't syncing (separate operational issue), every "ACT" path in §4 is starved of inputs and only the observe-only surfaces will show signal — manifesting as "no new quotes" at the rep view even though the read layer is healthy.

---

## Next 5 Email Execution Upgrades (prioritized)

Each item is one concrete change. Each lists the likely files, a one-sentence acceptance test, and the rep/LM payoff.

### 1. First-touch tender → auto-create freight opportunity
- **What:** When an inbound email is classified `tender_received` / `award_notice` *without* a prior open quote on the thread, create a `freight_opportunities` row in `pending_approval` and link it to the source `email_messages.id` and the resolved `companies.id`. (Today the Won Load Autopilot only fires when there is already an open won quote.)
- **Files:** `server/emailIntelligenceService.ts` (add `tender_received` handling), `server/services/customerQuotes.ts:3280` (`createFreightOpportunityFromWonQuote` — generalize to `createFreightOpportunityFromTender`), `server/routes/freightOpportunityCockpit.ts` (display source badge "from email — tender"), schema unchanged.
- **Acceptance:** Send a test inbound containing "PO #4421 attached, please cover Atlanta GA → Dallas TX 2026-05-07 reefer" with no prior quote on the thread → within 2 minutes a row appears in `freight_opportunities` with `status='pending_approval'`, `source='email'`, `sourceReference=<messageId>`, and a notification fires to the resolved account owner.
- **Why it matters:** Today reps copy-paste tender emails into freight manually. This closes the most obvious "knew it, didn't do it" gap and is the single biggest LM volume lever.

### 2. Pass regex/LLM lane hints into `needs_routing`
- **What:** When confidence < 0.7 lands a row in `needs_routing`, persist whatever regex + AI did extract (`originCity/State`, `destCity/State`, `equipment`, `pickupDate`, `quotedAmount`) into the row's draft fields and surface them as pre-filled inputs in the routing drawer. Do not change `routing_status` semantics — only enrich the row.
- **Files:** `server/services/inlineEmailClassifier.ts:287-313` (pass `extractedData` through), `server/services/quoteEmailIngestion.ts` (write hints into `quote_opportunities` even when `isQuote` is uncertain), `client/src/pages/quote-requests.tsx` Needs-Routing drawer (render hints with a "AI suggested — confirm" pill).
- **Acceptance:** Send a test inbound that triggers `looksLikeQuoteCandidate` but AI confidence 0.4–0.7 → the Needs-Routing row shows the parsed lane / equipment / rate as pre-filled, and confirming the row in one click writes the same values into `quote_opportunities` without re-typing.
- **Why it matters:** Cuts retype time on the highest-friction bucket. Honors CQ-2 by *not* widening the customer-only chokepoint — the row stays in Needs Routing until a human confirms.

### 3. Carrier-quote branch in ingestion
- **What:** When `actorType='carrier'` and a rate is extracted, write a `carrier_quote_event` (or extend `quote_events`) with `carrierId`, `targetBuyRate`, `email_messages.id`, and surface it on the procurement side of the lane. Does not affect customer quote rows.
- **Files:** `server/services/quoteEmailIngestion.ts` (add `ingestCarrierQuoteFromEmail`), `shared/schema.ts` (new `carrier_quote_events` table or `quote_events.kind` enum extension), `server/services/copilot/copilotFitEngine.ts` (consume the new fact), Carrier Hub UI surface for visibility.
- **Acceptance:** A carrier email "we'll cover ATL→DAL Tuesday at $1,850" on a known lane creates a `carrier_quote_events` row within 2 min; the load's procurement panel shows the carrier offer alongside any prior quotes; no `quote_opportunities` row is touched.
- **Why it matters:** Carrier price discovery today is locked in inboxes. Writing it back lets the Rate Intelligence and Copilot fit engines learn buy-side market rates per lane.

### 4. Signature-derived contact + rep linking sweep
- **What:** When `extractEmailSignals` finds new sender entities (phone, title, alternate email) on a domain that already maps to a `companies` row, upsert the contact into `contacts` and queue a "new-rep claim" if the signature looks like a rep at our org. This addresses the same root cause Task #1048 just fixed at the read layer (unlinked `quote_reps.user_id`).
- **Files:** `server/services/quoteEmailIngestion.ts` (new `syncContactEntities`), `server/services/contactSuggestionService.ts` if it exists, schema unchanged. Pair with proposed Task #1049.
- **Acceptance:** A reply from a not-yet-known sender on a known account creates a `contacts` row with name/title/phone parsed from the signature, the sender appears as a selectable contact in the account drawer, and ZoomInfo enrichment is queued.
- **Why it matters:** Stops the slow drift where signature-only reps and contacts pile up with `user_id IS NULL`, which is exactly what hid 70 % of fresh quotes from rep view this week.

### 5. Free-mail attribution via thread + signature heuristics
- **What:** Replace the blanket free-mail suppression with a tiered fallback: (a) if the thread already has an inbound from a corporate domain, attribute the free-mail reply to that domain's `companies` row; (b) else parse company name from email signature; (c) else keep the suppression. Prevents loss of small-business quotes without re-introducing "Gmail Inc."
- **Files:** `server/services/quoteEmailIngestion.ts:1852` (`backfillFreeMailCustomerNames`), `server/emailIntelligenceService.ts` (signature-name extraction signal), classifier prompt update.
- **Acceptance:** A Gmail-domain reply on a thread whose first message came from `@acmecarriers.com` attaches to the Acme Carriers account; a brand-new Gmail inbound with "Acme Brokerage – Jane Doe" in the signature creates a draft contact + suggested account named "Acme Brokerage" rather than "Unknown / Gmail."
- **Why it matters:** Recovers the long tail of small-customer email volume that today silently sinks into Needs Routing or the leak queue.

---

## Constraints honored in this analysis
- Read-only inspection. No production database touched. No production `DATABASE_URL` fabricated.
- No customer PII captured anywhere in this document.
- Items 1–5 above are *recommendations*; none have been implemented in this audit.
- If the Value Truck mailbox is currently not syncing (separate operational issue), every ACT path in §4 is starved of input regardless of upgrades 1–5. Fix ingestion first, then layer these on.
