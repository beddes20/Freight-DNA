-- Migration: Add `owner_rep_id` to quote_customers
-- Task #1012 — Customer Owner Rep Fallback
--
-- A primary owner rep per `quote_customers` row used as the fallback
-- on inbound quote ingestion when no sender-routing or inbox-owner
-- match resolved a more specific rep, and as the display rep on the
-- Quote Requests list for unassigned rows linked to the customer.
--
-- References `quote_reps.id` directly (same id-space the Quote
-- Requests `repId` already uses) and nulls out on rep delete so
-- ownership is cleared rather than cascaded.
--
-- Idempotent: safe to re-run against envs where db:push already
-- created the column or where server/runMigrations.ts has already
-- applied it.

ALTER TABLE quote_customers
  ADD COLUMN IF NOT EXISTS owner_rep_id varchar;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quote_customers_owner_rep_id_fkey'
  ) THEN
    ALTER TABLE quote_customers
      ADD CONSTRAINT quote_customers_owner_rep_id_fkey
      FOREIGN KEY (owner_rep_id) REFERENCES quote_reps(id) ON DELETE SET NULL;
  END IF;
END $$;
