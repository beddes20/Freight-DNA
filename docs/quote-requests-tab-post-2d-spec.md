# Quote Requests Tab — Post-2d UX/IA Spec

> **Status:** Spec only. No production code is written or modified by this document.
> **Prerequisite:** Phase 2b (forward closure), 2c (capture-leak auto-empty), and 2d (legacy fold-in) are shipped and stable.
> **Companion:** Three Canvas mockups in `artifacts/mockup-sandbox/src/components/mockups/quote-requests-post-2d/` (`PopulatedList`, `RowAndDetailDrawer`, `EmptyState`).
> **Implementation owner:** Whoever picks up the post-2d UI implementation task created from this spec.

---

## 0. Frame

After Phase 2d:

- `quote_opportunities` is the **system of record** for every customer quote request, regardless of channel.
- Phase 2b's signal-extractor → opportunity pipeline runs on every inbound customer email and is responsible for populating `source = 'email_signal'` rows; the four counters (`created` / `attached` / `skipped_internal` / `skipped_low_confidence`) are surfaced both on the admin Integrations Health tile and inline in this tab's automation strip.
- The **Quote Requests tab is the operator surface** for that table — it replaces the legacy `customer-quotes.tsx` page. The legacy code path survives only as a redirect (see §8).

The tab is **not** "a filtered inbox." It is the intake-to-outcome surface. One row = one customer quote request = one `quote_opportunities` row. Always.

The tab consciously absorbs functionality that today lives in three places (legacy Customer Quotes table, Capture Leak Queue triage, Conversations "looks like a quote request" filter). The Capture Leak Queue does not disappear — it shrinks dramatically (Phase 2c auto-empties it) and is reframed as a **review surface for things the autopilot intentionally skipped or could not classify**, not a primary triage queue.

---

## 1. Current state audit (what we are replacing)

Read against `client/src/pages/customer-quotes.tsx` (3,031 lines), `client/src/pages/conversations.tsx` (1,260 lines), and `client/src/pages/admin-integrations-health.tsx` (Phase 2a leakage tile).

### 1.1 Legacy Customer Quotes (`/customer-quotes`)

- One giant 3k-line page. Holds: KPI snapshot, action queue card, new-contact-review strip, spot-quote search, validity window module, alerts, lane variance, attractiveness, stale follow-ups, the actual list table, and the detail drawer (`QuoteDetailDrawer`).
- List columns today: `requestDate`, `customerName`, `originCity/originState → destCity/destState`, `equipment`, `quotedAmount`, `validThrough`, `outcomeStatus`, `outcomeReasonLabel`, `repName`, `responseTimeHours`, `source`, `score`. Saved views and presets persist filters via `customer-quotes-presets`.
- Drawer is large: header, lane card, source thread deep-link (`sourceThreadId` / `sourceMessageId`), pricing recommendation card, pricing intelligence panel, related-same-lane / related-same-customer / related-lane-group, timeline of `quote_events` with auto-flip context, notes, optional `NewContactReviewSection` for first-time senders.
- Status taxonomy: 10 labels (`pending`, `quoted`, `won`, `won_low_margin`, `lost_price`, `lost_service`, `lost_timing`, `lost_incumbent`, `no_response`, `expired`); 8 outcome buckets (excludes `pending` and `quoted`). Status colors are amber/sky/emerald/yellow/red/muted — preserved by the new tab.
- Drawer mounts `EmailThreadViewerModal` for source-thread peek; this pattern survives.
- The page mixes "operator triage" (the table) with "analytics" (variance, attractiveness, alerts panels). The new tab keeps **only the triage half**; analytics moves to a separate AI/analytics surface (out of scope here).

### 1.2 Conversations Inbox (`/conversations`)

- Bucket sidebar (`BucketSidebar`) + thread list (`ThreadList`) + thread detail pane (`ThreadDetailPane`). Density toggle (compact / comfortable), group-by (none / account / carrier), audience filter (all / customers / carriers), date popover, filters popover, bulk action bar, capture-audit status pill.
- Persists per-user keys in localStorage: density, group-by, collapsed groups, audience.
- Phase 1 freshness work landed: list ships server-computed `lastEmailAt = MAX(provider_sent_at)` plus `lastIncomingAt` / `lastOutgoingAt`. The new tab consumes the same anchored timestamps — never `email_conversation_threads.updated_at`.
- The "looks like a quote request" filter on this page is **retired** post-2d. Conversations is the email transport surface; Quote Requests is the operator surface for the request artifact extracted from those emails. Cross-link, don't duplicate.

### 1.3 Capture Leak Queue + Phase 2a tile

- Today: lists inbound `quote_request` / `pricing_request` signals that did not produce a `quote_opportunities` row. Admin actions: review, manual quote creation, attach orphan outbound to existing quote (writes paired `quote_events` + `capture_leak_reviews` audit).
- Phase 2a tile (`/admin/integrations-health`): `% leaked` over 24h / 7d windows, top 10 leaking sender domains. Read-only. Refreshes 60s. Drives no automation — the operator-day baseline before 2b turns on.
- Post-2d: Phase 2b auto-creates / auto-attaches the vast majority. The leak queue still exists as a fallback for `skipped_internal` / `skipped_low_confidence` and unparseable edge cases. The Quote Requests tab links into it from the automation strip; it is no longer a sibling tab in the same operator's daily rotation.

---

## 2. System-of-record contract (LOCKED — do not re-litigate)

| Decision | Locked answer | Rationale |
|---|---|---|
| What is one row in this tab? | Exactly one `quote_opportunities` row. | The whole point of 2b is to make this true. The UI must not invent a different unit. |
| Where do email-sourced rows come from? | `source = 'email_signal'`, written by Phase 2b's forward-closure path off `email_signals`. | Phase 2b spec. |
| What about non-email-sourced rows (TMS imports, manual entry, spot-quote-search results)? | They appear in this same tab, with their respective `source` value (`tms`, `manual`, `spot_search`). One tab. One table. Source is a facet, not a tab. | Operator works the request, not the channel. Channel is a column / filter. |
| Are "attached" signals their own rows? | **No.** When 2b attaches a new signal to an existing opp, the signal does not get its own row — it bumps the parent opp's `lastIncomingAt` and adds a timeline event. The parent row's "Last activity" cell shows the attach. | One-row-per-request invariant. The signal is a fact about the existing request, not a new one. |
| What is the row-to-thread mapping? | Deterministic via `quote_opportunities.source_reference` matching `email_messages.provider_message_id` for the originating message; `email_signals.linked_opportunity_id` for subsequent attached signals. Both columns are already populated by 2b. | Same join the Phase 2a counter uses — proven. |
| Does the legacy `customer-quotes.tsx` page survive? | Redirect-only after 2d. `/customer-quotes` 301s to `/quote-requests`. Saved views / presets are migrated by a one-time backfill. The 3k-line page file is deleted in the post-2d implementation task. | Two pages with the same data is a leak factory. |
| Is `repName` resolution reused? | Yes — the existing layered resolution from `replit.md` ("Customer Quotes Display Resolution") applies unchanged. The new tab consumes the resolved name from the list endpoint. | Already correct. Don't reimplement. |
| Org isolation? | Every query is scoped via `org_id` (request → opportunity → message). No exceptions. | Same RBAC posture as today's tab. |

---

## 3. List view spec

### 3.1 Layout

```
┌─ Top bar ─────────────────────────────────────────────────────────────────┐
│ Quote Requests · [count] · Saved views ▾                  [+ New quote]   │
│ Every inbound request, one row, one source of truth                       │
└────────────────────────────────────────────────────────────────────────────┘
┌─ KPI strip (5 tiles) ─────────────────────────────────────────────────────┐
│ Open · Awaiting your reply · Past SLA · Won today · Auto-captured today   │
└────────────────────────────────────────────────────────────────────────────┘
┌─ Filter row ──────────────────────────────────────────────────────────────┐
│ [search] [status chips] [age chips] [Mine only] [Free-email] [Domain ▾]   │
└────────────────────────────────────────────────────────────────────────────┘
┌─ Automation strip ────────────────────────────────────────────────────────┐
│ Today · Created 47 · Attached 12 · Skipped (internal) 3 · Low conf 5  →   │
└────────────────────────────────────────────────────────────────────────────┘
┌─ Table ───────────────────────────────────────────────────────────────────┐
│ • | Customer | Lane | Requested | Age | Status | Rep | Conf | Activity │⋯│
│ ...                                                                       │
└────────────────────────────────────────────────────────────────────────────┘
┌─ Footer · pagination ─────────────────────────────────────────────────────┐
│ 1–50 of 312        [‹] [›]                       j/k · enter · e · w      │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Columns (default, left to right)

| Col | Source | Notes |
|---|---|---|
| Status dot | `outcome_status` | Color from `STATUS_COLORS`. One pixel of identity, scannable in periphery. |
| Customer | `quote_opportunities → customers.name` (canonical) | Sluggified-name upgrade rules from `replit.md` apply. Free-email senders get an amber chip after the name. |
| Lane | `originCity, originState → destCity, destState` over `equipment` | Two-line cell. Equipment in 11px muted. |
| Requested | `requestDate` | Relative ("12m ago", "2h ago", "Tue 9:14a", "Apr 28"); absolute on hover via Tooltip. |
| Age | derived | Pill. Past SLA → red ring; near SLA (>75% of `pTypicalHours`) → amber ring. |
| Status | `STATUS_LABELS[outcome_status]` | Pill from existing palette. |
| Rep | `repName` (layered resolution) | Initial avatar + name. Click → reassign popover (no drawer needed). |
| Conf | `email_signals.confidence` for `source='email_signal'` rows; blank for others | Tiny 0–100 bar + numeric label + tier (`high` / `med` / `low`). Low-confidence rows get a "Review" outline. |
| Activity | server-computed | One precise line: "Customer replied 12m ago" / "You replied 1h ago" / "Auto-attached to opp #4821" / "Quoted $2,400 · awaiting" — anchored to `lastIncomingAt` / `lastOutgoingAt` / latest `quote_events`. **Never `updated_at`.** |
| ⋯ | — | Row actions: Open, Assign, Mark won, Mark lost, Send to leak queue, Snooze, Mark duplicate. |

Row height: 32–36px. Body text 12–13px. Hover: subtle elevation (per `references/hover_and_elevation.md`), no border shift.

### 3.3 Sort

- **Default:** `requestDate desc` (newest first).
- **Secondary sorts** (click column header): Customer, Age (asc puts oldest first — useful for SLA triage), Status, Rep, Conf.
- The legacy `customerName | originCity | destCity | equipment | quotedAmount | validThrough | outcomeStatus | outcomeReasonLabel | repName | responseTimeHours | source | score` sort keys carry over verbatim — no schema break. (`carrierPaid`, `marginDollar`, `marginPct` remain retired per Task #816.)

### 3.4 Filters (above the fold)

- **Status chips** (single-select+all): `All` · `New` (= `pending` + just-created in last 4h) · `Quoted` · `Won` · `Lost` · `No-response`.
- **Age chips** (single-select): `Today` · `24h` · `7d` · `30d` · `All`.
- **Mine only** toggle: filters by `assigned_rep_user_id = currentUser.id`.
- **Free-email senders** toggle: filters where source signal sender domain ∈ {gmail, yahoo, hotmail, outlook.com personal, …} — exposes risk.
- **Sender domain** dropdown: type-ahead over distinct sender domains in the current window. Mirrors the Phase 2a "top leaking domains" list — operators recognize the names.
- Free-text search: debounced 250ms, matches across customer name, lane city/state, sender email, sender display name, notes.

### 3.5 Saved views

- Reuse existing `customer-quotes/saved-views` endpoints. Migration backfill rewrites legacy filter shape into the new shape (status chips, age chips, mine, free-email, domain). Old views that referenced retired columns (`carrierPaid` etc.) silently coerce to the default sort, same as today.

### 3.6 Pagination

- **Keyset pagination**, page size 50 (matches `PAGE_SIZE` constant). Footer shows `1–50 of N` plus prev/next. No infinite scroll — the operator's mental model is "I worked through page 1," and the keyboard nav (j/k) plays better with discrete pages.

### 3.7 Row hover preview

- 200ms hover on the Customer cell pops a `HoverCard` with: customer health score, last 3 quoted lanes for this customer, win rate. Same pattern as the existing cross-tab UX layer hover-cards.
- Hover on the Activity cell pops a `HoverCard` with the last incoming and outgoing message snippet — no need to open the drawer for a glance.

### 3.8 Click-through

- Click anywhere on the row (except Rep avatar, ⋯, or status dot) → opens detail drawer. Drawer state persists in URL via `?quote=<id>`, identical to today.
- Cmd/Ctrl-click → opens the source thread in a new tab via `/conversations?threadId=...`.

### 3.9 Empty / loading / error / slow / permission-denied

See §6.

### 3.10 Automation strip

A single thin row immediately below the filter row, full-width, muted background. Format:

```
Today · Created 47 · Attached 12 · Skipped (internal) 3 · Low confidence 5     [Review skipped →]
```

- Counters come from a new endpoint described in §5.10. They mirror the four Phase 2b outcomes and are scoped to `(org, today)`.
- "Review skipped" deep-links to the Capture Leak Queue pre-filtered to the union of `skipped_internal` + `skipped_low_confidence` for today.
- Clicking any counter applies a virtual filter to the table below ("show me the 12 attached ones today"). This is the operator's primary path back into the autopilot's audit trail.

---

## 4. Detail drawer spec

A right-edge `Sheet` (existing `@/components/ui/sheet`), 480–560px wide on desktop, full-screen on narrow viewports. Mounts via the same `CustomerQuotesPortalContext` as today so modals (`EmailThreadViewerModal`) layer correctly above it.

### 4.1 Sticky header

```
┌──────────────────────────────────────────────────────────────────┐
│ Lactalis USA                              [×]                    │
│ Quote Request · #QR-1042 · Reefer · 8m ago                       │
│ [Status pill]  [Rep avatar + name ▾]                             │
│ [Send quote]  [Mark won / lost ▾]   [⋯]                          │
└──────────────────────────────────────────────────────────────────┘
```

- Customer name uses canonical CRM `companies.name` via `EntityLink` (same upgrade rules as the list).
- The ⋯ kebab houses lower-frequency actions: Attach to existing opp · Mark duplicate · Send to leak queue · Snooze · Copy permalink.
- Header stays sticky on scroll.

### 4.2 Lane card

```
BELVIDERE, IL  →  STURTEVANT, WI
Reefer · 38,000 lbs · pickup Tue Apr 30 · 2 stops
[mini map placeholder — origin pin / dest pin]
```

- Same `formatCustomerName` / lane formatters used in today's drawer.
- Map is the existing Leaflet snippet, lazy-loaded.

### 4.3 Confidence card (only for `source='email_signal'`)

```
Auto-captured by autopilot   ●●●●●○○ 94 · high
Why: Subject contains "pricing" · Body has lane + equipment + pickup date
[View signal trace →]                  [Override: not a quote request]
```

- "Override: not a quote request" is the rep escape hatch — it sends the row to the leak queue with `decision='not_a_request'` and unlinks the signal. Mirrors the existing `capture_leak_reviews` audit pattern.
- "View signal trace" opens a side modal with the raw extractor output (matched phrases, regex tier, model rationale if any).

### 4.4 Source thread embed

A compressed conversation preview — not a full inbox pane. Shows up to 3 messages (latest first), each as: subject (only on the first), sender + time, 2-line snippet, attachment count. A footer link "Open full thread in Conversations →" routes to `/conversations?threadId=<id>`. Clicking any one message opens the existing `EmailThreadViewerModal` anchored to that message.

For non-email sources, this card is replaced by a "Source: TMS import (booking #12345)" / "Source: Manual entry by Maria S. on Apr 28" card.

### 4.5 Pricing intel mini-panel

Recommended price band with sparkline of last N won on this lane. Reuses the existing `PricingRecommendationCard` and `PricingIntelligencePanel` components verbatim — same gating (`outcomeStatus === "pending"` only), same lookup keys.

### 4.6 Activity timeline

Vertical list of `quote_events` for this opp, newest first, colored dots:

- emerald → won / mark_won
- red → lost / mark_lost / sent_to_leak_queue
- amber → auto-flips, manual overrides
- sky → outbound replies, quotes sent
- muted → assignments, snoozes, system bookkeeping

Each entry shows: event label, actor (`auto:phase2b`, `auto:outbound_reply`, `system`, or username), absolute time, and any payload-derived enrichment (matched phrase, body excerpt, deep link to triggering email via existing `OutboundReplyEventLink` and flip-context patterns).

Phase 2b specifically writes events with these `actor` strings (already specced in the 2b plan): `auto:phase2b_create`, `auto:phase2b_attach`, `auto:phase2b_skip_internal`, `auto:phase2b_skip_low_confidence`. The drawer renders each with a one-line plain-English label so reps don't have to read code.

### 4.7 Quick actions strip (sticky bottom)

```
[Send reply]  [Log call]  [Add note]  [Create task]
```

Each routes through the existing handler (Send reply opens the existing reply composer pre-targeted at the source thread; Log call opens the Webex click-to-call modal pre-filled with the customer's primary contact; Add note + Create task are inline forms).

### 4.8 New-contact-review section

Renders only when `needsNewContactReview` is non-null on the row, identical to today's `NewContactReviewSection` (Add / Dismiss → `POST /api/customer-quotes/quote/:id/new-contact-review`). Carry over unchanged.

---

## 5. Actions catalog (with API contracts)

For each action: `Trigger` → `Permission` → `UX behavior` → `API contract`.

### 5.1 Open detail drawer

- Trigger: row click, enter on focused row, deep link `?quote=<id>`.
- Permission: `isQuoteOpportunitiesRole(role)` (existing helper in `@shared/quoteOpportunitiesRoles`).
- UX: drawer opens, URL updates, focus moves to drawer header.
- API: `GET /api/customer-quotes/quote/:id` (exists).

### 5.2 Assign / reassign rep

- Trigger: click on Rep avatar in row, or click rep selector in drawer header.
- Permission: any role with quote-opportunities access; reassigning across reps requires director/admin/sales_director.
- UX: combobox popover (type-ahead users in same org). Optimistic update; revert on failure with toast.
- API: existing `PATCH /api/customer-quotes/quote/:id` accepts `{ repId }`. **Confirmed exists** — same shape used by today's drawer.

### 5.3 Mark won / mark lost

- Trigger: split-button in drawer header, `w` / `l` keyboard shortcut on focused row.
- Permission: assigned rep, the rep's manager, or admin/director.
- UX: split button. Mark won → inline form (final price, carrier optional, margin). Mark lost → inline form (reason chip selector from `STATUS_LABELS` lost_* keys + free-text). Both confirm in-place; the drawer status pill flips and a timeline event appears within 200ms (optimistic).
- API: existing `PATCH /api/customer-quotes/quote/:id` accepts `{ outcomeStatus, outcomeReasonId?, carrierPaid? }`.

### 5.4 Attach to existing opp (manual override of 2b auto-attach)

- Trigger: kebab → "Attach to existing opp."
- Permission: admin / director / sales_director.
- UX: typeahead combobox over open opps in the same customer/lane neighbourhood; confirm dialog ("This will close the current request and re-route its activity onto opp #4821."). Optimistic, with revert on failure.
- API: **The existing leak-attach endpoint does NOT cover this case.** Today's `POST /api/customer-quotes/funnel-diagnostics/leaks/attach` (body `{ messageId, targetQuoteId }`) only attaches an orphan-outbound `email_messages` row to a quote — it does not collapse one `quote_opportunities` row into another. A new endpoint is required: `POST /api/customer-quotes/quote/:id/attach-to` with body `{ targetOppId, decision: 'attached' | 'duplicate' }`. Server: (a) re-points the source thread's `email_signals.linked_opportunity_id` to `targetOppId`, (b) closes the source opp with `outcomeStatus='attached'` (new outcome value — see §9 OPEN), (c) writes paired `quote_events(quoteId=targetOppId, actor='manual_leak_attach', payload={fromOppId})` + a `capture_leak_reviews(decision='attached')` row keyed off the source thread's most recent inbound `email_messages.id`. Reuses the existing in-process mutex from `attachOrphanOutboundToQuote` to prevent duplicate-attach races.

### 5.5 Send quote reply (handoff to composer)

- Trigger: header `[Send quote]` button, drawer quick action.
- Permission: assigned rep, admin/director.
- UX: opens the existing reply composer pre-targeted at the source thread, pre-populated with pricing-recommendation values if available. On send, an outbound `email_messages` row is written, the timeline gets an `outbound_reply` event, and the row's `outcomeStatus` flips from `pending` to `quoted` via the existing autopilot.
- API: **No reply-send endpoint exists yet.** Today the codebase has `POST /api/email-drafts/generate` (AI drafting) but no UI-facing send-thread-reply route — the existing send paths are limited to procurement outreach (`server/routes/procurementOutreach.ts`) and quote-lifecycle autopilot (server-side only). The post-2d UI task (or a dedicated predecessor task) must add `POST /api/email-conversations/:threadId/reply` with body `{ subject?, bodyText, bodyHtml?, attachments?, draftSource? }`. Server writes the outbound `email_messages` row, dispatches via the existing mailbox-aware send service, and writes the `outbound_reply` `quote_events` entry. Composer UX itself (modal/drawer/inline) is not specified here — pick one of the three existing composer affordances.

### 5.6 Send to leak queue (escalate)

- Trigger: kebab → "Send to leak queue."
- Permission: assigned rep, admin/director.
- UX: confirm dialog with reason selector (`not_a_request` / `unparseable` / `wrong_party` / `other` + free-text). On confirm, the opp is closed (`outcomeStatus='no_response'` with `outcomeReasonId='sent_to_leak_queue'`), a `capture_leak_reviews` row is written with `decision='returned_to_queue'`, and the row drops from this tab.
- API: **Needs new endpoint AND a schema change.** Endpoint: `POST /api/customer-quotes/quote/:id/send-to-leak`, body `{ reason, note? }`. Schema: today `CAPTURE_LEAK_REVIEW_DECISIONS = ['not_quote', 'ignored', 'attached']` (`shared/schema.ts`). The implementer must extend that enum to include `returned_to_queue` (and `not_a_request`, `duplicate` — see §5.7 / §5.13) and update `buildLeakCandidateIds` so returned-to-queue rows resurface in the leak queue. Server writes the `quote_events` + `capture_leak_reviews` pair under the same in-process mutex used by attach.

### 5.7 Mark duplicate

- Trigger: kebab → "Mark duplicate."
- Permission: assigned rep, admin/director.
- UX: typeahead over open opps (same as Attach but framing is different — duplicate means "we already have this request as opp #X, drop this one"). Confirm dialog explains what happens.
- API: **Reuse** the new §5.4 `POST /api/customer-quotes/quote/:id/attach-to` contract with `decision: 'duplicate'`. Same enum-extension prerequisite (`duplicate` must be added to `CAPTURE_LEAK_REVIEW_DECISIONS`).

### 5.8 Snooze

- Trigger: kebab → "Snooze for…" (4h / tomorrow morning / Mon 8a / custom).
- Permission: assigned rep.
- UX: row disappears from default views (filtered by `snoozedUntil > now()`), reappears at the snooze time. Drawer header shows a snoozed banner.
- API: **Needs new endpoint** — `PATCH /api/customer-quotes/quote/:id/snooze` with `{ snoozedUntil: ISO }`. New column `quote_opportunities.snoozed_until timestamptz null`. The implementer adds the column + endpoint + hides snoozed rows from list endpoints unless an explicit `includeSnoozed=1` filter is passed.

### 5.9 Reopen / unsnooze

- Trigger: drawer header banner "Snoozed until 8:00 AM Mon — Reopen now."
- Permission: assigned rep.
- API: same `PATCH /api/customer-quotes/quote/:id/snooze` with `{ snoozedUntil: null }`.

### 5.10 Today's automation counters (read)

- Trigger: page load, refresh every 60s.
- Permission: any role with quote-opportunities access.
- API: **Reuse Phase 2b's extended leakage-stats endpoint.** Phase 2b extends `GET /api/admin/conversations/leakage-stats` (server/routes/conversationsLeakage.ts) with four new closure counters per window — `closure.created`, `closure.attached`, `closure.skipped_internal`, `closure.skipped_low_confidence` (plus `would_*` dry-run variants when the flag is OFF). The post-2d UI reads those counters directly from the `today` window of that response and renders the automation strip from them. **DO NOT** aggregate `quote_events.actor LIKE 'auto:phase2b_%'` for skipped-counter math — `quote_events.quote_id` is `NOT NULL` (`shared/schema.ts:5413`), so skipped-internal / skipped-low-confidence decisions cannot be persisted there. The leakage-stats endpoint reads them from the closure service's per-window in-memory or persisted counter store (whichever Phase 2b lands on). **Permission caveat:** `/api/admin/conversations/leakage-stats` is currently admin/director/sales_director only. For the post-2d tab to expose counters to reps, either (a) gate the strip on elevated roles and hide it for reps, or (b) add a sibling endpoint `GET /api/quote-requests/automation-counters?window=today` that proxies just the four counters with rep-readable role gating. Default recommendation: option (b) — the counters are non-sensitive operational telemetry and reps benefit from the closure visibility.

### 5.11 New quote (manual create)

- Trigger: top-bar `[+ New quote]` button.
- Permission: any role with quote-opportunities access.
- UX: existing manual-create flow (the legacy page already has it). Carry over unchanged.
- API: existing `POST /api/customer-quotes/quote` (server/routes/customerQuotes.ts:249) — same payload, same validation. (The legacy page route name `/customer-quotes/list` is the GET list endpoint, not the create endpoint.)

### 5.12 New-contact-review (Add / Dismiss)

- Trigger: amber section in drawer when `needsNewContactReview` is set.
- API: existing `POST /api/customer-quotes/quote/:id/new-contact-review`. Carry over unchanged.

### 5.13 Override autopilot ("not a quote request")

- Trigger: button on the Confidence card in the drawer.
- Permission: assigned rep, admin/director.
- UX: confirm dialog. Closes the opp, writes a `capture_leak_reviews` row with `decision='not_a_request'` (requires the same enum extension as §5.6), and writes a sender-mapping suppression row so the autopilot learns. Toast: "Marked as not a request. The autopilot will skip similar emails from this sender." Undo for 5s.
- API: same `POST /api/customer-quotes/quote/:id/send-to-leak` (§5.6) with reason `not_a_request`. Implementer can collapse or split. Sender-mapping suppression is a separate write to whatever table holds the customer-sender-domain learnings (`replit.md` references "Customer sender domain learning" — confirm exact table during implementation).

### Permission summary table

| Action | Rep (own) | Rep (other's) | Manager | Admin/Director |
|---|---|---|---|---|
| Open drawer | ✓ | ✓ (read-only mutations gated) | ✓ | ✓ |
| Assign / reassign | own → self | — | ✓ | ✓ |
| Mark won/lost | ✓ | — | ✓ | ✓ |
| Attach / duplicate | — | — | — | ✓ |
| Send reply | ✓ | — | ✓ | ✓ |
| Send to leak | ✓ | — | ✓ | ✓ |
| Snooze | ✓ | — | ✓ | ✓ |
| Override autopilot | ✓ | — | ✓ | ✓ |
| New quote (manual) | ✓ | n/a | ✓ | ✓ |
| Read counters | ✓ | ✓ | ✓ | ✓ |

---

## 6. Empty / loading / error / slow / permission-denied states

### 6.1 Empty — zero rows in the current window

Calm, declarative, broker tone. No exclamation marks. No emoji.

```
No quote requests today.
23 emails were auto-evaluated and skipped (3 internal forwards, 5 low confidence).
                       [Review skipped]   [Show last 7 days]
```

A single muted Lucide `Inbox` icon, moderate size. The "Review skipped" link routes into the Capture Leak Queue pre-filtered. The "Show last 7 days" button widens the age filter inline.

### 6.2 Empty — filters return zero (but the unfiltered set is non-empty)

Different copy:

```
No requests match these filters.
                                      [Clear filters]
```

### 6.3 Loading

- First load: skeleton table — 12 rows of muted bars matching column widths. KPI tiles also skeletoned. Use shared `Skeleton` primitive.
- Background refetch: subtle 2px progress bar at the top of the table, no skeleton (don't blank known data).

### 6.4 Slow load (>2s with no first response)

After 2s, the loading state shows an inline message under the skeleton: "Still loading — large window or slow network." After 8s, the row count tile flips to "—" and a "Retry" button appears.

### 6.5 Error

Use `ErrorBanner` shared primitive at the top of the table area:

```
We couldn't load quote requests. The team has been notified.
                                                     [Retry]
```

A small "Show details" link expands to the (sanitized) error string for support context.

### 6.6 Permission denied

```
You don't have access to Quote Requests.
Ask your administrator to grant the Quote Opportunities role.
```

Hard-coded role check via `isQuoteOpportunitiesRole` before the page mounts; no API roundtrip needed. Logged-out users hit auth bounce as usual.

### 6.7 Empty drawer (no row selected after navigating to `?quote=X` that doesn't exist)

```
We couldn't find that quote request.
It may have been merged into another opportunity or deleted.
                                                  [Back to list]
```

---

## 7. Keyboard navigation

Consistent with the existing command palette (Cmd-K) and the cross-tab UX layer. All shortcuts only fire when the table region has focus (or the drawer for drawer-scoped ones).

| Key | Action | Scope |
|---|---|---|
| `j` / `↓` | Next row | Table |
| `k` / `↑` | Prev row | Table |
| `enter` | Open drawer for focused row | Table |
| `esc` | Close drawer | Drawer open |
| `e` | Open assign-rep popover for focused row | Table |
| `w` | Mark won (inline form) | Drawer or focused row |
| `l` | Mark lost (inline form) | Drawer or focused row |
| `r` | Send reply (opens composer) | Drawer |
| `s` | Snooze… (popover) | Drawer or focused row |
| `/` | Focus search box | Page |
| `g` then `q` | Jump to Quote Requests from anywhere | Global (via existing palette router) |
| `Cmd/Ctrl-K` | Open command palette | Global |
| `?` | Show shortcut help sheet | Page |
| `[` / `]` | Prev / next page | Table |

The footer keyboard hint pill ("j/k · enter · e · w") is the discovery affordance — not a tutorial overlay.

---

## 8. Cross-surface boundaries

This is the section that prevents this work from quietly recreating the leak it was supposed to seal.

### 8.1 Where does an `email_signal`-sourced opportunity appear?

| Surface | Appears? | Form |
|---|---|---|
| **Quote Requests tab** | YES — primary | One row, full lifecycle. |
| **Conversations Inbox** | YES — as the original email thread | Thread carries a "Quote request: #QR-1042" badge linking back to the opp. The thread itself is not a Quote Request; it is the email transport. |
| **Capture Leak Queue** | NO | The whole point of 2b. The leak queue only shows signals the autopilot intentionally skipped or could not classify. |
| **Legacy Customer Quotes page** | N/A — page is removed (redirect-only) | See §2 LOCKED table. |

### 8.2 Cross-links

- **Quote Requests row → source email thread:** Cmd/Ctrl-click on row, or "Open full thread" link in drawer. Lands on `/conversations?threadId=<id>` with the thread expanded.
- **Conversations thread → Quote Request:** if a thread has a linked opp (`linked_opportunity_id` on any of its signals OR thread-level resolution), the thread row in the inbox shows a small "Quote request" badge; clicking the badge opens the Quote Request drawer (URL `/quote-requests?quote=<id>`).
- **Quote Requests → Capture Leak Queue:** automation strip "Review skipped" link, plus the "Send to leak queue" action on a row.
- **Capture Leak Queue → Quote Requests:** existing "Attach to existing opp" already routes the user back to the opp's drawer — that drawer is now the Quote Requests drawer (same component, same URL pattern).
- **Admin Integrations Health → Quote Requests:** the Phase 2a leakage tile gets a "View today's autopilot decisions" footer link to `/quote-requests?strip=automation`.

### 8.3 Deduplication rule (the contract that kills the duplicate-row class of bugs)

If a single underlying customer request would otherwise appear as both a Quote Request row AND a separate Conversations thread badge AND a leak queue row, the order of precedence is:

1. **Quote Request row wins.** The row is the canonical artifact.
2. The Conversations thread shows the badge but no second "needs quoting" treatment.
3. The leak queue row is auto-removed (Phase 2c invariant — the autopilot owns this) and never shown.

This precedence is enforced server-side. The UI does not have to do this filtering — but the spec calls it out so reviewers can verify the post-2d implementation honors it.

### 8.4 What does the legacy Customer Quotes page become?

- `/customer-quotes` and `/customer-quotes?...` 301-redirect to `/quote-requests` preserving query string.
- Saved-views migration runs once at boot (idempotent), translating legacy filter keys into the new shape.
- `customer-quotes.tsx` file is deleted in the post-2d implementation task; `customer-quotes-presets.ts` is kept (constants reused) and re-exported under the new route.
- Internal cross-links (`setDrawerId(id)` from `ActionQueueCard`, `ValidityWindowModule`, alerts panels, etc.) are rewired to `/quote-requests?quote=<id>` via a one-shot find-replace in the implementation task.
- The analytics half of the legacy page (KPI snapshot, lane variance, attractiveness, alerts panels) moves to a dedicated **Quote Analytics** surface — explicitly out of scope here, called out as a follow-up task.

---

## 9. OPEN questions (need user sign-off before implementation task is created)

Each question gets a **recommended default** the implementer should use if the user does not weigh in.

1. **Should snoozed rows be hidden by default or shown with a snoozed badge?**
   *Recommended default:* Hidden by default; revealed by an explicit "Include snoozed" toggle in the filter row (off by default, persists per-user). Snoozing is operator self-care, not data hiding from peers.

2. **Should the legacy `customer-quotes.tsx` be deleted in the post-2d UI task, or kept around for one release as a feature-flagged fallback?**
   *Recommended default:* Delete in the same PR. Two pages with the same data is what got us here. A safer rollback is to revert the PR.

3. **For `source != 'email_signal'` rows (TMS, manual, spot-search), do they get the Confidence card?**
   *Recommended default:* No. The card is replaced by a "Source: TMS import (booking #12345)" / "Source: Manual entry by Maria S." card. Confidence is meaningful only for autopilot-extracted requests.

4. **Should the automation strip be visible to all roles, or only admin/director/sales_director?**
   *Recommended default:* Visible to all. The counters are operator context — "the autopilot caught 47 today, 5 of which need a human eye" is exactly what a rep needs to know to trust the queue. Hiding it would re-create the trust-gap that motivated 2a in the first place.

5. **Free-email senders — soft chip or hard filter?**
   *Recommended default:* Soft amber chip on the row, plus a "Free-email senders" filter toggle in the filter row. Don't auto-route them anywhere — the autopilot already decides whether to create or skip based on confidence, not on sender domain.

6. **Per-row "Override autopilot" — does it write a sender-mapping suppression on the offending sender, or only on the offending sender + lane combination?**
   *Recommended default:* Sender + lane combination. A single false positive shouldn't permanently mute a customer's entire inbox.

7. **Does the Quote Analytics surface (the legacy page's analytics half) live under `/quote-requests/analytics` or as a separate top-level `/analytics/quotes` route?**
   *Recommended default:* `/analytics/quotes` — analytics is a different mental mode than triage. The Quote Requests tab stays focused on "the operator's day."

8. **Should `g q` keyboard shortcut conflict-check against existing `g` mappings in the command palette router?**
   *Recommended default:* Implementer audits the palette's `g`-prefixed mappings during build; if `g q` is taken, fall back to `g r` (requests). Document the chosen mapping in `replit.md`.

9. **Is the `snoozed_until` column allowed to be nullable, or do we want a boolean `is_snoozed` plus a timestamp?**
   *Recommended default:* Single nullable `snoozed_until timestamptz`. Boolean adds a denormalization risk; the indexed predicate `snoozed_until IS NULL OR snoozed_until <= now()` is fine.

10. **Hover-card preview on Activity cell — does it count against an SSE subscription budget?**
    *Recommended default:* No. Hover preview reads from the already-fetched list payload. We don't open a new subscription per row.

11. **(BLOCKING) `QUOTE_SOURCES` enum — extend or fold `email_signal` into `email`?**
    Today `shared/schema.ts:5276` declares `QUOTE_SOURCES = ['email', 'tms', 'crm', 'manual', 'import']`. The spec uses `email_signal` (and `spot_search`) as if they were distinct values. They are not. Folding into `email` loses the distinction between "raw inbound email" and "Phase 2b autopilot-classified email signal," which the Confidence card (§4.3) and the source filter (§3.4) depend on.
    *Recommended default:* Extend the enum to `['email', 'email_signal', 'tms', 'crm', 'manual', 'import', 'spot_search']`. Backfill existing `email`-source rows that have a non-null `email_signals.linked_opportunity_id` link to `email_signal`. Update the Zod validator on `POST /api/customer-quotes/quote` to accept the new values. Implementer must land this migration in the same PR that introduces the Confidence card and the source filter, or those features will throw at runtime.

12. **(BLOCKING) `CAPTURE_LEAK_REVIEW_DECISIONS` enum — extend or repurpose `not_quote`?**
    Today `shared/schema.ts:5434` declares `['not_quote', 'ignored', 'attached']`. The spec writes `'returned_to_queue'` (§5.6), `'duplicate'` (§5.7), and `'not_a_request'` (§5.13) — none exist. The implementer also needs to update `buildLeakCandidateIds` (server/services/customerQuotes.ts) so `returned_to_queue` rows resurface in the leak queue while `attached` / `duplicate` / `not_quote` / `not_a_request` rows stay suppressed.
    *Recommended default:* Extend to `['not_quote', 'ignored', 'attached', 'returned_to_queue', 'duplicate', 'not_a_request']`. Land the enum + the `buildLeakCandidateIds` predicate change + the new `POST /api/customer-quotes/quote/:id/send-to-leak` endpoint in the same PR. Add a guardrail in `tests/code-quality-guardrails.test.ts` that fails if anyone reduces the enum.

13. **(BLOCKING) `quote_opportunities.outcomeStatus` — does `'attached'` need to be a new outcome value?**
    §5.4 closes the source opp with `outcomeStatus='attached'` so the row drops from active queries while the audit trail survives. Today's outcome statuses (e.g. `pending`, `quoted`, `won`, `lost`, `no_response`) do not include `attached`. Forcing it into `no_response` with `outcomeReasonId='attached_to_other'` works but pollutes lost-rate metrics.
    *Recommended default:* Add `'attached'` to the outcome enum. Exclude it from win-rate / lost-rate denominators in analytics (it's a re-routing, not a competitive outcome). Implementer audits every query that filters on `outcomeStatus` and adjusts.

---

## 10. Mockup index

The three Canvas mockups live in `artifacts/mockup-sandbox/src/components/mockups/quote-requests-post-2d/`:

| File | Shows | Canvas iframe id |
|---|---|---|
| `PopulatedList.tsx` | Top bar + KPI strip + filter row + automation strip + dense table (14–18 rows, mixed statuses) + footer pagination | `qr-list-view` |
| `RowAndDetailDrawer.tsx` | Same page chrome with the detail drawer open over a selected row | `qr-detail-view` |
| `EmptyState.tsx` | Same page chrome with the empty-state body (zero rows, "23 evaluated and skipped" callout, "Show last 7 days" helper) | `qr-empty-state` |

Each renders into a 1280×900 iframe, dark-mode-first, no emoji. They are visual references — the implementer should treat the spec above as authoritative when the mockup and the spec disagree.

---

## 11. Sign-off checklist

- [ ] User has reviewed the LOCKED table in §2 and not flagged anything for re-litigation.
- [ ] User has answered the 10 OPEN questions in §9 (or accepted the recommended defaults).
- [ ] User has eyeballed the three mockups on Canvas and confirmed the visual direction.
- [ ] Phase 2b has been live in production for ≥ 5 business days with stable counters.
- [ ] Phase 2c (capture-leak auto-empty) has been live for ≥ 3 business days.
- [ ] Phase 2d (legacy fold-in / redirect plan) has been agreed.

When all six are checked, this spec graduates to the post-2d UI implementation task.
