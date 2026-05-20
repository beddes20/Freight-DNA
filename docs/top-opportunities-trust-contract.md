# Top Opportunities Trust Contract (Task #1140, 2026-05-08)

The Top Opportunities page (`client/src/pages/top-opportunities.tsx`) ships two trust-shaped surfaces that must not silently regress.

## (1) Freight-data freshness pill
- `data-testid="pill-freight-data-freshness"`, gated behind `viewMode === "rfp"`.
- Must distinguish all five `data-freshness-state` values: `loading | unavailable | empty | fresh | stale`.
- The `isFreshnessError` branch MUST map to `unavailable` (neutral grey), never `stale` (amber) — this is the same Task #1109a three-state rule.
- Reads from `useQuery(["/api/opportunities/source-freshness"])`, which is a pure SELECT wrapping `getLatestFinancialUploadForOrg`; the route stays `requireUser` + org-scoped to `req.session.organizationId`.

## (2) Manager-only dismiss flow
- Trash-button `title` must mention both "org" and "manager".
- `AlertDialogTitle` must contain "whole org".
- `AlertDialogDescription` must mention "every rep" and "manager".
- The "Removed from list" rows render `data-testid="text-dismissed-attribution-<companyId>"` with the literal `"Unknown user"` fallback (preserves attribution honesty when the dismisser is soft-deleted under the Task #1126 cleaned roster — do NOT collapse to empty/`-`/bare id).
- The role list `["admin","director","national_account_manager","sales_director"]` appears in **exactly 3** handlers in `server/routes/financials.ts` (GET dismissals, POST/DELETE dismiss/:companyId) and is mirrored verbatim by the client `canManage` check; widening (e.g., adding `sales`) hands dismiss power to non-managers, narrowing locks managers out — both are silent trust regressions.

## Enforcement
Section 1140 of `tests/code-quality-guardrails.test.ts` enforces every contract above.

## Out of scope (do NOT regress here)
`server/services/customerQuotes.ts`, `freight_daily_upload_fact` writers, email ingestion, contact-jobs gate (#1094), user lifecycle filter (#1126). Future hardening (matcher-quality filters, cross-rep scoping for Field-Created/Archived) lands as Section 1140.x sub-sections rather than mutating Section 1140.
