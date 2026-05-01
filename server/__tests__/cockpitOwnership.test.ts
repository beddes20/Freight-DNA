import { describe, it, expect } from "vitest";
import {
  buildRowOwnership,
  isRowOwnedByUser,
  resolveUserIdentity,
  rowOwnerKeys,
} from "../../shared/cockpitOwnership";

describe("shared/cockpitOwnership (Task #875)", () => {
  describe("resolveUserIdentity", () => {
    it("lowercases username/email and trims whitespace", () => {
      const id = resolveUserIdentity({ id: "u1", username: "  Jared@Arrive.COM  ", email: "Jared@Arrive.com" });
      expect(id).toEqual({ id: "u1", emailLower: "jared@arrive.com", usernameLower: "jared@arrive.com" });
    });
    it("returns null when id missing", () => {
      expect(resolveUserIdentity(null)).toBeNull();
      expect(resolveUserIdentity({ username: "x" } as { username: string })).toBeNull();
    });
    it("treats empty strings as null", () => {
      const id = resolveUserIdentity({ id: "u1", username: "", email: "   " });
      expect(id).toEqual({ id: "u1", emailLower: null, usernameLower: null });
    });
  });

  describe("buildRowOwnership", () => {
    it("dedupes ids and emails across owner-shape fields", () => {
      const users: Record<string, string> = {
        owner: "owner@arrive.com",
        delegated: "lm@arrive.com",
        creator: "owner@arrive.com", // shares email with owner
        approver: "boss@arrive.com",
      };
      const ownership = buildRowOwnership(
        {
          ownerUserId: "owner",
          delegatedToUserId: "delegated",
          createdById: "creator",
          approvedById: "approver",
        },
        (id) => users[id] ?? null,
      );
      expect(ownership.ids).toEqual(["owner", "delegated", "creator", "approver"]);
      // owner & creator share an email — should appear once
      expect(ownership.emails).toEqual(["owner@arrive.com", "lm@arrive.com", "boss@arrive.com"]);
    });

    it("ignores null/undefined owner-shape fields", () => {
      const ownership = buildRowOwnership(
        { ownerUserId: "owner", delegatedToUserId: null, createdById: undefined, approvedById: null },
        () => "owner@arrive.com",
      );
      expect(ownership.ids).toEqual(["owner"]);
      expect(ownership.emails).toEqual(["owner@arrive.com"]);
    });
  });

  describe("isRowOwnedByUser", () => {
    const jared = resolveUserIdentity({ id: "jared", username: "jared@arrive.com" })!;

    it("matches by direct id", () => {
      const ownership = { ids: ["jared"], emails: [] };
      expect(isRowOwnedByUser(ownership, jared)).toBe(true);
    });

    it("matches by delegated id", () => {
      const ownership = { ids: ["lm", "jared"], emails: [] };
      expect(isRowOwnedByUser(ownership, jared)).toBe(true);
    });

    it("matches by email even when ids differ", () => {
      const ownership = { ids: ["stranger"], emails: ["jared@arrive.com"] };
      expect(isRowOwnedByUser(ownership, jared)).toBe(true);
    });

    it("falls back to legacy owner.id when ownership envelope is missing", () => {
      expect(isRowOwnedByUser(null, jared, "jared")).toBe(true);
      expect(isRowOwnedByUser(null, jared, "stranger")).toBe(false);
    });

    it("returns false when identity is null", () => {
      expect(isRowOwnedByUser({ ids: ["jared"], emails: [] }, null)).toBe(false);
    });

    it("does not match unrelated owners", () => {
      const ownership = { ids: ["lm", "stranger"], emails: ["lm@arrive.com"] };
      expect(isRowOwnedByUser(ownership, jared)).toBe(false);
    });
  });

  describe("rowOwnerKeys", () => {
    it("merges legacy owner id into the envelope", () => {
      const { ids, emails } = rowOwnerKeys({ ids: ["a"], emails: ["a@x"] }, "legacy");
      expect(ids).toEqual(new Set(["a", "legacy"]));
      expect(emails).toEqual(new Set(["a@x"]));
    });
  });
});
