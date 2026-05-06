/**
 * Call Volume Drop Alerts (Task #330)
 *
 * Once a day, evaluates each rep's call volume in the trailing 7-day window
 * against their 30-day baseline. Reps whose current-window volume is at least
 * 50% below the baseline are flagged as "drop-off". When a rep flips into
 * drop-off (was not flagged yesterday, is flagged today), their manager is
 * sent an in-app notification and an email. Reps already flagged yesterday
 * are skipped so a prolonged slump does not re-alert daily.
 *
 * Mirrors the flagging math in /api/webex/usage-report so leadership sees the
 * same set in both places.
 */

import cron from "node-cron";
import { storage as defaultStorage, type IStorage } from "./storage";
import { sendEmail, baseEmailTemplate, emailEnabled } from "./emailService";
import type { Touchpoint, User } from "@shared/schema";

type ManagerLike = User & { email?: string | null };

function log(msg: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [call-volume-drop] ${msg}`);
}

const WINDOW_DAYS = 7;
const BASELINE_DAYS = 30;
const MIN_BASELINE_CALLS = 5;
const DROP_THRESHOLD_PCT = -50;
const SETTING_KEY = "call_volume_dropoffs_yesterday";

interface DropoffRow {
  userId: string;
  name: string;
  managerId: string | null;
  count: number;
  baselineAvgPerDay: number;
  expectedForWindow: number;
  deltaPct: number;
}

async function evaluateOrg(organizationId: string, storage: IStorage = defaultStorage): Promise<DropoffRow[]> {
  const allTouchpoints: Touchpoint[] = await storage.getTouchpointsByOrg(organizationId);
  const callTps = allTouchpoints.filter((tp: Touchpoint) =>
    tp.type === "call" && typeof tp.notes === "string" && tp.notes.includes("[Webex CDR:"),
  );

  const now = Date.now();
  const windowStart = now - WINDOW_DAYS * 24 * 3600 * 1000;
  const baselineStart = now - BASELINE_DAYS * 24 * 3600 * 1000;

  const baselineByRep = new Map<string, number>();
  const windowByRep = new Map<string, number>();
  for (const tp of callTps) {
    const createdAt = tp.createdAt;
    if (!createdAt) continue;
    const t = Date.parse(createdAt);
    if (!Number.isFinite(t) || t > now) continue;
    if (t >= baselineStart) {
      baselineByRep.set(tp.loggedById, (baselineByRep.get(tp.loggedById) ?? 0) + 1);
    }
    if (t >= windowStart) {
      windowByRep.set(tp.loggedById, (windowByRep.get(tp.loggedById) ?? 0) + 1);
    }
  }

  const users = await storage.getUsers(organizationId);
  const userById = new Map(users.map(u => [u.id, u] as const));

  const dropoffs: DropoffRow[] = [];
  for (const [userId, baselineTotal] of baselineByRep.entries()) {
    if (baselineTotal < MIN_BASELINE_CALLS) continue;
    const u = userById.get(userId);
    if (!u) continue;
    const count = windowByRep.get(userId) ?? 0;
    const baselineAvgPerDay = baselineTotal / BASELINE_DAYS;
    const expectedForWindow = baselineAvgPerDay * WINDOW_DAYS;
    let deltaPct = 0;
    if (expectedForWindow > 0) {
      deltaPct = Math.round(((count - expectedForWindow) / expectedForWindow) * 100);
    } else if (count > 0) {
      deltaPct = 100;
    }
    if (deltaPct > DROP_THRESHOLD_PCT) continue;
    dropoffs.push({
      userId,
      name: u.name || u.username || "Unknown",
      managerId: u.managerId ?? null,
      count,
      baselineAvgPerDay: Math.round(baselineAvgPerDay * 10) / 10,
      expectedForWindow: Math.round(expectedForWindow),
      deltaPct,
    });
  }
  return dropoffs;
}

function dropoffEmailHtml(managerFirstName: string, rows: DropoffRow[]): string {
  const lines = rows.map(r => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:600;color:#111827;">${r.name}</div>
        <div style="font-size:12px;color:#6b7280;">30-day avg: ${r.baselineAvgPerDay} calls/day</div>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">
        <div style="font-weight:600;color:#b91c1c;">${r.count} calls</div>
        <div style="font-size:12px;color:#6b7280;">vs ~${r.expectedForWindow} expected (${r.deltaPct}%)</div>
      </td>
    </tr>`).join("");

  const portalUrl = process.env.APP_URL || "https://sales-org-builder.replit.app";
  const intro = rows.length === 1
    ? `One of your reps has flipped into a sharp call-volume drop-off in the past 7 days. Worth a quick check-in.`
    : `${rows.length} of your reps have flipped into a sharp call-volume drop-off in the past 7 days. Worth a quick check-in.`;

  return baseEmailTemplate(
    `Call volume drop-off alert`,
    `<p>Good morning${managerFirstName ? `, ${managerFirstName}` : ""}.</p>
     <p style="font-size:14px;color:#374151;margin-bottom:16px;">${intro}</p>
     <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
       <thead>
         <tr style="background:#f9fafb;">
           <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Rep</th>
           <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Last 7 days</th>
         </tr>
       </thead>
       <tbody>${lines}</tbody>
     </table>
     <a class="cta" href="${portalUrl}/admin/phone-usage">Open Phone Usage Report →</a>`,
  );
}

async function checkCallVolumeDropoffs(storage: IStorage = defaultStorage): Promise<void> {
  log("Running daily call volume drop-off check...");

  const orgs = await storage.getOrganizations();
  if (orgs.length === 0) { log("No organisations found, skipping."); return; }

  const prevRaw = await storage.getSetting(SETTING_KEY);
  let prevByOrg: Record<string, string[]> = {};
  if (prevRaw) {
    try { prevByOrg = JSON.parse(prevRaw); } catch { prevByOrg = {}; }
  }

  const todayByOrg: Record<string, string[]> = {};
  let totalAlerts = 0;

  for (const org of orgs) {
    try {
      const dropoffs = await evaluateOrg(org.id, storage);
      todayByOrg[org.id] = dropoffs.map(d => d.userId).sort();

      const prevSet = new Set(prevByOrg[org.id] ?? []);
      const newDropoffs = dropoffs.filter(d => !prevSet.has(d.userId));
      if (newDropoffs.length === 0) continue;

      const users = await storage.getUsers(org.id);
      const userById = new Map(users.map(u => [u.id, u] as const));

      // Group new drop-offs by manager so each manager gets a single digest.
      const byManager = new Map<string, DropoffRow[]>();
      const orphans: DropoffRow[] = [];
      for (const d of newDropoffs) {
        if (d.managerId && userById.has(d.managerId)) {
          const list = byManager.get(d.managerId) ?? [];
          list.push(d);
          byManager.set(d.managerId, list);
        } else {
          orphans.push(d);
        }
      }

      // Fall back to leadership for reps with no assigned manager.
      if (orphans.length > 0) {
        const leaders = users.filter(u =>
          u.role === "admin" || u.role === "director"
          || u.role === "sales_director" || u.role === "national_account_manager",
        );
        for (const leader of leaders) {
          const list = byManager.get(leader.id) ?? [];
          byManager.set(leader.id, list.concat(orphans));
        }
      }

      for (const [managerId, rows] of byManager.entries()) {
        const manager = userById.get(managerId);
        if (!manager) continue;

        // In-app notification — one per manager per drop-off transition. The
        // dedupe check uses each rep's userId as relatedId so a rep who exits
        // and re-enters drop-off after the unread notification is read can
        // alert again, while an unread alert blocks duplicates.
        for (const row of rows) {
          const already = await storage.hasUnreadNotification(
            manager.id, "call_volume_drop", row.userId,
          );
          if (already) continue;
          try {
            await storage.createNotification({
              userId: manager.id,
              type: "call_volume_drop",
              title: `📉 ${row.name}'s call volume dropped sharply`,
              body: `${row.count} calls in the last 7 days vs a 30-day average of ${row.baselineAvgPerDay}/day (${row.deltaPct}%).`,
              link: `/admin/phone-usage`,
              relatedId: row.userId,
              read: false,
            });
            totalAlerts++;
          } catch (err) {
            log(`Failed to create notification for ${manager.name}: ${err instanceof Error ? err.message : err}`);
          }
        }

        // Single email digest per manager covering all of today's new drop-offs.
        // Users may carry an optional `email` column in some deployments; fall
        // back to `username` (which doubles as the email address in this app).
        if (emailEnabled()) {
          const managerWithEmail = manager as ManagerLike;
          const email = managerWithEmail.email ?? manager.username;
          if (email && /@/.test(email)) {
            const firstName = (manager.name || "").split(" ")[0] || "";
            const html = dropoffEmailHtml(firstName, rows);
            const subject = rows.length === 1
              ? `[Freight DNA] ${rows[0].name}'s call volume dropped sharply`
              : `[Freight DNA] ${rows.length} reps flagged for sharp call-volume drop`;
            try {
              await sendEmail({ to: email, subject, html });
            } catch (err) {
              log(`Failed to email manager ${manager.name}: ${err instanceof Error ? err.message : err}`);
            }
          }
        }
      }

      log(`Org ${org.id}: ${newDropoffs.length} new drop-off${newDropoffs.length === 1 ? "" : "s"} surfaced to ${byManager.size} manager(s).`);
    } catch (orgErr) {
      log(`Error processing org ${org.id}: ${orgErr instanceof Error ? orgErr.message : orgErr}`);
    }
  }

  try {
    await storage.setSetting(SETTING_KEY, JSON.stringify(todayByOrg));
  } catch (err) {
    log(`Failed to persist today's drop-off state: ${err instanceof Error ? err.message : err}`);
  }

  log(`Done — ${totalAlerts} new alert(s) created across ${orgs.length} org(s).`);
}

export function initCallVolumeDropScheduler(): void {
  // Daily at 8:30am Chicago time — slightly after the health alert run so the
  // overnight Webex CDR sync has settled.
  const cronExpression = process.env.CALL_VOLUME_DROP_CRON || "30 8 * * *";
  cron.schedule(cronExpression, () => {
    checkCallVolumeDropoffs().catch(err =>
      log(`Error in call volume drop scheduler: ${err instanceof Error ? err.message : err}`),
    );
  }, { timezone: "America/Chicago" });
  log(`Call volume drop scheduler initialized (cron: ${cronExpression}).`);
}

export const __testing__ = { evaluateOrg, checkCallVolumeDropoffs };
