import { Pool } from "pg";
import { FIXTURE_MAILBOX_LIKE_PATTERNS, setFixtureContaminationScan } from "./lib/fixtureMailboxes";
import { FAKE_NAME_SQL_RULES } from "@shared/fakeCustomerName";

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

    // Task #461: Provision Gabe Broos so he can sign in via Clerk.
    // Idempotent: only inserts if no row exists for this email. clerk_user_id
    // is left null so the existing first-sign-in email-linking path attaches
    // his Clerk identity automatically on his next login.
    await client.query(`
      INSERT INTO users (organization_id, username, name, role, manager_id, created_at)
      SELECT
        'da3ed822-8846-4435-bb13-3cc4bf26f71d',
        'gabe.broos@valuetruck.com',
        'Gabe Broos',
        'logistics_manager',
        '1ff95654-faf0-43ba-b98a-0b5522dd886e',
        NOW()::text
      WHERE NOT EXISTS (
        SELECT 1 FROM users WHERE username = 'gabe.broos@valuetruck.com'
      )
    `);
    console.log("[migrations] gabe.broos user provisioned");

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
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_financial_uploads_uploaded_by ON financial_uploads(uploaded_by)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_touchpoints_logged_by_date    ON touchpoints(logged_by_id, date DESC)`);
    await clientIdx.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status         ON tasks(assigned_to, status)`);
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

  // ── Task #182: Inbound Email Reply Tracking ──────────────────────────────
  const clientReply = await pool.connect();
  try {
    await clientReply.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS thread_id text`);
    await clientReply.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS reply_received_at timestamp`);
    await clientReply.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS reply_snippet text`);
    await clientReply.query(`CREATE INDEX IF NOT EXISTS idx_outreach_thread_id ON carrier_outreach_logs(thread_id) WHERE thread_id IS NOT NULL`);
    console.log("[migrations] carrier_outreach_logs reply tracking columns ensured");
  } catch (err) {
    console.error("[migrations] reply tracking migration error:", err);
  } finally {
    clientReply.release();
  }

  // Task #183 — Two-way email foundation: add direction, providerMessageId, conversationId, and inbound tracking columns
  const clientTwoWayEmail = await pool.connect();
  try {
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS direction varchar NOT NULL DEFAULT 'outbound'`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS provider_message_id text`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS conversation_id text`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS from_email text`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS to_email text`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS subject text`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS body_preview text`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS raw_payload_ref text`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS received_at timestamp`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS process_status varchar`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS matched_carrier_id varchar REFERENCES carriers(id) ON DELETE SET NULL`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS matched_lane_id varchar REFERENCES recurring_lanes(id) ON DELETE SET NULL`);
    await clientTwoWayEmail.query(`ALTER TABLE carrier_outreach_logs ADD COLUMN IF NOT EXISTS match_confidence varchar`);
    // Unique index on provider_message_id for idempotent inbound processing (partial — only for non-null)
    await clientTwoWayEmail.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_outreach_logs_provider_message_id
      ON carrier_outreach_logs (provider_message_id)
      WHERE provider_message_id IS NOT NULL
    `);
    await clientTwoWayEmail.query(`CREATE INDEX IF NOT EXISTS idx_carrier_outreach_logs_conversation_id ON carrier_outreach_logs(conversation_id) WHERE conversation_id IS NOT NULL`);
    await clientTwoWayEmail.query(`CREATE INDEX IF NOT EXISTS idx_carrier_outreach_logs_org_direction ON carrier_outreach_logs(org_id, direction)`);
    console.log("[migrations] carrier_outreach_logs: two-way email columns added (Task #183)");
  } catch (err) {
    console.error("[migrations] carrier_outreach_logs two-way email migration error:", err);
  } finally {
    clientTwoWayEmail.release();
  }

  // Task #185 — Market Signal Intelligence Layer: market_events and market_signals tables
  const clientMarketSignal = await pool.connect();
  try {
    await clientMarketSignal.query(`
      CREATE TABLE IF NOT EXISTS market_events (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type text NOT NULL,
        scope_type text NOT NULL,
        scope_key text NOT NULL,
        equipment_type text,
        origin_region text,
        destination_region text,
        account_id varchar,
        carrier_id varchar,
        event_value decimal(14,4),
        metadata jsonb,
        occurred_at timestamp NOT NULL DEFAULT now(),
        recorded_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientMarketSignal.query(`CREATE INDEX IF NOT EXISTS idx_market_events_scope ON market_events(scope_type, scope_key)`);
    await clientMarketSignal.query(`CREATE INDEX IF NOT EXISTS idx_market_events_occurred_at ON market_events(occurred_at DESC)`);
    await clientMarketSignal.query(`CREATE INDEX IF NOT EXISTS idx_market_events_event_type ON market_events(event_type)`);

    await clientMarketSignal.query(`
      CREATE TABLE IF NOT EXISTS market_signals (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        signal_type text NOT NULL,
        scope_type text NOT NULL,
        scope_key text NOT NULL,
        equipment_type text,
        status text NOT NULL DEFAULT 'active',
        severity text NOT NULL DEFAULT 'medium',
        confidence decimal(5,4) NOT NULL DEFAULT 0,
        evidence_payload jsonb NOT NULL DEFAULT '{}',
        explanation text NOT NULL DEFAULT '',
        first_detected_at timestamp NOT NULL DEFAULT now(),
        last_evaluated_at timestamp NOT NULL DEFAULT now(),
        cooling_started_at timestamp,
        resolved_at timestamp
      )
    `);
    // Ensure Task #185 columns exist if table was previously created with Task #186's simpler schema
    await clientMarketSignal.query(`ALTER TABLE market_signals ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'region'`);
    await clientMarketSignal.query(`ALTER TABLE market_signals ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT ''`);
    await clientMarketSignal.query(`ALTER TABLE market_signals ADD COLUMN IF NOT EXISTS confidence decimal(5,4) NOT NULL DEFAULT 0`);
    await clientMarketSignal.query(`ALTER TABLE market_signals ADD COLUMN IF NOT EXISTS evidence_payload jsonb NOT NULL DEFAULT '{}'`);
    await clientMarketSignal.query(`ALTER TABLE market_signals ADD COLUMN IF NOT EXISTS explanation text NOT NULL DEFAULT ''`);
    await clientMarketSignal.query(`ALTER TABLE market_signals ADD COLUMN IF NOT EXISTS first_detected_at timestamp NOT NULL DEFAULT now()`);
    await clientMarketSignal.query(`ALTER TABLE market_signals ADD COLUMN IF NOT EXISTS last_evaluated_at timestamp NOT NULL DEFAULT now()`);
    await clientMarketSignal.query(`ALTER TABLE market_signals ADD COLUMN IF NOT EXISTS cooling_started_at timestamp`);

    await clientMarketSignal.query(`CREATE INDEX IF NOT EXISTS idx_market_signals_scope ON market_signals(scope_type, scope_key)`);
    await clientMarketSignal.query(`CREATE INDEX IF NOT EXISTS idx_market_signals_status ON market_signals(status)`);
    await clientMarketSignal.query(`CREATE INDEX IF NOT EXISTS idx_market_signals_signal_type ON market_signals(signal_type)`);
    await clientMarketSignal.query(`CREATE INDEX IF NOT EXISTS idx_market_signals_last_evaluated ON market_signals(last_evaluated_at DESC)`);

    // Partial unique index: enforce one active/cooling signal per (signal_type, scope_type, scope_key, equipment_type).
    // Uses COALESCE on equipment_type so NULL values are included in the uniqueness check.
    await clientMarketSignal.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_market_signals_active_dedup
        ON market_signals (signal_type, scope_type, scope_key, COALESCE(equipment_type, ''))
        WHERE status IN ('active', 'cooling')
    `);

    // CHECK constraints for enum-like columns (idempotent via pg_constraint lookup).
    // Drop-and-recreate pattern handles the case where the constraint was previously
    // created with incorrect values (e.g., rate_change/lane_award instead of load_posted/load_covered).
    await clientMarketSignal.query(`
      DO $$ BEGIN
        -- Drop the constraint if it exists (regardless of value set) then re-add correct values
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'market_events_event_type_check') THEN
          ALTER TABLE market_events DROP CONSTRAINT market_events_event_type_check;
        END IF;
        ALTER TABLE market_events ADD CONSTRAINT market_events_event_type_check
          CHECK (event_type IN ('demand_request','carrier_capacity_declaration','quote_submission','load_posted','load_covered'));
      END $$
    `);
    await clientMarketSignal.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'market_events_scope_type_check') THEN
          ALTER TABLE market_events ADD CONSTRAINT market_events_scope_type_check
            CHECK (scope_type IN ('region','corridor','equipment_region','national'));
        END IF;
      END $$
    `);
    await clientMarketSignal.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'market_signals_signal_type_check') THEN
          ALTER TABLE market_signals ADD CONSTRAINT market_signals_signal_type_check
            CHECK (signal_type IN ('demand_surge','capacity_shortage','demand_capacity_imbalance','quote_activity_spike','carrier_capacity_declaration'));
        END IF;
      END $$
    `);
    await clientMarketSignal.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'market_signals_scope_type_check') THEN
          ALTER TABLE market_signals ADD CONSTRAINT market_signals_scope_type_check
            CHECK (scope_type IN ('region','corridor','equipment_region','national'));
        END IF;
      END $$
    `);
    await clientMarketSignal.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'market_signals_status_check') THEN
          ALTER TABLE market_signals ADD CONSTRAINT market_signals_status_check
            CHECK (status IN ('active','cooling','resolved','suppressed'));
        END IF;
      END $$
    `);
    await clientMarketSignal.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'market_signals_severity_check') THEN
          ALTER TABLE market_signals ADD CONSTRAINT market_signals_severity_check
            CHECK (severity IN ('low','medium','high','critical'));
        END IF;
      END $$
    `);

    // Task #186 — add market_signal_id to nba_cards (nullable)
    await clientMarketSignal.query(`
      ALTER TABLE nba_cards ADD COLUMN IF NOT EXISTS market_signal_id varchar
    `);
    await clientMarketSignal.query(`
      CREATE INDEX IF NOT EXISTS idx_nba_cards_market_signal_id ON nba_cards(market_signal_id) WHERE market_signal_id IS NOT NULL
    `);

    console.log("[migrations] market_events and market_signals tables ensured (+ Task #186 nba_cards columns)");
  } catch (err) {
    console.error("[migrations] market signal tables migration error:", err);
  } finally {
    clientMarketSignal.release();
  }

  // Task #187 — Carrier-Side Market Signal NBAs: carrier_market_nbas table
  const clientCarrierNbas = await pool.connect();
  try {
    await clientCarrierNbas.query(`
      CREATE TABLE IF NOT EXISTS carrier_market_nbas (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        carrier_id varchar NOT NULL,
        market_signal_id varchar NOT NULL,
        recommendation_type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        urgency_score integer NOT NULL DEFAULT 0,
        explanation jsonb NOT NULL DEFAULT '{}',
        suppression_reason text,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        first_seen_at timestamp NOT NULL DEFAULT now(),
        last_action_at timestamp
      )
    `);
    await clientCarrierNbas.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'carrier_market_nbas_status_check') THEN
          ALTER TABLE carrier_market_nbas ADD CONSTRAINT carrier_market_nbas_status_check
            CHECK (status IN ('pending','in_progress','completed','dismissed'));
        END IF;
      END $$
    `);
    await clientCarrierNbas.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_market_nbas_dedup
        ON carrier_market_nbas (carrier_id, market_signal_id, recommendation_type)
    `);
    await clientCarrierNbas.query(`CREATE INDEX IF NOT EXISTS idx_carrier_market_nbas_signal ON carrier_market_nbas(market_signal_id)`);
    await clientCarrierNbas.query(`CREATE INDEX IF NOT EXISTS idx_carrier_market_nbas_carrier ON carrier_market_nbas(carrier_id)`);
    await clientCarrierNbas.query(`CREATE INDEX IF NOT EXISTS idx_carrier_market_nbas_status ON carrier_market_nbas(status)`);
    console.log("[migrations] carrier_market_nbas table ensured (Task #187)");
  } catch (err) {
    console.error("[migrations] carrier_market_nbas migration error:", err);
  } finally {
    clientCarrierNbas.release();
  }

  // Task #190 — Email Intelligence Layer v1
  const clientEmailIntel = await pool.connect();
  try {
    await clientEmailIntel.query(`
      CREATE TABLE IF NOT EXISTS email_messages (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        thread_id text,
        direction text NOT NULL,
        from_email text,
        to_email text,
        cc_email text,
        subject text,
        body text,
        linked_account_id varchar REFERENCES companies(id) ON DELETE SET NULL,
        linked_carrier_id varchar REFERENCES carriers(id) ON DELETE SET NULL,
        linked_lane_id varchar REFERENCES recurring_lanes(id) ON DELETE SET NULL,
        linked_load_id varchar,
        linked_task_id varchar REFERENCES tasks(id) ON DELETE SET NULL,
        linked_nba_id varchar REFERENCES nba_cards(id) ON DELETE SET NULL,
        linked_outreach_log_id varchar REFERENCES carrier_outreach_logs(id) ON DELETE SET NULL,
        processed_for_signals_at timestamp,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_messages_org_id ON email_messages(org_id)
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_messages_thread_id ON email_messages(thread_id) WHERE thread_id IS NOT NULL
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_messages_unprocessed ON email_messages(created_at) WHERE processed_for_signals_at IS NULL
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_messages_carrier ON email_messages(linked_carrier_id) WHERE linked_carrier_id IS NOT NULL
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_messages_account ON email_messages(linked_account_id) WHERE linked_account_id IS NOT NULL
    `);
    await clientEmailIntel.query(`
      CREATE TABLE IF NOT EXISTS email_signals (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id varchar NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
        intent_type text NOT NULL,
        intent_subtype text,
        actor_type text NOT NULL,
        entity_type text,
        entity_id varchar,
        confidence integer NOT NULL DEFAULT 50,
        extracted_data jsonb DEFAULT '{}',
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_signals_message_id ON email_signals(message_id)
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_signals_entity ON email_signals(entity_type, entity_id)
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_signals_intent_type ON email_signals(intent_type)
    `);
    // Add outcome column to crm_opportunities if absent
    await clientEmailIntel.query(`
      ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS outcome text
    `);
    // carrier_intel_suggestions table (Task #193)
    await clientEmailIntel.query(`
      CREATE TABLE IF NOT EXISTS carrier_intel_suggestions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        carrier_id varchar NOT NULL,
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_type text NOT NULL,
        email_signal_id varchar REFERENCES email_signals(id) ON DELETE SET NULL,
        market_signal_id varchar,
        suggestion_type text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}',
        confidence_score integer NOT NULL DEFAULT 50,
        status text NOT NULL DEFAULT 'pending',
        comment text,
        accepted_by_user_id varchar,
        rejected_by_user_id varchar,
        accepted_at timestamp,
        rejected_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_carrier_id
        ON carrier_intel_suggestions(carrier_id)
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_status
        ON carrier_intel_suggestions(carrier_id, status)
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_email_signal
        ON carrier_intel_suggestions(email_signal_id) WHERE email_signal_id IS NOT NULL
    `);
    // Add provider_message_id for inbound idempotency (Task #190 rev)
    await clientEmailIntel.query(`
      ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS provider_message_id text
    `);
    // Deduplicate any pre-existing rows that would violate the unique
    // index below — but ONLY when the index doesn't yet exist. The
    // window-function scan is expensive on large tables; once the
    // unique index is in place, duplicates are impossible and we can
    // skip this on every subsequent boot.
    const idxCheck = await clientEmailIntel.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_email_messages_provider_msg_id' LIMIT 1`,
    );
    if (idxCheck.rowCount === 0) {
      // Wrap dedup + index creation in a transaction with an EXCLUSIVE table
      // lock. Without the lock, a concurrent inbound webhook insert between
      // the DELETE and CREATE UNIQUE INDEX statements would re-introduce a
      // duplicate and cause the index creation to fail (race condition that
      // has blocked deploys repeatedly). EXCLUSIVE allows reads but blocks
      // INSERT/UPDATE/DELETE until COMMIT, guaranteeing the index sees a
      // dedup'd snapshot. Lock auto-releases on COMMIT or ROLLBACK.
      try {
        await clientEmailIntel.query("BEGIN");
        await clientEmailIntel.query("LOCK TABLE email_messages IN EXCLUSIVE MODE");
        await clientEmailIntel.query(`
          DELETE FROM email_messages em
          USING (
            SELECT id FROM (
              SELECT id,
                     ROW_NUMBER() OVER (
                       PARTITION BY org_id, provider_message_id
                       ORDER BY created_at ASC, id ASC
                     ) AS rn
              FROM email_messages
              WHERE provider_message_id IS NOT NULL
            ) ranked
            WHERE ranked.rn > 1
          ) dups
          WHERE em.id = dups.id
        `);
        await clientEmailIntel.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_provider_msg_id
            ON email_messages(org_id, provider_message_id)
            WHERE provider_message_id IS NOT NULL
        `);
        await clientEmailIntel.query("COMMIT");
        console.log("[migrations] email_messages dedup + unique index created (locked)");
      } catch (err) {
        await clientEmailIntel.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }
    // Add linked entity columns to email_signals (Task #191)
    await clientEmailIntel.query(`
      ALTER TABLE email_signals ADD COLUMN IF NOT EXISTS linked_account_id varchar REFERENCES companies(id) ON DELETE SET NULL
    `);
    await clientEmailIntel.query(`
      ALTER TABLE email_signals ADD COLUMN IF NOT EXISTS linked_carrier_id varchar REFERENCES carriers(id) ON DELETE SET NULL
    `);
    await clientEmailIntel.query(`
      ALTER TABLE email_signals ADD COLUMN IF NOT EXISTS linked_lane_id varchar REFERENCES recurring_lanes(id) ON DELETE SET NULL
    `);
    await clientEmailIntel.query(`
      ALTER TABLE email_signals ADD COLUMN IF NOT EXISTS linked_opportunity_id varchar
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_signals_linked_account ON email_signals(linked_account_id) WHERE linked_account_id IS NOT NULL
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_signals_linked_carrier ON email_signals(linked_carrier_id) WHERE linked_carrier_id IS NOT NULL
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_signals_linked_opportunity ON email_signals(linked_opportunity_id) WHERE linked_opportunity_id IS NOT NULL
    `);
    // carrier_email_suggestions staging table (Task #191)
    await clientEmailIntel.query(`
      CREATE TABLE IF NOT EXISTS carrier_email_suggestions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        carrier_id varchar NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
        email_message_id varchar NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
        thread_id text,
        suggestion_type text NOT NULL,
        payload jsonb DEFAULT '{}',
        confidence integer NOT NULL DEFAULT 50,
        payload_hash text,
        status text NOT NULL DEFAULT 'pending',
        created_at timestamp DEFAULT NOW() NOT NULL
      )
    `);
    await clientEmailIntel.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_email_suggestions_dedup
        ON carrier_email_suggestions(carrier_id, suggestion_type, payload_hash, thread_id)
        WHERE thread_id IS NOT NULL AND payload_hash IS NOT NULL
    `);
    // email_outcome_links join table (Task #191)
    await clientEmailIntel.query(`
      CREATE TABLE IF NOT EXISTS email_outcome_links (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        email_signal_id varchar NOT NULL REFERENCES email_signals(id) ON DELETE CASCADE,
        entity_type text NOT NULL,
        entity_id varchar NOT NULL,
        outcome_type text NOT NULL,
        created_at timestamp DEFAULT NOW() NOT NULL
      )
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_outcome_links_signal ON email_outcome_links(email_signal_id)
    `);
    await clientEmailIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_email_outcome_links_entity ON email_outcome_links(entity_type, entity_id)
    `);
    console.log("[migrations] email_messages, email_signals tables ensured, crm_opportunities.outcome added (Task #190)");
  } catch (err) {
    console.error("[migrations] email intelligence migration error:", err);
  } finally {
    clientEmailIntel.release();
  }

  // Task #193 / #194: Carrier Intel Suggestions staging table
  const clientCarrierIntel = await pool.connect();
  try {
    await clientCarrierIntel.query(`
      CREATE TABLE IF NOT EXISTS carrier_intel_suggestions (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        carrier_id VARCHAR NOT NULL,
        org_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL DEFAULT 'email_signal',
        email_signal_id VARCHAR REFERENCES email_signals(id) ON DELETE SET NULL,
        market_signal_id VARCHAR,
        suggestion_type TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}',
        confidence_score INTEGER NOT NULL DEFAULT 50,
        status TEXT NOT NULL DEFAULT 'pending',
        comment TEXT,
        accepted_by_user_id VARCHAR,
        rejected_by_user_id VARCHAR,
        accepted_at TIMESTAMP,
        rejected_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await clientCarrierIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_carrier
        ON carrier_intel_suggestions(carrier_id)
    `);
    await clientCarrierIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_org
        ON carrier_intel_suggestions(org_id)
    `);
    await clientCarrierIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_status
        ON carrier_intel_suggestions(status)
    `);
    // Task #769: resolution_reason column distinguishes auto-resolution audit
    // reasons (e.g. "auto_resolved_stale") from human accept/reject actions.
    await clientCarrierIntel.query(`
      ALTER TABLE carrier_intel_suggestions ADD COLUMN IF NOT EXISTS resolution_reason TEXT
    `);
    // Composite index for the nightly stale-cleanup scan.
    await clientCarrierIntel.query(`
      CREATE INDEX IF NOT EXISTS idx_carrier_intel_suggestions_pending_age
        ON carrier_intel_suggestions(org_id, created_at) WHERE status = 'pending'
    `);
    console.log("[migrations] carrier_intel_suggestions table ensured (Task #193/#194/#769)");
  } catch (err) {
    console.error("[migrations] carrier_intel_suggestions migration error:", err);
  } finally {
    clientCarrierIntel.release();
  }

  // Task #201: Customer Contact Capture — extend contacts + add account_contact_suggestions
  const clientContactCapture = await pool.connect();
  try {
    // Extend contacts table with new fields
    await clientContactCapture.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP`);
    await clientContactCapture.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_type TEXT`);
    await clientContactCapture.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS role_type TEXT`);
    await clientContactCapture.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`);
    await clientContactCapture.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT false`);

    // Create account_contact_suggestions table
    await clientContactCapture.query(`
      CREATE TABLE IF NOT EXISTS account_contact_suggestions (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id VARCHAR NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        org_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        email_address TEXT NOT NULL,
        suggested_name TEXT,
        suggested_title TEXT,
        suggested_phone TEXT,
        suggestion_source TEXT NOT NULL DEFAULT 'email_thread',
        confidence_score INTEGER NOT NULL DEFAULT 50,
        status TEXT NOT NULL DEFAULT 'pending',
        thread_count INTEGER NOT NULL DEFAULT 1,
        email_message_id VARCHAR,
        thread_id TEXT,
        snoozed_until TIMESTAMP,
        acted_by_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    // Unique constraint for deduplication
    await clientContactCapture.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS account_contact_suggestions_account_email_idx
        ON account_contact_suggestions(account_id, email_address)
    `);

    await clientContactCapture.query(`
      CREATE INDEX IF NOT EXISTS idx_account_contact_suggestions_org
        ON account_contact_suggestions(org_id)
    `);
    await clientContactCapture.query(`
      CREATE INDEX IF NOT EXISTS idx_account_contact_suggestions_status
        ON account_contact_suggestions(status)
    `);

    console.log("[migrations] contacts extended and account_contact_suggestions table ensured (Task #201)");
  } catch (err) {
    console.error("[migrations] account_contact_suggestions migration error:", err);
  } finally {
    clientContactCapture.release();
  }

  // ── Conversation Inbox — email_conversation_threads (Task #202) ──────────────
  const clientConversations = await pool.connect();
  try {
    await clientConversations.query(`
      CREATE TABLE IF NOT EXISTS "email_conversation_threads" (
        "id"                  varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "org_id"              varchar NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "thread_id"           text NOT NULL,
        "linked_account_id"   varchar REFERENCES "companies"("id") ON DELETE SET NULL,
        "linked_carrier_id"   varchar REFERENCES "carriers"("id") ON DELETE SET NULL,
        "owner_user_id"       varchar REFERENCES "users"("id") ON DELETE SET NULL,
        "waiting_state"       text NOT NULL DEFAULT 'waiting_on_us',
        "response_priority"   text NOT NULL DEFAULT 'normal',
        "last_message_id"     varchar REFERENCES "email_messages"("id") ON DELETE SET NULL,
        "last_incoming_at"    timestamp,
        "last_outgoing_at"    timestamp,
        "waiting_since_at"    timestamp,
        "overdue_at"          timestamp,
        "created_at"          timestamp NOT NULL DEFAULT now(),
        "updated_at"          timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientConversations.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "email_conversation_threads_org_thread"
        ON "email_conversation_threads" ("org_id", "thread_id")
    `);
    await clientConversations.query(`
      CREATE INDEX IF NOT EXISTS "email_conversation_threads_owner_waiting"
        ON "email_conversation_threads" ("owner_user_id", "waiting_state")
    `);
    console.log("[migrations] email_conversation_threads table ensured (Task #202)");
  } catch (err) {
    console.error("[migrations] email_conversation_threads migration error:", err);
  } finally {
    clientConversations.release();
  }

  // ── lane_summary_cache (Task #200: LWQ Data Flow & Performance Optimization) ──
  const clientLaneSummaryCache = await pool.connect();
  try {
    await clientLaneSummaryCache.query(`
      CREATE TABLE IF NOT EXISTS "lane_summary_cache" (
        "lane_id"                       varchar PRIMARY KEY REFERENCES "recurring_lanes"("id") ON DELETE CASCADE,
        "lane_score"                    integer,
        "priority"                      integer DEFAULT 0,
        "origin"                        text NOT NULL,
        "origin_state"                  text,
        "destination"                   text NOT NULL,
        "destination_state"             text,
        "equipment_type"                text,
        "avg_loads_per_week"            decimal(6, 2),
        "company_id"                    varchar,
        "company_name"                  text,
        "owner_user_id"                 varchar,
        "carriers_contacted_count"      integer DEFAULT 0,
        "contactable_count"             integer DEFAULT 0,
        "total_bench_count"             integer DEFAULT 0,
        "historical_count"              integer DEFAULT 0,
        "missing_contact_count"         integer DEFAULT 0,
        "org_id"                        varchar,
        "is_eligible"                   boolean DEFAULT true,
        "has_preferred_carrier_program" boolean DEFAULT false,
        "snoozed_until"                 text,
        "resolved_at"                   text,
        "updated_at"                    timestamp DEFAULT now() NOT NULL
      )
    `);
    await clientLaneSummaryCache.query(`ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "contactable_count" integer DEFAULT 0`);
    await clientLaneSummaryCache.query(`ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "total_bench_count" integer DEFAULT 0`);
    await clientLaneSummaryCache.query(`ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "historical_count" integer DEFAULT 0`);
    await clientLaneSummaryCache.query(`ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "missing_contact_count" integer DEFAULT 0`);
    await clientLaneSummaryCache.query(`ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "org_id" varchar`);
    await clientLaneSummaryCache.query(`ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "is_eligible" boolean DEFAULT true`);
    await clientLaneSummaryCache.query(`ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "has_preferred_carrier_program" boolean DEFAULT false`);
    await clientLaneSummaryCache.query(`ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "snoozed_until" text`);
    await clientLaneSummaryCache.query(`CREATE INDEX IF NOT EXISTS "lane_summary_cache_owner_resolved_score" ON "lane_summary_cache" ("owner_user_id", "resolved_at", "lane_score")`);
    await clientLaneSummaryCache.query(`CREATE INDEX IF NOT EXISTS "lane_summary_cache_org_resolved_score" ON "lane_summary_cache" ("org_id", "resolved_at", "lane_score")`);
    await clientLaneSummaryCache.query(`CREATE INDEX IF NOT EXISTS "recurring_lanes_owner_resolved" ON "recurring_lanes" ("owner_user_id", "resolved_at")`);
    await clientLaneSummaryCache.query(`CREATE INDEX IF NOT EXISTS "recurring_lanes_lane_score_desc" ON "recurring_lanes" ("lane_score" DESC)`);
    await clientLaneSummaryCache.query(`CREATE INDEX IF NOT EXISTS "tasks_assigned_status" ON "tasks" ("assigned_to", "status")`);
    await clientLaneSummaryCache.query(`CREATE INDEX IF NOT EXISTS "lane_carrier_interest_lane_id_idx" ON "lane_carrier_interest" ("lane_id")`);
    console.log("[migrations] lane_summary_cache table + indexes ensured (Task #200)");
  } catch (err) {
    console.error("[migrations] lane_summary_cache migration error:", err);
  } finally {
    clientLaneSummaryCache.release();
  }

  // ── Geographic Lane Patterns + Responsibilities (Task #203) ──────────────────
  const clientGeoLanes = await pool.connect();
  try {
    await clientGeoLanes.query(`
      CREATE TABLE IF NOT EXISTS "geographic_lane_patterns" (
        "id"                 varchar PRIMARY KEY,
        "org_id"             varchar,
        "name"               text NOT NULL,
        "origin_region"      text NOT NULL,
        "destination_region" text NOT NULL,
        "named_corridor"     text,
        "description"        text,
        "is_baseline"        boolean DEFAULT false NOT NULL,
        "created_at"         timestamp DEFAULT now() NOT NULL
      )
    `);
    await clientGeoLanes.query(`ALTER TABLE geographic_lane_patterns ADD COLUMN IF NOT EXISTS is_baseline boolean DEFAULT false NOT NULL`);
    await clientGeoLanes.query(`
      CREATE INDEX IF NOT EXISTS idx_geographic_lane_patterns_org
        ON geographic_lane_patterns(org_id)
    `);

    await clientGeoLanes.query(`
      CREATE TABLE IF NOT EXISTS "account_contact_lane_pattern_responsibilities" (
        "id"                   varchar PRIMARY KEY,
        "org_id"               varchar NOT NULL,
        "account_id"           varchar NOT NULL,
        "contact_id"           varchar NOT NULL,
        "lane_pattern_id"      varchar NOT NULL REFERENCES "geographic_lane_patterns"("id") ON DELETE CASCADE,
        "status"               text DEFAULT 'suggested' NOT NULL,
        "confidence_score"     integer DEFAULT 0 NOT NULL,
        "responsibility_type"  text,
        "evidence_count"       integer DEFAULT 0 NOT NULL,
        "evidence_event_keys"  text[],
        "source_types"         text[],
        "first_seen_at"        timestamp DEFAULT now() NOT NULL,
        "last_seen_at"         timestamp DEFAULT now() NOT NULL,
        "confirmed_by"         varchar,
        "confirmed_at"         timestamp,
        "dismissed_by"         varchar,
        "dismissed_at"         timestamp,
        "notes"                text,
        "created_at"           timestamp DEFAULT now() NOT NULL,
        "updated_at"           timestamp DEFAULT now() NOT NULL
      )
    `);
    await clientGeoLanes.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS account_contact_lane_resp_unique_idx
        ON account_contact_lane_pattern_responsibilities(account_id, contact_id, lane_pattern_id)
    `);
    await clientGeoLanes.query(`
      CREATE INDEX IF NOT EXISTS idx_aclpr_account
        ON account_contact_lane_pattern_responsibilities(account_id)
    `);
    await clientGeoLanes.query(`
      CREATE INDEX IF NOT EXISTS idx_aclpr_contact
        ON account_contact_lane_pattern_responsibilities(contact_id)
    `);
    // Add columns that were added to schema after initial migration
    await clientGeoLanes.query(`
      ALTER TABLE account_contact_lane_pattern_responsibilities
        ADD COLUMN IF NOT EXISTS is_responsible_for_pattern boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS primary_source_type text NOT NULL DEFAULT 'email',
        ADD COLUMN IF NOT EXISTS last_reviewed_at timestamp,
        ADD COLUMN IF NOT EXISTS last_reviewed_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL
    `);
    console.log("[migrations] geographic_lane_patterns and account_contact_lane_pattern_responsibilities tables ensured (Task #203)");
  } catch (err) {
    console.error("[migrations] geographic lane pattern migration error:", err);
  } finally {
    clientGeoLanes.release();
  }

  // Seed baseline geographic lane patterns (idempotent via INSERT ... ON CONFLICT DO NOTHING)
  try {
    const { storage } = await import("./storage");
    await storage.seedBaselinePatterns();
    console.log("[migrations] baseline geographic lane patterns seeded (Task #203)");
  } catch (err) {
    console.error("[migrations] baseline pattern seeding error:", err);
  }

  // Companies — handoff notes + onboarding milestones
  const clientCompanyAudit = await pool.connect();
  try {
    await clientCompanyAudit.query(`
      ALTER TABLE companies
        ADD COLUMN IF NOT EXISTS handoff_notes text,
        ADD COLUMN IF NOT EXISTS onboarding_milestones jsonb
    `);
    console.log("[migrations] companies handoff_notes + onboarding_milestones columns ensured");
  } catch (err) {
    console.error("[migrations] companies audit columns migration error:", err);
  } finally {
    clientCompanyAudit.release();
  }

  // Pinned companies — user-level account bookmarks (Task #206)
  const clientPinnedCompanies = await pool.connect();
  try {
    // Create table matching shared/schema.ts: varchar UUID PK, timestamp pinnedAt, FK refs
    await clientPinnedCompanies.query(`
      CREATE TABLE IF NOT EXISTS pinned_companies (
        id          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id  varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        pinned_at   timestamp NOT NULL DEFAULT now(),
        UNIQUE (user_id, company_id)
      )
    `);
    await clientPinnedCompanies.query(`
      CREATE INDEX IF NOT EXISTS idx_pinned_companies_user_id ON pinned_companies (user_id)
    `);
    console.log("[migrations] pinned_companies table ensured (Task #206)");
  } catch (err) {
    console.error("[migrations] pinned_companies migration error:", err);
  } finally {
    clientPinnedCompanies.release();
  }

  // Task #215 — Add company_id to crm_opportunities and make prospect_id nullable
  const clientCrmOppCompany = await pool.connect();
  try {
    await clientCrmOppCompany.query(`
      ALTER TABLE crm_opportunities
        ADD COLUMN IF NOT EXISTS company_id varchar REFERENCES companies(id) ON DELETE CASCADE
    `);
    await clientCrmOppCompany.query(`
      ALTER TABLE crm_opportunities ALTER COLUMN prospect_id DROP NOT NULL
    `);
    await clientCrmOppCompany.query(`
      CREATE INDEX IF NOT EXISTS idx_crm_opp_company_id ON crm_opportunities (company_id)
    `);
    console.log("[migrations] crm_opportunities company_id column added, prospect_id made nullable (Task #215)");
  } catch (err) {
    console.error("[migrations] crm_opportunities Task #215 error:", err);
  } finally {
    clientCrmOppCompany.release();
  }

  // Task #222 — Add play_label column to nba_cards and touchpoints
  const clientPlayLabel = await pool.connect();
  try {
    await clientPlayLabel.query(`ALTER TABLE nba_cards ADD COLUMN IF NOT EXISTS play_label text`);
    await clientPlayLabel.query(`ALTER TABLE touchpoints ADD COLUMN IF NOT EXISTS play_label text`);
    console.log("[migrations] play_label column added to nba_cards and touchpoints (Task #222)");
  } catch (err) {
    console.error("[migrations] play_label Task #222 error:", err);
  } finally {
    clientPlayLabel.release();
  }

  // Task #225 — Create contact_geography_suggestions table
  const clientGeoSugg = await pool.connect();
  try {
    await clientGeoSugg.query(`
      CREATE TABLE IF NOT EXISTS contact_geography_suggestions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        account_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        contact_id varchar NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        suggested_region text,
        suggested_lane text,
        confidence_score integer NOT NULL DEFAULT 50,
        status text NOT NULL DEFAULT 'pending',
        source_evidence jsonb DEFAULT '{}',
        suggestion_source text NOT NULL DEFAULT 'email_inference',
        acted_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientGeoSugg.query(`CREATE INDEX IF NOT EXISTS cgs_account_contact_idx ON contact_geography_suggestions (account_id, contact_id)`);
    await clientGeoSugg.query(`CREATE INDEX IF NOT EXISTS cgs_contact_status_idx ON contact_geography_suggestions (contact_id, status)`);
    await clientGeoSugg.query(`CREATE INDEX IF NOT EXISTS cgs_account_status_idx ON contact_geography_suggestions (account_id, status)`);
    console.log("[migrations] contact_geography_suggestions table ensured (Task #225)");
  } catch (err) {
    console.error("[migrations] contact_geography_suggestions Task #225 error:", err);
  } finally {
    clientGeoSugg.release();
  }

  // Tactical Learning Engine — Create proven_tactics table
  const clientTactics = await pool.connect();
  try {
    await clientTactics.query(`
      CREATE TABLE IF NOT EXISTS proven_tactics (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        signal_type text NOT NULL,
        signal_subtype text,
        tactic_label text NOT NULL,
        tactic_summary text NOT NULL,
        example_response text,
        source_message_id varchar REFERENCES email_messages(id) ON DELETE SET NULL,
        source_signal_id varchar REFERENCES email_signals(id) ON DELETE SET NULL,
        linked_account_id varchar REFERENCES companies(id) ON DELETE SET NULL,
        account_name text,
        rep_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        rep_name text,
        outcome text NOT NULL DEFAULT 'pending',
        outcome_confidence integer DEFAULT 0,
        times_used integer NOT NULL DEFAULT 1,
        success_count integer NOT NULL DEFAULT 0,
        failure_count integer NOT NULL DEFAULT 0,
        success_rate integer DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz
      )
    `);
    await clientTactics.query(`CREATE INDEX IF NOT EXISTS pt_org_signal_idx ON proven_tactics (org_id, signal_type)`);
    await clientTactics.query(`CREATE INDEX IF NOT EXISTS pt_outcome_idx ON proven_tactics (outcome)`);
    await clientTactics.query(`CREATE INDEX IF NOT EXISTS pt_signal_outcome_idx ON proven_tactics (signal_type, outcome)`);
    console.log("[migrations] proven_tactics table ensured (Tactical Learning Engine)");

    try {
      const { seedDemoTactics } = await import("./services/tacticalLearningService");
      await seedDemoTactics("da3ed822-8846-4435-bb13-3cc4bf26f71d");
    } catch (seedErr) {
      console.error("[migrations] proven_tactics seed error:", seedErr);
    }
  } catch (err) {
    console.error("[migrations] proven_tactics error:", err);
  } finally {
    clientTactics.release();
  }

  // Draft Feedback — AI training loop table
  const clientFeedback = await pool.connect();
  try {
    await clientFeedback.query(`
      CREATE TABLE IF NOT EXISTS draft_feedback (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_name text,
        rating text NOT NULL,
        notes text,
        draft_text text NOT NULL,
        edited_text text,
        play_type text NOT NULL,
        play_label text,
        thread_id text,
        account_id varchar REFERENCES companies(id) ON DELETE SET NULL,
        account_name text,
        contact_id varchar REFERENCES contacts(id) ON DELETE SET NULL,
        contact_name text,
        voice_profile_used boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientFeedback.query(`CREATE INDEX IF NOT EXISTS df_org_idx ON draft_feedback (org_id)`);
    await clientFeedback.query(`CREATE INDEX IF NOT EXISTS df_user_idx ON draft_feedback (user_id)`);
    await clientFeedback.query(`CREATE INDEX IF NOT EXISTS df_rating_idx ON draft_feedback (org_id, rating)`);
    console.log("[migrations] draft_feedback table ensured (AI Training Loop)");
  } catch (err) {
    console.error("[migrations] draft_feedback error:", err);
  } finally {
    clientFeedback.release();
  }

  const clientCorr = await pool.connect();
  try {
    await clientCorr.query(`
      CREATE TABLE IF NOT EXISTS sent_email_corrections (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        corrected_by_user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        corrected_by_name text,
        email_message_id varchar,
        outreach_log_id varchar,
        original_text text NOT NULL,
        corrected_text text NOT NULL,
        correction_notes text,
        thread_id text,
        account_id varchar REFERENCES companies(id) ON DELETE SET NULL,
        carrier_id varchar,
        subject text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientCorr.query(`CREATE INDEX IF NOT EXISTS sec_org_idx ON sent_email_corrections (org_id)`);
    await clientCorr.query(`CREATE INDEX IF NOT EXISTS sec_email_msg_idx ON sent_email_corrections (email_message_id)`);
    await clientCorr.query(`CREATE INDEX IF NOT EXISTS sec_outreach_idx ON sent_email_corrections (outreach_log_id)`);
    console.log("[migrations] sent_email_corrections table ensured");
  } catch (err) {
    console.error("[migrations] sent_email_corrections error:", err);
  } finally {
    clientCorr.release();
  }

  const clientAI = await pool.connect();
  try {
    await clientAI.query(`
      CREATE TABLE IF NOT EXISTS meeting_prep_briefs (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        generated_by_user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        brief_content jsonb NOT NULL,
        recent_activity jsonb,
        lane_highlights jsonb,
        talking_points jsonb,
        risk_alerts jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS mpb_org_company_idx ON meeting_prep_briefs (org_id, company_id)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS mpb_user_idx ON meeting_prep_briefs (generated_by_user_id)`);

    await clientAI.query(`
      CREATE TABLE IF NOT EXISTS contact_sentiment_tracking (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        contact_id varchar NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        sentiment_score integer NOT NULL,
        sentiment_trend text NOT NULL DEFAULT 'stable',
        avg_response_time_hours decimal,
        response_time_change decimal,
        signals jsonb,
        analysis_date timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS cst_org_contact_idx ON contact_sentiment_tracking (org_id, contact_id)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS cst_company_idx ON contact_sentiment_tracking (company_id)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS cst_trend_idx ON contact_sentiment_tracking (org_id, sentiment_trend)`);

    await clientAI.query(`
      CREATE TABLE IF NOT EXISTS follow_up_recommendations (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        contact_id varchar NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        recommended_day text,
        recommended_time_of_day text,
        optimal_cadence_days integer,
        max_silence_days integer,
        next_follow_up_date text,
        reasoning text,
        confidence_score integer,
        data_points integer DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS fur_org_contact_idx ON follow_up_recommendations (org_id, contact_id)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS fur_next_date_idx ON follow_up_recommendations (org_id, next_follow_up_date)`);

    await clientAI.query(`
      CREATE TABLE IF NOT EXISTS relationship_coaching_insights (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        contact_id varchar REFERENCES contacts(id) ON DELETE CASCADE,
        insight_type text NOT NULL,
        title text NOT NULL,
        description text NOT NULL,
        priority text NOT NULL DEFAULT 'moderate',
        suggested_action text,
        status text NOT NULL DEFAULT 'active',
        data_context jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS rci_org_company_idx ON relationship_coaching_insights (org_id, company_id)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS rci_status_idx ON relationship_coaching_insights (org_id, status)`);

    await clientAI.query(`
      CREATE TABLE IF NOT EXISTS org_chart_gaps (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        gap_type text NOT NULL,
        title text NOT NULL,
        description text NOT NULL,
        suggested_contact_name text,
        suggested_contact_title text,
        suggested_contact_email text,
        evidence_sources jsonb,
        priority text NOT NULL DEFAULT 'moderate',
        status text NOT NULL DEFAULT 'open',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS ocg_org_company_idx ON org_chart_gaps (org_id, company_id)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS ocg_status_idx ON org_chart_gaps (org_id, status)`);

    await clientAI.query(`
      CREATE TABLE IF NOT EXISTS warm_intro_suggestions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        target_contact_id varchar REFERENCES contacts(id) ON DELETE CASCADE,
        target_contact_name text,
        bridge_contact_id varchar REFERENCES contacts(id) ON DELETE SET NULL,
        bridge_contact_name text,
        connection_strength text NOT NULL DEFAULT 'moderate',
        reasoning text,
        suggested_approach text,
        status text NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS wis_org_company_idx ON warm_intro_suggestions (org_id, company_id)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS wis_status_idx ON warm_intro_suggestions (org_id, status)`);

    await clientAI.query(`
      CREATE TABLE IF NOT EXISTS account_look_alikes (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        target_company_id varchar REFERENCES companies(id) ON DELETE SET NULL,
        target_company_name text,
        similarity_score integer NOT NULL,
        match_factors jsonb,
        expansion_opportunity text,
        status text NOT NULL DEFAULT 'identified',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS ala_org_source_idx ON account_look_alikes (org_id, source_company_id)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS ala_score_idx ON account_look_alikes (org_id, similarity_score)`);

    await clientAI.query(`
      CREATE TABLE IF NOT EXISTS cross_sell_opportunities (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        opportunity_type text NOT NULL,
        title text NOT NULL,
        description text NOT NULL,
        lane text,
        estimated_value decimal,
        confidence_score integer,
        peer_evidence jsonb,
        suggested_approach text,
        status text NOT NULL DEFAULT 'identified',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS cso_org_company_idx ON cross_sell_opportunities (org_id, company_id)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS cso_status_idx ON cross_sell_opportunities (org_id, status)`);

    await clientAI.query(`
      CREATE TABLE IF NOT EXISTS wallet_share_plays (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        play_title text NOT NULL,
        play_description text NOT NULL,
        target_lanes jsonb,
        target_contacts jsonb,
        pricing_strategy text,
        estimated_revenue decimal,
        timeline_weeks integer,
        steps jsonb,
        status text NOT NULL DEFAULT 'draft',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS wsp_org_company_idx ON wallet_share_plays (org_id, company_id)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS wsp_status_idx ON wallet_share_plays (org_id, status)`);

    await clientAI.query(`
      CREATE TABLE IF NOT EXISTS win_loss_patterns (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        pattern_type text NOT NULL,
        title text NOT NULL,
        description text NOT NULL,
        outcome text NOT NULL,
        frequency integer NOT NULL DEFAULT 1,
        factors jsonb,
        recommendations jsonb,
        affected_accounts jsonb,
        confidence_score integer,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS wlp_org_type_idx ON win_loss_patterns (org_id, pattern_type)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS wlp_outcome_idx ON win_loss_patterns (org_id, outcome)`);

    await clientAI.query(`
      CREATE TABLE IF NOT EXISTS competitive_signals (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        signal_type text NOT NULL,
        competitor_name text,
        description text NOT NULL,
        source_type text NOT NULL,
        source_id text,
        severity text NOT NULL DEFAULT 'moderate',
        suggested_response text,
        status text NOT NULL DEFAULT 'active',
        detected_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS cs_org_company_idx ON competitive_signals (org_id, company_id)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS cs_severity_idx ON competitive_signals (org_id, severity)`);
    await clientAI.query(`CREATE INDEX IF NOT EXISTS cs_status_idx ON competitive_signals (org_id, status)`);

    console.log("[migrations] AI Intelligence Suite tables created (11 features)");
  } catch (err) {
    console.error("[migrations] AI Intelligence Suite error:", err);
  } finally {
    clientAI.release();
  }

  // ── monitored_mailboxes (Task #230) ──
  const clientMmb = await pool.connect();
  try {
    await clientMmb.query(`
      CREATE TABLE IF NOT EXISTS monitored_mailboxes (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        subscription_id TEXT,
        sent_items_subscription_id TEXT,
        subscription_expires_at TIMESTAMP,
        last_sync_at TIMESTAMP,
        delta_sync_token TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        sync_error TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await clientMmb.query(`CREATE UNIQUE INDEX IF NOT EXISTS monitored_mailboxes_org_email_idx ON monitored_mailboxes(org_id, email)`);
    await clientMmb.query(`CREATE INDEX IF NOT EXISTS monitored_mailboxes_org_enabled_idx ON monitored_mailboxes(org_id, enabled)`);
    await clientMmb.query(`ALTER TABLE monitored_mailboxes ADD COLUMN IF NOT EXISTS sent_items_subscription_id TEXT`);
    await clientMmb.query(`ALTER TABLE monitored_mailboxes ADD COLUMN IF NOT EXISTS sent_delta_sync_token TEXT`);
    console.log("[migrations] monitored_mailboxes table ensured (Task #230)");
    // Task #517 — durable Mail.Read tenant consent state. Single row per
    // tenant (Azure app-only creds are tenant-global), but keyed on a
    // string scope so we can extend per-org later without a migration.
    await clientMmb.query(`
      CREATE TABLE IF NOT EXISTS graph_tenant_consent (
        scope TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_checked_at TIMESTAMP,
        last_error TEXT,
        mailbox TEXT,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    console.log("[migrations] graph_tenant_consent table ensured (Task #517)");
    // Task #517 — ingestion-source marker on email_messages so spot-quote
    // counters can prove which ones actually came through the historical
    // 30-day backfill path (vs live delta sync or self-heal).
    await clientMmb.query(`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS ingested_via TEXT`);
    await clientMmb.query(`CREATE INDEX IF NOT EXISTS email_messages_ingested_via_idx ON email_messages(ingested_via)`);
    console.log("[migrations] email_messages.ingested_via column ensured (Task #517)");
  } catch (err) {
    console.error("[migrations] monitored_mailboxes error:", err);
  } finally {
    clientMmb.release();
  }

  const clientApiCache = await pool.connect();
  try {
    await clientApiCache.query(`
      CREATE TABLE IF NOT EXISTS api_response_cache (
        cache_key  text PRIMARY KEY,
        response   jsonb NOT NULL,
        fetched_at timestamp NOT NULL DEFAULT now(),
        ttl_seconds integer NOT NULL,
        source     text NOT NULL DEFAULT 'sonar'
      )
    `);
    await clientApiCache.query(`CREATE INDEX IF NOT EXISTS arc_source_idx ON api_response_cache (source)`);
    await clientApiCache.query(`CREATE INDEX IF NOT EXISTS arc_fetched_idx ON api_response_cache (fetched_at)`);
    // Webex routes (refresh-token storage and reauth state) reuse this table
    // with separate column names. Add them if missing so both code paths work.
    await clientApiCache.query(`ALTER TABLE api_response_cache ADD COLUMN IF NOT EXISTS response_data jsonb`);
    await clientApiCache.query(`ALTER TABLE api_response_cache ADD COLUMN IF NOT EXISTS cached_at timestamp DEFAULT now()`);
    console.log("[migrations] api_response_cache table ensured (Task #231)");
  } catch (err) {
    console.error("[migrations] api_response_cache migration error:", err);
  } finally {
    clientApiCache.release();
  }

  const clientDropTrailer = await pool.connect();
  try {
    await clientDropTrailer.query(`ALTER TABLE recurring_lanes ADD COLUMN IF NOT EXISTS drop_trailer_shipper BOOLEAN NOT NULL DEFAULT false`);
    await clientDropTrailer.query(`ALTER TABLE recurring_lanes ADD COLUMN IF NOT EXISTS drop_trailer_receiver BOOLEAN NOT NULL DEFAULT false`);
    await clientDropTrailer.query(`ALTER TABLE lane_summary_cache ADD COLUMN IF NOT EXISTS drop_trailer_shipper BOOLEAN NOT NULL DEFAULT false`);
    await clientDropTrailer.query(`ALTER TABLE lane_summary_cache ADD COLUMN IF NOT EXISTS drop_trailer_receiver BOOLEAN NOT NULL DEFAULT false`);
    console.log("[migrations] drop trailer columns added to recurring_lanes and lane_summary_cache (Task #236)");
  } catch (err) {
    console.error("[migrations] drop trailer migration error:", err);
  } finally {
    clientDropTrailer.release();
  }

  const clientArchive = await pool.connect();
  try {
    await clientArchive.query(`ALTER TABLE email_conversation_threads ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP`);
    await clientArchive.query(`CREATE INDEX IF NOT EXISTS idx_ect_archived_at ON email_conversation_threads(archived_at)`);
    await clientArchive.query(`CREATE INDEX IF NOT EXISTS idx_ect_waiting_state ON email_conversation_threads(waiting_state)`);
    console.log("[migrations] archived_at column and indexes added to email_conversation_threads (Task #237)");
  } catch (err) {
    console.error("[migrations] archived_at migration error:", err);
  } finally {
    clientArchive.release();
  }

  // ── (Task #285) Ensure (org_id, thread_id) uniqueness on email_conversation_threads ──
  // The thread row is conceptually a singleton per (org, thread). The original
  // migration omitted the unique index, so concurrent ingestion races could
  // produce duplicates. The backfill job and on-demand materialisation rely
  // on ON CONFLICT to stay race-safe, so we add it here.
  const clientEctUniq = await pool.connect();
  try {
    // De-dupe any pre-existing duplicates so the unique index can be created.
    // Keeps the most recently updated row per (org_id, thread_id) and deletes
    // the rest. Safe in practice: ingestion routinely upserts to the latest.
    await clientEctUniq.query(`
      DELETE FROM email_conversation_threads e
      USING (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY org_id, thread_id
                 ORDER BY updated_at DESC, created_at DESC
               ) AS rn
        FROM email_conversation_threads
      ) d
      WHERE e.id = d.id AND d.rn > 1
    `);
    await clientEctUniq.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ect_org_thread
      ON email_conversation_threads(org_id, thread_id)
    `);
    console.log("[migrations] uq_ect_org_thread unique index ensured (Task #285)");
  } catch (err) {
    console.error("[migrations] uq_ect_org_thread migration error:", err);
  } finally {
    clientEctUniq.release();
  }

  const clientManualCache = await pool.connect();
  try {
    await clientManualCache.query(`ALTER TABLE lane_summary_cache ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT false`);
    await clientManualCache.query(`
      UPDATE lane_summary_cache c
      SET is_manual = true
      FROM recurring_lanes r
      WHERE c.lane_id = r.id AND r.is_manual = true AND c.is_manual = false
    `);
    console.log("[migrations] is_manual column added to lane_summary_cache and back-filled");
  } catch (err) {
    console.error("[migrations] lane_summary_cache is_manual migration error:", err);
  } finally {
    clientManualCache.release();
  }

  const clientOwnerName = await pool.connect();
  try {
    await clientOwnerName.query(`ALTER TABLE lane_summary_cache ADD COLUMN IF NOT EXISTS owner_name TEXT`);
    await clientOwnerName.query(`
      UPDATE lane_summary_cache c
      SET owner_name = u.name
      FROM users u
      WHERE c.owner_user_id = u.id AND c.owner_name IS NULL
    `);
    console.log("[migrations] owner_name column added to lane_summary_cache and back-filled (Task #239)");
  } catch (err) {
    console.error("[migrations] lane_summary_cache owner_name migration error:", err);
  } finally {
    clientOwnerName.release();
  }

  // ── webex_user_mappings (Task #258) ──
  const clientWum = await pool.connect();
  try {
    await clientWum.query(`
      CREATE TABLE IF NOT EXISTS webex_user_mappings (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        webex_person_id TEXT,
        webex_email TEXT,
        webex_display_name TEXT,
        user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'needs_review',
        match_source TEXT,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await clientWum.query(`CREATE UNIQUE INDEX IF NOT EXISTS webex_user_mappings_org_person_idx ON webex_user_mappings(org_id, webex_person_id) WHERE webex_person_id IS NOT NULL`);
    await clientWum.query(`CREATE UNIQUE INDEX IF NOT EXISTS webex_user_mappings_org_email_idx ON webex_user_mappings(org_id, webex_email) WHERE webex_email IS NOT NULL`);
    await clientWum.query(`CREATE INDEX IF NOT EXISTS webex_user_mappings_org_user_idx ON webex_user_mappings(org_id, user_id)`);
    await clientWum.query(`CREATE INDEX IF NOT EXISTS webex_user_mappings_status_idx ON webex_user_mappings(org_id, status)`);
    console.log("[migrations] webex_user_mappings table ensured (Task #258)");
  } catch (err) {
    console.error("[migrations] webex_user_mappings migration error:", err);
  } finally {
    clientWum.release();
  }

  // ── webex_user_tokens (Task #261) ──
  const clientWut = await pool.connect();
  try {
    await clientWut.query(`
      CREATE TABLE IF NOT EXISTS webex_user_tokens (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        webex_person_id TEXT,
        webex_email TEXT,
        webex_display_name TEXT,
        refresh_token TEXT NOT NULL,
        access_token_expires_at TIMESTAMP,
        needs_reauth BOOLEAN NOT NULL DEFAULT FALSE,
        last_refresh_at TIMESTAMP,
        last_refresh_error TEXT,
        scopes TEXT,
        connected_at TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await clientWut.query(`CREATE UNIQUE INDEX IF NOT EXISTS webex_user_tokens_user_idx ON webex_user_tokens(user_id)`);
    await clientWut.query(`CREATE INDEX IF NOT EXISTS webex_user_tokens_org_idx ON webex_user_tokens(org_id)`);
    await clientWut.query(`CREATE INDEX IF NOT EXISTS webex_user_tokens_person_idx ON webex_user_tokens(webex_person_id)`);
    console.log("[migrations] webex_user_tokens table ensured (Task #261)");
  } catch (err) {
    console.error("[migrations] webex_user_tokens migration error:", err);
  } finally {
    clientWut.release();
  }

  // ── agents / agent_personas / agent_plays (Task #290) ──
  // Admin-managed persona & playbook backing the in-app DNA bot. Tables are
  // keyed by agent_id from day one to support the upcoming multi-agent
  // registry. The partial unique index on agent_personas guarantees at most
  // one active row per (agent_id, channel) so the loader can't get confused.
  const clientAgents = await pool.connect();
  try {
    await clientAgents.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        slug text NOT NULL,
        name text NOT NULL,
        description text,
        is_default boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'published',
        created_by varchar,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientAgents.query(`CREATE UNIQUE INDEX IF NOT EXISTS agents_org_slug_idx ON agents(organization_id, slug)`);
    await clientAgents.query(`CREATE INDEX IF NOT EXISTS agents_org_default_idx ON agents(organization_id, is_default)`);

    await clientAgents.query(`
      CREATE TABLE IF NOT EXISTS agent_personas (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id varchar NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        channel text NOT NULL,
        body text NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        version integer NOT NULL DEFAULT 1,
        created_by varchar,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientAgents.query(`CREATE INDEX IF NOT EXISTS agent_personas_active_idx ON agent_personas(agent_id, channel, is_active)`);
    await clientAgents.query(`CREATE INDEX IF NOT EXISTS agent_personas_history_idx ON agent_personas(agent_id, channel, created_at)`);
    // Enforce: at most one ACTIVE persona row per (agent_id, channel).
    await clientAgents.query(`CREATE UNIQUE INDEX IF NOT EXISTS agent_personas_active_unique ON agent_personas(agent_id, channel) WHERE is_active = true`);

    await clientAgents.query(`
      CREATE TABLE IF NOT EXISTS agent_plays (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id varchar NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name text NOT NULL,
        when_to_use text NOT NULL,
        body text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        created_by varchar,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientAgents.query(`CREATE INDEX IF NOT EXISTS agent_plays_agent_idx ON agent_plays(agent_id, enabled)`);

    console.log("[migrations] agents/agent_personas/agent_plays tables ensured (Task #290)");
  } catch (err) {
    console.error("[migrations] agents migration error:", err);
  } finally {
    clientAgents.release();
  }

  // ── ValueIQ Workspace + Multi-Agent Registry (Task #291) ──
  const clientV = await pool.connect();
  try {
    await clientV.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS avatar_url text`);
    await clientV.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_id varchar`);
    await clientV.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS model text`);
    await clientV.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS access_scope text NOT NULL DEFAULT 'everyone'`);
    await clientV.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS allowed_roles text[]`);

    await clientV.query(`
      CREATE TABLE IF NOT EXISTS agent_tools (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id varchar NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        capability text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientV.query(`CREATE UNIQUE INDEX IF NOT EXISTS agent_tools_agent_cap_idx ON agent_tools(agent_id, capability)`);

    await clientV.query(`
      CREATE TABLE IF NOT EXISTS agent_channel_access (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id varchar NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        channel text NOT NULL,
        enabled boolean NOT NULL DEFAULT true
      )
    `);
    await clientV.query(`CREATE UNIQUE INDEX IF NOT EXISTS agent_channel_access_agent_chan_idx ON agent_channel_access(agent_id, channel)`);

    await clientV.query(`
      CREATE TABLE IF NOT EXISTS agent_user_access (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id varchar NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        enabled boolean NOT NULL DEFAULT true
      )
    `);
    await clientV.query(`CREATE UNIQUE INDEX IF NOT EXISTS agent_user_access_agent_user_idx ON agent_user_access(agent_id, user_id)`);
    await clientV.query(`CREATE INDEX IF NOT EXISTS agent_user_access_user_idx ON agent_user_access(user_id)`);

    await clientV.query(`
      CREATE TABLE IF NOT EXISTS thread_projects (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL,
        pinned_context text,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientV.query(`CREATE INDEX IF NOT EXISTS thread_projects_user_idx ON thread_projects(user_id, created_at)`);

    await clientV.query(`
      CREATE TABLE IF NOT EXISTS threads (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id varchar,
        title text NOT NULL DEFAULT 'New thread',
        default_agent_id varchar,
        surface text NOT NULL DEFAULT 'valueiq',
        pinned boolean NOT NULL DEFAULT false,
        archived_at timestamp,
        last_message_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientV.query(`CREATE INDEX IF NOT EXISTS threads_user_idx ON threads(user_id, archived_at, last_message_at)`);
    await clientV.query(`CREATE INDEX IF NOT EXISTS threads_project_idx ON threads(project_id)`);
    await clientV.query(`CREATE INDEX IF NOT EXISTS threads_org_idx ON threads(organization_id, created_at)`);

    await clientV.query(`
      CREATE TABLE IF NOT EXISTS thread_messages (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        thread_id varchar NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role text NOT NULL,
        agent_id varchar,
        agent_name text,
        content text NOT NULL,
        attachments jsonb,
        rating integer,
        metadata jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientV.query(`CREATE INDEX IF NOT EXISTS thread_messages_thread_idx ON thread_messages(thread_id, created_at)`);

    await clientV.query(`
      CREATE TABLE IF NOT EXISTS thread_attachments (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        thread_id varchar NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        message_id varchar,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind text NOT NULL,
        file_name text NOT NULL,
        mime_type text,
        byte_size integer NOT NULL DEFAULT 0,
        parsed_text text,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientV.query(`CREATE INDEX IF NOT EXISTS thread_attachments_thread_idx ON thread_attachments(thread_id)`);
    await clientV.query(`CREATE INDEX IF NOT EXISTS thread_attachments_message_idx ON thread_attachments(message_id)`);

    await clientV.query(`
      CREATE TABLE IF NOT EXISTS library_items (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind text NOT NULL,
        source_id varchar,
        title text NOT NULL,
        body text,
        embedding vector(1536),
        metadata jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientV.query(`CREATE INDEX IF NOT EXISTS library_items_user_idx ON library_items(user_id, created_at)`);
    await clientV.query(`CREATE INDEX IF NOT EXISTS library_items_kind_idx ON library_items(user_id, kind)`);

    await clientV.query(`
      CREATE TABLE IF NOT EXISTS org_corpus_chunks (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_kind text NOT NULL,
        source_id text NOT NULL,
        chunk_index integer NOT NULL DEFAULT 0,
        text text NOT NULL,
        embedding vector(1536),
        metadata jsonb,
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientV.query(`CREATE UNIQUE INDEX IF NOT EXISTS org_corpus_kind_src_chunk_idx ON org_corpus_chunks(organization_id, source_kind, source_id, chunk_index)`);
    await clientV.query(`CREATE INDEX IF NOT EXISTS org_corpus_org_kind_idx ON org_corpus_chunks(organization_id, source_kind)`);

    console.log("[migrations] ValueIQ + multi-agent registry tables ensured (Task #291)");
  } catch (err) {
    console.error("[migrations] ValueIQ migration error:", err);
  } finally {
    clientV.release();
  }

  // ── Playbook Module (Task #300) ──
  // First-class plays: managers author, version, publish, and we track runs+outcomes.
  const clientPb = await pool.connect();
  try {
    await clientPb.query(`
      CREATE TABLE IF NOT EXISTS plays (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name text NOT NULL,
        description text,
        audience text NOT NULL DEFAULT 'customer',
        channel text NOT NULL DEFAULT 'email',
        trigger_type text NOT NULL DEFAULT 'manual',
        trigger_config jsonb DEFAULT '{}'::jsonb,
        signal_type text,
        recommended_steps text[] NOT NULL DEFAULT ARRAY[]::text[],
        template_body text NOT NULL DEFAULT '',
        success_metric text NOT NULL DEFAULT '',
        outcome_window_hours integer NOT NULL DEFAULT 96,
        status text NOT NULL DEFAULT 'draft',
        current_version integer NOT NULL DEFAULT 1,
        source_legacy_id varchar,
        created_by varchar REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientPb.query(`CREATE INDEX IF NOT EXISTS plays_org_status_idx ON plays(org_id, status)`);
    await clientPb.query(`CREATE INDEX IF NOT EXISTS plays_org_trigger_idx ON plays(org_id, trigger_type)`);

    await clientPb.query(`
      CREATE TABLE IF NOT EXISTS play_versions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        play_id varchar NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
        version integer NOT NULL,
        snapshot jsonb NOT NULL,
        published_at timestamp,
        created_by varchar REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientPb.query(`CREATE UNIQUE INDEX IF NOT EXISTS play_versions_play_version_idx ON play_versions(play_id, version)`);

    await clientPb.query(`
      CREATE TABLE IF NOT EXISTS play_runs (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        play_id varchar NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
        play_version integer NOT NULL,
        rep_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        account_id varchar REFERENCES companies(id) ON DELETE SET NULL,
        account_name text,
        lane_id varchar,
        contact_id varchar,
        reference_type text,
        reference_id text,
        status text NOT NULL DEFAULT 'suggested',
        trigger_snapshot jsonb,
        suggested_at timestamp NOT NULL DEFAULT now(),
        started_at timestamp,
        completed_at timestamp
      )
    `);
    await clientPb.query(`CREATE INDEX IF NOT EXISTS play_runs_org_status_idx ON play_runs(org_id, status)`);
    await clientPb.query(`CREATE INDEX IF NOT EXISTS play_runs_rep_status_idx ON play_runs(rep_user_id, status)`);
    await clientPb.query(`CREATE INDEX IF NOT EXISTS play_runs_play_idx ON play_runs(play_id)`);
    // Hardened idempotency for trigger-generated suggested runs (Task #300):
    // (play_id, reference_type, reference_id) is unique among 'suggested' rows
    // so concurrent evaluator passes can't seed duplicates. Once a run is
    // promoted to open/completed/skipped this constraint no longer applies.
    await clientPb.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS play_runs_suggested_ref_uidx
      ON play_runs(play_id, reference_type, reference_id)
      WHERE status = 'suggested' AND reference_type IS NOT NULL AND reference_id IS NOT NULL
    `);

    await clientPb.query(`
      CREATE TABLE IF NOT EXISTS play_outcomes (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        play_run_id varchar NOT NULL REFERENCES play_runs(id) ON DELETE CASCADE,
        outcome text NOT NULL,
        notes text,
        time_to_outcome_hours integer,
        recorded_by varchar REFERENCES users(id) ON DELETE SET NULL,
        recorded_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientPb.query(`CREATE UNIQUE INDEX IF NOT EXISTS play_outcomes_run_idx ON play_outcomes(play_run_id)`);

    // Backfill: copy existing agent_plays into plays as v1 records (per-org via agents.organization_id).
    // Idempotent: source_legacy_id uniqueness is enforced via the WHERE NOT EXISTS guard.
    await clientPb.query(`
      INSERT INTO plays (org_id, name, description, audience, channel, trigger_type, recommended_steps,
                         template_body, success_metric, status, current_version, source_legacy_id, created_by, created_at, updated_at)
      SELECT a.organization_id, ap.name, NULL, 'customer', 'email', 'manual',
             ARRAY[ap.when_to_use]::text[], ap.body, '', 'published', 1,
             ap.id, ap.created_by, ap.created_at, ap.updated_at
      FROM agent_plays ap
      JOIN agents a ON a.id = ap.agent_id
      WHERE NOT EXISTS (SELECT 1 FROM plays p WHERE p.source_legacy_id = ap.id)
    `);

    // Seed v1 versions for every play that has no versions yet.
    await clientPb.query(`
      INSERT INTO play_versions (play_id, version, snapshot, published_at, created_by, created_at)
      SELECT p.id, 1,
             jsonb_build_object(
               'name', p.name, 'description', p.description, 'audience', p.audience,
               'channel', p.channel, 'triggerType', p.trigger_type, 'triggerConfig', p.trigger_config,
               'signalType', p.signal_type, 'recommendedSteps', to_jsonb(p.recommended_steps),
               'templateBody', p.template_body, 'successMetric', p.success_metric,
               'outcomeWindowHours', p.outcome_window_hours
             ),
             CASE WHEN p.status = 'published' THEN p.created_at ELSE NULL END,
             p.created_by, p.created_at
      FROM plays p
      WHERE NOT EXISTS (SELECT 1 FROM play_versions v WHERE v.play_id = p.id)
    `);

    // ── Task #302 — Email Play Outcome-Tagging ──
    // Extends play_runs with outbound-send attribution (sentAt + Graph IDs) so
    // inbound replies can be matched back to the run that produced them, and
    // extends play_outcomes with classifier metadata, an override audit trail,
    // and a status/window for the expiry sweep.
    await clientPb.query(`ALTER TABLE play_runs ADD COLUMN IF NOT EXISTS sent_at timestamp`);
    await clientPb.query(`ALTER TABLE play_runs ADD COLUMN IF NOT EXISTS thread_id text`);
    await clientPb.query(`ALTER TABLE play_runs ADD COLUMN IF NOT EXISTS provider_message_id text`);
    await clientPb.query(`CREATE INDEX IF NOT EXISTS play_runs_thread_idx ON play_runs(thread_id)`);

    await clientPb.query(`ALTER TABLE play_outcomes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'recorded'`);
    await clientPb.query(`ALTER TABLE play_outcomes ADD COLUMN IF NOT EXISTS classifier_label text`);
    await clientPb.query(`ALTER TABLE play_outcomes ADD COLUMN IF NOT EXISTS classifier_confidence integer`);
    await clientPb.query(`ALTER TABLE play_outcomes ADD COLUMN IF NOT EXISTS source_signal_ids text[] NOT NULL DEFAULT ARRAY[]::text[]`);
    await clientPb.query(`ALTER TABLE play_outcomes ADD COLUMN IF NOT EXISTS evidence jsonb`);
    await clientPb.query(`ALTER TABLE play_outcomes ADD COLUMN IF NOT EXISTS window_expires_at timestamp`);
    await clientPb.query(`ALTER TABLE play_outcomes ADD COLUMN IF NOT EXISTS override_label text`);
    await clientPb.query(`ALTER TABLE play_outcomes ADD COLUMN IF NOT EXISTS override_user_id varchar REFERENCES users(id) ON DELETE SET NULL`);
    await clientPb.query(`ALTER TABLE play_outcomes ADD COLUMN IF NOT EXISTS override_reason text`);
    await clientPb.query(`ALTER TABLE play_outcomes ADD COLUMN IF NOT EXISTS override_at timestamp`);
    await clientPb.query(`CREATE INDEX IF NOT EXISTS play_outcomes_status_window_idx ON play_outcomes(status, window_expires_at)`);

    console.log("[migrations] Playbook module tables ensured (Task #300)");
    console.log("[migrations] Play outcome tagging columns ensured (Task #302)");
  } catch (err) {
    console.error("[migrations] playbook migration error:", err);
  } finally {
    clientPb.release();
  }

  // ── contacts.mobile (Task #263) ──
  // Secondary phone number so Webex call sync can auto-attach calls placed to
  // either a contact's direct line or their cell.
  const clientContactMobile = await pool.connect();
  try {
    await clientContactMobile.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mobile text`);
    console.log("[migrations] contacts.mobile column ensured (Task #263)");
  } catch (err) {
    console.error("[migrations] contacts.mobile migration error:", err);
  } finally {
    clientContactMobile.release();
  }

  // Task #317 — Missed Inbound Call Visibility.
  // One row per unanswered inbound Webex CDR, deduped by (org_id, cdr_id).
  // Captured for BOTH known (matched contact) and unknown callers so the
  // Missed Inbound portlet and weekly coordinator recap have the full picture
  // even when auto-contact-creation is out of scope.
  const clientMissedInbound = await pool.connect();
  try {
    await clientMissedInbound.query(`
      CREATE TABLE IF NOT EXISTS missed_inbound_calls (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        cdr_id text NOT NULL,
        calling_number text NOT NULL,
        called_number text,
        ring_duration_seconds integer NOT NULL DEFAULT 0,
        voicemail_left boolean NOT NULL DEFAULT false,
        start_time text NOT NULL,
        contact_id varchar REFERENCES contacts(id) ON DELETE SET NULL,
        company_id varchar REFERENCES companies(id) ON DELETE SET NULL,
        attributed_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        webex_person_id text,
        webex_user_email text,
        after_hours boolean NOT NULL DEFAULT false,
        nba_card_id varchar,
        callback_created_at text,
        created_at text NOT NULL
      )
    `);
    await clientMissedInbound.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS missed_inbound_calls_org_cdr_unique ON missed_inbound_calls (org_id, cdr_id)`
    );
    await clientMissedInbound.query(
      `CREATE INDEX IF NOT EXISTS missed_inbound_calls_org_start_idx ON missed_inbound_calls (org_id, start_time)`
    );
    console.log("[migrations] missed_inbound_calls table ensured (Task #317)");
  } catch (err) {
    console.error("[migrations] missed_inbound_calls migration error:", err);
  } finally {
    clientMissedInbound.release();
  }

  // Task #298 — ValueIQ as the rep's daily start screen.
  // Adds the per-user opt-out flag, three org-level controls (landing on/off,
  // morning seed on/off, morning seed timezone), and a discriminator on
  // threads so the seeder can locate the day's "Today" thread idempotently.
  const clientValueIQToday = await pool.connect();
  try {
    await clientValueIQToday.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS valueiq_landing_disabled BOOLEAN NOT NULL DEFAULT false`);
    await clientValueIQToday.query(`ALTER TABLE agent_org_settings ADD COLUMN IF NOT EXISTS valueiq_landing_enabled BOOLEAN NOT NULL DEFAULT true`);
    await clientValueIQToday.query(`ALTER TABLE agent_org_settings ADD COLUMN IF NOT EXISTS valueiq_today_seed_enabled BOOLEAN NOT NULL DEFAULT true`);
    await clientValueIQToday.query(`ALTER TABLE agent_org_settings ADD COLUMN IF NOT EXISTS valueiq_today_timezone TEXT NOT NULL DEFAULT 'America/Chicago'`);
    await clientValueIQToday.query(`ALTER TABLE threads ADD COLUMN IF NOT EXISTS seed_kind TEXT`);
    await clientValueIQToday.query(`CREATE INDEX IF NOT EXISTS threads_user_seed_kind_idx ON threads (user_id, seed_kind)`);
    // Strict idempotency: at most one Today thread per (user, seed kind, date-in-title).
    // Prevents duplicate seeds if scheduler + manual GET race in production.
    await clientValueIQToday.query(`CREATE UNIQUE INDEX IF NOT EXISTS threads_user_seed_kind_title_uidx ON threads (user_id, seed_kind, title) WHERE seed_kind IS NOT NULL`);
    console.log("[migrations] ValueIQ Today columns + threads.seed_kind ensured (Task #298)");
  } catch (err) {
    console.error("[migrations] ValueIQ Today migration error:", err);
  } finally {
    clientValueIQToday.release();
  }

  // ── account_reviews + follow_up_thread_id (Task #299) ──
  // Auto Weekly Account Review storage. Idempotent CREATE TABLE + ALTER for
  // the follow-up thread reference column.
  const clientAR = await pool.connect();
  try {
    await clientAR.query(`
      CREATE TABLE IF NOT EXISTS account_reviews (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        rep_user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id varchar NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        week_of text NOT NULL,
        body text NOT NULL,
        sections jsonb,
        source_snapshots jsonb,
        library_item_id varchar,
        follow_up_thread_id varchar,
        generated_by text NOT NULL DEFAULT 'scheduled',
        rating integer,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientAR.query(`ALTER TABLE account_reviews ADD COLUMN IF NOT EXISTS follow_up_thread_id varchar`);
    await clientAR.query(`CREATE UNIQUE INDEX IF NOT EXISTS account_reviews_rep_company_week_idx ON account_reviews(rep_user_id, company_id, week_of)`);
    await clientAR.query(`CREATE INDEX IF NOT EXISTS account_reviews_company_idx ON account_reviews(company_id, week_of)`);
    await clientAR.query(`CREATE INDEX IF NOT EXISTS account_reviews_rep_idx ON account_reviews(rep_user_id, week_of)`);
    await clientAR.query(`CREATE INDEX IF NOT EXISTS account_reviews_org_idx ON account_reviews(organization_id, week_of)`);
    console.log("[migrations] account_reviews table + follow_up_thread_id column ensured (Task #299)");
  } catch (err) {
    console.error("[migrations] account_reviews migration error:", err);
  } finally {
    clientAR.release();
  }

  // Task #364 — Available Freight approval SLA + escalation columns
  const clientSla = await pool.connect();
  try {
    const cols = await clientSla.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='freight_opportunities'
        AND column_name IN ('awaiting_approval_since','sla_notified_l1_at','sla_notified_l2_at')
    `);
    const have = new Set<string>(cols.rows.map((r: any) => r.column_name));
    if (!have.has("awaiting_approval_since")) {
      await clientSla.query(`ALTER TABLE freight_opportunities ADD COLUMN awaiting_approval_since timestamp`);
    }
    if (!have.has("sla_notified_l1_at")) {
      await clientSla.query(`ALTER TABLE freight_opportunities ADD COLUMN sla_notified_l1_at timestamp`);
    }
    if (!have.has("sla_notified_l2_at")) {
      await clientSla.query(`ALTER TABLE freight_opportunities ADD COLUMN sla_notified_l2_at timestamp`);
    }
    // Backfill: any unapproved opp without an SLA clock gets stamped at generated_at
    await clientSla.query(`
      UPDATE freight_opportunities
      SET awaiting_approval_since = COALESCE(generated_at, NOW())
      WHERE approved_at IS NULL AND awaiting_approval_since IS NULL
    `);
    await clientSla.query(`
      CREATE INDEX IF NOT EXISTS freight_opps_awaiting_idx
      ON freight_opportunities(org_id, awaiting_approval_since)
      WHERE approved_at IS NULL AND awaiting_approval_since IS NOT NULL
    `);
    console.log("[migrations] freight_opportunities approval-SLA columns + index ensured (Task #364)");
  } catch (err) {
    console.error("[migrations] freight SLA migration error:", err);
  } finally {
    clientSla.release();
  }

  // Task #366 — composite index for the My Procurement freight bucket query.
  // The hot WHERE filter is (org_id, owner_user_id|delegated_to_user_id,
  // status IN (...), pickup_window_end >= today). The two existing single-
  // column indexes (org_status_urgency, owner) each only cover part of that
  // filter, so the planner had to sort-merge. This composite covers the
  // common case where a rep is paging their own queue.
  const clientFI = await pool.connect();
  try {
    await clientFI.query(`
      CREATE INDEX IF NOT EXISTS freight_opps_owner_status_pickup_idx
      ON freight_opportunities(org_id, owner_user_id, status, pickup_window_end)
    `);
    await clientFI.query(`
      CREATE INDEX IF NOT EXISTS freight_opps_delegated_status_pickup_idx
      ON freight_opportunities(org_id, delegated_to_user_id, status, pickup_window_end)
      WHERE delegated_to_user_id IS NOT NULL
    `);
    console.log("[migrations] freight_opportunities owner/delegate composite indexes ensured (Task #366)");
  } catch (err) {
    console.error("[migrations] freight composite-index migration error:", err);
  } finally {
    clientFI.release();
  }

  // ── Task #368: load_fact widening + audit table ─────────────────────────
  const clientLF = await pool.connect();
  try {
    // Belt-and-braces: foundation tables must exist deterministically on a
    // fresh DB where Drizzle push hasn't run yet, otherwise the importer +
    // history writes will throw at runtime.
    await clientLF.query(`
      CREATE TABLE IF NOT EXISTS load_fact (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL,
        order_id text NOT NULL,
        company_id varchar,
        customer_name text,
        carrier_name text,
        carrier_payee_code text,
        origin_city text,
        origin_state text,
        destination_city text,
        destination_state text,
        equipment_type text,
        pickup_date text,
        delivery_date text,
        month text,
        move_status text,
        bucket text NOT NULL DEFAULT 'available',
        revenue numeric(14,2),
        cost numeric(14,2),
        margin numeric(14,2),
        load_count integer NOT NULL DEFAULT 1,
        raw_row jsonb,
        source_file_name text,
        source_kind text NOT NULL DEFAULT 'powerbi',
        imported_at timestamp NOT NULL DEFAULT now(),
        last_changed_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientLF.query(`CREATE UNIQUE INDEX IF NOT EXISTS load_fact_org_order_uq ON load_fact (org_id, order_id)`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_org_bucket_idx ON load_fact (org_id, bucket)`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_org_carrier_idx ON load_fact (org_id, carrier_name)`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_org_month_idx ON load_fact (org_id, month)`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_org_company_idx ON load_fact (org_id, company_id)`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_org_pickup_idx ON load_fact (org_id, pickup_date)`);

    await clientLF.query(`
      CREATE TABLE IF NOT EXISTS load_fact_history (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        load_fact_id varchar NOT NULL,
        org_id varchar NOT NULL,
        changed_at timestamp NOT NULL DEFAULT now(),
        field_name text NOT NULL,
        old_value text,
        new_value text,
        import_batch_id varchar
      )
    `);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_history_load_changed_idx ON load_fact_history (load_fact_id, changed_at)`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_history_org_changed_idx ON load_fact_history (org_id, changed_at)`);

    const wideCols = [
      "ADD COLUMN IF NOT EXISTS origin_zip text",
      "ADD COLUMN IF NOT EXISTS destination_zip text",
      "ADD COLUMN IF NOT EXISTS account_manager text",
      "ADD COLUMN IF NOT EXISTS dispatcher text",
      "ADD COLUMN IF NOT EXISTS pickup_appt_start text",
      "ADD COLUMN IF NOT EXISTS pickup_appt_end text",
      "ADD COLUMN IF NOT EXISTS delivery_appt_start text",
      "ADD COLUMN IF NOT EXISTS delivery_appt_end text",
      "ADD COLUMN IF NOT EXISTS arrived_at_pickup text",
      "ADD COLUMN IF NOT EXISTS arrived_at_delivery text",
      "ADD COLUMN IF NOT EXISTS total_stops integer",
      "ADD COLUMN IF NOT EXISTS total_miles numeric(10,2)",
      "ADD COLUMN IF NOT EXISTS margin_pct numeric(7,4)",
      "ADD COLUMN IF NOT EXISTS last_seen_at timestamp NOT NULL DEFAULT now()",
      "ADD COLUMN IF NOT EXISTS expired_at timestamp",
    ];
    await clientLF.query(`ALTER TABLE load_fact ${wideCols.join(", ")}`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_org_account_manager_idx ON load_fact (org_id, account_manager)`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_org_dispatcher_idx ON load_fact (org_id, dispatcher)`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_org_last_seen_idx ON load_fact (org_id, last_seen_at)`);
    // Lane lookups (Available freight matching) and pickup-window scheduling.
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_org_origin_dest_zip_idx ON load_fact (org_id, origin_zip, destination_zip)`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_org_status_pickup_idx ON load_fact (org_id, move_status, pickup_appt_start)`);
    await clientLF.query(`
      CREATE TABLE IF NOT EXISTS load_fact_import_audit (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL,
        file_name text,
        file_hash text,
        replay_token text,
        total_rows integer NOT NULL DEFAULT 0,
        inserted integer NOT NULL DEFAULT 0,
        updated integer NOT NULL DEFAULT 0,
        unchanged integer NOT NULL DEFAULT 0,
        transitioned integer NOT NULL DEFAULT 0,
        expired integer NOT NULL DEFAULT 0,
        skipped integer NOT NULL DEFAULT 0,
        bucket_available integer NOT NULL DEFAULT 0,
        bucket_realized integer NOT NULL DEFAULT 0,
        bucket_cancelled integer NOT NULL DEFAULT 0,
        bucket_unknown integer NOT NULL DEFAULT 0,
        warnings jsonb,
        actor_user_id varchar,
        triggered_by text NOT NULL DEFAULT 'manual',
        kind text NOT NULL DEFAULT 'powerbi',
        error text,
        duration_ms integer,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientLF.query(`ALTER TABLE load_fact_import_audit ADD COLUMN IF NOT EXISTS file_hash text`);
    await clientLF.query(`ALTER TABLE load_fact_import_audit ADD COLUMN IF NOT EXISTS replay_token text`);
    await clientLF.query(`ALTER TABLE load_fact_import_audit ADD COLUMN IF NOT EXISTS transitioned integer NOT NULL DEFAULT 0`);
    await clientLF.query(`ALTER TABLE load_fact_import_audit ADD COLUMN IF NOT EXISTS expired integer NOT NULL DEFAULT 0`);
    await clientLF.query(`ALTER TABLE load_fact_import_audit ADD COLUMN IF NOT EXISTS skipped integer NOT NULL DEFAULT 0`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_import_audit_org_created_idx ON load_fact_import_audit (org_id, created_at)`);
    await clientLF.query(`CREATE INDEX IF NOT EXISTS load_fact_import_audit_org_replay_idx ON load_fact_import_audit (org_id, replay_token)`);
    console.log("[migrations] load_fact widened + load_fact_import_audit ensured (Task #368)");
  } catch (err) {
    console.error("[migrations] load_fact migration error:", err);
  } finally {
    clientLF.release();
  }

  // ── Performance indexes (Task #272) ──
  // Composite indexes on the hot filter paths used by Intel / Dashboard /
  // Tasks / Carrier Hub so list queries stop sequential-scanning large tables.
  // All idempotent — safe to re-run.
  const clientPerf272 = await pool.connect();
  try {
    const stmts: string[] = [
      // tasks
      `CREATE INDEX IF NOT EXISTS tasks_org_status_idx          ON tasks (org_id, status)`,
      `CREATE INDEX IF NOT EXISTS tasks_org_assigned_to_idx     ON tasks (org_id, assigned_to)`,
      `CREATE INDEX IF NOT EXISTS tasks_org_assigned_by_idx     ON tasks (org_id, assigned_by)`,
      `CREATE INDEX IF NOT EXISTS tasks_company_status_idx      ON tasks (company_id, status)`,
      `CREATE INDEX IF NOT EXISTS tasks_due_date_idx            ON tasks (due_date)`,
      // touchpoints
      `CREATE INDEX IF NOT EXISTS touchpoints_logged_by_date_idx ON touchpoints (logged_by_id, date DESC)`,
      `CREATE INDEX IF NOT EXISTS touchpoints_company_date_idx   ON touchpoints (company_id, date DESC)`,
      `CREATE INDEX IF NOT EXISTS touchpoints_date_idx           ON touchpoints (date DESC)`,
      // contacts
      `CREATE INDEX IF NOT EXISTS contacts_created_at_idx        ON contacts (created_at)`,
      `CREATE INDEX IF NOT EXISTS contacts_base_advanced_at_idx  ON contacts (base_advanced_at) WHERE base_advanced_at IS NOT NULL`,
      // companies
      `CREATE INDEX IF NOT EXISTS companies_organization_id_idx  ON companies (organization_id)`,
      `CREATE INDEX IF NOT EXISTS companies_sales_person_id_idx  ON companies (sales_person_id)`,
      // task_comments
      `CREATE INDEX IF NOT EXISTS task_comments_task_id_idx      ON task_comments (task_id)`,
      // intel rate lookups
      `CREATE INDEX IF NOT EXISTS intel_tracked_lanes_org_active_idx ON intel_tracked_lanes (org_id, active)`,
      `CREATE INDEX IF NOT EXISTS intel_lane_rates_tracked_lane_idx  ON intel_lane_rates (tracked_lane_id)`,
      // notifications
      `CREATE INDEX IF NOT EXISTS notifications_user_read_idx    ON notifications (user_id, read)`,
    ];
    for (const s of stmts) {
      try { await clientPerf272.query(s); } catch (e) { /* per-statement non-blocking */ void e; }
    }
    console.log("[migrations] Task #272 performance indexes ensured");
  } catch (err) {
    console.error("[migrations] Task #272 perf indexes error:", err);
  } finally {
    clientPerf272.release();
  }

  // ── Webex Call Quality Analytics (Task #315) ──
  // Per-call quality and talk-time metrics pulled from Webex detailed call
  // history so Rep Call Quality Scorecards can aggregate without re-hitting
  // Webex. Keyed by (org_id, call_id) for idempotent backfills.
  const clientWca = await pool.connect();
  try {
    await clientWca.query(`
      CREATE TABLE IF NOT EXISTS webex_call_analytics (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        call_id text NOT NULL,
        user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        webex_person_id text,
        webex_user_email text,
        direction text,
        remote_number text,
        start_time timestamp,
        duration_seconds integer NOT NULL DEFAULT 0,
        answered boolean NOT NULL DEFAULT false,
        talk_time_seconds integer NOT NULL DEFAULT 0,
        hold_time_seconds integer NOT NULL DEFAULT 0,
        silence_seconds integer NOT NULL DEFAULT 0,
        ring_time_seconds integer NOT NULL DEFAULT 0,
        mos_score numeric(4,2),
        jitter_ms numeric(8,2),
        packet_loss_pct numeric(6,3),
        quality_grade text,
        after_hours boolean NOT NULL DEFAULT false,
        company_id varchar,
        contact_id varchar,
        touchpoint_id varchar,
        synced_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientWca.query(`CREATE UNIQUE INDEX IF NOT EXISTS webex_analytics_org_call_idx ON webex_call_analytics(org_id, call_id)`);
    await clientWca.query(`CREATE INDEX IF NOT EXISTS webex_analytics_user_time_idx ON webex_call_analytics(user_id, start_time)`);
    await clientWca.query(`CREATE INDEX IF NOT EXISTS webex_analytics_org_time_idx ON webex_call_analytics(org_id, start_time)`);
    // Task #691 — composite index for the Call Performance Hub. The
    // call-quality scorecard and drill endpoints filter by
    // (org_id, start_time, user_id, quality_grade). The earlier
    // org_time / user_time indexes only cover the first two columns; this
    // composite lets postgres satisfy the per-rep + grade filters from the
    // index alone as analytics history grows.
    await clientWca.query(`CREATE INDEX IF NOT EXISTS webex_analytics_org_time_user_grade_idx ON webex_call_analytics(org_id, start_time, user_id, quality_grade)`);
    console.log("[migrations] webex_call_analytics table ensured (Task #315)");
  } catch (err) {
    console.error("[migrations] webex_call_analytics migration error:", err);
  } finally {
    clientWca.release();
  }

  // ── Task #369: Carrier Intelligence Scoring & Pricing tables ────────────
  const clientCI = await pool.connect();
  try {
    await clientCI.query(`
      CREATE TABLE IF NOT EXISTS carrier_scorecard_fact (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        carrier_name text NOT NULL,
        equipment_type text NOT NULL DEFAULT 'ALL',
        window_days integer NOT NULL DEFAULT 180,
        loads integer NOT NULL DEFAULT 0,
        loads_30d integer NOT NULL DEFAULT 0,
        loads_90d integer NOT NULL DEFAULT 0,
        revenue numeric(14,2) NOT NULL DEFAULT 0,
        cost numeric(14,2) NOT NULL DEFAULT 0,
        margin numeric(14,2) NOT NULL DEFAULT 0,
        margin_pct numeric(7,4) NOT NULL DEFAULT 0,
        avg_rpm numeric(8,4),
        do_not_use boolean NOT NULL DEFAULT false,
        performance_score integer NOT NULL DEFAULT 0,
        tier text NOT NULL DEFAULT 'new',
        days_since_last_load integer,
        last_load_date text,
        computed_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientCI.query(`CREATE UNIQUE INDEX IF NOT EXISTS carrier_scorecard_org_carrier_eq_uq ON carrier_scorecard_fact (org_id, carrier_name, equipment_type)`);
    await clientCI.query(`CREATE INDEX IF NOT EXISTS carrier_scorecard_org_score_idx ON carrier_scorecard_fact (org_id, performance_score)`);

    await clientCI.query(`
      CREATE TABLE IF NOT EXISTS lane_rate_history (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        origin_state text NOT NULL,
        destination_state text NOT NULL,
        equipment_type text NOT NULL DEFAULT 'ALL',
        window_days integer NOT NULL DEFAULT 180,
        loads integer NOT NULL DEFAULT 0,
        loads_30d integer NOT NULL DEFAULT 0,
        loads_90d integer NOT NULL DEFAULT 0,
        avg_revenue_per_mile numeric(8,4),
        avg_cost_per_mile numeric(8,4),
        avg_margin_pct numeric(7,4),
        median_cost_per_mile numeric(8,4),
        p25_cost_per_mile numeric(8,4),
        p75_cost_per_mile numeric(8,4),
        unique_carriers integer NOT NULL DEFAULT 0,
        computed_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientCI.query(`CREATE UNIQUE INDEX IF NOT EXISTS lane_rate_history_lane_uq ON lane_rate_history (org_id, origin_state, destination_state, equipment_type)`);
    await clientCI.query(`CREATE INDEX IF NOT EXISTS lane_rate_history_org_loads_idx ON lane_rate_history (org_id, loads)`);

    await clientCI.query(`
      CREATE TABLE IF NOT EXISTS carrier_lane_fit (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        carrier_name text NOT NULL,
        origin_state text NOT NULL,
        destination_state text NOT NULL,
        equipment_type text NOT NULL DEFAULT 'ALL',
        fit_score integer NOT NULL DEFAULT 0,
        exact_lane_runs integer NOT NULL DEFAULT 0,
        nearby_runs integer NOT NULL DEFAULT 0,
        equipment_match boolean NOT NULL DEFAULT false,
        region_match boolean NOT NULL DEFAULT false,
        evidence_tier text NOT NULL DEFAULT 'none',
        reason text,
        computed_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientCI.query(`CREATE UNIQUE INDEX IF NOT EXISTS carrier_lane_fit_uq ON carrier_lane_fit (org_id, carrier_name, origin_state, destination_state, equipment_type)`);
    await clientCI.query(`CREATE INDEX IF NOT EXISTS carrier_lane_fit_org_fit_idx ON carrier_lane_fit (org_id, fit_score)`);

    await clientCI.query(`
      CREATE TABLE IF NOT EXISTS carrier_recommendation (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        load_fact_id varchar NOT NULL REFERENCES load_fact(id) ON DELETE CASCADE,
        rank integer NOT NULL,
        carrier_name text NOT NULL,
        total_score integer NOT NULL DEFAULT 0,
        fit_score integer NOT NULL DEFAULT 0,
        performance_score integer NOT NULL DEFAULT 0,
        target_buy_rpm numeric(8,4),
        pricing_confidence text NOT NULL DEFAULT 'low',
        reason text,
        rationale jsonb,
        computed_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await clientCI.query(`CREATE UNIQUE INDEX IF NOT EXISTS carrier_recommendation_load_rank_uq ON carrier_recommendation (load_fact_id, rank)`);
    await clientCI.query(`CREATE INDEX IF NOT EXISTS carrier_recommendation_org_load_idx ON carrier_recommendation (org_id, load_fact_id)`);

    // Task #369 follow-on: extend scorecard / lane history / recommendation
    // with the additional dimensions called out in the spec.
    await clientCI.query(`ALTER TABLE carrier_scorecard_fact ADD COLUMN IF NOT EXISTS total_miles numeric(14,2) NOT NULL DEFAULT 0`);
    await clientCI.query(`ALTER TABLE carrier_scorecard_fact ADD COLUMN IF NOT EXISTS revenue_per_load numeric(12,2)`);
    await clientCI.query(`ALTER TABLE carrier_scorecard_fact ADD COLUMN IF NOT EXISTS on_time_pct numeric(5,2)`);
    await clientCI.query(`ALTER TABLE carrier_scorecard_fact ADD COLUMN IF NOT EXISTS active_loads integer NOT NULL DEFAULT 0`);
    await clientCI.query(`ALTER TABLE carrier_scorecard_fact ADD COLUMN IF NOT EXISTS available_loads integer NOT NULL DEFAULT 0`);

    await clientCI.query(`ALTER TABLE lane_rate_history ADD COLUMN IF NOT EXISTS customer_name text NOT NULL DEFAULT '__ANY__'`);
    await clientCI.query(`ALTER TABLE lane_rate_history ADD COLUMN IF NOT EXISTS loads_60d integer NOT NULL DEFAULT 0`);
    await clientCI.query(`ALTER TABLE lane_rate_history ADD COLUMN IF NOT EXISTS min_cost_per_mile numeric(8,4)`);
    await clientCI.query(`ALTER TABLE lane_rate_history ADD COLUMN IF NOT EXISTS max_cost_per_mile numeric(8,4)`);
    await clientCI.query(`ALTER TABLE lane_rate_history ADD COLUMN IF NOT EXISTS avg_cost_30d numeric(8,4)`);
    await clientCI.query(`ALTER TABLE lane_rate_history ADD COLUMN IF NOT EXISTS avg_cost_60d numeric(8,4)`);
    await clientCI.query(`ALTER TABLE lane_rate_history ADD COLUMN IF NOT EXISTS avg_cost_90d numeric(8,4)`);
    // Drop + recreate the unique index now that customer_name participates.
    await clientCI.query(`DROP INDEX IF EXISTS lane_rate_history_lane_uq`);
    await clientCI.query(`CREATE UNIQUE INDEX IF NOT EXISTS lane_rate_history_lane_uq ON lane_rate_history (org_id, origin_state, destination_state, equipment_type, customer_name)`);

    await clientCI.query(`ALTER TABLE carrier_recommendation ADD COLUMN IF NOT EXISTS last_used_date text`);
    await clientCI.query(`ALTER TABLE carrier_recommendation ADD COLUMN IF NOT EXISTS avg_historical_buy_rpm numeric(8,4)`);
    await clientCI.query(`ALTER TABLE carrier_recommendation ADD COLUMN IF NOT EXISTS expected_margin_low_pct numeric(5,2)`);
    await clientCI.query(`ALTER TABLE carrier_recommendation ADD COLUMN IF NOT EXISTS expected_margin_high_pct numeric(5,2)`);
    await clientCI.query(`ALTER TABLE carrier_recommendation ADD COLUMN IF NOT EXISTS coverage_urgency text NOT NULL DEFAULT 'green'`);

    console.log("[migrations] carrier intelligence scoring tables ensured (Task #369)");
  } catch (err) {
    console.error("[migrations] Task #369 migration error:", err);
  } finally {
    clientCI.release();
  }

  // ── Task #372: NBA $-at-stake + universal account/contact/lane linkage ──────
  const client372 = await pool.connect();
  try {
    await client372.query(`ALTER TABLE nba_cards ADD COLUMN IF NOT EXISTS at_stake_amount numeric(14,2)`);
    await client372.query(`ALTER TABLE nba_cards ADD COLUMN IF NOT EXISTS at_stake_basis text`);
    await client372.query(`ALTER TABLE nba_cards ADD COLUMN IF NOT EXISTS primary_contact_id varchar`);
    await client372.query(`ALTER TABLE nba_cards ADD COLUMN IF NOT EXISTS primary_lane_id varchar`);
    // Add FKs only if the constraint isn't already present (defensive — safe to re-run)
    await client372.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'nba_cards_primary_contact_id_fkey'
        ) THEN
          ALTER TABLE nba_cards
            ADD CONSTRAINT nba_cards_primary_contact_id_fkey
            FOREIGN KEY (primary_contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'nba_cards_primary_lane_id_fkey'
        ) THEN
          ALTER TABLE nba_cards
            ADD CONSTRAINT nba_cards_primary_lane_id_fkey
            FOREIGN KEY (primary_lane_id) REFERENCES recurring_lanes(id) ON DELETE SET NULL;
        END IF;
      END$$;
    `);
    await client372.query(`CREATE INDEX IF NOT EXISTS nba_cards_at_stake_amount_idx ON nba_cards (at_stake_amount DESC NULLS LAST)`);
    console.log("[migrations] nba_cards at-stake + linkage columns ensured (Task #372)");
  } catch (err) {
    console.error("[migrations] Task #372 migration error:", err);
  } finally {
    client372.release();
  }

  // ── Task #374: NBA outcome loop (lifecycle events + outcome classification) ──
  const client374 = await pool.connect();
  try {
    // Stored as text to match the rest of nba_cards' ISO-string timestamp columns (e.g., resolved_at).
    await client374.query(`ALTER TABLE nba_cards ADD COLUMN IF NOT EXISTS first_viewed_at text`);
    await client374.query(`
      CREATE TABLE IF NOT EXISTS nba_card_events (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        card_id varchar NOT NULL REFERENCES nba_cards(id) ON DELETE CASCADE,
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type text NOT NULL,
        reason text,
        actor_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        metadata jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    // Defensive: backfill columns if an older revision of this table exists
    await client374.query(`ALTER TABLE nba_card_events ADD COLUMN IF NOT EXISTS user_id varchar`);
    await client374.query(`ALTER TABLE nba_card_events ADD COLUMN IF NOT EXISTS actor_user_id varchar`);
    await client374.query(`CREATE INDEX IF NOT EXISTS nba_card_events_card_idx ON nba_card_events(card_id)`);
    await client374.query(`CREATE INDEX IF NOT EXISTS nba_card_events_org_type_idx ON nba_card_events(org_id, event_type)`);
    await client374.query(`
      CREATE TABLE IF NOT EXISTS nba_card_outcomes (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        card_id varchar NOT NULL REFERENCES nba_cards(id) ON DELETE CASCADE,
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rule_type text NOT NULL,
        outcome text NOT NULL,
        basis text,
        dollar_impact numeric(14,2),
        from_action text,
        attribution_window_days integer,
        classified_at timestamp NOT NULL DEFAULT now(),
        signals jsonb
      )
    `);
    // Defensive: backfill any missing columns from an earlier table revision
    await client374.query(`ALTER TABLE nba_card_outcomes ADD COLUMN IF NOT EXISTS basis text`);
    await client374.query(`ALTER TABLE nba_card_outcomes ADD COLUMN IF NOT EXISTS from_action text`);
    await client374.query(`CREATE UNIQUE INDEX IF NOT EXISTS nba_card_outcomes_card_unique ON nba_card_outcomes(card_id)`);
    await client374.query(`CREATE INDEX IF NOT EXISTS nba_card_outcomes_org_user_idx ON nba_card_outcomes(org_id, user_id)`);
    await client374.query(`CREATE INDEX IF NOT EXISTS nba_card_outcomes_rule_idx ON nba_card_outcomes(org_id, rule_type)`);
    console.log("[migrations] nba lifecycle events + outcomes tables ensured (Task #374)");
  } catch (err) {
    console.error("[migrations] Task #374 migration error:", err);
  } finally {
    client374.release();
  }

  // Phase 5 (Task #425) — copilot_actions idempotency: at most one row per
  // (organization, turn/messageId, tool). Backfill-deduplicates first so the
  // unique index can be applied safely on existing rows.
  const client425 = await pool.connect();
  try {
    await client425.query(`
      CREATE TABLE IF NOT EXISTS copilot_actions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        confirmed_by_user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_ref text,
        message_id integer,
        tool text NOT NULL,
        args jsonb,
        result text NOT NULL DEFAULT 'success',
        error_message text,
        related_company_id varchar,
        related_contact_id varchar,
        completed_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await client425.query(`CREATE INDEX IF NOT EXISTS copilot_actions_org_idx ON copilot_actions(organization_id, completed_at)`);
    await client425.query(`CREATE INDEX IF NOT EXISTS copilot_actions_user_idx ON copilot_actions(confirmed_by_user_id, completed_at)`);
    await client425.query(`CREATE INDEX IF NOT EXISTS copilot_actions_company_idx ON copilot_actions(related_company_id, completed_at)`);
    await client425.query(`CREATE INDEX IF NOT EXISTS copilot_actions_tool_idx ON copilot_actions(tool)`);
    {
      await client425.query(`
        DELETE FROM copilot_actions a
        USING copilot_actions b
        WHERE a.id < b.id
          AND a.organization_id = b.organization_id
          AND a.message_id IS NOT NULL
          AND a.message_id = b.message_id
          AND a.tool = b.tool
      `);
      await client425.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS copilot_actions_turn_tool_unique
        ON copilot_actions (organization_id, message_id, tool)
        WHERE message_id IS NOT NULL
      `);
      console.log("[migrations] copilot_actions (turnId, tool) unique index ensured (Task #425)");
    }
  } catch (err) {
    console.error("[migrations] Task #425 idempotency index error:", err);
  } finally {
    client425.release();
  }

  // ── Task #435: Self-heal missing rep replies in Conversations ─────────────
  // 1. Add SentItems coverage timestamps onto monitored_mailboxes so we can
  //    flag stale / missing webhook delivery.
  // 2. Create conversation_thread_capture_audits table for per-thread
  //    self-heal history surfaced to reps and managers.
  const client435 = await pool.connect();
  try {
    await client435.query(`ALTER TABLE monitored_mailboxes ADD COLUMN IF NOT EXISTS last_sent_items_notification_at TIMESTAMP`);
    await client435.query(`ALTER TABLE monitored_mailboxes ADD COLUMN IF NOT EXISTS last_outbound_captured_at TIMESTAMP`);
    await client435.query(`
      CREATE TABLE IF NOT EXISTS conversation_thread_capture_audits (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        mailbox_id VARCHAR REFERENCES monitored_mailboxes(id) ON DELETE SET NULL,
        triggered_by TEXT NOT NULL,
        triggered_by_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
        messages_found_upstream INTEGER NOT NULL DEFAULT 0,
        messages_persisted INTEGER NOT NULL DEFAULT 0,
        root_cause_label TEXT NOT NULL DEFAULT 'nothing_missing',
        details JSONB DEFAULT '{}',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client435.query(`
      CREATE INDEX IF NOT EXISTS conversation_thread_capture_audits_org_thread_idx
        ON conversation_thread_capture_audits (org_id, thread_id, created_at DESC)
    `);
    await client435.query(`ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS provider_sent_at TIMESTAMP`);
    // Backfill existing rows so the timeline doesn't suddenly become null:
    // for already-ingested messages we treat created_at as the send time.
    await client435.query(`UPDATE email_messages SET provider_sent_at = created_at WHERE provider_sent_at IS NULL`);
    console.log("[migrations] Task #435 reply-capture audit + SentItems health columns + provider_sent_at ensured");
  } catch (err) {
    console.error("[migrations] Task #435 migration error:", err);
  } finally {
    client435.release();
  }

  // ── Task #468: Customer Quotes tab — defensive idempotent table creation ──
  // Schema is owned by Drizzle (`shared/schema.ts`) + `npm run db:push --force`.
  // The block below only runs CREATE TABLE/INDEX IF NOT EXISTS so a fresh
  // deploy that has not yet run db:push still gets the tables stood up.
  const client468 = await pool.connect();
  try {
    await client468.query(`
      CREATE TABLE IF NOT EXISTS quote_customers (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name text NOT NULL,
        segment text,
        notes text,
        created_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await client468.query(`ALTER TABLE quote_customers ADD COLUMN IF NOT EXISTS notes text`);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_customers_org_idx ON quote_customers (organization_id)`);

    await client468.query(`
      CREATE TABLE IF NOT EXISTS quote_reps (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        name text NOT NULL,
        email text
      )
    `);
    await client468.query(`ALTER TABLE quote_reps ADD COLUMN IF NOT EXISTS user_id varchar REFERENCES users(id) ON DELETE SET NULL`);
    await client468.query(`ALTER TABLE quote_reps ADD COLUMN IF NOT EXISTS suppressed boolean NOT NULL DEFAULT false`);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_reps_org_idx ON quote_reps (organization_id)`);

    await client468.query(`
      CREATE TABLE IF NOT EXISTS quote_carriers (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name text NOT NULL,
        mc_number text
      )
    `);
    await client468.query(`ALTER TABLE quote_carriers ADD COLUMN IF NOT EXISTS mc_number text`);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_carriers_org_idx ON quote_carriers (organization_id)`);

    await client468.query(`
      CREATE TABLE IF NOT EXISTS quote_lane_groups (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name text NOT NULL,
        origin_region text,
        dest_region text
      )
    `);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_lane_groups_org_idx ON quote_lane_groups (organization_id)`);

    await client468.query(`
      CREATE TABLE IF NOT EXISTS quote_outcome_reasons (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        code text NOT NULL,
        label text NOT NULL,
        category text NOT NULL
      )
    `);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_outcome_reasons_org_idx ON quote_outcome_reasons (organization_id)`);

    await client468.query(`
      CREATE TABLE IF NOT EXISTS quote_opportunities (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        customer_id varchar NOT NULL REFERENCES quote_customers(id) ON DELETE CASCADE,
        rep_id varchar REFERENCES quote_reps(id) ON DELETE SET NULL,
        lane_group_id varchar REFERENCES quote_lane_groups(id) ON DELETE SET NULL,
        carrier_id varchar REFERENCES quote_carriers(id) ON DELETE SET NULL,
        outcome_reason_id varchar REFERENCES quote_outcome_reasons(id) ON DELETE SET NULL,
        request_date timestamp NOT NULL DEFAULT NOW(),
        origin_city text NOT NULL,
        origin_state text NOT NULL,
        dest_city text NOT NULL,
        dest_state text NOT NULL,
        equipment text NOT NULL,
        quoted_amount numeric,
        valid_through timestamp,
        outcome_status text NOT NULL,
        carrier_paid numeric,
        response_time_hours numeric,
        source text NOT NULL,
        source_reference text,
        notes text,
        score numeric,
        created_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await client468.query(`ALTER TABLE quote_opportunities ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT NOW()`);
    await client468.query(`ALTER TABLE quote_opportunities ADD COLUMN IF NOT EXISTS sonar_benchmark numeric(12,2)`);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_opportunities_org_date_idx ON quote_opportunities (organization_id, request_date DESC)`);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_opportunities_customer_idx ON quote_opportunities (customer_id)`);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_opportunities_lane_idx ON quote_opportunities (organization_id, origin_city, dest_city)`);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_opportunities_status_idx ON quote_opportunities (organization_id, outcome_status)`);

    await client468.query(`
      CREATE TABLE IF NOT EXISTS quote_events (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        quote_id varchar NOT NULL REFERENCES quote_opportunities(id) ON DELETE CASCADE,
        event_type text NOT NULL,
        occurred_at timestamp NOT NULL DEFAULT NOW(),
        actor text,
        payload jsonb DEFAULT '{}'::jsonb
      )
    `);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_events_quote_idx ON quote_events (quote_id, occurred_at)`);

    await client468.query(`
      CREATE TABLE IF NOT EXISTS quote_saved_views (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id varchar REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL,
        filters jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_saved_views_org_idx ON quote_saved_views (organization_id, created_at DESC)`);

    // Task #481 — quote pattern-shift detector persistence.
    await client468.query(`
      CREATE TABLE IF NOT EXISTS quote_pattern_alerts (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        customer_id varchar NOT NULL REFERENCES quote_customers(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'active',
        summary text NOT NULL,
        axes jsonb NOT NULL DEFAULT '{}'::jsonb,
        detected_at timestamp NOT NULL DEFAULT NOW(),
        last_shifted_at timestamp NOT NULL DEFAULT NOW(),
        normalized_since timestamp,
        resolved_at timestamp
      )
    `);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_pattern_alerts_org_idx ON quote_pattern_alerts (organization_id)`);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_pattern_alerts_customer_idx ON quote_pattern_alerts (customer_id)`);
    await client468.query(`CREATE INDEX IF NOT EXISTS quote_pattern_alerts_status_idx ON quote_pattern_alerts (status)`);
    // Hard guarantee: at most one active alert per (org, customer).
    await client468.query(`CREATE UNIQUE INDEX IF NOT EXISTS quote_pattern_alerts_active_uq ON quote_pattern_alerts (organization_id, customer_id) WHERE status = 'active'`);

    // Capture Leak Queue Phase 2A — admin-triaged "Not a quote" / "Ignore"
    // decisions on individual leak rows. Required by the schema-drift guard
    // alongside the Drizzle table `captureLeakReviews` in shared/schema.ts.
    await client468.query(`
      CREATE TABLE IF NOT EXISTS capture_leak_reviews (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        message_id varchar NOT NULL,
        leak_type text NOT NULL,
        decision text NOT NULL,
        decided_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        note text,
        decided_at timestamp NOT NULL DEFAULT NOW(),
        updated_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await client468.query(`CREATE UNIQUE INDEX IF NOT EXISTS capture_leak_reviews_org_msg_type_uidx ON capture_leak_reviews (organization_id, message_id, leak_type)`);
    await client468.query(`CREATE INDEX IF NOT EXISTS capture_leak_reviews_org_decided_at_idx ON capture_leak_reviews (organization_id, decided_at)`);

    console.log("[migrations] Task #468 customer quotes tables ensured");
  } catch (err) {
    console.error("[migrations] Task #468 customer quotes table create error:", err);
  } finally {
    client468.release();
  }

  // ── Task #803: Quote Lifecycle Autopilot — additive columns ────────────
  // (A) quote_opportunities.needs_new_contact_review jsonb — populated by
  //     ingestQuoteFromEmail when sender's domain matched but the email is
  //     new. Cleared once the rep clicks Add-as-contact or Dismiss.
  // (B) quoted is now a valid outcome_status; nothing to migrate (text col).
  // (C) agent_org_settings.quote_no_response_timeout_hours integer default 2 —
  //     drives the auto-close cron threshold.
  const client803 = await pool.connect();
  try {
    await client803.query(
      `ALTER TABLE quote_opportunities ADD COLUMN IF NOT EXISTS needs_new_contact_review jsonb`,
    );
    await client803.query(
      `ALTER TABLE agent_org_settings ADD COLUMN IF NOT EXISTS quote_no_response_timeout_hours integer NOT NULL DEFAULT 2`,
    );
    // Forward-only activation gate. Set on first sweep run per org so the
    // autopilot only acts on quotes that became stale AFTER deployment —
    // not on the org's entire historical pending backlog.
    await client803.query(
      `ALTER TABLE agent_org_settings ADD COLUMN IF NOT EXISTS quote_autopilot_started_at timestamp`,
    );
    console.log("[migrations] Task #803 quote autopilot columns ensured");
  } catch (err) {
    console.error("[migrations] Task #803 quote autopilot column error:", err);
  } finally {
    client803.release();
  }

  // ── Task #508: Mailbox 30-day historical backfill state ────────────────────
  // Per-mailbox backfill tracking row. Idempotent: re-runs are safe because
  // ingestion is keyed on the unique (org_id, provider_message_id) index on
  // email_messages — duplicates are silently skipped at insert time.
  const client508 = await pool.connect();
  try {
    await client508.query(`
      CREATE TABLE IF NOT EXISTS mailbox_historical_backfills (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        mailbox_id varchar NOT NULL REFERENCES monitored_mailboxes(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'pending',
        window_start timestamp NOT NULL,
        window_end timestamp NOT NULL,
        messages_fetched integer NOT NULL DEFAULT 0,
        messages_ingested integer NOT NULL DEFAULT 0,
        messages_duplicate integer NOT NULL DEFAULT 0,
        errors_count integer NOT NULL DEFAULT 0,
        last_error text,
        triggered_by text NOT NULL DEFAULT 'auto',
        triggered_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        started_at timestamp,
        completed_at timestamp,
        created_at timestamp NOT NULL DEFAULT NOW(),
        updated_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await client508.query(`CREATE INDEX IF NOT EXISTS mailbox_historical_backfills_mailbox_idx ON mailbox_historical_backfills (mailbox_id, created_at DESC)`);
    await client508.query(`CREATE INDEX IF NOT EXISTS mailbox_historical_backfills_org_status_idx ON mailbox_historical_backfills (org_id, status)`);
    console.log("[migrations] Task #508 mailbox_historical_backfills table ensured");
  } catch (err) {
    console.error("[migrations] Task #508 backfill table create error:", err);
  } finally {
    client508.release();
  }

  // ── Task #472: pgvector ANN indexes for retrieval speed ───────────────────
  // Without an ANN index every chat turn does an exact-distance scan of every
  // embedding row in scope, which dominates wall-clock once the corpus grows.
  // HNSW + cosine matches the distance operator we already use in retrieval.ts
  // (`<=>` with `vector_cosine_ops`). CREATE INDEX IF NOT EXISTS makes this a
  // no-op on subsequent boots and on environments where pgvector / HNSW isn't
  // available the error is logged and skipped — chat will still work via the
  // exact-scan path, just slower.
  const client472 = await pool.connect();
  try {
    // Try HNSW first (better recall, but only available on pgvector ≥ 0.5).
    // If HNSW isn't supported on this Postgres build, fall back to ivfflat
    // (pgvector ≥ 0.4) so we still get an ANN index instead of an exact scan.
    const tables: Array<{ table: string; idxBase: string }> = [
      { table: "library_items",     idxBase: "library_items_embedding" },
      { table: "org_corpus_chunks", idxBase: "org_corpus_chunks_embedding" },
      { table: "agent_memories",    idxBase: "agent_memories_embedding" },
    ];
    for (const { table, idxBase } of tables) {
      try {
        await client472.query(
          `CREATE INDEX IF NOT EXISTS ${idxBase}_hnsw_idx ON ${table} USING hnsw (embedding vector_cosine_ops)`
        );
        console.log(`[migrations] Task #472 HNSW index ensured on ${table}`);
      } catch (hnswErr) {
        console.warn(`[migrations] Task #472 HNSW unavailable on ${table} (${(hnswErr as Error).message}) — trying ivfflat fallback`);
        try {
          await client472.query(
            `CREATE INDEX IF NOT EXISTS ${idxBase}_ivfflat_idx ON ${table} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
          );
          console.log(`[migrations] Task #472 ivfflat fallback index ensured on ${table}`);
        } catch (ivfErr) {
          console.warn(`[migrations] Task #472 ivfflat fallback also failed on ${table}:`, (ivfErr as Error).message);
        }
      }
    }
  } finally {
    client472.release();
  }

  // ── Task #466 / #467: Webex schema reconciliation + one-time scope bump ──
  // Verification (Task #467) found that the original Task #466 migration
  // referenced columns/tables that drifted from what the working code
  // actually uses (`data_source` vs `data_type`, `next_retry_at` vs
  // `next_run_at`, `voicemail_id`/`read` vs `webex_message_id`/`is_read`)
  // and created seven tables (`webex_backfill_jobs`, `webex_api_failures`,
  // `webex_workspaces`, `webex_locations`, `webex_call_queues`,
  // `webex_hunt_groups`, `webex_devices_snapshot`, `webex_admin_reports`)
  // that no live code path reads or writes. The original block crashed on
  // the very first index it tried to create against `webex_sync_state`,
  // which left the rest of the block — including the scope-bump update —
  // unexecuted. This rewritten block contains only what the live code
  // actually relies on:
  //   1. `scopes_version` column on `webex_user_tokens` (used by the
  //      one-time scope bump and the per-user re-auth notifier).
  //   2. The composite unique index that `getWebexSyncState`/upserts in
  //      `storage.ts` rely on (org + data_source + user_id).
  //   3. The scope-bump UPDATE that flips every pre-v2 user token into
  //      needs_reauth=true so reps are nudged to reconnect once.
  //   4. The marker row in `api_response_cache` so the org-token drop
  //      happens exactly once.
  // Every other table the original migration tried to create is
  // ensured by the canonical schema migrations earlier in this file
  // (webex_sync_state, webex_call_enrichment_jobs, webex_voicemails,
  // webex_inventory) and intentionally not duplicated here.
  const WEBEX_SCOPES_VERSION_CURRENT = 2;
  const client466 = await pool.connect();
  try {
    await client466.query(`
      ALTER TABLE webex_user_tokens
        ADD COLUMN IF NOT EXISTS scopes_version INTEGER NOT NULL DEFAULT 1
    `);
    // Composite uniqueness for upsertWebexSyncState — keyed by
    // (org_id, data_source, user_id). user_id is nullable for org-scoped
    // sync rows, so we use two PARTIAL unique indexes (one for the
    // user-scoped case, one for the org-scoped case). Partial indexes
    // round-trip cleanly through drizzle-kit introspection — the prior
    // COALESCE-expression index did not, which caused deploy-time
    // `drizzle-kit push` to emit malformed DDL with truncated cast text.
    await client466.query(`DROP INDEX IF EXISTS webex_sync_state_org_source_user_idx`);
    await client466.query(`DROP INDEX IF EXISTS webex_sync_state_unique_idx`);
    await client466.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS webex_sync_state_user_unique_idx
        ON webex_sync_state (org_id, data_source, user_id)
        WHERE user_id IS NOT NULL
    `);
    await client466.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS webex_sync_state_org_unique_idx
        ON webex_sync_state (org_id, data_source)
        WHERE user_id IS NULL
    `);

    // One-time scope bump → mark every existing per-user token as needs_reauth.
    const bumped = await client466.query(
      `UPDATE webex_user_tokens
         SET needs_reauth = TRUE,
             reauth_reason = 'Webex scope expansion: please reconnect to grant analytics, voicemail, devices, workspaces, queues, and reports access.',
             scopes_version = $1,
             last_reauth_email_at = NULL,
             updated_at = NOW()
       WHERE COALESCE(scopes_version, 1) < $1`,
      [WEBEX_SCOPES_VERSION_CURRENT],
    );
    if ((bumped.rowCount ?? 0) > 0) {
      console.log(`[migrations] Task #466: marked ${bumped.rowCount} webex_user_tokens for re-auth (scope bump)`);
    }
    // Drop the org-level refresh token if it predates the scope bump so the
    // admin reconnects once. We use a marker key to do this exactly once.
    const marker = await client466.query(
      `SELECT 1 FROM api_response_cache WHERE cache_key = 'webex_scopes_v2_applied'`,
    );
    if (marker.rowCount === 0) {
      await client466.query(`DELETE FROM api_response_cache WHERE cache_key = 'webex_refresh_token'`);
      await client466.query(
        `INSERT INTO api_response_cache (cache_key, response, fetched_at, ttl_seconds, source)
         VALUES ('webex_scopes_v2_applied', '{"applied":true}'::jsonb, NOW(), 31536000, 'webex')
         ON CONFLICT (cache_key) DO NOTHING`,
      );
      console.log(`[migrations] Task #466: dropped org-level Webex refresh token (admin must reconnect to grant new scopes)`);
    }
    console.log("[migrations] Task #466 Webex schema + scope bump complete");
  } catch (err) {
    console.error("[migrations] Task #466 migration error:", err);
  } finally {
    client466.release();
  }

  // ── Task #533/#573: snooze fields on email_conversation_threads ──────────
  // Task #533 added snooze support in shared/schema.ts (snoozedUntil,
  // snoozedFromState, snoozedByUserId) but never wrote the supporting
  // migration. Without these columns every query against the table fails
  // (`column "snoozed_until" does not exist`), which 500s the Conversations
  // tab and floods the wake-sweep scheduler with errors. This block adds the
  // columns idempotently plus a partial index that keeps the wake-sweep query
  // (waiting_state='snoozed' AND snoozed_until <= now()) cheap as snooze
  // volume grows.
  const clientSnooze = await pool.connect();
  try {
    await clientSnooze.query(`ALTER TABLE email_conversation_threads ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP`);
    await clientSnooze.query(`ALTER TABLE email_conversation_threads ADD COLUMN IF NOT EXISTS snoozed_from_state TEXT`);
    await clientSnooze.query(`ALTER TABLE email_conversation_threads ADD COLUMN IF NOT EXISTS snoozed_by_user_id VARCHAR`);
    // Add the FK in its own try block so any failure (e.g. legacy bad data
    // in snoozed_by_user_id, or transient lock) doesn't prevent the wake
    // index below from being created. The FK existence check is scoped by
    // table OID to avoid false positives from same-named constraints on
    // unrelated tables/schemas.
    try {
      const fkExists = await clientSnooze.query(`
        SELECT 1 FROM pg_constraint
        WHERE conname = 'email_conversation_threads_snoozed_by_user_id_fkey'
          AND conrelid = 'public.email_conversation_threads'::regclass
      `);
      if (fkExists.rowCount === 0) {
        await clientSnooze.query(`
          ALTER TABLE email_conversation_threads
          ADD CONSTRAINT email_conversation_threads_snoozed_by_user_id_fkey
          FOREIGN KEY (snoozed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        `);
      }
    } catch (fkErr) {
      console.error("[migrations] snooze FK add error (non-fatal, wake index will still be created):", fkErr);
    }
    await clientSnooze.query(`
      CREATE INDEX IF NOT EXISTS idx_ect_snoozed_wake
      ON email_conversation_threads (snoozed_until)
      WHERE waiting_state = 'snoozed'
    `);
    console.log("[migrations] snooze columns + wake index added to email_conversation_threads (Task #533/#573)");
  } catch (err) {
    console.error("[migrations] snooze columns migration error:", err);
  } finally {
    clientSnooze.release();
  }

  // ── Task #532/#573: email_conversation_read_states table ─────────────────
  // Task #532 added per-user thread read-state tracking in shared/schema.ts
  // but never wrote the supporting migration. The Conversations endpoint
  // (GET /api/internal/conversations) joins this table on every request to
  // compute the unread badge, so without it the entire inbox 500s. Discovered
  // while validating the Task #573 snooze fix — without this companion
  // migration the Conversations tab still won't load. Idempotent.
  const clientReadStates = await pool.connect();
  try {
    await clientReadStates.query(`
      CREATE TABLE IF NOT EXISTS email_conversation_read_states (
        id            varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id        varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id       varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        thread_id     text NOT NULL,
        last_read_at  timestamp,
        created_at    timestamp NOT NULL DEFAULT NOW(),
        updated_at    timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientReadStates.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS email_conv_read_user_thread_uniq
        ON email_conversation_read_states (user_id, thread_id)
    `);
    console.log("[migrations] email_conversation_read_states table ensured (Task #532/#573)");
  } catch (err) {
    console.error("[migrations] email_conversation_read_states migration error:", err);
  } finally {
    clientReadStates.release();
  }

  // Customer Quotes upgrade #1 — per-org margin floors ($/mile per equipment).
  // Backs the PricingRecommendationCard floor warnings and the admin
  // "Margin floors" settings dialog. Idempotent.
  const clientQuotePricing = await pool.connect();
  try {
    await clientQuotePricing.query(`
      CREATE TABLE IF NOT EXISTS quote_pricing_settings (
        organization_id    varchar PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        margin_floors_rpm  jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at         timestamp NOT NULL DEFAULT NOW(),
        updated_by_id      varchar REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    console.log("[migrations] quote_pricing_settings table ensured (Customer Quotes #1)");
  } catch (err) {
    console.error("[migrations] quote_pricing_settings migration error:", err);
  } finally {
    clientQuotePricing.release();
  }

  // ── Task #602: email_response_time_sla_settings table ────────────────────
  // Per-org configurable Response Time SLA targets (default 1h/4h/24h business
  // hours). Backs the new SLA section on the Email Intelligence > Response
  // Time tab. Idempotent.
  const clientRtSla = await pool.connect();
  try {
    await clientRtSla.query(`
      CREATE TABLE IF NOT EXISTS email_response_time_sla_settings (
        organization_id varchar PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        targets jsonb NOT NULL DEFAULT '[]'::jsonb,
        updated_at timestamp NOT NULL DEFAULT NOW(),
        updated_by varchar REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    console.log("[migrations] email_response_time_sla_settings table ensured (Task #602)");
  } catch (err) {
    console.error("[migrations] email_response_time_sla_settings migration error:", err);
  } finally {
    clientRtSla.release();
  }

  // ── Customer Quotes #3: quote_sender_mappings table ──────────────────────
  // Sender-domain learning. EXACTLY ONE of (sender_email, sender_domain)
  // is set per row; partial unique indexes enforce one mapping per scope.
  // Idempotent.
  const clientSenderMap = await pool.connect();
  try {
    await clientSenderMap.query(`
      CREATE TABLE IF NOT EXISTS quote_sender_mappings (
        id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        sender_domain   text,
        sender_email    text,
        customer_id     varchar NOT NULL REFERENCES quote_customers(id) ON DELETE CASCADE,
        source          text    NOT NULL DEFAULT 'manual',
        sample_count    integer NOT NULL DEFAULT 1,
        last_used_at    timestamp NOT NULL DEFAULT NOW(),
        created_at      timestamp NOT NULL DEFAULT NOW(),
        updated_at      timestamp NOT NULL DEFAULT NOW(),
        CONSTRAINT quote_sender_mappings_one_of_chk CHECK (
          (sender_email IS NOT NULL AND sender_domain IS NULL)
          OR (sender_email IS NULL AND sender_domain IS NOT NULL)
        )
      )
    `);
    await clientSenderMap.query(`
      CREATE INDEX IF NOT EXISTS quote_sender_mappings_org_idx
        ON quote_sender_mappings (organization_id)
    `);
    await clientSenderMap.query(`
      CREATE INDEX IF NOT EXISTS quote_sender_mappings_customer_idx
        ON quote_sender_mappings (customer_id)
    `);
    await clientSenderMap.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS quote_sender_mappings_org_email_uq
        ON quote_sender_mappings (organization_id, sender_email)
        WHERE sender_email IS NOT NULL
    `);
    await clientSenderMap.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS quote_sender_mappings_org_domain_uq
        ON quote_sender_mappings (organization_id, sender_domain)
        WHERE sender_domain IS NOT NULL
    `);
    console.log("[migrations] quote_sender_mappings table ensured (Customer Quotes #3)");
  } catch (err) {
    console.error("[migrations] quote_sender_mappings migration error:", err);
  } finally {
    clientSenderMap.release();
  }

  // ── Task #601: Available Freight Cockpit schema ──────────────────────────
  // Adds the cockpit's snooze column on freight_opportunities, the auto-pilot
  // controls on company_outreach_policies, and the two cockpit-only tables
  // (saved views + per-user prefs). All idempotent.
  const clientCockpit = await pool.connect();
  try {
    await clientCockpit.query(`
      ALTER TABLE freight_opportunities
        ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP
    `);
    await clientCockpit.query(`
      ALTER TABLE company_outreach_policies
        ADD COLUMN IF NOT EXISTS auto_send_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS auto_send_hour_ct    INTEGER NOT NULL DEFAULT 8,
        ADD COLUMN IF NOT EXISTS auto_send_top_n      INTEGER NOT NULL DEFAULT 3,
        ADD COLUMN IF NOT EXISTS auto_send_max_per_day INTEGER NOT NULL DEFAULT 10,
        ADD COLUMN IF NOT EXISTS auto_send_last_run_at TIMESTAMP
    `);
    await clientCockpit.query(`
      CREATE INDEX IF NOT EXISTS company_outreach_policies_auto_send_idx
        ON company_outreach_policies (org_id, auto_send_enabled)
    `);
    await clientCockpit.query(`
      CREATE TABLE IF NOT EXISTS freight_opportunity_saved_views (
        id         varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id     varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id    varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       text    NOT NULL,
        filters    jsonb   NOT NULL DEFAULT '{}'::jsonb,
        is_shared  boolean NOT NULL DEFAULT FALSE,
        created_at timestamp NOT NULL DEFAULT NOW(),
        updated_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientCockpit.query(`
      CREATE INDEX IF NOT EXISTS freight_saved_views_org_user_idx
        ON freight_opportunity_saved_views (org_id, user_id)
    `);
    await clientCockpit.query(`
      CREATE TABLE IF NOT EXISTS user_freight_cockpit_prefs (
        user_id              varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        org_id               varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        active_view_id       varchar REFERENCES freight_opportunity_saved_views(id) ON DELETE SET NULL,
        layout               text    NOT NULL DEFAULT 'table',
        grouping             text    NOT NULL DEFAULT 'none',
        sort                 text    NOT NULL DEFAULT 'urgency',
        autopilot_muted_until timestamp,
        updated_at           timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientCockpit.query(`
      CREATE INDEX IF NOT EXISTS user_freight_cockpit_prefs_org_idx
        ON user_freight_cockpit_prefs (org_id)
    `);
    console.log("[migrations] Task #601 cockpit schema ensured (snooze, auto-pilot, saved views, prefs)");
  } catch (err) {
    console.error("[migrations] Task #601 cockpit migration error:", err);
  } finally {
    clientCockpit.release();
  }

  // ── Task #611: email_reply_latency_regression_settings ────────────────────
  // Per-org configuration for the weekly reply-speed regression detector.
  // Idempotent.
  const clientReplyRegression = await pool.connect();
  try {
    await clientReplyRegression.query(`
      CREATE TABLE IF NOT EXISTS email_reply_latency_regression_settings (
        organization_id    varchar PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        enabled            boolean NOT NULL DEFAULT TRUE,
        lookback_weeks     integer NOT NULL DEFAULT 4,
        p90_regression_pct integer NOT NULL DEFAULT 25,
        min_replies        integer NOT NULL DEFAULT 10,
        business_hours     boolean NOT NULL DEFAULT TRUE,
        updated_at         timestamp NOT NULL DEFAULT NOW(),
        updated_by         varchar REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    console.log("[migrations] email_reply_latency_regression_settings table ensured (Task #611)");
  } catch (err) {
    console.error("[migrations] email_reply_latency_regression_settings migration error:", err);
  } finally {
    clientReplyRegression.release();
  }

  // ── Task #631: carrier_outreach_logs.source_module ────────────────────────
  // Unified contact-lock view classifies which send path produced each row so
  // dedup queries can surface "Contacted via LWQ by Rep B" / "via auto-pilot"
  // suppression reasons. Nullable for legacy rows. Idempotent ADD COLUMN IF
  // NOT EXISTS — safe to run on every boot. Required by the schema-drift guard
  // in tandem with the corresponding column in shared/schema.ts.
  const clientSourceModule = await pool.connect();
  try {
    await clientSourceModule.query(`
      ALTER TABLE carrier_outreach_logs
      ADD COLUMN IF NOT EXISTS source_module varchar
    `);
    console.log("[migrations] carrier_outreach_logs.source_module ensured (Task #631)");
  } catch (err) {
    console.error("[migrations] source_module migration error:", err);
  } finally {
    clientSourceModule.release();
  }

  // ── Task #637: carrier_lane_outcomes ──────────────────────────────────────
  // Per-(orgId, carrierId, laneSignature) rolling outcome counters. Written
  // by recordCarrierLaneOutcome() on outbound send / reply / cover / etc and
  // read by the carrier ranker as a "prior" so reps can see "carrier X has
  // 2 covers + 1 yes on this lane" without re-scanning every legacy event
  // table on the hot path. Idempotent CREATE IF NOT EXISTS — required by
  // the schema-drift guard alongside the Drizzle table in shared/schema.ts.
  const clientCarrierLaneOutcomes = await pool.connect();
  try {
    await clientCarrierLaneOutcomes.query(`
      CREATE TABLE IF NOT EXISTS carrier_lane_outcomes (
        id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id          varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        carrier_id      varchar NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
        lane_signature  text NOT NULL,
        origin              text,
        origin_state        text,
        destination         text,
        destination_state   text,
        equipment_type      text,
        sent_count      integer NOT NULL DEFAULT 0,
        open_count      integer NOT NULL DEFAULT 0,
        reply_count     integer NOT NULL DEFAULT 0,
        yes_count       integer NOT NULL DEFAULT 0,
        quote_count     integer NOT NULL DEFAULT 0,
        cover_count     integer NOT NULL DEFAULT 0,
        loss_count      integer NOT NULL DEFAULT 0,
        first_event_at  timestamp NOT NULL DEFAULT NOW(),
        last_event_at   timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientCarrierLaneOutcomes.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS carrier_lane_outcomes_uq
        ON carrier_lane_outcomes (org_id, carrier_id, lane_signature)
    `);
    await clientCarrierLaneOutcomes.query(`
      CREATE INDEX IF NOT EXISTS carrier_lane_outcomes_org_carrier_idx
        ON carrier_lane_outcomes (org_id, carrier_id)
    `);
    await clientCarrierLaneOutcomes.query(`
      CREATE INDEX IF NOT EXISTS carrier_lane_outcomes_org_lane_idx
        ON carrier_lane_outcomes (org_id, lane_signature)
    `);
    console.log("[migrations] carrier_lane_outcomes ensured (Task #637)");
  } catch (err) {
    console.error("[migrations] carrier_lane_outcomes migration error:", err);
  } finally {
    clientCarrierLaneOutcomes.release();
  }

  // Task #637 — event-level dedupe ledger. Caller-supplied event keys
  // (e.g. `outreach:<logId>:sent`) land here first; the helper bumps the
  // counter row only when the dedupe insert produced a fresh row.
  const clientCarrierLaneOutcomeEventKeys = await pool.connect();
  try {
    await clientCarrierLaneOutcomeEventKeys.query(`
      CREATE TABLE IF NOT EXISTS carrier_lane_outcome_event_keys (
        org_id      varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_key   varchar NOT NULL,
        recorded_at timestamp NOT NULL DEFAULT NOW(),
        PRIMARY KEY (org_id, event_key)
      )
    `);
    console.log("[migrations] carrier_lane_outcome_event_keys ensured (Task #637)");
  } catch (err) {
    console.error("[migrations] carrier_lane_outcome_event_keys migration error:", err);
  } finally {
    clientCarrierLaneOutcomeEventKeys.release();
  }

  // Task #638: carrier_overrides — rep override ledger; idempotent per UTC day.
  const clientCarrierOverrides = await pool.connect();
  try {
    await clientCarrierOverrides.query(`
      CREATE TABLE IF NOT EXISTS carrier_overrides (
        id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id          varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        carrier_id      varchar NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
        lane_signature  text NOT NULL,
        origin              text,
        origin_state        text,
        destination         text,
        destination_state   text,
        equipment_type      text,
        reason_code     text,
        action          text NOT NULL,
        notes           text,
        rep_id          varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        occurred_at     timestamp NOT NULL DEFAULT NOW(),
        occurred_at_day varchar(10) NOT NULL
      )
    `);
    await clientCarrierOverrides.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS carrier_overrides_uq
        ON carrier_overrides (org_id, carrier_id, lane_signature, rep_id, occurred_at_day)
    `);
    await clientCarrierOverrides.query(`
      CREATE INDEX IF NOT EXISTS carrier_overrides_org_lane_idx
        ON carrier_overrides (org_id, lane_signature)
    `);
    await clientCarrierOverrides.query(`
      CREATE INDEX IF NOT EXISTS carrier_overrides_org_carrier_idx
        ON carrier_overrides (org_id, carrier_id)
    `);
    console.log("[migrations] carrier_overrides ensured (Task #638)");
  } catch (err) {
    console.error("[migrations] carrier_overrides migration error:", err);
  } finally {
    clientCarrierOverrides.release();
  }

  // ── Task #639: Today queue — landing pref column + snooze table ────────────
  // `users.default_to_today_queue` drives the "/" → "/today" redirect at the
  // top of <Router/>; defaults to TRUE so the new queue becomes the new home,
  // and reps can opt back to the classic dashboard via the in-app toggle.
  // Idempotent ADD COLUMN IF NOT EXISTS — required by the schema-drift guard
  // alongside the column declaration in shared/schema.ts.
  const clientTodayLandingCol = await pool.connect();
  try {
    await clientTodayLandingCol.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS default_to_today_queue BOOLEAN NOT NULL DEFAULT true
    `);
    console.log("[migrations] users.default_to_today_queue ensured (Task #639)");
  } catch (err) {
    console.error("[migrations] users.default_to_today_queue migration error:", err);
  } finally {
    clientTodayLandingCol.release();
  }

  // `today_queue_snoozes` — per-user, per-source-item "Done for now" rows used
  // by the unified Today queue aggregator to filter out items the rep has
  // explicitly parked. Composite uniqueness on (user_id, source, source_id)
  // means re-snoozing the same row is an upsert (extends the wake time).
  // Required by the schema-drift guard alongside the Drizzle table in
  // shared/schema.ts.
  const clientTodaySnoozes = await pool.connect();
  try {
    await clientTodaySnoozes.query(`
      CREATE TABLE IF NOT EXISTS today_queue_snoozes (
        id            varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id        varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id       varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source        text NOT NULL,
        source_id     text NOT NULL,
        snoozed_until timestamp NOT NULL,
        reason        text,
        created_at    timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientTodaySnoozes.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS today_queue_snoozes_user_item_uniq
        ON today_queue_snoozes (user_id, source, source_id)
    `);
    await clientTodaySnoozes.query(`
      CREATE INDEX IF NOT EXISTS today_queue_snoozes_org_user_idx
        ON today_queue_snoozes (org_id, user_id)
    `);
    console.log("[migrations] today_queue_snoozes ensured (Task #639)");
  } catch (err) {
    console.error("[migrations] today_queue_snoozes migration error:", err);
  } finally {
    clientTodaySnoozes.release();
  }

  // Task #700 — AI Engagement Instrumentation table.
  // Task #701 — Integration health snapshots table.
  // Task #705 — Endpoint perf samples table.
  const clientObservability = await pool.connect();
  try {
    await clientObservability.query(`
      CREATE TABLE IF NOT EXISTS ai_engagement_events (
        id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id         varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        surface         text NOT NULL,
        feature         text,
        event_type      text NOT NULL,
        target_id       text,
        meta            jsonb,
        created_at      timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientObservability.query(`CREATE INDEX IF NOT EXISTS ai_eng_org_surface_created_idx ON ai_engagement_events (organization_id, surface, created_at)`);
    await clientObservability.query(`CREATE INDEX IF NOT EXISTS ai_eng_org_created_idx ON ai_engagement_events (organization_id, created_at)`);
    await clientObservability.query(`CREATE INDEX IF NOT EXISTS ai_eng_user_created_idx ON ai_engagement_events (user_id, created_at)`);

    await clientObservability.query(`
      CREATE TABLE IF NOT EXISTS endpoint_perf_samples (
        id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id varchar,
        route_key       text NOT NULL,
        duration_ms     integer NOT NULL,
        status_code     integer NOT NULL,
        cache_hint      text,
        created_at      timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientObservability.query(`CREATE INDEX IF NOT EXISTS perf_samples_route_created_idx ON endpoint_perf_samples (route_key, created_at)`);
    await clientObservability.query(`CREATE INDEX IF NOT EXISTS perf_samples_created_idx ON endpoint_perf_samples (created_at)`);

    await clientObservability.query(`
      CREATE TABLE IF NOT EXISTS integration_health_snapshots (
        id                 varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        source             text NOT NULL,
        connected          boolean NOT NULL,
        health_state       text NOT NULL,
        last_success_at    timestamp,
        last_error_at      timestamp,
        last_error_message text,
        breaker_state      text,
        detail             jsonb,
        created_at         timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientObservability.query(`CREATE INDEX IF NOT EXISTS integration_health_source_created_idx ON integration_health_snapshots (source, created_at)`);
    console.log("[migrations] observability tables ensured (Tasks #700/#701/#705)");
  } catch (err) {
    console.error("[migrations] observability migration error:", err);
  } finally {
    clientObservability.release();
  }

  // ─── Task #741: Webex real-time webhooks ────────────────────────────────
  // Two new tables to drive push-based Webex telephony_calls / voicemails:
  //   • webex_webhook_subscriptions — one row per (org, [user], resource, event)
  //     with the Webex-side webhook id, signing secret, status, and last-event
  //     timestamp. Used by the receiver to look up secrets and by the adaptive
  //     poller to decide whether webhooks are healthy enough to back off.
  //   • webex_webhook_events — append-only log of every notification that hits
  //     /webhooks/webex. event_id is unique to dedupe Webex retries.
  // CREATE-IF-NOT-EXISTS, idempotent on every boot.
  const clientWebexWebhooks = await pool.connect();
  try {
    await clientWebexWebhooks.query(`
      CREATE TABLE IF NOT EXISTS webex_webhook_subscriptions (
        id               varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id           varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id          varchar REFERENCES users(id) ON DELETE CASCADE,
        scope            text NOT NULL DEFAULT 'org',
        resource         text NOT NULL,
        event            text NOT NULL DEFAULT 'all',
        webhook_id       text,
        target_url       text NOT NULL,
        secret           text NOT NULL,
        status           text NOT NULL DEFAULT 'active',
        last_error       text,
        last_error_at    timestamp,
        last_event_at    timestamp,
        events_received  integer NOT NULL DEFAULT 0,
        expires_at       timestamp,
        created_at       timestamp NOT NULL DEFAULT NOW(),
        updated_at       timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientWebexWebhooks.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS webex_webhook_sub_user_unique_idx
        ON webex_webhook_subscriptions (org_id, user_id, resource, event)
        WHERE user_id IS NOT NULL
    `);
    await clientWebexWebhooks.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS webex_webhook_sub_org_unique_idx
        ON webex_webhook_subscriptions (org_id, resource, event)
        WHERE user_id IS NULL
    `);
    await clientWebexWebhooks.query(`CREATE INDEX IF NOT EXISTS webex_webhook_sub_org_idx ON webex_webhook_subscriptions (org_id)`);
    await clientWebexWebhooks.query(`CREATE INDEX IF NOT EXISTS webex_webhook_sub_status_idx ON webex_webhook_subscriptions (status)`);

    await clientWebexWebhooks.query(`
      CREATE TABLE IF NOT EXISTS webex_webhook_events (
        id               varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id         text NOT NULL,
        subscription_id  varchar REFERENCES webex_webhook_subscriptions(id) ON DELETE SET NULL,
        org_id           varchar REFERENCES organizations(id) ON DELETE SET NULL,
        user_id          varchar REFERENCES users(id) ON DELETE SET NULL,
        resource         text NOT NULL,
        event            text NOT NULL,
        resource_id      text,
        payload          jsonb NOT NULL,
        signature_valid  boolean NOT NULL DEFAULT false,
        processed_at     timestamp,
        process_error    text,
        received_at      timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await clientWebexWebhooks.query(`CREATE UNIQUE INDEX IF NOT EXISTS webex_webhook_event_id_unique_idx ON webex_webhook_events (event_id)`);
    await clientWebexWebhooks.query(`CREATE INDEX IF NOT EXISTS webex_webhook_event_org_received_idx ON webex_webhook_events (org_id, received_at)`);
    await clientWebexWebhooks.query(`CREATE INDEX IF NOT EXISTS webex_webhook_event_resource_idx ON webex_webhook_events (resource, received_at)`);
    console.log("[migrations] Task #741: webex webhook tables ensured");
  } catch (err) {
    console.error("[migrations] Task #741 webex webhook migration error:", err);
  } finally {
    clientWebexWebhooks.release();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Cleanup: purge fixture mailbox addresses from monitored_mailboxes.
  //
  // Background: the lane-work-queue test suite seeds users with
  // `wq.test.*@example.com` addresses. If anyone ever invokes the admin
  // "Enroll all eligible users" flow while those test users exist, those
  // addresses get inserted into monitored_mailboxes. Microsoft Graph cannot
  // subscribe to non-existent addresses, so each one is permanently stuck
  // with `sentItemsHealth = "missing"`, and the Conversations Inbox shows
  // "Webhook unhealthy" forever even though every real mailbox is fine.
  //
  // This migration removes any mailboxes whose address ends in a known
  // fixture/non-routable domain (kept in sync with FIXTURE_MAILBOX_DOMAINS in
  // server/routes/monitoredMailboxes.ts). The route handlers reject these
  // addresses going forward, so this cleanup only needs to run once per
  // environment but is safe to leave in place permanently.
  // ────────────────────────────────────────────────────────────────────────
  const clientFixturePurge = await pool.connect();
  try {
    const result = await clientFixturePurge.query(
      `DELETE FROM monitored_mailboxes
       WHERE LOWER(email) LIKE ANY($1::text[])
       RETURNING id, email`,
      [FIXTURE_MAILBOX_LIKE_PATTERNS as string[]],
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(
        `[migrations] purged ${result.rowCount} fixture monitored_mailboxes (e.g. ${result.rows.slice(0, 3).map(r => r.email).join(", ")}) — these can never receive Graph notifications and were tripping the "Webhook unhealthy" badge`,
      );
    } else {
      console.log("[migrations] no fixture monitored_mailboxes to purge");
    }
  } catch (err) {
    console.error("[migrations] fixture monitored_mailboxes purge error:", err);
  } finally {
    clientFixturePurge.release();
  }

  // Task #820: add freight_opportunities.delivery_date and overwrite any
  // freight_outreach_templates rows that still leak {{customer_name}} or a
  // hardcoded company name. Idempotent.
  const clientFreightOpp820 = await pool.connect();
  try {
    await clientFreightOpp820.query(
      `ALTER TABLE freight_opportunities ADD COLUMN IF NOT EXISTS delivery_date text`,
    );

    // Force-overwrite every freight_outreach_templates row whose subject OR
    // body still references `{{customer_name}}` — replacing the entire row
    // (subject + body) with the new rep-approved default for that kind. We
    // do NOT try to surgically strip the token: a partial scrub leaves the
    // surrounding sentence ("Load for  on …") in a fragile, half-edited
    // state and the row would still need a human pass. Overwriting in full
    // guarantees every send after this migration uses safe copy. Reps who
    // need org-specific tweaks can re-customize from the new clean baseline.
    const NEW_EXACT_SUBJECT =
      "Available freight - {{lane_display_to}} ({{pickup_window_short}})";
    const NEW_EXACT_BODY =
      "Hey {{carrier_name}} team,\n\n" +
      "I've got a {{equipment_human}} load picking up in {{origin}} to {{destination}}. " +
      "P/U {{pickup_date_short}} and delivers {{delivery_date_short}}.\n\n" +
      "Do you have capacity? If not, what lanes are you working on?\n\n" +
      "Thanks,\n{{rep_name}}";
    const NEW_LANE_SUBJECT =
      "Available freight - {{lane_display_to}} ({{pickup_window_short}})";
    const NEW_LANE_BODY =
      "Hey {{carrier_name}} team,\n\n" +
      "I'm building out steady coverage on {{lane_display_to}} ({{equipment_human}}). " +
      "Next pickup is {{pickup_date_short}} delivering {{delivery_date_short}}.\n\n" +
      "Does this lane fit your network? Even rough timing (this week, next few weeks, or future) is helpful so I know when to call.\n\n" +
      "Thanks,\n{{rep_name}}";

    const overwriteExact = await clientFreightOpp820.query(
      `UPDATE freight_outreach_templates
         SET subject = $1, body = $2, updated_at = NOW()
       WHERE kind = 'exact_load'
         AND (subject LIKE '%{{customer_name}}%' OR body LIKE '%{{customer_name}}%')`,
      [NEW_EXACT_SUBJECT, NEW_EXACT_BODY],
    );
    const overwriteLane = await clientFreightOpp820.query(
      `UPDATE freight_outreach_templates
         SET subject = $1, body = $2, updated_at = NOW()
       WHERE kind = 'lane_building'
         AND (subject LIKE '%{{customer_name}}%' OR body LIKE '%{{customer_name}}%')`,
      [NEW_LANE_SUBJECT, NEW_LANE_BODY],
    );

    // ALSO scan for hardcoded customer-name leakage: any template whose
    // saved subject/body contains the literal text of one of *that org's*
    // companies. This catches reps who pasted "ACME Foods" verbatim into a
    // custom override (so the customer name is on the page even though
    // `{{customer_name}}` isn't). We compare case-insensitively, ignore
    // very short company names (≤3 chars — too noisy, e.g. "USA"), and
    // limit to non-archived rows. Hits get overwritten with the safe
    // default for that kind, same as above.
    //
    // This is intentionally conservative: it can only catch leaks of the
    // *currently saved* company name string. If a customer rebrands, an
    // older saved template with the old name remains until the next edit.
    // Combined with the runtime `customer_name: ""` substitution and the
    // overwrite above, the residual blast radius is acceptable.
    const hardcodedRows = await clientFreightOpp820.query(
      `SELECT t.id, t.kind, t.org_id, t.subject, t.body, c.name AS company_name
         FROM freight_outreach_templates t
         JOIN companies c ON c.org_id = t.org_id
        WHERE c.name IS NOT NULL
          AND length(c.name) > 3
          AND (
            position(lower(c.name) in lower(t.subject)) > 0
            OR position(lower(c.name) in lower(t.body)) > 0
          )`,
    );
    let hardcodedFixed = 0;
    for (const row of hardcodedRows.rows as Array<{
      id: string;
      kind: string;
      company_name: string;
    }>) {
      const newSubject = row.kind === "exact_load" ? NEW_EXACT_SUBJECT : NEW_LANE_SUBJECT;
      const newBody = row.kind === "exact_load" ? NEW_EXACT_BODY : NEW_LANE_BODY;
      await clientFreightOpp820.query(
        `UPDATE freight_outreach_templates
           SET subject = $1, body = $2, updated_at = NOW()
         WHERE id = $3`,
        [newSubject, newBody, row.id],
      );
      hardcodedFixed += 1;
      console.warn(
        `[migrations] task-820: overwrote freight_outreach_templates row ${row.id} (kind=${row.kind}) — saved copy contained literal customer name "${row.company_name}"`,
      );
    }

    const totalOverwritten =
      (overwriteExact.rowCount ?? 0) + (overwriteLane.rowCount ?? 0) + hardcodedFixed;
    if (totalOverwritten > 0) {
      console.log(
        `[migrations] task-820: overwrote ${totalOverwritten} freight_outreach_templates row(s) to safe defaults ` +
        `(token leak: ${(overwriteExact.rowCount ?? 0) + (overwriteLane.rowCount ?? 0)}, hardcoded customer name: ${hardcodedFixed})`,
      );
    } else {
      console.log("[migrations] task-820: no freight_outreach_templates needed customer_name scrub");
    }
  } catch (err) {
    console.error("[migrations] task-820 freight outreach scrub error:", err);
  } finally {
    clientFreightOpp820.release();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Cross-table fixture contamination AUDIT (read-only).
  //
  // monitored_mailboxes is purged above because every row there must have a
  // working Graph subscription. The other tables — users, companies,
  // contacts — may legitimately contain test rows in dev environments and
  // we must NOT silently delete them. Instead, we count any fixture
  // addresses present and stash the result in module-level state so the
  // admin /admin/integrations-health page can surface the warning. The
  // boundary guards in storage.ts prevent any NEW fixture rows from being
  // inserted after this audit runs.
  // ────────────────────────────────────────────────────────────────────────
  const clientAudit = await pool.connect();
  try {
    const samples: { table: string; column: string; email: string }[] = [];

    const usersResult = await clientAudit.query(
      `SELECT username FROM users WHERE LOWER(username) LIKE ANY($1::text[]) LIMIT 5`,
      [FIXTURE_MAILBOX_LIKE_PATTERNS as string[]],
    );
    const usersCount = (await clientAudit.query(
      `SELECT COUNT(*)::int AS n FROM users WHERE LOWER(username) LIKE ANY($1::text[])`,
      [FIXTURE_MAILBOX_LIKE_PATTERNS as string[]],
    )).rows[0]?.n ?? 0;
    for (const r of usersResult.rows) samples.push({ table: "users", column: "username", email: r.username });

    const companiesResult = await clientAudit.query(
      `SELECT dl_email FROM companies WHERE dl_email IS NOT NULL AND LOWER(dl_email) LIKE ANY($1::text[]) LIMIT 5`,
      [FIXTURE_MAILBOX_LIKE_PATTERNS as string[]],
    );
    const companiesCount = (await clientAudit.query(
      `SELECT COUNT(*)::int AS n FROM companies WHERE dl_email IS NOT NULL AND LOWER(dl_email) LIKE ANY($1::text[])`,
      [FIXTURE_MAILBOX_LIKE_PATTERNS as string[]],
    )).rows[0]?.n ?? 0;
    for (const r of companiesResult.rows) samples.push({ table: "companies", column: "dl_email", email: r.dl_email });

    const contactsResult = await clientAudit.query(
      `SELECT email FROM contacts WHERE email IS NOT NULL AND LOWER(email) LIKE ANY($1::text[]) LIMIT 5`,
      [FIXTURE_MAILBOX_LIKE_PATTERNS as string[]],
    );
    const contactsCount = (await clientAudit.query(
      `SELECT COUNT(*)::int AS n FROM contacts WHERE email IS NOT NULL AND LOWER(email) LIKE ANY($1::text[])`,
      [FIXTURE_MAILBOX_LIKE_PATTERNS as string[]],
    )).rows[0]?.n ?? 0;
    for (const r of contactsResult.rows) samples.push({ table: "contacts", column: "email", email: r.email });

    setFixtureContaminationScan({
      monitoredMailboxes: 0, // purged above; always 0 after migration ran
      users: usersCount,
      companies: companiesCount,
      contacts: contactsCount,
      scannedAt: new Date().toISOString(),
      samples,
    });

    const totalCrossTable = usersCount + companiesCount + contactsCount;
    if (totalCrossTable > 0) {
      console.warn(
        `[migrations] fixture contamination AUDIT — found ${totalCrossTable} fixture address(es) across email-bearing tables: ` +
        `users.username=${usersCount}, companies.dl_email=${companiesCount}, contacts.email=${contactsCount}. ` +
        `Boundary guards prevent new pollution; review /admin/integrations-health to clean these up if undesired.`,
      );
    } else {
      console.log("[migrations] fixture contamination audit clean — no fixture addresses in users/companies/contacts");
    }
  } catch (err) {
    console.error("[migrations] fixture contamination audit error:", err);
    setFixtureContaminationScan({
      monitoredMailboxes: 0,
      users: 0,
      companies: 0,
      contacts: 0,
      scannedAt: new Date().toISOString(),
      samples: [],
    });
  } finally {
    clientAudit.release();
  }

  // ===================================================================
  // Customer-Quotes-portlet bugfix — backfill `quote_reps.user_id`.
  //
  // Historically `findOrCreateRep` (server/services/quoteEmailIngestion.ts)
  // looked up the linked `users` row by `username = email` only to gate
  // the insert and threw the linkage away. The result was that EVERY
  // email-ingested rep row had `user_id IS NULL`, which then hid the
  // rep on the Customer Quotes portlet via the Task #752 funnel-
  // eligibility filter (rep displayed as "Unassigned" instead of the
  // real AM/NAM name).
  //
  // The ingestion path now persists `userId` on insert and self-heals
  // existing rows on access. This block force-heals every legacy row
  // up-front so the portlet shows the correct rep on first load instead
  // of waiting for incremental ingestion. Org-scoped and role-gated to
  // preserve cross-tenant safety; only links rows whose linked user is
  // customer-facing per the shared QUOTE_REP_UNIVERSE_ROLES contract.
  // Idempotent — only updates rows that are still NULL.
  // ===================================================================
  const clientRepBackfill = await pool.connect();
  try {
    const repBackfillResult = await clientRepBackfill.query(`
      UPDATE quote_reps qr
         SET user_id = u.id
        FROM users u
       WHERE qr.user_id IS NULL
         AND qr.email IS NOT NULL
         AND qr.organization_id = u.organization_id
         AND lower(u.username) = lower(qr.email)
         AND u.role IN ('national_account_manager', 'account_manager')
    `);
    if ((repBackfillResult.rowCount ?? 0) > 0) {
      console.log(
        `[migrations] quote_reps.user_id backfill — linked ${repBackfillResult.rowCount} rep row(s) ` +
        `to their matching users.id (Customer Quotes portlet rep resolution)`,
      );
    } else {
      console.log("[migrations] quote_reps.user_id backfill — no orphan rows needed linking");
    }
  } catch (err) {
    console.error("[migrations] quote_reps.user_id backfill error:", err);
  } finally {
    clientRepBackfill.release();
  }

  // ===================================================================
  // Conversations freshness — backfill `last_incoming_at` / `last_outgoing_at`
  // / `last_email_at` from MAX(email_messages.provider_sent_at).
  //
  // Phase 1 of "Stop lying about freshness." Historically:
  //   - applyMessageToThread stamped these columns with wall-clock now()
  //     instead of the email's actual provider_sent_at, so any mailbox
  //     backfill produced a wall of identical timestamps that have no
  //     relationship to when the emails were actually sent.
  //   - Many threads were created before applyMessageToThread existed at
  //     all, so 56% of email_conversation_threads still had NULL
  //     last_incoming_at (per the diagnostic query that triggered this
  //     phase: avg drift +134h, only 40% of quote-request threads even
  //     linked to quote_opportunities).
  //
  // Task #859 collapses the three sources of truth (storage GREATEST
  // expression, route layer's MAX(provider_sent_at) GROUP BY, and the
  // denormalized direction columns) into a single permanent
  // `last_email_at` column. Both the date filter (storage.ts) and the
  // row-label timestamp (computeLastEmailAtMap) now read this column,
  // so they cannot disagree. We materialize the column here, backfill
  // it from MAX(provider_sent_at) per thread, and replace the
  // per-direction indexes Task #858 added with a single
  // (org_id, last_email_at DESC) index that backs both the filter and
  // the recency sort. Idempotent — every statement is IF NOT EXISTS or
  // DISTINCT FROM, safe to re-run on every boot.
  // ===================================================================
  const clientFreshness = await pool.connect();
  try {
    // Task #859 — materialize the column so the schema-drift guard
    // doesn't refuse to start. shared/schema.ts owns the Drizzle
    // declaration; this ALTER mirrors it in the live DB.
    await clientFreshness.query(`
      ALTER TABLE email_conversation_threads
        ADD COLUMN IF NOT EXISTS last_email_at timestamp
    `);

    const freshnessResult = await clientFreshness.query(`
      UPDATE email_conversation_threads ect
         SET last_incoming_at = COALESCE(sub.max_in,  ect.last_incoming_at),
             last_outgoing_at = COALESCE(sub.max_out, ect.last_outgoing_at),
             last_email_at    = COALESCE(sub.max_any, ect.last_email_at)
        FROM (
          SELECT thread_id,
                 org_id,
                 MAX(provider_sent_at) FILTER (WHERE direction = 'inbound')  AS max_in,
                 MAX(provider_sent_at) FILTER (WHERE direction = 'outbound') AS max_out,
                 MAX(provider_sent_at)                                       AS max_any
            FROM email_messages
           WHERE provider_sent_at IS NOT NULL
             AND thread_id IS NOT NULL
           GROUP BY thread_id, org_id
        ) sub
       WHERE sub.thread_id = ect.thread_id
         AND sub.org_id    = ect.org_id
         AND (
              (sub.max_in  IS NOT NULL AND ect.last_incoming_at IS DISTINCT FROM sub.max_in)
           OR (sub.max_out IS NOT NULL AND ect.last_outgoing_at IS DISTINCT FROM sub.max_out)
           OR (sub.max_any IS NOT NULL AND ect.last_email_at    IS DISTINCT FROM sub.max_any)
         )
    `);
    if ((freshnessResult.rowCount ?? 0) > 0) {
      console.log(
        `[migrations] conversations freshness backfill — re-anchored ` +
        `${freshnessResult.rowCount} thread row(s) to MAX(email_messages.provider_sent_at) ` +
        `(Task #859: single denormalized last_email_at column)`,
      );
    } else {
      console.log("[migrations] conversations freshness backfill — every thread already in sync");
    }

    // Task #859 — Backstop for threads with NO email_messages rows
    // (e.g. carrier outreach threads that wrote last_outgoing_at via
    // upsert without persisting a message row, or legacy rows). Without
    // this, last_email_at stays NULL and the date filter excludes them
    // even though the per-direction columns still carry a real
    // timestamp. Mirror the GREATEST(...) the storage layer USED to
    // compute on the fly so the backfill matches the previous query
    // semantics for every row that was reachable before.
    const backstopResult = await clientFreshness.query(`
      UPDATE email_conversation_threads
         SET last_email_at = GREATEST(
                COALESCE(last_incoming_at, last_outgoing_at),
                COALESCE(last_outgoing_at, last_incoming_at)
             )
       WHERE last_email_at IS NULL
         AND (last_incoming_at IS NOT NULL OR last_outgoing_at IS NOT NULL)
    `);
    if ((backstopResult.rowCount ?? 0) > 0) {
      console.log(
        `[migrations] conversations freshness backfill — seeded last_email_at ` +
        `from existing direction columns for ${backstopResult.rowCount} row(s) ` +
        `with no email_messages backing`,
      );
    }

    // Task #859 — single index that backs both the date filter and
    // the recency sort. Replaces the per-direction indexes Task #858
    // added for the GREATEST(...) predicate (which can't use either of
    // them anyway — they were a holding pattern, not a real fix).
    await clientFreshness.query(`
      CREATE INDEX IF NOT EXISTS idx_ect_org_last_email_at
        ON email_conversation_threads (org_id, last_email_at DESC)
    `);
    await clientFreshness.query(`DROP INDEX IF EXISTS idx_ect_org_last_incoming_at`);
    await clientFreshness.query(`DROP INDEX IF EXISTS idx_ect_org_last_outgoing_at`);
  } catch (err) {
    console.error("[migrations] conversations freshness backfill error:", err);
  } finally {
    clientFreshness.release();
  }

  // Quote leak forward closure (Task #847). Fail-closed: the partial
  // unique index is the only thing protecting concurrent scheduler
  // ticks from creating duplicate opps for the same source_reference,
  // so any failure here aborts boot. The companion `internal_domains`
  // column on `organizations` powers the per-org admin override.
  const clientClosure = await pool.connect();
  try {
    await clientClosure.query(`
      ALTER TABLE organizations
        ADD COLUMN IF NOT EXISTS internal_domains text[]
        DEFAULT ARRAY[]::text[]
    `);
    await clientClosure.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS quote_opportunities_email_signal_source_ref_uidx
        ON quote_opportunities (organization_id, source_reference)
        WHERE source = 'email_signal'
    `);
  } finally {
    clientClosure.release();
  }

  // ===================================================================
  // Task #849 §1.3 — snoozed_until column + partial index.
  //
  // Production runs idempotent ALTER TABLE statements via
  // runMigrations rather than `npm run db:push`, so the new column
  // declared in shared/schema.ts MUST be materialized here or the
  // schema-drift guard refuses to start. Required by the drift guard
  // alongside the Drizzle column in shared/schema.ts.
  // ===================================================================
  const clientSnoozedUntil = await pool.connect();
  try {
    await clientSnoozedUntil.query(`
      ALTER TABLE quote_opportunities
        ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP
    `);
    await clientSnoozedUntil.query(`
      CREATE INDEX IF NOT EXISTS quote_opportunities_snoozed_idx
        ON quote_opportunities (organization_id, snoozed_until)
        WHERE snoozed_until IS NOT NULL
    `);
  } finally {
    clientSnoozedUntil.release();
  }

  // ===================================================================
  // Task #849 §3.2 — sender suppression on quote_sender_mappings.
  //
  // Adds the `suppressed` boolean column and relaxes `customer_id` to
  // NULLABLE so a Send-to-leak action with `suppressSender=true` can
  // record "do not auto-create opps from this sender" without having
  // to point at a real customer row. Lookup-side honor is in
  // `lookupMapping` (returns null for suppressed rows) and the
  // closure path in `processOneSignal` (skips opp creation when a
  // suppression mapping matches the inbound sender).
  //
  // Idempotent — repeated boots converge. The DROP NOT NULL is a
  // metadata-only change in Postgres so it is safe on hot tables.
  // ===================================================================
  const clientSenderSuppression = await pool.connect();
  try {
    await clientSenderSuppression.query(`
      ALTER TABLE quote_sender_mappings
        ADD COLUMN IF NOT EXISTS suppressed boolean NOT NULL DEFAULT false
    `);
    await clientSenderSuppression.query(`
      ALTER TABLE quote_sender_mappings
        ALTER COLUMN customer_id DROP NOT NULL
    `);
  } finally {
    clientSenderSuppression.release();
  }

  // ===================================================================
  // Task #849 §1.1 — post-2d source backfill (`quote_sources_v2_post2d`).
  //
  // Historically every autopilot-classified inbound quote landed with
  // `source='email'`, indistinguishable from a rep who manually typed
  // the row into the list. The post-2d Quote Requests tab needs to
  // separate those two populations: only `email_signal` rows get the
  // Confidence card and the autopilot-reasoning panel; the source
  // filter rail surfaces them as distinct chips. The new enum lifts
  // `email_signal` and `spot_search` into typed values; this backfill
  // heals legacy rows up-front so the new tab shows the right counts
  // on first load instead of waiting for incremental ingestion.
  //
  // Heuristics (mirrors §1.1 of docs/quote-requests-tab-post-2d-backend-contract.md):
  //   1. `email` → `email_signal` if the opp is referenced by ANY
  //      `email_signals.linked_opportunity_id` row, OR if its
  //      `source_reference` matches the `provider_message_id` of an
  //      email_messages row in the same org. The OR is conservative:
  //      either path reliably indicates autopilot-driven creation.
  //   2. `manual` → `spot_search` if `source_reference LIKE 'spot:%'`.
  //      The Spot Quote Search → Quote Builder write-path stamps the
  //      reference with a `spot:<searchId>` prefix, so this regex is
  //      both necessary and sufficient.
  //
  // Constraint-safety: `quote_opportunities_email_signal_source_ref_uidx`
  // (created by the leak-closure block above) forbids two `email_signal`
  // rows sharing `(organization_id, source_reference)`. Legacy data
  // contains duplicate `email` rows pointing at the same provider
  // message id (one per ingestion attempt). Naive UPDATE flips them
  // all and the second insert into the partial index aborts the whole
  // statement. We dedupe with `DISTINCT ON (organization_id,
  // source_reference) … ORDER BY created_at DESC` and skip groups
  // where an `email_signal` row already exists. NULL source_reference
  // rows are immune to the partial index (NULLs do not collide) and
  // pass through unchanged.
  //
  // Idempotent — re-running converges to zero affected rows. Logs both
  // the affected count and the deduped/skipped count so the operator
  // can confirm the backfill ran exactly once and see the leftovers.
  // ===================================================================
  const clientPost2dSource = await pool.connect();
  try {
    const emailSignalResult = await clientPost2dSource.query(`
      WITH candidates AS (
        SELECT qo.id,
               qo.organization_id,
               qo.source_reference,
               qo.created_at
          FROM quote_opportunities qo
         WHERE qo.source = 'email'
           AND (
             EXISTS (
               SELECT 1
                 FROM email_signals es
                WHERE es.linked_opportunity_id = qo.id
             )
             OR (
               qo.source_reference IS NOT NULL
               AND EXISTS (
                 SELECT 1
                   FROM email_messages em
                  WHERE em.provider_message_id = qo.source_reference
                    AND em.org_id = qo.organization_id
               )
             )
           )
      ),
      null_ref_winners AS (
        SELECT id FROM candidates WHERE source_reference IS NULL
      ),
      keyed_winners AS (
        SELECT DISTINCT ON (c.organization_id, c.source_reference) c.id
          FROM candidates c
         WHERE c.source_reference IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM quote_opportunities other
              WHERE other.organization_id = c.organization_id
                AND other.source_reference = c.source_reference
                AND other.source = 'email_signal'
           )
         ORDER BY c.organization_id, c.source_reference, c.created_at DESC
      )
      UPDATE quote_opportunities qo
         SET source = 'email_signal'
        FROM (
          SELECT id FROM null_ref_winners
          UNION ALL
          SELECT id FROM keyed_winners
        ) winners
       WHERE qo.id = winners.id
    `);
    const skippedResult = await clientPost2dSource.query(`
      SELECT COUNT(*)::int AS skipped
        FROM quote_opportunities qo
       WHERE qo.source = 'email'
         AND qo.source_reference IS NOT NULL
         AND (
           EXISTS (
             SELECT 1
               FROM email_signals es
              WHERE es.linked_opportunity_id = qo.id
           )
           OR EXISTS (
             SELECT 1
               FROM email_messages em
              WHERE em.provider_message_id = qo.source_reference
                AND em.org_id = qo.organization_id
           )
         )
    `);
    const spotSearchResult = await clientPost2dSource.query(`
      UPDATE quote_opportunities
         SET source = 'spot_search'
       WHERE source = 'manual'
         AND source_reference LIKE 'spot:%'
    `);
    const emailSignalCount = emailSignalResult.rowCount ?? 0;
    const spotSearchCount = spotSearchResult.rowCount ?? 0;
    const skippedCount = (skippedResult.rows[0]?.skipped as number) ?? 0;
    if (emailSignalCount > 0 || spotSearchCount > 0 || skippedCount > 0) {
      console.log(
        `[migrations] post-2d source backfill (quote_sources_v2_post2d) — ` +
        `email→email_signal: ${emailSignalCount} row(s), ` +
        `manual→spot_search: ${spotSearchCount} row(s), ` +
        `skipped (dedupe vs unique-index): ${skippedCount} row(s)`,
      );
    } else {
      console.log("[migrations] post-2d source backfill (quote_sources_v2_post2d) — every quote already on the right source");
    }
  } catch (err) {
    console.error("[migrations] post-2d source backfill error:", err);
  } finally {
    clientPost2dSource.release();
  }

  // ── Task #844: Capacity Matches — truck_postings + truck_load_matches ──
  // Idempotent runtime guard (mirrors `shared/schema.ts` definitions). Lets
  // freshly-deployed environments come up without requiring an out-of-band
  // `npm run db:push` first; existing environments where db push already
  // ran are no-ops thanks to IF NOT EXISTS.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS truck_postings (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        carrier_id varchar REFERENCES carriers(id) ON DELETE SET NULL,
        carrier_name_raw text,
        source text NOT NULL,
        email_message_id varchar REFERENCES email_messages(id) ON DELETE SET NULL,
        attachment_name text,
        row_index integer,
        origin_city text,
        origin_state text,
        dest_city text,
        dest_state text,
        dest_preference text,
        available_date date,
        available_through date,
        equipment text,
        rate_ask numeric(12,2),
        notes text,
        raw_text text,
        status text NOT NULL DEFAULT 'active',
        expires_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS truck_postings_org_status_idx ON truck_postings (org_id, status);
      CREATE INDEX IF NOT EXISTS truck_postings_carrier_idx ON truck_postings (carrier_id);
      CREATE INDEX IF NOT EXISTS truck_postings_available_date_idx ON truck_postings (available_date);

      CREATE TABLE IF NOT EXISTS truck_load_matches (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        truck_posting_id varchar NOT NULL REFERENCES truck_postings(id) ON DELETE CASCADE,
        freight_opportunity_id varchar NOT NULL REFERENCES freight_opportunities(id) ON DELETE CASCADE,
        fit_score integer NOT NULL DEFAULT 0,
        reasons text[] DEFAULT '{}'::text[],
        state text NOT NULL DEFAULT 'new',
        assigned_rep_id varchar REFERENCES users(id) ON DELETE SET NULL,
        notified_at timestamp,
        contacted_at timestamp,
        booked_at timestamp,
        dismissed_at timestamp,
        dismissed_reason text,
        actor_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS truck_load_matches_org_state_idx ON truck_load_matches (org_id, state);
      CREATE INDEX IF NOT EXISTS truck_load_matches_posting_idx ON truck_load_matches (truck_posting_id);
      CREATE INDEX IF NOT EXISTS truck_load_matches_opp_idx ON truck_load_matches (freight_opportunity_id);
      CREATE UNIQUE INDEX IF NOT EXISTS truck_load_matches_pair_uq ON truck_load_matches (truck_posting_id, freight_opportunity_id);
      CREATE INDEX IF NOT EXISTS truck_load_matches_rep_idx ON truck_load_matches (assigned_rep_id);
    `);
    console.log("[migrations] Task #844 truck_postings + truck_load_matches ensured");
  } catch (err) {
    console.error("[migrations] Task #844 capacity-matches table guard error:", err);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase A2 — one-shot strip of obvious-fake customer companies and the
  // freight_opportunities they spawned. Idempotent by design: every pass only
  // affects rows where (companies.archived_at IS NULL AND name matches a fake
  // pattern) AND (freight_opportunities.status NOT IN terminal). Once stripped
  // a company stays archived and its opps stay 'cancelled', so subsequent
  // boots find nothing to do and return 0 rows.
  //
  // The producer-side guard in createFreightOpportunityFromWonQuote refuses to
  // seed new fake names going forward; this scrub closes the gap on names that
  // slipped through before the guard existed.
  //
  // LOCKSTEP NOTE (post-architect-review): predicate strings are sourced from
  // `shared/fakeCustomerName.ts` (FAKE_NAME_SQL_RULES) so the JS guard and
  // this SQL scrub cannot drift. Adding/changing a rule there propagates here
  // automatically — including the per-row 'reason' attribution recorded in
  // the freight_opportunities.notes audit trail.
  try {
    // Build the WHERE union and the reason CASE expression directly from the
    // shared rule list. `c.name` is the column we test; `o.name` is the
    // org brand parameter for the self-reference rule.
    const reasonWhen = FAKE_NAME_SQL_RULES
      .map((r) => `WHEN ${r.predicate("fc.name", "fc.org_brand")} THEN '${r.reason}'`)
      .join("\n                       ");
    const fakeWhere = FAKE_NAME_SQL_RULES
      .map((r) => `(${r.predicate("c.name", "o.name")})`)
      .join("\n            OR ");
    const placeholderPredicate = FAKE_NAME_SQL_RULES.find(
      (r) => r.reason === "placeholder",
    )!.predicate("c.name", "o.name");
    const result = await pool.query(`
      WITH fake_companies AS (
        SELECT c.id, c.name, c.organization_id, o.name AS org_brand
        FROM companies c
        LEFT JOIN organizations o ON o.id = c.organization_id
        WHERE c.archived_at IS NULL
          AND (
            ${fakeWhere}
          )
      ),
      cancelled_opps AS (
        UPDATE freight_opportunities fo
           SET status = 'cancelled',
               notes = COALESCE(fo.notes || E'\n', '') ||
                       '[A2 strip] auto-cancelled — customer "' || fc.name ||
                       '" flagged as obvious-fake (' ||
                       CASE
                         ${reasonWhen}
                         ELSE 'unspecified'
                       END || ')'
          FROM fake_companies fc
         WHERE fo.company_id = fc.id
           AND fo.status NOT IN ('cancelled','expired','covered')
        RETURNING fo.id, fc.name AS fake_name
      ),
      archived_companies AS (
        UPDATE companies c
           SET archived_at = to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          FROM fake_companies fc
         WHERE c.id = fc.id
           AND c.archived_at IS NULL
           -- Don't archive the placeholder bucket — it's a sentinel that
           -- might still be useful as a known holding pen. Just cancel its
           -- opps so they stop cluttering the cockpit.
           AND NOT (${placeholderPredicate.replace(/c\.name/g, "c.name").replace(/o\.name/g, "(SELECT name FROM organizations WHERE id = c.organization_id)")})
        RETURNING c.id
      )
      SELECT
        (SELECT COUNT(*) FROM cancelled_opps)     AS opps_cancelled,
        (SELECT COUNT(*) FROM archived_companies) AS companies_archived,
        (SELECT COUNT(*) FROM fake_companies)     AS companies_flagged
    `);
    const row = result.rows[0] ?? {};
    const oppsCancelled = Number(row.opps_cancelled ?? 0);
    const companiesArchived = Number(row.companies_archived ?? 0);
    const companiesFlagged = Number(row.companies_flagged ?? 0);
    if (companiesFlagged > 0 || oppsCancelled > 0) {
      console.log(
        `[migrations] Phase A2 fake-customer strip: cancelled ${oppsCancelled} opps, ` +
        `archived ${companiesArchived} companies (flagged=${companiesFlagged}). ` +
        `Producer-side guard in createFreightOpportunityFromWonQuote prevents new ones.`,
      );
    }
  } catch (err) {
    console.error("[migrations] Phase A2 fake-customer strip error:", err);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase A5 — Won-Quote conversion failure audit. Creates the failure-log
  // table (mirrors the Drizzle definition in shared/schema.ts) and registers
  // one row per pre-A5 won quote that has no matching freight_opportunities
  // row. Idempotent on every level:
  //   - CREATE TABLE / INDEX use IF NOT EXISTS.
  //   - The orphan backfill INSERT relies on the partial unique index
  //     (org_id, quote_id) WHERE resolved_at IS NULL — re-runs are no-ops.
  //
  // This guarantees the admin /admin/freight-conversion-failures page is
  // populated at boot without requiring a manual triage script.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS freight_opportunity_capture_failures (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        quote_id varchar NOT NULL REFERENCES quote_opportunities(id) ON DELETE CASCADE,
        reason text NOT NULL,
        detail text,
        error_message text,
        error_stack text,
        attempted_at timestamp NOT NULL DEFAULT now(),
        retry_count integer NOT NULL DEFAULT 0,
        last_retry_at timestamp,
        last_retry_error text,
        resolved_at timestamp,
        resolved_by_id varchar REFERENCES users(id) ON DELETE SET NULL,
        resolution_note text
      );
      CREATE INDEX IF NOT EXISTS freight_opp_capture_failures_org_resolved_idx
        ON freight_opportunity_capture_failures (org_id, resolved_at);
      CREATE INDEX IF NOT EXISTS freight_opp_capture_failures_quote_idx
        ON freight_opportunity_capture_failures (quote_id);
      CREATE UNIQUE INDEX IF NOT EXISTS freight_opp_capture_failures_open_uq
        ON freight_opportunity_capture_failures (org_id, quote_id)
        WHERE resolved_at IS NULL;
    `);
    console.log("[migrations] Phase A5 freight_opportunity_capture_failures ensured");
  } catch (err) {
    console.error("[migrations] Phase A5 capture-failures table guard error:", err);
  }

  try {
    const backfill = await pool.query(`
      INSERT INTO freight_opportunity_capture_failures
        (org_id, quote_id, reason, detail, attempted_at, retry_count)
      SELECT
        qo.organization_id,
        qo.id,
        'backfill_orphan',
        'Pre-A5 won quote with no matching freight_opportunities row. Click Retry to re-run the converter.',
        COALESCE(qo.created_at, now()),
        0
      FROM quote_opportunities qo
      WHERE qo.outcome_status IN ('won', 'won_low_margin')
        AND NOT EXISTS (
          SELECT 1 FROM freight_opportunities fo
           WHERE fo.org_id = qo.organization_id
             AND fo.source_ref->>'type' = 'won_quote'
             AND fo.source_ref->>'quoteId' = qo.id
        )
      ON CONFLICT (org_id, quote_id) WHERE resolved_at IS NULL
      DO NOTHING
      RETURNING id
    `);
    if (backfill.rowCount && backfill.rowCount > 0) {
      console.log(
        `[migrations] Phase A5 backfill: registered ${backfill.rowCount} orphan won quotes ` +
        `as backfill_orphan failures (admin can Retry from /admin/freight-conversion-failures).`,
      );
    }
  } catch (err) {
    console.error("[migrations] Phase A5 orphan backfill error:", err);
  }
}
