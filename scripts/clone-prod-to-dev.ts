/**
 * Clone production database to development.
 * Run with: npx tsx scripts/clone-prod-to-dev.ts
 * 
 * Reads from PRODUCTION_DATABASE_URL (or PROD_DATABASE_URL) 
 * and writes to DATABASE_URL (dev).
 */

import { Pool } from "pg";
import * as fs from "fs";

const DEV_URL = process.env.DATABASE_URL!;
const PROD_URL = process.env.PRODUCTION_DATABASE_URL || process.env.PROD_DATABASE_URL;

if (!PROD_URL) {
  console.error("No PRODUCTION_DATABASE_URL or PROD_DATABASE_URL env var found.");
  console.error("Set PRODUCTION_DATABASE_URL to your production database connection string.");
  process.exit(1);
}

const dev = new Pool({ connectionString: DEV_URL });
const prod = new Pool({ connectionString: PROD_URL });

// Table copy order respects FK dependencies
const TABLE_ORDER = [
  "organizations",
  "users",
  "companies",
  "contacts",
  "rfps",
  "awards",
  "tasks",
  "task_comments",
  "touchpoints",
  "market_share_entries",
  "one_on_one_sessions",
  "one_on_one_topics",
  "one_on_one_topic_replies",
  "feed_posts",
  "feed_post_reactions",
  "callouts",
  "callout_reactions",
  "financial_uploads",
  "goals",
  "goal_comments",
  "development_goals",
  "promotion_criteria",
  "promotion_nominations",
  "attachments",
  "app_settings",
  "app_suggestions",
  "chat_conversations",
  "chat_messages",
  "demo_requests",
  "internal_posts",
  "notifications",
  "personal_alerts",
  "pto_passoffs",
  "pto_passoff_items",
  "report_card_snapshots",
  "tool_links",
  "vendor_routed",
];
// session table is skipped intentionally

async function copyTable(tableName: string) {
  console.log(`\n→ Copying ${tableName}...`);
  
  // Get columns
  const colRes = await prod.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_schema='public' AND table_name=$1 
    ORDER BY ordinal_position`, [tableName]);
  const cols = colRes.rows.map((r: any) => r.column_name);
  
  if (!cols.length) {
    console.log(`  (table not found in prod, skipping)`);
    return;
  }

  // Fetch all rows from production
  const rows = await prod.query(`SELECT * FROM "${tableName}"`);
  console.log(`  ${rows.rows.length} rows`);
  
  if (!rows.rows.length) return;

  // Truncate dev table (CASCADE to handle FK deps handled by insert order)
  await dev.query(`TRUNCATE "${tableName}" CASCADE`);
  
  // Insert rows in batches of 50
  const BATCH = 50;
  const colList = cols.map((c: string) => `"${c}"`).join(", ");
  
  for (let i = 0; i < rows.rows.length; i += BATCH) {
    const batch = rows.rows.slice(i, i + BATCH);
    const valuePlaceholders = batch.map((_: any, bi: number) => 
      `(${cols.map((_: any, ci: number) => `$${bi * cols.length + ci + 1}`).join(", ")})`
    ).join(", ");
    
    const values = batch.flatMap((row: any) => cols.map((c: string) => {
      const v = row[c];
      if (v === null || v === undefined) return null;
      // JSONB fields: pass as string
      if (typeof v === "object" && !Array.isArray(v)) return JSON.stringify(v);
      if (Array.isArray(v)) return v; // pg handles arrays
      return v;
    }));
    
    await dev.query(
      `INSERT INTO "${tableName}" (${colList}) VALUES ${valuePlaceholders} ON CONFLICT DO NOTHING`,
      values
    );
  }
  console.log(`  ✓ done`);
}

async function main() {
  console.log("=== Production → Development Clone ===");
  console.log("Dev:", DEV_URL?.split("@")[1] || "local");
  console.log("Prod:", PROD_URL?.split("@")[1] || "unknown");
  
  try {
    // Disable FK checks for the duration
    await dev.query("SET session_replication_role = 'replica'");
    
    for (const table of TABLE_ORDER) {
      try {
        await copyTable(table);
      } catch (err: any) {
        console.error(`  ✗ Error copying ${table}:`, err.message);
      }
    }
    
    await dev.query("SET session_replication_role = 'origin'");
    console.log("\n=== Clone complete! ===");
  } finally {
    await dev.end();
    await prod.end();
  }
}

main().catch(console.error);
