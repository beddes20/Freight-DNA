/**
 * Task #1126 — Admin-only User Roster Health snapshot endpoints.
 *
 * Pure SELECT-only. Returns a heuristic classification of every user in
 * the caller's organization (org-scoped, never cross-tenant) plus a CSV
 * export per bucket. No writes, no side effects, no row-level actions.
 *
 * See `docs/user-roster-classification.md` for the rule set and Phase 1
 * mapping.
 */

import type { Express } from "express";
import { requireAuth, getCurrentUser } from "../auth";
import { isAdmin } from "../lib/roles";
import { qStr } from "../lib/req";
import {
  getRosterHealthSnapshot,
  ROSTER_BUCKETS,
  ROSTER_BUCKET_LABELS,
  type RosterBucket,
  type ClassifiedUser,
} from "../lib/userRosterClassification";

const MAX_EXAMPLES_PER_BUCKET = 50;

function isValidBucket(v: string): v is RosterBucket {
  return (ROSTER_BUCKETS as string[]).includes(v);
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const out: string[] = [];
  out.push(headers.map(csvEscape).join(","));
  for (const r of rows) out.push(r.map(csvEscape).join(","));
  return out.join("\r\n");
}

function userToCsvRow(u: ClassifiedUser): unknown[] {
  return [
    u.id,
    u.name,
    u.username,
    u.role,
    u.organizationId,
    u.managerId ?? "",
    u.financialRepId ?? "",
    u.lastLoginAt ?? "",
    u.createdAt ?? "",
    u.bucket,
    u.reason,
    u.activity.notesAuthored,
    u.activity.touchpoints,
    u.activity.ownedCompanies,
    u.activity.ownedOpportunities,
    u.activity.assignedTasks,
    u.activity.freightRows,
    u.totalActivity,
    u.reviewPriority,
    // signals are joined with ";" — semicolons are safe inside the
    // CSV-quoted cell and let downstream sheets split on `;` if desired.
    u.signals.join(";"),
  ];
}

const CSV_HEADERS = [
  "id",
  "name",
  "username",
  "role",
  "organizationId",
  "managerId",
  "financialRepId",
  "lastLoginAt",
  "createdAt",
  "bucket",
  "reason",
  "notesAuthored",
  "touchpoints",
  "ownedCompanies",
  "ownedOpportunities",
  "assignedTasks",
  "freightRows",
  "totalActivity",
  "reviewPriority",
  "signals",
];

// Cleanup buckets: the reviewer wants the most clearly cleanup-worthy
// rows on top, NOT the most-active ones (which would bury the obvious
// fixtures and shared inboxes). Real buckets stay sorted by activity.
const CLEANUP_BUCKETS: ReadonlySet<RosterBucket> = new Set<RosterBucket>([
  "likely_junk",
  "likely_demo_fixture",
  "likely_service_shared_inbox",
  "uncertain",
]);

function compareForBucket(bucket: RosterBucket) {
  if (CLEANUP_BUCKETS.has(bucket)) {
    return (a: ClassifiedUser, b: ClassifiedUser) => {
      if (b.reviewPriority !== a.reviewPriority) return b.reviewPriority - a.reviewPriority;
      if (a.totalActivity !== b.totalActivity) return a.totalActivity - b.totalActivity;
      const aCreated = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bCreated = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (bCreated !== aCreated) return bCreated - aCreated;
      return a.name.localeCompare(b.name);
    };
  }
  return (a: ClassifiedUser, b: ClassifiedUser) =>
    b.totalActivity - a.totalActivity || a.name.localeCompare(b.name);
}

export function registerAdminRosterHealthRoutes(app: Express) {
  // ──────────────────────────────────────────────────────────────────────────
  // Both routes below MUST stay admin-only and org-scoped:
  //   • requireAuth        — 401 if no session
  //   • isAdmin(viewer)    — 403 unless role === "admin"
  //   • viewer.organizationId is the ONLY org id passed into the classifier;
  //     never trust an org id from req.query / req.body / req.params.
  // Do not relax these checks. There is no read-other-orgs use case for this
  // endpoint — admins of org A must not be able to inspect org B's roster.
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/admin/roster-health", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdmin(viewer)) return res.status(403).json({ error: "Admin only" });

      const snapshot = await getRosterHealthSnapshot(viewer.organizationId);

      // Trim each bucket to MAX_EXAMPLES_PER_BUCKET examples for the panel
      // payload. The CSV export endpoint returns the full list.
      const examplesByBucket: Record<RosterBucket, ClassifiedUser[]> = ROSTER_BUCKETS.reduce(
        (acc, b) => {
          acc[b] = [];
          return acc;
        },
        {} as Record<RosterBucket, ClassifiedUser[]>,
      );
      // Sort the FULL bucket first (so the cap takes the top-priority rows),
      // then trim. Cleanup buckets sort by reviewPriority desc; real buckets
      // sort by activity desc.
      const fullByBucket: Record<RosterBucket, ClassifiedUser[]> = ROSTER_BUCKETS.reduce(
        (acc, b) => {
          acc[b] = [];
          return acc;
        },
        {} as Record<RosterBucket, ClassifiedUser[]>,
      );
      for (const u of snapshot.users) fullByBucket[u.bucket].push(u);
      for (const b of ROSTER_BUCKETS) {
        fullByBucket[b].sort(compareForBucket(b));
        examplesByBucket[b] = fullByBucket[b].slice(0, MAX_EXAMPLES_PER_BUCKET);
      }

      res.json({
        organizationId: snapshot.organizationId,
        generatedAt: snapshot.generatedAt,
        totalUsers: snapshot.totalUsers,
        bucketCounts: snapshot.bucketCounts,
        bucketLabels: ROSTER_BUCKET_LABELS,
        buckets: ROSTER_BUCKETS,
        examplesPerBucketLimit: MAX_EXAMPLES_PER_BUCKET,
        examples: examplesByBucket,
        disclaimer: "Heuristic audit only — not saved user state. Buckets here must not drive delete, deactivate, or hide actions.",
      });
    } catch (err) {
      console.error("GET /api/admin/roster-health error:", err);
      res.status(500).json({ error: "Failed to compute roster health snapshot" });
    }
  });

  app.get("/api/admin/roster-health/export", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdmin(viewer)) return res.status(403).json({ error: "Admin only" });

      const bucket = qStr(req.query.bucket);
      if (!bucket || !isValidBucket(bucket)) {
        return res.status(400).json({ error: "Invalid bucket" });
      }

      const snapshot = await getRosterHealthSnapshot(viewer.organizationId);
      const rows = snapshot.users
        .filter((u) => u.bucket === bucket)
        .sort(compareForBucket(bucket))
        .map(userToCsvRow);

      const csv = rowsToCsv(CSV_HEADERS, rows);
      const filename = `roster-health-${bucket}-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      console.error("GET /api/admin/roster-health/export error:", err);
      res.status(500).json({ error: "Failed to export roster health bucket" });
    }
  });
}
