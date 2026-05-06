/**
 * Manager Coaching Mode (Task #301) — weekly digest email.
 *
 * Fires Monday 7:00 AM org-tz. For each manager (admin/director/
 * national_account_manager/sales_director) builds the week's Coaching
 * Cards across their direct reports and emails the top-3 highest-impact
 * items per rep.
 */
import cron from "node-cron";
import { storage } from "./storage";
import { sendEmail, baseEmailTemplate, emailEnabled } from "./emailService";
import { buildCoachingCards, mondayOf, type CoachingCard, type CoachingCardItem } from "./coachingAggregator";

const MANAGER_ROLES = new Set(["admin", "director", "sales_director", "national_account_manager"]);

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [coaching-digest] ${msg}`);
}

/** Flatten a card's items and pick the top-N by severity. */
function topItemsForCard(card: CoachingCard, n = 3): CoachingCardItem[] {
  const flat: CoachingCardItem[] = [
    ...card.accountsAtRisk,
    ...card.flaggedCalls,
    ...card.playsNotRun,
    ...card.responseOutliers,
  ];
  if (card.promotionReady) flat.push(card.promotionReady);
  const rank = (s: CoachingCardItem["severity"]) => (s === "urgent" ? 0 : s === "watch" ? 1 : 2);
  flat.sort((a, b) => rank(a.severity) - rank(b.severity));
  return flat.slice(0, n);
}

function sevBadge(sev: CoachingCardItem["severity"]): string {
  const bg = sev === "urgent" ? "#dc2626" : sev === "watch" ? "#d97706" : "#2563eb";
  const label = sev === "urgent" ? "URGENT" : sev === "watch" ? "WATCH" : "INFO";
  return `<span style="display:inline-block;font-size:10px;font-weight:700;color:#fff;background:${bg};border-radius:4px;padding:2px 6px;margin-right:6px;vertical-align:middle;">${label}</span>`;
}

function kindLabel(k: CoachingCardItem["subjectKind"]): string {
  return {
    account_risk: "Account at risk",
    play_not_run: "Play not run",
    flagged_call: "Flagged call",
    response_outlier: "Response-time gap",
    promotion_ready: "Promotion-ready",
  }[k];
}

export async function sendCoachingDigests(): Promise<number> {
  if (!emailEnabled()) {
    log("Email not configured — skipping.");
    return 0;
  }
  const org = await storage.getDefaultOrganization();
  if (!org) { log("No default organization, skipping."); return 0; }

  const allUsers = await storage.getUsers(org.id);
  const managers = allUsers.filter(u => MANAGER_ROLES.has(u.role));

  const weekStart = mondayOf(new Date());
  const portalUrl = process.env.APP_URL || "https://sales-org-builder.replit.app";
  let sent = 0;

  for (const mgr of managers) {
    const email = (mgr as any).email || mgr.username;
    if (!email || !email.includes("@")) continue;
    let cards: CoachingCard[] = [];
    try {
      cards = await buildCoachingCards(mgr.id, org.id, weekStart);
    } catch (err) {
      log(`Failed to build cards for ${mgr.name}: ${(err as Error).message}`);
      continue;
    }
    if (cards.length === 0) continue;

    const totalItems = cards.reduce((acc, c) =>
      acc + c.accountsAtRisk.length + c.flaggedCalls.length + c.playsNotRun.length + c.responseOutliers.length + (c.promotionReady ? 1 : 0)
    , 0);
    if (totalItems === 0) continue;

    const repBlocks = cards.map(card => {
      const top = topItemsForCard(card, 3);
      if (top.length === 0) {
        return `
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:12px;">
            <p style="margin:0;font-size:14px;font-weight:600;color:#111827;">${card.rep.name}</p>
            <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">No coaching items this week — nice.</p>
          </div>`;
      }
      const rows = top.map(item => `
        <li style="margin:6px 0;font-size:13px;color:#374151;line-height:1.5;">
          ${sevBadge(item.severity)}<strong>${kindLabel(item.subjectKind)}:</strong> ${escapeHtml(item.title)}
          <div style="color:#6b7280;font-size:12px;margin-top:2px;">${escapeHtml(item.detail)}</div>
        </li>`).join("");
      return `
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:12px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <p style="margin:0;font-size:14px;font-weight:600;color:#111827;">${escapeHtml(card.rep.name)}</p>
            <a href="${portalUrl}/coaching?rep=${card.rep.id}" style="font-size:12px;color:#2563eb;text-decoration:none;">Open Coaching Card →</a>
          </div>
          <ul style="margin:0;padding-left:18px;">${rows}</ul>
        </div>`;
    }).join("");

    const html = baseEmailTemplate(
      `Manager Coaching Digest — week of ${weekStart}`,
      `<p>Good morning, ${(mgr.name || "").split(" ")[0] || "there"} — here are this week's highest-impact coaching items across your team.</p>
      <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">Week of ${weekStart} • ${cards.length} rep${cards.length !== 1 ? "s" : ""}</p>
      ${repBlocks}
      <a class="cta" href="${portalUrl}/coaching">Open Coaching Mode →</a>`
    );

    const ok = await sendEmail({
      to: email,
      subject: `[Freight DNA] Weekly coaching digest — ${cards.length} rep${cards.length !== 1 ? "s" : ""} to review`,
      html,
    });
    if (ok) {
      sent++;
      log(`Digest sent to ${mgr.name} (${cards.length} reps, ${totalItems} items)`);
    }
  }
  log(`Coaching digest complete — ${sent} manager(s) notified.`);
  return sent;
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function initCoachingDigestScheduler(): void {
  // Monday 7 AM America/Chicago by default; override via env.
  const cronExpression = process.env.COACHING_DIGEST_CRON || "0 7 * * 1";
  cron.schedule(cronExpression, () => {
    sendCoachingDigests().catch(err => log(`Error: ${err.message}`));
  }, { timezone: "America/Chicago" });
  log(`Coaching digest scheduler initialized (cron: ${cronExpression}, tz: America/Chicago)`);
}
