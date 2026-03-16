import nodemailer from "nodemailer";

function logMessage(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [email] ${msg}`);
}

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
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
    const from = process.env.EMAIL_FROM || process.env.SMTP_USER || "noreply@valuetruck.com";
    await transporter.sendMail({ from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text });
    logMessage(`Email sent to ${opts.to}: "${opts.subject}"`);
    return true;
  } catch (err: any) {
    logMessage(`Failed to send email to ${opts.to}: ${err.message}`);
    return false;
  }
}

export function emailEnabled(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
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
