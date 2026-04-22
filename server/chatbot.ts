import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { sendEmail, buildFeedbackEmail } from "./emailService";
import { getNationalMarketSummary, getMarketOtris, getLaneVotrisBatch, getLaneMarketRate, buildVotriQualifier } from "./sonarClient";
import { tracLaneDirectionSignal } from "./tracAlertEngine";
import { computeIntelPayload } from "./routes/intel";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, desc, gte, inArray, sql } from "drizzle-orm";
import {
  companies, contacts, touchpoints, rfps, goals, tasks, users,
  chatConversations, chatMessages, appSuggestions, notifications,
} from "@shared/schema";
import { storage } from "./storage";
import { resolveColumns } from "./colResolver";
import { geocodeCity, haversineDistance } from "./geocoding";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// Rate positioning context cache: 30-minute TTL per org to avoid heavy recomputation on every chat message
const ratePositioningCache = new Map<string, { context: string; fetchedAt: number }>();
const RATE_POSITIONING_CACHE_TTL_MS = 30 * 60 * 1000;

export async function getCachedRatePositioningContext(orgId: string, filterUserId?: string): Promise<string> {
  const cacheKey = `rpc:${orgId}:${filterUserId ?? "all"}`;
  const cached = ratePositioningCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < RATE_POSITIONING_CACHE_TTL_MS) {
    return cached.context;
  }
  try {
    const intel = await computeIntelPayload(orgId, filterUserId);
    const rp = intel.ratePositioning;
    if (!rp || rp.lanes.length === 0) return "";
    const pe = rp.portfolioExposure;
    const topAbove = rp.lanes.filter(l => l.classification === "ABOVE_MARKET").slice(0, 3);
    const topBelow = rp.lanes.filter(l => l.classification === "BELOW_MARKET").slice(0, 3);
    const context = `\n\n=== RATE POSITIONING SUMMARY (SONAR TRAC-adjusted, 4-week avg vs national VCRPM1 benchmark) ===
Portfolio: ${pe.aboveMarketCount} lanes above market (${pe.aboveMarketPct}%), ${pe.atMarketCount} at market (${pe.atMarketPct}%), ${pe.belowMarketCount} below market (${pe.belowMarketPct}%).
Avg delta: ${pe.avgDeltaPct > 0 ? "+" : ""}${pe.avgDeltaPct}% vs benchmark. Est. monthly over-market spend: $${pe.monthlyOverMarketDollars?.toLocaleString() ?? 0}.
${topAbove.length > 0 ? `TOP ABOVE-MARKET LANES (paying too much): ${topAbove.map(l => `${l.lane} (+${l.deltaPct.toFixed(1)}%, $${l.avgCarrierPayPerMile.toFixed(2)}/mi vs ${l.marketRatePerMile != null ? `$${l.marketRatePerMile.toFixed(2)}` : "unavailable"} benchmark)`).join("; ")}.` : ""}
${topBelow.length > 0 ? `TOP BELOW-MARKET LANES (favorable rate): ${topBelow.map(l => `${l.lane} (${l.deltaPct.toFixed(1)}%, $${l.avgCarrierPayPerMile.toFixed(2)}/mi vs ${l.marketRatePerMile != null ? `$${l.marketRatePerMile.toFixed(2)}` : "unavailable"} benchmark)`).join("; ")}.` : ""}
${pe.tighteningActionLanes?.length ? `TIGHTENING LANES (act fast): ${pe.tighteningActionLanes.join(", ")}.` : ""}
Use the get_lane_rate_positioning tool for full coaching detail on any specific lane or when the user asks about rate competitiveness.`;
    ratePositioningCache.set(cacheKey, { context, fetchedAt: Date.now() });
    return context;
  } catch {
    return "";
  }
}

const anthropic = new Anthropic({
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
});

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

function normalizeModeCS(raw: string): string {
  const t = (raw || "").trim().toLowerCase();
  if (!t) return "";
  if (/^(v|van|dry.?van|dv|dryvan)$/.test(t)) return "Van";
  if (/^(r|reefer|refrigerated|temp|temperature|temp.?ctrl)$/.test(t)) return "Reefer";
  if (/^(f|flatbed|fb|flat|step.?deck|rgn|lowboy)$/.test(t)) return "Flatbed";
  if (/^ltl$/.test(t)) return "LTL";
  if (/^(drayage|dray)$/.test(t)) return "Drayage";
  if (/^(imdl|intermodal|im|rail)$/.test(t)) return "IMDL";
  const s = raw.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function runCarrierLaneSearch(
  orgId: string,
  originQuery: string,
  destQuery: string,
  radiusMiles: number,
  modeFilter: string,
  minLoadsPerMonth: number,
): Promise<string> {
  try {
    function parseCityState(q: string): { city: string; state: string } {
      if (!q) return { city: "", state: "" };
      const cm = q.match(/^(.+),\s*([A-Za-z]{2})$/);
      if (cm) return { city: cm[1].trim(), state: cm[2].trim().toUpperCase() };
      const sm = q.match(/^(.+)\s+([A-Za-z]{2})$/);
      if (sm) return { city: sm[1].trim(), state: sm[2].trim().toUpperCase() };
      if (/^[A-Za-z]{2}$/.test(q)) return { city: "", state: q.trim().toUpperCase() };
      return { city: q.trim(), state: "" };
    }

    const originParsed = parseCityState(originQuery);
    const destParsed   = parseCityState(destQuery);
    const originCenter = originQuery ? geocodeCity(originParsed.city, originParsed.state) : null;
    const destCenter   = destQuery   ? geocodeCity(destParsed.city,   destParsed.state)   : null;

    function locMatches(city: string, state: string, rawText: string, queryRaw: string, center: [number, number] | null): { match: boolean; dist: number | null } {
      if (!queryRaw) return { match: true, dist: null };
      if (center) {
        const lc = geocodeCity(city, state);
        if (lc) {
          const d = haversineDistance(center[0], center[1], lc[0], lc[1]);
          return { match: d <= radiusMiles, dist: Math.round(d) };
        }
      }
      return { match: rawText.toLowerCase().includes(queryRaw.toLowerCase()), dist: null };
    }

    const uploads = await storage.getFinancialUploadsForOrg(orgId);
    if (!uploads.length) return "No financial data found for this organization.";

    type CarrierStats = { loads: number; totalMargin: number; totalCarrierPay: number; lastDate: string | null };
    type CorridorData = {
      originCity: string; originState: string;
      destCity: string;   destState: string;
      mode: string;
      monthLoads: Map<string, number>;
      carriers: Map<string, CarrierStats>;
    };
    const corridorMap = new Map<string, CorridorData>();

    for (const upload of uploads) {
      const rows: any[] = (upload.rows as any[]) || [];
      if (!rows.length) continue;
      const cols = resolveColumns(rows);

      for (const row of rows) {
        // exclude valubuaz
        const rep = String(row[cols.opsUser] || "").trim().toLowerCase();
        if (rep === "valubuaz") continue;
        const revenue = Number(row[cols.revenue] || row[cols.totalCharges] || 0);
        if (revenue === 0) continue;

        const origCity  = String(row[cols.shipperCity]    || row[cols.origin]          || "").trim();
        const origState = String(row[cols.shipperState]   || row[cols.originState]      || "").trim().toUpperCase();
        const dstCity   = String(row[cols.consigneeCity]  || row[cols.destination]      || "").trim();
        const dstState  = String(row[cols.consigneeState] || row[cols.destinationState] || "").trim().toUpperCase();
        const carrier   = String(row[cols.carrier]        || "").trim();
        const mode      = normalizeModeCS(String(row[cols.equipmentType] || "").trim());

        if (!origCity && !origState) continue;
        if (!dstCity  && !dstState)  continue;
        if (!carrier) continue;
        if (!mode) continue;
        if (modeFilter && modeFilter.toLowerCase() !== "any" && mode.toLowerCase() !== modeFilter.toLowerCase()) continue;

        // parse month key + margin
        let monthKey = "";
        let margin = 0;
        const rawDate = row[cols.deliveryDate] || row[cols.dateOrdered];
        if (rawDate != null && rawDate !== "") {
          const serial = Number(rawDate);
          if (!isNaN(serial) && serial > 40000) {
            const d = new Date(new Date(1899, 11, 30).getTime() + serial * 86400000);
            monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          } else {
            const dStr = String(rawDate).trim();
            if (dStr && isNaN(Number(dStr))) {
              const d = new Date(dStr);
              if (!isNaN(d.getTime())) monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            }
          }
        }
        const rawMargin = String(row[cols.marginDollar] || "").replace(/[^0-9.\-]/g, "");
        if (rawMargin) margin = parseFloat(rawMargin) || 0;
        else {
          const rev = Number(row[cols.revenue] || row[cols.totalCharges] || 0);
          const rawCP = String(row[cols.carrierPay] || row[cols.freightCharge] || "").replace(/[^0-9.]/g, "");
          const cp = rawCP ? parseFloat(rawCP) || 0 : 0;
          margin = rev - cp;
        }

        const rawCarrierPay = String(row[cols.carrierPay] || row[cols.freightCharge] || "").replace(/[^0-9.]/g, "");
        const carrierPayVal = rawCarrierPay ? parseFloat(rawCarrierPay) || 0 : 0;

        const key = `${origCity.toLowerCase()}|${origState}|${dstCity.toLowerCase()}|${dstState}|${mode}`;
        if (!corridorMap.has(key)) {
          corridorMap.set(key, {
            originCity: origCity, originState: origState,
            destCity: dstCity,   destState: dstState,
            mode,
            monthLoads: new Map(),
            carriers: new Map(),
          });
        }
        const corridor = corridorMap.get(key)!;
        const mk = monthKey || "unknown";
        corridor.monthLoads.set(mk, (corridor.monthLoads.get(mk) || 0) + 1);
        if (!corridor.carriers.has(carrier)) corridor.carriers.set(carrier, { loads: 0, totalMargin: 0, totalCarrierPay: 0, lastDate: null });
        const cs = corridor.carriers.get(carrier)!;
        cs.loads++;
        cs.totalMargin += margin || 0;
        cs.totalCarrierPay += carrierPayVal;
        if (monthKey && (!cs.lastDate || monthKey > cs.lastDate)) cs.lastDate = monthKey;
      }
    }

    const results: any[] = [];
    for (const corridor of corridorMap.values()) {
      const realMonths = [...corridor.monthLoads.keys()].filter(k => k !== "unknown");
      const totalLoads = [...corridor.monthLoads.values()].reduce((s, v) => s + v, 0);
      const monthCount = Math.max(1, realMonths.length);
      const avgLoadsPerMonth = totalLoads / monthCount;
      if (avgLoadsPerMonth < minLoadsPerMonth) continue;

      const origCheck = locMatches(corridor.originCity, corridor.originState, `${corridor.originCity} ${corridor.originState}`, originQuery, originCenter);
      const dstCheck  = locMatches(corridor.destCity,   corridor.destState,   `${corridor.destCity} ${corridor.destState}`,   destQuery,   destCenter);
      if (!origCheck.match || !dstCheck.match) continue;

      const originLabel = [corridor.originCity, corridor.originState].filter(Boolean).join(", ");
      const destLabel   = [corridor.destCity,   corridor.destState].filter(Boolean).join(", ");
      const carrierList = [...corridor.carriers.entries()]
        .map(([name, cs]) => ({
          name,
          loads: cs.loads,
          pct: Math.round((cs.loads / totalLoads) * 100),
          avgMarginPerLoad: cs.loads > 0 ? Math.round(cs.totalMargin / cs.loads) : null,
          avgCarrierPay: cs.loads > 0 && cs.totalCarrierPay > 0 ? Math.round(cs.totalCarrierPay / cs.loads) : null,
          lastUsed: cs.lastDate,
        }))
        .sort((a, b) => b.loads - a.loads);

      results.push({ originLabel, destLabel, mode: corridor.mode, avgLoadsPerMonth: Math.round(avgLoadsPerMonth * 10) / 10, totalLoads, carriers: carrierList });
    }

    results.sort((a, b) => b.avgLoadsPerMonth - a.avgLoadsPerMonth);

    if (!results.length) return `No corridors found matching your criteria (origin: "${originQuery || "any"}", dest: "${destQuery || "any"}", radius: ${radiusMiles}mi, mode: ${modeFilter || "any"}).`;

    const TOP_CORRIDORS = 6;
    const TOP_CARRIERS  = 5;
    let out = `Carrier lane search results — ${originQuery || "any origin"} → ${destQuery || "any dest"} (${radiusMiles}mi radius${modeFilter ? `, ${modeFilter} only` : ""}):\n\n`;
    for (const r of results.slice(0, TOP_CORRIDORS)) {
      out += `**${r.originLabel} → ${r.destLabel}** [${r.mode}] — ${r.avgLoadsPerMonth} loads/mo avg (${r.totalLoads} total)\n`;
      for (const c of r.carriers.slice(0, TOP_CARRIERS)) {
        const pay  = c.avgCarrierPay     != null ? ` | avg carrier pay $${c.avgCarrierPay.toLocaleString()}`    : "";
        const marg = c.avgMarginPerLoad  != null ? ` | avg margin $${c.avgMarginPerLoad.toLocaleString()}`  : "";
        out += `  • ${c.name} — ${c.loads} loads (${c.pct}%)${pay}${marg}\n`;
      }
      if (r.carriers.length > TOP_CARRIERS) out += `  ...and ${r.carriers.length - TOP_CARRIERS} more carriers\n`;
      out += "\n";
    }
    if (results.length > TOP_CORRIDORS) out += `(${results.length - TOP_CORRIDORS} more corridors — open Carrier Lane Search for full results)\n`;
    return out;
  } catch (err) {
    console.error("Chatbot carrier lane search error:", err);
    return "Carrier lane search failed. Please try the Carrier Lane Search page directly.";
  }
}

async function buildEveryoneContext(requestingUserId: string): Promise<string> {
  try {
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString();

    const [allUsers, allCompanies, allContacts, allTouchpoints, allGoals, allTasks, allRfps] = await Promise.all([
      db.select().from(users).limit(200),
      db.select().from(companies).limit(500),
      db.select().from(contacts).limit(2000),
      db.select().from(touchpoints).where(gte(touchpoints.date, thirtyDaysAgo)).limit(2000),
      db.select().from(goals).limit(200),
      db.select().from(tasks).where(eq(tasks.status, "open")).limit(200),
      db.select().from(rfps).where(eq(rfps.status, "open")).limit(100),
    ]);

    const accountManagerUsers = allUsers.filter(u =>
      u.role === "account_manager" || u.role === "national_account_manager" || u.role === "director" || u.role === "sales"
    );

    let ctx = `Today's date: ${today}\nData scope: EVERYONE (all teams)\n\n`;

    ctx += `=== TEAM MEMBERS (${accountManagerUsers.length}) ===\n`;
    accountManagerUsers.forEach(u => {
      const myCompanies = allCompanies.filter(c => c.assignedTo === u.id);
      const myContactIds = allContacts.filter(c => myCompanies.some(co => co.id === c.companyId)).map(c => c.id);
      const contactsThisMonth = allContacts.filter(c =>
        myCompanies.some(co => co.id === c.companyId) && c.createdAt && c.createdAt >= firstOfMonth
      ).length;
      const touchpointsThisMonth = allTouchpoints.filter(tp =>
        tp.contactId !== null && myContactIds.includes(tp.contactId) && tp.date >= firstOfMonth
      ).length;
      const touchpoints30d = allTouchpoints.filter(tp => tp.contactId !== null && myContactIds.includes(tp.contactId)).length;
      ctx += `- ${u.name} (${u.role.replace(/_/g, " ")}): ${myCompanies.length} accounts, ${myContactIds.length} contacts total, ${contactsThisMonth} new contacts this month, ${touchpointsThisMonth} touchpoints this month, ${touchpoints30d} touchpoints last 30d\n`;
    });

    ctx += `\n=== ALL ACCOUNTS (${allCompanies.length}) ===\n`;
    allCompanies.slice(0, 120).forEach(c => {
      const rep = allUsers.find(u => u.id === c.assignedTo);
      const modes = (c as any).shippingModes?.length ? ` [Modes: ${(c as any).shippingModes.join(", ")}]` : "";
      ctx += `- ${c.name}${c.financialAlias ? ` (alias: ${c.financialAlias})` : ""}${modes} → ${rep?.name || "Unassigned"}\n`;
    });
    if (allCompanies.length > 120) ctx += `  ...and ${allCompanies.length - 120} more accounts\n`;

    ctx += `\n=== ALL CONTACTS (${allContacts.length}) ===\n`;
    allContacts.slice(0, 200).forEach(c => {
      const company = allCompanies.find(co => co.id === c.companyId);
      const rep = allUsers.find(u => u.id === company?.assignedTo);
      const lastTouch = allTouchpoints.find(tp => tp.contactId === c.id);
      const daysAgo = lastTouch ? Math.floor((Date.now() - new Date(lastTouch.date).getTime()) / 86400000) : null;
      ctx += `- ${c.name}${c.title ? ` (${c.title})` : ""} @ ${company?.name || "Unknown"} [Rep: ${rep?.name || "?"}]`;
      if (daysAgo !== null) ctx += ` | Last touch: ${daysAgo}d ago (${lastTouch!.type})`;
      else ctx += ` | Last touch: >30 days or never`;
      if (c.createdAt && c.createdAt >= firstOfMonth) ctx += ` | NEW THIS MONTH`;
      ctx += "\n";
    });
    if (allContacts.length > 200) ctx += `  ...and ${allContacts.length - 200} more contacts\n`;

    ctx += `\n=== OPEN RFPs (${allRfps.length}) ===\n`;
    allRfps.forEach(r => {
      const company = allCompanies.find(co => co.id === r.companyId);
      const rep = allUsers.find(u => u.id === company?.assignedTo);
      ctx += `- ${r.title} @ ${company?.name || "Unknown"} [Rep: ${rep?.name || "?"}] | Due: ${r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "No due date"}\n`;
    });

    ctx += `\n=== OPEN TASKS (${allTasks.length}) ===\n`;
    allTasks.slice(0, 60).forEach(t => {
      const assignee = allUsers.find(u => u.id === t.assignedTo);
      const assigner = allUsers.find(u => u.id === t.assignedBy);
      ctx += `- ${t.title} | Assigned to: ${assignee?.name || "?"} | By: ${assigner?.name || "?"} | Due: ${t.dueDate ? new Date(t.dueDate).toLocaleDateString() : "None"}\n`;
    });
    if (allTasks.length > 60) ctx += `  ...and ${allTasks.length - 60} more tasks\n`;

    ctx += `\n=== GOALS (${allGoals.length}) ===\n`;
    allGoals.slice(0, 60).forEach(g => {
      const nam = allUsers.find(u => u.id === g.namId);
      const am = allUsers.find(u => u.id === g.amId);
      const tgt = parseFloat(g.target) || 0;
      const cur = parseFloat(g.currentValue || "0") || 0;
      const pct = tgt > 0 ? Math.round((cur / tgt) * 100) : 0;
      ctx += `- ${am?.name || "?"} | ${g.metric}${g.customLabel ? ` (${g.customLabel})` : ""}: ${cur}/${tgt} (${pct}%) | Set by: ${nam?.name || "?"}\n`;
    });

    return ctx;
  } catch (err) {
    console.error("Error building everyone context:", err);
    return "CRM data temporarily unavailable.";
  }
}

async function buildMyTeamContext(userId: string, userRole: string): Promise<string> {
  try {
    let visibleCompanies: (typeof companies.$inferSelect)[] = [];

    if (userRole === "admin") {
      visibleCompanies = await db.select().from(companies).limit(300);
    } else if (userRole === "national_account_manager" || userRole === "director" || userRole === "sales") {
      const subordinates = await db.select({ id: users.id }).from(users).where(eq(users.managerId, userId));
      const subIds = [userId, ...subordinates.map((s) => s.id)];
      visibleCompanies = await db.select().from(companies).where(inArray(companies.assignedTo, subIds)).limit(300);
    } else {
      visibleCompanies = await db.select().from(companies).where(eq(companies.assignedTo, userId)).limit(200);
    }

    const companyIds = visibleCompanies.map((c) => c.id);

    let contactList: (typeof contacts.$inferSelect)[] = [];
    if (companyIds.length > 0) {
      contactList = await db.select().from(contacts).where(inArray(contacts.companyId, companyIds)).limit(500);
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    let recentTouchpoints: (typeof touchpoints.$inferSelect)[] = [];
    if (contactList.length > 0) {
      const contactIds = contactList.map((c) => c.id);
      recentTouchpoints = await db.select().from(touchpoints)
        .where(and(inArray(touchpoints.contactId, contactIds), gte(touchpoints.date, thirtyDaysAgo.toISOString())))
        .orderBy(desc(touchpoints.date))
        .limit(200);
    }

    let openRfps: (typeof rfps.$inferSelect)[] = [];
    if (companyIds.length > 0) {
      openRfps = await db.select().from(rfps).where(and(inArray(rfps.companyId, companyIds), eq(rfps.status, "open"))).limit(50);
    }

    let activeGoals: (typeof goals.$inferSelect)[] = [];
    if (userRole === "national_account_manager" || userRole === "admin" || userRole === "director" || userRole === "sales") {
      activeGoals = await db.select().from(goals).where(eq(goals.namId, userId)).limit(30);
    } else {
      activeGoals = await db.select().from(goals).where(eq(goals.amId, userId)).limit(20);
    }

    let openTasks: (typeof tasks.$inferSelect)[] = [];
    openTasks = await db.select().from(tasks).where(and(eq(tasks.assignedTo, userId), eq(tasks.status, "open"))).limit(30);

    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    let ctx = `Today's date: ${today}\nData scope: MY TEAM\n\n`;

    ctx += `=== ACCOUNTS (${visibleCompanies.length}) ===\n`;
    visibleCompanies.slice(0, 80).forEach((c) => {
      const modes = (c as any).shippingModes?.length ? ` [Modes: ${(c as any).shippingModes.join(", ")}]` : "";
      ctx += `- ${c.name}${c.financialAlias ? ` (alias: ${c.financialAlias})` : ""}${modes}\n`;
    });
    if (visibleCompanies.length > 80) ctx += `  ...and ${visibleCompanies.length - 80} more accounts\n`;

    ctx += `\n=== CONTACTS (${contactList.length}) ===\n`;
    contactList.slice(0, 150).forEach((c) => {
      const company = visibleCompanies.find((co) => co.id === c.companyId);
      const lastTouch = recentTouchpoints.find((tp) => tp.contactId === c.id);
      ctx += `- ${c.name}${c.title ? ` (${c.title})` : ""} @ ${company?.name || "Unknown"}`;
      if (c.relationshipBase) ctx += ` | Relationship: ${c.relationshipBase}`;
      if (lastTouch) {
        const daysAgo = Math.floor((Date.now() - new Date(lastTouch.date).getTime()) / 86400000);
        ctx += ` | Last touch: ${daysAgo}d ago (${lastTouch.type})`;
      } else {
        ctx += ` | Last touch: >30 days or never`;
      }
      if (c.createdAt && c.createdAt >= firstOfMonth) ctx += ` | NEW THIS MONTH`;
      ctx += "\n";
    });
    if (contactList.length > 150) ctx += `  ...and ${contactList.length - 150} more contacts\n`;

    ctx += `\n=== OPEN RFPs (${openRfps.length}) ===\n`;
    openRfps.forEach((r) => {
      const company = visibleCompanies.find((co) => co.id === r.companyId);
      ctx += `- ${r.title} @ ${company?.name || "Unknown"} | Due: ${r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "No due date"}\n`;
    });

    ctx += `\n=== OPEN TASKS (${openTasks.length}) ===\n`;
    openTasks.forEach((t) => {
      ctx += `- ${t.title}${t.dueDate ? ` | Due: ${new Date(t.dueDate).toLocaleDateString()}` : ""}\n`;
    });

    ctx += `\n=== GOALS (${activeGoals.length}) ===\n`;
    activeGoals.forEach((g) => {
      const tgt = parseFloat(g.target) || 0;
      const cur = parseFloat(g.currentValue || "0") || 0;
      const pct = tgt > 0 ? Math.round((cur / tgt) * 100) : 0;
      ctx += `- ${g.metric}${g.customLabel ? ` (${g.customLabel})` : ""}: ${cur}/${tgt} (${pct}%)\n`;
    });

    return ctx;
  } catch (err) {
    console.error("Error building my-team context:", err);
    return "CRM data temporarily unavailable.";
  }
}

export async function getCompanyDetails(orgId: string, companyName: string): Promise<string> {
  try {
    const allCompanies = await db.select().from(companies).where(eq(companies.organizationId, orgId));
    const cn = companyName.toLowerCase();
    const company = allCompanies.find(c => c.name.toLowerCase().includes(cn))
      || allCompanies.find(c => cn.includes(c.name.toLowerCase().slice(0, 5)));
    if (!company) return `No company found matching "${companyName}".`;

    const [companyContacts, companyRfps, assignedUserRows] = await Promise.all([
      db.select().from(contacts).where(eq(contacts.companyId, company.id)),
      db.select().from(rfps).where(and(eq(rfps.companyId, company.id), eq(rfps.status, "open"))),
      company.assignedTo ? db.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, company.assignedTo)) : Promise.resolve([]),
    ]);

    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const recentTps = await db.select().from(touchpoints)
      .where(and(eq(touchpoints.companyId, company.id), gte(touchpoints.date, sixtyDaysAgo)))
      .orderBy(desc(touchpoints.date))
      .limit(15);

    const assignedUser = assignedUserRows[0];
    let out = `=== ${company.name} ===\n`;
    if (company.industry) out += `Industry: ${company.industry}\n`;
    if (company.financialAlias) out += `Financial alias: ${company.financialAlias}\n`;
    if (company.shippingModes?.length) out += `Shipping modes: ${company.shippingModes.join(", ")}\n`;
    if (company.estimatedFreightSpend) out += `Est. freight spend: $${Number(company.estimatedFreightSpend).toLocaleString()}\n`;
    if (assignedUser) out += `Rep: ${assignedUser.name} (${assignedUser.role.replace(/_/g, " ")})\n`;
    if (company.tenderStyle) out += `Tender style: ${company.tenderStyle}\n`;
    if (company.accountSummary) out += `\nAccount summary: ${company.accountSummary}\n`;
    if (company.accountQuirks) out += `Quirks/notes: ${company.accountQuirks}\n`;
    if (company.processNotes) out += `Process notes: ${company.processNotes}\n`;
    if (company.spotProcess) out += `Spot process: ${company.spotProcess}\n`;
    if (company.operatingHours) out += `Operating hours: ${company.operatingHours}\n`;

    out += `\n-- Contacts (${companyContacts.length}) --\n`;
    companyContacts.forEach(c => {
      out += `• ${c.name}${c.title ? ` (${c.title})` : ""}`;
      if (c.relationshipBase) out += ` | Rel: ${c.relationshipBase}`;
      if (c.email) out += ` | ${c.email}`;
      if (c.phone) out += ` | ${c.phone}`;
      if (c.nextSteps) out += ` | Next: ${c.nextSteps}`;
      out += "\n";
    });

    out += `\n-- Recent Touchpoints (last 60 days, ${recentTps.length}) --\n`;
    recentTps.forEach(tp => {
      const contact = companyContacts.find(c => c.id === tp.contactId);
      out += `• [${tp.date}] ${tp.type}${contact ? ` w/ ${contact.name}` : ""}${tp.isMeaningful ? " ★" : ""}`;
      if (tp.notes) out += ` — "${tp.notes.slice(0, 100)}${tp.notes.length > 100 ? "..." : ""}"`;
      out += "\n";
    });

    out += `\n-- Open RFPs (${companyRfps.length}) --\n`;
    companyRfps.forEach(r => {
      out += `• ${r.title}${r.dueDate ? ` | Due: ${r.dueDate}` : ""}${r.value ? ` | Value: $${Number(r.value).toLocaleString()}` : ""}\n`;
    });

    return out;
  } catch (err) {
    console.error("getCompanyDetails error:", err);
    return `Failed to load details for "${companyName}".`;
  }
}

async function buildCrmContext(userId: string, userRole: string, scope: string): Promise<string> {
  const useEveryone = userRole === "admin" || userRole === "director" || scope === "everyone";
  if (useEveryone) {
    return buildEveryoneContext(userId);
  }
  return buildMyTeamContext(userId, userRole);
}

export function registerChatbotRoutes(app: Express): void {
  app.get("/api/chatbot/conversations", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const convos = await db.select().from(chatConversations)
        .where(eq(chatConversations.userId, req.session.userId))
        .orderBy(desc(chatConversations.id))
        .limit(20);
      res.json(convos);
    } catch (err) {
      res.status(500).json({ error: "Failed to load conversations" });
    }
  });

  app.post("/api/chatbot/conversations", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const [convo] = await db.insert(chatConversations).values({
        userId: req.session.userId,
        title: req.body.title || "New Chat",
        createdAt: new Date().toISOString(),
      }).returning();
      res.json(convo);
    } catch (err) {
      console.error("Failed to create chatbot conversation:", err);
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  app.delete("/api/chatbot/conversations/:id", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const id = parseInt(req.params.id as string);
      await db.delete(chatMessages).where(eq(chatMessages.conversationId, id));
      await db.delete(chatConversations).where(and(
        eq(chatConversations.id, id),
        eq(chatConversations.userId, req.session.userId),
      ));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  app.get("/api/chatbot/conversations/:id/messages", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const conversationId = parseInt(req.params.id as string);
      const [conv] = await db.select().from(chatConversations).where(eq(chatConversations.id, conversationId));
      if (!conv || conv.userId !== req.session.userId) return res.status(404).json({ error: "Conversation not found" });
      const msgs = await db.select().from(chatMessages)
        .where(eq(chatMessages.conversationId, conversationId))
        .orderBy(chatMessages.id);
      res.json(msgs);
    } catch (err) {
      res.status(500).json({ error: "Failed to load messages" });
    }
  });

  app.post("/api/chatbot/conversations/:id/messages", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    const { content, scope = "my_team", pageContext } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: "Message content required" });

    const conversationId = parseInt(req.params.id as string);
    try {
      const [conv] = await db.select().from(chatConversations).where(eq(chatConversations.id, conversationId));
      if (!conv || conv.userId !== req.session.userId) return res.status(404).json({ error: "Conversation not found" });

      await db.insert(chatMessages).values({
        conversationId,
        role: "user",
        content: content.trim(),
        createdAt: new Date().toISOString(),
      });

      const [user] = await db.select().from(users).where(eq(users.id, req.session.userId));
      if (!user) return res.status(401).json({ error: "User not found" });

      const history = await db.select().from(chatMessages)
        .where(eq(chatMessages.conversationId, conversationId))
        .orderBy(chatMessages.id)
        .limit(30);

      // SECURITY: client-supplied `scope` must NEVER let a non-manager pull
      // org-wide rollups. Several manager-only tools (team_touchpoint_tally,
      // reps_missing_touchpoints, …) historically also accepted scope==="everyone"
      // as a manager equivalence — so a sales rep posting `{scope:"everyone"}`
      // would have bypassed the gate. Clamp here at the channel boundary:
      //   - admin / director  → always "everyone" (preserves prior behaviour)
      //   - sales_director    → may opt in via scope=everyone
      //   - everyone else     → forced to "my_team", regardless of body
      let effectiveScope: "my_team" | "everyone";
      if (user.role === "admin" || user.role === "director") {
        effectiveScope = "everyone";
      } else if (user.role === "sales_director" && scope === "everyone") {
        effectiveScope = "everyone";
      } else {
        effectiveScope = "my_team";
      }

      // ─── DNA Logistics Bot agent core (Task #282 Phase 1) ──────────────
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const { runAgentTurn } = await import("./agent/core");
      const { hasModuleAccess } = await import("./agent/permissions");
      const { tryRoute, buildPageContextBlock } = await import("./agent/router");
      const access = await hasModuleAccess(user);
      if (!access.allowed) {
        res.write(`data: ${JSON.stringify({ content: access.reason || "AI Agent module is not available." })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
        return;
      }
      const priorHistory = history
        .slice(0, -1) // exclude the user message we just inserted; agent passes it as `userMessage`
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const emit = (event: any) => { res.write(`data: ${JSON.stringify(event)}\n\n`); };
      const conversationRef = String(conversationId);

      // 1. Smart router — deterministic intents short-circuit the LLM.
      const routed = await tryRoute({
        rep: user,
        organizationId: req.session.organizationId!,
        conversationRef,
        message: content.trim(),
        pageContext,
        emit,
      });

      let assistantText = "";
      let hadError = false;
      let surfacedAction = false;
      let confidence: number | undefined;
      let route: string | undefined;

      if (routed.handled) {
        assistantText = routed.assistantText || "";
        surfacedAction = !!routed.surfacedAction;
      } else {
        // 2. Page-aware context block (also seeds the per-conversation memo).
        const pageContextBlock = await buildPageContextBlock(
          req.session.organizationId!,
          conversationRef,
          pageContext,
        );

        const result = await runAgentTurn({
          ctx: {
            rep: user,
            organizationId: req.session.organizationId!,
            channel: "in_app",
            conversationRef,
            scope: effectiveScope as "my_team" | "everyone",
          },
          history: priorHistory,
          userMessage: content.trim(),
          emit,
          pageContextBlock,
        });
        assistantText = result.assistantText;
        hadError = result.hadError;
        surfacedAction = result.surfacedAction;
        confidence = (result as any).confidence;
        route = (result as any).route;
      }

      // Only persist an assistant message if the turn produced something
      // meaningful. Skip on transport errors (no empty bubbles) but keep a
      // placeholder when the agent surfaced an action card without prose.
      const persisted = assistantText.trim() || (surfacedAction ? "(action proposed)" : "");
      let assistantMsgId: number | null = null;
      if (!hadError && persisted) {
        const [inserted] = await db.insert(chatMessages).values({
          conversationId,
          role: "assistant",
          content: persisted,
          createdAt: new Date().toISOString(),
        }).returning();
        assistantMsgId = inserted?.id ?? null;
        if (assistantMsgId) {
          // Back-fill the messageId on the most recent turn_complete row so
          // analytics / feedback can pivot from the chat bubble.
          try {
            const { agentActivity } = await import("@shared/schema");
            const recent = await db.select({ id: agentActivity.id })
              .from(agentActivity)
              .where(and(
                eq(agentActivity.conversationRef, String(conversationId)),
                eq(agentActivity.userId, user.id),
                eq(agentActivity.direction, "turn_complete"),
              ))
              .orderBy(desc(agentActivity.createdAt))
              .limit(1);
            if (recent[0]) {
              await db.update(agentActivity)
                .set({ messageId: assistantMsgId })
                .where(eq(agentActivity.id, recent[0].id));
            }
          } catch (e) { /* non-fatal */ }
        }
      }

      if (!hadError && history.length <= 1) {
        const shortTitle = content.trim().slice(0, 50);
        await db.update(chatConversations).set({ title: shortTitle }).where(eq(chatConversations.id, conversationId));
      }

      // Surface the assistant message id so the client can wire feedback.
      if (assistantMsgId) {
        res.write(`data: ${JSON.stringify({ messageId: assistantMsgId })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err: any) {
      console.error("Chatbot error:", err);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: "Something went wrong. Please try again." })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Failed to process message" });
      }
    }
  });

  app.post("/api/chatbot/suggest", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: "Suggestion content required" });

    try {
      const [submitter] = await db.select().from(users).where(eq(users.id, req.session.userId));
      if (!submitter) return res.status(401).json({ error: "User not found" });

      const [suggestion] = await db.insert(appSuggestions).values({
        submittedById: req.session.userId,
        content: content.trim(),
        status: "new",
      }).returning();

      // Determine type label from content prefix
      const trimmed = content.trim();
      const firstLine = trimmed.split("\n")[0].toUpperCase();
      const isBug = firstLine.includes("BUG");
      const isImprovement = firstLine.includes("IMPROVEMENT");
      const typeLabel = isBug ? "Bug Report" : isImprovement ? "Improvement Request" : "Feature Request";
      const typeEmoji = isBug ? "🐛" : isImprovement ? "🔧" : "✨";
      const taskTitle = `${typeEmoji} ${typeLabel} from ${submitter.name}`;
      const bodyPreview = trimmed; // store full content so admin can read the whole request
      const now = new Date().toISOString();

      const allAdmins = await db.select().from(users).where(eq(users.role, "admin"));
      const admins = allAdmins.filter((a) => a.username !== "jordan.baumgart@valuetruck.com");
      const feedbackType: "bug" | "improvement" | "feature" = isBug ? "bug" : isImprovement ? "improvement" : "feature";
      const portalUrl = process.env.APP_URL || "https://sales-org-builder.replit.app";

      for (const admin of admins) {
        await db.insert(notifications).values({
          userId: admin.id,
          type: "app_suggestion",
          title: taskTitle,
          body: bodyPreview,
          link: "/feedback-inbox",
          read: false,
          relatedId: suggestion.id,
        });

        await db.insert(tasks).values({
          title: taskTitle,
          notes: trimmed,
          status: "open",
          assignedTo: admin.id,
          assignedBy: req.session.userId,
          createdAt: now,
        });

        // Send branded email notification to admin (ValueTruck + freight-dna)
        if (admin.username) {
          const html = buildFeedbackEmail({
            submitterName: submitter.name,
            submitterEmail: submitter.username,
            type: feedbackType,
            content: trimmed,
            portalUrl,
          });
          const subject = `[Freight DNA] ${taskTitle}`;
          sendEmail({ to: admin.username, subject, html })
            .catch((e) => console.error("Feedback email error:", e));
          sendEmail({ to: "info@freight-dna.com", subject, html })
            .catch((e) => console.error("Feedback email (freight-dna) error:", e));
        }
      }

      res.json({ ok: true, suggestionId: suggestion.id });
    } catch (err) {
      console.error("Suggestion error:", err);
      res.status(500).json({ error: "Failed to submit suggestion" });
    }
  });

  app.get("/api/chatbot/suggestions", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const [currentUser] = await db.select().from(users).where(eq(users.id, req.session.userId));
      if (!currentUser || !["admin", "director"].includes(currentUser.role)) return res.status(403).json({ error: "Admins only" });

      const results = await db
        .select({
          id: appSuggestions.id,
          content: appSuggestions.content,
          status: appSuggestions.status,
          createdAt: appSuggestions.createdAt,
          submitterName: users.name,
          submitterRole: users.role,
          submittedById: appSuggestions.submittedById,
          submitterEmail: users.username,
          adminResponse: appSuggestions.adminResponse,
          respondedAt: appSuggestions.respondedAt,
        })
        .from(appSuggestions)
        .innerJoin(users, eq(users.id, appSuggestions.submittedById))
        .orderBy(desc(appSuggestions.createdAt))
        .limit(200);

      res.json(results);
    } catch (err) {
      res.status(500).json({ error: "Failed to load suggestions" });
    }
  });

  app.patch("/api/chatbot/suggestions/:id", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const [currentUser] = await db.select().from(users).where(eq(users.id, req.session.userId));
      if (!currentUser || !["admin", "director"].includes(currentUser.role)) return res.status(403).json({ error: "Admins only" });
      const { status, adminResponse } = req.body;
      if (status && !["new", "reviewing", "resolved"].includes(status)) return res.status(400).json({ error: "Invalid status" });

      // Fetch current suggestion to detect if response is being newly added
      const suggId = req.params.id as string;
      const [existing] = await db.select().from(appSuggestions).where(eq(appSuggestions.id, suggId));
      if (!existing) return res.status(404).json({ error: "Not found" });

      // Build update: status and/or adminResponse
      const statusVal: string | undefined = status;
      const responseVal: string | undefined = adminResponse;
      if (statusVal && responseVal !== undefined) {
        await db.update(appSuggestions).set({ status: statusVal, adminResponse: responseVal, respondedAt: new Date() }).where(eq(appSuggestions.id, suggId));
      } else if (statusVal) {
        await db.update(appSuggestions).set({ status: statusVal }).where(eq(appSuggestions.id, suggId));
      } else if (responseVal !== undefined) {
        await db.update(appSuggestions).set({ adminResponse: responseVal, respondedAt: new Date() }).where(eq(appSuggestions.id, suggId));
      }

      // If a new response was added, email the submitter (username is the email)
      if (adminResponse && adminResponse.trim() && !existing.adminResponse) {
        const [submitter] = await db.select().from(users).where(eq(users.id, existing.submittedById));
        const submitterEmail = submitter?.username;
        if (submitterEmail?.includes("@")) {
          try {
            const { sendEmail } = await import("./emailService");
            await sendEmail({
              to: submitterEmail,
              subject: "Response to your Freight DNA feedback",
              html: `<p>Hi ${submitter?.name ?? submitterEmail},</p>
<p>An admin has responded to your feedback:</p>
<blockquote style="border-left:3px solid #d97706;padding:8px 16px;margin:12px 0;color:#555;">${existing.content}</blockquote>
<p><strong>Admin response:</strong></p>
<blockquote style="border-left:3px solid #2563eb;padding:8px 16px;margin:12px 0;color:#555;">${adminResponse}</blockquote>
<p>Log in to Freight DNA to view the full thread.</p>`,
            });
          } catch (_) { /* email failure is non-fatal */ }
        }
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("Error updating suggestion:", err);
      res.status(500).json({ error: "Failed to update suggestion" });
    }
  });

  app.post("/api/analyze/stream", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });

    const { contextType, contextData, messages: history = [], question } = req.body as {
      contextType: "rfp" | "financial" | "historical";
      contextData: string;
      messages: { role: "user" | "assistant"; content: string }[];
      question: string;
    };

    if (!question?.trim()) return res.status(400).json({ error: "Question required" });

    const ANALYST_RULES = `
## How to analyze this data

You are a senior spreadsheet analyst. Apply these rules to every question:

**Inspection rules**
- Work through the data sheet by sheet (or section by section when the context groups data that way).
- Treat text values as exact strings. Do not normalize unless the user explicitly asks.
- When grouping names, categories, or labels, first normalize them yourself: trim whitespace, standardize case, and identify obvious variants (e.g. "Spot" vs "spot" vs "SPOT" are the same). Explain the normalization you applied before presenting the rollup.
- Analyze records individually before aggregating them.
- If a column contains mixed formats, detect each format separately and report them.
- Do not guess. If the data is ambiguous, show the competing interpretations side by side.
- If the dataset is large, tell the user which rows, sheets, or ranges you examined in this pass.

**Required output structure**
Always reason through these steps in order — do not skip to a final answer first:

Step 1 — Data structure map: what columns/fields are present, their types, and any irregularities.
Step 2 — Data quality issues: nulls, duplicates, mixed formats, encoding problems, outliers.
Step 3 — Row-level observations: what you see at the individual record level before any grouping.
Step 4 — Pattern detection after normalization: rollups, trends, rankings — computed after applying the normalization described above.
Step 5 — Exceptions and edge cases: rows that do not fit the dominant pattern; anomalies worth flagging.
Step 6 — Final answer with evidence: your direct answer to the user's question, citing specific rows, columns, or computed values from the steps above.

Do not produce a single polished summary first. Show your intermediate reasoning so the user can verify each step.`;

    const systemPrompts: Record<string, string> = {
      rfp: `You are a freight brokerage sales analyst specializing in RFP analysis. You have deep expertise in transportation lanes, freight volumes, equipment types, and carrier networks. Your job is to analyze RFP data and help the sales team identify opportunities, prioritize lanes, and develop winning strategies.

The context includes the RFP metadata, high-volume lanes, a column listing from the actual RFP spreadsheet, top lanes by volume, and a RAW RFP DATA SAMPLE section with up to 150 actual rows in pipe-delimited format. Use the raw rows to answer questions about specific lanes, equipment types, or column values not captured in the summary.

Be specific and actionable. Reference actual lane data, volumes, origin/destination states, and column values from the context. When you identify an opportunity or recommendation, make it concrete enough that it could become a task.
${ANALYST_RULES}`,

      financial: `You are a freight brokerage financial analyst with direct access to the full spreadsheet data. You have deep expertise in load data, revenue trends, rep performance, lane economics, and customer analysis.

The context includes:
(1) Column names from the actual uploaded spreadsheet
(2) Unique values for categorical columns (Order Type, Tender Method, etc.)
(3) MONTHLY BREAKDOWN sections — one per detected date column — computed from EVERY row in the file. Each month shows total loads, revenue, and breakdowns by order type (e.g. Spot, Contract) and by rep. USE THESE SECTIONS to answer any question involving a specific month, date range, or order type filter. These are exact counts, not estimates.
(4) Aggregated summaries (top reps/customers/lanes, computed from all rows)
(5) A RAW DATA SAMPLE (up to 3,000 rows) for record-level lookups

When asked about a specific month (e.g. "how many spot loads in March"), look in the MONTHLY BREAKDOWN section for that month and read the "Order Types" line. Give the exact number. Never say you can't filter by date — the monthly breakdowns provide this data for every month in the dataset.
${ANALYST_RULES}`,

      historical: `You are a freight network analyst specializing in historical delivery pattern analysis for transportation brokers. You have deep expertise in lane density, delivery zone mapping, hub analysis, and identifying freight opportunities from historical data.

The context includes: (1) ALL unique delivery destinations (up to 200) with total loads, average weekly frequency, and peak weekly loads — hot zones are marked 🔥, and (2) CITY-TO-CITY LANE CORRIDORS (up to 200 top corridors) showing every origin → destination pair and how many loads moved on that lane. Use both sections to answer questions about specific lanes, cities, states, or shipping patterns.

Be specific and insight-driven. Reference actual cities, states, corridors, and load counts from the context. Identify patterns, hot zones, and underserved lanes. When you find an opportunity, make it actionable.
${ANALYST_RULES}`,
    };

    const systemPrompt = systemPrompts[contextType] || systemPrompts.rfp;

    const chatMessages: { role: "user" | "assistant"; content: string }[] = [
      ...history,
      { role: "user", content: question.trim() },
    ];

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: `${systemPrompt}\n\n=== DATA CONTEXT ===\n${contextData}`,
        messages: chatMessages,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          const content = event.delta.text;
          if (content) {
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err) {
      console.error("Analyze stream error:", err);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: "Analysis failed. Please try again." })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Failed to analyze data" });
      }
    }
  });

  app.post("/api/ai/talking-points", async (req: Request, res: Response) => {
    try {
      const { company, contacts: contactList, touchpoints: tps, tasks: tsks, rfps: rfpList, financialSummary, accountIntelligence, lanePairs } = req.body;
      if (!company) return res.status(400).json({ error: "Company data required" });

      const lastTouches = (contactList || []).slice(0, 6).map((c: any) => {
        const last = (tps || []).filter((t: any) => t.contactId === c.id).sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
        return `${c.name}${c.title ? ` (${c.title})` : ""}: last touch ${last ? `${last.type} on ${last.date}` : "never"}`;
      }).join("\n");

      const openRfps = (rfpList || []).filter((r: any) => r.status === "open" || r.status === "pending");
      const overdueTasks = (tsks || []).filter((t: any) => t.status === "open" && t.dueDate && new Date(t.dueDate) < new Date());

      const rfpsWithDeadlines = (rfpList || []).map((r: any) => {
        const daysLeft = r.dueDate ? Math.ceil((new Date(r.dueDate).getTime() - Date.now()) / 86400000) : null;
        return { ...r, daysLeft };
      });
      const urgentRfps = rfpsWithDeadlines.filter((r: any) => r.daysLeft !== null && r.daysLeft <= 14 && r.daysLeft >= 0);
      const openTasksList = (tsks || []).filter((t: any) => t.status === "open");

      // Resolve lane pairs: client may supply them, or we derive from server-side lane data.
      let resolvedLanePairs: Array<{ origin: string; destination: string }> = [];
      if (Array.isArray(lanePairs) && lanePairs.length > 0) {
        resolvedLanePairs = lanePairs.slice(0, 5);
      } else if (company.id) {
        // Fall back: resolve top corridors server-side from recurring lane data
        try {
          const companyLanes = await storage.getRecurringLanesByCompany(company.id);
          resolvedLanePairs = companyLanes
            .filter((l: any) => l.origin && l.destination)
            .sort((a: any, b: any) => (Number(b.weeklyFrequency ?? 0) - Number(a.weeklyFrequency ?? 0)))
            .slice(0, 5)
            .map((l: any) => ({ origin: l.origin as string, destination: l.destination as string }));
        } catch { /* non-fatal */ }
      }

      // Fetch Sonar market context in parallel
      let marketContext = "";
      try {
        const [pulse, laneVotris] = await Promise.all([
          getNationalMarketSummary(),
          resolvedLanePairs.length > 0
            ? getLaneVotrisBatch(resolvedLanePairs)
            : Promise.resolve(new Map()),
        ]);
        if (pulse.otri !== null) {
          const marketSignal = pulse.otri > 20 ? "tight (carriers rejecting frequently)"
            : pulse.otri > 8 ? "moderate"
            : "loose (capacity abundant)";
          marketContext = `\nCurrent market: National OTRI ${pulse.otri.toFixed(1)}% — market is ${marketSignal}.${pulse.isStale ? " (data may be slightly delayed)" : ""}`;
        } else {
          marketContext = `\nCurrent market: National OTRI data unavailable${pulse.lastSuccessfulPull ? ` — last updated ${pulse.lastSuccessfulPull}` : ""}.`;
        }
        if (laneVotris.size > 0) {
          const laneSignals = Array.from(laneVotris.values()).slice(0, 3).map(v => {
            const sigLabel = v.signal === "hot" ? "🔴 Hot" : v.signal === "warm" ? "🟡 Warm" : v.signal === "cool" ? "🟢 Cool" : "⚪ No signal";
            if (v.votri !== null) {
              const wowStr = v.votriWoW !== null ? ` (${v.votriWoW > 0 ? "+" : ""}${v.votriWoW.toFixed(1)} pp WoW)` : "";
              return `${v.origin}→${v.destination}: VOTRI ${v.votri.toFixed(1)}% ${sigLabel}${wowStr}`;
            }
            return `${v.origin}→${v.destination}: VOTRI unavailable`;
          }).join("; ");
          marketContext += `\nLane signals: ${laneSignals}`;
        }
      } catch { /* non-fatal */ }

      const prompt = `You are a freight broker sales coach. Help prep for a call with ${company.name}${company.industry ? ` (${company.industry})` : ""}.

${(req.body.accountSummary) ? `Current account status: ${req.body.accountSummary}\n` : ""}Key contacts:\n${lastTouches || "None on file"}
${financialSummary ? `\nFinancials YTD: ${financialSummary.ytdLoads ?? "?"} loads, $${Number(financialSummary.ytdMargin ?? 0).toLocaleString()} margin` : ""}
${urgentRfps.length > 0 ? `\nURGENT — RFPs due soon: ${urgentRfps.map((r: any) => `${r.title} (${r.daysLeft}d)`).join(", ")}` : openRfps.length > 0 ? `\nOpen RFPs: ${openRfps.map((r: any) => r.title).join(", ")}` : ""}
${overdueTasks.length > 0 ? `\nOverdue tasks: ${overdueTasks.map((t: any) => t.title).join(", ")}` : openTasksList.length > 0 ? `\nOpen tasks: ${openTasksList.slice(0, 3).map((t: any) => t.title).join(", ")}` : ""}
${accountIntelligence?.quirks ? `\nAccount quirks: ${accountIntelligence.quirks}` : ""}
${accountIntelligence?.spotProcess ? `\nSpot process: ${accountIntelligence.spotProcess}` : ""}
${accountIntelligence?.tenderStyle ? `\nTender style: ${accountIntelligence.tenderStyle}` : ""}${marketContext}

Generate exactly 3 sharp, specific talking points for this call. Each is 1-2 sentences. Be direct and actionable — reference the specific account details above. When market data is available and relevant, use it to make a talking point specific to current conditions. No generic freight advice. Numbered list.`;

      const message = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });

      const text = message.content[0].type === "text" ? message.content[0].text : "";
      const lines = text.split(/\n/).map((l: string) => l.trim()).filter(Boolean);
      const points = lines.filter((l: string) => l.match(/^\d[\.\)]/)).map((l: string) => l.replace(/^\d[\.\)]\s*/, ""));
      res.json({ points: points.length >= 2 ? points.slice(0, 3) : lines.slice(0, 3) });
    } catch (err: any) {
      console.error("Talking points error:", err);
      res.status(500).json({ error: "Failed to generate talking points" });
    }
  });
}
