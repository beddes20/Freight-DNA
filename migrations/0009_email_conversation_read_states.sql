-- Per-user read state for conversation threads (Task #532).
-- Was added to shared/schema.ts but never had a migration file, so any
-- environment where db:push didn't apply cleanly was missing this table
-- and the GET /api/internal/conversations route 500'd for non-admins.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS email_conversation_read_states (
  id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id    TEXT    NOT NULL,
  last_read_at TIMESTAMP,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_conv_read_user_thread_uniq
  ON email_conversation_read_states (user_id, thread_id);
