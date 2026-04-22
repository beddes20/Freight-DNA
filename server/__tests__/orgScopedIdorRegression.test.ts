/**
 * Cross-Org IDOR Regression Suite
 *
 * Locks in the per-tenant scoping behavior of the storage methods that
 * the route layer relies on to prevent Insecure Direct Object Reference
 * leaks across organizations:
 *
 *   - storage.getRfpInOrg(id, orgId)
 *   - storage.getAwardInOrg(id, orgId)
 *   - storage.getPtoPassoffInOrg(id, orgId)
 *
 * The architect has flagged the lack of these tests in three consecutive
 * reviews. Until now we'd been verifying the SQL by code inspection.
 *
 * Pattern per fixture group:
 *   1. Create org A and org B
 *   2. Create the parent row (company in org A, or user in org A)
 *   3. Create the target row (rfp/award/passoff)
 *   4. Positive assertion: lookup in org A returns the row
 *   5. Negative assertion: lookup in org B returns undefined (the IDOR test)
 *   6. Cleanup all fixture rows in reverse FK order
 *
 * These run against the live dev DATABASE_URL with isolated random IDs.
 * Cleanup is in `afterAll` and uses try/catch so a partial failure of one
 * group does not leak fixtures from the other groups.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, storage } from "../storage";
import {
  organizations,
  companies,
  users,
  rfps,
  awards,
  ptoPassoffs,
} from "@shared/schema";
import { eq, inArray } from "drizzle-orm";

// Each test run uses a unique tag so concurrent runs / partial cleanup
// from a prior crashed run can be identified and pruned manually if needed.
const RUN_TAG = `idor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// IDs we create — tracked here so afterAll can scrub even if a test fails.
const created = {
  orgIds: [] as string[],
  userIds: [] as string[],
  companyIds: [] as string[],
  rfpIds: [] as string[],
  awardIds: [] as string[],
  ptoIds: [] as string[],
};

let orgA = "";
let orgB = "";
let companyAId = "";
let userAId = "";
let rfpId = "";
let awardId = "";
let ptoId = "";

beforeAll(async () => {
  // ── Two orgs ──────────────────────────────────────────────────────────
  const [oA] = await db.insert(organizations).values({
    name: `${RUN_TAG}-orgA`, slug: `${RUN_TAG}-a`,
  }).returning();
  const [oB] = await db.insert(organizations).values({
    name: `${RUN_TAG}-orgB`, slug: `${RUN_TAG}-b`,
  }).returning();
  orgA = oA.id;
  orgB = oB.id;
  created.orgIds.push(oA.id, oB.id);

  // ── A user + a company in org A (parents for the target rows) ────────
  const [uA] = await db.insert(users).values({
    organizationId: orgA,
    username: `${RUN_TAG}-u`,
    name: "IDOR Test User",
    role: "account_manager",
  }).returning();
  userAId = uA.id;
  created.userIds.push(uA.id);

  const [cA] = await db.insert(companies).values({
    organizationId: orgA,
    name: `${RUN_TAG}-co`,
  }).returning();
  companyAId = cA.id;
  created.companyIds.push(cA.id);

  // ── Target rows: rfp, award, pto passoff ─────────────────────────────
  const [r] = await db.insert(rfps).values({
    companyId: companyAId,
    title: `${RUN_TAG}-rfp`,
    status: "pending",
  }).returning();
  rfpId = r.id;
  created.rfpIds.push(r.id);

  const [a] = await db.insert(awards).values({
    companyId: companyAId,
    title: `${RUN_TAG}-award`,
  }).returning();
  awardId = a.id;
  created.awardIds.push(a.id);

  const [p] = await db.insert(ptoPassoffs).values({
    createdById: userAId,
    startDate: "2026-05-01",
    endDate: "2026-05-05",
    status: "draft",
    createdAt: new Date().toISOString(),
  }).returning();
  ptoId = p.id;
  created.ptoIds.push(p.id);
});

afterAll(async () => {
  // Reverse FK order. Each delete is wrapped so a failure on one does
  // not skip the others — fixtures must be scrubbed even on partial failure.
  const safeDelete = async <T,>(label: string, fn: () => Promise<T>) => {
    try { await fn(); } catch (e) {
      console.error(`[idor-test cleanup] ${label} failed:`, e);
    }
  };
  if (created.rfpIds.length)     await safeDelete("rfps",       () => db.delete(rfps).where(inArray(rfps.id, created.rfpIds)));
  if (created.awardIds.length)   await safeDelete("awards",     () => db.delete(awards).where(inArray(awards.id, created.awardIds)));
  if (created.ptoIds.length)     await safeDelete("pto",        () => db.delete(ptoPassoffs).where(inArray(ptoPassoffs.id, created.ptoIds)));
  if (created.companyIds.length) await safeDelete("companies",  () => db.delete(companies).where(inArray(companies.id, created.companyIds)));
  if (created.userIds.length)    await safeDelete("users",      () => db.delete(users).where(inArray(users.id, created.userIds)));
  if (created.orgIds.length)     await safeDelete("orgs",       () => db.delete(organizations).where(inArray(organizations.id, created.orgIds)));
});

// ─── 1: getRfpInOrg ───────────────────────────────────────────────────────────

describe("storage.getRfpInOrg — cross-org IDOR protection", () => {
  it("[1a] returns the RFP when queried with the OWNING org's ID", async () => {
    const row = await storage.getRfpInOrg(rfpId, orgA);
    expect(row).toBeDefined();
    expect(row?.id).toBe(rfpId);
    expect(row?.companyId).toBe(companyAId);
  });

  it("[1b] returns undefined when queried with a DIFFERENT org's ID (IDOR blocked)", async () => {
    const row = await storage.getRfpInOrg(rfpId, orgB);
    expect(row).toBeUndefined();
  });

  it("[1c] sanity: the unscoped getRfp DOES return the row (proving the scoped method is what blocks IDOR, not the absence of data)", async () => {
    const row = await storage.getRfp(rfpId);
    expect(row).toBeDefined();
    expect(row?.id).toBe(rfpId);
  });
});

// ─── 2: getAwardInOrg ─────────────────────────────────────────────────────────

describe("storage.getAwardInOrg — cross-org IDOR protection", () => {
  it("[2a] returns the award for the owning org", async () => {
    const row = await storage.getAwardInOrg(awardId, orgA);
    expect(row).toBeDefined();
    expect(row?.id).toBe(awardId);
  });

  it("[2b] returns undefined for a foreign org", async () => {
    const row = await storage.getAwardInOrg(awardId, orgB);
    expect(row).toBeUndefined();
  });

  it("[2c] sanity: unscoped getAward returns the row", async () => {
    const row = await storage.getAward(awardId);
    expect(row).toBeDefined();
    expect(row?.id).toBe(awardId);
  });
});

// ─── 3: getPtoPassoffInOrg ────────────────────────────────────────────────────

describe("storage.getPtoPassoffInOrg — cross-org IDOR protection", () => {
  it("[3a] returns the passoff for the owning org (joined via createdById -> users.organizationId)", async () => {
    const row = await storage.getPtoPassoffInOrg(ptoId, orgA);
    expect(row).toBeDefined();
    expect(row?.id).toBe(ptoId);
  });

  it("[3b] returns undefined for a foreign org", async () => {
    const row = await storage.getPtoPassoffInOrg(ptoId, orgB);
    expect(row).toBeUndefined();
  });

  it("[3c] sanity: unscoped getPtoPassoff returns the row", async () => {
    const row = await storage.getPtoPassoff(ptoId);
    expect(row).toBeDefined();
    expect(row?.id).toBe(ptoId);
  });
});

// ─── 4: lookups for rows that don't exist ─────────────────────────────────────

describe("org-scoped lookups — missing IDs", () => {
  it("[4a] getRfpInOrg returns undefined for a non-existent RFP id", async () => {
    expect(await storage.getRfpInOrg("non-existent-rfp-id", orgA)).toBeUndefined();
  });
  it("[4b] getAwardInOrg returns undefined for a non-existent award id", async () => {
    expect(await storage.getAwardInOrg("non-existent-award-id", orgA)).toBeUndefined();
  });
  it("[4c] getPtoPassoffInOrg returns undefined for a non-existent passoff id", async () => {
    expect(await storage.getPtoPassoffInOrg("non-existent-pto-id", orgA)).toBeUndefined();
  });
});
