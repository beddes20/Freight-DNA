# Hero Loop: Email → Quote → Won → Load Ready

Task #1069 — minimum-glue proof that a single inbound customer email walks the whole loop:

```
Inbound email
  → Conversations (org inbox)
  → Customer Quotes (Needs Routing → Mine queue)
  → Won
  → freight_opportunities (auto-assigned to LM, status=ready_to_send)
  → Available Freight (LM sees it, no NAM/AM popup)
  → Lane Work Queue (carriers contacted, lane chip surfaces "active won")
```

This document defines the hero slice (one customer, one lane family),
how the auto-assign is configured, and the captured artifacts proving the
walk. Each step calls out the surface a screenshot should be taken on so
the proof is reproducible.

## 1. Hero slice definition

Stored as a single JSON value under the setting key
`hero_slice_auto_assign:<orgId>`. Configure once per org via
`setHeroSlices(orgId, slices)` (see `server/services/heroSliceAutoAssign.ts`).

```json
{
  "slices": [
    {
      "id": "hero-acme-mw-se-vans",
      "customerNamePattern": "ACME LOGISTICS",
      "originStatePattern": "IL|IN|OH",
      "destinationStatePattern": "GA|FL|NC",
      "equipmentPattern": "VAN",
      "lmUserId": "<logistics_manager users.id>"
    }
  ]
}
```

Match rules (pure function `matchHeroSlice`):

- `customerNamePattern` — required, case-insensitive substring match against
  the won quote's customer name.
- `originStatePattern` / `destinationStatePattern` — optional pipe-separated
  state list; the row's value must equal-or-contain one of the tokens
  (case-insensitive). Missing row value fails the optional gate.
- `equipmentPattern` — optional substring (case-insensitive) on the
  normalized equipment type.
- First match wins. Outside the slice, the existing NAM/AM popup
  (`server/routes/wonLoadAutopilot.ts`) remains the only assignment path
  for every other won quote.

## 2. Auto-assign on conversion

The slice is evaluated inside `createFreightOpportunityFromWonQuote`
(`server/services/customerQuotes.ts`) at insert time, in the same advisory-
locked transaction as the freight_opportunities row. When the slice
matches, the row is created with:

| field                    | value                                      |
|--------------------------|--------------------------------------------|
| `status`                 | `ready_to_send`                            |
| `delegatedToUserId`      | `slice.lmUserId`                           |
| `approvedAt`             | `now`                                      |
| `approvedById`           | `actorUserId ?? slice.lmUserId`            |
| `awaitingApprovalSince`  | `null`                                     |

Outside the slice the row is unchanged: `status="pending_approval"`,
`awaitingApprovalSince=now`, no delegate.

A distinct log line is emitted on the auto-assign branch so the proof
walk can grep for it:

```
[customer-quotes] AF handoff created opp=<id> quote=<id> pickup=<iso>
  status=ready_to_send hero_slice=<sliceId> delegated_to=<lmUserId>
```

## 3. Available Freight visibility

`OPEN_OPP_STATUSES` (server/laneCrossLinkService.ts) and the cockpit
default status set both already include `ready_to_send`, and the cockpit
ownership predicate matches on `delegated_to_user_id`, so an LM sees
the auto-assigned row in their default Available Freight view without any
filter change.

## 4. LWQ chip — "active won"

`buildOpenOppContextByLaneSig` now stamps a `wonQuoteCount` field on the
per-lane open-opp context (subset of `count` whose
`sourceRef.type='won_quote'`). The LWQ row renders an `Active won` chip
when the count is > 0, on the same row as the existing live-opps chip,
so the LM sees the email-driven won load alongside the lane it belongs
to. The recurring-lane handoff (`createLwqLaneFromWonQuote`) already
runs from the same `updateQuote`/`createQuote` transition, so a recurring_lane
row exists for every won quote and the chip lands on the right row.

## 5. Proof walk

The code path is locked by Section 1052 of
`tests/code-quality-guardrails.test.ts` (17 assertions on the matcher,
the converter wiring, OPEN_OPP_STATUSES, the LWQ aggregator, and the
LWQ chip). The live walk producing concrete production IDs cannot be
captured from the isolated dev environment because it requires (a) the
real production org, (b) a configured slice pointing at a real
customer + LM, and (c) a real inbound email arriving at a monitored
mailbox. Follow-up Task #1073 ships an admin UI to configure the
slice, which unblocks the live capture; Task #1074 ships the e2e test
that drives the walk synthetically inside CI.

When the live capture runs (capture each screenshot under
`docs/screenshots/hero-loop/`):

| Step | Surface                          | What to capture                                           | ID to record                          |
|------|----------------------------------|-----------------------------------------------------------|---------------------------------------|
| 1    | Conversations inbox              | Inbound email row from the hero customer                  | `email_messages.id`                   |
| 2    | Customer Quotes — Needs Routing  | Same email surfaced as a hint-rich quote draft            | `quote_opportunities.id`              |
| 3    | Customer Quotes — Mine queue     | Quote after rep clicks Confirm & Create, status=Open      | (same `quote_opportunities.id`)       |
| 4    | Customer Quotes — Mine queue     | Same quote, after marking Won                             | (same `quote_opportunities.id`)       |
| 5    | Server log                       | `AF handoff created … status=ready_to_send hero_slice=…`  | `freight_opportunities.id`, `slice.id`|
| 6    | Available Freight (LM session)   | Auto-assigned freight row visible without any filter      | LM `users.id`, `freight_opp.id`       |
| 7    | Lane Work Queue (LM session)     | Same lane row showing the green `N active won` chip       | `recurring_lanes.id`                  |

Walk twice (two distinct emails on the same slice) so the proof shows
the second specimen passing through the same path; record both sets
of IDs in the table above when filling in the live capture.

### Anti-regression: no synthetic moves

Hero-loop conversion MUST NOT write into `freight_daily_upload_fact`.
That table is the single source of truth for "moved loads" and feeds
the LWQ ≥6/30d eligibility rule (Task #1051). Only the unified
ReplitDailyUpload writes to it; quote events (won, hero-assigned, or
otherwise) leave it untouched. Section 1052 asserts that
`server/services/customerQuotes.ts` contains no insert/upsert against
`freight_daily_upload_fact` so a future refactor cannot accidentally
double-count quote wins as moved loads.

## 6. Locked contracts

- Section 1052 of `tests/code-quality-guardrails.test.ts` enforces:
  - `heroSliceAutoAssign.ts` exports `matchHeroSlice` +
    `resolveHeroSliceAutoAssign` and reads the
    `hero_slice_auto_assign:<orgId>` setting.
  - `createFreightOpportunityFromWonQuote` calls
    `resolveHeroSliceAutoAssign` and gates `ready_to_send` /
    `delegatedToUserId` / `approvedAt` on its result.
  - `OPEN_OPP_STATUSES` still contains `ready_to_send` so the LWQ /
    AF live-opp readers count the auto-assigned rows.
  - The LWQ row template renders the `chip-active-won-${laneId}` chip
    keyed off `liveOpps.wonQuoteCount`.
  - The doc itself exists.
- Section 1076 of `tests/code-quality-guardrails.test.ts` enforces the
  cross-tab navigation polish (see § 8 below).

## 7. Walkthroughs

These are the canonical narratives the rollout doc and onboarding refer
to. They name the exact chips, badges, and links that ship today.

### Rep view (account manager / sales)

1. **Conversations.** A new email arrives from a hero customer. The
   rep doesn't need to do anything in this tab — `processUserMailboxEmail`
   has already persisted the message and downstream classifiers will hand
   it to Customer Quotes.
2. **Customer Quotes — Needs Routing.** The same email surfaces in the
   `NeedsRoutingPanel`. The rep clicks **Customer** to confirm intent.
   The quote moves into the rep's "Mine" queue.
3. **Customer Quotes — Mine.** The rep replies with a price and clicks
   **Won** (the `MarkWonDialog` captures price + valid-through if the
   quote has no `quotedAmount` yet). A toast confirms `Quote updated`.
4. **Customer Quotes — Activity timeline.** The rep sees a new
   **`Auto-routed to Available Freight (opportunity <8-char id>…)`**
   entry the instant the converter commits. This is the rep's signal
   that the won quote landed somewhere actionable — no more "did
   anything happen?" guessing. (Backed by Section 1076.)

### LM view (logistics manager)

1. **Available Freight.** A new row appears in the LM's default view
   (no filter changes) with status **`ready to send`** and an emerald
   **`From won quote`** badge. The badge is now a **link** —
   `/quote-requests?quote=<quoteId>` — so the LM can confirm the
   originating customer email in one click. The tooltip carries the
   buy/sell priors from the quote.
2. **Lane Work Queue.** The matching lane row shows the green
   **`N active won`** chip. The chip is now a **link** —
   `/available-freight?lane=<laneSig>` — that drops the LM into the
   AF cockpit pre-filtered to that lane signature, exactly the same
   navigation pattern the sibling `LiveOppsChip` uses. The count and
   the rows it points at always agree because both come from the same
   `buildOpenOppContextByLaneSig` aggregator.
3. **Reverse direction.** From AF the LM can return to Quote Requests
   via the `From won quote` badge; from Quote Requests the timeline's
   `Auto-routed to Available Freight` line carries the opp id so an
   AF cockpit search jumps straight back. The loop is now traversable
   in both directions without breadcrumbs.

## 8. Cross-tab navigation polish (locked)

Section 1076 of `tests/code-quality-guardrails.test.ts` locks the three
small affordances above. Touching any of these requires updating both
the file and the guardrail in the same commit:

| Affordance                                  | File                                       |
|---------------------------------------------|--------------------------------------------|
| `WonQuoteBadge` → `/quote-requests?quote=…` | `client/src/pages/available-freight.tsx`   |
| Active-won chip → `/available-freight?lane=…` | `client/src/pages/lane-work-queue.tsx`     |
| `describeEvent` `af_handoff` case           | `client/src/pages/quote-requests.tsx`      |

Out of scope for this polish pass (deliberate; tracked elsewhere):

- Conversations does **not** render a "linked quote" pill yet — the
  email→quote routing UX lives in the Needs Routing panel of Customer
  Quotes by design, and adding cross-pointers in Conversations would
  duplicate that surface. Revisit only if reps consistently start in
  Conversations rather than Quote Requests.
- The post-Won toast in Customer Quotes stays generic (`Quote updated`).
  The activity-timeline narrative is the canonical place to learn
  "where did this go?", and adding a hero-specific toast would be
  redundant with it (and would race the converter on the rare
  pending-approval path).
- No new entities, no schema changes, no email-plumbing changes.

## 9. Rollout checklist

Before flipping the four tabs from "guarded" to "general availability":

- [ ] **Hero slices configured.** `/admin/hero-slice` lists at least
      one slice; the global `auto_won_quote_af_handoff` toggle is on.
      Each slice's `lmUserId` resolves to a real `logistics_manager`
      (or `logistics_coordinator` / `admin`) in the org.
- [ ] **Rep walk.** Run `npx tsx tests/hero-loop-email-to-load.test.ts`
      against the dev DB. 26/26 assertions must pass.
- [ ] **Guardrails green.** `npx tsx tests/code-quality-guardrails.test.ts`
      reports `0 failed`. Sections 1052 + 1076 must both run.
- [ ] **Manual sanity (AF).** As an LM, load `/available-freight`,
      confirm the `From won quote` badge is clickable and lands on the
      right `/quote-requests?quote=…`. Confirm the row carries
      `ready to send` (not `pending approval`).
- [ ] **Manual sanity (LWQ).** As an LM, load `/lane-work-queue`,
      confirm the `N active won` chip on a hero lane is clickable and
      lands on `/available-freight?lane=…` filtered to that lane.
- [ ] **Manual sanity (Customer Quotes).** As a rep, open a recently
      won hero-slice quote's drawer; the activity timeline shows
      `Auto-routed to Available Freight (opportunity …)`.
- [ ] **Known limitation comms.** Mention to LMs that the chip count
      is "open won-quote AF rows since start of UTC day" — the same
      window `buildOpenOppContextByLaneSig` already uses for live opps.
