# Conversations sync — architecture, repros, root causes, runbook

Task #973 hardens the live-sync + mailbox-watchdog pair so the recurring trio
of admin pages — *Live-sync stream rejecting connections*, *Mailbox sync
unhealthy: no Inbox/SentItems webhook in X h*, and *Live-sync silent despite
recent mailbox activity* — stop firing on transient blips and only page
humans when there is real action to take.

This doc is the single place to look when one of those alerts shows up.

---

## 1. End-to-end architecture

```
   Microsoft Graph                 ┌──────────── Express API ────────────┐
   ┌────────────────┐  webhook    │                                     │
   │  Inbox /       │ ──────────▶ │  POST /api/graph-webhook            │
   │  SentItems     │             │   ├─ ingestEmailMessage             │
   │  subscriptions │  delta      │   └─ publish(orgId, mailbox_*)──┐  │
   └────────────────┘  poll       │                                  │  │
            ▲                     │  syncMailboxDelta (cron, 1m)     │  │
            │ renew/resub         │   └─ publish(orgId, mailbox_*)──┤  │
            │                     │                                  │  │
   ┌────────┴────────┐            │  conversationReplyCaptureService │  │
   │ graphSubscription│            │   └─ publish(orgId, mailbox_*)──┤  │
   │ Service          │            │                                  ▼  │
   └─────────────────┘            │  liveSync.ts (in-process EventEmitter)│
                                  │   ├─ subscribe(orgId, listener)     │
                                  │   └─ recordLiveSyncAuthOutcome      │
                                  │                                     │
                                  │  GET /api/live-sync/stream (SSE)    │
                                  │   ├─ resolveOrgId (Clerk ?token=)   │
                                  │   ├─ register active connection     │
                                  │   └─ flush events to browser        │
                                  └──────────────┬──────────────────────┘
                                                 │ text/event-stream
                                                 ▼
                                  ┌──────────────────────────────────────┐
                                  │  Browser tab                          │
                                  │   useLiveSync (App.tsx, single mount)│
                                  │    ├─ exp-backoff + jitter reconnect │
                                  │    ├─ tabId (sessionStorage)         │
                                  │    └─ status store ⇒ <LiveSyncPill/> │
                                  │                                       │
                                  │   queryClient.invalidateQueries(...)  │
                                  └──────────────────────────────────────┘
```

Key invariants:
- **In-process only.** `liveSync.ts` uses a Node `EventEmitter`. No Redis,
  no queue. If we ever scale horizontally we swap the emitter for a
  pub/sub backend without changing the `publish()` / `subscribe()` API.
- **Best-effort.** `publish()` never throws and never blocks an ingest
  write path. A dropped event is acceptable; the client also refetches
  on focus and on a 30-120s background interval.
- **Org-scoped fan-out.** Subscribers only see their own org's traffic;
  the route never trusts a query-string `orgId` — it always derives the
  org from the authenticated session or the verified Clerk JWT.
- **Clerk JWT in `?token=` (Task #958).** `EventSource` cannot set
  custom headers, so the SSE route accepts a Clerk session token in the
  URL. Preserved end-to-end by Task #973 — every reconnect mints a
  fresh token.

## 2. The three alerts and what they actually mean

| Alert key                       | Meaning                                                                                | Severity tag         | Action                                                                           |
|--------------------------------|----------------------------------------------------------------------------------------|----------------------|----------------------------------------------------------------------------------|
| `live_sync_auth_failure`       | SSE endpoint rejecting ≥90% of connections in last 60s, ≥10 attempts, 2 ticks running. | **action-required**  | Clerk JWT validation broken. Check `LIVE_SYNC_AUTH_DEBUG=1` log. See §5.1.       |
| `live_sync_silent_stream`      | Mailbox just ingested but `mailbox_inbound/_outbound` publish() is stale (>5min behind).| **action-required**  | A write path dropped its `publish()`. Check graphWebhook + delta-sync diff.       |
| `mailbox_unhealthy` (webhook silence) | Inbox webhook silent for >baseline factor × pollCadenceSeconds, watchdog already retried backfill. | **action-required**   | Subscription stale; admin should re-register. See §5.2.                          |
| `mailbox_unhealthy` (renewal)  | Watchdog tried to renew/resubscribe and Graph rejected it.                              | **action-required**  | Permissions/auth issue with Graph app. Check `lastSubscriptionRenewalError`.     |
| `subscription_renewal_failed`  | A renewal flopped but the existing subscription still covers us for the headroom window.| **auto-recovering**  | No action; the periodic renewer will retry. Monitor for re-fire after cool-down.  |

Quiet-hours suppression: when the watchdog observes a webhook-silence
condition during the per-org quiet window (default 22:00–06:00 UTC; the
window is configurable per env), the alert is downgraded to
`auto-recovering` severity and admin notifications are skipped — reps
aren't actively sending mail, so a quiet inbox is the expected state.
The condition is still recorded in `mailbox_health_alerts` so the
overnight gap is visible in the morning.

## 3. Reproducing each failure mode locally

All three repros assume a dev process with `npm run dev` and a Clerk
secret configured. Run them one at a time so the watchdog tick (1 min)
clearly attributes which test fired the alert.

### 3.1 `live_sync_auth_failure` — rejected connections

```bash
# 1. Trigger 12 unauthenticated SSE connects in <60s (no ?token=).
for i in $(seq 1 12); do
  curl -sS -o /dev/null -w "%{http_code}\n" \
    "http://localhost:5000/api/live-sync/stream"
  sleep 1
done

# 2. Wait two watchdog ticks (~2m). The alert fires on tick 2.
# 3. Verify in mailbox_health_alerts:
psql "$DATABASE_URL" -c \
  "select alert_key, severity, reason from mailbox_health_alerts \
   where alert_key='live_sync_auth_failure' and resolved_at is null;"
```

Expected: one open alert per org with at least one enabled mailbox; the
reason text quotes the failure ratio and connection count.

### 3.2 `live_sync_silent_stream` — ingest but no publish

The simulator uses a vitest spy because the publish call is awaited
inside the same module the test imports.

```bash
npx vitest run server/__tests__/liveSyncE2EScenarios.test.ts \
  -t "silent_stream"
```

The test inserts an `email_messages` row directly via storage, advances
`lastInboxNotificationAt`, then runs two watchdog ticks without any
`publish()` calls. The second tick fires `live_sync_silent_stream`.

### 3.3 Mailbox `webhook silence` → backfill → unhealthy

```bash
# 1. In a dev shell, freeze a mailbox's lastInboxNotificationAt to >2h ago.
psql "$DATABASE_URL" -c \
  "update monitored_mailboxes \
   set last_inbox_notification_at = now() - interval '3 hours' \
   where email = '<dev mailbox>';"

# 2. Watchdog tick #1: classifies degraded, runs delta backfill.
# 3. Watchdog tick #2: still silent → classifies unhealthy, fires alert.
```

The delta backfill on tick #1 *must* call `syncMailboxDelta(mb.id)` and
re-classify before the unhealthy escalation. The watchdog logs
`backfill-before-escalate` when it does.

## 4. Root causes we have already shipped fixes for

| Date       | Symptom                                          | Root cause                                                                   | Fix                                                                                                                                |
|------------|--------------------------------------------------|------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------|
| Task #951  | `live_sync_auth_failure` flapping under low load | Clerk back-fill missed users with NULL `clerk_user_id` until next provision  | `resolveClerkUserToDbUser` adds email-based fallback (Task #958)                                                                  |
| Task #951  | Watchdog screams when one bad client loops 401s  | Auth ring was global per process — one tab poisons the org metric            | Task #973: per-user-fingerprint auth bucketing; org metric is the *median across users*, not the sum                              |
| Task #874  | "Conversations not updating" after every deploy  | Delta-sync forgot `publish()` after refactor                                 | `liveSync.ts` exports `publish()` as the single funnel; watchdog `silent_stream` alarm fires on regressions                       |
| Task #973  | Reconnect storm during prod blips (every 2s)     | Fixed 2 s reconnect, no jitter — tabs reconnected in lockstep                | Exp-backoff (1 s → 30 s cap) with ±25% jitter; per-user connection cap; same-tab dedup via `tabId`                                |
| Task #973  | Repeated overnight pages for "no Inbox webhook"  | Silence threshold was a flat 30/90 min regardless of mailbox cadence/quiet hr | Per-mailbox baseline factor × `pollCadenceSeconds`; quiet-hour downgrade to `auto-recovering`                                     |
| Task #973  | Same alert flap-firing every minute              | No cool-down between resolve and re-fire                                     | Per-(mailbox, alertKey) cool-down (10 min) + flap counter; ≥3 flap cycles/hr forces a single sticky `flap_dampened` alert       |

## 5. Runbook

### 5.1 `live_sync_auth_failure` is firing

1. Open `/admin/integrations-health` and find the **Live-sync** tile.
   The tile shows: active connections, rejected-by-reason histogram,
   top-failing user fingerprints (last 60s).
2. If a single user fingerprint dominates (>70% of failures), it's a
   client-side issue (an old tab with an expired token, a misbehaving
   browser extension). The per-user rate limiter will already have
   capped them; ignore unless they spread.
3. If failures are spread across users, check the Clerk dashboard for
   issuer/audience drift. The dev console log line
   `[live-sync/auth] verifyToken failed (kind): …` classifies the cause
   without dumping the token.
4. Set `LIVE_SYNC_AUTH_DEBUG=1` and restart to capture per-connect
   structured logs (`{outcome, branch, kind, clerkId fingerprint}`).
5. Alert auto-resolves the first watchdog tick where failure ratio is
   below 90% AND the cool-down (10 min) has elapsed.

### 5.2 `mailbox_unhealthy` for webhook silence

1. Open the mailbox row in `/admin/integrations-health` →
   **Monitored mailboxes**. Confirm `lastInboxNotificationAt` is more
   than `pollCadenceSeconds × baselineFactor` (default 6×) old.
2. Click **Re-register** to force a `renewSingleMailboxSubscription`
   and a `runWatchdogOnce` cycle. The watchdog re-classifies on the
   spot; if the mailbox returns to `healthy` the open alert resolves.
3. If re-register fails, inspect `lastSubscriptionRenewalError`. The
   most common cause is an Azure AD app-permission drift — check the
   Graph subscriptions API directly with a test admin token.

### 5.3 `live_sync_silent_stream` is firing

This alert is the one we *want* to be loud about — it almost always
means a recent code change dropped a `publish()` call from a write
path. The fix is in code, not in the live env.

1. `git log --since="48 hours" -- server/services/conversationReplyCaptureService.ts \
   server/services/mailboxDeltaSyncService.ts \
   server/routes/graphWebhook.ts` — look for diffs that removed a
   `publish()` call, renamed a topic, or moved the `if (created)` gate.
2. The three required publish sites are pinned by
   `server/__tests__/mailboxDeltaSyncLiveSync.test.ts` and the new
   `server/__tests__/liveSyncE2EScenarios.test.ts`. If a CI run lets
   the regression through, those tests need an extra assertion.
3. Resolve the alert manually after the fix ships; the watchdog
   resolves it automatically on the next tick where ingest+publish are
   in sync.

## 6. Metrics surfaced on `/admin/integrations-health`

The Live-sync tile (added in Task #973, served by
`GET /api/admin/live-sync-metrics`, polled every 30 s) renders:
- **Active conns** — count of currently-open SSE streams in this
  process. One per tab. A sudden drop to 0 with no deploy in flight
  usually indicates an upstream proxy (CDN/ALB) tearing down keep-alive.
- **My org** — active connections scoped to the viewer's org, so the
  admin can tell whether the count they see represents their own
  tabs or a global problem.
- **Connects (60 s window)** — accepted (`success`) vs rejected
  (`failure`) totals.
- **User-median fail %** — per-user-fingerprint median failure ratio
  in the same window, with `n=usersObserved` so admins can see when
  the gate-of-2 is or isn't met. This is the signal the watchdog
  fires on (not the global ratio).
- **Rejections by reason** — badge cloud of classifier labels
  (`expired` / `bad-signature` / `bad-issuer` / `no-token-or-secret` /
  `no-db-user` / `no-org-id` / `rate-limited` / `rate-limited-preauth`
  / `other`). Hidden when no rejections have been recorded.
- **Top failing user fingerprints** — sorted descending by failure
  count. Each fingerprint is the first 8 + last 4 chars of the Clerk
  user id; we never log the full id. Hidden when none.

## 7. Related docs / files

- `server/services/liveSync.ts` — pub/sub + auth ring + metrics snapshot
- `server/routes/liveSync.ts` — SSE endpoint (Clerk JWT in `?token=`)
- `client/src/hooks/useLiveSync.ts` — singleton EventSource, exp-backoff
- `client/src/lib/liveSyncBackoff.ts` — pure backoff math (testable)
- `server/services/mailboxWatchdogService.ts` — health classification + alerts
- `server/__tests__/liveSyncE2EScenarios.test.ts` — three required scenarios
- `server/__tests__/mailboxWatchdogCooldown.test.ts` — flap dampening
- `server/__tests__/liveSyncBackoff.test.ts` — backoff/jitter math
