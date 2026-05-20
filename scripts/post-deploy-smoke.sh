#!/usr/bin/env bash
# Post-deploy smoke check for Freight-DNA P0 health endpoints.
#
# Verifies:
#   1. /healthz       — process liveness (always 200 "ok")
#   2. /readyz        — boot-complete readiness (200 "ready")
#   3. /api/health/deep — runtime shape (JSON with expected fields)
#
# Usage:
#   ./scripts/post-deploy-smoke.sh https://freight-dna.onrender.com
#   ./scripts/post-deploy-smoke.sh https://app.example.com production
#
# Optional second arg ("production" | "staging") asserts the deep endpoint's
# appEnv matches. Omit to skip that check.
#
# Exits 0 on PASS, non-zero on FAIL. Each check prints PASS/FAIL with reason.
set -u

BASE="${1:-}"
EXPECT_APP_ENV="${2:-}"

if [ -z "$BASE" ]; then
  echo "FAIL: missing base URL" >&2
  echo "Usage: $0 <base-url> [expected-app-env]" >&2
  exit 2
fi

BASE="${BASE%/}"
FAIL=0

check() {
  local name="$1"; local result="$2"; local detail="${3:-}"
  if [ "$result" = "PASS" ]; then
    echo "PASS  $name${detail:+ — $detail}"
  else
    echo "FAIL  $name${detail:+ — $detail}" >&2
    FAIL=1
  fi
}

# 1. /healthz
body=$(curl -fsS --max-time 10 "$BASE/healthz" 2>/dev/null || echo "__ERR__")
if [ "$body" = "ok" ]; then
  check "/healthz" PASS "body=ok"
else
  check "/healthz" FAIL "expected body 'ok', got '$body'"
fi

# 2. /readyz
status=$(curl -s -o /tmp/.smoke_readyz_body --max-time 10 -w "%{http_code}" "$BASE/readyz" 2>/dev/null || echo "000")
body=$(cat /tmp/.smoke_readyz_body 2>/dev/null || echo "")
if [ "$status" = "200" ] && [ "$body" = "ready" ]; then
  check "/readyz" PASS "200 ready"
else
  check "/readyz" FAIL "expected 200 'ready', got $status '$body' (boot may still be in progress or a critical phase failed)"
fi

# 3. /api/health/deep
deep=$(curl -fsS --max-time 10 "$BASE/api/health/deep" 2>/dev/null || echo "")
if [ -z "$deep" ]; then
  check "/api/health/deep" FAIL "no JSON response"
else
  # Extract fields with grep/sed — avoids jq dependency.
  field() { echo "$deep" | sed -n 's/.*"'"$1"'":[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p' | head -1; }
  app_env=$(field appEnv)
  auth_mode=$(field authMode)
  boot_ready=$(field bootReady)
  email_live=$(field emailLiveMode)
  schedulers=$(field schedulersEnabled)
  git_sha=$(field gitSha)

  [ -n "$app_env" ] && check "deep.appEnv present" PASS "$app_env" || check "deep.appEnv present" FAIL "missing"
  [ -n "$auth_mode" ] && check "deep.authMode present" PASS "$auth_mode" || check "deep.authMode present" FAIL "missing"
  [ "$boot_ready" = "true" ] && check "deep.bootReady" PASS "true" || check "deep.bootReady" FAIL "expected true, got '$boot_ready'"
  [ -n "$email_live" ] && check "deep.emailLiveMode present" PASS "$email_live" || check "deep.emailLiveMode present" FAIL "missing"
  [ -n "$schedulers" ] && check "deep.schedulersEnabled present" PASS "$schedulers" || check "deep.schedulersEnabled present" FAIL "missing"
  [ -n "$git_sha" ] && check "deep.gitSha present" PASS "$git_sha" || check "deep.gitSha present" FAIL "missing"

  if [ -n "$EXPECT_APP_ENV" ]; then
    [ "$app_env" = "$EXPECT_APP_ENV" ] \
      && check "deep.appEnv matches expected" PASS "$app_env" \
      || check "deep.appEnv matches expected" FAIL "expected '$EXPECT_APP_ENV', got '$app_env'"
  fi

  # Render-target hardening: if the caller declared this is prod or staging,
  # assert the runtime shape matches a real Render deploy (not a dev env
  # accidentally pointed at a Render URL, and not a partially-booted process).
  if [ "$EXPECT_APP_ENV" = "production" ] || [ "$EXPECT_APP_ENV" = "staging" ]; then
    case "$app_env" in
      production|staging)
        check "deep.appEnv is a Render env" PASS "$app_env"
        ;;
      *)
        check "deep.appEnv is a Render env" FAIL "expected production|staging, got '$app_env'"
        ;;
    esac

    [ "$boot_ready" = "true" ] \
      && check "deep.bootReady (Render)" PASS "true" \
      || check "deep.bootReady (Render)" FAIL "expected true on a Render deploy, got '$boot_ready'"

    case "$auth_mode" in
      ""|dev-bypass|bypass|dev|disabled|none)
        check "deep.authMode safe for Render" FAIL "unsafe value '$auth_mode' on a Render deploy (expected clerk)"
        ;;
      *)
        check "deep.authMode safe for Render" PASS "$auth_mode"
        ;;
    esac
  fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "OVERALL: PASS"
  exit 0
else
  echo "OVERALL: FAIL"
  exit 1
fi
