/**
 * Available Freight Cockpit (Task #900) — owner filter + actionable scope.
 *
 * Pure-unit coverage that exercises:
 *   - shouldHideForPickup under the new 'actionable' scope
 *   - isRowOwnedByUser routing for "me" / "unassigned" / specific-userId
 *   - The OWNER_FILTER_ALIASES and isOwnerFilterValue route guards
 *   - The route schema accepts ownerFilter + pickupScope (incl. nulls)
 *   - The built-in views serialise the new envelope
 *   - The actionable hidden-by-pickup SQL predicate is wired into the route
 *   - The route exposes kpis.hiddenStale
 *
 * No DB or Express harness: we either drive the shared helpers directly
 * or grep the route source for the wiring we depend on. That keeps the
 * suite fast and free of the giant cockpit fixture stack.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  shouldHideForPickup,
  computePickupFreshness,
  daysSincePickup,
  ACTIONABLE_OPEN_STATUSES,
  SOFT_OVERDUE_HOURS,
  DEFAULT_PICKUP_SCOPE,
  isActionableOpenStatus,
} from "@shared/pickupFreshness";
import {
  isRowOwnedByUser,
  resolveUserIdentity,
  buildRowOwnership,
} from "@shared/cockpitOwnership";

const TODAY = "2026-05-01";
const YESTERDAY = "2026-04-30";
const TWO_DAYS_AGO = "2026-04-29";
const TOMORROW = "2026-05-02";

function freshness(pickup: string | null) {
  return computePickupFreshness(pickup, TODAY);
}
function days(pickup: string | null) {
  return daysSincePickup(pickup, TODAY);
}

describe("Task #900 — pickup scope 'actionable' is the new default", () => {
  it("DEFAULT_PICKUP_SCOPE is 'actionable'", () => {
    expect(DEFAULT_PICKUP_SCOPE).toBe("actionable");
  });

  it("SOFT_OVERDUE_HOURS = 24", () => {
    expect(SOFT_OVERDUE_HOURS).toBe(24);
  });

  it("ACTIONABLE_OPEN_STATUSES contains the five still-open statuses", () => {
    for (const s of [
      "pending_approval",
      "ready_to_send",
      "sent",
      "awaiting_carrier_reply",
      "partially_covered",
    ]) {
      expect(isActionableOpenStatus(s)).toBe(true);
    }
    for (const s of ["covered", "expired", "cancelled", "lost", "no_bid"]) {
      expect(isActionableOpenStatus(s)).toBe(false);
    }
  });
});

describe("Task #900 — shouldHideForPickup under 'actionable'", () => {
  it("shows future pickups", () => {
    expect(
      shouldHideForPickup(freshness(TOMORROW), "actionable", {
        status: "ready_to_send",
        daysSincePickup: days(TOMORROW),
      }),
    ).toBe(false);
  });

  it("shows today pickups", () => {
    expect(
      shouldHideForPickup(freshness(TODAY), "actionable", {
        status: "ready_to_send",
        daysSincePickup: days(TODAY),
      }),
    ).toBe(false);
  });

  it("shows no-pickup rows", () => {
    expect(
      shouldHideForPickup(freshness(null), "actionable", {
        status: "ready_to_send",
        daysSincePickup: null,
      }),
    ).toBe(false);
  });

  it("shows yesterday + still-open status (within 24h soft window)", () => {
    expect(
      shouldHideForPickup(freshness(YESTERDAY), "actionable", {
        status: "ready_to_send",
        daysSincePickup: days(YESTERDAY),
      }),
    ).toBe(false);
  });

  it("hides yesterday + closed status", () => {
    expect(
      shouldHideForPickup(freshness(YESTERDAY), "actionable", {
        status: "covered",
        daysSincePickup: days(YESTERDAY),
      }),
    ).toBe(true);
  });

  it("hides 2-day-old past pickup even with still-open status", () => {
    expect(
      shouldHideForPickup(freshness(TWO_DAYS_AGO), "actionable", {
        status: "sent",
        daysSincePickup: days(TWO_DAYS_AGO),
      }),
    ).toBe(true);
  });

  it("legacy 'recent' scope keeps showing 2-day-old past pickup", () => {
    expect(
      shouldHideForPickup(freshness(TWO_DAYS_AGO), "recent"),
    ).toBe(false);
  });

  it("legacy 'upcoming' scope hides today's past_recent if any (none here, just sanity)", () => {
    // 'upcoming' hides past_recent + past_stale unconditionally.
    expect(shouldHideForPickup(freshness(YESTERDAY), "upcoming")).toBe(true);
    expect(shouldHideForPickup(freshness(TOMORROW), "upcoming")).toBe(false);
  });

  it("'all' never hides on pickup date", () => {
    expect(shouldHideForPickup(freshness(TWO_DAYS_AGO), "all")).toBe(false);
  });
});

describe("Task #900 — server ownership filter routing via isRowOwnedByUser", () => {
  // Build an ownership envelope the way the cockpit row would.
  function ownershipFor(ownerUserId: string | null) {
    return buildRowOwnership(
      {
        ownerUserId,
        delegatedToUserId: null,
        createdById: null,
        approvedById: null,
      },
      // resolveUsername lookup — return an email that mirrors the
      // route's behavior so emails-set is non-empty for owned rows.
      (uid) => (uid === "u-me" ? "me@example.com" : null),
    );
  }
  const meIdentity = resolveUserIdentity({
    id: "u-me",
    email: "me@example.com",
    username: "me@example.com",
  });

  it("'me' matches the current user's owned row", () => {
    expect(isRowOwnedByUser(ownershipFor("u-me"), meIdentity, "u-me")).toBe(true);
  });

  it("'me' rejects another user's row", () => {
    expect(isRowOwnedByUser(ownershipFor("u-other"), meIdentity, "u-other")).toBe(false);
  });

  it("'unassigned' is identified by an empty ids set on the envelope", () => {
    const env = ownershipFor(null);
    expect(env.ids.length).toBe(0);
  });

  it("specific-userId synthesised identity matches that user's row", () => {
    const target = { id: "u-other", emailLower: null, usernameLower: null };
    expect(isRowOwnedByUser(ownershipFor("u-other"), target, "u-other")).toBe(true);
    expect(isRowOwnedByUser(ownershipFor("u-me"), target, "u-me")).toBe(false);
  });
});

describe("Task #900 — route source wiring", () => {
  // Grep-style assertions over the route source to lock the contract:
  // these are the same style the existing `guardrails` checks use, and
  // they catch accidental removal during refactors.
  const routeSrc = readFileSync(
    "server/routes/freightOpportunityCockpit.ts",
    "utf8",
  );

  it("exposes the OWNER_FILTER_ALIASES guard", () => {
    expect(routeSrc).toMatch(/OWNER_FILTER_ALIASES\s*=\s*\["all",\s*"me",\s*"unassigned"\]/);
  });

  it("parses ?ownerFilter= from the request and degrades safely to 'all'", () => {
    expect(routeSrc).toMatch(/ownerFilter:\s*ownerFilterRaw/);
    expect(routeSrc).toMatch(/isOwnerFilterValue\(ownerFilterRaw\)\s*\?\s*ownerFilterRaw\s*:\s*"all"/);
  });

  it("passes status + daysSincePickup into shouldHideForPickup", () => {
    expect(routeSrc).toMatch(
      /shouldHideForPickup\(freshness,\s*pickupScope,\s*\{\s*status:\s*r\.status,\s*daysSincePickup:\s*daysSincePickup/,
    );
  });

  it("emits hidden_by_actionable in the SQL aggregate and surfaces it on kpis.hiddenStale", () => {
    expect(routeSrc).toMatch(/hidden_by_actionable/);
    // The route initializes `kpis.hiddenStale` to 0 in the static object
    // and patches it after the SQL aggregate runs. Either form satisfies
    // the contract — the response shape is the same.
    expect(routeSrc).toMatch(/kpis\.hiddenStale\s*=\s*hiddenStaleByActionable/);
  });

  it("echoes ownerFilter back on the response payload", () => {
    // Task #972 — the response now echoes `effectiveOwnerFilter` instead
    // of the raw client value, because impersonation can clamp "all" /
    // other-user tokens down to "me". The contract is unchanged for the
    // client (still `ownerFilter: <string>` on the payload), but the
    // server-side variable name is different.
    expect(routeSrc).toMatch(/ownerFilter:\s*effectiveOwnerFilter/);
  });

  it("widens the prefs PATCH schema with ownerFilter + pickupScope", () => {
    expect(routeSrc).toMatch(/ownerFilter:\s*z\s*\n?\s*\.string\(\)/);
    expect(routeSrc).toMatch(/pickupScope:\s*z\s*\n?\s*\.string\(\)/);
  });

  it("upserts ownerFilter + pickupScope on cockpit-prefs PATCH", () => {
    expect(routeSrc).toMatch(/ownerFilter:\s*parsed\.data\.ownerFilter/);
    expect(routeSrc).toMatch(/pickupScope:\s*parsed\.data\.pickupScope/);
  });

  it("My freight today built-in view carries ownerFilter='me' + pickupScope='actionable'", () => {
    // Match across the multi-line filters object. The block includes a
    // long task-citation comment, so the window has to be generous.
    const myFreightBlock = routeSrc.match(
      /id:\s*"builtin:my-freight-today"[\s\S]{0,1600}/,
    )?.[0] ?? "";
    expect(myFreightBlock).toMatch(/ownerFilter:\s*"me"/);
    expect(myFreightBlock).toMatch(/pickupScope:\s*"actionable"/);
  });

  it("Team needs approval built-in view carries pickupScope='actionable'", () => {
    const teamBlock = routeSrc.match(
      /id:\s*"builtin:team-needs-approval"[\s\S]{0,1600}/,
    )?.[0] ?? "";
    expect(teamBlock).toMatch(/pickupScope:\s*"actionable"/);
  });
});

describe("Task #900 — schema + storage round-trip wiring", () => {
  it("schema declares owner_filter + pickup_scope on user_freight_cockpit_prefs", () => {
    const schemaSrc = readFileSync("shared/schema.ts", "utf8");
    const block = schemaSrc.match(
      /userFreightCockpitPrefs[\s\S]*?\)\;/,
    )?.[0] ?? "";
    expect(block).toMatch(/owner_filter|ownerFilter/);
    expect(block).toMatch(/pickup_scope|pickupScope/);
  });

  it("storage upsert round-trips ownerFilter + pickupScope", () => {
    const storageSrc = readFileSync("server/storage.ts", "utf8");
    // Anchor on the *implementation* of upsertUserFreightCockpitPrefs (not
    // the IStorage interface declaration above) and stop at the first
    // closing brace of the method body so we don't bleed into adjacent
    // upserts (e.g. upsertUserLaneInboxPrefs).
    const fn = storageSrc.match(
      /async upsertUserFreightCockpitPrefs\([\s\S]*?\.returning\(\);[\s\S]*?\n  \}/,
    )?.[0] ?? "";
    expect(fn).toMatch(/ownerFilter:\s*data\.ownerFilter\s*\?\?\s*null/);
    expect(fn).toMatch(/pickupScope:\s*data\.pickupScope\s*\?\?\s*null/);
  });

  it("migration adds owner_filter + pickup_scope as IF NOT EXISTS", () => {
    const migSrc = readFileSync("server/runMigrations.ts", "utf8");
    expect(migSrc).toMatch(
      /ADD COLUMN IF NOT EXISTS owner_filter text/,
    );
    expect(migSrc).toMatch(
      /ADD COLUMN IF NOT EXISTS pickup_scope text/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Task #972 — Available Freight cockpit base scope under impersonation
//
// Source-grep tests that lock in the route wiring for "view as":
//   1. The route imports + calls `getImpersonationContext`.
//   2. A base owner scope filter is applied BEFORE the client owner
//      filter, derived from the impersonated user id.
//   3. The client owner filter is clamped to "me" when impersonating.
//   4. The response echoes an `impersonation` envelope and a `byBaseScope`
//      hidden-counts entry, and exposes a `?debug=cockpit` payload.
//   5. The `getImpersonationContext` helper itself returns the documented
//      shape for both Clerk and dev-session impersonation.
// ─────────────────────────────────────────────────────────────────────

describe("Task #972 — Available Freight cockpit base scope under impersonation", () => {
  const routeSrc = readFileSync(
    "server/routes/freightOpportunityCockpit.ts",
    "utf8",
  );
  const authSrc = readFileSync("server/auth.ts", "utf8");

  it("route imports getImpersonationContext from server/auth", () => {
    expect(routeSrc).toMatch(
      /import\s*\{[^}]*getImpersonationContext[^}]*\}\s*from\s*"\.\.\/auth"/,
    );
  });

  it("route resolves impersonation once at the top of the cockpit handler", () => {
    expect(routeSrc).toMatch(
      /const\s+impersonation\s*=\s*getImpersonationContext\(req\)/,
    );
  });

  it("route derives baseScopeUserIds from the impersonated user id", () => {
    expect(routeSrc).toMatch(
      /baseScopeUserIds[\s\S]{0,160}impersonation\.isImpersonating[\s\S]{0,80}impersonation\.impersonatedUserId/,
    );
  });

  it("route applies the base scope BEFORE the client owner filter", () => {
    const baseIdx = routeSrc.search(/const\s+baseScope\s*=/);
    const ownerIdx = routeSrc.search(/itemsBeforeOwner\s*=/);
    expect(baseIdx).toBeGreaterThan(0);
    expect(ownerIdx).toBeGreaterThan(0);
    expect(baseIdx).toBeLessThan(ownerIdx);
  });

  it("route tracks hiddenByBaseScope for KPI attribution", () => {
    expect(routeSrc).toMatch(/hiddenByBaseScope/);
  });

  it("route clamps the client ownerFilter to 'me' when it widens past the impersonated rep", () => {
    expect(routeSrc).toMatch(
      /widensPastImpersonated[\s\S]{0,400}effectiveOwnerFilter\s*=\s*"me"/,
    );
  });

  it("route widening guard rejects 'all', includeUnassigned, and other userIds", () => {
    const guardBlock = routeSrc.match(
      /widensPastImpersonated\s*=\s*[\s\S]{0,500}/,
    )?.[0] ?? "";
    expect(guardBlock).toMatch(/requestedScope\.isAll/);
    expect(guardBlock).toMatch(/requestedScope\.includeUnassigned/);
    expect(guardBlock).toMatch(
      /Array\.from\(requestedScope\.userIds\)\.some/,
    );
  });

  it("response echoes a stable impersonation envelope (always present)", () => {
    expect(routeSrc).toMatch(
      /impersonation:\s*\{\s*isImpersonating:\s*impersonation\.isImpersonating,\s*impersonatedUserId:\s*impersonation\.impersonatedUserId/,
    );
  });

  it("response hiddenCounts payload exposes byBaseScope", () => {
    expect(routeSrc).toMatch(/byBaseScope/);
  });

  it("?debug=cockpit gates the diagnostics payload", () => {
    // The route reads the debug flag off the query string and only
    // attaches the diagnostics block when it's truthy.
    expect(routeSrc).toMatch(/debug.*===\s*"cockpit"|cockpitDebug/);
    expect(routeSrc).toMatch(
      /isImpersonating:\s*impersonation\.isImpersonating[\s\S]{0,400}impersonatedUserId:\s*impersonation\.impersonatedUserId[\s\S]{0,400}adminId:\s*impersonation\.adminId/,
    );
  });

  it("getImpersonationContext returns the documented shape for Clerk-mode impersonation", () => {
    // The helper's body checks the in-process impersonationMap keyed by
    // the admin's Clerk user id; when present, the response shape is
    // { isImpersonating: true, impersonatedUserId: <target>, adminId: <clerkId> }.
    expect(authSrc).toMatch(
      /const\s+target\s*=\s*impersonationMap\.get\(clerkUserId\)/,
    );
    expect(authSrc).toMatch(
      /isImpersonating:\s*true,\s*impersonatedUserId:\s*target,\s*adminId:\s*clerkUserId/,
    );
  });

  it("getImpersonationContext returns the documented shape for dev-session impersonation", () => {
    // Dev path: req.session.impersonatingAdminId carries the admin DB id
    // while req.session.userId points at the impersonated rep.
    expect(authSrc).toMatch(
      /req\.session\?\.impersonatingAdminId/,
    );
    expect(authSrc).toMatch(
      /isImpersonating:\s*true,\s*impersonatedUserId:\s*req\.session\.userId,\s*adminId:\s*adminDbId/,
    );
  });

  it("getImpersonationContext returns the no-impersonation default at the bottom", () => {
    expect(authSrc).toMatch(
      /isImpersonating:\s*false,\s*impersonatedUserId:\s*null,\s*adminId:\s*null/,
    );
  });

  it("/api/auth/me uses the same getImpersonationContext helper as the cockpit route", () => {
    // Single source of truth: the client `currentUser.isImpersonating`
    // flag and the server cockpit base scope must derive from the same
    // primitive, otherwise the client could think it isn't impersonating
    // while the server is still scoping rows down.
    expect(authSrc).toMatch(
      /\/api\/auth\/me[\s\S]{0,2000}getImpersonationContext\(req\)/,
    );
  });
});
