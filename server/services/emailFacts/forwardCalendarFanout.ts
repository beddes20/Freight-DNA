/**
 * Email Intelligence v1.5 — Tier 2.1 forward-calendar fan-out (Task #943).
 *
 * Reads pending `forward_calendar_events` (RFP dates, contract end dates,
 * renewal windows extracted by the slot extractor) and creates `tasks`
 * rows assigned to the account's primary rep so the work surfaces on the
 * rep's queue. Each generated task carries `forwardedFrom = "fwcal:<id>"`
 * so the same calendar event never spawns more than one task — the
 * post-create handler stamps the event with `status='nba_queued'` and the
 * task id which is also the secondary idempotency check.
 *
 * Lead time policy:
 *   - RFP / bid prep   → 7 days before the event
 *   - Contract end     → 14 days before the event
 *   - everything else  → 3 days before the event
 *
 * The fan-out is best-effort and runs once per day from a cron — if the
 * task creation fails the event is left in `pending` so the next run
 * retries.
 */

import { db } from "../../storage";
import { eq, and, sql } from "drizzle-orm";
import {
  companies,
  type ForwardCalendarEvent,
  type ForwardCalendarEventType,
  type InsertTask,
} from "@shared/schema";
import {
  getUpcomingForwardCalendarEvents,
  markForwardCalendarEventStatus,
} from "./emailFactsStorage";
import type { IStorage } from "../../storage";

const HORIZON_DAYS = 30;

/**
 * Lead-time map keyed off the canonical `ForwardCalendarEventType` enum
 * emitted by the slot extractor (`shared/schema.ts → forwardCalendarEventTypes`).
 * Defined as a `Record<ForwardCalendarEventType, number>` so adding a new
 * enum value triggers a compile error here — no silent default-fallback.
 */
const LEAD_DAYS_BY_TYPE: Record<ForwardCalendarEventType, number> = {
  rfp: 7,
  contract_end: 14,
  renewal: 14,
  follow_up_at: 3,
};

function leadDaysFor(eventType: ForwardCalendarEventType): number {
  return LEAD_DAYS_BY_TYPE[eventType];
}

function asEventType(raw: string): ForwardCalendarEventType | null {
  return (raw in LEAD_DAYS_BY_TYPE) ? (raw as ForwardCalendarEventType) : null;
}

function shouldFireNow(event: ForwardCalendarEvent, now: Date): boolean {
  if (!event.eventDate) return false;
  const eventType = asEventType(event.eventType);
  if (!eventType) return false;
  const lead = leadDaysFor(eventType);
  const fireAt = new Date(event.eventDate.getTime() - lead * 86400 * 1000);
  return now >= fireAt;
}

function tipText(event: ForwardCalendarEvent): { title: string; notes: string } {
  const dateStr = event.eventDate?.toISOString().slice(0, 10) ?? "TBD";
  switch (event.eventType as ForwardCalendarEventType) {
    case "rfp":
      return {
        title: `Prep RFP response — due ${dateStr}`,
        notes: `Email-detected RFP / bid window. Pull recent lane history, last quote, and competitive notes for this account before the deadline.`,
      };
    case "contract_end":
    case "renewal":
      return {
        title: `Renewal-risk prep — contract ends ${dateStr}`,
        notes: `Email-detected contract end. Confirm renewal posture, gather award rationale, and schedule a stakeholder check-in 2 weeks before expiry.`,
      };
    case "follow_up_at":
    default:
      return {
        title: `Email-detected milestone — ${dateStr}`,
        notes: `Auto-created from forward_calendar_events (${event.eventType}). Review and decide on action.`,
      };
  }
}

async function resolveAccountManagerId(orgId: string, companyId: string | null): Promise<string | null> {
  if (!companyId) return null;
  const rows = await db
    .select({ assignedTo: companies.assignedTo, salesPersonId: companies.salesPersonId })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, orgId)))
    .limit(1);
  return rows[0]?.assignedTo ?? rows[0]?.salesPersonId ?? null;
}

export interface ForwardCalendarFanoutResult {
  scanned: number;
  created: number;
  skipped: number;
  errors: number;
}

/**
 * Run the fan-out for a single org. Pure DB work — no external state.
 */
export async function runForwardCalendarFanoutForOrg(
  orgId: string,
  storage: Pick<IStorage, "createTask">,
  now: Date = new Date(),
): Promise<ForwardCalendarFanoutResult> {
  const events = await getUpcomingForwardCalendarEvents(orgId, HORIZON_DAYS);
  let created = 0;
  let skipped = 0;
  let errors = 0;
  for (const event of events) {
    if (!shouldFireNow(event, now)) {
      skipped += 1;
      continue;
    }
    try {
      const assignedTo = await resolveAccountManagerId(orgId, event.linkedAccountId);
      if (!assignedTo) {
        // Account has no rep assignment — leave pending so a future run can
        // pick it up once an assignment lands.
        skipped += 1;
        continue;
      }
      const tip = tipText(event);
      const taskInput: InsertTask = {
        title: tip.title,
        notes: tip.notes,
        status: "open",
        dueDate: event.eventDate?.toISOString().slice(0, 10) ?? null,
        assignedTo,
        assignedBy: assignedTo,
        companyId: event.linkedAccountId ?? null,
        contactId: null,
        orgId,
        forwardedFrom: `fwcal:${event.id}`,
        createdAt: now.toISOString(),
      };
      const task = await storage.createTask(taskInput);
      await markForwardCalendarEventStatus(event.id, "nba_queued", task?.id ?? null);
      created += 1;
    } catch (err) {
      errors += 1;
      console.error(`[emailFacts.fwcal] fan-out failed for event ${event.id}:`, err);
    }
  }
  return { scanned: events.length, created, skipped, errors };
}

/**
 * Run the fan-out across all orgs that have any pending events. Used by
 * the cron entry point.
 */
export async function runForwardCalendarFanoutAllOrgs(
  storage: Pick<IStorage, "createTask">,
  now: Date = new Date(),
): Promise<{ orgs: number; totals: ForwardCalendarFanoutResult }> {
  const rows = await db.execute<{ org_id: string }>(sql`
    SELECT DISTINCT org_id FROM forward_calendar_events WHERE status = 'pending'
  `);
  const totals: ForwardCalendarFanoutResult = { scanned: 0, created: 0, skipped: 0, errors: 0 };
  let orgs = 0;
  for (const row of rows.rows ?? rows) {
    const orgId = (row as { org_id: string }).org_id;
    if (!orgId) continue;
    orgs += 1;
    const out = await runForwardCalendarFanoutForOrg(orgId, storage, now);
    totals.scanned += out.scanned;
    totals.created += out.created;
    totals.skipped += out.skipped;
    totals.errors += out.errors;
  }
  return { orgs, totals };
}
