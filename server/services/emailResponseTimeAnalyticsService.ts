/**
 * Email response time analytics (Task #414).
 *
 * Pairs each inbound customer email with the *next outbound reply on the
 * same thread*. Computes wall-clock and business-hours (Mon–Fri 8a–6p local)
 * elapsed time. Carrier threads are excluded.
 *
 * Sender attribution: the spec defines response time as the gap to the next
 * outbound reply *from the assigned rep*. email_messages has no
 * sender_user_id, but `users.username` is generally the rep's email address.
 * We therefore match outbound from_email (case-insensitive) against the
 * thread owner's username when that username is email-shaped (contains '@').
 * When it is not — e.g. legacy non-email usernames — we fall back to "any
 * outbound on the thread" and the comment block remains accurate. A future
 * sender_user_id column on email_messages would let us drop the fallback
 * entirely.
 */

import { storage } from "../storage";

// Hard cap on the number of inbound rows we'll process per request. Generous
// enough to cover a year of activity for most orgs; we log a warning if hit
// so we can tune (or paginate) before silent truncation becomes a concern.
const PAIR_ROW_LIMIT = 100000;

const BUSINESS_TZ = "America/New_York";
const BIZ_START_HOUR = 8;
const BIZ_END_HOUR = 18;

// ─── Timezone helpers ────────────────────────────────────────────────────────

function localParts(d: Date): { y: number; m: number; day: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    day: Number(get("day")),
    weekday: get("weekday"),
  };
}

function getTzOffsetMs(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const localMs = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return localMs - d.getTime();
}

function utcMsForLocalHour(y: number, m: number, day: number, hour: number): number {
  const probe = new Date(Date.UTC(y, m - 1, day, 12, 0, 0));
  const offset = getTzOffsetMs(probe);
  return Date.UTC(y, m - 1, day, hour, 0, 0) - offset;
}

const WEEKEND = new Set(["Sat", "Sun"]);

/**
 * Compute total ms of overlap between [startUtc, endUtc] and the
 * business-hours window (Mon–Fri 8am–6pm local).
 */
export function businessHoursMs(startUtc: number, endUtc: number): number {
  if (endUtc <= startUtc) return 0;

  let total = 0;
  // Walk by local calendar days. Start from start's local date.
  const startLocal = localParts(new Date(startUtc));
  let y = startLocal.y;
  let m = startLocal.m;
  let day = startLocal.day;

  // Safety cap — never iterate more than 400 days.
  for (let i = 0; i < 400; i++) {
    const dayStartUtc = utcMsForLocalHour(y, m, day, BIZ_START_HOUR);
    const dayEndUtc = utcMsForLocalHour(y, m, day, BIZ_END_HOUR);

    if (dayStartUtc > endUtc) break;

    const wd = localParts(new Date(dayStartUtc)).weekday;
    if (!WEEKEND.has(wd)) {
      const overlapStart = Math.max(startUtc, dayStartUtc);
      const overlapEnd = Math.min(endUtc, dayEndUtc);
      if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
    }

    // Advance one calendar day in local TZ.
    const next = new Date(Date.UTC(y, m - 1, day) + 36 * 60 * 60 * 1000); // add 36h to safely cross DST boundaries
    const np = localParts(next);
    y = np.y;
    m = np.m;
    day = np.day;
  }

  return total;
}

// ─── Stats helpers ───────────────────────────────────────────────────────────

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface ResponseTimeFilters {
  orgId: string;
  start: Date;
  end: Date;
  repIds?: string[]; // optional
  accountId?: string; // optional
  businessHours: boolean;
}

export interface ResponsePair {
  inboundId: string;
  threadId: string;
  inboundAt: Date;
  outboundAt: Date | null; // null = still waiting
  ownerUserId: string | null;
  ownerName: string | null;
  accountId: string | null;
  accountName: string | null;
  subject: string | null;
  fromEmail: string | null;
  wallMs: number | null;
  bizMs: number | null;
}

// ─── Core query ──────────────────────────────────────────────────────────────

/**
 * Pulls every inbound customer email in [start, end] and the next outbound
 * reply on the same thread. Threads tied to a carrier (linked_carrier_id)
 * are excluded — this is customer email only.
 */
export async function fetchResponsePairs(filters: ResponseTimeFilters): Promise<ResponsePair[]> {
  const { orgId, start, end, repIds, accountId } = filters;

  const params: unknown[] = [orgId, start.toISOString(), end.toISOString()];
  let repFilter = "";
  if (repIds && repIds.length > 0) {
    params.push(repIds);
    repFilter = `AND ect.owner_user_id = ANY($${params.length}::varchar[])`;
  }
  let accountFilter = "";
  if (accountId) {
    params.push(accountId);
    accountFilter = `AND COALESCE(ect.linked_account_id, inb.linked_account_id) = $${params.length}`;
  }

  const sql = `
    SELECT
      inb.id            AS inbound_id,
      inb.thread_id     AS thread_id,
      inb.created_at    AS inbound_at,
      inb.from_email    AS from_email,
      inb.subject       AS subject,
      COALESCE(ect.linked_account_id, inb.linked_account_id) AS account_id,
      ect.owner_user_id AS owner_user_id,
      u.name            AS owner_name,
      c.name            AS account_name,
      (
        SELECT outb.created_at
        FROM email_messages outb
        WHERE outb.org_id = inb.org_id
          AND outb.thread_id = inb.thread_id
          AND outb.direction = 'outbound'
          AND outb.created_at > inb.created_at
          -- Restrict to outbound *from the assigned owner* when we have an
          -- email-shaped username we can match against. Otherwise (non-email
          -- username, no owner, etc.) fall back to any outbound on the thread.
          AND (
            u.username IS NULL
            OR u.username NOT LIKE '%@%'
            OR LOWER(outb.from_email) = LOWER(u.username)
          )
        ORDER BY outb.created_at ASC
        LIMIT 1
      ) AS outbound_at
    FROM email_messages inb
    LEFT JOIN email_conversation_threads ect
      ON ect.org_id = inb.org_id AND ect.thread_id = inb.thread_id
    LEFT JOIN users u ON u.id = ect.owner_user_id
    LEFT JOIN companies c ON c.id = COALESCE(ect.linked_account_id, inb.linked_account_id)
    WHERE inb.org_id = $1
      AND inb.direction = 'inbound'
      AND inb.thread_id IS NOT NULL
      AND inb.created_at >= $2
      AND inb.created_at < $3
      AND inb.linked_carrier_id IS NULL
      AND (ect.linked_carrier_id IS NULL OR ect.id IS NULL)
      AND (COALESCE(ect.linked_account_id, inb.linked_account_id) IS NOT NULL)
      ${repFilter}
      ${accountFilter}
    ORDER BY inb.created_at DESC
    LIMIT $${params.push(PAIR_ROW_LIMIT)}
  `;

  const result = await storage.pool.query(sql, params);
  if (result.rows.length >= PAIR_ROW_LIMIT) {
    console.warn(
      `[email-response-time] hit row limit (${PAIR_ROW_LIMIT}) for org=${orgId} ` +
      `range=${start.toISOString()}..${end.toISOString()} — aggregates may be truncated`,
    );
  }

  return result.rows.map((r: Record<string, unknown>) => {
    const inboundAt = new Date(r.inbound_at as string);
    const outboundAt = r.outbound_at ? new Date(r.outbound_at as string) : null;
    const wallMs = outboundAt ? outboundAt.getTime() - inboundAt.getTime() : null;
    const bizMs = outboundAt ? businessHoursMs(inboundAt.getTime(), outboundAt.getTime()) : null;
    return {
      inboundId: r.inbound_id as string,
      threadId: r.thread_id as string,
      inboundAt,
      outboundAt,
      ownerUserId: (r.owner_user_id as string) ?? null,
      ownerName: (r.owner_name as string) ?? null,
      accountId: (r.account_id as string) ?? null,
      accountName: (r.account_name as string) ?? null,
      subject: (r.subject as string) ?? null,
      fromEmail: (r.from_email as string) ?? null,
      wallMs,
      bizMs,
    };
  });
}

// ─── Aggregations ────────────────────────────────────────────────────────────

function pickMs(p: ResponsePair, biz: boolean): number | null {
  return biz ? p.bizMs : p.wallMs;
}

export interface KpiBucket {
  label: string;
  start: Date;
  end: Date;
  avgMs: number | null;
  medianMs: number | null;
  count: number;
  waiting: number;
}

export function summarizeBucket(pairs: ResponsePair[], biz: boolean, label: string, start: Date, end: Date): KpiBucket {
  const responded = pairs.filter((p) => p.outboundAt != null);
  const waiting = pairs.length - responded.length;
  const ms = responded.map((p) => pickMs(p, biz)).filter((v): v is number => v != null && v >= 0);
  return {
    label,
    start,
    end,
    avgMs: avg(ms),
    medianMs: median(ms),
    count: ms.length,
    waiting,
  };
}

export interface RepLeaderboardRow {
  ownerUserId: string;
  ownerName: string;
  count: number;
  waiting: number;
  avgMs: number | null;
  medianMs: number | null;
}

export function buildLeaderboard(pairs: ResponsePair[], biz: boolean): RepLeaderboardRow[] {
  const byRep = new Map<string, ResponsePair[]>();
  for (const p of pairs) {
    if (!p.ownerUserId) continue;
    const arr = byRep.get(p.ownerUserId) ?? [];
    arr.push(p);
    byRep.set(p.ownerUserId, arr);
  }
  const rows: RepLeaderboardRow[] = [];
  for (const [ownerUserId, list] of Array.from(byRep.entries())) {
    const responded = list.filter((p) => p.outboundAt != null);
    const ms = responded.map((p) => pickMs(p, biz)).filter((v): v is number => v != null && v >= 0);
    rows.push({
      ownerUserId,
      ownerName: list[0].ownerName ?? "Unknown",
      count: responded.length,
      waiting: list.length - responded.length,
      avgMs: avg(ms),
      medianMs: median(ms),
    });
  }
  rows.sort((a, b) => {
    if (a.avgMs == null && b.avgMs == null) return 0;
    if (a.avgMs == null) return 1;
    if (b.avgMs == null) return -1;
    return a.avgMs - b.avgMs;
  });
  return rows;
}

export interface SlowestThreadRow {
  inboundId: string;
  threadId: string;
  inboundAt: Date;
  outboundAt: Date | null;
  ageMs: number; // either response time, or current age if waiting
  isWaiting: boolean;
  ownerName: string | null;
  ownerUserId: string | null;
  accountName: string | null;
  accountId: string | null;
  subject: string | null;
  fromEmail: string | null;
}

export function buildSlowestThreads(
  pairs: ResponsePair[],
  biz: boolean,
  now: Date,
  limit = 25,
): SlowestThreadRow[] {
  const rows: SlowestThreadRow[] = pairs.map((p) => {
    if (p.outboundAt) {
      const ms = pickMs(p, biz) ?? 0;
      return {
        inboundId: p.inboundId,
        threadId: p.threadId,
        inboundAt: p.inboundAt,
        outboundAt: p.outboundAt,
        ageMs: ms,
        isWaiting: false,
        ownerName: p.ownerName,
        ownerUserId: p.ownerUserId,
        accountName: p.accountName,
        accountId: p.accountId,
        subject: p.subject,
        fromEmail: p.fromEmail,
      };
    }
    const ms = biz
      ? businessHoursMs(p.inboundAt.getTime(), now.getTime())
      : now.getTime() - p.inboundAt.getTime();
    return {
      inboundId: p.inboundId,
      threadId: p.threadId,
      inboundAt: p.inboundAt,
      outboundAt: null,
      ageMs: ms,
      isWaiting: true,
      ownerName: p.ownerName,
      ownerUserId: p.ownerUserId,
      accountName: p.accountName,
      accountId: p.accountId,
      subject: p.subject,
      fromEmail: p.fromEmail,
    };
  });
  rows.sort((a, b) => b.ageMs - a.ageMs);
  return rows.slice(0, limit);
}

// ─── Time series bucketing ───────────────────────────────────────────────────

export type Granularity = "day" | "week" | "month";

function bucketKey(d: Date, g: Granularity): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (g === "month") return `${y}-${String(m).padStart(2, "0")}`;
  if (g === "day") return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // week — ISO-ish: bucket by Monday of the week (UTC)
  const dt = new Date(Date.UTC(y, m - 1, day));
  const wd = dt.getUTCDay() || 7; // 1..7 (Mon..Sun)
  dt.setUTCDate(dt.getUTCDate() - (wd - 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export interface TimeseriesPoint {
  bucket: string;
  avgMs: number | null;
  medianMs: number | null;
  count: number;
}

export function buildTimeseries(
  pairs: ResponsePair[],
  biz: boolean,
  granularity: Granularity,
): TimeseriesPoint[] {
  const groups = new Map<string, number[]>();
  for (const p of pairs) {
    if (!p.outboundAt) continue;
    const ms = pickMs(p, biz);
    if (ms == null || ms < 0) continue;
    const key = bucketKey(p.inboundAt, granularity);
    const arr = groups.get(key) ?? [];
    arr.push(ms);
    groups.set(key, arr);
  }
  const points: TimeseriesPoint[] = Array.from(groups.entries())
    .map(([bucket, vals]) => ({
      bucket,
      avgMs: avg(vals),
      medianMs: median(vals),
      count: vals.length,
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
  return points;
}
