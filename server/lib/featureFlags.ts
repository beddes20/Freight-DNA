/**
 * Feature flag helpers — env-driven runtime kill switches.
 *
 * Task #1094 — `CONTACT_JOBS_ENABLED` kill switch for FreightDNA's
 * inbound contact / company / suggestion auto-create writers.
 *
 * Semantics
 * ─────────
 * `contactJobsEnabled()` returns `false` ONLY when the env value is the
 * literal string "false" (case-insensitive, surrounding whitespace
 * trimmed). Every other value — unset, "", "0", "no", "FALSE2", etc. —
 * resolves to `true`. This deliberately fails open: if an operator typos
 * the env value while trying to disable jobs, the worst case is that
 * jobs keep running (the safe default), not that we silently turn them
 * off in production.
 *
 * What this gates (callers)
 * ─────────────────────────
 *   • `server/accountContactCaptureService.ts`
 *       - `detectAndSuggest`              → writes `account_contact_suggestions`
 *       - `detectUnlinkedDomainSuggestions` → writes `account_contact_suggestions`
 *   • `server/services/signatureContactSweep.ts`
 *       - `sweepSignatureContactForInbound` → writes `contacts` (create + enrich)
 *         and falls back to `detectAndSuggest` (already gated above).
 *
 * The single inbound-email company auto-create branch (`processUserMailboxEmail`
 * in `server/routes/graphWebhook.ts`) does NOT auto-create a company today —
 * unknown senders fall into the PERSIST-UNKNOWN branch which preserves the
 * email row with `linkedAccountId=null`. The kill switch keeps that contract
 * intact: when disabled, downstream contact / suggestion writers stop, and
 * the inbound email is still preserved. PERSIST-UNKNOWN is unaffected.
 *
 * What is intentionally NOT gated
 * ───────────────────────────────
 *   • `POST /api/companies/:companyId/contacts`     (user-driven CRUD)
 *   • `POST /api/companies/:companyId/contacts/bulk-import` (user-driven CRUD)
 *   • `PATCH /api/contacts/:id`                     (user edits)
 *   • `DELETE /api/contacts/:id`                    (soft-delete)
 *   • `POST /api/companies`                          (user-driven CRUD)
 * A rep manually creating a contact or company through the UI is exactly
 * the recovery path operators need while jobs are paused, so these stay
 * UNGATED on purpose.
 *
 * HTTP auto-create paths
 * ──────────────────────
 * Any future HTTP endpoint that triggers a non-user-driven contact /
 * company / suggestion create MUST call `contactJobsEnabled()` and, when
 * disabled, respond with:
 *
 *   { skipped: true, reason: "contact_jobs_disabled" }
 *
 * so callers can distinguish "we paused" from a genuine error.
 *
 * Boot logging
 * ────────────
 * `server/index.ts` emits `[boot] CONTACT_JOBS_ENABLED=<true|false>` once
 * during startup so the value an operator set is visible in the same log
 * stream where the kill switch's effects (the structured warn lines below)
 * will appear.
 *
 * Structured warn log shape (emitted by callers when the flag is OFF)
 * ───────────────────────────────────────────────────────────────────
 *   [contact-jobs] disabled — skipping <writer> (<context>)
 *
 * Guardrails: `tests/code-quality-guardrails.test.ts` Section 1094 lists
 * every gated file by path and asserts each one imports + calls
 * `contactJobsEnabled` from this module. Adding a new contact / company /
 * suggestion writer means adding the import + call AND extending the
 * guardrail list — there is no other safe way to introduce a new writer.
 */

const FLAG_NAME = "CONTACT_JOBS_ENABLED";

function readFlag(): boolean {
  const raw = process.env[FLAG_NAME];
  if (raw == null) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "false") return false;
  return true;
}

/**
 * Returns true when contact / company / suggestion auto-create jobs are
 * permitted to run. False ONLY when the env value is the literal string
 * "false" (trimmed, case-insensitive). Default is true (fail open).
 *
 * Read at every call site — do NOT cache. Operators can flip the env and
 * restart a single worker without redeploying every consumer; reading
 * fresh keeps the behaviour predictable.
 */
export function contactJobsEnabled(): boolean {
  return readFlag();
}

/**
 * Operator-friendly description of the current flag state for boot logs
 * and `/api/health`-style debug endpoints. Returns the literal "true" or
 * "false" matching what `contactJobsEnabled()` will return for the same
 * call.
 */
export function describeContactJobsFlag(): "true" | "false" {
  return contactJobsEnabled() ? "true" : "false";
}
