/**
 * Task #742 — AI Hub role-gating contract test.
 *
 * Composition-only deterministic test that protects two invariants of
 * the AI Hub sidebar gate without spinning up a browser:
 *
 *   1. AI_HUB_ANY_TAB_ROLES (the union of every tab's role list) must
 *      NOT include roles that aren't allowed in any AI surface — these
 *      users should not see the AI sidebar row at all.
 *   2. The sidebar must actually gate the AI row by AI_HUB_ANY_TAB_ROLES.
 *      A regression that drops this check would silently expose the row
 *      to unprivileged users.
 *
 * This complements the Playwright spec (which covers the privileged
 * happy path) by providing fast, deterministic coverage of the
 * unprivileged path that's hard to set up in a browser fixture.
 *
 * The assertions parse source files directly rather than importing the
 * React module, so the test runs cleanly under tsx with no Vite/JSX
 * runtime overhead.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

console.log("══════════════════════════════════════════════════════════════");
console.log("  AI Hub Role Gating — Contract Tests (Task #742)");
console.log("══════════════════════════════════════════════════════════════");

const hubPath = resolve(process.cwd(), "client/src/pages/ai-hub.tsx");
const hubSrc = readFileSync(hubPath, "utf8");
const sidebarPath = resolve(
  process.cwd(),
  "client/src/components/app-sidebar.tsx",
);
const sidebarSrc = readFileSync(sidebarPath, "utf8");

// Extract every roles: [...] array literal from AI_HUB_TABS in order.
// We parse the source so we don't depend on the React build pipeline.
function extractTabRoleLists(src: string): string[][] {
  const result: string[][] = [];
  const re = /roles:\s*\[([^\]]*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const raw = match[1];
    const items = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^["']|["']$/g, ""));
    result.push(items);
  }
  return result;
}

const tabRoleLists = extractTabRoleLists(hubSrc);
check(
  `AI_HUB_TABS declares 7 tabs (found ${tabRoleLists.length})`,
  tabRoleLists.length === 7,
);

const anyTabRoles = Array.from(new Set(tabRoleLists.flat())).sort();

// ── 1. Roles that should NEVER see the AI row ────────────────────────
//
// These are roles that exist in the system but aren't listed in any
// AI_HUB_TABS entry. A regression that adds them to the union by
// mistake would expose the consolidated AI surface to people whose
// role does not grant access to even one of the seven sub-surfaces.
console.log("── 1. Unprivileged roles do not appear in AI_HUB_ANY_TAB_ROLES ──");
const UNPRIVILEGED_ROLES = [
  "logistics_coordinator",
  "carrier_user",
  "carrier_dispatcher",
  "guest",
  "viewer",
  "anonymous",
];
for (const role of UNPRIVILEGED_ROLES) {
  check(
    `role "${role}" is NOT granted access to the AI Hub`,
    !anyTabRoles.includes(role),
  );
}

// ── 2. The sidebar actually uses AI_HUB_ANY_TAB_ROLES to gate the row ──
//
// This protects against a sneaky regression: someone removes the role
// gate and the AI row leaks to all users — including unprivileged ones.
console.log("── 2. The sidebar gates the AI row by AI_HUB_ANY_TAB_ROLES ──");
check(
  "app-sidebar.tsx imports AI_HUB_ANY_TAB_ROLES from @/pages/ai-hub",
  /import\s*{[^}]*AI_HUB_ANY_TAB_ROLES[^}]*}\s*from\s*["']@\/pages\/ai-hub["']/.test(
    sidebarSrc,
  ),
);
check(
  "app-sidebar.tsx wires AI_HUB_ANY_TAB_ROLES into the AI row's roles config",
  /roles:\s*AI_HUB_ANY_TAB_ROLES/.test(sidebarSrc),
);
check(
  "app-sidebar.tsx still tags the AI row with data-testid=\"link-ai-hub\"",
  /data-testid=["']link-ai-hub["']/.test(sidebarSrc),
);
check(
  "app-sidebar.tsx still exposes the tour anchor data-tour=\"tour-ai-hub\"",
  /data-tour=["']tour-ai-hub["']/.test(sidebarSrc),
);

// ── 3. Per-tab role gating spot-checks ───────────────────────────────
//
// Mirror the per-page guards that already existed pre-consolidation.
// If an underlying page tightens or loosens its role check, the
// matching entry here must move with it. We index by tab key parsed
// from the source so we don't have to hard-code positional indices.
console.log("── 3. Per-tab role gating spot-checks ──");
function rolesForTab(tabKey: string): string[] {
  // Match `key: "<tabKey>"` … then the next `roles: [...]` in that block.
  const re = new RegExp(
    `key:\\s*["']${tabKey}["'][\\s\\S]*?roles:\\s*\\[([^\\]]*)\\]`,
  );
  const m = hubSrc.match(re);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^["']|["']$/g, ""));
}

const engagementRoles = rolesForTab("engagement");
check(
  `engagement tab is admin-tier only — found [${engagementRoles.join(", ")}]`,
  ["admin", "director", "sales_director"].every((r) =>
    engagementRoles.includes(r),
  ) && !engagementRoles.includes("account_manager"),
);

const copilotRoles = rolesForTab("copilot");
check(
  `copilot tab is admin-tier only — found [${copilotRoles.join(", ")}]`,
  ["admin", "director", "sales_director"].every((r) =>
    copilotRoles.includes(r),
  ) && !copilotRoles.includes("account_manager"),
);

const prioritiesRoles = rolesForTab("priorities");
check(
  `priorities tab is open to account_manager + sales — found [${prioritiesRoles.join(", ")}]`,
  prioritiesRoles.includes("account_manager") &&
    prioritiesRoles.includes("sales"),
);

// ── 4. Hub uses ?hub= (NOT ?tab=) to avoid query namespace collision ──
//
// ValueIQ owns its own `?tab=` state. If the hub regresses back to
// `?tab=` it shadows ValueIQ's tab state and breaks its UI.
console.log("── 4. Hub query namespace ──");
check(
  "ai-hub.tsx reads its active tab from the `hub` query param",
  /params\.get\(\s*["']hub["']\s*\)/.test(hubSrc),
);
check(
  "ai-hub.tsx writes the canonical URL with `?hub=`",
  /\/ai-hub\?hub=/.test(hubSrc),
);
check(
  "ai-hub.tsx no longer references `params.get(\"tab\")`",
  !/params\.get\(\s*["']tab["']\s*\)/.test(hubSrc),
);

console.log("──────────────────────────────────────────────────────────────");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════════════");

if (failed > 0) {
  process.exit(1);
}
