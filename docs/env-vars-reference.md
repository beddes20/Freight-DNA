# Environment Variables Reference

Authoritative list of FreightDNA environment variables and their semantics. Render-specific deploy values live in `docs/render-env-manifest.md`.

## Core
| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. |
| `OPENAI_API_KEY` | OpenAI API access for AI features. |
| `MICROSOFT_GRAPH_CLIENT_ID` | Microsoft Graph (Outlook) OAuth client id. |
| `MICROSOFT_GRAPH_CLIENT_SECRET` | Microsoft Graph (Outlook) OAuth client secret. |
| `RESEND_API_KEY` | Resend provider key for outbound email (when EMAIL_LIVE_MODE is on). |
| `SESSION_SECRET` | Cookie session secret. Must be ≥16 chars in any deployed env. See `docs/render-env-manifest.md` + in-code fail-closed at `server/auth.ts` / `server/routes/webex.ts`. |

## Environment shape
| Var | Purpose |
|---|---|
| `APP_ENV` | `production` \| `staging` \| `development`. Must be set explicitly on every deployed service. |
| `NODE_ENV` | Standard Node env. `production` on Render. |
| `EMAIL_LIVE_MODE` | Must be the literal string `true` to allow live mail. Composed with `APP_ENV==='production'` by `server/emailGate.ts`. |
| `SCHEDULERS_ENABLED` | `false` disables schedulers (string-equals check). |

## Feature kill switches & throttles
| Var | Purpose |
|---|---|
| `CONTACT_JOBS_ENABLED` | Task #1094 kill switch — default `true`; set to literal `false` to halt inbound contact / suggestion auto-create writers. See `docs/contact-jobs-kill-switch-contract.md`. |
| `QUOTE_EMAIL_BACKFILL_THROTTLE_MS` | Task #1146 — per-org throttle on the request-path `ensureEmailBackfill` re-arm window in milliseconds; default `30000`. Only consulted by the request-path auto-backfill — the admin `POST /api/customer-quotes/email-backfill` route bypasses the throttle. |

## Forbidden on deployed environments
- `DEV_AUTH_BYPASS`
- `DEV_AUTH_BYPASS_USER_ID`

Enforced by `scripts/preflight-env.cjs`.
