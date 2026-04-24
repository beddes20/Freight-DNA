-- Migration: Smarter Conversations detail pane (Task #534)
-- Adds three tables that back the right-hand smart pane on the
-- Conversations page:
--   1. conversation_thread_summaries — cached AI summary per thread,
--      invalidated by a content_hash over the thread's messages.
--   2. conversation_thread_suggestions — current suggested next action
--      for the thread plus the rep's dismiss / "wrong" feedback.
--   3. conversation_thread_events — append-only audit log of every
--      meaningful action on a thread (assignments, state changes,
--      AI drafts, AI corrections, human sends, capture-audit recoveries).
-- Idempotent: safe to re-run against environments where db:push already
-- created the tables.

CREATE TABLE IF NOT EXISTS conversation_thread_summaries (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  summary text NOT NULL,
  content_hash text NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  last_message_at timestamp,
  model text,
  generated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_thread_summaries_org_thread_uq
  ON conversation_thread_summaries (org_id, thread_id);

CREATE TABLE IF NOT EXISTS conversation_thread_suggestions (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  action_type text NOT NULL,
  action_label text NOT NULL,
  action_reason text NOT NULL,
  action_params jsonb DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  generated_at timestamp NOT NULL DEFAULT now(),
  dismissed_at timestamp,
  dismissed_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  feedback_kind text,
  feedback_notes text,
  feedback_at timestamp,
  feedback_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_thread_suggestions_org_thread_uq
  ON conversation_thread_suggestions (org_id, thread_id);

CREATE TABLE IF NOT EXISTS conversation_thread_events (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  actor_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  actor_name text,
  event_type text NOT NULL,
  description text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_thread_events_org_thread_idx
  ON conversation_thread_events (org_id, thread_id, created_at);
