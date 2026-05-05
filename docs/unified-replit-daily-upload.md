# Unified ReplitDailyUpload — Architecture Contract (Task #1051)

## Why this document exists

Before Task #1051, the daily Excel "ReplitDailyUpload" was the on-paper source
for three independent surfaces — Financials, Available Freight, and the Lane
Work Queue (LWQ) — but in code they each consumed a different cut of the
workbook through a different path. The Financials page read raw rows from
`financial_uploads`, the Available Freight cockpit read `freight_opportunities`
written by `availableFreightImporter`, and the LWQ engine
(`recurringLaneCapacityEngine`) reaggregated `financial_uploads.rows` from
scratch. Every "where did this number come from?" question hit a different
ingest path with its own quirks and no shared freshness signal.

This document locks in the unified pipeline that replaces those forks.

## Single ingest entry point

`POST /api/financials/upload` is the **only** rep-facing entry point. It
writes:

1. `financial_uploads` — raw rows + summary sheets (unchanged, still the
   Financials source).
2. `freight_daily_upload_fact` — one normalized row per load/AVL row from the
   workbook (NEW — see schema in `shared/schema.ts` and writer in
   `server/services/freightDailyUploadFact.ts`).
3. Triggers the recurring lane engine + the available freight importer
   (unchanged in spirit, but both now consume the canonical fact rows for
   downstream enrichment).

The OneDrive monthly refresh scheduler funnels through the same writer.
There is no other supported ingest path; anything else is incidental
backfill code.

## The canonical fact table

`freight_daily_upload_fact` is the single normalized representation of a
"daily upload row":

| column                | meaning                                            |
|-----------------------|----------------------------------------------------|
| `orgId` + `uploadId`  | parent upload (joins back to `financial_uploads`)  |
| `loadKey`             | stable id (Order #, fallback to fingerprint hash)  |
| `customer`            | display-cleaned customer name                      |
| `originCity` / `originState` / `destCity` / `destState` | normalized lane geography |
| `equipment`           | trailer type                                       |
| `carrierName` / `carrierPayeeCode` | carrier identification (payee + name) |
| `shipDate` / `deliveryDate` | TMS dates                                    |
| `brokerageStatus` / `orderType` | preserved for diagnostics                |
| `moved`               | **canonical** "this load moved" boolean            |
| `totalRevenue` / `carrierTotal` / `marginPct` / `loadedMiles` | money + ops metrics |
| `ingestedAt`          | wall-clock writer time                             |

**`moved` semantics.** A row is `moved=true` when its TMS state indicates the
load actually went on a truck (POD, DEL, TRANSIT, BOOKED, COVERED). AVL /
quote-only rows are `moved=false`. The mapping is centralized in
`isMovedBrokerageStatus` in `server/services/freightDailyUploadFact.ts`; do
not re-derive it in callers.

## LWQ engine rule (replaces 8-week / ≥1-load lookback)

Eligibility for the Lane Work Queue is now:

> A `(originCity, originState, destCity, destState, equipment)` lane
> qualifies when `freight_daily_upload_fact` shows **≥6 moved loads in the
> rolling last 30 days** (anchored to the latest `shipDate` seen in the
> data, capped to "today" if the data is more than 60 days old).

A 7-day grace period prevents flapping: when a lane drops below the
threshold, the engine writes `recurring_lanes.lastEligibleAt` and only
retracts `isEligible=false` once `now - lastEligibleAt > 7 days`.

## LWQ row enrichment contract

For every eligible lane the engine writes the following columns on
`recurring_lanes` so that the LWQ row UI never has to recompute them:

- `movesLast30Days` — count of `moved=true` rows in the rolling window.
- `lastMovedAt` — most recent `shipDate` among those rows.
- `qualificationReason` — short human-readable string ("6 moved loads in
  last 30 days" / "8 moved loads — 3 carriers").
- `supportingCustomers` — `[{ name, count }]` (top 3 customers by load
  count over the window).
- `recentCarriers` — `[{ name, payeeCode, lastMovedAt, count }]` (top 5
  carriers by recency × count).
- `lastEligibleAt` — grace anchor (see above).

The LWQ row in `client/src/pages/lane-work-queue.tsx` reads these fields
directly. Any new derivation must be added to the engine and exposed here,
not computed in the UI.

## Shared "last upload at" freshness pill

All three surfaces consume the same freshness signal via
`GET /api/unified-upload/latest`, which returns:

```json
{
  "uploadId": "uuid",
  "uploadedAt": "iso-timestamp",
  "fileName": "...",
  "rowCount": 1234,
  "factRowCount": 1234,
  "movedRowCount": 987
}
```

The shared pill component is `client/src/components/freight/unified-upload-freshness-pill.tsx`.
The legacy AF-importer-specific health surface
(`/api/freight-opportunities/import-health`) is retained read-only for the
admin import audit page only — rep-facing surfaces must use the unified
pill.

## Out of scope (kept stable on purpose)

- The LWQ scoring weights (`LANE_CONFIG.scoring`) are unchanged.
- The carrier intelligence `load_fact` table is unaffected (it still
  ingests through `availableFreightImporter` for AVL freight).
- `freight_opportunities` remains the AF cockpit read model; only its
  freshness pill flips to the unified signal.
