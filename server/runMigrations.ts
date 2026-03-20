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

    // Add spot process and DL email to companies
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS spot_process text`);
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS dl_email varchar(255)`);
    console.log("[migrations] spot_process and dl_email added to companies");

    // Add parent_id to task_comments for threaded replies
    await client.query(`ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS parent_id varchar`);
    console.log("[migrations] parent_id added to task_comments");

    // Add topic replies table for 1:1 threaded dialogue
    await client.query(`
      CREATE TABLE IF NOT EXISTS one_on_one_topic_replies (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        topic_id varchar NOT NULL REFERENCES one_on_one_topics(id) ON DELETE CASCADE,
        author_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text text NOT NULL,
        created_at text NOT NULL
      )
    `);
    console.log("[migrations] one_on_one_topic_replies table created");

    // Set financial aliases (short codes) for all companies where not already set
    const companyAliases: [string, string][] = [
      ['ACH Food Companies, Inc.', 'ACHFOAIL'],
      ['ACUITY C/O RXO', 'ACUICHNC'],
      ['ALF Inc', 'ALFISEWA'],
      ['AMERICAN BOTTLING CO C/O RYDER LOGISTICS', 'AMERNOMI'],
      ['American Woodmark Corporation (AWC)', 'AMERWIVA'],
      ['Armstrong World Industries', 'ARMSLAPA'],
      ['BAE MARITIME SOLUTIONS 0273 CO CTIS', 'BAESMETN'],
      ['BAY VALLEY FOODS', 'BAYVOAIL'],
      ['Ball Metal Beverage Container Corp', 'BALLWEC1'],
      ['Brooklyn Bedding LLC', 'BROOGLAZ'],
      ['CTSI C/o Rheem WH 1827', 'CTSIMIGA'],
      ['Conagra', 'CONAOMNE'],
      ['Covestro LLC C/O Cass Information System', 'COVESTMO'],
      ['DE WELL SUPPLY CHAIN MANAGEMENT', 'DEWESACA'],
      ['DOW CHEMICAL', 'DOWCMIMI'],
      ['Ferrara', 'FERRCHIL'],
      ['Ferrero', 'FERRPANJ'],
      ['Food In Transit', 'FOODCHIL'],
      ['HP HOOD CO', 'HPHOVENY'],
      ['Honeywell International Inc.', 'HONEMONJ'],
      ['Idahoan Foods', 'IDAHIDID'],
      ['International Food Solutions', 'INTEOVFL'],
      ['JBS FOODS', 'JBSFGRCO'],
      ['JOHNSON CONTROLS - . Intelligent Audit', 'JOHNMEWI'],
      ['Keurig Green Mountain', 'KEURNOMI'],
      ['Lactalis American Group', 'LACTBUNY'],
      ['MASONITE CORPORATION - MONTERREY', 'MASOMONX'],
      ['MASONITE CORPORATION - US', 'MASOTAFL'],
      ['MASONITE MEXICO SA DE CV', 'MASOCINX'],
      ['MOHAWK', 'MOHACAGA'],
      ['MOTTS C/O RYDER FREIGHT BILL PROCESSING', 'MOTTNOMI'],
      ['MS International LLC', 'MSINORCA'],
      ['National Food Group', 'NATINOMI'],
      ['Nestle Purina Petcare C/O Cass', 'NESTSTMO'],
      ['Nortek', 'NORTOKOK'],
      ['POOL CORP C/O CASS INFORMATION SYSTEMS', 'POOLBRMO'],
      ['Rheem (Laredo)', 'COCTMETN'],
      ['Rick Miles Produce Service, Inc', 'RICKIDID'],
      ['SDDC DOMESTIC BUSINESS', 'SDDCSCIL'],
      ['Signode Industrial Group LLC', 'SIGNTAFL'],
      ['Staples Inc', 'STAPCOSC'],
      ['SurfacePrep', 'SURFBYMI'],
      ['Terra Express Logistics Corp', 'TERRSACA'],
      ['Vertiv Mexico VERUSD CO Data2Logistics', 'VERTFOFL'],
      ['Wada Farms Marketing Group', 'WADAIDID'],
      ['GMCCA (General Motors Customer Care & Aftermarket)', 'GMCCPOMI'],
      ['MKB Construction', 'MKBCTEAZ'],
      ['BLOOM ENERGY', 'BLOOSACA'],
      ['Brooklyn Bedding DBA Southerland', 'BROOGLA1'],
      ['360 LION USA INC.', 'WISEGACA'],
      ['Rock Run Industries', 'ROCKMIIN'],
      ['Waupaca Northwoods LLC', 'WAUPWAWI'],
    ];

    for (const [name, alias] of companyAliases) {
      await client.query(
        `UPDATE companies SET financial_alias = $1 WHERE name = $2 AND (financial_alias IS NULL OR financial_alias = '')`,
        [alias, name]
      );
    }
    console.log("[migrations] financial aliases set for all companies");

    // Create goal_comments table if it doesn't exist (was missing from original migration)
    await client.query(`
      CREATE TABLE IF NOT EXISTS goal_comments (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        goal_id varchar NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        author_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body text NOT NULL,
        created_at text NOT NULL
      )
    `);
    console.log("[migrations] goal_comments table ensured");

    // Add performance indexes on high-traffic foreign key columns
    const perfIndexes = [
      `CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts(company_id)`,
      `CREATE INDEX IF NOT EXISTS idx_companies_assigned_to ON companies(assigned_to)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_company_id ON tasks(company_id)`,
      `CREATE INDEX IF NOT EXISTS idx_goals_am_id ON goals(am_id)`,
      `CREATE INDEX IF NOT EXISTS idx_goals_nam_id ON goals(nam_id)`,
      `CREATE INDEX IF NOT EXISTS idx_one_on_one_topics_session_id ON one_on_one_topics(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_one_on_one_topic_replies_topic_id ON one_on_one_topic_replies(topic_id)`,
      `CREATE INDEX IF NOT EXISTS idx_callouts_company_id ON callouts(company_id)`,
      `CREATE INDEX IF NOT EXISTS idx_feed_posts_parent_id ON feed_posts(parent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_feed_posts_author_id ON feed_posts(author_id)`,
      `CREATE INDEX IF NOT EXISTS idx_goal_comments_goal_id ON goal_comments(goal_id)`,
      `CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id)`,
    ];
    for (const sql of perfIndexes) {
      await client.query(sql);
    }
    console.log("[migrations] performance indexes ensured");

    // Fix notification links that pointed to /feed (page doesn't exist — callouts live on dashboard)
    await client.query(`UPDATE notifications SET link = '/' WHERE link = '/feed'`);
    console.log("[migrations] notification /feed links corrected");

    // Internal posts table for admin/director → recipient direct messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS internal_posts (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        content text NOT NULL,
        author_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_ids text[] NOT NULL DEFAULT '{}',
        parent_id varchar,
        created_at text NOT NULL
      )
    `);
    console.log("[migrations] internal_posts table ensured");

    // Market share entries table
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_share_entries (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        entry_type text NOT NULL DEFAULT 'monthly',
        period_label text NOT NULL,
        period_start text,
        period_end text,
        total_market_loads integer,
        vt_loads integer DEFAULT 0,
        spot_loads integer DEFAULT 0,
        rfp_id varchar,
        notes text,
        created_at text,
        created_by varchar
      )
    `);
    console.log("[migrations] market_share_entries table ensured");

    await client.query(`ALTER TABLE financial_uploads ADD COLUMN IF NOT EXISTS best_deal_days_spot jsonb NOT NULL DEFAULT '[]'`);
    await client.query(`ALTER TABLE financial_uploads ADD COLUMN IF NOT EXISTS best_deal_days_all jsonb NOT NULL DEFAULT '[]'`);
    await client.query(`ALTER TABLE financial_uploads ADD COLUMN IF NOT EXISTS trend_analysis jsonb NOT NULL DEFAULT '[]'`);
    await client.query(`ALTER TABLE financial_uploads ADD COLUMN IF NOT EXISTS averages_data jsonb NOT NULL DEFAULT '[]'`);
    await client.query(`ALTER TABLE financial_uploads ADD COLUMN IF NOT EXISTS daily_acquisition jsonb NOT NULL DEFAULT '[]'`);
    console.log("[migrations] financial_uploads extra sheets columns ensured");

    // Add sales_person_id to companies for linking accounts to sales/sales_director users
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS sales_person_id varchar`);
    console.log("[migrations] sales_person_id added to companies");

    // Add pinned columns to feed_posts for pinning team feed posts
    await client.query(`ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS pinned boolean DEFAULT false`);
    await client.query(`ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS pinned_at text`);
    console.log("[migrations] feed_posts pinned columns added");

  } catch (err) {
    console.error("[migrations] Migration error:", err);
  } finally {
    client.release();
  }
}
