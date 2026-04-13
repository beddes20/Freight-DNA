import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { sendEmail, buildFeedbackEmail } from "./emailService";
import { getNationalMarketSummary, getMarketOtris, getLaneVotrisBatch, buildVotriQualifier } from "./sonarClient";
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

async function runCarrierLaneSearch(
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

async function getCompanyDetails(orgId: string, companyName: string): Promise<string> {
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
      const msgs = await db.select().from(chatMessages)
        .where(eq(chatMessages.conversationId, parseInt(req.params.id as string)))
        .orderBy(chatMessages.id);
      res.json(msgs);
    } catch (err) {
      res.status(500).json({ error: "Failed to load messages" });
    }
  });

  app.post("/api/chatbot/conversations/:id/messages", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    const { content, scope = "my_team" } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: "Message content required" });

    const conversationId = parseInt(req.params.id as string);
    try {
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

      const effectiveScope = (user.role === "admin" || user.role === "director") ? "everyone" : scope;
      const crmContext = await buildCrmContext(user.id, user.role, effectiveScope);

      const scopeLabel = effectiveScope === "everyone" ? "the entire organization (all reps and teams)" : "the current user's team only";

      const systemPrompt = `You are DNA Guru, an AI assistant built into the OrgChart CRM for Value Truck transportation brokerage. You have access to live CRM data.

Current user: ${user.name} (${user.role.replace(/_/g, " ")})
Data scope: ${scopeLabel}

Here is the current CRM data:
${crmContext}

Keep it short and casual — reps are busy. No fluff, no filler.
- Use the data above to answer questions about accounts, contacts, RFPs, touchpoints, tasks, and goals
- For ranking questions use the TEAM MEMBERS section for per-rep stats
- Bullet points for lists, plain sentences otherwise
- If data isn't there, just say so
- Talk like a sharp colleague, not a corporate assistant
- When the user asks for details, full info, or wants to know everything about a SPECIFIC account — use the get_company_details tool
- When the user says "open", "navigate to", "pull up", "go to", or "show me" a specific account page — use the navigate_to_company tool
- When the user says they want to LOG A CALL, LOG AN EMAIL, LOG A TEXT, LOG A VISIT, or LOG A TOUCHPOINT — use the log_touchpoint tool
- When the user says they want to CREATE A TASK, SET A REMINDER, or ADD A TO-DO — use the create_task tool
- When the user says they want to MARK A TASK DONE, COMPLETE A TASK, or CHECK OFF a to-do — use the complete_task tool
- When the user says a conversation WAS MEANINGFUL, or wants to MARK A TOUCHPOINT MEANINGFUL — use the mark_meaningful tool
- When the user asks about CARRIERS on a lane, who runs a corridor, carrier pay rates, what we're paying for a mode on a lane (e.g. "what carriers run TX-CA?", "how much are we paying for dry vans CA-TX?") — use the carrier_lane_search tool
- When the user asks about MARKET CONDITIONS, current spot rates, OTRI, tender rejections, market tightness, how hot/cool a lane is, or Sonar data — use the query_market_otri or query_national_rates tools
- When the user asks about a SPECIFIC LANE's market signal, rejection index, or how tight that corridor is — use the query_lane_votri tool with origin and destination
- When the user asks about NATIONAL rates, NTI spot $/move, contract $/mile, or the spread between spot and contract — use the query_national_rates tool
- PROACTIVELY use Sonar market tools when the user asks about specific accounts' lanes, procurement strategy, buy rates on a corridor, or what action to take on a lane — don't wait for them to explicitly ask about "the market"
- Example: if someone asks "what should I do for [Company] on the CHI-ATL lane?", query_lane_votri for Chicago→Atlanta and weave the signal into your advice`;

      const tools: any[] = [
        {
          type: "function",
          function: {
            name: "get_company_details",
            description: "Pull the full account profile for a specific company: all contacts with relationship levels, recent touchpoints with notes, open RFPs, account summary, quirks, tendering style, and rep assignment. Use when the user asks for details or full info about a specific account.",
            parameters: {
              type: "object",
              properties: {
                company_name: { type: "string", description: "Name of the company to look up (partial match is fine)" },
              },
              required: ["company_name"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "navigate_to_company",
            description: "Navigate the user directly to a company's account page in the CRM. Use when the user says 'open', 'go to', 'pull up', 'navigate to', or 'show me the account page for' a specific company.",
            parameters: {
              type: "object",
              properties: {
                company_name: { type: "string", description: "Name of the company to navigate to" },
              },
              required: ["company_name"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "complete_task",
            description: "Mark an open task as complete/done. Use when the user says they want to mark a task done, complete a task, check off a to-do, or close out a task.",
            parameters: {
              type: "object",
              properties: {
                task_name: { type: "string", description: "Title or partial name of the task to mark complete" },
              },
              required: ["task_name"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "mark_meaningful",
            description: "Mark the user's most recent touchpoint at a company as meaningful. Use when the user says a call/conversation was meaningful, productive, or they want to flag it as meaningful.",
            parameters: {
              type: "object",
              properties: {
                company_name: { type: "string", description: "Name of the company where the touchpoint occurred" },
                contact_name: { type: "string", description: "Name of the contact involved (optional)" },
              },
              required: ["company_name"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "log_touchpoint",
            description: "Log a touchpoint/interaction (call, email, text, or site visit) with a contact. Use this when the user wants to log or record a call, email, text, or meeting.",
            parameters: {
              type: "object",
              properties: {
                company_name: { type: "string", description: "Name of the company/account (as it appears in the CRM)" },
                contact_name: { type: "string", description: "Name of the contact person (leave empty if not specified)" },
                type: { type: "string", enum: ["call", "email", "text", "site_visit"], description: "Type of interaction" },
                note: { type: "string", description: "Brief note about what was discussed or the outcome" },
              },
              required: ["type"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "create_task",
            description: "Create a new task or reminder. Use this when the user wants to set a reminder, create a to-do, or follow up on something.",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string", description: "Clear, actionable task title" },
                due_date: { type: "string", description: "Due date in YYYY-MM-DD format (optional, omit if not mentioned)" },
              },
              required: ["title"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "carrier_lane_search",
            description: "Search financial upload data to find which carriers run on a specific lane/corridor and what we're paying them. Use when the user asks about carriers on a lane, carrier pay rates, who runs TX-CA, what we're paying for dry vans on a corridor, etc.",
            parameters: {
              type: "object",
              properties: {
                origin: { type: "string", description: "Origin location: city+state ('Chicago, IL'), state abbreviation ('TX'), or city name. Leave empty to search any origin." },
                destination: { type: "string", description: "Destination location: city+state, state abbreviation, or city name. Leave empty to search any destination." },
                radius_miles: { type: "number", description: "Radius in miles around the origin/destination to include nearby lanes (default 75)." },
                mode: { type: "string", description: "Equipment/mode filter: Van, Reefer, Flatbed, LTL, Drayage, or IMDL. Leave empty for all modes." },
                min_loads_per_month: { type: "number", description: "Minimum average loads per month for a corridor to be included (default 3)." },
              },
              required: [],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "query_national_rates",
            description: "Fetch live national market data from FreightWaves Sonar: national OTRI (%), national spot $/move (NTI), contract $/mile (VCRPM1), and the RATES spread between spot and contract. Use when the user asks about overall market conditions, national OTRI, current spot rates, or the spread between spot and contract rates.",
            parameters: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "query_lane_votri",
            description: "Fetch live Sonar VOTRI (Van Outbound Tender Rejection Index) for a specific lane/corridor. Returns the rejection rate (%) and week-over-week delta. Use when the user asks how tight a specific lane is, the market signal for a corridor, VOTRI for a specific origin-destination pair, or what to target buying on a lane.",
            parameters: {
              type: "object",
              properties: {
                origin: { type: "string", description: "Origin city or market (e.g. 'Atlanta', 'Chicago', 'Dallas')" },
                destination: { type: "string", description: "Destination city or market (e.g. 'Dallas', 'Los Angeles', 'Memphis')" },
              },
              required: ["origin", "destination"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "query_market_otri",
            description: "Fetch live OTRI (Outbound Tender Rejection Index), VOTRI (Van Tender Rejection Index), and week-over-week trend for a specific market/city from FreightWaves Sonar. Use when the user asks about a specific market's tightness, rejection rate, OTRI, VOTRI, or trend direction. Examples: 'Is Chicago tight?', 'What's the OTRI in Atlanta?', 'How is the Dallas market moving?'",
            parameters: {
              type: "object",
              properties: {
                market: {
                  type: "string",
                  description: "City/market name to fetch OTRI and VOTRI for (e.g. 'Atlanta', 'Dallas', 'Chicago')",
                },
              },
              required: ["market"],
            },
          },
        },
      ];

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const chatHistory = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "system", content: systemPrompt }, ...chatHistory],
        tools,
        tool_choice: "auto",
        stream: true,
        max_tokens: 1200,
      });

      let fullResponse = "";
      let toolCallId   = "";
      let toolCallName = "";
      let toolCallArgs = "";

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;

        // Streaming text content
        if (delta?.content) {
          fullResponse += delta.content;
          res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
        }

        // Accumulate tool call data
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id)              toolCallId   += tc.id;
            if (tc.function?.name) toolCallName += tc.function.name;
            if (tc.function?.arguments) toolCallArgs += tc.function.arguments;
          }
        }

        // Tool call complete
        if (choice?.finish_reason === "tool_calls" && toolCallName) {
          try {
            const args = JSON.parse(toolCallArgs);

            // ── Data-retrieval tools execute server-side then feed result back to GPT ──
            const dataRetrievalTools = ["carrier_lane_search", "get_company_details", "query_national_rates", "query_lane_votri", "query_market_otri"];

            if (dataRetrievalTools.includes(toolCallName)) {
              let searchResult = "";
              let callLabel = "";

              if (toolCallName === "carrier_lane_search") {
                callLabel = "call_carrier";
                searchResult = await runCarrierLaneSearch(
                  req.session.organizationId!,
                  String(args.origin || ""),
                  String(args.destination || ""),
                  Number(args.radius_miles || 75),
                  String(args.mode || ""),
                  Number(args.min_loads_per_month || 3),
                );
              } else if (toolCallName === "get_company_details") {
                callLabel = "call_company";
                searchResult = await getCompanyDetails(req.session.organizationId!, String(args.company_name || ""));
              } else if (toolCallName === "query_national_rates") {
                callLabel = "call_sonar_pulse";
                try {
                  const pulse = await getNationalMarketSummary();
                  const signalLabel = pulse.otri > 20 ? "🔴 Hot" : pulse.otri > 8 ? "🟡 Warm" : "🟢 Cool";
                  searchResult = [
                    `FreightWaves Sonar — National Market Pulse (as of ${new Date(pulse.timestamp).toLocaleString()})${pulse.isStale ? " ⚠ Stale" : ""}`,
                    `National OTRI: ${pulse.otri.toFixed(2)}% (${pulse.otriWoWDelta > 0 ? "+" : ""}${pulse.otriWoWDelta.toFixed(1)} pp WoW) — ${signalLabel}`,
                    `NTI National Spot: $${pulse.ntiPerMove > 100 ? pulse.ntiPerMove.toLocaleString() : pulse.ntiPerMove.toFixed(2)}/move`,
                    `Contract Rate (VCRPM1): $${pulse.ntiPerMile.toFixed(2)}/mile`,
                    `Market Signal: ${pulse.otri > 20 ? "Tight — capacity scarce, rejection rates elevated. Good time to lock in contracts and position as reliable capacity source." : pulse.otri > 8 ? "Moderate — balanced market conditions." : "Loose — capacity abundant, good negotiating leverage on buy rates."}`,
                  ].join("\n");
                } catch {
                  searchResult = "Sonar market data temporarily unavailable.";
                }
              } else if (toolCallName === "query_lane_votri") {
                callLabel = "call_sonar_lane";
                try {
                  const origin = String(args.origin || "");
                  const destination = String(args.destination || "");
                  const votriMap = await getLaneVotrisBatch([{ origin, destination }]);
                  const qualifier = buildVotriQualifier(origin, destination);
                  const votri = votriMap.get(qualifier);
                  if (votri) {
                    const sig = votri.signal === "hot" ? "🔴 Hot" : votri.signal === "warm" ? "🟡 Warm" : "🟢 Cool";
                    searchResult = [
                      `Sonar VOTRI for ${origin} → ${destination} (qualifier: ${qualifier})${votri.isStale ? " ⚠ Stale" : ""}`,
                      `Van Tender Rejection Rate: ${votri.votri.toFixed(1)}% — ${sig}`,
                      `Week-over-Week: ${votri.votriWoW > 0 ? "+" : ""}${votri.votriWoW.toFixed(1)} pp`,
                      votri.signal === "hot"
                        ? "Market is tight on this lane — carriers rejecting frequently. Capacity is scarce, rates under upward pressure."
                        : votri.signal === "warm"
                        ? "Market is moderately active — some capacity pressure, normal booking lead times."
                        : "Market is loose — plenty of capacity available, good leverage for negotiating buy rates.",
                    ].join("\n");
                  } else {
                    searchResult = `No VOTRI data found for ${origin} → ${destination}. This qualifier (${qualifier}) may not have enough volume in Sonar.`;
                  }
                } catch {
                  searchResult = "Sonar lane signal data temporarily unavailable.";
                }
              } else if (toolCallName === "query_market_otri") {
                callLabel = "call_sonar_otris";
                try {
                  const market: string = typeof args.market === "string" ? args.market.trim() : "";
                  if (!market) {
                    searchResult = "No market specified.";
                  } else {
                    const otris = await getMarketOtris([market]);
                    const m = otris[0];
                    if (!m) {
                      searchResult = `No Sonar data found for "${market}".`;
                    } else {
                      const sig = m.signal === "hot" ? "🔴 Hot" : m.signal === "warm" ? "🟡 Warm" : "🟢 Cool";
                      const wowArrow = m.otriWoW > 0 ? "↑" : m.otriWoW < 0 ? "↓" : "→";
                      const lines = [
                        `Sonar market data for ${m.market}:`,
                        `  OTRI: ${m.otri.toFixed(1)}% — ${sig} (WoW: ${wowArrow}${Math.abs(m.otriWoW).toFixed(1)} pp)`,
                      ];
                      if (m.votri !== null) {
                        lines.push(`  VOTRI (Van Outbound Rejection): ${m.votri.toFixed(1)}%`);
                      }
                      searchResult = lines.join("\n");
                    }
                  }
                } catch {
                  searchResult = "Sonar market OTRI data temporarily unavailable.";
                }
              }

              const toolResultMessages: any[] = [
                { role: "system", content: systemPrompt },
                ...chatHistory,
                {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: toolCallId || callLabel,
                    type: "function",
                    function: { name: toolCallName, arguments: toolCallArgs },
                  }],
                },
                {
                  role: "tool",
                  tool_call_id: toolCallId || callLabel,
                  content: searchResult,
                },
              ];

              const stream2 = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: toolResultMessages,
                stream: true,
                max_tokens: 1500,
              });

              for await (const chunk2 of stream2) {
                const c2 = chunk2.choices[0]?.delta?.content;
                if (c2) {
                  fullResponse += c2;
                  res.write(`data: ${JSON.stringify({ content: c2 })}\n\n`);
                }
              }

            } else if (toolCallName === "navigate_to_company") {
              // ── Navigate: resolve company ID server-side, emit navigate event ──
              const orgId = req.session.organizationId!;
              const cn = (args.company_name || "").toLowerCase();
              const allOrgCompanies = await db.select({ id: companies.id, name: companies.name })
                .from(companies).where(eq(companies.organizationId, orgId));
              const matched = allOrgCompanies.find(c => c.name.toLowerCase().includes(cn))
                || allOrgCompanies.find(c => cn.includes(c.name.toLowerCase().slice(0, 5)));
              if (matched) {
                const msg = `Opening ${matched.name}...`;
                fullResponse += msg;
                res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
                res.write(`data: ${JSON.stringify({ navigate: `/companies/${matched.id}` })}\n\n`);
              } else {
                const msg = `I couldn't find "${args.company_name}" in your CRM.`;
                fullResponse += msg;
                res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
              }

            } else if (toolCallName === "complete_task") {
              // ── Complete task: resolve task by name, emit confirmation card ──
              const userId = req.session.userId!;
              const taskName = (args.task_name || "").toLowerCase();
              const openTasks = await db.select().from(tasks)
                .where(and(eq(tasks.assignedTo, userId), eq(tasks.status, "open")));
              const matched = openTasks.find(t =>
                t.title.toLowerCase().includes(taskName) || taskName.includes(t.title.toLowerCase())
              );
              if (matched) {
                const actionResponse = `Got it — ready to mark this task complete:`;
                fullResponse += actionResponse;
                res.write(`data: ${JSON.stringify({ content: actionResponse })}\n\n`);
                res.write(`data: ${JSON.stringify({ action: { tool: "complete_task", args: { task_id: matched.id, task_title: matched.title, due_date: matched.dueDate || "" } } })}\n\n`);
              } else {
                const msg = `I couldn't find an open task matching "${args.task_name}". Check your tasks page for the full list.`;
                fullResponse += msg;
                res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
              }

            } else if (toolCallName === "mark_meaningful") {
              // ── Mark meaningful: find most recent touchpoint by user at company ──
              const orgId = req.session.organizationId!;
              const userId = req.session.userId!;
              const cn = (args.company_name || "").toLowerCase();
              const allOrgCompanies = await db.select({ id: companies.id, name: companies.name })
                .from(companies).where(eq(companies.organizationId, orgId));
              const matchedCompany = allOrgCompanies.find(c => c.name.toLowerCase().includes(cn));
              if (!matchedCompany) {
                const msg = `I couldn't find "${args.company_name}" in your CRM.`;
                fullResponse += msg;
                res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
              } else {
                const recentTps = await db.select().from(touchpoints)
                  .where(and(eq(touchpoints.companyId, matchedCompany.id), eq(touchpoints.loggedById, userId)))
                  .orderBy(desc(touchpoints.createdAt))
                  .limit(5);
                if (recentTps.length === 0) {
                  const msg = `No touchpoints logged by you at ${matchedCompany.name} yet.`;
                  fullResponse += msg;
                  res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
                } else {
                  const tp = recentTps[0];
                  const actionResponse = `Here's your most recent touchpoint at ${matchedCompany.name}:`;
                  fullResponse += actionResponse;
                  res.write(`data: ${JSON.stringify({ content: actionResponse })}\n\n`);
                  res.write(`data: ${JSON.stringify({ action: { tool: "mark_meaningful", args: { touchpoint_id: tp.id, company_name: matchedCompany.name, type: tp.type, date: tp.date, note: tp.notes || "" } } })}\n\n`);
                }
              }

            } else {
              // ── Action tools (log_touchpoint, create_task): emit confirmation card ──
              const actionResponse = `I can do that for you. Here's what I'll log:`;
              fullResponse += actionResponse;
              res.write(`data: ${JSON.stringify({ content: actionResponse })}\n\n`);
              res.write(`data: ${JSON.stringify({ action: { tool: toolCallName, args } })}\n\n`);
            }

            toolCallId = "";
            toolCallName = "";
            toolCallArgs = "";
          } catch (parseErr) {
            console.error("Tool call parse error:", parseErr);
          }
        }
      }

      await db.insert(chatMessages).values({
        conversationId,
        role: "assistant",
        content: fullResponse || "(action proposed)",
        createdAt: new Date().toISOString(),
      });

      if (history.length <= 1) {
        const shortTitle = content.trim().slice(0, 50);
        await db.update(chatConversations).set({ title: shortTitle }).where(eq(chatConversations.id, conversationId));
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
        const marketSignal = pulse.otri > 20 ? "tight (carriers rejecting frequently)"
          : pulse.otri > 8 ? "moderate"
          : "loose (capacity abundant)";
        marketContext = `\nCurrent market: National OTRI ${pulse.otri.toFixed(1)}% — market is ${marketSignal}.${pulse.isStale ? " (data may be slightly delayed)" : ""}`;
        if (laneVotris.size > 0) {
          const laneSignals = Array.from(laneVotris.values()).slice(0, 3).map(v =>
            `${v.origin}→${v.destination}: VOTRI ${v.votri.toFixed(1)}% ${v.signal === "hot" ? "🔴 Hot" : v.signal === "warm" ? "🟡 Warm" : "🟢 Cool"} (${v.votriWoW > 0 ? "+" : ""}${v.votriWoW.toFixed(1)} pp WoW)`
          ).join("; ");
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
