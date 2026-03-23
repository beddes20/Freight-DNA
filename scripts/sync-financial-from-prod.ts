/**
 * Sync financial_uploads rows from production to dev.
 * Uses Replit's production database read replica.
 * Run: npx tsx scripts/sync-financial-from-prod.ts
 * 
 * Requires PRODUCTION_DATABASE_URL env var to be set.
 */

import { Pool } from "pg";

const DEV_URL = process.env.DATABASE_URL;
const PROD_URL = process.env.PRODUCTION_DATABASE_URL;

if (!DEV_URL) { console.error("DATABASE_URL not set"); process.exit(1); }
if (!PROD_URL) {
  console.error("\nThis script requires PRODUCTION_DATABASE_URL to be set.");
  console.error("To get the production DB URL:");
  console.error("  1. Go to your Replit deployment settings");
  console.error("  2. Find the PostgreSQL database connection string");
  console.error("  3. Set it as PRODUCTION_DATABASE_URL in your dev secrets\n");
  process.exit(1);
}

async function main() {
  const dev = new Pool({ connectionString: DEV_URL });
  const prod = new Pool({ connectionString: PROD_URL });

  try {
    console.log("Reading financial_uploads from production...");
    const prodRows = await prod.query("SELECT * FROM financial_uploads ORDER BY uploaded_at DESC LIMIT 1");
    if (!prodRows.rows.length) { console.log("No financial uploads in production."); return; }

    const upload = prodRows.rows[0];
    const txRows = upload.rows as any[];
    console.log(`  Found upload: ${upload.file_name} (${txRows.length} transaction rows)`);

    // Clear dev financial_uploads and insert with production data
    await dev.query("DELETE FROM financial_uploads");
    
    // Insert metadata + empty rows first
    await dev.query(
      `INSERT INTO financial_uploads (id, file_name, uploaded_at, uploaded_by, row_count, rows,
        summary_rows, best_deal_days_spot, best_deal_days_all, trend_analysis, averages_data, daily_acquisition)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)`,
      [upload.id, upload.file_name, upload.uploaded_at, upload.uploaded_by, upload.row_count,
       JSON.stringify([]), JSON.stringify(upload.summary_rows || null),
       JSON.stringify(upload.best_deal_days_spot || null), JSON.stringify(upload.best_deal_days_all || null),
       JSON.stringify(upload.trend_analysis || null), JSON.stringify(upload.averages_data || null),
       JSON.stringify(upload.daily_acquisition || null)]
    );
    console.log("  Metadata inserted.");

    // Copy rows in chunks using UPDATE with parameterized query (no E2BIG)
    const CHUNK = 500;
    const chunks = Math.ceil(txRows.length / CHUNK);
    for (let i = 0; i < chunks; i++) {
      const chunk = txRows.slice(i * CHUNK, (i + 1) * CHUNK);
      await dev.query(
        `UPDATE financial_uploads SET rows = rows || $1::jsonb WHERE id = $2`,
        [JSON.stringify(chunk), upload.id]
      );
      process.stdout.write(`  Chunk ${i+1}/${chunks} copied...\r`);
    }
    
    const verify = await dev.query(`SELECT jsonb_array_length(rows) FROM financial_uploads WHERE id=$1`, [upload.id]);
    console.log(`\n  ✓ Financial data synced: ${verify.rows[0].jsonb_array_length} rows in dev`);
  } finally {
    await dev.end();
    await prod.end();
  }
}

main().catch(console.error);
