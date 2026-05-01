// Workflow OS — Owner-filter predicates.
//
// Locks the contract that AM-aware filtering lives inside the Owner
// dropdown (ADR-001 in docs/workflow-os-spec.md). Covers:
//   - AM seeing their own accounts.
//   - NAM seeing their direct reports' accounts.
//   - Rep seeing nothing in `am_book` mode (their AM is somebody else).
//   - `companies.assignedTo` null falling through to no match.

import { describe, it, expect } from "vitest";
import {
  isRowInUsersAmBook,
  applyOwnerFilter,
  isRepLikeRole,
  WORKFLOW_OS_REP_ROLES,
  type WorkflowOsRow,
  type WorkflowOsUser,
  type OwnerFilterValue,
} from "@shared/workflowOs/ownership";

const am: WorkflowOsUser = { id: "am-1", role: "account_manager", name: "Alice" };
const am2: WorkflowOsUser = { id: "am-2", role: "account_manager", name: "Bob", managerId: "nam-1" };
const am3: WorkflowOsUser = { id: "am-3", role: "account_manager", name: "Carol", managerId: "nam-1" };
const nam: WorkflowOsUser = { id: "nam-1", role: "national_account_manager", name: "Nina" };
const rep: WorkflowOsUser = { id: "rep-1", role: "sales", name: "Rita" };

const ORG = [am, am2, am3, nam, rep];

function row(overrides: Partial<WorkflowOsRow>): WorkflowOsRow {
  return { ...overrides };
}

describe("isRowInUsersAmBook", () => {
  it("returns true when the AM is assigned to the row's company", () => {
    const r = row({ companyId: "co-1" });
    const map = new Map([["co-1", "am-1"]]);
    expect(isRowInUsersAmBook(r, am, ORG, map)).toBe(true);
  });

  it("returns true for a NAM when the assignee is one of their direct reports", () => {
    const r = row({ companyId: "co-2" });
    const map = new Map([["co-2", "am-2"]]);
    expect(isRowInUsersAmBook(r, nam, ORG, map)).toBe(true);
  });

  it("returns false for a rep whose AM is somebody else", () => {
    const r = row({ companyId: "co-1" });
    const map = new Map([["co-1", "am-1"]]);
    expect(isRowInUsersAmBook(r, rep, ORG, map)).toBe(false);
  });

  it("returns false when companies.assignedTo is null/undefined", () => {
    const r = row({ companyId: "co-3" });
    const map = new Map([["co-3", null]]);
    expect(isRowInUsersAmBook(r, am, ORG, map)).toBe(false);
    const empty = new Map<string, string | null>();
    expect(isRowInUsersAmBook(r, am, ORG, empty)).toBe(false);
  });

  it("returns false when row.companyId is missing", () => {
    const r = row({});
    const map = new Map([["co-1", "am-1"]]);
    expect(isRowInUsersAmBook(r, am, ORG, map)).toBe(false);
  });
});

describe("applyOwnerFilter", () => {
  const rows: WorkflowOsRow[] = [
    { ownerUserId: "am-1", companyId: "co-1", ownership: { ids: ["am-1"], emails: [] } },
    { ownerUserId: "am-2", companyId: "co-2", ownership: { ids: ["am-2"], emails: [] } },
    { ownerUserId: undefined, delegatedToUserId: undefined, companyId: "co-3", ownership: { ids: [], emails: [] } },
    { ownerUserId: "rep-1", delegatedToUserId: "am-1", companyId: "co-1", ownership: { ids: ["rep-1", "am-1"], emails: [] } },
  ];

  const ctx = {
    user: am,
    orgUsers: ORG,
    companyAssignedToByCompanyId: new Map<string, string | null>([
      ["co-1", "am-1"],
      ["co-2", "am-2"],
      ["co-3", null],
    ]),
  };

  it("'all' returns every row", () => {
    expect(applyOwnerFilter(rows, "all" as OwnerFilterValue, ctx)).toHaveLength(rows.length);
  });

  it("'me' matches via the row's ownership envelope", () => {
    const out = applyOwnerFilter(rows, "me" as OwnerFilterValue, ctx);
    // am-1 is owner on row 0 and delegated on row 3.
    expect(out.map((r) => r.ownerUserId)).toEqual(["am-1", "rep-1"]);
  });

  it("'unassigned' returns rows with no owner and no delegate", () => {
    const out = applyOwnerFilter(rows, "unassigned" as OwnerFilterValue, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].companyId).toBe("co-3");
  });

  it("'am_book' returns rows in the user's AM book", () => {
    const out = applyOwnerFilter(rows, "am_book" as OwnerFilterValue, ctx);
    // am sees their own accounts only (co-1).
    expect(out.map((r) => r.companyId)).toEqual(["co-1", "co-1"]);
  });

  it("'am_book' for a NAM picks up their direct reports' books", () => {
    const out = applyOwnerFilter(rows, "am_book" as OwnerFilterValue, {
      ...ctx,
      user: nam,
    });
    // nam sees am-2's book (co-2) — am-1 is not their direct report, so co-1 is excluded.
    expect(out.map((r) => r.companyId)).toEqual(["co-2"]);
  });

  it("{ specificUserId } returns rows owned/delegated to that user", () => {
    const out = applyOwnerFilter(
      rows,
      { specificUserId: "am-1" } as OwnerFilterValue,
      ctx,
    );
    expect(out.map((r) => r.ownerUserId)).toEqual(["am-1", "rep-1"]);
  });
});

describe("isRepLikeRole", () => {
  it("accepts every canonical rep-ish role and rejects others", () => {
    for (const r of WORKFLOW_OS_REP_ROLES) {
      expect(isRepLikeRole(r)).toBe(true);
    }
    expect(isRepLikeRole("admin")).toBe(false);
    expect(isRepLikeRole("director")).toBe(false);
    expect(isRepLikeRole(null)).toBe(false);
    expect(isRepLikeRole(undefined)).toBe(false);
  });
});
