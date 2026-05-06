# Available Freight tab — discovery + audit (April 30, 2026)

Read-only investigation. No code or data changed. All numbers are real
counts from the live PostgreSQL database at the time of the audit.

---

## TL;DR — what is actually broken

> **Same-day deep-dive (the question the user actually cares about) is in
> §11 below.** Headline: of 150 freight opportunities with pickup=today,
> **0 are visible** in the default view, **0 have ever been approved**,
> **0 SLA escalations have ever fired**, **87% have no pricing**, and
> **56% are bound to placeholder customers**. Today's same-day surface
> is structurally non-functional, not just under-filtered.

**The default Available Freight view shows zero of the 428 currently-ingested
loads because of a string-name mismatch between the producer and the
consumer.**

- Won Load Autopilot writes new rows with `status = "pending_approval"`
  (`server/services/customerQuotes.ts:2788`).
- The Available Freight UI default "active" filter sends a status whitelist
  that omits that exact string and includes the *similarly named but unused*
  `awaiting_approval` instead
  (`client/src/pages/available-freight.tsx:476`).
- The "Awaiting approval" tab option in the same dropdown also sends
  `awaiting_approval` (line 1287), so the UI has *no* filter that returns
  the rows actually present.

That single mismatch hides 100% of today's ingested loads. Every other
problem listed below stacks on top of it:

| Issue | Rows hidden | % of total |
|---|---|---|
| Status name mismatch (`pending_approval` vs `awaiting_approval`) | 428 / 428 | **100%** |
| Past-CT exclusion (`pickupIso < todayIso`) | 278 / 428 | 65% |
| Lane-signature dupes (12× "Dallas → Laredo Dry Van 4/30", etc.) | 177 / 428 | 41% |
| Won-quote → freight-op silent drop | 16 / 444 won quotes | 3.6% |
| Owner unset (team visibility may hide for solo reps) | 389 / 428 | 91% |

The freshness/refresh layer is fine; the data and filter layers are not.

---

## 1. What the tab is supposed to be

Per the codebase and route names, Available Freight (internally
"Freight Cockpit") is the operating surface for **open, actionable freight
opportunities** that a Logistics Manager / dispatcher can work today: rank,
shortlist carriers, send outreach, mark covered.

It is *not* meant to be:
- a historical load-fact archive (that is `load_fact` + Carrier Hub),
- a customer quote backlog (that is `/quote-requests`),
- nor a long-tail prospecting feed (that is PAFOE).

So the right business question is: **"Which loads are open right now,
ordered by urgency, with enough context for me to either cover them or send
them to carriers?"**

Right now the tab does not answer that question, because by default it
returns nothing.

---

## 2. Data sources

### 2.1 `freight_opportunities` — the only table the page reads

| Column | Type | Notes |
|---|---|---|
| `status` | text | enum-by-convention; producer/consumer disagree (see §4.1) |
| `pickup_window_start/end` | **text** (`YYYY-MM-DD`) | lexical compare via `slice(0,10)` |
| `generated_at`, `expires_at`, `awaiting_approval_since`, `snoozed_until` | timestamp (UTC) | |
| `org_id`, `company_id`, `owner_user_id`, `delegated_to_user_id` | varchar | |
| `urgency_score` | integer 0–100 | computed in `computeCockpitUrgency` |
| `source_quote_id`, `source_ref` (jsonb), `source_file_name` | mixed | identifies ingestion path |

There are **3 nominally-supported producers** and a handful of manual / demo
paths, but only one is producing data in this org today.

### 2.2 Producers — actual contribution

| Producer | File | Cadence | Rows in DB today |
|---|---|---|---|
| Won Load Autopilot | `server/services/customerQuotes.ts` `createFreightOpportunityFromWonQuote` | event-driven on quote `outcome_status → won` | **428 / 428 (100%)** |
| Available Freight Importer (OneDrive spreadsheet) | `server/availableFreightImporter.ts`, scheduled by `availableFreightScheduler.ts` | weekday 6:30 AM CT cron | **0** |
| Proactive Outreach Engine (PAFOE) | `server/proactiveOpportunityService.ts` | wave scheduler / "Scan" button | **0** |
| Manual / `myProcurement` insert | `server/routes/myProcurement.ts` | rep action | **0** |

Confirmed via:
```
SELECT source_ref->>'kind', source_ref->>'type', COUNT(*) FROM freight_opportunities GROUP BY 1,2;
→  (null, "won_quote", 428)

SELECT source_file_name, COUNT(*) FROM freight_opportunities GROUP BY 1;
→  (null, 428)         -- no spreadsheet imports have ever landed for this org
```

### 2.3 `load_fact` — supposed mirror / market-intel table

```
SELECT bucket, COUNT(*) FROM load_fact GROUP BY bucket;
→  (no rows)
```

`load_fact` is **completely empty.** Consequences:
- Carrier Hub "Available Loads" (which reads `bucket='available'`) returns nothing.
- Carrier ranking can't lean on the `realized` bucket — every shortlist
  computes against zero history.
- The `loadFactPowerBIImporter` runs at 5:30 AM and 1:30 PM CT but is gated
  per-org by `getLoadFactScheduleConfig` + `loadFactPowerBiUrlKey`. The fact
  that not a single row exists for any bucket strongly suggests the URL is
  unset for this org and the scheduler is silently no-op'ing.
- Won Load Autopilot is supposed to mirror via `upsertLoadFact`; that
  mirror is not running either (or is failing silently).

---

## 3. Full data path (source → UI)

```
quote_opportunities.outcome_status set to "won"
  └─ server/services/customerQuotes.ts
        markQuoteOutcome / updateQuoteOpportunity
        └─ createFreightOpportunityFromWonQuote
              status = "pending_approval"            ← producer string
              pickup_window_start = clamp_to_today(quote_pickup)
              owner_user_id = quote.assigned_rep_id  ← null for 91% of rows today
              targetBuyRate = quoted_rate * 0.85     ← hardcoded haircut
              source_ref = { type: "won_quote", quoteId, buy, sell }
              upsertLoadFact(...)                    ← appears to no-op
```

```
GET /api/freight-opportunities/cockpit
  └─ server/routes/freightOpportunityCockpit.ts:467
        statusList = req.query.status.split(",")    ← "active" → "new,...,awaiting_approval"
                                                       (does NOT include "pending_approval")
        listFreightOpportunities({ orgId, status: statusList, ... })
          └─ server/storage.ts:9491
                where(eq(orgId), inArray(status, statusList))
                orderBy(desc(urgencyScore), desc(generatedAt))
        → 0 rows when status="active" today.

        Post-query in-memory filters (cockpit route, lines 502–531):
          - drop snoozed
          - drop pickupIso < todayIsoCT
          - resolveVisibleUserIds team scoping
        → for each row, enrich with carriers, pricing blend, KPIs
        → return rows + KPIs + ROI metrics
```

```
client/src/pages/available-freight.tsx:362
  useQuery(["/api/freight-opportunities/cockpit", { status: statusParam, ... }])
    statusParam = "new,ready_to_send,sent,awaiting_carrier_reply,
                   awaiting_customer_confirm,partially_covered,awaiting_approval"
                  ← produces 0 rows because the actual stored status is "pending_approval"
```

### Where loads can be dropped, in order

1. **Producer never fires** — won quote outcome_status set but
   `createFreightOpportunityFromWonQuote` throws or returns early. Currently
   16/444 won quotes (3.6%) have no matching freight opp; nothing logs the
   reason.
2. **Status-name mismatch** — written as `pending_approval`, queried as
   `awaiting_approval`. Hides 100% today.
3. **Past-CT exclusion** — `pickupIso < todayIso` drops loads whose pickup
   date has rolled past midnight CT. 278/428 (65%) currently fall here.
   The Won-Load clamp only fires at insert time; rows written yesterday for
   pickup="yesterday" stay invisible forever.
4. **Visibility scoping** — rows with no `owner_user_id` rely on team-based
   `resolveVisibleUserIds`; for a rep without team membership in the right
   chain, those rows are invisible. 389/428 (91%) of rows have no owner.
5. **Snooze + expire** — currently dropping nothing (0 rows snoozed/expired).
6. **Pagination cap** — limit defaults to 100, max 500, default sort
   `urgencyScore desc, generatedAt desc`. With 428 rows and limit=200 from
   the UI, no truncation today, but at scale a low-urgency same-day load
   could fall off page 1.

---

## 4. Completeness diagnosis — why same-day loads are missing

### 4.1 Primary cause — status whitelist mismatch (CRITICAL)

| Side | String used |
|---|---|
| `server/services/customerQuotes.ts:2788` (writer) | `"pending_approval"` |
| `client/src/pages/available-freight.tsx:476` (default "active" filter) | `"...,awaiting_approval"` (note: `awaiting_`, not `pending_`) |
| `client/src/pages/available-freight.tsx:1287` ("Awaiting approval" UI option) | `"awaiting_approval"` |
| `client/src/pages/my-procurement.tsx:1851` | `"pending_approval"` ✓ correct |
| `client/src/lib/__tests__/cockpitFilters.test.ts:41` | `"awaiting_approval"` ❌ enshrines the wrong string in tests |

There is no `awaiting_approval` row anywhere in the database. Every row uses
`pending_approval`. The mismatch is silent: no error, no warning, just an
empty page.

### 4.2 Secondary cause — past-CT clamp ages out yesterday's loads

`pickupIso < todayIso` (cockpit route line 513) is correct for hiding
*delivered* yesterday loads, but Won Load Autopilot stamps `pickup_window_start`
to whatever the customer wrote in the quote — often "yesterday" or "today"
relative to when the email was parsed. The clamp inside Won Load Autopilot
(`pickupDay` clamped at insert) only runs once. Aging makes those rows fall
off the next day.

Real numbers: 278/428 rows have pickup before today CT. Most are 1–2 days
old. A rep working at 9 AM CT on a Wednesday will not see Tuesday-night
ingested "Wednesday" loads if they were written with pickup="Tuesday".

### 4.3 Tertiary cause — Won-Quote ingestion silently drops 3.6%

```
SELECT q.outcome_status, COUNT(*) AS quotes, COUNT(fo.id) AS ops, COUNT(*)-COUNT(fo.id) AS dropped
FROM quote_opportunities q LEFT JOIN freight_opportunities fo ON fo.source_quote_id = q.id
WHERE q.outcome_status='won' GROUP BY 1;
→  ("won", 444, 428, 16)
```

16 won quotes have no matching freight opp. That means a rep marked the
quote won, but no row showed up on Available Freight. Today there is no
audit trail in `freight_opportunity_audit` for "wanted to create but
couldn't" — likely silent throws inside `createFreightOpportunityFromWonQuote`
(missing company, unparseable lane, equipment normalization failure).

### 4.4 Quaternary cause — alternate producers are dark

- 0 rows with `source_file_name` → `availableFreightImporter` has never
  written to this org. Likely no OneDrive URL configured. The 6:30 AM CT
  scheduler is running but no-op'ing per-org.
- 0 rows with `mode='lane_building'` and 0 with `confidence_flag != 'normal'`
  → PAFOE is either disabled or has not produced anything for this org.
- `load_fact` empty → PowerBI/TMS daily pull is not landing.

If those producers were intended to be live, three independent ingestion
paths are silently dark.

### 4.5 Same-day breakdown today

```
SELECT
  COUNT(*) FILTER (WHERE LEFT(pickup_window_start,10) = today_ct) AS today,
  COUNT(*) FILTER (WHERE LEFT(pickup_window_start,10) < today_ct) AS past,
  COUNT(*) FILTER (WHERE LEFT(pickup_window_start,10) > today_ct) AS future
FROM freight_opportunities;
→  today=150, past=278, future=0
```

So even if the status-name bug were fixed, the rep would see at most
**150 same-day loads** instead of 428 (because 65% are aged-out and 0 are
future-pickup, which itself is suspicious — see §6.2).

---

## 5. Accuracy diagnosis — why displayed loads are wrong

### 5.1 41% apparent duplicates by lane signature

```
SELECT origin, destination, equipment_type, pickup_window_start, COUNT(*)
FROM freight_opportunities GROUP BY 1,2,3,4 HAVING COUNT(*)>1 ORDER BY 5 DESC LIMIT 8;
→
Dallas        → Laredo        Dry Van 2026-04-30  n=12
Macon         → Bridgeton     Dry Van 2026-04-28  n=9
Chandler      → Anniston      Dry Van 2026-04-29  n=8
Columbia      → Memphis       Dry Van 2026-04-29  n=6
Make Sure That→ Are Good      Dry Van 2026-04-29  n=5     ← obvious test/seed data
Grand Prairie → Laredo        Dry Van 2026-04-29  n=5
Calhoun       → Sacramento    Dry Van 2026-04-30  n=5
Topeka        → Franklin Park Dry Van 2026-04-29  n=5
```

Each row has its own `source_quote_id`, so technically these are 12
distinct won quotes for the same lane on the same day. From the rep's
point of view, that lane is one cluster of demand to work, not 12 separate
load tiles. The cockpit's grouping options (by Lane) help, but the default
view does not collapse them.

The "Make Sure That → Are Good" rows are seed/test data that have leaked
into the live ingestion path — those should never appear in production.

### 5.2 Stale / incorrect status

99% of rows are stuck in `pending_approval` for >1 hour (369/428 >4h,
204/428 >24h). The "approval" workflow is functionally abandoned. From a
data-correctness standpoint, the status is technically true but
operationally meaningless: nobody is approving these.

### 5.3 Hardcoded pricing assumptions

`targetBuyRate = quoted_rate * 0.85` is set at insert time and never
revisited. There is no Sonar refresh, no market-aware re-rate, no
last-mile cost lookup. For any load that sits >1h, the buy target is
already stale.

### 5.4 Owner attribution gap

Only 39/428 (9%) have `owner_user_id`. The remaining 91% inherit visibility
from team rules — which means rep attribution is "whoever's on the team",
not "this rep owns it". The UI's "My Loads" saved view is therefore
misleading: most loads have no owner to belong to.

### 5.5 Pickup-date storage is `text`, not `date`

Currently 100% are clean `YYYY-MM-DD` (verified). But lexical comparison
on a `text` column is brittle: a single upstream insert with a full ISO
string (`2026-04-30T08:00:00Z`) would still slice to `2026-04-30` and pass,
but anything malformed (e.g. `04/30/2026` or `2026-4-30`) silently sorts
wrong against `slice(0,10)` of `2026-04-30`. The clean-data check today is
luck, not a guarantee.

---

## 6. Freshness / timeliness

### 6.1 The freshness layer is good

- `useQuery` `staleTime: 30_000` + `refetchOnWindowFocus: true`.
- App-wide SSE via `useLiveSync()`.
- Interaction-aware buffering pill (Task #649) — new updates queue while
  the user is typing, auto-apply after 3s idle.
- 60s polling on KPIs.

This is not where the problem is. A rep refreshing every 30s will get
fresh "0 rows" instead of stale "0 rows."

### 6.2 But ingestion latency is the actual constraint

- Won Load Autopilot is event-driven, so a quote marked won at 9:01 AM
  produces a freight op at 9:01 AM. Good.
- The OneDrive importer runs once a weekday at 6:30 AM CT. A spreadsheet
  uploaded at 7 AM is invisible until 6:30 AM tomorrow.
- The PowerBI pull runs at 5:30 AM and 1:30 PM CT. Mid-morning TMS
  changes are invisible until 1:30 PM.
- There is **no future-pickup row in the entire dataset** (`future_ct=0`).
  Either reps are quoting day-of (plausible for spot freight) or
  forward-dated quotes never made it through the win flow. Worth
  confirming with the user.

### 6.3 No staleness alarm anywhere

There is nothing watching "no inserts in N hours" or "approval queue
> threshold" on Available Freight. The 99%-stale `pending_approval`
backlog has no surface that would tell an admin it's broken.

---

## 7. UX / trust issues

Separate from data correctness, the UI itself has trust-eroding patterns:

1. **"Active queue" returns 0** — the default landing state of the most
   important operating surface shows an empty page with no explanation.
   No "0 of 428 — your filter excludes status pending_approval" hint.
2. **"Awaiting approval" tab also returns 0** — because of the same
   string mismatch. The user has to know to bypass the dropdown entirely
   to see anything.
3. **Sort is by computed `urgency_score`** which is opaque — a 70 is just
   "70" with no tooltip explaining "+15 for today pickup, +20 for tier-1
   customer, ..."
4. **"From won quote" badge** is informational but the rep can't see *which*
   quote without opening the detail drawer, then clicking through.
5. **Pricing column shows Suggested RPM with a Confidence badge** — but the
   blend cache is 90s and the stored `target_buy_rate` is the old 85% haircut.
   The two numbers can disagree on the same row.
6. **No "data freshness" indicator** anywhere — rep can't tell "last
   ingestion was 6 hours ago" vs "12 minutes ago".
7. **Calendar layout swimlanes by pickup day** — but with the past-CT
   clamp, anything dated before today disappears from the calendar entirely.
8. **`Make Sure That → Are Good`** showing in real production rows is a
   trust killer of its own.

---

## 8. Current constraints

- **Status enum is a `text` column with no DB constraint.** Producers and
  consumers can disagree forever, silently.
- **Two pickup-date columns are `text`, not `date`.** Lexical compare is
  the load-bearing operation; one bad upstream and filtering breaks.
- **Two simultaneous "available loads" surfaces** (Available Freight tab
  vs Carrier Hub Available Loads), each reading a different table
  (`freight_opportunities` vs `load_fact`). Drift is structural.
- **No idempotency on Won Load Autopilot at the lane level** — same lane
  + same day for the same customer gets N rows, not one with
  `load_count=N`.
- **No outcome telemetry for Won → Op conversion failures.** 16 silent
  drops are invisible.
- **Per-org load_fact PowerBI URL is required for any TMS visibility.**
  Currently unset for this org → entire load_fact pipeline is dark.
- **No pickup-date roll-forward.** Once a row has `pickup=2026-04-29`,
  it ages out of every view the next morning regardless of whether the
  load is still open.
- **Pricing is set once and forgotten.** No re-rate cron, no Sonar refresh
  tying back to the stored `target_buy_rate`.

---

## 9. Top root causes ranked by business impact

1. **Status-name mismatch (`pending_approval` vs `awaiting_approval`)** —
   100% of current rows hidden. One-line fix; highest possible ROI.
2. **Approval queue abandoned (`pending_approval` is a dead end)** — even
   if the filter were fixed, the rep still has to act on rows nobody is
   triaging. Need to either auto-approve trusted lanes or eliminate the
   approval gate.
3. **Past-CT pickup-date aging** — drops 65% of currently-stored rows.
   Need a roll-forward or a "still-open" semantic that doesn't depend on
   the original pickup date.
4. **Won-Quote silent drops (3.6%)** — a small but invisible leak that
   erodes trust over time. Needs an audit trail and an admin queue.
5. **Lane-signature dupes (41%)** — fixable by upserting on
   `(org, customer, lane, equipment, pickup_day)` with `load_count++`.
6. **load_fact pipeline empty** — Carrier Hub "Available Loads" is
   useless and carrier ranking flies blind. Configure the PowerBI URL
   per-org and let the 5:30 AM / 1:30 PM scheduler do its job.
7. **Test/seed data leaking into prod ingestion** ("Make Sure That →
   Are Good"). Needs a seed-data tag and a production filter.
8. **Owner attribution missing on 91% of rows** — "My Loads" view is
   misleading. Either default-assign at ingest or eliminate the view.
9. **Pricing staleness** — `target_buy_rate` should be derived live, not
   stored at 85% of quoted_rate.
10. **No data-freshness surfacing in UI** — rep cannot tell whether an
    empty page means "no work" or "ingestion is broken."

---

## 10. Phased roadmap

### Phase A — Trust / correctness fixes (days, not weeks)

A1. **Reconcile the status enum.** Pick one canonical name (recommend
    `pending_approval` since the writer already uses it and `my-procurement.tsx`
    already handles it). Update:
    - `client/src/pages/available-freight.tsx:476` (default "active" param)
    - line 1287 ("Awaiting approval" SelectItem value)
    - `client/src/lib/__tests__/cockpitFilters.test.ts:41/43`
    - any analytics queries that count by status
    Add a server-side guardrail that rejects `awaiting_approval` writes and a
    test that asserts the producer/consumer strings agree.

A2. **Strip seed/test data from production ingestion.** Identify
    `Make Sure That → Are Good`-style rows by pattern + by `source_ref`
    tag, hard-delete from prod, and add a producer-side guard that
    refuses to insert obviously-test data unless `NODE_ENV !== "production"`.

A3. **Add a "0 rows but loads exist" hint in the empty state.**
    Server-side, return `totalIgnoredByFilter` alongside `rows.length`
    so the UI can render: "0 matching your filter — 428 in other
    statuses. Show all?"

A4. **Surface ingestion freshness in the page header.** Show
    "Last ingest: 12m ago (Won Load Autopilot)" — pulls from
    `MAX(generated_at)` per source.

A5. **Audit-log Won-Quote conversion failures.** Wrap
    `createFreightOpportunityFromWonQuote` in a try/catch that writes
    to `freight_opportunity_audit` with `event="conversion_failed"` and
    a reason. Add an admin queue at `/admin/integrations-health` to
    surface the 16 currently-missing conversions.

### Phase B — Completeness / freshness fixes

B1. **Roll forward stale pickup dates.** Daily 4 AM CT cron: any row
    with `pickup_window_start < today_ct AND status NOT IN (covered, expired,
    cancelled)` → bump pickup to today and emit a "rolled-forward" audit
    event. Or change the cockpit filter to drop the past-pickup exclusion
    when status is still open.

B2. **Dedupe at the lane level.** Change `createFreightOpportunityFromWonQuote`
    to upsert on `(org_id, company_id, origin, destination, equipment_type,
    pickup_window_start)` with `load_count++` and `source_ref.quoteIds[]`
    appended, instead of inserting a new row. Migrate the existing 177
    duplicates with a one-time backfill.

B3. **Fill the load_fact gap.** Configure the per-org
    `loadFactPowerBiUrlKey`. If the upstream feed is genuinely not
    available, hide the Carrier Hub "Available Loads" tab entirely
    rather than showing an empty surface. Add a heartbeat alert when
    the 5:30/1:30 slots run with 0 inserts.

B4. **Either fix or remove the OneDrive Available Freight Importer.**
    0 spreadsheet rows ever, weekday-6:30-AM cron running daily. Confirm
    with the user whether this path is still expected; if not, delete
    the scheduler. If yes, configure the OneDrive folder per-org and add
    a "last successful import" surface.

B5. **Either fix or remove PAFOE for this org.** Same treatment.

B6. **Replace `pickup_window_start text` with `pickup_window_start date`.**
    One Drizzle migration + a one-time clean-up of any malformed rows
    (none today, but the type guarantee matters going forward). Removes
    the lexical-compare brittleness from every query.

B7. **Eliminate or auto-clear the `pending_approval` chokepoint.** Either:
    - auto-approve when the source quote is from a trusted customer/rep, or
    - convert the popup into a passive notification and start rows in
      `ready_to_send` directly.

### Phase C — Workflow / UX redesign

C1. **Default the page to "Open" not "Active queue."** "Open" =
    everything not in a terminal state. Move "Active queue" to a saved
    view.

C2. **Group by lane by default**, not flat row list. With dedupe in
    place (B2), this is naturally one row per lane-day with a load_count
    and an expandable child list of source quotes.

C3. **Replace the urgency_score number with a "Why" tooltip.** Show the
    component breakdown so reps trust the ranking.

C4. **Pricing column should derive live from Sonar + load_fact**, not
    read the stored `target_buy_rate`. Cache for 90s (the cockpit already
    has this LRU; just stop reading the stored field).

C5. **Add a "data health" pill in the header** with last-ingest time per
    producer + a link to `/admin/integrations-health`.

C6. **Collapse the dual surface.** Decide whether Available Freight
    (`freight_opportunities`) or Carrier Hub Available Loads
    (`load_fact bucket=available`) is canonical and redirect the other.
    My recommendation: `freight_opportunities` is the operating surface
    (rep-actionable) and `load_fact` is the analytical surface
    (history + market). Stop showing `load_fact` rows as if they were
    actionable loads.

### Phase D — Analytics / AI / prioritization opportunities

D1. **Coverage-rate KPI per lane** — once dedupe lands, `load_count` per
    lane-day enables a useful "you covered 7/12 loads on this lane today"
    rollup.

D2. **AI urgency narrative** — feed the urgency components + customer
    history into GPT-4o to produce a one-line rationale per row
    ("Tier-1 customer, $4.2k margin, 3 prior wins on this lane, hot
    pickup window") replacing the opaque score.

D3. **Predictive carrier shortlist freshness** — track which carriers
    actually responded to outreach for similar lane signatures and feed
    back into `rankCarriersForOpportunity`.

D4. **Same-day demand forecasting** — with proper `pickup_date` typing
    and PAFOE active, surface "expected loads not yet ingested" based on
    historical patterns per lane-day-of-week.

D5. **AI-assisted approval auto-clear** — score each `pending_approval`
    row for risk (new customer, unusual lane, margin outlier) and
    auto-approve the safe majority.

---

## 11. Same-day deep-dive — why today's loads cannot be trusted

The original §4 covered same-day at a high level. This section drills into
the cohort `WHERE LEFT(pickup_window_start,10) = today_ct` (150 rows on
April 30, 2026) end-to-end: what's there, what's wrong, and why the rep
sees what they see.

### 11.1 The same-day funnel — actual numbers

```
                                         today-pickup rows
quote_opportunities (won, created today) ─► 86 (100%)  source-of-truth
freight_opportunities (today pickup)     ─► 150        ← carry-over from prior days included
  ├─ visible to default UI filter        ─► 0          ← status mismatch
  ├─ ever approved                       ─► 0          ← approval workflow has never fired
  ├─ have pricing (quoted_rate set)      ─► 19  (13%)
  ├─ have a real customer (not stub)     ─► 66  (44%)
  ├─ have an owner (owner_user_id)       ─► 39  (26%)
  ├─ unique by (origin, dest, equip)     ─► 91         ← 59 dupes (39%)
  ├─ pending_approval > 1h               ─► 145 (97%)
  ├─ pending_approval > 4h               ─► 94  (63%)
  └─ SLA L1/L2 escalation fired          ─► 0 / 0
```

Every same-day load is in `pending_approval`. Every same-day load is
filtered out of the default UI view. No same-day load has ever been
approved or escalated. **The same-day surface is not under-performing —
it has never functioned for a single load.**

### 11.2 What "same-day" means in current logic

Three different definitions are in play, and they don't agree.

| Layer | "Today" definition | Source |
|---|---|---|
| Cockpit route filter | `todayIsoInOrgTz(now)` → `YYYY-MM-DD` in `America/Chicago` | `server/lib/orgLocalDate.ts` |
| Won Load Autopilot pickup-clamp | "if pickup<today, clamp to today" — runs *only at insert* | `customerQuotes.ts:createFreightOpportunityFromWonQuote` |
| `request_date` on quote | UTC timestamp written by quote ingestion | `quote_opportunities.request_date` |

Edge case that bites: a quote ingested at 22:00 CT (3:00 UTC next day)
with pickup written as today's date. The CT-anchored cockpit considers
it "today." The quote's `request_date` (timestamp) crosses UTC midnight.
The Won Load Autopilot writes pickup unchanged. All three agree at
insert time — but at 06:00 CT the next morning, pickup is now "yesterday"
and the cockpit's `pickupIso < todayIso` filter drops it permanently.
A real same-day load just disappeared without changing state.

### 11.3 End-to-end same-day latency (production data)

For the 150 today-pickup rows:

```
generated_at - source_quote.created_at
  avg = 19.2 hours
  min = 0 seconds  (instant — quote created and won in same write)
  max = 56 hours   (quote sat 2+ days before being marked won)
```

The Won Load Autopilot itself is fast (sub-second when triggered).
**Today's latency is dominated by reps sitting on quotes**, not by ingest
machinery. But the system has no surface that says "12 quotes won today
have pickup<=today and are still in `pending_approval` — go act."

### 11.4 The approval queue is a black hole

```
SELECT COUNT(*) FILTER (WHERE approved_at IS NOT NULL) FROM freight_opportunities;
→ 0 / 428
```

Not a single freight opportunity has ever been approved. The
`createFreightOpportunityFromWonQuote` function writes
`status="pending_approval"` and waits "for the NAM/AM popup to assign an
LM" (per code comment line 2788). That popup either:
- doesn't exist in the UI (no surface found in `client/src/pages/`
  matching this pattern),
- exists but is wired to a status not present in the DB, or
- exists but nobody knows it exists.

The SLA sweep (`*/15 * * * *` cron) is supposed to escalate pending
approvals at L1/L2 thresholds. Result on today's loads:

```
SELECT COUNT(*) FILTER (WHERE sla_notified_l1_at IS NOT NULL) AS l1,
       COUNT(*) FILTER (WHERE sla_notified_l2_at IS NOT NULL) AS l2
FROM freight_opportunities WHERE LEFT(pickup_window_start,10)=today;
→ l1=0, l2=0
```

145/150 today rows are >1 hour pending. 94/150 are >4 hours pending. The
SLA cron has had hundreds of opportunities to escalate and has fired
zero notifications. Either the cron is failing silently, the thresholds
are wrong, or the escalation channel (email/notification) is missing.

### 11.5 Pricing is missing on 87% of today's loads

```
total=150, has_quoted_rate=19, has_target_buy_rate=19,
has_source_ref.buy=0, has_source_ref.sell=19
```

The Won Load Autopilot is supposed to populate `quoted_rate`,
`target_buy_rate`, and `source_ref.{buy, sell}` from the source quote.
Reality:
- 0/150 rows have `source_ref.buy` (the buy figure is *never* written).
- Only 19/150 (13%) have any pricing at all, and those rows have the
  *same* values in `quoted_rate`, `target_buy_rate`, and
  `source_ref.sell` — meaning the autopilot copied the sell price
  three places but never derived a buy.

Root cause: `quote_opportunities` only has one pricing column —
`quoted_amount`. The autopilot's "85% haircut" assumes it's reading the
sell price. But for 87% of today's source quotes, `quoted_amount` is
NULL — the email parser couldn't extract a rate. So the autopilot
copies NULL into all three fields and the rep sees a load with no
pricing context whatsoever.

For a same-day decision, "no pricing" + "no recent buy" + "no historical
load_fact" = the rep cannot price the load at all from this surface.

### 11.6 Customer attribution is wrong on 56% of today's loads

```
LEFT JOIN companies → 150/150 join
  but 84/150 (56%) are placeholder companies (name LIKE %unknown%/%pending%/'')
```

When the email parser can't resolve a sender domain to a known company,
the autopilot auto-creates a placeholder. 84 of today's 150 rows point
to such placeholders. Even with the status filter fixed, the rep sees
"Unknown Customer" or blank in the customer column for the majority of
today's freight.

### 11.7 Owner attribution is wrong on 74% of today's loads

39 today rows have `owner_user_id`; 111 don't. The "My Loads" saved view
in the UI filters on the owner column → a rep using "My Loads" sees at
most 39 loads, mostly random based on which quotes happened to be
auto-mapped to a rep.

### 11.8 Today-specific dedupe

```
Dallas → Laredo (Dry Van, 2026-04-30):    12 separate freight_opp rows
Calhoun → Sacramento (Dry Van, 2026-04-30):  5
Dalton → Sacramento (Dry Van, 2026-04-30):   5
Mesquite → Moreno Valley:                    4
Edison → Avon:                               4
Dallas → Chicago:                            4
Grand Rapids → Springfield:                  4
York → Anniston:                             4
```

39% of today's rows are duplicates of other today rows on the same
(origin, destination, equipment) tuple. For the Dallas → Laredo lane,
12 separate rows clutter the screen; collapsing them into one row with
`load_count=12` would cut visual noise by an order of magnitude on the
hottest lane of the day.

### 11.9 Today's silent drops — none, but the recent-history pattern is real

```
SELECT created_at::date, COUNT(*) AS dropped
FROM quote_opportunities WHERE outcome_status='won'
  AND id NOT IN (SELECT source_quote_id FROM freight_opportunities WHERE source_quote_id IS NOT NULL)
GROUP BY 1 ORDER BY 1 DESC;
→ 2026-04-28: 14, 2026-04-27: 2
```

86/86 wins today converted (100%). But 14/X wins on 4/28 and 2/Y on
4/27 silently dropped. We can't identify what changed between 4/28 and
4/30 without instrumentation — there's no audit trail telling us
why those 16 quotes failed to spawn a freight opp. If the same failure
mode reappears tomorrow, today's same-day rep will simply lose loads
with no warning.

### 11.10 Ingestion freshness

Hourly bucket of `generated_at` over the last 24h shows steady ingestion
(11–37 rows/hour, no >2h dead spots during business hours). The producer
is healthy. Nothing in the rep's experience is caused by a stalled feed.

### 11.11 Same-day ranked root causes (focus list)

Ordered by which fix would most immediately increase a rep's trust in
"today's freight" specifically.

1. **Status mismatch** — 0 of 150 today loads visible. Fix `pending_approval`
   in the UI default filter and in the `awaiting_approval` SelectItem
   value. Estimated effort: <1 hour. Gain: 150 → potentially 150 visible.

2. **Approval queue chokepoint** — 0/150 today rows can ever be acted on
   from the cockpit until somebody approves them. Either:
   - eliminate the approval gate (start in `ready_to_send` directly), or
   - auto-approve when `source_quote.assigned_rep_id` is a trusted user
     and the lane is recurring, or
   - ship the missing NAM/AM approval popup and notification.
   Without one of these, fixing the status filter alone would just
   surface 150 unactionable rows.

3. **Pricing population** — 87% of today's rows have no rates. Fix the
   Won Load Autopilot copy: don't haircut a NULL. If `quoted_amount` is
   NULL, leave `quoted_rate` NULL but compute `target_buy_rate` from
   live Sonar + `load_fact` history at render time, and surface "no
   customer rate yet — derive from market" badge.

4. **Customer placeholder cleanup** — 56% of today's rows show a stub
   customer. Either resolve via ZoomInfo at ingestion time (sender
   domain lookup), suppress placeholder rows from the cockpit (route to
   a separate "needs customer" queue), or label them "Unverified
   sender — confirm before quoting."

5. **Same-day dedupe** — collapse the 39% of dupes into lane-day
   aggregates with `load_count`. The 12 Dallas→Laredo rows become one.

6. **Owner attribution** — auto-assign at ingestion using the source
   quote's rep + the customer's existing AM, instead of leaving 74%
   unowned.

7. **SLA escalation** — the cron has fired zero notifications in
   production. Either the SLA notifier is broken or the thresholds need
   review. Today's pending pile is the symptom.

8. **Pickup-date roll-forward / open-state filter** — for same-day,
   the immediate concern is rows that were ingested yesterday with
   pickup=yesterday but are still actively open. Cockpit drops them via
   `pickupIso < todayIso`. Either roll forward at midnight or change
   the filter to "drop only if pickup<today AND status terminal."

9. **Silent-drop instrumentation** — the 16 missing wins from earlier
   this week aren't reproducing today, but with no audit trail we
   wouldn't catch the next regression. Wrap the autopilot in a try/catch
   that writes failures to `freight_opportunity_audit`.

10. **Same-day data-freshness pill** in the header — show "Last load
    ingested: 9m ago" so a rep can tell "0 rows" means "filter is wrong"
    rather than "ingestion is dead."

### 11.12 Suggested same-day acceptance test

To know we've actually solved this, the following should all be true at
9:00 AM CT on a normal weekday:

1. The default Available Freight view shows >0 rows whose pickup is
   today (CT).
2. Every today-pickup row has a non-null customer_name that matches the
   originating quote's customer (no "Unknown" placeholders).
3. Every today-pickup row has either a `quoted_rate` from the source
   quote OR a Sonar-derived buy band visible in the pricing column.
4. Every today-pickup row has a real owner_user_id (not null).
5. No two today-pickup rows on the same `(customer, origin, destination,
   equipment_type)` tuple appear separately — they collapse into one
   row with `load_count > 1`.
6. The page header shows "Last load ingested: <Nm ago>" and the SLA
   counter shows the count of today's pending_approval >L1 threshold
   (currently would read 145 → should converge toward 0).
7. Marking a load won at 8:55 AM CT produces a visible same-day freight
   opportunity by 8:55:30 AM CT.

If any of those fail, the same-day surface is still not trustworthy.

---

## Appendix — useful diagnostic queries

```sql
-- Status distribution + ingestion source
SELECT status, mode, confidence_flag, COUNT(*) FROM freight_opportunities GROUP BY 1,2,3 ORDER BY 4 DESC;

-- Ingestion path breakdown
SELECT source_ref->>'kind', source_ref->>'type', source_file_name IS NOT NULL AS from_spreadsheet,
       COUNT(*) FROM freight_opportunities GROUP BY 1,2,3 ORDER BY 4 DESC;

-- Won-Quote conversion gap
SELECT q.outcome_status, COUNT(*) AS quotes, COUNT(fo.id) AS ops
FROM quote_opportunities q
LEFT JOIN freight_opportunities fo ON fo.source_quote_id = q.id
WHERE q.outcome_status IN ('won','won_low_margin') GROUP BY 1;

-- Approval queue staleness
SELECT
  COUNT(*) FILTER (WHERE awaiting_approval_since < now() - interval '24h') AS over_24h,
  COUNT(*) FILTER (WHERE awaiting_approval_since < now() - interval '4h')  AS over_4h,
  COUNT(*) FILTER (WHERE awaiting_approval_since < now() - interval '1h')  AS over_1h
FROM freight_opportunities WHERE status='pending_approval';

-- Lane-signature duplicates
SELECT origin, destination, equipment_type, pickup_window_start, COUNT(*)
FROM freight_opportunities GROUP BY 1,2,3,4 HAVING COUNT(*)>1 ORDER BY 5 DESC;

-- Same-day vs past-CT
SELECT
  COUNT(*) FILTER (WHERE LEFT(pickup_window_start,10) = TO_CHAR((now() AT TIME ZONE 'America/Chicago')::date,'YYYY-MM-DD')) AS today_ct,
  COUNT(*) FILTER (WHERE LEFT(pickup_window_start,10) < TO_CHAR((now() AT TIME ZONE 'America/Chicago')::date,'YYYY-MM-DD')) AS past_ct
FROM freight_opportunities;
```
