/**
 * Intel Email Scheduler
 *
 * - Daily Insights email: sends every weekday morning (7 AM) to all admin users
 * - Bi-Weekly Scorecard email: sends every other Monday morning (7:30 AM) to all admin users
 *
 * Follows the same pattern as dailyDigestScheduler.ts and repReportScheduler.ts
 */

import cron from "node-cron";
import { storage } from "./storage";
import { sendEmail, baseEmailTemplate, emailEnabled } from "./emailService";
import {
  getNationalMarketSummary,
  getMarketOtris,
} from "./sonarClient";
import { resolveColumns, getCustomerFromRow, getStatusFromRow } from "./colResolver";
import { isExcludedRow } from "./financialHelpers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

function logIntel(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [intel-email] ${msg}`);
}

// ── Shared helpers (mirrors intel route logic) ─────────────────────────────────

function normStr(s: string) {
  return (s ?? "").toString().trim().toLowerCase();
}

function getWeekKey(dateStr: string): string {
  const datePart = String(dateStr).trim().slice(0, 10);
  const d = new Date(datePart + "T12:00:00Z");
  if (isNaN(d.getTime())) return "";
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getUTCDay() + 1) / 7);
  return `${year}-${String(weekNum).padStart(2, "0")}`;
}

function getRecentWeekKeys(n: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const key = getWeekKey(d.toISOString().split("T")[0]);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys.reverse();
}

function getScorecardStatus(marginPct: number): { status: string; color: string } {
  if (marginPct >= 25) return { status: "SCALE", color: "#16a34a" };
  if (marginPct >= 15) return { status: "GROW", color: "#2563eb" };
  if (marginPct >= 8) return { status: "WATCH", color: "#ca8a04" };
  return { status: "HOLD", color: "#dc2626" };
}

function computeBuyRateRange(
  carrierPays: number[],
  originOtri: number,
): { low: number; high: number } {
  if (carrierPays.length === 0) return { low: 0, high: 0 };
  const sorted = [...carrierPays].sort((a, b) => a - b);
  const p25Idx = Math.floor(sorted.length * 0.25);
  const p75Idx = Math.floor(sorted.length * 0.75);
  const p25 = sorted[p25Idx] ?? sorted[0];
  const p75 = sorted[p75Idx] ?? sorted[sorted.length - 1];
  const avgMiles = 500;
  let adjustment = 0;
  if (originOtri > 25) adjustment = 0.1;
  else if (originOtri > 10) adjustment = 0.05;
  return {
    low: Math.round((p25 / avgMiles) * (1 + adjustment) * 100) / 100,
    high: Math.round((p75 / avgMiles) * (1 + adjustment) * 100) / 100,
  };
}

// ── Bi-weekly stamp ────────────────────────────────────────────────────────────

const BIWEEKLY_EMAIL_STAMP = join(process.cwd(), ".data", "intel_biweekly_email_ts.json");

function getLastBiweeklyEmailTs(): number {
  try {
    const d = JSON.parse(readFileSync(BIWEEKLY_EMAIL_STAMP, "utf-8"));
    return d.ts ?? 0;
  } catch {
    return 0;
  }
}

function saveBiweeklyEmailTs(ts: number) {
  try {
    const dir = join(process.cwd(), ".data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BIWEEKLY_EMAIL_STAMP, JSON.stringify({ ts }), "utf-8");
  } catch {}
}

// ── Lane aggregation ───────────────────────────────────────────────────────────

interface SimpleLane {
  origin: string;
  destination: string;
  equipmentType: string;
  totalLoads: number;
  totalRevenue: number;
  totalCarrierPay: number;
  carrierPays: number[];
  marginPct: number;
}

function aggregateLanes(rows: any[], cols: ReturnType<typeof resolveColumns>, sixWeekKeys: string[], threeWeekKeys: string[]): SimpleLane[] {
  const map = new Map<string, SimpleLane>();
  for (const row of rows) {
    if (isExcludedRow(row, cols)) continue;
    if (getStatusFromRow(row, cols) === "void") continue;

    const origin = normStr(row[cols.origin] ?? row[cols.shipperCity] ?? "");
    const destination = normStr(row[cols.destination] ?? row[cols.consigneeCity] ?? "");
    const equipment = normStr(row[cols.equipmentType] ?? "");
    const dateStr = row[cols.deliveryDate] ?? row[cols.dateOrdered] ?? "";
    const weekKey = getWeekKey(String(dateStr));

    if (!origin || !destination || !weekKey) continue;
    if (!sixWeekKeys.includes(weekKey)) continue;

    const revenue = Number(row[cols.totalCharges] ?? row[cols.revenue] ?? 0) || 0;
    const carrierPay = Number(row[cols.carrierPay] ?? row[cols.freightCharge] ?? 0) || 0;
    const key = `${origin}|${destination}|${equipment}`;

    if (!map.has(key)) {
      map.set(key, { origin, destination, equipmentType: equipment, totalLoads: 0, totalRevenue: 0, totalCarrierPay: 0, carrierPays: [], marginPct: 0 });
    }
    const lane = map.get(key)!;
    lane.totalLoads += 1;
    lane.totalRevenue += revenue;
    lane.totalCarrierPay += carrierPay;
    if (threeWeekKeys.includes(weekKey) && carrierPay > 0) lane.carrierPays.push(carrierPay);
  }

  for (const lane of map.values()) {
    lane.marginPct = lane.totalRevenue > 0 ? ((lane.totalRevenue - lane.totalCarrierPay) / lane.totalRevenue) * 100 : 0;
  }

  return Array.from(map.values()).sort((a, b) => b.totalLoads - a.totalLoads);
}

// ── Email templates ────────────────────────────────────────────────────────────

function buildDailyInsightsEmail(opts: {
  recipientName: string;
  dateStr: string;
  otri: number;
  otriDelta: number;
  ntiPerMile: number;
  diesel: number;
  alertHtml: string;
  buyRateHtml: string;
}): string {
  const otriDir = opts.otriDelta >= 0 ? "▲" : "▼";
  const otriColor = opts.otriDelta > 0 ? "#dc2626" : "#16a34a";

  const body = `
    <div style="background:linear-gradient(135deg,#0d5c34 0%,#0a7a5c 100%);padding:32px 40px;border-radius:8px 8px 0 0;">
      <div style="color:rgba(255,255,255,0.6);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">
        VALUE TRUCK · DAILY INTELLIGENCE
      </div>
      <h1 style="color:#fff;font-size:26px;font-weight:900;margin:0;">Good morning, ${opts.recipientName}.</h1>
      <p style="color:rgba(255,255,255,0.6);font-size:13px;margin:6px 0 0;">${opts.dateStr}</p>
    </div>

    <div style="background:#0a1628;padding:0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="padding:16px 20px;border-right:1px solid rgba(255,255,255,0.08);text-align:center;width:25%;">
            <div style="color:#fff;font-size:20px;font-weight:900;">${opts.otri.toFixed(1)}%</div>
            <div style="color:rgba(255,255,255,0.4);font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Nat'l OTRI</div>
            <div style="color:${otriColor};font-size:10px;margin-top:4px;">${otriDir} ${Math.abs(opts.otriDelta).toFixed(1)}% WoW</div>
          </td>
          <td style="padding:16px 20px;border-right:1px solid rgba(255,255,255,0.08);text-align:center;width:25%;">
            <div style="color:#fff;font-size:20px;font-weight:900;">$${opts.ntiPerMile.toFixed(2)}</div>
            <div style="color:rgba(255,255,255,0.4);font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">NTI $/mi</div>
          </td>
          <td style="padding:16px 20px;border-right:1px solid rgba(255,255,255,0.08);text-align:center;width:25%;">
            <div style="color:#fff;font-size:20px;font-weight:900;">$${opts.diesel.toFixed(2)}</div>
            <div style="color:rgba(255,255,255,0.4);font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Diesel/gal</div>
          </td>
          <td style="padding:16px 20px;text-align:center;width:25%;">
            <a href="${process.env.APP_URL ?? "https://freight-dna.replit.app"}/intel"
               style="display:inline-block;background:#16a34a;color:#fff;font-size:11px;font-weight:700;padding:8px 16px;border-radius:20px;text-decoration:none;letter-spacing:1px;">
              VIEW FULL INTEL →
            </a>
          </td>
        </tr>
      </table>
    </div>

    ${opts.alertHtml}
    ${opts.buyRateHtml}

    <div style="background:#f9fafb;padding:20px 24px;border-top:1px solid #e5e7eb;">
      <p style="color:#6b7280;font-size:11px;margin:0;text-align:center;">
        Freight DNA Intelligence · Generated ${new Date().toLocaleString()} · Admin Only
      </p>
    </div>
  `;

  return baseEmailTemplate("Daily Intelligence", body);
}

function buildScorecardEmail(opts: {
  recipientName: string;
  dateStr: string;
  totalLoads: number;
  totalRevenue: number;
  overallMarginPct: number;
  lanesHtml: string;
}): string {
  const marginColor = opts.overallMarginPct >= 15 ? "#16a34a" : opts.overallMarginPct >= 8 ? "#ca8a04" : "#dc2626";

  const body = `
    <div style="background:linear-gradient(135deg,#0d5c34 0%,#0a7a5c 100%);padding:32px 40px 24px;border-radius:8px 8px 0 0;">
      <div style="color:rgba(255,255,255,0.6);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">
        VALUE TRUCK · BI-WEEKLY LANE SCORECARD
      </div>
      <h1 style="color:#fff;font-size:26px;font-weight:900;margin:0;">Lane Health Report</h1>
      <p style="color:rgba(255,255,255,0.6);font-size:13px;margin:6px 0 16px;">${opts.dateStr}</p>

      <div style="display:inline-block;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.2);border-radius:12px;padding:16px 24px;text-align:center;">
        <div style="color:rgba(255,255,255,0.5);font-size:10px;text-transform:uppercase;letter-spacing:1px;">6-Week Overall Margin</div>
        <div style="color:${marginColor};font-size:36px;font-weight:900;line-height:1.1;margin-top:4px;">${opts.overallMarginPct.toFixed(1)}%</div>
        <div style="color:rgba(255,255,255,0.4);font-size:11px;margin-top:4px;">
          ${opts.totalLoads.toLocaleString()} loads · $${(opts.totalRevenue / 1000).toFixed(0)}K revenue
        </div>
      </div>
    </div>

    <div style="padding:24px;">
      <h2 style="color:#111827;font-size:15px;font-weight:700;margin:0 0 16px;padding:0;border-bottom:2px solid #e5e7eb;padding-bottom:8px;">
        Top Lane Performance
      </h2>
      ${opts.lanesHtml}

      <div style="margin-top:20px;text-align:center;">
        <a href="${process.env.APP_URL ?? "https://freight-dna.replit.app"}/intel"
           style="display:inline-block;background:linear-gradient(135deg,#0d5c34,#0a7a5c);color:#fff;font-size:12px;font-weight:700;padding:12px 28px;border-radius:24px;text-decoration:none;letter-spacing:1px;">
          VIEW FULL SCORECARD →
        </a>
      </div>
    </div>

    <div style="background:#f9fafb;padding:20px 24px;border-top:1px solid #e5e7eb;">
      <p style="color:#6b7280;font-size:11px;margin:0;text-align:center;">
        Freight DNA Intelligence · Bi-Weekly Scorecard · Admin Only
      </p>
    </div>
  `;

  return baseEmailTemplate("Bi-Weekly Lane Scorecard", body);
}

// ── Daily email send ──────────────────────────────────────────────────────────

async function sendDailyIntelEmails(): Promise<void> {
  if (!emailEnabled()) {
    logIntel("Email not configured — skipping daily intel email");
    return;
  }

  try {
    const allOrgs = await storage.getOrganizations();

    for (const org of allOrgs) {
      const allUsers = await storage.getUsers(org.id);
      const adminUsers = allUsers.filter(u => u.role === "admin" && u.email);

      if (adminUsers.length === 0) continue;

      const uploads = await storage.getFinancialUploadsForOrg(org.id);
      const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
      let allRows: any[] = [];
      for (const upload of sorted.slice(0, 3)) {
        allRows = allRows.concat((upload.rows as any[]) ?? []);
      }

      const cols = resolveColumns(allRows.length > 0 ? allRows : []);
      const sixWeekKeys = getRecentWeekKeys(6);
      const threeWeekKeys = getRecentWeekKeys(3);
      const lanes = aggregateLanes(allRows, cols, sixWeekKeys, threeWeekKeys);

      const national = await getNationalMarketSummary();
      const uniqueMarkets = Array.from(new Set([
        ...lanes.map(l => l.origin),
        ...lanes.map(l => l.destination),
      ])).filter(Boolean).slice(0, 20);
      const marketOtris = await getMarketOtris(uniqueMarkets);
      const otriByMarket = new Map(marketOtris.map(m => [m.market.toLowerCase(), m.otri]));

      // Build alert HTML
      const alerts: Array<{ lane: string; signal: string; severity: string }> = [];
      for (const lane of lanes.slice(0, 10)) {
        const originOtri = otriByMarket.get(lane.origin.toLowerCase()) ?? 15;
        if (originOtri > 25) {
          alerts.push({
            lane: `${lane.origin} → ${lane.destination}`,
            signal: `Origin tight (OTRI ${originOtri.toFixed(1)}%)`,
            severity: "high",
          });
        }
      }

      const alertHtml = alerts.length > 0 ? `
        <div style="padding:16px 24px;background:#fff;">
          <h3 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin:0 0 12px;display:flex;align-items:center;gap:6px;">
            ⚠ Lane Alerts (${alerts.length})
          </h3>
          ${alerts.slice(0, 5).map(a => `
            <div style="border-left:3px solid ${a.severity === "high" ? "#ef4444" : "#f59e0b"};padding:8px 12px;margin-bottom:8px;background:${a.severity === "high" ? "#fef2f2" : "#fffbeb"};border-radius:0 6px 6px 0;">
              <strong style="font-size:12px;color:#111;">${a.lane}</strong>
              <br><span style="font-size:11px;color:#6b7280;">${a.signal}</span>
            </div>
          `).join("")}
        </div>
      ` : `
        <div style="padding:16px 24px;background:#fff;">
          <p style="color:#16a34a;font-size:13px;margin:0;">✓ No active lane alerts — all monitored lanes looking healthy.</p>
        </div>
      `;

      // Build buy rate quick-look HTML
      const buyRateHtml = lanes.slice(0, 5).length > 0 ? `
        <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;">
          <h3 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin:0 0 12px;">
            Today's Buy Rate Quick-Look
          </h3>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
            <thead>
              <tr style="background:#f3f4f6;">
                <th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;">Lane</th>
                <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;">Loads</th>
                <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;">Buy Rate $/mi</th>
              </tr>
            </thead>
            <tbody>
              ${lanes.slice(0, 5).map((lane, i) => {
                const originOtri = otriByMarket.get(lane.origin.toLowerCase()) ?? 15;
                const buyRate = computeBuyRateRange(lane.carrierPays, originOtri);
                return `
                  <tr style="border-top:1px solid #e5e7eb;background:${i % 2 === 0 ? "#fff" : "#f9fafb"};">
                    <td style="padding:8px 12px;font-size:12px;color:#111;text-transform:capitalize;">${lane.origin} → ${lane.destination}</td>
                    <td style="padding:8px 12px;font-size:12px;color:#6b7280;text-align:right;">${lane.totalLoads}</td>
                    <td style="padding:8px 12px;font-size:12px;font-weight:700;color:#111;text-align:right;">
                      ${buyRate.low > 0 ? `$${buyRate.low.toFixed(2)}–$${buyRate.high.toFixed(2)}` : "–"}
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      ` : "";

      const today = new Date();
      const dateStr = today.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

      for (const admin of adminUsers) {
        const html = buildDailyInsightsEmail({
          recipientName: admin.name.split(" ")[0],
          dateStr,
          otri: national.otri,
          otriDelta: national.otriWoWDelta,
          ntiPerMile: national.ntiPerMile,
          diesel: national.dieselPerGal,
          alertHtml,
          buyRateHtml,
        });

        const sent = await sendEmail({
          to: admin.email!,
          subject: `Freight DNA: Daily Market Intel — ${today.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`,
          html,
        });

        logIntel(sent ? `Daily intel sent to ${admin.email}` : `Failed to send daily intel to ${admin.email}`);
      }
    }
  } catch (err: any) {
    logIntel(`Error in daily intel emails: ${err.message}`);
  }
}

// ── Bi-weekly scorecard send ──────────────────────────────────────────────────

async function sendBiweeklyScorecardEmails(): Promise<void> {
  if (!emailEnabled()) {
    logIntel("Email not configured — skipping bi-weekly scorecard");
    return;
  }

  const now = Date.now();
  const lastTs = getLastBiweeklyEmailTs();
  const daysSince = (now - lastTs) / (1000 * 60 * 60 * 24);

  if (lastTs > 0 && daysSince < 13.5) {
    logIntel(`Bi-weekly scorecard not due (${daysSince.toFixed(1)} days since last send)`);
    return;
  }

  saveBiweeklyEmailTs(now);
  logIntel("Sending bi-weekly scorecard emails...");

  try {
    const allOrgs = await storage.getOrganizations();

    for (const org of allOrgs) {
      const allUsers = await storage.getUsers(org.id);
      const adminUsers = allUsers.filter(u => u.role === "admin" && u.email);
      if (adminUsers.length === 0) continue;

      const uploads = await storage.getFinancialUploadsForOrg(org.id);
      const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
      let allRows: any[] = [];
      for (const upload of sorted.slice(0, 3)) {
        allRows = allRows.concat((upload.rows as any[]) ?? []);
      }

      const cols = resolveColumns(allRows.length > 0 ? allRows : []);
      const sixWeekKeys = getRecentWeekKeys(6);
      const threeWeekKeys = getRecentWeekKeys(3);
      const lanes = aggregateLanes(allRows, cols, sixWeekKeys, threeWeekKeys);

      const uniqueMarkets = Array.from(new Set([
        ...lanes.map(l => l.origin),
        ...lanes.map(l => l.destination),
      ])).filter(Boolean).slice(0, 20);
      const marketOtris = await getMarketOtris(uniqueMarkets);
      const otriByMarket = new Map(marketOtris.map(m => [m.market.toLowerCase(), m.otri]));

      const totalLoads = lanes.reduce((s, l) => s + l.totalLoads, 0);
      const totalRevenue = lanes.reduce((s, l) => s + l.totalRevenue, 0);
      const totalCarrierPay = lanes.reduce((s, l) => s + l.totalCarrierPay, 0);
      const overallMarginPct = totalRevenue > 0 ? ((totalRevenue - totalCarrierPay) / totalRevenue) * 100 : 0;

      // Build lanes HTML for scorecard
      const lanesHtml = lanes.slice(0, 10).map((lane, i) => {
        const { status, color } = getScorecardStatus(lane.marginPct);
        const originOtri = otriByMarket.get(lane.origin.toLowerCase()) ?? 15;
        const buyRate = computeBuyRateRange(lane.carrierPays, originOtri);

        return `
          <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:10px;background:#fff;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
              <div>
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:3px;">
                  Lane #${i + 1}
                </div>
                <div style="font-size:15px;font-weight:900;color:#111;text-transform:capitalize;">${lane.origin}</div>
                <div style="font-size:12px;color:#6b7280;margin-top:2px;">→ <span style="text-transform:capitalize;">${lane.destination}</span></div>
                ${lane.equipmentType ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px;">${lane.equipmentType}</div>` : ""}
              </div>
              <div style="text-align:right;">
                <span style="display:inline-block;background:${color};color:${color === "#ca8a04" ? "#000" : "#fff"};font-size:9px;font-weight:800;padding:3px 10px;border-radius:20px;letter-spacing:1px;">${status}</span>
                <div style="font-size:24px;font-weight:900;color:${color};margin-top:6px;line-height:1;">${lane.marginPct.toFixed(1)}%</div>
                <div style="font-size:10px;color:#9ca3af;">6-wk margin</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;">
              <div style="flex:1;background:#f9fafb;border-radius:6px;padding:8px;text-align:center;">
                <div style="font-size:14px;font-weight:900;color:#111;">${lane.totalLoads}</div>
                <div style="font-size:10px;color:#9ca3af;">Loads</div>
              </div>
              ${buyRate.low > 0 ? `
              <div style="flex:2;background:linear-gradient(135deg,#0a1628,#1e3a5f);border-radius:6px;padding:8px;text-align:center;">
                <div style="font-size:10px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Buy Rate $/mi</div>
                <div style="font-size:14px;font-weight:900;color:#fff;">$${buyRate.low.toFixed(2)} – $${buyRate.high.toFixed(2)}</div>
              </div>` : ""}
            </div>
          </div>
        `;
      }).join("");

      const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

      for (const admin of adminUsers) {
        const html = buildScorecardEmail({
          recipientName: admin.name.split(" ")[0],
          dateStr,
          totalLoads,
          totalRevenue,
          overallMarginPct,
          lanesHtml,
        });

        const sent = await sendEmail({
          to: admin.email!,
          subject: `Freight DNA: Bi-Weekly Lane Scorecard — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
          html,
        });

        logIntel(sent ? `Bi-weekly scorecard sent to ${admin.email}` : `Failed to send scorecard to ${admin.email}`);
      }
    }
  } catch (err: any) {
    logIntel(`Error in bi-weekly scorecard emails: ${err.message}`);
  }
}

// ── Manual / on-demand send for a specific org ────────────────────────────────

export async function sendIntelNowForOrg(orgId: string): Promise<void> {
  logIntel(`Manual send triggered for org ${orgId}`);

  const allUsers = await storage.getUsers(orgId);
  const adminUsers = allUsers.filter(u => u.role === "admin" && u.email);
  if (adminUsers.length === 0) {
    logIntel("No admin users with email — skipping manual send");
    return;
  }

  const uploads = await storage.getFinancialUploadsForOrg(orgId);
  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  let allRows: any[] = [];
  for (const upload of sorted.slice(0, 3)) {
    allRows = allRows.concat((upload.rows as any[]) ?? []);
  }

  const cols = resolveColumns(allRows.length > 0 ? allRows : []);
  const sixWeekKeys = getRecentWeekKeys(6);
  const threeWeekKeys = getRecentWeekKeys(3);
  const lanes = aggregateLanes(allRows, cols, sixWeekKeys, threeWeekKeys);

  const national = await getNationalMarketSummary();
  const uniqueMarkets = Array.from(new Set([
    ...lanes.map(l => l.origin),
    ...lanes.map(l => l.destination),
  ])).filter(Boolean).slice(0, 20);
  const marketOtris = await getMarketOtris(uniqueMarkets);
  const otriByMarket = new Map(marketOtris.map(m => [m.market.toLowerCase(), m.otri]));

  const totalLoads = lanes.reduce((s, l) => s + l.totalLoads, 0);
  const totalRevenue = lanes.reduce((s, l) => s + l.totalRevenue, 0);
  const totalCarrierPay = lanes.reduce((s, l) => s + l.totalCarrierPay, 0);
  const overallMarginPct = totalRevenue > 0 ? ((totalRevenue - totalCarrierPay) / totalRevenue) * 100 : 0;

  // Build alerts
  const alerts: Array<{ lane: string; signal: string; severity: string }> = [];
  for (const lane of lanes.slice(0, 10)) {
    const originOtri = otriByMarket.get(lane.origin.toLowerCase()) ?? 15;
    if (originOtri > 25) {
      alerts.push({ lane: `${lane.origin} → ${lane.destination}`, signal: `Origin tight (OTRI ${originOtri.toFixed(1)}%)`, severity: "high" });
    }
  }

  const alertHtml = alerts.length > 0 ? `
    <div style="padding:16px 24px;background:#fff;">
      <h3 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin:0 0 12px;">⚠ Lane Alerts (${alerts.length})</h3>
      ${alerts.slice(0, 5).map(a => `
        <div style="border-left:3px solid ${a.severity === "high" ? "#ef4444" : "#f59e0b"};padding:8px 12px;margin-bottom:8px;background:${a.severity === "high" ? "#fef2f2" : "#fffbeb"};border-radius:0 6px 6px 0;">
          <strong style="font-size:12px;color:#111;">${a.lane}</strong>
          <br><span style="font-size:11px;color:#6b7280;">${a.signal}</span>
        </div>
      `).join("")}
    </div>
  ` : `<div style="padding:16px 24px;background:#fff;"><p style="color:#16a34a;font-size:13px;margin:0;">✓ No active lane alerts.</p></div>`;

  const buyRateHtml = lanes.slice(0, 5).length > 0 ? `
    <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;">
      <h3 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin:0 0 12px;">Today's Buy Rate Quick-Look</h3>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <thead><tr style="background:#f3f4f6;">
          <th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;">Lane</th>
          <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;">Loads</th>
          <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;">Buy Rate $/mi</th>
        </tr></thead>
        <tbody>${lanes.slice(0, 5).map((lane, i) => {
          const originOtri = otriByMarket.get(lane.origin.toLowerCase()) ?? 15;
          const buyRate = computeBuyRateRange(lane.carrierPays, originOtri);
          return `<tr style="border-top:1px solid #e5e7eb;background:${i % 2 === 0 ? "#fff" : "#f9fafb"};">
            <td style="padding:8px 12px;font-size:12px;color:#111;text-transform:capitalize;">${lane.origin} → ${lane.destination}</td>
            <td style="padding:8px 12px;font-size:12px;color:#6b7280;text-align:right;">${lane.totalLoads}</td>
            <td style="padding:8px 12px;font-size:12px;font-weight:700;color:#111;text-align:right;">${buyRate.low > 0 ? `$${buyRate.low.toFixed(2)}–$${buyRate.high.toFixed(2)}` : "–"}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>
  ` : "";

  // Build lane scorecard HTML
  const lanesHtml = lanes.slice(0, 10).map((lane, i) => {
    const { status, color } = getScorecardStatus(lane.marginPct);
    const originOtri = otriByMarket.get(lane.origin.toLowerCase()) ?? 15;
    const buyRate = computeBuyRateRange(lane.carrierPays, originOtri);
    return `
      <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:10px;background:#fff;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
          <div>
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:3px;">Lane #${i + 1}</div>
            <div style="font-size:15px;font-weight:900;color:#111;text-transform:capitalize;">${lane.origin}</div>
            <div style="font-size:12px;color:#6b7280;margin-top:2px;">→ <span style="text-transform:capitalize;">${lane.destination}</span></div>
            ${lane.equipmentType ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px;">${lane.equipmentType}</div>` : ""}
          </div>
          <div style="text-align:right;">
            <span style="display:inline-block;background:${color};color:${color === "#ca8a04" ? "#000" : "#fff"};font-size:9px;font-weight:800;padding:3px 10px;border-radius:20px;letter-spacing:1px;">${status}</span>
            <div style="font-size:24px;font-weight:900;color:${color};margin-top:6px;line-height:1;">${lane.marginPct.toFixed(1)}%</div>
            <div style="font-size:10px;color:#9ca3af;">6-wk margin</div>
          </div>
        </div>
        ${buyRate.low > 0 ? `
        <div style="background:linear-gradient(135deg,#0a1628,#1e3a5f);border-radius:6px;padding:8px;text-align:center;">
          <div style="font-size:10px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Buy Rate $/mi</div>
          <div style="font-size:14px;font-weight:900;color:#fff;">$${buyRate.low.toFixed(2)} – $${buyRate.high.toFixed(2)}</div>
        </div>` : ""}
      </div>
    `;
  }).join("");

  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  for (const admin of adminUsers) {
    // Send combined daily + scorecard email
    const combinedHtml = buildDailyInsightsEmail({
      recipientName: admin.name.split(" ")[0],
      dateStr,
      otri: national.otri,
      otriDelta: national.otriWoWDelta,
      ntiPerMile: national.ntiPerMile,
      diesel: national.dieselPerGal,
      alertHtml,
      buyRateHtml,
    });

    const sent = await sendEmail({
      to: admin.email!,
      subject: `Freight DNA: Manual Intel Report — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
      html: combinedHtml,
    });

    // Also send scorecard
    const scorecardHtml = buildScorecardEmail({
      recipientName: admin.name.split(" ")[0],
      dateStr,
      totalLoads,
      totalRevenue,
      overallMarginPct,
      lanesHtml,
    });
    await sendEmail({
      to: admin.email!,
      subject: `Freight DNA: Lane Scorecard (On-Demand) — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
      html: scorecardHtml,
    });

    logIntel(sent ? `Manual intel sent to ${admin.email}` : `Failed to send manual intel to ${admin.email}`);
  }
}

// ── Cron setup ─────────────────────────────────────────────────────────────────

export function startIntelEmailScheduler(): void {
  // Daily Insights: every weekday at 7:00 AM server time
  cron.schedule("0 7 * * 1-5", () => {
    logIntel("Daily intel email job triggered");
    sendDailyIntelEmails().catch(err => logIntel(`Unhandled error: ${err.message}`));
  });

  // Bi-weekly check: every Monday at 7:30 AM (will gate internally on 14-day window)
  cron.schedule("30 7 * * 1", () => {
    logIntel("Bi-weekly scorecard check triggered");
    sendBiweeklyScorecardEmails().catch(err => logIntel(`Unhandled error: ${err.message}`));
  });

  logIntel("Intel email scheduler started (daily @ 7am weekdays, bi-weekly @ 7:30am Mondays)");
}
