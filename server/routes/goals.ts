import type { Express } from "express";
import { storage } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import { resolveColumns, getRepFromRow, getDispatcherFromRow } from "../colResolver";
import {
  isExcludedRow,
  parseHistoricalRow,
  isBadSummaryData,
  computeLoadsForRepGoal,
} from "../financialHelpers";
import { cacheGet, cacheSet, cacheInvalidatePrefix } from "../cache";

export function registerGoalRoutes(app: Express): void {
  // ── Goals ─────────────────────────────────────────────────────────────────
  app.get("/api/goals", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      let goalsList;
      if (user.role === "admin") {
        goalsList = await storage.getGoals({});
      } else if (user.role === "director" || user.role === "sales" || user.role === "sales_director") {
        goalsList = await storage.getGoals({ namId: user.id });
      } else if (user.role === "national_account_manager") {
        const setGoals = await storage.getGoals({ namId: user.id });
        const assignedGoals = await storage.getGoals({ amId: user.id });
        const seen = new Set<string>();
        goalsList = [...setGoals, ...assignedGoals].filter(g => { if (seen.has(g.id)) return false; seen.add(g.id); return true; });
      } else if (user.role === "account_manager") {
        // AMs see their own goals AND any goals they've set for LM reports
        const ownGoals = await storage.getGoals({ amId: user.id });
        const setGoals = await storage.getGoals({ namId: user.id });
        const seen = new Set<string>();
        goalsList = [...ownGoals, ...setGoals].filter(g => { if (seen.has(g.id)) return false; seen.add(g.id); return true; });
      } else {
        goalsList = await storage.getGoals({ amId: user.id });
      }

      // Enrich goals with auto-computed values so dashboard alerts use accurate data
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const latestUpload = uploads.length ? uploads[uploads.length - 1] : null;

      const enriched = await Promise.all(goalsList.map(async (goal) => {
        let computedValue: number | null = null;
        if (goal.metric === "contacts_added") {
          computedValue = await storage.getContactsAddedByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "touchpoints") {
          computedValue = await storage.getTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "meaningful_touchpoints") {
          computedValue = await storage.getMeaningfulTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "margin" && latestUpload) {
          const amUser = allUsers.find(u => u.id === goal.amId);
          const repKey = amUser ? (amUser as any).financialRepId as string | null : null;
          const isLMUser = amUser?.role === "logistics_manager" || amUser?.role === "logistics_coordinator";
          if (repKey && isLMUser) {
            // LMs: margin is in the Dispatcher column — use shared helper
            const txRows: any[] = (latestUpload.rows as any[]) || [];
            const lmTxCols = resolveColumns(txRows);
            const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
            const { totalMargin } = computeLoadsForRepGoal(txRows, lmTxCols, repKey, true, goalMonthKey);
            if (totalMargin > 0) computedValue = Math.round(totalMargin);
          } else if (repKey) {
            // AMs/NAMs: margin is in the Ops User column — use summary or tx rows
            const repKeyLower = repKey.toLowerCase();
            const raw = (latestUpload.summaryRows as any[]) || [];
            let total = 0;
            if (isBadSummaryData(raw)) {
              const txRows: any[] = (latestUpload.rows as any[]) || [];
              const goalTxCols = resolveColumns(txRows);
              const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
              const byRep: Record<string, Record<string, number>> = {};
              for (const row of txRows) {
                if (isExcludedRow(row, goalTxCols)) continue;
                const { monthKey, margin } = parseHistoricalRow(row, goalTxCols);
                const rep = getRepFromRow(row, goalTxCols);
                if (!rep) continue;
                if (!byRep[rep]) byRep[rep] = {};
                if (monthKey) byRep[rep][monthKey] = (byRep[rep][monthKey] || 0) + margin;
              }
              if (goalMonthKey) total = (byRep[repKeyLower] || {})[goalMonthKey] || 0;
            } else {
              const firstRow = raw[0] || {};
              const usesEmptyKeys = "__EMPTY" in firstRow;
              let rows = raw;
              if (usesEmptyKeys) rows = raw.filter((r: any) => { const n = String(r["__EMPTY"] || "").trim(); return n && n !== "Customer Name" && n !== "TOTAL" && n !== "Customer code"; });
              const sumRawCols = resolveColumns(rows);
              for (const r of rows) {
                let repName: string, totalMargin: number;
                if (usesEmptyKeys) { repName = String(r["__EMPTY_6"] || "").trim(); totalMargin = Number(r["__EMPTY_3"] ?? 0); }
                else { repName = getRepFromRow(r, sumRawCols); totalMargin = Number(r["Total Margin $"] || r["Total Margin"] || 0); }
                if (repName.toLowerCase() === repKeyLower) total += totalMargin;
              }
            }
            if (total > 0) computedValue = Math.round(total);
          }
        }
        if ((goal.metric === "loads_booked" || goal.metric === "margin_pct") && latestUpload) {
          const amUser = allUsers.find(u => u.id === goal.amId);
          const repKey = amUser ? (amUser as any).financialRepId as string | null : null;
          if (repKey) {
            const isLM = amUser?.role === "logistics_manager" || amUser?.role === "logistics_coordinator";
            const txRows: any[] = (latestUpload.rows as any[]) || [];
            const lbCols = resolveColumns(txRows);
            const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
            const { loads, totalMargin, totalCharges } = computeLoadsForRepGoal(txRows, lbCols, repKey, isLM, goalMonthKey);
            if (goal.metric === "loads_booked") computedValue = loads;
            else computedValue = totalCharges > 0 ? Math.round((totalMargin / totalCharges) * 1000) / 10 : 0;
          }
        }
        return { ...goal, computedValue };
      }));

      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch goals" });
    }
  });

  app.get("/api/goals/monthly-check", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role === "account_manager" || user.role === "logistics_manager" || user.role === "logistics_coordinator") return res.json([]);
      const namId = user.role === "admin" ? undefined : user.id;
      const missing = await storage.getAmsMissingMonthlyGoals(user.organizationId, namId);
      res.json(missing);
    } catch (error) {
      res.status(500).json({ error: "Failed to check monthly goals" });
    }
  });

  // ── Goals Leaderboard ─────────────────────────────────────────────────────
  app.get("/api/goals/leaderboard", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const lbCacheKey = `leaderboard:${req.session.organizationId}`;
      const lbCached = cacheGet(lbCacheKey);
      if (lbCached) return res.json(lbCached);

      // All goals across the org (NAMs see company-wide leaderboard)
      const allGoals = await storage.getGoals({});
      const allUsers = await storage.getUsers(req.session.organizationId!);

      const todayStr = new Date().toISOString().slice(0, 10);
      const activeGoals = allGoals.filter(g => g.startDate <= todayStr && (!g.endDate || g.endDate >= todayStr));

      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const latestUpload = uploads.length ? uploads[uploads.length - 1] : null;

      type GoalEntry = { metric: string; customLabel: string | null; amId: string; amName: string; currentValue: number; target: number; pct: number };
      const goalEntries: GoalEntry[] = [];

      for (const goal of activeGoals) {
        const amUser = allUsers.find(u => u.id === goal.amId);
        if (!amUser) continue;

        let effectiveValue = parseFloat(goal.currentValue || "0");

        if (goal.metric === "contacts_added") {
          effectiveValue = await storage.getContactsAddedByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "touchpoints") {
          effectiveValue = await storage.getTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "meaningful_touchpoints") {
          effectiveValue = await storage.getMeaningfulTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "margin" && latestUpload) {
          const repKey = (amUser as any).financialRepId as string | null;
          const isLMUser = (amUser as any).role === "logistics_manager" || (amUser as any).role === "logistics_coordinator";
          if (repKey && isLMUser) {
            // LMs: margin is in Dispatcher column
            const txRows: any[] = (latestUpload.rows as any[]) || [];
            const lmTxCols = resolveColumns(txRows);
            const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
            const { totalMargin } = computeLoadsForRepGoal(txRows, lmTxCols, repKey, true, goalMonthKey);
            if (totalMargin > 0) effectiveValue = Math.round(totalMargin);
          } else if (repKey) {
            // AMs/NAMs: margin is in Ops User column
            const raw = (latestUpload.summaryRows as any[]) || [];
            const repKeyLower = repKey.toLowerCase();
            let total = 0;
            if (isBadSummaryData(raw)) {
              const txRows: any[] = (latestUpload.rows as any[]) || [];
              const lbTxCols = resolveColumns(txRows);
              const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
              const byRep: Record<string, Record<string, number>> = {};
              for (const row of txRows) {
                if (isExcludedRow(row, lbTxCols)) continue;
                const { monthKey, margin } = parseHistoricalRow(row, lbTxCols);
                const rep = getRepFromRow(row, lbTxCols);
                if (!rep) continue;
                if (!byRep[rep]) byRep[rep] = {};
                if (monthKey) byRep[rep][monthKey] = (byRep[rep][monthKey] || 0) + margin;
              }
              const repMonths = byRep[repKeyLower] || {};
              if (goalMonthKey) total = repMonths[goalMonthKey] || 0;
            } else {
              const firstRow = raw[0] || {};
              const usesEmptyKeys = "__EMPTY" in firstRow;
              let rows = raw;
              if (usesEmptyKeys) rows = raw.filter((r: any) => { const n = String(r["__EMPTY"] || "").trim(); return n && n !== "Customer Name" && n !== "TOTAL" && n !== "Customer code"; });
              for (const r of rows) {
                let repName: string, totalMargin: number;
                if (usesEmptyKeys) { repName = String(r["__EMPTY_6"] || "").trim(); totalMargin = Number(r["__EMPTY_3"] ?? 0); }
                else { repName = String(r["Rep Name"] || r["Rep"] || r["rep name"] || r["REP"] || r["Sales Rep"] || "").trim(); totalMargin = Number(r["Total Margin $"] || r["total margin $"] || r["TOTAL MARGIN $"] || r["Total Margin"] || 0); }
                if (repName.toLowerCase() === repKeyLower) total += totalMargin;
              }
            }
            if (total > 0) effectiveValue = Math.round(total);
          }
        }
        if ((goal.metric === "loads_booked" || goal.metric === "margin_pct") && latestUpload) {
          const repKey = (amUser as any).financialRepId as string | null;
          if (repKey) {
            const isLM = (amUser as any).role === "logistics_manager" || (amUser as any).role === "logistics_coordinator";
            const txRows: any[] = (latestUpload.rows as any[]) || [];
            const lbCols = resolveColumns(txRows);
            const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
            const { loads, totalMargin, totalCharges } = computeLoadsForRepGoal(txRows, lbCols, repKey, isLM, goalMonthKey);
            if (goal.metric === "loads_booked") effectiveValue = loads;
            else effectiveValue = totalCharges > 0 ? Math.round((totalMargin / totalCharges) * 1000) / 10 : 0;
          }
        }

        const target = parseFloat(goal.target || "0");
        const pct = target > 0 ? Math.min((effectiveValue / target) * 100, 999) : 0;
        goalEntries.push({ metric: goal.metric, customLabel: goal.customLabel, amId: goal.amId, amName: amUser.name, currentValue: effectiveValue, target, pct });
      }

      // Group by metric (custom uses label as sub-key), take top 3 by pct
      const metricGroups = new Map<string, GoalEntry[]>();
      for (const entry of goalEntries) {
        const key = entry.metric === "custom" ? `custom:${entry.customLabel || ""}` : entry.metric;
        if (!metricGroups.has(key)) metricGroups.set(key, []);
        metricGroups.get(key)!.push(entry);
      }

      const METRIC_ORDER = ["margin", "touchpoints", "contacts_added", "load_count", "custom"];
      const leaderboard: { metric: string; customLabel: string | null; entries: { rank: number; amId: string; amName: string; currentValue: number; target: number; pct: number }[] }[] = [];

      for (const [, entries] of metricGroups) {
        const sorted = [...entries].sort((a, b) => b.pct - a.pct).slice(0, 3);
        leaderboard.push({ metric: sorted[0].metric, customLabel: sorted[0].customLabel, entries: sorted.map((e, i) => ({ rank: i + 1, amId: e.amId, amName: e.amName, currentValue: e.currentValue, target: e.target, pct: e.pct })) });
      }

      leaderboard.sort((a, b) => METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric));
      cacheSet(`leaderboard:${req.session.organizationId}`, leaderboard);
      res.json(leaderboard);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });

  app.post("/api/goals", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role === "logistics_manager" || user.role === "logistics_coordinator") return res.status(403).json({ error: "Only managers can create goals" });
      // AMs can set goals for themselves or for users who report directly to them
      if (user.role === "account_manager") {
        const amId = req.body.amId;
        if (amId !== user.id) {
          const allUsers = await storage.getUsers(req.session.organizationId!);
          const targetUser = allUsers.find(u => u.id === amId);
          if (!targetUser || targetUser.managerId !== user.id) {
            return res.status(403).json({ error: "You can only set goals for yourself or your direct reports" });
          }
        }
      }
      const goal = await storage.createGoal({
        ...req.body,
        namId: user.role === "admin" ? (req.body.namId || user.id) : user.id,
        createdById: user.id,
        createdAt: new Date().toISOString(),
        currentValue: "0",
      });
      const isSelfGoal = goal.amId === user.id;
      if (!isSelfGoal && goal.amId) {
        // Notify the AM that a goal has been set for them
        storage.createNotification({
          userId: goal.amId,
          type: "goal_set",
          title: `${user.name} set a goal for you`,
          body: goal.title,
          link: "/goals",
          relatedId: goal.id,
          read: false,
        }).catch(() => {});
      } else if (isSelfGoal) {
        // Self-goal: notify the user's director/manager and all admins
        const orgUsers = await storage.getUsers(req.session.organizationId!);
        const notifyIds = new Set<string>();
        if (user.managerId) notifyIds.add(user.managerId);
        orgUsers.filter(u => u.role === "admin" || u.role === "director" || u.role === "sales_director")
          .forEach(u => { if (u.id !== user.id) notifyIds.add(u.id); });
        for (const uid of notifyIds) {
          storage.createNotification({
            userId: uid,
            type: "goal_set",
            title: `${user.name} set a goal for themselves`,
            body: goal.title || goal.metric.replace(/_/g, " "),
            link: "/goals",
            relatedId: goal.id,
            read: false,
          }).catch(() => {});
        }
      }
      cacheInvalidatePrefix(`leaderboard:`);
      res.status(201).json(goal);
    } catch (error) {
      res.status(500).json({ error: "Failed to create goal" });
    }
  });

  // ── Bulk Goal Creation ──────────────────────────────────────────────────────
  app.post("/api/goals/bulk", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const namRoles = ["admin", "director", "national_account_manager"];
      if (!namRoles.includes(user.role)) return res.status(403).json({ error: "Access denied" });
      const { metric, period, target, startDate, endDate, notes, amIds } = req.body;
      if (!metric || !period || !target || !startDate || !endDate || !Array.isArray(amIds) || !amIds.length) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      const existingGoals = await storage.getGoals({ namId: user.id });
      const created = [];
      let skipped = 0;
      for (const amId of amIds) {
        const isDuplicate = existingGoals.some(g =>
          g.amId === amId && g.metric === metric &&
          g.startDate === startDate && g.endDate === endDate
        );
        if (isDuplicate) { skipped++; continue; }
        const goal = await storage.createGoal({
          namId: user.id,
          amId,
          metric,
          period,
          target: String(target),
          currentValue: "0",
          startDate,
          endDate,
          notes: notes || null,
          status: "active",
          createdAt: new Date().toISOString(),
          createdById: user.id,
        });
        storage.createNotification({
          userId: amId,
          type: "goal_set",
          title: `${user.name} set a goal for you`,
          body: `${metric.replace(/_/g, " ")} — target: ${target}`,
          link: "/goals",
          relatedId: goal.id,
          read: false,
        }).catch(() => {});
        created.push(goal);
      }
      res.status(201).json({ created: created.length, skipped });
    } catch (error) {
      res.status(500).json({ error: "Failed to bulk create goals" });
    }
  });

  app.patch("/api/goals/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getGoal((req.params.id as string));
      if (!existing) return res.status(404).json({ error: "Goal not found" });
      let canEdit = user.role === "admin" || existing.namId === user.id || existing.amId === user.id;
      if (!canEdit && (user.role === "director" || user.role === "sales_director")) {
        // Directors can edit margin goals for users in their own organization
        const orgId = req.session.organizationId;
        if (orgId && existing.metric === "margin") {
          const orgUsers = await storage.getUsers(orgId);
          const orgUserIds = new Set(orgUsers.map(u => u.id));
          canEdit = (existing.namId ? orgUserIds.has(existing.namId) : false) ||
                    (existing.amId ? orgUserIds.has(existing.amId) : false);
        }
      }
      if (!canEdit) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateGoal((req.params.id as string), req.body);
      // Notify the other party about goal updates
      const isProgressUpdate = req.body.currentValue !== undefined && Object.keys(req.body).length === 1;
      if (isProgressUpdate && existing.namId !== user.id) {
        // AM updated their progress — notify NAM
        storage.createNotification({
          userId: existing.namId,
          type: "goal_updated",
          title: `${user.name} updated goal progress`,
          body: existing.title,
          link: "/goals",
          relatedId: existing.id,
          read: false,
        }).catch(() => {});
      } else if (!isProgressUpdate && existing.amId && existing.amId !== user.id) {
        // NAM changed the goal definition — notify AM
        storage.createNotification({
          userId: existing.amId,
          type: "goal_updated",
          title: `${user.name} updated one of your goals`,
          body: existing.title,
          link: "/goals",
          relatedId: existing.id,
          read: false,
        }).catch(() => {});
      }
      // Goal completion: auto-complete and notify when value crosses target
      if (isProgressUpdate && existing.status !== "completed") {
        const newVal = parseFloat(req.body.currentValue || "0");
        const tgt = parseFloat(existing.target || "0");
        if (tgt > 0 && newVal >= tgt) {
          await storage.updateGoal((req.params.id as string), { status: "completed" }).catch(() => {});
          const goalTitle = existing.title || `${existing.metric.replace(/_/g, " ")} goal`;
          if (existing.namId !== user.id) {
            storage.createNotification({
              userId: existing.namId,
              type: "goal_updated",
              title: `🎉 ${user.name} hit their goal!`,
              body: goalTitle,
              link: "/goals",
              relatedId: existing.id,
              read: false,
            }).catch(() => {});
          }
          if (existing.amId && existing.amId === user.id) {
            storage.createNotification({
              userId: user.id,
              type: "goal_updated",
              title: "🎉 Goal achieved!",
              body: goalTitle,
              link: "/goals",
              relatedId: existing.id,
              read: false,
            }).catch(() => {});
          }
        }
      }
      cacheInvalidatePrefix(`leaderboard:`);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update goal" });
    }
  });

  app.delete("/api/goals/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getGoal((req.params.id as string));
      if (!existing) return res.status(404).json({ error: "Goal not found" });
      if (user.role !== "admin" && existing.namId !== user.id) return res.status(403).json({ error: "Access denied" });
      await storage.deleteGoal((req.params.id as string));
      cacheInvalidatePrefix(`leaderboard:`);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete goal" });
    }
  });

  app.get("/api/goals/:id/comments", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const comments = await storage.getGoalComments((req.params.id as string));
      res.json(comments);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch comments" });
    }
  });

  app.post("/api/goals/:id/comments", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const goal = await storage.getGoal((req.params.id as string));
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      const canComment = user.role === "admin" || goal.namId === user.id || goal.amId === user.id;
      if (!canComment) return res.status(403).json({ error: "Access denied" });
      const body = (req.body.body || req.body.text || "").trim();
      if (!body) return res.status(400).json({ error: "Comment body is required" });
      const comment = await storage.createGoalComment({
        goalId: (req.params.id as string),
        authorId: user.id,
        body,
        createdAt: new Date().toISOString(),
      });
      // Notify both NAM and AM about the goal comment (skip the commenter)
      const goalNotifyIds = [goal.namId, goal.amId].filter(
        (id): id is string => !!id && id !== user.id
      );
      for (const uid of goalNotifyIds) {
        storage.createNotification({
          userId: uid,
          type: "goal_comment",
          title: `${user.name} commented on a goal`,
          body: goal.title,
          link: "/goals",
          relatedId: goal.id,
          read: false,
        }).catch(() => {});
      }
      res.status(201).json(comment);
    } catch (error) {
      res.status(500).json({ error: "Failed to post comment" });
    }
  });

  app.delete("/api/goal-comments/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const comment = await storage.getGoalComment((req.params.id as string));
      if (!comment) return res.status(404).json({ error: "Comment not found" });
      if (user.role !== "admin" && comment.authorId !== user.id) return res.status(403).json({ error: "Access denied" });
      await storage.deleteGoalComment((req.params.id as string));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete comment" });
    }
  });

  app.get("/api/goals/:id/progress", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const goal = await storage.getGoal((req.params.id as string));
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      let autoValue: number | null = null;
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const targetUser = allUsers.find(u => u.id === goal.amId);
      const isLMGoal = targetUser?.role === "logistics_manager" || targetUser?.role === "logistics_coordinator";

      if (goal.metric === "contacts_added") {
        // LMs/LCs don't own companies via assignedTo — skip auto-compute so manual update is available
        if (!isLMGoal) {
          autoValue = await storage.getContactsAddedByAm(goal.amId, goal.startDate, goal.endDate);
        }
      } else if (goal.metric === "touchpoints") {
        if (!isLMGoal) {
          autoValue = await storage.getTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        }
      } else if (goal.metric === "meaningful_touchpoints") {
        if (!isLMGoal) {
          autoValue = await storage.getMeaningfulTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        }
      } else if (goal.metric === "loads_booked" || goal.metric === "margin_pct" || (goal.metric === "margin" && isLMGoal)) {
        // loads_booked / margin_pct / LM margin — LMs use Dispatcher col; AMs use Ops User col
        const repKey = targetUser ? (targetUser as any).financialRepId as string | null : null;
        if (repKey) {
          const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
          if (uploads.length) {
            const latest = uploads[uploads.length - 1];
            const txRows: any[] = (latest.rows as any[]) || [];
            const cols = resolveColumns(txRows);
            const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
            const { loads, totalMargin, totalCharges } = computeLoadsForRepGoal(txRows, cols, repKey, isLMGoal, goalMonthKey);
            if (goal.metric === "loads_booked") autoValue = loads;
            else if (goal.metric === "margin_pct") autoValue = totalCharges > 0 ? Math.round((totalMargin / totalCharges) * 1000) / 10 : 0;
            else autoValue = Math.round(totalMargin); // margin for LM
          }
        }
      } else if (goal.metric === "margin") {
        if (targetUser) {
          const repKey = (targetUser as any).financialRepId as string | null;
          if (repKey) {
            const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
            if (uploads.length) {
              const latest = uploads[uploads.length - 1];
              const raw = (latest.summaryRows as any[]) || [];
              const repKeyLower = repKey.toLowerCase();
              let total = 0;
              if (isBadSummaryData(raw)) {
                const txRows: any[] = (latest.rows as any[]) || [];
                const progTxCols = resolveColumns(txRows);
                const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
                const byRep: Record<string, Record<string, number>> = {};
                for (const row of txRows) {
                  if (isExcludedRow(row, progTxCols)) continue;
                  const { monthKey, margin } = parseHistoricalRow(row, progTxCols);
                  const rep = getRepFromRow(row, progTxCols);
                  if (!rep) continue;
                  if (!byRep[rep]) byRep[rep] = {};
                  if (monthKey) byRep[rep][monthKey] = (byRep[rep][monthKey] || 0) + margin;
                }
                const repMonths = byRep[repKeyLower] || {};
                if (goalMonthKey) total = repMonths[goalMonthKey] || 0;
              } else {
                const firstRow = raw[0] || {};
                const usesEmptyKeys = "__EMPTY" in firstRow;
                let rows = raw;
                if (usesEmptyKeys) {
                  rows = raw.filter((r: any) => {
                    const name = String(r["__EMPTY"] || "").trim();
                    return name && name !== "Customer Name" && name !== "TOTAL" && name !== "Customer code";
                  });
                }
                for (const r of rows) {
                  let repName: string, totalMargin: number;
                  if (usesEmptyKeys) {
                    repName = String(r["__EMPTY_6"] || "").trim();
                    totalMargin = Number(r["__EMPTY_3"] ?? 0);
                  } else {
                    repName = String(r["Rep Name"] || r["Rep"] || r["rep name"] || r["REP"] || r["Sales Rep"] || "").trim();
                    totalMargin = Number(r["Total Margin $"] || r["total margin $"] || r["TOTAL MARGIN $"] || r["Total Margin"] || 0);
                  }
                  if (repName.toLowerCase() === repKeyLower) total += totalMargin;
                }
              }
              autoValue = Math.round(total);
            }
          }
        }
      }
      res.json({ autoValue, currentValue: parseFloat(goal.currentValue || "0") });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch progress" });
    }
  });

  // Margin trend: last 6 months of actual margin for the rep tied to a goal
  app.get("/api/goals/:id/margin-trend", requireAuth, async (req, res) => {
    try {
      const goal = await storage.getGoal((req.params.id as string));
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const amUser = allUsers.find(u => u.id === goal.amId);
      const repKey = amUser ? (amUser as any).financialRepId as string | null : null;
      if (!repKey) return res.json({ months: [] });
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (!uploads.length) return res.json({ months: [] });
      const latest = uploads[uploads.length - 1];
      const txRows: any[] = (latest.rows as any[]) || [];
      const trendCols = resolveColumns(txRows);
      const repKeyLower = repKey.toLowerCase();
      const isLMUser = amUser?.role === "logistics_manager" || amUser?.role === "logistics_coordinator";
      const byMonth: Record<string, number> = {};
      for (const row of txRows) {
        if (isExcludedRow(row, trendCols)) continue;
        const { monthKey, margin } = parseHistoricalRow(row, trendCols);
        if (!monthKey) continue;
        // LMs are in Dispatcher column; AMs/NAMs are in Operations User column
        const rep = isLMUser
          ? getDispatcherFromRow(row, trendCols).toLowerCase()
          : getRepFromRow(row, trendCols);
        if (rep !== repKeyLower) continue;
        byMonth[monthKey] = (byMonth[monthKey] || 0) + margin;
      }
      // Build last 6 months relative to goal startDate
      const anchor = new Date(goal.startDate + "T00:00:00");
      const months = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
        months.push({ key, label, margin: Math.round(byMonth[key] || 0) });
      }
      res.json({ months, repKey });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch margin trend" });
    }
  });

}
