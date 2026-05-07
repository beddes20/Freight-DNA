-- Task #P2.1b — Add `company_financial_aliases` table + supporting
-- indexes. Schema-only; no readers or writers in this migration.
-- Backfill from `companies.financial_alias` is performed by
-- `scripts/backfill-company-financial-aliases.ts` (idempotent, separate
-- step). The legacy column stays in place untouched for one full
-- release per the dual-read/dual-write rollout in
-- docs/company-financial-aliases-plan.md §C.
--
-- Index strategy mirrors `migrations/0016_contacts_partial_indexes.sql`:
-- plain (non-CONCURRENTLY) `CREATE INDEX IF NOT EXISTS` because the
-- project's migration runner wraps each file in a transaction. Table
-- starts empty so the brief ACCESS EXCLUSIVE lock is a non-issue.

CREATE TABLE IF NOT EXISTS company_financial_aliases (
    id                      VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  VARCHAR NOT NULL REFERENCES organizations(id),
    company_id              VARCHAR NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    alias                   TEXT    NOT NULL,
    alias_normalized        TEXT    NOT NULL,
    source                  TEXT    NOT NULL,
    confirmed_by_user_id    VARCHAR,
    confirmed_at            TIMESTAMP,
    created_at              TIMESTAMP NOT NULL DEFAULT now(),
    created_by_user_id      VARCHAR,
    updated_at              TIMESTAMP NOT NULL DEFAULT now(),
    notes                   TEXT,
    CONSTRAINT cfa_source_check CHECK (
        source IN ('legacy_column', 'admin', 'financial_upload', 'heuristic', 'migration')
    )
);

CREATE INDEX IF NOT EXISTS cfa_org_company_idx
    ON company_financial_aliases (org_id, company_id);

CREATE INDEX IF NOT EXISTS cfa_org_alias_norm_idx
    ON company_financial_aliases (org_id, alias_normalized);

-- One authoritative alias per org. Heuristic suggestions are allowed
-- to coexist with confirmed mappings, so they're excluded from the
-- uniqueness predicate.
CREATE UNIQUE INDEX IF NOT EXISTS cfa_org_alias_norm_uniq
    ON company_financial_aliases (org_id, alias_normalized)
    WHERE source <> 'heuristic';

-- Powers the P2.4 quarantine surface.
CREATE INDEX IF NOT EXISTS cfa_quarantine_idx
    ON company_financial_aliases (org_id)
    WHERE source = 'heuristic' AND confirmed_by_user_id IS NULL;
