# Proactive Available Freight Outreach Engine — Phase 1 Audit & Architecture

> **Status:** Planning checkpoint. No code, schema, or UI changes are produced in this phase.
> **Owner:** Freight DNA platform team
> **Phase 2 hand-off:** `proactive-freight-outreach-phase2-backend.md`

---

## 1. Executive Summary

Freight DNA today is excellent at:

- Detecting **recurring lanes** from historical TMS data (the capacity engine).
- Scoring those lanes for procurement priority (`laneScoringService`).
- Ranking carriers for a chosen lane (`carrierRankingService`) using exact-lane history, regional fit, customer history, market NBAs, accepted intel, and HF (high-frequency) floors.
- Sending lane-procurement emails through a single Outlook-Graph send path with a central reply-tracking mailbox (`outlookService` + `email_conversation_threads`).

What it is **not** built for today:

- A first-class concept of a single **available, unbooked load** with a pickup date in the next 2–7 days.
- A reusable per-load **opportunity object** that links one load (or a small grouped lane sweep) to a **ranked, bucketed shortlist** of carriers with audit-grade explanation strings.
- A per-customer **outreach policy** controlling whether automation may run, in which mode, with what guardrails, and using which carriers.
- An **outcome-of-outreach** signal that is distinct from carrier truth (so a "no, slammed this week" reply doesn't overwrite the carrier's standing capability profile).

The Proactive Available Freight Outreach Engine ("PAFOE", working name) introduces those four things as a thin coordination layer on top of the existing scoring, ranking, email, and reply-tracking stacks. The vast majority of behavior is **reuse, not rewrite**.

---

## 2. Audit of Existing Architecture

### 2.1 Available Freight & Open Shipments — current representation

| Source | What it stores | Use today | Relevance to PAFOE |
|---|---|---|---|
| `financial_uploads.rows` (JSONB) | Raw TMS rows: `Origin`, `Destination`, `Month`, `shipDate`/`pickupDate`, `equipmentType`, `carrier` (PAYCODE - NAME), `margin`, `Revenue`, etc. | Source of truth for everything historical: lane detection, margin signal, carrier history, HF detection. | This is the only source that knows about specific shipments. It is **historical / executed**, not "open." |
| `recurring_lanes` | Detected eligible corridor: `origin`, `destination`, `equipmentType`, `avgLoadsPerWeek`, `weeksActive`, `eligibilityConfidence`, `companyId`, `laneScore`, `ownerUserId`, `isManual`, `isEligible`. | Drives Lane Work Queue, My Procurement, lane outreach. | Represents **recurring capacity demand**, not a single open load. |
| `lane_summary_cache` | Lean pre-computed denormalized view of each eligible recurring lane (counts + score). | Read path for LWQ list endpoints. | Not load-level; aggregates only. |
| `geographic_lane_patterns` | Region/corridor groupings (e.g., "Upper Midwest Outbound"). | Used by contact-pattern responsibilities and regional intel. | Useful as a **lane-building bucket** for opportunities that should be grouped by corridor instead of strict O→D. |
| `recurring_lanes` + `lane_summary_cache.snoozedUntil` / `resolvedAt` | Lane-level lifecycle. | Suppress lanes that are already booked / resolved. | Lane-level, not load-level. |

**Gap:** there is no table where a row means "load #12345 from Phoenix → Kent picks up Tuesday and is currently unassigned." Today, that information lives only inside the most recent `financial_uploads` JSON blob (post-execution) and in customer tender emails (unstructured). PAFOE must introduce a load-level concept while staying compatible with the recurring-lane world it sits next to.

### 2.2 Lane Scoring (`server/laneScoringService.ts`)

Rule-based 0–100 score per eligible recurring lane, blended with an AI score (configurable weights):

- `consistencyScore` — weeksActive / lookbackWeeks
- `volumeScore` — avgLoadsPerWeek / benchmark
- `confidenceBonus` — eligibility confidence
- `tierBonus` — customer estimatedFreightSpend
- `noPreferredCarrierBonus` — bonus when no preferred carrier program
- `marginSignal` — actual avg margin % from history (with proxy fallback)
- `volatilityPenalty` — weekly load CV penalty
- `total` — sum, clamped 0–100, then AI-blended

**Decision:** PAFOE will **not** re-score lanes. Lane-level priority is already a solved problem and is out-of-scope per the task. Opportunity-level urgency is computed separately (pickup proximity, customer tier, lane score as an input) and never overwrites `lane_score`.

### 2.3 Carrier Ranking (`server/carrierRankingService.ts`)

Per-lane ranked shortlist with `fitScore` 0–100. Tiers / signals:

- **History tiers (`historyMatch`):** `exact` → `nearby` (≤75 mi) → `state_pair` → `region` → `none`.
- **High-Frequency floors (HIGH_FREQUENCY_CONFIG):** lanes ≥ 2 loads/week qualify; carriers with ≥10 / ≥5 / ≥1 exact-lane runs get floors of 95 / 85 / 72 to guarantee proven carriers always rank above region-only carriers.
- **Accepted-intel boosts (ACCEPTED_INTEL_CONFIG):** capped additive points for accepted lane preference, region preference, equipment capability, capacity_available; penalty for accepted capacity_unavailable; freshness window 21 days.
- **Other inputs:** customer history loads, market NBA boost (+8), HQ proximity bonus, equipment match, region match, prior outcome boost, do-not-use suppression.
- **Output extras:** `fitReason` (human string), `carrierFitExplanation` (structured), `cautionFlags`, `suppressionReasons`, `debugScores` (when ?debug=true).

**Decision:** PAFOE **reuses** `carrierRankingService` as-is. Three new behaviors are layered as a thin **post-rank filter / re-bucket** step (NOT new weights inside the scorer):

1. **Recent-contact suppression** — if the carrier has any outbound on this lane within `outreachDedupWindowHours` (already 48h in HF config) OR has hit `CARRIER_DAILY_BUDGET_CONFIG.dailyCap` across all lanes today, mark `excluded` with reason; do not change `fitScore`.
2. **Customer restrictions** — if the customer's outreach policy is `approved_carrier_only` and the carrier is not on the customer's approved list, exclude.
3. **Responsiveness** — derived metric (carrier reply rate over last N opportunities) added as a **bucket modifier**, not a score modifier. Used to break ties and to size the "exploratory" bucket.

The rationale for keeping these as filters/buckets is that they are **carrier-relationship truth**, not lane-fit truth. Today's `fitScore` is the answer to "who *can* haul this best;" filters answer "who *should we ask right now*."

**Buckets** (output-only; not stored on the carrier):

- **proven** — `historyMatch in (exact, nearby)` AND ≥1 successful prior outcome OR HF floor applied. Always shown first.
- **strong-fit-underused** — `regionMatch && equipmentMatch`, no recent contact, no negative caution flags. Where most growth comes from.
- **exploratory** — anything else that survives suppression. Capped at a small N to keep emails honest.

### 2.4 Outreach / Email Stack

| Component | Role |
|---|---|
| `server/outlookService.ts` | Single Microsoft Graph send path (two-step create → send to capture `messageId` + `conversationId`). Honors live-mode gate. Sets `Reply-To` to `OUTLOOK_REPLY_EMAIL` so all replies funnel to one monitored mailbox regardless of sender. |
| `server/emailService.ts` | Resend / SMTP fallback used for transactional brokerage email (rep reports, password resets, feedback). Not used for carrier outreach. |
| `server/laneOutreachEmailBuilder.ts` | Pure builders / fallback templates — `buildFallbackEmail`, lane formatters, equipment normalization. Already supports `lane_building` and `immediate_plus_lane` modes. |
| `email_messages`, `email_signals`, `email_conversation_threads` | Reply ingestion, thread state, per-message AI-extracted signals (capacity_available, lane_preference, etc.). |
| `carrier_outreach_logs` | One row per outbound to a carrier on a lane: `threadId`, `deliveryStatus`. |
| `lane_carrier_interest` | Per-(lane, carrier) latest interest status: `available_now`, `available_next_week`, `future_interest`, `not_fit`, `needs_follow_up`. |
| `CARRIER_DAILY_BUDGET_CONFIG` (`storage.ts`) | Cross-lane daily cap (5/day) and min-gap (4h) per carrier. |

**Decision:** PAFOE **reuses** `outlookService.sendOutlookEmail`, `OUTLOOK_REPLY_EMAIL` reply funneling, the existing email-thread / signal pipeline, and the existing carrier daily budget gate. Carrier outreach for an opportunity records a `carrier_outreach_logs` row exactly like today's lane outreach does.

### 2.5 Existing Opportunity-like Objects

| Object | Purpose | PAFOE relationship |
|---|---|---|
| `crm_opportunities` | Account-level sales pipeline (stage, amount, probability, outcome). | **Do not reuse.** Different grain (account, not load), different lifecycle (weeks/months, not 2–7 days). Out-of-scope per task. |
| `nba_cards` | Next-Best-Action cards on the AM/NAM dashboard with `rule_type`, `urgency_score`, `linked_lane_id`, `suggested_action`. | **Adjacent, not reused.** PAFOE may emit an NBA card *as a UI surface* for a generated opportunity in Phase 3 (one-line: "3 carriers ready for tomorrow's PHX→KENT load"), but the source-of-truth row is the new `freight_opportunity`, not an NBA card. NBA behavior is unchanged. |

### 2.6 Customer / Company Eligibility Today

`companies` already has a useful but informal mix: `operatingHours`, `sharedReps`, `accountQuirks`, `processNotes`, `spotProcess`, `tenderStyle`, `dlEmail`, `estimatedFreightSpend`. None of these gate automation; they are all advisory text or sales metadata.

**Gap:** no machine-readable opt-in flag, mode, lead-time window, max-carriers cap, approved-carrier list, or do-not-automate flag. Without those, an automated outreach engine cannot run safely on a per-customer basis.

### 2.7 Reporting / Dashboard Pattern

`client/src/pages/dashboard.tsx` composes role-scoped portlets via the `useDashboardLayout` hook (persisted ordering/visibility per user). Existing carrier/lane portlets:

- `NextBestActionsPortlet`, `NbaDashboardPanel` — NBA cards.
- `CoverageGapsPortlet`, `AwardHealthPortlet` — lane-level health.
- `IntelSnapshotPortlet`, `SonarMarketPulsePortlet` — market intel.
- Lane Work Queue / My Procurement pages own their own layouts.

**Decision:** PAFOE **extends the existing portlet pattern** with one new portlet ("Today's Available Freight" or chosen feature name) in Phase 3 and a Phase-5 ROI portlet. No new dashboard framework is introduced.

---

## 3. Gaps Summary (what PAFOE must add)

1. A **load-level open-freight signal** with a configurable lead-time window (default 2–7 days).
2. A **`freight_opportunity` row** that pins one open load (or a tight grouped lane sweep) at a moment in time, with a frozen ranked carrier shortlist.
3. A **per-customer outreach policy** that gates automation safely.
4. A **response-outcome enum** that lives separately from carrier-truth signals and is built specifically to inform "did this proactive ask convert."
5. A small set of **service-layer guardrails** (duplicate suppression, cap, opt-out, do-not-automate, approved-carrier-only) used as a single gate.
6. **One new portlet** for visibility and one for ROI.

---

## 4. Proposed Data Model (no migrations in this phase)

> All new tables are `orgId`-scoped. Existing carrier / company / lane / user FKs are reused.

### 4.1 `freight_opportunities`

One row per generated opportunity. An opportunity is either a single open load OR a small lane-building grouping for the same customer / corridor / equipment / pickup window.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `orgId` | uuid fk → `organizations.id` | |
| `companyId` | uuid fk → `companies.id` | The shipper. Required. |
| `mode` | text enum: `exact_load` \| `lane_building` | Driven by the customer's outreach policy. |
| `recurringLaneId` | uuid fk → `recurring_lanes.id` nullable | Set when the opportunity rolls up to a known recurring lane. |
| `geographicLanePatternId` | uuid fk → `geographic_lane_patterns.id` nullable | Set for `lane_building` opportunities that group by corridor. |
| `origin`, `originState`, `destination`, `destinationState` | text | Snapshot at generation time. |
| `equipmentType` | text nullable | Normalized via existing helper. |
| `pickupWindowStart`, `pickupWindowEnd` | date | The 2–7 day window the load falls in. |
| `loadCount` | integer | 1 for exact-load; N for lane-building. |
| `sourceRef` | jsonb | `{ kind: 'tms_row' \| 'tender_email' \| 'manual', uploadId?, rowKey?, emailMessageId?, repNote? }` for traceability. |
| `urgencyScore` | integer 0–100 | Computed (pickup proximity + customer tier + lane score input). Indexed. |
| `confidenceFlag` | text enum: `low` \| `normal` | Derived at generation from share of `proven` shortlist rows, median `fitScore`, and shipper's historical loads on the lane. Drives the Phase-3 low-confidence banner; never suppresses generation. |
| `status` | text enum | `new` \| `ready_to_send` \| `sent` \| `partially_covered` \| `covered` \| `expired` \| `cancelled`. |
| `policySnapshot` | jsonb | Frozen copy of the customer outreach policy at generation time (so audit is reproducible). |
| `generatedAt` | timestamp | |
| `expiresAt` | timestamp | `pickupWindowEnd + 24h` typical. |
| `createdById` | uuid nullable | null for engine-generated, user id for manual. |
| `notes` | text nullable | |

Indexes: `(orgId, status, urgencyScore desc)`, `(companyId, pickupWindowStart)`, `(recurringLaneId)`.

### 4.2 `freight_opportunity_carriers`

One row per (opportunity, carrier). Frozen shortlist at the moment outreach is queued.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `opportunityId` | uuid fk → `freight_opportunities.id` on delete cascade | |
| `carrierId` | uuid fk → `carriers.id` | |
| `rank` | integer | 1-based. |
| `bucket` | text enum nullable | `proven` \| `strong_fit_underused` \| `exploratory` \| `rep_added`. Null when `excludedReason` is set. |
| `fitScore` | integer | Snapshot of `fitScore` at generation. |
| `historyMatch` | text | `exact` / `nearby` / `state_pair` / `region` / `none`. |
| `explanation` | text | Human-readable one-liner. |
| `explanationStructured` | jsonb | Snapshot of `CarrierFitExplanation`. |
| `responsivenessSnapshot` | jsonb nullable | `{ replyRate, repliesLast30d, lastReplyAt }` at generation. |
| `excludedReason` | text nullable | Set by guardrails: `recent_contact`, `daily_cap`, `not_approved`, `do_not_use`, `opted_out`, `rep_override`. Reserved for future use: `customer_carrier_blocked`. When set, `bucket` is `null` and the row is informational only. |
| `outreachLogId` | uuid fk → `carrier_outreach_logs.id` nullable | Set after send. |
| `lastResponseId` | uuid fk → `freight_opportunity_responses.id` nullable | Latest response for this carrier on this opportunity. |
| `createdAt` | timestamp | |

Indexes: `(opportunityId, rank)`, `(carrierId, createdAt desc)`.

### 4.3 `company_outreach_policies`

Sibling table (kept off `companies` to avoid widening an already-wide row and to keep Phase-2 migration small).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `companyId` | uuid unique fk → `companies.id` on delete cascade | |
| `enabled` | boolean default false | Master opt-in. |
| `mode` | text enum | `exact_load` \| `lane_building` \| `both`. |
| `approvalRequired` | boolean default true | If true, opportunities sit in `ready_to_send` until a rep clicks Approve. |
| `maxCarriersPerOpportunity` | integer default 12 | |
| `leadTimeMinDays` | integer default 2 | Lower bound of pickup window. |
| `leadTimeMaxDays` | integer default 7 | Upper bound. |
| `approvedCarrierOnly` | boolean default false | If true, restrict to `approvedCarrierIds`. |
| `approvedCarrierIds` | uuid[] | Empty array allowed when `approvedCarrierOnly = false`. |
| `doNotAutomate` | boolean default false | Hard block — even rep-initiated PAFOE outreach is blocked; manual lane outreach still works. |
| `specialNotes` | text | Free text shown in the opportunity drawer. |
| `updatedAt`, `updatedById` | | |

Indexes: `(enabled)`, `(companyId)`.

### 4.4 `freight_opportunity_responses`

Outcome-of-outreach. Lives separately from `email_signals` to avoid overwriting carrier-truth.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `opportunityCarrierId` | uuid fk → `freight_opportunity_carriers.id` on delete cascade | |
| `outcome` | text enum | `accepted` \| `quoted` \| `interested_future` \| `passed_busy` \| `passed_rate` \| `passed_lane_fit` \| `passed_other` \| `auto_no_reply`. |
| `quotedRate` | numeric(12,2) nullable | |
| `replySource` | text enum | `email` \| `manual_log` \| `phone_followup`. |
| `emailMessageId` | uuid fk → `email_messages.id` nullable | When derived from a reply. |
| `notes` | text nullable | |
| `recordedById` | uuid nullable | null when auto-derived from a reply. |
| `createdAt` | timestamp | |

The existing `email_signals` ingestion continues to populate carrier-truth signals (lane preferences, equipment, capacity) regardless of whether the inbound is tied to an opportunity. PAFOE response derivation reads `email_signals` and the body sentiment to decide an `outcome`, but it **does not write back to `email_signals` or `lane_carrier_interest`** — those keep their existing semantics.

### 4.5 `freight_opportunity_audit`

Append-only event log per opportunity. (We do not have a generic audit table to reuse; introducing this scoped one is cleaner than retrofitting.)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `opportunityId` | uuid fk on delete cascade | |
| `eventType` | text enum | `generated`, `policy_blocked`, `approved`, `carrier_excluded`, `carrier_included_override`, `outreach_queued`, `outreach_sent`, `response_recorded`, `status_changed`, `expired`, `cancelled`. |
| `actorUserId` | uuid nullable | null = engine. |
| `payload` | jsonb | Free-form per event. |
| `createdAt` | timestamp | |

Index: `(opportunityId, createdAt)`.

### 4.6 Reused entities (no schema changes)

- `carriers`, `carrier_contacts` — recipient identity / contact selection.
- `recurring_lanes`, `lane_summary_cache`, `geographic_lane_patterns` — context, not modified.
- `companies` — read for tier/policy joins; not widened.
- `carrier_outreach_logs`, `email_messages`, `email_signals`, `email_conversation_threads`, `lane_carrier_interest` — outreach + reply pipeline as-is.
- `nba_cards` — optional UI surface only; not the source of truth.

---

## 5. Reuse vs New — Decision Matrix

| Concern | Decision | Notes |
|---|---|---|
| Opportunity object | **New** (`freight_opportunities`) | `crm_opportunities` is account-grain, wrong lifecycle; `nba_cards` is a UI card, not a state machine. |
| Lane grouping for `lane_building` mode | **Reuse** `recurring_lanes` and `geographic_lane_patterns` via FK | No new corridor model. |
| Carrier ranking | **Reuse** `carrierRankingService` unchanged | New behaviors layered as post-rank filters and bucket assignment. |
| Customer eligibility | **New** (`company_outreach_policies` sibling table) | Keeps `companies` slim; explicit opt-in. |
| Email send path | **Reuse** `outlookService.sendOutlookEmail` + `OUTLOOK_REPLY_EMAIL` | No second mailer. |
| Email body composition | **Reuse** builders in `laneOutreachEmailBuilder.ts` + AI drafting; add an `opportunity` mode alongside `lane_building` / `immediate_plus_lane`. |
| Response tracking | **Hybrid** — reuse `email_messages`/`email_signals`/`email_conversation_threads` for ingestion; **new** `freight_opportunity_responses` for opportunity-level outcomes | Avoids overwriting carrier-truth signals. |
| Reporting | **Extend** existing dashboard portlet pattern (`useDashboardLayout`) | Two new portlets; no new dashboard. |
| Audit trail | **New** scoped table (`freight_opportunity_audit`) | No generic audit log exists today to reuse. |
| Throttling / daily caps | **Reuse** `CARRIER_DAILY_BUDGET_CONFIG` + checkCarrierDailyBudget gate | Add opportunity-level dedup window on top. |
| Suppression on do-not-use carriers | **Reuse** existing carrier `do_not_use` status / tags | No new flag. |

---

## 6. Naming Proposal

Three candidate user-facing names, with a recommendation:

1. **Available Freight** — short, neutral, fits next to "Lane Work Queue" and "My Procurement." Risk: very generic.
2. **Daily Freight Sweep** — emphasizes the cadence and the sweep-style outreach. Risk: implies fixed daily run, which Phase 2 may or may not be.
3. **Freight Match** — emphasizes the carrier-matching dimension, pairs naturally with "Match Score" in the UI. Risk: easy to confuse with the load-board "freight matching" jargon.

**Recommendation: "Available Freight"** as the primary user-facing label (sidebar entry, page title), with **"Match Score"** used inside the page for the carrier shortlist. Internal/code identifier remains `freight_opportunity` / `PAFOE`.

---

## 7. Guardrails Design

A single service-layer gate, called by every action that would queue or send outreach:

1. **Customer opt-in** — `company_outreach_policies.enabled = true` AND `doNotAutomate = false`.
2. **Mode match** — opportunity `mode` allowed by policy `mode`.
3. **Approved-carrier-only** — when set, drop carriers not in `approvedCarrierIds` (records `excludedReason = 'not_approved'`).
4. **Recent-contact suppression** — drop any carrier with a `carrier_outreach_logs` row to this carrier within `outreachDedupWindowHours` (HF config, currently 48h) for any opportunity OR lane.
5. **Daily cap** — reuse `CARRIER_DAILY_BUDGET_CONFIG.dailyCap` (5/day) and `minGapHours` (4h). Existing `checkCarrierDailyBudget`-style helper is the gate.
6. **Carrier opt-out / do-not-use** — drop carriers whose status is `do_not_use` or whose tags contain `do_not_use` / `no_use`.
7. **Per-opportunity carrier cap** — clamp final list to `policy.maxCarriersPerOpportunity`.
8. **Approval workflow** — when `policy.approvalRequired = true`, the engine stops at status `ready_to_send` and a rep must click Approve before any send.

Every gate decision writes a `freight_opportunity_audit` row with `eventType = 'carrier_excluded'` or `'policy_blocked'` and the reason. All exclusions are visible in the opportunity drawer for trust.

---

## 8. Reporting Integration

**Phase 3 (UI):** one new dashboard portlet — **"Available Freight Today"** — listing the rep's current `new` / `ready_to_send` / `sent` opportunities with urgency, # carriers contacted, and # responses.

**Phase 5 (ROI):** one new portlet — **"Proactive Outreach Performance"** — with these metrics:

- Opportunities generated (by day / week)
- Opportunities reaching `covered` status
- Average time-to-cover (generated → first accepted response)
- Response rate by bucket (proven / strong-fit-underused / exploratory)
- Quote conversion rate
- Reply rate per carrier (feeds the responsiveness signal in 2.3)
- Suppression breakdown (which guardrail blocked how many carriers — to detect over-tight policies)
- Customers with the highest cover rate vs. customers with `enabled = true` but 0 covers (configuration tuning surface)

These extend the existing `useDashboardLayout` registry and reuse the portlet error boundary; no new dashboard framework.

---

## 9. The 10 Validation Scenarios

These are the canonical scenarios from the original brief. Each is answered against the proposed model so Phase 2 has a concrete service-layer target. The same numbering and wording is preserved.

**S1. Eligible customer, common lane, strong repeat carriers available.**
→ Engine reads `company_outreach_policies.enabled = true` for the shipper, scans unbooked freight in the configured 2–7 day window, and emits a `freight_opportunity (mode=exact_load|lane_building per policy, status=new)`. The carrier-recommendation adapter calls `carrierRankingService` unchanged — HF floors and `historyMatch=exact` push proven carriers to the top. The §7 guardrails clamp to `policy.maxCarriersPerOpportunity` and assign buckets: most rows land in `proven`, a few in `strong_fit_underused`, a small `exploratory` tail. With `policy.approvalRequired = true` (default) status flips to `ready_to_send` and waits for the rep. `freight_opportunity_audit` records `generated`. ✅

**S2. Eligible customer, weak lane history, recommendations based on similar-lane logic.**
→ The opportunity is generated with the same flow, but `freight_opportunity_carriers.historyMatch` for most rows is `nearby` / `state_pair` / `region` rather than `exact`, and `fitScore` is dominated by region/equipment match plus accepted-intel boosts. The opportunity is flagged **low-confidence** (see S10): `policySnapshot` plus a derived `confidenceFlag` field on `freight_opportunities` (computed from share of `proven` rows < threshold AND median `fitScore` < threshold) is exposed to the UI so Phase 3 can render the low-confidence banner. The `exploratory` bucket is intentionally a bit larger here so the rep sees coverage breadth. ✅

**S3. Ineligible customer, workflow blocked.**
→ The opportunity-generation service checks `company_outreach_policies.enabled` and `doNotAutomate` first. If `enabled = false` OR `doNotAutomate = true`, **no** `freight_opportunity` row is created; the audit table records a single `policy_blocked` event scoped to the candidate (with payload describing which gate fired). Existing lane-work-queue and manual-procurement behavior for that customer is untouched. ✅

**S4. Customer with manual approval requirement.**
→ `policy.approvalRequired = true` is the default. Engine generates the opportunity and ranked shortlist as normal, then halts at status `ready_to_send`. No `outreach_queued` or `outreach_sent` audit events fire until a rep clicks Approve in Phase 3 UI. The Approve action writes an `approved` audit event with `actorUserId`, transitions status to `sent`, and only then is `outlookService.sendOutlookEmail` invoked per carrier. Customers with `approvalRequired = false` skip directly to `sent`. ✅

**S5. Carrier recently contacted, suppressed from duplicate outreach.**
→ The recent-contact guardrail (§7 #4) queries `carrier_outreach_logs` for any outbound to that carrier within `outreachDedupWindowHours` (HF config, currently 48h) — across **any** lane or opportunity. The `CARRIER_DAILY_BUDGET_CONFIG.dailyCap` (5/day, `minGapHours` 4h) is checked alongside it. Any hit produces a `freight_opportunity_carriers` row with `bucket = null` and `excludedReason = 'recent_contact'` or `'daily_cap'`. The carrier is visible in the opportunity drawer as informational (so the rep knows they were considered) but is not sent. A `carrier_excluded` audit event records the reason. ✅

**S6. Carrier responds with future interest but not current capacity.**
→ Inbound reply is ingested by the existing pipeline: `email_messages` row written, `email_signals` extracted, `email_conversation_threads` updated. The PAFOE response classifier matches the inbound to the opportunity via `conversationId` (set when `outlookService` first sent the outbound) and writes a `freight_opportunity_responses` row with `outcome = 'interested_future'`. The carrier's `lane_carrier_interest` keeps its existing semantics (a `future_interest` row is fine, since that table already supports that value) — PAFOE does not overwrite carrier-truth signals; it appends. Reporting in §8 surfaces "future-interest responses that later convert" by joining `freight_opportunity_responses` to subsequent bookings on the same lane/carrier within a configurable window. ✅

**S7. Carrier marked not qualified for that customer/lane.**
→ Two paths feed this:
  - **Customer-level:** `policy.approvedCarrierOnly = true` + the carrier missing from `approvedCarrierIds` → guardrail excludes with `excludedReason = 'not_approved'`.
  - **Carrier-level:** existing `do_not_use` carrier status / tag → guardrail excludes with `excludedReason = 'do_not_use'`.
A future per-(customer, carrier) blocklist (out of scope for Phase 1) would add `excludedReason = 'customer_carrier_blocked'`. In every case the row is recorded with the reason; nothing is silently dropped. A `carrier_excluded` audit event is written. ✅

**S8. Rep overrides ranking and manually sends to a different carrier set.**
→ The Phase 3 UI lets the rep include/exclude/pin/reorder inside `freight_opportunity_carriers`. Each toggle writes a `carrier_excluded` (or its inverse, `carrier_included_override`) audit event with `actorUserId` and the reason "rep_override". The rep can also add a carrier that was not in the auto-shortlist; that creates a new `freight_opportunity_carriers` row with `rank = null`, `bucket = 'rep_added'` (additional bucket value reserved for this case), and `excludedReason = null`. The `policySnapshot` + audit chain makes the override fully reproducible: anyone reading the opportunity later sees what the engine recommended AND what the rep changed. ✅

**S9. Opportunity converts to booked shipment and history updates correctly.**
→ When a carrier accepts, the rep marks `freight_opportunity_responses.outcome = 'accepted'` (or the email classifier auto-detects it). On booking, the opportunity transitions: if `loadCount = 1` → status `covered`; if `loadCount > 1` and at least one but not all loads are booked → `partially_covered`. A `status_changed` audit event is written. Booking itself flows through existing TMS/financial-upload processes unchanged — the next ingestion cycle picks up the booked shipment, which feeds `recurring_lanes`, carrier history, and `lane_carrier_interest` exactly as today. PAFOE does **not** double-write carrier history; it links to it via the `outreachLogId` / `lastResponseId` on `freight_opportunity_carriers` so reporting can attribute the booking to the proactive outreach. ✅

**S10. Low-confidence opportunity with thin historical data is clearly flagged.**
→ The `freight_opportunities` row carries a derived `confidenceFlag` (low / normal) computed at generation from: (a) the share of shortlist rows with `historyMatch in (exact, nearby)`, (b) the median `fitScore`, and (c) whether the shipper has < N historical loads on this lane. When `low`, the audit row's `generated` payload includes `{ reason: 'thin_history', signals: {...} }`, the Phase 3 UI shows a low-confidence banner and biases the rep toward review, and reporting can segment performance by confidence. The flag does **not** suppress generation — it informs the rep. ✅

**Design changes flagged from the walkthrough (folded back into §4):**

- S2 added a derived `confidenceFlag` field on `freight_opportunities` (low / normal) so the Phase-3 banner has a structured input.
- S7 confirmed `freight_opportunity_carriers.excludedReason` enum must include `not_approved` and `do_not_use`, and reserved `customer_carrier_blocked` for a future per-pair blocklist.
- S8 added a `bucket = 'rep_added'` value and a `carrier_included_override` audit event so manual additions are first-class and auditable.
- S9 confirmed `freight_opportunity_carriers.outreachLogId` + `lastResponseId` are the join keys reporting uses to attribute bookings to proactive outreach without double-writing carrier history.
- S10 keeps `policySnapshot` on the opportunity row so the confidence calculation is reproducible even if policy thresholds change.

No other design changes are needed before Phase 2.

---

## 10. Phase 2 Hand-off Checklist

Phase 2 (`proactive-freight-outreach-phase2-backend.md`) inherits from this audit:

- The five new tables in §4, Zod insert/select schemas, and `IStorage` extensions.
- The opportunity generation service that scans the configured 2–7 day lead window from current unbooked freight signals.
- The carrier-recommendation adapter that calls existing ranking and applies the §7 guardrails as a single gate.
- Read-only API routes for list / detail / policy GET / policy PATCH.
- A scripted dry-run that exercises the 10 scenarios in §9 at the service layer.

No carrier ranking weights, no lane scoring weights, no `crm_opportunities`, `nba_cards`, or `lane_summary_cache` behavior are touched — consistent with this task's out-of-scope list.
