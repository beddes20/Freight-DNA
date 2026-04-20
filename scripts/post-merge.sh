#!/bin/bash
set -e
npm install
# Drizzle-kit prompts come in two flavors: confirm prompts (typed y/n) and
# select prompts (arrow-key list where Enter picks the highlighted default,
# which is always the safe/non-destructive option). A bare newline handles
# both — it accepts the safe default on selects, and answers "no" to confirms
# (drizzle-kit treats empty input as the default-no for confirm prompts).
# Provide plenty of newlines so we never run out across many prompts.
printf '\n%.0s' {1..40} | npx drizzle-kit push --force
# Ensure the session table used by connect-pg-simple is always present.
# drizzle-kit push does not manage this table (excluded via tablesFilter),
# but this guard recreates it if it was ever accidentally dropped.
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\`
  CREATE TABLE IF NOT EXISTS \"session\" (
    \"sid\" varchar NOT NULL COLLATE \"default\",
    \"sess\" json NOT NULL,
    \"expire\" timestamp(6) NOT NULL,
    CONSTRAINT \"session_pkey\" PRIMARY KEY (\"sid\") NOT DEFERRABLE INITIALLY IMMEDIATE
  )
\`).then(() => pool.query(\`CREATE INDEX IF NOT EXISTS \"IDX_session_expire\" ON \"session\" (\"expire\")\`))
  .then(() => { console.log('[post-merge] session table ensured'); pool.end(); })
  .catch(e => { console.error('[post-merge] session table error:', e.message); pool.end(); });
"
