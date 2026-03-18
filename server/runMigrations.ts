import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS financial_rep_id text`);

    const repMappings: [string, string][] = [
      ["taylor.call@valuetruck.com",    "t.call"],
      ["danny.beddes@valuetruck.com",   "d.beddes"],
      ["dallin.meier@valuetruck.com",   "vltk-dmeie"],
      ["sam.davis@valuetruck.com",      "vltk-sdavi"],
      ["alex.shumway@valuetruck.com",   "a.shumway"],
      ["jared.reynolds@valuetruck.com", "j.reynolds"],
      ["jason.allen@valuetruck.com",    "jallen"],
      ["braden.shinsel@valuetruck.com", "s.shinsel"],
      ["yuri.yassin@valuetruck.com",    "vltk-yyass"],
      ["ethan.allen@valuetruck.com",    "e.allen"],
      ["brianna.coakley@valuetruck.com","briannac"],
      ["kimberly.dornseif@valuetruck.com", "k.dornseif"],
      ["legrand.toia@valuetruck.com",   "vltk-ltoia"],
      ["adan.castaneda@valuetruck.com", "a.castaned"],
      ["mason.moore@valuetruck.com",    "m.moore"],
    ];

    for (const [username, repId] of repMappings) {
      await client.query(
        `UPDATE users SET financial_rep_id = $1 WHERE username = $2 AND (financial_rep_id IS NULL OR financial_rep_id != $1)`,
        [repId, username]
      );
    }

    console.log("[migrations] financial_rep_id migration complete");

    // Fix FK constraints that were missing ON DELETE rules — causes 500 when deleting users
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'touchpoints_logged_by_id_fkey' AND confdeltype = 'a') THEN
          ALTER TABLE touchpoints DROP CONSTRAINT touchpoints_logged_by_id_fkey;
          ALTER TABLE touchpoints ADD CONSTRAINT touchpoints_logged_by_id_fkey FOREIGN KEY (logged_by_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'callouts_author_id_fkey' AND confdeltype = 'a') THEN
          ALTER TABLE callouts DROP CONSTRAINT callouts_author_id_fkey;
          ALTER TABLE callouts ADD CONSTRAINT callouts_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goals_created_by_id_fkey' AND confdeltype = 'a') THEN
          ALTER TABLE goals ALTER COLUMN created_by_id DROP NOT NULL;
          ALTER TABLE goals DROP CONSTRAINT goals_created_by_id_fkey;
          ALTER TABLE goals ADD CONSTRAINT goals_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pto_passoffs_covering_user_id_fkey' AND confdeltype = 'a') THEN
          ALTER TABLE pto_passoffs DROP CONSTRAINT pto_passoffs_covering_user_id_fkey;
          ALTER TABLE pto_passoffs ADD CONSTRAINT pto_passoffs_covering_user_id_fkey FOREIGN KEY (covering_user_id) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    console.log("[migrations] FK cascade/set-null constraints applied");

    // Add account intelligence columns to companies
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS tender_style text`);
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_quirks text`);
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS process_notes text`);
    console.log("[migrations] account intelligence columns added to companies");

    // Add parent_id to task_comments for threaded replies
    await client.query(`ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS parent_id varchar`);
    console.log("[migrations] parent_id added to task_comments");
  } catch (err) {
    console.error("[migrations] Migration error:", err);
  } finally {
    client.release();
  }
}
