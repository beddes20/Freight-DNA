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

# ─────────────────────────────────────────────────────────────────────────────
# Restart-required banner (Task #880 follow-up)
#
# This script does NOT (and cannot) restart the Express dev server itself.
# Replit workflows are managed by the platform's workflow runner, which can
# only be restarted via the agent's `restart_workflow` tool — not from a
# shell. If we send SIGTERM to the tsx process here, the workflow goes to
# FAILED state instead of auto-respawning, which is strictly worse than
# the current behavior.
#
# What this banner DOES guarantee:
#  - Every post-merge run prints a loud, unambiguous instruction in stdout.
#  - Any agent (or human) reading post-merge output sees the same message
#    in the same place, so the restart step never gets quietly skipped.
#  - Tasks #861 and #862 both had stale-server bugs that wasted an hour
#    each because the restart-required signal was implicit. Making it
#    explicit and impossible-to-miss is the cheapest fix that always works.
#
# Why this matters: `runMigrations.ts`, schedulers, and any other in-process
# state from server boot is only re-evaluated on a fresh boot. Code merged
# in by post-merge.sh will sit dormant until Express restarts, and tests
# run in that window will report stale failures.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "[post-merge] ⚠  ACTION REQUIRED: restart 'Start application' workflow"
echo "[post-merge]"
echo "[post-merge] Express keeps boot-time migrations, backfills, and"
echo "[post-merge] scheduler registrations in memory. Any change to"
echo "[post-merge] server/runMigrations.ts, schedulers, route handlers, or"
echo "[post-merge] any other server-side code WILL NOT take effect until"
echo "[post-merge] you restart the 'Start application' workflow."
echo "[post-merge]"
echo "[post-merge] Tests run in this window may report stale failures."
echo "[post-merge] (This banner exists because Tasks #861 and #862 each"
echo "[post-merge]  burned an hour of debugging on stale-server symptoms.)"
echo "════════════════════════════════════════════════════════════════════════"
