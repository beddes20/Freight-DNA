# FreightDNA — Rollout Critique Briefing for Perplexity

**Briefing date:** April 29, 2026
**Prepared for:** Perplexity (one-shot ingestion — paste this entire document into a single prompt)
**Prepared by:** FreightDNA product team
**Goal:** Have Perplexity critique our user rollout plan and surface workflow, training, and trust risks before we go wide.

---

## 0. What we want from you

Read this entire document first. It is self-contained — every term, persona, surface, and integration we mention is defined here. Do not ask follow-up questions before producing your first pass.

After you read it, give us back:

1. **A prioritized critique** of the platform from a real-world user-rollout perspective — workflow friction, IA/naming confusion, persona fit, AI trust and safety risks, change-management risk, missing safety rails, ordering of features in a rep's day, and over-promised AI surfaces.
2. **A rollout-readiness scorecard** (0–10) for each persona (Account Manager, National Account Manager, Sales / Sales Director, Director, Logistics Manager, Logistics Coordinator, Admin) with a 1–2 sentence "why" for each score.
3. **A suggested rollout sequence** — which user cohorts and which surfaces to enable first, second, third — with the rationale.
4. **A training and comms checklist** — what we should write, record, or send before launch day; what we need on launch day; and what we should send 2 / 7 / 30 days after launch.
5. **Five quantitative success metrics** we should commit to measuring in the first 30 days, with a target value for each.
6. **A list of "do not ship until fixed" items** — anything from this document that you think is genuinely unsafe to put in front of users in its current form.

Be blunt. We would rather hear "this is going to confuse reps and erode trust" than a polite list of generic best practices. We have shipped a lot of features quickly and we want a fresh pair of eyes on whether the user experience holds together.

---

## 1. Product summary

FreightDNA is a sales-and-operations platform built specifically for **transportation brokerage** teams. It blends:

- A **CRM** for customer accounts, contacts, and org charts.
- A **freight cockpit** that turns inbound spot-quote requests, recurring lanes, and won loads into structured, prioritized work queues.
- A **carrier hub** that scores carriers, tracks outreach, and recommends carriers for open loads.
- A **shared email inbox** and conversations layer powered by a real-time Microsoft Graph subscription, with AI-extracted intent signals on every inbound email.
- A **DNA Copilot** — an LLM-powered agent with tool-calling that answers questions, drafts emails, logs touchpoints, navigates the app, and surfaces clarifying questions when unsure.
- A **rule-based Next-Best-Action engine** that produces daily prioritized cards (NBAs) for reps.
- A **Plays / Playbook** system with templated outreach plays, persona system prompts, and an outcome classifier.
- An **admin / AI Center** for managing agents, approvals, pods, persona templates, and integration health.

It is built as a single Express + React monorepo. It runs at `freight-dna.com`. Auth is **Clerk** in production. Data lives in **PostgreSQL** via **Drizzle ORM**. AI calls go to **OpenAI** (`gpt-4o`, `gpt-4o-mini`, `whisper`, `gpt-audio`) and **Anthropic** (`claude-opus-4-5`) for narratives and pre-call planning. Email sync is via **Microsoft Graph** (delta-sync + webhooks). Market data is via **FreightWaves SONAR** and **FreightWaves TRAC**. Telephony is via **Webex Calling**. Payments are via **Stripe** (landing-page checkout only).

---

## 2. The rollout question we are asking you

We are about to roll FreightDNA out to a brokerage that runs ~25–60 reps across Account Managers, National Account Managers, Logistics Managers, Logistics Coordinators, Sales, Sales Directors, and a small Director / Admin tier. The first production tenant (a brokerage called Value Truck) is already live and in daily use; we are now expanding internally and prepping for additional tenants.

Treat this as your input. Tell us where the platform's user experience is brittle, where the AI labelling overpromises, where the persona/role split doesn't match how a rep actually spends a day, and what change-management risks we are walking into.

---

## 3. Personas and a day-in-the-life

We have seven roles. The mental model is: AMs and Sales talk to **customers**, LMs and LCs talk to **carriers**, Sales Directors / Directors / NAMs are coaching tiers, and Admin runs the platform. The platform's "Customer-Facing" and "Carrier-Facing" sidebar groups are organized around this split.

### Account Manager (AM)
- Owns a book of customer accounts. Talks to shippers daily, logs touchpoints, handles inbound quote requests, watches for at-risk accounts.
- Day starts in **Today's Priorities** (NBA cards bucketed by action) or **Dashboard** (depending on personal preference). Then **Customers** for account work, **Customer Quotes** for the quote pipeline, **Conversations** for inbound email, and **Available Freight** when a load needs covering.
- Heavy user of the **DNA Copilot** for "draft a follow-up email to X," "log a call with Y," "what's the latest with account Z."

### National Account Manager (NAM)
- Manages a strategic account or a small set of large accounts. Same daily flow as AM but more time in **1:1's**, **Team Performance**, **Coaching**, and **Rep Scorecard** because they coach AMs.
- Cares about **Momentum Score** drift and **at-risk accounts**.

### Sales / Sales Director
- Lives in **Launchpad** (prospect pipeline), **Top Opportunities**, **Customers**. Less email triage, more outbound.
- Sales Director also reviews **Pipeline Analytics**, **Coaching**, **Rep Scorecard**.

### Director
- Portfolio view. Reads **Dashboard**, **Team Performance**, **Rep Scorecard**, **Lane Analytics**, **Phone Usage**, **Call Performance**, **Integrations Health**.
- Approves things in the **AI Center → Approvals** queue when an AI agent stages an action.

### Logistics Manager (LM)
- Carrier-facing. Lives in **Lane Work Queue**, **My Procurement**, **Available Freight**, **Carrier Hub**, **Carrier Scorecard**, **Available Loads**, **Lane Pricing**, **Conversations** (carrier replies).
- Has a dedicated **Career Panel** on their dashboard with operational KPIs and a path-to-AM milestone tracker.

### Logistics Coordinator (LC)
- Operational support: portal credentials, dispatcher contacts, scheduling windows. Lives in **Coordinators Corner** and **My Procurement**.

### Admin
- User management, integration health, monitored mailboxes, sidebar tooltip overrides, persona/play/agent configuration. Sees everything.

---

## 4. Feature surface, grouped by job

We deliberately list features by what a user does with them, not by sidebar order, so you can judge whether the workflow makes sense.

### 4.1 Sell (customer-facing)

- **Customers** — Searchable, filterable list of accounts. Per-account multi-tab detail page (Overview, Intel, People, Touchpoints, RFPs). Saved Views (up to 10).
- **Contacts & Org Charts** — People at each customer. Relationship Base levels (1st base → Home Run). Visual org chart with reporting hierarchy, freight-spend influence, and lane responsibility per contact.
- **Touchpoints** — Calls, emails, texts, site visits. Logged via floating button, `Shift+T`, or from a company page. Each touchpoint has type, "meaningful conversation" toggle, vibe (Great/Neutral/Cold), notes. Drives Momentum Score and Goals.
- **Momentum Score** — 0–100 health score per account, banded into At Risk / Stable / Growth Ready / Primed to Grow. Real-time band-drop notifications and a Monday 7am CT digest.
- **Goals** — Weekly/monthly KPI tracking with auto-pace indicators (Ahead / On Track / Behind). Metrics: touchpoints, meaningful conversations, new contacts, margin, loads, custom.
- **Tasks** — Manual + auto-generated + procurement-specific. List and calendar views. Bulk reassign / complete.
- **1:1's** — Coaching workspace for manager-rep pairs. Topics, dev goals, AI session summary, optional email recap.
- **Launchpad** — Sales pipeline (New Lead → Intro Scheduled → Intro Completed → Follow Up → Opportunity Sent → First Load Won, plus Lost / Disqualified). Kanban + table. Stale-prospect detection at 14 days.
- **Top Opportunities** — Hot Zone matches between high-frequency delivery locations and active RFP pickup origins.
- **RFP & Awards** — Excel/CSV upload with AI column mapping (`gpt-4o`), award lane parsing, wallet-share upload, RFP Calendar.
- **Customer Quotes** — Quote pipeline with stale-followup count badged on the sidebar. Live-syncs across tabs.
- **Freight Capture** — Quote-to-book funnel: stages from request received through win, with loss reasons.
- **Email Intelligence** — Inbound emails are scored every ~2 minutes by `gpt-4o-mini` for intent (pricing request, urgency, objection, win/loss signal, etc.). Four tabs: Urgency Tracker, Win/Loss Patterns, Signal Overview, Recent Feed.
- **Quote Request SLA** — When a pricing-request signal fires, a 7-minute timer runs; manager escalation at 5 minutes.
- **Contact Suggestions** — `gpt-4o-mini`-detected new people from email signatures and threads. Org-wide batch review with role assignment.
- **Conversations** — Org-scoped shared inbox. Threads, ownership, priority/SLA (4h High / 24h Normal), AI summaries, suggested next actions. Sidebar live count.
- **Proven Tactics** — Outbound responses that historically led to wins, classified by signal type.
- **Playbook + Plays** — Templated outreach plays (e.g., "Quote no response," "Reactivate stale account"). Managers author and version plays; reps run them; outcomes are auto-classified by `gpt-4o-mini`.

### 4.2 Triage freight (carrier-facing)

- **Available Freight Cockpit** — Triage cockpit for inbound freight opportunities. KPI header cards, ranked carrier chips, suggested buy rates, coverage / freshness / urgency scores, bulk actions, make-recurring, SSE-driven refresh pill, **a 90-second in-process pricing-blend cache** (Sonar + internal history) so duplicate lanes don't repay the API cost on a single page load. Approval-overdue notifications fire for stale unapproved loads.
- **Lane Work Queue (LWQ)** — Recurring lanes that need carrier coverage. Buckets: Unassigned / No Contactable / Assigned Untouched / In Progress. Lane Score (0–100) drives priority. Carrier Outreach Panel: ranked carrier suggestions, outreach templates, send via Outlook with reply-to set to ops mailbox.
- **My Procurement** — Personal worksurface combining LWQ + open award procurement tasks. Hot-reply badges.
- **Won Load Autopilot** — Won quote → freight opportunity conversion, triggers an approval modal in front of an LM/LC.
- **Lane Inbox** — Cross-surface activity feed at `/lane-inbox`. Aggregates recent events from Available Freight, LWQ, Carrier Hub, and Customer Quotes into one chronological feed.
- **Carrier Hub** — Carrier CRM. Profile tabs: Overview, Intelligence, Best Lanes Right Now, Contacts, Claimed Lanes, Proven History, Activity. Carrier Reliability Score (Reply Rate 40% + Hard Commitment 30% + Positive Outcome 30%).
- **Carrier Scorecard / Available Loads / Lane Pricing** — Tiered carrier performance, top-3 carrier suggestions per open load with target buy rate, blended Sonar TRAC + realized history pricing.
- **Lane Intelligence** — Lane Research / RFP Lane Search / Carrier Lane Search.
- **My PODs** — Proof-of-delivery intake routed from the AR mailbox.

### 4.3 Communicate

- **Conversations** (above) — Real-time webhook + delta-sync hybrid. Background jobs are heartbeat-instrumented so admins see if the email pipeline stalls. Manual recovery hatches: "Sync mail now," "Renew subscriptions now," "Run AI batch now."
- **Webex Calling** — Click-to-call from contact records, CDR sync, presence, recording download, Whisper transcription, AI analysis. *Requires per-org OAuth — currently configured but not authorized for every tenant.*
- **AI Email Drafting** — "Draft for me" in any compose dialog. Pulls context from contact, account, and recent touchpoints.
- **Pre-Call Planner** — `claude-opus-4-5`-generated 3 sharp talking points + health narrative + touchpoint summary, surfaced in a drawer on the company detail page.
- **Post-Call Capture** — `gpt-4o-mini` extracts sentiment, follow-ups, and play labels from a transcribed call.

### 4.4 Coach

- **Team Performance** — Rep-level KPI rollup, coaching needs flags, promotion-readiness criteria.
- **Rep Scorecard & Leaderboard** — Sortable leaderboard for NAMs and AMs across last week / MTD / last month / YTD. Pace badges. Plays-executed tracking. Linkable to per-rep report card.
- **Coaching** — Coaching notes and rep development plans.
- **Career Progression (LM Career Panel)** — Operational KPIs + Path-to-AM tracker + Top Carriers + Development Milestones. Renders on the dashboard for LMs.
- **LM Check-In Log** — History of LM daily check-ins.
- **Report Cards** — Weekly + monthly snapshots stored as JSONB.
- **Touchpoint History** — Org-wide review of every logged touch.
- **Notifications / Inbox** — Aggregated alerts: tasks, goals, posts, PTO, account assignments, promotion nominations, etc.
- **Callouts / Trends Feed** — Per-account collaboration feed. Categories: Win / Risk / Intel / Idea / Trend. @mentions, threaded replies, file attachments, pinned posts.

### 4.5 Plan & operate

- **Coordinators Corner** — Per-account portal credentials, dispatch contacts, scheduling windows, account quirks. One-click copy on every credential. *No AI — this is a credential vault, not an intelligence surface.*
- **PTO Passoff** — Structured passoff workflow with per-account checklist (priority, spot handler, key contact, open items, quirks, active RFPs, weekly load count, email-forwarding confirmation, spot-board confirmation), covering-rep dashboard, daily 8am CT return-from-PTO job.
- **Financials** — Total revenue, cost, margin. Manual upload (admin) + OneDrive sync. Financial aliases for matching.
- **Lane Analytics (Historical Data)** — Lane corridors, heatmaps, proximity matches, trend analysis.
- **Market Pulse (SONAR)** — OTRI, NTI, diesel; role-specific intelligence (directors see hot/warm/cool lanes; AMs see top 3 markets affecting their accounts; LMs see lane urgency by VOTRI).

### 4.6 AI surfaces (the AI Hub)

All AI surfaces are consolidated under a single **AI Hub** at `/ai-hub`. The five tabs:

1. **Today's Priorities** — All active NBA signals bucketed by action type. *Backed by a rule engine, not a model.*
2. **ValueIQ** — Daily AI briefing (heuristic SQL aggregation), Threads (real LLM chat), and a personal Library. The chat shares the DNA Copilot runtime.
3. **AI Center** — Admin module for AI agents, approvals, pods, and adapters; persona/play config and the AI activity log live as sub-views inside `/ai/admin`.
4. **Engagement** — Per-surface impressions, click-through, accept rate, zero-engagement candidates.
5. **Copilot Analytics** — Top questions, failure modes, latency, full Action Audit log, "Needs Attention" queue for failures and low-confidence turns.

The **DNA Copilot** itself is the global chatbot reachable from anywhere in the app. It uses `gpt-4o` for reasoning + `gpt-4o-mini` for fast responses, streams via SSE, supports a 6-iteration tool loop (navigate, log_touchpoint, query_pipeline, available_freight_search, lane_carrier_lookup, etc.), has a per-org agent allowlist, surfaces low-confidence callouts with clarifying-question chips, sanitizes secrets out of error reports, and writes a per-turn audit row that the rep's profile and the company activity feed both render.

The seven legacy AI URLs (`/daily-priorities`, `/valueiq`, `/ai`, `/ai/agents`, `/ai/approvals`, `/admin/ai-engagement`, `/admin/copilot-analytics`) all resolve to the same hub with the matching tab pre-selected, so existing bookmarks keep working.

### 4.7 Admin

- **User Management**, **Carrier Catalog**, **Monitored Mailboxes**, **Sidebar Tooltips**, **Webex Health**, **Integrations Health** (live Sonar / Outlook / Webex / ZoomInfo / OneDrive / TRAC / Stripe status, with a "Test Now" probe and a Sonar call-budget tracker), **Endpoint Perf** (per-route p50/p95/p99 vs budget), **POD Intake**, **Freight Import Health**, **Carrier Intel Admin** (load_fact backfill, parity reports), **Carrier Intel Settings**, **Freight Capture Rep Audit** (link / merge / suppress rep names appearing on the funnel), **Freight Outreach Templates**, **Feedback Inbox**.

---

## 5. Onboarding and training flow

A new tenant is onboarded in roughly one week. The flow we run today:

1. **Demo + plan selection.** Prospect schedules a demo from the public landing page. After demo, they pick a plan (Trial $1,000 first month, Standard $1,500/mo, Enterprise $2,000/mo, or Custom Buildout) and pay via Stripe checkout.
2. **Account provisioning.** Admin creates the org, invites users, and sets each user's role. Users authenticate via Clerk on first login. Users with no record yet see a "Your account hasn't been provisioned" screen instead of a broken app.
3. **Data import.** Admin uploads historical financial data (Excel/CSV via SheetJS) and/or wires OneDrive sync so financial uploads flow in automatically. Customers and contacts are seeded from the same source.
4. **Mailbox monitoring.** Admin configures which mailboxes the platform watches via Microsoft Graph delta-sync + webhooks. Historical backfill runs once at attach time.
5. **Carrier intelligence backfill.** Admin runs the load_fact backfill so the carrier hub, available freight, and carrier scorecards have realized-load history to score against.
6. **Persona + play setup.** Admin reviews the default persona system prompts and the default playbook. Plays can be authored in-app or imported from Excel.
7. **First-week reviews.** A morning "Today's Priorities" session helps reps see the NBA queue. Managers review Team Performance and Rep Scorecard at end-of-week.

There is **no formal in-app tour** beyond a tooltip override system that admins can edit per sidebar entry. There is a **Training** page with onboarding materials and a **Feedback Inbox** for users to report issues.

---

## 6. Integrations and data sources

| Integration | Status today |
| --- | --- |
| **OpenAI** (`gpt-4o`, `gpt-4o-mini`, `whisper`, `gpt-audio`) | Live, real keys, real traffic |
| **Anthropic** (`claude-opus-4-5`) | Live for narratives and pre-call planning |
| **Microsoft Graph — Outlook** (delta-sync + webhooks) | Live, processing 100+ messages per mailbox per cycle |
| **Microsoft Graph — OneDrive** | Live for financial sync |
| **FreightWaves SONAR** | Live, but the live client is currently circuit-breaker open at intervals; cached snapshots are used during outages |
| **FreightWaves TRAC** | Live for spot rates / forecasts |
| **Webex Calling** | Configured per org; some tenants are not yet authorized |
| **ZoomInfo** | Live for contact intelligence enrichment |
| **Clerk** | Live, production publishable key |
| **Resend / GoDaddy SMTP** | Live for transactional email |
| **Stripe** | Live for landing-page checkout only |
| **Perplexity** (sonar model) | Optional, conditional on `PERPLEXITY_API_KEY` |

The **Agentic Brokerage Program** (six workflow agents — Pricing, Order, Coverage, Risk, Execution, Billing — across eleven external adapters: DAT, Truckstop, SONAR, Highway, Carrier411, ValueTMS, EDI, Graph Mail outbound, Twilio, Customer Portal, Payment Portal) is **dry-run today**. The HITL approval queue is real; the approved action goes to a stub adapter that returns deterministic mock data. This is intentionally surfaced in the AI Center's Adapters tab; the very first time an admin opens `/ai-hub`, we redirect them to `/ai/adapters` so they see which integrations are wired before they look at the agent fleet.

---

## 7. Roles and permissions (high level)

- **Admin** sees everything, including all org data, all routes, all admin surfaces.
- **Director** sees their team plus team-of-team accounts; full access to coaching, scorecards, lane analytics, integrations health.
- **NAM** same as Director but typically scoped to a strategic account or pod.
- **Sales Director / Sales** lives in Launchpad and prospect-driven pipeline.
- **AM** sees only assigned or shared accounts.
- **LM** inherits visibility from their assigned manager; lives in carrier-facing surfaces; has the Career Panel.
- **LC** sees only explicitly assigned accounts; lives in Coordinators Corner and procurement.

The sidebar uses three visibility states per item: **active**, **admin_preview**, and **hidden**. An `admin_preview` entry is **hidden entirely from non-admin users** in the sidebar; admins see it visible-but-disabled with an "In development" tag so the surface stays discoverable while we iterate. The page itself is still reachable by direct URL for any role on its allow-list. Many surfaces are currently `admin_preview` while we settle on UX (My Scorecard, Launchpad, Customer Quotes for some roles, Freight Capture, Email Intelligence, Proven Tactics, Playbook, Coaching, Rep Scorecard, AI Hub, Carrier Hub, Lane Inbox, Phone Usage, Call Performance, Carrier Scorecard, Lane Pricing, Carrier Intel Settings, RFP Calendar, Freight Attribution Triage, My PODs).

The command palette (cmd-K) intentionally still surfaces every role-allowed destination including admin-preview ones, so admins can jump directly to incubating surfaces.

Server-side, every storage operation is **org-scoped** — cross-org reads return undefined and cross-org writes return null with no mutation. Every Express handler normalizes `req.params` and `req.query` through helper functions (`pStr` / `qStr` / `qOptStr`) so there are no raw string reads. AI chat conversation endpoints are user-scoped (`chatConversations.userId === currentUser.id`) so reps cannot read each other's chat history.

---

## 8. Known gaps, open issues, and things still being built

We want you to factor these into your critique — they are what the user will eventually run into.

### 8.1 Numbers and labelling

- **"Current month" on the dashboard is the latest financial-upload month, not the calendar month.** If the April upload is late, "this month" shows March data without saying so.
- **Rep attribution falls back to fuzzy name matching** when `users.financialRepId` is null. Common first names (two reps named "Jordan") can collide silently. There is no in-app warning that a user's `financialRepId` is unset.
- **SLA thresholds are hardcoded** — stale account at 21 days, urgent RFP at 14 days, churn at a 20% drop, touchpoint streak goal at 5/day. Not configurable per org or per rep.
- **Opportunity Leaderboard "Potential Margin" is a placeholder** — `(RFP volume − YTD loads) × avg margin per load`, not real quoted pipeline.
- **NBA "confidence" labels are static per rule type**, not a real probability.

### 8.2 AI labelling

- **Next Best Action** is rule-based, not AI. The card and the page brand it as intelligence; it's `if (no_touchpoint_for_14_days) fire card`.
- **ValueIQ "Today" briefing** is a SQL aggregation. The chat layered on top is real LLM. Reps may not realize the briefing itself isn't generated.
- **Coordinators Corner** is presented as a hub but contains no AI — it is a credential and dispatcher-contact vault.
- **The Agentic Brokerage Program** approves real-looking actions in the HITL queue, but the action goes to a stub. Approving "Send mail" returns a fake message ID; no email is sent. We need this to be either fully wired or unmistakably labelled as a sandbox.
- **AI helpers fail silently to `null`** when an API key is missing — the user sees a missing card with no explanation.

### 8.3 Operational

- **Webex is configured but not authorized** for at least one org today. Phone Usage and Call Performance both depend on Webex auth and will look broken until OAuth is granted.
- **SONAR live client periodically opens its circuit breaker.** Cached snapshots are used during outages, but the user has no in-page indication.
- **There are ~54 pre-existing TypeScript errors** in the typecheck baseline (mostly `err?.message` on `unknown` catch variables in unrelated route files). They do not affect runtime; they are tracked as a follow-up.
- **The post-call capture drawer doesn't live-stream new tool rows** — admins viewing a turn-detail drawer in the Copilot Analytics queue need to close/re-open if the turn updates after open.
- **Error-report sanitization only applies to the explicit "Report this" path.** A secret pasted into a normal prompt still reaches the agent activity log.

### 8.4 Workflow and IA

- The home route `/` reads the user's `prefersToday` preference and redirects to either Today's Priorities or Dashboard. Some users may not realize there are two real "home" surfaces and confuse them with the AI Hub's Today's Priorities tab (same name, different page).
- The sidebar groups (Customer-Facing, Carrier-Facing, AI, Admin/Team) collapse independently and persist per-user. Reps in mixed roles (LM who also covers customer accounts) currently jump between groups.
- **Conversations** appears in both the Customer-Facing and Carrier-Facing groups intentionally. It is the same page in both places. Some users have asked which one they should click.

### 8.5 Trust rails

- AI surfaces use silent null fallback when keys are missing; consider explicit "AI unavailable — check Integrations Health" copy.
- The "Send mail" agent action that today goes to a stub should refuse to render until a live adapter is wired, OR should be visually marked as a sandbox action.
- A user with `financialRepId: null` should see a banner on their own scorecard that their numbers may be incomplete.

---

## 9. Current rollout state

- **Production deployment:** `freight-dna.com` (Clerk live key, real OpenAI / Anthropic / Graph traffic).
- **First production tenant:** Value Truck — a value-truck transportation brokerage. Live in daily use across AM, NAM, LM, LC, Sales, and Admin roles.
- **Demo tenant:** A `demo` org used for sales and staging.
- **Test tenants:** Several "HF Test" and "Fixture Guard" orgs that exercise high-frequency lanes and mailbox isolation.
- **Scale today:** Tens of users across the production tenant; tens of thousands of `load_fact` rows; 30+ monitored mailboxes syncing on Graph delta; a few hundred customer-quote follow-ups in flight at any moment.
- **Background jobs running:** email_intelligence_batch (every 2 min, with a 5-min wall-clock + cooperative cancellation), Webex CDR sync, OneDrive financial sync, ValueIQ Today seed at 06:00, PTO return-from-PTO job at 08:00, Quote Request SLA escalation every minute, weekly account review generation.
- **Roles deployed:** Account Manager, National Account Manager, Director, Sales, Sales Director, Logistics Manager, Logistics Coordinator, Admin.
- **Surfaces gated to admin_preview** (sidebar entry hidden from non-admins, visible-but-disabled for admins; URL still reachable for permitted roles): see the Roles & Permissions section above for the full list.

We are currently about to widen rollout — both more roles inside the existing tenant and additional tenants within the next quarter.

---

## 10. Specific critique dimensions we want you to grade us on

Please cover all of these in your prioritized critique. Don't skip any.

1. **Workflow ordering.** Does the rep's day make sense given the surfaces above? What's missing or in the wrong place?
2. **Persona fit.** Are AM / NAM / LM / LC / Sales / Director / Admin really the right set of roles? Where do they overlap or leak?
3. **Naming and IA confusion.** Same-name-different-page (Today's Priorities), Conversations appearing twice, AI Hub vs Today vs Dashboard, ValueIQ "briefing" vs "chat," Coordinators Corner being labelled like an intelligence hub.
4. **AI trust and safety.** Where is AI overpromised (NBA, ValueIQ briefing, Coordinators Corner, agentic adapters)? Where could a silent null-fallback erode trust? Where should we add "AI unavailable" copy?
5. **Change-management risk.** Reps switching from existing CRMs and TMS workflows to FreightDNA — what habits will break? What will they miss?
6. **Training gaps.** What in-app help, tours, micro-tutorials, or recorded walkthroughs are we missing? What should onboarding cover that we aren't covering today?
7. **Missing safety rails.** Where could a rep do something destructive or trust-breaking with no guardrail (sending a real email through an "agent action," counting margin under the wrong rep, treating a hardcoded SLA as gospel)?
8. **Success metrics.** What five metrics should we commit to publicly for the first 30 days? Touchpoint adoption? Quote-response time? NBA acceptance rate? Time-to-first-load? Something else?
9. **Suggested rollout sequencing.** Which roles should we widen to first? Which surfaces should we leave gated for now?
10. **What we should NOT ship until fixed.** Be specific. Give us the items you would refuse to put in front of a rep on day one.

---

## Reminder — what we want back

Produce, in this order:

1. **Prioritized critique** (P0 / P1 / P2, with rationale).
2. **Rollout-readiness scorecard** per persona (0–10 + "why").
3. **Suggested rollout sequence** (cohort × surface × week).
4. **Training and comms checklist** (pre-launch, day-one, day 2 / 7 / 30).
5. **Five 30-day success metrics with target values.**
6. **"Do not ship until fixed" list.**

Be direct. Skip the throat-clearing. We're rolling this out soon.
