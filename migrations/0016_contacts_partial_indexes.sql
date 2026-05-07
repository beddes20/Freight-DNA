-- Task #1093 — Finish soft-delete hardening for `contacts`.
--
-- Replaces the existing non-partial `contacts_deleted_at_idx` (created in
-- the 2026-05-07 incident-hardening pass) with a partial index that only
-- covers tombstoned rows. The vast majority of `contacts` are active
-- (deleted_at IS NULL), so a non-partial index on deleted_at is mostly
-- NULLs and wastes pages — the partial form keeps "show me deleted
-- contacts" admin queries fast without bloating writes on the hot path.
--
-- Adds `contacts_company_active_idx` — a partial index on (company_id)
-- WHERE deleted_at IS NULL, which is the exact predicate used by every
-- user-facing read path in server/storage.ts (getContactsByCompany,
-- getContactsByCompanyIds, the cold/meaningful-overdue raw SQL queries,
-- the chatbot lookups, etc.).
--
-- NOTE on CONCURRENTLY: this project's migration runner (drizzle-kit
-- push:pg) wraps each file in a transaction, and Postgres forbids
-- CREATE INDEX CONCURRENTLY inside a transaction. We therefore use plain
-- CREATE INDEX. The contacts table is small enough today that the brief
-- ACCESS EXCLUSIVE lock is acceptable; revisit if row count grows.

DROP INDEX IF EXISTS contacts_deleted_at_idx;

CREATE INDEX IF NOT EXISTS contacts_deleted_at_idx
    ON contacts (deleted_at)
    WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS contacts_company_active_idx
    ON contacts (company_id)
    WHERE deleted_at IS NULL;
