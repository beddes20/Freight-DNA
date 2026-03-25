import cron from "node-cron";
import { storage } from "./storage";
import { sendEmail, baseEmailTemplate, emailEnabled } from "./emailService";

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [daily-digest] ${message}`);
}

function isWeekend(date: Date): boolean {
  const dow = date.getDay();
  return dow === 0 || dow === 6;
}

function daysSince(dateStr: string): number {
  const d = new Date(dateStr + (dateStr.length === 10 ? "T12:00:00" : ""));
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

const COLD_THRESHOLD_DAYS = 30;

async function generateAiPriority(repName: string, summaryLines: string[]): Promise<string> {
  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });
    const context = summaryLines.join("\n");
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: `You are a freight sales coach. Based on this rep's daily briefing for ${repName}, write ONE short, motivating, specific priority action sentence (max 20 words). Be concrete and direct.\n\nContext:\n${context}`,
      }],
      max_tokens: 60,
      temperature: 0.5,
    });
    return resp.choices[0]?.message?.content?.trim() || "";
  } catch {
    return "";
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function sendDailyDigests(): Promise<void> {
  const today = new Date();
  if (isWeekend(today)) {
    logMessage("Skipping daily digest on weekend.");
    return;
  }

  logMessage("Running daily digest...");

  const defaultOrg = await storage.getDefaultOrganization();
  if (!defaultOrg) { logMessage("No default organization found, skipping."); return; }

  const allUsers = await storage.getUsers(defaultOrg.id);
  const allTasks = await storage.getTasks();
  const allContacts = await storage.getContacts();
  const allTouchpoints = await storage.getTouchpoints ? await storage.getTouchpoints() : [];
  const allCompanies = await storage.getCompanies(defaultOrg.id);
  const allRfps = await storage.getRfps();
  const uploads = await storage.getFinancialUploadsForOrg(defaultOrg.id);
  const companyMap = Object.fromEntries(allCompanies.map((c: any) => [c.id, c]));
  const todayStr = today.toISOString().split("T")[0];

  // Precompute RFP deadlines within 14 days
  const rfpDeadlines = allRfps.filter((r: any) => {
    if (r.status !== "open" && r.status !== "pending") return false;
    if (!r.dueDate) return false;
    const d = daysSince(r.dueDate);
    return d >= -14 && d <= 0;
  }).sort((a: any, b: any) => a.dueDate.localeCompare(b.dueDate));

  // Precompute current month and prior month financial data per company
  const now = today;
  const curMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prevDate = new Date(now); prevDate.setMonth(prevDate.getMonth() - 1);
  const prevMonthStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;

  const reps = allUsers.filter((u: any) => ["account_manager", "national_account_manager", "sales"].includes(u.role));
  let digestsSent = 0;

  for (const user of reps) {
    const myTasks = allTasks.filter((t: any) => t.assignedTo === user.id && t.status !== "completed");
    const overdueTasks = myTasks.filter((t: any) => t.dueDate && t.dueDate < todayStr);

    const myCompanies = allCompanies.filter((c: any) => c.assignedTo === user.id && !c.archivedAt);
    const myCompanyIds = myCompanies.map((c: any) => c.id);
    const myContacts = allContacts.filter((c: any) => myCompanyIds.includes(c.companyId));

    // Cold contacts (no touch in 30+ days)
    const coldContacts: typeof allContacts = [];
    for (const contact of myContacts) {
      const contactTouchpoints = allTouchpoints.filter((tp: any) => tp.contactId === contact.id);
      if (contactTouchpoints.length === 0) {
        coldContacts.push(contact);
      } else {
        const latestDate = contactTouchpoints.map((tp: any) => tp.date).sort().reverse()[0];
        if (daysSince(latestDate) >= COLD_THRESHOLD_DAYS) {
          coldContacts.push(contact);
        }
      }
    }

    // My RFP deadlines
    const myRfpDeadlines = rfpDeadlines.filter((r: any) => r.companyId && myCompanyIds.includes(r.companyId));

    // Stale companies (no touchpoint logged in 21+ days)
    const STALE_COMPANY_DAYS = 21;
    const staleCompanies: typeof myCompanies = [];
    for (const company of myCompanies) {
      const companyTouchpoints = allTouchpoints.filter((tp: any) => tp.companyId === company.id);
      if (companyTouchpoints.length === 0) {
        staleCompanies.push(company);
      } else {
        const latestDate = companyTouchpoints.map((tp: any) => tp.date).sort().reverse()[0];
        if (daysSince(latestDate) >= STALE_COMPANY_DAYS) {
          staleCompanies.push(company);
        }
      }
    }

    // Churn risk: companies with >20% load drop vs last month (min 5 prior loads)
    const churnRiskCompanies: Array<{ company: any; curLoads: number; prevLoads: number; pct: number }> = [];
    for (const company of myCompanies) {
      const aliases = [company.name, ...(company.financialAlias ? company.financialAlias.split(",").map((a: string) => a.trim()) : [])];
      const normAliases = aliases.map(normalize);

      let curLoads = 0;
      let prevLoads = 0;

      for (const upload of uploads) {
        const rows = (upload.rows as any[]) || [];
        for (const row of rows) {
          const custNorm = normalize(String(row.customerName || ""));
          if (!normAliases.includes(custNorm)) continue;
          const month = String(row.month || "").slice(0, 7);
          if (month === curMonthStr) curLoads += Number(row.totalLoads || 0);
          if (month === prevMonthStr) prevLoads += Number(row.totalLoads || 0);
        }
      }

      if (prevLoads >= 5 && curLoads < prevLoads * 0.8) {
        const pct = Math.round(((prevLoads - curLoads) / prevLoads) * 100);
        churnRiskCompanies.push({ company, curLoads, prevLoads, pct });
      }
    }
    churnRiskCompanies.sort((a, b) => b.pct - a.pct);

    const hasAlert = overdueTasks.length > 0 || coldContacts.length > 0 || myRfpDeadlines.length > 0 || churnRiskCompanies.length > 0 || staleCompanies.length > 0;

    if (!hasAlert) continue;

    const notifParts: string[] = [];
    if (overdueTasks.length > 0) notifParts.push(`${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}`);
    if (staleCompanies.length > 0) notifParts.push(`${staleCompanies.length} untouched account${staleCompanies.length > 1 ? "s" : ""}`);
    if (coldContacts.length > 0) notifParts.push(`${coldContacts.length} cold contact${coldContacts.length > 1 ? "s" : ""}`);
    if (myRfpDeadlines.length > 0) notifParts.push(`${myRfpDeadlines.length} RFP deadline${myRfpDeadlines.length > 1 ? "s" : ""}`);
    if (churnRiskCompanies.length > 0) notifParts.push(`${churnRiskCompanies.length} volume drop${churnRiskCompanies.length > 1 ? "s" : ""}`);

    const notifTitle = `Daily brief: ${notifParts.join(", ")}`;
    const notifBody = churnRiskCompanies.length > 0
      ? `${churnRiskCompanies[0].company.name} is down ${churnRiskCompanies[0].pct}% in loads — check in today.`
      : staleCompanies.length > 0
        ? `You haven't logged a touchpoint for ${staleCompanies[0].name} in 21+ days — time to check in.`
        : overdueTasks.length > 0
          ? `You have ${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""} that need attention.`
          : `${coldContacts.length} contact${coldContacts.length > 1 ? "s" : ""} haven't been touched in ${COLD_THRESHOLD_DAYS}+ days.`;

    await storage.createNotification({
      userId: user.id,
      type: "daily_digest",
      title: notifTitle,
      body: notifBody,
      link: "/dashboard",
      read: false,
    });

    if (emailEnabled() && user.username?.includes("@")) {
      const firstName = user.name.split(" ")[0];

      // Generate AI priority line
      const summaryCtx: string[] = [];
      if (churnRiskCompanies.length > 0) summaryCtx.push(`Volume drops: ${churnRiskCompanies.slice(0, 3).map(c => `${c.company.name} -${c.pct}%`).join(", ")}`);
      if (myRfpDeadlines.length > 0) summaryCtx.push(`Upcoming RFP deadlines: ${myRfpDeadlines.slice(0, 3).map((r: any) => `${r.title} (due ${r.dueDate})`).join(", ")}`);
      if (overdueTasks.length > 0) summaryCtx.push(`${overdueTasks.length} overdue tasks`);
      if (coldContacts.length > 0) summaryCtx.push(`${coldContacts.length} contacts needing attention`);

      const aiPriority = summaryCtx.length > 0 ? await generateAiPriority(user.name, summaryCtx) : "";

      // Build email HTML sections
      let aiPriorityHtml = "";
      if (aiPriority) {
        aiPriorityHtml = `
          <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:14px 16px;margin-bottom:20px;">
            <p style="margin:0;font-size:13px;font-weight:600;color:#92400e;margin-bottom:4px;">✦ AI Priority for Today</p>
            <p style="margin:0;font-size:14px;color:#78350f;font-style:italic;">${aiPriority}</p>
          </div>`;
      }

      let churnHtml = "";
      if (churnRiskCompanies.length > 0) {
        churnHtml = `
          <p style="font-weight:600;color:#111827;margin:0 0 10px;">📉 Volume Drops — Churn Risk (${churnRiskCompanies.length})</p>
          ${churnRiskCompanies.slice(0, 5).map(({ company, curLoads, prevLoads, pct }) => `
            <div class="item">
              <div class="item-title">${company.name}</div>
              <div class="item-meta">Down <span class="badge badge-red">${pct}% MoM</span> &bull; ${curLoads} loads this month vs ${prevLoads} last month — call today.</div>
            </div>`).join("")}
          ${churnRiskCompanies.length > 5 ? `<p style="color:#6b7280;font-size:13px;">...and ${churnRiskCompanies.length - 5} more.</p>` : ""}
        `;
      }

      let rfpHtml = "";
      if (myRfpDeadlines.length > 0) {
        rfpHtml = `
          <p style="font-weight:600;color:#111827;margin:${churnRiskCompanies.length > 0 ? "20px" : "0"} 0 10px;">📋 RFP Deadlines (${myRfpDeadlines.length})</p>
          ${myRfpDeadlines.slice(0, 5).map((r: any) => {
            const daysLeft = -daysSince(r.dueDate);
            const urgencyBadge = daysLeft <= 0 ? `<span class="badge badge-red">OVERDUE</span>` : daysLeft <= 3 ? `<span class="badge badge-red">${daysLeft}d left</span>` : `<span class="badge badge-amber">${daysLeft}d left</span>`;
            const company = companyMap[r.companyId];
            return `<div class="item">
              <div class="item-title">${r.title} ${urgencyBadge}</div>
              <div class="item-meta">${company ? `Account: ${company.name} &bull; ` : ""}Due: ${r.dueDate}</div>
            </div>`;
          }).join("")}
        `;
      }

      let overdueHtml = "";
      if (overdueTasks.length > 0) {
        overdueHtml = `
          <p style="font-weight:600;color:#111827;margin:${churnRiskCompanies.length > 0 || myRfpDeadlines.length > 0 ? "20px" : "0"} 0 10px;">🔴 Overdue Tasks (${overdueTasks.length})</p>
          ${overdueTasks.slice(0, 8).map((t: any) => {
            const company = t.companyId ? companyMap[t.companyId] : null;
            const daysAgo = t.dueDate ? daysSince(t.dueDate) : 0;
            return `<div class="item">
              <div class="item-title">${t.title}</div>
              <div class="item-meta">${company ? `Account: ${company.name} &bull; ` : ""}Due: ${t.dueDate} <span class="badge badge-red">${daysAgo}d overdue</span></div>
            </div>`;
          }).join("")}
          ${overdueTasks.length > 8 ? `<p style="color:#6b7280;font-size:13px;">...and ${overdueTasks.length - 8} more.</p>` : ""}
        `;
      }

      let coldHtml = "";
      if (coldContacts.length > 0) {
        const hasPrev = churnRiskCompanies.length > 0 || myRfpDeadlines.length > 0 || overdueTasks.length > 0;
        coldHtml = `
          <p style="font-weight:600;color:#111827;margin:${hasPrev ? "20px" : "0"} 0 10px;">🧊 Contacts Needing Attention (${coldContacts.length})</p>
          ${coldContacts.slice(0, 8).map((c: any) => {
            const company = companyMap[c.companyId];
            return `<div class="item">
              <div class="item-title">${c.name}${c.title ? ` — ${c.title}` : ""}</div>
              <div class="item-meta">Account: ${company?.name ?? "Unknown"}</div>
            </div>`;
          }).join("")}
          ${coldContacts.length > 8 ? `<p style="color:#6b7280;font-size:13px;">...and ${coldContacts.length - 8} more.</p>` : ""}
        `;
      }

      const subjectParts: string[] = [];
      if (churnRiskCompanies.length > 0) subjectParts.push(`📉 ${churnRiskCompanies.length} volume drop${churnRiskCompanies.length > 1 ? "s" : ""}`);
      if (myRfpDeadlines.length > 0) subjectParts.push(`📋 ${myRfpDeadlines.length} RFP deadline${myRfpDeadlines.length > 1 ? "s" : ""}`);
      if (overdueTasks.length > 0) subjectParts.push(`🔴 ${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}`);
      if (coldContacts.length > 0) subjectParts.push(`🧊 ${coldContacts.length} cold contact${coldContacts.length > 1 ? "s" : ""}`);

      const html = baseEmailTemplate(
        `Daily Brief for ${user.name}`,
        `<p>Good morning, ${firstName}! Here's your Freight DNA daily brief — a focused snapshot of what needs attention today.</p>
        ${aiPriorityHtml}
        ${churnHtml}${rfpHtml}${overdueHtml}${coldHtml}
        <a class="cta" href="https://sales-org-builder.replit.app/dashboard">Open Dashboard →</a>`
      );

      await sendEmail({
        to: user.username,
        subject: `[Freight DNA] Daily brief — ${subjectParts.join(", ")}`,
        html,
      });
    }

    digestsSent++;
    logMessage(`Digest sent to ${user.name}: ${notifParts.join(", ")}`);
  }

  if (digestsSent === 0) {
    logMessage("No digests needed — all reps are on top of their work!");
  } else {
    logMessage(`Daily digest complete — ${digestsSent} rep(s) notified.`);
  }
}

export function initDailyDigestScheduler(): void {
  const cronExpression = process.env.DAILY_DIGEST_CRON || "0 7 * * 1-5";
  cron.schedule(cronExpression, () => {
    sendDailyDigests().catch(err => logMessage(`Error in daily digest scheduler: ${err.message}`));
  });
  logMessage(`Daily digest scheduler initialized (cron: ${cronExpression})`);
}
