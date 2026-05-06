/**
 * Email response time analytics (Tasks #414 + #602).
 *
 * One row per rep "response event" plus one row per "still-waiting" thread.
 * A response event is a single outbound reply paired with the most recent
 * inbound on the same thread that arrived strictly before it; the gap is
 * outbound_sent_at − last_inbound_sent_at. Wall-clock and business-hours
 * (Mon–Fri 8a–6p local) elapsed time are computed for every event.
 * Carrier threads are excluded (this is customer email only).
 *
 * Why "one row per outbound, not one per inbound": chatty customers often
 * send many emails in a burst before the rep replies once. Pairing every
 * inbound with the same outbound double-counts the gap and badly inflates
 * avg/median response time when a real rep is, in fact, responsive. This
 * model collapses each customer-side burst into a single response event
 * timed from the customer's last message in the burst.
 *
 * Why provider_sent_at, not created_at: created_at is the row insert time
 * in our DB, which can lag the actual send by hours or days for backfilled
 * Outlook syncs. provider_sent_at is the timestamp Microsoft Graph reports
 * for the message; we fall back to created_at only when provider_sent_at
 * is missing (legacy rows).
 *
 * Sender attribution (Task #602): email_messages has no sender_user_id,
 * so we resolve at query time using a per-org email→user index built
 * from:
 *   • users.username when email-shaped (case-insensitive)
 *   • monitored_mailboxes.email rows owned by that user
 *   • alias-stripped variants ("rep+something@x.com" → "rep@x.com")
 * Replies are credited to the resolved sender. Only when no sender match is
 * found do we fall back to the thread owner (the legacy behaviour). This
 * captures replies sent from aliases, shared inboxes, and threads that were
 * never assigned to an owner — without those, hundreds of replies were
 * landing in org-wide totals but disappearing from the per-rep leaderboard.
 *
 * Replies that still cannot be attributed surface as a single "Unattributed"
 * leaderboard row so leadership can drill in and assign owners. The waiting
 * clear check uses the same resolution rule so a rep replying from an alias
 * correctly stops the wait clock.
 */

import { storage } from "../storage";

// Hard cap on the number of inbound rows we'll process per request. Generous
// enough to cover a year of activity for most orgs; we log a warning if hit
// so we can tune (or paginate) before silent truncation becomes a concern.
const PAIR_ROW_LIMIT = 100000;

const BUSINESS_TZ = "America/New_York";
const BIZ_START_HOUR = 8;
const BIZ_END_HOUR = 18;

// Sentinel id used to bucket replies whose from_email cannot be resolved to
// any rep, in either the leaderboard or the slowest-threads list.
export const UNATTRIBUTED_SENDER_ID = "__unattributed__";

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

/**
 * Return the local ET day-of-week (0=Sun..6=Sat) and hour-of-day (0..23)
 * for a UTC timestamp. Used for the response-time heatmap so DST handling
 * lines up with the business-hours window above.
 */
export function etDayOfWeekHour(d: Date): { weekday: number; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
  }).formatToParts(d);
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wd = wdMap[fmt.find((p) => p.type === "weekday")?.value ?? ""] ?? 0;
  let hr = Number(fmt.find((p) => p.type === "hour")?.value ?? 0);
  if (hr === 24) hr = 0;
  return { weekday: wd, hour: hr };
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

/**
 * Nearest-rank percentile (0..100). Returns null on an empty input.
 * Used by the weekly trend so leaders can spot p90 drift even when the
 * median looks flat — a few worst-case responses are usually what burns
 * customers, and a tail-only regression won't move the median.
 */
function percentile(nums: number[], p: number): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

// ─── Sender attribution index ────────────────────────────────────────────────

export interface SenderUserDirectoryEntry {
  userId: string;
  name: string;
  email: string;
}

export interface SenderUserDirectory {
  /** lower-cased email → {userId, name, sourceEmail} */
  byEmail: Map<string, SenderUserDirectoryEntry>;
  /** lower-cased email with alias suffix stripped → entry */
  byBaseEmail: Map<string, SenderUserDirectoryEntry>;
  /** all known users in the org, for diagnostics */
  users: Array<{ id: string; name: string; username: string }>;
}

/**
 * Strip a "+suffix" alias from the local-part of an email.
 *   "rep+invoices@example.com" → "rep@example.com"
 *   "rep@example.com"          → "rep@example.com"
 */
export function stripEmailAlias(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const plus = local.indexOf("+");
  return plus < 0 ? trimmed : `${local.slice(0, plus)}@${domain}`;
}

function isEmailShaped(value: string | null | undefined): value is string {
  return !!value && value.includes("@");
}

/**
 * Build the per-org email→user index used to attribute outbound replies.
 * Pulls from users.username (when email-shaped) and monitored_mailboxes.
 * Adds an alias-stripped variant of every entry so "rep+invoices@x" matches
 * "rep@x".
 */
export async function buildSenderUserDirectory(orgId: string): Promise<SenderUserDirectory> {
  const userResult = await storage.pool.query<{ id: string; name: string | null; username: string }>(
    `SELECT id, name, username FROM users WHERE organization_id = $1`,
    [orgId],
  );
  const mailboxResult = await storage.pool.query<{ user_id: string; email: string }>(
    `SELECT user_id, email FROM monitored_mailboxes WHERE org_id = $1`,
    [orgId],
  );

  const userById = new Map<string, { id: string; name: string; username: string }>();
  for (const row of userResult.rows) {
    userById.set(row.id, { id: row.id, name: row.name ?? row.username, username: row.username });
  }

  const byEmail = new Map<string, SenderUserDirectoryEntry>();
  const byBaseEmail = new Map<string, SenderUserDirectoryEntry>();

  function add(email: string, userId: string) {
    const u = userById.get(userId);
    if (!u) return;
    const lower = email.trim().toLowerCase();
    if (!lower.includes("@")) return;
    const entry: SenderUserDirectoryEntry = { userId, name: u.name, email: lower };
    if (!byEmail.has(lower)) byEmail.set(lower, entry);
    const base = stripEmailAlias(lower);
    if (!byBaseEmail.has(base)) byBaseEmail.set(base, entry);
  }

  for (const u of userResult.rows) {
    if (isEmailShaped(u.username)) add(u.username, u.id);
  }
  for (const mb of mailboxResult.rows) {
    add(mb.email, mb.user_id);
  }

  return {
    byEmail,
    byBaseEmail,
    users: Array.from(userById.values()),
  };
}

/**
 * Resolve a rep's userId from an outbound from_email. Returns null when no
 * match is found in the directory (the caller decides whether to fall back
 * to the assigned thread owner).
 */
export function resolveSenderUserId(
  fromEmail: string | null | undefined,
  directory: SenderUserDirectory,
): { userId: string; name: string } | null {
  if (!fromEmail) return null;
  const lower = fromEmail.trim().toLowerCase();
  if (!lower.includes("@")) return null;
  const exact = directory.byEmail.get(lower);
  if (exact) return { userId: exact.userId, name: exact.name };
  const base = stripEmailAlias(lower);
  const aliased = directory.byBaseEmail.get(base);
  if (aliased) return { userId: aliased.userId, name: aliased.name };
  return null;
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
  /** Thread's assigned owner (may be null for unassigned threads). */
  ownerUserId: string | null;
  ownerName: string | null;
  /** Resolved sender of the outbound reply (preferred over ownerUserId). */
  senderUserId: string | null;
  senderName: string | null;
  accountId: string | null;
  accountName: string | null;
  subject: string | null;
  fromEmail: string | null;
  wallMs: number | null;
  bizMs: number | null;
}

// ─── Core query ──────────────────────────────────────────────────────────────

interface RawReplyRow {
  row_id: string;
  thread_id: string;
  outbound_at: string;
  from_email: string | null;
  subject: string | null;
  account_id: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  account_name: string | null;
  inbound_at: string | null;
}

interface RawWaitingRow {
  row_id: string;
  thread_id: string;
  org_id: string;
  inbound_at: string;
  from_email: string | null;
  subject: string | null;
  account_id: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  account_name: string | null;
}

/**
 * Pulls two kinds of rows for the requested window, both keyed on
 * provider_sent_at (falling back to created_at):
 *
 *   1. RESPONSE EVENTS — one row per outbound reply that has at least one
 *      prior inbound on the same thread. inboundAt = the most recent
 *      inbound's send time; outboundAt = the outbound's send time.
 *      Sender is resolved client-side via the email→user directory so a
 *      reply from an alias still gets credited to the right rep.
 *
 *   2. WAITING THREADS — one row per thread whose latest message in the
 *      window is inbound (no subsequent outbound reply yet). outboundAt
 *      is null; inboundAt = the latest inbound's send time. The "latest
 *      outbound clears the wait" check is performed in JS using the same
 *      sender-resolution rule as the replies query.
 *
 * Both kinds are filtered by the same owner / account / carrier-exclusion
 * rules. Aggregations downstream treat outboundAt != null as "responded"
 * and outboundAt == null as "waiting".
 */
export async function fetchResponsePairs(filters: ResponseTimeFilters): Promise<ResponsePair[]> {
  const { orgId, start, end, repIds, accountId } = filters;

  const directory = await buildSenderUserDirectory(orgId);

  const params: unknown[] = [orgId, start.toISOString(), end.toISOString()];
  let accountFilter = "";
  if (accountId) {
    params.push(accountId);
    accountFilter = `AND COALESCE(ect.linked_account_id, em.linked_account_id) = $${params.length}`;
  }

  // ── Part 1: response events (one per outbound reply with prior inbound) ──
  // We restrict the OUTBOUND's send time to [start, end). The matching prior
  // inbound can be older — that's fine, it just means the customer wrote
  // before the window opened and the rep replied inside the window.
  //
  // No SQL-side sender or rep filter — sender attribution is done in JS so
  // alias / shared-inbox / unassigned-thread replies flow through. The
  // optional `repIds` filter is also applied in JS against
  // attributedSenderId(...) so a rep gets credit for replies they actually
  // sent on threads owned by someone else (or unassigned), matching the
  // leaderboard's attribution rules.
  const sqlReplies = `
    SELECT
      em.id            AS row_id,
      em.thread_id     AS thread_id,
      COALESCE(em.provider_sent_at, em.created_at) AS outbound_at,
      em.from_email    AS from_email,
      em.subject       AS subject,
      COALESCE(ect.linked_account_id, em.linked_account_id) AS account_id,
      ect.owner_user_id AS owner_user_id,
      u.name           AS owner_name,
      c.name           AS account_name,
      (
        SELECT MAX(COALESCE(inb.provider_sent_at, inb.created_at))
        FROM email_messages inb
        WHERE inb.org_id = em.org_id
          AND inb.thread_id = em.thread_id
          AND inb.direction = 'inbound'
          AND COALESCE(inb.provider_sent_at, inb.created_at)
              < COALESCE(em.provider_sent_at, em.created_at)
      ) AS inbound_at
    FROM email_messages em
    LEFT JOIN email_conversation_threads ect
      ON ect.org_id = em.org_id AND ect.thread_id = em.thread_id
    LEFT JOIN users u ON u.id = ect.owner_user_id
    LEFT JOIN companies c ON c.id = COALESCE(ect.linked_account_id, em.linked_account_id)
    WHERE em.org_id = $1
      AND em.direction = 'outbound'
      AND em.thread_id IS NOT NULL
      AND COALESCE(em.provider_sent_at, em.created_at) >= $2
      AND COALESCE(em.provider_sent_at, em.created_at) < $3
      AND em.linked_carrier_id IS NULL
      AND (ect.linked_carrier_id IS NULL OR ect.id IS NULL)
      -- Lane discriminator: customer-mailbox lane vs carrier-outreach lane.
      -- The user-mailbox ingest lane never sets linked_outreach_log_id; the
      -- carrier-outreach send-grid lane always does. We previously required
      -- COALESCE(ect.linked_account_id, em.linked_account_id) IS NOT NULL,
      -- but linked_account_id is rarely populated on outbound rows (and the
      -- thread tag depends on contact-match having succeeded on a prior
      -- inbound), so legitimate replies were silently dropped from today's
      -- leaderboard whenever inbound contact-match hadn't run yet.
      AND em.linked_outreach_log_id IS NULL
      ${accountFilter}
    ORDER BY COALESCE(em.provider_sent_at, em.created_at) DESC
    LIMIT $${params.push(PAIR_ROW_LIMIT)}
  `;

  // ── Part 2: latest inbound per thread in the window ──────────────────────
  // We need to know whether ANY outbound after that inbound resolved the
  // wait. The original "owner-username only" SQL filter dropped alias /
  // shared-inbox replies and incorrectly left those threads stuck on
  // waiting. We now load every outbound on each candidate thread that
  // happened after the latest inbound and filter in JS using the directory.
  const waitingParams: unknown[] = [orgId, start.toISOString(), end.toISOString()];
  let repFilterW = "";
  if (repIds && repIds.length > 0) {
    waitingParams.push(repIds);
    repFilterW = `AND ect.owner_user_id = ANY($${waitingParams.length}::varchar[])`;
  }
  let accountFilterW = "";
  if (accountId) {
    waitingParams.push(accountId);
    accountFilterW = `AND COALESCE(ect.linked_account_id, inb.linked_account_id) = $${waitingParams.length}`;
  }
  const sqlLatestInbound = `
    SELECT DISTINCT ON (inb.thread_id)
      inb.id          AS row_id,
      inb.thread_id   AS thread_id,
      inb.org_id      AS org_id,
      COALESCE(inb.provider_sent_at, inb.created_at) AS inbound_at,
      inb.from_email  AS from_email,
      inb.subject     AS subject,
      COALESCE(ect.linked_account_id, inb.linked_account_id) AS account_id,
      ect.owner_user_id AS owner_user_id,
      u.name          AS owner_name,
      c.name          AS account_name
    FROM email_messages inb
    LEFT JOIN email_conversation_threads ect
      ON ect.org_id = inb.org_id AND ect.thread_id = inb.thread_id
    LEFT JOIN users u ON u.id = ect.owner_user_id
    LEFT JOIN companies c ON c.id = COALESCE(ect.linked_account_id, inb.linked_account_id)
    WHERE inb.org_id = $1
      AND inb.direction = 'inbound'
      AND inb.thread_id IS NOT NULL
      AND COALESCE(inb.provider_sent_at, inb.created_at) >= $2
      AND COALESCE(inb.provider_sent_at, inb.created_at) < $3
      AND inb.linked_carrier_id IS NULL
      AND (ect.linked_carrier_id IS NULL OR ect.id IS NULL)
      -- Same lane discriminator as the replies query above — see comment.
      AND inb.linked_outreach_log_id IS NULL
      ${repFilterW}
      ${accountFilterW}
    ORDER BY inb.thread_id, COALESCE(inb.provider_sent_at, inb.created_at) DESC
    LIMIT $${waitingParams.push(PAIR_ROW_LIMIT)}
  `;

  const [repliesResult, latestInboundResult] = await Promise.all([
    storage.pool.query<RawReplyRow>(sqlReplies, params),
    storage.pool.query<RawWaitingRow>(sqlLatestInbound, waitingParams),
  ]);
  if (repliesResult.rows.length >= PAIR_ROW_LIMIT || latestInboundResult.rows.length >= PAIR_ROW_LIMIT) {
    console.warn(
      `[email-response-time] hit row limit (${PAIR_ROW_LIMIT}) for org=${orgId} ` +
      `range=${start.toISOString()}..${end.toISOString()} — aggregates may be truncated`,
    );
  }

  // ── Resolve waiting threads against any outbound after the latest inbound.
  // We pull the outbounds for the candidate threads in one round-trip and
  // check sender attribution in JS.
  let stillWaiting: RawWaitingRow[] = latestInboundResult.rows;
  if (latestInboundResult.rows.length > 0) {
    const threadIds = latestInboundResult.rows.map((r) => r.thread_id);
    const outboundResult = await storage.pool.query<{
      thread_id: string; from_email: string | null; outbound_at: string;
    }>(
      `SELECT thread_id, from_email,
              COALESCE(provider_sent_at, created_at) AS outbound_at
         FROM email_messages
        WHERE org_id = $1
          AND direction = 'outbound'
          AND thread_id = ANY($2::text[])
          AND linked_carrier_id IS NULL
          AND COALESCE(provider_sent_at, created_at) IS NOT NULL`,
      [orgId, threadIds],
    );
    const outboundsByThread = new Map<string, Array<{ at: number; from: string | null }>>();
    for (const r of outboundResult.rows) {
      const arr = outboundsByThread.get(r.thread_id) ?? [];
      arr.push({ at: new Date(r.outbound_at).getTime(), from: r.from_email });
      outboundsByThread.set(r.thread_id, arr);
    }
    stillWaiting = latestInboundResult.rows.filter((row) => {
      const inboundMs = new Date(row.inbound_at).getTime();
      const outs = outboundsByThread.get(row.thread_id) ?? [];
      // Any outbound after the latest inbound clears the wait. This matches
      // the replies query (sqlReplies) which counts any post-inbound outbound
      // as a reply event regardless of whether the sender resolves to a known
      // user or whether the thread has an assigned owner. Without this
      // parity, an unassigned thread whose reply came from an unattributed
      // address ("alias+suffix@", shared mailbox, forwarder, etc.) would be
      // double-counted: appearing both as a reply event and as still-waiting,
      // inflating the waiting count and breaking the leaderboard reconcile.
      return !outs.some((o) => o.at > inboundMs);
    });
  }

  const replies: ResponsePair[] = repliesResult.rows
    .filter((r) => r.inbound_at != null)
    .map((r) => {
      const inboundAt = new Date(r.inbound_at as string);
      const outboundAt = new Date(r.outbound_at);
      const wallMs = outboundAt.getTime() - inboundAt.getTime();
      const bizMs = businessHoursMs(inboundAt.getTime(), outboundAt.getTime());
      const sender = resolveSenderUserId(r.from_email, directory);
      return {
        inboundId: r.row_id,
        threadId: r.thread_id,
        inboundAt,
        outboundAt,
        ownerUserId: r.owner_user_id ?? null,
        ownerName: r.owner_name ?? null,
        senderUserId: sender?.userId ?? null,
        senderName: sender?.name ?? null,
        accountId: r.account_id ?? null,
        accountName: r.account_name ?? null,
        subject: r.subject ?? null,
        fromEmail: r.from_email ?? null,
        wallMs,
        bizMs,
      } satisfies ResponsePair;
    });

  const waiting: ResponsePair[] = stillWaiting.map((r) => {
    const inboundAt = new Date(r.inbound_at);
    return {
      inboundId: r.row_id,
      threadId: r.thread_id,
      inboundAt,
      outboundAt: null,
      ownerUserId: r.owner_user_id ?? null,
      ownerName: r.owner_name ?? null,
      senderUserId: null,
      senderName: null,
      accountId: r.account_id ?? null,
      accountName: r.account_name ?? null,
      subject: r.subject ?? null,
      fromEmail: r.from_email ?? null,
      wallMs: null,
      bizMs: null,
    } satisfies ResponsePair;
  });

  // Apply the rep filter on REPLIES using attribution (resolved sender,
  // then owner, then unattributed) so a rep gets credit for replies they
  // actually sent on threads owned by another rep or unassigned. Waiting
  // rows have no sender, so we filter them by assigned owner only.
  const repIdSet = repIds && repIds.length > 0 ? new Set(repIds) : null;
  const filteredReplies = repIdSet
    ? replies.filter((p) => {
        const id = attributedSenderId(p);
        return id !== UNATTRIBUTED_SENDER_ID && repIdSet.has(id);
      })
    : replies;
  const filteredWaiting = repIdSet
    ? waiting.filter((p) => p.ownerUserId !== null && repIdSet.has(p.ownerUserId))
    : waiting;

  return [...filteredReplies, ...filteredWaiting];
}

// ─── Aggregations ────────────────────────────────────────────────────────────

function pickMs(p: ResponsePair, biz: boolean): number | null {
  return biz ? p.bizMs : p.wallMs;
}

/**
 * The id we credit a reply against in the leaderboard. Prefer the resolved
 * sender (when from_email matched a rep), then the assigned thread owner,
 * then the unattributed sentinel.
 */
export function attributedSenderId(p: ResponsePair): string {
  if (p.senderUserId) return p.senderUserId;
  if (p.ownerUserId) return p.ownerUserId;
  return UNATTRIBUTED_SENDER_ID;
}

export function attributedSenderName(p: ResponsePair): string {
  if (p.senderUserId) return p.senderName ?? "Unknown";
  if (p.ownerUserId) return p.ownerName ?? "Unknown";
  return "Unattributed";
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
  /** True for the synthetic "Unattributed" row. */
  unattributed?: boolean;
  /**
   * Raw role from the users table for this rep, used by the client to
   * split the leaderboard into Customer Facing vs Carrier Facing tabs
   * (Task #798). null for the synthetic "Unattributed" row and for any
   * rep whose role can't be resolved.
   */
  role?: string | null;
  /**
   * Derived cohort for the per-rep leaderboard tabs (Task #798):
   *   "customer" — National Account Manager (NAM) or Account Manager (AM)
   *   "carrier"  — Logistics Manager (LM)
   *   null       — Unattributed row, or any role outside NAM/AM/LM
   */
  cohort?: "customer" | "carrier" | null;
}

/**
 * Map a users.role value to the leaderboard cohort used by the
 * Customer/Carrier Facing tabs (Task #798). Anyone outside NAM/AM/LM
 * (e.g. logistics_coordinator, sales, directors, admins) is excluded
 * from both tabs by getting a null cohort.
 */
export function roleToCohort(role: string | null | undefined): "customer" | "carrier" | null {
  if (!role) return null;
  if (role === "national_account_manager" || role === "account_manager") return "customer";
  if (role === "logistics_manager") return "carrier";
  return null;
}

export function buildLeaderboard(
  pairs: ResponsePair[],
  biz: boolean,
  userRoleById?: Map<string, string | null>,
): RepLeaderboardRow[] {
  const byRep = new Map<string, ResponsePair[]>();
  // Bucket replies by their attributed sender (real rep, or Unattributed).
  for (const p of pairs.filter((p) => p.outboundAt != null)) {
    const id = attributedSenderId(p);
    const arr = byRep.get(id) ?? [];
    arr.push(p);
    byRep.set(id, arr);
  }
  // Bucket waiting threads by their assigned owner only — waiting threads
  // have no sender to resolve. Threads with no owner contribute to the
  // unattributed waiting count so leadership can drill in and assign.
  for (const p of pairs.filter((p) => p.outboundAt == null)) {
    const id = p.ownerUserId ?? UNATTRIBUTED_SENDER_ID;
    const arr = byRep.get(id) ?? [];
    arr.push(p);
    byRep.set(id, arr);
  }

  const rows: RepLeaderboardRow[] = [];
  for (const [id, list] of Array.from(byRep.entries())) {
    const responded = list.filter((p) => p.outboundAt != null);
    const ms = responded.map((p) => pickMs(p, biz)).filter((v): v is number => v != null && v >= 0);
    const namedSample = list.find((p) => attributedSenderId(p) === id);
    const isUnattributed = id === UNATTRIBUTED_SENDER_ID;
    const role = isUnattributed ? null : (userRoleById?.get(id) ?? null);
    rows.push({
      ownerUserId: id,
      ownerName: isUnattributed ? "Unattributed" : (namedSample ? attributedSenderName(namedSample) : "Unknown"),
      count: responded.length,
      waiting: list.length - responded.length,
      avgMs: avg(ms),
      medianMs: median(ms),
      unattributed: isUnattributed,
      role,
      cohort: isUnattributed ? null : roleToCohort(role),
    });
  }
  rows.sort((a, b) => {
    // Unattributed always sorts last so it doesn't crowd out real reps.
    if (a.unattributed && !b.unattributed) return 1;
    if (!a.unattributed && b.unattributed) return -1;
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
  /** Resolved sender of the outbound reply, when different from owner. */
  senderName: string | null;
  senderUserId: string | null;
  accountName: string | null;
  accountId: string | null;
  subject: string | null;
  fromEmail: string | null;
  /** True when this row's reply could not be attributed to any rep. */
  unattributed: boolean;
}

export function buildSlowestThreads(
  pairs: ResponsePair[],
  biz: boolean,
  now: Date,
  limit = 25,
  opts: { unattributedOnly?: boolean } = {},
): SlowestThreadRow[] {
  const rows: SlowestThreadRow[] = pairs.map((p) => {
    const unattributed = attributedSenderId(p) === UNATTRIBUTED_SENDER_ID;
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
        senderName: p.senderName,
        senderUserId: p.senderUserId,
        accountName: p.accountName,
        accountId: p.accountId,
        subject: p.subject,
        fromEmail: p.fromEmail,
        unattributed,
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
      senderName: null,
      senderUserId: null,
      accountName: p.accountName,
      accountId: p.accountId,
      subject: p.subject,
      fromEmail: p.fromEmail,
      unattributed: p.ownerUserId == null,
    };
  });
  const filtered = opts.unattributedOnly ? rows.filter((r) => r.unattributed) : rows;
  filtered.sort((a, b) => b.ageMs - a.ageMs);
  return filtered.slice(0, limit);
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
    const key = bucketKey(p.outboundAt, granularity);
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

// ─── Weekly trend (median + p90 by ISO-week) ─────────────────────────────────
// Anchors each reply on the Monday of the ISO-week that contains its outbound
// send time, then reports median + p90 + count per week so leadership can see
// week-over-week drift in both the typical and worst-case rep response time.

export interface WeeklyTrendPoint {
  /** YYYY-MM-DD of the ISO-week Monday this bucket represents (UTC). */
  weekStart: string;
  /** ISO week-numbering year (may differ from calendar year near Jan 1 / Dec 31). */
  isoYear: number;
  /** ISO week number (1..53). */
  isoWeek: number;
  /** Number of replies in the bucket. */
  count: number;
  /** Median response time in ms (null when count == 0). */
  medianMs: number | null;
  /** p90 response time in ms (null when count == 0). */
  p90Ms: number | null;
}

/**
 * Compute the ISO-week Monday (UTC) plus ISO year/week number for a date.
 * "ISO week" = week starts Monday; week 1 is the week containing Thursday
 * Jan 4 (equivalently, the first Thursday of the ISO year). This matches the
 * definition used by Postgres `EXTRACT(week …)` and ECMA-402.
 */
export function isoWeekParts(d: Date): { weekStart: string; isoYear: number; isoWeek: number } {
  const utcMid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dt = new Date(utcMid);
  const dayNum = dt.getUTCDay() || 7; // 1..7 (Mon..Sun)
  const monday = new Date(utcMid - (dayNum - 1) * 86400000);
  // ISO year is determined by the Thursday of this week.
  const thursday = new Date(monday.getTime() + 3 * 86400000);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
  const isoWeek = Math.round((monday.getTime() - week1Monday.getTime()) / (7 * 86400000)) + 1;
  const y = monday.getUTCFullYear();
  const m = String(monday.getUTCMonth() + 1).padStart(2, "0");
  const day = String(monday.getUTCDate()).padStart(2, "0");
  return { weekStart: `${y}-${m}-${day}`, isoYear, isoWeek };
}

/**
 * Bucket responded pairs by the ISO-week of their outbound send time and
 * return one point per week with median + p90 + reply count. Sorted by
 * weekStart ascending so a recharts LineChart can render directly.
 */
export function buildWeeklyTrend(pairs: ResponsePair[], biz: boolean): WeeklyTrendPoint[] {
  const groups = new Map<string, { values: number[]; isoYear: number; isoWeek: number }>();
  for (const p of pairs) {
    if (!p.outboundAt) continue;
    const ms = pickMs(p, biz);
    if (ms == null || ms < 0) continue;
    const { weekStart, isoYear, isoWeek } = isoWeekParts(p.outboundAt);
    const cur = groups.get(weekStart) ?? { values: [], isoYear, isoWeek };
    cur.values.push(ms);
    groups.set(weekStart, cur);
  }
  return Array.from(groups.entries())
    .map(([weekStart, { values, isoYear, isoWeek }]) => ({
      weekStart,
      isoYear,
      isoWeek,
      count: values.length,
      medianMs: median(values),
      p90Ms: percentile(values, 90),
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// ─── "Right now" snapshot ────────────────────────────────────────────────────
// Surfaces the live state of the inbox, independent of the selected range:
// oldest unanswered customer email, count of waiting threads in age buckets,
// and the rep with the most overdue threads. Auto-refresh every 60s on the
// frontend so reps can monitor without leaving the tab.

export interface RightNowSnapshot {
  oldestWaiting: SlowestThreadRow | null;
  waitingTotal: number;
  waitingOver1h: number;
  waitingOver4h: number;
  waitingOver24h: number;
  topOverdueRep: { ownerUserId: string; ownerName: string; overdueCount: number } | null;
  generatedAt: string;
}

export function buildRightNow(pairs: ResponsePair[], biz: boolean, now: Date): RightNowSnapshot {
  // Derive waiting rows directly from pairs (filter outboundAt == null) rather
  // than routing through buildSlowestThreads(...) with any limit. The previous
  // implementation passed limit=10000 and then filtered for isWaiting, but
  // buildSlowestThreads slices AFTER sorting mixed responded+waiting rows by
  // ageMs — so in an org with thousands of slow responded threads, the
  // waiting rows could fall off the cut and silently disappear from the
  // strip, distorting the oldest-unanswered + overdue counts.
  const waitingRows: SlowestThreadRow[] = pairs
    .filter((p) => p.outboundAt === null)
    .map((p) => {
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
        senderName: null,
        senderUserId: null,
        accountName: p.accountName,
        accountId: p.accountId,
        subject: p.subject,
        fromEmail: p.fromEmail,
        unattributed: p.ownerUserId == null,
      };
    });
  const oldestWaiting = waitingRows.reduce<SlowestThreadRow | null>(
    (max, r) => (max === null || r.ageMs > max.ageMs ? r : max),
    null,
  );
  const HOUR_MS = 60 * 60 * 1000;

  let over1 = 0, over4 = 0, over24 = 0;
  const overdueByOwner = new Map<string, { name: string; count: number }>();
  for (const w of waitingRows) {
    if (w.ageMs > HOUR_MS) over1++;
    if (w.ageMs > 4 * HOUR_MS) over4++;
    if (w.ageMs > 24 * HOUR_MS) over24++;
    if (w.ageMs > 4 * HOUR_MS && w.ownerUserId) {
      const prev = overdueByOwner.get(w.ownerUserId) ?? { name: w.ownerName ?? "Unknown", count: 0 };
      prev.count++;
      overdueByOwner.set(w.ownerUserId, prev);
    }
  }
  let topOwner: RightNowSnapshot["topOverdueRep"] = null;
  for (const [id, v] of Array.from(overdueByOwner.entries())) {
    if (!topOwner || v.count > topOwner.overdueCount) {
      topOwner = { ownerUserId: id, ownerName: v.name, overdueCount: v.count };
    }
  }
  return {
    oldestWaiting,
    waitingTotal: waitingRows.length,
    waitingOver1h: over1,
    waitingOver4h: over4,
    waitingOver24h: over24,
    topOverdueRep: topOwner,
    generatedAt: now.toISOString(),
  };
}

// ─── SLA compliance + per-account outliers ───────────────────────────────────

export interface SlaTarget {
  label: string;
  ms: number;
  /** True = use business-hours elapsed, false = wall-clock. */
  businessHours: boolean;
}

export const DEFAULT_SLA_TARGETS: SlaTarget[] = [
  { label: "1h", ms: 60 * 60 * 1000, businessHours: true },
  { label: "4h", ms: 4 * 60 * 60 * 1000, businessHours: true },
  { label: "24h", ms: 24 * 60 * 60 * 1000, businessHours: true },
];

export interface SlaTargetCompliance {
  label: string;
  ms: number;
  businessHours: boolean;
  total: number;
  withinTarget: number;
  pct: number;
}

export function buildSlaCompliance(pairs: ResponsePair[], targets: SlaTarget[]): SlaTargetCompliance[] {
  const responded = pairs.filter((p) => p.outboundAt != null);
  return targets.map((t) => {
    const total = responded.length;
    const within = responded.filter((p) => {
      const ms = t.businessHours ? p.bizMs : p.wallMs;
      return ms != null && ms >= 0 && ms <= t.ms;
    }).length;
    return {
      label: t.label,
      ms: t.ms,
      businessHours: t.businessHours,
      total,
      withinTarget: within,
      pct: total > 0 ? (within / total) * 100 : 0,
    };
  });
}

export interface AccountOutlier {
  accountId: string;
  accountName: string;
  count: number;
  medianMs: number;
  orgMedianMs: number;
  multiplier: number;
}

export function buildAccountOutliers(pairs: ResponsePair[], biz: boolean, threshold = 2): AccountOutlier[] {
  const responded = pairs.filter((p) => p.outboundAt != null && p.accountId);
  const allMs = responded
    .map((p) => pickMs(p, biz))
    .filter((v): v is number => v != null && v >= 0);
  const orgMedian = median(allMs);
  if (orgMedian == null || orgMedian <= 0) return [];
  const byAccount = new Map<string, { name: string; values: number[] }>();
  for (const p of responded) {
    const ms = pickMs(p, biz);
    if (ms == null || ms < 0) continue;
    const cur = byAccount.get(p.accountId!) ?? { name: p.accountName ?? "Unknown account", values: [] };
    cur.values.push(ms);
    byAccount.set(p.accountId!, cur);
  }
  const outliers: AccountOutlier[] = [];
  for (const [accountId, { name, values }] of Array.from(byAccount.entries())) {
    if (values.length < 3) continue; // Avoid noisy single-reply accounts.
    const m = median(values)!;
    if (m >= orgMedian * threshold) {
      outliers.push({
        accountId,
        accountName: name,
        count: values.length,
        medianMs: m,
        orgMedianMs: orgMedian,
        multiplier: m / orgMedian,
      });
    }
  }
  outliers.sort((a, b) => b.multiplier - a.multiplier);
  return outliers;
}

// ─── Heatmap (DoW × hour, ET) ────────────────────────────────────────────────

export interface HeatmapCell {
  weekday: number; // 0=Sun..6=Sat
  hour: number;    // 0..23 ET
  count: number;
  medianMs: number | null;
}

export function buildHeatmap(pairs: ResponsePair[], biz: boolean): HeatmapCell[] {
  const buckets = new Map<string, number[]>();
  for (const p of pairs) {
    if (!p.outboundAt) continue;
    const ms = pickMs(p, biz);
    if (ms == null || ms < 0) continue;
    // Bucket by the OUTBOUND's ET day-of-week × hour-of-day. Mapping the
    // reply (rather than the inbound) onto the grid keeps the chart aligned
    // with "when does the rep actually send", which is the question
    // leadership asks of this view.
    const { weekday, hour } = etDayOfWeekHour(p.outboundAt);
    const key = `${weekday}:${hour}`;
    const arr = buckets.get(key) ?? [];
    arr.push(ms);
    buckets.set(key, arr);
  }
  const cells: HeatmapCell[] = [];
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      const arr = buckets.get(`${wd}:${h}`) ?? [];
      cells.push({ weekday: wd, hour: h, count: arr.length, medianMs: median(arr) });
    }
  }
  return cells;
}

// ─── Diagnostics summary ─────────────────────────────────────────────────────

export interface DiagnosticsSummary {
  totalReplies: number;
  attributedToRep: number;
  attributedToOwnerFallback: number;
  unattributed: number;
  threadsWithoutOwner: number;
  usersInOrg: number;
  usersWithoutEmailUsername: number;
  topUnmatchedFromEmails: Array<{ fromEmail: string; count: number }>;
}

export async function buildDiagnostics(pairs: ResponsePair[], orgId: string): Promise<DiagnosticsSummary> {
  const directory = await buildSenderUserDirectory(orgId);

  const replies = pairs.filter((p) => p.outboundAt != null);
  let attributedToRep = 0;
  let attributedToOwner = 0;
  let unattributed = 0;
  const unmatched = new Map<string, number>();
  for (const p of replies) {
    if (p.senderUserId) {
      attributedToRep++;
    } else if (p.ownerUserId) {
      attributedToOwner++;
      if (p.fromEmail) unmatched.set(p.fromEmail.toLowerCase(), (unmatched.get(p.fromEmail.toLowerCase()) ?? 0) + 1);
    } else {
      unattributed++;
      if (p.fromEmail) unmatched.set(p.fromEmail.toLowerCase(), (unmatched.get(p.fromEmail.toLowerCase()) ?? 0) + 1);
    }
  }

  const threadsWithoutOwner = new Set<string>();
  for (const p of pairs) {
    if (!p.ownerUserId) threadsWithoutOwner.add(p.threadId);
  }

  const usersInOrg = directory.users.length;
  const usersWithoutEmailUsername = directory.users.filter((u) => !isEmailShaped(u.username)).length;

  const topUnmatched = Array.from(unmatched.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([fromEmail, count]) => ({ fromEmail, count }));

  return {
    totalReplies: replies.length,
    attributedToRep,
    attributedToOwnerFallback: attributedToOwner,
    unattributed,
    threadsWithoutOwner: threadsWithoutOwner.size,
    usersInOrg,
    usersWithoutEmailUsername,
    topUnmatchedFromEmails: topUnmatched,
  };
}

// ─── Sync freshness ──────────────────────────────────────────────────────────

export interface SyncFreshness {
  /** Most recent provider_sent_at across customer email_messages for this org. */
  lastProviderSentAt: string | null;
  /** Most recent monitored_mailboxes.last_sync_at for this org. */
  lastMailboxSyncAt: string | null;
  /** The greater of the two — what the UI actually shows as "Data as of". */
  asOf: string | null;
  /** ms behind "now"; null when both above are null. */
  ageMs: number | null;
  /** True when ageMs > 15min (or sync is missing entirely). */
  stale: boolean;
}

export const STALE_THRESHOLD_MS = 15 * 60 * 1000;

export async function getSyncFreshness(orgId: string): Promise<SyncFreshness> {
  const result = await storage.pool.query<{ last_provider_sent_at: string | null; last_mailbox_sync_at: string | null }>(
    `SELECT
       (SELECT MAX(COALESCE(em.provider_sent_at, em.created_at))
          FROM email_messages em
         WHERE em.org_id = $1)                                   AS last_provider_sent_at,
       (SELECT MAX(last_sync_at)
          FROM monitored_mailboxes
         WHERE org_id = $1 AND enabled = true)                   AS last_mailbox_sync_at`,
    [orgId],
  );
  const row = result.rows[0] ?? { last_provider_sent_at: null, last_mailbox_sync_at: null };
  const a = row.last_provider_sent_at ? new Date(row.last_provider_sent_at).getTime() : null;
  const b = row.last_mailbox_sync_at ? new Date(row.last_mailbox_sync_at).getTime() : null;
  const asOfMs = a == null ? b : (b == null ? a : Math.max(a, b));
  const now = Date.now();
  const ageMs = asOfMs == null ? null : now - asOfMs;
  const stale = ageMs == null ? true : ageMs > STALE_THRESHOLD_MS;
  return {
    lastProviderSentAt: row.last_provider_sent_at,
    lastMailboxSyncAt: row.last_mailbox_sync_at,
    asOf: asOfMs == null ? null : new Date(asOfMs).toISOString(),
    ageMs,
    stale,
  };
}
