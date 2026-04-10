import type { Express } from "express";
import { storage } from "../storage";
import { getCurrentUser, requireAuth } from "../auth";
import { db } from "../storage";
import { sql } from "drizzle-orm";
import type { InsertCrmOpportunity } from "../../shared/schema";

const PROSPECT_ROLES = ["admin", "sales", "sales_director"];

async function requireProspectRole(req: any, res: any, next: any) {
  const user = await getCurrentUser(req);
  if (!user || !PROSPECT_ROLES.includes(user.role)) {
    return res.status(403).json({ error: "Access restricted to sales team" });
  }
  next();
}

function validateProspectPayload(body: any): string | null {
  if (body.dealProbability != null) {
    const p = Number(body.dealProbability);
    if (!Number.isInteger(p) || p < 0 || p > 100) return "dealProbability must be an integer between 0 and 100";
  }
  if (body.stage === "lost" || body.stage === "disqualified") {
    if (!body.lostReason || typeof body.lostReason !== "string" || body.lostReason.trim() === "") {
      return "lostReason is required when marking a prospect as lost or disqualified";
    }
  }
  return null;
}

const IMPORT_ALLOWED_FIELDS = new Set([
  "name", "industry", "estimatedSpend", "website",
  "primaryContactName", "primaryContactTitle", "primaryContactEmail", "primaryContactPhone", "primaryContactLinkedin",
  "currentCarrier", "topLanes", "commodity", "leadSource", "notes", "nextSteps", "painPoints",
  "estLoadsPerWeek", "estimatedAnnualRevenue", "employeeCount",
]);

const VALID_ACCOUNT_STATUSES = ["prospecting", "intro_scheduled", "active_customer", "dormant", "lost"];

const VALID_OPP_RECORD_TYPES = ["single_multi_lane", "private_hauling", "rfp", "trucking_opportunity"];
const VALID_OPP_STAGES = ["qualification", "discovery", "proposal", "negotiation", "closed_won", "closed_lost"];

function validateOppPayload(body: any): string | null {
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) return "Name is required";
  if (body.recordType && !VALID_OPP_RECORD_TYPES.includes(body.recordType)) return `Invalid record type: ${body.recordType}`;
  if (body.stage && !VALID_OPP_STAGES.includes(body.stage)) return `Invalid stage: ${body.stage}`;
  if (body.probability != null) {
    const p = Number(body.probability);
    if (isNaN(p) || p < 0 || p > 100) return "Probability must be 0–100";
  }
  return null;
}

const CRM_SETTINGS_DEFAULTS = {
  pipelineStages: [
    { key: "new_lead", label: "New Lead", active: true },
    { key: "intro_scheduled", label: "Intro Scheduled", active: true },
    { key: "intro_completed", label: "Intro Completed", active: true },
    { key: "follow_up", label: "Active Follow-Up", active: true },
    { key: "opportunity_sent", label: "Opportunity Sent", active: true },
    { key: "first_load_won", label: "First Load Won", active: true },
  ],
  opportunityTypes: [
    { key: "single_lane", label: "Single Lane", active: true },
    { key: "multi_lane", label: "Multi Lane", active: true },
    { key: "private_hauling", label: "Private Hauling", active: true },
    { key: "rfp", label: "RFP", active: true },
    { key: "trucking_opportunity", label: "Trucking Opportunity", active: true },
  ],
  accountStatusLabels: [
    { key: "active", label: "Active", color: "#22c55e" },
    { key: "at_risk", label: "At Risk", color: "#f59e0b" },
    { key: "churned", label: "Churned", color: "#ef4444" },
    { key: "new", label: "New", color: "#3b82f6" },
  ],
  leadSources: [
    { key: "cold_call", label: "Cold Call", active: true },
    { key: "zoominfo", label: "ZoomInfo", active: true },
    { key: "linkedin", label: "LinkedIn", active: true },
    { key: "referral", label: "Referral", active: true },
    { key: "conference", label: "Conference", active: true },
    { key: "website_inbound", label: "Website Inbound", active: true },
    { key: "email_campaign", label: "Email Campaign", active: true },
    { key: "other", label: "Other", active: true },
  ],
  ownershipMode: "approval_required",
  staleThresholdDays: 14,
  requiredFields: {
    name: true,
    stage: true,
    ownerId: true,
    primaryContactName: false,
    primaryContactEmail: false,
    leadSource: false,
    estimatedSpend: false,
  },
};

export function registerProspectRoutes(app: Express) {
  // ── Sales Prospect Pipeline ──────────────────────────────────────────────────

  app.get("/api/prospects", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isSalesDirectorOrAdmin = user.role === "admin" || user.role === "sales_director";
      const ownerId = isSalesDirectorOrAdmin ? undefined : user.id;
      const [items, allUsers] = await Promise.all([
        storage.getProspects(user.organizationId, ownerId),
        storage.getUsers(user.organizationId),
      ]);
      const enriched = items.map(p => ({
        ...p,
        ownerName: allUsers.find(u => u.id === p.ownerId)?.name ?? null,
        assignedNamName: allUsers.find(u => u.id === p.assignedNamId)?.name ?? null,
      }));
      res.json(enriched);
    } catch (err) {
      console.error("GET /api/prospects error:", err);
      res.status(500).json({ error: "Failed to fetch prospects" });
    }
  });

  app.post("/api/prospects", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const validationError = validateProspectPayload(req.body);
      if (validationError) return res.status(400).json({ error: validationError });
      const data = { ...req.body, organizationId: user.organizationId, ownerId: req.body.ownerId || user.id };
      const prospect = await storage.createProspect(data);
      res.status(201).json(prospect);
    } catch (err) {
      console.error("POST /api/prospects error:", err);
      res.status(500).json({ error: "Failed to create prospect" });
    }
  });

  // ── Pipeline Analytics (must be before /:id routes) ──────────────────────────

  app.get("/api/prospects/analytics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Access restricted to sales directors and admins" });
      }

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      // Fetch prospects and users in parallel; activities need prospect IDs so run after
      const [allProspects, allUsers] = await Promise.all([
        storage.getProspects(user.organizationId),
        storage.getUsers(user.organizationId),
      ]);
      const recentActivities = await storage.getOrgProspectActivitiesSince(allProspects.map(p => p.id), thirtyDaysAgo);
      const userMap = new Map(allUsers.map(u => [u.id, u.name]));

      const ACTIVE_STAGES = ["new_lead", "intro_scheduled", "intro_completed", "follow_up", "opportunity_sent", "first_load_won"];
      const CLOSED_STAGES = ["lost", "disqualified"];
      const now = Date.now();

      const parseSpend = (s?: string | null) => {
        if (!s) return 0;
        return parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
      };

      const stageCounts: Record<string, number> = {};
      const stageWeightedValues: Record<string, number> = {};
      const stageTotalSpends: Record<string, number> = {};
      const stageAgeSums: Record<string, number> = {};
      const stageAgeCounts: Record<string, number> = {};

      allProspects.forEach(p => {
        const s = p.stage;
        stageCounts[s] = (stageCounts[s] || 0) + 1;
        const spend = parseSpend(p.estimatedSpend);
        const prob = p.dealProbability != null ? p.dealProbability / 100 : 0.5;
        const weighted = spend * prob;
        stageTotalSpends[s] = (stageTotalSpends[s] || 0) + spend;
        stageWeightedValues[s] = (stageWeightedValues[s] || 0) + weighted;
        const stageEntry = p.stageChangedAt ?? p.createdAt;
        const stageEntryMs = now - new Date(stageEntry).getTime();
        const stageDays = Math.floor(stageEntryMs / 86400000);
        stageAgeSums[s] = (stageAgeSums[s] || 0) + stageDays;
        stageAgeCounts[s] = (stageAgeCounts[s] || 0) + 1;
      });

      const avgDaysInStage: Record<string, number> = {};
      ACTIVE_STAGES.forEach(s => {
        avgDaysInStage[s] = stageAgeCounts[s] ? Math.round(stageAgeSums[s] / stageAgeCounts[s]) : 0;
      });

      const lostReasonCounts: Record<string, number> = {};
      allProspects.filter(p => CLOSED_STAGES.includes(p.stage)).forEach(p => {
        const r = p.lostReason || "other";
        lostReasonCounts[r] = (lostReasonCounts[r] || 0) + 1;
      });

      const converted = allProspects.filter(p => p.convertedToCompanyId).length;
      const lost = allProspects.filter(p => CLOSED_STAGES.includes(p.stage)).length;
      const totalClosed = converted + lost;
      const winRate = totalClosed > 0 ? Math.round((converted / totalClosed) * 100) : 0;

      const totalWeighted = allProspects
        .filter(p => ACTIVE_STAGES.includes(p.stage) && !p.convertedToCompanyId)
        .reduce((sum, p) => {
          const spend = parseSpend(p.estimatedSpend);
          const prob = p.dealProbability != null ? p.dealProbability / 100 : 0.5;
          return sum + spend * prob;
        }, 0);

      const activityByRep: Record<string, number> = {};
      recentActivities.forEach(a => {
        activityByRep[a.createdById] = (activityByRep[a.createdById] || 0) + 1;
      });

      const repMap: Record<string, {
        name: string; prospectsOwned: number; converted: number; lost: number;
        totalAgeDays: number; ageCount: number;
      }> = {};

      allProspects.forEach(p => {
        if (!repMap[p.ownerId]) {
          repMap[p.ownerId] = { name: userMap.get(p.ownerId) ?? p.ownerId, prospectsOwned: 0, converted: 0, lost: 0, totalAgeDays: 0, ageCount: 0 };
        }
        repMap[p.ownerId].prospectsOwned++;
        if (p.convertedToCompanyId) repMap[p.ownerId].converted++;
        if (CLOSED_STAGES.includes(p.stage)) repMap[p.ownerId].lost++;
        const ageMs = now - new Date(p.createdAt).getTime();
        repMap[p.ownerId].totalAgeDays += Math.floor(ageMs / 86400000);
        repMap[p.ownerId].ageCount++;
      });

      const repStats = Object.entries(repMap).map(([ownerId, data]) => {
        const repTotal = data.converted + data.lost;
        return {
          ownerId,
          ownerName: data.name,
          prospectsOwned: data.prospectsOwned,
          activitiesLast30d: activityByRep[ownerId] || 0,
          avgDealAge: data.ageCount ? Math.round(data.totalAgeDays / data.ageCount) : 0,
          conversionRate: repTotal > 0 ? Math.round((data.converted / repTotal) * 100) : 0,
          converted: data.converted,
        };
      }).sort((a, b) => b.prospectsOwned - a.prospectsOwned);

      res.json({
        stageCounts,
        stageWeightedValues,
        stageTotalSpends,
        avgDaysInStage,
        lostReasonCounts,
        winRate,
        converted,
        totalClosed,
        totalWeighted,
        totalProspects: allProspects.length,
        repStats,
      });
    } catch (err) {
      console.error("GET /api/prospects/analytics error:", err);
      res.status(500).json({ error: "Failed to generate analytics" });
    }
  });

  // ── Exec Dashboard Analytics ─────────────────────────────────────────────────

  app.get("/api/prospects/exec-analytics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Access restricted" });
      }

      const range = (req.query.range as string) || "month";
      const now = new Date();
      const thisYear = now.getFullYear();
      const thisMonth = now.getMonth();

      let rangeStart: Date;
      let rangeEnd: Date = new Date(now);
      let prevRangeStart: Date;
      let prevRangeEnd: Date;

      if (range === "last_month") {
        rangeStart = new Date(thisYear, thisMonth - 1, 1);
        rangeEnd = new Date(thisYear, thisMonth, 1);
        prevRangeStart = new Date(thisYear, thisMonth - 2, 1);
        prevRangeEnd = rangeStart;
      } else if (range === "qtd") {
        const qMonth = Math.floor(thisMonth / 3) * 3;
        rangeStart = new Date(thisYear, qMonth, 1);
        const prevQMonth = qMonth === 0 ? 9 : qMonth - 3;
        const prevQYear = qMonth === 0 ? thisYear - 1 : thisYear;
        prevRangeStart = new Date(prevQYear, prevQMonth, 1);
        prevRangeEnd = rangeStart;
      } else if (range === "ytd") {
        rangeStart = new Date(thisYear, 0, 1);
        prevRangeStart = new Date(thisYear - 1, 0, 1);
        prevRangeEnd = new Date(thisYear - 1, thisMonth, now.getDate());
      } else {
        rangeStart = new Date(thisYear, thisMonth, 1);
        prevRangeStart = new Date(thisYear, thisMonth - 1, 1);
        prevRangeEnd = rangeStart;
      }

      const allProspects = await storage.getProspects(user.organizationId);
      const allUsers = await storage.getUsers(user.organizationId);
      const userMap = new Map(allUsers.map(u => [u.id, u.name]));

      const ACTIVE_STAGES = ["new_lead", "intro_scheduled", "intro_completed", "follow_up", "opportunity_sent", "first_load_won"];
      const CLOSED_STAGES = ["lost", "disqualified"];
      const STALE_DAYS = 30;
      const staleThreshold = new Date(Date.now() - STALE_DAYS * 86400000);

      const buildRepBreakdown = (items: typeof allProspects, keyFn: (p: typeof allProspects[0]) => string) => {
        const map: Record<string, number> = {};
        for (const p of items) {
          const key = keyFn(p);
          if (key) map[key] = (map[key] || 0) + 1;
        }
        return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([repId, count]) => ({
          repId, repName: userMap.get(repId) ?? repId, count,
        }));
      };

      const filterByWindow = (prospects: typeof allProspects, start: Date, end: Date) =>
        prospects.filter(p => {
          const created = new Date(p.createdAt);
          const updated = new Date(p.updatedAt);
          return (created >= start && created <= end) || (updated >= start && updated <= end);
        });

      const prospectsInRange = filterByWindow(allProspects, rangeStart, rangeEnd);
      const prospectsInPrevRange = filterByWindow(allProspects, prevRangeStart, prevRangeEnd);

      const classifyProspecting = (ps: typeof allProspects) =>
        ps.filter(p => !p.convertedToCompanyId && !CLOSED_STAGES.includes(p.stage) && new Date(p.updatedAt) >= staleThreshold);
      const classifyDormant = (ps: typeof allProspects) =>
        ps.filter(p => !p.convertedToCompanyId && !CLOSED_STAGES.includes(p.stage) && new Date(p.updatedAt) < staleThreshold);
      const classifyActiveCustomers = (ps: typeof allProspects) =>
        ps.filter(p => !!p.convertedToCompanyId);

      const prospectingAccounts = classifyProspecting(prospectsInRange);
      const dormantAccounts = classifyDormant(prospectsInRange);
      const activeCustomers = classifyActiveCustomers(prospectsInRange);

      const prevProspectingCount = classifyProspecting(prospectsInPrevRange).length;
      const prevDormantCount = classifyDormant(prospectsInPrevRange).length;
      const prevActiveCustomersCount = classifyActiveCustomers(prospectsInPrevRange).length;

      const cfyStart = new Date(thisYear, 0, 1);
      const cfyEnd = new Date(now);
      const closedWonCFY = allProspects.filter(p =>
        p.convertedToCompanyId && p.convertedAt &&
        new Date(p.convertedAt) >= cfyStart && new Date(p.convertedAt) <= cfyEnd
      );
      const prevCfyStart = new Date(thisYear - 1, 0, 1);
      const prevCfyEnd = new Date(thisYear - 1, thisMonth, now.getDate());
      const prevClosedWonCFYCount = allProspects.filter(p =>
        p.convertedToCompanyId && p.convertedAt &&
        new Date(p.convertedAt) >= prevCfyStart && new Date(p.convertedAt) <= prevCfyEnd
      ).length;

      const parseSpend = (s?: string | null) => {
        if (!s) return 0;
        return parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
      };

      const revenueByRepMonth: Record<string, number> = {};
      const revenueByRepCFY: Record<string, number> = {};

      for (const p of allProspects) {
        if (!p.convertedToCompanyId || !p.convertedAt) continue;
        const convDate = new Date(p.convertedAt);
        const spend = parseSpend(p.estimatedSpend);
        const repId = p.ownerId;
        if (convDate >= rangeStart && convDate <= rangeEnd) {
          revenueByRepMonth[repId] = (revenueByRepMonth[repId] || 0) + spend;
        }
        if (convDate.getFullYear() === thisYear) {
          revenueByRepCFY[repId] = (revenueByRepCFY[repId] || 0) + spend;
        }
      }

      const prospectIds = allProspects.map(p => p.id);
      const activities = await storage.getOrgProspectActivitiesSince(prospectIds, rangeStart);
      const filteredActivities = activities.filter(a => new Date(a.createdAt) <= rangeEnd);

      const emailsByRep: Record<string, number> = {};
      for (const a of filteredActivities) {
        if (a.type === "email") {
          emailsByRep[a.createdById] = (emailsByRep[a.createdById] || 0) + 1;
        }
      }

      const ACTIVE_STAGE_LIST = ["new_lead","intro_scheduled","intro_completed","follow_up","opportunity_sent","first_load_won"];
      const activeOnlyProspects = allProspects.filter(p => {
        if (p.convertedToCompanyId || CLOSED_STAGES.includes(p.stage)) return false;
        const created = new Date(p.createdAt);
        const updated = new Date(p.updatedAt);
        const createdInRange = created >= rangeStart && created <= rangeEnd;
        const updatedInRange = updated >= rangeStart && updated <= rangeEnd;
        return createdInRange || updatedInRange;
      });

      const stageCounts: Record<string, number> = {};
      const stageWeightedValues: Record<string, number> = {};
      const stageTotalSpends: Record<string, number> = {};
      const stageAgeSumMs: Record<string, number> = {};
      const stageAgeCounts: Record<string, number> = {};
      const nowMs = Date.now();
      const parseSpendExec = (s?: string | null) => {
        if (!s) return 0;
        return parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
      };
      for (const p of activeOnlyProspects) {
        stageCounts[p.stage] = (stageCounts[p.stage] || 0) + 1;
        const spend = parseSpendExec(p.estimatedSpend);
        const prob = p.dealProbability != null ? p.dealProbability / 100 : 0.5;
        stageTotalSpends[p.stage] = (stageTotalSpends[p.stage] || 0) + spend;
        stageWeightedValues[p.stage] = (stageWeightedValues[p.stage] || 0) + spend * prob;
        const changedAt = p.stageChangedAt ? new Date(p.stageChangedAt).getTime() : new Date(p.createdAt).getTime();
        const msInStage = nowMs - changedAt;
        stageAgeSumMs[p.stage] = (stageAgeSumMs[p.stage] || 0) + msInStage;
        stageAgeCounts[p.stage] = (stageAgeCounts[p.stage] || 0) + 1;
      }
      const totalWeighted = Object.values(stageWeightedValues).reduce((a, b) => a + b, 0);

      const stageVelocity = ACTIVE_STAGE_LIST.map(stage => ({
        stage,
        count: stageCounts[stage] ?? 0,
        avgDays: stageAgeCounts[stage]
          ? Math.round(stageAgeSumMs[stage] / stageAgeCounts[stage] / 86400000)
          : 0,
      }));

      const avgDaysInStage: Record<string, number> = {};
      for (const sv of stageVelocity) {
        avgDaysInStage[sv.stage] = sv.avgDays;
      }

      const lostReasonCounts: Record<string, number> = {};
      for (const p of allProspects) {
        if ((p.stage === "lost" || p.stage === "disqualified") && p.lostReason) {
          const lostDate = new Date(p.updatedAt);
          if (lostDate >= rangeStart && lostDate <= rangeEnd) {
            lostReasonCounts[p.lostReason] = (lostReasonCounts[p.lostReason] || 0) + 1;
          }
        }
      }

      const closedInRange = allProspects.filter(p => {
        const closed = CLOSED_STAGES.includes(p.stage) || p.convertedToCompanyId;
        if (!closed) return false;
        const closedDate = p.convertedAt ? new Date(p.convertedAt) : new Date(p.updatedAt);
        return closedDate >= rangeStart && closedDate <= rangeEnd;
      });
      const convertedInRange = closedInRange.filter(p => p.convertedToCompanyId).length;
      const totalClosedInRange = closedInRange.length;
      const winRate = totalClosedInRange > 0 ? Math.round((convertedInRange / totalClosedInRange) * 100) : 0;

      const repStatsMap: Record<string, {
        ownerId: string; ownerName: string; prospectsOwned: number;
        activityCount: number; converted: number; totalOwned: number; dealAgeSumDays: number; dealAgeCount: number;
      }> = {};

      for (const p of allProspects) {
        if (!p.ownerId) continue;
        if (!repStatsMap[p.ownerId]) {
          repStatsMap[p.ownerId] = {
            ownerId: p.ownerId,
            ownerName: userMap.get(p.ownerId) ?? p.ownerId,
            prospectsOwned: 0, activityCount: 0, converted: 0, totalOwned: 0,
            dealAgeSumDays: 0, dealAgeCount: 0,
          };
        }
        const rs = repStatsMap[p.ownerId];
        rs.totalOwned++;
        if (!CLOSED_STAGES.includes(p.stage) && !p.convertedToCompanyId) {
          rs.prospectsOwned++;
          const ageDays = Math.round((nowMs - new Date(p.createdAt).getTime()) / 86400000);
          rs.dealAgeSumDays += ageDays;
          rs.dealAgeCount++;
        }
        if (p.convertedToCompanyId) rs.converted++;
      }

      for (const a of filteredActivities) {
        if (!a.createdById) continue;
        if (!repStatsMap[a.createdById]) {
          repStatsMap[a.createdById] = {
            ownerId: a.createdById, ownerName: userMap.get(a.createdById) ?? a.createdById,
            prospectsOwned: 0, activityCount: 0, converted: 0, totalOwned: 0,
            dealAgeSumDays: 0, dealAgeCount: 0,
          };
        }
        repStatsMap[a.createdById].activityCount++;
      }

      const repStats = Object.values(repStatsMap)
        .filter(rs => rs.totalOwned > 0)
        .sort((a, b) => b.activityCount - a.activityCount || b.converted - a.converted)
        .map(rs => ({
          ownerId: rs.ownerId,
          ownerName: rs.ownerName,
          prospectsOwned: rs.prospectsOwned,
          activitiesInRange: rs.activityCount,
          avgDealAge: rs.dealAgeCount > 0 ? Math.round(rs.dealAgeSumDays / rs.dealAgeCount) : 0,
          conversionRate: rs.totalOwned > 0 ? Math.round((rs.converted / rs.totalOwned) * 100) : 0,
          converted: rs.converted,
        }));

      const conversionByRep = repStats.map(rs => ({
        repName: rs.ownerName,
        rate: rs.conversionRate,
        converted: rs.converted,
        total: rs.prospectsOwned + rs.converted,
      }));

      const trendDelta = (curr: number, prev: number) => curr - prev;

      res.json({
        prospecting: {
          total: prospectingAccounts.length,
          prevTotal: prevProspectingCount,
          trend: trendDelta(prospectingAccounts.length, prevProspectingCount),
          byRep: buildRepBreakdown(prospectingAccounts, p => p.ownerId),
        },
        dormant: {
          total: dormantAccounts.length,
          prevTotal: prevDormantCount,
          trend: trendDelta(dormantAccounts.length, prevDormantCount),
          byRep: buildRepBreakdown(dormantAccounts, p => p.ownerId),
        },
        activeCustomers: {
          total: activeCustomers.length,
          prevTotal: prevActiveCustomersCount,
          trend: trendDelta(activeCustomers.length, prevActiveCustomersCount),
          byRep: buildRepBreakdown(activeCustomers, p => p.ownerId),
        },
        closedWonCFY: {
          total: closedWonCFY.length,
          prevTotal: prevClosedWonCFYCount,
          trend: trendDelta(closedWonCFY.length, prevClosedWonCFYCount),
          byRep: buildRepBreakdown(closedWonCFY, p => p.ownerId),
        },
        closedWonRevByRepRange: Object.entries(revenueByRepMonth).sort((a, b) => b[1] - a[1]).map(([repId, amount]) => ({
          repName: userMap.get(repId) ?? repId, amount,
        })),
        closedWonRevByRepCFY: Object.entries(revenueByRepCFY).sort((a, b) => b[1] - a[1]).map(([repId, amount]) => ({
          repName: userMap.get(repId) ?? repId, amount,
        })),
        emailsToLeadsByRep: Object.entries(emailsByRep).sort((a, b) => b[1] - a[1]).map(([repId, count]) => ({
          repName: userMap.get(repId) ?? repId, count,
        })),
        stageCounts,
        stageWeightedValues,
        stageTotalSpends,
        totalWeighted,
        avgDaysInStage,
        lostReasonCounts,
        winRate,
        converted: convertedInRange,
        totalClosed: totalClosedInRange,
        totalProspects: allProspects.length,
        repStats,
        stageVelocity,
        conversionByRep,
      });
    } catch (err) {
      console.error("GET /api/prospects/exec-analytics error:", err);
      res.status(500).json({ error: "Failed to generate exec analytics" });
    }
  });

  // ── Rep Personal Analytics ────────────────────────────────────────────────────

  app.get("/api/prospects/my-analytics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const allProspects = await storage.getProspects(user.organizationId);
      const myProspects = allProspects.filter(p => p.ownerId === user.id);

      const now = new Date();
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

      const CLOSED_STAGES = ["lost", "disqualified"];
      const STAGE_LABELS: Record<string, string> = {
        new_lead: "New Lead", intro_scheduled: "Intro Scheduled",
        intro_completed: "Intro Completed", follow_up: "Active Follow-Up",
        opportunity_sent: "Opportunity Sent", first_load_won: "First Load Won",
        lost: "Lost", disqualified: "Disqualified",
      };

      const accountsByStatus = Object.entries(
        myProspects.reduce((acc: Record<string, number>, p) => {
          const label = STAGE_LABELS[p.stage] ?? p.stage;
          acc[label] = (acc[label] || 0) + 1;
          return acc;
        }, {})
      ).map(([label, count]) => ({ label, count }));

      const openProspects = myProspects.filter(p => !CLOSED_STAGES.includes(p.stage) && !p.convertedToCompanyId);
      const parseSpend = (s?: string | null) => {
        if (!s) return 0;
        return parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
      };
      const openOpportunityValue = openProspects.reduce((sum, p) => sum + parseSpend(p.estimatedSpend), 0);

      const myProspectIds = myProspects.map(p => p.id);
      const allActivities = myProspectIds.length > 0
        ? await storage.getOrgProspectActivitiesSince(myProspectIds, lastMonth)
        : [];

      const myCallsEmails = allActivities.filter(a =>
        a.createdById === user.id && (a.type === "call" || a.type === "email")
      );

      const activityThisMonth = myCallsEmails.filter(a => new Date(a.createdAt) >= thisMonth).length;
      const activityLastMonth = myCallsEmails.filter(a =>
        new Date(a.createdAt) >= lastMonth && new Date(a.createdAt) < thisMonth
      ).length;

      res.json({
        accountsByStatus,
        openOpportunityCount: openProspects.length,
        openOpportunityValue,
        activityThisMonth,
        activityLastMonth,
        totalAccounts: myProspects.length,
      });
    } catch (err) {
      console.error("GET /api/prospects/my-analytics error:", err);
      res.status(500).json({ error: "Failed to generate personal analytics" });
    }
  });

  // ── Prospect Mass Import ─────────────────────────────────────────────────────

  app.post("/api/prospects/import/preview", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const rows: any[] = req.body.rows;
      if (!Array.isArray(rows)) return res.status(400).json({ error: "rows required" });

      const existingProspects = await storage.getProspects(user.organizationId);
      const existingNames = new Set(existingProspects.map(p => p.name.toLowerCase().trim()));
      const existingWebsites = new Set(
        existingProspects
          .filter(p => p.website)
          .map(p => p.website!.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0])
      );
      const batchNames = new Set<string>();

      const preview = rows.map((row, i) => {
        const rawName = typeof row.name === "string" ? row.name.trim() : "";
        const nameLower = rawName.toLowerCase();
        const website = typeof row.website === "string"
          ? row.website.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]
          : "";
        let duplicateReason: string | null = null;
        if (!rawName) duplicateReason = "Missing company name";
        else if (existingNames.has(nameLower)) duplicateReason = `Already in pipeline (name match)`;
        else if (website && existingWebsites.has(website)) duplicateReason = `Already in pipeline (website match)`;
        else if (batchNames.has(nameLower)) duplicateReason = `Duplicate within file`;

        if (!duplicateReason && rawName) batchNames.add(nameLower);

        return {
          rowIndex: i,
          name: rawName,
          isDuplicate: !!duplicateReason,
          duplicateReason,
          row,
        };
      });

      res.json({ preview });
    } catch (err) {
      console.error("POST /api/prospects/import/preview error:", err);
      res.status(500).json({ error: "Preview failed" });
    }
  });

  app.post("/api/prospects/import", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const rows: any[] = req.body.rows;
      const skipDuplicates: boolean = req.body.skipDuplicates !== false;
      const isZoomInfo: boolean = req.body.isZoomInfo === true;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "rows must be a non-empty array" });
      }

      const existingProspects = await storage.getProspects(user.organizationId);
      const existingNames = new Set(existingProspects.map(p => p.name.toLowerCase().trim()));
      const batchNames = new Set<string>();

      let created = 0;
      const errors: { row: number; error: string }[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rawName = typeof row.name === "string" ? row.name.trim() : "";

        if (!rawName) {
          errors.push({ row: i + 1, error: "Company name is required" });
          continue;
        }
        const nameLower = rawName.toLowerCase();
        if (existingNames.has(nameLower)) {
          if (skipDuplicates) {
            errors.push({ row: i + 1, error: `Duplicate: "${rawName}" already exists in your pipeline` });
          }
          continue;
        }
        if (batchNames.has(nameLower)) {
          errors.push({ row: i + 1, error: `Duplicate within file: "${rawName}" appears more than once` });
          continue;
        }
        batchNames.add(nameLower);

        const safeRow: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(row)) {
          if (IMPORT_ALLOWED_FIELDS.has(k) && typeof v === "string" && v.trim()) {
            safeRow[k] = v.trim();
          }
        }

        try {
          const prospect = await storage.createProspect({
            ...safeRow,
            name: rawName,
            organizationId: user.organizationId,
            ownerId: user.id,
            stage: "new_lead",
            leadSource: isZoomInfo ? "zoominfo" : (safeRow.leadSource || null),
            dealProbability: null,
          });
          existingNames.add(nameLower);

          const activityNote = isZoomInfo
            ? `Imported from ZoomInfo${row.estimatedAnnualRevenue ? ` — Est. Revenue: ${row.estimatedAnnualRevenue}` : ""}${row.employeeCount ? `, ~${row.employeeCount} employees` : ""}`
            : `Imported via CSV`;
          await storage.createProspectActivity({
            prospectId: prospect.id,
            type: "note",
            notes: activityNote,
            createdById: user.id,
          });

          if (isZoomInfo) {
            for (let ci = 2; ci <= 3; ci++) {
              const cName = typeof row[`contact${ci}Name`] === "string" ? row[`contact${ci}Name`].trim() : "";
              if (cName) {
                await storage.createProspectContact({
                  prospectId: prospect.id,
                  name: cName,
                  title: row[`contact${ci}Title`] || null,
                  email: row[`contact${ci}Email`] || null,
                  phone: row[`contact${ci}Phone`] || null,
                  linkedin: null,
                  role: "other",
                  notes: null,
                });
              }
            }
          }

          created++;
        } catch (err: any) {
          errors.push({ row: i + 1, error: err.message ?? "Failed to create" });
        }
      }
      res.json({ created, errors });
    } catch (err) {
      console.error("POST /api/prospects/import error:", err);
      res.status(500).json({ error: "Import failed" });
    }
  });

  app.patch("/api/prospects/:id", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const validationError = validateProspectPayload(req.body);
      if (validationError) return res.status(400).json({ error: validationError });
      if (req.body.accountStatus !== undefined && !VALID_ACCOUNT_STATUSES.includes(req.body.accountStatus)) {
        return res.status(400).json({ error: `Invalid account status: ${req.body.accountStatus}` });
      }
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      if (user.role === "sales" && existing.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      const updated = await storage.updateProspect(id, req.body);

      const TRACKED_FIELDS = ["stage", "ownerId", "priority", "estimatedSpend", "dealProbability", "followUpDate", "expectedCloseDate", "name", "industry", "accountStatus"];
      for (const field of TRACKED_FIELDS) {
        if (field in req.body) {
          const oldVal = (existing as any)[field];
          const newVal = req.body[field];
          const oldStr = oldVal != null ? String(oldVal) : null;
          const newStr = newVal != null ? String(newVal) : null;
          if (oldStr !== newStr) {
            storage.logCrmAccountHistory({ prospectId: id, organizationId: user.organizationId, field, oldValue: oldStr, newValue: newStr, changedById: user.id }).catch(() => {});
          }
        }
      }

      res.json(updated);
    } catch (err) {
      console.error("PATCH /api/prospects/:id error:", err);
      res.status(500).json({ error: "Failed to update prospect" });
    }
  });

  app.delete("/api/prospects/:id", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      if (user.role === "sales" && existing.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      await storage.deleteProspect(id);
      res.json({ ok: true });
    } catch (err) {
      console.error("DELETE /api/prospects/:id error:", err);
      res.status(500).json({ error: "Failed to delete prospect" });
    }
  });

  app.get("/api/prospects/:id/activities", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const activities = await storage.getProspectActivities(id);
      const allUsers = await storage.getUsers(user.organizationId);
      const enriched = activities.map(a => ({
        ...a,
        createdByName: allUsers.find(u => u.id === a.createdById)?.name ?? "Unknown",
      }));
      res.json(enriched);
    } catch (err) {
      console.error("GET /api/prospects/:id/activities error:", err);
      res.status(500).json({ error: "Failed to fetch activities" });
    }
  });

  app.post("/api/prospects/:id/activities", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const activity = await storage.createProspectActivity({
        prospectId: id,
        type: req.body.type,
        notes: req.body.notes,
        createdById: user.id,
      });
      res.status(201).json(activity);
    } catch (err) {
      console.error("POST /api/prospects/:id/activities error:", err);
      res.status(500).json({ error: "Failed to log activity" });
    }
  });

  // ── Prospect Contacts sub-resource ──────────────────────────────────────────

  app.get("/api/prospects/:id/contacts", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const contacts = await storage.getProspectContacts(id);
      res.json(contacts);
    } catch (err) {
      console.error("GET /api/prospects/:id/contacts error:", err);
      res.status(500).json({ error: "Failed to fetch contacts" });
    }
  });

  app.post("/api/prospects/:id/contacts", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const contact = await storage.createProspectContact({ ...req.body, prospectId: id });
      res.status(201).json(contact);
    } catch (err) {
      console.error("POST /api/prospects/:id/contacts error:", err);
      res.status(500).json({ error: "Failed to create contact" });
    }
  });

  app.patch("/api/prospects/:id/contacts/:contactId", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const contactId = parseInt(req.params.contactId);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const updated = await storage.updateProspectContact(id, contactId, req.body);
      if (!updated) return res.status(404).json({ error: "Contact not found under this prospect" });
      res.json(updated);
    } catch (err) {
      console.error("PATCH /api/prospects/:id/contacts/:contactId error:", err);
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  app.delete("/api/prospects/:id/contacts/:contactId", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const contactId = parseInt(req.params.contactId);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const deleted = await storage.deleteProspectContact(id, contactId);
      if (!deleted) return res.status(404).json({ error: "Contact not found under this prospect" });
      res.json({ ok: true });
    } catch (err) {
      console.error("DELETE /api/prospects/:id/contacts/:contactId error:", err);
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  // ── AI Sales Intel Brief ─────────────────────────────────────────────────────

  app.post("/api/prospects/:id/intel", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const prospect = await storage.getProspect(id);
      if (!prospect || prospect.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });

      const forceRegen = req.body?.force === true;
      if (prospect.intelBrief && !forceRegen) {
        return res.json({ brief: prospect.intelBrief });
      }

      const allCompanies = await storage.getCompanies(user.organizationId);

      const laneTokens: string[] = (prospect.topLanes ?? "")
        .split(/[,\-\/|→to]+/i)
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length >= 3 && !["the", "and"].includes(t));

      const industryKey = (prospect.industry ?? "").toLowerCase().slice(0, 12);
      const industryMatchIds = new Set<string>(
        industryKey
          ? allCompanies.filter(c => c.industry && c.industry.toLowerCase().includes(industryKey)).map(c => c.id)
          : []
      );

      const laneMatchIds = new Set<string>();
      if (laneTokens.length > 0 && allCompanies.length > 0) {
        const { db: dbInner } = await import("../storage");
        const { contacts: contactsTable } = await import("../../shared/schema");
        const { inArray: drizzleInArray } = await import("drizzle-orm");
        const companyIds = allCompanies.map(c => c.id);
        const contactRows = await dbInner
          .select({ companyId: contactsTable.companyId, lanes: contactsTable.lanes })
          .from(contactsTable)
          .where(drizzleInArray(contactsTable.companyId, companyIds));
        contactRows.forEach(row => {
          if (row.companyId && row.lanes && row.lanes.some(lane =>
            laneTokens.some(token => lane.toLowerCase().includes(token))
          )) {
            laneMatchIds.add(row.companyId);
          }
        });
      }

      const combinedMap = new Map<string, { company: typeof allCompanies[number]; score: number }>();
      allCompanies.forEach(c => {
        const inIndustry = industryMatchIds.has(c.id);
        const inLane = laneMatchIds.has(c.id);
        if (inIndustry || inLane) {
          combinedMap.set(c.id, { company: c, score: (inIndustry ? 1 : 0) + (inLane ? 1 : 0) });
        }
      });
      const similar = [...combinedMap.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map(x => x.company);

      const contextCompanies = similar.length > 0 ? similar : allCompanies.slice(0, 4);

      const networkLines = contextCompanies.length > 0
        ? contextCompanies.map(c => {
            const tags: string[] = [];
            if (industryMatchIds.has(c.id)) tags.push("same industry");
            if (laneMatchIds.has(c.id)) tags.push("overlapping lanes");
            const tag = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
            const spend = c.estimatedFreightSpend ? ` ~$${Number(c.estimatedFreightSpend).toLocaleString()}/mo` : "";
            return `- ${c.name}${c.industry ? ` (${c.industry})` : ""}${spend}${tag}`;
          }).join("\n")
        : "- No closely matching customers found yet";

      const prompt = `You are a strategic sales intelligence analyst for Value Truck, a top-tier transportation brokerage. Prepare a concise, actionable Sales Intel Brief for a prospect the sales team is pursuing.

PROSPECT PROFILE:
- Company: ${prospect.name}
- Industry: ${prospect.industry ?? "Unknown"}
- Estimated Freight Spend: ${prospect.estimatedSpend ? prospect.estimatedSpend + "/mo" : "Unknown"}
- Top Lanes: ${prospect.topLanes ?? "Not specified"}
- Commodity: ${prospect.commodity ?? "Not specified"}
- Current Carrier: ${prospect.currentCarrier ?? "Not specified"}
- Known Pain Points: ${prospect.painPoints ?? "Not specified"}

EXISTING VALUE TRUCK CUSTOMER NETWORK (similar companies already with us):
${networkLines}

Write a Sales Intel Brief using EXACTLY these 4 sections with bullet points. Be specific, practical, and concise:

## 🔗 Network Overlap
(Which existing VT customers are similar to this prospect and what that reveals about needs, patterns, and buying behavior)

## 💬 Conversation Starters
(3-4 specific opening questions or statements tailored to their freight profile, industry, and lanes)

## ⚠️ Industry Pain Points
(Top 3 freight challenges common in their vertical that Value Truck directly solves)

## 🏆 Competitive Tips
(How to position Value Truck vs their current carrier — be specific if the carrier is named, otherwise give general differentiation tips)`;

      const OpenAI = (await import("openai")).default;
      const openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 700,
        temperature: 0.7,
      });

      const brief = completion.choices[0].message.content ?? "";
      await storage.updateProspect(id, { intelBrief: brief });
      res.json({ brief });
    } catch (err) {
      console.error("POST /api/prospects/:id/intel error:", err);
      res.status(500).json({ error: "Failed to generate intel brief" });
    }
  });

  // Convert prospect → company

  app.post("/api/prospects/:id/convert", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const { assignedNamId } = req.body;
      const { nanoid } = await import("nanoid");
      const companyId = nanoid(10);
      const company = await storage.createCompany({
        id: companyId,
        organizationId: user.organizationId,
        name: existing.name,
        industry: existing.industry ?? undefined,
        website: existing.website ?? undefined,
        assignedTo: assignedNamId || null,
        shippingModes: existing.shippingModes ?? [],
        estimatedSpend: existing.estimatedSpend ?? undefined,
        notes: existing.notes ? `[Converted from prospect]\n${existing.notes}` : "[Converted from prospect]",
      } as any);
      if (existing.primaryContactName) {
        await storage.createContact({
          id: nanoid(10),
          companyId: company.id,
          name: existing.primaryContactName,
          title: existing.primaryContactTitle ?? undefined,
          email: existing.primaryContactEmail ?? undefined,
          phone: existing.primaryContactPhone ?? undefined,
          linkedin: existing.primaryContactLinkedin ?? undefined,
        } as any);
      }
      await storage.updateProspect(id, {
        convertedToCompanyId: company.id,
        convertedAt: new Date() as any,
        stage: "first_load_won",
        assignedNamId: assignedNamId || existing.assignedNamId,
      });
      res.json({ company, prospectId: id });
    } catch (err) {
      console.error("POST /api/prospects/:id/convert error:", err);
      res.status(500).json({ error: "Failed to convert prospect" });
    }
  });

  // ─── Launchpad CRM — Opportunities ──────────────────────────────────────────

  app.get("/api/prospects/opportunities-summary", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      let rows: unknown;
      if (user.role === "sales") {
        rows = await db.execute(sql`
          SELECT
            o.prospect_id as "prospectId",
            COUNT(*) FILTER (WHERE o.stage NOT IN ('closed_won','closed_lost')) as "openCount",
            COUNT(*) FILTER (WHERE o.stage = 'closed_won') as "closedWonCount",
            SUM(CASE WHEN o.stage NOT IN ('closed_won','closed_lost')
              AND o.amount IS NOT NULL AND o.amount ~ '^[^0-9]*[0-9]'
              THEN CAST(REGEXP_REPLACE(o.amount, '[^0-9.]', '', 'g') AS NUMERIC)
              ELSE 0 END) as "pipelineValue"
          FROM crm_opportunities o
          INNER JOIN prospects p ON p.id = o.prospect_id
          WHERE o.organization_id = ${user.organizationId}
            AND p.owner_id = ${user.id}
          GROUP BY o.prospect_id
        `);
      } else {
        rows = await db.execute(sql`
          SELECT
            prospect_id as "prospectId",
            COUNT(*) FILTER (WHERE stage NOT IN ('closed_won','closed_lost')) as "openCount",
            COUNT(*) FILTER (WHERE stage = 'closed_won') as "closedWonCount",
            SUM(CASE WHEN stage NOT IN ('closed_won','closed_lost')
              AND amount IS NOT NULL AND amount ~ '^[^0-9]*[0-9]'
              THEN CAST(REGEXP_REPLACE(amount, '[^0-9.]', '', 'g') AS NUMERIC)
              ELSE 0 END) as "pipelineValue"
          FROM crm_opportunities
          WHERE organization_id = ${user.organizationId}
          GROUP BY prospect_id
        `);
      }
      const result: Record<number, { openCount: number; closedWonCount: number; pipelineValue: number }> = {};
      const rowArray = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
      for (const row of rowArray as Array<{ prospectId: unknown; openCount: unknown; closedWonCount: unknown; pipelineValue: unknown }>) {
        result[Number(row.prospectId)] = {
          openCount: Number(row.openCount ?? 0),
          closedWonCount: Number(row.closedWonCount ?? 0),
          pipelineValue: Number(row.pipelineValue ?? 0),
        };
      }
      res.json(result);
    } catch (err) {
      console.error("GET /api/prospects/opportunities-summary error:", err);
      res.status(500).json({ error: "Failed to fetch opportunities summary" });
    }
  });

  app.get("/api/prospects/:id/opportunities", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const prospect = await storage.getProspect(id);
      if (!prospect || prospect.organizationId !== user.organizationId) return res.status(404).json({ error: "Prospect not found" });
      if (user.role === "sales" && prospect.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      const rows = await storage.getCrmOpportunities(id);
      res.json(rows);
    } catch (err) {
      console.error("GET /api/prospects/:id/opportunities error:", err);
      res.status(500).json({ error: "Failed to fetch opportunities" });
    }
  });

  app.post("/api/prospects/:id/opportunities", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const prospect = await storage.getProspect(id);
      if (!prospect || prospect.organizationId !== user.organizationId) return res.status(404).json({ error: "Prospect not found" });
      if (user.role === "sales" && prospect.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      const validationError = validateOppPayload(req.body);
      if (validationError) return res.status(400).json({ error: validationError });
      const { name, recordType, stage, amount, closeDate, probability, notes, lostReason } = req.body;
      const row = await storage.createCrmOpportunity({
        name,
        recordType: recordType ?? "single_multi_lane",
        stage: stage ?? "qualification",
        amount: amount ?? null,
        closeDate: closeDate ?? null,
        probability: probability ?? null,
        notes: notes ?? null,
        lostReason: lostReason ?? null,
        prospectId: id,
        organizationId: user.organizationId,
        createdById: user.id,
      });
      res.json(row);
    } catch (err) {
      console.error("POST /api/prospects/:id/opportunities error:", err);
      res.status(500).json({ error: "Failed to create opportunity" });
    }
  });

  app.patch("/api/prospects/:id/opportunities/:oppId", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const oppId = parseInt(req.params.oppId);
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getCrmOpportunityById(oppId);
      if (!existing || existing.prospectId !== id || existing.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Opportunity not found" });
      }
      if (user.role === "sales") {
        const prospect = await storage.getProspect(id);
        if (!prospect || prospect.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      }
      type OppEditableFields = Pick<InsertCrmOpportunity, "name" | "recordType" | "stage" | "amount" | "closeDate" | "probability" | "notes" | "lostReason">;
      const body = req.body as Partial<OppEditableFields>;
      const safeUpdate: Partial<OppEditableFields> = {};
      if ("name" in body && body.name !== undefined) safeUpdate.name = body.name;
      if ("recordType" in body) safeUpdate.recordType = body.recordType;
      if ("stage" in body) safeUpdate.stage = body.stage;
      if ("amount" in body) safeUpdate.amount = body.amount;
      if ("closeDate" in body) safeUpdate.closeDate = body.closeDate;
      if ("probability" in body) safeUpdate.probability = body.probability;
      if ("notes" in body) safeUpdate.notes = body.notes;
      if ("lostReason" in body) safeUpdate.lostReason = body.lostReason;
      const validationError = validateOppPayload({ name: existing.name, ...safeUpdate });
      if (validationError) return res.status(400).json({ error: validationError });
      const row = await storage.updateCrmOpportunity(oppId, safeUpdate);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    } catch (err) {
      console.error("PATCH /api/prospects/:id/opportunities/:oppId error:", err);
      res.status(500).json({ error: "Failed to update opportunity" });
    }
  });

  app.delete("/api/prospects/:id/opportunities/:oppId", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const oppId = parseInt(req.params.oppId);
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getCrmOpportunityById(oppId);
      if (!existing || existing.prospectId !== id || existing.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Opportunity not found" });
      }
      if (user.role === "sales") {
        const prospect = await storage.getProspect(id);
        if (!prospect || prospect.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      }
      await storage.deleteCrmOpportunity(oppId);
      res.json({ success: true });
    } catch (err) {
      console.error("DELETE /api/prospects/:id/opportunities/:oppId error:", err);
      res.status(500).json({ error: "Failed to delete opportunity" });
    }
  });

  // ─── Launchpad CRM — Ownership Requests ──────────────────────────────────────

  app.get("/api/launchpad/ownership-requests", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "sales_director", "director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin only" });
      }
      const rows = await storage.getCrmOwnershipRequests(user.organizationId);
      res.json(rows);
    } catch (err) {
      console.error("GET /api/launchpad/ownership-requests error:", err);
      res.status(500).json({ error: "Failed to fetch ownership requests" });
    }
  });

  app.post("/api/prospects/:id/ownership-request", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const prospect = await storage.getProspect(id);
      if (!prospect || prospect.organizationId !== user.organizationId) return res.status(404).json({ error: "Prospect not found" });

      const settingKey = `crm_settings_${user.organizationId}`;
      const raw = await storage.getSetting(settingKey);
      const crmSettings = raw ? JSON.parse(raw) : {};
      const ownershipMode = crmSettings.ownershipMode ?? "approval_required";

      if (ownershipMode === "self_assign") {
        const oldOwner = await storage.getUser(prospect.ownerId);
        await storage.updateProspect(id, { ownerId: user.id });
        storage.logCrmAccountHistory({
          prospectId: id,
          organizationId: user.organizationId,
          field: "ownerId",
          oldValue: oldOwner?.name ?? prospect.ownerId,
          newValue: user.name ?? user.username,
          changedById: user.id,
        }).catch(() => {});
        return res.json({ status: "self_assigned", message: "Ownership transferred directly (self-assign mode)" });
      }

      const row = await storage.createCrmOwnershipRequest({
        prospectId: id,
        organizationId: user.organizationId,
        requesterId: user.id,
        currentOwnerId: prospect.ownerId,
        reason: req.body.reason ?? null,
        status: "pending",
      });
      res.json(row);
    } catch (err) {
      console.error("POST /api/prospects/:id/ownership-request error:", err);
      res.status(500).json({ error: "Failed to submit ownership request" });
    }
  });

  app.patch("/api/launchpad/ownership-requests/:id/review", requireAuth, async (req, res) => {
    try {
      const reqId = parseInt(req.params.id);
      const user = await getCurrentUser(req);
      if (!user || !["admin", "sales_director", "director"].includes(user.role)) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      const existingReq = await storage.getCrmOwnershipRequestById(reqId);
      if (!existingReq || existingReq.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Not found" });
      }
      if (existingReq.status !== "pending") {
        return res.status(400).json({ error: "Request has already been reviewed" });
      }
      const { status, adminNote } = req.body;
      if (!["approved", "denied"].includes(status)) {
        return res.status(400).json({ error: "Status must be 'approved' or 'denied'" });
      }
      const row = await storage.reviewCrmOwnershipRequest(reqId, status, user.id, adminNote);
      if (!row) return res.status(404).json({ error: "Not found" });
      const prospect = await storage.getProspect(row.prospectId);
      const prospectName = prospect?.name ?? `Account #${row.prospectId}`;
      if (status === "approved") {
        if (prospect) {
          const oldOwner = await storage.getUser(prospect.ownerId);
          const newOwner = await storage.getUser(row.requesterId);
          await storage.updateProspect(row.prospectId, { ownerId: row.requesterId });
          storage.logCrmAccountHistory({
            prospectId: row.prospectId,
            organizationId: user.organizationId,
            field: "ownerId",
            oldValue: oldOwner?.name ?? prospect.ownerId,
            newValue: newOwner?.name ?? row.requesterId,
            changedById: user.id,
          }).catch(() => {});
        }
      }
      storage.createNotification({
        userId: row.requesterId,
        type: "ownership_request_reviewed",
        title: status === "approved" ? "Ownership Request Approved" : "Ownership Request Denied",
        body: status === "approved"
          ? `Your request to take ownership of "${prospectName}" has been approved.`
          : `Your request to take ownership of "${prospectName}" was denied${adminNote ? `: ${adminNote}` : "."}`,
        link: `/prospects`,
        relatedId: String(row.prospectId),
        read: false,
      }).catch(() => {});
      res.json(row);
    } catch (err) {
      console.error("PATCH /api/launchpad/ownership-requests/:id/review error:", err);
      res.status(500).json({ error: "Failed to review ownership request" });
    }
  });

  // ─── Launchpad CRM — Account History ──────────────────────────────────────────

  app.get("/api/prospects/:id/history", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const prospect = await storage.getProspect(id);
      if (!prospect || prospect.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Not found" });
      }
      const rows = await storage.getCrmAccountHistory(id);
      res.json(rows);
    } catch (err) {
      console.error("GET /api/prospects/:id/history error:", err);
      res.status(500).json({ error: "Failed to fetch account history" });
    }
  });

  // ─── Launchpad CRM Settings Routes ─────────────────────────────────────────────

  app.get("/api/launchpad/crm-settings", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const settingKey = `crm_settings_${user.organizationId}`;
      const raw = await storage.getSetting(settingKey);
      if (!raw) return res.json(CRM_SETTINGS_DEFAULTS);
      const parsed = JSON.parse(raw);
      res.json({ ...CRM_SETTINGS_DEFAULTS, ...parsed });
    } catch (err) {
      console.error("GET /api/launchpad/crm-settings error:", err);
      res.status(500).json({ error: "Failed to fetch CRM settings" });
    }
  });

  app.patch("/api/launchpad/crm-settings", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin only" });
      }
      const body = req.body;
      const ALLOWED_KEYS = new Set(["pipelineStages", "opportunityTypes", "accountStatusLabels", "leadSources", "ownershipMode", "staleThresholdDays", "requiredFields"]);
      const unknown = Object.keys(body).filter(k => !ALLOWED_KEYS.has(k));
      if (unknown.length > 0) {
        return res.status(400).json({ error: `Unknown settings keys: ${unknown.join(", ")}` });
      }
      if (body.ownershipMode !== undefined && !["approval_required", "self_assign"].includes(body.ownershipMode)) {
        return res.status(400).json({ error: "ownershipMode must be 'approval_required' or 'self_assign'" });
      }
      const settingKey = `crm_settings_${user.organizationId}`;
      const current = await storage.getSetting(settingKey);
      const existing = current ? JSON.parse(current) : {};
      const merged = { ...existing, ...body };
      await storage.setSetting(settingKey, JSON.stringify(merged));
      res.json(merged);
    } catch (err) {
      console.error("PATCH /api/launchpad/crm-settings error:", err);
      res.status(500).json({ error: "Failed to update CRM settings" });
    }
  });

  // Direct admin owner reassignment

  app.patch("/api/prospects/:id/owner", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "sales_director", "director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin only" });
      }
      const id = parseInt(req.params.id);
      const { newOwnerId } = req.body;
      if (!newOwnerId) return res.status(400).json({ error: "newOwnerId required" });
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const newOwnerUser = await storage.getUser(newOwnerId);
      if (!newOwnerUser || newOwnerUser.organizationId !== user.organizationId) {
        return res.status(400).json({ error: "New owner must belong to the same organization" });
      }
      const updated = await storage.updateProspect(id, { ownerId: newOwnerId });
      const oldOwner = await storage.getUser(existing.ownerId);
      const newOwner = await storage.getUser(newOwnerId);
      storage.logCrmAccountHistory({
        prospectId: id,
        organizationId: user.organizationId,
        field: "ownerId",
        oldValue: oldOwner?.name ?? existing.ownerId,
        newValue: newOwner?.name ?? newOwnerId,
        changedById: user.id,
      }).catch(() => {});
      res.json(updated);
    } catch (err) {
      console.error("PATCH /api/prospects/:id/owner error:", err);
      res.status(500).json({ error: "Failed to reassign owner" });
    }
  });
}
