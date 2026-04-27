-- Migration: Add `suppressed` flag to quote_reps
-- Task #752 — Audit non-AM/NAM reps on Freight Capture
-- The Freight Capture rep audit page lets admins suppress unwanted
-- "Rep" names so they stop appearing in the funnel rep dropdown /
-- column / rankings while still letting their underlying quotes
-- count toward customer/lane stage totals. Idempotent: safe to
-- re-run against envs where db:push already created the column or
-- where server/runMigrations.ts has already applied it.

ALTER TABLE quote_reps
  ADD COLUMN IF NOT EXISTS suppressed boolean NOT NULL DEFAULT false;
