# Available Freight tab — discovery + audit (April 30, 2026)

Read-only investigation. No code or data changed. All numbers are real
counts from the live PostgreSQL database at the time of the audit.

---

## TL;DR — what is actually broken

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
