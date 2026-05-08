-- Task #1126 Phase 1 — additive lifecycle columns on `users`.
--
-- This migration is INTENTIONALLY behavior-neutral. It only adds
-- columns and partial indexes. No production code reads or writes
-- these columns yet — the helpers in server/lib/userLifecycle.ts are
-- pure functions that consumers will adopt in a follow-up step.
--
-- Defaults are chosen so every existing row matches today's behavior:
--   is_active = true                → can still log in
--   is_service_account = false      → counted toward seats / dropdowns
--   is_demo / is_fixture = false    → visible in production roster
--   is_quarantined = false          → no admin gate
--   deleted_at IS NULL              → not soft-deleted
--   deactivated_at IS NULL          → not deactivated
--   user_source IS NULL             → backfilled later (separate task)
--   last_activity_at IS NULL        → backfilled later (separate task)
--
-- Soft-delete semantics mirror the contacts pattern from Task #1093
-- (deleted_at / deleted_by / delete_reason). Deactivation is its own
-- axis (deactivated_at / deactivated_by / deactivation_reason) because
-- the policy refinement keeps "real employee left" distinct from
-- "junk row admin tombstoned".
--
-- NOTE on CONCURRENTLY: drizzle-kit push:pg wraps each migration in a
-- transaction, and Postgres forbids CREATE INDEX CONCURRENTLY inside a
-- transaction. We use plain CREATE INDEX. The users table is small
-- (low thousands of rows org-wide) so the brief ACCESS EXCLUSIVE lock
-- is acceptable.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_active            boolean      NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS is_service_account   boolean      NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_demo              boolean      NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_fixture           boolean      NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_quarantined       boolean      NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS deleted_at           timestamptz  NULL,
    ADD COLUMN IF NOT EXISTS deleted_by           varchar      NULL REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS delete_reason        text         NULL,
    ADD COLUMN IF NOT EXISTS deactivated_at       timestamptz  NULL,
    ADD COLUMN IF NOT EXISTS deactivated_by       varchar      NULL REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS deactivation_reason  text         NULL,
    ADD COLUMN IF NOT EXISTS user_source          text         NULL,
    ADD COLUMN IF NOT EXISTS last_activity_at     timestamptz  NULL;

-- Partial indexes — present for future read-side filters. No code
-- depends on them yet; they exist so the cutover PRs in Phase 1 step 8
-- (read-side filter migration) can land without a separate index PR.

CREATE INDEX IF NOT EXISTS users_active_idx
    ON users (organization_id)
    WHERE deleted_at IS NULL AND is_active = true;

CREATE INDEX IF NOT EXISTS users_deleted_idx
    ON users (deleted_at)
    WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_service_idx
    ON users (organization_id)
    WHERE is_service_account = true;

CREATE INDEX IF NOT EXISTS users_quarantined_idx
    ON users (organization_id)
    WHERE is_quarantined = true;
