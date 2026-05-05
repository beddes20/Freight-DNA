/**
 * Code Quality Guardrails — Static Analysis
 *
 * Regression fence for the code-quality improvement pass:
 *   1. err:any catch clauses have been removed (use unknown instead)
 *   2. Rate-limiting middleware is applied to AI and bulk-import endpoints
 *   3. Contacts routes are served from the extracted module (not inline in routes.ts)
 *   4. fanOutCelebration is no longer defined inline in routes.ts
 *   5. Storage Promise<any[]> methods have typed return types
 *   6. Shared lib files exist (rateLimiter, errors)
 *   7. Companies routes are served from the extracted module (not inline in routes.ts)
 *   8. Chat conversation reads are always scoped to the requesting user's id
 *
 * Run with: npx tsx tests/code-quality-guardrails.test.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${description}\n    ${detail}` : `  ✗ ${description}`;
    console.error(msg);
    failures.push(description + (detail ? ` — ${detail}` : ""));
    failed++;
  }
}

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

function walkFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

const ROUTE_FILES: string[] = [
  path.join(ROOT, "server", "routes.ts"),
  ...walkFiles(path.join(ROOT, "server", "routes"), ".ts"),
];

// ── 1. No explicit `catch (err: any)` or `catch (error: any)` ────────────────
console.log("\n── 1. No explicit :any on catch variables ───────────────────────────\n");

const ErrAnyPattern = /catch\s*\(\s*(err|error)\s*:\s*any\s*\)/g;

for (const filePath of ROUTE_FILES) {
  const rel = path.relative(ROOT, filePath);
  const content = readFile(rel);
  const matches = content.match(ErrAnyPattern);
  assert(
    `${rel} — no catch (err/error: any)`,
    !matches || matches.length === 0,
    matches ? `Found ${matches.length} violation(s)` : undefined
  );
}

// ── 2. Rate-limiting middleware on AI endpoints ───────────────────────────────
console.log("\n── 2. Rate-limiting applied to AI / bulk-import endpoints ───────────\n");

const callIntelContent = readFile("server/routes/callIntelligence.ts");
assert(
  "callIntelligence.ts — /api/call-prep has aiRateLimit",
  /app\.post\("\/api\/call-prep\/:companyId".*?aiRateLimit/.test(callIntelContent),
  "aiRateLimit middleware not found on /api/call-prep/:companyId"
);
assert(
  "callIntelligence.ts — /api/post-call-capture has aiRateLimit",
  /app\.post\("\/api\/post-call-capture".*?aiRateLimit/.test(callIntelContent),
  "aiRateLimit middleware not found on /api/post-call-capture"
);

const mainRoutesContent = readFile("server/routes.ts");
assert(
  "routes.ts — /api/users/bulk-import has bulkImportRateLimit",
  /app\.post\("\/api\/users\/bulk-import".*?bulkImportRateLimit/.test(mainRoutesContent),
  "bulkImportRateLimit not found on /api/users/bulk-import"
);
assert(
  "routes.ts — /api/companies/bulk-import has bulkImportRateLimit",
  /app\.post\("\/api\/companies\/bulk-import".*?bulkImportRateLimit/.test(mainRoutesContent),
  "bulkImportRateLimit not found on /api/companies/bulk-import"
);
assert(
  "routes.ts — /api/rfps/preview-headers has aiPreviewRateLimit",
  /app\.post\("\/api\/rfps\/preview-headers".*?aiPreviewRateLimit/.test(mainRoutesContent),
  "aiPreviewRateLimit not found on /api/rfps/preview-headers"
);
assert(
  "routes.ts — /api/rfps/upload has aiPreviewRateLimit",
  /app\.post\("\/api\/rfps\/upload".*?aiPreviewRateLimit/.test(mainRoutesContent),
  "aiPreviewRateLimit not found on /api/rfps/upload"
);
assert(
  "routes.ts — /api/awards/parse-lanes has bulkImportRateLimit",
  /app\.post\("\/api\/awards\/parse-lanes".*?bulkImportRateLimit/.test(mainRoutesContent),
  "bulkImportRateLimit not found on /api/awards/parse-lanes"
);
assert(
  "routes.ts — /api/companies/:id/market-share/upload has bulkImportRateLimit",
  /app\.post\("\/api\/companies\/:id\/market-share\/upload".*?bulkImportRateLimit/.test(mainRoutesContent),
  "bulkImportRateLimit not found on /api/companies/:id/market-share/upload"
);

// ── 3. Contacts routes are extracted (not inline in routes.ts) ────────────────
console.log("\n── 3. Contacts routes extracted from routes.ts ───────────────────────\n");

assert(
  "routes.ts — no inline app.get(\"/api/contacts\")",
  !mainRoutesContent.includes('app.get("/api/contacts"'),
  "Found inline app.get(\"/api/contacts\") — should be in server/routes/contacts.ts"
);
assert(
  "routes.ts — no inline app.post(\"/api/companies/:companyId/contacts\")",
  !mainRoutesContent.includes('app.post("/api/companies/:companyId/contacts"'),
  "Found inline contact creation route — should be in server/routes/contacts.ts"
);
assert(
  "routes.ts — no inline app.patch(\"/api/contacts/:id\")",
  !mainRoutesContent.includes('app.patch("/api/contacts/:id"'),
  "Found inline contact update route — should be in server/routes/contacts.ts"
);
assert(
  "routes.ts — registerContactRoutes(app) is called",
  mainRoutesContent.includes("registerContactRoutes(app)"),
  "registerContactRoutes not wired in routes.ts"
);
assert(
  "server/routes/contacts.ts — file exists",
  fs.existsSync(path.join(ROOT, "server", "routes", "contacts.ts")),
  "contacts.ts not found"
);

const contactsContent = readFile("server/routes/contacts.ts");
assert(
  "contacts.ts — exports registerContactRoutes",
  contactsContent.includes("export function registerContactRoutes"),
  "registerContactRoutes not exported from contacts.ts"
);

// ── 4. fanOutCelebration extracted from routes.ts ─────────────────────────────
console.log("\n── 4. fanOutCelebration moved to server/lib ──────────────────────────\n");

assert(
  "routes.ts — no inline fanOutCelebration definition",
  !mainRoutesContent.includes("async function fanOutCelebration("),
  "fanOutCelebration still defined inline in routes.ts"
);
assert(
  "server/lib/fanOutCelebration.ts — file exists",
  fs.existsSync(path.join(ROOT, "server", "lib", "fanOutCelebration.ts")),
  "fanOutCelebration.ts not found in server/lib"
);
assert(
  "routes.ts — imports fanOutCelebration from lib",
  mainRoutesContent.includes('from "./lib/fanOutCelebration"'),
  "routes.ts does not import fanOutCelebration from lib"
);

// ── 5. Storage methods have typed return types (no Promise<any>) ──────────────
console.log("\n── 5. Storage methods have proper return types ───────────────────────\n");

const storageContent = readFile("server/storage.ts");

assert(
  "storage.ts — getContactBaseHistory returns ContactBaseHistoryRow[]",
  storageContent.includes("getContactBaseHistory(contactId: string): Promise<ContactBaseHistoryRow[]>"),
  "getContactBaseHistory still returns Promise<any[]>"
);
assert(
  "storage.ts — getInternalPosts returns InternalPost[]",
  storageContent.includes("getInternalPosts(userId: string, role: string, orgUserIds: string[]): Promise<InternalPost[]>"),
  "getInternalPosts still returns Promise<any[]>"
);
assert(
  "storage.ts — createInternalPost returns InternalPost",
  storageContent.includes("): Promise<InternalPost>;"),
  "createInternalPost still returns Promise<any>"
);
assert(
  "storage.ts — ContactBaseHistoryRow type is exported",
  storageContent.includes("export type ContactBaseHistoryRow"),
  "ContactBaseHistoryRow type not exported from storage.ts"
);

// ── 6. Rate-limiter lib exists ────────────────────────────────────────────────
console.log("\n── 6. Shared lib files exist ────────────────────────────────────────\n");

assert(
  "server/lib/rateLimiter.ts — file exists",
  fs.existsSync(path.join(ROOT, "server", "lib", "rateLimiter.ts")),
  "rateLimiter.ts not found in server/lib"
);
assert(
  "server/lib/errors.ts — file exists",
  fs.existsSync(path.join(ROOT, "server", "lib", "errors.ts")),
  "errors.ts not found in server/lib"
);

const errorsContent = readFile("server/lib/errors.ts");
assert(
  "errors.ts — exports getErrorMessage",
  errorsContent.includes("export function getErrorMessage"),
  "getErrorMessage not exported from errors.ts"
);

// ── 7. Companies routes are extracted (not inline in routes.ts) ───────────────
console.log("\n── 7. Companies routes extracted from routes.ts ──────────────────────\n");

assert(
  "routes.ts — no inline app.get(\"/api/companies\")",
  !mainRoutesContent.includes('app.get("/api/companies"'),
  "Found inline app.get(\"/api/companies\") — should be in server/routes/companies.ts"
);
assert(
  "routes.ts — no inline app.post(\"/api/companies\")",
  !mainRoutesContent.includes('app.post("/api/companies"'),
  "Found inline company creation route — should be in server/routes/companies.ts"
);
assert(
  "routes.ts — no inline app.patch(\"/api/companies/:id\")",
  !mainRoutesContent.includes('app.patch("/api/companies/:id"'),
  "Found inline company update route — should be in server/routes/companies.ts"
);
assert(
  "routes.ts — registerCompanyRoutes(app) is called",
  mainRoutesContent.includes("registerCompanyRoutes(app)"),
  "registerCompanyRoutes not wired in routes.ts"
);
assert(
  "server/routes/companies.ts — file exists",
  fs.existsSync(path.join(ROOT, "server", "routes", "companies.ts")),
  "companies.ts not found in server/routes"
);

const companiesContent = readFile("server/routes/companies.ts");
assert(
  "companies.ts — exports registerCompanyRoutes",
  companiesContent.includes("export function registerCompanyRoutes"),
  "registerCompanyRoutes not exported from companies.ts"
);
assert(
  "companies.ts — all company routes scope to currentUser.organizationId",
  companiesContent.includes("currentUser.organizationId"),
  "companies.ts does not scope queries to the current user's org"
);

// ── 8. Chat conversation reads are always scoped by userId ────────────────────
console.log("\n── 8. Chat conversation ownership scoping ────────────────────────────\n");

const chatStorageContent = readFile("server/replit_integrations/chat/storage.ts");

assert(
  "chat/storage.ts — getConversationForUser filters by userId",
  /getConversationForUser.*?\{[\s\S]*?eq\(chatConversations\.userId,\s*userId\)/.test(chatStorageContent),
  "getConversationForUser does not filter chatConversations by userId"
);
assert(
  "chat/storage.ts — deleteConversationForUser checks ownership before delete",
  /deleteConversationForUser.*?\{[\s\S]*?eq\(chatConversations\.userId,\s*userId\)/.test(chatStorageContent),
  "deleteConversationForUser does not verify ownership (userId check) before deleting"
);
assert(
  "chat/storage.ts — getAllConversationsForUser filters by userId",
  /getAllConversationsForUser.*?\{[\s\S]*?eq\(chatConversations\.userId,\s*userId\)/.test(chatStorageContent),
  "getAllConversationsForUser does not filter by userId"
);

const chatRoutesDir = path.join(ROOT, "server", "replit_integrations", "chat");
const chatRouteFiles = fs
  .readdirSync(chatRoutesDir)
  .filter(f => f.endsWith(".ts") && f !== "storage.ts")
  .map(f => fs.readFileSync(path.join(chatRoutesDir, f), "utf-8"));

for (const [i, content] of chatRouteFiles.entries()) {
  const filename = fs.readdirSync(chatRoutesDir).filter(f => f.endsWith(".ts") && f !== "storage.ts")[i];
  const hasChatConversationsRead = content.includes("chatConversations");
  if (hasChatConversationsRead) {
    assert(
      `chat/${filename} — uses chatStorage helper (not raw DB) for chatConversations reads`,
      content.includes("chatStorage.") || content.includes("getConversationForUser") || content.includes("getAllConversationsForUser"),
      `${filename} queries chatConversations directly — use chatStorage helpers which enforce userId scoping`
    );
  }
}

// ── 9. Daily Priorities Workspace (Task #674) ─────────────────────────────────
console.log("\n── 9. Daily Priorities Workspace endpoints ───────────────────────────\n");

assert(
  "routes.ts — GET /api/nba/daily-workspace has requireAuth",
  /app\.get\("\/api\/nba\/daily-workspace",\s*requireAuth/.test(mainRoutesContent),
  "GET /api/nba/daily-workspace is missing requireAuth middleware"
);

assert(
  "routes.ts — POST /api/nba/dismiss/:cardId has requireAuth",
  /app\.post\("\/api\/nba\/dismiss\/:cardId",\s*requireAuth/.test(mainRoutesContent),
  "POST /api/nba/dismiss/:cardId is missing requireAuth middleware"
);

assert(
  "routes.ts — dismiss endpoint uses pStr for cardId param",
  mainRoutesContent.includes("pStr(req.params.cardId)"),
  "POST /api/nba/dismiss/:cardId does not normalize cardId with pStr"
);

assert(
  "routes.ts — daily-workspace endpoint uses qOptStr for repId query param",
  mainRoutesContent.includes("qOptStr(req.query.repId)"),
  "GET /api/nba/daily-workspace does not normalize repId with qOptStr"
);

assert(
  "routes.ts — daily-workspace uses getErrorMessage for error handling",
  mainRoutesContent.includes('[nba/daily-workspace GET]') &&
    mainRoutesContent.includes("getErrorMessage(err)"),
  "daily-workspace catch block does not use getErrorMessage"
);

assert(
  "server/lib/dailyWorkspaceBuckets.ts — bucket mapping module exists",
  fs.existsSync(path.join(ROOT, "server", "lib", "dailyWorkspaceBuckets.ts")),
  "dailyWorkspaceBuckets.ts not found in server/lib"
);

const bucketMapContent = readFile("server/lib/dailyWorkspaceBuckets.ts");
assert(
  "dailyWorkspaceBuckets.ts — exports ruleTypeToBucket",
  bucketMapContent.includes("export function ruleTypeToBucket"),
  "ruleTypeToBucket not exported from dailyWorkspaceBuckets.ts"
);

assert(
  "dailyWorkspaceBuckets.ts — exports BUCKET_PRIORITY",
  bucketMapContent.includes("export const BUCKET_PRIORITY"),
  "BUCKET_PRIORITY not exported from dailyWorkspaceBuckets.ts"
);

assert(
  "daily-priorities page — loading skeleton present",
  fs.existsSync(path.join(ROOT, "client", "src", "pages", "daily-priorities.tsx")) &&
    readFile("client/src/pages/daily-priorities.tsx").includes("isLoading"),
  "daily-priorities.tsx does not handle loading state"
);

assert(
  "daily-priorities page — error state present",
  readFile("client/src/pages/daily-priorities.tsx").includes("error-workspace"),
  "daily-priorities.tsx does not have a data-testid=error-workspace error state"
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 10: Shared loading/empty/error UI primitives (Task #694)
// Make sure the shared <EmptyState /> and <ErrorBanner /> components exist in
// client/src/components/ui/ and are wired into the surfaces the recent
// code-quality pass (Task #676) touched. Future pages should reach for these
// instead of hand-rolling empty divs or raw destructive banners.
// ─────────────────────────────────────────────────────────────────────────────
assert(
  "ui/empty-state.tsx — shared EmptyState component exists",
  fs.existsSync(path.join(ROOT, "client", "src", "components", "ui", "empty-state.tsx")),
  "client/src/components/ui/empty-state.tsx not found"
);

const emptyStateContent = fs.existsSync(path.join(ROOT, "client", "src", "components", "ui", "empty-state.tsx"))
  ? readFile("client/src/components/ui/empty-state.tsx")
  : "";

assert(
  "ui/empty-state.tsx — exports EmptyState",
  emptyStateContent.includes("export function EmptyState"),
  "EmptyState is not exported from empty-state.tsx"
);

assert(
  "ui/error-banner.tsx — shared ErrorBanner alias exists",
  fs.existsSync(path.join(ROOT, "client", "src", "components", "ui", "error-banner.tsx")),
  "client/src/components/ui/error-banner.tsx not found"
);

const errorBannerContent = fs.existsSync(path.join(ROOT, "client", "src", "components", "ui", "error-banner.tsx"))
  ? readFile("client/src/components/ui/error-banner.tsx")
  : "";

assert(
  "ui/error-banner.tsx — re-exports QueryError as ErrorBanner",
  errorBannerContent.includes("QueryError as ErrorBanner"),
  "error-banner.tsx does not alias QueryError as ErrorBanner"
);

const lwqContent = readFile("client/src/pages/lane-work-queue.tsx");
assert(
  "lane-work-queue page — uses QueryError for error state",
  lwqContent.includes("QueryError"),
  "lane-work-queue.tsx no longer uses QueryError"
);

const laneInboxContent = readFile("client/src/pages/lane-inbox.tsx");
assert(
  "lane-inbox page — uses ErrorBanner + EmptyState",
  laneInboxContent.includes("ErrorBanner") && laneInboxContent.includes("EmptyState"),
  "lane-inbox.tsx is missing ErrorBanner or EmptyState"
);

// Task #850 — customer-quotes.tsx was retired in favour of the new
// /quote-requests operator surface. The post-2d page still has to honour
// the empty/error UI primitive contract on its snapshot + list queries.
const quoteRequestsContent = readFile("client/src/pages/quote-requests.tsx");
assert(
  "quote-requests page — uses ErrorBanner for query errors",
  quoteRequestsContent.includes("ErrorBanner") && quoteRequestsContent.includes("snapshotQuery.isError"),
  "quote-requests.tsx is missing ErrorBanner wiring on snapshot/list queries"
);

assert(
  "quote-requests page — uses EmptyState for empty filtered table",
  quoteRequestsContent.includes("EmptyState") && quoteRequestsContent.includes("empty-quote-rows"),
  "quote-requests.tsx is missing EmptyState for empty filtered results"
);

const callPaceContent = readFile("client/src/components/call-pace-card.tsx");
assert(
  "call-pace-card — uses EmptyState + ErrorBanner",
  callPaceContent.includes("EmptyState") && callPaceContent.includes("ErrorBanner"),
  "call-pace-card.tsx is missing standardized empty/error states"
);

const callTrendContent = readFile("client/src/components/call-activity-trendline.tsx");
assert(
  "call-activity-trendline — uses EmptyState + ErrorBanner",
  callTrendContent.includes("EmptyState") && callTrendContent.includes("ErrorBanner"),
  "call-activity-trendline.tsx is missing standardized empty/error states"
);

const callQualityContent = readFile("client/src/components/call-quality-scorecard.tsx");
assert(
  "call-quality-scorecard — uses EmptyState + ErrorBanner",
  callQualityContent.includes("EmptyState") && callQualityContent.includes("ErrorBanner"),
  "call-quality-scorecard.tsx is missing standardized empty/error states"
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 11: Directory-wide route hygiene (Task #695)
// Walk every file in server/routes/ and assert:
//   • No raw `req.params.X` reads (must be wrapped in pStr)
//   • No raw `req.query.X` reads (must be wrapped in qStr / qOptStr / qStrArr
//     / qInt / qBool / extractListFilters)
//   • No legacy error-message patterns in catch blocks
//     (`(err as Error)?.message`, `err instanceof Error ? err.message : …`)
// This catches regressions in route files we haven't hand-listed in earlier
// sections and is intentionally O(routes) so newly-added route files are
// covered automatically.
// ─────────────────────────────────────────────────────────────────────────────
const ROUTES_DIR = path.join(ROOT, "server", "routes");
const ALL_ROUTE_FILES = fs
  .readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort();

// Files that legitimately reference the helpers (their own definitions etc).
// Currently empty — every route file should funnel through the helpers.
const RAW_REQ_ALLOWLIST = new Set<string>([]);

// Destructuring-pattern allowlist — these files still use
// `const { x, y } = req.query` / `const { id } = req.params` and have not yet
// been migrated to the typed accessors. New route files MUST NOT add
// destructured access; this list should only shrink.
const DESTRUCTURING_ALLOWLIST = new Set<string>([
  "carrierHub.ts",
  "coaching.ts",
  "companyCollaborators.ts",
  "conversations.ts",
  "emailDrafting.ts",
  "engagement.ts",
  "freightOpportunityCockpit.ts",
  "marketSignals.ts",
  "myProcurement.ts",
  "playbook.ts",
  "proactiveOpportunities.ts",
  "provenTactics.ts",
]);

const RAW_PARAM_RE = /(?<!pStr\()(?<!qStrArr\()req\.params\.\w+/g;
const RAW_QUERY_RE =
  /(?<!qStr\()(?<!qOptStr\()(?<!qStrArr\()(?<!qInt\()(?<!qBool\()(?<!extractListFilters\()req\.query\.\w+/g;
const LEGACY_ERR_RE_1 = /\(\s*err(?:or)?\s+as\s+Error\s*\)\s*\??\.message/g;
const LEGACY_ERR_RE_2 =
  /err(?:or)?\s+instanceof\s+Error\s*\?\s*err(?:or)?\.message/g;
// Destructured req.params/req.query — escapes the per-property regexes above
// (`const { x } = req.query` parses past `RAW_QUERY_RE` because there is no
// `.X` after `req.query`). This was identified as a Section 11 gap during
// Task #695 architect review.
const DESTRUCTURE_REQ_RE = /\}\s*=\s*req\.(?:params|query)\b/g;
// Bracket notation: `req.params["x"]` / `req.query['y']` also escapes the
// `.X` regex. Forbid it directly.
const BRACKET_REQ_RE = /\breq\.(?:params|query)\s*\[/g;

for (const f of ALL_ROUTE_FILES) {
  if (RAW_REQ_ALLOWLIST.has(f)) continue;
  const src = readFile(path.join("server", "routes", f));

  const rawParams = src.match(RAW_PARAM_RE) ?? [];
  assert(
    `routes/${f} — no raw req.params.X (must use pStr)`,
    rawParams.length === 0,
    `Found ${rawParams.length} raw req.params reads in server/routes/${f}: e.g. ${rawParams.slice(0, 3).join(", ")}`
  );

  const rawQueries = src.match(RAW_QUERY_RE) ?? [];
  assert(
    `routes/${f} — no raw req.query.X (must use qStr / qOptStr / qStrArr / qInt / qBool / extractListFilters)`,
    rawQueries.length === 0,
    `Found ${rawQueries.length} raw req.query reads in server/routes/${f}: e.g. ${rawQueries.slice(0, 3).join(", ")}`
  );

  const legacyErr = (src.match(LEGACY_ERR_RE_1) ?? []).concat(src.match(LEGACY_ERR_RE_2) ?? []);
  assert(
    `routes/${f} — no legacy error patterns (must use getErrorMessage)`,
    legacyErr.length === 0,
    `Found ${legacyErr.length} legacy error-message reads in server/routes/${f}`
  );

  // Destructuring + bracket-notation hygiene. Skip files explicitly grandfathered
  // in DESTRUCTURING_ALLOWLIST — those are tracked as a follow-up.
  if (!DESTRUCTURING_ALLOWLIST.has(f)) {
    const destructured = src.match(DESTRUCTURE_REQ_RE) ?? [];
    assert(
      `routes/${f} — no destructured req.params / req.query (must use pStr / qStr helpers)`,
      destructured.length === 0,
      `Found ${destructured.length} destructured req.* reads in server/routes/${f}: e.g. ${destructured.slice(0, 3).join(", ")}`
    );

    const bracketed = src.match(BRACKET_REQ_RE) ?? [];
    assert(
      `routes/${f} — no bracket-notation req.params[…] / req.query[…] (must use pStr / qStr helpers)`,
      bracketed.length === 0,
      `Found ${bracketed.length} bracket req.* reads in server/routes/${f}: e.g. ${bracketed.slice(0, 3).join(", ")}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 12: Reusable handler helpers exist (Task #695)
// ─────────────────────────────────────────────────────────────────────────────
const reqHelpersSrc = readFile("server/lib/req.ts");
assert(
  "server/lib/req.ts — exports extractListFilters",
  reqHelpersSrc.includes("export function extractListFilters"),
  "extractListFilters helper missing from server/lib/req.ts"
);
assert(
  "server/lib/req.ts — exports qInt",
  reqHelpersSrc.includes("export function qInt"),
  "qInt helper missing from server/lib/req.ts"
);
assert(
  "server/lib/req.ts — exports qBool",
  reqHelpersSrc.includes("export function qBool"),
  "qBool helper missing from server/lib/req.ts"
);

const authSrc = readFile("server/auth.ts");
assert(
  "server/auth.ts — exports requireUser middleware",
  authSrc.includes("export async function requireUser"),
  "requireUser middleware missing from server/auth.ts"
);
assert(
  "server/auth.ts — augments Request with user property",
  authSrc.includes('declare module "express-serve-static-core"') &&
    authSrc.includes("user?: User"),
  "Express Request not augmented with user?: User"
);

// ── Section 13: Shared resilience helper exists (Task #706) ──────────────────
//
// External-API services should converge on a single `resilientFetch` helper
// instead of each rolling its own timeout / retry / circuit-breaker code.
// This section enforces that the helper file exists, exports the expected
// surface, and is paired with the integration probe registry that powers
// Task #701's Integrations Health Console.
const httpRetryPath = "server/lib/httpRetry.ts";
const probeRegistryPath = "server/integrations/probeRegistry.ts";
const httpRetrySrc = readFile(httpRetryPath);
const probeRegistrySrc = readFile(probeRegistryPath);
assert(
  `${httpRetryPath} — exports resilientFetch`,
  httpRetrySrc.includes("export async function resilientFetch") ||
    httpRetrySrc.includes("export function resilientFetch"),
  "resilientFetch helper missing — Task #706 needs the shared HTTP wrapper to converge service code on one retry/circuit primitive."
);
assert(
  `${httpRetryPath} — implements timeout + backoff`,
  /timeout/i.test(httpRetrySrc) && /retry|backoff/i.test(httpRetrySrc),
  "resilientFetch must combine a per-attempt timeout with retry/backoff so callers get bounded latency + transient-error recovery."
);
assert(
  `${probeRegistryPath} — exports recordIntegrationEvent`,
  probeRegistrySrc.includes("export function recordIntegrationEvent") ||
    probeRegistrySrc.includes("export async function recordIntegrationEvent"),
  "recordIntegrationEvent missing — Integrations Health (Task #701) consumes this from resilientFetch via the integration probe registry."
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 13: Shared resilience helper coverage (Task #706)
// Every external-integration HTTP call site in the listed files must funnel
// through `resilientFetch(...)` so the per-source policy (timeout, retry,
// breaker, Retry-After honoring) and the Integrations Health probe events
// (Task #701) apply uniformly. New raw `fetch(` calls in these files are
// forbidden unless explicitly opted out with a `// guardrail-allow-fetch:`
// marker on the same or previous line (used for public, non-policy endpoints
// like the EIA petroleum API in sonarClient.ts).
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 13. Shared resilience helper coverage (Task #706) ────────────────\n");

const RESILIENT_FETCH_FILES: string[] = [
  "server/sonarClient.ts",
  "server/tracService.ts",
  "server/graphService.ts",
  "server/graphSubscriptionService.ts",
  "server/services/mailboxHistoricalBackfillService.ts",
  "server/services/mailboxDeltaSyncService.ts",
  "server/webexService.ts",
  "server/zoominfo.ts",
  "server/outlookService.ts",
  "server/availableFreightImporter.ts",
  "server/loadFactPowerBIImporter.ts",
  "server/monthlyDataRefreshScheduler.ts",
];

// Match `fetch(` but NOT `resilientFetch(` (negative lookbehind) and NOT
// the inner factory `() => fetch(...)` body inside a resilientFetch call
// (we can't easily do that with regex, so we instead look at each line and
// require either the `resilientFetch(` token on the same line, or the
// allow-fetch marker on this or the previous line).
const RAW_FETCH_RE = /(?<!resilient)\bfetch\s*\(/i;

for (const rel of RESILIENT_FETCH_FILES) {
  const fullPath = path.join(ROOT, rel);
  if (!fs.existsSync(fullPath)) {
    assert(`${rel} — file exists`, false, "file not found");
    continue;
  }
  const lines = readFile(rel).split("\n");
  const offenders: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!RAW_FETCH_RE.test(line)) continue;
    // Skip pure-comment lines (the regex matches the word "fetch" inside
    // section banners like "── OneDrive fetch (mirrors …) ──").
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    // Allow if `resilientFetch(` appears on the same line (factory pattern).
    if (/resilientFetch\s*\(/.test(line)) continue;
    // Allow if explicit opt-out marker is on this line OR within 5 lines
    // above (multi-line justification comments are common — see EIA call
    // in sonarClient.ts).
    let allowed = line.includes("guardrail-allow-fetch:");
    for (let look = 1; !allowed && look <= 5 && i - look >= 0; look++) {
      if (lines[i - look].includes("guardrail-allow-fetch:")) allowed = true;
    }
    if (allowed) continue;
    offenders.push(`L${i + 1}: ${line.trim().slice(0, 120)}`);
  }
  assert(
    `${rel} — every external HTTP call routes through resilientFetch (or is marked guardrail-allow-fetch)`,
    offenders.length === 0,
    offenders.length
      ? `Found ${offenders.length} raw fetch() call(s):\n      ${offenders.slice(0, 5).join("\n      ")}`
      : undefined
  );
}

// Sanity-check the policy registry covers every IntegrationSource we route
// through resilientFetch. New sources added to probeRegistry should also get
// a tuned policy in httpRetry.ts; otherwise they silently inherit DEFAULT.
const httpRetryFullSrc = readFile("server/lib/httpRetry.ts");
for (const source of ["sonar", "graph", "webex", "zoominfo", "onedrive", "trac", "stripe"]) {
  assert(
    `httpRetry.ts — POLICIES has tuned entry for "${source}"`,
    new RegExp(`\\b${source}\\s*:\\s*\\{`).test(httpRetryFullSrc),
    `No tuned policy for "${source}" in POLICIES — add timeoutMs/retries/breaker settings.`
  );
}

assert(
  "httpRetry.ts — exports getBreakerStatus / tripBreaker / _resetBreakerForTests",
  /export\s+function\s+getBreakerStatus/.test(httpRetryFullSrc) &&
    /export\s+function\s+tripBreaker/.test(httpRetryFullSrc) &&
    /export\s+function\s+_resetBreakerForTests/.test(httpRetryFullSrc),
  "httpRetry.ts is missing one of the breaker introspection helpers required by sonarClient.getSonarCircuitBreakerStatus and the unit tests."
);

assert(
  "sonarClient.ts — getSonarCircuitBreakerStatus delegates to shared helper",
  readFile("server/sonarClient.ts").includes('getBreakerStatus("sonar")') ||
    readFile("server/sonarClient.ts").includes("_getBreakerStatus(\"sonar\")"),
  "getSonarCircuitBreakerStatus no longer reads from the shared httpRetry breaker — the bespoke breaker should have been removed in Task #706."
);

// ──────────────────────────────────────────────────────────────────────────
// 14. Endpoint perf budgets coverage (Task #705)
// ──────────────────────────────────────────────────────────────────────────
console.log("\n── 14. Endpoint perf budgets coverage (Task #705) ────────────────\n");

const perfBudgetsSrc = readFile("server/perfBudgets.ts");
const endpointPerfSrc = readFile("server/routes/endpointPerf.ts");
const breachSchedulerSrc = readFile("server/perfBudgetBreachScheduler.ts");
const indexSrc = readFile("server/index.ts");
const routesSrc = readFile("server/routes.ts");
const cacheSrc = readFile("server/cache.ts");
const dbCacheSrc = readFile("server/dbCache.ts");
const perfHintsSrc = readFile("server/lib/perfHints.ts");

// 14a. ENDPOINT_BUDGETS lists all 12 routes called out in the task plan.
const REQUIRED_BUDGET_KEYS = [
  "/api/today-queue",
  "/api/nba/cards",
  "/api/lane-inbox",
  "/api/available-freight",
  "/api/recurring-lanes/work-queue",
  "/api/carrier-hub",
  "/api/customer-quotes",
  "/api/internal/conversations",
  "/api/dashboard/summary",
  "/api/calls/trendline",
  "/api/ai-center/fleet",
  "/api/valueiq/today",
];
for (const key of REQUIRED_BUDGET_KEYS) {
  assert(
    `perfBudgets.ts — ENDPOINT_BUDGETS includes ${key}`,
    perfBudgetsSrc.includes(`"GET ${key}"`),
    `Missing budget for ${key}. Add a row to ENDPOINT_BUDGETS in server/perfBudgets.ts.`,
  );
}

// 14b. Middleware + admin routes wired into the server.
assert(
  "server/routes.ts — perfTimingMiddleware is mounted",
  /app\.use\(perfTimingMiddleware\)/.test(routesSrc),
  "perfTimingMiddleware is no longer registered. Sample collection is broken.",
);
assert(
  "server/routes.ts — registerEndpointPerfRoutes is called",
  /registerEndpointPerfRoutes\(app\)/.test(routesSrc),
  "registerEndpointPerfRoutes(app) is missing — admin perf endpoints will 404.",
);
assert(
  "endpointPerf.ts — exposes both overview and timeseries endpoints",
  endpointPerfSrc.includes("/api/admin/endpoint-perf/overview") &&
    endpointPerfSrc.includes("/api/admin/endpoint-perf/timeseries"),
  "Admin perf API surface is incomplete (missing overview or timeseries).",
);

// 14c. Breach scheduler exists and is wired into boot.
assert(
  "perfBudgetBreachScheduler.ts — exports init + run + find helpers",
  /export\s+function\s+initPerfBudgetBreachScheduler/.test(breachSchedulerSrc) &&
    /export\s+async\s+function\s+runPerfBudgetBreachCheck/.test(breachSchedulerSrc) &&
    /export\s+async\s+function\s+findBudgetBreaches/.test(breachSchedulerSrc),
  "Breach scheduler is missing one of its public helpers.",
);
assert(
  "server/index.ts — initPerfBudgetBreachScheduler is called at boot",
  /initPerfBudgetBreachScheduler\(\)/.test(indexSrc),
  "initPerfBudgetBreachScheduler() is not called in server/index.ts — daily breach notifier is dormant.",
);
assert(
  "perfBudgetBreachScheduler.ts — throttles by relatedId within 24h",
  /relatedId/.test(breachSchedulerSrc) && /perf_budget_breach/.test(breachSchedulerSrc),
  "Breach scheduler is missing the per-route throttle. It will spam admins.",
);

// 14d. Cache layers expose req-aware tagging via the shared perfHints helper.
assert(
  "server/lib/perfHints.ts — exports markCacheHint + getCacheHint",
  /export\s+function\s+markCacheHint/.test(perfHintsSrc) &&
    /export\s+function\s+getCacheHint/.test(perfHintsSrc),
  "perfHints helper is missing one of its exports.",
);
assert(
  "server/cache.ts — cacheGet accepts an optional req and tags it",
  /markCacheHint/.test(cacheSrc) && /req\?: Request/.test(cacheSrc),
  "cacheGet no longer accepts req — cold/warm cache hint coverage is broken.",
);
assert(
  "server/dbCache.ts — getDbCached accepts an optional req and tags it",
  /markCacheHint/.test(dbCacheSrc) && /req\?: Request/.test(dbCacheSrc),
  "getDbCached no longer accepts req — cold/warm cache hint coverage is broken.",
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 15: Conversations freshness fence (Phase 1 — "Stop lying about
// freshness.")
//
// The Conversations row UI used to render `Updated {formatAgo(thread.updatedAt)}`
// and the page-level sort comparators used `b.updatedAt`. But
// `email_conversation_threads.updated_at` is a row-touched-by-anything clock
// (bumped by every background worker that touches the row) and is routinely
// hours-to-days off the actual conversation activity. Phase 1 replaced it
// with `lastEmailAt`, originally computed as MAX(email_messages.provider_sent_at)
// per page. Task #859 then promoted `lastEmailAt` to a permanent denormalized
// column on `email_conversation_threads` (kept in sync by `applyMessageToThread`
// + the freshness backfill), so the route-layer helper is now a passthrough —
// see Section 18 for the column / index / migration fences.
//
// These fences fail the build if anyone re-introduces a freshness label
// backed by `thread.updatedAt`, or removes `lastEmailAt` from the shared
// type / API enrichment.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 15. Conversations freshness fence (Phase 1) ─────────────────────\n");

const threadRowSrc = readFile("client/src/components/conversations/thread-row.tsx");
assert(
  "thread-row.tsx — does NOT render Updated <…thread.updatedAt> as a freshness label",
  !/formatAgo\s*\(\s*thread\.updatedAt\s*\)/.test(threadRowSrc),
  "Found `formatAgo(thread.updatedAt)` in thread-row.tsx — that label lies about freshness; use lastEmailAt / lastIncomingAt / lastOutgoingAt instead.",
);
assert(
  "thread-row.tsx — renders at least one real email-activity timestamp",
  /thread\.lastIncomingAt/.test(threadRowSrc) &&
    /thread\.lastOutgoingAt/.test(threadRowSrc) &&
    /thread\.lastEmailAt/.test(threadRowSrc),
  "thread-row.tsx must surface lastIncomingAt / lastOutgoingAt / lastEmailAt — those are the source-of-truth email-activity clocks.",
);

const conversationsTypesSrc = readFile("client/src/components/conversations/types.ts");
assert(
  "conversations/types.ts — declares lastEmailAt on ConversationThread",
  /\blastEmailAt\b\s*:\s*string\s*\|\s*null/.test(conversationsTypesSrc),
  "ConversationThread is missing `lastEmailAt: string | null` — the API ships it and the UI consumes it.",
);

const conversationsRouteSrc = readFile("server/routes/conversations.ts");
assert(
  "routes/conversations.ts — exposes computeLastEmailAtMap helper (Task #859 passthrough)",
  /computeLastEmailAtMap/.test(conversationsRouteSrc) &&
    /t\.lastEmailAt/.test(conversationsRouteSrc),
  "server/routes/conversations.ts must surface lastEmailAt via the computeLastEmailAtMap passthrough that reads the denormalized `lastEmailAt` column on email_conversation_threads (Task #859) — no per-page MAX() aggregate, no GREATEST() reconciliation.",
);
assert(
  "routes/conversations.ts — main list and my-waiting both ship lastEmailAt",
  (conversationsRouteSrc.match(/lastEmailAt:/g) ?? []).length >= 2,
  "Both /api/internal/conversations and /api/internal/conversations/my-waiting must return lastEmailAt on every thread row.",
);

const conversationsPageSrc = readFile("client/src/pages/conversations.tsx");
assert(
  "pages/conversations.tsx — sort comparators no longer key on raw thread.updatedAt for freshness",
  !/new Date\(\s*[ab]\.updatedAt\s*\)\.getTime\(\)\s*-\s*new Date\(\s*[ab]\.updatedAt\s*\)\.getTime\(\)/.test(conversationsPageSrc),
  "pages/conversations.tsx still sorts inbox rows by `b.updatedAt - a.updatedAt`. Sort by lastEmailAt ?? lastIncomingAt ?? lastOutgoingAt instead — see the recencyTs helper.",
);
assert(
  "pages/conversations.tsx — sort comparator uses the real-email-activity fallback chain",
  /lastEmailAt\s*\?\?\s*[a-zA-Z]+\.lastIncomingAt\s*\?\?\s*[a-zA-Z]+\.lastOutgoingAt/.test(conversationsPageSrc),
  "Sort must read lastEmailAt ?? lastIncomingAt ?? lastOutgoingAt so the row order matches what the row labels show.",
);

// Task #862 (QA polish) — the Quote requests sidebar count query MUST mirror
// the visible-list filter set. The list (buildParams, bucket === "quote_requests")
// sets only `signal=quote_request` and intentionally does NOT add
// `waitingState=waiting_on_us`, so the count query must do the same. The QA
// pass surfaced a 6× drift between the badge (waiting_on_us only) and the
// visible list (all signal=quote_request). This fence stops the
// `waiting_on_us` filter from creeping back into the count call.
{
  // Match only the literal URLSearchParams({...}) argument inside the
  // quote-request-count query — don't pull in surrounding comments
  // (which legitimately mention waitingState as documentation).
  const quoteCountQueryBlock = conversationsPageSrc.match(
    /quote-request-count[\s\S]*?new URLSearchParams\(\s*(\{[^}]*\})\s*\)/,
  );
  const quoteCountArgs = quoteCountQueryBlock?.[1] ?? "";
  assert(
    "pages/conversations.tsx — quote-request-count query mirrors the list filter (signal only, no waitingState)",
    !!quoteCountQueryBlock && !/waitingState/.test(quoteCountArgs),
    quoteCountQueryBlock
      ? "quote-request-count query has a `waitingState` filter that the visible list does NOT apply — the badge will diverge from what the rep sees in the bucket. Drop the waitingState param so the count matches the list (Task #862 polish)."
      : "Could not locate quote-request-count query block in conversations.tsx — guardrail layout drifted.",
  );
}

const waitingStateSrc = readFile("server/services/conversationWaitingStateService.ts");
assert(
  "conversationWaitingStateService — applyMessageToThread anchors timestamps to message.providerSentAt",
  /message\.providerSentAt\s*\?\?\s*now/.test(waitingStateSrc),
  "applyMessageToThread must prefer message.providerSentAt over wall-clock now() when stamping last_incoming_at / last_outgoing_at — otherwise mailbox backfills produce wall-of-now timestamps with no relationship to actual email activity.",
);

const runMigrationsSrc = readFile("server/runMigrations.ts");
assert(
  "runMigrations.ts — ships idempotent freshness backfill for last_incoming_at / last_outgoing_at",
  /conversations freshness backfill/.test(runMigrationsSrc) &&
    /MAX\(provider_sent_at\)\s+FILTER/.test(runMigrationsSrc),
  "runMigrations must heal email_conversation_threads.last_incoming_at / last_outgoing_at from MAX(email_messages.provider_sent_at) per direction. Without it, legacy rows render with the wrong timestamps until they next receive a message.",
);

// Task #898 — per-direction reconciliation lives in the thread backfill
// service AND runs on every boot. The runMigrations block (above) is the
// schema-migration backstop; this is the live read-write path that
// auto-corrects drift accumulated since the last boot from out-of-order
// ingestion (mailbox historical backfills, late webhooks) overwriting
// last_incoming_at / last_outgoing_at unconditionally inside
// applyMessageToThread. Both fences must hold.
const backfillSrc898 = readFile("server/services/conversationThreadBackfillService.ts");
assert(
  "conversationThreadBackfillService — exports reconcileThreadDirectionTimestamps (Task #898)",
  /export\s+async\s+function\s+reconcileThreadDirectionTimestamps\s*\(/.test(backfillSrc898),
  "Task #898 — conversationThreadBackfillService.ts must export `reconcileThreadDirectionTimestamps()` so the per-direction reconciliation pass is reachable from the boot path and admin tooling, not only from inside the runMigrations lifecycle.",
);
assert(
  "conversationThreadBackfillService — reconcile pass aggregates MAX(provider_sent_at) FILTER per direction",
  /MAX\([^)]*provider_sent_at[^)]*\)\s+FILTER\s*\(\s*WHERE\s+[a-z._]*direction\s*=\s*'inbound'\s*\)/i.test(backfillSrc898) &&
    /MAX\([^)]*provider_sent_at[^)]*\)\s+FILTER\s*\(\s*WHERE\s+[a-z._]*direction\s*=\s*'outbound'\s*\)/i.test(backfillSrc898),
  "Task #898 — reconcileThreadDirectionTimestamps must compute `MAX(provider_sent_at) FILTER (WHERE direction = 'inbound')` and the symmetric outbound aggregate, then write them into last_incoming_at / last_outgoing_at. That's the invariant the conversations-freshness regression suite asserts.",
);
{
  // Scope the row_version_at / updated_at check to the reconcile function
  // body so the assertion isn't satisfied by other writers in the same
  // file (e.g. reclassifyThreadsCustomerWins).
  const fnMatch = backfillSrc898.match(
    /export\s+async\s+function\s+reconcileThreadDirectionTimestamps[\s\S]*?\n\}\n/,
  );
  const fnBody = fnMatch?.[0] ?? "";
  assert(
    "conversationThreadBackfillService — reconcile pass bumps row_version_at (Task #860 contract)",
    /row_version_at\s*=\s*NOW\(\)/i.test(fnBody),
    "Task #898 — the reconcile pass is a denormalization sweep, not a real conversation event. It must bump `row_version_at = NOW()` so the audit clock advances on every touch.",
  );
  assert(
    "conversationThreadBackfillService — reconcile pass does NOT bump updated_at (Task #860 contract)",
    !/\bupdated_at\s*=\s*NOW\(\)/i.test(fnBody),
    "Task #898 — the reconcile pass must NOT write `updated_at = NOW()`. Per the Task #860 freshness contract, sweeps that aren't real conversation events keep `updated_at` untouched so the user-visible freshness signal stays honest.",
  );
}
const indexBootSrc898 = readFile("server/index.ts");
assert(
  "server/index.ts — invokes reconcileThreadDirectionTimestamps on boot (Task #898)",
  /reconcileThreadDirectionTimestamps\s*\(/.test(indexBootSrc898),
  "Task #898 — server/index.ts must call `reconcileThreadDirectionTimestamps()` during startup so any per-direction drift accumulated since the last boot is auto-corrected (idempotent). Without the boot wiring, the conversations-freshness regression suite's Phase 1 invariant degrades over time as out-of-order ingestion regresses the columns.",
);
const schedulerSrc898 = readFile("server/conversationThreadBackfillScheduler.ts");
assert(
  "conversationThreadBackfillScheduler — runs reconcileThreadDirectionTimestamps on every cadence (Task #898)",
  /reconcileThreadDirectionTimestamps\s*\(/.test(schedulerSrc898),
  "Task #898 — the periodic backfill scheduler must invoke `reconcileThreadDirectionTimestamps()` alongside the orphan-thread sweep so any per-direction drift introduced by ingestion paths that bypass `applyMessageToThread` (or by races between concurrent inserts on the same thread) is auto-corrected within at most one cadence interval. The boot pass alone leaves drift in place between restarts.",
);
const waitingStateSrc898 = readFile("server/services/conversationWaitingStateService.ts");
{
  const fnMatch = waitingStateSrc898.match(/export\s+function\s+applyMessageToThread[\s\S]*?\n\}\n/);
  const fnBody = fnMatch?.[0] ?? "";
  assert(
    "conversationWaitingStateService.applyMessageToThread — per-direction columns advance monotonically (Task #897 / #898)",
    /thread\.lastIncomingAt\?\.getTime\(\)/.test(fnBody) &&
      /thread\.lastOutgoingAt\?\.getTime\(\)/.test(fnBody) &&
      /sentAt?Ms\s*>=?\s*existing\w*Ms/.test(fnBody),
    "Task #897 / #898 — applyMessageToThread must guard the per-direction column writes with a monotonic comparison (`sentAtMs > existingIncomingMs` / `existingOutgoingMs`). Without the monotonic guard, an out-of-order replayed message (older provider_sent_at arriving AFTER a newer one for the same thread+direction) regresses last_incoming_at / last_outgoing_at below MAX(provider_sent_at), failing the conversations-freshness Phase 1 invariant.",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 16: Post-2d Quote Requests contract — schema + security invariants
// (Task #849 — locked contract: docs/quote-requests-tab-post-2d-backend-contract.md)
//
// S1 of the post-2d Quote Requests sprint widens three enums, adds a
// `snoozedUntil` column + partial index to `quote_opportunities`, and
// folds a §6.1 ownership-check security fix into the four mutation
// routes. These guardrails fail the build if any of those invariants
// regresses — they are the cheap fence keeping the contract from
// silently drifting.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 16. Post-2d Quote Requests contract — schema + security invariants ─────\n");

const sharedSchemaSrc = readFile("shared/schema.ts");
assert(
  "shared/schema.ts — QUOTE_OUTCOME_STATUSES contains 'attached'",
  /QUOTE_OUTCOME_STATUSES\s*=\s*\[[\s\S]*?"attached"[\s\S]*?\]\s*as\s+const/.test(sharedSchemaSrc),
  "QUOTE_OUTCOME_STATUSES is missing 'attached' — required by Task #849 §1.3 for the attach-to / mark-duplicate close-out path.",
);
assert(
  "shared/schema.ts — QUOTE_SOURCES contains 'email_signal' AND 'spot_search'",
  /QUOTE_SOURCES\s*=\s*\[[\s\S]*?"email_signal"[\s\S]*?"spot_search"[\s\S]*?\]\s*as\s+const/.test(sharedSchemaSrc),
  "QUOTE_SOURCES must include 'email_signal' and 'spot_search' — required by Task #849 §1.1 so the Confidence card and source filter rail can distinguish autopilot vs human-typed vs spot-search origins.",
);
{
  // CAPTURE_LEAK_REVIEW_DECISIONS must contain the full 7-value set
  // (4 originals: not_quote, ignored, attached, deferred — added by
  // #847 — plus 3 new from §1.2: returned_to_queue, duplicate,
  // not_a_request).
  const required = [
    "not_quote", "ignored", "attached", "deferred",
    "returned_to_queue", "duplicate", "not_a_request",
  ];
  const enumMatch = sharedSchemaSrc.match(
    /CAPTURE_LEAK_REVIEW_DECISIONS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
  );
  const body = enumMatch?.[1] ?? "";
  const missing = required.filter(v => !new RegExp(`"${v}"`).test(body));
  assert(
    "shared/schema.ts — CAPTURE_LEAK_REVIEW_DECISIONS contains the full 7-value set",
    missing.length === 0,
    missing.length > 0
      ? `Missing ${missing.join(", ")} — Task #849 §1.2 requires the post-2d additions on top of the existing Phase 2b 'deferred' value.`
      : undefined,
  );
}
assert(
  "shared/schema.ts — quote_opportunities.snoozed_until column + partial index declared",
  /snoozedUntil\s*:\s*timestamp\(\s*"snoozed_until"\s*\)/.test(sharedSchemaSrc) &&
    /quote_opportunities_snoozed_idx/.test(sharedSchemaSrc) &&
    /snoozed_until\s+IS\s+NOT\s+NULL/.test(sharedSchemaSrc),
  "quote_opportunities is missing the snoozed_until column or its partial index. Task #849 §2 requires both — the partial index keeps the column zero-cost for the unsnoozed default case while making 'list snoozed for org X' a sub-millisecond lookup.",
);

const runMigrationsForSourceBackfill = readFile("server/runMigrations.ts");
assert(
  "runMigrations.ts — ships the post-2d source backfill (quote_sources_v2_post2d)",
  /quote_sources_v2_post2d/.test(runMigrationsForSourceBackfill) &&
    /SET\s+source\s*=\s*'email_signal'/.test(runMigrationsForSourceBackfill) &&
    /SET\s+source\s*=\s*'spot_search'/.test(runMigrationsForSourceBackfill),
  "runMigrations must heal legacy quote_opportunities rows from the old 2-source world (email/manual) to the new typed sources (email_signal/spot_search) up-front. Without it, the Confidence card and source filter on the new tab show the wrong counts on first load.",
);

const customerQuotesRoutesSrc = readFile("server/routes/customerQuotes.ts");
assert(
  "customerQuotes.ts — defines and exports the assertCanMutateQuote(s) helper",
  /export\s+async\s+function\s+assertCanMutateQuotes/.test(customerQuotesRoutesSrc) &&
    /export\s+async\s+function\s+assertCanMutateQuote\b/.test(customerQuotesRoutesSrc),
  "Task #849 §6.1 — the ownership gate must live in customerQuotes.ts as an exported helper so the regression test can exercise the same predicate the routes use.",
);
{
  // Every one of the four mutation routes must reach for the helper.
  // Count the call-sites — the four routes each gate exactly once,
  // so any non-trivial deletion fails the count assertion.
  const callSites = (customerQuotesRoutesSrc.match(/\bassertCanMutateQuote[s]?\s*\(/g) ?? []).length;
  // 2 helper definitions + 4 route call-sites = 6.
  assert(
    "customerQuotes.ts — gate is wired into all four mutation routes (definitions + 4 call-sites)",
    callSites >= 6,
    `Found ${callSites} reference(s) to assertCanMutateQuote(s) — expected at least 6 (2 definitions + 4 route call-sites). Task #849 §6.1 requires the gate at PATCH /quote/:id, mark-outcome, bulk-reassign-customer, and bulk-status.`,
  );
}

// Section 17: Post-2d Quote Requests S2-S6 — operator endpoints, leakage
// classifier amendment, and quote-sender suppression schema (Task #849
// §3.1, §3.2, §3.3, §3.4, §3.5, §3.7).
console.log("\n── 17. Post-2d Quote Requests S2-S6 — endpoints / classifier / schema ────\n");

{
  const customerQuotesRoutes = readFile("server/routes/customerQuotes.ts");
  // §3.1 attach-to
  assert(
    "customerQuotes.ts — POST /quote/:id/attach-to route exists",
    /app\.post\(\s*"\/api\/customer-quotes\/quote\/:id\/attach-to"/.test(customerQuotesRoutes),
    "Task #849 §3.1 requires POST /api/customer-quotes/quote/:id/attach-to.",
  );
  // §3.2 send-to-leak
  assert(
    "customerQuotes.ts — POST /quote/:id/send-to-leak route exists",
    /app\.post\(\s*"\/api\/customer-quotes\/quote\/:id\/send-to-leak"/.test(customerQuotesRoutes),
    "Task #849 §3.2 requires POST /api/customer-quotes/quote/:id/send-to-leak.",
  );
  // §3.3 snooze
  assert(
    "customerQuotes.ts — PATCH /quote/:id/snooze route exists",
    /app\.patch\(\s*"\/api\/customer-quotes\/quote\/:id\/snooze"/.test(customerQuotesRoutes),
    "Task #849 §3.3 requires PATCH /api/customer-quotes/quote/:id/snooze.",
  );
  // All three reach for the ownership gate.
  const newRouteSegment = customerQuotesRoutes.slice(
    customerQuotesRoutes.indexOf("§3.1"),
  );
  if (newRouteSegment) {
    const gateCalls = (newRouteSegment.match(/\bassertCanMutateQuote[s]?\s*\(/g) ?? []).length;
    assert(
      "customerQuotes.ts — S2/S3/S4 routes all gate via assertCanMutateQuote",
      gateCalls >= 3,
      `Found ${gateCalls} ownership-gate call-sites in the post-2d S2-S4 routes — expected ≥3 (one per attach-to / send-to-leak / snooze).`,
    );
  }
}

{
  const customerQuotesSvc = readFile("server/services/customerQuotes.ts");
  for (const fn of ["attachQuoteToTarget", "sendQuoteToLeak", "snoozeQuote"] as const) {
    assert(
      `services/customerQuotes.ts — exports ${fn}`,
      new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`).test(customerQuotesSvc),
      `Task #849 §3.1-3.3 requires services/customerQuotes.ts to export ${fn}.`,
    );
  }
  assert(
    "services/customerQuotes.ts — attach-to and send-to-leak each use an in-process mutex",
    /_attachQuoteInFlight\s*=\s*new Map/.test(customerQuotesSvc) &&
      /_sendToLeakInFlight\s*=\s*new Map/.test(customerQuotesSvc),
    "Task #849 §3.1, §3.2 — duplicate-click protection requires per-key Map<string,Promise> mutexes mirroring the existing _leakAttachInFlight pattern.",
  );
  assert(
    "services/customerQuotes.ts — SNOOZE_QUOTE_LIMITS.MAX_FUTURE_MS = 14d",
    /SNOOZE_QUOTE_LIMITS[\s\S]*?MAX_FUTURE_MS\s*:\s*(?:SNOOZE_MAX_FUTURE_MS|14\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000)/.test(customerQuotesSvc) &&
      /SNOOZE_MAX_FUTURE_MS\s*=\s*14\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(customerQuotesSvc),
    "Task #849 §3.3 caps snoozedUntil at +14 days. Don't loosen this without updating the contract.",
  );
}

{
  // §3.4 automation-counters: route + 30s cache window.
  const conversationsLeakageSrc = readFile("server/routes/conversationsLeakage.ts");
  assert(
    "conversationsLeakage.ts — GET /api/quote-requests/automation-counters route exists",
    /\/api\/quote-requests\/automation-counters/.test(conversationsLeakageSrc),
    "Task #849 §3.4 requires GET /api/quote-requests/automation-counters.",
  );
  assert(
    "conversationsLeakage.ts — automation-counters honours the 30s freshness cap",
    /max-age=30(?!\d)/.test(conversationsLeakageSrc) ||
      /AUTOMATION_COUNTERS_TTL_MS\s*=\s*30[_\s]*000/.test(conversationsLeakageSrc),
    "Task #849 §3.4 caps the operator strip at 30s freshness so concurrent dashboards don't hammer the read path.",
  );
  const sourceRefMatches = (conversationsLeakageSrc.match(
    /qo\.source_reference\s*=\s*e\.provider_message_id/g,
  ) ?? []).length;
  assert(
    "conversationsLeakage.ts — §3.7 classifier amendment present in BOTH CTEs (window + top-domains)",
    sourceRefMatches >= 2,
    `Found ${sourceRefMatches} occurrence(s) of the source_reference fallback. Task #849 §3.7 requires the EXISTS clause in both computeWindow AND computeTopLeakingDomains so the leakage strip and the per-domain breakdown agree on what counts as "materialized".`,
  );
}

{
  // §3.5 send-thread-reply route.
  const conversationsRoutes = readFile("server/routes/conversations.ts");
  assert(
    "conversations.ts — POST /api/email-conversations/:threadId/reply route exists",
    /app\.post\(\s*"\/api\/email-conversations\/:threadId\/reply"/.test(conversationsRoutes),
    "Task #849 §3.5 requires POST /api/email-conversations/:threadId/reply (public path, not the /api/internal/conversations alias).",
  );
  assert(
    "conversations.ts — send-thread-reply gates the from-mailbox to a monitored mailbox",
    /from_mailbox_not_monitored/.test(conversationsRoutes),
    "Task #849 §3.5 — without the monitored-mailbox check, a reply could be sent through an unmanaged identity. Fail closed instead.",
  );
}

{
  // §3.2 quote-sender suppression schema.
  const senderMappingsSchema = readFile("shared/schema.ts");
  assert(
    "shared/schema.ts — quote_sender_mappings.suppressed boolean exists",
    /suppressed\s*:\s*boolean\(\s*"suppressed"\s*\)[\s\S]*?notNull\(\s*\)[\s\S]*?default\(\s*false\s*\)/.test(senderMappingsSchema),
    "Task #849 §3.2 — quote_sender_mappings needs a non-null `suppressed boolean default false` column.",
  );
  const senderMappingsSvc = readFile("server/services/quoteSenderMappings.ts");
  assert(
    "services/quoteSenderMappings.ts — lookupMapping filters suppressed=false",
    /lookupMapping[\s\S]*?suppressed/.test(senderMappingsSvc),
    "Task #849 §3.2 — lookupMapping must filter out suppression rows so they never route inbound mail to a customer.",
  );
  assert(
    "services/quoteSenderMappings.ts — exports findSuppressionMapping",
    /export\s+async\s+function\s+findSuppressionMapping\b/.test(senderMappingsSvc),
    "Task #849 §3.2 requires findSuppressionMapping so the ingestion path can short-circuit on suppression.",
  );
  const oppFromSignalSrc = readFile("server/services/quoteOpportunityFromSignalService.ts");
  assert(
    "services/quoteOpportunityFromSignalService.ts — processOneSignal short-circuits on findSuppressionMapping",
    /findSuppressionMapping/.test(oppFromSignalSrc),
    "Task #849 §3.2 — quoteOpportunityFromSignalService.processOneSignal must consult findSuppressionMapping after the internal-domain check so suppressed senders never materialize a quote opportunity.",
  );
}

// Section 18: Task #859 — Conversations date filter must anchor on the
// denormalized `last_email_at` column (single source of truth, kept in
// sync by applyMessageToThread + the freshness backfill), not the
// per-direction columns or a `GREATEST(...)` recomputation. Archived
// bucket keeps `archived_at`. Replaces Task #858's GREATEST predicate
// with a column read so the date filter and the row-label UI both look
// at the same value.
console.log("\n── 18. Conversations date filter — denormalized last_email_at column (Task #859) ─────\n");

{
  const schemaSrc = readFile("shared/schema.ts");
  assert(
    "shared/schema.ts — emailConversationThreads.lastEmailAt column exists",
    /lastEmailAt:\s*timestamp\(\s*"last_email_at"\s*\)/.test(schemaSrc),
    "Task #859 — shared/schema.ts must declare `lastEmailAt: timestamp(\"last_email_at\")` on emailConversationThreads.",
  );
  assert(
    "shared/schema.ts — (org_id, last_email_at DESC) index declared",
    /idx_ect_org_last_email_at/.test(schemaSrc),
    "Task #859 — the `idx_ect_org_last_email_at` index on (orgId, lastEmailAt DESC) must be declared in the table builder so the date filter / sort has an index to read.",
  );
}

{
  const migrationsSrc = readFile("server/runMigrations.ts");
  assert(
    "runMigrations.ts — adds last_email_at column with ADD COLUMN IF NOT EXISTS",
    /ADD COLUMN IF NOT EXISTS\s+last_email_at\s+timestamp/i.test(migrationsSrc),
    "Task #859 — runMigrations.ts must materialize `email_conversation_threads.last_email_at timestamp` so the live DB matches shared/schema.ts.",
  );
  assert(
    "runMigrations.ts — backfills last_email_at from MAX(provider_sent_at)",
    /last_email_at[\s\S]{0,800}MAX\(provider_sent_at\)/.test(migrationsSrc),
    "Task #859 — runMigrations.ts must heal `last_email_at` from MAX(email_messages.provider_sent_at) per thread.",
  );
  assert(
    "runMigrations.ts — drops the per-direction indexes Task #858 added",
    /DROP INDEX IF EXISTS\s+idx_ect_org_last_incoming_at/.test(migrationsSrc) &&
      /DROP INDEX IF EXISTS\s+idx_ect_org_last_outgoing_at/.test(migrationsSrc),
    "Task #859 — the `(org_id, last_incoming_at DESC)` / `(org_id, last_outgoing_at DESC)` indexes are no longer used and must be dropped.",
  );
  assert(
    "runMigrations.ts — creates the new (org_id, last_email_at DESC) index",
    /CREATE INDEX IF NOT EXISTS\s+idx_ect_org_last_email_at[\s\S]{0,200}org_id,\s*last_email_at\s+DESC/i.test(migrationsSrc),
    "Task #859 — the new `idx_ect_org_last_email_at` index must back the date filter / sort.",
  );
}

const storageSrcForDateFilter = readFile("server/storage.ts");
{
  const fnStart = storageSrcForDateFilter.indexOf("async listEmailConversationThreads");
  const sliceStart = fnStart >= 0 ? fnStart : 0;
  const body = storageSrcForDateFilter.slice(sliceStart, sliceStart + 25000);
  const filterBlock = body.match(/if\s*\(\s*filters\.dateFrom\s*\|\|\s*filters\.dateTo\s*\)[\s\S]{0,3000}/);
  assert(
    "storage.ts listEmailConversationThreads — has a unified date-filter block",
    !!filterBlock,
    "Could not locate the dateFrom/dateTo block in listEmailConversationThreads — Task #859 expects a single guarded block that branches on archivedOnly.",
  );
  if (filterBlock) {
    const block = filterBlock[0];
    assert(
      "storage.ts listEmailConversationThreads — non-archived date filter does NOT touch updatedAt",
      !/emailConversationThreads\.updatedAt/.test(block),
      "Found `emailConversationThreads.updatedAt` inside the date-filter block. Task #859: the non-archived path must anchor on `last_email_at`.",
    );
    assert(
      "storage.ts listEmailConversationThreads — non-archived date filter anchors on the denormalized last_email_at column",
      /emailConversationThreads\.lastEmailAt/.test(block),
      "The non-archived date filter must reference `emailConversationThreads.lastEmailAt` — Task #859's single source of truth.",
    );
    assert(
      "storage.ts listEmailConversationThreads — non-archived date filter does NOT recompute GREATEST(last_incoming_at, last_outgoing_at)",
      !/GREATEST/.test(block),
      "Task #859: the date filter must read the denormalized `last_email_at` column directly, not recompute `GREATEST(...)` on every query.",
    );
    assert(
      "storage.ts listEmailConversationThreads — Archived bucket still anchors on archived_at",
      /archivedAt/.test(block),
      "The archived branch of the date filter must keep using `archivedAt` — that bucket is *about* archive time.",
    );
  }
}

{
  // Task #859 — applyMessageToThread is the write-side guarantee that
  // `last_email_at` stays in sync with the per-direction columns. If
  // the function stops writing it, every new inbound/outbound stops
  // updating freshness and the date filter silently regresses.
  const waitingStateSrc = readFile("server/services/conversationWaitingStateService.ts");
  const fnMatch = waitingStateSrc.match(/export\s+function\s+applyMessageToThread[\s\S]{0,3000}/);
  assert(
    "conversationWaitingStateService.applyMessageToThread — assigns lastEmailAt",
    !!fnMatch && /update\.lastEmailAt\s*=/.test(fnMatch[0]),
    "Task #859 — applyMessageToThread must write `update.lastEmailAt` alongside the direction-specific column so the denormalized column stays in sync.",
  );
}

{
  // Task #859 — `conversationThreadBackfillService` materializes new
  // thread rows from the email_messages aggregate. Bare
  // `GREATEST(last_incoming_at, last_outgoing_at)` returns NULL in
  // Postgres if either side is NULL, so single-direction threads (only
  // inbound OR only outbound) would land with `last_email_at = NULL`
  // and silently disappear from the storage date filter. Both insert
  // sites must use the NULL-safe `GREATEST(COALESCE(a, b), COALESCE(b, a))`
  // shape; bare GREATEST(...) on the two raw direction columns is
  // forbidden.
  const backfillSrc = readFile("server/services/conversationThreadBackfillService.ts");
  assert(
    "conversationThreadBackfillService — does NOT use bare GREATEST(last_incoming_at, last_outgoing_at) for last_email_at",
    !/GREATEST\(\s*[a-zA-Z_.]*last_incoming_at\s*,\s*[a-zA-Z_.]*last_outgoing_at\s*\)/.test(backfillSrc),
    "Task #859 — bare `GREATEST(last_incoming_at, last_outgoing_at)` returns NULL when either side is NULL, leaving single-direction threads invisible to the date filter. Wrap each arm in COALESCE: `GREATEST(COALESCE(a, b), COALESCE(b, a))`.",
  );
  assert(
    "conversationThreadBackfillService — uses NULL-safe GREATEST(COALESCE(...)) for last_email_at",
    /GREATEST\(\s*COALESCE\([^)]*last_incoming_at[^)]*last_outgoing_at[^)]*\)\s*,\s*COALESCE\([^)]*last_outgoing_at[^)]*last_incoming_at[^)]*\)\s*\)/.test(
      backfillSrc.replace(/\s+/g, " "),
    ),
    "Task #859 — the new-thread insert SQL must seed `last_email_at` via `GREATEST(COALESCE(last_incoming_at, last_outgoing_at), COALESCE(last_outgoing_at, last_incoming_at))` so single-direction threads still land with a non-NULL value.",
  );
}

const conversationsRouteForTz = readFile("server/routes/conversations.ts");
assert(
  "routes/conversations.ts — exposes resolveLocalDayBound + accepts the `tz` query param",
  /resolveLocalDayBound/.test(conversationsRouteForTz) &&
    /\btz\b/.test(conversationsRouteForTz) &&
    /Intl\.DateTimeFormat/.test(conversationsRouteForTz),
  "Task #858 step 2 (timezone seam): the route layer must resolve `dateFrom`/`dateTo` to the rep's local-day boundary using a `tz` query param so an EDT 7pm 'Today' pick doesn't lop off the evening.",
);

// Section 19: Available Freight — pending_approval is the canonical status name
// (Phase A1). The producer (Won Load Autopilot) writes status="pending_approval";
// every consumer/filter site must use the same string. The typo
// `awaiting_approval` previously hid 100% of ingested rows from the default
// view; this fence prevents the regression. The freight_opportunities status
// column has no DB-level CHECK constraint, so a single typo silently zeroes
// the surface — only static analysis catches it.
console.log("\n── 19. Available Freight — canonical status name (Phase A1) ────────\n");

{
  const schemaSrc = readFile("shared/schema.ts");
  const enumMatch = schemaSrc.match(/FREIGHT_OPPORTUNITY_STATUSES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/);
  assert(
    "shared/schema.ts — FREIGHT_OPPORTUNITY_STATUSES enum exists",
    !!enumMatch,
    "Expected `export const FREIGHT_OPPORTUNITY_STATUSES = [...] as const` in shared/schema.ts.",
  );
  const enumMembers: string[] = enumMatch
    ? Array.from(enumMatch[1].matchAll(/"([a-z_]+)"/g)).map(m => m[1])
    : [];
  assert(
    "shared/schema.ts — enum contains the canonical 'pending_approval' member",
    enumMembers.includes("pending_approval"),
    `Found members: ${JSON.stringify(enumMembers)}`,
  );
  assert(
    "shared/schema.ts — enum does NOT contain the deprecated 'awaiting_approval' typo",
    !enumMembers.includes("awaiting_approval"),
    "If 'awaiting_approval' is added to the canonical enum, the producer in customerQuotes.ts must also be flipped — they cannot drift again.",
  );

  // Critical consumer/filter sites that historically held the `awaiting_approval`
  // typo or its variants. None of these may reference the typo as a status
  // value. (server/agent/tools.ts is *intentionally* excluded: it uses
  // `awaiting_approval` as a stable LLM-facing scope-keyword argument name —
  // not as a DB status string. The DB filter on that path uses the canonical
  // enum members via the status whitelist below it.)
  const CONSUMER_FILES = [
    "client/src/pages/available-freight.tsx",
    "client/src/lib/__tests__/cockpitFilters.test.ts",
    "server/freightOpportunityAutoPilot.ts",
    "server/services/todayQueue.ts",
    "server/routes/freightOpportunityCockpit.ts",
    "server/services/customerQuotes.ts",
  ];
  for (const rel of CONSUMER_FILES) {
    const src = readFile(rel);
    // Match the typo only when it appears as a quoted string literal
    // (status value), not in identifiers like `awaiting_approval_since`
    // (which is a legitimate column name) or in code comments. Lookahead
    // for the closing quote rules out the column-name false positive.
    const violations = src.match(/["']awaiting_approval["']/g);
    assert(
      `${rel} — no quoted "awaiting_approval" status literal`,
      !violations,
      violations
        ? `Found ${violations.length} occurrence(s) of "awaiting_approval" as a status string. The canonical name is "pending_approval" (see shared/schema.ts FREIGHT_OPPORTUNITY_STATUSES). Replace and re-run.`
        : undefined,
    );
  }

  // Producer-side sanity: customerQuotes.ts must continue to write
  // pending_approval into the freight_opportunities row. If a future
  // refactor accidentally drops the status field, the consumer-side
  // negative checks above would still pass (no typo) while the producer
  // silently writes the table default ("new"), so the SLA timer never
  // starts and the approval queue page goes empty in a different way.
  const customerQuotesSrc = readFile("server/services/customerQuotes.ts");
  assert(
    "server/services/customerQuotes.ts — Won Load Autopilot writes status: \"pending_approval\"",
    /status:\s*"pending_approval"/.test(customerQuotesSrc),
    "createFreightOpportunityFromWonQuote must continue to seed status=\"pending_approval\" so the approval SLA clock starts.",
  );

  // Consumer-side positive assertion: the Available Freight default
  // status filter must include pending_approval. This is the single
  // most-impactful regression fence in the file — a missing
  // pending_approval here hides every freshly-converted won quote.
  const cockpitPageSrc = readFile("client/src/pages/available-freight.tsx");
  const activeFilterMatch = cockpitPageSrc.match(/statusFilter\s*===\s*"active"\s*\?\s*"([^"]+)"/);
  assert(
    "client/src/pages/available-freight.tsx — \"active\" status filter exists",
    !!activeFilterMatch,
    "Could not locate the `statusFilter === \"active\" ? \"...\"` whitelist string in available-freight.tsx.",
  );
  if (activeFilterMatch) {
    const activeStatuses = activeFilterMatch[1].split(",").map(s => s.trim());
    assert(
      "client/src/pages/available-freight.tsx — \"active\" filter includes pending_approval",
      activeStatuses.includes("pending_approval"),
      `Active status filter is currently: ${JSON.stringify(activeStatuses)}. Won-quote-derived loads start in pending_approval and are invisible without it.`,
    );
    // Every member of the active filter must be a real enum member —
    // catches future typos at PR time even before they reach prod.
    const unknown = activeStatuses.filter(s => s.length > 0 && !enumMembers.includes(s));
    assert(
      "client/src/pages/available-freight.tsx — every \"active\" filter member is a known status",
      unknown.length === 0,
      `Unknown status string(s) in the active filter: ${JSON.stringify(unknown)}. Must be members of FREIGHT_OPPORTUNITY_STATUSES.`,
    );
  }
}

// Section 20: Available Freight — obvious-fake customer guard (Phase A2).
// The Won Load Autopilot will silently auto-create a `companies` row using
// whatever string lives in `quote_customers.name`. Greeting fragments parsed
// from inbound emails ("Thanks. BLAS Express Trucking"), the org's own brand
// ("Valuetruck"), and seed/test fixtures used to sneak through and pollute
// the cockpit. This fence makes sure the helper exists, the producer consults
// it before INSERTing into companies, and the one-shot DB strip in
// runMigrations stays in lockstep with the helper's predicates.
console.log("\n── 20. Available Freight — obvious-fake customer guard (Phase A2) ──\n");

{
  const helperSrc = readFile("shared/fakeCustomerName.ts");
  assert(
    "shared/fakeCustomerName.ts — helper exists",
    helperSrc.length > 0,
    "Expected shared/fakeCustomerName.ts (Phase A2) to exist.",
  );
  assert(
    "shared/fakeCustomerName.ts — exports isObviousFakeCustomerName",
    /export\s+function\s+isObviousFakeCustomerName\s*\(/.test(helperSrc),
    "isObviousFakeCustomerName(name, orgBrand?) is the canonical entry point producers must call.",
  );
  // The helper covers the four key buckets the audit identified: test/seed
  // prefixes, self-references against the org brand, greeting fragments
  // parsed from email signatures, and the placeholder bucket.
  assert(
    "shared/fakeCustomerName.ts — covers test/seed/demo prefixes",
    /test\|seed\|demo\|sample\|fixture\|example\|fake\|placeholder\|foo\|bar\|baz\|qux\|tbd\|tba/.test(helperSrc),
    "TEST_PREFIX_RX must enumerate the seed-prefix vocabulary.",
  );
  assert(
    "shared/fakeCustomerName.ts — covers greeting fragments (Thanks./Re:/Fwd:/etc)",
    /thanks\?\|thx\|regards\?\|cheers\|sincerely\|fwd\|re\|hi\|hello\|hey/.test(helperSrc),
    "GREETING_FRAGMENT_RX must catch the email-signature artefacts seen in production.",
  );
  assert(
    "shared/fakeCustomerName.ts — covers self-reference vs orgBrand",
    /self-reference/.test(helperSrc) && /normalizeForCompare|regexp_replace.*a-z0-9/i.test(helperSrc),
    "Helper must normalize the org's own brand name and reject customers that match it.",
  );

  // Producer-side: customerQuotes must consult the helper *before*
  // db.insert(companies). If a future refactor inserts the row without
  // checking, the strip migration cleans the past but new fakes flow in.
  const cqSrc = readFile("server/services/customerQuotes.ts");
  assert(
    "server/services/customerQuotes.ts — imports isObviousFakeCustomerName",
    /import\s*\{[^}]*isObviousFakeCustomerName[^}]*\}\s*from\s*["']@shared\/fakeCustomerName["']/.test(cqSrc),
    "Producer must import the helper from shared/fakeCustomerName.",
  );
  assert(
    "server/services/customerQuotes.ts — guard runs before db.insert(companies)",
    (() => {
      // The guard call must precede the companies insert in createFreight…WonQuote.
      const guardIdx = cqSrc.indexOf("isObviousFakeCustomerName(customerName");
      const insertIdx = cqSrc.indexOf("db.insert(companies)");
      return guardIdx > 0 && insertIdx > 0 && guardIdx < insertIdx;
    })(),
    "isObviousFakeCustomerName(customerName, orgBrand) must be called before db.insert(companies).",
  );

  // Migration-side: the one-shot strip in runMigrations must exist and
  // mirror the helper's predicates so the DB scrub stays consistent with
  // what the producer-side guard rejects going forward.
  const migSrc = readFile("server/runMigrations.ts");
  assert(
    "server/runMigrations.ts — Phase A2 fake-customer strip step is registered",
    /Phase A2 — one-shot strip of obvious-fake customer companies/.test(migSrc),
    "The one-shot strip step (cancels fake opps + archives fake companies) must be present in runMigrations.",
  );
  assert(
    "server/runMigrations.ts — strip imports FAKE_NAME_SQL_RULES from the helper (no JS↔SQL drift)",
    /import\s*\{[^}]*FAKE_NAME_SQL_RULES[^}]*\}\s*from\s*["']@shared\/fakeCustomerName["']/.test(migSrc) &&
      /FAKE_NAME_SQL_RULES\s*\.\s*map\b/.test(migSrc),
    "Migration must build the WHERE clause and reason CASE expression from the shared FAKE_NAME_SQL_RULES list. " +
      "Inline-duplicating regex literals here causes JS↔SQL drift the next time a rule changes (architect-flagged).",
  );
}

// Section 21: Available Freight — ingestion freshness pill (Phase A4).
// The cockpit feed must publish a `freshness` block (overall + per-producer)
// and the page header must render the pill so reps can spot a stalled feed
// at a glance instead of seeing a silently-empty cockpit. Three producers
// are wired: Won Load Autopilot, Available Freight Importer, and Manual.
console.log("\n── 21. Available Freight — ingestion freshness pill (Phase A4) ─────\n");

{
  const cockpitRouteSrc = readFile("server/routes/freightOpportunityCockpit.ts");
  assert(
    "server/routes/freightOpportunityCockpit.ts — feed includes `freshness` block",
    /const\s+freshness\s*=\s*\{/.test(cockpitRouteSrc) &&
      /res\.json\(\{[\s\S]*\bfreshness\b\s*,[\s\S]*\}\)/.test(cockpitRouteSrc),
    "Cockpit handler must build a `freshness` object and include it in res.json (shorthand `freshness,` is fine) so the header pill has data to render.",
  );
  // All three producer buckets must be wired or the pill loses a column
  // and stalled producers go invisible.
  for (const producer of ["won_load_autopilot", "available_freight_importer", "manual"]) {
    assert(
      `server/routes/freightOpportunityCockpit.ts — producer bucket "${producer}" present`,
      cockpitRouteSrc.includes(producer),
      `Freshness bucketing must enumerate all three producers; "${producer}" is missing.`,
    );
  }
  assert(
    "server/routes/freightOpportunityCockpit.ts — derives producer via source_quote_id / source_file_name",
    /sourceQuoteId/.test(cockpitRouteSrc) && /sourceFileName/.test(cockpitRouteSrc),
    "Producer detection must derive from sourceQuoteId (Won Load Autopilot) and sourceFileName (Importer).",
  );

  const pageSrc = readFile("client/src/pages/available-freight.tsx");
  // Task #871 — the FreshnessSignal type + pill component were extracted
  // into client/src/components/freight/freshness-pill.tsx so LWQ can reuse
  // them. The AF page imports the type and renders <FreshnessPill /> in
  // its header; the type declaration + stable testid live in the shared
  // module now.
  const freshnessPillSrc = readFile("client/src/components/freight/freshness-pill.tsx");
  assert(
    "client/src/components/freight/freshness-pill.tsx — declares FreshnessSignal type",
    /interface\s+FreshnessSignal\b/.test(freshnessPillSrc),
    "Shared FreshnessPill module must declare a FreshnessSignal type matching the server contract.",
  );
  assert(
    "client/src/pages/available-freight.tsx — imports FreshnessSignal from the shared pill module",
    /from\s+["']@\/components\/freight\/freshness-pill["']/.test(pageSrc)
      && /\bFreshnessSignal\b/.test(pageSrc),
    "AF page must import FreshnessSignal from the shared freshness-pill module so types stay in lock-step.",
  );
  assert(
    "client/src/pages/available-freight.tsx — renders the FreshnessPill in the header",
    /<FreshnessPill\s+signal=\{feed\?\.freshness\}\s*\/>/.test(pageSrc),
    "Header must render <FreshnessPill signal={feed?.freshness} /> so the user sees freshness on every page load.",
  );
  assert(
    "client/src/components/freight/freshness-pill.tsx — pill exposes data-testid='pill-freight-freshness'",
    /["']pill-freight-freshness["']/.test(freshnessPillSrc),
    "Stable testid required for end-to-end coverage of the freshness signal.",
  );
}

// Section 22: Available Freight — explained empty state (Phase A3).
// When the cockpit list is empty, the rep must see WHY instead of a generic
// "no rows" panel. The server publishes per-bucket hidden counts and the
// frontend renders them with one-click "clear filter" chips so the rep
// understands whether the queue is genuinely empty or just filtered down.
console.log("\n── 22. Available Freight — empty-state hidden counts (Phase A3) ────\n");

{
  const cockpitRouteSrc = readFile("server/routes/freightOpportunityCockpit.ts");
  assert(
    "server/routes/freightOpportunityCockpit.ts — feed includes `hiddenCounts` block",
    /const\s+hiddenCounts\s*=\s*\{/.test(cockpitRouteSrc) &&
      /res\.json\(\{[\s\S]*\bhiddenCounts\b\s*,[\s\S]*\}\)/.test(cockpitRouteSrc),
    "Cockpit handler must build a `hiddenCounts` object and include it in res.json so the empty-state hint can explain which filter dropped what.",
  );
  // All five hidden buckets must be wired or one of them silently shows
  // as undefined in the UI and the rep loses the explanation.
  for (const bucket of [
    "totalInScope",
    "byStatus",
    "bySnooze",
    "byPastPickup",
    "byLane",
    "byCarrier",
  ]) {
    assert(
      `server/routes/freightOpportunityCockpit.ts — hiddenCounts.${bucket} present`,
      new RegExp(`\\b${bucket}\\b`).test(cockpitRouteSrc),
      `hiddenCounts must populate ${bucket}; missing buckets break the empty-state UI.`,
    );
  }
  assert(
    "server/routes/freightOpportunityCockpit.ts — uses single org-scoped SQL aggregate (FILTER clauses)",
    /hidden_by_status[\s\S]*hidden_by_snooze[\s\S]*hidden_by_past_pickup/.test(cockpitRouteSrc) &&
      /COUNT\(\*\)\s+FILTER/.test(cockpitRouteSrc),
    "Hidden counts must be derived from a single org-scoped aggregate (COUNT FILTER) — not by paging the full table or trusting page-scoped arrays — or the numbers will lie at scale.",
  );
  assert(
    "server/routes/freightOpportunityCockpit.ts — past-pickup uses todayIsoInOrgTz",
    /substring\([\s\S]{0,80}pickupWindowStart[\s\S]{0,80}\)\s*<\s*\$\{todayIso\}/.test(cockpitRouteSrc) ||
      /todayIso[\s\S]{0,200}substring/.test(cockpitRouteSrc),
    "Past-pickup hidden count must compare against todayIso (org-local), matching the in-memory filter at lines 508-518; UTC comparison would mis-report at the date boundary.",
  );

  const pageSrc = readFile("client/src/pages/available-freight.tsx");
  assert(
    "client/src/pages/available-freight.tsx — declares hiddenCounts on CockpitResponse",
    /hiddenCounts\?:\s*\{[\s\S]*byStatus[\s\S]*byPastPickup[\s\S]*\}/.test(pageSrc),
    "Frontend type must declare hiddenCounts so the empty-state hint sees the server payload.",
  );
  assert(
    "client/src/pages/available-freight.tsx — empty state renders the hidden-counts panel",
    /data-testid="panel-hidden-counts"/.test(pageSrc),
    "Empty state must mount a panel with data-testid='panel-hidden-counts' so e2e tests can assert the rep sees the explanation.",
  );
  assert(
    "client/src/pages/available-freight.tsx — empty state exposes Clear status chip",
    /["']button-clear-status-filter["']/.test(pageSrc) &&
      /setStatusFilter\(\s*["']active["']\s*\)/.test(pageSrc),
    "Empty state must expose a one-click chip that resets the status filter back to the active queue.",
  );
  assert(
    "client/src/pages/available-freight.tsx — empty state offers Clear lane / Clear carrier chips",
    /["']button-empty-clear-lane["']/.test(pageSrc) &&
      /["']button-empty-clear-carrier["']/.test(pageSrc),
    "When a deep-link filter is responsible for the empty queue, the rep needs a one-click escape hatch for both lane and carrier filters.",
  );
  assert(
    "client/src/pages/available-freight.tsx — uses shared clearLaneFilter helper",
    /function\s+clearLaneFilter\s*\(/.test(pageSrc) &&
      /onClick=\{clearLaneFilter\}/.test(pageSrc),
    "The lane-clear behavior in the deep-link banner and the empty-state chip must share one helper so they cannot drift.",
  );
  assert(
    "client/src/pages/available-freight.tsx — empty state explains plain-language counts",
    /No freight matches your current filters/.test(pageSrc),
    "Empty-state headline must use plain language a rep would understand (no jargon like 'predicate' or 'where clause').",
  );
}

// Section 23: Won → Freight conversion failure audit (Phase A5).
// Stops the converter (createFreightOpportunityFromWonQuote) from silently
// dropping won quotes by writing every failure path into a dedicated
// audit table, then surfacing them on /admin/freight-conversion-failures
// with Retry + Mark-resolved actions and a health pill. The fence below
// pins the schema, the four logging insertions, the success-path
// auto-resolve, the runMigrations boot guard + backfill, the admin API
// registration, and the page route.
console.log("\n── 23. Won → Freight conversion failure audit (Phase A5) ────\n");

{
  const schemaSrc = readFile("shared/schema.ts");
  assert(
    "shared/schema.ts — declares freight_opportunity_capture_failures table",
    /export const freightOpportunityCaptureFailures\s*=\s*pgTable\("freight_opportunity_capture_failures"/.test(schemaSrc),
    "Table must exist or the converter has nowhere to write failures.",
  );
  for (const col of [
    "orgId", "quoteId", "reason", "detail",
    "errorMessage", "errorStack", "attemptedAt",
    "retryCount", "lastRetryAt", "lastRetryError",
    "resolvedAt", "resolvedById", "resolutionNote",
  ]) {
    assert(
      `shared/schema.ts — failure column ${col} present`,
      new RegExp(`\\b${col}\\b\\s*:`).test(schemaSrc),
      `Column ${col} powers the admin row + retry / resolve workflow.`,
    );
  }
  assert(
    "shared/schema.ts — partial unique index dedupes open failures per quote",
    /freight_opp_capture_failures_open_uq[\s\S]*?\.where\(sql`resolved_at IS NULL`\)/.test(schemaSrc),
    "Partial unique on (org_id, quote_id) WHERE resolved_at IS NULL keeps the converter from spawning duplicate open rows.",
  );
  assert(
    "shared/schema.ts — exports FREIGHT_CAPTURE_FAILURE_REASONS taxonomy",
    /FREIGHT_CAPTURE_FAILURE_REASONS\s*=\s*\[[\s\S]*"no_customer"[\s\S]*"fake_customer"[\s\S]*"company_create_failed"[\s\S]*"exception"[\s\S]*"backfill_orphan"[\s\S]*\]/.test(schemaSrc),
    "Reason taxonomy must list every code the converter writes — drift here corrupts admin filters.",
  );

  const cqSrc = readFile("server/services/customerQuotes.ts");
  assert(
    "server/services/customerQuotes.ts — exports recordCaptureFailure helper",
    /export async function recordCaptureFailure\(\s*orgId: string,\s*quoteId: string,\s*reason: FreightCaptureFailureReason,/.test(cqSrc),
    "Helper must exist for the four failure paths to call into.",
  );
  assert(
    "server/services/customerQuotes.ts — recordCaptureFailure upserts on the partial unique index",
    /ON CONFLICT \(org_id, quote_id\) WHERE resolved_at IS NULL/.test(cqSrc) &&
      /retry_count = freight_opportunity_capture_failures.retry_count \+ 1/.test(cqSrc),
    "ON CONFLICT … DO UPDATE bumps retry_count instead of inserting a duplicate open row.",
  );
  assert(
    "server/services/customerQuotes.ts — exports resolveOpenCaptureFailure helper",
    /export async function resolveOpenCaptureFailure\(/.test(cqSrc) &&
      /SET resolved_at = now\(\)/.test(cqSrc),
    "Auto-resolve helper must exist so successful conversions clear their open failures.",
  );
  for (const reason of [
    `"no_customer"`,
    `"fake_customer"`,
    `"company_create_failed"`,
    `"exception"`,
  ]) {
    assert(
      `server/services/customerQuotes.ts — recordCaptureFailure call wired with reason ${reason}`,
      new RegExp(`recordCaptureFailure\\([\\s\\S]{0,400}?${reason}`).test(cqSrc),
      `Failure path ${reason} must call recordCaptureFailure or it stays a silent drop.`,
    );
  }
  assert(
    "server/services/customerQuotes.ts — success path calls resolveOpenCaptureFailure",
    /if \(result\?\.id\) \{[\s\S]{0,200}resolveOpenCaptureFailure\(orgId, opp\.id, result\.id\)/.test(cqSrc),
    "Successful conversion must auto-resolve the open failure so the admin queue clears without a manual click.",
  );
  assert(
    "server/services/customerQuotes.ts — converter exception block logs before returning null",
    /catch \(err\) \{[\s\S]{0,400}AF handoff failed[\s\S]{0,400}recordCaptureFailure\([\s\S]{0,300}"exception"/.test(cqSrc),
    "Catch block must log an exception failure with stack so admins can diagnose; raw console-only logging is what the audit was built to replace.",
  );

  const migSrc = readFile("server/runMigrations.ts");
  assert(
    "server/runMigrations.ts — Phase A5 CREATE TABLE IF NOT EXISTS guard",
    /CREATE TABLE IF NOT EXISTS freight_opportunity_capture_failures/.test(migSrc) &&
      /CREATE UNIQUE INDEX IF NOT EXISTS freight_opp_capture_failures_open_uq[\s\S]{0,200}WHERE resolved_at IS NULL/.test(migSrc),
    "Boot must idempotently create the table + partial unique index — db:push alone is not the convention here.",
  );
  assert(
    "server/runMigrations.ts — Phase A5 backfills orphan won quotes",
    /WHERE qo\.outcome_status IN \('won', 'won_low_margin'\)[\s\S]{0,1500}ON CONFLICT \(org_id, quote_id\) WHERE resolved_at IS NULL/.test(migSrc),
    "Backfill must include both 'won' and 'won_low_margin' (the converter treats both as wins) and dedupe via the partial unique index.",
  );
  assert(
    "server/services/customerQuotes.ts — post-commit null branch logs a capture failure",
    /\.then\(async \(result\) => \{[\s\S]{0,400}if \(!result\) \{[\s\S]{0,400}recordCaptureFailure\([\s\S]{0,300}"exception"/.test(cqSrc),
    "Even when the transaction returns no row (driver returned nothing), the won quote must surface as a recoverable failure instead of a silent drop.",
  );

  const routesSrc = readFile("server/routes.ts");
  assert(
    "server/routes.ts — registers freight-conversion-failures routes",
    /registerFreightConversionFailuresRoutes\(app\)/.test(routesSrc) &&
      /from "\.\/routes\/freightConversionFailures"/.test(routesSrc),
    "Admin routes must be wired or the page falls back to 404.",
  );
  const apiSrc = readFile("server/routes/freightConversionFailures.ts");
  for (const route of [
    `"/api/admin/freight-conversion-failures"`,
    `"/api/admin/freight-conversion-failures/health"`,
    `"/api/admin/freight-conversion-failures/:id/retry"`,
    `"/api/admin/freight-conversion-failures/:id/resolve"`,
  ]) {
    assert(
      `server/routes/freightConversionFailures.ts — exposes ${route}`,
      apiSrc.includes(route),
      `Route ${route} powers the admin page; missing it breaks list / health / retry / resolve respectively.`,
    );
  }
  assert(
    "server/routes/freightConversionFailures.ts — admin gate on every endpoint",
    (apiSrc.match(/isAdmin\(me\?\.role\)/g) ?? []).length >= 4,
    "All four admin endpoints must check role === 'admin' before reading or writing.",
  );
  assert(
    "server/routes/freightConversionFailures.ts — retry accepts both won and won_low_margin",
    /quote\.outcomeStatus === "won" \|\| quote\.outcomeStatus === "won_low_margin"/.test(apiSrc),
    "Retry must mirror the converter's WON_STATUSES so low-margin wins aren't wrongly 409'd as 'not won'.",
  );

  const pageSrc = readFile("client/src/pages/admin-freight-conversion-failures.tsx");
  assert(
    "client/src/pages/admin-freight-conversion-failures.tsx — page mounted with data-testid",
    /data-testid="page-freight-conversion-failures"/.test(pageSrc),
    "Page root must be testable so e2e and the architect can find it.",
  );
  assert(
    "client/src/pages/admin-freight-conversion-failures.tsx — wires Retry + Mark-resolved actions",
    /button-retry-\$\{r\.id\}/.test(pageSrc) &&
      /button-resolve-\$\{r\.id\}/.test(pageSrc),
    "Per-row Retry and Mark-resolved buttons are the whole point of the page.",
  );
  assert(
    "client/src/pages/admin-freight-conversion-failures.tsx — plain-language healthy banner",
    /Won → Freight is healthy/.test(pageSrc) &&
      /no failures recorded/.test(pageSrc),
    "Empty-state and health banner must use the plain-language copy a non-engineer admin can scan in two seconds.",
  );
  const appSrc = readFile("client/src/App.tsx");
  assert(
    "client/src/App.tsx — registers /admin/freight-conversion-failures route",
    /path="\/admin\/freight-conversion-failures"\s+component=\{AdminFreightConversionFailuresPage\}/.test(appSrc),
    "Route must be wired or the admin page is unreachable.",
  );
}

// ── §24. Pickup-freshness scope semantics (Phase B1) ─────────────────────────
// Phase B1 replaces the blunt "every past pickup is hidden" rule in
// /available-freight with a status-driven "still open" rule plus an
// explicit per-row freshness label, so reps can answer the operator
// question: "Is this lane hidden because it is truly no longer
// actionable, or just because the current pickup-date logic is too
// blunt?". This section locks the new contract end-to-end:
//   • shared/pickupFreshness.ts exports the helper + scope enum
//   • cockpit feed reads pickupScope, returns it, and hides only
//     strictly-stale rows under the default scope
//   • hiddenCounts SQL exposes byPastStale + visiblePastPickupRecent
//   • UI renders the scope pill, the per-row "Pickup was Xd ago"
//     badge, and the new empty-state explainer copy
{
  const fresh = readFile("shared/pickupFreshness.ts");
  assert(
    "shared/pickupFreshness.ts — exports computePickupFreshness helper",
    /export\s+(?:const|function)\s+computePickupFreshness\b/.test(fresh),
    "Phase B1 requires a shared, dependency-free helper so server (filter) and client (label) cannot drift apart on what 'recent' vs 'stale' means.",
  );
  assert(
    "shared/pickupFreshness.ts — exports PICKUP_SCOPES with all three values",
    /export\s+const\s+PICKUP_SCOPES\b[\s\S]{0,200}upcoming[\s\S]{0,200}recent[\s\S]{0,200}all/.test(fresh),
    "PICKUP_SCOPES must include 'upcoming','recent','all' so the 3-way operator selector and the server param guard share one source of truth.",
  );
  assert(
    "shared/pickupFreshness.ts — exports DEFAULT_PICKUP_SCOPE = 'actionable'",
    /export\s+const\s+DEFAULT_PICKUP_SCOPE\b[^=]*=\s*['"]actionable['"]/.test(fresh),
    "Task #900 tightened the default scope from 'recent' to 'actionable' — the cockpit only surfaces today + future + past 24h still-open by default. Phase B1's older 'recent' default has been retired in favor of the actionable rule.",
  );
  assert(
    "shared/pickupFreshness.ts — exports PICKUP_GRACE_DAYS_DEFAULT (= 14)",
    /export\s+const\s+PICKUP_GRACE_DAYS_DEFAULT\s*=\s*14\b/.test(fresh),
    "Grace window default must be 14d so the empty-state copy ('>14d stale') and the SQL boundary cannot drift apart.",
  );
  assert(
    "shared/pickupFreshness.ts — exports shouldHideForPickup",
    /export\s+(?:const|function)\s+shouldHideForPickup\b/.test(fresh),
    "shouldHideForPickup() is the predicate the cockpit filter uses; required so server filter and client label agree on every row.",
  );

  const cockpit = readFile("server/routes/freightOpportunityCockpit.ts");
  assert(
    "server/routes/freightOpportunityCockpit.ts — imports the shared helper",
    /from\s+["']@shared\/pickupFreshness["']/.test(cockpit),
    "Cockpit must import the shared module so the freshness contract can't drift between server and client.",
  );
  assert(
    "server/routes/freightOpportunityCockpit.ts — reads pickupScope query param via guard",
    /isPickupScope\s*\(/.test(cockpit) && /pickupScope/.test(cockpit),
    "Cockpit must parse and validate pickupScope through the shared isPickupScope guard so unknown values fall back to the default instead of breaking the SQL.",
  );
  assert(
    "server/routes/freightOpportunityCockpit.ts — exposes pickupScope on the response",
    /res\.json\(\{[\s\S]{0,800}pickupScope\b/.test(cockpit),
    "The client needs the server-confirmed scope echoed back (and pickupGraceDays) so the UI pill shows what the server actually applied, not just what it requested.",
  );
  assert(
    "server/routes/freightOpportunityCockpit.ts — no unconditional past-pickup hard-hide",
    !/pickupIso\s*<\s*todayIso\s*\)\s*return\s+false/.test(cockpit)
      && !/substring\(opportunity\.pickupWindowStart, 1, 10\)\s*<\s*todayIso[\s\S]{0,80}return\s+false/.test(cockpit),
    "The legacy 'pickupIso < todayIso → return false' hard-hide must be gone; B1 routes the decision through shouldHideForPickup so the default scope keeps still-open past-pickup rows visible.",
  );
  assert(
    "server/routes/freightOpportunityCockpit.ts — tags each row with pickupFreshness",
    /pickupFreshness\s*[:=]/.test(cockpit) && /computePickupFreshness\s*\(/.test(cockpit),
    "Each enriched row must carry a server-derived freshness value so the UI can label without re-deriving (and so the label always matches the filter decision).",
  );
  assert(
    "server/routes/freightOpportunityCockpit.ts — tags each row with server-computed pickupDaysAgo",
    /pickupDaysAgo\s*[:=]/.test(cockpit) && /daysSincePickup\s*\(/.test(cockpit),
    "Per-row pickupDaysAgo must come from daysSincePickup(... , todayIso) so the client badge can't drift off-by-one from the server filter at the CT/UTC midnight rollover.",
  );
  assert(
    "server/routes/freightOpportunityCockpit.ts — visiblePastPickupRecent excludes stale (scope-independent)",
    /AND NOT \(\$\{isStaleSql\}\)[\s\S]{0,200}AS\s+visible_past_pickup_recent/.test(cockpit),
    "visible_past_pickup_recent must be defined as past AND NOT (stale) — wrapped in parens because SQL `NOT` binds tighter than `AND` and the bare `NOT pickupWindowStart IS NOT NULL AND ...` collapses to FALSE for every non-null row, silently zeroing the count.",
  );
  assert(
    "server/routes/freightOpportunityCockpit.ts — hiddenCounts SQL exposes byPastStale",
    /hidden_by_past_stale\b/.test(cockpit),
    "byPastStale must be its own FILTER aggregate so the empty-state 'M stale (>14d)' chip is stable across scope flips (Recent / Upcoming / All).",
  );
  assert(
    "server/routes/freightOpportunityCockpit.ts — hiddenCounts SQL exposes visiblePastPickupRecent",
    /visible_past_pickup_recent\b/.test(cockpit),
    "visiblePastPickupRecent powers the explainer 'N past-pickup loads stay visible because they're still actionable' — required so the rep doesn't think the queue is wrong.",
  );

  const page = readFile("client/src/pages/available-freight.tsx");
  assert(
    "client/src/pages/available-freight.tsx — sends pickupScope on the cockpit query",
    /params\.set\(\s*["']pickupScope["']\s*,\s*pickupScope\s*\)/.test(page),
    "Client must forward the operator's scope choice on every fetch, otherwise the UI 3-way pill is purely cosmetic.",
  );
  assert(
    "client/src/pages/available-freight.tsx — renders pill-pickup-scope header pill",
    /data-testid=["']pill-pickup-scope["']/.test(page)
      && /data-testid=["']select-pickup-scope["']/.test(page),
    "Header must show both the scope select (3-way) and the confirmation pill so the rep can flip Recent / Upcoming-only / All and see what's active.",
  );
  assert(
    "client/src/pages/available-freight.tsx — renders per-row pill-pickup-was-stale-{id}",
    /data-testid=\{`pill-pickup-was-stale-\$\{[^}]+\}`\}/.test(page),
    "Per-row badge is the answer to the operator question — without it, reps can't tell 'still actionable' apart from 'should be cleaned up'.",
  );
  assert(
    "client/src/pages/available-freight.tsx — empty state offers chip-stale-pickup escape hatch",
    /testId:\s*["']chip-stale-pickup["']/.test(page),
    "Empty state must give a one-click way to flip to scope=all so the rep can still review the stale tail when curious.",
  );
  assert(
    "client/src/pages/available-freight.tsx — empty state explainer text present",
    /Past-pickup loads with an open status now stay visible by default/.test(page)
      && /Switch to Upcoming only if you want the strict view/.test(page),
    "Plain-language explainer is the required UX hand-off — locks the operator-question answer into the empty state.",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section: Live-sync from polling fallback (Task #874)
// The Conversations page (`client/src/pages/conversations.tsx`) is "instant"
// only while `mailbox_inbound` / `mailbox_outbound` events keep flowing. Task
// #867 wired those events from the webhook path; Task #874 closed the gap on
// the polling-fallback path so a webhook outage doesn't degrade the page back
// to its 2-minute background-refetch cadence. Lock both halves of the contract:
//   1. mailboxDeltaSyncService.ts imports `publish` from `../services/liveSync`
//      and emits both topic strings.
//   2. processUserMailboxEmail returns a `{ created, direction }` shape so
//      callers can gate their emit on whether ingestion actually wrote a row
//      (idempotency — webhook + poll racing the same Graph id only emits once).
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Live-sync from polling fallback (Task #874) ──────────────────────\n");

const deltaSyncSrc = readFile("server/services/mailboxDeltaSyncService.ts");
assert(
  "mailboxDeltaSyncService — imports publish from ../services/liveSync",
  /import\s*\{\s*publish[^}]*\}\s*from\s*["']\.\.\/services\/liveSync["']/.test(deltaSyncSrc),
  "The polling path must import the live-sync publisher directly so a future refactor of the shared ingest helper cannot silently regress freshness.",
);
assert(
  "mailboxDeltaSyncService — emits the literal 'mailbox_inbound' topic",
  deltaSyncSrc.includes(`"mailbox_inbound"`),
  "Without this string the Conversations page only refreshes on its 2-minute background poll when webhooks are degraded.",
);
assert(
  "mailboxDeltaSyncService — emits the literal 'mailbox_outbound' topic",
  deltaSyncSrc.includes(`"mailbox_outbound"`),
  "SentItems-folder ingests must publish the outbound topic so threads update for the rep's own replies during a webhook outage.",
);
assert(
  "mailboxDeltaSyncService — gates publish on the helper's `created` flag",
  /if\s*\(\s*result\.created\s*\)/.test(deltaSyncSrc),
  "Idempotency: emit only when the persistence path actually wrote a new row, otherwise webhook + poll racing the same Graph id would double-emit.",
);
assert(
  "mailboxDeltaSyncService — wraps publish in try/catch (best-effort, never blocks ingest)",
  /try\s*\{\s*\n[^}]*publishLiveSync\(/.test(deltaSyncSrc) || /publishLiveSync\([\s\S]*?\)\s*;[\s\S]*?\}\s*catch\s*\(/m.test(deltaSyncSrc),
  "Live-sync is purely advisory — a publish failure must never throw and break the underlying ingest write.",
);

const graphWebhookSrc = readFile("server/routes/graphWebhook.ts");
assert(
  "graphWebhook — processUserMailboxEmail returns the UserMailboxIngestResult shape",
  /UserMailboxIngestResult/.test(graphWebhookSrc) &&
    /Promise<UserMailboxIngestResult>/.test(graphWebhookSrc),
  "Callers (webhook, delta-sync, self-heal) need a `created` signal to gate their live-sync publish on actual row insertion.",
);
assert(
  "graphWebhook — webhook caller publishes only when ingestResult.created is true",
  /ingestResult\.created/.test(graphWebhookSrc) &&
    /publishLiveSync\(/.test(graphWebhookSrc),
  "The webhook path also has to publish off the `created` flag now that the shared helper no longer auto-publishes.",
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 24: email_conversation_threads freshness contract (Task #860).
//
// Background sweeps used to bump `updated_at` on rows whose actual
// conversation activity hadn't changed (auto-archive cron + the
// classification reclassify pass were the loudest offenders). That made
// `updated_at` lie about freshness and forced every consumer to invent
// its own "did this row really change?" heuristic.
//
// The contract this section pins:
//   - `updated_at`     advances ONLY when the conversation itself
//                      changed in a way a rep would care about — a new
//                      email landed, the owner / waiting-state /
//                      priority / snooze flipped via a user action.
//   - `row_version_at` advances on every write (including sweeps,
//                      denormalization, and re-stamps) so the audit
//                      trail of touches stays debuggable.
//
// If anyone re-introduces an `updated_at` write inside the two known
// sweep call sites — or removes the column / migration / contract
// comment from the source of truth — this fails the build.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 24. Conversation threads freshness contract (Task #860) ─────────\n");

const schemaSrc860 = readFile("shared/schema.ts");
assert(
  "shared/schema.ts — emailConversationThreads declares rowVersionAt column",
  /rowVersionAt:\s*timestamp\(\s*["']row_version_at["']\s*\)\s*\.defaultNow\(\)\s*\.notNull\(\)/.test(schemaSrc860),
  "emailConversationThreads must own a `rowVersionAt: timestamp('row_version_at').defaultNow().notNull()` column — that's the audit clock sweeps write to instead of `updatedAt`.",
);
assert(
  "shared/schema.ts — insertEmailConversationThreadSchema omits rowVersionAt",
  /insertEmailConversationThreadSchema[\s\S]{0,400}\.omit\(\{[\s\S]*?rowVersionAt:\s*true/.test(schemaSrc860),
  "rowVersionAt is auto-managed (DEFAULT now() on insert, written explicitly by sweeps) — exclude it from the insert schema like createdAt/updatedAt.",
);
assert(
  "shared/schema.ts — documents the updated_at vs row_version_at contract inline",
  /Task #860/.test(schemaSrc860) && /row_version_at|rowVersionAt/.test(schemaSrc860) &&
    /sweep/i.test(schemaSrc860.slice(schemaSrc860.indexOf("Task #860"))),
  "shared/schema.ts must keep the inline contract comment (Task #860) explaining when updatedAt vs rowVersionAt advances — that comment is the single source of truth other writers reference.",
);

const runMigrationsSrc860 = readFile("server/runMigrations.ts");
assert(
  "runMigrations.ts — adds row_version_at column (idempotent)",
  /ADD COLUMN IF NOT EXISTS row_version_at\s+timestamp\s+NOT NULL\s+DEFAULT now\(\)/i.test(runMigrationsSrc860),
  "runMigrations must materialize email_conversation_threads.row_version_at with NOT NULL DEFAULT now(); without it, a fresh checkout boot will fail when sweep writers try to set the column.",
);
assert(
  "runMigrations.ts — seeds row_version_at from existing updated_at",
  /SET\s+row_version_at\s*=\s*updated_at[\s\S]{0,200}WHERE\s+row_version_at\s*<\s*updated_at/i.test(runMigrationsSrc860),
  "Historical rows need their row_version_at backfilled from updated_at so the audit clock never appears to run backwards relative to the user-visible clock immediately after deploy.",
);

const archiveSchedulerSrc = readFile("server/conversationArchiveScheduler.ts");
assert(
  "conversationArchiveScheduler.ts — auto-archive sweep does NOT bump updatedAt",
  !/updatedAt:\s*new Date\(\)/.test(archiveSchedulerSrc),
  "autoArchiveResolvedThreads is a background sweep, not a real conversation event. It must not write `updatedAt: new Date()` — use `rowVersionAt: new Date()` so the user-visible freshness signal stays honest.",
);
assert(
  "conversationArchiveScheduler.ts — auto-archive sweep DOES bump rowVersionAt",
  /rowVersionAt:\s*new Date\(\)/.test(archiveSchedulerSrc),
  "autoArchiveResolvedThreads must still touch `rowVersionAt` so the audit trail of archive sweeps remains debuggable.",
);

const reclassifySrc = readFile("server/services/conversationThreadBackfillService.ts");
assert(
  "conversationThreadBackfillService.ts — reclassify sweep does NOT write updated_at = NOW()",
  !/UPDATE\s+email_conversation_threads[\s\S]*?updated_at\s*=\s*NOW\(\)/i.test(reclassifySrc),
  "reclassifyThreadsCustomerWins is a denormalization sweep — it must write `row_version_at = NOW()` instead of `updated_at = NOW()` so freshness signals don't lie when classification runs.",
);
assert(
  "conversationThreadBackfillService.ts — reclassify sweep DOES write row_version_at = NOW() (both update steps)",
  (reclassifySrc.match(/row_version_at\s*=\s*NOW\(\)/gi) ?? []).length >= 2,
  "Both UPDATE steps in reclassifyThreadsCustomerWins (drop carrier id; promote linked_account_id from message evidence) must touch row_version_at so the audit clock advances even though updated_at intentionally stays put.",
);

// ── Snooze-wake routing — scheduler vs user split ────────────────────────────
const storageSrc860 = readFile("server/storage.ts");
assert(
  "storage.ts — IStorage exposes touchEmailConversationThreadInternal",
  /touchEmailConversationThreadInternal\s*\(/.test(storageSrc860),
  "Storage layer must expose `touchEmailConversationThreadInternal` so background sweeps and scheduler-driven state changes (e.g. snooze-wake) can update rows without bumping `updated_at`.",
);
{
  // Extract the `.set({...})` payload of touchEmailConversationThreadInternal
  // and assert it bumps row_version_at but NOT updated_at. The destructure
  // earlier in the function legitimately mentions `updatedAt:` (we strip
  // caller-supplied bumps), so we have to scope the check tightly to the SET.
  const fnMatch = storageSrc860.match(
    /async\s+touchEmailConversationThreadInternal\b[\s\S]*?\.set\(\s*(\{[\s\S]*?\})\s*\)/,
  );
  assert(
    "storage.ts — touchEmailConversationThreadInternal SET clause bumps rowVersionAt but NOT updatedAt",
    !!fnMatch &&
      /rowVersionAt\s*:/.test(fnMatch[1]) &&
      !/updatedAt\s*:/.test(fnMatch[1]),
    "touchEmailConversationThreadInternal must set `rowVersionAt` but NOT `updatedAt` — the whole point of the internal-touch path is to leave the user-visible freshness signal untouched. Found SET block: " +
      (fnMatch ? fnMatch[1].replace(/\s+/g, " ") : "<no .set() found>"),
  );
}

const waitingStateSrc860 = readFile("server/services/conversationWaitingStateService.ts");
assert(
  "conversationWaitingStateService.ts — exports separate wakeSnoozedThread + wakeSnoozedThreadInternal",
  /export\s+async\s+function\s+wakeSnoozedThread\s*\(/.test(waitingStateSrc860) &&
    /export\s+async\s+function\s+wakeSnoozedThreadInternal\s*\(/.test(waitingStateSrc860),
  "The user-initiated and scheduler-initiated wake paths must be distinct exported entry points so call sites can opt into the right freshness behaviour explicitly.",
);
assert(
  "conversationWaitingStateService.ts — wakeSnoozedThreadInternal writes via touchEmailConversationThreadInternal",
  /export\s+async\s+function\s+wakeSnoozedThreadInternal[\s\S]*?storageInstance\.touchEmailConversationThreadInternal\(/.test(waitingStateSrc860),
  "wakeSnoozedThreadInternal must write through the internal-touch storage method so scheduler wakes never bump `updated_at`.",
);
assert(
  "conversationWaitingStateService.ts — wakeSnoozedThread (user path) writes via updateEmailConversationThread",
  /export\s+async\s+function\s+wakeSnoozedThread\s*\([\s\S]*?\)\s*:\s*Promise<void>\s*\{[\s\S]*?storageInstance\.updateEmailConversationThread\(/.test(waitingStateSrc860),
  "wakeSnoozedThread (user-initiated) must continue to write through updateEmailConversationThread because a rep clicking 'wake now' IS a real conversation event.",
);

const archiveSchedulerSrc860 = readFile("server/conversationArchiveScheduler.ts");
assert(
  "conversationArchiveScheduler.ts — wakeExpiredSnoozes calls the scheduler-only wake variant",
  /wakeSnoozedThreadInternal\(/.test(archiveSchedulerSrc860) &&
    !/(?<![A-Za-z])wakeSnoozedThread\(/.test(archiveSchedulerSrc860),
  "wakeExpiredSnoozes runs every minute as a background cron — it must call wakeSnoozedThreadInternal, NEVER wakeSnoozedThread, otherwise every snooze-expiry would keep bumping updated_at and re-introduce the misleading-freshness bug.",
);

// ── Section 25: Leak Console daily snapshot scheduler (Task #880) ───────────
//
// The Manager Leak Console renders 14-day KPI sparklines. The on-read upsert
// in routes/leakConsole.ts only writes today's row when a manager visits, so
// any day with no manager visit, and any org with no manager activity, ends
// up missing from the trend table. Task #880 added a background scheduler
// that snapshots every org once at 23:55 UTC.
//
// This section pins:
//   1. The scheduler file exists and exports the public API.
//   2. snapshotAllOrgs iterates the organizations table (not just one org).
//   3. snapshotAllOrgs calls computeKpiCounts and upserts on (orgId, snapshotDate).
//   4. server/index.ts imports + invokes initLeakConsoleSnapshotScheduler.
//   5. routes/leakConsole.ts exposes the manual admin trigger.
//
// If any of these break, manager sparklines silently revert to flat lines and
// the regression won't surface in product until a manager opens the console
// and notices a missing day.

const snapshotSchedulerSrc = readFile("server/leakConsoleSnapshotScheduler.ts");
assert(
  "leakConsoleSnapshotScheduler.ts — exports initLeakConsoleSnapshotScheduler + snapshotAllOrgs",
  /export\s+function\s+initLeakConsoleSnapshotScheduler\s*\(/.test(snapshotSchedulerSrc) &&
    /export\s+async\s+function\s+snapshotAllOrgs\s*\(/.test(snapshotSchedulerSrc),
  "Both initLeakConsoleSnapshotScheduler (cron wiring) and snapshotAllOrgs (the work fn) must be exported. snapshotAllOrgs is reused by the admin manual-trigger endpoint and any future one-off backfill scripts.",
);
assert(
  "leakConsoleSnapshotScheduler.ts — iterates the organizations table (multi-org)",
  /from\(organizations\)/.test(snapshotSchedulerSrc),
  "snapshotAllOrgs must select from the organizations table to cover EVERY org, not just the requesting user's. The whole point of the scheduler is to fix the gap where the on-read upsert only covers the org of whoever visited.",
);
assert(
  "leakConsoleSnapshotScheduler.ts — calls computeKpiCounts per org",
  /computeKpiCounts\(/.test(snapshotSchedulerSrc),
  "Snapshot rows must come from the same KPI compute function the live KPI endpoint uses. Otherwise the scheduler can drift from what the page renders.",
);
assert(
  "leakConsoleSnapshotScheduler.ts — upserts on (orgId, snapshotDate) primary key",
  /onConflictDoUpdate/.test(snapshotSchedulerSrc) &&
    /leakConsoleDailySnapshot\.orgId/.test(snapshotSchedulerSrc) &&
    /leakConsoleDailySnapshot\.snapshotDate/.test(snapshotSchedulerSrc),
  "The scheduler must use onConflictDoUpdate against (orgId, snapshotDate) so multiple runs in the same UTC day collapse to one row, identical to the on-read upsert in routes/leakConsole.ts.",
);
assert(
  "leakConsoleSnapshotScheduler.ts — runs daily at 23:55 UTC",
  /cron\.schedule\(\s*["']55 23 \* \* \*["']/.test(snapshotSchedulerSrc),
  "Schedule must be 23:55 UTC daily — late enough to capture end-of-day, early enough that a slow run finishes before midnight rolls.",
);
assert(
  "leakConsoleSnapshotScheduler.ts — pins cron timezone to Etc/UTC",
  /timezone\s*:\s*["']Etc\/UTC["']/.test(snapshotSchedulerSrc),
  "node-cron defaults to host local timezone, which is not guaranteed to be UTC. The schedule string ('55 23 * * *') is interpreted in that local TZ — without an explicit `timezone: 'Etc/UTC'` option, snapshots can fire at the wrong wall-clock minute AND write a snapshotDate (always UTC via toISOString) that doesn't match the data they captured.",
);
assert(
  "leakConsoleSnapshotScheduler.ts — error handling per org (single bad org never aborts the run)",
  /try\s*\{[\s\S]*?computeKpiCounts[\s\S]*?\}\s*catch/.test(snapshotSchedulerSrc),
  "Each org must be wrapped in try/catch so one malformed org's data can't poison every other org's snapshot.",
);

const indexSrc880 = readFile("server/index.ts");
assert(
  "server/index.ts — imports + invokes initLeakConsoleSnapshotScheduler",
  /import\s*\{\s*initLeakConsoleSnapshotScheduler\s*\}\s*from\s*["']\.\/leakConsoleSnapshotScheduler["']/.test(indexSrc880) &&
    /initLeakConsoleSnapshotScheduler\(\)/.test(indexSrc880),
  "The scheduler is dead code unless it's wired into the boot sequence. Both the import and the call site must be present.",
);

const leakRoutesSrc880 = readFile("server/routes/leakConsole.ts");
assert(
  "routes/leakConsole.ts — exposes admin manual-trigger endpoint POST /api/admin/leak-console/snapshot-now",
  /["']\/api\/admin\/leak-console\/snapshot-now["']/.test(leakRoutesSrc880) &&
    /snapshotAllOrgs\(\)/.test(leakRoutesSrc880),
  "Admins must be able to force-write today's snapshot without waiting for the cron — needed for post-deploy verification and for backfilling today after a data fix.",
);
{
  // The snapshot-now endpoint runs across every org and surfaces per-org
  // error metadata. It MUST be gated by a strict platform-admin check,
  // not the broader managerial gate. Tenant-scoped managers (director,
  // sales_director, NAM, account_manager) cannot trigger cross-tenant
  // operations. Walk the route handler and verify it calls gateAdmin
  // (or some isAdmin(...) guard) before snapshotAllOrgs.
  const handlerMatch = leakRoutesSrc880.match(
    /app\.post\(\s*["']\/api\/admin\/leak-console\/snapshot-now["'][\s\S]*?\}\s*\);/,
  );
  assert(
    "routes/leakConsole.ts — snapshot-now endpoint gated by gateAdmin (NOT gateManager)",
    !!handlerMatch &&
      /gateAdmin\s*\(/.test(handlerMatch[0]) &&
      !/gateManager\s*\(/.test(handlerMatch[0]),
    "snapshotAllOrgs is cross-tenant — it writes to every org's snapshot table and returns org IDs in the response. Gating with the broader gateManager (which permits director / sales_director / NAM / account_manager) is broken access control. Use gateAdmin so only role === 'admin' can trigger it.",
  );
}
assert(
  "routes/leakConsole.ts — defines a gateAdmin helper distinct from gateManager",
  /function\s+gateAdmin\s*\([\s\S]*?isAdmin\s*\(/.test(leakRoutesSrc880),
  "A dedicated gateAdmin helper backed by isAdmin() must exist so cross-tenant operations have a single, auditable enforcement point. Inlining the role check at each call site invites drift.",
);

// ── Section 26: Lane Work Queue — Workflow OS conformance (Task #917) ───────
//
// LWQ adopted the canonical Workflow OS primitives in Task #917 (see
// docs/workflow-os-spec.md). These guardrails pin the page to the shared
// pieces so a future regression — someone re-introducing a local Owner
// Select, hand-rolling a pickup-scope union, or writing yet another
// `useState<Set<string>>` selection store — fails CI loudly instead of
// silently bit-rotting the cross-surface contract.
//
// What we assert:
//   1. The four shared primitives are imported (defence-in-depth alongside
//      the AST-level conformance suite in
//      client/src/lib/workflow-os/__tests__/conformance.test.ts).
//   2. Selection state goes through useRowSelection — no inline
//      useState<Set<string>>.
//   3. No local pickup-scope literal union (must reuse PickupScopeValue /
//      DEFAULT_PICKUP_SCOPE from shared/pickupFreshness).
//   4. URL filter round-trip uses serializeFiltersToUrl /
//      deserializeFiltersFromUrl from the shared savedViews module.
//   5. The work-queue query threads owner + pickupScope through the
//      queryKey so the cache splits per-filter (otherwise the cached
//      response would mask filter changes).

const lwqSrc917 = readFile("client/src/pages/lane-work-queue.tsx");

assert(
  "lane-work-queue.tsx — imports OwnerFilterSelect from the shared workflow-os module",
  /from\s+["'](?:@|[./]+)\/components\/workflow-os\/OwnerFilterSelect["']/.test(lwqSrc917),
  "LWQ must use the shared OwnerFilterSelect — local Selects would diverge from the cross-surface owner-filter contract (me / my_book / am_book / unassigned / specific user).",
);
assert(
  "lane-work-queue.tsx — imports PickupScopeSelect from the shared workflow-os module",
  /from\s+["'](?:@|[./]+)\/components\/workflow-os\/PickupScopeSelect["']/.test(lwqSrc917),
  "LWQ must use the shared PickupScopeSelect so the actionable / 14-days / all scope vocabulary stays identical across AF, LWQ, and Available Loads.",
);
assert(
  "lane-work-queue.tsx — imports StaleCountChip from the shared workflow-os module",
  /from\s+["'](?:@|[./]+)\/components\/workflow-os\/StaleCountChip["']/.test(lwqSrc917),
  "Hidden-stale escape hatch must come from the shared chip — it carries the contracted onShowAll behaviour and copy.",
);
assert(
  "lane-work-queue.tsx — imports BulkActionBar from the shared workflow-os module",
  /from\s+["'](?:@|[./]+)\/components\/workflow-os\/BulkActionBar["']/.test(lwqSrc917),
  "Bulk actions must render via the shared BulkActionBar so the canonical Reassign / Snooze / Outreach / Tag-Status grammar is preserved across surfaces.",
);
assert(
  "lane-work-queue.tsx — imports useRowSelection from the shared hooks module",
  /from\s+["'](?:@|[./]+)\/hooks\/workflow-os\/useRowSelection["']/.test(lwqSrc917),
  "Row selection must go through the shared useRowSelection hook so behaviours like Shift+click range, Ctrl+A, and clear-on-filter-change stay identical across surfaces.",
);
assert(
  "lane-work-queue.tsx — does not declare a local useState<Set<string>> selection store",
  !/useState<Set<string>>/.test(lwqSrc917),
  "Selection state must come from useRowSelection. A local `useState<Set<string>>` re-introduces the legacy selection model and bypasses the shared keyboard / clear / parity behaviours.",
);
assert(
  "lane-work-queue.tsx — does not hard-code a local pickup-scope literal union",
  !/["']actionable["']\s*\|\s*["']14_days["']/.test(lwqSrc917) &&
    !/["']actionable["']\s*\|\s*["']all["']/.test(lwqSrc917),
  "The pickup-scope vocabulary lives in shared/pickupFreshness as PickupScopeValue / PICKUP_SCOPES / DEFAULT_PICKUP_SCOPE. Re-declaring the union locally guarantees a future drift between server and client.",
);
assert(
  "lane-work-queue.tsx — uses serializeFiltersToUrl + deserializeFiltersFromUrl from savedViews",
  /serializeFiltersToUrl/.test(lwqSrc917) &&
    /deserializeFiltersFromUrl/.test(lwqSrc917) &&
    /from\s+["'](?:@|[./]+)\/lib\/workflow-os\/savedViews["']/.test(lwqSrc917),
  "URL <-> filter round-trip must reuse the shared serializer so saved-view URLs work uniformly across AF, LWQ, and Available Loads.",
);
{
  // The work-queue cache key MUST partition on owner + pickupScope.
  // Otherwise switching filters would return the previous cached payload
  // (bucket counts, cursor) until the 60s refetch fired — a nasty subtle
  // bug. We grep for the literal queryKey shape; the regex is permissive
  // about whitespace but pins the three canonical pieces.
  const m = lwqSrc917.match(
    /queryKey\s*:\s*\[\s*["']\/api\/recurring-lanes\/work-queue["']\s*,\s*\{[^}]*owner[^}]*pickupScope[^}]*\}\s*\]/,
  );
  assert(
    "lane-work-queue.tsx — work-queue queryKey threads owner + pickupScope",
    !!m,
    "The /api/recurring-lanes/work-queue useQuery must include { owner, pickupScope } in its queryKey so React Query splits the cache per filter combination. Without this, switching filters reads stale cached payloads.",
  );
}

// ── Section 27: Available Loads — Workflow OS conformance (Task #918) ──────
//
// Available Loads adopted the canonical Workflow OS owner + pickup-scope
// primitives in Task #918 (see docs/workflow-os-spec.md). These guardrails
// pin the page to the shared pieces so a future regression — someone re-
// introducing a local Owner Select, hand-rolling a pickup-scope union, or
// dropping the URL round-trip — fails CI loudly.
//
// Note: BulkActionBar + useRowSelection are NOT yet asserted here because
// Available Loads has no selection UI; that adoption is tracked under
// Task #902 (outreach workspace rollout). When #902 lands, mirror the
// LWQ assertions from Section 26.

const alSrc918 = readFile("client/src/pages/carrier-intelligence-available-loads.tsx");

assert(
  "carrier-intelligence-available-loads.tsx — imports OwnerFilterSelect from the shared workflow-os module",
  /from\s+["'](?:@|[./]+)\/components\/workflow-os\/OwnerFilterSelect["']/.test(alSrc918),
  "Available Loads must use the shared OwnerFilterSelect — local Selects would diverge from the cross-surface owner-filter contract (me / my_book / am_book / unassigned / specific user).",
);
assert(
  "carrier-intelligence-available-loads.tsx — imports PickupScopeSelect from the shared workflow-os module",
  /from\s+["'](?:@|[./]+)\/components\/workflow-os\/PickupScopeSelect["']/.test(alSrc918),
  "Available Loads must use the shared PickupScopeSelect so the actionable / 14-days / all scope vocabulary stays identical across AF, LWQ, and Available Loads.",
);
assert(
  "carrier-intelligence-available-loads.tsx — imports StaleCountChip from the shared workflow-os module",
  /from\s+["'](?:@|[./]+)\/components\/workflow-os\/StaleCountChip["']/.test(alSrc918),
  "Hidden-stale escape hatch must come from the shared chip — it carries the contracted onShowAll behaviour and copy.",
);
assert(
  "carrier-intelligence-available-loads.tsx — does not hard-code a local pickup-scope literal union",
  !/["']actionable["']\s*\|\s*["']14_days["']/.test(alSrc918) &&
    !/["']actionable["']\s*\|\s*["']all["']/.test(alSrc918),
  "The pickup-scope vocabulary lives in shared/workflowOs/actionability as PickupScopeValue / DEFAULT_PICKUP_SCOPE. Re-declaring the union locally guarantees a future drift between server and client.",
);
assert(
  "carrier-intelligence-available-loads.tsx — uses serializeFiltersToUrl + deserializeFiltersFromUrl from savedViews",
  /serializeFiltersToUrl/.test(alSrc918) &&
    /deserializeFiltersFromUrl/.test(alSrc918) &&
    /from\s+["'](?:@|[./]+)\/lib\/workflow-os\/savedViews["']/.test(alSrc918),
  "URL <-> filter round-trip must reuse the shared serializer so saved-view URLs work uniformly across AF, LWQ, and Available Loads.",
);
{
  // The available-loads cache key MUST partition on owner + pickupScope.
  // Without this, switching filters reads the prior cached payload until
  // the next refetch — a subtle leakage between filter slices.
  const m = alSrc918.match(
    /queryKey\s*:\s*\[\s*["']\/api\/carrier-intelligence\/available-loads["']\s*,\s*\{[^}]*owner[^}]*pickupScope[^}]*\}\s*\]/,
  );
  assert(
    "carrier-intelligence-available-loads.tsx — available-loads queryKey threads owner + pickupScope",
    !!m,
    "The /api/carrier-intelligence/available-loads useQuery must include { owner, pickupScope } in its queryKey so React Query splits the cache per filter combination. Without this, switching filters reads stale cached payloads.",
  );
}

// ── Section 28: Event-driven email→quote pipeline (Task #939) ──────────────
//
// The email→quote pipeline used to wait on a 2-minute scheduler tick before
// any inbound customer email got classified, deduped, and turned into a
// quote_opportunities row. Task #939 makes the live-ingest paths
// fire-and-forget the inline classifier the moment they persist a row, so
// the typical webhook→quote latency drops from minutes to seconds. These
// guardrails pin the contract:
//
//   1. The dispatcher module (`server/services/inlineEmailClassifier.ts`)
//      exists and exports the `dispatchInlineClassification` entry point.
//   2. Both live-ingest call sites — the Graph webhook handler and the
//      polling delta-sync service — import and call the dispatcher,
//      gated on `direction === "inbound"` + `messageId` (so duplicates
//      and outbound rep mail never spend OpenAI tokens).
//   3. `quoteEmailIngestion.ts` publishes the `customer_quote` live-sync
//      hint immediately after the quote row is inserted, so the Quote
//      Requests tab refreshes within ~50ms regardless of whether the
//      ingest came from the inline dispatcher or the recovery cron.
//   4. The historical 30-day backfill, the admin manual-drain handler,
//      the email pipeline ops routes, and the conversation reply-capture
//      service do NOT import the inline dispatcher. Those paths are
//      batch-shaped and would blow OpenAI quota if every row dispatched
//      inline; a future refactor that wires the dispatcher in there must
//      fail CI loudly here so the contract is renegotiated explicitly.
//   5. The 2-minute scheduler is reframed as a *recovery sweep* — both
//      the boot log and the per-batch log say so — to make it obvious in
//      production logs that the cron is the safety net, not the primary
//      path.

const inlineDispatcherPath939 = "server/services/inlineEmailClassifier.ts";
const inlineDispatcherSrc939 = readFile(inlineDispatcherPath939);

assert(
  "inlineEmailClassifier — exports dispatchInlineClassification",
  /export\s+function\s+dispatchInlineClassification\s*\(/.test(inlineDispatcherSrc939),
  "The webhook + delta-sync paths import this exact named function. Renaming or removing it silently disables the inline pipeline and reverts to the 2-min cron.",
);
assert(
  "inlineEmailClassifier — runs under a process-wide concurrency limit",
  /INLINE_CLASSIFY_MAX_INFLIGHT/.test(inlineDispatcherSrc939),
  "Without a semaphore, a webhook burst would hand thousands of concurrent OpenAI calls to extractEmailSignals at once and trigger the same rate-limit pile-up that Task #939 is meant to prevent.",
);
assert(
  "inlineEmailClassifier — applies a per-message wall clock + AbortController",
  /INLINE_CLASSIFY_TIMEOUT_MS/.test(inlineDispatcherSrc939) && /AbortController/.test(inlineDispatcherSrc939),
  "A stuck OpenAI call must not pin a semaphore slot forever; the wall-clock + abort signal is what bounds the dispatcher's worst-case latency.",
);

const graphWebhookSrc939 = readFile("server/routes/graphWebhook.ts");
assert(
  "graphWebhook — imports dispatchInlineClassification",
  /import\s*\{[^}]*dispatchInlineClassification[^}]*\}\s*from\s*["']\.\.\/services\/inlineEmailClassifier["']/.test(graphWebhookSrc939),
  "Without this import the webhook handler can't dispatch the inline classifier and we'd silently fall back to the 2-min recovery cron.",
);
assert(
  "graphWebhook — calls dispatchInlineClassification gated on inbound + messageId",
  /dispatchInlineClassification\s*\(\s*\{\s*messageId:\s*ingestResult\.messageId\s*\}\s*\)/.test(graphWebhookSrc939) &&
    /direction\s*===\s*["']inbound["']\s*&&\s*ingestResult\.messageId/.test(graphWebhookSrc939),
  "The dispatch must be gated on direction === 'inbound' && messageId so outbound rep replies and dedupe-skipped rows never enter the OpenAI pipeline.",
);
assert(
  "graphWebhook — UserMailboxIngestResult exposes messageId for the dispatcher",
  /messageId\??:\s*string/.test(graphWebhookSrc939) &&
    /return\s*\{\s*created:\s*true\s*,\s*direction\s*,\s*messageId:\s*message\.id/.test(graphWebhookSrc939),
  "The dispatcher needs the freshly-persisted row's primary key to load it; surfacing messageId from the ingest helper avoids a redundant DB lookup at the call site.",
);

const deltaSyncSrc939 = readFile("server/services/mailboxDeltaSyncService.ts");
assert(
  "mailboxDeltaSyncService — imports dispatchInlineClassification",
  /import\s*\{[^}]*dispatchInlineClassification[^}]*\}\s*from\s*["']\.\.\/services\/inlineEmailClassifier["']/.test(deltaSyncSrc939),
  "When the polling delta path wins the upsert race (webhook missed or delayed) it must still hand off to the inline classifier; otherwise polling-fallback regresses to 2-min latency.",
);
assert(
  "mailboxDeltaSyncService — calls dispatchInlineClassification gated on inbound + messageId",
  /dispatchInlineClassification\s*\(\s*\{\s*messageId:\s*result\.messageId\s*\}\s*\)/.test(deltaSyncSrc939) &&
    /result\.direction\s*===\s*["']inbound["']\s*&&\s*result\.messageId/.test(deltaSyncSrc939),
  "Same gating as the webhook path so the two ingest sites have identical inline-dispatch semantics.",
);

const quoteIngestSrc939 = readFile("server/services/quoteEmailIngestion.ts");
assert(
  "quoteEmailIngestion — publishes customer_quote live-sync after quote insert",
  /publish[^;]*customer_quote[^;]*opp\.id/.test(quoteIngestSrc939) ||
    /publishLiveSync\([^)]*orgId[^)]*,\s*["']customer_quote["']\s*,\s*opp\.id/.test(quoteIngestSrc939),
  "Without this publish the Quote Requests tab waits on its 30s React Query refetch even when the inline classifier just produced a quote — defeating the whole point of going event-driven.",
);

// Backfill / admin-drain isolation. These four files run on bulk-shaped
// batch flows; importing the inline dispatcher there would route a 30-day
// backfill through the live-pipeline limiter and burn OpenAI quota for
// rows that don't need real-time treatment.
for (const isolatedPath of [
  "server/services/mailboxHistoricalBackfillService.ts",
  "server/routes/emailPipelineOps.ts",
  "server/routes/conversations.ts",
  "server/services/conversationReplyCaptureService.ts",
]) {
  const fullPath = path.join(ROOT, isolatedPath);
  if (!fs.existsSync(fullPath)) {
    // The file may have been renamed; the guardrail is still meaningful
    // for the ones that exist. Note this in the output so a renamer can
    // re-anchor the assertion deliberately.
    console.log(`  · skip ${isolatedPath} — file not found (re-anchor this assertion if intentional)`);
    continue;
  }
  const src = fs.readFileSync(fullPath, "utf-8");
  assert(
    `${isolatedPath} — does NOT import dispatchInlineClassification (backfill / drain isolation)`,
    !/dispatchInlineClassification/.test(src) &&
      !/from\s*["'][^"']*inlineEmailClassifier["']/.test(src),
    "Backfill + admin manual-drain are batch-shaped and intentionally bypass the inline pipeline. If you genuinely need inline-style behavior on one of these paths, build a separate batch-aware dispatcher rather than reusing the live one — that decision should be a deliberate code review, not an accidental import.",
  );
}

const schedulerSrc939 = readFile("server/emailIntelligenceScheduler.ts");
assert(
  "emailIntelligenceScheduler — boot log advertises 'recovery sweep' framing",
  /starting recovery sweep/.test(schedulerSrc939),
  "The 2-min cron is now the recovery safety net for the inline pipeline. Re-framing the boot log makes that obvious in production logs and prevents a future on-call from concluding 'this cron is doing the work' when the dispatcher is silently broken.",
);
assert(
  "emailIntelligenceScheduler — per-batch log calls itself a recovery sweep",
  /recovery sweep:.*unprocessed message\(s\) the inline dispatcher did not handle/.test(schedulerSrc939),
  "Anything this batch picks up is by definition something the inline path missed. The log should say so explicitly so backlog spikes are immediately attributable.",
);

// Watchdog classification-lag alert (Task #939 health metric).
const watchdogSrc939 = readFile("server/services/mailboxWatchdogService.ts");
assert(
  "mailboxWatchdogService — runs the per-tick classification-lag check",
  /export\s+async\s+function\s+runClassificationLagCheck\s*\(/.test(watchdogSrc939),
  "The classification-lag metric is what tells admins the inline dispatcher is silently behind (e.g. OpenAI 5xx storm). Removing the per-tick check would degrade observability of exactly the regression Task #939 was meant to prevent.",
);
assert(
  "mailboxWatchdogService — fires `classification_lag` alert key",
  /["']classification_lag["']/.test(watchdogSrc939),
  "The alert key must stay stable so the open-alerts dedupe ledger and the admin notification fan-out keep matching across deploys.",
);
assert(
  "mailboxWatchdogService — requires consecutive lagging ticks before firing",
  /CLASSIFICATION_LAG_CONSECUTIVE_TICKS/.test(watchdogSrc939),
  "A single transient blip (large attachment, brief 429) must not page admins. Requiring N consecutive ticks at the 1-min cadence guarantees the lag is a real regression, not an isolated retry.",
);

const monitoredMailboxesSrc939 = readFile("server/routes/monitoredMailboxes.ts");
assert(
  "/api/admin/mailbox-health — surfaces classificationLag in the summary",
  /classificationLag\s*:\s*\{[^}]*oldestAgeSeconds/.test(monitoredMailboxesSrc939),
  "The admin health UI reads classificationLag.oldestAgeSeconds to render the inline-pipeline lag tile next to the per-mailbox health. Dropping this field reverts the admin to the old 'no idea why my quotes aren't showing' state.",
);

// ── 28. Live-sync auth + health probe (Task #951) ──────────────────────────
// Pins the SSE auth contract that fixed the prod regression where
// Conversations stopped auto-updating: the route MUST accept a Clerk JWT
// in the ?token= query (because EventSource cannot set Authorization
// headers), and the watchdog MUST run a per-tick health probe so the
// next regression of this kind fires an alert instead of waiting for a
// rep to complain.
console.log("\n── 28. Live-sync auth + health probe (Task #951) ────────────");

const liveSyncRouteSrc951 = readFile("server/routes/liveSync.ts");
assert(
  "routes/liveSync.ts — accepts ?token= query for Clerk JWT (EventSource can't set headers)",
  /qOptStr\(req\.query\.token\)/.test(liveSyncRouteSrc951) &&
    /verifyToken/.test(liveSyncRouteSrc951),
  "Without `?token=` + verifyToken the SSE endpoint reverts to header-only auth, EventSource can't authenticate, and Conversations silently falls back to the 120s poll. This was the exact prod regression.",
);
assert(
  "routes/liveSync.ts — does NOT use requireAuth middleware (header-only path is broken for SSE)",
  // Detect real usage (import or middleware mount), not comment references.
  !/import[^;]*\brequireAuth\b/.test(liveSyncRouteSrc951) &&
    !/\brequireAuth\s*[,)]/.test(liveSyncRouteSrc951),
  "`requireAuth` enforces an Authorization Bearer header; EventSource can only send cookies. Re-mounting this middleware re-introduces the prod bug.",
);
assert(
  "routes/liveSync.ts — records auth outcome on every connect for the watchdog",
  /recordLiveSyncAuthOutcome\(\s*orgId\s*!==\s*null\s*[,)]/.test(liveSyncRouteSrc951),
  "If the route stops feeding the rolling auth-outcome ring, the live_sync_auth_failure watchdog goes blind and the next auth regression will only surface as rep complaints.",
);

// The /api/* global middleware MUST bypass requireAuth for the SSE
// stream — otherwise the route's `?token=` handler never runs and every
// EventSource gets 401'd before reaching `verifyToken`. This was the
// post-deploy regression on 2026-05-03 that left Conversations dead in
// the water even after the route-level fix shipped.
const routesIndexSrc951 = readFile("server/routes.ts");
assert(
  "routes.ts — global /api requireAuth bypasses /live-sync/stream",
  /req\.path\s*===\s*["']\/live-sync\/stream["']\s*\)\s*return\s+next\(\)/.test(
    routesIndexSrc951,
  ),
  "Without this bypass, the global app.use('/api', requireAuth) at the top of registerRoutes intercepts every SSE connect and rejects it with 401 before the live-sync route's Clerk-token verification can run. Conversations falls back to the 120s poll. Same user-visible symptom as the original bug, different layer.",
);

const liveSyncSvcSrc951 = readFile("server/services/liveSync.ts");
assert(
  "services/liveSync.ts — exports recordLiveSyncAuthOutcome + getLiveSyncAuthStats",
  /export\s+function\s+recordLiveSyncAuthOutcome\s*\(/.test(liveSyncSvcSrc951) &&
    /export\s+function\s+getLiveSyncAuthStats\s*\(/.test(liveSyncSvcSrc951),
  "These are the two-sided contract between the SSE route (writes outcomes) and the watchdog (reads the rolling window). Either side missing breaks the auth-failure alert.",
);
assert(
  "services/liveSync.ts — exports getLastMailboxPublishAt for silent-stream detection",
  /export\s+function\s+getLastMailboxPublishAt\s*\(/.test(liveSyncSvcSrc951),
  "The silent-stream watchdog compares mailbox ingest recency against the most recent mailbox_inbound/_outbound publish per org. Removing this getter blinds the silent-stream alert.",
);
assert(
  "services/liveSync.ts — publish() records last-publish-at for mailbox topics",
  /_lastPublishByOrgTopic\.set\(`\$\{orgId\}::\$\{topic\}`/.test(liveSyncSvcSrc951),
  "Without the per-(org, topic) timestamp set, getLastMailboxPublishAt always returns null and the silent-stream alert can never resolve.",
);

const watchdogSrc951 = readFile("server/services/mailboxWatchdogService.ts");
assert(
  "mailboxWatchdogService — exposes runLiveSyncHealthCheck",
  /export\s+async\s+function\s+runLiveSyncHealthCheck\s*\(/.test(watchdogSrc951),
  "The per-tick live-sync probe is the alarm the user explicitly asked for: 401/403 storms must fire loudly, not be discovered by reps complaining.",
);
assert(
  "mailboxWatchdogService — fires `live_sync_auth_failure` alert key",
  /["']live_sync_auth_failure["']/.test(watchdogSrc951),
  "Stable alert key keeps the dedupe ledger and notification fan-out aligned across deploys.",
);
assert(
  "mailboxWatchdogService — fires `live_sync_silent_stream` alert key",
  /["']live_sync_silent_stream["']/.test(watchdogSrc951),
  "Detects future regressions where a write path forgets to call publish() — same user-visible symptom (Conversations stops updating) but a different root cause from the auth failure.",
);
assert(
  "mailboxWatchdogService — requires consecutive failing ticks before paging admins",
  /LIVE_SYNC_AUTH_CONSECUTIVE_TICKS/.test(watchdogSrc951) &&
    /LIVE_SYNC_SILENT_CONSECUTIVE_TICKS/.test(watchdogSrc951),
  "A single transient blip (one bad tick of token-refresh races) must not page admins. Requiring N consecutive ticks at the 1-min cadence guarantees the condition is real.",
);
assert(
  "mailboxWatchdogService — wires runLiveSyncHealthCheck into runWatchdogCycle",
  /runLiveSyncHealthCheck\s*\(\s*mailboxes/.test(watchdogSrc951),
  "Defining the function but not calling it from the cron is dead code. The probe must run every tick to be the early-warning the user asked for.",
);

// ── Section 29: Customer-Quote pipeline observability (Task #952) ──────────
//
// Pre-Task #952, every email→quote attempt that the inline classifier or
// the ingestion stage decided not to capture was a SILENT skip — the only
// signal was a rep noticing missing rows in /quote-requests. Task #952
// introduces a durable, replayable record (`quote_pipeline_drops`) of
// every such skip + a watchdog probe that pages admins on a stalled
// pipeline. These guardrails pin the contract so a future refactor can't
// silently revert to the old "drop on the floor" behavior.
//
//   1. The four skip branches in `quoteEmailIngestion.ts` MUST persist a
//      drop row before returning.
//   2. The classifier-miss + ingest-exception branches in
//      `inlineEmailClassifier.ts` MUST persist a drop row before silently
//      moving on to the next message.
//   3. Both helpers MUST be best-effort try/catch — a drops-table outage
//      cannot break customer-quote capture.
//   4. The admin endpoints + page MUST exist.
//   5. The watchdog MUST run a per-tick quote-pipeline probe + fire two
//      stable alert keys (zero_capture, classifier_outage).
console.log("\n── 29. Customer-Quote pipeline observability (Task #952) ────");

const ingestSrc952 = readFile("server/services/quoteEmailIngestion.ts");
assert(
  "quoteEmailIngestion — defines recordIngestionDrop helper",
  /async\s+function\s+recordIngestionDrop\s*\(/.test(ingestSrc952),
  "The ingestion-stage drops helper is the only sink that records `outbound`/`duplicate`/`unparseable` skips. Removing it re-introduces the silent-drop bug.",
);
for (const reason of ["outbound", "duplicate", "unparseable"]) {
  assert(
    `quoteEmailIngestion — wires recordIngestionDrop("${reason}")`,
    new RegExp(`recordIngestionDrop\\([^)]*["']${reason}["']`).test(ingestSrc952),
    `The ${reason} skip branch in ingestQuoteFromEmail must record a drop row so an admin can see why the email never became a quote and trigger a reprocess after a fix lands.`,
  );
}
assert(
  "quoteEmailIngestion — recordIngestionDrop is best-effort (try/catch around storage write)",
  /async\s+function\s+recordIngestionDrop[\s\S]{0,3000}try\s*\{[\s\S]{0,3000}storage\.recordQuotePipelineDrop[\s\S]{0,3000}\}\s*catch/.test(ingestSrc952),
  "A failure writing to quote_pipeline_drops MUST NOT bubble — capture-side metrics outage cannot block customer-quote capture, which is the higher-priority contract.",
);

const classifierSrc952 = readFile("server/services/inlineEmailClassifier.ts");
assert(
  "inlineEmailClassifier — defines recordClassificationDrop helper",
  /async\s+function\s+recordClassificationDrop\s*\(/.test(classifierSrc952),
  "Mirror of recordIngestionDrop for the earlier classification stage. Removing it loses visibility into the classifier_miss + exception cases — exactly the cases an OpenAI prompt regression would surface as.",
);
for (const reason of ["classifier_miss", "exception"]) {
  assert(
    `inlineEmailClassifier — wires recordClassificationDrop("${reason}")`,
    new RegExp(`recordClassificationDrop\\([^)]*["']${reason}["']`).test(classifierSrc952),
    `The ${reason} branch in classifyOne must record a drop row so admins can trend the rate (catches classifier regressions) and replay individual messages after a fix.`,
  );
}
assert(
  "inlineEmailClassifier — recordClassificationDrop is best-effort (try/catch around storage write)",
  /async\s+function\s+recordClassificationDrop[\s\S]{0,3000}try\s*\{[\s\S]{0,3000}storage\.recordQuotePipelineDrop[\s\S]{0,3000}\}\s*catch/.test(classifierSrc952),
  "Same contract as the ingestion-side helper: a metrics-write failure cannot break inline classification.",
);

const quotePipelineRoutesSrc952 = readFile("server/routes/quotePipelineHealth.ts");
for (const endpoint of ["/funnel", "/health", "/drops"]) {
  assert(
    `routes/quotePipelineHealth.ts — registers GET ${endpoint}`,
    new RegExp(`app\\.get\\(\\s*["']/api/admin/quote-pipeline${endpoint.replace(/\//g, "\\/")}["']`).test(quotePipelineRoutesSrc952),
    `The admin operator console reads ${endpoint}. Removing or renaming it breaks the page silently (it'll show "Failed to load…" instead of pipeline data).`,
  );
}
for (const action of ["reprocess", "resolve"]) {
  assert(
    `routes/quotePipelineHealth.ts — registers POST drops/:id/${action}`,
    new RegExp(`app\\.post\\(\\s*["']/api/admin/quote-pipeline/drops/:id/${action}["']`).test(quotePipelineRoutesSrc952),
    `The ${action} action is what makes drops actionable. Without it the page becomes a read-only ticker and admins have no way to clear the queue.`,
  );
}

const routesIndexSrc952 = readFile("server/routes.ts");
assert(
  "routes.ts — mounts registerQuotePipelineHealthRoutes",
  /registerQuotePipelineHealthRoutes\s*\(\s*app\s*\)/.test(routesIndexSrc952),
  "The route module exists but is not wired in. Mount it so /admin/quote-pipeline-health can fetch data.",
);

const watchdogSrc952 = readFile("server/services/mailboxWatchdogService.ts");
assert(
  "mailboxWatchdogService — exposes runQuotePipelineHealthCheck",
  /export\s+async\s+function\s+runQuotePipelineHealthCheck\s*\(/.test(watchdogSrc952),
  "The per-tick quote-pipeline probe is the early-warning system for `pipeline silently captured zero quotes`. Without it, the next regression of the kind Task #952 fixes would only surface as customer complaints.",
);
for (const key of ["quote_pipeline_zero_capture", "quote_pipeline_classifier_outage"]) {
  assert(
    `mailboxWatchdogService — fires \`${key}\` alert key`,
    new RegExp(`["']${key}["']`).test(watchdogSrc952),
    "Stable alert keys keep the dedupe ledger and admin notification fan-out aligned across deploys.",
  );
}
assert(
  "mailboxWatchdogService — wires runQuotePipelineHealthCheck into runWatchdogCycle",
  /runQuotePipelineHealthCheck\s*\(\s*mailboxes/.test(watchdogSrc952),
  "Defining the probe but not calling it from the cron is dead code. The probe must run every tick to be the alarm.",
);
assert(
  "mailboxWatchdogService — requires consecutive ticks before firing quote-pipeline alerts",
  /QUOTE_PIPELINE_CONSECUTIVE_TICKS/.test(watchdogSrc952),
  "A single transient blip (e.g. brief OpenAI 5xx during a quiet hour) must not page admins. Consecutive-tick gating ensures the condition is a real regression.",
);

const schemaSrc952 = readFile("shared/schema.ts");
assert(
  "shared/schema.ts — defines quotePipelineDrops table",
  /export\s+const\s+quotePipelineDrops\s*=\s*pgTable\(\s*["']quote_pipeline_drops["']/.test(schemaSrc952),
  "The drops table is the durable record of every silent skip. Removing it reverts the entire Task #952 hardening pass to the old fire-and-forget behavior.",
);
assert(
  "shared/schema.ts — exports QUOTE_PIPELINE_DROP_REASONS enum with all 5 reasons",
  /QUOTE_PIPELINE_DROP_REASONS\s*=\s*\[[^\]]*classifier_miss[^\]]*outbound[^\]]*duplicate[^\]]*unparseable[^\]]*exception/.test(schemaSrc952),
  "The reason enum is the join key between the writers (ingestion + classifier helpers) and the readers (funnel endpoint + filter UI). Adding/removing reasons must be deliberate.",
);

// SSE freshness — consumer side. The producer (publishLiveSync on
// `customer_quote` after a quote insert) is already pinned in Section 28.
// This pins the OTHER half of the contract: the Quote Requests page must
// subscribe to that topic, otherwise the publish lands on a topic with no
// listeners and the page silently waits on its 30s React Query refetch
// — exactly the user-visible regression Task #952 is hardening against.
const quoteRequestsPageSrc952 = readFile("client/src/pages/quote-requests.tsx");
assert(
  "client/src/pages/quote-requests.tsx — subscribes to customer_quote live-sync topic",
  /useLiveSync\(\s*\[[^\]]*["']customer_quote["']/.test(quoteRequestsPageSrc952),
  "The producer (publishLiveSync on customer_quote in quoteEmailIngestion.ts) is meaningless without a subscriber on the page. Removing this subscription reverts the page to ~30s React Query latency and re-introduces the perceived 'silent drop' regression Task #952 is hardening against.",
);

// Defensive numeric handling on the classification-side helper. The
// `quote_pipeline_drops.confidence` column is decimal(5,4) so the max
// value is 9.9999. OpenAI extraction occasionally returns a confidence
// > 1 (or NaN/Infinity) which would otherwise crash the classifier on
// what is supposed to be a best-effort metrics write — defeating the
// "no silent drops" contract by introducing a NEW silent drop.
assert(
  "inlineEmailClassifier — clamps confidence to [0,1] and rejects non-finite values",
  /Number\.isFinite\(opts\.confidence\)/.test(classifierSrc952) &&
    /Math\.max\(\s*0\s*,\s*Math\.min\(\s*1\s*,\s*opts\.confidence/.test(classifierSrc952),
  "decimal(5,4) max is 9.9999 — an OpenAI hallucination of e.g. 12.3 would overflow. The classifier MUST normalize the value before storing or the metrics-write side-effect becomes a primary-path crash.",
);

// Reprocess endpoint — stage-aware replay. The admin reprocess action is
// only meaningful if a `classifier_miss` drop is replayed through the
// classifier (not just through the ingest stage), because the live path
// is classify → ingest. A reprocess that calls ingest directly on a
// classification-stage drop would silently skip the very logic the drop
// flagged, and the operator would never see the missing quote even
// after a prompt fix lands.
assert(
  "inlineEmailClassifier — exports replayClassificationForReprocess for admin replay",
  /export\s+async\s+function\s+replayClassificationForReprocess\s*\(/.test(classifierSrc952),
  "The admin reprocess path needs a synchronous classification-stage replay primitive. Without it, classifier_miss drops can only be replayed through ingest — defeating the purpose of recording them.",
);
assert(
  "routes/quotePipelineHealth.ts — reprocess branches on drop.stage to pick replay primitive",
  /drop\.stage\s*===\s*["']classification["']/.test(quotePipelineRoutesSrc952) &&
    /replayClassificationForReprocess/.test(quotePipelineRoutesSrc952),
  "A `classifier_miss` drop replayed via ingestQuoteFromEmail alone would skip the classifier entirely — the operator would think the prompt fix worked when in fact ingest just hit the same dead-end signals. The reprocess route MUST branch on drop.stage so classification drops go through the classifier and ingestion drops bypass it.",
);
assert(
  "storage — exposes findQuoteOpportunityByMessageRef for replay confirmation",
  /findQuoteOpportunityByMessageRef\s*\(\s*orgId:\s*string\s*,\s*messageRef:\s*string\s*,?\s*\)/.test(
    readFile("server/storage.ts"),
  ),
  "After a classification replay, the route needs a deterministic way to ask 'did a quote actually appear for this message?' so it can auto-resolve the drop. Without this lookup, every successful classifier replay leaves the drop open and the operator has to manually resolve it.",
);

// ── 28b. Live-sync auth resolver shares the email back-fill (Task #958) ────
// In production we observed `/api/live-sync/stream` returning 401 ~50/min
// for users whose `users.clerk_user_id` was still NULL — the SSE auth
// resolver was looking up users by clerkUserId only, while every other
// authenticated /api route went through `requireAuth → getCurrentUser`,
// which performs an email-based back-fill and writes `clerk_user_id` on
// first sign-in. The two paths MUST share the same Clerk-→-DB resolver
// (or contain the same back-fill logic inline) — otherwise this exact
// failure mode silently returns the next time someone refactors the SSE
// resolver. See `server/auth.ts: resolveClerkUserToDbUser` and
// `server/__tests__/liveSyncResolveOrgId.test.ts`.
console.log("\n── 28b. Live-sync auth resolver shares the email back-fill (Task #958) ────────────");

assert(
  "auth.ts — exports resolveClerkUserToDbUser helper",
  /export\s+async\s+function\s+resolveClerkUserToDbUser\s*\(/.test(readFile("server/auth.ts")),
  "The shared Clerk → DB resolver was extracted so the SSE auth path can inherit the email back-fill that requireAuth/getCurrentUser already performs. Removing the export forces the SSE path back to a clerkUserId-only lookup, which 401s every user whose DB row hasn't been linked yet.",
);

assert(
  "auth.ts — getCurrentUser delegates Clerk resolution to the shared helper (no duplicate back-fill)",
  /if\s*\(\s*clerkUserId\s*\)\s*\{\s*return\s+resolveClerkUserToDbUser\s*\(\s*clerkUserId\s*\)\s*;\s*\}/.test(
    readFile("server/auth.ts"),
  ),
  "If getCurrentUser keeps its own copy of the back-fill logic, the two implementations will drift the next time someone updates the email-link semantics — and the SSE path will silently regress.",
);

assert(
  "routes/liveSync.ts — resolveOrgId calls resolveClerkUserToDbUser (NOT storage.getUserByClerkId directly)",
  /resolveClerkUserToDbUser\s*\(\s*clerkUserId\s*\)/.test(liveSyncRouteSrc951) &&
    !/storage\.getUserByClerkId\s*\(/.test(liveSyncRouteSrc951),
  "The SSE resolver must use the shared helper so users whose `users.clerk_user_id` is still NULL get auto-linked the same way they would on any other /api route. A direct `storage.getUserByClerkId(...)` lookup re-introduces the prod regression where Conversations stops auto-updating until the user happens to hit a non-SSE /api route first.",
);

assert(
  "routes/liveSync.ts — verifyToken failures are no longer silently swallowed",
  /catch\s*\([^)]*\)\s*\{[\s\S]*?(console\.warn|console\.error)\s*\(/.test(liveSyncRouteSrc951),
  "When token verification fails (issuer mismatch, expired, bad signature) we have to log the cause — silently dropping the error is what made the original prod regression invisible until reps complained. At minimum a warn-level log inside the verify catch is required.",
);

// ─────────────────────────────────────────────────────────────────────────────
// Section: Reply-To header gated on live shared-mailbox subscription (Task #959)
//
// Background — production was emitting `Reply-To: <OUTLOOK_REPLY_EMAIL>` on every
// carrier-outreach email regardless of whether the shared mailbox actually existed
// in the Microsoft 365 tenant. When the mailbox was misspelled / unprovisioned
// (the Ops@valuetruck.com 404 incident), every carrier reply bounced into a
// non-existent mailbox and was silently lost — the rep never saw the reply.
//
// The fix: each of the three carrier-outreach send paths must consult
// `replyTrackingEnabled()` (the live "Mail.Read granted AND subscription active"
// signal) before adding the `Reply-To` header. When the shared subscription is
// dormant, fall back to no Reply-To so replies hit the sending rep's own
// monitored mailbox instead. This guardrail catches a regression that goes
// back to "Reply-To whenever env var is set".
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 959. Reply-To header gated on live shared-mailbox subscription ───\n");

const replyToGatedFiles: Array<{ path: string; label: string }> = [
  { path: "server/routes/laneCarrierOutreach.ts",         label: "lane carrier outreach (LWQ)" },
  { path: "server/routes/procurementOutreach.ts",         label: "procurement outreach" },
  { path: "server/freightOpportunityOutreachService.ts",  label: "freight opportunity outreach" },
];

for (const { path: relPath, label } of replyToGatedFiles) {
  const src = readFile(relPath);

  // Each path must call replyTrackingEnabled() before computing the Reply-To.
  // Static check: the file must reference replyTrackingEnabled() (covers both
  // top-level imports and lazy `await import("./graphSubscriptionService")`).
  assert(
    `${relPath} — ${label} consults replyTrackingEnabled() before adding Reply-To`,
    /replyTrackingEnabled\s*\(\s*\)/.test(src),
    "Without the live-subscription gate, a stale OUTLOOK_REPLY_EMAIL silently swallows every carrier reply",
  );

  // The legacy "Reply-To = env var, period" pattern must be gone. We refuse
  // any direct `outlookReplyTo = process.env.OUTLOOK_REPLY_EMAIL?.trim() || null`
  // assignment — the env var must flow through the gating ternary instead.
  assert(
    `${relPath} — ${label} does NOT assign Reply-To directly from OUTLOOK_REPLY_EMAIL without the gate`,
    !/const\s+outlookReplyTo\s*=\s*process\.env\.OUTLOOK_REPLY_EMAIL\?\.trim\(\)\s*\|\|\s*null\s*;/.test(src),
    "Reply-To must be gated on replyTrackingEnabled(), not on the raw env var",
  );

  // The gated form must compute Reply-To via the conditional.
  assert(
    `${relPath} — ${label} resolves Reply-To via the sharedReplyActive ternary`,
    /sharedReplyActive\s*\?\s*sharedReplyMailbox\s*:\s*null/.test(src),
    "The Reply-To value must be `sharedReplyActive ? sharedReplyMailbox : null` so a dormant subscription falls back to no Reply-To",
  );

  // Admins need to see the degradation when it fires — log a one-liner so
  // "carrier replies stopped landing" is debuggable from server logs.
  assert(
    `${relPath} — ${label} logs a fallback warning when the shared subscription is dormant`,
    /sharedReplyMailbox\s*&&\s*!sharedReplyActive[\s\S]{0,200}console\.(warn|log|error)/.test(src),
    "Without the log line, admins have no breadcrumb that the fallback path engaged",
  );
}

// The readiness panel must not flip to OK on the mere presence of the env var
// — it has to cross-check the live Mail.Read consent / probe state. That's the
// row-level fence on the same regression.
const readinessSrc = readFile("server/routes/monitoredMailboxes.ts");
assert(
  "monitoredMailboxes.ts — reply_mailbox readiness row checks consent.status (not just env var presence)",
  /id:\s*"reply_mailbox"[\s\S]{0,1500}consent\.status/.test(readinessSrc),
  "Without this cross-check, a misspelled / unprovisioned OUTLOOK_REPLY_EMAIL keeps the row green while the shared subscription is permanently dormant",
);
assert(
  "monitoredMailboxes.ts — reply_mailbox row surfaces the 404-not-found case as an error",
  /id:\s*"reply_mailbox"[\s\S]{0,1500}not\\s\+found/.test(readinessSrc),
  "404 ErrorInvalidUser from the Graph probe must mark the row as error so admins see the misconfiguration",
);

// ── Section 30: email_messages canonical write path ────────────────────────
// Lock the invariant exposed during the inbound-email persistence incident:
// there must be EXACTLY ONE canonical write path into `email_messages` for
// Graph traffic — `storage.upsertInboundEmailMessage` (called from
// `processUserMailboxEmail` in `server/routes/graphWebhook.ts`). The only
// other production-code insert is the manual capture-leak attach action in
// `server/routes/conversations.ts`. Tests are excluded.
//
// If a future PR adds a third `db.insert(emailMessages)` call (especially
// one that hard-codes `direction='outbound'` or skips field validation),
// this assertion fires before the regression can ship.
console.log("\n── Section 30: email_messages canonical write path ──────────────────\n");

(function pinCanonicalEmailMessagesWritePath() {
  const inserts: string[] = [];
  const InsertPattern = /db\.insert\(emailMessages\)/g;
  function scan(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Exclude test directories (their fixtures legitimately seed rows).
        if (entry.name === "__tests__") continue;
        scan(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const rel = path.relative(ROOT, full);
      const content = fs.readFileSync(full, "utf-8");
      const matches = content.match(InsertPattern);
      if (matches) {
        for (let i = 0; i < matches.length; i++) inserts.push(rel);
      }
    }
  }
  scan(path.join(ROOT, "server"));

  const allowed = new Set([
    "server/storage.ts",
    "server/routes/conversations.ts",
  ]);
  const unexpected = inserts.filter(p => !allowed.has(p));
  assert(
    "server/* — db.insert(emailMessages) appears only in the two sanctioned files",
    unexpected.length === 0,
    unexpected.length > 0
      ? `Unexpected insert site(s): ${Array.from(new Set(unexpected)).join(", ")} — ` +
        `every Graph-sourced write must go through processUserMailboxEmail → storage.upsertInboundEmailMessage`
      : undefined,
  );
  for (const p of allowed) {
    assert(
      `${p} — sanctioned db.insert(emailMessages) site is still present`,
      inserts.includes(p),
      `Expected at least one db.insert(emailMessages) call in ${p}; this file is the canonical write path and removing it without updating Section 30 will cause a silent regression`,
    );
  }
})();

// ── Section 31: ingestion-silent-drop & empty-content-spike watchdog ───────
// Pins the two new watchdog checks added after the inbound-email persistence
// incident: ingestion_silent_drop fires when Graph webhooks deliver but
// nothing lands in email_messages; email_empty_content_spike fires when a
// large fraction of new rows have empty from_email/subject. Both reuse the
// existing per-org streak gating so cross-tab alerts stay deduped.
console.log("\n── Section 31: ingestion-silent-drop & empty-content watchdog ───────\n");

(function pinIngestionWatchdogContract() {
  const watchdogSrc = readFile("server/services/mailboxWatchdogService.ts");

  assert(
    "mailboxWatchdogService — ALERT_KEY_INGESTION_SILENT_DROP defined",
    /ALERT_KEY_INGESTION_SILENT_DROP\s*=\s*"ingestion_silent_drop"/.test(watchdogSrc),
    "Alert key constant missing — admins won't be able to dedupe or auto-resolve ingestion-silent-drop alerts",
  );
  assert(
    "mailboxWatchdogService — ALERT_KEY_EMPTY_CONTENT_SPIKE defined",
    /ALERT_KEY_EMPTY_CONTENT_SPIKE\s*=\s*"email_empty_content_spike"/.test(watchdogSrc),
    "Alert key constant missing — admins won't be able to dedupe or auto-resolve empty-content-spike alerts",
  );

  assert(
    "mailboxWatchdogService — runIngestionSilentDropCheck export exists",
    /export\s+async\s+function\s+runIngestionSilentDropCheck\s*\(/.test(watchdogSrc),
    "The watchdog cycle imports this name; renaming it without updating the cycle will silently disable the check",
  );
  assert(
    "mailboxWatchdogService — runEmptyContentSpikeCheck export exists",
    /export\s+async\s+function\s+runEmptyContentSpikeCheck\s*\(/.test(watchdogSrc),
    "The watchdog cycle imports this name; renaming it without updating the cycle will silently disable the check",
  );

  // Both checks must be wired into runWatchdogCycle so they actually run.
  // Without the wire-up the exports are dead code.
  assert(
    "mailboxWatchdogService — runWatchdogCycle invokes runIngestionSilentDropCheck",
    /runWatchdogCycle[\s\S]{0,4000}runIngestionSilentDropCheck\s*\(/.test(watchdogSrc),
    "Wire-up missing — the check exists but never runs",
  );
  assert(
    "mailboxWatchdogService — runWatchdogCycle invokes runEmptyContentSpikeCheck",
    /runWatchdogCycle[\s\S]{0,4000}runEmptyContentSpikeCheck\s*\(/.test(watchdogSrc),
    "Wire-up missing — the check exists but never runs",
  );

  // Both checks must reuse the same per-org consecutive-tick gating constant
  // as runQuotePipelineHealthCheck so a one-tick blip can't page on-call.
  assert(
    "mailboxWatchdogService — ingestion-silent-drop honors QUOTE_PIPELINE_CONSECUTIVE_TICKS",
    /_ingestSilentDropTickCount[\s\S]{0,2000}QUOTE_PIPELINE_CONSECUTIVE_TICKS/.test(watchdogSrc),
    "Without consecutive-tick gating, a single transient minute will wake on-call",
  );
  assert(
    "mailboxWatchdogService — empty-content-spike honors QUOTE_PIPELINE_CONSECUTIVE_TICKS",
    /_emptyContentTickCount[\s\S]{0,2000}QUOTE_PIPELINE_CONSECUTIVE_TICKS/.test(watchdogSrc),
    "Without consecutive-tick gating, a single transient minute will wake on-call",
  );

  // Both checks must auto-resolve via storage.resolveMailboxHealthAlert, the
  // same primitive every other watchdog alert uses, so the admin console can
  // clear them automatically once the underlying condition lifts.
  assert(
    "mailboxWatchdogService — ingestion-silent-drop calls resolveMailboxHealthAlert on recovery",
    /_ingestSilentDropTickCount[\s\S]{0,2500}resolveMailboxHealthAlert\([^)]*ALERT_KEY_INGESTION_SILENT_DROP/.test(watchdogSrc),
    "Without the auto-resolve call, a recovered alert will sit red in the admin console forever",
  );
  assert(
    "mailboxWatchdogService — empty-content-spike calls resolveMailboxHealthAlert on recovery",
    /_emptyContentTickCount[\s\S]{0,2500}resolveMailboxHealthAlert\([^)]*ALERT_KEY_EMPTY_CONTENT_SPIKE/.test(watchdogSrc),
    "Without the auto-resolve call, a recovered alert will sit red in the admin console forever",
  );

  // Task #1002 — inbound/outbound asymmetry guard. The closest detector to
  // the May-2026 incident's signature (outbound healthy while inbound is
  // starved). The other two checks above can be defeated by partial
  // regressions; this one cannot.
  assert(
    "mailboxWatchdogService — ALERT_KEY_INBOUND_OUTBOUND_ASYMMETRY defined",
    /ALERT_KEY_INBOUND_OUTBOUND_ASYMMETRY\s*=\s*"ingestion_inbound_outbound_asymmetry"/.test(watchdogSrc),
    "Alert key constant missing — admins won't be able to dedupe or auto-resolve asymmetry alerts",
  );
  assert(
    "mailboxWatchdogService — runInboundOutboundAsymmetryCheck export exists",
    /export\s+async\s+function\s+runInboundOutboundAsymmetryCheck\s*\(/.test(watchdogSrc),
    "The watchdog cycle imports this name; renaming it without updating the cycle will silently disable the check",
  );
  assert(
    "mailboxWatchdogService — runWatchdogCycle invokes runInboundOutboundAsymmetryCheck",
    /runWatchdogCycle[\s\S]{0,5000}runInboundOutboundAsymmetryCheck\s*\(/.test(watchdogSrc),
    "Wire-up missing — the asymmetry check exists but never runs",
  );
  assert(
    "mailboxWatchdogService — asymmetry honors QUOTE_PIPELINE_CONSECUTIVE_TICKS",
    /_asymmetryTickCount[\s\S]{0,2000}QUOTE_PIPELINE_CONSECUTIVE_TICKS/.test(watchdogSrc),
    "Without consecutive-tick gating, a single transient minute will wake on-call",
  );
  assert(
    "mailboxWatchdogService — asymmetry calls resolveMailboxHealthAlert on recovery",
    /_asymmetryTickCount[\s\S]{0,2500}resolveMailboxHealthAlert\([^)]*ALERT_KEY_INBOUND_OUTBOUND_ASYMMETRY/.test(watchdogSrc),
    "Without the auto-resolve call, a recovered alert will sit red in the admin console forever",
  );
})();

// ── Section 33: Capture-first contract (Task #1003) ──────────────────
// Locks the capture-first rewrite invariant:
//
//   Every quote-shaped inbound email becomes a quote_opportunities row
//   tagged with `routing_status` ∈ {auto_customer, needs_routing,
//   auto_carrier, routed_*, dismissed}. The ONLY allowed silent
//   no-create paths are tombstone + duplicate; everything else MUST be
//   captured (or recorded as a drop with a reason) so a rep can route
//   it from the Needs Routing tab.
//
// Section 33 fires before a regression that re-introduces a silent drop
// in the classifier or ingestion layer can ship.
console.log("\n── Section 33: Capture-first contract (Task #1003) ──────────────────\n");

(function pinCaptureFirstContract() {
  const schemaSrc = readFile("shared/schema.ts");
  const ingestSrc = readFile("server/services/quoteEmailIngestion.ts");
  const classifierSrc = readFile("server/services/inlineEmailClassifier.ts");
  const schedulerSrc = readFile("server/emailIntelligenceScheduler.ts");
  const routesSrc = readFile("server/routes/customerQuotes.ts");
  const pageSrc = readFile("client/src/pages/quote-requests.tsx");

  assert(
    "shared/schema.ts — quoteOpportunities.routingStatus column exists",
    /routingStatus:\s*text\(/.test(schemaSrc),
  );
  assert(
    "shared/schema.ts — senderRoutingRules table is exported",
    /export const senderRoutingRules\s*=\s*pgTable/.test(schemaSrc),
  );
  assert(
    "shared/schema.ts — QUOTE_ROUTING_STATUSES enum is exported",
    /export const QUOTE_ROUTING_STATUSES/.test(schemaSrc),
  );
  assert(
    "shared/schema.ts — SENDER_ROUTING_DECISIONS enum is exported",
    /export const SENDER_ROUTING_DECISIONS/.test(schemaSrc),
  );
  assert(
    "quoteEmailIngestion — exports lookupSenderRoutingDecision helper",
    /export\s+(?:async\s+)?function\s+lookupSenderRoutingDecision/.test(ingestSrc),
  );
  assert(
    "inlineEmailClassifier — uses looksLikeQuoteCandidate as a fallback gate",
    /looksLikeQuoteCandidate\s*\(/.test(classifierSrc),
  );
  assert(
    "inlineEmailClassifier — calls lookupSenderRoutingDecision before bucketing",
    /lookupSenderRoutingDecision\s*\(/.test(classifierSrc),
  );
  assert(
    "emailIntelligenceScheduler — cron runs every minute (`* * * * *`)",
    /cron\.schedule\(\s*["']\*\s\*\s\*\s\*\s\*["']/.test(schedulerSrc),
  );
  assert(
    "routes/customerQuotes.ts — registers GET /api/customer-quotes/needs-routing",
    /app\.get\(\s*["']\/api\/customer-quotes\/needs-routing/.test(routesSrc),
  );
  assert(
    "routes/customerQuotes.ts — registers POST /api/customer-quotes/:id/route",
    /app\.post\(\s*["']\/api\/customer-quotes\/:id\/route/.test(routesSrc),
  );
  assert(
    "routes/customerQuotes.ts — registers GET /api/customer-quotes/routing-slo",
    /app\.get\(\s*["']\/api\/customer-quotes\/routing-slo/.test(routesSrc),
  );
  assert(
    "routes/customerQuotes.ts — route POST persists `remember` decisions to sender_routing_rules",
    /INSERT INTO sender_routing_rules/.test(routesSrc),
  );
  assert(
    "quote-requests.tsx — StatusFilter includes 'needs_routing'",
    /needs_routing/.test(pageSrc),
  );
  assert(
    "quote-requests.tsx — renders NeedsRoutingPanel when status is 'needs_routing'",
    /NeedsRoutingPanel/.test(pageSrc),
  );
  // Task #1016 — Needs Routing count/list/snapshot consistency contract.
  // The list endpoint must return both `total` (scoped to match `rows`)
  // and `orgTotal` (org-wide) so the UI can never show a non-zero badge
  // alongside an empty table without explanation.
  assert(
    "routes/customerQuotes.ts — needs-routing returns scoped total + orgTotal",
    /scopeNarrowed/.test(routesSrc) && /orgTotal/.test(routesSrc),
  );
  assert(
    "routes/customerQuotes.ts — routing-slo accepts includeAll and returns needsRoutingOrgTotal",
    /routing-slo[\s\S]{0,2000}includeAll/.test(routesSrc) &&
      /needsRoutingOrgTotal/.test(routesSrc),
  );
  assert(
    "quote-requests.tsx — NeedsRoutingPanel handles list-error state (not 'healthy' fall-through)",
    /needs-routing-error/.test(pageSrc),
  );
  assert(
    "quote-requests.tsx — NeedsRoutingPanel surfaces scope-narrowed explainer with Show all reps",
    /needs-routing-scope-narrowed/.test(pageSrc) &&
      /button-needs-routing-show-all-reps/.test(pageSrc),
  );
})();

// ── Section 32: Carrier Ranking Lane-First Rebalance (May 2026) ────────────
// Pins the contract that lane fit (history + geography + equipment + recency)
// is the PRIMARY signal in carrier ranking and customer history is a
// secondary booster only. The detailed behavioural assertions live in
// tests/carrier-ranking-lane-first.test.ts; this section pins the *shape* of
// the contract (constants, exports, magnitudes) so future refactors can't
// silently undo the rebalance.
console.log("\n── Section 32: Carrier Ranking Lane-First Rebalance ─────────────────\n");

(function pinLaneFirstRebalanceContract() {
  const rankerSrc = readFile("server/carrierRankingService.ts");
  const recSrc = readFile("server/carrierRecommendationEngine.ts");
  const settingsSrc = readFile("server/carrierIntelligenceSettings.ts");

  // ── Constants exist + match the canonical values ─────────────────────────
  assert(
    "carrierRankingService — exports MIN_LANE_FIT_FOR_TOP_RANK = 50",
    /export\s+const\s+MIN_LANE_FIT_FOR_TOP_RANK\s*=\s*50\b/.test(rankerSrc),
    "Floor constant missing or value drifted — lane-fit gating contract is broken",
  );
  assert(
    "carrierRankingService — exports CUSTOMER_ONLY_FALLBACK_REASON with the spec wording",
    /CUSTOMER_ONLY_FALLBACK_REASON\s*=[\s\S]{0,200}Customer history only on other lanes \(weak lane fit\)/.test(rankerSrc),
    "Reason copy drifted — reps will see different wording per surface",
  );
  assert(
    "carrierRankingService — exports classifyCustomerOnlyFallback helper",
    /export\s+function\s+classifyCustomerOnlyFallback\s*\(/.test(rankerSrc),
    "Pure helper missing — both branches + tests reuse it",
  );
  assert(
    "carrierRecommendationEngine — exports REC_MIN_LANE_FIT_FOR_TOP_RANK = 50",
    /export\s+const\s+REC_MIN_LANE_FIT_FOR_TOP_RANK\s*=\s*50\b/.test(recSrc),
    "Floor constant missing — recommendCarriersForLoad won't gate weak-fit carriers",
  );
  assert(
    "carrierRecommendationEngine — exports blendFitAndPerformance helper",
    /export\s+function\s+blendFitAndPerformance\s*\(/.test(recSrc),
    "Blend helper missing — weight changes can't be pinned by tests",
  );

  // ── Customer-history boost magnitudes are HALVED ─────────────────────────
  // Catalog branch (lookupCustomerLoads → fitScore += Math.min(10, 5+custLoads*1))
  assert(
    "carrierRankingService — catalog customer-history boost is +5 + 1/load (cap 10)",
    /Math\.min\(10,\s*5\s*\+\s*custLoads\s*\*\s*1\)/.test(rankerSrc),
    "Customer-history magnitude drifted from the +5/+1/cap-10 spec — re-check carrier ranker",
  );
  assert(
    "carrierRankingService — TMS-only customer-history boost is +5 + 1/load (cap 10)",
    /Math\.min\(10,\s*5\s*\+\s*custLoadsHist\s*\*\s*1\)/.test(rankerSrc),
    "TMS-only customer-history magnitude drifted from the +5/+1/cap-10 spec",
  );
  // The pre-rebalance values must NOT exist anywhere.
  assert(
    "carrierRankingService — old +12 base / cap-20 customer-history boost is gone",
    !/Math\.min\(20,\s*12\s*\+\s*cust(?:Loads|LoadsHist)\s*\*\s*2\)/.test(rankerSrc),
    "Pre-rebalance magnitude (+12 base, +2/load, cap 20) re-appeared — lane-first rebalance was reverted",
  );

  // ── Blend weights — fit ≥ 65% in both code paths ────────────────────────
  assert(
    "carrierRecommendationEngine — blend weights are 0.65·fit + 0.35·perf at loads≥3",
    /loads\s*>=\s*3[\s\S]{0,200}Math\.round\(\s*0\.65\s*\*\s*fit\s*\+\s*0\.35\s*\*\s*perf\s*\)/.test(recSrc),
    "Mature-carrier blend drifted from the 65/35 split — lane fit no longer carries primary weight",
  );
  assert(
    "carrierRecommendationEngine — blend weights are 0.80·fit + 0.20·perf at loads<3",
    /Math\.round\(\s*0\.80\s*\*\s*fit\s*\+\s*0\.20\s*\*\s*perf\s*\)/.test(recSrc),
    "New-carrier blend drifted from the 80/20 split — performance can outweigh lane fit on cold carriers",
  );
  assert(
    "carrierRecommendationEngine — old 0.55/0.45 blend is gone",
    !/0\.55\s*\*\s*(?:i\.fitScore|fit\.fitScore)\s*\+\s*0\.45\s*\*/.test(recSrc),
    "Pre-rebalance blend (0.55·fit + 0.45·perf) re-appeared — rebalance was reverted",
  );

  // ── RankedCarrier interface fields ───────────────────────────────────────
  assert(
    "carrierRankingService — RankedCarrier exposes laneFitBaseline + customerOnlyFallback",
    /laneFitBaseline\?\s*:\s*number/.test(rankerSrc) &&
      /customerOnlyFallback\?\s*:\s*boolean/.test(rankerSrc),
    "Interface fields missing — debug + tests can't read the lane-first signal",
  );

  // ── Sort comparators include customerOnlyFallback demotion ──────────────
  assert(
    "carrierRankingService — both sort comparators demote customerOnlyFallback",
    (rankerSrc.match(/customerOnlyFallback\s*===\s*true/g) ?? []).length >= 2,
    "Demotion guard appears <2 times — at least the regular sort + HF sort must include it",
  );

  // ── Settings expose minLaneFitForTopRank ─────────────────────────────────
  assert(
    "carrierIntelligenceSettings — ScoringThresholds exposes minLaneFitForTopRank",
    /minLaneFitForTopRank\s*:\s*number/.test(settingsSrc),
    "Threshold is not org-tunable — a brokerage with a different appetite has no escape hatch",
  );
  assert(
    "carrierIntelligenceSettings — DEFAULT_THRESHOLDS sets minLaneFitForTopRank: 50",
    /DEFAULT_THRESHOLDS[\s\S]{0,800}minLaneFitForTopRank\s*:\s*50/.test(settingsSrc),
    "Default threshold drifted from 50 — production behaviour will differ from the spec",
  );

  // ── Org-tunable threshold is actually wired into both engines ────────────
  assert(
    "carrierRankingService — rankCarriersForLane reads getThresholds(lane.orgId).minLaneFitForTopRank",
    /getThresholds\(lane\.orgId\)/.test(rankerSrc) &&
      /minLaneFitForTopRank\s*=\s*orgThresholds\.minLaneFitForTopRank/.test(rankerSrc),
    "Threshold constant is fixed at compile time — orgs cannot tune it via settings",
  );
  assert(
    "carrierRankingService — both classifyCustomerOnlyFallback call sites pass threshold: minLaneFitForTopRank",
    (rankerSrc.match(/threshold:\s*minLaneFitForTopRank/g) ?? []).length >= 2,
    "Wiring missing on at least one branch — TMS-only or catalog will silently use the hardcoded floor",
  );
  assert(
    "carrierRecommendationEngine — recommendCarriersForLoad reads getThresholds(orgId).minLaneFitForTopRank",
    /import\s*\{\s*getThresholds\s*\}\s*from\s*"\.\/carrierIntelligenceSettings"/.test(recSrc) &&
      /getThresholds\(orgId\)/.test(recSrc) &&
      /minLaneFit\s*=\s*orgThresholds\.minLaneFitForTopRank/.test(recSrc),
    "Threshold constant is fixed at compile time — orgs cannot tune the rec engine floor via settings",
  );

  // ── classifyCustomerOnlyFallback excludes bench-win carriers ─────────────
  // Bench wins prove capacity *on this lane* via positive outreach, so a
  // carrier with bench wins is never a customer-only fallback regardless of
  // historyMatch tier or baseline. Both call sites must pass benchWins.
  assert(
    "carrierRankingService — classifyCustomerOnlyFallback signature accepts benchWins",
    /benchWins\?:\s*number/.test(rankerSrc),
    "Bench-win exclusion isn't part of the classifier — bench-tier carriers can still be flagged as fallbacks",
  );
  assert(
    "carrierRankingService — both call sites pass benchWins to classifyCustomerOnlyFallback",
    (rankerSrc.match(/benchWins:\s*benchWinsForCarrier\(/g) ?? []).length >= 2,
    "At least one branch is not passing benchWins — the bench-win exclusion only applies to one of catalog / TMS-only",
  );

  // ── AI re-sort path preserves the canonical ordering contract ────────────
  // After the optional AI top-5 re-score, the re-sort MUST use the canonical
  // bench → claimed → fallback → score → tier comparator. A naive
  // `b.fitScore - a.fitScore` would let AI score adjustments push a fallback
  // above a non-fallback. Also: AI cannot overwrite the fitReason of a
  // customerOnlyFallback carrier (rep needs to see the canonical wording).
  assert(
    "carrierRankingService — AI re-sort applies the canonical comparator (not a naive score sort)",
    !/top5\.sort\(\(a,\s*b\)\s*=>\s*b\.fitScore\s*-\s*a\.fitScore\)/.test(rankerSrc),
    "Naive AI re-sort detected — bench tier-0, claimed-lane and fallback ordering will be silently violated",
  );
  assert(
    "carrierRankingService — AI re-sort comparator demotes customerOnlyFallback inside top-5",
    /top5\.sort\(\(a,\s*b\)\s*=>\s*\{[\s\S]{0,2000}aFallback\s*!==\s*bFallback/.test(rankerSrc),
    "AI re-sort missing the fallback demotion — same regression risk as the naive sort",
  );
  assert(
    "carrierRankingService — AI fitReason overwrite is gated on !customerOnlyFallback",
    /if\s*\(\s*!\s*carrier\.customerOnlyFallback\s*\)\s*\{[\s\S]{0,200}carrier\.fitReason\s*=\s*aiItem\.reason/.test(rankerSrc),
    "AI can overwrite the canonical fallback fitReason — reps lose the 'Customer history only on other lanes' explanation",
  );

  // ── Admin route + UI surface the new threshold so orgs can tune it ───────
  // The settings layer is useless if admins can't actually edit the value.
  // The PUT schema must accept it and the UI must render an input.
  const adminRouteSrc = readFile("server/routes/carrierIntelligenceScoring.ts");
  const adminUiSrc = readFile("client/src/pages/admin-carrier-intelligence-scoring.tsx");
  assert(
    "carrierIntelligenceScoring route — PUT thresholds schema accepts minLaneFitForTopRank",
    /thresholds:\s*z\.object\(\{[\s\S]{0,1200}minLaneFitForTopRank:\s*z\.number\(\)/.test(adminRouteSrc),
    "Admin PUT will silently drop minLaneFitForTopRank — orgs cannot persist their override",
  );
  assert(
    "admin-carrier-intelligence-scoring page — ThresholdsCfg includes minLaneFitForTopRank",
    /interface\s+ThresholdsCfg\s*\{[\s\S]{0,400}minLaneFitForTopRank:\s*number/.test(adminUiSrc),
    "UI threshold type doesn't model the new field — it can never be sent to the server",
  );
  assert(
    "admin-carrier-intelligence-scoring page — DEFAULT_THRESHOLDS sets minLaneFitForTopRank: 50",
    /DEFAULT_THRESHOLDS[\s\S]{0,400}minLaneFitForTopRank:\s*50/.test(adminUiSrc),
    "Default UI threshold drifted from 50 — admins see a misleading initial value",
  );
  assert(
    "admin-carrier-intelligence-scoring page — renders an input bound to minLaneFitForTopRank",
    /minLaneFitForTopRank:\s*v/.test(adminUiSrc) && /input-min-lane-fit/.test(adminUiSrc),
    "No NumberField wired for minLaneFitForTopRank — admins have no way to tune it",
  );
})();

// ── 30. graphWebhook DROP-GATE removed — never silently drop unknown-sender inbound ─
// P0 incident: prior to this fix, `processUserMailboxEmail` short-circuited
// inbound emails when the sender wasn't a known contact, wasn't a known
// carrier, and didn't extend an existing thread, returning `{created: false}`
// without persisting anything. That destroyed every brand-new customer's
// first-touch quote email — they'd hit Outlook, get `DROP-GATE`'d in our
// log, and never appear in `email_messages`, Conversations, or Customer
// Quotes. This guardrail prevents that early-return from being re-introduced
// and guarantees the new PERSIST-UNKNOWN log path stays in the file so the
// branch is grep-attributable for ops.
console.log("\n── 30. graphWebhook never silently drops unknown-sender inbound ──────\n");
{
  const graphWebhookSrc = readFile("server/routes/graphWebhook.ts");

  // The legacy DROP-GATE early-return is gone. Match the actual log() call
  // signature `[user-mailbox] DROP-GATE` — historical comments that mention
  // the gate by name are fine, but the executable log line must not exist.
  assert(
    "graphWebhook.ts — legacy DROP-GATE log call removed (no silent inbound drop)",
    !/\[user-mailbox\]\s+DROP-GATE/.test(graphWebhookSrc),
    "DROP-GATE log call still present — unknown-sender inbound emails are being silently discarded again",
  );

  // The replacement contract: when the unknown-first-touch branch fires,
  // it must either (a) drop with a TOMBSTONE-DROP reason for truly empty
  // payloads, or (b) fall through to the upsert and emit PERSIST-UNKNOWN.
  // Both log lines must exist; their presence is what makes the contract
  // observable in production logs.
  assert(
    "graphWebhook.ts — PERSIST-UNKNOWN log present for unknown first-touch inbound",
    /PERSIST-UNKNOWN direction=inbound/.test(graphWebhookSrc),
    "PERSIST-UNKNOWN log missing — unknown-sender preservation is not observable in ops logs",
  );
  assert(
    "graphWebhook.ts — TOMBSTONE-DROP log present for empty-payload Graph deliveries",
    /TOMBSTONE-DROP direction=inbound/.test(graphWebhookSrc),
    "TOMBSTONE-DROP log missing — the only safe drop path is no longer attributable",
  );

  // Hard structural check: in `processUserMailboxEmail`, between the carrier-
  // match block and the upsert, the only `return { created: false` allowed
  // is the TOMBSTONE-DROP branch. Any other early-return would re-introduce
  // silent loss of inbound email.
  const fnStart = graphWebhookSrc.indexOf("async function processUserMailboxEmail");
  const fnEnd = graphWebhookSrc.indexOf("\n}\n", fnStart);
  const fnBody = fnStart >= 0 && fnEnd > fnStart ? graphWebhookSrc.slice(fnStart, fnEnd) : "";
  const earlyReturns = (fnBody.match(/return\s*\{\s*created:\s*false/g) ?? []).length;
  // Allowed early-returns inside processUserMailboxEmail:
  //   1. TOMBSTONE-DROP (truly empty Graph payload)
  //   2. Duplicate provider_message_id (`if (!created) ... return { created: false`)
  // Anything beyond these two is a regression.
  assert(
    "graphWebhook.ts — processUserMailboxEmail has at most 2 created:false early-returns (tombstone + duplicate)",
    earlyReturns <= 2,
    `Found ${earlyReturns} created:false early-returns — silent inbound drops may have been re-introduced`,
  );
}

// ── Section 32: Quote Requests "Mine only" trust contract ───────────────────
//
// Background — the legacy `applyMineOnly` injected a `__no_rep__` sentinel
// repId when the requesting user had no `quote_reps` row, which silently
// turned the list endpoint into a fake-zero result while the snapshot
// still returned org-wide KPIs. Result: rep saw "No matches for the
// current filters" + a "99+" sidebar badge + 1700+ pending opps in
// production. Trust bug.
//
// Replacement contract (Task #1007):
//   1. The legacy `__no_rep__` sentinel must not exist anywhere in
//      `server/routes/customerQuotes.ts`.
//   2. `applyMineOnly` must return `{ filters, meta }` — not a bare
//      filters object — so `mineOnlyMeta` can be propagated to the UI.
//   3. Both `/api/customer-quotes/list` and `/api/customer-quotes/snapshot`
//      must include `mineOnlyMeta` in their JSON responses.
//   4. The frontend must render the `banner-mine-only-no-rep` element when
//      `warningCode === "NO_QUOTE_REP_MAPPING"` and offer a one-click
//      "Turn off Mine only" escape hatch.
console.log("\n── Section 32: Quote Requests Mine-only trust contract ──────────────\n");
{
  const routesPath = path.join(ROOT, "server/routes/customerQuotes.ts");
  const pagePath = path.join(ROOT, "client/src/pages/quote-requests.tsx");
  const routesSrc = fs.readFileSync(routesPath, "utf-8");
  const pageSrc = fs.readFileSync(pagePath, "utf-8");

  // Strip line comments so the historical-context comment that names the
  // legacy sentinel doesn't trigger a false positive — what we forbid is
  // an executable reference, not a commemorative note.
  const routesCode = routesSrc.split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");
  assert(
    "customerQuotes.ts — legacy __no_rep__ sentinel removed (no silent fake-zero list)",
    !/["'`]__no_rep__["'`]|NO_REP_SENTINEL\s*=/.test(routesCode),
    "__no_rep__ / NO_REP_SENTINEL still defined in code — silent zero-row mineOnly bug may have been re-introduced",
  );

  assert(
    "customerQuotes.ts — applyMineOnly returns { filters, meta } shape",
    /async\s+function\s+applyMineOnly[\s\S]{0,400}Promise<\{\s*filters:\s*QuoteFilters;\s*meta:\s*MineOnlyMeta/.test(routesSrc),
    "applyMineOnly signature does not return the structured { filters, meta } contract",
  );

  assert(
    "customerQuotes.ts — NO_QUOTE_REP_MAPPING warning code emitted by applyMineOnly",
    /warningCode:\s*["']NO_QUOTE_REP_MAPPING["']/.test(routesSrc),
    "applyMineOnly does not emit the NO_QUOTE_REP_MAPPING warning code — UI cannot render an honest banner",
  );

  assert(
    "customerQuotes.ts — /list endpoint propagates mineOnlyMeta in response",
    /res\.json\(\{\s*\.\.\.result,\s*mineOnlyMeta\s*\}\)/.test(routesSrc),
    "/api/customer-quotes/list response does not include mineOnlyMeta — UI cannot detect no-rep state",
  );

  assert(
    "customerQuotes.ts — /snapshot endpoint propagates mineOnlyMeta in response",
    /res\.json\(\{\s*\.\.\.snap,\s*myRepId:[^,]+,\s*mineOnlyMeta\s*\}\)/.test(routesSrc),
    "/api/customer-quotes/snapshot response does not include mineOnlyMeta — UI cannot render warning banner",
  );

  assert(
    "quote-requests.tsx — banner renders on NO_QUOTE_REP_MAPPING with Show-all CTA",
    /data-testid="banner-mine-only-no-rep"/.test(pageSrc)
      && /data-testid="button-mine-only-show-all"/.test(pageSrc)
      && /warningCode\s*===\s*["']NO_QUOTE_REP_MAPPING["']/.test(pageSrc),
    "Mine-only honesty banner missing in quote-requests.tsx — generic empty state will be shown for unmapped users again",
  );

  assert(
    "quote-requests.tsx — Show-all button clears mineOnly via setMineOnly(false)",
    /setMineOnly\(false\)[\s\S]{0,300}button-mine-only-show-all/.test(pageSrc)
      || /button-mine-only-show-all[\s\S]{0,300}setMineOnly\(false\)/.test(pageSrc),
    "Show-all button does not call setMineOnly(false) — user has no escape hatch from mine-only-on state",
  );
}

// ── Section 35: Account Owner unification (canonical companies.ownerRepId) ─
//
// After the Task #1011 / #1012 ownership work landed, the team
// consolidated on `companies.ownerRepId` as the single source of truth
// for "Account Owner". This guard locks the contract:
//   1. Quote Requests Rep fallback reads from the companies-derived
//      `ownerRepNameByCustomerId` map, NOT from the deprecated
//      `quote_customers.owner_rep_id` cache.
//   2. The Intel tab Account Information portlet surfaces Account
//      Owner (view + edit) with the canonical test ids.
//   3. Terminology has been unified — no "Quote Owner Rep" label
//      remains in user-facing UI.

console.log("\n── Section 35: Account Owner unification ──────────────────────────────\n");

{
  const svcSrc = fs.readFileSync("server/services/customerQuotes.ts", "utf8");

  // (1) The Tier-3 fallback in `enrich()` must read the
  //     companies-derived map, not the quote_customers cache.
  const enrichWindow = svcSrc.match(/let repFromCustomerOwner[\s\S]{0,1800}?repFromCustomerOwner = true/);
  assert(enrichWindow, "Account Owner: could not isolate enrich() Tier-3 fallback for audit");
  if (enrichWindow) {
    const block = enrichWindow[0];
    assert(
      /opts\.ownerRepNameByCustomerId\?\.get\(r\.customerId\)/.test(block),
      "Account Owner: enrich() Tier-3 must read from opts.ownerRepNameByCustomerId (companies.ownerRepId source of truth)",
    );
    assert(
      !/customer\?\.ownerRepId/.test(block) && !/customer\.ownerRepId/.test(block),
      "Account Owner: enrich() Tier-3 must NOT read from customer.ownerRepId (deprecated quote_customers cache)",
    );
  }
}

{
  const tabSrc = fs.readFileSync("client/src/pages/company-detail/tabs/IntelTab.tsx", "utf8");

  // (2) Intel tab Account Information portlet must expose Account
  //     Owner with both view and edit test ids.
  assert(
    /data-testid="text-account-owner"/.test(tabSrc),
    "Account Owner: IntelTab must render an Account Owner display row (text-account-owner)",
  );
  assert(
    /data-testid="select-account-owner"/.test(tabSrc),
    "Account Owner: IntelTab must render an Account Owner editor (select-account-owner) for permissioned users",
  );
  assert(
    /\/api\/companies\/\$\{companyId\}\/owner/.test(tabSrc),
    "Account Owner: IntelTab save must hit PATCH /api/companies/:id/owner (the RBAC-gated endpoint)",
  );
}

{
  // (3) No "Quote Owner Rep" label anywhere in user-facing client
  //     JSX/strings. (Comments referencing the legacy name are OK so
  //     historical context is preserved — we only forbid it in JSX
  //     content and string literals like toast titles / labels.)
  const grep = execSync(
    "rg -n --no-heading 'Quote Owner Rep' client/ -g '*.tsx' -g '*.ts' || true",
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(line => line.trim() !== "")
    .filter(line => !/^\S+:\s*\d+:\s*\/\//.test(line)) // skip // comment lines
    .filter(line => !/^\S+:\s*\d+:\s*\*/.test(line))   // skip block-comment continuations
    .join("\n");
  assert(
    grep === "",
    `Account Owner: legacy "Quote Owner Rep" label must be relabeled to "Account Owner" in user-facing surfaces. Found:\n${grep}`,
  );
}

{
  // (4) Generic company create/update must NOT accept ownerRepId.
  //     Account Owner edits must flow through the dedicated
  //     /api/companies/:id/owner endpoint with its stricter RBAC.
  const routesSrc = fs.readFileSync("server/routes/companies.ts", "utf8");
  const patchHandler = routesSrc.match(/app\.patch\("\/api\/companies\/:id"[\s\S]*?^  \}\);/m);
  assert(patchHandler, "Account Owner: could not isolate generic PATCH /api/companies/:id handler for audit");
  if (patchHandler) {
    assert(
      /delete \(data as Record<string, unknown>\)\.ownerRepId/.test(patchHandler[0]),
      "Account Owner: generic PATCH /api/companies/:id must strip ownerRepId before persisting",
    );
  }
  const postHandler = routesSrc.match(/app\.post\("\/api\/companies"[\s\S]*?^  \}\);/m);
  assert(postHandler, "Account Owner: could not isolate generic POST /api/companies handler for audit");
  if (postHandler) {
    assert(
      /delete \(data as Record<string, unknown>\)\.ownerRepId/.test(postHandler[0]),
      "Account Owner: generic POST /api/companies must strip ownerRepId (owner is set post-create via /owner endpoint)",
    );
  }
}

{
  // (5) The generic CompanyDialog must not collect or post ownerRepId
  //     — that was the bypass path that exposed Account Owner edits
  //     to `sales` users.
  const dlgSrc = fs.readFileSync("client/src/components/company-dialog.tsx", "utf8");
  assert(
    !/name="ownerRepId"/.test(dlgSrc),
    "Account Owner: CompanyDialog must not render an ownerRepId form field — edit via the Intel tab instead",
  );
  assert(
    !/ownerRepId:\s*data\.ownerRepId/.test(dlgSrc),
    "Account Owner: CompanyDialog must not include ownerRepId in its submit payload",
  );
}

{
  // (6) IntelTab save flow must invalidate the company query in
  //     onSettled so a partial-success (main PATCH ok, owner PATCH
  //     fails) doesn't leave the UI showing stale values.
  const tabSrc = fs.readFileSync("client/src/pages/company-detail/tabs/IntelTab.tsx", "utf8");
  const mut = tabSrc.match(/savePortalMutation = useMutation\(\{[\s\S]*?\}\);/);
  assert(mut, "Account Owner: could not isolate savePortalMutation for audit");
  if (mut) {
    assert(
      /onSettled:\s*\(\)\s*=>\s*\{[\s\S]*?invalidateQueries/.test(mut[0]),
      "Account Owner: savePortalMutation must invalidate company cache in onSettled (partial-failure safety)",
    );
  }
}

// ── Section 34: Phase 1 Response-Time Visibility (read-only contract) ─────
//
// Locks in the contract for Phase 1: response-time signal must come from
// the existing `quote_opportunities.responseTimeHours` column and a
// read-only join against `email_messages`. Any change that re-routes
// through new ingestion / classifier / webhook / backfill code must
// trip these assertions BEFORE merging — Phase 2 (Playbook) and
// Phase 3 (Coaching/Map) live on top of this contract.

console.log("\n── Section 34: Phase 1 Response-Time Visibility (read-only) ──────────\n");

{
  const svcPath = "server/services/customerQuotes.ts";
  const svcSrc = fs.readFileSync(svcPath, "utf8");

  // (1) EnrichedQuote must project firstReplyMinutes + firstQuoteMinutes
  //     so the UI never has to reach into raw quoteOpportunities.
  assert(
    /firstReplyMinutes:\s*number\s*\|\s*null/.test(svcSrc)
      && /firstQuoteMinutes:\s*number\s*\|\s*null/.test(svcSrc),
    "Phase 1: EnrichedQuote must declare firstReplyMinutes/firstQuoteMinutes (number|null) — UI badges depend on it",
  );

  // (2) attachResponseTimes must exist and be invoked from listQuotes
  //     and getActionQueue (the only two surfaces that hand visible
  //     pages to the UI).
  assert(
    /async function attachResponseTimes\(orgId: string, rows: EnrichedQuote\[\]\)/.test(svcSrc),
    "Phase 1: attachResponseTimes(orgId, rows) helper missing in customerQuotes.ts",
  );
  const attachCalls = (svcSrc.match(/await attachResponseTimes\(/g) ?? []).length;
  assert(
    attachCalls >= 2,
    `Phase 1: expected attachResponseTimes to be awaited from listQuotes and getActionQueue (≥2 sites), found ${attachCalls}`,
  );

  // (3) Read-only contract: the new helper must not write to email_messages
  //     (or any other ingestion-side table). Detect any insert/update/upsert
  //     within the helper body.
  const helperMatch = svcSrc.match(/async function attachResponseTimes[\s\S]*?\n\}\n/);
  assert(helperMatch, "Phase 1: could not isolate attachResponseTimes body for read-only audit");
  if (helperMatch) {
    const body = helperMatch[0];
    assert(
      !/db\.(insert|update|delete)\(/.test(body),
      "Phase 1: attachResponseTimes must be read-only (no db.insert/update/delete) — Phase 1 explicitly forbids re-opening email plumbing",
    );
    assert(
      !/processUserMailboxEmail|ingestQuoteFromEmail|classifyEmail/.test(body),
      "Phase 1: attachResponseTimes must not call ingestion/classifier helpers — read-only derivation only",
    );
  }

  // (4) Snapshot must surface the two new aggregate KPIs so the strip
  //     can render avg quote time + % quoted ≤ 60 min.
  assert(
    /avgFirstQuoteMin:\s*number/.test(svcSrc)
      && /pctFirstQuoteUnder60:\s*number/.test(svcSrc)
      && /quotedCount:\s*number/.test(svcSrc),
    "Phase 1: Snapshot.kpis must declare avgFirstQuoteMin, pctFirstQuoteUnder60, quotedCount",
  );
  assert(
    /avgFirstQuoteMin,\s*pctFirstQuoteUnder60,\s*quotedCount/.test(svcSrc),
    "Phase 1: getSnapshot return must wire {avgFirstQuoteMin, pctFirstQuoteUnder60, quotedCount} into kpis",
  );
}

{
  const pagePath = "client/src/pages/quote-requests.tsx";
  const pageSrc = fs.readFileSync(pagePath, "utf8");

  // (5) ResponseCell component must exist and be wired into the row.
  assert(
    /function ResponseCell\(/.test(pageSrc),
    "Phase 1: ResponseCell component missing in quote-requests.tsx",
  );
  assert(
    /<ResponseCell\s+quote=\{q\}\s*\/>/.test(pageSrc),
    "Phase 1: ResponseCell must be rendered inside the quote row",
  );
  assert(
    /data-testid=\{`badge-reply-\$\{quote\.id\}`\}/.test(pageSrc)
      && /data-testid=\{`badge-quote-\$\{quote\.id\}`\}/.test(pageSrc),
    "Phase 1: ResponseCell must expose badge-reply-{id} and badge-quote-{id} test IDs",
  );

  // (6) Both response-time KPI tiles must be present.
  assert(
    /testId="kpi-avg-quote-time"/.test(pageSrc)
      && /testId="kpi-pct-quoted-under-60"/.test(pageSrc),
    "Phase 1: KPI strip must include kpi-avg-quote-time and kpi-pct-quoted-under-60 tiles",
  );
}


// ── Section 35: Task #1030 (LWQ E) — admin/engine surfaces off LWQ ──────────
//
// The Lane Work Queue rep page must not host the engine-control,
// freshness, leak-console, sourcing-performance, edit/delete-lane, or
// admin-debug surfaces. Those live on /admin/lane-engine. The rep page
// keeps only a small `status-engine-health` dot that links to the admin
// route. Any regression that re-introduces these surfaces on LWQ should
// fail this section.
console.log("\n── Section 35: Task #1030 LWQ E — engine surfaces relocated to /admin/lane-engine ──\n");

{
  const lwqSrc = readFile("client/src/pages/lane-work-queue.tsx");
  const adminSrc = readFile("client/src/pages/admin-lane-engine.tsx");
  const appSrc = readFile("client/src/App.tsx");

  // (1) Status dot present in LWQ header
  assert(
    /data-testid="status-engine-health"/.test(lwqSrc),
    "Task #1030: LWQ must render status-engine-health dot in the header",
  );
  assert(
    /href="\/admin\/lane-engine"/.test(lwqSrc),
    "Task #1030: status-engine-health dot must link to /admin/lane-engine",
  );

  // (2) Forbidden surfaces on LWQ
  const forbidden: Array<[RegExp, string]> = [
    [/data-testid="btn-run-engine"/, "btn-run-engine"],
    [/data-testid="btn-run-engine-empty"/, "btn-run-engine-empty"],
    [/data-testid="btn-leak-console"/, "btn-leak-console"],
    [/data-testid="banner-cache-warming"/, "banner-cache-warming"],
    [/data-testid="engine-debug-panel"/, "engine-debug-panel"],
    [/data-testid="sourcing-performance-panel"/, "sourcing-performance-panel"],
    [/data-testid="admin-debug-panel"/, "admin-debug-panel"],
    [/data-testid="pill-lwq-freshness"/, "pill-lwq-freshness"],
    [/data-testid=\{`btn-edit-lane-/, "btn-edit-lane-{id}"],
    [/data-testid=\{`btn-delete-lane-/, "btn-delete-lane-{id}"],
    [/from "@\/components\/freight\/freshness-pill"/, "freshness-pill import"],
    [/<FreshnessPill/, "<FreshnessPill> render"],
    [/\/api\/recurring-lanes\/run-engine/, "/api/recurring-lanes/run-engine call"],
    [/\/api\/recurring-lanes\/engine-status/, "/api/recurring-lanes/engine-status call"],
    [/\/api\/carriers\/sourcing-performance/, "/api/carriers/sourcing-performance call"],
    [/\/api\/freight-freshness/, "/api/freight-freshness call"],
  ];
  for (const [re, label] of forbidden) {
    assert(
      !re.test(lwqSrc),
      `Task #1030: LWQ rep page must NOT contain ${label} (moved to /admin/lane-engine)`,
    );
  }

  // (3) Admin Lane Engine page exists and hosts the moved surfaces.
  assert(/data-testid="page-admin-lane-engine"/.test(adminSrc),
    "Task #1030: admin-lane-engine.tsx must render the page-admin-lane-engine container");
  for (const id of [
    "btn-run-engine",
    "engine-debug-panel",
    "sourcing-performance-panel",
    "pill-lwq-freshness",
    "card-recurring-lane-upload",
    "input-lane-upload-file",
    "link-leak-console",
    "card-lane-management",
    "card-engine-kpis",
    "kpi-detected-this-week",
    "kpi-retracted-this-week",
    "kpi-eligibility-distribution",
    "btn-recompute-cache",
  ]) {
    assert(
      new RegExp(`data-testid="${id}"`).test(adminSrc),
      `Task #1030: admin-lane-engine.tsx must host ${id}`,
    );
  }
  assert(
    /btn-edit-lane-\$\{l\.laneId\}/.test(adminSrc) || /btn-edit-lane-\$/.test(adminSrc),
    "Task #1030: admin-lane-engine.tsx must host per-row btn-edit-lane-{id}",
  );
  assert(
    /btn-delete-lane-\$\{l\.laneId\}/.test(adminSrc) || /btn-delete-lane-\$/.test(adminSrc),
    "Task #1030: admin-lane-engine.tsx must host per-row btn-delete-lane-{id}",
  );

  // (4) RBAC gate on the admin page — sales must be 403'd.
  assert(
    /ALLOWED_ROLES\s*=\s*\[\s*"admin",\s*"director",\s*"national_account_manager",\s*"sales_director"\s*\]/.test(adminSrc),
    "Task #1030: admin-lane-engine.tsx must gate to admin/director/national_account_manager/sales_director",
  );
  assert(
    /admin-lane-engine-forbidden/.test(adminSrc),
    "Task #1030: admin-lane-engine.tsx must render a 403 placeholder for disallowed roles",
  );

  // (5) Route registered.
  assert(
    /<Route\s+path="\/admin\/lane-engine"\s+component=\{AdminLaneEnginePage\}\s*\/>/.test(appSrc),
    "Task #1030: App.tsx must register <Route path=\"/admin/lane-engine\" />",
  );

  // (6) Server health/KPIs/recompute endpoints exist; run-engine stamps ranAt.
  const serverSrc = readFile("server/routes/laneCarrierOutreach.ts");
  assert(
    /app\.get\("\/api\/lane-engine\/health"/.test(serverSrc),
    "Task #1030: GET /api/lane-engine/health must exist in laneCarrierOutreach.ts",
  );
  assert(
    /app\.get\("\/api\/lane-engine\/kpis"/.test(serverSrc),
    "Task #1030: GET /api/lane-engine/kpis must exist (detected/retracted/eligibility)",
  );
  assert(
    /app\.post\("\/api\/lane-engine\/recompute-cache"/.test(serverSrc),
    "Task #1030: POST /api/lane-engine/recompute-cache must exist (manual cache trigger)",
  );
  assert(
    /lane_engine_last_run:\$\{user\.organizationId\}.*ranAt:\s*new Date\(\)\.toISOString\(\)/s.test(serverSrc),
    "Task #1030: run-engine handler must persist `ranAt` so the health endpoint can age-check the last run",
  );
  // (7) RBAC widening — the three engine endpoints must allow NAM +
  // sales_director so the page roles match the API roles.
  for (const route of [
    /app\.get\("\/api\/recurring-lanes\/engine-status"[\s\S]*?national_account_manager[\s\S]*?sales_director/,
    /app\.post\("\/api\/recurring-lanes\/run-engine"[\s\S]*?national_account_manager[\s\S]*?sales_director/,
    /app\.post\("\/api\/admin\/carriers\/seed-from-excel"[\s\S]*?national_account_manager[\s\S]*?sales_director/,
  ]) {
    assert(
      route.test(serverSrc),
      `Task #1030: backend RBAC for ${route.source.slice(0, 60)}… must include national_account_manager + sales_director to match /admin/lane-engine page roles`,
    );
  }
}


// ── Section 1026: LWQ A — Lifecycle as first-class state ─────────────────
// Lifecycle stages are derived once on the server (`shared/laneLifecycle.ts`
// → consumed by `server/services/laneLifecycle.ts`) and persisted on
// `recurring_lanes.lifecycle_stage`. The UI must NEVER redefine the ladder
// or write the column directly, and the operationalized predicate must
// keep the "covered/won load with pickup AFTER first outreach" semantics.
console.log("── Section 1026: LWQ A — Lifecycle as first-class state ──");
{
  const sharedSrc = readFile("shared/laneLifecycle.ts");
  assert(
    "shared/laneLifecycle.ts exports LIFECYCLE_STAGES with all 7 stages",
    /LIFECYCLE_STAGES[\s\S]*detected[\s\S]*qualified[\s\S]*assigned[\s\S]*contactable[\s\S]*contacted[\s\S]*engaged[\s\S]*operationalized/.test(sharedSrc),
  );
  assert(
    "shared/laneLifecycle.ts exports the pure deriveLaneLifecycleStage()",
    /export function deriveLaneLifecycleStage\b/.test(sharedSrc),
  );

  const svcSrc = readFile("server/services/laneLifecycle.ts");
  assert(
    "laneLifecycle service guards Operationalized with firstOutreachAt",
    /firstOutreachAt/.test(svcSrc),
  );
  assert(
    "laneLifecycle service requires pickup AFTER first outreach attempt",
    /pickupDate\}\s*>\s*\$\{pickupCutoff\}/.test(svcSrc)
      && /pickupCutoff\s*=\s*firstOutreachAt\.toISOString\(\)/.test(svcSrc),
  );
  assert(
    "laneLifecycle service exports recomputeLaneLifecycleStage()",
    /export async function recomputeLaneLifecycleStage\b/.test(svcSrc),
  );
  assert(
    "laneLifecycle service exports recomputeOrgLaneLifecycleStages()",
    /export async function recomputeOrgLaneLifecycleStages\b/.test(svcSrc),
  );

  // Only the lifecycle service + the boot-time backfill may write the column.
  // (The lane-cache projection module is allowed to *read* it, so we only
  // forbid object-literal writes like `lifecycleStage:` / `lifecycle_stage =`.)
  const allowedWriters = new Set([
    "server/services/laneLifecycle.ts",
    "server/runMigrations.ts",
    // Read-only consumer: projects `lifecycleStage` from a Drizzle select
    // and shapes it onto an in-memory row for the lifecycle-counts endpoint.
    // Never persists the column — guarded separately by the lifecycle-counts
    // assertions below.
    "server/routes/laneCarrierOutreach.ts",
    // Synthetic / pseudo-lane builders. These construct in-memory
    // RecurringLane-shaped objects (never inserted/updated) to satisfy the
    // type contract of helpers like `rankCarriersForLane`. They set
    // `lifecycleStage: null` purely as a type filler.
    "server/proactiveOpportunityService.ts",
    "server/routes/procurementOutreach.ts",
  ]);
  const serverFiles = walkFiles("server", ".ts");
  const offenders: string[] = [];
  for (const f of serverFiles) {
    const rel = path.relative(ROOT, f).replaceAll("\\", "/");
    if (allowedWriters.has(rel)) continue;
    const src = fs.readFileSync(f, "utf-8");
    // Match only WRITES — object-literal assignments to lifecycleStage that
    // are NOT a Drizzle select-projection (e.g. `lifecycleStage: recurringLanes.lifecycleStage`).
    // Reads/projections are explicitly allowed; persistence is the gate.
    const writeRe = /\blifecycleStage\s*:\s*(?!recurringLanes\.lifecycleStage\b)/;
    if (writeRe.test(src) || /\blifecycle_stage\s*=\s*/.test(src)) {
      offenders.push(rel);
    }
  }
  assert(
    "lifecycle_stage is written ONLY by laneLifecycle service + runMigrations backfill",
    offenders.length === 0,
    offenders.length ? `unexpected writers: ${offenders.join(", ")}` : undefined,
  );

  // The UI must not redefine the lifecycle ladder or import the derivation.
  const uiPages = [
    "client/src/pages/lane-work-queue.tsx",
    "client/src/pages/lane-story.tsx",
    "client/src/pages/my-procurement.tsx",
  ];
  for (const rel of uiPages) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, "utf-8");
    assert(
      `${rel} does not redefine deriveLaneLifecycleStage`,
      !/function deriveLaneLifecycleStage\b/.test(src) && !/const deriveLaneLifecycleStage\b/.test(src),
    );
  }

  // The lifecycle-counts endpoint must reuse the shared owner-filter +
  // pickup-scope helpers — never roll its own scoping.
  const routeSrc = readFile("server/routes/laneCarrierOutreach.ts");
  assert(
    "lifecycle-counts endpoint is registered",
    /\/api\/recurring-lanes\/lifecycle-counts/.test(routeSrc),
  );
  assert(
    "lifecycle-counts endpoint reuses applyOwnerFilter + applyPickupScope",
    /lifecycle-counts[\s\S]{0,4000}applyOwnerFilter[\s\S]{0,4000}applyPickupScope/.test(routeSrc),
  );
  assert(
    "lifecycle-counts endpoint is feature-flag gated via assertFlagEnabled",
    /lifecycle-counts[\s\S]{0,2000}assertFlagEnabled/.test(routeSrc),
  );
}

// ── Section 34: role-promotion contract ────────────────────────────────────
//
// The TJ-LM-to-AM incident: a user was "promoted" but the new role was never
// persisted, no audit trail existed, and the promoted user's nav/route gates
// stayed on the old role for up to the /api/auth/me staleTime. The contract
// these guardrails defend:
//
//   1. PATCH /api/users/:id MUST route role changes through applyRolePromotion
//      so every transition emits a structured `[role-promotion]` log line.
//   2. The admin user-edit mutation MUST invalidate /api/auth/me so the
//      promoted user's session refreshes instead of holding the old role.
//   3. The /api/auth/me staleTime MUST stay short (≤ 60s) so role changes
//      propagate within seconds, not minutes.
//   4. account_manager MUST stay in SALES_ROLES so AMs see the Customers nav.
//
{
  console.log("\n── Section 34: role-promotion contract ───────────────────────\n");

  const promotionHelper = readFile("server/lib/rolePromotion.ts");
  assert(
    "rolePromotion helper exists and exports applyRolePromotion",
    /export\s+(async\s+)?function\s+applyRolePromotion\b/.test(promotionHelper) ||
      /export\s+\{[^}]*applyRolePromotion/.test(promotionHelper),
  );
  assert(
    "rolePromotion helper emits the [role-promotion] APPLIED audit log",
    /\[role-promotion\][^"`]*APPLIED/.test(promotionHelper),
  );

  const routesSrc = readFile("server/routes.ts");
  assert(
    "PATCH /api/users/:id handler is present",
    /app\.patch\("\/api\/users\/:id"/.test(routesSrc),
  );
  // The role-promotion helper is wired in. Combined with the
  // "no direct data.role write" check below this guarantees role
  // changes funnel through applyRolePromotion.
  assert(
    "server/routes.ts invokes applyRolePromotion (role changes go through the helper)",
    /applyRolePromotion\s*\(/.test(routesSrc),
  );
  // Defensive: the legacy direct `data.role = req.body.role` write must
  // be gone anywhere in routes.ts — every role write goes through the helper now.
  assert(
    "server/routes.ts no longer writes data.role = req.body.role directly",
    !/data\.role\s*=\s*req\.body\.role\b/.test(routesSrc),
  );

  const adminUsersSrc = readFile("client/src/pages/admin-users.tsx");
  assert(
    "admin-users user-edit mutation invalidates /api/auth/me on success",
    /invalidateQueries\(\{\s*queryKey:\s*\["\/api\/auth\/me"\]\s*\}\)/.test(adminUsersSrc),
  );

  const useAuthSrc = readFile("client/src/hooks/use-auth.ts");
  // Both the bypass and Clerk paths must keep staleTime short. Match any
  // numeric staleTime expression and reject anything > 60s.
  const staleTimes = Array.from(useAuthSrc.matchAll(/staleTime:\s*([^\n,]+)/g)).map(m => m[1].trim());
  assert(
    "use-auth declares at least one staleTime for /api/auth/me",
    staleTimes.length >= 2,
  );
  for (const expr of staleTimes) {
    // Evaluate the simple multiplication expressions we use (e.g. `30 * 1000`).
    const ms = (() => {
      try { return Function(`"use strict"; return (${expr});`)(); } catch { return NaN; }
    })();
    assert(
      `use-auth staleTime "${expr}" stays ≤ 60s so role changes propagate quickly`,
      typeof ms === "number" && Number.isFinite(ms) && ms <= 60_000,
    );
  }

  const navItemsSrc = readFile("client/src/lib/nav-items.ts");
  const salesRolesMatch = navItemsSrc.match(/SALES_ROLES\s*=\s*\[([^\]]*)\]/);
  assert(
    "SALES_ROLES is defined in nav-items",
    !!salesRolesMatch,
  );
  if (salesRolesMatch) {
    assert(
      "account_manager is in SALES_ROLES so AMs see the Customers nav",
      /"account_manager"/.test(salesRolesMatch[1]),
    );
  }
  // The Customers entry itself must be gated by SALES_ROLES (not a hand-rolled list).
  assert(
    "Customers nav entry is gated by SALES_ROLES",
    /title:\s*"Customers"[^}]*roles:\s*SALES_ROLES/.test(navItemsSrc),
  );
}

// ── Section 1027: LWQ B — Strategic priority composite ──────────────────
// `computeLaneStrategicPriority` is the single source of truth for the LWQ
// strategic ranking. It MUST stay pure (no DB / storage imports), the
// defaults MUST live as a documented exported constant, and the work-queue
// response MUST carry `priorityExplanation` whenever `strategicPriority` is
// attached to a row (so Task D's reason chip never has to re-derive).
console.log("\n── Section 1027: LWQ B — Strategic priority composite ──────────────");
{
  const pureSrc = readFile("server/services/laneStrategicPriority.ts");
  // (a) Pure function: no DB / storage imports.
  assert(
    "computeLaneStrategicPriority module has no DB or storage imports (pure)",
    !/from\s+["']\.\.\/storage["']/.test(pureSrc)
      && !/from\s+["']drizzle-orm["']/.test(pureSrc)
      && !/\bawait\s+storage\./.test(pureSrc)
      && !/\bawait\s+db\./.test(pureSrc),
  );
  assert(
    "computeLaneStrategicPriority is exported",
    /export function computeLaneStrategicPriority\b/.test(pureSrc),
  );
  // (b) Defaults are a documented exported constant.
  assert(
    "DEFAULT_LANE_STRATEGIC_WEIGHTS exported as documented constant",
    /export const DEFAULT_LANE_STRATEGIC_WEIGHTS\s*:\s*LaneStrategicWeights\s*=/.test(pureSrc),
  );

  // (c) Work-queue endpoint wires the composite + opt-in sort param, and
  //     pairs `strategicPriority` with `priorityExplanation`.
  const wqSrc = readFile("server/routes/laneCarrierOutreach.ts");
  assert(
    "work-queue handler reads ?sort=strategic opt-in",
    /sortMode[\s\S]{0,200}sort.*===\s*["']strategic["']/.test(wqSrc),
  );
  assert(
    "work-queue handler imports computeLaneStrategicPriority",
    /from\s+["']\.\.\/services\/laneStrategicPriority["']/.test(wqSrc)
      && /computeLaneStrategicPriority/.test(wqSrc),
  );
  assert(
    "work-queue rows pair strategicPriority with priorityExplanation",
    /r\.strategicPriority\s*=[\s\S]{0,200}r\.priorityExplanation\s*=/.test(wqSrc),
  );
  assert(
    "LeanItem type declares both strategicPriority and priorityExplanation",
    /strategicPriority\?:\s*number;[\s\S]{0,200}priorityExplanation\?:/.test(wqSrc),
  );

  // (d) Per-org weights live in their own settings module + admin route.
  const settingsSrc = readFile("server/laneStrategicWeights.ts");
  assert(
    "laneStrategicWeights exports get/set helpers",
    /export async function getLaneStrategicWeights\b/.test(settingsSrc)
      && /export async function setLaneStrategicWeights\b/.test(settingsSrc),
  );
  const adminSrc = readFile("server/routes/carrierIntelligenceScoring.ts");
  assert(
    "admin route exposes GET + PUT /api/admin/lane-strategic-weights",
    /app\.get\("\/api\/admin\/lane-strategic-weights"/.test(adminSrc)
      && /app\.put\("\/api\/admin\/lane-strategic-weights"/.test(adminSrc),
  );

  // (e) Admin UI surfaces the new card so admins can tune without a deploy.
  const adminPageSrc = readFile("client/src/pages/admin-carrier-intelligence-scoring.tsx");
  assert(
    "admin scoring page renders the lane-strategic-weights card",
    /data-testid="card-lane-strategic-weights"/.test(adminPageSrc)
      && /data-testid="button-save-lane-strategic-weights"/.test(adminPageSrc),
  );

  // (f) Scorer signature uses real signals — NOT lifecycle-proxied "hot"
  //     and NOT generic "any-rep" freshness. Code review specifically
  //     rejected the proxies; this guardrail prevents regression.
  assert(
    "scorer accepts hotReplyCount (real lane_carrier_interest signal)",
    /hotReplyCount\s*:\s*number/.test(pureSrc),
  );
  assert(
    "scorer accepts daysSinceOwnerTouchpoint (owner-specific freshness)",
    /daysSinceOwnerTouchpoint\s*:\s*number/.test(pureSrc),
  );
  assert(
    "scorer accepts strategicTierBoost (on-company strategic signal)",
    /strategicTierBoost\?:\s*number/.test(pureSrc),
  );
  assert(
    "scorer no longer carries the lifecycle-proxied isHot field",
    !/\bisHot\b/.test(pureSrc),
  );

  // (g) Route batch-loads the real Hot signal from lane_carrier_interest
  //     and filters touchpoints by ownerRepId.
  assert(
    "work-queue batch-loads Hot replies from lane_carrier_interest",
    /laneCarrierInterest[\s\S]{0,400}available_now[\s\S]{0,80}available_next_week/.test(wqSrc),
  );
  assert(
    "work-queue filters touchpoints by company ownerRepId for freshness",
    /touchpoints\.loggedById/.test(wqSrc) && /ownerRepId/.test(wqSrc),
  );
  assert(
    "work-queue passes hotReplyCount + daysSinceOwnerTouchpoint to scorer",
    /hotReplyCount:\s*hotByLaneId/.test(wqSrc)
      && /daysSinceOwnerTouchpoint/.test(wqSrc),
  );

  // (h) LWQ page exposes the opt-in Strategic toggle AND skips the
  //     client-side resort when strategic mode is active (otherwise the
  //     server's strategic ordering would be silently overridden).
  const lwqSrc = readFile("client/src/pages/lane-work-queue.tsx");
  assert(
    "LWQ page renders the Strategic sort toggle",
    /data-testid="select-lwq-sort-mode"/.test(lwqSrc)
      && /data-testid="option-sort-strategic"/.test(lwqSrc),
  );
  assert(
    "LWQ page threads sort=strategic into the work-queue request",
    /sortMode\s*===\s*["']strategic["'][\s\S]{0,200}sp\.set\(\s*["']sort["']\s*,\s*["']strategic["']\s*\)/.test(lwqSrc),
  );
  assert(
    "LWQ page skips client-side resort when strategic mode is active",
    /if\s*\(\s*sortMode\s*===\s*["']strategic["']\s*\)\s*return\s+filteredQueue\?\.unassigned/.test(lwqSrc),
  );

  // (i) Unit tests for the pure scorer exist (code review required them).
  const unitSrc = readFile("tests/lane-strategic-priority.test.ts");
  assert(
    "unit tests file imports computeLaneStrategicPriority",
    /computeLaneStrategicPriority/.test(unitSrc)
      && /from\s+["']\.\.\/server\/services\/laneStrategicPriority["']/.test(unitSrc),
  );
  assert(
    "unit tests cover the contract edge cases",
    /missing customer value/i.test(unitSrc)
      && /never[- ]touched|null daysSinceOwnerTouchpoint/i.test(unitSrc)
      && /priorCoveredLoads=0/i.test(unitSrc)
      && /null lifecycle/i.test(unitSrc)
      && /strategicTierBoost/i.test(unitSrc)
      && /hotReplyCount/i.test(unitSrc),
  );
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────────────────────\n`);
if (failures.length > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
