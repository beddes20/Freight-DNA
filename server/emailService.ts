import nodemailer from "nodemailer";
import { Resend } from "resend";

function logMessage(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [email] ${msg}`);
}

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER || process.env.SMTP_FROM;
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
  const fromAddr = process.env.SMTP_FROM || "noreply@freight-dna.com";
  const fromName = process.env.SMTP_FROM_NAME || "Value Truck · Freight DNA";
  const from = `${fromName} <${fromAddr}>`;

  const resend = getResend();
  if (resend) {
    try {
      const { error } = await resend.emails.send({
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      });
      if (error) {
        logMessage(`Resend error for ${opts.to}: ${error.message}`);
        return false;
      }
      logMessage(`Email sent via Resend to ${opts.to}: "${opts.subject}"`);
      return true;
    } catch (err: any) {
      logMessage(`Resend exception for ${opts.to}: ${err.message}`);
      return false;
    }
  }

  const transporter = getTransporter();
  if (!transporter) {
    logMessage(`Email not configured — skipping email to ${opts.to}: "${opts.subject}"`);
    return false;
  }
  try {
    await transporter.sendMail({ from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text });
    logMessage(`Email sent via SMTP to ${opts.to}: "${opts.subject}"`);
    return true;
  } catch (err: any) {
    logMessage(`SMTP error for ${opts.to}: ${err.message}`);
    return false;
  }
}

export async function verifySmtp(): Promise<{ ok: boolean; provider?: string; error?: string }> {
  const resend = getResend();
  if (resend) {
    return { ok: true, provider: "Resend" };
  }
  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: "No email provider configured (set RESEND_API_KEY or SMTP_HOST/SMTP_PASSWORD)" };
  try {
    await transporter.verify();
    return { ok: true, provider: "SMTP" };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export function emailEnabled(): boolean {
  if (process.env.RESEND_API_KEY) return true;
  const user = process.env.SMTP_USER || process.env.SMTP_FROM;
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
    <h1>Freight DNA</h1>
    <p>${title}</p>
  </div>
  <div class="body">${bodyHtml}</div>
  <div class="footer">Value Truck Transportation Brokerage &bull; This is an automated message from Freight DNA.</div>
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
      <span style="color:#94a3b8;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;">Value Truck · Freight DNA</span>
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

export function buildFeedbackEmail(data: {
  submitterName: string;
  submitterEmail: string;
  type: "bug" | "improvement" | "feature";
  content: string;
  portalUrl: string;
}): string {
  const { submitterName, submitterEmail, type, content, portalUrl } = data;
  const initials = submitterName.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase();

  const typeConfig = {
    bug:         { label: "Bug Report",           emoji: "🐛", accent: "#ef4444", badge: "#fee2e2", badgeText: "#991b1b", tagline: "Something isn't working as expected" },
    improvement: { label: "Improvement Request",  emoji: "🔧", accent: "#3b82f6", badge: "#dbeafe", badgeText: "#1e40af", tagline: "A suggestion to make something work better" },
    feature:     { label: "Feature Request",      emoji: "✨", accent: "#8b5cf6", badge: "#ede9fe", badgeText: "#5b21b6", tagline: "A new capability that would help the team" },
  }[type];

  const lines = content
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map(l => l.trim())
    .filter(Boolean);

  const bodyHtml = lines.map(line => {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && colonIdx < 40) {
      const label = line.slice(0, colonIdx).trim();
      const val   = line.slice(colonIdx + 1).trim();
      return `
        <div style="margin-bottom:12px;">
          <p style="color:#64748b;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 4px;">${label}</p>
          <p style="color:#1e293b;font-size:14px;margin:0;line-height:1.6;">${val}</p>
        </div>`;
    }
    return `<p style="color:#1e293b;font-size:14px;margin:0 0 12px;line-height:1.6;">${line}</p>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:580px;margin:32px auto;padding:0 16px;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#001AB3 0%,#0a2fd4 60%,#0d4a8f 100%);border-radius:16px 16px 0 0;padding:28px 32px;display:flex;align-items:center;gap:16px;">
    <div style="width:44px;height:44px;background:rgba(255,255,255,0.15);border-radius:12px;display:flex;align-items:center;justify-content:center;">
      <span style="font-size:22px;">${typeConfig.emoji}</span>
    </div>
    <div>
      <p style="color:rgba(255,255,255,0.7);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 3px;">DNA Guru · User Feedback</p>
      <p style="color:#ffffff;font-size:20px;font-weight:700;margin:0;">${typeConfig.label}</p>
    </div>
  </div>

  <!-- Body -->
  <div style="background:#ffffff;border:1px solid #e2e8f0;border-top:none;padding:28px 32px;">

    <!-- Submitted by -->
    <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:#f8fafc;border-radius:10px;margin-bottom:24px;">
      <div style="width:36px;height:36px;background:#001AB3;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <span style="color:#fff;font-size:13px;font-weight:700;">${initials}</span>
      </div>
      <div>
        <p style="color:#1e293b;font-size:14px;font-weight:600;margin:0;">${submitterName}</p>
        <p style="color:#64748b;font-size:12px;margin:2px 0 0;">${submitterEmail}</p>
      </div>
      <div style="margin-left:auto;">
        <span style="background:${typeConfig.badge};color:${typeConfig.badgeText};font-size:11px;font-weight:600;padding:3px 10px;border-radius:50px;">${typeConfig.label}</span>
      </div>
    </div>

    <!-- Tagline -->
    <p style="color:#64748b;font-size:13px;margin:0 0 20px;font-style:italic;">${typeConfig.tagline}</p>

    <!-- Divider -->
    <div style="border-top:1px solid #f1f5f9;margin-bottom:20px;"></div>

    <!-- Feedback content -->
    <div style="border-left:3px solid ${typeConfig.accent};padding-left:16px;margin-bottom:24px;">
      ${bodyHtml}
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-top:8px;">
      <a href="${portalUrl}/tasks" style="display:inline-block;background:#001AB3;color:#fff;font-size:14px;font-weight:600;padding:13px 28px;border-radius:50px;text-decoration:none;letter-spacing:0.01em;">
        View Task in Freight DNA →
      </a>
    </div>

  </div>

  <!-- Footer -->
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:16px 32px;text-align:center;">
    <p style="color:#94a3b8;font-size:11px;margin:0;">Submitted via DNA Guru feedback panel · Value Truck Freight DNA</p>
  </div>

</div>
</body></html>`;
}

export function buildPasswordResetEmail(name: string, resetUrl: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif;">
<div style="max-width:560px;margin:40px auto;">

  <!-- Header -->
  <div style="background:#111;border-radius:16px 16px 0 0;padding:32px;text-align:center;">
    <p style="color:#ffb400;font-size:20px;font-weight:700;margin:0;letter-spacing:0.05em;">freight · dna</p>
    <p style="color:rgba(255,180,0,0.55);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:4px 0 0;">Value Truck · Sales Intelligence</p>
  </div>

  <!-- Body -->
  <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:36px 32px;">
    <h2 style="color:#0f172a;font-size:20px;margin:0 0 8px;">Password Reset Request</h2>
    <p style="color:#475569;font-size:14px;margin:0 0 24px;">Hi ${name}, we received a request to reset your Freight DNA password. Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>

    <div style="text-align:center;margin:28px 0;">
      <a href="${resetUrl}" style="display:inline-block;background:#ffb400;color:#111;font-size:15px;font-weight:700;padding:14px 36px;border-radius:50px;text-decoration:none;letter-spacing:0.01em;">
        Reset My Password →
      </a>
    </div>

    <p style="color:#94a3b8;font-size:12px;margin:24px 0 0;line-height:1.6;">If you didn't request a password reset, you can safely ignore this email — your password will not change. If you have concerns, contact your administrator.</p>

    <div style="border-top:1px solid #f1f5f9;margin-top:24px;padding-top:16px;">
      <p style="color:#cbd5e1;font-size:11px;margin:0;">This link will expire at ${new Date(Date.now() + 3600000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}. If it has expired, visit the login page and request a new one.</p>
    </div>
  </div>

  <p style="text-align:center;color:#94a3b8;font-size:11px;margin-top:16px;">Value Truck · Freight DNA · freight-dna.com</p>
</div>
</body></html>`;
}
