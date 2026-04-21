-- Migration: Proactive Available Freight Outreach Engine — Phase 4
-- Task #306
-- Adds the editable templates table + per-carrier wave/thread tracking columns
-- on the existing freight_opportunity_carriers table. Idempotent so it can be
-- re-applied safely against environments that already have the columns from
-- earlier in-place application.

CREATE TABLE IF NOT EXISTS freight_outreach_templates (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now(),
  updated_by_id varchar REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS freight_outreach_templates_org_kind_uq
  ON freight_outreach_templates (org_id, kind);

-- Phase 4 columns on the ranked-shortlist table (introduced in 0007).
ALTER TABLE freight_opportunity_carriers
  ADD COLUMN IF NOT EXISTS wave integer,
  ADD COLUMN IF NOT EXISTS scheduled_for timestamp,
  ADD COLUMN IF NOT EXISTS sent_at timestamp,
  ADD COLUMN IF NOT EXISTS thread_id text,
  ADD COLUMN IF NOT EXISTS internet_message_id text,
  ADD COLUMN IF NOT EXISTS last_send_error text;

CREATE INDEX IF NOT EXISTS freight_opp_carriers_scheduled_idx
  ON freight_opportunity_carriers (scheduled_for, sent_at);
CREATE INDEX IF NOT EXISTS freight_opp_carriers_thread_idx
  ON freight_opportunity_carriers (thread_id);
