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
printf '\n%.0s' {1..40} | timeout 90 npx drizzle-kit push --force
DRIZZLE_EXIT=$?
set -e
if [ $DRIZZLE_EXIT -ne 0 ]; then
  echo "[post-merge] drizzle-kit push exited with $DRIZZLE_EXIT — continuing." >&2
  echo "[post-merge] If this was a hang on an interactive prompt, run the prompted DDL manually via psql, then re-run db:push to verify." >&2
fi

# Belt-and-suspenders fallback: drizzle-kit's interactive *select* prompts
# (e.g. "Is X table created or renamed from another table?") read from a TTY
# and can't be answered by piping newlines. When that happens db:push hangs
# until the timeout above and the schema never lands. To keep dev/prod in
# sync regardless, also apply every committed migrations/*.sql file via psql.
# All of our migrations use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so this
# is idempotent and safe to re-run on every merge.
if [ -d migrations ] && command -v psql >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  for f in $(ls migrations/*.sql 2>/dev/null | sort); do
    echo "[post-merge] applying $f"
    if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1; then
      echo "[post-merge] WARN: $f failed (continuing — may already be applied with conflicting state)" >&2
    fi
  done
else
  echo "[post-merge] skipping migrations/*.sql replay (psql or DATABASE_URL unavailable)" >&2
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
