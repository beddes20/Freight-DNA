#!/bin/bash
set -e
npm install
printf 'no\nno\nno\nno\nno\nno\nno\nno\n' | npx drizzle-kit push --force
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
