# Profile Safety Labels Contract (Task #1109 / #1109a, 2026-05-07)

Non-destructive UI labels on the Company Profile:
- email-derived banner
- split Connection / Data-freshness pills
- per-card "Updated Xh ago" + "Stale" pills
- financial "may be incomplete" hint

## Feature flag
Gated by org-scoped feature flag `profile_safety_labels_enabled`, exposed via `GET /api/profile-safety-flag` (default-ON: returns `{ enabled: true, configured: false }` when no row exists). Admins flip OFF via `PATCH /api/feature-flags/profile_safety_labels_enabled`.

## New read-only routes
- `GET /api/companies/:id/data-freshness` — max(createdAt) on nbaCards / latest accountGrowthScores.calculatedAt / max(touchpoints.date) / max(freightDailyUploadFact.ingestedAt) for matching customer.
- `GET /api/companies/:id/financial-mapping-health` — counts freight rows whose `customer` ILIKEs the company name but is not bound by name- or financialAlias-equality.

## Stale thresholds
- NBA: 24h
- growth / health / financials: 7d

(in `client/src/hooks/useCompanyDataFreshness.ts`)

All UI is gated behind `useProfileSafetyFlag()` — leaving the flag default-ON in dev.

## Three states (#1109a hardening)
- **loading**
- **unavailable** — fetch error → neutral grey "Freshness unavailable", emits `data-freshness-state="unavailable"`
- **stale** — real upstream age → amber

Do NOT collapse fetch errors back into the stale branch — it misled reps in pilot.

The `health` source maps to "Last touchpoint" (not "Health updated") because `touchpoints.date` is user-entered and can be backdated; do not rename without changing the underlying timestamp source.

## Out of scope (do NOT regress here)
No edits to `server/services/customerQuotes.ts`, `freight_daily_upload_fact` writers, email ingestion, or the CQ stability contract — these endpoints are pure SELECTs.
