/**
 * Proactive Available Freight Outreach Engine ("PAFOE") — Phase 4 service.
 *
 * Responsibilities:
 *   1. renderTemplate         — admin-template variable substitution.
 *   2. buildOpportunityDraft  — build subject/body for one carrier from the
 *                                appropriate template (exact_load | lane_building).
 *   3. sendOpportunityWave    — rep-approved send (or schedule) for a list of
 *                                carrier rows; re-evaluates Phase 2 guardrails
 *                                IMMEDIATELY before each send and writes a
 *                                carrier_outreach_logs audit row per send.
 *   4. processDueScheduledWaves — scheduler tick to send queued rows whose
 *                                   `scheduled_for` is in the past.
 *   5. classifyOpportunityReply — inbound-reply classifier into the Phase 4
 *                                   structured outcome enum + signal feedback.
 *   6. feedbackToCarrierIntel — additive write to carrier_intel_suggestions
 *                                so positive/negative responses bias future
 *                                ranking without overwriting carrier truth.
 */

import type { IStorage } from "./storage";
import { db } from "./storage";
import { sql } from "drizzle-orm";
import {
  buildEligibilityContext,
  evaluateCarrierEligibility,
  loadEffectivePolicy,
} from "./proactiveOpportunityService";
import {
  formatLaneDisplay,
  normalizeEquipmentType,
} from "./laneOutreachEmailBuilder";
import {
  findCrossThrottledCarriers,
  FREIGHT_CROSS_THROTTLE_HOURS,
} from "./freightOpportunityCrossThrottle";
import { recordCarrierLaneOutcome } from "./services/carrierLaneOutcomes";
import { laneSig } from "./laneCrossLinkService";
import {
  carrierIntelSuggestions,
  type Carrier,
  type Company,
  type FreightOpportunity,
  type FreightOpportunityCarrier,
  type FreightOpportunityResponseOutcome,
  type FreightOutreachTemplate,
  type FreightOutreachTemplateKind,
  type InsertCarrierOutreachLog,
  type InsertCarrierIntelSuggestion,
  type User,
} from "@shared/schema";

// Phased-wave automation knobs. After the rep approves wave 1, follow-on
// waves auto-cascade FOLLOW_UP_DELAY_HOURS apart, capped at MAX_AUTOMATED_WAVES.
// They are cancelled the moment any positive reply lands on the opportunity.
export const MAX_AUTOMATED_WAVES = 3;
export const FOLLOW_UP_DELAY_HOURS = 48;
export const MAX_CARRIERS_PER_WAVE = 8;

// ── Default templates (seeded on first read per org) ────────────────────────
// Carrier-bound only. Must not reference customer/shipper identity (Task #820).
export const DEFAULT_FREIGHT_OUTREACH_TEMPLATES: Record<
  FreightOutreachTemplateKind,
  { subject: string; body: string }
> = {
  exact_load: {
    subject: "Available freight - {{lane_display_to}} ({{pickup_window_short}})",
    body:
      "Hey {{carrier_name}} team,\n\n" +
      "I've got a {{equipment_human}} load picking up in {{origin}} to {{destination}}. " +
      "P/U {{pickup_date_short}} and delivers {{delivery_date_short}}.\n\n" +
      "Do you have capacity? If not, what lanes are you working on?\n\n" +
      "Thanks,\n{{rep_name}}",
  },
  lane_building: {
    subject: "Available freight - {{lane_display_to}} ({{pickup_window_short}})",
    body:
      "Hey {{carrier_name}} team,\n\n" +
      "I'm building out steady coverage on {{lane_display_to}} ({{equipment_human}}). " +
      "Next pickup is {{pickup_date_short}} delivering {{delivery_date_short}}.\n\n" +
      "Does this lane fit your network? Even rough timing (this week, next few weeks, or future) is helpful so I know when to call.\n\n" +
      "Thanks,\n{{rep_name}}",
  },
};

// ── Variable substitution ───────────────────────────────────────────────────

export type TemplateVars = Record<string, string>;

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    return vars[name] ?? "";
  });
}

/**
 * Format an ISO-like calendar date string ("YYYY-MM-DD" or anything `Date`
 * can parse) as `M/D` (no year, no leading zeros). Returns "" for any input
 * that doesn't parse — callers fall back to other dates rather than letting
 * a stray "1/1" leak into a carrier email.
 */
export function formatShortDate(input: string | null | undefined): string {
  if (!input) return "";
  const s = String(input).trim();
  if (!s) return "";
  // Fast path for the canonical "YYYY-MM-DD" we store in pickup_window_start
  // and delivery_date — avoids the Date timezone trap.
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return `${parseInt(isoMatch[2], 10)}/${parseInt(isoMatch[3], 10)}`;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Humanize a TMS equipment label for use in a sentence ("dry van",
 * "reefer", "flatbed"). The base normalizer (`normalizeEquipmentType`)
 * already handles the common short codes; this layer just lower-cases the
 * canonical labels so the body reads naturally ("a dry van load" instead
 * of "a Dry Van load").
 */
export function humanizeEquipmentLabel(raw: string | null | undefined): string {
  const normalized = normalizeEquipmentType(raw ?? "");
  if (!normalized) return "dry van";
  // Preserve true acronyms like "LTL" — anything that's all caps + short
  // we leave alone. Everything else lowercases for natural sentence flow.
  if (/^[A-Z]{2,4}$/.test(normalized)) return normalized;
  return normalized.toLowerCase();
}

export function buildTemplateVars(opts: {
  carrier: Pick<Carrier, "name">;
  rep: Pick<User, "name" | "username">;
  company: Pick<Company, "name">;
  opportunity: FreightOpportunity;
  hasHistory: boolean;
  loadsOnLane?: number | null;
}): TemplateVars {
  const { carrier, rep, opportunity, hasHistory, loadsOnLane } = opts;
  const equipment = normalizeEquipmentType(opportunity.equipmentType ?? "");
  const equipmentHuman = humanizeEquipmentLabel(opportunity.equipmentType);
  const lane = formatLaneDisplay(
    opportunity.origin,
    opportunity.originState,
    opportunity.destination,
    opportunity.destinationState,
  );
  // "to" form for the rep-approved subject; `lane_display` keeps the arrow form for legacy templates.
  const laneDisplayTo = lane.replace(/\s*→\s*/g, " to ");
  const pickupWindow = `${opportunity.pickupWindowStart} → ${opportunity.pickupWindowEnd}`;
  const pickupShort = formatShortDate(opportunity.pickupWindowStart);
  // Prefer delivery_date; fall back to pickup_window_end then pickup_window_start so the body always has a date.
  const deliveryRaw = opportunity.deliveryDate
    || opportunity.pickupWindowEnd
    || opportunity.pickupWindowStart;
  const deliveryShort = formatShortDate(deliveryRaw);
  // Subject window: "(M/D - M/D)" when pickup ≠ delivery, "(M/D)" otherwise.
  const pickupWindowShort = pickupShort && deliveryShort && pickupShort !== deliveryShort
    ? `${pickupShort} - ${deliveryShort}`
    : (pickupShort || deliveryShort || "");
  const historyPhrase = hasHistory && loadsOnLane && loadsOnLane > 0
    ? ` We've worked together on ${loadsOnLane} load${loadsOnLane === 1 ? "" : "s"} like this before.`
    : "";

  return {
    carrier_name: carrier.name ?? "",
    rep_name: rep.name?.trim() || (rep.username ?? "").split("@")[0],
    rep_email: rep.username ?? "",
    // Empty by design (Task #820): legacy {{customer_name}} tokens render to nothing.
    customer_name: "",
    lane_display: lane,
    lane_display_to: laneDisplayTo,
    origin: opportunity.origin,
    destination: opportunity.destination,
    equipment: equipment || "your equipment",
    equipment_human: equipmentHuman,
    pickup_window: pickupWindow,
    pickup_window_short: pickupWindowShort,
    pickup_date_short: pickupShort,
    delivery_date_short: deliveryShort,
    load_count: String(opportunity.loadCount ?? 1),
    has_history: hasHistory ? "yes" : "no",
    history_phrase: historyPhrase,
  };
}

// ── Template loading (seeded defaults) ──────────────────────────────────────

export async function getOrSeedTemplate(
  storage: IStorage,
  orgId: string,
  kind: FreightOutreachTemplateKind,
): Promise<FreightOutreachTemplate> {
  const existing = await storage.getFreightOutreachTemplate(orgId, kind);
  if (existing) return existing;
  const def = DEFAULT_FREIGHT_OUTREACH_TEMPLATES[kind];
  return storage.upsertFreightOutreachTemplate({
    orgId,
    kind,
    subject: def.subject,
    body: def.body,
    updatedById: null,
  });
}

// ── Draft building ──────────────────────────────────────────────────────────

export interface OpportunityDraft {
  opportunityCarrierId: string;
  carrierId: string;
  carrierName: string;
  toEmail: string | null;
  subject: string;
  body: string;
  templateKind: FreightOutreachTemplateKind;
  warnings: string[];
}

export async function buildOpportunityDraft(
  storage: IStorage,
  opportunity: FreightOpportunity,
  oppCarrier: FreightOpportunityCarrier,
  rep: User,
): Promise<OpportunityDraft> {
  const carrier = await storage.getCarrier(oppCarrier.carrierId);
  const company = await storage.getCompany(opportunity.companyId);
  const kind: FreightOutreachTemplateKind =
    opportunity.mode === "exact_load" ? "exact_load" : "lane_building";
  const template = await getOrSeedTemplate(storage, opportunity.orgId, kind);

  const snap = (oppCarrier.responsivenessSnapshot ?? {}) as Record<string, unknown>;
  const loadsOnLane = typeof snap.loadsOnLane === "number" ? snap.loadsOnLane : null;
  const hasHistory = (loadsOnLane ?? 0) > 0 || oppCarrier.historyMatch !== "none";

  const vars = buildTemplateVars({
    carrier: { name: carrier?.name ?? "Carrier" },
    rep,
    company: { name: company?.name ?? "" },
    opportunity,
    hasHistory,
    loadsOnLane,
  });

  const warnings: string[] = [];
  const toEmail = carrier?.primaryEmail ?? carrier?.backupEmail ?? null;
  if (!toEmail) warnings.push("No email on file for this carrier");

  return {
    opportunityCarrierId: oppCarrier.id,
    carrierId: oppCarrier.carrierId,
    carrierName: carrier?.name ?? "Carrier",
    toEmail,
    subject: renderTemplate(template.subject, vars),
    body: renderTemplate(template.body, vars),
    templateKind: kind,
    warnings,
  };
}

// ── Send / schedule ─────────────────────────────────────────────────────────

export interface SendWaveResult {
  opportunityCarrierId: string;
  carrierId: string;
  carrierName: string;
  status: "sent" | "scheduled" | "blocked" | "failed" | "no_email" | "throttled_cross_module";
  blockedReason?: string;
  error?: string;
  scheduledFor?: string;
  threadId?: string | null;
  internetMessageId?: string | null;
}

export interface SendWaveOpts {
  carrierRowIds: string[];
  /** ISO timestamp; if present the wave is queued instead of sent immediately. */
  scheduleAt?: string | null;
  /** Wave label (1 = first wave, 2 = follow-up after no positive response, …). */
  wave?: number;
  /** Per-row subject/body overrides keyed by opportunityCarrierId (rep edits in UI). */
  overrides?: Record<string, { subject?: string; body?: string }>;
  /**
   * Identifies which send path produced this wave so the unified contact-lock
   * helper (Task #631) can render correct suppression reasons. Defaults to
   * "af_wave"; the auto-pilot scheduler must pass "auto_pilot" so other paths
   * see "Contacted via auto-pilot" rather than misattributing the policy
   * owner as the rep that sent.
   */
  sourceModule?: "af_wave" | "auto_pilot" | "single_carrier";
}

export async function sendOpportunityWave(
  storage: IStorage,
  orgId: string,
  opportunityId: string,
  rep: User,
  opts: SendWaveOpts,
): Promise<{ results: SendWaveResult[]; opportunity: FreightOpportunity }> {
  const opportunity = await storage.getFreightOpportunity(orgId, opportunityId);
  if (!opportunity) throw new Error("Opportunity not found");

  // Re-load the policy at send time and re-evaluate guardrails. This is the
  // critical guarantee: even if generation passed an hour ago, we never send
  // to a carrier that is no longer eligible.
  const policy = await loadEffectivePolicy(storage, orgId, opportunity.companyId);
  if (policy.doNotAutomate) {
    throw new Error("Customer policy forbids automated outreach (do_not_automate)");
  }
  if (!policy.enabled) {
    throw new Error("Customer outreach is disabled in policy");
  }

  // Approval gate (task #354): every opportunity sourced from the Available
  // Freight import requires explicit manager approval before send, regardless
  // of policy. Other (non-imported) opportunities still defer to
  // `policy.approvalRequired`. The rep clicking Send is never treated as the
  // approval — that decoupling is the entire point of the workflow.
  const sourceKind = (opportunity.sourceRef as { kind?: string } | null | undefined)?.kind;
  const isAvailableFreightImport = sourceKind === "available_freight_import";
  const requiresApproval = isAvailableFreightImport || policy.approvalRequired;
  if (
    requiresApproval &&
    opportunity.status !== "ready_to_send" &&
    opportunity.status !== "sent" &&
    opportunity.status !== "partially_covered" &&
    opportunity.status !== "awaiting_carrier_reply"
  ) {
    throw new Error(`Opportunity is in status "${opportunity.status}" — cannot send`);
  }
  if (requiresApproval && !opportunity.approvedAt) {
    throw new Error("Manager approval required before sending this opportunity");
  }

  const allCarriers = await storage.listFreightOpportunityCarriers(opportunityId);
  const carriersById = new Map(allCarriers.map(c => [c.id, c]));
  const ctx = await buildEligibilityContext(storage, orgId, policy);

  const scheduleAt = opts.scheduleAt ? new Date(opts.scheduleAt) : null;
  const wave = opts.wave ?? 1;
  const results: SendWaveResult[] = [];

  // Task #365 — cross-system throttle. Pull the carrier IDs the rep is
  // about to contact and check whether they were already pinged (by LWQ or
  // by an earlier freight opportunity) on the same lane within the per-carrier
  // dedup window. We compute this once per wave to amortize the SQL.
  const candidateCarrierIds = opts.carrierRowIds
    .map(id => carriersById.get(id)?.carrierId)
    .filter((id): id is string => !!id);
  const laneLabel = formatLaneDisplay(
    opportunity.origin,
    opportunity.originState,
    opportunity.destination,
    opportunity.destinationState,
  );
  const crossThrottled = await findCrossThrottledCarriers({
    orgId,
    carrierIds: candidateCarrierIds,
    recurringLaneId: opportunity.recurringLaneId ?? null,
    companyId: opportunity.companyId,
    laneLabel,
  });

  // Lazy-loaded outlook helpers (kept inside the loop's closure to avoid
  // import overhead when nothing is sent).
  const { sendOutlookEmail, outlookEnabled } = await import("./outlookService");
  // Task #959 — gate the Reply-To header on the live shared-mailbox
  // subscription state, not on the env var alone. A configured-but-dead
  // shared mailbox (e.g. the Ops@valuetruck.com 404 incident) otherwise
  // black-holes every carrier reply because the bounce hits a mailbox
  // that doesn't exist in the M365 tenant. When the shared path is
  // dormant, fall back to no Reply-To so the carrier reply lands back
  // in the sending rep's own monitored inbox.
  const { replyTrackingEnabled } = await import("./graphSubscriptionService");
  const outlookFromEmail = rep.username?.trim() ?? null;
  const sharedReplyMailbox = process.env.OUTLOOK_REPLY_EMAIL?.trim() || null;
  const sharedReplyActive = replyTrackingEnabled();
  const outlookReplyTo = sharedReplyActive ? sharedReplyMailbox : null;
  if (sharedReplyMailbox && !sharedReplyActive) {
    console.warn(
      `[freightOpportunityOutreach] Shared reply mailbox ${sharedReplyMailbox} is configured but the Graph subscription is dormant — falling back to no Reply-To.`,
    );
  }
  const useOutlook = outlookEnabled() && !!outlookFromEmail;

  for (const rowId of opts.carrierRowIds) {
    const row = carriersById.get(rowId);
    if (!row) {
      results.push({
        opportunityCarrierId: rowId,
        carrierId: "",
        carrierName: "?",
        status: "blocked",
        blockedReason: "Row not found on this opportunity",
      });
      continue;
    }
    if (row.sentAt) {
      results.push({
        opportunityCarrierId: rowId,
        carrierId: row.carrierId,
        carrierName: "(already sent)",
        status: "blocked",
        blockedReason: "Already sent in a prior wave",
      });
      continue;
    }

    const carrier = await storage.getCarrier(row.carrierId);
    if (!carrier) {
      results.push({
        opportunityCarrierId: rowId,
        carrierId: row.carrierId,
        carrierName: "(missing carrier)",
        status: "blocked",
        blockedReason: "Carrier no longer exists",
      });
      continue;
    }

    // Task #365 — cross-system throttle. Skip sends where the same carrier
    // was already pinged on this lane (by LWQ or another freight opp) in the
    // last FREIGHT_CROSS_THROTTLE_HOURS. The row is not terminal — clearing
    // scheduledFor lets the rep re-include after the window expires.
    const throttleHit = crossThrottled.get(row.carrierId);
    if (throttleHit) {
      const ageH = ((Date.now() - throttleHit.lastSentAt.getTime()) / 3600000).toFixed(1);
      // Surface WHICH path / WHO contacted so reps see "via LWQ by Sara" not
      // a faceless "throttled". Auto-pilot omits the actor name (it's the
      // policy owner, not the sender — calling out "by Sara" would mislead).
      const moduleLabel =
        throttleHit.sourceModule === "lwq" ? "LWQ" :
        throttleHit.sourceModule === "lwq_procurement" ? "LWQ procurement" :
        throttleHit.sourceModule === "lwq_adhoc" ? "LWQ ad-hoc" :
        throttleHit.sourceModule === "af_wave" ? "Available Freight" :
        throttleHit.sourceModule === "auto_pilot" ? "auto-pilot" :
        throttleHit.sourceModule === "single_carrier" ? "single-carrier email" :
        "outreach";
      const actorClause =
        throttleHit.actorName && throttleHit.sourceModule !== "auto_pilot"
          ? ` by ${throttleHit.actorName}`
          : "";
      const message = `Skipped: contacted on this lane ${ageH}h ago via ${moduleLabel}${actorClause} (cross-module throttle, ${FREIGHT_CROSS_THROTTLE_HOURS}h window)`;
      results.push({
        opportunityCarrierId: rowId,
        carrierId: row.carrierId,
        carrierName: carrier.name,
        status: "throttled_cross_module",
        blockedReason: message,
      });
      await storage.updateFreightOpportunityCarrier(rowId, {
        lastSendError: message,
        scheduledFor: null,
      });
      await storage.appendFreightOpportunityAudit({
        opportunityId,
        eventType: "outreach_blocked",
        actorUserId: rep.id,
        payload: {
          carrierId: row.carrierId,
          reason: "throttled_cross_module",
          message,
          wave,
          lastSentAt: throttleHit.lastSentAt.toISOString(),
          throttleSource: throttleHit.source,
          throttleSourceModule: throttleHit.sourceModule,
          throttleActorName: throttleHit.actorName,
          windowHours: FREIGHT_CROSS_THROTTLE_HOURS,
        },
      });
      continue;
    }

    // Re-evaluate guardrails — never send to a carrier that flipped to
    // do_not_use / opted_out / hit daily cap / was contacted in the dedup
    // window since shortlist generation.
    const decision = await evaluateCarrierEligibility(
      {
        id: carrier.id,
        primaryEmail: carrier.primaryEmail,
        status: carrier.status,
        tags: carrier.tags ?? [],
      },
      ctx,
    );
    if (!decision.allowed) {
      results.push({
        opportunityCarrierId: rowId,
        carrierId: row.carrierId,
        carrierName: carrier.name,
        status: "blocked",
        blockedReason: decision.message,
      });
      await storage.updateFreightOpportunityCarrier(rowId, {
        excludedReason: decision.reason,
        lastSendError: decision.message,
        // Terminal: never re-tick. The rep can re-include the row to retry.
        scheduledFor: null,
      });
      await storage.appendFreightOpportunityAudit({
        opportunityId,
        eventType: "outreach_blocked",
        actorUserId: rep.id,
        payload: { carrierId: row.carrierId, reason: decision.reason, message: decision.message, wave },
      });
      continue;
    }

    const draft = await buildOpportunityDraft(storage, opportunity, row, rep);
    const override = opts.overrides?.[rowId];
    const subject = override?.subject?.trim() || draft.subject;
    const body = override?.body?.trim() || draft.body;
    const toEmail = draft.toEmail;

    if (!toEmail) {
      results.push({
        opportunityCarrierId: rowId,
        carrierId: row.carrierId,
        carrierName: carrier.name,
        status: "no_email",
        error: "No email address on file",
      });
      // Terminal: clear scheduledFor so the scheduler doesn't re-pick this row.
      await storage.updateFreightOpportunityCarrier(rowId, {
        lastSendError: "No email on file",
        scheduledFor: null,
      });
      continue;
    }

    // Schedule path: persist scheduled_for, audit, and stop here.
    if (scheduleAt && scheduleAt.getTime() > Date.now() + 30_000) {
      await storage.updateFreightOpportunityCarrier(rowId, {
        wave,
        scheduledFor: scheduleAt,
        lastSendError: null,
      });
      await storage.appendFreightOpportunityAudit({
        opportunityId,
        eventType: "wave_scheduled",
        actorUserId: rep.id,
        payload: { carrierId: row.carrierId, scheduledFor: scheduleAt.toISOString(), wave },
      });
      results.push({
        opportunityCarrierId: rowId,
        carrierId: row.carrierId,
        carrierName: carrier.name,
        status: "scheduled",
        scheduledFor: scheduleAt.toISOString(),
      });
      continue;
    }

    // Send-now path
    const sendResult = await performSend({
      useOutlook,
      outlookFromEmail,
      outlookReplyTo,
      sendOutlookEmail,
      toEmail,
      subject,
      body,
    });

    if (!sendResult.ok) {
      // Clear scheduledFor so the scheduler doesn't loop on this row every tick.
      // Failures require rep re-action (re-include) to retry, surfacing the
      // error in the UI rather than silently retrying forever.
      await storage.updateFreightOpportunityCarrier(rowId, {
        lastSendError: sendResult.error,
        scheduledFor: null,
      });
      results.push({
        opportunityCarrierId: rowId,
        carrierId: row.carrierId,
        carrierName: carrier.name,
        status: "failed",
        error: sendResult.error,
      });
      continue;
    }

    // Persist outreach + thread linkage. Task #631 — also persist the
    // canonical "Origin → Destination" label into procurement_lane and tag the
    // source_module so the unified contact-lock helper finds these rows from
    // LWQ lookups (synthetic-lane opps have no recurringLaneId; the company +
    // lane label fallback is the only thing that links them).
    const log = await storage.createCarrierOutreachLog({
      orgId,
      laneId: opportunity.recurringLaneId ?? null,
      companyId: opportunity.companyId,
      carrierIds: [row.carrierId],
      carrierNames: [carrier.name],
      actorUserId: rep.id,
      ownerUserId: null,
      overseerUserId: null,
      outreachMode: opportunity.mode === "exact_load" ? "immediate_plus_lane" : "lane_building",
      procurementLane: laneLabel,
      sourceModule: opts.sourceModule ?? "af_wave",
      emailDrafts: [{
        carrierId: row.carrierId,
        carrierName: carrier.name,
        recipientEmail: toEmail,
        subject,
        body,
        templateKind: draft.templateKind,
        opportunityId,
        opportunityCarrierId: rowId,
      // The plain-object arrays match the jsonb column shapes exactly; the
      // insert-schema type is opaque to tsc because the column is jsonb.
      }] as unknown as InsertCarrierOutreachLog["emailDrafts"],
      sentAt: new Date(),
      deliveryStatus: "sent",
      recipients: [{
        carrierId: row.carrierId,
        carrierName: carrier.name,
        email: toEmail,
        status: "sent",
        internetMessageId: sendResult.internetMessageId,
        conversationId: sendResult.conversationId,
      }] as unknown as InsertCarrierOutreachLog["recipients"],
      threadId: sendResult.internetMessageId ?? null,
      direction: "outbound",
      providerMessageId: sendResult.internetMessageId ?? null,
      conversationId: sendResult.conversationId ?? null,
      fromEmail: outlookFromEmail,
      toEmail,
      subject,
      bodyPreview: body.slice(0, 255),
      processStatus: "processed",
      matchedCarrierId: row.carrierId,
    });

    const threadKey = sendResult.conversationId ?? sendResult.internetMessageId ?? null;

    // Persist linkage in email_conversation_threads so inbound replies
    // correlate back to this carrier (and through it, to the opportunity).
    if (threadKey) {
      // Task #859 — share a single timestamp between `lastOutgoingAt` and
      // the denormalized `lastEmailAt` so the two columns can never drift
      // by a millisecond. Using two separate `new Date()` calls would let
      // the row-level recency sort and the per-direction predicate
      // disagree about which direction "won" the freshness tie-break.
      const sentAt = new Date();
      try {
        await storage.upsertEmailConversationThread({
          orgId,
          threadId: threadKey,
          linkedAccountId: opportunity.companyId ?? null,
          linkedCarrierId: row.carrierId,
          update: {
            linkedAccountId: opportunity.companyId ?? null,
            linkedCarrierId: row.carrierId,
            ownerUserId: rep.id,
            lastOutgoingAt: sentAt,
            // Single denormalized "real email activity" column must stay
            // in sync with the per-direction column we just bumped.
            lastEmailAt: sentAt,
            waitingState: "waiting_on_them",
          },
        });
      } catch (err) {
        console.warn("[pafoe-outreach] thread upsert failed:", err instanceof Error ? err.message : err);
      }
    }

    await storage.updateFreightOpportunityCarrier(rowId, {
      wave,
      sentAt: new Date(),
      scheduledFor: null,
      threadId: threadKey,
      internetMessageId: sendResult.internetMessageId ?? null,
      outreachLogId: log.id,
      lastSendError: null,
    });

    await storage.appendFreightOpportunityAudit({
      opportunityId,
      eventType: "outreach_sent",
      actorUserId: rep.id,
      payload: {
        carrierId: row.carrierId,
        wave,
        templateKind: draft.templateKind,
        threadId: sendResult.conversationId ?? sendResult.internetMessageId ?? null,
        outreachLogId: log.id,
      },
    });

    // Task #637 — bump rolling outcome counter so the ranker sees this
    // carrier picked up a fresh "sent" against this lane signature.
    // eventKey ties the bump to the underlying outreach log row so any
    // retry of this code path is counter-safe.
    await recordCarrierLaneOutcome({
      orgId,
      carrierId: row.carrierId,
      laneSignature: laneSig(
        opportunity.origin,
        opportunity.originState,
        opportunity.destination,
        opportunity.destinationState,
        opportunity.equipmentType,
      ),
      origin: opportunity.origin,
      originState: opportunity.originState,
      destination: opportunity.destination,
      destinationState: opportunity.destinationState,
      equipmentType: opportunity.equipmentType,
      event: "sent",
      eventKey: `pafoe-outreach:${log.id}:sent`,
    });

    results.push({
      opportunityCarrierId: rowId,
      carrierId: row.carrierId,
      carrierName: carrier.name,
      status: "sent",
      threadId: sendResult.conversationId ?? sendResult.internetMessageId ?? null,
      internetMessageId: sendResult.internetMessageId ?? null,
    });
  }

  // ── Auto-queue next wave ────────────────────────────────────────────────
  // PAFOE design: the rep explicitly approves wave 1; subsequent waves
  // cascade automatically every FOLLOW_UP_DELAY_HOURS unless either (a) the
  // opportunity has already received any positive response, or (b) we've
  // exhausted MAX_WAVES, or (c) there are no un-sent carriers left.
  // The scheduler tick will release the queued rows; classifyOpportunityReply
  // calls cancelPendingWaves() the moment a positive reply lands.
  const sentRowIds = new Set(results.filter(r => r.status === "sent").map(r => r.opportunityCarrierId));
  if (sentRowIds.size > 0 && !opts.scheduleAt && wave < MAX_AUTOMATED_WAVES) {
    try {
      // Re-read from DB so freshly-sent rows are reflected (sentAt set);
      // otherwise we'd risk re-selecting wave-1 carriers for wave 2.
      const freshCarriers = await storage.listFreightOpportunityCarriers(opportunityId);
      await queueFollowUpWave(storage, opportunityId, freshCarriers, wave + 1, policy);
    } catch (err) {
      console.warn("[pafoe-outreach] follow-up queue failed:", err instanceof Error ? err.message : err);
    }
  }

  // Bump opportunity status: if at least one row sent, opp moves to "sent"
  // (or stays at "partially_covered" if it was already there). Pure-blocked
  // batches don't change status.
  const anySent = results.some(r => r.status === "sent");
  let opp = opportunity;
  if (anySent) {
    // Task #365 — once carriers go out, the opp is "awaiting_carrier_reply"
    // (was previously a flat "sent"). Terminal states (covered) and
    // partially_covered are preserved. The legacy "sent" value is kept stable
    // when a row was already there (no migration), but new transitions use
    // the more descriptive awaiting_carrier_reply.
    const next = opportunity.status === "covered" ? "covered"
      : opportunity.status === "partially_covered" ? "partially_covered"
      : opportunity.status === "awaiting_customer_confirm" ? "awaiting_customer_confirm"
      : opportunity.status === "sent" ? "sent"
      : "awaiting_carrier_reply";
    if (next !== opportunity.status) {
      const updated = await storage.updateFreightOpportunity(orgId, opportunityId, { status: next });
      if (updated) opp = updated;
      await storage.appendFreightOpportunityAudit({
        opportunityId,
        eventType: "status_changed",
        actorUserId: rep.id,
        payload: { from: opportunity.status, to: next, wave },
      });
    }
  }

  return { results, opportunity: opp };
}

interface SendOutcome {
  ok: boolean;
  internetMessageId?: string | null;
  conversationId?: string | null;
  error?: string;
}

async function performSend(opts: {
  useOutlook: boolean;
  outlookFromEmail: string | null;
  outlookReplyTo: string | null;
  sendOutlookEmail: typeof import("./outlookService").sendOutlookEmail;
  toEmail: string;
  subject: string;
  body: string;
}): Promise<SendOutcome> {
  const { useOutlook, outlookFromEmail, outlookReplyTo, sendOutlookEmail, toEmail, subject, body } = opts;
  const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:640px;line-height:1.6">${body.replace(/\n/g, "<br/>")}</div>`;
  if (useOutlook && outlookFromEmail) {
    const r = await sendOutlookEmail({
      fromEmail: outlookFromEmail,
      toEmail,
      subject,
      body: htmlBody,
      isHtml: true,
      replyToEmail: outlookReplyTo ?? undefined,
      saveToSentItems: true,
    });
    if (!r.ok) return { ok: false, error: r.error ?? "Outlook send failed" };
    return {
      ok: true,
      internetMessageId: r.internetMessageId?.replace(/[<>]/g, "") ?? null,
      conversationId: (r as { conversationId?: string | null }).conversationId ?? null,
    };
  }
  // Non-Outlook fallback: refuse rather than silently using a different
  // transport. The task is explicit: reuse the existing Outlook stack.
  return { ok: false, error: "Outlook is not configured for this rep" };
}

// ── Phased-wave automation helpers ───────────────────────────────────────────

/**
 * After a wave is sent, schedule the next-best un-sent carriers as the
 * follow-on wave at now + FOLLOW_UP_DELAY_HOURS. No-op if the opportunity
 * already has any positive response or if no eligible carriers remain.
 */
export async function queueFollowUpWave(
  storage: IStorage,
  opportunityId: string,
  allCarriers: FreightOpportunityCarrier[],
  nextWave: number,
  policy: { maxCarriersPerOpportunity: number },
): Promise<number> {
  if (await opportunityHasPositiveResponse(storage, allCarriers)) return 0;
  const candidates = allCarriers
    .filter(c => !c.sentAt && !c.scheduledFor && !c.excludedReason)
    .sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999))
    .slice(0, Math.min(MAX_CARRIERS_PER_WAVE, policy.maxCarriersPerOpportunity));
  if (candidates.length === 0) return 0;
  const releaseAt = new Date(Date.now() + FOLLOW_UP_DELAY_HOURS * 3600 * 1000);
  for (const row of candidates) {
    await storage.updateFreightOpportunityCarrier(row.id, {
      wave: nextWave,
      scheduledFor: releaseAt,
      lastSendError: null,
    });
  }
  await storage.appendFreightOpportunityAudit({
    opportunityId,
    eventType: "wave_scheduled",
    actorUserId: null,
    payload: {
      wave: nextWave,
      scheduledFor: releaseAt.toISOString(),
      carrierCount: candidates.length,
      reason: "auto_follow_up",
    },
  });
  return candidates.length;
}

/**
 * Cancel any future scheduled waves on this opportunity. Called when a
 * positive reply lands so we stop chasing carriers we no longer need.
 */
export async function cancelPendingWaves(
  storage: IStorage,
  opportunityId: string,
  reason: string,
): Promise<number> {
  const rows = await storage.listFreightOpportunityCarriers(opportunityId);
  const pending = rows.filter(r => r.scheduledFor && !r.sentAt);
  if (pending.length === 0) return 0;
  for (const row of pending) {
    await storage.updateFreightOpportunityCarrier(row.id, { scheduledFor: null });
  }
  await storage.appendFreightOpportunityAudit({
    opportunityId,
    eventType: "wave_scheduled",
    actorUserId: null,
    payload: { cancelled: pending.length, reason },
  });
  return pending.length;
}

async function opportunityHasPositiveResponse(
  storage: IStorage,
  carriers: FreightOpportunityCarrier[],
): Promise<boolean> {
  for (const c of carriers) {
    if (!c.lastResponseId) continue;
    const responses = await storage.listFreightOpportunityResponses(c.id);
    if (responses.some(r => POSITIVE_SET.has(r.outcome as FreightOpportunityResponseOutcome))) {
      return true;
    }
  }
  return false;
}

// ── Scheduler tick ──────────────────────────────────────────────────────────

/**
 * Process scheduled outreach rows whose `scheduled_for` is in the past.
 * Designed to be called from a setInterval at startup.
 */
export async function processDueScheduledWaves(storage: IStorage): Promise<{ processed: number; sent: number; blocked: number; failed: number }> {
  const due = await storage.listDueScheduledOpportunityCarriers(new Date(), 50);
  let sent = 0;
  let blocked = 0;
  let failed = 0;
  // Group by opportunity for efficiency
  const byOpp = new Map<string, FreightOpportunityCarrier[]>();
  for (const row of due) {
    const arr = byOpp.get(row.opportunityId) ?? [];
    arr.push(row);
    byOpp.set(row.opportunityId, arr);
  }
  for (const [oppId, rows] of byOpp) {
    // Find the opportunity to resolve org + creator
    const oppRow = await db.execute<{ org_id: string; created_by_id: string | null }>(
      sql`SELECT org_id, created_by_id FROM freight_opportunities WHERE id = ${oppId} LIMIT 1`,
    );
    const orgId = oppRow.rows[0]?.org_id;
    const creatorId = oppRow.rows[0]?.created_by_id;
    if (!orgId) continue;
    // Use the opportunity's creator as the rep (or first org admin as fallback).
    let rep = creatorId ? await storage.getUser(creatorId) : null;
    if (!rep) {
      const admin = await storage.getFirstOrgAdmin(orgId);
      rep = admin ? (await storage.getUser(admin.id)) ?? null : null;
    }
    if (!rep) continue;
    try {
      const { results } = await sendOpportunityWave(storage, orgId, oppId, rep, {
        carrierRowIds: rows.map(r => r.id),
        wave: rows[0]?.wave ?? 2,
      });
      for (const r of results) {
        if (r.status === "sent") sent++;
        else if (r.status === "blocked" || r.status === "no_email") blocked++;
        else if (r.status === "failed") failed++;
      }
    } catch (err) {
      console.warn(`[pafoe-scheduler] opp ${oppId} send error:`, err instanceof Error ? err.message : err);
      failed += rows.length;
    }
  }
  return { processed: due.length, sent, blocked, failed };
}

// ── Inbound classifier ──────────────────────────────────────────────────────

const POSITIVE_SET: ReadonlySet<FreightOpportunityResponseOutcome> = new Set([
  "interested_now",
  "interested_few_days",
  "interested_next_week",
  "interested_future",
  "booked",
]);

const NEGATIVE_SET: ReadonlySet<FreightOpportunityResponseOutcome> = new Set([
  "declined",
  "not_qualified",
  "do_not_contact_lane",
]);

interface ClassifierResult {
  outcome: FreightOpportunityResponseOutcome;
  confidence: number;
  reasoning: string;
  /**
   * Carrier-quoted rate extracted from the reply body, when present. Drives
   * the `quote` event into carrier_lane_outcomes (Task #637) and is persisted
   * onto the freight_opportunity_responses row. Null when no parseable
   * dollar amount appears.
   */
  quotedRate: number | null;
}

/**
 * Heuristic rate extractor for carrier reply bodies. Looks for a `$X,XXX(.XX)?`
 * dollar amount or a bare 3–5 digit number near rate-related keywords
 * ("rate", "all in", "do it for", "quote", "price", "will run"). Returns
 * the first plausible match (rounded to nearest dollar) or null.
 *
 * Exported for unit tests — kept side-effect-free.
 */
export function extractQuotedRate(body: string): number | null {
  if (!body) return null;
  const text = body.replace(/\s+/g, " ");
  // Strict: $X[,XXX](.XX)? — most reliable.
  const dollar = text.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})(?:\.[0-9]{1,2})?/);
  if (dollar) {
    const n = Number(dollar[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 100 && n <= 100000) return Math.round(n);
  }
  // Looser: rate/quote/all-in keyword followed shortly by a 3-5 digit number.
  const kw = text.match(
    /\b(?:rate|quote|price|all[\s-]?in|will\s+(?:run|do)|do\s+it\s+for|can\s+do)\b[^0-9]{0,40}([0-9]{3,5}(?:\.[0-9]{1,2})?)/i,
  );
  if (kw) {
    const n = Number(kw[1]);
    if (Number.isFinite(n) && n >= 100 && n <= 100000) return Math.round(n);
  }
  return null;
}

async function classifyReplyWithLLM(
  templateKind: FreightOutreachTemplateKind,
  outboundSnippet: string,
  inboundSubject: string,
  inboundBody: string,
): Promise<ClassifierResult> {
  const sys = `You classify carrier replies to freight outreach into ONE of these labels:
- interested_now: ready to cover this load right now / asks for rate-con
- interested_few_days: wants to cover but not for a few days
- interested_next_week: wants the lane next week / soon-but-not-now
- interested_future: open to future loads on this lane (capacity development)
- declined: not interested in this load (rate, busy, lane fit, polite no)
- not_qualified: cannot legally/operationally serve (no authority, equipment mismatch)
- no_response: out-of-office, unrelated, auto-acknowledgment, or non-substantive
- booked: explicitly confirms they are booking the load
- do_not_contact_lane: asks to be removed from this lane / unsubscribe / stop emailing
Also extract any carrier-quoted dollar rate (numeric, no $ or commas; null if absent).
Return strict JSON: { "outcome": "...", "confidence": 0-100, "reasoning": "1 sentence", "quotedRate": number|null }.`;
  const usr = `OUTREACH TYPE: ${templateKind}
ORIGINAL OUTREACH (truncated):
${outboundSnippet.slice(0, 500)}

REPLY SUBJECT: ${inboundSubject}
REPLY BODY (truncated):
${inboundBody.slice(0, 1800)}`;

  try {
    const OpenAI = (await import("openai")).default;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");
    const client = new OpenAI({ apiKey });
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    });
    const raw = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    const valid = new Set<string>([
      "interested_now", "interested_few_days", "interested_next_week",
      "interested_future", "declined", "not_qualified", "no_response",
      "booked", "do_not_contact_lane",
    ]);
    const outcome = (valid.has(parsed.outcome) ? parsed.outcome : "no_response") as FreightOpportunityResponseOutcome;
    // Trust the LLM extraction first, then fall back to the regex helper.
    // The regex catches cases where the LLM returns null but the body
    // clearly contains a "$2,500" / "rate is 2500" pattern.
    let quotedRate: number | null = null;
    const llmRate = Number(parsed.quotedRate);
    if (Number.isFinite(llmRate) && llmRate >= 100 && llmRate <= 100000) {
      quotedRate = Math.round(llmRate);
    } else {
      quotedRate = extractQuotedRate(inboundBody);
    }
    return {
      outcome,
      confidence: Math.max(0, Math.min(100, Number(parsed.confidence ?? 50))),
      reasoning: String(parsed.reasoning ?? "").slice(0, 320),
      quotedRate,
    };
  } catch {
    // Heuristic fallback — keyword-based + regex rate extraction.
    const b = inboundBody.toLowerCase();
    const s = inboundSubject.toLowerCase();
    const quotedRate = extractQuotedRate(inboundBody);
    if (s.includes("out of office") || s.includes("automatic reply")) {
      return { outcome: "no_response", confidence: 70, reasoning: "Auto-reply detected (heuristic)", quotedRate: null };
    }
    if (/\b(unsubscribe|remove me|do not (contact|email)|stop emailing)\b/.test(b)) {
      return { outcome: "do_not_contact_lane", confidence: 80, reasoning: "Opt-out language (heuristic)", quotedRate: null };
    }
    if (/\b(book(ed)?\s+it|send (the )?rate\s*con|covered)\b/.test(b)) {
      return { outcome: "booked", confidence: 65, reasoning: "Booking language (heuristic)", quotedRate };
    }
    if (/\b(yes|interested|sounds good|let's talk|i can cover)\b/.test(b)) {
      return { outcome: "interested_now", confidence: 55, reasoning: "Acceptance language (heuristic)", quotedRate };
    }
    if (/\b(next week|few days)\b/.test(b)) {
      return { outcome: "interested_next_week", confidence: 50, reasoning: "Timing keyword (heuristic)", quotedRate };
    }
    if (/\b(no thanks|not interested|pass|too low|cannot|can't run)\b/.test(b)) {
      // A decline with a counter-rate ("would need $3,200 to run it") still
      // counts as a quote signal on the lane, so preserve the extracted
      // rate even on the negative path.
      return { outcome: "declined", confidence: 55, reasoning: "Decline language (heuristic)", quotedRate };
    }
    return { outcome: "no_response", confidence: 40, reasoning: "Inconclusive (heuristic)", quotedRate: null };
  }
}

export async function classifyOpportunityReply(
  storage: IStorage,
  params: {
    orgId: string;
    conversationId: string | null;
    internetMessageId?: string | null;
    fromEmail: string;
    subject: string;
    bodyFull: string;
    providerMessageId: string;
    emailMessageId?: string | null;
  },
): Promise<{ matched: number; outcomes: FreightOpportunityResponseOutcome[] }> {
  const { orgId, conversationId, fromEmail, subject, bodyFull, internetMessageId } = params;
  if (!conversationId && !internetMessageId) return { matched: 0, outcomes: [] };

  const matches = await storage.findOpportunityCarriersByThreadOrMessage(orgId, {
    threadId: conversationId,
    internetMessageId: internetMessageId ?? null,
  });
  if (matches.length === 0) return { matched: 0, outcomes: [] };

  const outcomes: FreightOpportunityResponseOutcome[] = [];
  for (const oppCarrier of matches) {
    const opp = await storage.getFreightOpportunity(orgId, oppCarrier.opportunityId);
    if (!opp) continue;
    const templateKind: FreightOutreachTemplateKind =
      opp.mode === "exact_load" ? "exact_load" : "lane_building";
    const tmpl = await getOrSeedTemplate(storage, orgId, templateKind);
    const cls = await classifyReplyWithLLM(templateKind, tmpl.body, subject, bodyFull);

    const response = await storage.createFreightOpportunityResponse({
      opportunityCarrierId: oppCarrier.id,
      outcome: cls.outcome,
      replySource: "email",
      emailMessageId: params.emailMessageId ?? null,
      notes: cls.reasoning,
      recordedById: null,
      // Task #637 — persist any quoted rate the classifier or fallback
      // regex extracted from the reply body so the same number drives
      // both the response row and the carrier_lane_outcomes quote bump.
      quotedRate: cls.quotedRate !== null ? String(cls.quotedRate) : null,
    });

    await storage.updateFreightOpportunityCarrier(oppCarrier.id, {
      lastResponseId: response.id,
    });

    await storage.appendFreightOpportunityAudit({
      opportunityId: oppCarrier.opportunityId,
      eventType: "response_recorded",
      actorUserId: null,
      payload: {
        carrierId: oppCarrier.carrierId,
        outcome: cls.outcome,
        confidence: cls.confidence,
        source: "email_classifier",
        fromEmail,
        responseId: response.id,
      },
    });

    // Task #637 — every classified inbound bumps reply_count; positive
    // outcomes additionally bump yes_count, negatives bump loss_count.
    // The "no_response" bucket (auto-acknowledgements, OOO) is intentionally
    // skipped — it's not a substantive reply.
    if (oppCarrier.carrierId && cls.outcome !== "no_response") {
      const sig = laneSig(
        opp.origin,
        opp.originState,
        opp.destination,
        opp.destinationState,
        opp.equipmentType,
      );
      const laneParts = {
        origin: opp.origin,
        originState: opp.originState,
        destination: opp.destination,
        destinationState: opp.destinationState,
        equipmentType: opp.equipmentType,
      };
      // Each event tagged with the response.id so the same inbound
      // classified twice (e.g. webhook re-delivery) does not double-count.
      await recordCarrierLaneOutcome({
        orgId,
        carrierId: oppCarrier.carrierId,
        laneSignature: sig,
        ...laneParts,
        event: "reply",
        eventKey: `pafoe-reply:${response.id}:reply`,
      });
      if (POSITIVE_SET.has(cls.outcome)) {
        await recordCarrierLaneOutcome({
          orgId,
          carrierId: oppCarrier.carrierId,
          laneSignature: sig,
          ...laneParts,
          event: "yes",
          eventKey: `pafoe-reply:${response.id}:yes`,
        });
      } else if (NEGATIVE_SET.has(cls.outcome)) {
        await recordCarrierLaneOutcome({
          orgId,
          carrierId: oppCarrier.carrierId,
          laneSignature: sig,
          ...laneParts,
          event: "loss",
          eventKey: `pafoe-reply:${response.id}:loss`,
        });
      }
      // Independent of yes/loss: any reply that includes a parseable
      // dollar amount counts as a carrier quote on this lane.
      if (cls.quotedRate !== null) {
        await recordCarrierLaneOutcome({
          orgId,
          carrierId: oppCarrier.carrierId,
          laneSignature: sig,
          ...laneParts,
          event: "quote",
          eventKey: `pafoe-reply:${response.id}:quote`,
        });
      }
    }

    // If positive, cancel any future automated waves on this opportunity —
    // we have what we need.
    if (POSITIVE_SET.has(cls.outcome)) {
      try {
        await cancelPendingWaves(storage, oppCarrier.opportunityId, "positive_response");
      } catch (err) {
        console.warn("[pafoe-outreach] cancelPendingWaves failed:", err instanceof Error ? err.message : err);
      }

      // Task #365 — a positive carrier reply transitions an
      // "awaiting_carrier_reply" opp to "awaiting_customer_confirm" (the rep
      // now needs to confirm with the customer that the load is theirs).
      // Terminal statuses (covered, partially_covered) are not changed.
      if (
        opp.status === "awaiting_carrier_reply" ||
        opp.status === "sent" ||
        opp.status === "ready_to_send"
      ) {
        try {
          await storage.updateFreightOpportunity(orgId, opp.id, {
            status: "awaiting_customer_confirm",
          });
          await storage.appendFreightOpportunityAudit({
            opportunityId: opp.id,
            eventType: "status_changed",
            actorUserId: null,
            payload: {
              from: opp.status,
              to: "awaiting_customer_confirm",
              reason: "carrier_positive_reply",
              outcome: cls.outcome,
              carrierId: oppCarrier.carrierId,
            },
          });
        } catch (err) {
          console.warn("[pafoe-outreach] status transition to awaiting_customer_confirm failed:", err instanceof Error ? err.message : err);
        }
      }
    }

    // Additive signal feedback
    await feedbackToCarrierIntel(storage, {
      orgId,
      carrierId: oppCarrier.carrierId,
      opportunity: opp,
      outcome: cls.outcome,
      confidence: cls.confidence,
      sourceNote: cls.reasoning,
    });

    outcomes.push(cls.outcome);
  }
  return { matched: matches.length, outcomes };
}

// ── Signal feedback ─────────────────────────────────────────────────────────

/**
 * Convert a Phase 4 outcome into an additive carrier_intel_suggestion. Never
 * overwrites carrier master fields; status='accepted' so the existing
 * carrierRankingService's getBatchAcceptedIntelForCarriers picks it up
 * automatically on the next ranking pass.
 */
export async function feedbackToCarrierIntel(
  storage: IStorage,
  args: {
    orgId: string;
    carrierId: string;
    opportunity: FreightOpportunity;
    outcome: FreightOpportunityResponseOutcome;
    confidence?: number;
    sourceNote?: string;
    actorUserId?: string | null;
  },
): Promise<void> {
  const { orgId, carrierId, opportunity, outcome, confidence, sourceNote, actorUserId } = args;
  const isPositive = POSITIVE_SET.has(outcome);
  const isNegative = NEGATIVE_SET.has(outcome);
  if (!isPositive && !isNegative) return; // no_response / unknown — nothing to feed back

  let suggestionType: "lane_preference" | "capacity_available" | "capacity_unavailable" | "service_risk";
  if (outcome === "do_not_contact_lane") suggestionType = "service_risk";
  else if (outcome === "declined" || outcome === "not_qualified") suggestionType = "capacity_unavailable";
  else if (outcome === "interested_now" || outcome === "booked") suggestionType = "capacity_available";
  else suggestionType = "lane_preference"; // future/few_days/next_week

  const payload: InsertCarrierIntelSuggestion = {
    carrierId,
    orgId,
    sourceType: "email_signal",
    emailSignalId: null,
    marketSignalId: null,
    suggestionType,
    payload: {
      origin: opportunity.origin,
      originState: opportunity.originState,
      destination: opportunity.destination,
      destinationState: opportunity.destinationState,
      equipmentType: opportunity.equipmentType,
      laneOpportunityId: opportunity.id,
      outcome,
      direction: isPositive ? "positive" : "negative",
      note: sourceNote ?? null,
    },
    confidenceScore: Math.max(0, Math.min(100, confidence ?? 60)),
    // Auto-accept: response signals come from the carrier themselves (or the
    // rep manually logging them). They are the highest-quality intel we have
    // and should bias ranking immediately.
    status: "accepted",
    comment: `PAFOE outcome: ${outcome}`,
    acceptedByUserId: actorUserId ?? null,
    rejectedByUserId: null,
  };

  try {
    await db.insert(carrierIntelSuggestions).values({
      ...payload,
      acceptedAt: new Date(),
    });
    await storage.appendFreightOpportunityAudit({
      opportunityId: opportunity.id,
      eventType: "signal_fed_back",
      actorUserId: actorUserId ?? null,
      payload: { carrierId, suggestionType, direction: isPositive ? "positive" : "negative", outcome },
    });
  } catch (err) {
    console.warn("[pafoe] signal feedback insert failed:", err instanceof Error ? err.message : err);
  }
}
