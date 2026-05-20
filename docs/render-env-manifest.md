# Render Env Manifest — Freight-DNA

Operator-facing source of truth for what MUST be set on every Render service
running Freight-DNA. Paired with `scripts/preflight-env.cjs` (runs at boot;
non-zero exit aborts the deploy) and `scripts/post-deploy-smoke.sh` (run
manually or in CI after a deploy).

If you change a value in the Render dashboard, update this file in the same PR.

---

## 1. Required env vars

✅ = required (preflight FAILs if missing)
⚙️ = recommended (no preflight enforcement yet)
❌ = forbidden (preflight FAILs if present)

| Var | Production | Staging | Notes |
|---|---|---|---|
| `APP_ENV` | ✅ `production` | ✅ `staging` | Must be EXPLICIT. Unset = email gate fail-closed AND Clerk picks the wrong key set. |
| `NODE_ENV` | ✅ `production` | ✅ `production` | Render usually injects automatically. |
| `DATABASE_URL` | ✅ `postgres://…` | ✅ `postgres://…` | Must point at the per-env Postgres. NEVER point staging at prod. |
| `SESSION_SECRET` | ✅ ≥16 random chars | ✅ ≥16 random chars | `server/auth.ts` silently falls back to `"dev-only-secret"` if missing. Preflight blocks this. |
| `CLERK_PUBLISHABLE_KEY_LIVE` *(or generic `CLERK_PUBLISHABLE_KEY` starting `pk_live_…`)* | ✅ | — | Prod uses live keys. |
| `CLERK_SECRET_KEY_LIVE` *(or generic `CLERK_SECRET_KEY` starting `sk_live_…`)* | ✅ | — | |
| `CLERK_PUBLISHABLE_KEY_TEST` *(or generic starting `pk_test_…`)* | — | ✅ | Staging uses test keys. |
| `CLERK_SECRET_KEY_TEST` *(or generic starting `sk_test_…`)* | — | ✅ | |
| `EMAIL_LIVE_MODE` | ✅ `on` | ✅ `off` | Must be EXPLICIT — preflight rejects blank/unset on Render. Staging must NEVER send live mail. |
| `SCHEDULERS_ENABLED` | ⚙️ `true` | ⚙️ `false` | Default `true` if unset. Staging running ~25 crons against prod-like data = duplicate work. |
| `APP_BASE_URL` / `APP_URL` | ⚙️ canonical service URL | ⚙️ canonical service URL | Used in email templates + OAuth callbacks. |
| `GIT_SHA` *(or `RENDER_GIT_COMMIT`)* | ⚙️ inject via Render build hook | ⚙️ inject | Surfaced by `/api/health/deep`; "unavailable" if absent. |

### Feature-gated (set only if the feature is in use)

| Var (group) | Notes |
|---|---|
| `OPENAI_API_KEY` / `AI_INTEGRATIONS_OPENAI_API_KEY` | Required for NBA / draft-email / summaries. |
| `ANTHROPIC_API_KEY` / `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | Required for Claude paths. |
| `RESEND_API_KEY` | Required in prod when `EMAIL_LIVE_MODE=on`. |
| `OUTLOOK_CLIENT_ID` + `OUTLOOK_CLIENT_SECRET` + `OUTLOOK_TENANT_ID` + `OUTLOOK_WEBHOOK_SECRET` + `OUTLOOK_FROM_EMAIL` + `OUTLOOK_REPLY_EMAIL` | All 6 together or none. |
| `WEBEX_CLIENT_ID` + `WEBEX_CLIENT_SECRET` + `WEBEX_REDIRECT_URI` + `WEBEX_ORG_ID` + `WEBEX_BOT_TOKEN` + `WEBEX_WEBHOOK_URL` | All 6 together or none. |
| `SONAR_USERNAME` + `SONAR_PASSWORD`, `FREIGHTWAVES_TOKEN` | FreightWaves market intel. |
| `FMCSA_WEBKEY` | Carrier safety lookups. |
| `ZOOMINFO_CLIENT_ID` + `ZOOMINFO_CLIENT_SECRET` | Contact enrichment. |
| `AZURE_DOC_INTEL_ENDPOINT` + `AZURE_DOC_INTEL_KEY` | RFP Excel parsing. |
| `PERPLEXITY_API_KEY` | Account research. |
| `SMTP_HOST` + `SMTP_PORT` + `SMTP_USER` + `SMTP_PASS` + `SMTP_FROM` + `SMTP_FROM_NAME` | SMTP fallback (alt to Resend). |

---

## 2. Forbidden on prod and staging

Preflight FAILs if any of these are set:

| Var | Why forbidden |
|---|---|
| `DEV_AUTH_BYPASS` | Disables Clerk auth entirely. Dev-only shortcut. |
| `DEV_AUTH_BYPASS_USER_ID` | Same. |

Strongly discouraged (not preflight-enforced yet, but should not be on Render):

| Var | Why |
|---|---|
| `REPL_IDENTITY`, `REPLIT_*`, `WEB_REPL_RENEWAL` | Replit-only. Harmless if present but indicates env was copy-pasted from a Repl. |

---

## 3. Recommended values

| Var | Production | Staging | Development |
|---|---|---|---|
| `APP_ENV` | `production` | `staging` | `development` |
| `NODE_ENV` | `production` | `production` | `development` |
| `EMAIL_LIVE_MODE` | `on` | `off` | unset (defaults to off via fail-closed gate) |
| `SCHEDULERS_ENABLED` | `true` | `false` | `false` (recommended) |

---

## 4. Before next prod deploy — checklist

Run through this every time the Render service-level env changes. Owner is
whoever holds the Render dashboard access (currently: ops).

- [ ] `APP_ENV=production` is set EXPLICITLY (not blank, not "Production" with capital P)
- [ ] `EMAIL_LIVE_MODE=on` is set EXPLICITLY
- [ ] `SESSION_SECRET` is ≥32 random chars and is NOT the same value as staging
- [ ] `DATABASE_URL` points at the prod Postgres (sanity-check the hostname)
- [ ] `CLERK_*` keys are LIVE (`pk_live_…` / `sk_live_…`), not test
- [ ] `DEV_AUTH_BYPASS*` are unset
- [ ] Render HTTP health check path is `/readyz` (NOT `/healthz`)
- [ ] `SCHEDULERS_ENABLED=true` on prod, `false` on staging
- [ ] This file (`docs/render-env-manifest.md`) reflects today's Render state

For staging, repeat with `APP_ENV=staging`, `EMAIL_LIVE_MODE=off`, test keys,
staging Postgres, and `SCHEDULERS_ENABLED=false`.

---

## 5. Post-deploy verification — checklist

Run after every Render deploy completes:

```bash
# 1. Liveness (the process is up at all)
curl -fsS https://<service>.onrender.com/healthz
#   → expects 200 body "ok"

# 2. Readiness (boot phases finished, migrations applied, routes mounted)
curl -fsS https://<service>.onrender.com/readyz
#   → expects 200 body "ready"
#   → 503 "starting" means boot stuck or a critical phase threw

# 3. Runtime shape (env + auth + email + scheduler + commit sha)
curl -fsS https://<service>.onrender.com/api/health/deep | jq
#   → expects appEnv=production|staging, bootReady=true, authMode=clerk,
#     emailLiveMode=true|false matching your intent, gitSha=<sha>

# 4. End-to-end smoke (all three above + assertions)
./scripts/post-deploy-smoke.sh https://<service>.onrender.com production
#   → exits 0 on PASS; non-zero blocks promote
```

The smoke script, when given a second arg of `production` or `staging`, also
asserts:
- `deep.appEnv` matches the expected value
- `deep.bootReady === true`
- `deep.authMode` is NOT `dev-bypass` (would mean `DEV_AUTH_BYPASS` slipped in)

---

## 6. How preflight is wired

`npm start` (the Render start command) runs:

```
node scripts/preflight-env.cjs && NODE_ENV=production node dist/index.cjs
```

`scripts/preflight-env.cjs` is plain Node CommonJS with zero npm deps so it
runs even after `npm install --omit=dev` strips devDependencies (which is
where `tsx` lives). On FAIL it exits 1 and Render's health check never sees a
listening port → the deploy is aborted before any partially-configured
process can accept traffic.

To run locally against your shell env:

```bash
APP_ENV=production node scripts/preflight-env.cjs
```
