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

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────────────────────\n`);
if (failures.length > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
