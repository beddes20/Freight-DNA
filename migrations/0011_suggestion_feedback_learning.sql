-- Migration: Suggestion feedback learning rollup (Task #552)
-- Adds the small per-(org, account, action_type) summary table that
-- powers the conversation thread suggestion service's learning loop.
-- A nightly job (server/suggestionFeedbackLearningScheduler.ts) and the
-- request-path feedback handlers keep this table fresh; the suggestion
-- service consults it to avoid re-recommending action types a rep
-- already marked "wrong" for the same account in the last 7 days.
--
-- account_id uses the sentinel '__org__' for threads that aren't linked
-- to a company so the unique index can stay simple (PostgreSQL treats
-- NULLs as distinct, which would otherwise fragment org-wide rollups).
-- Idempotent: safe to re-run against environments where db:push already
-- created the table.

CREATE TABLE IF NOT EXISTS conversation_suggestion_feedback_stats (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id varchar NOT NULL,
  action_type text NOT NULL,
  wrong_count integer NOT NULL DEFAULT 0,
  good_count integer NOT NULL DEFAULT 0,
  dismissed_count integer NOT NULL DEFAULT 0,
  recent_wrong_reasons jsonb DEFAULT '[]'::jsonb,
  last_wrong_at timestamp,
  last_feedback_at timestamp,
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conv_sug_fb_stats_org_acct_action_uq
  ON conversation_suggestion_feedback_stats (org_id, account_id, action_type);
