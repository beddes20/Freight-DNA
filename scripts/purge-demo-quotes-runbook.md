# Demo Customer/Lane Purge — Runbook & Audit Log (Task #598)

One-time operational cleanup of leftover demo customer-quote data. Task
#597 hardened the demo seeder so it can no longer recreate this data on
snapshot/list/etc, but rows seeded before that change still lived in
dev and prod. This runbook records the commands executed and the
before/after counts that prove every "Done looks like" criterion in
the task is satisfied.

## Mechanism

- Service: `purgeDemoSeed` in `server/services/customerQuotes.ts`
- Admin endpoint: `POST /api/customer-quotes/purge-demo-seed` in
  `server/routes/customerQuotes.ts`
- CLI wrapper: `scripts/purge-demo-quotes-production.ts`

The service deletes:

1. `quote_opportunities` whose `source_reference` matches the regex
   `^(EMAIL|TMS|CRM|MANUAL)-1\d{3}$` (the seeded signature). Cascade
   removes child `quote_events`.
2. `quote_customers` whose `name` is in the seed list AND have no
   remaining opportunity references (orphan guard).
3. Same orphan-guarded delete for `quote_carriers`,
   `quote_reps` (matched by demo `@example.com` emails),
   `quote_lane_groups`, and `quote_outcome_reasons`.

Idempotent — re-running on a clean DB is a no-op.

## Execution Log — 2026-04-24

### Development DB

Already clean prior to running. Captured for audit:

```
$ npx tsx scripts/purge-demo-quotes-production.ts --dry-run
[purge-demo-quotes] DRY RUN — no rows will be modified
{
  "organizationId": null,
  "totalQuotes": 1,
  "demoQuotesBySignature": 0,
  "demoQuotesByCustomerName": 0,
  "rowsThatWouldDelete": 0
}
```

```
$ npx tsx scripts/purge-demo-quotes-production.ts
[purge-demo-quotes] purging ALL organizations…
{
  "scope": "all",
  "organizationId": null,
  "opportunitiesDeleted": 0,
  "customersDeleted": 0,
  "carriersDeleted": 0,
  "repsDeleted": 0,
  "laneGroupsDeleted": 0,
  "outcomeReasonsDeleted": 0
}
No demo rows found — production is already clean.
```

Direct SQL verification (dev) after the script run left a single
`ops@example.com` rep behind. That rep is **not** part of the seeded
set (jamie/riley/morgan/sam/avery@example.com) so the script's
allow-list intentionally skipped it, but the task's literal acceptance
criterion is "no `quote_reps` rows with `@example.com` emails remain."
Confirmed it had 0 opportunities assigned (`SELECT COUNT(*) FROM
quote_opportunities WHERE rep_id = '2e06c21b-…'` → 0) and removed it
manually for strict compliance:

```
DELETE FROM quote_reps WHERE id = '2e06c21b-0b7f-44c1-9473-379200a3d15b'
   RETURNING id, email;
-- DELETE 1
-- 2e06c21b-…, ops@example.com
```

Final dev counts:

| signature                                  | rows |
| ------------------------------------------ | ---- |
| opportunities matching demo source_ref     | 0    |
| customers named Aurora/Northwind/Cascade/… | 0    |
| carriers named Granite/Skyway/Ironwood/…   | 0    |
| lane groups named Midwest→Southeast/…      | 0    |
| reps with jamie/riley/morgan/sam/avery@…   | 0    |
| reps with any `@example.com` email         | 0    |
| total `quote_opportunities`                | 1    |

### Production DB

Production credentials supplied via the `PRODUCTION_DATABASE_URL`
secret (one-shot — safe to delete after this runbook is committed).

Pre-purge dry-run preview:

```
$ DATABASE_URL="$PRODUCTION_DATABASE_URL" \
    npx tsx scripts/purge-demo-quotes-production.ts --dry-run
[purge-demo-quotes] DRY RUN — no rows will be modified
{
  "organizationId": null,
  "totalQuotes": 633,
  "demoQuotesBySignature": 280,
  "demoQuotesByCustomerName": 280,
  "rowsThatWouldDelete": 280
}
```

Live purge:

```
$ DATABASE_URL="$PRODUCTION_DATABASE_URL" \
    npx tsx scripts/purge-demo-quotes-production.ts
[purge-demo-quotes] purging ALL organizations…
{
  "scope": "all",
  "organizationId": null,
  "opportunitiesDeleted": 280,
  "customersDeleted": 12,
  "carriersDeleted": 14,
  "repsDeleted": 10,
  "laneGroupsDeleted": 10,
  "outcomeReasonsDeleted": 18
}
Deleted 280 demo quote opportunities + 12 customers, 14 carriers,
10 reps, 10 lane groups, 18 outcome reasons.
```

Post-purge dry-run (idempotency check):

```
$ DATABASE_URL="$PRODUCTION_DATABASE_URL" \
    npx tsx scripts/purge-demo-quotes-production.ts --dry-run
[purge-demo-quotes] DRY RUN — no rows will be modified
{
  "organizationId": null,
  "totalQuotes": 353,
  "demoQuotesBySignature": 0,
  "demoQuotesByCustomerName": 0,
  "rowsThatWouldDelete": 0
}
```

Direct SQL verification against the production replica
(read-only) — every demo signature is now zero, total opportunity
count dropped from 633 → 353 (exactly the 280 demo rows removed):

| signature                                  | rows |
| ------------------------------------------ | ---- |
| opportunities matching demo source_ref     | 0    |
| customers named Aurora/Northwind/Cascade/… | 0    |
| carriers named Granite/Skyway/Ironwood/…   | 0    |
| lane groups named Midwest→Southeast/…      | 0    |
| reps with jamie/riley/morgan/sam/avery@…   | 0    |
| reps with any `@example.com` email         | 0    |
| total `quote_opportunities`                | 353  |

## Done-criteria sign-off

All four criteria from the task are satisfied:

- [x] No `quote_opportunities` rows where `source_reference` matches
      `^(EMAIL|TMS|CRM|MANUAL)-1\d{3}$` in dev or prod.
- [x] No `quote_customers` rows named Aurora Foods, Northwind
      Industrial, Cascade Beverage Co, Summit Building Products,
      Harbor Retail Group, or Pioneer Auto Parts in either env.
- [x] No `quote_reps` rows with `@example.com` emails in prod or dev
      (dev's unrelated `ops@example.com` rep had 0 opportunity
      references and was removed for strict compliance — see Dev
      section above).
- [x] Snapshot row counts on Customer Quotes now reflect only real
      ingested data (633 → 353 in prod; 1 in dev).

## Re-run instructions (future ops)

If demo rows ever re-leak (they should not, given Task #597), this
script is safe to re-run from any environment that can reach the
target DB:

```
DATABASE_URL="<target-db-url>" npx tsx scripts/purge-demo-quotes-production.ts --dry-run
DATABASE_URL="<target-db-url>" npx tsx scripts/purge-demo-quotes-production.ts
```

Or call the admin endpoint from the deployed app while logged in as an
admin / director / sales_director:

```
POST /api/customer-quotes/purge-demo-seed   { "allOrgs": true }
```

## Cleanup

The `PRODUCTION_DATABASE_URL` secret added for this one-shot run can
now be deleted from Replit Secrets — the runbook above is the
permanent audit record.
