-- Migration: Add party_type to quote_customers (customer | carrier | unknown)
-- Task #597
-- Adds the auto-classification bucket plus a manual-override flag that
-- locks the row against future re-classification when an operator has
-- explicitly marked it via the drawer Mark customer/carrier/unknown
-- controls. Idempotent: safe to re-run against envs where db:push
-- already created the columns.

ALTER TABLE quote_customers
  ADD COLUMN IF NOT EXISTS party_type text NOT NULL DEFAULT 'unknown';

ALTER TABLE quote_customers
  ADD COLUMN IF NOT EXISTS party_type_manual boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS quote_customers_org_party_type_idx
  ON quote_customers (organization_id, party_type);
