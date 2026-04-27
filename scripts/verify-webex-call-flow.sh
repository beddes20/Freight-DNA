#!/usr/bin/env bash
#
# Task #741 — verify the call → CDR → recording → Whisper → summary pipeline
# completes in <120 s after a real Webex call hits a connected rep.
#
# Usage:
#   APP_URL=https://your.app SESSION_COOKIE='connect.sid=…' \
#     bash scripts/verify-webex-call-flow.sh
#
# What it does:
#   1. Snapshots /api/webex/health (initial event count + last event)
#   2. Polls every 5s for 130s, watching:
#        - webhooks.lastEventAt advances (push works)
#        - enrichment job count succeeds + grows
#   3. Prints a green/red final assessment.
#
# Exit codes:
#   0 = all checks passed within 120s
#   1 = no webhook event received
#   2 = webhook ok but enrichment job didn't succeed
#   3 = HTTP / config error
set -euo pipefail

APP_URL="${APP_URL:-http://localhost:5000}"
COOKIE="${SESSION_COOKIE:-}"
TIMEOUT_S="${TIMEOUT_S:-120}"

if [[ -z "$COOKIE" ]]; then
  echo "ERROR: SESSION_COOKIE env required (admin session). Get it from your browser devtools." >&2
  exit 3
fi

curl_health() {
  curl -sS --max-time 5 -H "cookie: $COOKIE" "$APP_URL/api/webex/health"
}

initial="$(curl_health || true)"
if [[ -z "$initial" ]] || ! echo "$initial" | grep -q '"webhooks"'; then
  echo "ERROR: /api/webex/health did not return webhook block. Check admin auth + that webhook subs exist." >&2
  exit 3
fi

initial_last_event=$(echo "$initial" | grep -oE '"lastEventAt":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
initial_succeeded=$(echo "$initial" | grep -oE '"succeeded":[0-9]+' | head -1 | cut -d: -f2 || echo "0")

echo "=== Webex call-flow verification ==="
echo "App URL:           $APP_URL"
echo "Initial last event: ${initial_last_event:-<none>}"
echo "Initial succeeded:  ${initial_succeeded:-0}"
echo ""
echo "Place an inbound Webex call to a connected rep NOW. Speak ≥30s, then hang up."
echo "Watching for ${TIMEOUT_S}s…"
echo ""

webhook_ok=0
enrichment_ok=0
elapsed=0
while (( elapsed < TIMEOUT_S )); do
  sleep 5
  elapsed=$((elapsed + 5))
  snap="$(curl_health || true)"
  [[ -z "$snap" ]] && continue

  cur_last_event=$(echo "$snap" | grep -oE '"lastEventAt":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
  cur_succeeded=$(echo "$snap" | grep -oE '"succeeded":[0-9]+' | head -1 | cut -d: -f2 || echo "0")

  if [[ "$webhook_ok" -eq 0 && -n "$cur_last_event" && "$cur_last_event" != "$initial_last_event" ]]; then
    echo "[+${elapsed}s] ✓ Webhook event received (lastEventAt=$cur_last_event)"
    webhook_ok=1
  fi
  if [[ "$enrichment_ok" -eq 0 && "${cur_succeeded:-0}" -gt "${initial_succeeded:-0}" ]]; then
    echo "[+${elapsed}s] ✓ Enrichment job succeeded (succeeded count: $initial_succeeded → $cur_succeeded)"
    enrichment_ok=1
  fi
  if (( webhook_ok == 1 && enrichment_ok == 1 )); then
    echo ""
    echo "✅ PASS — full pipeline completed in ${elapsed}s (target <${TIMEOUT_S}s)"
    exit 0
  fi
done

echo ""
echo "❌ FAIL — timeout after ${TIMEOUT_S}s"
[[ $webhook_ok -eq 0 ]] && { echo "  - No webhook event received. Check WEBEX_WEBHOOK_URL reachability + subscription status."; exit 1; }
[[ $enrichment_ok -eq 0 ]] && { echo "  - Webhook arrived but enrichment job didn't succeed. Check /admin/webex-health → recent failures."; exit 2; }
exit 1
