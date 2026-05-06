# Pilot Rollout Notes — Hero Loop (4 tabs)

Companion to `docs/hero-loop-email-to-load.md`. This file is written for
the pilot user group (reps + LMs) and the people running the pilot. It
describes **what ships today**, what's deliberately out of scope, and the
shortest path through the four tabs.

The hero loop is:

```
Customer email
  → Conversations            (org inbox / triage)
  → Customer Quotes          (Needs Routing → Mine → Won)
  → Available Freight        (LM cockpit, ready_to_send)
  → Lane Work Queue          (carrier outreach for the matching lane)
```

## 1. What reps should expect

### Conversations
- The rep's default bucket is **Waiting on me**. The audience filter is
  sticky per user — confirm it's set to **Customers** during the pilot.
- New customer emails appear here automatically. The rep does **not**
  need to forward, tag, or "promote" the email. The capture pipeline
  hands it to Customer Quotes (Needs Routing) on its own.
- If the sender is unknown, the row still appears with an
  **`Inferred: From contact`** or attribution badge. A one-click
  **Confirm account attribution** action in the right-side smart pane
  hard-links the thread to the suggested company.
- The detail pane shows the **AI thread summary** (cached, regenerable)
  and a single **Suggested next action** (`draft_reply`,
  `quote_request_reply`, `mark_resolved`, `await_response`,
  `confirm_account_attribution`).
- For pricing emails the rep can also use the row's **"This should be
  a quote"** overflow action to force a re-route into Customer Quotes.
- **Known pilot gap:** there is no "Linked to Quote #…" pill on
  Conversations rows yet. Once a rep converts an email into a quote,
  the visible follow-up lives in **Customer Quotes**, not back in
  Conversations. See § 4 below.

### Customer Quotes
- The default view is **All reps · all statuses · today**. Toggle
  **Mine only** (top-right) to narrow to the rep's own pipeline.
- The **Needs Routing** tab is the chokepoint where new email-captured
  quotes land before assignment. Reps clear them by clicking
  **Customer** (or rejecting) on the `NeedsRoutingPanel` row. After
  Confirm, the quote appears in the rep's **Mine** queue.
- The **Mine empty state is honest**. If no rows exist for "today"
  but pending requests exist in the last 7 days, the page renders a
  **`Show last 7 days`** affordance — it does **not** silently widen
  the window.
- The **Won** affordance lives in the row's detail drawer header.
  - If a quoted price is already on file, clicking Won updates the
    quote and fires the AF handoff in the same transaction.
  - If no price is on file, the **Mark Won — capture price** dialog
    opens to capture price + valid-through.
  - A `Quote updated` toast confirms the write.
- The **activity timeline** (in the drawer) shows the canonical record
  of what happened. The rep should see a new
  **`Auto-routed to Available Freight (opportunity <8-char id>…)`**
  entry the moment the converter commits. This is the rep's "did
  anything happen?" signal.
- Response-time pills:
  - `Reply Xm` — time to first outbound reply (green ≤15m, amber ≤60m,
    red >60m).
  - `Quote Xm` — time to first priced reply (green ≤60m, amber ≤240m,
    red >240m).
  - These are **derived**, read-only — the rep cannot edit them, and
    they are CQ-1..CQ-6 stability-contract critical.

### Available Freight
- The cockpit defaults to **Action** mode with the **actionable**
  pickup window (Upcoming + Recent within grace). Other modes
  (**Coverage**, **Ops & Health**) are intentionally hidden until the
  rep needs them.
- Owner scope is **sticky per user**. Reps land on whatever scope they
  used last (their own browser only — pilot teammates do not bleed
  state into each other).
- A row created by a won customer quote carries a **green
  `From won quote`** badge. Clicking the badge deep-links to
  `/quote-requests?quote=…` so the rep can see the original email
  context.
- A row carrying any AF handoff also carries the standard urgency,
  freshness, and "why surfaced" badges. Hover the **Why** badge for
  the bucket reason (e.g., `proven`, `rep_added`).
- If the visible list is empty, the **`HiddenCountsDisclosure`** under
  the table explains *why*: "0 matching · N hidden by status · M past
  pickup · K hidden by owner". Stale rows can be revealed via
  **`Reveal stale`**.

### Lane Work Queue
- The default mode is **Strategic** — lanes that need attention,
  ranked by composite score.
- A lane appears in LWQ when it has **≥6 moved loads in the rolling
  last 30 days** (sourced from `freight_daily_upload_fact`, written by
  the unified ReplitDailyUpload). The reason is shown on the
  **Qualification chip** (`12× / 30d`) — hover for `lastMovedAt`,
  `supportingCustomers`, and `recentCarriers`.
- Lanes with active won quotes show a green **`N active won`** chip.
  Clicking it deep-links to `/available-freight?lane=…` filtered to
  that lane signature. The count and the rows it links to **always**
  agree because both come from the same `buildOpenOppContextByLaneSig`
  aggregator.
- Click a row to open the **Carrier Outreach Panel**. Press `L` (or
  use the row's overflow menu) to open the larger **Lane Cockpit**
  sheet for full intelligence + market signals.

## 2. What LMs should expect

LMs run mostly inside Available Freight and Lane Work Queue. The two
shortcuts:

- **AF row → originating quote.** Click the **`From won quote`** badge
  to land on `/quote-requests?quote=…`. Use this to confirm the
  customer commitment and any priors carried in the source email.
- **LWQ chip → AF cockpit.** Click the **`N active won`** chip to
  drop into AF pre-filtered to that lane signature. Use this when the
  lane row says "active won" but the rep doesn't see why.
- **Quote activity timeline → AF.** When the LM opens a quote drawer,
  the timeline names the auto-routed opportunity id. Today this is
  **text only** — see § 4 for the planned link.
- For hero-slice customers the LM should expect rows with status
  **`ready to send`** and an emerald `From won quote` badge to appear
  **without any filter change** in their default cockpit view. No
  NAM/AM approval popup blocks the handoff.

## 3. Known pilot limitations

These are the parts of the loop that **work but feel rough**. They are
flagged here so pilot users do not file them as "broken."

| Area | Limitation | Workaround |
|---|---|---|
| Conversations | No "Linked to Quote #…" pill on rows. After conversion, the email looks unchanged in Conversations. | Use Customer Quotes' Needs Routing tab as the source of truth for "did this email get captured?" |
| Customer Quotes | Won toast is generic (`Quote updated`). It does not say "Auto-routed to AF" vs "Sent to NAM/AM popup." | Open the activity timeline to see the canonical narrative; AF handoff lands within ~1s of Won. |
| Customer Quotes | Activity timeline names the AF opportunity id but does not link to it. | Reps can read the id; LMs can search AF for it. AF → Quote direction does work via the badge link. |
| Available Freight | Mode selector (Action / Coverage / Ops) has no inline description. New users must learn the difference. | Stay in Action for the pilot; the other modes are not pilot-required. |
| Available Freight | Default scope/mode is sticky in browser localStorage. A pilot user moving between machines may see different defaults. | Use the URL `?owner=me&pickupScope=actionable&mode=action` to lock a scope when sharing links. |
| Lane Work Queue | LWQ qualification depends on the daily upload. If the upload is late, eligibility is late. | Watch the **Unified Upload Freshness Pill** in the LWQ header — it shares state with Financials and AF. |
| All four tabs | Keyboard shortcuts (`L`, `S`, `Shift+Enter`) are not discoverable inline. | Trainers should demo them once; they are not required for the basic loop. |

## 4. The fastest path through the loop (rep + LM script)

This is the script the pilot trainer should walk through with each
user. It assumes the hero slice is configured (`/admin/hero-slice`)
and the global `auto_won_quote_af_handoff` toggle is on.

**Rep (one customer, one lane):**
1. Open **Conversations**. Confirm the new customer email is in
   **Waiting on me**.
2. Open **Customer Quotes** → **Needs Routing**. Find the same email
   surfaced as a draft. Click **Customer** to confirm. The quote
   moves to **Mine**.
3. In **Mine**, open the quote drawer. Reply to the customer with a
   price (uses the source thread). Click **Won**, capture the price
   in the dialog if prompted.
4. In the same drawer, watch the **activity timeline**. The
   **`Auto-routed to Available Freight (opportunity …)`** line
   appears within ~1s. The rep is done.

**LM (same customer, same lane):**
5. Open **Available Freight**. The new row appears with status
   **`ready to send`** and the emerald **`From won quote`** badge.
   Click the badge to confirm the source quote in a new view.
6. Open **Lane Work Queue**. Find the matching lane row — the green
   **`N active won`** chip is now > 0. Click the chip to drop into
   AF pre-filtered to that lane.
7. From the AF row, click into the lane cockpit (or `L` from the
   row) to start carrier outreach. The carrier ranker has already
   produced a top-5 with explainable reasons.

If any step in this script fails for a hero-slice customer, **escalate
to engineering** — the loop is locked behind Sections 1052 and 1076 of
`tests/code-quality-guardrails.test.ts` and a real failure means a
guardrail regression slipped through.

## 5. What is intentionally **not** changing during pilot

- No new entities, no schema changes.
- No email-plumbing changes (capture pipeline, attribution, classifier,
  inbound preservation contract — all locked).
- No CQ-1..CQ-6 stability-contract changes
  (`docs/customer-quotes-stability-contract.md`).
- No carrier-ranking re-weighting.
- No default-scope changes on the four tabs (sticky behavior preserved).

If pilot users push back on any of the above, capture the feedback
under § 6 below; it feeds the **post-pilot** decisions, not in-flight
patches.

## 6. Pilot feedback intake

File pilot friction in the agent inbox with the prefix
**`pilot-hero-loop:`**. The triage rule is:

- **Rollout blocker** → confusing or broken enough that the pilot
  cannot trust the result. Halt rollout; patch immediately.
- **High-friction** → causes hesitation or repeated questions but the
  loop still completes. Batch into a small surgical follow-up
  (≤3 file diff, doc + guardrail in the same commit).
- **Polish** → worth improving but not a pilot blocker. Park for
  post-pilot.

The current open items in this triage are listed in
`docs/hero-loop-email-to-load.md` § 8 (intentional out-of-scope) and
in the audit recorded with this doc's introduction.
