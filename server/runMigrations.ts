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
  } catch (err) {
    console.error("[migrations] Migration error:", err);
  } finally {
    client.release();
  }
}
