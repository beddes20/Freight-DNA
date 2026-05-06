# FreightDNA Platform Health Audit — April 2026

**Audit owner:** Task #777
**Audit window:** April 2026 (production deployment at `freight-dna.com`)
**Scope:** Every user-visible surface in FreightDNA, classified for whether it is genuinely working, partially working, silently mocked, broken, or unused. Includes a Stats Validity appendix and a prioritized remediation roadmap.
**Out of scope:** Any code change, schema change, or data backfill. This document is read-only.

---

## How to read this report

For the non-technical reader, every surface gets a one-line headline in plain English ("what the user sees vs. what's really happening"). Engineering details (file paths, models, line numbers) are listed below the headline as evidence.

### Status grades

| Grade | Meaning |
|---|---|
| **Working** | Functions as advertised. Real data, real services, no silent fallback. |
| **Partial** | Functions, but with caveats — some part is heuristic, hardcoded, or not what the label implies. |
| **Mocked** | Returns deterministic stub data even though the UI suggests it's live. The user cannot tell. |
| **Broken** | Returns errors, empty data, or wrong data in production today. |
| **Unused** | Reachable in code but not actually delivering value to anyone (no traffic, no rollout). |

### Severity & effort

- **P0** — User-blocking or trust-destroying. Numbers are wrong, an action does nothing, or a labeled "AI" feature has no AI behind it.
- **P1** — Trust-eroding. Works most of the time but has a real failure mode the user cannot diagnose.
- **P2** — Cosmetic or low-impact. Confusing, but the right answer is reachable.
- **Effort:** S (≤1 day), M (a few days), L (a week+).

---

## 1. Executive summary

FreightDNA's **revenue-facing surfaces are real** (CRM, conversations, financials, RFP, lane work queue, prospects, customer quotes). Email ingestion, MS Graph delta-sync, and conversation history are doing genuine work in production.

The **AI surfaces are mixed**. The conversational copilots (DNA Copilot, ValueIQ chat, Landing Bot, Email Intelligence, Call Prep, Post-Call Capture, AI Intelligence cards, voice/audio) **do invoke real LLMs in production today** with real tool-calling. But several other "AI" labels are either heuristic, template, or stub:

- **Next Best Action (NBA)** is rule-based, not AI. The UI presents it as an intelligence feature but the engine is `if (no_touchpoint_for_14_days) fire card`.
- **The entire Agentic Brokerage Program** (six workflow agents, Pricing/Order/Coverage/Risk/Execution/Billing, plus eleven external adapters) is **dry-run only**. Every adapter returns hardcoded mock data via a deterministic seed hash. No external system (DAT, Truckstop, Highway, ValueTMS, EDI, Twilio, Customer Portal, Payment Portal, even MS Graph for outbound mail) actually executes when an agent "acts." The HITL approval flow exists but the approved action goes to a stub.
- **ValueIQ "Today" briefing** is a SQL aggregation, not generative. The chat on top of it is real LLM.

The **dashboards and KPIs have structural validity issues**:

- The dashboard's "current month" is derived from the **latest financial upload**, not the calendar. Today (April 27, 2026) the dashboard may be showing March data labeled as "this month" if the April upload hasn't landed.
- **Rep attribution** for margin and load counts falls back to a fuzzy name match if the rep doesn't have `financialRepId` set. Three users in production have `financialRepId: null` (admins) and several reps go through the fuzzy fallback silently.
- **SLA thresholds are hardcoded** — stale account = 21 days, urgent RFP = 14 days, churn = 20% drop, touchpoint streak goal = 5/day. None of these are configurable per org.
- **Pipeline margin in Opportunity Leaderboard is a placeholder** — it's `(RFP volume − YTD loads) × avg margin per load`, not actual quoted pipeline.

**External systems status (live evidence pulled from deployment logs, April 27, 2026):**

| System | Status | Evidence |
|---|---|---|
| FreightWaves SONAR | **Circuit breaker OPEN** | `7:16:30 PM [sonar] National market data unavailable — caching null snapshot` |
| MS Graph delta-sync | Working | 30+ mailboxes syncing, 0–108 messages each, occasional `ErrorInvalidUser` |
| Webex | **Configured, not authorized** | `/api/webex/status → {"configured":true,"authorized":false}` |
| OpenAI / Anthropic | Working | Tool-call traffic on /api/chatbot, /api/ai-intelligence, /api/post-call-capture |
| Outlook (mail) | Working | `/api/outlook/status → {"enabled":true}` |
| Clerk auth | Working | Live sessions for valuetruck.com users |
| All agentic adapters | **Dry-run** | `server/agentic/adapters.ts:104,126,151,159,167,175,183` — every "live" branch returns `credentialsMissing: true` |

Bottom line: nothing here is dangerously broken, but several features are **dressed up** as more capable than they are. The remediation roadmap at the end of this document lists the items in priority order.

---

## 2. Surface inventory & status

### 2.1 Sidebar (top-level navigation)

| Route | What the user thinks | What it actually is | Grade | Severity / Effort | Evidence |
|---|---|---|---|---|---|
| `/` Dashboard | "My personal command center" | Real — KPIs from latest financial upload + touchpoints + tasks. **But** "current month" is derived from upload date, not calendar. | Partial | P1 / M | `server/routes/dashboard.ts:109` (`curMonthKey = max(monthKey)`) |
| `/one-on-one` 1:1's | Live coaching session log | Real CRUD on `oneOnOneSessions`, `oneOnOneTopics`. | Working | — | `server/routes/coaching.ts` |
| `/tasks` Tasks | Real task list | Real CRUD. | Working | — | `server/routes/tasks.ts` |
| `/goals` Goals | Real goal tracking | Real, but `margin_pct` and `loads_booked` use fuzzy rep-match fallback when `financialRepId` is null. | Partial | P1 / S | `server/financialHelpers.ts:178`, `client/src/lib/rep-utils.ts:1` |
| `/report/me` My Scorecard | Personal performance | Real. Window is **calendar-derived** (system clock), unlike dashboard. | Partial | P1 / S | `server/storage.ts:3087` — date asynchrony with dashboard |
| `/team-performance` | Manager view | Real — same fuzzy match issue as Goals. | Partial | P1 / S | `server/routes/dashboard.ts:753` |
| `/ai-hub` AI Hub | Unified AI workspace | Tabbed wrapper over 7 AI surfaces (see §2.2). | Partial | — | `client/src/pages/ai-hub.tsx` |
| `/prospects` Launchpad | CRM pipeline | Real. | Working | — | `server/routes/prospects.ts` |
| `/customers` Customers | Account list | Real. | Working | — | `server/routes/companies.ts` |
| `/customer-quotes` | Quote pipeline | Real. 372 stale follow-ups currently queued (per live `/api/customer-quotes/stale-followups/count`). | Working | — | `server/routes/customerQuotes.ts` |
| `/freight-capture` | Funnel of inbound spot quotes | Real. | Working | — | `server/services/spotQuoteIntake.ts` |
| `/top-opportunities` | High-margin growth list | Real read; **"Potential Margin" column is a placeholder calc** (RFP gap × avg margin). | Partial | P1 / M | `server/routes/dashboard.ts:1130` |
| `/rfp-awards`, `/rfp-calendar` | RFP tracking | Real. | Working | — | `server/storage.ts` rfp helpers |
| `/research-tasks` Lane Intelligence | Lane research | Real. | Working | — | `server/routes/intel.ts` |
| `/my-procurement` | Coordinator carrier work queue | Real. | Working | — | `server/routes/myProcurement.ts` |
| `/lanes/work-queue` | Recurring lane work | Real. | Working | — | `server/routes/laneSwitchboard.ts` |
| `/lane-inbox` | Lane inbound queue | Real. | Working | — | `server/routes/laneInbox.ts` |
| `/my-pods` | POD intake | Real. | Working | — | `server/routes/podIntake.ts` |
| `/available-freight` | Available loads cockpit | Real, including SLA approval timer (currently firing in prod — multiple "Approval overdue (2.0h)" notifications observed). | Working | — | `server/routes/freightOpportunityCockpit.ts` |
| `/carrier-hub` | Carrier rolodex | Real. | Working | — | `server/routes/carrierHub.ts` |
| `/conversations` | Unified inbox | Real (24 conversations for sample user, message bodies returning 200 in 200–250 ms). | Working | — | `/api/internal/conversations/*` traffic in logs |
| `/phone-usage` | Webex phone usage | **Working only when Webex is authorized.** Currently `authorized:false` for the org. | Broken | P0 / S | `/api/webex/status → authorized:false` |
| `/calls` Call Performance | Call quality scorecards | Same — depends on Webex auth. | Broken | P0 / S | Same as above |
| `/lm-checkin-history` | LM check-in log | Real. | Working | — | `server/routes/coaching.ts` |
| `/carrier-intelligence/scorecard` | Carrier scorecard | Real. | Working | — | `server/routes/carrierIntelligenceScoring.ts` |

### 2.2 AI Hub tabs

The AI Hub (`/ai-hub`) consolidates seven previously separate AI surfaces into a single tabbed page. Each tab is also reachable at its old URL.

| Tab | Old URL | Backing | Grade |
|---|---|---|---|
| Today's Priorities | `/daily-priorities` | NBA cards + tasks. NBA is rule-based. | Partial |
| ValueIQ | `/valueiq` | "Today" briefing = SQL; chat = real LLM. | Partial |
| Email Intelligence | `/email-intelligence` | Real `gpt-4o-mini` extraction on every inbound email via `emailIntelligenceScheduler`. | Working |
| Contact Suggestions | `/contact-suggestions` | Real heuristics over signature parsing. | Working |
| AI Center | `/ai` | Sub-tabs below. | Partial |
| Engagement | `/admin/ai-engagement` | Real engagement telemetry. | Working |
| Copilot Analytics | `/admin/copilot-analytics` | Real analytics on copilot traffic. | Working |

#### AI Center sub-tabs (`/ai/*`)

| Sub-tab | What it claims | What it is | Grade |
|---|---|---|---|
| Agents (Fleet) | Workflow agent dashboard | Lists six agents (Pricing, Order, Coverage, Risk, Execution, Billing). All run dry-run only. | **Mocked** |
| Approvals | HITL action queue | Real queue, but every staged action's payload is dry-run. Approving "Send mail" calls `adapters.sendMail` which returns `{messageId: "dry-…"}` — no email is sent. | **Mocked** |
| Pods | Agent grouping | Working as a UI grouping. | Working |
| Adapters (admin) | Adapter health & toggle | Real toggle UI; flipping to "live" results in `credentialsMissing` error because no live implementations exist. | Partial |
| Admin (Personas/Plays) | Persona editor | Real CRUD on persona templates. | Working |

### 2.3 Admin module (`/admin/*`)

| Route | Grade | Notes |
|---|---|---|
| `/admin/users` | Working | Real user CRUD + Clerk impersonation. Three users have `financialRepId: null` which silently disables their financial attribution. |
| `/admin/carriers` | Working | Real. |
| `/admin/integrations-health` | Working | Real probe results. SONAR shows circuit-breaker open right now. |
| `/admin/endpoint-perf` | Working | Real. |
| `/admin/monitored-mailboxes` | Working | Real. Some webhook subs are orphaned (see §6). |
| `/admin/pod-intake` | Working | Real. |
| `/admin/carrier-intelligence` | Working | Real scoring config. |
| `/admin/carrier-intelligence-scoring` | Working | Real. |
| `/admin/sidebar-tooltips` | Working | Real. |
| `/admin/ai-engagement` | Working | Real telemetry. |
| `/admin/copilot-analytics` | Working | Real telemetry. |
| `/admin/freight-capture-rep-audit` | Working | Real. |
| `/admin/webex-health` | Partial | Reports `configured:true, authorized:false` — feature itself works, but it's reporting that Webex is not authorized for the org. |
| `/admin/freight-outreach-templates` | Working | Real. |
| `/admin/available-freight-imports` | Working | Real. |

### 2.4 Other client surfaces (not in primary sidebar)

| Page | Backing | Grade | Notes |
|---|---|---|---|
| `/landing` | `/api/marketing-chat` (real `gpt-4o-mini`) | Working | Real bot. |
| `/coordinators-corner` | DB lookup of portal credentials and operating hours | Working | **Note: this is presented as a hub but contains no AI.** |
| `/playbook`, `/playbook-analytics` | Real | Working | — |
| `/proven-tactics` | Real | Working | — |
| `/training` | Real | Working | — |
| `/notifications` | Real | Working | — |
| `/historical-data` | Real over `financial_uploads` | Working | — |
| `/intel` | Real | Working | — |
| `/financials` | Real | Working | — |
| `/carrier-lane-search` | Real | Working | — |
| `/touchpoint-history` | Real | Working | — |
| `/feedback-inbox` | Real | Working | — |
| `/profile`, `/login`, `/reset-password`, `/checkout-success`, `/privacy`, `/terms`, `/not-found` | Real | Working | — |
| `/pto-passoff` | Real | Working | — |
| `/tools` | Real | Working | — |

---

## 3. AI surfaces — deep dive

This section confirms which features genuinely call an LLM in production and which are heuristic/template/stub.

| Surface | Model | Real or stub? | Evidence |
|---|---|---|---|
| **DNA Copilot** (global chat) | `gpt-4o` (reasoning) + `gpt-4o-mini` (fast) | **Real LLM with tool-calling.** Streams via SSE; supports navigation, action cards, tool execution, retrieval. Has 6-iteration tool loop, persona system prompt, per-org agent allowlist. | `server/agent/core.ts:227–437` |
| **ValueIQ — "Today" briefing** | None | **Heuristic.** Pulls SQL aggregates (loads, margin, stale accounts, NBA cards) and seeds a daily card. Cron is `0 6 * * *`, runs from `valueiqTodayScheduler`. | `server/agent/todaySeed.ts`, scheduler init log: `[valueiq-today] Today scheduler initialized — 2 org schedule(s)` |
| **ValueIQ — chat on Today** | Same as DNA Copilot (real LLM) | Real | Shares `runAgentTurn` |
| **AI Intelligence Hub cards** (Account Momentum, Coaching Tips, Sentiment) | `gpt-4o-mini` | Real LLM | `server/services/aiIntelligenceService.ts:167` |
| **Pre-call Planner** | `claude-opus-4-5` | Real LLM. 3 talking points pulled from SONAR market + CRM history. | `server/chatbot.ts:1287`, `server/aiHelpers.ts:264` |
| **Post-call Capture** | `gpt-4o-mini` | Real LLM. Extracts sentiment, follow-ups, play labels as structured JSON. | `server/routes/callIntelligence.ts:272` |
| **Voice / Audio** | `gpt-audio` + `gpt-4o-mini-transcribe` | Real. Streaming audio completion. | `server/replit_integrations/audio/routes.ts:112` |
| **Persona / Plays** | Persona = template; Play outcome classifier = `gpt-4o-mini` | **Hybrid.** Personas are static system-prompt blocks ("The Disruptor," "The Specialist"). Outcome classifier is real. | `server/agent/persona.ts:22`, `server/services/playOutcomeClassifierService.ts:64` |
| **Next Best Action (NBA)** | None | **Rule-based.** Phase 1 engine fires cards from hardcoded triggers (`webex_missed_call`, `no_touchpoint_for_14d`, etc.). The "AI" badge is misleading. | `server/nbaPhase1Engine.ts`, `server/nextBestActionEngine.ts`. Live evidence: a card with `ruleType:"webex_missed_call"` was returned by `/api/nba/daily-workspace` at 7:15:46 PM with confidence "high" and a hardcoded `whyThisNow` template |
| **Coordinators Corner** | None | **Not AI.** Database list of portal credentials and hours. The naming implies an intelligence layer that does not exist. | `client/src/pages/coordinators-corner.tsx` |
| **Landing AI Bot** | `gpt-4o-mini` | Real LLM. Marketing system prompt. | `server/routes.ts:680` (`/api/marketing-chat`) |
| **M365 Mailbox / Shared Inbox AI** | `gpt-4o-mini` | Real LLM. Every inbound email runs through intent extraction (`emailSignals` table) and thread summarization. | `server/emailIntelligenceService.ts:236`, `server/services/conversationThreadSummaryService.ts:104`. Live evidence: `delta-sync` is processing 100+ messages per mailbox per cycle |
| **Conversation history per channel** | Real LLM via streaming chat | Real | `server/replit_integrations/chat/routes.ts:100` |
| **Lane narratives, Executive Brief, Buy-rate Rationale** | `claude-opus-4-5` (lane), `gpt-4o` (briefs), `gpt-4o` (buy-rate) | Real LLM with cache TTL 30–60 min, layered (in-memory + DB). Falls back to `null` silently if API key missing. | `server/aiHelpers.ts:264, 312, 212` |
| **Perplexity market context** | `sonar` model on Perplexity | Real, conditional on `PERPLEXITY_API_KEY`. | `server/aiHelpers.ts:378` |

### Failure modes to call out

- **Silent null-fallback.** Every AI helper returns `null` when its API key is missing (`aiHelpers.ts:149, 184, 219, 273, 320, 381, 496`). Callers display the page without the AI block — the user sees a missing card and has no way to know it should have been there.
- **Rate-positioning chat context cache** (`server/chatbot.ts:30`) has a 30-min TTL but **no cache busting on financial upload**. After a fresh upload, the chat may use stale rate positioning for up to 30 minutes.
- **NBA "confidence" labels are static.** The engine sets confidence by rule, not by model. Showing "high confidence" implies a probability score; it's actually a hardcoded constant per rule type.

---

## 4. Agentic adapters — deep dive

The Agentic Brokerage Program (the "AI Center → Agents" surface) advertises six workflow agents that operate against eleven external adapters. **Every adapter is a stub today.**

### 4.1 Adapter table

| Adapter | Key | Live or dry-run? | What "live" returns today | Required credentials | What user sees on failure |
|---|---|---|---|---|---|
| DAT (rates) | `dat` | **Stub** | `{ok:false, credentialsMissing:true, error:"Live DAT adapter not yet enabled"}` | (no env wired) | Adapter rollout view shows the gap; the agent run silently returns dry-run rates |
| Truckstop | `truckstop` | **Stub** | shares `dat` dispatcher | n/a | Same |
| FreightWaves SONAR | `sonar` | **Stub** for the agentic adapter; **Live** for the standalone `sonarClient` used by Intel/chat | Same as DAT | `FREIGHTWAVES_TOKEN` (live SONAR client only) | Currently SONAR live client is **circuit-breaker OPEN** — see §6 |
| Highway (carrier vetting) | `highway` | **Stub** | `{ok:false, credentialsMissing:true, error:"Live Highway adapter not yet enabled"}` | (none wired) | Risk agent reports a deterministic risk score from `seedHash(MC#)` |
| Carrier411 | `carrier411` | **Stub** | (no dispatcher in `adapters.ts`) | none | Listed but not callable |
| ValueTMS | `valuetms` | **Stub** | `{ok:false, credentialsMissing:true}` | none | Order/Schedule agent fakes a `loadId: "dry-load-…"` |
| EDI | `edi` | **Stub** | Same | none | Tender accept fakes `{accepted:true}` |
| MS Graph (mail) | `graph_mail` | **Stub for outbound action via agent**, **Live for inbound delta-sync** | When an agent stages "send email" and a manager approves, the action returns a fake `messageId` | Outbound: not wired. Inbound: `OUTLOOK_TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET` wired and working. | Approver sees "Sent" but no email goes out. **This is a P0 trust issue.** |
| Twilio | `twilio` | **Stub** | Same | none | "Send SMS" is faked |
| Customer portal | `customer_portal` | **Stub** | Same | none | Faked submission ID |
| Payment portal | `payment_portal` | **Stub** | (no dispatcher) | none | Listed but not callable |

Evidence: `server/agentic/adapters.ts:104, 126, 151, 159, 167, 175, 183` — every `if (mode === "live")` branch returns `credentialsMissing: true`. Dry-run branches use `seedHash(...)` to produce deterministic stub responses (rates between $1.60–$2.40/mi, risk scores 0–99, fake message IDs).

### 4.2 Agent runners

| Agent | What the UI advertises | What runs today |
|---|---|---|
| **Pricing & Strategy** | Generates safe/stretch/aggressive tiered quotes from live market | Calls `adapters.fetchRates` (stub) → builds three tiers from a hashed mid-rate → records suggestion → stages HITL `quote.send` action whose payload is the stub data |
| **Order & Schedule** | Validates tender against won quote, proposes appointments | Pure JavaScript — no adapter call, no validation. Hardcoded `laneMatches:true, equipmentMatches:true, rateMatches:true`. |
| **Coverage & Carrier** | Ranks incumbent + top-3 carriers, builds outreach plan | Hardcoded `ranked: [Incumbent, Top Match A, Top Match B]` with synthetic scores. |
| **Risk & Compliance** | Carrier vetting via Highway / Carrier411 | Calls `adapters.vetCarrier` (stub) → score from `seedHash(MC#)` → flags appended at thresholds 70/80/90 |
| **Execution & Detention** | Driver check-call cadence + detention timer | Hardcoded plan: `["pickup-2hr","midpoint","delivery-2hr"]`, free-time `120 min`, alert `135 min`. |
| **Billing & Collections** | Validates invoice against contract, submits to portal | Hardcoded validation `"all_lines_match_contract"`; stub portal submit. |

Evidence: `server/agentic/agents/index.ts:34–229`. Every runner explicitly passes `adapterMode: "dry_run"` for non-pricing/risk agents (lines 97, 128, 138, 185, 195, 214, 224).

### 4.3 What this means for the user

The HITL Approvals queue is real — managers see action cards, can approve them, and the action is logged. But on approval, **nothing leaves the building**. The customer doesn't get an email, the carrier doesn't get an SMS, the load doesn't get built in the TMS, the invoice doesn't get submitted. The loop completes locally with mock data.

This is the single biggest gap in the platform. It needs to be either (a) implemented, or (b) clearly labeled as a sandbox/preview module so users don't expect real-world effects.

### 4.4 Adapters not in `adapters.ts` but referenced by the broader app

| Service | Status | Evidence |
|---|---|---|
| **Webex** | Live client exists; OAuth for the org is **not authorized** | `/api/webex/status → {"configured":true,"authorized":false,"needsReauth":false}` (live, 7:24 PM) |
| **FreightWaves TRAC** | Live service exists (`server/tracService.ts`) but not wired to agentic adapter | `server/tracAlertEngine.ts` is used by the chatbot, not by agentic |
| **ZoomInfo** | Probe exists (`server/zoominfo.ts`); not surfaced in agentic adapter list | `server/integrations/probeRegistry.ts` |
| **Resend** | Not present. The platform standardized on MS Graph for outbound. | n/a |
| **OpenAI / Anthropic** | Live (real keys, real traffic) | `server/aiHelpers.ts:21–35` |
| **Clerk** | Live (production publishable key `pk_live_…`) | `/api/config/public → {"clerkPublishableKey":"pk_live_…"}` |

---

## 5. Dashboard / KPI validity

This is the section most likely to surprise the non-technical user. Each row explains, in plain English, why a number on the dashboard might look wrong.

### 5.1 Headline KPIs

| KPI tile | Where the number comes from | Plain-English failure mode | Severity |
|---|---|---|---|
| **Current month margin** | `financial_uploads` rows whose `monthKey` equals the **maximum month seen in the file** | If the latest upload is from March, "this month" on the dashboard shows March even though the calendar says April. The user will think April started badly when really April hasn't been uploaded yet. | **P1** |
| **Current month loads** | Same | Same | **P1** |
| **Trending Accounts (Up/Down)** | Top 5 by margin delta vs trailing 3-month average, pace-adjusted | Skewed by accounts with ≤3 months of history; new accounts can dominate "Up" with one large load | P2 |
| **Stale Accounts** | Companies with no `touchpoint` in **21 days** (hardcoded) | Threshold is one-size-fits-all. A weekly account looks stale at day 22; a quarterly account doesn't look stale at day 89. | P1 |
| **Today's Five** | Score = NeverTouched(+10) + 30d+(+8) + OpenTask(+3) + UrgentRFP(+5) | Hardcoded weights; no per-rep tuning | P2 |
| **NBA Cards** | Rule-based engine. If empty, the "Briefing" portlet shows "NBA Stub" | "NBA Stub" reads like a bug; users have asked what it means | **P1** |
| **Opportunity Leaderboard "Potential Margin"** | `(RFP volume − YTD loads) × avg margin per load` | This is not pipeline. It's a back-of-envelope estimate. The label promises more than it delivers. | **P0** |
| **Churn Risk** | Load count drop **>20%** current vs prior month | Hardcoded threshold; not statistically derived | P1 |
| **Award Health** | Stalled if `<5 loads in last 60 days` | Hardcoded threshold | P2 |
| **Touchpoint Streak** | Hardcoded daily goal of **5 touchpoints** | Not configurable | P2 |
| **Sync Alert banner (admin only)** | Triggers when latest monthly sync failed | Real and useful | Working |

### 5.2 Rep attribution (the most insidious source of "wrong numbers")

The platform attributes loads/margin to a rep in two ways:

1. **Strict match:** `users.financialRepId` ↔ financial-upload "Operations user" (for AM/NAM/sales) or "Dispatcher" column (for Logistics Managers).
2. **Fuzzy fallback:** if `financialRepId` is null, the system falls back to `matchRepName` (case-insensitive, name-part match).

In production right now, **at least 3 users have `financialRepId: null`** (admins like Jordan Baumgart, Kylee Hazelgren — observed in `/api/team-members` response). For these users, fuzzy match is the silent path.

**Failure modes:**

- "Jordan B." vs "Jordan Baumgart" works. "Alex" vs "Alexander Smith" works. "Sam Davis" vs "Sam D" works.
- "Sean Heneghan" vs "Sean H." works.
- **But** common first names (e.g., two reps named "Jordan") collapse together, and the dashboard happily double-counts.
- Even worse: a rep with `financialRepId: null` who has no fuzzy match shows **0 loads / 0 margin** with no warning.

There is no UI today that says "this user's `financialRepId` is unset; their dashboard numbers may be wrong." That's a P0 trust issue.

### 5.3 Date-window asynchrony

| Surface | Date source |
|---|---|
| Dashboard portlets | Latest upload's `monthKey` |
| Goals | `goal.startDate` / `goal.endDate` |
| Rep Report | System clock (today, this week, this month) |
| Goals leaderboard | Mix — touchpoints/contacts use system clock; margin uses upload data |

**Result:** the same rep can see "32 loads this month" on the dashboard and "0 loads this week" on the rep report, depending on when the financial upload last landed. Plain-English: the two pages are using **different definitions of "month"** and the user has no way to know.

### 5.4 Cache TTLs

| Cache | TTL | Bust trigger |
|---|---|---|
| Goals leaderboard | per-org cached | Goal create/update |
| Rate positioning chat context | 30 min | None (no bust on financial upload) |
| AI alert narratives, spot, buy-rate | 30 min (in-memory + DB) | None |
| Lane narratives, executive brief | 60 min | None |
| Perplexity market context | 60 min in-memory + 4 h in DB | None |
| Dashboard portlets | route-level memoization (varies) | None systematic |

Plain-English: a user who uploads a fresh financial file may keep seeing yesterday's chat context for up to 30 minutes.

---

## 6. Production smoke pass

The following observations were captured from live deployment logs at `freight-dna.com` on April 27, 2026 between 7:15 PM and 7:24 PM UTC.

### 6.1 Endpoints serving real data

| Endpoint | Sample response | Status |
|---|---|---|
| `GET /api/auth/me` | Real user records (live Clerk IDs) | Working |
| `GET /api/team-members` | Real team list, ~30+ users | Working |
| `GET /api/users` | Real user list | Working |
| `GET /api/notifications` | Real notifications, including currently-firing approval SLA alerts: "Approval overdue (2.0h) — DOW CHEMICAL · MARIETTA, GA → RICHMOND, VA" | Working |
| `GET /api/customer-quotes/stale-followups/count` | `{"count":372}` | Working |
| `GET /api/internal/conversations/my-count` | `{"count":24}` | Working |
| `GET /api/internal/conversations/:id/messages` | Real MS Graph thread bodies in 200–250 ms | Working |
| `GET /api/feed-posts` | `[]` (empty for sample user) | Working |
| `GET /api/promotion/criteria` | `[]` | Working |
| `GET /api/dashboard-relationship-summary` | Empty distribution `{levels:[],totalCompanies:0,totalContacts:0}` | Returns 200 but **empty** — needs investigation |
| `GET /api/nba/daily-workspace` | Real NBA cards (1 card with `ruleType:"webex_missed_call"`, confidence:"high", `whyThisNow:"Ezra Stafford called 706 hours ago…"`) | Working but stale signal |
| `GET /api/sidebar-tooltips` | `{"items":[]}` | Working |

### 6.2 Endpoints failing or degraded in prod

| Endpoint | Behavior | Severity |
|---|---|---|
| `GET /api/webex/status` | `{"configured":true,"authorized":false,"needsReauth":false,"accessTokenExpiresAt":null,"lastRefreshAt":null}` — Webex is configured but the org has not authorized OAuth, so `/phone-usage`, `/calls`, and Webex health are non-functional for this org. | **P0** |
| `GET /api/internal/accounts/.../contact-suggestions` | `403 "You don't have access to this account's suggestions."` — observed for a logistics_manager. May indicate role gate inconsistency. | P1 |
| `GET /api/nba/daily-workspace` | Returned `403 "Not authorized"` for some users. NBA visibility gating may be too tight. | P1 |
| `GET /api/users` | Returned `403 "Access required"` for a logistics_manager. Probably correct. | n/a |
| `GET /api/live-sync/stream` | Returned `401 "Authentication required"` repeatedly for unauthenticated SSE attempts | n/a |
| **SONAR (FreightWaves)** | `7:16:30 PM [sonar] GET /data/VCRPM1/USA/2026-04-20/2026-04-27 error: Circuit breaker OPEN` and `[sonar] National market data unavailable — caching null snapshot to avoid re-pulling until next daily refresh` and `Circuit breaker OPEN — returning cached/fallback data for all SONAR calls until 2026-04-27T19:46:08.787Z` | **P0** |
| **Microsoft Graph delta-sync** | Mostly working (30+ mailboxes processed). Errors: `casey.blambert@valuetruck.com → 404 ErrorInvalidUser` (user no longer in tenant); occasional `Could not resolve org for resource ...` notifications (orphaned subscriptions). | P1 |
| **Graph subscriptions** | Several `[graphWebhook] Could not resolve org for resource "Users/<uuid>/Messages/..." subId=<uuid> — skipping (no matching monitored mailbox or org)` — orphan webhook subscriptions are still being delivered and silently dropped. | P1 |

### 6.3 Background schedulers (confirmed running from boot logs)

```
[nba-outcome-classifier] NBA outcome classifier initialized (every 15 min).
[valueiq-today] Today scheduler initialized — 2 org schedule(s), cron=0 6 * * *.
[nba-phase1] NBA Phase 1 nightly scheduler registered (3:00 AM CT)
```

All three schedulers are running.

---

## 7. Data freshness

| Source | Latest activity (observed) | Surfaces affected |
|---|---|---|
| `financial_uploads` | "Sync alert" banner not currently firing → latest upload is recent. Exact age cannot be established without DB query. | Dashboard, Goals, Rep Report, Top Opportunities, Trending |
| MS Graph mailbox sync | Continuous — every 1–3 minutes per mailbox. | Conversations, Email Intelligence, Lane Inbox |
| SONAR national pull | **Stale — circuit-breaker open until 7:46 PM.** Last successful pull unknown. | Intel, Chat rate-positioning context, Lane narratives, Pre-call planner |
| Webex sync | **Stale — org not authorized.** | Phone usage, Calls page, NBA `webex_missed_call` rule (the live card we observed referenced a call **706 hours / 29 days old**) |
| TRAC alerts | Dependent on FREIGHTWAVES_TOKEN; currently piggybacks on SONAR which is degraded | Lane direction signals |

**Plain-English:** the freshest data on the platform right now is email; the stalest is Webex (the org is missing OAuth) and SONAR (circuit breaker tripped today). Anything that depends on either of those is showing yesterday's world.

---

## 8. Stats Validity Appendix

This appendix is written for the non-technical user. It explains, in plain English, why a number on a dashboard might look wrong.

### Why "this month's margin" might look wrong

Your dashboard's "current month" is **whatever the latest financial spreadsheet says is the latest month** — not the calendar. If your team uploaded April data on April 25th, your dashboard will show April. If they didn't, your dashboard will show March until the next upload, even after the calendar flips to April.

**How to spot it:** The "Sync Alert" banner only fires when an upload outright failed. There is no banner that says "no upload this month yet." When in doubt, cross-check the financial uploads page.

### Why some reps show 0 loads

The platform tries two ways to attribute loads to a rep:

1. **Strict ID match** using the `financialRepId` field on the user record.
2. **Fuzzy name match** if the strict ID is missing.

If your `financialRepId` is blank **and** your name doesn't match anything in the spreadsheet, you show 0 loads with no warning. Three admins currently have a blank `financialRepId`; everyone else relies on the fuzzy match.

**How to spot it:** If a rep's dashboard shows 0 loads but they swear they booked 12, it's almost certainly a `financialRepId` problem. There's no UI today that warns about this.

### Why two pages can disagree

The dashboard ("this month = whatever's in the upload") and your Scorecard ("this month = the actual calendar month") use **different definitions of month**. The same rep can see different numbers on the two pages. Both are technically correct given their own definition; the platform just doesn't tell you the definition is different.

### Why "Potential Margin" on Top Opportunities is fuzzy

That column is calculated as **(RFP volume − YTD loads) × average margin per load**. It's a rough estimate — not actual quoted pipeline. If a customer's award volume is 1,000 loads and we've covered 400, it shows 600 × your average margin. It's directional, not a forecast.

### Why churn / stale / streak thresholds feel arbitrary

They are. Stale = 21 days, urgent RFP = 14 days, churn = 20% drop, touchpoint goal = 5/day. These are baked into the code, not configured per organization. A weekly account "goes stale" at day 22; a quarterly one doesn't go stale until day 90 in real life.

### Why "AI confidence" labels are not really probabilities

When NBA shows a card with "high confidence," that's **a static label set by the rule that fired**, not a probabilistic score from a model. Two cards both labeled "high" have no meaningful relative ranking.

### Why the chat sometimes uses old data

The Copilot's lane-rate context cache is 30 minutes. If you upload a fresh financial file, the chat may still reference the old data for up to 30 minutes. The cache doesn't bust on upload.

---

## 9. Prioritized remediation roadmap

Each item is also listed in §10 as a candidate follow-up task. Severity is the user-impact rating; effort is engineering time.

### P0 — User-blocking / trust-destroying

| # | Item | Severity | Effort | Why now |
|---|---|---|---|---|
| R1 | **Wire the agentic mail and SMS adapters to real services (or relabel the module as Sandbox).** Right now, when a manager approves an HITL action, the mail/SMS that the system says it sent is never actually sent. | P0 | L | The HITL queue is being used; users believe actions are real |
| R2 | **Wire the agentic ValueTMS, EDI, and customer/payment portal adapters (or hide the agents that depend on them).** Coverage / Order&Schedule / Billing all complete loops with fake load IDs and fake tender accepts. | P0 | L | Same — silent no-op on approve |
| R3 | **Fix Webex authorization for the org**, or hide the Phone Usage / Calls pages when not authorized so they don't appear broken. | P0 | S | `/api/webex/status` returns `authorized:false` today |
| R4 | **Restore SONAR live data** (circuit breaker is open; investigate and replace fallback labelling so users know national market context is unavailable). | P0 | M | Multiple AI surfaces silently degrade today |
| R5 | **Surface a "financialRepId is missing" warning on user pages** (and on the rep's dashboard when their numbers are coming from fuzzy match). Prevent silent zero-load reports. | P0 | S | Direct cause of "my numbers look wrong" complaints |
| R6 | **Rename "Potential Margin" on Top Opportunities** to a more honest label and document the formula in-product. | P0 | S | Label currently overpromises |

### P1 — Trust-eroding

| # | Item | Severity | Effort |
|---|---|---|---|
| R7 | **Reconcile date semantics across Dashboard / Scorecard / Goals.** Either pick one definition of "this month" or explicitly label which definition each page uses. | P1 | M |
| R8 | **Stop labelling rule-based NBA as "AI."** Keep the engine; rename the surface, or actually upgrade the engine to a model-driven scorer. | P1 | M |
| R9 | **Move SLA thresholds (21d stale, 14d RFP, 20% churn, 5/day touchpoints) into a per-org settings page.** Currently hardcoded. | P1 | M |
| R10 | **Bust the chat rate-positioning cache on financial-upload events** (and any AI cache that depends on financial data). | P1 | S |
| R11 | **Clean up orphan MS Graph webhook subscriptions** that fire `Could not resolve org for resource …` repeatedly. Either re-link or delete. | P1 | S |
| R12 | **Resolve `casey.blambert@valuetruck.com` (and similar invalid users)** in the monitored-mailboxes config so delta-sync stops 404-ing. | P1 | S |
| R13 | **Tighten or document the 403s on `/api/nba/daily-workspace` and `/api/internal/accounts/:id/contact-suggestions`** for logistics_manager. | P1 | S |
| R14 | **Surface a "no upload yet for this month" banner** on the dashboard so users don't think they had a bad month. | P1 | S |
| R15 | **Mark the AI Center → Agents tab and its Approvals queue as "Sandbox" in the UI** until R1/R2 land, so users don't believe approvals execute. | P1 | S |
| R16 | **Coordinators Corner is not AI.** Either rename it (e.g., "Coordinator Reference") or actually add the AI features the name implies. | P1 | S |

### P2 — Cosmetic

| # | Item | Effort |
|---|---|---|
| R17 | Replace "NBA Stub" placeholder string in the briefing portlet with a real empty-state. | S |
| R18 | Add tooltips to every hardcoded threshold so the user can see "stale = 21 days" on hover. | S |
| R19 | Document the persona templates in-product so users know they're picking from a fixed list, not training the agent. | S |

---

## 10. Proposed follow-up tasks

The following follow-up project tasks are being proposed alongside this audit. Each is in **PROPOSED** state, depends on this audit (Task #777), and includes a brief plan file under `.local/tasks/`. Tasks that overlap with already-pending or proposed work (Webex coverage, ValueIQ landing default, weekly review email, persona/plays promotion, AI Bot Landing, DNA Copilot Overhaul, Coordinators Corner Hub, ValueIQ skeleton, ZIP feed alerts, M365 mailbox enrollment, etc.) are **not duplicated** — instead, the audit cross-references the existing task and notes that the remediation should happen as part of that task.

| Roadmap # | Proposed task name | Existing duplicate? |
|---|---|---|
| R1 | `agentic-wire-live-mail-and-sms-adapters` | No |
| R2 | `agentic-wire-live-tms-edi-portal-adapters` | No |
| R3 | `webex-authorize-or-hide-phone-pages` | Partial overlap with `webex-end-to-end-verification.md`; new task scopes to "hide-when-unauthorized" UI |
| R4 | `sonar-circuit-breaker-recovery-and-fallback-labels` | No |
| R5 | `financialrepid-missing-warning` | No |
| R6 | `top-opportunities-relabel-potential-margin` | No |
| R7 | `dashboard-scorecard-goals-date-semantics-reconciliation` | No |
| R8 | `nba-rebrand-or-upgrade-from-rules-to-model` | No |
| R9 | `org-configurable-sla-thresholds` | No |
| R10 | `bust-ai-caches-on-financial-upload` | No |
| R11 | `cleanup-orphan-graph-webhook-subscriptions` | No |
| R12 | `resolve-invalid-monitored-mailbox-users` | No |
| R13 | `tighten-or-document-nba-and-contact-suggestions-403s` | No |
| R14 | `dashboard-no-upload-this-month-banner` | No |
| R15 | `agentic-mark-as-sandbox-until-adapters-live` | No |
| R16 | `coordinators-corner-rename-or-add-ai` | Partial overlap with the existing Coordinators Corner Hub task; new task scopes to "rename until AI ships" |

The actual proposal step (creation of `.local/tasks/<slug>.md` files and project-task records) is performed by the platform's follow-up-task workflow.

---

## 11. Methodology

### What this audit looked at

- Every `client/src/pages/*.tsx` registered in `App.tsx` (cross-referenced against the sidebar in `client/src/components/app-sidebar.tsx`).
- Every `server/routes/*.ts` module (51 modules).
- The agentic stack: `server/agentic/{adapters,registry,hitl,outcomes,autonomy}.ts` and `server/agentic/agents/index.ts`.
- The agent stack: `server/agent/{core,tools,persona,classifier,retrieval,activity}.ts`.
- AI helpers: `server/aiHelpers.ts`, `server/chatbot.ts`.
- KPI logic: `server/routes/dashboard.ts`, `server/routes/goals.ts`, `server/financialHelpers.ts`, `server/storage.ts` (rep report helpers).
- NBA: `server/nbaPhase1Engine.ts`, `server/nextBestActionEngine.ts`.

### Live evidence sources

- **Production deployment logs** at `freight-dna.com` (April 27, 2026, 7:15–7:24 PM UTC). All quoted log lines in §6 are real.
- **Live API responses** from production, captured from logs (auth, team-members, notifications, conversations, customer-quotes, NBA, Webex status, Outlook status, integrations health).
- **Boot-time scheduler initialization logs** confirming background jobs are registered.

### What this audit did not do

- No code changes, no schema changes, no config changes, no credential rotations.
- No DB queries beyond what was already visible in deployment logs.
- No e2e UI testing — log evidence and API JSON were used in lieu.
- No load testing or perf benchmarking.

---

*End of report. For follow-up task definitions, see `.local/tasks/audit-2026-04-r*.md`.*
