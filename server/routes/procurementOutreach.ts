/**
 * Procurement Outreach Routes — Task #180
 *
 * LWQ-style carrier outreach for award lane procurement tasks.
 * Provides ranked carrier bench, AI email drafting, email dispatch,
 * and outreach log — mirroring the LWQ workflow.
 *
 * These endpoints work with taskId + lane info rather than laneId from recurring_lanes.
 * When a matchedLaneId is provided (task has a linked recurring lane), outreach logs
 * are written to carrier_outreach_logs. Per-carrier email history is stored on the
 * lane_carrier row itself via the outreach log embedded in the carrier row.
 */

import type { Express } from "express";
import { storage } from "../storage";
import { getCurrentUser, getVisibleCompanyIds, canAccessCompany } from "../auth";
import { rankCarriersForLane } from "../carrierRankingService";
import {
  formatLaneDisplay,
  formatWeeklyLoadRange,
  normalizeEquipmentType,
  buildFallbackEmail,
} from "../laneOutreachEmailBuilder";
import { sendEmail } from "../emailService";
import { sendOutlookEmail, outlookEnabled } from "../outlookService";
import type { RecurringLane } from "@shared/schema";
import { z } from "zod";

/** One entry in the per-carrier outreach log stored in lane_carriers.outreach_log */
interface OutreachLogEntry {
  sentAt: string;
  subject: string;
  bodyPreview: string;
  email: string | null;
  status: "sent" | "failed" | "no_email";
}

/**
 * Build a minimal RecurringLane-shaped object from procurement lane info
 * so we can reuse rankCarriersForLane without a real recurring lane record.
 */
function buildPseudoLane(
  orgId: string,
  origin: string,
  destination: string,
  volume: number,
  equipmentType?: string | null,
  customerName?: string | null,
): RecurringLane {
  const [originCity, originState] = origin.includes(",")
    ? origin.split(",").map(s => s.trim())
    : [origin.trim(), null];
  const [destinationCity, destinationState] = destination.includes(",")
    ? destination.split(",").map(s => s.trim())
    : [destination.trim(), null];

  const avgLoadsPerWeek = volume > 0 ? String((volume / 52).toFixed(2)) : null;

  return {
    id: "pseudo",
    orgId,
    companyId: null,
    companyName: customerName ?? null,
    origin,
    originState: originState ?? null,
    destination,
    destinationState: destinationState ?? null,
    equipmentType: equipmentType ?? null,
    avgLoadsPerWeek,
    weeksActive: 0,
    lookbackWeeks: 4,
    hasPreferredCarrierProgram: false,
    ownerUserId: null,
    overseerUserId: null,
    assignedAt: null,
    assignedByUserId: null,
    laneScore: null,
    laneScoreFactors: null,
    eligibilityConfidence: "medium",
    lastScoredAt: null,
    isEligible: true,
    snoozedUntil: null,
    carriersContactedCount: 0,
    resolvedAt: null,
    isManual: false,
    sourceQuoteId: null,
    dropTrailerShipper: false,
    dropTrailerReceiver: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function registerProcurementOutreachRoutes(app: Express): void {
  /**
   * GET /api/procurement/carrier-bench
   * Returns ranked carrier suggestions for a procurement lane.
   *
   * Query params:
   *   origin        — lane origin (e.g. "Phoenix, AZ")
   *   destination   — lane destination
   *   volume        — annual loads (number)
   *   equipmentType — optional equipment type string
   *   customerName  — optional customer name for scoring boost
   */
  app.get("/api/procurement/carrier-bench", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const origin = String(req.query.origin ?? "").trim();
    const destination = String(req.query.destination ?? "").trim();
    const volume = parseFloat(String(req.query.volume ?? "0")) || 0;
    const equipmentType = String(req.query.equipmentType ?? "").trim() || null;
    const customerName = String(req.query.customerName ?? "").trim() || null;

    if (!origin || !destination) {
      return res.status(400).json({ error: "origin and destination are required" });
    }

    try {
      const pseudoLane = buildPseudoLane(
        user.organizationId,
        origin,
        destination,
        volume,
        equipmentType,
        customerName,
      );

      let ranked = await rankCarriersForLane(pseudoLane, storage);

      // Suppress Do Not Use carriers
      ranked = ranked.filter(c => !c.isDoNotUse);

      // Sort by fitScore desc
      ranked.sort((a, b) => b.fitScore - a.fitScore);

      // Cap at top 30
      const carriers = ranked.slice(0, 30).map(c => ({
        carrierId: c.carrierId,
        carrierName: c.carrierName,
        mcDot: c.mcDot,
        primaryEmail: c.primaryEmail,
        backupEmail: c.backupEmail,
        phone: null as string | null,
        regions: c.regions,
        equipmentTypes: c.equipmentTypes,
        fitScore: c.fitScore,
        fitReason: c.fitReason,
        historyMatch: c.historyMatch,
        loadsOnLane: c.loadsOnLane,
        lastUsedMonth: c.lastUsedMonth,
        isNewProspect: c.isNewProspect,
        equipmentMatch: c.equipmentMatch,
        regionMatch: c.regionMatch,
        suppressionReasons: c.suppressionReasons,
        missingContactInfo: !c.primaryEmail && !c.backupEmail,
        tier: c.fitScore >= 75 ? 1 : c.fitScore >= 50 ? 2 : c.fitScore >= 30 ? 3 : 4,
      }));

      // Enrich with phone from catalog
      const carrierIds = carriers
        .map(c => c.carrierId)
        .filter((id): id is string => id !== null);
      if (carrierIds.length > 0) {
        const details = await storage.getCarriersByIds(carrierIds, user.organizationId);
        const phoneMap = new Map(details.map(d => [d.id, d.phone ?? null]));
        for (const c of carriers) {
          if (c.carrierId && phoneMap.has(c.carrierId)) {
            c.phone = phoneMap.get(c.carrierId) ?? null;
          }
        }
      }

      return res.json({ carriers });
    } catch (err) {
      console.error("[procurement/carrier-bench] error:", err);
      return res.status(500).json({ error: "Failed to rank carriers" });
    }
  });

  /**
   * POST /api/procurement/draft-outreach-emails
   * Draft AI outreach emails for carriers on a procurement lane.
   *
   * Body:
   *   origin          — lane origin
   *   destination     — lane destination
   *   volume          — annual loads
   *   equipmentType   — optional
   *   carriers        — array of { carrierId: string | null, carrierName: string }
   */
  app.post("/api/procurement/draft-outreach-emails", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const schema = z.object({
      origin: z.string().min(1),
      destination: z.string().min(1),
      volume: z.number().default(0),
      equipmentType: z.string().optional().nullable(),
      customerName: z.string().optional().nullable(),
      carriers: z.array(z.object({
        carrierId: z.string().nullable(),
        carrierName: z.string().min(1),
      })).min(1).max(20),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { origin, destination, volume, equipmentType, customerName, carriers } = parsed.data;

    const [originCity, originState] = origin.includes(",")
      ? origin.split(",").map(s => s.trim())
      : [origin.trim(), null];
    const [destinationCity, destinationState] = destination.includes(",")
      ? destination.split(",").map(s => s.trim())
      : [destination.trim(), null];
    const avgLoadsPerWeek = volume > 0 ? String((volume / 52).toFixed(2)) : null;

    try {
      const { callAI } = await import("../aiHelpers");

      const laneDisplay = formatLaneDisplay(origin, originState, destination, destinationState);
      const loadRange = formatWeeklyLoadRange(avgLoadsPerWeek);
      const equipment = normalizeEquipmentType(equipmentType);

      const emails = await Promise.all(
        carriers.map(async ({ carrierId, carrierName }) => {
          let carrierDetails = "";
          let hasVerifiedHistory = false;

          if (carrierId) {
            const c = await storage.getCarrier(carrierId);
            if (c && c.orgId === user.organizationId) {
              hasVerifiedHistory = !!c.payeeCode;
              if (c.regions?.length) carrierDetails += ` Preferred regions: ${c.regions.join(", ")}.`;
              if (c.equipmentTypes?.length) carrierDetails += ` Equipment: ${c.equipmentTypes.join(", ")}.`;
              if (c.notes) carrierDetails += ` Notes: ${c.notes}.`;
            }
          }

          const relationshipNote = hasVerifiedHistory
            ? `You have hauled freight for us before — acknowledge the prior relationship briefly in one clause. Do NOT say "we've run freight together before" verbatim.`
            : `This is a new prospect — introduce Value Truck as a freight brokerage in a single short phrase. Do NOT imply any prior business relationship.`;

          const prompt = `You are a freight broker writing a short outreach email to a carrier about a recurring lane.

Carrier: ${carrierName}
Lane: ${laneDisplay} (${equipment})
Weekly volume: ${loadRange}
${relationshipNote}${carrierDetails ? `\nCarrier context:${carrierDetails}` : ""}

House style — follow every rule:
- Direct, conversational, freight-native. Sound like a broker, not a sales rep or account manager.
- 3–4 short sentences MAX. Under 100 words.
- Use the lane exactly as written above: "${laneDisplay}". Never shorten, alter, or add "corridor" after it.
- Use the volume phrase exactly as given: "${loadRange}". Never convert to a decimal.
- BANNED — never use any of these phrases:
  "carrier bench", "we value our relationship", "ongoing coverage",
  "reaching out about", "love to connect", "top of mind",
  "lane runs consistently", "this lane runs consistently",
  "keep you in mind", "would love to", "I'd love to"
- End with a direct operational ask: "Does that fit your network?" or "If that fits your network, I'd be glad to talk through it."
- If this week doesn't work, say "if this week's tight, no worries" — not "I'd still love to connect."
- Vary sentence structure. Do not copy examples verbatim.
- Output ONLY the email body. No subject line. No sign-off block. No placeholders like [Name].`.trim();

          let body = "";
          try {
            body = await callAI(prompt);
          } catch {
            body = buildFallbackEmail(carrierName, hasVerifiedHistory, laneDisplay, equipment, loadRange, "lane_building");
          }

          return {
            carrierId,
            carrierName,
            subject: `Capacity Check: ${laneDisplay} (${equipment})`,
            body,
          };
        })
      );

      return res.json({ emails });
    } catch (err) {
      console.error("[procurement/draft-outreach-emails] error:", err);
      return res.status(500).json({ error: "Email drafting failed" });
    }
  });

  /**
   * POST /api/procurement/send-outreach-emails
   * Send emails to carriers and log outreach on the lane_carrier rows.
   *
   * Body:
   *   taskId          — procurement task ID
   *   awardId         — award ID
   *   lane            — lane label string
   *   origin          — lane origin
   *   destination     — lane destination
   *   matchedLaneId   — optional: recurring_lane id for outreach log
   *   emailDrafts     — array of { carrierId, carrierName, laneCarrierId, subject, body, recipientEmail? }
   *   capturedEmails  — optional map of carrierId/name → email to persist
   */
  app.post("/api/procurement/send-outreach-emails", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const schema = z.object({
      taskId: z.string().min(1),
      awardId: z.string().min(1),
      lane: z.string().min(1),
      origin: z.string().min(1),
      destination: z.string().min(1),
      matchedLaneId: z.string().nullable().optional(),
      emailDrafts: z.array(z.object({
        carrierId: z.string().nullable(),
        carrierName: z.string().min(1),
        laneCarrierId: z.string().nullable().optional(),
        subject: z.string().min(1),
        body: z.string().min(1),
        recipientEmail: z.string().email().nullable().optional(),
      })).min(1).max(20),
      capturedEmails: z.record(z.string().email()).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { taskId, awardId, lane, origin, destination, matchedLaneId, emailDrafts, capturedEmails = {} } = parsed.data;

    // ── Access-control: verify task and award belong to this user's org ─────────
    const task = await storage.getTask(taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Task access: mirrors verifyTaskAccess in routes.ts
    // If task is linked to a company, use canAccessCompany (full visibility rules).
    // Otherwise, resolve org via task.orgId (preferred) or assignedTo/assignedBy user.
    let taskAccessGranted = false;
    if (task.companyId) {
      taskAccessGranted = await canAccessCompany(user, task.companyId);
    } else {
      let taskOrgId: string | null | undefined = task.orgId;
      if (!taskOrgId) {
        const taskUserId = task.assignedTo || task.assignedBy;
        if (taskUserId) {
          const taskUser = await storage.getUser(taskUserId);
          taskOrgId = taskUser?.organizationId;
        }
      }
      taskAccessGranted = !!(taskOrgId && taskOrgId === user.organizationId);
    }
    if (!taskAccessGranted) {
      return res.status(403).json({ error: "Access denied: task does not belong to your organization" });
    }

    // Award access: mirrors verifyAwardAccess in routes.ts
    const award = await storage.getAward(awardId);
    if (!award) return res.status(404).json({ error: "Award not found" });
    const orgCompanies = await storage.getCompanies(user.organizationId);
    const orgCompanyIds = new Set(orgCompanies.map((c) => c.id));
    if (!orgCompanyIds.has(award.companyId)) {
      return res.status(403).json({ error: "Access denied: award does not belong to your organization" });
    }
    const visibleCompanyIds = await getVisibleCompanyIds(user);
    if (visibleCompanyIds !== null && !visibleCompanyIds.includes(award.companyId)) {
      return res.status(403).json({ error: "Access denied: award company not visible to your account" });
    }

    // Cross-entity consistency: ensure task's attachedLaneData references this awardId + lane
    // This prevents within-org cross-linking of tasks/awards that don't belong together.
    type LaneDataEntry = { awardId?: string; lane?: string; type?: string };
    const rawLaneData: unknown = task.attachedLaneData;
    const attachedLaneData: LaneDataEntry[] = Array.isArray(rawLaneData) ? rawLaneData as LaneDataEntry[] : [];
    const procEntry = attachedLaneData.find(e =>
      e.type === "carrier_procurement" &&
      e.awardId === awardId &&
      e.lane === lane
    );
    if (!procEntry) {
      return res.status(403).json({ error: "Task is not linked to the specified award and lane" });
    }

    // Verify each laneCarrierId provided belongs to this same task/award/org before trusting it
    for (const draft of emailDrafts) {
      if (!draft.laneCarrierId) continue;
      const lc = await storage.getLaneCarrier(draft.laneCarrierId);
      if (!lc) continue;
      if (lc.taskId !== taskId || lc.awardId !== awardId) {
        return res.status(403).json({
          error: `Carrier row ${draft.laneCarrierId} does not belong to the specified task/award`,
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────────

    // Org-guard: verify catalog carriers belong to this org
    for (const draft of emailDrafts) {
      if (!draft.carrierId) continue;
      const c = await storage.getCarrier(draft.carrierId);
      if (!c || c.orgId !== user.organizationId) {
        return res.status(403).json({ error: `Carrier ${draft.carrierId} not found in your organization` });
      }
    }

    // Persist captured emails to catalog for carriers with a known carrierId
    for (const draft of emailDrafts) {
      const key = draft.carrierId ?? draft.carrierName;
      const capturedEmail = typeof capturedEmails[key] === "string" ? capturedEmails[key].trim() : null;
      if (capturedEmail && draft.carrierId) {
        await storage.updateCarrier(draft.carrierId, user.organizationId, { primaryEmail: capturedEmail }).catch(() => {});
      }
    }

    const results: Array<{
      carrierId: string | null;
      carrierName: string;
      laneCarrierId: string | null | undefined;
      email: string | null;
      status: "sent" | "failed" | "no_email";
      error?: string;
      subject: string;
      body: string;
      internetMessageId?: string;
    }> = [];
    let sentCount = 0;
    let failedCount = 0;

    // Use the logged-in user's own Outlook mailbox when available, mirroring the LWQ send path.
    // username is the email address in this system.
    const outlookFromEmail = user.username?.trim() ?? null;
    const outlookReplyTo = process.env.OUTLOOK_REPLY_EMAIL?.trim() || null;
    const useOutlook = outlookEnabled() && !!outlookFromEmail;

    for (const draft of emailDrafts) {
      const key = draft.carrierId ?? draft.carrierName;

      // Resolve email: captured > recipientEmail > catalog primary/backup > lane_carrier row email
      let email: string | null = null;
      if (capturedEmails[key]?.trim()) {
        email = capturedEmails[key].trim();
      } else if (draft.recipientEmail) {
        email = draft.recipientEmail;
      } else if (draft.carrierId) {
        const c = await storage.getCarrier(draft.carrierId);
        if (c && c.orgId === user.organizationId) {
          email = c.primaryEmail ?? c.backupEmail ?? null;
        }
      }
      // Try lane_carrier email as last fallback
      if (!email && draft.laneCarrierId) {
        const lc = await storage.getLaneCarrier(draft.laneCarrierId);
        if (lc) email = lc.email ?? null;
      }

      if (!email) {
        results.push({
          carrierId: draft.carrierId,
          carrierName: draft.carrierName,
          laneCarrierId: draft.laneCarrierId,
          email: null,
          status: "no_email",
          error: "No email address available",
          subject: draft.subject,
          body: draft.body,
        });
        // Still track as "sent attempt" for logging — just no delivery
        continue;
      }

      const _fromName = user.name?.trim() || process.env.SMTP_FROM_NAME || "Value Truck · Freight DNA";
      const plainText = draft.body.replace(/<[^>]+>/g, "").trim();
      const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:600px;line-height:1.6">${draft.body.replace(/\n/g, "<br/>")}</div><br/><p style="color:#888;font-size:12px">— ${_fromName}</p>`;

      try {
        if (useOutlook && outlookFromEmail) {
          const result = await sendOutlookEmail({
            fromEmail: outlookFromEmail,
            toEmail: email,
            subject: draft.subject,
            body: htmlBody,
            isHtml: true,
            replyToEmail: outlookReplyTo ?? undefined,
          });
          if (result.ok) {
            // Strip RFC 2822 angle brackets so stored IDs match inbound In-Reply-To headers
            const cleanMsgId = result.internetMessageId?.replace(/[<>]/g, "") ?? undefined;
            results.push({
              carrierId: draft.carrierId,
              carrierName: draft.carrierName,
              laneCarrierId: draft.laneCarrierId,
              email,
              status: "sent",
              subject: draft.subject,
              body: draft.body,
              internetMessageId: cleanMsgId,
            });
            sentCount++;
          } else {
            results.push({
              carrierId: draft.carrierId,
              carrierName: draft.carrierName,
              laneCarrierId: draft.laneCarrierId,
              email,
              status: "failed",
              error: result.error ?? "Outlook send failed",
              subject: draft.subject,
              body: draft.body,
            });
            failedCount++;
          }
        } else {
          const ok = await sendEmail({ to: email, subject: draft.subject, html: htmlBody, text: plainText });
          if (ok) {
            results.push({
              carrierId: draft.carrierId,
              carrierName: draft.carrierName,
              laneCarrierId: draft.laneCarrierId,
              email,
              status: "sent",
              subject: draft.subject,
              body: draft.body,
            });
            sentCount++;
          } else {
            results.push({
              carrierId: draft.carrierId,
              carrierName: draft.carrierName,
              laneCarrierId: draft.laneCarrierId,
              email,
              status: "failed",
              error: "Email provider returned failure",
              subject: draft.subject,
              body: draft.body,
            });
            failedCount++;
          }
        }
      } catch (sendErr: unknown) {
        const errMsg = sendErr instanceof Error ? sendErr.message : "Send error";
        results.push({
          carrierId: draft.carrierId,
          carrierName: draft.carrierName,
          laneCarrierId: draft.laneCarrierId,
          email,
          status: "failed",
          error: errMsg,
          subject: draft.subject,
          body: draft.body,
        });
        failedCount++;
      }
    }

    // Update / create lane_carrier rows and append outreach log entries
    const sentAt = new Date().toISOString();

    for (const r of results) {
      const logEntry = {
        sentAt,
        subject: r.subject,
        bodyPreview: r.body.slice(0, 300),
        email: r.email,
        status: r.status,
      };

      let resolvedLcId = r.laneCarrierId ?? null;

      // If no laneCarrierId, try to find an existing row for this carrier on this task+lane
      if (!resolvedLcId) {
        const existing = await storage.getLaneCarriersByTask(taskId);
        const match = existing.find(
          (lc) =>
            lc.lane === lane &&
            lc.carrierName.toLowerCase() === r.carrierName.trim().toLowerCase(),
        );
        if (match) {
          resolvedLcId = match.id;
        } else {
          // Auto-create a lane_carrier row so the email is always logged
          try {
            const created = await storage.createLaneCarrier({
              taskId,
              awardId,
              lane,
              carrierName: r.carrierName.trim(),
              mcNumber: null,
              contactName: null,
              phone: null,
              email: r.email,
              rate: null,
              capacityPerWeek: null,
              notes: null,
              status: r.status === "sent" ? "emailed" : "contacted",
              outreachLog: [logEntry],
              createdAt: sentAt,
            });
            resolvedLcId = created.id;
            // Row created with log already — skip update below
            continue;
          } catch (createErr: unknown) {
            const msg = createErr instanceof Error ? createErr.message : String(createErr);
            if (!msg.includes("unique") && !msg.includes("duplicate")) {
              console.warn("[procurement/send] auto-create lane_carrier failed:", msg);
            }
            // Duplicate race — try to find it again
            const retry = await storage.getLaneCarriersByTask(taskId);
            const found = retry.find(
              (lc) =>
                lc.lane === lane &&
                lc.carrierName.toLowerCase() === r.carrierName.trim().toLowerCase(),
            );
            if (found) resolvedLcId = found.id;
          }
        }
      }

      if (!resolvedLcId) continue;

      // Verify ownership one more time before mutating (in case user supplied a laneCarrierId)
      const lc = await storage.getLaneCarrier(resolvedLcId);
      if (!lc || lc.taskId !== taskId || lc.awardId !== awardId) continue;

      const existingLog = lc.outreachLog;
      const currentLog: OutreachLogEntry[] = Array.isArray(existingLog) ? (existingLog as OutreachLogEntry[]) : [];
      const updatedLog: OutreachLogEntry[] = [...currentLog, logEntry];

      const updates: Partial<import("@shared/schema").InsertLaneCarrier> = {
        outreachLog: updatedLog,
      };
      // Auto-upgrade status to "emailed" only when a send succeeded and current status is "contacted"
      if (r.status === "sent" && (lc.status === "contacted" || lc.status === "emailed")) {
        updates.status = "emailed";
      }
      await storage.updateLaneCarrier(resolvedLcId, updates);
    }

    // Always write to carrier_outreach_logs for audit trail — use matchedLaneId if present,
    // otherwise write a stub record keyed to the procurement task context
    try {
      let outreachLaneId = matchedLaneId ?? null;
      let outreachCompanyId = award.companyId ?? null;
      let ownerUserId: string | null = null;
      let overseerUserId: string | null = null;

      if (outreachLaneId) {
        const matchedLane = await storage.getRecurringLane(outreachLaneId);
        if (!matchedLane || matchedLane.orgId !== user.organizationId) {
          // Matched lane doesn't belong to this org — fall back to task-only log
          outreachLaneId = null;
        } else {
          ownerUserId = matchedLane.ownerUserId ?? null;
          overseerUserId = matchedLane.overseerUserId ?? null;
        }
      }

      // Capture the primary internetMessageId for reply-thread matching
      const primaryThreadId = results.find(r => r.internetMessageId)?.internetMessageId ?? null;

      await storage.createCarrierOutreachLog({
        orgId: user.organizationId,
        laneId: outreachLaneId ?? null,
        companyId: outreachCompanyId,
        carrierIds: emailDrafts.map(d => d.carrierId).filter((id): id is string => id !== null),
        carrierNames: emailDrafts.map(d => d.carrierName),
        actorUserId: user.id,
        ownerUserId,
        overseerUserId,
        outreachMode: "lane_building",
        emailDrafts: JSON.parse(JSON.stringify(emailDrafts)),
        sentAt: sentCount > 0 ? new Date() : null,
        deliveryStatus: sentCount === emailDrafts.length ? "sent" : sentCount === 0 ? "failed" : "partial",
        failureReason: failedCount > 0 ? results.filter(r => r.error).map(r => `${r.carrierName}: ${r.error}`).join("; ") : null,
        recipients: JSON.parse(JSON.stringify(results)),
        procurementTaskId: taskId,
        procurementLane: lane,
        // Task #631 — tag the source so the unified contact-lock view shows
        // "Contacted via LWQ procurement by Sara".
        sourceModule: "lwq_procurement",
        // Store threadId so reply tracking can match inbound replies for procurement sends too
        threadId: primaryThreadId,
      });
    } catch (err) {
      console.warn("[procurement/send] carrier_outreach_logs write failed (non-fatal):", err);
    }

    return res.json({
      results,
      sentCount,
      failedCount,
      overallStatus: sentCount === emailDrafts.length ? "sent" : sentCount === 0 ? "failed" : "partial",
    });
  });
}
