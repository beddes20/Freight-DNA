-- Migration: Carrier Intel Suggestions v1 (Task #194)
-- Adds carrier_intel_suggestions as a broader staging table for carrier
-- intelligence enrichment from email signals, market signals, or manual sources.
-- Distinct from carrier_email_suggestions (email-only, simpler schema).

CREATE TABLE IF NOT EXISTS carrier_intel_suggestions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_id VARCHAR NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  org_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL DEFAULT 'email_signal',
  -- 'email_signal' | 'market_signal' | 'manual'
  email_signal_id VARCHAR,
  -- nullable FK-less reference to email_signals.id
  suggestion_type TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  confidence_score INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'pending',
  -- pending | accepted | rejected | auto_accepted
  accepted_by_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  rejected_by_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  thread_id TEXT,
  payload_hash TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_carrier ON carrier_intel_suggestions(carrier_id);
CREATE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_org ON carrier_intel_suggestions(org_id);
CREATE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_status ON carrier_intel_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_thread ON carrier_intel_suggestions(thread_id);

-- Dedup index: one suggestion per (carrierId, suggestionType, payloadHash, threadId)
-- Only enforced when both thread_id and payload_hash are present.
CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_dedup
  ON carrier_intel_suggestions(carrier_id, suggestion_type, payload_hash, thread_id)
  WHERE thread_id IS NOT NULL AND payload_hash IS NOT NULL;
