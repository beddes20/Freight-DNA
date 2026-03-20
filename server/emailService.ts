import nodemailer from "nodemailer";

function logMessage(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [email] ${msg}`);
}

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_FROM || process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
}

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(opts: EmailOptions): Promise<boolean> {
  const transporter = getTransporter();
  if (!transporter) {
    logMessage(`SMTP not configured — skipping email to ${opts.to}: "${opts.subject}"`);
    return false;
  }
  try {
    const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@freight-dna.com";
    const fromName = process.env.SMTP_FROM_NAME || "Value Truck · Growth Chart";
    const from = `"${fromName}" <${fromAddr}>`;
    await transporter.sendMail({ from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text });
    logMessage(`Email sent to ${opts.to}: "${opts.subject}"`);
    return true;
  } catch (err: any) {
    logMessage(`Failed to send email to ${opts.to}: ${err.message}`);
    return false;
  }
}

export async function verifySmtp(): Promise<{ ok: boolean; error?: string }> {
  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: "SMTP not configured" };
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export function emailEnabled(): boolean {
  const user = process.env.SMTP_FROM || process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;
  return !!(process.env.SMTP_HOST && user && pass);
}

export function baseEmailTemplate(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:0;}
  .wrapper{max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);}
  .header{background:#001AB3;padding:24px 32px;}
  .header h1{color:#fff;margin:0;font-size:20px;font-weight:700;}
  .header p{color:rgba(255,255,255,.7);margin:4px 0 0;font-size:13px;}
  .body{padding:28px 32px;}
  .body p{color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px;}
  .item{background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:14px 16px;margin:0 0 12px;}
  .item-title{font-weight:600;color:#111827;font-size:14px;}
  .item-meta{color:#6b7280;font-size:12px;margin-top:4px;}
  .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;}
  .badge-red{background:#fee2e2;color:#b91c1c;}
  .badge-amber{background:#fef3c7;color:#92400e;}
  .badge-blue{background:#dbeafe;color:#1d4ed8;}
  .cta{display:inline-block;background:#001AB3;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;margin-top:8px;}
  .footer{background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;color:#9ca3af;font-size:12px;}
</style></head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>Growth Chart VT</h1>
    <p>${title}</p>
  </div>
  <div class="body">${bodyHtml}</div>
  <div class="footer">Value Truck Transportation Brokerage &bull; This is an automated message from Growth Chart VT.</div>
</div>
</body></html>`;
}

export function buildRepReportEmail(data: {
  rep: { name: string; role: string; manager: string | null };
  period: { type: string; label: string };
  goals: Array<{ label: string; current: number; target: number; pct: number; metric: string }>;
  touchpoints: { total: number; call: number; email: number; text: number; site_visit: number };
  contacts: { newThisPeriod: number };
  tasks: { completed: number; open: number; overdue: number };
  wins: Array<{ text: string; category: string }>;
  portalUrl: string;
}): string {
  const { rep, period, goals, touchpoints: tp, contacts, tasks, wins, portalUrl } = data;
  const firstName = rep.name.split(" ")[0];
  const initials = rep.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase();
  const roleLabel = rep.role.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
  const isWeekly = period.type === "weekly";
  const title = isWeekly ? "Weekly Progress Report" : "Monthly Progress Report";

  function pctColor(p: number) {
    if (p >= 80) return { bar: "#22c55e", label: "On Track", badge: "#dcfce7", text: "#166534" };
    if (p >= 50) return { bar: "#f59e0b", label: "In Progress", badge: "#fef3c7", text: "#92400e" };
    return { bar: "#ef4444", label: "Needs Focus", badge: "#fee2e2", text: "#991b1b" };
  }

  const goalRows = goals.map((g) => {
    const c = pctColor(g.pct);
    const isMoney = g.metric === "margin" || g.metric === "revenue";
    const fmt = (v: number) => isMoney ? `$${v.toLocaleString()}` : String(Math.round(v));
    return `
      <div style="border:1px solid #f1f5f9;border-radius:12px;padding:16px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div>
            <p style="color:#1e293b;font-size:14px;font-weight:600;margin:0;">${g.label}</p>
            <p style="color:#94a3b8;font-size:12px;margin:2px 0 0;">${fmt(g.current)} of ${fmt(g.target)}</p>
          </div>
          <div style="text-align:right;">
            <p style="color:${c.bar};font-size:22px;font-weight:700;margin:0;">${g.pct}%</p>
            <span style="background:${c.badge};color:${c.text};font-size:10px;font-weight:600;padding:2px 8px;border-radius:50px;">${c.label}</span>
          </div>
        </div>
        <div style="background:#f1f5f9;border-radius:999px;height:6px;overflow:hidden;">
          <div style="width:${g.pct}%;height:100%;background:${c.bar};border-radius:999px;"></div>
        </div>
      </div>`;
  }).join("");

  const winRows = wins.slice(0, 3).map((w) => {
    const emoji = w.category === "growth" ? "🚀" : w.category === "celebrate" ? "🎉" : "📣";
    return `
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 14px;margin-bottom:8px;display:flex;gap:10px;align-items:flex-start;">
        <span style="font-size:16px;">${emoji}</span>
        <p style="color:#92400e;font-size:13px;margin:0;">${w.text.slice(0, 120)}${w.text.length > 120 ? "…" : ""}</p>
      </div>`;
  }).join("");

  const needsAttentionGoal = goals.find(g => g.pct < 50);
  const calloutText = needsAttentionGoal
    ? `Keep pushing on <strong>${needsAttentionGoal.label}</strong> to hit your goal this ${isWeekly ? "week" : "month"}.`
    : `You're making solid progress this ${isWeekly ? "week" : "month"} — keep it up!`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="background:#f1f5f9;min-height:100vh;padding:32px 16px;font-family:'Inter',-apple-system,sans-serif;margin:0;">
<div style="max-width:600px;margin:0 auto;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 55%,#334155 100%);border-radius:16px 16px 0 0;padding:32px;text-align:center;">
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:16px;">
      <div style="width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#001AB3);"></div>
      <span style="color:#94a3b8;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;">Value Truck · Growth Chart</span>
    </div>
    <h1 style="color:#fff;font-size:24px;font-weight:700;margin:0;">${title}</h1>
    <p style="color:#94a3b8;font-size:13px;margin-top:6px;">${period.label}</p>
    <div style="display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,0.1);border-radius:50px;padding:8px 16px 8px 8px;margin-top:20px;">
      <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#001AB3,#3b82f6);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px;">${initials}</div>
      <div style="text-align:left;">
        <p style="color:#fff;font-size:14px;font-weight:600;margin:0;">${rep.name}</p>
        <p style="color:#94a3b8;font-size:12px;margin:0;">${roleLabel}</p>
      </div>
    </div>
  </div>

  <!-- White body -->
  <div style="background:#ffffff;padding:32px;">
    <p style="color:#1e293b;font-size:15px;margin:0 0 4px;">Hey <strong>${firstName}</strong>,</p>
    <p style="color:#475569;font-size:14px;margin:0 0 28px;line-height:1.6;">
      Here's your ${isWeekly ? "weekly" : "monthly"} snapshot. ${calloutText}
    </p>

    <!-- Activity row -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:28px;">
      ${[
        { label: "Touchpoints", value: String(tp.total), color: "#001AB3" },
        { label: "New Contacts", value: String(contacts.newThisPeriod), color: "#7c3aed" },
        { label: "Tasks Done", value: `${tasks.completed}/${tasks.completed + tasks.open}`, color: "#059669" },
        { label: "Overdue Tasks", value: String(tasks.overdue), color: tasks.overdue > 0 ? "#dc2626" : "#059669" },
      ].map(({ label, value, color }) => `
        <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 12px;text-align:center;">
          <p style="color:${color};font-size:22px;font-weight:700;margin:0;">${value}</p>
          <p style="color:#1e293b;font-size:11px;font-weight:600;margin:2px 0 0;">${label}</p>
        </div>`).join("")}
    </div>

    <hr style="border:none;border-top:1px solid #f1f5f9;margin:0 0 24px;">

    <!-- Goals -->
    <p style="color:#0f172a;font-size:13px;font-weight:700;margin:0 0 14px;text-transform:uppercase;letter-spacing:0.06em;">🎯 Goals Progress</p>
    ${rep.manager ? `<p style="color:#64748b;font-size:12px;margin:0 0 16px;">Goals set by your manager, ${rep.manager}</p>` : ""}
    ${goalRows || '<p style="color:#64748b;font-size:13px;">No active goals for this period.</p>'}

    <hr style="border:none;border-top:1px solid #f1f5f9;margin:0 0 24px;">

    <!-- Touchpoints -->
    <p style="color:#0f172a;font-size:13px;font-weight:700;margin:0 0 14px;text-transform:uppercase;letter-spacing:0.06em;">⚡ Touchpoints</p>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:28px;">
      ${[
        { label: "Calls", value: tp.call, bg: "#eff6ff", color: "#1d4ed8" },
        { label: "Emails", value: tp.email, bg: "#f5f3ff", color: "#6d28d9" },
        { label: "Texts", value: tp.text, bg: "#f0fdf4", color: "#15803d" },
        { label: "Site Visits", value: tp.site_visit, bg: "#fffbeb", color: "#b45309" },
      ].map(({ label, value, bg, color }) => `
        <div style="background:${bg};border-radius:12px;padding:14px 8px;text-align:center;">
          <p style="color:${color};font-size:22px;font-weight:700;margin:0;">${value}</p>
          <p style="color:#64748b;font-size:11px;margin:2px 0 0;">${label}</p>
        </div>`).join("")}
    </div>

    ${wins.length > 0 ? `
    <hr style="border:none;border-top:1px solid #f1f5f9;margin:0 0 24px;">
    <p style="color:#0f172a;font-size:13px;font-weight:700;margin:0 0 14px;text-transform:uppercase;letter-spacing:0.06em;">🏆 Wins This ${isWeekly ? "Week" : "Month"}</p>
    <div style="margin-bottom:32px;">${winRows}</div>
    ` : ""}

    <!-- CTA -->
    <div style="text-align:center;margin-top:24px;">
      <a href="${portalUrl}" style="display:inline-block;background:#001AB3;color:#fff;font-size:14px;font-weight:600;padding:14px 32px;border-radius:50px;text-decoration:none;letter-spacing:0.01em;">
        View Full Report in Portal →
      </a>
      <p style="color:#94a3b8;font-size:12px;margin-top:16px;">
        Sent every Monday morning for weekly · 1st of the month for monthly
      </p>
    </div>
  </div>

  <!-- Footer -->
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center;">
    <p style="color:#94a3b8;font-size:11px;margin:0;">You're receiving this because you're on the Value Truck sales team.</p>
  </div>

</div>
</body></html>`;
}
