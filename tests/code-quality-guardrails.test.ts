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

const customerQuotesContent = readFile("client/src/pages/customer-quotes.tsx");
assert(
  "customer-quotes page — uses ErrorBanner for query errors",
  customerQuotesContent.includes("ErrorBanner") && customerQuotesContent.includes("snapshotQuery.isError"),
  "customer-quotes.tsx is missing ErrorBanner wiring on snapshot/list queries"
);

assert(
  "customer-quotes page — uses EmptyState for empty filtered table",
  customerQuotesContent.includes("EmptyState") && customerQuotesContent.includes("empty-quote-rows"),
  "customer-quotes.tsx VirtualTable does not use EmptyState for empty results"
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
// with `lastEmailAt` (server-computed as MAX(email_messages.provider_sent_at))
// plus the existing `lastIncomingAt` / `lastOutgoingAt` denorm columns.
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
  "routes/conversations.ts — exposes computeLastEmailAtMap helper",
  /computeLastEmailAtMap/.test(conversationsRouteSrc) &&
    /MAX\s*\(\s*\$\{?\s*emailMessages\.providerSentAt/.test(conversationsRouteSrc),
  "server/routes/conversations.ts must compute lastEmailAt as MAX(email_messages.provider_sent_at) per page.",
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

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────────────────────\n`);
if (failures.length > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
