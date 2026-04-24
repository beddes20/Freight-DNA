import { describe, it, expect } from "vitest";
import {
  checkSchemaDrift,
  collectExpectedSchema,
  formatDriftReport,
  hasDrift,
  type SchemaDrift,
} from "../checkSchemaDrift";

interface FakeRow {
  table_schema: string;
  table_name: string;
  column_name?: string;
}

/**
 * Builds a minimal mock pool whose `connect()` returns a client that
 * answers the two information_schema queries `checkSchemaDrift` issues.
 *
 * `tables` and `columns` describe the *DB state* the test wants to
 * simulate (only entries the queries should return).
 */
function makeMockPool(
  tables: Array<{ schema: string; name: string }>,
  columns: Array<{ schema: string; table: string; name: string }>,
) {
  let released = 0;
  let queryCount = 0;
  const tableRows: FakeRow[] = tables.map((t) => ({
    table_schema: t.schema,
    table_name: t.name,
  }));
  const columnRows: FakeRow[] = columns.map((c) => ({
    table_schema: c.schema,
    table_name: c.table,
    column_name: c.name,
  }));

  const client = {
    async query(sql: string, _params: unknown[]) {
      queryCount += 1;
      if (sql.includes("information_schema.tables")) {
        return { rows: tableRows };
      }
      if (sql.includes("information_schema.columns")) {
        return { rows: columnRows };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {
      released += 1;
    },
  };

  return {
    pool: {
      async connect() {
        return client;
      },
    },
    stats: () => ({ released, queryCount }),
  };
}

describe("collectExpectedSchema", () => {
  it("includes every pgTable declared in shared/schema.ts", () => {
    const expected = collectExpectedSchema();
    // The codebase has well over 100 tables; a low floor guards against an
    // accidental import regression that would silently shrink the set.
    let totalTables = 0;
    for (const tables of expected.byTable.values()) totalTables += tables.size;
    expect(totalTables).toBeGreaterThan(50);

    // public schema is always present
    expect(expected.byTable.has("public")).toBe(true);

    // Sanity-check a few tables that have shipped for a long time and a few
    // columns whose absence has historically broken production.
    const publicTables = expected.byTable.get("public")!;
    expect(publicTables.has("organizations")).toBe(true);
    expect(publicTables.has("companies")).toBe(true);
    expect(publicTables.has("email_conversation_threads")).toBe(true);
    expect(publicTables.has("email_conversation_read_states")).toBe(true);

    const ectCols = publicTables.get("email_conversation_threads")!;
    // The columns Task #533 added — checker must know they're expected.
    expect(ectCols.has("snoozed_until")).toBe(true);
    expect(ectCols.has("snoozed_from_state")).toBe(true);
    expect(ectCols.has("snoozed_by_user_id")).toBe(true);
  });
});

describe("checkSchemaDrift", () => {
  it("returns an empty report when every expected table+column exists", async () => {
    const expected = collectExpectedSchema();
    const tables: Array<{ schema: string; name: string }> = [];
    const columns: Array<{ schema: string; table: string; name: string }> = [];
    for (const [schema, byTable] of expected.byTable) {
      for (const [tableName, cols] of byTable) {
        tables.push({ schema, name: tableName });
        for (const col of cols) {
          columns.push({ schema, table: tableName, name: col });
        }
      }
    }

    const { pool, stats } = makeMockPool(tables, columns);
    const drift = await checkSchemaDrift(pool);

    expect(hasDrift(drift)).toBe(false);
    expect(drift.missingTables).toEqual([]);
    expect(drift.missingColumns).toEqual([]);

    const { released, queryCount } = stats();
    expect(released).toBe(1);
    expect(queryCount).toBe(2);
  });

  it("flags tables that exist in code but not in the DB", async () => {
    const expected = collectExpectedSchema();
    const tables: Array<{ schema: string; name: string }> = [];
    const columns: Array<{ schema: string; table: string; name: string }> = [];
    for (const [schema, byTable] of expected.byTable) {
      for (const [tableName, cols] of byTable) {
        // Simulate the Task #532 regression: read-state table is missing.
        if (tableName === "email_conversation_read_states") continue;
        tables.push({ schema, name: tableName });
        for (const col of cols) {
          columns.push({ schema, table: tableName, name: col });
        }
      }
    }

    const { pool } = makeMockPool(tables, columns);
    const drift = await checkSchemaDrift(pool);

    expect(hasDrift(drift)).toBe(true);
    expect(drift.missingTables).toContainEqual({
      schema: "public",
      table: "email_conversation_read_states",
    });
    // When the table is missing we don't also list every column on it —
    // the report should focus the dev on the missing table.
    expect(
      drift.missingColumns.find(
        (c) => c.table === "email_conversation_read_states",
      ),
    ).toBeUndefined();
  });

  it("flags columns that exist in code but not in the DB", async () => {
    const expected = collectExpectedSchema();
    const tables: Array<{ schema: string; name: string }> = [];
    const columns: Array<{ schema: string; table: string; name: string }> = [];
    for (const [schema, byTable] of expected.byTable) {
      for (const [tableName, cols] of byTable) {
        tables.push({ schema, name: tableName });
        for (const col of cols) {
          // Simulate the Task #533 regression: snooze columns missing.
          if (
            tableName === "email_conversation_threads" &&
            (col === "snoozed_until" ||
              col === "snoozed_from_state" ||
              col === "snoozed_by_user_id")
          ) {
            continue;
          }
          columns.push({ schema, table: tableName, name: col });
        }
      }
    }

    const { pool } = makeMockPool(tables, columns);
    const drift = await checkSchemaDrift(pool);

    expect(hasDrift(drift)).toBe(true);
    expect(drift.missingTables).toEqual([]);
    const ectMissing = drift.missingColumns
      .filter((c) => c.table === "email_conversation_threads")
      .map((c) => c.column)
      .sort();
    expect(ectMissing).toEqual([
      "snoozed_by_user_id",
      "snoozed_from_state",
      "snoozed_until",
    ]);
  });

  it("does NOT flag DB-only tables/columns (one-directional check)", async () => {
    const expected = collectExpectedSchema();
    const tables: Array<{ schema: string; name: string }> = [];
    const columns: Array<{ schema: string; table: string; name: string }> = [];
    for (const [schema, byTable] of expected.byTable) {
      for (const [tableName, cols] of byTable) {
        tables.push({ schema, name: tableName });
        for (const col of cols) {
          columns.push({ schema, table: tableName, name: col });
        }
      }
    }
    // Add an extra DB-only table and an extra column the schema doesn't know
    // about. Neither should show up in the drift report — extras are fine,
    // missing-from-code is the dangerous direction.
    tables.push({ schema: "public", name: "legacy_only_table" });
    columns.push({
      schema: "public",
      table: "legacy_only_table",
      name: "id",
    });
    columns.push({
      schema: "public",
      table: "organizations",
      name: "ghost_column_from_legacy_migration",
    });

    const { pool } = makeMockPool(tables, columns);
    const drift = await checkSchemaDrift(pool);
    expect(hasDrift(drift)).toBe(false);
  });
});

describe("formatDriftReport", () => {
  it("produces a human-readable report listing missing tables and columns", () => {
    const drift: SchemaDrift = {
      missingTables: [{ schema: "public", table: "email_conversation_read_states" }],
      missingColumns: [
        { schema: "public", table: "email_conversation_threads", column: "snoozed_until" },
        { schema: "public", table: "email_conversation_threads", column: "snoozed_from_state" },
      ],
    };
    const report = formatDriftReport(drift);
    expect(report).toContain("Drift detected");
    expect(report).toContain("server/runMigrations.ts");
    expect(report).toContain("public.email_conversation_read_states");
    expect(report).toContain(
      "public.email_conversation_threads: snoozed_until, snoozed_from_state",
    );
  });
});
