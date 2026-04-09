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

    // Fix chat_conversations sequence to be in sync with max existing id
    await client.query(`SELECT setval('chat_conversations_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM chat_conversations), 1))`);
    console.log("[migrations] chat_conversations sequence synced");

    // Add meeting_link column to one_on_one_sessions for video meeting URLs
    await client.query(`ALTER TABLE one_on_one_sessions ADD COLUMN IF NOT EXISTS meeting_link text`);
    console.log("[migrations] meeting_link added to one_on_one_sessions");

    // Add created_at to users for tenure tracking
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at text`);
    console.log("[migrations] users created_at column ensured");

    // Create promotion_criteria table for career progression benchmarks
    await client.query(`
      CREATE TABLE IF NOT EXISTS promotion_criteria (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        from_role text NOT NULL,
        to_role text NOT NULL,
        min_load_count integer,
        min_margin_pct numeric(8,2),
        min_touchpoints integer,
        min_tenure_months integer,
        notes text,
        updated_at text,
        updated_by_id varchar
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_promotion_criteria_roles ON promotion_criteria(from_role, to_role)`);
    console.log("[migrations] promotion_criteria table ensured");

    // Create promotion_nominations table for nomination tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS promotion_nominations (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        nominee_id varchar NOT NULL,
        nominated_by_id varchar NOT NULL,
        notes text,
        status text NOT NULL DEFAULT 'active',
        nominated_at text NOT NULL
      )
    `);
    console.log("[migrations] promotion_nominations table ensured");

    await client.query(`
      CREATE TABLE IF NOT EXISTS development_goals (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        nam_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        am_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        updated_by_id VARCHAR NOT NULL REFERENCES users(id)
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS dev_goals_nam_am_uniq ON development_goals(nam_id, am_id)`);
    console.log("[migrations] development_goals table ensured");

    // vendor_routed table for vendor routing data
    await client.query(`
      CREATE TABLE IF NOT EXISTS vendor_routed (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        row_key text NOT NULL,
        active boolean NOT NULL DEFAULT true,
        UNIQUE(company_id, row_key)
      )
    `);
    console.log("[migrations] vendor_routed table ensured");

    // Multi-tenant organization foundation
    // Step 1: Create organizations table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL,
        created_at timestamp DEFAULT now() NOT NULL
      )
    `);
    // Ensure the named unique constraint drizzle expects exists
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_slug_unique') THEN
          ALTER TABLE organizations ADD CONSTRAINT organizations_slug_unique UNIQUE (slug);
        END IF;
        -- Drop the auto-named constraint if the named one was just added or already exists
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_slug_key') THEN
          ALTER TABLE organizations DROP CONSTRAINT organizations_slug_key;
        END IF;
      END $$;
    `);

    // Step 2: Seed the default Value Truck organization
    await client.query(`
      INSERT INTO organizations (name, slug)
      VALUES ('Value Truck', 'valuetruck')
      ON CONFLICT (slug) DO NOTHING
    `);

    // Step 3: Get the org ID for backfilling
    const orgResult = await client.query(`SELECT id FROM organizations WHERE slug = 'valuetruck'`);
    const orgId = orgResult.rows[0]?.id;

    if (orgId) {
      // Step 4: Add organization_id to companies (nullable first, then NOT NULL)
      await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS organization_id varchar REFERENCES organizations(id)`);
      await client.query(`UPDATE companies SET organization_id = $1 WHERE organization_id IS NULL`, [orgId]);
      await client.query(`ALTER TABLE companies ALTER COLUMN organization_id SET NOT NULL`);

      // Step 5: Add organization_id to users (nullable first, then NOT NULL)
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id varchar REFERENCES organizations(id)`);
      await client.query(`UPDATE users SET organization_id = $1 WHERE organization_id IS NULL`, [orgId]);
      await client.query(`ALTER TABLE users ALTER COLUMN organization_id SET NOT NULL`);
    }

    console.log("[migrations] organizations table and org-scoping columns ensured");

    // One-time: reset Jordan Baumgart's password (locked out of production)
    await client.query(
      `UPDATE users SET password = $1 WHERE username = 'jordan.baumgart@valuetruck.com'`,
      ['$2b$10$XV/Yel63VoBrjfAqW2doNeBoWm14rLfsxFDPN7m5kgXbTXvxH/y/e']
    );
    console.log("[migrations] jordan.baumgart password reset applied");

    // Ensure Ben Beddes (main admin) always has the correct role
    await client.query(
      `UPDATE users SET role = 'admin' WHERE username = 'ben.beddes@valuetruck.com'`
    );
    console.log("[migrations] ben.beddes admin role ensured");

    // Fix stale startDate on active 1:1 sessions that still carry old dates (before April 2026)
    await client.query(`
      UPDATE one_on_one_sessions
      SET start_date = $1
      WHERE status = 'active'
        AND start_date < '2026-04-01'
    `, [new Date().toISOString()]);
    console.log("[migrations] stale 1:1 session startDates patched to today");

  } catch (err) {
    console.error("[migrations] Migration error:", err);
  } finally {
    client.release();
  }

  // account_summary column on companies
  const client3 = await pool.connect();
  try {
    await client3.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_summary text`);
    console.log("[migrations] account_summary column ensured");
  } catch (err) {
    console.error("[migrations] account_summary migration error:", err);
  } finally {
    client3.release();
  }

  // shared_reps JSONB column on companies
  const clientSharedReps = await pool.connect();
  try {
    await clientSharedReps.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS shared_reps jsonb DEFAULT '[]'`);
    console.log("[migrations] shared_reps column ensured");
  } catch (err) {
    console.error("[migrations] shared_reps migration error:", err);
  } finally {
    clientSharedReps.release();
  }

  // demo_requests table (Task #53) — runs independently so earlier failures don't block it
  const client2 = await pool.connect();
  try {
    await client2.query(`
      CREATE TABLE IF NOT EXISTS demo_requests (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        first_name text NOT NULL,
        last_name text NOT NULL,
        email text NOT NULL,
        phone text,
        interest text NOT NULL,
        preferred_date text NOT NULL,
        preferred_time text NOT NULL,
        created_at timestamp DEFAULT now() NOT NULL
      )
    `);
    console.log("[migrations] demo_requests table ensured");
  } catch (err) {
    console.error("[migrations] demo_requests migration error:", err);
  } finally {
    client2.release();
  }

  // goals status column (for goal completion tracking)
  const clientGoals = await pool.connect();
  try {
    await clientGoals.query(`ALTER TABLE goals ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'`);
    console.log("[migrations] goals status column ensured");
  } catch (err) {
    console.error("[migrations] goals status migration error:", err);
  } finally {
    clientGoals.release();
  }

  // lm_daily_checks table (Task #61)
  const clientLm = await pool.connect();
  try {
    await clientLm.query(`
      CREATE TABLE IF NOT EXISTS lm_daily_checks (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id),
        lm_user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        checked_by_user_id varchar NOT NULL REFERENCES users(id),
        date text NOT NULL,
        calls_before_seven_thirty boolean,
        checkout_completed boolean,
        CONSTRAINT lm_daily_checks_lm_date UNIQUE (lm_user_id, date)
      )
    `);
    console.log("[migrations] lm_daily_checks table ensured");
  } catch (err) {
    console.error("[migrations] lm_daily_checks migration error:", err);
  } finally {
    clientLm.release();
  }

  // rfp_type column on rfps (Task #68)
  const clientRfpType = await pool.connect();
  try {
    await clientRfpType.query(`ALTER TABLE rfps ADD COLUMN IF NOT EXISTS rfp_type text`);
    console.log("[migrations] rfp_type column ensured on rfps");
  } catch (err) {
    console.error("[migrations] rfp_type migration error:", err);
  } finally {
    clientRfpType.release();
  }

  // password_reset_tokens table
  const clientPRT = await pool.connect();
  try {
    await clientPRT.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token varchar(128) NOT NULL UNIQUE,
        expires_at text NOT NULL,
        created_at text NOT NULL
      )
    `);
    console.log("[migrations] password_reset_tokens table ensured");
  } catch (err) {
    console.error("[migrations] password_reset_tokens migration error:", err);
  } finally {
    clientPRT.release();
  }

  const clientPTO = await pool.connect();
  try {
    await clientPTO.query(`ALTER TABLE pto_passoff_items ADD COLUMN IF NOT EXISTS covering_notes text`);
    await clientPTO.query(`ALTER TABLE pto_passoff_items ADD COLUMN IF NOT EXISTS override_covering_user_id varchar`);
    console.log("[migrations] pto_passoff_items covering_notes + override_covering_user_id ensured");
  } catch (err) {
    console.error("[migrations] pto_passoff_items covering columns error:", err);
  } finally {
    clientPTO.release();
  }

  const client1on1 = await pool.connect();
  try {
    await client1on1.query(`ALTER TABLE one_on_one_sessions ADD COLUMN IF NOT EXISTS morale_score integer`);
    await client1on1.query(`ALTER TABLE one_on_one_sessions ADD COLUMN IF NOT EXISTS session_summary text`);
    await client1on1.query(`ALTER TABLE one_on_one_sessions ADD COLUMN IF NOT EXISTS closed_at text`);
    console.log("[migrations] one_on_one_sessions morale_score + session_summary + closed_at ensured");
  } catch (err) {
    console.error("[migrations] one_on_one_sessions 1:1 columns error:", err);
  } finally {
    client1on1.release();
  }

  const clientDismiss = await pool.connect();
  try {
    await clientDismiss.query(`
      CREATE TABLE IF NOT EXISTS opportunity_dismissals (
        id serial PRIMARY KEY,
        company_id varchar NOT NULL,
        org_id varchar NOT NULL,
        dismissed_by varchar NOT NULL,
        dismissed_at text NOT NULL,
        UNIQUE(company_id, org_id)
      )
    `);
    console.log("[migrations] opportunity_dismissals table ensured");
  } catch (err) {
    console.error("[migrations] opportunity_dismissals error:", err);
  } finally {
    clientDismiss.release();
  }

  const clientOppLog = await pool.connect();
  try {
    await clientOppLog.query(`
      CREATE TABLE IF NOT EXISTS opportunity_logs (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL,
        rep_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id varchar REFERENCES companies(id) ON DELETE SET NULL,
        type text NOT NULL,
        category text NOT NULL DEFAULT 'other',
        title text NOT NULL,
        description text,
        estimated_loads integer,
        estimated_value numeric,
        logged_at text NOT NULL,
        created_at text NOT NULL
      )
    `);
    console.log("[migrations] opportunity_logs table ensured");
  } catch (err) {
    console.error("[migrations] opportunity_logs migration error:", err);
  } finally {
    clientOppLog.release();
  }

  const clientGoalCompany = await pool.connect();
  try {
    await clientGoalCompany.query(`
      ALTER TABLE goals ADD COLUMN IF NOT EXISTS company_id varchar REFERENCES companies(id) ON DELETE SET NULL
    `);
    console.log("[migrations] goals.company_id column ensured");
  } catch (err) {
    console.error("[migrations] goals.company_id migration error:", err);
  } finally {
    clientGoalCompany.release();
  }

  const clientSession = await pool.connect();
  try {
    await clientSession.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
      ) WITH (OIDS=FALSE)
    `);
    await clientSession.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")`);
    console.log("[migrations] session table ensured");
  } catch (err) {
    console.error("[migrations] session table error:", err);
  } finally {
    clientSession.release();
  }

  const clientLaneAttrib = await pool.connect();
  try {
    await clientLaneAttrib.query(`
      CREATE TABLE IF NOT EXISTS contact_lane_attributions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        contact_id varchar NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        origin_city text,
        origin_state text,
        destination_city text,
        destination_state text,
        source text NOT NULL DEFAULT 'manual',
        notes text,
        created_by varchar REFERENCES users(id),
        created_at text
      )
    `);
    console.log("[migrations] contact_lane_attributions table ensured");
  } catch (err) {
    console.error("[migrations] contact_lane_attributions error:", err);
  } finally {
    clientLaneAttrib.release();
  }

  const clientOpHours = await pool.connect();
  try {
    await clientOpHours.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS operating_hours text`);
    console.log("[migrations] operating_hours added to companies");
  } catch (err) {
    console.error("[migrations] operating_hours error:", err);
  } finally {
    clientOpHours.release();
  }

  // contact_base_history table
  const clientCBH = await pool.connect();
  try {
    await clientCBH.query(`
      CREATE TABLE IF NOT EXISTS contact_base_history (
        id serial PRIMARY KEY,
        contact_id varchar NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        from_base text,
        to_base text NOT NULL,
        changed_by_id varchar NOT NULL REFERENCES users(id),
        changed_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientCBH.query(`CREATE INDEX IF NOT EXISTS idx_cbh_contact_id ON contact_base_history(contact_id)`);
    console.log("[migrations] contact_base_history table ensured");
  } catch (err) {
    console.error("[migrations] contact_base_history error:", err);
  } finally {
    clientCBH.release();
  }

  // app_suggestions admin response columns
  const clientSugResp = await pool.connect();
  try {
    await clientSugResp.query(`ALTER TABLE app_suggestions ADD COLUMN IF NOT EXISTS admin_response text`);
    await clientSugResp.query(`ALTER TABLE app_suggestions ADD COLUMN IF NOT EXISTS responded_at timestamp`);
    console.log("[migrations] app_suggestions admin_response columns ensured");
  } catch (err) {
    console.error("[migrations] app_suggestions response error:", err);
  } finally {
    clientSugResp.release();
  }

  const clientProspectStage = await pool.connect();
  try {
    await clientProspectStage.query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS stage_changed_at TIMESTAMP`);
    console.log("[migrations] prospects stage_changed_at column ensured");
  } catch (err) {
    console.error("[migrations] prospects stage_changed_at error:", err);
  } finally {
    clientProspectStage.release();
  }

  const clientIdx = await pool.connect();
  try {
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_touchpoints_company_id      ON touchpoints(company_id)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_touchpoints_contact_id      ON touchpoints(contact_id)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_touchpoints_date             ON touchpoints(date DESC)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_touchpoints_is_meaningful    ON touchpoints(is_meaningful) WHERE is_meaningful = true`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_touchpoints_logged_by        ON touchpoints(logged_by_id)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_contacts_company_id          ON contacts(company_id)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_companies_assigned_to        ON companies(assigned_to)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_companies_organization_id    ON companies(organization_id)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_goals_am_id                  ON goals(am_id)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_goals_nam_id                 ON goals(nam_id)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_goals_start_end              ON goals(start_date, end_date)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to            ON tasks(assigned_to)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_tasks_company_id             ON tasks(company_id)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status                 ON tasks(status)`);
    console.log("[migrations] performance indexes ensured");
  } catch (err) {
    console.error("[migrations] performance index error:", err);
  } finally {
    clientIdx.release();
  }

  // Stripe billing fields on organizations table (Task #110)
  const clientStripe = await pool.connect();
  try {
    await clientStripe.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_customer_id text`);
    await clientStripe.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_subscription_id text`);
    await clientStripe.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_status text DEFAULT 'pending'`);
    await clientStripe.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_name text`);
    await clientStripe.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS current_period_end timestamp`);
    console.log("[migrations] organizations stripe billing columns ensured");
  } catch (err) {
    console.error("[migrations] stripe billing columns error:", err);
  } finally {
    clientStripe.release();
  }

  // Drop easter_egg_winners table (Task #138 — feature removed)
  const clientDropEgg = await pool.connect();
  try {
    await clientDropEgg.query(`DROP TABLE IF EXISTS easter_egg_winners`);
    console.log("[migrations] easter_egg_winners table dropped (feature removed)");
  } catch (err) {
    console.error("[migrations] easter_egg_winners drop error:", err);
  } finally {
    clientDropEgg.release();
  }

  // Carrier Procurement Rolodex (Task #113)
  const clientLaneCarriers = await pool.connect();
  try {
    await clientLaneCarriers.query(`
      CREATE TABLE IF NOT EXISTS lane_carriers (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id varchar NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        award_id varchar NOT NULL REFERENCES awards(id) ON DELETE CASCADE,
        lane text NOT NULL,
        carrier_name text NOT NULL,
        mc_number text,
        contact_name text,
        phone text,
        email text,
        rate text,
        capacity_per_week integer,
        notes text,
        status text NOT NULL DEFAULT 'contacted',
        created_at text NOT NULL
      )
    `);
    await clientLaneCarriers.query(`CREATE INDEX IF NOT EXISTS idx_lane_carriers_task_id ON lane_carriers(task_id)`);
    await clientLaneCarriers.query(`CREATE INDEX IF NOT EXISTS idx_lane_carriers_award_id ON lane_carriers(award_id)`);
    // Unique index to prevent duplicate carrier names per task+lane (case-insensitive)
    await clientLaneCarriers.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_lane_carriers_unique_carrier_per_lane
      ON lane_carriers(task_id, lane, lower(carrier_name))
    `);
    // Enforce status enum at DB level
    await clientLaneCarriers.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.constraint_column_usage
          WHERE table_name = 'lane_carriers' AND constraint_name = 'lane_carriers_status_check'
        ) THEN
          ALTER TABLE lane_carriers
          ADD CONSTRAINT lane_carriers_status_check
          CHECK (status IN ('contacted', 'committed', 'declined'));
        END IF;
      END $$
    `);
    console.log("[migrations] lane_carriers table ensured");
  } catch (err) {
    console.error("[migrations] lane_carriers error:", err);
  } finally {
    clientLaneCarriers.release();
  }

  // Email signature field on users (Task #115)
  const clientEmailSig = await pool.connect();
  try {
    await clientEmailSig.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_signature text`);
    console.log("[migrations] users email_signature column ensured");
  } catch (err) {
    console.error("[migrations] users email_signature migration error:", err);
  } finally {
    clientEmailSig.release();
  }

  // Launchpad TMS/Portal fields on prospects (Task #99)
  const clientTms = await pool.connect();
  try {
    await clientTms.query(`
      ALTER TABLE prospects
        ADD COLUMN IF NOT EXISTS tms_website text,
        ADD COLUMN IF NOT EXISTS tms_email text,
        ADD COLUMN IF NOT EXISTS scheduling_website text,
        ADD COLUMN IF NOT EXISTS scheduling_email text,
        ADD COLUMN IF NOT EXISTS tms_username text,
        ADD COLUMN IF NOT EXISTS tms_password text,
        ADD COLUMN IF NOT EXISTS phone text,
        ADD COLUMN IF NOT EXISTS billing_address text
    `);
    console.log("[migrations] prospects TMS columns ensured");
  } catch (err) {
    console.error("[migrations] prospects TMS columns error:", err);
  } finally {
    clientTms.release();
  }

  // Launchpad crm_opportunities table (Task #99)
  const clientOpps = await pool.connect();
  try {
    await clientOpps.query(`
      CREATE TABLE IF NOT EXISTS crm_opportunities (
        id serial PRIMARY KEY,
        prospect_id integer NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name text NOT NULL,
        record_type text NOT NULL DEFAULT 'single_lane',
        stage text NOT NULL DEFAULT 'qualification',
        amount text,
        close_date text,
        probability integer,
        notes text,
        lost_reason text,
        created_by_id varchar NOT NULL REFERENCES users(id),
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL
      )
    `);
    console.log("[migrations] crm_opportunities table ensured");
  } catch (err) {
    console.error("[migrations] crm_opportunities error:", err);
  } finally {
    clientOpps.release();
  }

  // Launchpad crm_ownership_requests table (Task #99)
  const clientOwn = await pool.connect();
  try {
    await clientOwn.query(`
      CREATE TABLE IF NOT EXISTS crm_ownership_requests (
        id serial PRIMARY KEY,
        prospect_id integer NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        requester_id varchar NOT NULL REFERENCES users(id),
        current_owner_id varchar NOT NULL REFERENCES users(id),
        status text NOT NULL DEFAULT 'pending',
        reason text,
        admin_note text,
        reviewed_by_id varchar REFERENCES users(id),
        created_at timestamptz DEFAULT now() NOT NULL,
        reviewed_at timestamptz
      )
    `);
    console.log("[migrations] crm_ownership_requests table ensured");
  } catch (err) {
    console.error("[migrations] crm_ownership_requests error:", err);
  } finally {
    clientOwn.release();
  }

  // Launchpad crm_account_history table (Task #99)
  const clientHist = await pool.connect();
  try {
    await clientHist.query(`
      CREATE TABLE IF NOT EXISTS crm_account_history (
        id serial PRIMARY KEY,
        prospect_id integer NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        field text NOT NULL,
        old_value text,
        new_value text,
        changed_by_id varchar NOT NULL REFERENCES users(id),
        created_at timestamptz DEFAULT now() NOT NULL
      )
    `);
    console.log("[migrations] crm_account_history table ensured");
  } catch (err) {
    console.error("[migrations] crm_account_history error:", err);
  } finally {
    clientHist.release();
  }

  // Account lifecycle status columns on prospects (Task #122)
  const clientAccStatus = await pool.connect();
  try {
    await clientAccStatus.query(`
      ALTER TABLE prospects
        ADD COLUMN IF NOT EXISTS account_status text DEFAULT 'prospecting',
        ADD COLUMN IF NOT EXISTS account_status_changed_at timestamptz
    `);
    // Backfill: set account_status_changed_at to created_at for any rows where it is null
    // This ensures stale/velocity tracking works correctly for pre-existing prospects
    await clientAccStatus.query(`
      UPDATE prospects
        SET account_status_changed_at = created_at
        WHERE account_status_changed_at IS NULL
    `);
    console.log("[migrations] prospects account_status columns ensured");
  } catch (err) {
    console.error("[migrations] prospects account_status error:", err);
  } finally {
    clientAccStatus.release();
  }

  // Prospect intel columns (estimated_annual_revenue, employee_count) — Task #123
  const clientIntel = await pool.connect();
  try {
    await clientIntel.query(`
      ALTER TABLE prospects
        ADD COLUMN IF NOT EXISTS estimated_annual_revenue text,
        ADD COLUMN IF NOT EXISTS employee_count text
    `);
    console.log("[migrations] prospects intel columns ensured");
  } catch (err) {
    console.error("[migrations] prospects intel columns error:", err);
  } finally {
    clientIntel.release();
  }

  // NAM/AM → LM daily check-in table
  const clientNamLm = await pool.connect();
  try {
    await clientNamLm.query(`
      CREATE TABLE IF NOT EXISTS nam_lm_checkins (
        id serial PRIMARY KEY,
        reviewer_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        lm_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        organization_id varchar NOT NULL REFERENCES organizations(id),
        check_date date NOT NULL DEFAULT CURRENT_DATE,
        check_type varchar(20) NOT NULL,
        check_calls_done boolean,
        board_clean boolean,
        checkout_done boolean,
        notes text,
        created_at timestamptz DEFAULT now(),
        CONSTRAINT nam_lm_checkins_unique UNIQUE (reviewer_id, lm_id, check_date, check_type)
      )
    `);
    await clientNamLm.query(`
      CREATE INDEX IF NOT EXISTS idx_nam_lm_checkins_reviewer ON nam_lm_checkins(reviewer_id, check_date)
    `);
    await clientNamLm.query(`
      CREATE INDEX IF NOT EXISTS idx_nam_lm_checkins_lm ON nam_lm_checkins(lm_id, check_date)
    `);
    console.log("[migrations] nam_lm_checkins table ensured");
  } catch (err) {
    console.error("[migrations] nam_lm_checkins error:", err);
  } finally {
    clientNamLm.release();
  }

  // Account Growth Score — cached scoring table
  const clientAgs = await pool.connect();
  try {
    await clientAgs.query(`
      CREATE TABLE IF NOT EXISTS account_growth_scores (
        id serial PRIMARY KEY,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        organization_id varchar NOT NULL REFERENCES organizations(id),
        score integer NOT NULL,
        band text NOT NULL,
        drivers jsonb NOT NULL DEFAULT '[]',
        calculated_at text NOT NULL
      )
    `);
    await clientAgs.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ags_company ON account_growth_scores(company_id)
    `);
    await clientAgs.query(`
      CREATE INDEX IF NOT EXISTS idx_ags_org ON account_growth_scores(organization_id, score)
    `);
    console.log("[migrations] account_growth_scores table ensured");
  } catch (err) {
    console.error("[migrations] account_growth_scores error:", err);
  } finally {
    clientAgs.release();
  }

  // Account Growth Score — add previous_score / previous_band columns (NBA prep)
  const clientAgsPrev = await pool.connect();
  try {
    await clientAgsPrev.query(`
      ALTER TABLE account_growth_scores
        ADD COLUMN IF NOT EXISTS previous_score integer,
        ADD COLUMN IF NOT EXISTS previous_band  text
    `);
    console.log("[migrations] account_growth_scores previous_score/band columns ensured");
  } catch (err) {
    console.error("[migrations] account_growth_scores previous columns error:", err);
  } finally {
    clientAgsPrev.release();
  }

  // Weekly AM Coaching Commitments
  const clientWc = await pool.connect();
  try {
    await clientWc.query(`
      CREATE TABLE IF NOT EXISTS weekly_commitments (
        id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_id          varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        company_id      varchar REFERENCES companies(id) ON DELETE SET NULL,
        contact_id      varchar REFERENCES contacts(id) ON DELETE SET NULL,
        company_name    text,
        contact_name    text,
        commitment_text text NOT NULL,
        lever           text NOT NULL DEFAULT 'Recovery',
        source          text NOT NULL DEFAULT 'dashboard',
        week_start      text NOT NULL,
        due_date        text NOT NULL,
        status          text NOT NULL DEFAULT 'pending',
        completed_at    text,
        created_at      text NOT NULL,
        updated_at      text
      )
    `);
    await clientWc.query(`ALTER TABLE weekly_commitments ADD COLUMN IF NOT EXISTS updated_at text`);
    await clientWc.query(`CREATE INDEX IF NOT EXISTS idx_wc_user_week ON weekly_commitments(user_id, week_start)`);
    await clientWc.query(`CREATE INDEX IF NOT EXISTS idx_wc_org_week ON weekly_commitments(org_id, week_start)`);
    await clientWc.query(`CREATE INDEX IF NOT EXISTS idx_wc_org_status ON weekly_commitments(org_id, status)`);
    console.log("[migrations] weekly_commitments table ensured");
  } catch (err) {
    console.error("[migrations] weekly_commitments error:", err);
  } finally {
    clientWc.release();
  }

  // NBA Phase 1 Persistent Cards
  const clientNba = await pool.connect();
  try {
    await clientNba.query(`
      CREATE TABLE IF NOT EXISTS nba_cards (
        id                   varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id               varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id              varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id           varchar REFERENCES companies(id) ON DELETE SET NULL,
        contact_id           varchar REFERENCES contacts(id) ON DELETE SET NULL,
        company_name         text,
        rule_type            text NOT NULL,
        outcome_type         text NOT NULL DEFAULT 'protect',
        confidence           text NOT NULL DEFAULT 'medium',
        signal_count         integer NOT NULL DEFAULT 1,
        signal_summary       jsonb NOT NULL DEFAULT '[]',
        why_this_now         text NOT NULL,
        suggested_action     text NOT NULL,
        expected_outcome     text NOT NULL,
        growth_lever         text,
        relationship_move    text,
        account_tier         text,
        urgency_score        integer NOT NULL DEFAULT 0,
        status               text NOT NULL DEFAULT 'generated',
        resolution_action    text,
        dismiss_reason       text,
        snooze_until         text,
        alternate_action_note text,
        linked_commitment_id varchar,
        linked_touchpoint_id varchar,
        linked_task_id       varchar,
        outcome_linked_at    text,
        outcome_type_linked  text,
        created_at           text NOT NULL,
        resolved_at          text
      )
    `);
    await clientNba.query(`CREATE INDEX IF NOT EXISTS idx_nba_cards_user_status ON nba_cards(user_id, status)`);
    await clientNba.query(`CREATE INDEX IF NOT EXISTS idx_nba_cards_org_rule ON nba_cards(org_id, rule_type, status)`);
    await clientNba.query(`CREATE INDEX IF NOT EXISTS idx_nba_cards_company ON nba_cards(company_id, status)`);
    await clientNba.query(`CREATE INDEX IF NOT EXISTS idx_nba_cards_snooze ON nba_cards(status, snooze_until)`);
    console.log("[migrations] nba_cards table ensured");
  } catch (err) {
    console.error("[migrations] nba_cards error:", err);
  } finally {
    clientNba.release();
  }

  // Task schema expansion (Task #147)
  const clientTaskExpand = await pool.connect();
  try {
    await clientTaskExpand.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS org_id varchar REFERENCES organizations(id)`);
    await clientTaskExpand.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS company_name text`);
    await clientTaskExpand.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS contact_name text`);
    // Add opportunity_id as integer FK (idempotent: drop varchar version if present, add integer FK)
    await clientTaskExpand.query(`
      DO $$
      BEGIN
        -- If column exists as varchar, drop and recreate as integer FK
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tasks' AND column_name = 'opportunity_id'
            AND data_type = 'character varying'
        ) THEN
          ALTER TABLE tasks DROP COLUMN opportunity_id;
        END IF;
        -- Add as integer FK if not present
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tasks' AND column_name = 'opportunity_id'
        ) THEN
          ALTER TABLE tasks ADD COLUMN opportunity_id integer REFERENCES crm_opportunities(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await clientTaskExpand.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lane_context jsonb`);
    await clientTaskExpand.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lever text`);
    await clientTaskExpand.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at text`);
    await clientTaskExpand.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description text`);
    console.log("[migrations] tasks expansion columns ensured");
  } catch (err) {
    console.error("[migrations] tasks expansion error:", err);
  } finally {
    clientTaskExpand.release();
  }

  // Forced Focus table (Task #147)
  const clientFF = await pool.connect();
  try {
    await clientFF.query(`
      CREATE TABLE IF NOT EXISTS forced_focus (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        assigned_to_user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        assigned_by_user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        company_id varchar REFERENCES companies(id) ON DELETE SET NULL,
        company_name text,
        contact_id varchar REFERENCES contacts(id) ON DELETE SET NULL,
        contact_name text,
        related_opportunity_id varchar,
        related_task_id varchar,
        lever text,
        action_text text NOT NULL,
        context_reason text,
        due_date text,
        status text NOT NULL DEFAULT 'active',
        created_at text NOT NULL,
        updated_at text
      )
    `);
    await clientFF.query(`CREATE INDEX IF NOT EXISTS idx_forced_focus_assigned_to ON forced_focus(assigned_to_user_id, status)`);
    await clientFF.query(`CREATE INDEX IF NOT EXISTS idx_forced_focus_org ON forced_focus(org_id, status)`);
    await clientFF.query(`CREATE INDEX IF NOT EXISTS idx_forced_focus_assigned_by ON forced_focus(assigned_by_user_id)`);
    console.log("[migrations] forced_focus table ensured");
  } catch (err) {
    console.error("[migrations] forced_focus error:", err);
  } finally {
    clientFF.release();
  }

  // Lane Carrier Outreach v1 — core tables (Task #148)
  const clientLCO = await pool.connect();
  try {
    // 1. Carrier catalog
    await clientLCO.query(`
      CREATE TABLE IF NOT EXISTS carriers (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name text NOT NULL,
        mc_dot text,
        regions text[] NOT NULL DEFAULT '{}',
        equipment_types text[] NOT NULL DEFAULT '{}',
        tags text[] NOT NULL DEFAULT '{}',
        primary_email text,
        backup_email text,
        last_email_validated_at text,
        notes text,
        created_at timestamp NOT NULL DEFAULT NOW(),
        updated_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientLCO.query(`CREATE INDEX IF NOT EXISTS idx_carriers_org ON carriers(org_id)`);

    // 2. Recurring lanes
    await clientLCO.query(`
      CREATE TABLE IF NOT EXISTS recurring_lanes (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        company_id varchar REFERENCES companies(id) ON DELETE SET NULL,
        company_name text,
        origin text NOT NULL,
        origin_state text,
        destination text NOT NULL,
        destination_state text,
        equipment_type text,
        avg_loads_per_week decimal(6,2),
        weeks_active integer DEFAULT 0,
        lookback_weeks integer DEFAULT 4,
        has_preferred_carrier_program boolean DEFAULT false,
        owner_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        overseer_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        lane_score integer,
        lane_score_factors jsonb,
        eligibility_confidence text NOT NULL DEFAULT 'medium',
        last_scored_at text,
        snoozed_until text,
        carriers_contacted_count integer DEFAULT 0,
        resolved_at text,
        created_at timestamp NOT NULL DEFAULT NOW(),
        updated_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientLCO.query(`CREATE INDEX IF NOT EXISTS idx_recurring_lanes_org ON recurring_lanes(org_id)`);
    await clientLCO.query(`CREATE INDEX IF NOT EXISTS idx_recurring_lanes_company ON recurring_lanes(org_id, company_id)`);
    await clientLCO.query(`CREATE INDEX IF NOT EXISTS idx_recurring_lanes_owner ON recurring_lanes(org_id, owner_user_id)`);
    await clientLCO.query(`ALTER TABLE recurring_lanes ADD COLUMN IF NOT EXISTS is_eligible boolean NOT NULL DEFAULT false`);

    // 3. Lane carrier interest (bench per lane)
    await clientLCO.query(`
      CREATE TABLE IF NOT EXISTS lane_carrier_interest (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        lane_id varchar NOT NULL REFERENCES recurring_lanes(id) ON DELETE CASCADE,
        carrier_id varchar REFERENCES carriers(id) ON DELETE SET NULL,
        carrier_name text NOT NULL,
        interest_status text NOT NULL DEFAULT 'needs_follow_up',
        reply_snippet text,
        last_reply_snippet text,
        classified_at text,
        notes text,
        fit_score integer,
        fit_reason text,
        outreach_sent_at text,
        created_at timestamp NOT NULL DEFAULT NOW(),
        updated_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientLCO.query(`CREATE INDEX IF NOT EXISTS idx_lci_lane ON lane_carrier_interest(lane_id)`);
    // Partial unique indexes matching application-level dedup:
    // (a) id-backed: one row per lane+carrier catalog entry
    await clientLCO.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lci_unique_carrier ON lane_carrier_interest(lane_id, carrier_id) WHERE carrier_id IS NOT NULL`);
    // (b) name-only: one row per lane+carrier name when no catalog entry exists yet
    await clientLCO.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lci_unique_name ON lane_carrier_interest(lane_id, carrier_name) WHERE carrier_id IS NULL`);

    // 4. Carrier outreach logs
    await clientLCO.query(`
      CREATE TABLE IF NOT EXISTS carrier_outreach_logs (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id),
        lane_id varchar NOT NULL REFERENCES recurring_lanes(id) ON DELETE CASCADE,
        company_id varchar REFERENCES companies(id) ON DELETE SET NULL,
        carrier_ids text[] NOT NULL DEFAULT '{}',
        carrier_names text[] NOT NULL DEFAULT '{}',
        actor_user_id varchar NOT NULL REFERENCES users(id),
        owner_user_id varchar REFERENCES users(id),
        overseer_user_id varchar REFERENCES users(id),
        outreach_mode text NOT NULL DEFAULT 'lane_building',
        email_drafts jsonb DEFAULT '[]',
        timestamp timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientLCO.query(`CREATE INDEX IF NOT EXISTS idx_col_lane ON carrier_outreach_logs(lane_id)`);
    await clientLCO.query(`CREATE INDEX IF NOT EXISTS idx_col_org ON carrier_outreach_logs(org_id)`);

    // 5. Add linked_lane_id to nba_cards
    await clientLCO.query(`ALTER TABLE nba_cards ADD COLUMN IF NOT EXISTS linked_lane_id varchar`);

    // 6. Carrier master-data columns (payee_code, phone, city, state)
    await clientLCO.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS payee_code text`);
    await clientLCO.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS phone text`);
    await clientLCO.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS city text`);
    await clientLCO.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS state text`);
    await clientLCO.query(`CREATE INDEX IF NOT EXISTS idx_carriers_payee ON carriers(org_id, payee_code) WHERE payee_code IS NOT NULL`);

    // 7. V1.5 — lane assignment tracking + carrier source type
    await clientLCO.query(`ALTER TABLE recurring_lanes ADD COLUMN IF NOT EXISTS assigned_at text`);
    await clientLCO.query(`ALTER TABLE recurring_lanes ADD COLUMN IF NOT EXISTS assigned_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL`);
    await clientLCO.query(`ALTER TABLE lane_carrier_interest ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'suggested'`);

    // 8. Phase 1 send-tracking on carrier_outreach_logs
    await clientLCO.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS sent_at timestamp`);
    await clientLCO.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS delivery_status varchar DEFAULT 'draft'`);
    await clientLCO.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS failure_reason text`);
    await clientLCO.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS recipients jsonb`);

    // 9. Phase 2 — external carrier sourcing + import
    await clientLCO.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS source_channel text`);
    await clientLCO.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS import_batch_id varchar`);
    await clientLCO.query(`CREATE INDEX IF NOT EXISTS idx_carriers_source ON carriers(org_id, source_channel) WHERE source_channel IS NOT NULL`);
    await clientLCO.query(`
      CREATE TABLE IF NOT EXISTS carrier_import_batches (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        lane_id varchar REFERENCES recurring_lanes(id) ON DELETE SET NULL,
        source text NOT NULL,
        created_by varchar NOT NULL REFERENCES users(id),
        created_at timestamp NOT NULL DEFAULT NOW(),
        carrier_count integer NOT NULL DEFAULT 0,
        new_count integer NOT NULL DEFAULT 0,
        matched_count integer NOT NULL DEFAULT 0,
        raw_input text
      )
    `);
    await clientLCO.query(`CREATE INDEX IF NOT EXISTS idx_cib_org ON carrier_import_batches(org_id)`);
    await clientLCO.query(`CREATE INDEX IF NOT EXISTS idx_cib_lane ON carrier_import_batches(lane_id) WHERE lane_id IS NOT NULL`);

    console.log("[migrations] lane carrier outreach tables ensured");
  } catch (err) {
    console.error("[migrations] lane carrier outreach tables error:", err);
  } finally {
    clientLCO.release();
  }

  // Feature Flags table (Task #148)
  const clientFlagTable = await pool.connect();
  try {
    await clientFlagTable.query(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        flag_key text NOT NULL,
        enabled boolean NOT NULL DEFAULT false,
        updated_at timestamp NOT NULL DEFAULT NOW(),
        updated_by_id varchar REFERENCES users(id),
        UNIQUE (org_id, flag_key)
      )
    `);
    // Ensure missing columns on pre-existing tables from earlier schema iterations
    await clientFlagTable.query(`ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS updated_by_id varchar REFERENCES users(id)`);
    await clientFlagTable.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'feature_flags' AND column_name = 'updated_at' AND data_type = 'text'
        ) THEN
          UPDATE feature_flags SET updated_at = NOW()::text WHERE updated_at IS NULL;
          ALTER TABLE feature_flags
            ALTER COLUMN updated_at TYPE timestamp USING updated_at::timestamp,
            ALTER COLUMN updated_at SET DEFAULT NOW(),
            ALTER COLUMN updated_at SET NOT NULL;
        END IF;
      END $$
    `);
    // Seed lane_carrier_outreach_v1 as disabled by default (operators enable per org for controlled rollout)
    await clientFlagTable.query(`
      INSERT INTO feature_flags (id, org_id, flag_key, enabled)
      SELECT gen_random_uuid(), o.id, 'lane_carrier_outreach_v1', false
      FROM organizations o
      ON CONFLICT (org_id, flag_key) DO NOTHING
    `);
    console.log("[migrations] feature_flags table ensured");
  } catch (err) {
    console.error("[migrations] feature_flags error:", err);
  } finally {
    clientFlagTable.release();
  }

  // Carrier Hub — new columns on carriers + carrier_contacts + carrier_claimed_lanes tables
  const clientCarrierHub = await pool.connect();
  try {
    // New columns on carriers table
    await clientCarrierHub.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS legal_name text`);
    await clientCarrierHub.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS dot_number text`);
    await clientCarrierHub.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS states_served text[] DEFAULT '{}'::text[]`);
    await clientCarrierHub.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS metro_areas text[] DEFAULT '{}'::text[]`);
    await clientCarrierHub.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS equipment_notes text`);
    await clientCarrierHub.query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'`);

    // carrier_contacts table
    await clientCarrierHub.query(`
      CREATE TABLE IF NOT EXISTS carrier_contacts (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        carrier_id varchar NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
        name text NOT NULL,
        role text NOT NULL DEFAULT 'dispatcher',
        email text,
        phone text,
        extension text,
        preferred_method text,
        notes text,
        is_primary boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamp NOT NULL DEFAULT NOW(),
        updated_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientCarrierHub.query(`CREATE INDEX IF NOT EXISTS idx_carrier_contacts_carrier ON carrier_contacts(carrier_id)`);

    // carrier_claimed_lanes table
    await clientCarrierHub.query(`
      CREATE TABLE IF NOT EXISTS carrier_claimed_lanes (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        carrier_id varchar NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
        origin_state text,
        origin_city text,
        dest_state text,
        dest_city text,
        equipment text,
        lane_type text NOT NULL DEFAULT 'prefer',
        notes text,
        created_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientCarrierHub.query(`CREATE INDEX IF NOT EXISTS idx_carrier_claimed_lanes_carrier ON carrier_claimed_lanes(carrier_id)`);

    console.log("[migrations] carrier hub tables ensured");
  } catch (err) {
    console.error("[migrations] carrier hub error:", err);
  } finally {
    clientCarrierHub.release();
  }

  // Lane Coverage Profiles — Task #157
  const clientCoverage = await pool.connect();
  try {
    await clientCoverage.query(`
      CREATE TABLE IF NOT EXISTS lane_coverage_profiles (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        lane_id varchar REFERENCES recurring_lanes(id) ON DELETE SET NULL,
        lane_key text NOT NULL,
        coverage_status text NOT NULL DEFAULT 'unstable',
        sample_size integer NOT NULL DEFAULT 0,
        qualified_carrier_count integer NOT NULL DEFAULT 0,
        top_carrier_coverage_share numeric(6,4),
        computed_at timestamp NOT NULL DEFAULT NOW(),
        manual_override_status text,
        manual_override_reason text,
        manually_confirmed_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        manually_confirmed_at timestamp,
        broaden_search_active boolean NOT NULL DEFAULT false,
        updated_at timestamp NOT NULL DEFAULT NOW(),
        UNIQUE (org_id, lane_key)
      )
    `);
    await clientCoverage.query(`CREATE INDEX IF NOT EXISTS idx_lane_coverage_profiles_org ON lane_coverage_profiles(org_id)`);
    await clientCoverage.query(`CREATE INDEX IF NOT EXISTS idx_lane_coverage_profiles_lane ON lane_coverage_profiles(lane_id) WHERE lane_id IS NOT NULL`);

    await clientCoverage.query(`
      CREATE TABLE IF NOT EXISTS lane_coverage_profile_carriers (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id varchar NOT NULL REFERENCES lane_coverage_profiles(id) ON DELETE CASCADE,
        carrier_id varchar REFERENCES carriers(id) ON DELETE SET NULL,
        carrier_name text NOT NULL,
        incumbent_rank integer NOT NULL,
        successful_load_count integer NOT NULL DEFAULT 0,
        recent_load_count integer NOT NULL DEFAULT 0,
        coverage_share numeric(6,4),
        last_used_at text,
        last_success_at text,
        is_current_primary boolean NOT NULL DEFAULT false,
        created_at timestamp NOT NULL DEFAULT NOW(),
        updated_at timestamp NOT NULL DEFAULT NOW(),
        UNIQUE (profile_id, incumbent_rank)
      )
    `);
    await clientCoverage.query(`CREATE INDEX IF NOT EXISTS idx_lcpc_profile ON lane_coverage_profile_carriers(profile_id)`);
    await clientCoverage.query(`CREATE INDEX IF NOT EXISTS idx_lcpc_carrier ON lane_coverage_profile_carriers(carrier_id) WHERE carrier_id IS NOT NULL`);

    console.log("[migrations] lane coverage profile tables ensured");
  } catch (err) {
    console.error("[migrations] lane coverage profile tables error:", err);
  } finally {
    clientCoverage.release();
  }

  // Task #180 — add outreach_log column to lane_carriers for procurement outreach tracking
  const clientProcurement = await pool.connect();
  try {
    await clientProcurement.query(`ALTER TABLE lane_carriers ADD COLUMN IF NOT EXISTS outreach_log jsonb NOT NULL DEFAULT '[]'::jsonb`);
    console.log("[migrations] lane_carriers.outreach_log column ensured");
  } catch (err) {
    console.error("[migrations] lane_carriers outreach_log column error:", err);
  } finally {
    clientProcurement.release();
  }

  // Task #180 — make carrier_outreach_logs.lane_id nullable so procurement sends can log without a matched recurring lane
  const clientOutreachLog = await pool.connect();
  try {
    await clientOutreachLog.query(`ALTER TABLE carrier_outreach_logs ALTER COLUMN lane_id DROP NOT NULL`);
    await clientOutreachLog.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS procurement_task_id varchar`);
    await clientOutreachLog.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS procurement_lane text`);
    console.log("[migrations] carrier_outreach_logs: lane_id nullable + procurement columns added");
  } catch (err) {
    console.error("[migrations] carrier_outreach_logs procurement columns migration error:", err);
  } finally {
    clientOutreachLog.release();
  }
}
