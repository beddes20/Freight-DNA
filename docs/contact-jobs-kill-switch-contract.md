# CONTACT_JOBS_ENABLED Kill Switch (Task #1094)

Env-driven pause for inbound `contacts` / auto-created `companies` / `account_contact_suggestions` writers.

## Default
**`true` (enabled).** Disabled ONLY when the env value is the literal string `false` (trimmed, case-insensitive).

## Gated callers
- `server/accountContactCaptureService.ts`
- `server/services/signatureContactSweep.ts`

When disabled, these early-return and emit a `[contact-jobs] disabled — skipping <writer>` warn line. PERSIST-UNKNOWN still preserves the source email.

## Always-ungated (recovery paths)
User-driven CRUD stays **ungated** so reps retain a recovery path:
- `POST /api/companies/:companyId/contacts`
- `PATCH /api/contacts/:id`
- `POST /api/companies`

## Plumbing
- Helper: `server/lib/featureFlags.ts`
- Boot log: `[boot] CONTACT_JOBS_ENABLED=<true|false>`

## Adding new writers
New writers MUST add the gate AND extend `tests/code-quality-guardrails.test.ts` Section 1094.
