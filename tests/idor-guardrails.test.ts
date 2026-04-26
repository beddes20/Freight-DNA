/**
 * IDOR Guardrails — Static Analysis for Multi-Tenancy Isolation
 *
 * Purpose: Prevent regressions on the IDOR fixes applied in the security
 * improvement pass. Unscoped calls to getContacts/getRfps/getAwards leak
 * cross-tenant data. These tests read source files and assert that the
 * unscoped methods are not called from any route handler.
 *
 * What this guards:
 *   1. storage.getRfps()  — unscoped; use getRfpsByOrg() or getRfpsByCompanyId()
 *   2. storage.getAwards() — unscoped; use getAwardsByOrg() or getAwardsByCompanyId()
 *   3. storage.getContacts() — unscoped; use getContactsByOrg() or getContactsByCompany()
 *
 * Exception: the methods themselves (in storage.ts) and the IStorage interface
 * declarations are allowed — only route files are checked.
 *
 * Run with: npx tsx tests/idor-guardrails.test.ts
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

// Route files to audit (excludes storage.ts itself and non-route server files)
const ROUTE_FILE_ROOTS = [
  path.join(ROOT, "server", "routes.ts"),
];
const ROUTE_DIR = path.join(ROOT, "server", "routes");
const routeFiles: string[] = [
  ...ROUTE_FILE_ROOTS.filter(f => fs.existsSync(f)),
  ...walkFiles(ROUTE_DIR, ".ts"),
];

// Patterns that are NOT allowed in route files
interface ForbiddenPattern {
  method: string;
  regex: RegExp;
  safeAlternatives: string[];
}

const FORBIDDEN: ForbiddenPattern[] = [
  {
    method: "storage.getRfps()",
    regex: /storage\.getRfps\(\)/g,
    safeAlternatives: ["getRfpsByOrg(orgId)", "getRfpsByCompanyId(companyId)"],
  },
  {
    method: "storage.getAwards()",
    regex: /storage\.getAwards\(\)/g,
    safeAlternatives: ["getAwardsByOrg(orgId)", "getAwardsByCompanyId(companyId)"],
  },
  {
    method: "storage.getContacts()",
    regex: /storage\.getContacts\(\)/g,
    safeAlternatives: ["getContactsByOrg(orgId)", "getContactsByCompany(companyId)"],
  },
];

console.log("\n── IDOR Guardrails: Unscoped tenant-crossing storage calls ──────────\n");

for (const forbidden of FORBIDDEN) {
  const violatingFiles: string[] = [];

  for (const filePath of routeFiles) {
    const content = readFile(path.relative(ROOT, filePath));
    // Strip single-line comments so we don't flag commented-out code
    const uncommented = content.replace(/\/\/[^\n]*/g, "");
    const matches = uncommented.match(forbidden.regex);
    if (matches && matches.length > 0) {
      const rel = path.relative(ROOT, filePath);
      violatingFiles.push(`${rel} (${matches.length} call${matches.length > 1 ? "s" : ""})`);
    }
  }

  assert(
    `No route file calls ${forbidden.method}`,
    violatingFiles.length === 0,
    violatingFiles.length > 0
      ? `Violations found:\n    ${violatingFiles.join("\n    ")}\n    Use instead: ${forbidden.safeAlternatives.join(" or ")}`
      : undefined,
  );
}

console.log("\n── AI Caching: Critical AI endpoints should use cacheGet/cacheSet ──\n");

const ROUTES_CONTENT = readFile("server/routes.ts");

// Health score narrative endpoint should have a cache check
assert(
  "Health score narrative endpoint has cacheGet guard",
  ROUTES_CONTENT.includes("health-narrative:") && ROUTES_CONTENT.includes("cacheGet"),
);

// Touchpoint summary endpoint should have a cache check
assert(
  "Touchpoint summary endpoint has cacheGet guard",
  ROUTES_CONTENT.includes("tp-summary:") && ROUTES_CONTENT.includes("cacheGet"),
);

// 1:1 session summary endpoint should have a cache check
assert(
  "1:1 session summary endpoint has cacheGet guard",
  ROUTES_CONTENT.includes("session-summary:") && ROUTES_CONTENT.includes("cacheGet"),
);

console.log("\n── Bulk Import Dedup: bulkCreate methods should check for duplicates ──\n");

const STORAGE_CONTENT = readFile("server/storage.ts");

assert(
  "bulkCreateCompanies checks for existing names before inserting",
  STORAGE_CONTENT.includes("existingNamesLower") && STORAGE_CONTENT.includes("toLowerCase().trim()"),
);

assert(
  "bulkCreateContacts checks for existing email/name before inserting",
  STORAGE_CONTENT.includes("existingKeys") && STORAGE_CONTENT.includes("toLowerCase().trim()"),
);

console.log("\n── DB Indexes: Key tables should declare compound performance indexes ──\n");

const SCHEMA_CONTENT = readFile("shared/schema.ts");

assert(
  "companies table has org index",
  SCHEMA_CONTENT.includes("companies_org_idx"),
);

assert(
  "contacts table has company index",
  SCHEMA_CONTENT.includes("contacts_company_idx"),
);

assert(
  "tasks table has assigned+status index",
  SCHEMA_CONTENT.includes("tasks_assigned_to_status_idx"),
);

assert(
  "notifications table has user+created index",
  SCHEMA_CONTENT.includes("notifications_user_created_idx"),
);

assert(
  "carriers table has org+status index",
  SCHEMA_CONTENT.includes("carriers_org_status_idx"),
);

assert(
  "email_conversation_threads table has org+updatedAt index",
  SCHEMA_CONTENT.includes("ect_org_updated_idx"),
);

// ─── Final report ─────────────────────────────────────────────────────────────
console.log("\n──────────────────────────────────────────────────────────────────────");
if (failures.length > 0) {
  console.error(`  ${passed} passed, ${failed} failed`);
  console.error("\nFailed assertions:");
  failures.forEach(f => console.error(`  • ${f}`));
  console.log("══════════════════════════════════════════════════════════════════════");
  process.exit(1);
} else {
  console.log(`  ${passed} passed, 0 failed`);
  console.log("══════════════════════════════════════════════════════════════════════");
}
