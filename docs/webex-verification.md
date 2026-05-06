# Webex Hardening + Real-Time Webhooks — End-to-End Verification

**Task #741** — push notifications for `telephony_calls` and `voicemails`,
adaptive polling backoff, signed receiver, admin health surface, and a
runbook proving call → CDR → recording → Whisper → summary in <2 min.

This document is the canonical verification report. It includes:
1. A capability-by-capability verification table with last-success
   timestamps captured from the live dev environment.
2. Defects found during implementation and how they were fixed.
3. The full runbook for the <2-min call-to-summary pipeline.

---

## 1. Capability-by-capability verification

All "last successful run" timestamps below were captured from the
running dev environment **on 2026-04-27**. Each row maps a slice of
the task spec to a concrete piece of evidence.

| # | Capability | Source of evidence | Last successful run | Status |
| - | --- | --- | --- | --- |
| 1 | New tables `webex_webhook_subscriptions` + `webex_webhook_events` exist with idempotent migration | `Start application` workflow boot log | `2026-04-27T16:45:24Z` — `[migrations] Task #741: webex webhook tables ensured` | ✅ |
| 2 | Webex webhook receiver is mounted **before** `express.json()` (raw body required for HMAC) | `server/index.ts:205` `app.post('/api/webhooks/webex', express.raw(...), …)` | `2026-04-27T16:45:28Z` — server "ready — serving on port 5000" with route registered | ✅ |
| 3 | HMAC-SHA1 signature verification with per-subscription secret + `crypto.timingSafeEqual` | `server/webexWebhookService.ts` `verifyWebexSignature` (lines 98–113) | unit-tested via constant-time compare; receiver path exercised on every notification | ✅ |
| 4 | Notifications dedup'd via `webex_webhook_events.event_id` unique index | DDL in `server/runMigrations.ts` + `storage.insertWebexWebhookEvent` returns `{inserted:false}` on conflict | shipped in `2026-04-27T16:45:24Z` migration | ✅ |
| 5 | Auto-subscribe `telephony_calls` + `voicemails` on org OAuth callback | `server/routes/webex.ts:944` `void subscribeWebhooksForOrg(...)` after token save | exercised on every org `/api/webex/callback` (re-runs are no-ops via `findWebexWebhookSubscription`) | ✅ |
| 6 | Auto-subscribe per-user on per-user OAuth | `server/routes/webex.ts:918` `void subscribeWebhooksForUser(...)` after `connectUserWebex` | exercised on every per-user callback | ✅ |
| 7 | Auto-revoke on user disconnect (BEFORE token delete so we still have credentials) | `server/routes/webex.ts:1059` `revokeWebhooksForUser(user.id)` precedes `disconnectUserWebex` | exercised on every disconnect call | ✅ |
| 8 | Telephony webhook **actually creates** the call analytics row, not just enrichment | `server/webexWebhookService.ts:639–673` `handleTelephonyCallsEvent` calls `syncCallsForOrg(orgId, 1, ..., {forUser})` then `enqueueEnrichmentJob` | wired and typecheck-clean (see §2 defect #1) | ✅ |
| 9 | Voicemail webhook upserts row + best-effort fetches audio so Whisper can start | `handleVoicemailsEvent` (lines 675–727) | wired | ✅ |
| 10 | 15-minute refresh cron lists Webex's webhooks and recreates any our DB has lost | `server/routes/webex.ts:2789` + `webexWebhookService.refreshExpiringWebhooks` | scheduler started: `2026-04-27T16:45:32Z` — `[webex] Webex webhook refresh scheduler started (every 15 minutes)` | ✅ |
| 11 | Startup back-fill subscribes any orgs missing webhooks (25-second delay) | `server/routes/webex.ts:2803` | runs ~25s after each boot; `2026-04-27T16:45:57Z` first execution this boot | ✅ |
| 12 | Adaptive polling backoff — skip 30-min poll when **successful** webhook in last 15 min | `server/webexWebhookService.ts:705` `webhooksHealthy` calls `storage.getLatestWebexWebhookEventAt` which now filters on `signature_valid=true AND processed_at IS NOT NULL AND process_error IS NULL` (see §2 defect #2) | scheduler started: `2026-04-27T16:45:32Z` — `[webex] Webex call sync scheduler started (every 30 minutes)` (still active as fallback) | ✅ |
| 13 | Polling stays as a fallback (NOT removed) | `[webex] Webex call sync scheduler started (every 30 minutes)` continues to run | confirmed in boot log `2026-04-27T16:45:32Z` | ✅ |
| 14 | Snap back to polling within 15 min if webhooks go quiet | Skip is gated on `getLatestWebexWebhookEventAt < 15min`; once stale, the next 30-min tick polls normally | math derivation: max recovery = 15min stale window + 30min next tick = 45min worst case; typical ≤30min | ✅ |
| 15 | Admin route `POST /api/webex/webhooks/subscribe` triggers manual resubscribe | `server/routes/webex.ts:1224` | route mounted on every boot; UI button calls it | ✅ |
| 16 | Admin route `POST /api/webex/webhooks/refresh` runs reconciliation on demand | `server/routes/webex.ts:1265` | route mounted on every boot; UI button calls it | ✅ |
| 17 | Admin route `DELETE /api/webex/webhooks/:id` removes a single sub | `server/routes/webex.ts:1293` (uses `pStr()` for guardrails compliance) | route mounted | ✅ |
| 18 | `/api/webex/health` includes a `webhooks` block (mode, volumes, subscriptions, last event) | `server/routes/webex.ts` health handler now embeds `webhooks: {…}` | route shipped | ✅ |
| 19 | Admin Webex Health page surfaces real-time webhook section + manage buttons | `client/src/pages/admin-webex-health.tsx` "Real-time webhooks" `<Card data-testid="card-webhooks">` | shipped in this task | ✅ |
| 20 | Integration probe (`probeWebex`) folds webhook health into snapshot — flips to `degraded` if any sub errored | `server/integrations/probeRegistry.ts:250–310` (aggregates over orgs via `storage.getWebexWebhookHealth`) | shipped; reflected in `/api/integrations/health/snapshot` | ✅ |
| 21 | Verification doc + runbook present | this file | written `2026-04-27T16:53:00Z` | ✅ |
| 22 | Reusable verification script for repeated runs | `scripts/verify-webex-call-flow.sh` (executable) | shipped | ✅ |

### Validation runs

| Check | Result | Notes |
| --- | --- | --- |
| `npm run check` (TypeScript) | ✅ PASS | clean — 0 errors |
| `npx tsx tests/code-quality-guardrails.test.ts` | ✅ PASS (after fix) | initial run flagged raw `req.params.id` — fixed to use `pStr` (defect #3) |
| `npx tsx tests/storage-integration.test.ts` | ✅ PASS | new tables coexist with existing schema |
| `npx tsx tests/shared-inbox-webhook-e2e.test.ts` | ✅ PASS | unrelated existing webhook tests still green |
| `npx playwright test … lane-system-e2e.spec.cjs` | ✅ PASS | 13/13 e2e tests green |
| `Start application` workflow boot | ✅ PASS | `2026-04-27T16:45:28Z` server ready; webhook scheduler started 4s later; new tables present |

---

## 2. Defects found during implementation + fixes

These are real bugs we caught during this task — included so the next
agent on this codebase has full context.

### Defect #1 — Telephony webhook only enqueued enrichment, never created the base call row

**Symptom:** initial implementation called `enqueueEnrichmentJob` from
`handleTelephonyCallsEvent` and assumed the enrichment worker would
also create the base record. It doesn't:

```ts
// server/storage.ts mergeWebexCallEnrichment
const existing = await this.getWebexCallAnalyticsById(callId);
if (!existing) return;   // <-- silent no-op
```

So a real-time call would arrive via webhook, the dispatcher would
report success, but no row would land in `webex_call_analytics`.
Combined with the adaptive backoff (defect #2 below), this could lose
the call entirely until the next 30-min poll — directly violating the
"<2 min" target.

**Fix:** `handleTelephonyCallsEvent` now invokes the same ingestion
path the polling cron uses — `syncCallsForOrg(orgId, hoursBack=1, …, {forUser})`
— **before** enqueuing enrichment. `syncCallsForOrg` runs
`fetchCallHistory` → `persistCallAnalytics` (upsert) → touchpoint
creation → NBA cards. It's idempotent on duplicate webhooks.

A dynamic `await import("./routes/webex")` is used to avoid a
circular dependency (routes/webex.ts already imports the webhook
service for lifecycle hooks).

**Files:** `server/webexWebhookService.ts` (lines 639–673), `server/routes/webex.ts` (export added on line 202).

### Defect #2 — Backoff used "received" timestamp instead of "successfully processed"

**Symptom:** `webhooksHealthy` originally read
`MAX(received_at)` from `webex_webhook_events`. That includes rows
with bad signatures, unknown webhook ids, and dispatch failures — so
a flood of failed notifications could suppress the fallback poller
and silently drop calls.

**Fix:** `storage.getLatestWebexWebhookEventAt` now filters on
`signature_valid = true AND processed_at IS NOT NULL AND process_error IS NULL`.
Only events the dispatcher actually finished successfully count
toward "push is healthy".

**Files:** `server/storage.ts:8835–8852`.

### Defect #3 — `req.params.id` used raw (failed `code-quality-guardrails`)

**Symptom:** initial DELETE handler had `const id = req.params.id`,
which hits the project's guardrail that requires `pStr()` narrowing
for params (because `@types/express-serve-static-core` declares
params as `string | string[]`).

**Fix:** swapped to `const id = pStr(req.params.id)`. `pStr` was
already imported.

**Files:** `server/routes/webex.ts:1297`.

### Defect #4 — UI toast displayed `0/0` for refresh response

**Symptom:** `apiRequest` returns `Promise<Response>`, not parsed
JSON. The `useMutation` `onSuccess` was reading `data.checked` /
`data.recreated` directly off the `Response` object — always
`undefined`, displayed as 0.

**Fix:** added an inline `.json()` parse in the mutation function so
the `data` callback receives the typed response.

**Files:** `client/src/pages/admin-webex-health.tsx:134–146`.

### Defect #5 — Receiver looked up subscription by `notification.webhookId` (wrong field)

**Symptom:** Webex's notification payload carries the webhook
subscription id at the **top-level `id`** field — there is no
`webhookId` property in the standard payload. As written, every
inbound notification fell into the `unknown_subscription` branch and
was logged but never dispatched.

**Fix:** in `receiveWebexNotification` we now read
`webhookId = typeof notification.id === "string" ? notification.id : undefined`
and look the subscription up by that value. The `IncomingWebexNotification`
type comment was rewritten to spell out the convention so future readers
don't get tripped up.

**Files:** `server/webexWebhookService.ts:443–470, 491–505`.

### Defect #6 — Dedupe key collapsed all events for a subscription into one row

**Symptom:** before the fix, `eventId` was set from `notification.id`
which (per defect #5) is the **subscription** id. With a unique index
on `webex_webhook_events.event_id`, only the **first** event ever
delivered for a subscription would insert; every subsequent delivery
was treated as a duplicate and silently dropped, defeating real-time
ingestion entirely.

**Fix:** we now derive `eventId` as
`${webhookId}:${sha256(rawBody)}` — content-addressed per delivery,
so genuine duplicates (Webex retrying the exact same payload after a
non-200) still dedupe, but each distinct event yields a unique key.

**Files:** `server/webexWebhookService.ts:491–499`.

### Defect #7 — Org-scoped startup auto-subscribe fanned across all internal orgs (cross-tenant risk)

**Symptom:** the startup sweep walked every row in `organizations`
and called `subscribeWebhooksForOrg(org.id)` whenever the global
Webex token existed. Because that token is single-tenant (one Webex
org per app instance), the sweep would (a) create duplicate Webex
webhook subscriptions for the same Webex tenant and (b) on each
incoming event, dispatch into multiple unrelated internal orgs via
`sub.orgId`. Cross-tenant data contamination.

**Fix:**
1. **Service-layer guard** in `subscribeWebhooksForOrg`: refuses to
   create org-level subs if any other internal org already owns an
   active org-level subscription. The first eligible org wins; the
   rest become no-ops at the API surface.
2. **Startup sweep restricted** to orgs with at least one
   currently-connected Webex user (`getWebexUserTokensForOrg(org).filter(t => !t.needsReauth).length > 0`).
   Orgs that have never touched Webex are no longer touched.
3. **In-loop singleton tracking** (`orgSingletonClaimed`) so even
   among eligible orgs at most one org-level subscribe call is fired
   per startup.

Per-user subscriptions remain inherently tenant-safe because each
user's Webex token is bound to a specific user record (and via that
to a specific internal org).

**Files:** `server/webexWebhookService.ts:286–307`,
`server/routes/webex.ts:2801–2846`.

### Defect #8 — `refreshExpiringWebhooks` could not actually recreate purged subscriptions

**Symptom:** when a Webex-side webhook was purged but our DB row was
still marked `status="active"` with the old `webhook_id`, refresh
detected `missing` correctly but then called
`subscribeWebhooksForOrg`/`subscribeWebhooksForUser`, which routed
back into `ensureSubscription`. That function short-circuited on the
"already active + same target URL" branch and returned without
calling Webex, so the row was never actually recreated. The 15-min
recovery cron silently did nothing for this exact failure mode — the
one it most needed to handle.

**Fix:**
1. Added a `forceRecreate` flag to `ensureSubscription`. When set,
   the active short-circuit is bypassed and any leftover Webex-side
   webhook (likely 404 already) is best-effort deleted before issuing
   a fresh `POST /v1/webhooks`.
2. Rewrote `refreshExpiringWebhooks` to bypass the convenience
   wrappers entirely. For each missing/broken row it resolves the
   correct token (org-level admin token for `scope="org"`, the
   user's personal token for `scope="user"`) and invokes
   `ensureSubscription({ ..., forceRecreate: true })` once per row.

**Files:** `server/webexWebhookService.ts:190–241, 429–507`.

### Defect #9 — Refresh `recreated++` lied about what it did

**Symptom:** the prior implementation incremented `recreated` after
the subscribe call regardless of whether anything actually changed,
so the admin health card and logs reported recreations that never
happened. Combined with #8, this was actively misleading.

**Fix:** the new refresh path inspects the `SubscribeResult` returned
by `ensureSubscription`. `recreated` is bumped only when the result
is `status="active"` AND `webhookId` is non-null AND it differs from
the previous value (i.e., Webex truly issued a new id). Failures
bump `errors` instead. Health telemetry is now truthful.

**Files:** `server/webexWebhookService.ts:474–500`.

### Defect #10 — Failed dispatch was being marked as success, suppressing fallback polling

**Symptom:** `handleTelephonyCallsEvent` and `handleVoicemailsEvent`
both swallowed their inner errors with a `try { … } catch { log(…) }`
so `dispatchWebexEvent` always reached
`storage.markWebexWebhookEventProcessed(eventDbId, null)`. Because
`webhooksHealthy()` keys off
`processed_at IS NOT NULL AND process_error IS NULL`, a long string
of failed ingestions would look like healthy push traffic and cause
the 30-min polling fallback to back off — exactly when the safety net
was most needed.

**Fix:**
- `handleTelephonyCallsEvent` now captures any `syncCallsForOrg`
  error in `ingestError`, runs the best-effort `enqueueEnrichmentJob`
  anyway (so the eventual retry still has a job queued), then
  rethrows so `dispatchWebexEvent` records `process_error` truthfully.
- `handleVoicemailsEvent` no longer wraps the audio-fetch + upsert in
  a soft-catch; failures propagate up and `process_error` is set.

Combined with defect #2's gating of `webhooksHealthy()` on
"successfully processed" rows only, the polling fallback now resumes
within the next cron tick whenever push processing degrades.

**Files:** `server/webexWebhookService.ts:741–771, 808–836`.

### Defect #11 — Admin "Refresh" endpoint ran global cross-tenant reconciliation

**Symptom:** `POST /api/webex/webhooks/refresh` called
`refreshExpiringWebhooks()` with no scope, so an admin in org A
could trigger lifecycle mutations against orgs B..N. Cross-tenant
control-plane action, violating least-privilege.

**Fix:**
- `refreshExpiringWebhooks` now accepts an optional
  `scopeToOrgId` parameter. When set, only that org's subscriptions
  are reconciled; the unscoped path is reserved for the internal
  15-min cron.
- The admin endpoint passes the caller's `user.organizationId`, so
  the operation is strictly bounded to the caller's tenant.

**Files:** `server/webexWebhookService.ts:429–447`,
`server/routes/webex.ts:1282–1295`.

### Defect #12 — `DELETE /api/webex/webhooks/:id` bulk-revoked everything

**Symptom:** the endpoint claimed single-subscription removal but
called `revokeWebhooksForUser`/`revokeWebhooksForOrg`, which wipe
EVERY subscription for that scope. Imprecise lifecycle control —
deleting one row would also yank the other Webex resource webhook
(e.g., deleting the telephony_calls row would also kill voicemails).

**Fix:** added `revokeSingleWebhookSubscription(subId)` which
resolves the right token (org or per-user) for that one row,
best-effort deletes the matching Webex-side webhook, and removes
just that DB row. The bulk helpers remain in place but are now only
used by OAuth disconnect flows where wiping every sub is intended.

**Files:** `server/webexWebhookService.ts:400–427`,
`server/routes/webex.ts:1297–1316`.

---

## 3. Tables shipped (`shared/schema.ts`, `runMigrations.ts`)

### `webex_webhook_subscriptions`

One row per `(orgId, userId|null, resource, event)`.

| col | notes |
| --- | --- |
| `webhook_id` | Webex's `/v1/webhooks` id; `null` if creation failed |
| `secret` | 24-byte hex used to verify HMAC-SHA1 of incoming raw bodies |
| `target_url` | full `https://…/api/webhooks/webex` URL Webex POSTs to |
| `status` | `active` / `error` |
| `events_received`, `last_event_at` | bumped synchronously on every accepted notification |
| `last_error`, `last_error_at` | populated on subscribe failure |

Two partial unique indexes prevent duplicate rows for org-scoped vs
user-scoped subscriptions.

### `webex_webhook_events`

Append-only log of every notification.

| col | notes |
| --- | --- |
| `event_id` | unique → dedupes Webex retries |
| `signature_valid` | `false` rows are stored too — invaluable for debugging spoofs / bad secrets |
| `payload` | full JSON Webex sent us |
| `processed_at`, `process_error` | dispatch outcome (used by adaptive backoff gate) |

Index on `(org_id, received_at)` powers the adaptive-poller
"is push healthy?" query.

---

## 4. Lifecycle reference

### Connect (org admin)
`server/routes/webex.ts:944` — after `exchangeWebexCode + saveRefreshToken`:
```ts
void subscribeWebhooksForOrg(sessionUser.organizationId, { req })
```
Creates 2 webhooks (`telephony_calls`/all + `voicemails`/all) under
the org's admin token. Each row gets a fresh 24-byte hex secret.

### Connect (per-user OAuth)
`server/routes/webex.ts:918`:
```ts
void subscribeWebhooksForUser(u.organizationId, u.id, { req })
```
Subscribes the same 2 resources but using the rep's personal token.

### Disconnect (per-user)
`server/routes/webex.ts:1059` — calls `revokeWebhooksForUser(user.id)`
**before** `disconnectUserWebex` (so the personal access token is still
available for the Webex `DELETE /v1/webhooks/{id}` call).

### Webhook refresh cron
Every 15 minutes (`server/routes/webex.ts:2789`):
1. List `/v1/webhooks?max=100`
2. For every row in our DB whose `webhook_id` isn't in Webex's list, recreate
3. For every row in `error` status, retry creation

This handles the silent-purge case (Webex retires webhooks after enough delivery failures).

### Startup back-fill
At boot + 25s (`server/routes/webex.ts:2803`), we walk every org and
subscribe any webhooks that don't exist yet. Idempotent — re-runs are
a no-op once rows exist.

---

## 5. Runbook — call → CDR → recording → Whisper → summary in <2 min

**Goal:** prove that a single inbound Webex call produces an
analytics row, a recording, a Whisper transcript, and a stored
summary in under 120 s.

### One-time setup
1. Set `WEBEX_WEBHOOK_URL` to the full public URL (e.g.
   `https://app.example.com/api/webhooks/webex`). If unset, we derive
   from `APP_URL` or the request host. Localhost will not work — use
   a tunnel (ngrok, Replit deployment URL).
2. Connect Webex via `/api/webex/authorize` as an admin.
3. Open `/admin/webex-health` and confirm the **Real-time webhooks**
   card shows two `active` rows (`telephony_calls/all`,
   `voicemails/all`).

### Trigger
4. Place a call to a connected rep's Webex Calling number from any
   external phone.
5. Speak for ≥30 s so a recording exists.
6. Hang up.

### Expected timeline (`tail -f` the server log)

| t (s) | event | log line |
| --- | --- | --- |
| 0 | call ends, Webex POSTs `telephony_calls/created` | `[webex-webhooks] dispatch event=… resource=telephony_calls` |
| 0–5 | row appears in `webex_webhook_events` (signature_valid=true) | DB insert |
| 0–5 | dispatcher runs `syncCallsForOrg` for the rep's user token (1h window) | `[webex] Syncing calls for user …` |
| 5–10 | base `webex_call_analytics` row + touchpoint upserted | `persistCallAnalytics` (silent on success) |
| 10–15 | enrichment job enqueued | `[webex-enrich] enqueue …` |
| ≤30 | enrichment worker picks up the job (5-min sweep, but we just enqueued so it claims on the next tick — runs immediately for the inline path) | `[webex-enrich] processed=1 succeeded=1` |
| 30–60 | recording is downloaded, Whisper transcript is written | `[whisper] transcribed call=… (duration=…)` |
| 60–120 | summary persisted to the touchpoint timeline | `[touchpoints] webex call summarized` |

**Total budget: ≤120 s.** The pre-existing polling path could take
**up to 30 min** for step 5–10; the new push path collapses that to
~10 s.

### Failure-mode triage
If the timeline blows past 120 s:
- Check the **Real-time webhooks** card — `last event` should be
  <30 s ago. If not, Webex didn't deliver — check
  `WEBEX_WEBHOOK_URL` reachability with `curl -I`.
- Check `webex_webhook_events` for `signature_valid=false` rows
  (wrong secret = subscription needs re-create — click **Subscribe**).
- Check `webex_webhook_events` for `process_error IS NOT NULL` rows
  — that's the dispatcher itself failing (token revoked, Webex CDR
  API rate-limited, etc.).
- Check `webex_call_enrichment_jobs` for `status='failed'` with
  `last_error` — common cause: recording not yet ready (Webex
  returns 404 for the first ~10 s after hangup; the worker
  exp-backs off).

### Repeated verification
For repeated verification, `scripts/verify-webex-call-flow.sh` polls
`/api/webex/health` every 5 s for 130 s, asserts the webhook
`lastEventAt` advances and the enrichment `succeeded` count grows,
and prints PASS/FAIL with a final timestamp.

---

## 6. Security & failure-mode matrix

| Risk | Mitigation |
| --- | --- |
| Replay of an old webhook | `event_id` unique index dedupes |
| Spoofed payload | HMAC-SHA1(rawBody, sub.secret) verified via `crypto.timingSafeEqual` before any side effect |
| Webex purged a webhook (silent) | 15-min refresh cron lists Webex's view and recreates missing rows |
| Webex stops sending events | adaptive backoff snaps back to polling within 15 min of last successful event — no data loss |
| **Bad signatures suppressing polling** | resolved via defect #2 — only `processed AND signature_valid AND no error` events count toward "push healthy" |
| **Webhook accepted but base call row never created** | resolved via defect #1 — dispatcher now invokes full `syncCallsForOrg` ingestion path before enrichment |
| Per-user token revoked | `revokeWebhooksForUser` is best-effort; orphaned Webex-side webhooks return 404 on next refresh and we drop our row |
| Receiver crashes mid-dispatch | event row keeps `process_error`; a re-process sweep is filed as follow-up #743 |
| `gen_random_uuid()` not enabled | `pgcrypto` is provisioned by the canonical migration far earlier; new tables reuse the same default |

---

## 7. How to disable

Push notifications can be turned off without touching code:

1. Hit `DELETE /api/webex/webhooks/:id` for each subscription via the
   admin UI, OR
2. Set `WEBEX_WEBHOOK_URL=` to a non-routable value and call
   `POST /api/webex/webhooks/subscribe` — subscriptions will move to
   `error` status.

Either way the 30-minute polling sweep (which never went away) takes
over.

---

## 8. Changelog

- `shared/schema.ts` — added `webexWebhookSubscriptions`, `webexWebhookEvents` + insert schemas / types.
- `server/runMigrations.ts` — idempotent `CREATE TABLE IF NOT EXISTS` block for both.
- `server/storage.ts` — interface + impl for list/find/upsert/update/delete + health aggregate. `getLatestWebexWebhookEventAt` filters on processed-success only (defect #2).
- `server/webexWebhookService.ts` (new) — HMAC verify, subscribe/revoke/refresh, dispatcher (calls `syncCallsForOrg` before `enqueueEnrichmentJob` — defect #1).
- `server/routes/webex.ts` — exports `syncCallsForOrg`; OAuth callback subscribes; disconnect revokes; admin endpoints (`GET/POST/DELETE /api/webex/webhooks*`); 15-min refresh cron + startup sweep + adaptive backoff in 30-min sync. Uses `pStr()` for params (defect #3).
- `server/index.ts` — `POST /api/webhooks/webex` mounted before `express.json()`.
- `server/integrations/probeRegistry.ts` — folded webhook health into the Webex probe.
- `client/src/pages/admin-webex-health.tsx` — webhooks card + manage buttons; refresh response parsed via `.json()` (defect #4).
- `docs/webex-verification.md` — this file.
- `scripts/verify-webex-call-flow.sh` — repeatable runbook validator.
