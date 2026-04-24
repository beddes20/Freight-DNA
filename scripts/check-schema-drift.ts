#!/usr/bin/env tsx
/**
 * Standalone schema-drift check for CI / pre-deploy hooks.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/check-schema-drift.ts
 *
 * Exits 0 when the live DB has every table/column declared in
 * `shared/schema.ts`. Exits 1 (and prints a list of what's missing) when
 * code declares anything the DB lacks — that's the bug class that broke
 * the Conversations tab twice (Tasks #532 / #533).
 *
 * Wire this into CI so a feature branch that adds columns to the schema
 * without the matching `runMigrations.ts` block fails the build instead
 * of failing the production deploy.
 */
import { Pool } from "pg";
import {
  checkSchemaDrift,
  formatDriftReport,
  hasDrift,
} from "../server/checkSchemaDrift";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "[check-schema-drift] DATABASE_URL is not set. Point it at the database you want to validate (typically the staging or pre-deploy DB).",
    );
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const drift = await checkSchemaDrift(pool);
    if (hasDrift(drift)) {
      console.error(formatDriftReport(drift));
      console.error("");
      console.error(
        "[check-schema-drift] FAIL — add the missing CREATE/ALTER statements to server/runMigrations.ts before merging.",
      );
      process.exit(1);
    }
    console.log(
      "[check-schema-drift] OK — live DB matches shared/schema.ts (no missing tables or columns).",
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[check-schema-drift] check crashed:", err);
  process.exit(2);
});
