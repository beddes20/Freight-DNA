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
  getLaneMarketRatesBatch,
  buildVotriQualifier,
} from "./sonarClient";
import { generateLaneCoachingCard } from "./aiHelpers";
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
  ratePositioningHtml?: string;
  coachingActionsHtml?: string;
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
    ${opts.coachingActionsHtml ?? ""}
    ${opts.ratePositioningHtml ?? ""}

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
  ratePositioningHtml?: string;
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
    </div>

    ${opts.ratePositioningHtml ?? ""}

    <div style="padding:24px 24px 0;">
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

      // Build coaching actions + tightening callout HTML for email
      let coachingActionsHtml = "";
      try {
        const lanesWithCoachData = lanes.filter(l => l.totalCarrierPay > 0 && l.totalLoads > 0);
        if (lanesWithCoachData.length > 0) {
          const coachLanePairs = lanesWithCoachData.map(l => ({ origin: l.origin, destination: l.destination }));
          const coachMarketRates = await getLaneMarketRatesBatch(coachLanePairs).catch(() => new Map());
          const AVG_MILES_C = 500;

          // Identify tightening lanes and above-market lanes for coaching
          const tighteningLanes: string[] = [];
          const aboveMarketItems: Array<{
            lane: string; deltaPct: number; deltaPerMile: number;
            paidRpm: number; marketRpm: number; forecastDir: string; votri: number | null; totalLoads: number;
          }> = [];

          for (const lane of lanesWithCoachData) {
            const qualifier = buildVotriQualifier(lane.origin, lane.destination);
            const mr = coachMarketRates.get(qualifier);
            if (!mr) continue;
            if (mr.forecastDirection === "TIGHTENING") tighteningLanes.push(`${lane.origin} → ${lane.destination}`);
            const paidPerMile = lane.totalCarrierPay / lane.totalLoads / AVG_MILES_C;
            const deltaPerMile = paidPerMile - mr.marketRatePerMile;
            const deltaPct = mr.marketRatePerMile > 0 ? (deltaPerMile / mr.marketRatePerMile) * 100 : 0;
            if (deltaPct > 10) aboveMarketItems.push({
              lane: `${lane.origin} → ${lane.destination}`,
              deltaPct,
              deltaPerMile,
              paidRpm: paidPerMile,
              marketRpm: mr.marketRatePerMile,
              forecastDir: mr.forecastDirection,
              votri: null,
              totalLoads: lane.totalLoads,
            });
          }
          aboveMarketItems.sort((a, b) => b.deltaPct - a.deltaPct);

          const actionItems: string[] = [];
          if (tighteningLanes.length > 0) {
            actionItems.push(`📈 <strong>Lock in capacity now</strong> — tightening market forecast on: ${tighteningLanes.slice(0, 3).map(l => `<em style="text-transform:capitalize;">${l}</em>`).join(", ")}. Rates are expected to rise — secure carriers before costs increase.`);
          }
          if (aboveMarketItems.length > 0) {
            const top = aboveMarketItems.slice(0, 3);
            actionItems.push(`🔴 <strong>Renegotiate overpriced lanes</strong> — ${top.map(r => `<em style="text-transform:capitalize;">${r.lane}</em> (+${r.deltaPct.toFixed(1)}% vs market)`).join(", ")}. Consider sourcing new carriers to reduce carrier pay.`);
          }

          // Generate top-3 coaching card snippets for the highest above-market lanes
          let coachingCardSnippetsHtml = "";
          try {
            const top3AboveMarket = aboveMarketItems.slice(0, 3);
            if (top3AboveMarket.length > 0) {
              const cardResults = await Promise.all(
                top3AboveMarket.map(r =>
                  generateLaneCoachingCard(
                    r.lane,
                    r.paidRpm,
                    r.marketRpm,
                    r.deltaPerMile,
                    r.deltaPct,
                    "ABOVE_MARKET",
                    r.forecastDir as "TIGHTENING" | "EASING" | "STABLE",
                    r.votri,
                    "tightening",
                  ).then(card => ({ lane: r.lane, card }))
                    .catch(() => ({ lane: r.lane, card: null }))
                )
              );
              const snippetBlocks = cardResults
                .filter(c => c.card)
                .map(c => `
                  <div style="margin-bottom:12px;padding:10px 14px;border-left:3px solid #dc2626;background:#fef2f2;border-radius:4px;">
                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#6b7280;margin-bottom:4px;">${c.lane}</div>
                    <div style="font-size:12px;color:#374151;line-height:1.5;font-style:italic;">${c.card}</div>
                  </div>
                `).join("");
              if (snippetBlocks) {
                coachingCardSnippetsHtml = `
                  <div style="padding:16px 24px;background:#fff;border-top:1px solid #e5e7eb;">
                    <h3 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin:0 0 10px;">
                      🤖 AI Coaching Cards — Top Above-Market Lanes
                    </h3>
                    ${snippetBlocks}
                  </div>
                `;
              }
            }
          } catch (err: any) {
            logIntel(`Coaching card snippets generation error: ${err.message}`);
          }

          if (actionItems.length > 0 || coachingCardSnippetsHtml) {
            const itemsHtml = actionItems.map(a => `<li style="margin-bottom:8px;line-height:1.5;">${a}</li>`).join("");
            coachingActionsHtml = `
              ${actionItems.length > 0 ? `
              <div style="padding:16px 24px;background:#fff;border-top:1px solid #e5e7eb;">
                <h3 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin:0 0 10px;">
                  ⚡ Top Coaching Actions This Week
                </h3>
                <ul style="margin:0;padding-left:18px;font-size:13px;color:#111;">
                  ${itemsHtml}
                </ul>
              </div>` : ""}
              ${coachingCardSnippetsHtml}
            `;
          }
        }
      } catch (err: any) {
        logIntel(`Coaching actions email section error: ${err.message}`);
      }

      // Build rate positioning summary HTML for email
      let ratePositioningHtml = "";
      try {
        // Compute counts from ALL eligible lanes (no display limit)
        const allEligibleLanes = lanes.filter(l => l.totalCarrierPay > 0 && l.totalLoads > 0);
        if (allEligibleLanes.length > 0) {
          const allLanePairs = allEligibleLanes.map(l => ({ origin: l.origin, destination: l.destination }));
          const marketRates = await getLaneMarketRatesBatch(allLanePairs).catch(() => new Map());
          const AVG_MILES = 500;

          const allRateRows = allEligibleLanes
            .map(lane => {
              const qualifier = buildVotriQualifier(lane.origin, lane.destination);
              const mr = marketRates.get(qualifier);
              if (!mr) return null;
              const paidPerMile = lane.totalCarrierPay / lane.totalLoads / AVG_MILES;
              const deltaPerMile = paidPerMile - mr.marketRatePerMile;
              const deltaPct = mr.marketRatePerMile > 0 ? (deltaPerMile / mr.marketRatePerMile) * 100 : 0;
              const cls = deltaPct > 10 ? "ABOVE_MARKET" : deltaPct < -10 ? "BELOW_MARKET" : "AT_MARKET";
              return { lane: `${lane.origin} → ${lane.destination}`, paidPerMile, marketRate: mr.marketRatePerMile, deltaPct, cls, forecast: mr.forecastDirection };
            })
            .filter(Boolean) as Array<{ lane: string; paidPerMile: number; marketRate: number; deltaPct: number; cls: string; forecast: string }>;

          // Display only top 8 rows but count from full set
          const rateRows = allRateRows.slice(0, 8);

          if (allRateRows.length > 0) {
            const aboveCount = allRateRows.filter(r => r.cls === "ABOVE_MARKET").length;
            const belowCount = allRateRows.filter(r => r.cls === "BELOW_MARKET").length;
            const atCount = allRateRows.filter(r => r.cls === "AT_MARKET").length;

            const rowsHtml = rateRows.map((r, i) => {
              const clsColor = r.cls === "ABOVE_MARKET" ? "#dc2626" : r.cls === "BELOW_MARKET" ? "#16a34a" : "#ca8a04";
              const clsLabel = r.cls === "ABOVE_MARKET" ? "▲ Above Market" : r.cls === "BELOW_MARKET" ? "▼ Below Market" : "◆ At Market";
              return `
                <tr style="border-top:1px solid #e5e7eb;background:${i % 2 === 0 ? "#fff" : "#f9fafb"};">
                  <td style="padding:8px 12px;font-size:12px;color:#111;text-transform:capitalize;">${r.lane}</td>
                  <td style="padding:8px 12px;font-size:12px;color:#111;text-align:right;font-weight:700;">$${r.paidPerMile.toFixed(2)}</td>
                  <td style="padding:8px 12px;font-size:12px;color:#6b7280;text-align:right;">$${r.marketRate.toFixed(2)}</td>
                  <td style="padding:8px 12px;font-size:12px;text-align:right;font-weight:700;color:${clsColor};">${r.deltaPct > 0 ? "+" : ""}${r.deltaPct.toFixed(1)}%</td>
                  <td style="padding:8px 12px;font-size:11px;text-align:right;"><span style="color:${clsColor};font-weight:700;">${clsLabel}</span></td>
                </tr>
              `;
            }).join("");

            ratePositioningHtml = `
              <div style="padding:16px 24px;background:#fff;border-top:1px solid #e5e7eb;">
                <h3 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin:0 0 10px;">
                  ◎ Rate Positioning Summary
                </h3>
                <div style="display:flex;gap:16px;margin-bottom:14px;">
                  <div style="flex:1;background:#fef2f2;border-radius:8px;padding:10px;text-align:center;">
                    <div style="font-size:18px;font-weight:900;color:#dc2626;">${aboveCount}</div>
                    <div style="font-size:10px;color:#991b1b;">Above Market</div>
                  </div>
                  <div style="flex:1;background:#fffbeb;border-radius:8px;padding:10px;text-align:center;">
                    <div style="font-size:18px;font-weight:900;color:#ca8a04;">${atCount}</div>
                    <div style="font-size:10px;color:#92400e;">At Market</div>
                  </div>
                  <div style="flex:1;background:#f0fdf4;border-radius:8px;padding:10px;text-align:center;">
                    <div style="font-size:18px;font-weight:900;color:#16a34a;">${belowCount}</div>
                    <div style="font-size:10px;color:#14532d;">Below Market</div>
                  </div>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                  <thead>
                    <tr style="background:#f3f4f6;">
                      <th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;">Lane</th>
                      <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;">Paid $/mi</th>
                      <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;">Market $/mi</th>
                      <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;">Delta</th>
                      <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;">Position</th>
                    </tr>
                  </thead>
                  <tbody>${rowsHtml}</tbody>
                </table>
              </div>
            `;
          }
        }
      } catch (err: any) {
        logIntel(`Rate positioning email section error: ${err.message}`);
      }

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
          coachingActionsHtml,
          ratePositioningHtml,
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

      // Build rate positioning summary for bi-weekly scorecard
      let scorecardRateHtml = "";
      try {
        // Compute counts from ALL eligible lanes, display only top 6
        const allScorecardLanes = lanes.filter(l => l.totalCarrierPay > 0 && l.totalLoads > 0);
        if (allScorecardLanes.length > 0) {
          const sRatePairs = allScorecardLanes.map(l => ({ origin: l.origin, destination: l.destination }));
          const sRateMap = await getLaneMarketRatesBatch(sRatePairs).catch(() => new Map());
          const AVG_MI = 500;
          const allSRows = allScorecardLanes.map(lane => {
            const q = buildVotriQualifier(lane.origin, lane.destination);
            const mr = sRateMap.get(q);
            if (!mr) return null;
            const paidPerMile = lane.totalCarrierPay / lane.totalLoads / AVG_MI;
            const deltaPct = mr.marketRatePerMile > 0 ? ((paidPerMile - mr.marketRatePerMile) / mr.marketRatePerMile) * 100 : 0;
            const cls = deltaPct > 10 ? "ABOVE_MARKET" : deltaPct < -10 ? "BELOW_MARKET" : "AT_MARKET";
            return { lane: `${lane.origin} → ${lane.destination}`, paidPerMile, marketRate: mr.marketRatePerMile, deltaPct, cls, forecast: mr.forecastDirection };
          }).filter(Boolean) as Array<{ lane: string; paidPerMile: number; marketRate: number; deltaPct: number; cls: string; forecast: string }>;

          // Display only top 6 rows but compute counts from all
          const sRows = allSRows.slice(0, 6);

          if (allSRows.length > 0) {
            const aboveCount = allSRows.filter(r => r.cls === "ABOVE_MARKET").length;
            const atCount = allSRows.filter(r => r.cls === "AT_MARKET").length;
            const belowCount = allSRows.filter(r => r.cls === "BELOW_MARKET").length;
            const tighteningLanes = allSRows.filter(r => r.forecast === "TIGHTENING").map(r => r.lane);
            const rowsHtml = sRows.map((r, i) => {
              const clsColor = r.cls === "ABOVE_MARKET" ? "#dc2626" : r.cls === "BELOW_MARKET" ? "#16a34a" : "#ca8a04";
              const clsLabel = r.cls === "ABOVE_MARKET" ? "▲ Above Market" : r.cls === "BELOW_MARKET" ? "▼ Below Market" : "◆ At Market";
              return `<tr style="border-top:1px solid #e5e7eb;background:${i % 2 === 0 ? "#fff" : "#f9fafb"};">
                <td style="padding:8px 12px;font-size:12px;color:#111;text-transform:capitalize;">${r.lane}</td>
                <td style="padding:8px 12px;font-size:12px;text-align:right;font-weight:700;">$${r.paidPerMile.toFixed(2)}</td>
                <td style="padding:8px 12px;font-size:12px;text-align:right;color:#6b7280;">$${r.marketRate.toFixed(2)}</td>
                <td style="padding:8px 12px;font-size:12px;text-align:right;font-weight:700;color:${clsColor};">${r.deltaPct > 0 ? "+" : ""}${r.deltaPct.toFixed(1)}%</td>
                <td style="padding:8px 12px;font-size:11px;text-align:right;color:${clsColor};font-weight:700;">${clsLabel}</td>
              </tr>`;
            }).join("");
            scorecardRateHtml = `
              <div style="padding:16px 24px;background:#fff;border-top:1px solid #e5e7eb;">
                <h3 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin:0 0 10px;">◎ Rate Positioning Summary</h3>
                <div style="display:flex;gap:12px;margin-bottom:12px;">
                  <div style="flex:1;background:#fef2f2;border-radius:8px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:900;color:#dc2626;">${aboveCount}</div><div style="font-size:10px;color:#991b1b;">Above Market</div></div>
                  <div style="flex:1;background:#fffbeb;border-radius:8px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:900;color:#ca8a04;">${atCount}</div><div style="font-size:10px;color:#92400e;">At Market</div></div>
                  <div style="flex:1;background:#f0fdf4;border-radius:8px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:900;color:#16a34a;">${belowCount}</div><div style="font-size:10px;color:#14532d;">Below Market</div></div>
                </div>
                ${tighteningLanes.length > 0 ? `<div style="margin-bottom:10px;font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 12px;">⚡ Act this week — tightening forecast: <strong style="text-transform:capitalize;">${tighteningLanes.slice(0, 3).join(", ")}</strong></div>` : ""}
                <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                  <thead><tr style="background:#f3f4f6;">
                    <th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;">Lane</th>
                    <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;">Paid $/mi</th>
                    <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;">Market $/mi</th>
                    <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;">Delta</th>
                    <th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;">Position</th>
                  </tr></thead>
                  <tbody>${rowsHtml}</tbody>
                </table>
              </div>`;
          }
        }
      } catch (err: any) {
        logIntel(`Scorecard rate positioning section error: ${err.message}`);
      }

      for (const admin of adminUsers) {
        const html = buildScorecardEmail({
          recipientName: admin.name.split(" ")[0],
          dateStr,
          totalLoads,
          totalRevenue,
          overallMarginPct,
          lanesHtml,
          ratePositioningHtml: scorecardRateHtml,
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
