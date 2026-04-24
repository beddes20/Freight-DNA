-- Task #533: Conversations triage speed pack
-- Adds snooze fields to email_conversation_threads and a per-user
-- conversation_saved_views table.

ALTER TABLE email_conversation_threads
  ADD COLUMN IF NOT EXISTS snoozed_until        TIMESTAMP,
  ADD COLUMN IF NOT EXISTS snoozed_from_state   TEXT,
  ADD COLUMN IF NOT EXISTS snoozed_by_user_id   VARCHAR REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_conv_snoozed_until
  ON email_conversation_threads (snoozed_until)
  WHERE snoozed_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_saved_views (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  bucket      TEXT NOT NULL,
  filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conv_saved_views_user
  ON conversation_saved_views (user_id, sort_order);
