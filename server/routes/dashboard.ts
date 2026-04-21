import type { Express } from "express";
import { storage } from "../storage";
import { requireAuth, getCurrentUser, getVisibleCompanyIds } from "../auth";
import { resolveColumns, getRepFromRow, getDispatcherFromRow, getCustomerFromRow } from "../colResolver";
import { isExcludedRow, parseHistoricalRow, toMonthKey } from "../financialHelpers";
import { cacheGet, cacheSet } from "../cache";

export function registerDashboardRoutes(app: Express): void {
  // ─── Director/Admin Dashboard Portlet Endpoints ───────────────────────────

  const DIRECTOR_ROLES = ["admin", "director", "sales_director"] as const;
  const NAM_ROLES = ["national_account_manager", "sales"] as const;

  // Helper: normalize string for fuzzy matching
  const normAlias = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Helper: get set of normalized company aliases for a list of companies
  function buildAliasSet(companies: any[]): Set<string> {
    const s = new Set<string>();
    for (const c of companies) {
      s.add(normAlias(c.name));
      if (c.financialAlias) {
        for (const a of c.financialAlias.split(',').map((x: string) => x.trim()).filter(Boolean)) {
          s.add(normAlias(a));
        }
      }
    }
    return s;
  }

  // Check if a company belongs to a given set of user IDs — considers BOTH salesPersonId AND assignedTo
  // so that a company isn't excluded just because salesPersonId points to a different person
  function companyBelongsToAny(c: any, idSet: Set<string>): boolean {
    return (c.salesPersonId && idSet.has(c.salesPersonId)) || (c.assignedTo && idSet.has(c.assignedTo));
  }

  function getNamTeamCompanies(namId: string, allUsers: any[], allCompanies: any[]): any[] {
    const directReportIds = new Set(allUsers.filter((u: any) => u.managerId === namId).map((u: any) => u.id));
    directReportIds.add(namId); // include companies directly assigned to the NAM
    return allCompanies.filter((c: any) => companyBelongsToAny(c, directReportIds));
  }

  // Helper: get companies owned by a specific AM (checks both salesPersonId and assignedTo)
  function getAmCompanies(amId: string, allCompanies: any[]): any[] {
    const idSet = new Set([amId]);
    return allCompanies.filter((c: any) => companyBelongsToAny(c, idSet));
  }

  // Helper: get all companies within a director's vertical (director → NAMs → AMs → companies)
  function getDirectorTeamCompanies(directorId: string, allUsers: any[], allCompanies: any[]): any[] {
    // Direct reports of the director (NAMs and any direct AMs)
    const directReportIds = new Set(allUsers.filter((u: any) => u.managerId === directorId).map((u: any) => u.id));
    // Collect all AM-level users under those direct reports (NAMs' direct reports)
    const allScopedRepIds = new Set<string>(directReportIds);
    for (const namId of directReportIds) {
      for (const u of allUsers) {
        if (u.managerId === namId) allScopedRepIds.add(u.id);
      }
    }
    return allCompanies.filter((c: any) => companyBelongsToAny(c, allScopedRepIds));
  }

  // Trending accounts — top 5 up, top 5 down by margin delta vs 3-month average
  // Roles: director/admin (org-wide), NAM (team-scoped), AM (own accounts)
  app.get("/api/dashboard/trending-accounts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isDirectorRole = (DIRECTOR_ROLES as readonly string[]).includes(user.role);
      const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
      const isAmRole = user.role === "account_manager";
      if (!isDirectorRole && !isNamRole && !isAmRole) {
        return res.status(403).json({ error: "Access denied" });
      }

      const orgId = req.session.organizationId!;
      const upload = await storage.getLatestFinancialUploadForOrg(orgId);
      if (!upload || !upload.rows) return res.json({ up: [], down: [] });

      const rows: any[] = upload.rows as any[];
      const cols = resolveColumns(rows);

      // Compute margin by company alias, grouped by month
      const byCustomerMonth: Record<string, Record<string, number>> = {};
      // Fallback display name for aliases not matched to a CRM company
      // Strips the "ALIAS - " prefix to show a friendlier name
      const aliasFallbackName: Record<string, string> = {};
      const allMonthKeys = new Set<string>();
      for (const row of rows) {
        if (isExcludedRow(row, cols)) continue;
        const cust = getCustomerFromRow(row, cols);
        if (!cust) continue;
        const { monthKey, margin } = parseHistoricalRow(row, cols);
        if (!monthKey) continue;
        allMonthKeys.add(monthKey);
        const key = normAlias(cust);
        if (!byCustomerMonth[key]) byCustomerMonth[key] = {};
        byCustomerMonth[key][monthKey] = (byCustomerMonth[key][monthKey] || 0) + margin;
        // Store friendly display name: strip leading "CODE - " prefix if present
        if (!aliasFallbackName[key]) {
          const dashIdx = cust.indexOf(' - ');
          aliasFallbackName[key] = dashIdx !== -1 ? cust.slice(dashIdx + 3).trim() : cust;
        }
      }

      // Determine current month and the 3 prior months from the data, not calendar month
      const sortedMonthKeys = Array.from(allMonthKeys).sort();
      const curMonthKey = sortedMonthKeys.length > 0 ? sortedMonthKeys[sortedMonthKeys.length - 1] : toMonthKey(new Date());
      const curIdx = sortedMonthKeys.indexOf(curMonthKey);
      // Up to 3 months before the current month (all available in the upload)
      const priorMonthKeys = sortedMonthKeys.slice(Math.max(0, curIdx - 3), curIdx);

      // Compute pace fraction: how far through the current month are we?
      const today = new Date();
      const calendarCurKey = toMonthKey(today);
      let monthFraction = 1.0;
      let isPartialMonth = false;
      if (curMonthKey === calendarCurKey) {
        const [yr, mo] = curMonthKey.split("-").map(Number);
        const daysInMonth = new Date(yr, mo, 0).getDate();
        monthFraction = Math.min(today.getDate() / daysInMonth, 1);
        isPartialMonth = true;
      }
      const [cmYr, cmMo] = curMonthKey.split("-").map(Number);
      const curMonthLabel = new Date(cmYr, cmMo - 1, 1).toLocaleString("en-US", { month: "long" });

      // Build delta list using prorated pace comparison vs 3-month average
      // New customers (no prior month data) are included with avgPrior = 0 and flagged isNew = true
      const deltas: { alias: string; delta: number; curMargin: number; priorMargin: number; isNew: boolean }[] = [];
      for (const [alias, monthMap] of Object.entries(byCustomerMonth)) {
        const cur = monthMap[curMonthKey] ?? null;
        if (cur === null) continue;
        // Average margin across up to 3 prior months (only months where account has data)
        const priorValues = priorMonthKeys.map(m => monthMap[m]).filter((v): v is number => v !== undefined);
        const isNew = priorValues.length === 0;
        const avgPrior = isNew ? 0 : priorValues.reduce((a, b) => a + b, 0) / priorValues.length;
        const paceExpected = avgPrior * monthFraction;
        deltas.push({ alias, delta: cur - paceExpected, curMargin: cur, priorMargin: avgPrior, isNew });
      }

      // Match to company names — optionally scoped; fetch both in parallel
      const [allCompanies, allUsers] = await Promise.all([
        storage.getCompanies(req.session.organizationId!),
        storage.getUsers(req.session.organizationId!),
      ]);
      const isDirectorOnlyRole = isDirectorRole && user.role !== "admin";

      // Build scoped alias filter for Director (non-admin) / NAM / AM
      // Admins can also filter by a specific director via ?directorId=<userId>
      let scopedAliases: Set<string> | null = null;
      const directorIdParam = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : null;
      if (directorIdParam) {
        const teamCompanies = getDirectorTeamCompanies(directorIdParam, allUsers, allCompanies);
        scopedAliases = buildAliasSet(teamCompanies);
      } else if (isDirectorOnlyRole) {
        const teamCompanies = getDirectorTeamCompanies(user.id, allUsers, allCompanies);
        scopedAliases = buildAliasSet(teamCompanies);
      } else if (isNamRole) {
        const teamCompanies = getNamTeamCompanies(user.id, allUsers, allCompanies);
        scopedAliases = buildAliasSet(teamCompanies);
      } else if (isAmRole) {
        const myCompanies = getAmCompanies(user.id, allCompanies);
        scopedAliases = buildAliasSet(myCompanies);
      }

      const resolveCompany = (alias: string): { name: string; companyId?: string } => {
        const norm = normAlias(alias);
        const match = allCompanies.find(c => {
          const cns = c.financialAlias
            ? c.financialAlias.split(',').map((a: string) => normAlias(a.trim())).filter(Boolean)
            : [normAlias(c.name)];
          return cns.some((cn: string) => cn === norm || cn.includes(norm) || norm.includes(cn));
        });
        // Fall back to the friendly display name (alias prefix stripped) if not in CRM
        return { name: match?.name || aliasFallbackName[norm] || alias, companyId: match?.id };
      };

      // Filter deltas by scope if applicable
      const filteredDeltas = scopedAliases
        ? deltas.filter(d => {
            if (scopedAliases!.has(d.alias)) return true;
            // fuzzy: check if any scoped alias contains or is contained by this alias
            for (const sa of scopedAliases!) {
              if (sa.includes(d.alias) || d.alias.includes(sa)) return true;
            }
            return false;
          })
        : deltas;

      filteredDeltas.sort((a, b) => b.delta - a.delta);
      const up = filteredDeltas.filter(d => d.delta > 0).map(d => {
        const { name, companyId } = resolveCompany(d.alias);
        return { name, delta: d.delta, isNew: d.isNew, companyId };
      });
      const down = [...filteredDeltas].sort((a, b) => a.delta - b.delta).filter(d => d.delta < 0).map(d => {
        const { name, companyId } = resolveCompany(d.alias);
        return { name, delta: d.delta, isNew: d.isNew, companyId };
      });

      res.json({ up, down, monthFraction, isPartialMonth, curMonthLabel });
    } catch (err) {
      console.error("Error computing trending accounts:", err);
      res.status(500).json({ error: "Failed to compute trending accounts" });
    }
  });

  // Stale accounts — companies with no touchpoint in 21+ days, scoped to the current rep/NAM
  app.get("/api/dashboard/stale-accounts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const isAmRole = user.role === "account_manager";
      const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
      if (!isAmRole && !isNamRole) return res.json({ stale: [] });

      const STALE_DAYS = 21;

      // Fetch companies and users in parallel; AM ignores users but the fetch is cheap
      const [allCompanies, allUsers] = await Promise.all([
        storage.getCompanies(req.session.organizationId!),
        storage.getUsers(req.session.organizationId!),
      ]);

      let myCompanies: any[];
      if (isAmRole) {
        myCompanies = getAmCompanies(user.id, allCompanies).filter((c: any) => !c.archivedAt);
      } else {
        myCompanies = getNamTeamCompanies(user.id, allUsers, allCompanies).filter((c: any) => !c.archivedAt);
      }

      if (myCompanies.length === 0) return res.json({ stale: [] });

      // Get all touchpoints in the last 90 days — one query, then filter in memory
      const since90 = new Date();
      since90.setDate(since90.getDate() - 90);
      const recentTps = await storage.getTouchpointsSince(since90.toISOString().slice(0, 10));

      // Build map: companyId → latest touchpoint date
      const latestByCompany: Record<string, string> = {};
      for (const tp of recentTps) {
        if (!tp.companyId) continue;
        if (!latestByCompany[tp.companyId] || tp.date > latestByCompany[tp.companyId]) {
          latestByCompany[tp.companyId] = tp.date;
        }
      }

      const today = new Date();
      const stale: { id: string; name: string; daysSince: number }[] = [];
      for (const company of myCompanies) {
        const latestDate = latestByCompany[company.id];
        let daySinceTouch: number;
        if (!latestDate) {
          daySinceTouch = 90;
        } else {
          const d = new Date(latestDate + "T12:00:00");
          daySinceTouch = Math.floor((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
        }
        if (daySinceTouch >= STALE_DAYS) {
          stale.push({ id: company.id, name: company.name, daysSince: daySinceTouch });
        }
      }

      stale.sort((a, b) => b.daysSince - a.daysSince);
      res.json({ stale });
    } catch (err) {
      console.error("Error computing stale accounts:", err);
      res.status(500).json({ error: "Failed to compute stale accounts" });
    }
  });

  // ── Today's 5 — top 5 priority accounts for an AM ────────────────────────
  app.get("/api/dashboard/todays-five", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const thirtyStr = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const [allCompanies, allTouchpoints, allTasks, allRfps] = await Promise.all([
        storage.getCompanies(user.organizationId),
        storage.getTouchpoints(),
        storage.getTasks(),
        storage.getRfps(user.organizationId),
      ]);

      // Scope to companies this user owns (or all visible for NAM/Director)
      const isAM = user.role === "account_manager";
      const myCompanies = isAM
        ? allCompanies.filter(c => !c.archivedAt && c.assignedTo === user.id)
        : allCompanies.filter(c => !c.archivedAt);

      // Build last-touch map
      const lastTouch: Record<string, string> = {};
      for (const tp of allTouchpoints) {
        if (!lastTouch[tp.companyId] || tp.date > lastTouch[tp.companyId]) {
          lastTouch[tp.companyId] = tp.date;
        }
      }

      // Build open-task count per company
      const openTasks: Record<string, number> = {};
      for (const t of allTasks) {
        if (t.companyId && t.status === "open") {
          openTasks[t.companyId] = (openTasks[t.companyId] || 0) + 1;
        }
      }

      // Build open-RFP deadline urgency per company
      const rfpUrgent: Record<string, boolean> = {};
      for (const rfp of allRfps) {
        if (rfp.companyId && rfp.status === "open" && rfp.deadline) {
          const daysLeft = Math.ceil((new Date(rfp.deadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          if (daysLeft <= 14) rfpUrgent[rfp.companyId] = true;
        }
      }

      type PriorityAccount = { id: string; name: string; daysSince: number | null; openTasks: number; hasUrgentRfp: boolean; score: number; reasons: string[] };
      const scored: PriorityAccount[] = myCompanies.map(c => {
        const last = lastTouch[c.id];
        const daysSince = last ? Math.floor((new Date(todayStr).getTime() - new Date(last).getTime()) / (1000 * 60 * 60 * 24)) : null;
        const tasks = openTasks[c.id] || 0;
        const urgentRfp = rfpUrgent[c.id] || false;

        let score = 0;
        const reasons: string[] = [];

        if (daysSince === null) { score += 10; reasons.push("Never touched"); }
        else if (daysSince >= 30) { score += 8; reasons.push(`${daysSince}d since last touch`); }
        else if (daysSince >= 14) { score += 4; reasons.push(`${daysSince}d since last touch`); }
        if (tasks > 0) { score += 3; reasons.push(`${tasks} open task${tasks > 1 ? "s" : ""}`); }
        if (urgentRfp) { score += 5; reasons.push("RFP due soon"); }

        return { id: c.id, name: c.name, daysSince, openTasks: tasks, hasUrgentRfp: urgentRfp, score, reasons };
      });

      const top5 = scored.sort((a, b) => b.score - a.score).slice(0, 5);
      res.json(top5);
    } catch (err) {
      console.error("Error computing today's five:", err);
      res.status(500).json({ error: "Failed to compute today's five" });
    }
  });

  // ── AM Comparison — side-by-side metrics for NAM/Director ────────────────
  app.get("/api/dashboard/am-comparison", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allowed = ["national_account_manager", "director", "admin", "sales", "sales_director"];
      if (!allowed.includes(user.role)) return res.status(403).json({ error: "Access denied" });

      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      const allUsers = await storage.getUsers(user.organizationId);
      let amIds: string[];
      if (user.role === "admin" || user.role === "director") {
        const directorIdParam = typeof req.query.directorId === "string" ? req.query.directorId : null;
        if (directorIdParam) {
          // Scope to AMs whose manager (NAM) reports to the selected director
          const directReportIds = new Set(allUsers.filter(u => u.managerId === directorIdParam).map(u => u.id));
          amIds = allUsers.filter(u => u.role === "account_manager" && directReportIds.has(u.managerId!)).map(u => u.id);
        } else {
          amIds = allUsers.filter(u => u.role === "account_manager").map(u => u.id);
        }
      } else {
        amIds = allUsers.filter(u => u.managerId === user.id && u.role === "account_manager").map(u => u.id);
      }
      if (!amIds.length) return res.json([]);

      // Task #272: org-scope touchpoints and tasks so we don't pull every
      // org's rows then discard them in JS.
      const [allTouchpoints, allGoals, allCompanies, allTasks] = await Promise.all([
        storage.getTouchpointsByOrg(user.organizationId),
        storage.getGoals({ namId: user.role === "admin" || user.role === "director" ? undefined : user.id }),
        storage.getCompanies(user.organizationId),
        storage.getTasksByOrg(user.organizationId),
      ]);

      // Last touch per company
      const lastTouchMap: Record<string, string> = {};
      for (const tp of allTouchpoints) {
        if (!lastTouchMap[tp.companyId] || tp.date > lastTouchMap[tp.companyId]) {
          lastTouchMap[tp.companyId] = tp.date;
        }
      }

      const result = amIds.map(amId => {
        const amUser = allUsers.find(u => u.id === amId);
        const touchesWeek = allTouchpoints.filter(tp => tp.loggedById === amId && tp.date >= weekAgo).length;
        const touchesMonth = allTouchpoints.filter(tp => tp.loggedById === amId && tp.date >= monthStart).length;
        const myCompanies = allCompanies.filter(c => !c.archivedAt && c.assignedTo === amId);
        const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const coldAccounts = myCompanies.filter(c => !lastTouchMap[c.id] || lastTouchMap[c.id] < thirtyAgo).length;
        const openTasks = allTasks.filter(t => t.assignedTo === amId && t.status === "open").length;
        const currentGoals = allGoals.filter(g => g.amId === amId && g.metric === "touchpoints" && g.startDate <= new Date().toISOString().slice(0, 10) && g.endDate >= new Date().toISOString().slice(0, 10));
        const tpGoal = currentGoals[0];
        const goalTarget = tpGoal?.target ? Number(tpGoal.target) : null;
        const goalPct = goalTarget && goalTarget > 0 ? Math.min(Math.round((touchesMonth / goalTarget) * 100), 100) : null;

        return {
          id: amId,
          name: amUser?.name || amUser?.username || "Unknown",
          touchesWeek,
          touchesMonth,
          coldAccounts,
          openTasks,
          companyCount: myCompanies.length,
          goalPct,
          goalTarget,
        };
      });

      result.sort((a, b) => b.touchesMonth - a.touchesMonth);
      res.json(result);
    } catch (err) {
      console.error("Error computing AM comparison:", err);
      res.status(500).json({ error: "Failed to compute AM comparison" });
    }
  });

  // Team activity metrics — today's touches, meaningful touches, new contacts
  // Directors: org-wide; NAMs: scoped to their team
  app.get("/api/dashboard/team-activity", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isDirectorRole = (DIRECTOR_ROLES as readonly string[]).includes(user.role);
      const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
      if (!isDirectorRole && !isNamRole) {
        return res.status(403).json({ error: "Access denied" });
      }

      const orgId = req.session.organizationId!;
      const today = new Date().toISOString().slice(0, 10);

      // Fetch all data in parallel — companies, users, touchpoints, and contacts are independent.
      // Task #272: org-scoped touchpoints + today-filtered contacts via SQL.
      const [orgCompanies, allUsers, allTouchpoints, allContacts] = await Promise.all([
        storage.getCompanies(orgId),
        storage.getUsers(orgId),
        storage.getTouchpointsByOrg(orgId),
        storage.getContacts(),
      ]);

      // For Director (non-admin)/NAM: scope to their team's companies
      // Admins can filter by a specific director via ?directorId=<userId>
      const isDirectorOnlyRole = isDirectorRole && user.role !== "admin";
      const directorIdParam = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : null;
      let scopedCompanyIds: Set<string>;
      if (isNamRole) {
        const teamCompanies = getNamTeamCompanies(user.id, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else if (directorIdParam) {
        const teamCompanies = getDirectorTeamCompanies(directorIdParam, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else if (isDirectorOnlyRole) {
        const teamCompanies = getDirectorTeamCompanies(user.id, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else {
        scopedCompanyIds = new Set(orgCompanies.map(c => c.id));
      }

      const todayTouchpoints = allTouchpoints.filter(t => t.date === today && scopedCompanyIds.has(t.companyId));
      const touches = todayTouchpoints.length;
      const meaningful = todayTouchpoints.filter(t => t.isMeaningful).length;

      const newContacts = allContacts.filter(c =>
        c.createdAt &&
        c.createdAt.slice(0, 10) === today &&
        scopedCompanyIds.has(c.companyId)
      ).length;

      res.json({ touches, meaningful, newContacts });
    } catch (err) {
      res.status(500).json({ error: "Failed to load team activity" });
    }
  });

  // Activity detail — enriched records for portlet drill-down
  // type = relationships | touches | meaningful | contacts
  // personal=true scopes to current user's own companies only
  app.get("/api/dashboard/activity-detail", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const type = String(req.query.type || "");
      const personal = req.query.personal === "true";
      const orgId = req.session.organizationId!;
      const today = new Date().toISOString().slice(0, 10);
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      const [orgCompanies, allUsers] = await Promise.all([
        storage.getCompanies(orgId),
        storage.getUsers(orgId),
      ]);
      const companyMap = new Map(orgCompanies.map(c => [c.id, c]));
      const userMap = new Map(allUsers.map(u => [u.id, u]));

      let scopedCompanyIds: Set<string>;
      if (personal) {
        scopedCompanyIds = new Set(orgCompanies.filter(c => c.assignedTo === user.id).map(c => c.id));
      } else {
        const isDirectorRole = (DIRECTOR_ROLES as readonly string[]).includes(user.role);
        const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
        const isDirectorOnlyRole = isDirectorRole && user.role !== "admin";
        const directorIdParam = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : null;
        if (isNamRole) {
          const teamCompanies = getNamTeamCompanies(user.id, allUsers, orgCompanies);
          scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
        } else if (directorIdParam) {
          const teamCompanies = getDirectorTeamCompanies(directorIdParam, allUsers, orgCompanies);
          scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
        } else if (isDirectorOnlyRole) {
          const teamCompanies = getDirectorTeamCompanies(user.id, allUsers, orgCompanies);
          scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
        } else if (isDirectorRole) {
          // admin without a directorId filter — see all companies
          scopedCompanyIds = new Set(orgCompanies.map(c => c.id));
        } else {
          scopedCompanyIds = new Set(orgCompanies.filter(c => c.assignedTo === user.id).map(c => c.id));
        }
      }

      if (type === "relationships") {
        const allContacts = await storage.getContacts();
        const result = allContacts
          .filter(c => c.baseAdvancedAt && c.baseAdvancedAt >= monthStart && scopedCompanyIds.has(c.companyId))
          .sort((a, b) => (b.baseAdvancedAt || "").localeCompare(a.baseAdvancedAt || ""))
          .map(c => {
            const company = companyMap.get(c.companyId);
            const rep = company?.assignedTo ? userMap.get(company.assignedTo) : null;
            return { contactId: c.id, contactName: c.name, contactTitle: c.title || null, relationshipBase: c.relationshipBase || null, baseAdvancedAt: c.baseAdvancedAt, companyId: c.companyId, companyName: company?.name || "Unknown", repName: rep?.name || null };
          });
        return res.json(result);
      }

      if (type === "touches" || type === "meaningful") {
        const [allTouchpoints, allContacts] = await Promise.all([
          storage.getTouchpointsByOrg(orgId),
          storage.getContacts(),
        ]);
        const contactMap = new Map(allContacts.map(c => [c.id, c]));
        let tps = allTouchpoints.filter(t => t.date === today && scopedCompanyIds.has(t.companyId));
        if (type === "meaningful") tps = tps.filter(t => t.isMeaningful);
        const result = tps
          .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
          .map(t => {
            const company = companyMap.get(t.companyId);
            const contact = t.contactId ? contactMap.get(t.contactId) : null;
            const rep = company?.assignedTo ? userMap.get(company.assignedTo) : null;
            return { id: t.id, type: t.type, isMeaningful: t.isMeaningful || false, notes: t.notes || null, date: t.date, companyId: t.companyId, companyName: company?.name || "Unknown", contactName: contact?.name || null, repName: rep?.name || null };
          });
        return res.json(result);
      }

      if (type === "contacts") {
        const allContacts = await storage.getContacts();
        const result = allContacts
          .filter(c => c.createdAt && c.createdAt.slice(0, 10) === today && scopedCompanyIds.has(c.companyId))
          .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
          .map(c => {
            const company = companyMap.get(c.companyId);
            const rep = company?.assignedTo ? userMap.get(company.assignedTo) : null;
            return { contactId: c.id, contactName: c.name, contactTitle: c.title || null, companyId: c.companyId, companyName: company?.name || "Unknown", repName: rep?.name || null };
          });
        return res.json(result);
      }

      return res.status(400).json({ error: "Invalid type" });
    } catch (err) {
      res.status(500).json({ error: "Failed to load activity detail" });
    }
  });

  // Relationships moved up — accounts with contacts that advanced this month
  // Directors: org-wide; NAMs: their team's accounts
  app.get("/api/dashboard/relationships-moved", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isDirectorRole = (DIRECTOR_ROLES as readonly string[]).includes(user.role);
      const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
      if (!isDirectorRole && !isNamRole) {
        return res.status(403).json({ error: "Access denied" });
      }

      const orgId = req.session.organizationId!;
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      const orgCompanies = await storage.getCompanies(orgId);

      // Admins can filter by a specific director via ?directorId=<userId>
      const isDirectorOnlyRole = isDirectorRole && user.role !== "admin";
      const directorIdParam = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : null;
      let scopedCompanyIds: Set<string>;
      if (isNamRole) {
        const allUsers = await storage.getUsers(orgId);
        const teamCompanies = getNamTeamCompanies(user.id, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else if (directorIdParam) {
        const allUsers = await storage.getUsers(orgId);
        const teamCompanies = getDirectorTeamCompanies(directorIdParam, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else if (isDirectorOnlyRole) {
        const allUsers = await storage.getUsers(orgId);
        const teamCompanies = getDirectorTeamCompanies(user.id, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else {
        scopedCompanyIds = new Set(orgCompanies.map(c => c.id));
      }

      const allContacts = await storage.getContacts();
      const advancedCompanyIds = new Set(
        allContacts
          .filter(c => c.baseAdvancedAt && c.baseAdvancedAt >= monthStart && scopedCompanyIds.has(c.companyId))
          .map(c => c.companyId)
      );
      const count = advancedCompanyIds.size;

      res.json({ count });
    } catch (err) {
      res.status(500).json({ error: "Failed to load relationships moved" });
    }
  });

  // NAM/AM Margin Metrics — current month margin vs goal for each user by role
  // Directors: org-wide; NAMs: scoped to their direct reports
  app.get("/api/dashboard/margin-metrics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isDirectorRole = (DIRECTOR_ROLES as readonly string[]).includes(user.role);
      const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
      if (!isDirectorRole && !isNamRole) {
        return res.status(403).json({ error: "Access denied" });
      }

      const mmDirId = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : "all";
      const mmCacheKey = `margin-metrics:${req.session.organizationId}:${user.id}:${mmDirId}`;
      const mmCached = cacheGet(mmCacheKey);
      if (mmCached) return res.json(mmCached);

      const now = new Date();

      // Get latest financial data — org-scoped to prevent cross-tenant data leakage
      const upload = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      const rows: any[] = (upload?.rows as any[]) || [];
      const cols = resolveColumns(rows);
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

      // Derive the latest month from the uploaded data (not calendar month)
      // This ensures correct results even when uploads lag behind the calendar
      const uploadMonthKeys = new Set<string>();
      for (const row of rows) {
        const { monthKey } = parseHistoricalRow(row, cols);
        if (monthKey) uploadMonthKeys.add(monthKey);
      }
      const sortedUploadKeys = Array.from(uploadMonthKeys).sort();
      const curMonthKey = sortedUploadKeys.length > 0
        ? sortedUploadKeys[sortedUploadKeys.length - 1]
        : toMonthKey(now);

      // For goal matching, we still use calendar month range for goal overlap
      const [yr, mo] = curMonthKey.split("-").map(Number);
      const monthStart = `${curMonthKey}-01`;
      const monthEnd = new Date(yr, mo, 0).toISOString().slice(0, 10);

      // Margin by financialRepId / customer — map by user's financialRepId
      const byRepId: Record<string, number> = {};
      for (const row of rows) {
        if (isExcludedRow(row, cols)) continue;
        const { monthKey, margin } = parseHistoricalRow(row, cols);
        if (monthKey !== curMonthKey) continue;
        // Use the rep field in the financial data
        const rep = getRepFromRow(row, cols);
        if (!rep) continue;
        byRepId[rep] = (byRepId[rep] || 0) + margin;
      }

      // Fetch users and goals in parallel — both independent of upload data processing
      const [allUsers, allGoalsRaw] = await Promise.all([
        storage.getUsers(req.session.organizationId!),
        storage.getGoals({}),
      ]);
      // Scope goals to org users only — filter after fetching to avoid cross-tenant leakage
      const orgUserIds = new Set(allUsers.map(u => u.id));
      const allGoals = allGoalsRaw.filter(g =>
        (g.namId && orgUserIds.has(g.namId)) || (g.amId && orgUserIds.has(g.amId))
      );

      const namRoles = ["national_account_manager"];
      const amRoles = ["account_manager"];

      // For NAM role: only show their direct reports as AMs, not all AMs
      // For Director (non-admin) role: only show users within their vertical (direct reports + their direct reports)
      // Admins can filter by a specific director via ?directorId=<userId>
      const isDirectorOnlyRole = isDirectorRole && user.role !== "admin";
      const directorIdParam = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : null;
      let scopedUserIds: Set<string> | null = null;
      if (isNamRole) {
        scopedUserIds = new Set(allUsers.filter(u => u.managerId === user.id).map(u => u.id));
      } else if (directorIdParam) {
        const directReportIds = new Set(allUsers.filter(u => u.managerId === directorIdParam).map(u => u.id));
        scopedUserIds = new Set<string>(directReportIds);
        for (const namId of directReportIds) {
          for (const u of allUsers) {
            if (u.managerId === namId) scopedUserIds.add(u.id);
          }
        }
      } else if (isDirectorOnlyRole) {
        const directReportIds = new Set(allUsers.filter(u => u.managerId === user.id).map(u => u.id));
        scopedUserIds = new Set<string>(directReportIds);
        for (const namId of directReportIds) {
          for (const u of allUsers) {
            if (u.managerId === namId) scopedUserIds.add(u.id);
          }
        }
      }

      const filterByScope = (users: any[]) => scopedUserIds
        ? users.filter(u => scopedUserIds!.has(u.id))
        : users;

      const buildMetrics = (roleFilter: string[]) => {
        return filterByScope(allUsers.filter(u => roleFilter.includes(u.role)))
          .map(u => {
            // Match by financialRepId or by name normalization
            let margin = 0;
            if (u.financialRepId) {
              const repKey = u.financialRepId.toLowerCase().trim();
              margin = byRepId[repKey] || 0;
              if (!margin) {
                const nameNorm = normalize(u.name);
                for (const [k, v] of Object.entries(byRepId)) {
                  if (normalize(k).includes(nameNorm) || nameNorm.includes(normalize(k))) {
                    margin = v;
                    break;
                  }
                }
              }
            } else {
              const nameNorm = normalize(u.name);
              for (const [k, v] of Object.entries(byRepId)) {
                if (normalize(k).includes(nameNorm) || nameNorm.includes(normalize(k))) {
                  margin = v;
                  break;
                }
              }
            }

            const marginGoal = allGoals.find(g =>
              g.metric === "margin" &&
              g.amId === u.id &&
              g.startDate <= monthEnd &&
              g.endDate >= monthStart
            );

            return {
              userId: u.id,
              name: u.name,
              role: u.role,
              margin,
              goal: marginGoal ? { id: marginGoal.id, target: parseFloat(marginGoal.target) } : null,
            };
          });
      };

      const namMetrics = isNamRole ? [] : buildMetrics(namRoles);
      const amMetrics = buildMetrics(amRoles);
      console.log(`[margin-metrics] role=${user.role} nams=${namMetrics.length} ams=${amMetrics.length} scopedUserIds=${scopedUserIds ? scopedUserIds.size : 'null'} byRepIdKeys=${Object.keys(byRepId).length} curMonthKey=${curMonthKey}`);
      const mmResult = { nams: namMetrics, ams: amMetrics };
      cacheSet(mmCacheKey, mmResult, 15 * 60 * 1000);
      res.json(mmResult);
    } catch (err) {
      console.error("Error loading margin metrics:", err);
      res.status(500).json({ error: "Failed to load margin metrics" });
    }
  });

  // Personal metrics — for NAM and AM: their own individual activity stats
  // relationshipsMovedThisMonth: accounts they personally own with contacts that advanced this month
  // meaningfulToday: meaningful touchpoints they personally logged today
  // contactsAddedToday: contacts added today in their personally owned accounts
  // touchesToday: all touchpoints they personally logged today
  app.get("/api/dashboard/personal-metrics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const today = new Date().toISOString().slice(0, 10);
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      const orgId = req.session.organizationId!;

      // Fetch companies and contacts in parallel — both independent
      const [allCompanies, allContacts] = await Promise.all([
        storage.getCompanies(orgId),
        storage.getContacts(),
      ]);
      // Own accounts = companies where salesPersonId === current user
      const myCompanies = allCompanies.filter(c => c.salesPersonId === user.id);
      const myCompanyIds = new Set(myCompanies.map(c => c.id));
      const advancedCompanyIds = new Set(
        allContacts
          .filter(c => c.baseAdvancedAt && c.baseAdvancedAt >= monthStart && myCompanyIds.has(c.companyId))
          .map(c => c.companyId)
      );
      const relationshipsMovedThisMonth = advancedCompanyIds.size;

      // My own touchpoints today
      const myTouchpointsToday = await storage.getTouchpointsByUser(user.id, today);
      const touchesToday = myTouchpointsToday.length;
      const meaningfulToday = myTouchpointsToday.filter(t => t.isMeaningful).length;

      // New contacts added today in my accounts
      const contactsAddedToday = allContacts.filter(c =>
        c.createdAt &&
        c.createdAt.slice(0, 10) === today &&
        myCompanyIds.has(c.companyId)
      ).length;

      res.json({ relationshipsMovedThisMonth, meaningfulToday, contactsAddedToday, touchesToday });
    } catch (err) {
      res.status(500).json({ error: "Failed to load personal metrics" });
    }
  });

  // LM Carrier metrics — repeat carrier rate for the logged-in LM
  app.get("/api/dashboard/lm-carrier-metrics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role !== "logistics_manager" && user.role !== "logistics_coordinator") {
        return res.status(403).json({ error: "Access denied" });
      }
      const repId = (user as any).financialRepId as string | null;
      if (!repId) return res.json({ totalLoads: 0, uniqueCarriers: 0, repeatCarrierLoads: 0, repeatPct: 0, preferredCarriers: 0, topCarriers: [] });

      const upload = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      const allRows: any[] = (upload?.rows as any[]) || [];
      const cols = resolveColumns(allRows);

      // Determine current month from upload data
      const monthKeys = new Set<string>();
      for (const row of allRows) {
        const { monthKey } = parseHistoricalRow(row, cols);
        if (monthKey) monthKeys.add(monthKey);
      }
      const curMonthKey = monthKeys.size > 0
        ? Array.from(monthKeys).sort().pop()!
        : toMonthKey(new Date());

      // Filter to this LM's dispatched loads in current month
      const repIdLower = repId.toLowerCase().trim();
      const myRows = allRows.filter(row => {
        if (isExcludedRow(row, cols)) return false;
        const { monthKey } = parseHistoricalRow(row, cols);
        if (monthKey !== curMonthKey) return false;
        const disp = getDispatcherFromRow(row, cols).toLowerCase();
        return disp === repIdLower;
      });

      if (myRows.length === 0) {
        return res.json({ totalLoads: 0, uniqueCarriers: 0, repeatCarrierLoads: 0, repeatPct: 0, preferredCarriers: 0, topCarriers: [], curMonthKey });
      }

      // Count uses per carrier
      const carrierUses: Record<string, number> = {};
      for (const row of myRows) {
        const carrier = String(row[cols.carrier] || row["Carrier"] || "").trim();
        if (!carrier) continue;
        carrierUses[carrier] = (carrierUses[carrier] || 0) + 1;
      }

      const totalLoads = myRows.length;
      const uniqueCarriers = Object.keys(carrierUses).length;
      let repeatCarrierLoads = 0;
      let preferredCarriers = 0;
      for (const uses of Object.values(carrierUses)) {
        if (uses >= 2) {
          repeatCarrierLoads += uses;
          preferredCarriers++;
        }
      }
      const repeatPct = totalLoads > 0 ? Math.round((repeatCarrierLoads / totalLoads) * 1000) / 10 : 0;

      // Top 10 carriers by load count
      const topCarriers = Object.entries(carrierUses)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([carrier, loads]) => {
          // Strip the alias prefix (e.g. "JACOINSC - JACOBS TRANS LLC" → "Jacobs Trans LLC")
          const parts = carrier.split(" - ");
          const displayName = parts.length > 1 ? parts.slice(1).join(" - ") : carrier;
          return { carrier: displayName, loads, isRepeat: loads >= 2 };
        });

      res.json({ totalLoads, uniqueCarriers, repeatCarrierLoads, repeatPct, preferredCarriers, topCarriers, curMonthKey });
    } catch (err) {
      console.error("Error loading LM carrier metrics:", err);
      res.status(500).json({ error: "Failed to load carrier metrics" });
    }
  });

  // Daily briefing data
  app.get("/api/dashboard/briefing", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      // Management roles and LMs don't have individual daily touch targets — skip the banner
      const mgmtRoles = ["director", "national_account_manager", "admin", "sales", "sales_director", "logistics_manager", "logistics_coordinator"];
      if (mgmtRoles.includes(user.role)) {
        return res.json({ skip: true });
      }

      const today = new Date().toISOString().slice(0, 10);
      const currentMonth = today.slice(0, 7);

      const [allTasks, tps, streak, goalsData] = await Promise.all([
        storage.getTasks(),
        storage.getTouchpointsByUser(user.id, today),
        (async () => {
          const goalSetting = await storage.getSetting("streak_goal");
          const goal = parseInt(goalSetting || "5");
          const since = new Date(); since.setDate(since.getDate() - 60);
          const userTps = await storage.getTouchpointsByUser(user.id, since.toISOString().slice(0, 10));
          const byDate: Record<string, number> = {};
          for (const tp of userTps) byDate[tp.date] = (byDate[tp.date] || 0) + 1;
          let s = 0;
          const cur = new Date();
          for (let i = 0; i < 60; i++) {
            const d = cur.toISOString().slice(0, 10);
            const count = byDate[d] || 0;
            if (i === 0 && count < goal) { cur.setDate(cur.getDate() - 1); continue; }
            if (count >= goal) { s++; cur.setDate(cur.getDate() - 1); }
            else break;
          }
          return { streak: s, goal, todayCount: byDate[today] || 0 };
        })(),
        // Fetch and compute current-month goals for this rep
        (async () => {
          const userGoals = await storage.getGoals({ amId: user.id });
          const activeGoals = userGoals.filter(g =>
            g.status === "active" && g.startDate && g.startDate.startsWith(currentMonth)
          );
          const computed = await Promise.all(activeGoals.map(async g => {
            let current = 0;
            if (g.metric === "touchpoints") {
              current = await storage.getTouchpointCountByAm(g.amId, g.startDate, g.endDate);
            } else if (g.metric === "meaningful_touchpoints") {
              current = await storage.getMeaningfulTouchpointCountByAm(g.amId, g.startDate, g.endDate);
            } else if (g.metric === "contacts_added") {
              current = await storage.getContactsAddedByAm(g.amId, g.startDate, g.endDate);
            } else {
              current = Number(g.currentValue) || 0;
            }
            const metricLabels: Record<string, string> = {
              touchpoints: "touches",
              meaningful_touchpoints: "meaningful touches",
              contacts_added: "contacts added",
              tasks_completed: "tasks completed",
            };
            return {
              metric: g.metric,
              label: g.customLabel || metricLabels[g.metric] || g.metric,
              current,
              target: Number(g.target),
            };
          }));
          return computed;
        })(),
      ]);

      const dueTasks = allTasks.filter(t => t.assignedTo === user.id && t.status === "open" && t.dueDate && t.dueDate <= today);
      const todayTouchpoints = tps.length;

      res.json({
        skip: false,
        dueTasks: dueTasks.length,
        todayTouchpoints,
        streak: streak.streak,
        streakGoal: streak.goal,
        streakToday: streak.todayCount,
        goals: goalsData,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to load briefing data" });
    }
  });

  // ── Additional dashboard portlets (cold-contacts, meaningful-overdue, opportunity-leaderboard, churn-risk) ─
  app.get("/api/dashboard/cold-contacts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const days = parseInt(req.query.days as string) || 30;
      const cacheKey = `cold-contacts:${user.id}:${days}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      let results;
      if (user.role === "admin") {
        results = await storage.getColdContacts(null, days);
      } else if (user.role === "director" || user.role === "sales_director" || user.role === "national_account_manager" || user.role === "sales") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        results = await storage.getColdContacts(null, days, teamIds);
      } else {
        results = await storage.getColdContacts(user.id, days);
      }
      cacheSet(cacheKey, results, 10 * 60 * 1000);
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch cold contacts" });
    }
  });

  app.get("/api/dashboard/meaningful-overdue", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const days = parseInt(req.query.days as string) || 30;
      const cacheKey = `meaningful-overdue:${user.id}:${days}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      let results;
      if (user.role === "admin") {
        results = await storage.getMeaningfulOverdueContacts(null, days);
      } else if (user.role === "director" || user.role === "sales_director" || user.role === "national_account_manager" || user.role === "sales") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        results = await storage.getMeaningfulOverdueContacts(null, days, teamIds);
      } else {
        results = await storage.getMeaningfulOverdueContacts(user.id, days);
      }
      cacheSet(cacheKey, results, 10 * 60 * 1000);
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch meaningful overdue contacts" });
    }
  });

  app.get("/api/dashboard/opportunity-leaderboard", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { rows: dismissedRows } = await storage.pool.query(
        `SELECT company_id FROM opportunity_dismissals WHERE org_id = $1`,
        [req.session.organizationId!]
      );
      const dismissedIds = new Set(dismissedRows.map((r: any) => r.company_id));

      const companies = (await storage.getCompanies(req.session.organizationId!)).filter(c => !dismissedIds.has(c.id));
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const allRows: any[] = uploads.flatMap(u => (u.rows as any[]) || []);
      const msCols = resolveColumns(allRows);

      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

      type FinSummary = { totalLoads: number; totalMargin: number; totalRevenue: number };
      const byCustomer: Record<string, FinSummary> = {};
      const now = new Date();
      const ytdStart = `${now.getFullYear()}-01-01`;
      for (const row of allRows) {
        if (isExcludedRow(row, msCols)) continue;
        const cust = getCustomerFromRow(row, msCols);
        if (!cust) continue;
        const { monthKey, margin } = parseHistoricalRow(row, msCols);
        if (!monthKey) continue;
        const periodStart = monthKey + "-01";
        if (periodStart < ytdStart) continue;
        const revenue = Number(row[msCols.revenue] || row[msCols.totalCharges] || 0);
        if (revenue === 0) continue;
        const key = normalize(cust);
        if (!byCustomer[key]) byCustomer[key] = { totalLoads: 0, totalMargin: 0, totalRevenue: 0 };
        byCustomer[key].totalLoads++;
        byCustomer[key].totalMargin += margin;
        byCustomer[key].totalRevenue += revenue;
      }

      const allRfps = await storage.getRfps();
      const rfpsByCompany: Record<string, typeof allRfps> = {};
      for (const rfp of allRfps) {
        if (!rfpsByCompany[rfp.companyId]) rfpsByCompany[rfp.companyId] = [];
        rfpsByCompany[rfp.companyId].push(rfp);
      }

      const results: { companyId: string; companyName: string; potentialMargin: number; currentLoads: number; rfpVolume: number | null; hasRfp: boolean }[] = [];

      for (const company of companies) {
        const rfps = rfpsByCompany[company.id] || [];
        const rfpVolume = rfps.length > 0
          ? rfps.reduce((sum, r) => sum + (Number((r as any).totalVolume) || 0), 0)
          : 0;
        const hasRfp = rfpVolume > 0;

        const aliasNorms = (company as any).financialAlias
          ? (company as any).financialAlias.split(',').map((a: string) => normalize(a.trim())).filter(Boolean)
          : [normalize(company.name)];
        let fin: FinSummary | undefined;
        for (const aliasNorm of aliasNorms) {
          fin = byCustomer[aliasNorm] ||
            Object.entries(byCustomer).find(([k]) => k.includes(aliasNorm) || aliasNorm.includes(k))?.[1];
          if (fin) break;
        }

        const ytdLoads = fin?.totalLoads || 0;
        const ytdMargin = fin?.totalMargin || 0;
        const avgMarginPerLoad = ytdLoads > 0 ? ytdMargin / ytdLoads : 0;

        let potentialMargin = 0;
        if (hasRfp && ytdLoads > 0 && rfpVolume > ytdLoads) {
          potentialMargin = (rfpVolume - ytdLoads) * avgMarginPerLoad;
        } else if (!hasRfp) {
          const estimatedSpend = parseFloat(String((company as any).estimatedFreightSpend || 0)) || 0;
          if (estimatedSpend > 0 && avgMarginPerLoad > 0) {
            const avgRevPerLoad = ytdLoads > 0 ? (fin?.totalRevenue || 0) / ytdLoads : 0;
            if (avgRevPerLoad > 0) {
              const estimatedLoads = estimatedSpend / avgRevPerLoad;
              potentialMargin = (estimatedLoads - ytdLoads) * avgMarginPerLoad;
            }
          }
        }

        if (potentialMargin > 0) {
          results.push({
            companyId: company.id,
            companyName: company.name,
            potentialMargin,
            currentLoads: ytdLoads,
            rfpVolume: hasRfp ? rfpVolume : null,
            hasRfp,
          });
        }
      }

      results.sort((a, b) => b.potentialMargin - a.potentialMargin);
      res.json(results.slice(0, 5));
    } catch (error) {
      console.error("Error computing opportunity leaderboard:", error);
      res.status(500).json({ error: "Failed to compute opportunity leaderboard" });
    }
  });

  // Churn risk — companies whose load count dropped >20% current vs prior month
  app.get("/api/dashboard/churn-risk", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (!uploads.length) return res.json([]);

      const allRows: any[] = uploads.flatMap(u => (u.rows as any[]) || []);
      const cols = resolveColumns(allRows);
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

      const now = new Date();
      const curYear = now.getFullYear();
      const curMonth = now.getMonth(); // 0-indexed
      const mk = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;
      const curKey = mk(curYear, curMonth);
      const priorKey = curMonth === 0 ? mk(curYear - 1, 11) : mk(curYear, curMonth - 1);

      type MonthLoads = Record<string, number>;
      const byCustomer: Record<string, MonthLoads> = {};

      for (const row of allRows) {
        if (isExcludedRow(row, cols)) continue;
        const cust = getCustomerFromRow(row, cols);
        if (!cust) continue;
        const { monthKey } = parseHistoricalRow(row, cols);
        if (!monthKey || (monthKey !== curKey && monthKey !== priorKey)) continue;
        const key = normalize(cust);
        if (!byCustomer[key]) byCustomer[key] = {};
        byCustomer[key][monthKey] = (byCustomer[key][monthKey] || 0) + 1;
      }

      const companies = await storage.getCompanies(req.session.organizationId!);

      // Scope by role
      let visibleCompanyIds: Set<string> | null = null;
      if (user.role === "account_manager") {
        const ids = await getVisibleCompanyIds(user);
        visibleCompanyIds = new Set(ids);
      } else if (user.role === "national_account_manager") {
        const ids = await getVisibleCompanyIds(user);
        visibleCompanyIds = new Set(ids);
      }

      const results: { companyId: string; companyName: string; repName: string | null; curLoads: number; priorLoads: number; dropPct: number }[] = [];

      for (const company of companies) {
        if (visibleCompanyIds && !visibleCompanyIds.has(company.id)) continue;
        if ((company as any).archivedAt) continue;

        const aliasNorms = (company as any).financialAlias
          ? (company as any).financialAlias.split(",").map((a: string) => normalize(a.trim())).filter(Boolean)
          : [normalize(company.name)];

        let curLoads = 0, priorLoads = 0;
        for (const alias of aliasNorms) {
          const direct = byCustomer[alias];
          if (direct) {
            curLoads += direct[curKey] || 0;
            priorLoads += direct[priorKey] || 0;
          } else {
            for (const [k, v] of Object.entries(byCustomer)) {
              if (k.includes(alias) || alias.includes(k)) {
                curLoads += v[curKey] || 0;
                priorLoads += v[priorKey] || 0;
                break;
              }
            }
          }
        }

        if (priorLoads < 5) continue; // ignore low-volume accounts — noise
        const dropPct = (priorLoads - curLoads) / priorLoads;
        if (dropPct < 0.20) continue; // only show >20% drops

        let repName: string | null = null;
        const repId = (company as any).salesPersonId || (company as any).assignedTo;
        if (repId) {
          const rep = (await storage.getUsers(req.session.organizationId!)).find(u => u.id === repId);
          repName = rep ? `${rep.firstName} ${rep.lastName}` : null;
        }

        results.push({ companyId: company.id, companyName: company.name, repName, curLoads, priorLoads, dropPct });
      }

      results.sort((a, b) => b.dropPct - a.dropPct);
      res.json(results.slice(0, 8));
    } catch (error) {
      console.error("Churn risk error:", error);
      res.status(500).json({ error: "Failed to compute churn risk" });
    }
  });

  // ─── Dashboard Summary ────────────────────────────────────────────────────
  // Consolidates 5 small independent calls into 1 parallel-fetched response:
  //   urgentRfps, syncAlert (admin), missingMonthlyGoals (managers),
  //   oneOnOnePending (count), streak (current user)
  app.get("/api/dashboard/summary", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const orgId = req.session.organizationId!;
      const isAdmin = user.role === "admin";
      const isManagerRole = !["account_manager", "logistics_manager", "logistics_coordinator"].includes(user.role);

      const [urgentRfpsResult, syncAlertResult, missingGoalsResult, streakResult, pendingCountResult] = await Promise.all([
        // --- 1. Urgent RFPs (due within 14 days, excluding closed statuses) ---
        (async () => {
          const allRfps = await storage.getRfps();
          const orgCompanies = await storage.getCompanies(orgId);
          const orgCompanyIds = new Set(orgCompanies.map((c: any) => c.id));
          const visibleIds = await getVisibleCompanyIds(user);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const cutoff = 14 * 24 * 60 * 60 * 1000;
          const closedStatuses = new Set(["awarded", "partially_awarded", "lost", "declined"]);
          return allRfps
            .filter(r => {
              if (!r.dueDate || closedStatuses.has(r.status ?? "")) return false;
              if (!orgCompanyIds.has(r.companyId)) return false;
              if (visibleIds !== null && !visibleIds.includes(r.companyId)) return false;
              const due = new Date(r.dueDate + "T00:00:00");
              return due.getTime() - today.getTime() <= cutoff;
            })
            .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
            .map(r => ({ id: r.id, title: r.title, companyId: r.companyId, dueDate: r.dueDate }));
        })(),

        // --- 2. Sync alert (admin only) ---
        (async () => {
          if (!isAdmin) return { failed: false };
          const failedMonth = await storage.getSetting("monthly_sync_failed");
          if (!failedMonth) return { failed: false };
          const errorMessage = await storage.getSetting("monthly_sync_failed_error") || "Unknown error";
          return { failed: true, month: failedMonth, error: errorMessage };
        })(),

        // --- 3. Missing monthly goals (managers only) ---
        (async () => {
          if (!isManagerRole) return [];
          const namId = isAdmin ? undefined : user.id;
          return storage.getAmsMissingMonthlyGoals(orgId, namId);
        })(),

        // --- 4. Streak (current user's touchpoint streak) ---
        (async () => {
          const goalSetting = await storage.getSetting("streak_goal");
          const goal = parseInt(goalSetting || "5");
          const since = new Date(); since.setDate(since.getDate() - 60);
          const tps = await storage.getTouchpointsByUser(user.id, since.toISOString().slice(0, 10));
          const byDate: Record<string, number> = {};
          for (const tp of tps) byDate[tp.date] = (byDate[tp.date] || 0) + 1;
          const today = new Date().toISOString().slice(0, 10);
          const todayCount = byDate[today] || 0;
          let streak = 0;
          const cur = new Date();
          for (let i = 0; i < 60; i++) {
            const d = cur.toISOString().slice(0, 10);
            const count = byDate[d] || 0;
            if (i === 0 && count < goal) { cur.setDate(cur.getDate() - 1); continue; }
            if (count >= goal) { streak++; cur.setDate(cur.getDate() - 1); }
            else break;
          }
          return { streak, goal, todayCount };
        })(),

        // --- 5. Pending 1:1 topics count ---
        (async () => {
          const allUsers = await storage.getUsers(orgId);
          const amLikeRoles = ["account_manager", "logistics_manager", "logistics_coordinator"];
          let pairs: Array<{ namId: string; amId: string }> = [];
          if (amLikeRoles.includes(user.role)) {
            if (user.managerId) pairs.push({ namId: user.managerId, amId: user.id });
          } else if (isAdmin) {
            const allReports = allUsers.filter((u: any) => u.managerId && u.role !== "admin");
            for (const report of allReports) pairs.push({ namId: report.managerId!, amId: report.id });
          } else {
            const reports = allUsers.filter((u: any) => u.managerId === user.id);
            for (const am of reports) pairs.push({ namId: user.id, amId: am.id });
            if (user.managerId) pairs.push({ namId: user.managerId, amId: user.id });
          }
          const counts = await Promise.all(pairs.map(async ({ namId, amId }) => {
            const session = await storage.getOrCreateActiveSession(namId, amId);
            const topics = await storage.getTopicsBySession(session.id);
            return topics.filter((t: any) => t.status === "pending").length;
          }));
          return { count: counts.reduce((s, c) => s + c, 0) };
        })(),
      ]);

      res.json({
        urgentRfps: urgentRfpsResult,
        syncAlert: syncAlertResult,
        missingMonthlyGoals: missingGoalsResult,
        streak: streakResult,
        oneOnOnePending: pendingCountResult,
      });
    } catch (err) {
      console.error("Dashboard summary error:", err);
      res.status(500).json({ error: "Failed to load dashboard summary" });
    }
  });

  // ── AM Award Health portlet ───────────────────────────────────────────────
  // Returns awards for the AM's accounts that are old enough to have started
  // moving freight but show little or no load activity — signals stalled lanes.
  // Phase 1 constraint: uses company-level monthly loads as a proxy (no per-lane data).
  app.get("/api/dashboard/award-health", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role !== "account_manager") return res.json([]);

      const [allAwards, allCompanies, uploads] = await Promise.all([
        storage.getAwards(),
        storage.getCompanies(user.organizationId),
        storage.getFinancialUploadsForOrg(user.organizationId),
      ]);

      const visibleIds = await getVisibleCompanyIds(user);
      const scopedCompanies = allCompanies.filter(c =>
        !c.archivedAt && (visibleIds === null || visibleIds.includes(c.id))
      );
      const companyMap = new Map(scopedCompanies.map(c => [c.id, c]));

      const now = Date.now();
      const MIN_AGE_DAYS = 30;
      const MAX_AGE_DAYS = 365;
      const STALL_LOAD_THRESHOLD = 5; // loads in last 60 days

      // Build a normName helper inline (same logic as nbaPhase1Engine)
      const normN = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

      // Precompute loads-per-company map (last 60 days)
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      const cutoffMonth = sixtyDaysAgo.toISOString().slice(0, 7);

      const companyLoadsRecent = new Map<string, number>();
      for (const company of scopedCompanies) {
        const crmNorm = normN(company.name);
        const aliasNorms = company.financialAlias
          ? company.financialAlias.split(",").map((s: string) => normN(s.trim())).filter(Boolean)
          : [];
        let recentLoads = 0;
        for (const upload of uploads) {
          const rows = (upload.rows as any[]) ?? [];
          for (const row of rows) {
            const month = String(row.month ?? "").slice(0, 7);
            if (month < cutoffMonth) continue;
            const cust = normN(String(row.customerName ?? ""));
            if (cust !== crmNorm && !aliasNorms.some((a: string) => cust === a)) continue;
            recentLoads += Number(row.totalLoads ?? 0);
          }
        }
        companyLoadsRecent.set(company.id, recentLoads);
      }

      interface AwardHealthRow {
        awardId: string;
        awardTitle: string;
        companyId: string;
        companyName: string;
        awardDate: string | null;
        awardAgeDays: number;
        laneCount: number;
        value: string | null;
        recentLoads: number;
        hasFinancialData: boolean;
      }

      const stalledAwards: AwardHealthRow[] = [];

      for (const award of allAwards) {
        if (!companyMap.has(award.companyId)) continue;
        const company = companyMap.get(award.companyId)!;

        // Age gate
        const awardMs = award.awardDate ? new Date(award.awardDate).getTime() : null;
        const awardAgeDays = awardMs ? Math.floor((now - awardMs) / 86_400_000) : null;
        if (awardAgeDays === null) continue; // no date = skip
        if (awardAgeDays < MIN_AGE_DAYS) continue; // too fresh
        if (awardAgeDays > MAX_AGE_DAYS) continue; // too old — likely expired/irrelevant

        const recentLoads = companyLoadsRecent.get(award.companyId) ?? 0;
        const hasFinancialData = uploads.some(u => {
          const rows = (u.rows as any[]) ?? [];
          const crmNorm = normN(company.name);
          return rows.some(r => normN(String(r.customerName ?? "")) === crmNorm);
        });

        // Only surface awards where loads are low/missing — suppress healthy accounts
        if (hasFinancialData && recentLoads >= STALL_LOAD_THRESHOLD) continue;

        const laneCount = (award.lanes ?? []).filter(Boolean).length;

        stalledAwards.push({
          awardId: award.id,
          awardTitle: award.title,
          companyId: award.companyId,
          companyName: company.name,
          awardDate: award.awardDate ?? null,
          awardAgeDays,
          laneCount,
          value: award.value ?? null,
          recentLoads,
          hasFinancialData,
        });
      }

      // Sort: no-financial-data accounts last (uncertain); within known, sort by award age desc
      stalledAwards.sort((a, b) => {
        if (a.hasFinancialData !== b.hasFinancialData) return a.hasFinancialData ? -1 : 1;
        return b.awardAgeDays - a.awardAgeDays;
      });

      res.json(stalledAwards.slice(0, 10));
    } catch (err) {
      console.error("Award health error:", err);
      res.status(500).json({ error: "Failed to load award health" });
    }
  });

  // ── AM Coverage Gaps portlet ──────────────────────────────────────────────
  // Returns the top uncovered high-volume RFP facility sites across all of
  // the current AM's accounts. Reuses the same facility-coverage algorithm as
  // GET /api/companies/:id/facility-coverage — no new schema required.
  // Only produces results for account_manager role; returns [] for all others.
  app.get("/api/dashboard/coverage-gaps", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      // Only meaningful for AMs — avoids expensive multi-company fan-out for other roles.
      if (user.role !== "account_manager") return res.json([]);

      const [allRfps, allCompanies] = await Promise.all([
        storage.getRfps(),
        storage.getCompanies(user.organizationId),
      ]);

      const visibleIds = await getVisibleCompanyIds(user);
      const scopedCompanies = allCompanies.filter(c =>
        !c.archivedAt && (visibleIds === null || visibleIds.includes(c.id))
      );
      const companyMap = new Map(scopedCompanies.map(c => [c.id, c]));

      // Find which companies have at least one RFP with extracted lane data
      const companiesWithLanes = new Set<string>();
      for (const rfp of allRfps) {
        if (!companyMap.has(rfp.companyId)) continue;
        const fd = rfp.fileData as { highVolumeLanes?: unknown[] } | null;
        if (fd?.highVolumeLanes && fd.highVolumeLanes.length > 0) {
          companiesWithLanes.add(rfp.companyId);
        }
      }

      interface GapRow {
        companyId: string;
        companyName: string;
        facilityName: string;
        state: string;
        totalVolume: number;
        laneCount: number;
        rfpTitles: string[];
      }

      const MIN_VOLUME = 50; // loads/yr — below this is not worth surfacing
      const allGaps: GapRow[] = [];

      for (const companyId of companiesWithLanes) {
        const company = companyMap.get(companyId)!;
        const contacts = await storage.getContactsByCompany(companyId);
        // Only consider active (open/pending) RFPs — suppress gaps from expired/rejected RFPs
        const companyRfps = allRfps.filter(r =>
          r.companyId === companyId &&
          (!r.status || r.status === "open" || r.status === "pending")
        );
        if (companyRfps.length === 0) continue;

        // Build facility map — key on name+state only (merge origin and destination entries
        // for the same physical location into one row to avoid showing the same city twice)
        const facilityMap = new Map<string, GapRow>();

        for (const rfp of companyRfps) {
          const fd = rfp.fileData as { highVolumeLanes?: any[] } | null;
          if (!fd?.highVolumeLanes) continue;

          for (const lane of fd.highVolumeLanes) {
            const addFacility = (name: string, state: string) => {
              if (!name) return;
              const key = `${name.toLowerCase()}|${(state || "").toLowerCase()}`;
              const existing = facilityMap.get(key);
              if (existing) {
                existing.totalVolume += lane.volume || 0;
                existing.laneCount += 1;
                if (!existing.rfpTitles.includes(rfp.title)) existing.rfpTitles.push(rfp.title);
              } else {
                facilityMap.set(key, {
                  companyId,
                  companyName: company.name,
                  facilityName: name,
                  state: state || "",
                  totalVolume: lane.volume || 0,
                  laneCount: 1,
                  rfpTitles: [rfp.title],
                });
              }
            };
            addFacility(lane.origin || "", lane.originState || "");
            addFacility(lane.destination || "", lane.destinationState || "");
          }
        }

        // Determine which facilities are uncovered by any contact
        for (const [, f] of facilityMap) {
          const fLow = f.facilityName.toLowerCase();
          const sLow = f.state.toLowerCase();
          const fullLow = f.state ? `${fLow}, ${sLow}` : fLow;

          const covered = contacts.some(c => {
            const lanes = (c.lanes ?? []).map((l: string) => l.toLowerCase().trim());
            const regions = (c.regions ?? []).map((r: string) => r.toLowerCase().trim());
            return (
              lanes.some(l => l.includes(fLow) || fLow.includes(l) || l.includes(fullLow)) ||
              regions.some(r => r.includes(fLow) || fLow.includes(r) || (sLow.length >= 2 && r === sLow) || r.includes(fullLow))
            );
          });

          // Minimum volume threshold + must be uncovered
          if (!covered && f.totalVolume >= MIN_VOLUME) allGaps.push(f);
        }
      }

      // Sort by volume descending; cap at 15 rows to keep the portlet light
      allGaps.sort((a, b) => b.totalVolume - a.totalVolume);
      res.json(allGaps.slice(0, 15));
    } catch (err) {
      console.error("Coverage gaps error:", err);
      res.status(500).json({ error: "Failed to load coverage gaps" });
    }
  });

  // ── Today's Briefing — health summary (at-risk + contacts needing attention) ──
  app.get("/api/dashboard/briefing-health", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const orgId = req.session.organizationId!;
      const rawIds = await getVisibleCompanyIds(user);
      const allCompanies = await storage.getCompanies(orgId);
      const activeCompanies = allCompanies.filter((c: any) => !c.archivedAt);
      const visibleIds: string[] = rawIds !== null ? rawIds : activeCompanies.map((c: any) => c.id);
      if (visibleIds.length === 0) return res.json([]);

      const visibleSet = new Set(visibleIds);
      const visible = activeCompanies.filter((c: any) => visibleSet.has(c.id));

      const growthScores = await storage.getGrowthScoresByOrg(orgId, visibleIds);
      const scoreMap = new Map(growthScores.map((s: any) => [s.companyId, s]));

      let coldContacts: any[] = [];
      try {
        if (user.role === "admin") {
          coldContacts = await storage.getColdContacts(null, 30);
        } else if (["director", "sales_director", "national_account_manager", "sales"].includes(user.role)) {
          const teamIds = await storage.getTeamMemberIds(user.id, orgId);
          coldContacts = await storage.getColdContacts(null, 30, teamIds);
        } else {
          coldContacts = await storage.getColdContacts(user.id, 30);
        }
      } catch (_) { /* cold contacts optional */ }

      const coldCompanyIds = new Set(coldContacts.map((r: any) => r.company?.id).filter(Boolean));

      const result = visible.map((c: any) => {
        const score = scoreMap.get(c.id);
        return {
          id: c.id,
          name: c.name,
          growthBand: score?.band ?? null,
          growthScore: score?.score ?? null,
          needsAttention: coldCompanyIds.has(c.id),
        };
      });

      res.json(result);
    } catch (err) {
      console.error("briefing-health error:", err);
      res.status(500).json({ error: "Failed to load briefing health data" });
    }
  });

}
