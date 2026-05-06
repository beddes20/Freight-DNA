import cron from "node-cron";
import { storage } from "./storage";
import { sendEmail, baseEmailTemplate, emailEnabled } from "./emailService";
import { phoneMatchKey } from "./webexService";

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [missed-inbound-recap] ${message}`);
}

function formatPhone(p: string): string {
  const digits = p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return p;
}

async function sendWeeklyMissedInboundRecap(): Promise<void> {
  if (!emailEnabled()) {
    logMessage("Email not configured — skipping weekly missed-inbound recap.");
    return;
  }

  logMessage("Running weekly missed-inbound recap...");

  const defaultOrg = await storage.getDefaultOrganization();
  if (!defaultOrg) { logMessage("No default organization found, skipping."); return; }

  const users = await storage.getUsers(defaultOrg.id);
  // Coordinators (operations) are the primary audience. Also include admins
  // so leadership gets visibility into the weekly missed-call pattern.
  const coordinators = users.filter(u =>
    u.role === "logistics_coordinator" ||
    u.role === "operations" ||
    u.role === "coordinator" ||
    u.role === "admin"
  );
  if (coordinators.length === 0) {
    logMessage("No coordinator users found — skipping.");
    return;
  }

  const sinceIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const calls = await storage.getMissedInboundCallsForOrg(defaultOrg.id, sinceIso);

  if (calls.length === 0) {
    logMessage("No missed inbound calls this week — skipping.");
    return;
  }

  const total = calls.length;
  const afterHours = calls.filter(c => c.afterHours).length;
  const voicemails = calls.filter(c => c.voicemailLeft).length;
  const unknowns = calls.filter(c => !c.contactId).length;
  const withCallback = calls.filter(c => c.callbackCreatedAt).length;

  // Repeat caller buckets — any phone number that rang 2+ times during the
  // week. Keep known callers separate from unknowns so coordinators can
  // distinguish a persistent prospect from a recurring ops issue.
  const byPhone = new Map<string, { count: number; latest: string; known: boolean; label: string }>();
  for (const c of calls) {
    const key = phoneMatchKey(c.callingNumber);
    const prev = byPhone.get(key);
    const label = c.contactId ? `${formatPhone(c.callingNumber)}` : formatPhone(c.callingNumber);
    if (!prev) {
      byPhone.set(key, { count: 1, latest: c.startTime, known: !!c.contactId, label });
    } else {
      prev.count += 1;
      if (c.startTime > prev.latest) prev.latest = c.startTime;
      if (c.contactId) prev.known = true;
    }
  }
  const repeats = Array.from(byPhone.values())
    .filter(v => v.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // After-hours bucket analysis — before 8a, after 6p, and weekends. Give
  // coordinators a sense of when the overflow is actually happening so they
  // can propose coverage or on-call rotations.
  const bucketEarly = calls.filter(c => {
    const h = new Date(c.startTime).getHours();
    const d = new Date(c.startTime).getDay();
    return d !== 0 && d !== 6 && h < 8;
  }).length;
  const bucketEvening = calls.filter(c => {
    const h = new Date(c.startTime).getHours();
    const d = new Date(c.startTime).getDay();
    return d !== 0 && d !== 6 && h >= 18;
  }).length;
  const bucketWeekend = calls.filter(c => {
    const d = new Date(c.startTime).getDay();
    return d === 0 || d === 6;
  }).length;

  const statTile = (label: string, value: string | number, tone: string) => `
    <div style="flex:1;min-width:120px;background:${tone};border-radius:8px;padding:12px 14px;">
      <p style="margin:0;font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:0.04em;">${label}</p>
      <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:#0f172a;">${value}</p>
    </div>`;

  const repeatRows = repeats.length === 0
    ? `<p style="font-size:13px;color:#6b7280;margin:0;">No repeat callers this week.</p>`
    : repeats.map(r => `
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;">
          <span>${r.label}${r.known ? "" : " <span style=\"color:#92400e;background:#fef3c7;padding:1px 6px;border-radius:4px;font-size:11px;margin-left:4px;\">unknown</span>"}</span>
          <span style="font-weight:600;color:#b91c1c;">×${r.count}</span>
        </div>`).join("");

  const portalUrl = process.env.APP_URL || "https://sales-org-builder.replit.app";

  const body = `
    <p>Here's a snapshot of missed inbound calls across the team for the last 7 days.</p>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin:16px 0 20px;">
      ${statTile("Total missed", total, "#fee2e2")}
      ${statTile("Voicemails", voicemails, "#fef3c7")}
      ${statTile("Unknown callers", unknowns, "#e0e7ff")}
      ${statTile("Callbacks queued", `${withCallback} / ${total}`, "#dcfce7")}
    </div>
    <h3 style="margin:20px 0 8px;font-size:15px;color:#0f172a;">After-hours pattern</h3>
    <p style="margin:0 0 12px;font-size:13px;color:#374151;">
      Before 8a: <strong>${bucketEarly}</strong> &nbsp;·&nbsp;
      After 6p: <strong>${bucketEvening}</strong> &nbsp;·&nbsp;
      Weekend: <strong>${bucketWeekend}</strong>
      &nbsp;(${afterHours} total outside business hours)
    </p>
    <h3 style="margin:24px 0 8px;font-size:15px;color:#0f172a;">Top repeat callers</h3>
    ${repeatRows}
    <a class="cta" href="${portalUrl}/coordinators-corner" style="margin-top:20px;">Open Coordinators Corner →</a>
    <p style="font-size:12px;color:#6b7280;margin-top:16px;">Click "Call back" on any row in the portlet to queue the callback and jump straight to the contact (or add them as a new contact if unknown).</p>
  `;

  const html = baseEmailTemplate(
    `Weekly Missed Inbound Recap`,
    body,
  );

  let sent = 0;
  for (const user of coordinators) {
    const email = (user as any).email || user.username;
    if (!email || !email.includes("@")) continue;
    const ok = await sendEmail({
      to: email,
      subject: `[Freight DNA] Missed inbound recap — ${total} call${total === 1 ? "" : "s"} last week`,
      html,
    });
    if (ok) sent++;
  }

  logMessage(`Weekly missed-inbound recap complete — ${sent} coordinator(s) notified (${total} calls analyzed).`);
}

export function initMissedInboundRecapScheduler(): void {
  // Mondays at 7:00 — runs just before the goal recap so coordinators have a
  // clean briefing when they sit down for the week. Configurable via env.
  const cronExpression = process.env.MISSED_INBOUND_RECAP_CRON || "0 7 * * 1";
  cron.schedule(cronExpression, () => {
    sendWeeklyMissedInboundRecap().catch(err =>
      logMessage(`Error in missed-inbound recap scheduler: ${err instanceof Error ? err.message : String(err)}`)
    );
  });
  logMessage(`Missed-inbound recap scheduler initialized (cron: ${cronExpression})`);
}
