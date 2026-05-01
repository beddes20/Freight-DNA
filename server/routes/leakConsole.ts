// Task #872 — Manager Leak Console routes.
//
// Manager-only HTTP surface for the four leak panels, the KPI rollup, and the
// fix-action endpoint. Every fix click writes a `leak_console_audit` row and
// (where applicable) a `carrier_outreach_logs` row so the rep sees the action
// surface in the Lane Inbox.

import type { Express, Response } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth";
import { db, storage } from "../storage";
import { isAdmin, isManagerial } from "../lib/roles";
import { pStr, qInt } from "../lib/req";
import {
  carrierOutreachLogs,
  leakConsoleAudit,
  leakConsoleDailySnapshot,
  recurringLanes,
  type LeakConsoleFixKind,
  type LeakConsolePanel,
  LEAK_CONSOLE_FIX_KINDS,
  LEAK_CONSOLE_PANELS,
} from "@shared/schema";
import {
  computeKpiCounts,
  getNoContactableUnderDemand,
  getOwnedUntouchedUnderPressure,
  getRecurringCoveredOnSpot,
  getUnstableSpotDeployed,
  laneHealthFromVolatility,
  type LeakFilters,
  type LeakPanelResult,
} from "../leakConsoleService";
import { snapshotAllOrgs } from "../leakConsoleSnapshotScheduler";
import { laneSig } from "../laneCrossLinkService";
import { getErrorMessage } from "../lib/errors";
import { publish as publishLiveSync } from "../services/liveSync";

const PANEL_SET = new Set<LeakConsolePanel>(LEAK_CONSOLE_PANELS);
const FIX_KIND_SET = new Set<LeakConsoleFixKind>(LEAK_CONSOLE_FIX_KINDS);

// Map fix kind → carrier_outreach_logs.outreachMode used when surfacing the
// action in the Lane Inbox stream. Kept short so the inbox renderer can pick
// a friendly label.
const FIX_OUTREACH_MODES: Record<LeakConsoleFixKind, string | null> = {
  build_bench: null, // deep-link only — no outreach row
  reassign_owner: "leak_console_reassign",
  stabilize: "leak_console_stabilize",
  demote_from_recurring: "leak_console_demote",
  push_to_lwq_owner: "leak_console_push",
  nudge_owner: "leak_console_nudge",
};

function gateManager(req: Parameters<Parameters<Express["get"]>[1]>[0], res: Response): boolean {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  if (!isManagerial(user)) {
    res.status(403).json({ error: "Manager Leak Console requires a managerial role" });
    return false;
  }
  return true;
}

// Stricter gate for endpoints that operate cross-tenant. snapshotAllOrgs
// writes to every org's snapshot table and surfaces org IDs + per-org
// errors in the response — that is platform-admin operational capability,
// not a per-tenant manager action. Tenant-scoped managers (director,
// sales_director, NAM, account_manager) must NOT be able to trigger this.
function gateAdmin(req: Parameters<Parameters<Express["get"]>[1]>[0], res: Response): boolean {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  if (!isAdmin(user)) {
    res.status(403).json({ error: "Cross-tenant snapshot trigger requires platform admin role" });
    return false;
  }
  return true;
}

function parseFilters(qs: Record<string, unknown>): LeakFilters {
  const out: LeakFilters = {};
  if (typeof qs.ownerUserId === "string" && qs.ownerUserId) out.ownerUserId = qs.ownerUserId;
  if (typeof qs.team === "string" && qs.team) {
    out.teamUserIds = qs.team.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (typeof qs.tier === "string" && ["A", "B", "C", "new"].includes(qs.tier)) {
    out.tier = qs.tier as LeakFilters["tier"];
  }
  if (typeof qs.health === "string" && ["stable", "volatile", "hot"].includes(qs.health)) {
    out.health = qs.health as LeakFilters["health"];
  }
  if (qs.windowDays != null) {
    const n = Number(qs.windowDays);
    if (Number.isFinite(n) && n > 0) out.windowDays = Math.floor(n);
  }
  if (qs.limit != null) {
    const n = Number(qs.limit);
    if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
  }
  if (qs.offset != null) {
    const n = Number(qs.offset);
    if (Number.isFinite(n) && n >= 0) out.offset = Math.floor(n);
  }
  return out;
}

const fixBodySchema = z.object({
  panel: z.enum(LEAK_CONSOLE_PANELS),
  fixKind: z.enum(LEAK_CONSOLE_FIX_KINDS),
  laneId: z.string().min(1),
  note: z.string().max(500).optional(),
  // Optional explicit owner reassignment target. Required when fixKind is
  // reassign_owner or push_to_lwq_owner.
  newOwnerUserId: z.string().optional(),
});

async function loadPanel(panel: LeakConsolePanel, orgId: string, filters: LeakFilters): Promise<LeakPanelResult> {
  switch (panel) {
    case "no_contactable_under_demand":
      return getNoContactableUnderDemand(orgId, filters);
    case "unstable_spot_deployed":
      return getUnstableSpotDeployed(orgId, filters);
    case "recurring_covered_on_spot":
      return getRecurringCoveredOnSpot(orgId, filters);
    case "owned_untouched_under_pressure":
      return getOwnedUntouchedUnderPressure(orgId, filters);
  }
}

export function registerLeakConsoleRoutes(app: Express) {
  // ── Panel feed ────────────────────────────────────────────────────────────
  app.get("/api/leak-console/panels/:panel", requireUser, async (req, res) => {
    if (!gateManager(req, res)) return;
    const panel = pStr(req.params.panel) as LeakConsolePanel;
    if (!PANEL_SET.has(panel)) {
      return res.status(400).json({ error: `Unknown panel: ${panel}` });
    }
    const filters = parseFilters(req.query as Record<string, unknown>);
    const result = await loadPanel(panel, req.user!.organizationId, filters);
    res.json(result);
  });

  // ── KPI counts (current snapshot) + 7-day trend ──────────────────────────
  app.get("/api/leak-console/kpi", requireUser, async (req, res) => {
    if (!gateManager(req, res)) return;
    const orgId = req.user!.organizationId;
    const counts = await computeKpiCounts(orgId);

    const snapshots = await db
      .select()
      .from(leakConsoleDailySnapshot)
      .where(eq(leakConsoleDailySnapshot.orgId, orgId))
      .orderBy(desc(leakConsoleDailySnapshot.snapshotDate))
      .limit(14);

    // Persist today's snapshot so tomorrow's trend has a fresh data point. We
    // upsert so multiple manager loads in the same UTC day collapse to one row.
    const today = new Date().toISOString().slice(0, 10);
    await db
      .insert(leakConsoleDailySnapshot)
      .values({
        orgId,
        snapshotDate: today,
        noContactableUnderDemand: counts.noContactableUnderDemand,
        unstableSpotDeployed: counts.unstableSpotDeployed,
        recurringCoveredOnSpot: counts.recurringCoveredOnSpot,
        ownedUntouchedUnderPressure: counts.ownedUntouchedUnderPressure,
      })
      .onConflictDoUpdate({
        target: [leakConsoleDailySnapshot.orgId, leakConsoleDailySnapshot.snapshotDate],
        set: {
          noContactableUnderDemand: counts.noContactableUnderDemand,
          unstableSpotDeployed: counts.unstableSpotDeployed,
          recurringCoveredOnSpot: counts.recurringCoveredOnSpot,
          ownedUntouchedUnderPressure: counts.ownedUntouchedUnderPressure,
          computedAt: new Date(),
        },
      });

    res.json({
      counts,
      trend: snapshots
        .map((s) => ({
          date: s.snapshotDate,
          noContactableUnderDemand: s.noContactableUnderDemand,
          unstableSpotDeployed: s.unstableSpotDeployed,
          recurringCoveredOnSpot: s.recurringCoveredOnSpot,
          ownedUntouchedUnderPressure: s.ownedUntouchedUnderPressure,
        }))
        .reverse(),
    });
  });

  // ── Fix action ───────────────────────────────────────────────────────────
  app.post("/api/leak-console/fix", requireUser, async (req, res) => {
    if (!gateManager(req, res)) return;
    const user = req.user!;
    const parsed = fixBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid fix payload", details: parsed.error.flatten() });
    }
    const { panel, fixKind, laneId, newOwnerUserId, note } = parsed.data;

    // Lane must belong to this org.
    const lane = await storage.getRecurringLane(laneId);
    if (!lane || lane.orgId !== user.organizationId) {
      return res.status(404).json({ error: "Lane not found" });
    }

    const sig = laneSig(
      lane.origin,
      lane.originState,
      lane.destination,
      lane.destinationState,
      lane.equipmentType,
    );

    // Fix-specific side effects ────────────────────────────────────────────
    let sideEffect: Record<string, unknown> = {};
    let touchpointTaskId: string | null = null;

    if (fixKind === "reassign_owner" || fixKind === "push_to_lwq_owner") {
      // Both fixes route work to a specific owner.
      if (!newOwnerUserId) {
        return res.status(400).json({ error: "newOwnerUserId is required for this fix" });
      }
      const target = await storage.getUser(newOwnerUserId);
      if (!target || target.organizationId !== user.organizationId) {
        return res.status(403).json({ error: "Target user not found in your organization" });
      }
    }

    if (fixKind === "reassign_owner") {
      await storage.updateRecurringLane(laneId, { ownerUserId: newOwnerUserId, assignedByUserId: user.id, assignedAt: new Date().toISOString() });
      sideEffect.previousOwnerUserId = lane.ownerUserId;
      sideEffect.newOwnerUserId = newOwnerUserId;
    } else if (fixKind === "demote_from_recurring") {
      await storage.updateRecurringLane(laneId, { isEligible: false });
      sideEffect.demoted = true;
    } else if (fixKind === "push_to_lwq_owner" || fixKind === "nudge_owner") {
      const ownerId = fixKind === "push_to_lwq_owner" ? newOwnerUserId! : lane.ownerUserId;
      if (!ownerId) {
        return res.status(400).json({ error: "Lane has no owner to nudge" });
      }
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 1);
      const created = await storage.createTask({
        title:
          fixKind === "push_to_lwq_owner"
            ? `Cover spot freight on ${lane.origin} → ${lane.destination}`
            : `Touch lane ${lane.origin} → ${lane.destination} — ${note ?? "manager nudge"}`,
        description: note ?? null,
        notes: `Manager Leak Console (${panel}) — ${fixKind}`,
        status: "open",
        dueDate: dueDate.toISOString().slice(0, 10),
        assignedTo: ownerId,
        assignedBy: user.id,
        companyId: lane.companyId ?? null,
        orgId: user.organizationId,
        companyName: lane.companyName ?? null,
        contactId: null,
        contactName: null,
        opportunityId: null,
        laneContext: { type: "leak_console_fix", laneId, fixKind, panel },
        lever: "leak_console",
        createdAt: new Date().toISOString(),
      });
      touchpointTaskId = created?.id ?? null;
      sideEffect.touchpointTaskId = touchpointTaskId;
      sideEffect.touchpointAssignee = ownerId;
    } else if (fixKind === "stabilize" || fixKind === "build_bench") {
      // No mutation — these are deep-link fixes. We still write the audit
      // row so managers can see the click attempted.
      sideEffect.deepLink = true;
    }

    // Audit row — every fix click. ───────────────────────────────────────
    const [audit] = await db
      .insert(leakConsoleAudit)
      .values({
        orgId: user.organizationId,
        actorUserId: user.id,
        laneId,
        laneSig: sig,
        panel,
        fixKind,
        payload: { note: note ?? null, ...sideEffect },
      })
      .returning();

    // Lane Inbox event — write a carrier_outreach_logs row when the fix has a
    // surfacing semantic. The lane-inbox feed reads this table as one of its
    // sources so the rep sees the action in context.
    const outreachMode = FIX_OUTREACH_MODES[fixKind];
    if (outreachMode) {
      await storage.createCarrierOutreachLog({
        orgId: user.organizationId,
        laneId,
        companyId: lane.companyId ?? null,
        carrierIds: [],
        carrierNames: [],
        actorUserId: user.id,
        ownerUserId:
          fixKind === "reassign_owner"
            ? newOwnerUserId ?? null
            : fixKind === "push_to_lwq_owner"
              ? newOwnerUserId ?? null
              : lane.ownerUserId ?? null,
        overseerUserId: lane.overseerUserId ?? null,
        outreachMode,
        sourceModule: "leak_console",
        emailDrafts: [],
      });
    }

    publishLiveSync(user.organizationId, "recurring_lane", laneId);

    res.json({
      ok: true,
      auditId: audit?.id ?? null,
      touchpointTaskId,
      sideEffect,
    });
  });

  // ── Manual end-of-day snapshot trigger (Task #880) ──────────────────────
  // Cross-tenant operation: writes today's snapshot for EVERY org and
  // returns per-org error metadata. Restricted to platform admin only —
  // tenant-scoped managerial roles must not be able to trigger this.
  // Useful right after a deploy, after a data backfill, or when verifying
  // that the trend pipeline is healthy.
  app.post("/api/admin/leak-console/snapshot-now", requireUser, async (req, res) => {
    if (!gateAdmin(req, res)) return;
    try {
      const result = await snapshotAllOrgs();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Snapshot run failed", message: getErrorMessage(err) });
    }
  });

  // ── Audit log read (for the existing admin audit view) ───────────────────
  app.get("/api/leak-console/audit", requireUser, async (req, res) => {
    if (!gateManager(req, res)) return;
    const orgId = req.user!.organizationId;
    const limit = Math.max(1, Math.min(200, qInt(req.query.limit, 50)));
    const rows = await db
      .select()
      .from(leakConsoleAudit)
      .where(eq(leakConsoleAudit.orgId, orgId))
      .orderBy(desc(leakConsoleAudit.createdAt))
      .limit(limit);
    res.json({ rows });
  });
}

// Pure helpers exported for tests.
export const __test = { parseFilters, FIX_OUTREACH_MODES };
