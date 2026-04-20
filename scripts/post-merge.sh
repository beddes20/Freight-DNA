#!/bin/bash
set -e
npm install

# Drizzle-kit push handles confirm prompts via --force, but newer versions also
# emit interactive *select* prompts (e.g. "truncate table?" when adding a unique
# constraint to an existing table). Those select prompts read from a TTY and
# will hang indefinitely when stdin is closed (which it is during post-merge).
#
# Strategy:
#  1. Try push with a hard timeout. On the happy path this finishes quickly.
#  2. If it times out or errors, fall back to a no-op warning — most schema
#     changes are also applied inline at server boot via server/migrations,
#     and a stuck push should never block the rest of post-merge setup.
#  3. Pipe newlines anyway so confirm prompts that DO read stdin get a default.
set +e
printf '\n%.0s' {1..40} | timeout 45 npx drizzle-kit push --force
DRIZZLE_EXIT=$?
set -e
if [ $DRIZZLE_EXIT -ne 0 ]; then
  echo "[post-merge] drizzle-kit push exited with $DRIZZLE_EXIT — continuing." >&2
  echo "[post-merge] If this was a hang on an interactive prompt, run the prompted DDL manually via psql, then re-run db:push to verify." >&2
fi

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
