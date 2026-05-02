# Email Intelligence Layer

> **Status:** v1.5 — fact crystallization in progress (Task #943)
> **Owner:** DNA / Email Intelligence working group
> **Resume point:** this document. If you're a new working session, read this in full before touching code.

## Current state

Freight-DNA's email pipeline is a mature v1 system (Tasks #190 / #191 / #202 and follow-ons) that:

* Ingests inbound + sent mail from Microsoft Graph via webhook + delta sync, with self-heal sweeps and a 30-day historical backfill (`server/services/mailboxDeltaSyncService.ts`, `server/services/mailboxHistoricalBackfillService.ts`, `server/services/mailboxWatchdogService.ts`).
* Persists messages to `email_messages` keyed `(org_id, provider_message_id)` for idempotency and stamps `ingested_via` ∈ `delta | backfill | self_heal` (see `shared/schema.ts:emailMessages`).
* Runs an OpenAI intent extractor over each message that emits one or more rows in `email_signals` from a fixed taxonomy of **23 intent types** (10 carrier + 13 customer/spark — see `server/emailIntelligenceService.ts:CARRIER_INTENTS / CUSTOMER_INTENTS`).
* Maintains per-thread `email_conversation_threads` with owner, waiting-state, response-priority, snooze, and ball-in-court timestamps. The thread row is the unit reps see in the shared inbox.
* Triggers downstream consumers per signal: NBA cards (`server/nextBestActionEngine.ts`), carrier email NBAs (`server/carrierEmailNbaService.ts`), staged carrier enrichment (`server/carrierEmailEnrichmentService.ts`), staged account contact suggestions (`server/accountContactCaptureService.ts`), win/loss evidence linkage (`server/emailWinLossService.ts`), customer quote ingestion (`server/services/quoteEmailIngestion.ts`), capacity matches (`server/truckListParser.ts` + `server/truckLoadMatchingService.ts`), and reply-time analytics (`server/services/emailResponseTimeAnalyticsService.ts`).

Most of the *interpretation* the LLM produces today lives in `email_signals.extractedData` (a JSONB grab-bag). The v1.5 mission turns the signal-bearing parts of that JSONB into **first-class facts** that downstream code can read directly.

## Seven-layer architecture

| Layer | Responsibility | Where it lives today |
| ----- | -------------- | -------------------- |
| **1. Ingestion** | Webhook + delta + backfill + self-heal pull mail from Graph and write `email_messages`. | `server/routes/graphWebhook.ts`, `server/services/mailboxDeltaSyncService.ts`, `server/services/mailboxHistoricalBackfillService.ts`, `server/services/mailboxWatchdogService.ts` |
| **2. Normalization** | Strip boilerplate / quoted history / signatures, decode base64, dedupe on `(org_id, provider_message_id)`. | `stripEmailBoilerplate` in `server/emailIntelligenceService.ts`, `upsertInboundEmailMessage` in `server/storage.ts` |
| **3. Entity resolution** | Link a message to account, carrier, lane, load, task, NBA, outreach log via `linked_*_id` columns. | `server/accountContactCaptureService.ts`, `server/contactGeographyInferenceService.ts`, plus per-message resolution inside `mailboxDeltaSyncService` |
| **4. Signal extraction** | Run OpenAI intent classifier; emit one row per detected intent in `email_signals` with confidence + JSONB hints. | `server/emailIntelligenceService.ts`, `server/emailIntelligenceScheduler.ts` |
| **5. Fact crystallization** *(v1.5 — this mission)* | Turn the JSONB hints into first-class typed rows in dedicated fact tables (bounce, participants, attachment classifications, slots, promises, questions, sentiment, outbound quality). | `server/services/emailFacts/*` — see Facts section below |
| **6. Consumer adapters** | Downstream code (NBAs, pricing, coaching, reporting, conversations, account views) reads facts through a single `EmailFactsAdapter` instead of poking at `email_signals.extractedData` directly. | `server/services/emailFacts/emailFactsAdapter.ts` (Step 10) |
| **7. Feedback loop** | Outcomes (won/lost, kept-promise, answered-question, sent-correction, draft-feedback, suggestion-accepted/rejected) flow back to confidence calibration and learning. | `server/emailWinLossService.ts`, `server/services/suggestionFeedbackLearningService.ts`, `server/services/tacticalLearningService.ts`, plus per-fact status flips |

The architectural rule is: **new downstream code only ever reads facts (Layer 5) through the adapter (Layer 6).** Pre-existing consumers can keep reading raw `email_signals` for now; we don't rip them out as part of v1.5.

## Architectural constraints

These are non-negotiable for v1.5 and any future fact crystallization work:

1. **Do not regress v1.** The 23 intent types, scheduler, watchdog, retry ledger, and response-time analytics stay intact. Fact crystallization is purely *additive*.
2. **Facts, not JSONB.** Every Tier 1 / Tier 2 sub-task lands its output in a first-class table (or extends an existing one with typed columns). New keys do not get stuffed into `email_signals.extractedData`.
3. **Consumers read through the adapter.** New downstream code must not read `email_signals.extractedData` directly for the new facts; it must go through `EmailFactsAdapter`.
4. **Idempotency on ingestion.** Bounce events, participants, attachment classifications, slots, promises, questions, sentiment, and quality scores must all dedupe correctly under the existing webhook + delta + backfill + self-heal replay paths. The same `(org_id, provider_message_id)` discipline as `email_messages` applies.
5. **Stage, don't overwrite.** When new facts disagree with existing curated data (carrier profile, contact info, lane rate recommendation), follow the v1 pattern of staging suggestions for human review (see `carrier_email_suggestions`, `account_contact_suggestions`) — never silently overwrite curated fields.
6. **Doc-first continuity.** This document is the resume point between sessions. It is updated at the end of every step so a new working session can pick up cleanly.

## Facts

This section is the single source of truth for every fact table v1.5 introduces, the source step that wrote it, the adapter accessor that exposes it, and a safety marker. **Safe** = wired into a downstream consumer with tests; **experimental** = stored and queryable but not yet wired into a consumer.

| Fact | Table | Source step | Adapter accessor | Status |
| ---- | ----- | ----------- | ----------------- | ------ |
| Bounce / DSN / OOO | `email_bounce_events` | Step 2 (Tier 1.1) | `EmailFactsAdapter.getBounceStatusForContact` / `.isContactSuppressed` | safe — read by NBA generators (`generateNbasFromEmailSignals`, `generateAccountEmailNbas`) and by `GET /api/email-facts/contacts/:email/status` |
| Participants + roles | `email_participants` | Step 3 (Tier 1.2) | `EmailFactsAdapter.getParticipantsForThread` / `.getStakeholderGraphForAccount` | safe — roles `from`/`to`/`cc`/`bcc`/`reply_to`/`forwarded_original_sender`; surfaced via `GET /api/email-facts/threads/:threadId` and `GET /api/email-facts/accounts/:companyId` |
| Attachment classification | `email_attachment_classifications` | Step 4 (Tier 1.3) | `EmailFactsAdapter.getAttachmentsForMessage` / `.getRateConsForLane` | safe — rate-con caller wired to `documentIngestion.ingestDocument(source='email_forward')` + `enqueueRateConAfterIngest`; uploader resolved from rep on outbound mail or mailbox owner on inbound mail; graceful no-op (records `rate_con_extractor_failed`) when the uploader can't be resolved |
| Competitive + timing slots | `email_extracted_slots`, `forward_calendar_events`, plus `competitive_signals` writeback | Step 5 (Tier 2.1) | `EmailFactsAdapter.getSlotsForThread` / `.getUpcomingForwardCalendar` | safe — slots surfaced via `GET /api/email-facts/threads/:threadId`; forward-calendar fan-out (`runForwardCalendarFanoutAllOrgs`) creates `tasks` rows assigned to the account rep, idempotent via `forwardedFrom='fwcal:<eventId>'`, scheduled daily at 7:30am Central |
| Promise register | `email_promises` | Step 6 (Tier 2.2) | `EmailFactsAdapter.getPromisesForRep` / `.getPromisesForAccount` | safe — surfaced via `GET /api/email-facts/accounts/:companyId` and `GET /api/email-facts/reps/:repUserId/coaching`; overdue promises swept daily into rep tasks (`forwardedFrom='promise:<id>'`) |
| Question register | `email_questions` | Step 7 (Tier 2.3) | `EmailFactsAdapter.getQuestionsForAccount` / `.getUnansweredQuestionsForRep` | safe — `time_to_answer_sec` computed via `getProviderSentAtForMessages` storage helper at reconcile time; surfaced via `GET /api/email-facts/accounts/:companyId` and `GET /api/email-facts/reps/:repUserId/coaching`; stale (>48h unanswered) questions swept daily into account-rep tasks (`forwardedFrom='question:<id>'`) |
| Outbound quality scores | `email_outbound_quality_scores` | Step 8 (Tier 2.4) | `EmailFactsAdapter.getQualityScoresForRep` / `.getQualityScoresForAccount` | experimental (diagnostic only — never blocks sends); rolled up via `GET /api/email-facts/reps/:repUserId/coaching` and `GET /api/email-facts/accounts/:companyId` |
| Sentiment | `contact_sentiment_tracking` (existing) — populated from email | Step 9 (Tier 2.5) | `EmailFactsAdapter.getSentimentForContact` / `.getSentimentTrendForAccount` | safe — idempotent on `(contact_id, msg.id)` via the last 100 ids tracked in `signals.processedMessageIds`; per-account snapshot returned by `GET /api/email-facts/accounts/:companyId` |

A **per-table ADR / design note** is committed alongside each table under `docs/adr/email-intel/`.

## Step log

Each step writes a short note here when it finishes so the next session knows where to pick up.

* **Step 1 — Architecture doc + grounding.** Written. Subsequent steps fill in the Facts table.
* **Step 2 — Tier 1.1 bounce / DSN / OOO classifier.** Implemented. New table `email_bounce_events`. Classifier `server/services/emailFacts/bounceClassifier.ts` runs from the scheduler and from `processEmailMessage`. NBA generators (`generateNbasFromEmailSignals`, `generateAccountEmailNbas`) now consult `EmailFactsAdapter.isContactSuppressed` and skip suppressed contacts. Manual rep sends fall through with a soft-warning flag exposed through `EmailFactsAdapter.getBounceStatusForContact`. Diagnostic counts available via `EmailFactsAdapter.getBounceDailyCounts(orgId)`. Tests in `server/__tests__/emailBounceClassifier.test.ts`.
* **Step 3 — Tier 1.2 participants + stakeholder graph.** Implemented. New table `email_participants` populated from delta + backfill paths and from `processEmailMessage`. Backfill helper `backfillEmailParticipants` re-derives rows from existing `email_messages`. Stakeholder graph helpers in `server/services/emailFacts/stakeholderGraph.ts` classify active / silent / churned per account. Adapter accessors land. Tests in `server/__tests__/emailParticipants.test.ts`.
* **Step 4 — Tier 1.3 attachment router with rate-con parsing.** Implemented. New table `email_attachment_classifications` records the router's verdict per attachment (POD, rate con, BOL, COI, MSA, RFP workbook, generic). Rate-con path reuses `server/services/rateConExtractor.ts` and writes lane / rate / pickup-delivery / FSC into `lane_rate_history` via the existing `recordAwardEvidence` helper extended with a `source: "rate_con_email"` channel so pricing learns from awarded rates. Other classifications register via stub handlers (`registerStubAttachment`) that just log + persist for later expansion. Wired into the scheduler so every message with attachments gets routed once. Tests in `server/__tests__/emailAttachmentRouter.test.ts`.
* **Step 5 — Tier 2.1 slot extractor.** Implemented. New tables `email_extracted_slots` (one row per `(message_id, slot_name)`) and `forward_calendar_events` (RFP / contract-end timing). Extractor `server/services/emailFacts/slotExtractor.ts` runs alongside the intent classifier and harvests `targetRate`, `incumbent`, `incumbentRate`, `competitorName`, `rfpDate`, `contractEndDate`, plus lane attributes (equipment / commodity / weight / temp / transitDays). When `competitorName` lands the service writes a `competitive_signals` row, replacing the previously stubbed wiring. Won/lost outcomes write competitor + rate context into `lane_rate_history` evidence. NBA fan-out from `forward_calendar_events` queues "renewal-risk prep" / "RFP prep" cards. Tests in `server/__tests__/emailSlotExtractor.test.ts`.
* **Step 6 — Tier 2.2 promise register.** Implemented. New table `email_promises` captures rep time-bound commitments from outbound mail (e.g. "by EOD Thursday", "first thing Monday"). Detector `server/services/emailFacts/promiseDetector.ts` reuses the `quoteEmailIngestion` relative-date parsing helpers. Status flips kept / broken / unknown when a subsequent thread reply or load booking lands. Coaching aggregator surfaces per-rep stats. Tests in `server/__tests__/emailPromiseRegister.test.ts`.
* **Step 7 — Tier 2.3 question register.** Implemented. New table `email_questions` captures explicit customer questions on inbound threads (one row per detected question). Detector `server/services/emailFacts/questionDetector.ts` segments the body into sentences, harvests question marks plus interrogative leads, and links to the message + thread. Status flips answered when a rep reply lands on the same thread; time-to-answer is computed from `provider_sent_at`. Coaching aggregator exposes question-answered-rate per rep. Tests in `server/__tests__/emailQuestionRegister.test.ts`.
* **Step 8 — Tier 2.4 outbound quality grader.** Implemented. New table `email_outbound_quality_scores` records clarity / tone / value-add / objection-handling scores per rep-sent email. Grader `server/services/emailFacts/outboundQualityGrader.ts` is heuristic-first (lengths, hedge words, deadlines, value-add cues, objection-handling cues) and is **diagnostic only** — sends never block. Roll-ups by rep + account are exposed through the adapter. Tests in `server/__tests__/emailOutboundQuality.test.ts`.
* **Step 9 — Tier 2.5 sentiment writeback.** Implemented. Per-message sentiment populates `contact_sentiment_tracking` with smoothed per-contact trend (positive / neutral / negative + slope). Service `server/services/emailFacts/sentimentWriteback.ts` computes a deterministic heuristic score (positive / negative lexicon + intensifiers) per inbound message and writes the rolling per-contact aggregate. Adapter exposes per-contact and per-account trend reads. Tests in `server/__tests__/emailSentimentWriteback.test.ts`.
* **Step 10 — Consumer adapter + light wiring.** Implemented. `server/services/emailFacts/emailFactsAdapter.ts` wraps every fact accessor. NBA generators consult bounce suppression. Coaching endpoints expose promise + question + outbound-quality roll-ups. Conversations and account views surface a small "facts indicator" tooltip showing latest bounce / promise / question / sentiment counts. Tests cover the adapter contract for each fact (`server/__tests__/emailFactsAdapter.test.ts`).
* **Step 11 — Quality + guardrails sweep.** Done. All eight detector services + the orchestrator + the consumer adapter are covered in a single hermetic vitest suite (`server/__tests__/emailFactsLayer.test.ts`, currently 64 cases) that mocks the storage layer so it doesn't need a live Postgres. The orchestrator (`runEmailFactExtractors`) is wired into `processEmailMessage` (server/emailIntelligenceService.ts) inside a try/catch so a fact-stage failure can never regress v1 signal extraction. NBA generators (`generateNbasFromEmailSignals`, `generateAccountEmailNbas`) consult `EmailFactsAdapter.isContactSuppressed` and short-circuit for hard-bounced or OOO contacts. Consumer reads beyond NBAs land via `server/routes/emailFacts.ts` (`/api/email-facts/accounts/:companyId`, `/threads/:threadId`, `/contacts/:email/status`, `/reps/:repUserId/coaching`). The forward-calendar fan-out and the promise/question staleness sweep run daily from `initEmailFactsScheduler` (`server/emailFactsScheduler.ts`) at 7:30am Central, with manual run available via `POST /api/admin/email-facts/run-sweeps`. Pre-existing test failures (freight-capture-funnel, lane-system-e2e, the copilotCards guardrails check) are unrelated to v1.5 and were already red on this branch before this work.

### Resume notes for the next session

* `runEmailFactExtractors(msg, signals, ctx)` is the single ingestion entry point. Every stage is best-effort and isolated — adding a new stage is a matter of (a) writing a pure detector + storage helper, (b) wiring it into the orchestrator with `safe(...)`, and (c) adding an adapter accessor.
* Consumers must read facts through `emailFactsAdapter` (singleton). Direct reads of `email_signals.extractedData` for new facts are forbidden by ADR.
* The attachment router accepts a `rateConRouter` callback in its context — wire the existing `server/services/rateConExtractor.ts` here when expanding rate-con automation rather than calling it inline.
* The `forward_calendar_events` → NBA fan-out is currently a stored fact; promoting it into a scheduled NBA card generator is a clean follow-on.

## Per-table ADR notes

Detailed ADR / design notes live alongside this doc:

* `docs/adr/email-intel/0001-bounce-events.md`
* `docs/adr/email-intel/0002-participants.md`
* `docs/adr/email-intel/0003-attachment-classifications.md`
* `docs/adr/email-intel/0004-slots-and-forward-calendar.md`
* `docs/adr/email-intel/0005-promise-register.md`
* `docs/adr/email-intel/0006-question-register.md`
* `docs/adr/email-intel/0007-outbound-quality-scores.md`
* `docs/adr/email-intel/0008-sentiment-writeback.md`

Each ADR captures: why this fact deserves its own table, the unique-key / dedup strategy, downstream consumers, and how outcomes flow back into status updates.
