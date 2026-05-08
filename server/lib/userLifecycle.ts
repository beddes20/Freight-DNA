/**
 * Task #1126 Phase 1 — pure user-lifecycle predicates.
 *
 * These helpers encode the single source of truth for "what does this
 * user row mean right now?" so that, when consumers are migrated in a
 * later step, every surface (auth, dropdowns, leaderboards, seats,
 * roster) reads from the same definitions.
 *
 * IMPORTANT: this module is INTENTIONALLY not imported by any
 * production code path yet. Wiring it into call sites is a separate
 * Phase 1 step (read-side filter migration). Behavior today is
 * unchanged. The unit tests live at
 * server/__tests__/userLifecycle.test.ts.
 *
 * Policy refinement (must stay aligned with the design doc):
 *   - Real employee leaving         → is_active=false (Deactivate)
 *   - Suspicious / undecided record → is_quarantined=true (Quarantine)
 *   - Shared inbox / automation     → is_service_account=true
 *   - Demo / seed / fixture         → is_demo / is_fixture = true
 *   - Clear junk / duplicate        → deleted_at set (Soft-delete)
 *
 * Soft-delete is reserved for junk/erroneous cases, NOT normal
 * offboarding. A real employee who leaves is `is_active=false` with
 * `deleted_at IS NULL`.
 */

/**
 * Minimal shape these helpers need. Accepting a structural type
 * (instead of importing `User` from @shared/schema) keeps the helpers
 * unit-testable without a DB and also lets Roster Health / future
 * services pass partial projections without widening their queries.
 */
export interface UserLifecycleFields {
  name?: string | null;
  isActive?: boolean | null;
  isServiceAccount?: boolean | null;
  isDemo?: boolean | null;
  isFixture?: boolean | null;
  isQuarantined?: boolean | null;
  deletedAt?: Date | string | null;
}

// ── Internal normalizers ────────────────────────────────────────────
// New columns default to `false` at the DB level, but callers may pass
// projections built from older queries that omit the field entirely.
// Treat `null`/`undefined` as the safe default (matches DB DEFAULT).

function bool(v: boolean | null | undefined, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function isTombstoned(user: UserLifecycleFields): boolean {
  return user.deletedAt != null;
}

// ── Predicates ──────────────────────────────────────────────────────

/**
 * Can this row start an interactive UI session?
 *
 * Blocks: soft-deleted, deactivated, OR service accounts. Service
 * accounts can be the principal for ingestion / outbound, but they
 * are not a person and never get a browser session.
 */
export function canInteractivelyLogIn(user: UserLifecycleFields): boolean {
  if (isTombstoned(user)) return false;
  if (!bool(user.isActive, true)) return false;
  if (bool(user.isServiceAccount, false)) return false;
  return true;
}

/**
 * Should this row appear in assignee dropdowns (companies, contacts,
 * tasks, opportunities, lanes)?
 *
 * Excludes: soft-deleted, deactivated, service, quarantined, demo,
 * fixture. The "demo" exclusion is intentionally unconditional here
 * — callers operating *inside* a demo org should opt back in via
 * their own org-aware helper rather than relaxing this predicate.
 */
export function isVisibleAssignee(user: UserLifecycleFields): boolean {
  if (isTombstoned(user)) return false;
  if (!bool(user.isActive, true)) return false;
  if (bool(user.isServiceAccount, false)) return false;
  if (bool(user.isQuarantined, false)) return false;
  if (bool(user.isDemo, false)) return false;
  if (bool(user.isFixture, false)) return false;
  return true;
}

/**
 * Does this row consume a paid seat (Stripe headcount)?
 *
 * Mirrors `isVisibleAssignee` minus the quarantine gate: a
 * quarantined real employee is still occupying a seat until an admin
 * decides what they are. Demo / fixture / service never count.
 */
export function isCountedForSeat(user: UserLifecycleFields): boolean {
  if (isTombstoned(user)) return false;
  if (!bool(user.isActive, true)) return false;
  if (bool(user.isServiceAccount, false)) return false;
  if (bool(user.isDemo, false)) return false;
  if (bool(user.isFixture, false)) return false;
  return true;
}

/**
 * Should this row appear in the default `GET /api/users` roster
 * (the one teammates see when picking owners, building org charts,
 * etc.)?
 *
 * Same gate as `isVisibleAssignee`. Kept as its own function so the
 * future opt-in flags on `GET /api/users` (?includeInactive,
 * ?includeServiceAccounts, ?includeDeleted, ?includeQuarantined,
 * ?includeDemo) can each invert exactly one branch without callers
 * reaching into predicate internals.
 */
export function isVisibleInDefaultRoster(user: UserLifecycleFields): boolean {
  return isVisibleAssignee(user);
}

/**
 * Render-side helper — appends a state suffix to the user's display
 * name so historical references in notes / touchpoints / activity
 * feeds never silently look like a live employee.
 *
 * Order of precedence (most informative wins):
 *   deleted > inactive > quarantined > service > demo/fixture > none
 */
export function formatUserAttribution(user: UserLifecycleFields): string {
  const base = (user.name ?? "").trim() || "Unknown user";
  if (isTombstoned(user)) return `${base} (deleted)`;
  if (!bool(user.isActive, true)) return `${base} (inactive)`;
  if (bool(user.isQuarantined, false)) return `${base} (quarantined)`;
  if (bool(user.isServiceAccount, false)) return `${base} (service)`;
  if (bool(user.isDemo, false)) return `${base} (demo)`;
  if (bool(user.isFixture, false)) return `${base} (fixture)`;
  return base;
}
