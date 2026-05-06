-- Migration: Email Intelligence Signal Consumers v1 (Task #191)
-- Adds:
--   1. New columns on email_signals (linkedAccountId, linkedCarrierId, linkedLaneId, linkedOpportunityId)
--   2. carrier_email_suggestions staging table
--   3. email_outcome_links win/loss evidence join table

-- 1. Add link columns to email_signals
ALTER TABLE email_signals
  ADD COLUMN IF NOT EXISTS linked_account_id VARCHAR REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_carrier_id VARCHAR REFERENCES carriers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_lane_id VARCHAR REFERENCES recurring_lanes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_opportunity_id VARCHAR;

-- 2. Carrier email suggestions (staging table for enrichment from email signals)
CREATE TABLE IF NOT EXISTS carrier_email_suggestions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_id VARCHAR NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  email_message_id VARCHAR NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  thread_id TEXT,
  suggestion_type TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  confidence INTEGER NOT NULL DEFAULT 50,
  payload_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_carrier_email_suggestions_carrier ON carrier_email_suggestions(carrier_id);
CREATE INDEX IF NOT EXISTS idx_carrier_email_suggestions_thread ON carrier_email_suggestions(thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_email_suggestions_dedup ON carrier_email_suggestions(carrier_id, thread_id, suggestion_type, payload_hash)
  WHERE thread_id IS NOT NULL AND payload_hash IS NOT NULL;

-- 3. Email outcome links (win/loss evidence join table)
CREATE TABLE IF NOT EXISTS email_outcome_links (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  email_signal_id VARCHAR NOT NULL REFERENCES email_signals(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id VARCHAR NOT NULL,
  outcome_type TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_outcome_links_signal ON email_outcome_links(email_signal_id);
CREATE INDEX IF NOT EXISTS idx_email_outcome_links_entity ON email_outcome_links(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_email_outcome_links_outcome ON email_outcome_links(outcome_type);
