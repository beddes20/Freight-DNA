/**
 * Task #803 — Quote Lifecycle Autopilot (C): no-response auto-close cron.
 *
 * Every 15 minutes, scan every org for `pending` quote opportunities
 * whose last quote_event is older than the org's
 * `quote_no_response_timeout_hours` (default 2h) AND have had no
 * inbound customer reply on the source thread since that last event.
 * Matching rows flip to outcomeStatus='no_response' with an
 * `actor='auto:no_response_timeout'` quote_event.
 *
 * Forward-only activation gate: the very first sweep cycle for an org
 * stamps `agent_org_settings.quote_autopilot_started_at` and skips that
 * org for the cycle. From then on, only quotes whose last event is
 * AFTER that stamp are eligible. Without this gate, deploying the
 * autopilot for the first time would mass-close every historical
 * pending quote in one go — indistinguishable from data loss to a rep.
 *
 * Re-open guard: if a quote was previously auto-closed by this sweep
 * (we see an `auto:no_response_timeout` event in its history) and a
 * rep manually re-opened it (status flipped back to pending), give the
 * thread one full timeout window before re-closing. That stops a
 * thrashy re-close loop while still letting the autopilot eventually
 * close stuck threads.
 *
 * Write path: closes flow through the canonical `markQuoteOutcome`
 * helper so they share status/reason/touchpoint plumbing with manual
 * rep actions — only the event type (`auto_lost`) and actor
 * (`auto:no_response_timeout`) differ via the autopilot opts.
 */
import { and, eq, isNotNull, or, sql, desc } from "drizzle-orm";
import cron from "node-cron";
import {
  agentOrgSettings,
  emailMessages,
  organizations,
  quoteEvents,
  quoteOpportunities,
} from "@shared/schema";
import { db } from "../storage";
import { JOB_NAMES, withHeartbeat } from "../lib/cronHeartbeat";
import { markQuoteOutcome } from "./customerQuotes";

const DEFAULT_TIMEOUT_HOURS = 2;

export interface SweepStats {
  scannedOrgs: number;
  candidates: number;
  closed: number;
  skippedReopened: number;
  skippedRecentInbound: number;
  skippedNotActivated: number;
  skippedPreActivation: number;
  errors: number;
}

interface OrgAutopilotState {
  timeoutHours: number;
  // The activation timestamp. `null` means we just inserted/seeded it
  // on this cycle and the org should be skipped wholesale (forward-only
  // gate). A real Date means the org is past activation and quotes whose
  // last event is older than this date should be ignored.
  activatedAt: Date | null;
}

/**
 * Read or seed the autopilot activation row for an org. The first call
 * for any org seeds `quote_autopilot_started_at = now`, returns
 * `activatedAt: null`, and the caller skips that org for the cycle —
 * forward-only init. Subsequent calls return the stamped timestamp.
 *
 * Tests inject `activatedAtOverride` so they can simulate an
 * already-activated org without poking the settings table directly.
 */
async function loadOrgAutopilotState(
  orgId: string,
  now: Date,
  activatedAtOverride?: Date | null,
): Promise<OrgAutopilotState> {
  if (activatedAtOverride !== undefined) {
    return {
      timeoutHours: clampTimeoutHours(DEFAULT_TIMEOUT_HOURS),
      activatedAt: activatedAtOverride,
    };
  }
  const [row] = await db
    .select({
      hrs: agentOrgSettings.quoteNoResponseTimeoutHours,
      startedAt: agentOrgSettings.quoteAutopilotStartedAt,
      id: agentOrgSettings.id,
    })
    .from(agentOrgSettings)
    .where(eq(agentOrgSettings.organizationId, orgId))
    .limit(1);
  const timeoutHours = clampTimeoutHours(row?.hrs ?? DEFAULT_TIMEOUT_HOURS);
  if (!row) {
    // No settings row at all — insert one with activation stamped now and
    // skip this cycle. Subsequent cycles will see an activatedAt and run
    // normally.
    await db.insert(agentOrgSettings).values({
      organizationId: orgId,
      quoteAutopilotStartedAt: now,
    }).onConflictDoNothing();
    return { timeoutHours, activatedAt: null };
  }
  if (!row.startedAt) {
    await db
      .update(agentOrgSettings)
      .set({ quoteAutopilotStartedAt: now })
      .where(eq(agentOrgSettings.id, row.id));
    return { timeoutHours, activatedAt: null };
  }
  return { timeoutHours, activatedAt: row.startedAt };
}

function clampTimeoutHours(hrs: number): number {
  // Clamp to a sane range. 0/negative would auto-close everything;
  // >168 (1 week) means autopilot effectively never fires — both are
  // bugs in the org settings UI rather than legitimate values.
  return Math.max(1, Math.min(168, hrs));
}

interface CandidateRow {
  id: string;
  organizationId: string;
  customerId: string;
  sourceReference: string | null;
  source: string;
}

export interface RunSweepOptions {
  /**
   * Test-only: bypass the per-org activation stamp lookup and treat
   * every org as if it activated at this date (or `null` to force every
   * org through the "just-seeded, skip this cycle" branch). Production
   * callers omit this and the stamp is read from `agent_org_settings`.
   */
  activatedAtOverride?: Date | null;
}

/**
 * Run a single sweep pass across every org. Idempotent + cheap to call —
 * the cron entrypoint and the test suite both call this directly.
 */
export async function runQuoteNoResponseSweep(
  now: Date = new Date(),
  opts?: RunSweepOptions,
): Promise<SweepStats> {
  const stats: SweepStats = {
    scannedOrgs: 0,
    candidates: 0,
    closed: 0,
    skippedReopened: 0,
    skippedRecentInbound: 0,
    skippedNotActivated: 0,
    skippedPreActivation: 0,
    errors: 0,
  };

  const orgs = await db.select({ id: organizations.id }).from(organizations);
  for (const org of orgs) {
    stats.scannedOrgs += 1;
    let state: OrgAutopilotState;
    try {
      state = await loadOrgAutopilotState(org.id, now, opts?.activatedAtOverride);
    } catch (err) {
      console.error(
        "[quoteNoResponseSweep] org settings load error:",
        org.id,
        err instanceof Error ? err.message : err,
      );
      stats.errors += 1;
      continue;
    }
    if (state.activatedAt === null) {
      // Forward-only gate: just stamped activation, skip this cycle.
      stats.skippedNotActivated += 1;
      continue;
    }
    const activatedAt = state.activatedAt;
    const timeoutMs = state.timeoutHours * 3600 * 1000;
    const cutoff = new Date(now.getTime() - timeoutMs);

    let candidates: CandidateRow[];
    try {
      candidates = await db
        .select({
          id: quoteOpportunities.id,
          organizationId: quoteOpportunities.organizationId,
          customerId: quoteOpportunities.customerId,
          sourceReference: quoteOpportunities.sourceReference,
          source: quoteOpportunities.source,
        })
        .from(quoteOpportunities)
        .where(
          and(
            eq(quoteOpportunities.organizationId, org.id),
            eq(quoteOpportunities.outcomeStatus, "pending"),
          ),
        );
    } catch (err) {
      console.error(
        "[quoteNoResponseSweep] candidate query error:",
        org.id,
        err instanceof Error ? err.message : err,
      );
      stats.errors += 1;
      continue;
    }

    for (const opp of candidates) {
      try {
        const result = await maybeCloseSingleQuote(opp, now, cutoff, timeoutMs, activatedAt, stats);
        if (result === "closed") stats.closed += 1;
        else if (result === "skipped_reopened") stats.skippedReopened += 1;
        else if (result === "skipped_recent_inbound") stats.skippedRecentInbound += 1;
        else if (result === "skipped_pre_activation") stats.skippedPreActivation += 1;
      } catch (err) {
        console.error(
          "[quoteNoResponseSweep] per-quote sweep error:",
          opp.id,
          err instanceof Error ? err.message : err,
        );
        stats.errors += 1;
      }
    }
  }

  return stats;
}

async function maybeCloseSingleQuote(
  opp: CandidateRow,
  now: Date,
  cutoff: Date,
  timeoutMs: number,
  activatedAt: Date,
  stats: SweepStats,
): Promise<
  | "closed"
  | "skipped_reopened"
  | "skipped_recent_inbound"
  | "skipped_recent_event"
  | "skipped_no_event"
  | "skipped_pre_activation"
> {
  // Pull the event history for this opp so we can answer:
  //   1. when was the most recent event?  (must be older than cutoff)
  //   2. has this opp ever been auto-closed before? if so, how long ago
  //      did the most recent re-open happen?  (skip-one-window guard)
  const events = await db
    .select({
      id: quoteEvents.id,
      eventType: quoteEvents.eventType,
      occurredAt: quoteEvents.occurredAt,
      actor: quoteEvents.actor,
    })
    .from(quoteEvents)
    .where(eq(quoteEvents.quoteId, opp.id))
    .orderBy(desc(quoteEvents.occurredAt));

  if (events.length === 0) return "skipped_no_event";
  const lastEvent = events[0];
  if (lastEvent.occurredAt.getTime() > cutoff.getTime()) return "skipped_recent_event";
  // Forward-only gate: if the last event predates the autopilot's
  // activation, we never inherited responsibility for this quote.
  if (lastEvent.occurredAt.getTime() < activatedAt.getTime()) return "skipped_pre_activation";

  // Re-open guard. If we've previously auto-closed this opp and the most
  // recent re-open is younger than one full timeout window, skip.
  // `events` is sorted DESC by occurredAt; `idxAuto` is the position of
  // the last auto-close in that array. Anything at indices < idxAuto is
  // newer than the auto-close (= a re-open or a subsequent rep action),
  // and events[0] in particular is the *most recent* such event.
  const idxAuto = events.findIndex(
    (e) => e.actor === "auto:no_response_timeout",
  );
  if (idxAuto > 0) {
    const mostRecentReopen = events[0];
    if (now.getTime() - mostRecentReopen.occurredAt.getTime() < timeoutMs) {
      return "skipped_reopened";
    }
  }

  // No-inbound-reply check. The source quote is keyed by an
  // email_messages row; pull that row's threadId, then look for any
  // inbound message on that thread newer than the last event. The
  // `sourceReference` value is `providerMessageId ?? id` (per
  // `quoteEmailIngestion.ts`), so we have to look up by either to
  // avoid silently missing the protective inbound-reply check (which
  // would let the sweep auto-close quotes that already got a reply).
  if (opp.source === "email" && opp.sourceReference) {
    const [src] = await db
      .select({ threadId: emailMessages.threadId })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.orgId, opp.organizationId),
          or(
            eq(emailMessages.id, opp.sourceReference),
            eq(emailMessages.providerMessageId, opp.sourceReference),
          ),
        ),
      )
      .limit(1);
    const threadId = src?.threadId ?? null;
    if (threadId) {
      const inbound = await db
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.orgId, opp.organizationId),
            eq(emailMessages.threadId, threadId),
            eq(emailMessages.direction, "inbound"),
            sql`${emailMessages.providerSentAt} > ${lastEvent.occurredAt}`,
          ),
        )
        .limit(1);
      if (inbound.length > 0) return "skipped_recent_inbound";
    }
  }

  stats.candidates += 1;
  // Canonical write path. `markQuoteOutcome` handles status update,
  // reason resolution (no-op for no_response), event insertion, and the
  // touchpoint log. Autopilot opts override the event type + payload so
  // the timeline honestly attributes this close to the cron.
  const timeoutHours = Math.round(timeoutMs / 3600 / 1000);
  await markQuoteOutcome(
    opp.organizationId,
    opp.id,
    "no_response",
    null,
    "auto:no_response_timeout",
    {
      eventTypeOverride: "auto_lost",
      payloadExtras: {
        source: "no_response_sweep",
        timeoutHours,
        lastEventOccurredAt: lastEvent.occurredAt.toISOString(),
        lastEventType: lastEvent.eventType,
      },
    },
  );
  return "closed";
}

let _scheduled: ReturnType<typeof cron.schedule> | null = null;
let _dailySummaryScheduled: ReturnType<typeof cron.schedule> | null = null;
const SCHEDULE_INTERVAL_MS = 15 * 60 * 1000;
const DAILY_SUMMARY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Task #803 — emit a per-org rollup of the last 24h of `auto:%`
 * quote_events to the server log. The Operational Alerts rail surfaces
 * the same rollup in-app via getSnapshot(); this log line is what makes
 * the daily summary observable from outside the app (logs/Datadog/etc.)
 * so an on-call rep can confirm the autopilot is running even when no
 * one's looked at the dashboard.
 *
 * Exported so tests / health checks can invoke it directly.
 */
export async function runQuoteAutopilotDailySummary(now: Date = new Date()): Promise<{ orgs: number; totalEvents: number }> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      orgId: quoteOpportunities.organizationId,
      actor: quoteEvents.actor,
    })
    .from(quoteEvents)
    .innerJoin(quoteOpportunities, eq(quoteEvents.quoteId, quoteOpportunities.id))
    .where(and(
      sql`${quoteEvents.occurredAt} >= ${since}`,
      sql`${quoteEvents.actor} LIKE 'auto:%'`,
    ));
  const perOrg = new Map<string, { newSender: number; outboundReply: number; noResponseTimeout: number }>();
  for (const r of rows) {
    const bucket = perOrg.get(r.orgId) ?? { newSender: 0, outboundReply: 0, noResponseTimeout: 0 };
    if (r.actor === "auto:new_sender") bucket.newSender += 1;
    else if (r.actor === "auto:outbound_reply") bucket.outboundReply += 1;
    else if (r.actor === "auto:no_response_timeout") bucket.noResponseTimeout += 1;
    perOrg.set(r.orgId, bucket);
  }
  let totalEvents = 0;
  for (const [orgId, b] of perOrg.entries()) {
    const subtotal = b.newSender + b.outboundReply + b.noResponseTimeout;
    totalEvents += subtotal;
    console.log(
      `[quoteAutopilotDailySummary] org=${orgId} window=24h ` +
        `new_sender=${b.newSender} outbound_reply=${b.outboundReply} ` +
        `no_response_timeout=${b.noResponseTimeout} total=${subtotal}`,
    );
  }
  if (perOrg.size === 0) {
    console.log("[quoteAutopilotDailySummary] window=24h orgs=0 total=0 (no autopilot activity)");
  }
  return { orgs: perOrg.size, totalEvents };
}

/** node-cron entry — every 15 minutes. Idempotent: a re-import is a no-op. */
export function startQuoteNoResponseSweepScheduler(): void {
  if (_scheduled) return;
  _scheduled = cron.schedule("*/15 * * * *", async () => {
    await withHeartbeat(
      JOB_NAMES.quoteNoResponseSweep,
      SCHEDULE_INTERVAL_MS,
      async () => {
        const stats = await runQuoteNoResponseSweep(new Date());
        if (stats.closed > 0 || stats.errors > 0 || stats.skippedNotActivated > 0) {
          console.log(
            `[quoteNoResponseSweep] scanned=${stats.scannedOrgs} closed=${stats.closed} ` +
              `skipped_reopened=${stats.skippedReopened} skipped_recent_inbound=${stats.skippedRecentInbound} ` +
              `skipped_not_activated=${stats.skippedNotActivated} skipped_pre_activation=${stats.skippedPreActivation} ` +
              `errors=${stats.errors}`,
          );
        }
      },
    );
  });
  console.log("[quoteNoResponseSweep] scheduler started — every 15min");

  // Daily autopilot summary — emit per-org rollup once every 24h at
  // 09:00 UTC. Idempotent on re-import (separate handle).
  if (!_dailySummaryScheduled) {
    _dailySummaryScheduled = cron.schedule("0 9 * * *", async () => {
      await withHeartbeat(
        JOB_NAMES.quoteAutopilotDailySummary,
        DAILY_SUMMARY_INTERVAL_MS,
        async () => {
          try {
            await runQuoteAutopilotDailySummary(new Date());
          } catch (err) {
            console.error("[quoteAutopilotDailySummary] error:", err instanceof Error ? err.message : err);
          }
        },
      );
    });
    console.log("[quoteAutopilotDailySummary] scheduler started — daily 09:00 UTC");
  }
}

export function stopQuoteNoResponseSweepScheduler(): void {
  if (_scheduled) {
    _scheduled.stop();
    _scheduled = null;
  }
  if (_dailySummaryScheduled) {
    _dailySummaryScheduled.stop();
    _dailySummaryScheduled = null;
  }
}
