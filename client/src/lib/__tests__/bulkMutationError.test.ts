// Task #1151 — Tests for the CQ bulk-mutation error parser/formatter.
//
// The parser is the only thing standing between `apiRequest`'s flattened
// "<status>: <body>" Error and a precise rep-facing message. If it
// silently degrades a partial-403 response into "Forbidden", reps lose
// the deniedIds and the safest reaction is to retry blindly.

import { describe, expect, it } from "vitest";
import {
  parseBulkMutationError,
  formatBulkMutationErrorTitle,
} from "../bulkMutationError";

function err(status: number, body: unknown): Error {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Error(`${status}: ${text}`);
}

describe("parseBulkMutationError", () => {
  it("recovers deniedIds from a partial-403 (forbidden) response", () => {
    const info = parseBulkMutationError(
      err(403, {
        error: "Some quotes belong to another rep",
        deniedIds: ["q1", "q2", "q3"],
      }),
    );
    expect(info.status).toBe(403);
    expect(info.reason).toBe("forbidden");
    expect(info.deniedIds).toEqual(["q1", "q2", "q3"]);
    expect(info.missingIds).toEqual([]);
    expect(info.message).toBe("Some quotes belong to another rep");
    expect(info.affectedCount).toBe(3);
  });

  it("recovers missingIds from a partial-404 (not_found) response", () => {
    const info = parseBulkMutationError(
      err(404, {
        error: "One or more quotes not found",
        missingIds: ["q9"],
      }),
    );
    expect(info.status).toBe(404);
    expect(info.reason).toBe("not_found");
    expect(info.missingIds).toEqual(["q9"]);
    expect(info.deniedIds).toEqual([]);
    expect(info.affectedCount).toBe(1);
  });

  it("classifies the no_rep_mapping branch on a 403 with no deniedIds", () => {
    const info = parseBulkMutationError(
      err(403, { error: "No rep mapping — cannot flip status" }),
    );
    expect(info.status).toBe(403);
    expect(info.reason).toBe("no_rep_mapping");
    expect(info.deniedIds).toEqual([]);
    expect(info.missingIds).toEqual([]);
  });

  it("falls back gracefully on a non-JSON body", () => {
    const info = parseBulkMutationError(new Error("500: Internal Server Error"));
    expect(info.status).toBe(500);
    expect(info.reason).toBe("unknown");
    expect(info.message).toBe("Internal Server Error");
  });

  it("falls back gracefully on a non-Error throwable", () => {
    const info = parseBulkMutationError("totally unstructured");
    expect(info.status).toBeNull();
    expect(info.reason).toBe("unknown");
    expect(info.message).toBe("totally unstructured");
    expect(info.deniedIds).toEqual([]);
    expect(info.missingIds).toEqual([]);
  });

  it("ignores non-string array entries defensively", () => {
    const info = parseBulkMutationError(
      err(403, { error: "Some quotes belong to another rep", deniedIds: ["q1", 42, null, "q2"] }),
    );
    expect(info.deniedIds).toEqual(["q1", "q2"]);
  });
});

describe("formatBulkMutationErrorTitle", () => {
  it("names the count and total on the partial-403 branch", () => {
    const info = parseBulkMutationError(
      err(403, {
        error: "Some quotes belong to another rep",
        deniedIds: ["q1", "q2"],
      }),
    );
    expect(formatBulkMutationErrorTitle(info, 5)).toBe(
      "2 of 5 quotes belong to another rep and were skipped",
    );
  });

  it("names the count on the partial-404 branch", () => {
    const info = parseBulkMutationError(
      err(404, { error: "One or more quotes not found", missingIds: ["q9"] }),
    );
    expect(formatBulkMutationErrorTitle(info, 3)).toBe(
      "1 of 3 quotes could not be found",
    );
  });

  it("uses the explicit cause string for no_rep_mapping", () => {
    const info = parseBulkMutationError(
      err(403, { error: "No rep mapping — cannot flip status" }),
    );
    expect(formatBulkMutationErrorTitle(info)).toBe(
      "You're not mapped to a quote rep — bulk action cannot proceed",
    );
  });

  it("singularizes verb agreement when exactly one row is affected and no total is given", () => {
    const info = parseBulkMutationError(
      err(403, {
        error: "Some quotes belong to another rep",
        deniedIds: ["q1"],
      }),
    );
    expect(formatBulkMutationErrorTitle(info)).toBe(
      "1 quote belongs to another rep and was skipped",
    );
  });

  it("keeps plural agreement when a total is supplied", () => {
    const info = parseBulkMutationError(
      err(403, {
        error: "Some quotes belong to another rep",
        deniedIds: ["q1"],
      }),
    );
    expect(formatBulkMutationErrorTitle(info, 4)).toBe(
      "1 of 4 quotes belong to another rep and were skipped",
    );
  });

  it("falls back to the server message on the unknown branch", () => {
    const info = parseBulkMutationError(new Error("500: Internal Server Error"));
    expect(formatBulkMutationErrorTitle(info)).toBe("Internal Server Error");
  });
});
