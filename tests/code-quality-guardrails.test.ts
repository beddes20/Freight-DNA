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

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────────────────────\n`);
if (failures.length > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
