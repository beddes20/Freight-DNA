// Phase 1 — Customer Quote Cockpit guardrail.
//
// This is a static-analysis test (no React render) that pins the
// contracts the cockpit page must hold so future edits don't silently
// regress them:
//
//   1. The cockpit page file exists at the expected path.
//   2. The cockpit reuses the SAME detail query key as the existing
//      drawer (["/api/customer-quotes/quote", id]) so cockpit + drawer
//      mutate-and-invalidate in lockstep.
//   3. The cockpit subscribes to the same live-sync topics as the list
//      page (["customer_quote", "email_thread"]).
//   4. The cockpit reuses the trust-layer primitives (LiveSyncPill +
//      AttributionDrawer) so the experience matches the list page.
//   5. The cockpit reuses the standalone shadcn-style sub-components
//      already used by the drawer (PricingRecommendationCard,
//      QuoteDetailsCard, PricingIntelGate, ContextNotePanel,
//      EmailThreadViewerModal) instead of forking new ones.
//   6. App.tsx registers /quote-requests/:id and the legacy
//      /quote-requests list route is still present.
//   7. The cockpit dispatches the same window CustomEvent
//      ("customer-quotes:show-attribution") the rest of the app uses to
//      open the AttributionDrawer.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const COCKPIT_PATH = join(ROOT, "client/src/pages/quote-cockpit.tsx");
const APP_PATH = join(ROOT, "client/src/App.tsx");
const LIST_PATH = join(ROOT, "client/src/pages/quote-requests.tsx");

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${label}${detail && !ok ? ` :: ${detail}` : ""}`);
  if (!ok) failed += 1;
}

const cockpit = readFileSync(COCKPIT_PATH, "utf-8");
const app = readFileSync(APP_PATH, "utf-8");
const list = readFileSync(LIST_PATH, "utf-8");

// 1. File exists (read above would throw if not). Sanity check the
//    default export.
check(
  "cockpit page has a default export",
  /export default function QuoteCockpitPage/.test(cockpit),
  "expected `export default function QuoteCockpitPage` in client/src/pages/quote-cockpit.tsx",
);

// 2. Same detail query key as the drawer.
const DETAIL_KEY = `["/api/customer-quotes/quote", quoteId]`;
const DRAWER_DETAIL_KEY = `["/api/customer-quotes/quote", quote.id]`;
check(
  "cockpit uses ['/api/customer-quotes/quote', id] query key",
  cockpit.includes(DETAIL_KEY),
  `expected literal ${DETAIL_KEY} in cockpit`,
);
check(
  "drawer still uses ['/api/customer-quotes/quote', id] query key (sanity)",
  list.includes(DRAWER_DETAIL_KEY),
  "the drawer reference query key has changed; update this guardrail too",
);

// 3. Same live-sync topics as the list page.
check(
  "cockpit subscribes to useLiveSync(['customer_quote', 'email_thread'])",
  /useLiveSync\(\["customer_quote",\s*"email_thread"\]\)/.test(cockpit),
  "expected useLiveSync([\"customer_quote\", \"email_thread\"]) in cockpit",
);

// 4. Trust-layer primitives.
check(
  "cockpit imports LiveSyncPill",
  /from "@\/components\/live-sync\/LiveSyncPill"/.test(cockpit),
);
check(
  "cockpit mounts a LiveSyncPill with a unique testId",
  /testId="pill-live-sync-quote-cockpit"/.test(cockpit),
);
check(
  "cockpit imports AttributionDrawer",
  /from "@\/components\/customer-quotes\/AttributionDrawer"/.test(cockpit),
);

// 5. Reused sub-components (no forks).
const REUSED = [
  ['PricingRecommendationCard', '@/components/PricingRecommendationCard'],
  ['QuoteDetailsCard', '@/components/quote-requests/QuoteDetailsCard'],
  ['PricingIntelGate', '@/components/quote-requests/PricingIntelGate'],
  ['ContextNotePanel', '@/components/context-notes'],
  ['EmailThreadViewerModal', '@/components/conversations/email-thread-viewer-modal'],
];
for (const [name, mod] of REUSED) {
  check(
    `cockpit reuses ${name} from ${mod}`,
    new RegExp(`import\\s+\\{[^}]*\\b${name}\\b[^}]*\\}\\s+from\\s+"${mod.replace(/[/.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(cockpit),
    `expected named import { ${name} } from "${mod}" in cockpit`,
  );
}

// 6. App.tsx registers both routes.
check(
  "App.tsx imports QuoteCockpitPage",
  /from "@\/pages\/quote-cockpit"/.test(app),
);
check(
  "App.tsx registers /quote-requests/:id route",
  /<Route\s+path="\/quote-requests\/:id"\s+component=\{QuoteCockpitPage\}\s*\/>/.test(app),
);
check(
  "App.tsx still registers the original /quote-requests list route",
  /<Route\s+path="\/quote-requests"\s+component=\{QuoteRequestsPage\}\s*\/>/.test(app),
);

// 7. Same attribution CustomEvent contract.
check(
  "cockpit dispatches customer-quotes:show-attribution CustomEvent",
  /new CustomEvent\("customer-quotes:show-attribution"/.test(cockpit),
);
check(
  "cockpit listens for customer-quotes:show-attribution CustomEvent",
  /addEventListener\("customer-quotes:show-attribution"/.test(cockpit),
);

if (failed > 0) {
  console.error(`\n${failed} guardrail check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll customer-quote-cockpit guardrails passed.");
