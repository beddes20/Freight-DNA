import type { Pool, PoolClient } from "pg";
import { isTable } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@shared/schema";

export interface MissingTable {
  schema: string;
  table: string;
}

export interface MissingColumn {
  schema: string;
  table: string;
  column: string;
}

export interface SchemaDrift {
  missingTables: MissingTable[];
  missingColumns: MissingColumn[];
}

interface QueryRunner {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface MinimalPool {
  connect(): Promise<PoolClient | (QueryRunner & { release: () => void })>;
}

/**
 * Tables that exist at runtime but are NOT declared in `shared/schema.ts`
 * (e.g. tables managed by external tooling or older modules). The check
 * only flags drift in the code → DB direction, but if a table from code
 * needs to be ignored intentionally it can be added here.
 */
const IGNORED_TABLES = new Set<string>([
  // session table is owned by connect-pg-simple, not declared in shared/schema.ts.
  "public.session",
]);

interface ExpectedSchema {
  // schema -> table -> set of column names (sql names)
  byTable: Map<string, Map<string, Set<string>>>;
  schemas: string[];
}

/**
 * Walks every Drizzle pgTable export from `shared/schema.ts` and returns
 * the schemas + table + column names that the code expects to exist in
 * the database.
 */
export function collectExpectedSchema(): ExpectedSchema {
  const byTable = new Map<string, Map<string, Set<string>>>();
  for (const value of Object.values(schema)) {
    if (!isTable(value as never)) continue;
    const cfg = getTableConfig(value as never);
    const schemaName = cfg.schema ?? "public";
    const fqName = `${schemaName}.${cfg.name}`;
    if (IGNORED_TABLES.has(fqName)) continue;
    if (!byTable.has(schemaName)) byTable.set(schemaName, new Map());
    const tables = byTable.get(schemaName)!;
    if (!tables.has(cfg.name)) tables.set(cfg.name, new Set());
    const cols = tables.get(cfg.name)!;
    for (const col of cfg.columns) cols.add(col.name);
  }
  return { byTable, schemas: [...byTable.keys()] };
}

/**
 * Compares the live DB to the Drizzle schema in `shared/schema.ts` and
 * returns a drift report listing any tables or columns that exist in code
 * but are missing from the database.
 *
 * This is intentionally one-directional: extra tables/columns in the DB
 * (legacy data, manual experiments, etc.) are NOT flagged. The goal is to
 * catch the failure mode that broke the Conversations tab twice — code
 * that reads/writes a column the migration block forgot to create.
 */
export async function checkSchemaDrift(pool: MinimalPool): Promise<SchemaDrift> {
  const expected = collectExpectedSchema();
  const drift: SchemaDrift = { missingTables: [], missingColumns: [] };
  if (expected.schemas.length === 0) return drift;

  const client = await pool.connect();
  try {
    const tablesRes = await (client as QueryRunner).query<{
      table_schema: string;
      table_name: string;
    }>(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_schema = ANY($1::text[])
          AND table_type = 'BASE TABLE'`,
      [expected.schemas],
    );
    const dbTables = new Set<string>();
    for (const r of tablesRes.rows) {
      dbTables.add(`${r.table_schema}.${r.table_name}`);
    }

    const colsRes = await (client as QueryRunner).query<{
      table_schema: string;
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_schema, table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = ANY($1::text[])`,
      [expected.schemas],
    );
    const dbColumns = new Map<string, Set<string>>();
    for (const r of colsRes.rows) {
      const key = `${r.table_schema}.${r.table_name}`;
      let set = dbColumns.get(key);
      if (!set) {
        set = new Set();
        dbColumns.set(key, set);
      }
      set.add(r.column_name);
    }

    for (const [schemaName, tables] of expected.byTable) {
      for (const [tableName, expectedCols] of tables) {
        const key = `${schemaName}.${tableName}`;
        if (!dbTables.has(key)) {
          drift.missingTables.push({ schema: schemaName, table: tableName });
          continue;
        }
        const dbCols = dbColumns.get(key) ?? new Set<string>();
        for (const col of expectedCols) {
          if (!dbCols.has(col)) {
            drift.missingColumns.push({
              schema: schemaName,
              table: tableName,
              column: col,
            });
          }
        }
      }
    }
  } finally {
    if ("release" in client && typeof client.release === "function") {
      client.release();
    }
  }
  return drift;
}

export function hasDrift(drift: SchemaDrift): boolean {
  return drift.missingTables.length > 0 || drift.missingColumns.length > 0;
}

export function formatDriftReport(drift: SchemaDrift): string {
  const lines: string[] = [];
  lines.push(
    "[schema-drift] Drift detected between shared/schema.ts and the live database.",
  );
  lines.push(
    "[schema-drift] The code declares tables/columns that the database does not have.",
  );
  lines.push(
    "[schema-drift] Add the matching CREATE/ALTER statements to server/runMigrations.ts.",
  );

  if (drift.missingTables.length > 0) {
    lines.push("");
    lines.push(`[schema-drift] Missing tables (${drift.missingTables.length}):`);
    for (const t of drift.missingTables) {
      lines.push(`  - ${t.schema}.${t.table}`);
    }
  }

  if (drift.missingColumns.length > 0) {
    lines.push("");
    lines.push(
      `[schema-drift] Missing columns (${drift.missingColumns.length}):`,
    );
    const grouped = new Map<string, string[]>();
    for (const c of drift.missingColumns) {
      const key = `${c.schema}.${c.table}`;
      let cols = grouped.get(key);
      if (!cols) {
        cols = [];
        grouped.set(key, cols);
      }
      cols.push(c.column);
    }
    for (const [table, cols] of grouped) {
      lines.push(`  - ${table}: ${cols.join(", ")}`);
    }
  }

  return lines.join("\n");
}

/**
 * Boot-time guard. Runs the drift check after migrations and either
 * crashes (in production) or warns (in development) when the live DB is
 * missing tables/columns declared in `shared/schema.ts`.
 *
 * The intent is to prevent the failure pattern that broke the
 * Conversations tab in production twice (Tasks #532 and #533): a feature
 * adds columns to the schema but forgets the migration block, so the
 * first deploy 500s every read of the affected table.
 */
export async function assertNoSchemaDrift(
  pool: Pool,
  options: { fatalInProduction?: boolean } = {},
): Promise<SchemaDrift> {
  const fatalInProduction = options.fatalInProduction ?? true;
  let drift: SchemaDrift;
  try {
    drift = await checkSchemaDrift(pool);
  } catch (err) {
    console.error(
      "[schema-drift] check failed (continuing boot):",
      err instanceof Error ? err.message : err,
    );
    return { missingTables: [], missingColumns: [] };
  }

  if (!hasDrift(drift)) {
    console.log("[schema-drift] OK — live DB matches shared/schema.ts");
    return drift;
  }

  const report = formatDriftReport(drift);
  console.error(report);

  if (fatalInProduction && process.env.NODE_ENV === "production") {
    console.error(
      "[schema-drift] Refusing to start in production with schema drift. Add the missing migration to server/runMigrations.ts and redeploy.",
    );
    process.exit(1);
  }

  console.error(
    "[schema-drift] WARNING: drift detected. Boot allowed in this environment, but production will refuse to start until server/runMigrations.ts is updated.",
  );
  return drift;
}
