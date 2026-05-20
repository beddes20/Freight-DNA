# Email-Derived Companies Contract (Task #1095, 2026-05-07)

`companies.is_email_derived` (bool, default false) marks rows auto-created by the inbound-email path.

## Default visibility
- `GET /api/companies` excludes these by default — pass `?includeEmailDerived=true` to opt back in.
- Customers page uses `data-testid="toggle-show-email-derived"` for the opt-in chip.

## Single production setter
The won-quote AF handoff in `server/services/customerQuotes.ts` is the **only** production setter (sets `true` iff `opp.source === "email"`). Do not introduce other auto-create sites without flagging consistently.

## Schema
Requires `drizzle-kit push:pg` before deploy. Adds:
- `is_email_derived`
- `email_derived_at`
- `email_derived_seed_message_id`
- partial index `companies_email_derived_idx`

## Backfill TODO
Existing legacy stub rows are NOT yet flagged. Use the admin console's "Heuristic (legacy)" mode in `/admin/email-derived-companies` until a backfill migration is run; the "is_email_derived flag" mode (`?source=flag`) only sees newly-flagged rows.

## Enforcement
Section 1095 of `tests/code-quality-guardrails.test.ts` enforces these contracts.
