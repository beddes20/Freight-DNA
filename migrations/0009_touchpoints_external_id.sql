-- Migration: Add external_id to touchpoints for quote event dedupe
-- Task #476
-- Auto-logged quote touchpoints use the originating quote_event id as
-- their dedupe key so re-emitting the same event is idempotent.
-- Idempotent: safe to re-run against environments where db:push already
-- applied the column.

ALTER TABLE touchpoints ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS touchpoints_external_id_uq
  ON touchpoints (external_id)
  WHERE external_id IS NOT NULL;
