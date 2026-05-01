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

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────────────────────\n`);
if (failures.length > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
