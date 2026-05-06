/**
 * ValueIQ "Today" thread seed payload builder.
 *
 * Gathers four sections per rep — Overdue touchpoints, Quote SLAs at risk,
 * Hot lanes (TRAC), and Top NBA cards — and renders them as a single
 * markdown blob suitable for use as the opening assistant message of a
 * daily Today thread.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import {
  companies as companiesTable,
  touchpoints as touchpointsTable,
  rfps as rfpsTable,
  recurringLanes,
  laneCarrierInterest,
  nbaCards as nbaCardsTable,
  coachingNotes as coachingNotesTable,
  users as usersTable,
  type User,
} from "@shared/schema";

export interface TodaySeedPayload {
  date: string;            // YYYY-MM-DD
  title: string;           // "Today — YYYY-MM-DD"
  markdown: string;        // assistant message body
}

const COLD_DAYS = 30;

/**
 * Render YYYY-MM-DD for a given timezone using Intl. Avoids server-local
 * skew so a Today thread's identity matches the org's actual local date.
 */
export function localDateString(d: Date, timeZone = "America/Chicago"): string {
  // en-CA → "YYYY-MM-DD" by spec.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function daysAgo(dateStr: string): number {
  const t = new Date(dateStr.length === 10 ? dateStr + "T12:00:00" : dateStr);
  return Math.floor((Date.now() - t.getTime()) / 86_400_000);
}

export async function buildTodaySeed(user: User, now: Date = new Date(), timeZone = "America/Chicago"): Promise<TodaySeedPayload> {
  const date = localDateString(now, timeZone);
  const title = `Today — ${date}`;

  // ── Companies the rep owns (assignedTo OR salesPersonId)
  const myCompanies = await db
    .select()
    .from(companiesTable)
    .where(
      and(
        eq(companiesTable.organizationId, user.organizationId),
        isNull(companiesTable.archivedAt),
        or(eq(companiesTable.assignedTo, user.id), eq(companiesTable.salesPersonId, user.id)),
      ),
    );
  const myCompanyIds = myCompanies.map((c) => c.id);

  // ── Section 1: Overdue touchpoints (top 5 cold accounts)
  const overdueLines: string[] = [];
  let overdueOk = true;
  try {
  if (myCompanyIds.length > 0) {
    const recentTps = await db
      .select({
        companyId: touchpointsTable.companyId,
        date: touchpointsTable.date,
      })
      .from(touchpointsTable)
      .where(inArray(touchpointsTable.companyId, myCompanyIds));
    const lastTouchByCompany = new Map<string, string>();
    for (const tp of recentTps) {
      if (!tp.companyId || !tp.date) continue;
      const prev = lastTouchByCompany.get(tp.companyId);
      if (!prev || tp.date > prev) lastTouchByCompany.set(tp.companyId, tp.date);
    }
    const candidates = myCompanies
      .map((c) => {
        const last = lastTouchByCompany.get(c.id) ?? null;
        const days = last ? daysAgo(last) : 9999;
        return { c, last, days };
      })
      .filter((x) => x.days >= COLD_DAYS)
      .sort((a, b) => b.days - a.days)
      .slice(0, 5);
    for (const { c, last, days } of candidates) {
      const ago = last ? `${days}d ago` : "never";
      overdueLines.push(`- [${c.name}](/companies/${c.id}) — last touch ${ago}`);
    }
  }
  } catch (err) {
    console.warn("[today-seed] overdue lookup failed:", err);
    overdueOk = false;
  }

  // ── Section 2: Quote SLAs at risk (open RFPs due ≤ 2 days for my accounts)
  const slaLines: string[] = [];
  let slaOk = true;
  try {
  if (myCompanyIds.length > 0) {
    const todayStr = date;
    const horizon = new Date(now); horizon.setDate(horizon.getDate() + 2);
    const horizonStr = localDateString(horizon, timeZone);
    const myRfps = await db
      .select()
      .from(rfpsTable)
      .where(
        and(
          inArray(rfpsTable.companyId, myCompanyIds),
          inArray(rfpsTable.status, ["open", "pending"]),
        ),
      );
    const atRisk = myRfps
      .filter((r) => r.dueDate && r.dueDate <= horizonStr)
      .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""))
      .slice(0, 5);
    const companyMap = new Map(myCompanies.map((c) => [c.id, c]));
    for (const r of atRisk) {
      const c = companyMap.get(r.companyId);
      const due = r.dueDate || "TBD";
      const overdue = r.dueDate && r.dueDate < todayStr ? " ⚠️ overdue" : "";
      slaLines.push(`- [${r.title}](/companies/${r.companyId}) — ${c?.name ?? "Account"} • due ${due}${overdue}`);
    }
  }
  } catch (err) {
    console.warn("[today-seed] SLA lookup failed:", err);
    slaOk = false;
  }

  // ── Section 3: Hot lanes (TRAC) — recurring lanes with hot carrier replies
  const hotLaneLines: string[] = [];
  let hotLaneOk = true;
  try {
    const myLanes = await db
      .select()
      .from(recurringLanes)
      .where(
        and(
          eq(recurringLanes.orgId, user.organizationId),
          eq(recurringLanes.isEligible, true),
          isNull(recurringLanes.resolvedAt),
          or(eq(recurringLanes.ownerUserId, user.id), eq(recurringLanes.overseerUserId, user.id)),
        ),
      )
      .orderBy(desc(recurringLanes.laneScore))
      .limit(50);
    if (myLanes.length > 0) {
      const laneIds = myLanes.map((l) => l.id);
      const hotStatuses = ["available_now", "available_next_week"];
      const hotRows = await db
        .selectDistinct({ laneId: laneCarrierInterest.laneId })
        .from(laneCarrierInterest)
        .where(
          and(
            inArray(laneCarrierInterest.laneId, laneIds),
            inArray(laneCarrierInterest.interestStatus, hotStatuses),
          ),
        );
      const hotIds = new Set(hotRows.map((r) => r.laneId));
      const hotLanes = myLanes.filter((l) => hotIds.has(l.id)).slice(0, 5);
      for (const l of hotLanes) {
        const route = `${l.origin ?? "?"} → ${l.destination ?? "?"}`;
        hotLaneLines.push(`- [${route}](/lanes/work-queue) — ${l.equipmentType ?? "any"} • score ${l.laneScore ?? 0}`);
      }
    }
  } catch (err) {
    console.warn("[today-seed] hot lanes lookup failed:", err);
    hotLaneOk = false;
  }

  // ── Section 4: Top NBA cards (top 3 by urgency, only actionable)
  const nbaLines: string[] = [];
  let nbaOk = true;
  try {
    const allCards = await storage.getNbaCardsByUserId(user.id);
    const open = allCards
      .filter((c) => c.status === "generated" || c.status === "visible")
      .sort((a, b) => (b.urgencyScore ?? 0) - (a.urgencyScore ?? 0))
      .slice(0, 3);
    for (const card of open) {
      const link = card.companyId ? `/companies/${card.companyId}` : "/valueiq?tab=insights";
      const acct = card.companyName ?? "Account";
      nbaLines.push(`- [${acct}](${link}) — ${card.suggestedAction.slice(0, 140)} (urgency ${card.urgencyScore ?? 0})`);
    }
  } catch (err) {
    console.warn("[today-seed] NBA cards lookup failed:", err);
    nbaOk = false;
  }

  // ── Section 0 (prepended): Coaching notes from the rep's manager
  //
  // Surfaces any undelivered coaching notes authored since the last Today
  // seed. Once rendered, notes are stamped with `deliveredAt` so they only
  // appear in one Today thread — the next morning after the note was left.
  let coachingMarkdown = "";
  try {
    const undelivered = await db
      .select()
      .from(coachingNotesTable)
      .where(and(
        eq(coachingNotesTable.repId, user.id),
        eq(coachingNotesTable.orgId, user.organizationId),
        isNull(coachingNotesTable.deliveredAt),
      ))
      .orderBy(desc(coachingNotesTable.createdAt))
      .limit(10);
    if (undelivered.length > 0) {
      const managerIds = Array.from(new Set(undelivered.map(n => n.managerId)));
      const managerRows = await db
        .select()
        .from(usersTable)
        .where(inArray(usersTable.id, managerIds));
      const managerName = new Map(managerRows.map(m => [m.id, m.name || m.username] as const));
      const lines = undelivered.map(n => {
        const who = managerName.get(n.managerId) || "Your manager";
        const subject = n.subjectLabel ? ` on **${n.subjectLabel}**` : "";
        return `- **${who}**${subject}: ${n.body}`;
      });
      coachingMarkdown = ["", "### 🧭 Coaching notes from your manager", lines.join("\n")].join("\n");
      // Mark delivered so they don't repeat tomorrow.
      await db
        .update(coachingNotesTable)
        .set({ deliveredAt: new Date() })
        .where(inArray(coachingNotesTable.id, undelivered.map(n => n.id)));
    }
  } catch (err) {
    console.warn("[today-seed] coaching notes lookup failed:", err);
  }

  const sections = [
    section("Overdue touchpoints (top 5)", overdueLines, "All accounts are warm — nice.", overdueOk),
    section("Quote SLAs at risk", slaLines, "No RFP deadlines flagged in the next 48 hours.", slaOk),
    section("Hot lanes (TRAC)", hotLaneLines, "No hot lanes with carrier interest right now.", hotLaneOk),
    section("Top NBA cards", nbaLines, "No fresh next-best-action cards waiting.", nbaOk),
  ];

  const greeting = `Good morning${user.name ? `, ${user.name.split(" ")[0]}` : ""} — here's what to focus on for **${date}**.`;
  const markdown = [
    greeting,
    coachingMarkdown,
    "",
    ...sections,
    "",
    "Ask me to dig into any of these, draft outreach, or pull up the underlying data.",
  ].filter(Boolean).join("\n");

  return { date, title, markdown };
}

export function section(heading: string, lines: string[], emptyMsg: string, ok: boolean = true): string {
  // Three states the rep deserves to be able to tell apart:
  //   1. Data       → render the bullets.
  //   2. Empty-good → "_${emptyMsg}_" (a positive, "nothing to do" signal).
  //   3. Source down → an explicit "data unavailable" notice — never silently
  //                    pretend everything is calm when our query just failed.
  let body: string;
  if (lines.length > 0) {
    body = lines.join("\n");
  } else if (!ok) {
    body = "_⚠️ Source unavailable right now — try again shortly._";
  } else {
    body = `_${emptyMsg}_`;
  }
  return ["", `### ${heading}`, body].join("\n");
}
