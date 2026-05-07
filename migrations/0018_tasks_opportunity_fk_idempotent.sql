-- Convergence migration — normalize tasks.opportunity_id FK to the canonical
-- Drizzle auto-generated name (`tasks_opportunity_id_crm_opportunities_id_fk`)
-- and shape (`ON DELETE SET NULL`).
--
-- Why this exists:
--   `migrations/meta/_journal.json` and `0000_snapshot.json` are stale (frozen
--   at migration #4 of 17). At deploy time, Replit's schema-sync diffs prod
--   against that stale snapshot and emits a synthetic
--     `ALTER TABLE tasks DROP CONSTRAINT tasks_opportunity_id_crm_opportunities_id_fk`
--   without `IF EXISTS`, which fails on any environment whose actual FK state
--   doesn't match the snapshot's. Schema, snapshot, dev DB, and prod DB are
--   four-way drifted on this constraint.
--
-- The same logic is also embedded in `server/runMigrations.ts` to guarantee
-- execution on every boot — `runMigrations.ts` does not auto-load files from
-- the `migrations/` directory; this SQL file exists for any external
-- migrator (e.g. Replit's deploy-time schema-sync) that does scan it.
--
-- Idempotent and data-safe across all four-way drift states:
--   - tasks.opportunity_id absent      → skip
--   - crm_opportunities table absent   → skip
--   - canonical FK already correct     → no-op
--   - canonical FK with wrong ON DELETE → drop + re-add
--   - non-canonical-name FK on same columns/refs → drop + re-add
--   - prod has orphan opportunity_id values → uses `NOT VALID` so ADD does
--     not scan/validate existing rows; a follow-up VALIDATE attempt is
--     wrapped in EXCEPTION to keep the migration green.

DO $$
DECLARE
  fk_record RECORD;
BEGIN
  -- Preconditions: tasks.opportunity_id column AND crm_opportunities table.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tasks'
      AND column_name = 'opportunity_id'
  ) THEN
    RAISE NOTICE '0018: tasks.opportunity_id column not present — skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'crm_opportunities'
  ) THEN
    RAISE NOTICE '0018: crm_opportunities table not present — skipping';
    RETURN;
  END IF;

  -- Step 1: drop EVERY existing FK on tasks(opportunity_id) -> crm_opportunities(id),
  -- regardless of name, so any historically-named drift constraint is removed.
  FOR fk_record IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t       ON c.conrelid  = t.oid AND t.relname = 'tasks'
    JOIN pg_namespace tn  ON t.relnamespace = tn.oid AND tn.nspname = 'public'
    JOIN pg_class rt      ON c.confrelid = rt.oid AND rt.relname = 'crm_opportunities'
    JOIN pg_namespace rtn ON rt.relnamespace = rtn.oid AND rtn.nspname = 'public'
    WHERE c.contype = 'f'
      AND c.conkey = (
        SELECT ARRAY[a.attnum]::smallint[]
        FROM pg_attribute a
        WHERE a.attrelid = t.oid AND a.attname = 'opportunity_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', fk_record.conname);
    RAISE NOTICE '0018: dropped pre-existing FK %', fk_record.conname;
  END LOOP;

  -- Step 2: add the canonical FK as NOT VALID so existing orphan rows in
  -- prod cannot block the deploy. Future writes are still enforced.
  EXECUTE 'ALTER TABLE tasks
    ADD CONSTRAINT tasks_opportunity_id_crm_opportunities_id_fk
    FOREIGN KEY (opportunity_id)
    REFERENCES crm_opportunities(id)
    ON DELETE SET NULL
    NOT VALID';

  -- Step 3: best-effort VALIDATE. If orphan rows exist this will raise; we
  -- swallow the error so the migration stays green and an operator can
  -- clean up + re-validate out-of-band. The constraint stays NOT VALID
  -- (still enforced for future writes).
  BEGIN
    EXECUTE 'ALTER TABLE tasks VALIDATE CONSTRAINT tasks_opportunity_id_crm_opportunities_id_fk';
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE NOTICE '0018: orphan tasks.opportunity_id values present — FK left NOT VALID; clean up + run VALIDATE CONSTRAINT manually';
  END;
END $$;
