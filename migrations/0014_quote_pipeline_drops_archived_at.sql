-- Migration: Add `archived_at` soft-archive timestamp + partial index
--   to `quote_pipeline_drops` for the 30-day TTL on the drops queue.
-- Task #969 — Customer Quotes trust hardening (defect 4).
--
-- The daily `quotePipelineDropsCleanupScheduler` job stamps
-- `archived_at = now()` on rows whose `attempted_at` is older than
-- 30 days. The default `/api/admin/quote-pipeline/drops` query
-- filters `archived_at IS NULL`; admins can opt back in to the
-- historical tail with `?include_archived=1`.
--
-- The partial index over the active (non-archived) tail keeps the
-- default operator query fast even after tens of thousands of
-- historical drops accumulate.
--
-- Idempotent: safe to re-run against envs where db:push already
-- created the column / index, or where server/runMigrations.ts has
-- already applied it.

ALTER TABLE quote_pipeline_drops
  ADD COLUMN IF NOT EXISTS archived_at timestamp;

CREATE INDEX IF NOT EXISTS quote_pipeline_drops_org_archived_idx
  ON quote_pipeline_drops (org_id, attempted_at)
  WHERE archived_at IS NULL;
