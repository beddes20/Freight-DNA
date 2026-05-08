import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // Tables managed outside shared/schema.ts (raw SQL CREATE TABLE IF NOT EXISTS
  // at runtime, or owned by external libs). Mirrored in
  // server/checkSchemaDrift.ts IGNORED_TABLES — keep the two lists in sync.
  // - session: owned by connect-pg-simple
  // - freight_opportunity_import_audit: created by server/availableFreightImporter.ts
  tablesFilter: ["!session", "!freight_opportunity_import_audit"],
});
