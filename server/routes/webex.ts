import type { Express, Request, Response } from "express";
import { requireAuth, getCurrentUser } from "../auth";
import { storage } from "../storage";
import {
  webexCredentialsConfigured,
  fetchCallHistory,
  fetchWebexPeople,
  fetchPersonStatus,
  fetchCallRecording,
  phonesMatch,
  buildWebexCallDeepLink,
  type WebexCallRecord,
} from "../webexService";
import { analyzeTouchpointNote } from "../aiTouchpoint";
import { computeGrowthScore } from "../growthScoreCalculator";
import { checkAndFireMomentumDropNotification } from "../momentumNotifications";
import { getPlayForRuleType, getPlayByLabel, getAllPlayLabels } from "../playsRegistry";
import OpenAI from "openai";
import cron from "node-cron";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [webex] ${msg}`);
}

const presenceCache = new Map<string, { status: string; fetchedAt: number }>();
const PRESENCE_CACHE_TTL = 60_000;

async function syncCallsForOrg(orgId: string, hoursBack: number, customEndMs?: number): Promise<{
  touchpoints: any[];
  nbaCards: any[];
}> {
  const endMs = customEndMs ?? Date.now();
  const endTime = new Date(endMs).toISOString();
  const startTime = new Date(endMs - hoursBack * 3600 * 1000).toISOString();

  log(`Syncing calls for org ${orgId}: ${startTime} → ${endTime}`);

  const records = await fetchCallHistory(startTime, endTime);
  if (records.length === 0) return { touchpoints: [], nbaCards: [] };

  const orgCompanies = await storage.getCompanies(orgId);
  const orgCompanyIds = orgCompanies.map(c => c.id);
  const allContacts = orgCompanyIds.length > 0
    ? await storage.getContactsByCompanyIds(orgCompanyIds)
    : [];
  const contactsByPhone = new Map<string, typeof allContacts[0]>();
  for (const contact of allContacts) {
    if (contact.phone) {
      contactsByPhone.set(contact.phone, contact);
    }
  }

  const orgTouchpoints = orgCompanyIds.length > 0
    ? (await Promise.all(orgCompanyIds.map(cid => storage.getTouchpointsByCompany(cid)))).flat()
    : [];
  const existingCallIds = new Set<string>();
  for (const tp of orgTouchpoints) {
    if (tp.type === "call" && tp.notes) {
      const match = tp.notes.match(/\[Webex CDR: ([^\]]+)\]/);
      if (match) existingCallIds.add(match[1]);
    }
  }

  const existingMissedCallCdrIds = new Set<string>();
  const visibleCards = await storage.getVisibleNbaCardsForOrg(orgId);
  for (const card of visibleCards) {
    if (card.ruleType === "webex_missed_call" && card.signalSummary) {
      const sigs = Array.isArray(card.signalSummary) ? card.signalSummary : [];
      for (const sig of sigs) {
        const m = typeof sig === "string" ? sig.match(/\[CDR:([^\]]+)\]/) : null;
        if (m) existingMissedCallCdrIds.add(m[1]);
      }
    }
  }

  const orgUsers = await storage.getUsers(orgId);
  const defaultUserId = orgUsers[0]?.id;
  if (!defaultUserId) {
    log(`No users in org ${orgId}, skipping sync`);
    return { touchpoints: [], nbaCards: [] };
  }

  const createdTouchpoints: any[] = [];
  const createdNbaCards: any[] = [];

  for (const record of records) {
    if (existingCallIds.has(record.id)) continue;

    const otherNumber = record.direction === "ORIGINATING"
      ? record.calledNumber
      : record.callingNumber;

    let matchedContact = null;
    for (const [phone, contact] of contactsByPhone) {
      if (phonesMatch(phone, otherNumber)) {
        matchedContact = contact;
        break;
      }
    }

    if (!matchedContact) continue;

    if (!record.answered && record.direction === "TERMINATING") {
      if (existingMissedCallCdrIds.has(record.id)) continue;

      try {

        const play = getPlayForRuleType("webex_missed_call");
        const company = matchedContact.companyId
          ? await storage.getCompany(matchedContact.companyId)
          : null;

        const minutesAgo = Math.floor(
          (Date.now() - new Date(record.startTime).getTime()) / 60_000
        );
        const urgency = minutesAgo < 60 ? 90 : minutesAgo < 360 ? 60 : 30;

        const nbaCard = await storage.createNbaCard({
          orgId,
          userId: defaultUserId,
          companyId: matchedContact.companyId || null,
          contactId: matchedContact.id,
          companyName: company?.name || null,
          ruleType: "webex_missed_call",
          outcomeType: "protect",
          confidence: "high",
          signalCount: 1,
          signalSummary: [
            `Missed ${record.voicemailLeft ? "call + voicemail" : "call"} from ${matchedContact.name} (${otherNumber}) [CDR:${record.id}]`,
            `Call time: ${new Date(record.startTime).toLocaleString()}`,
          ],
          whyThisNow: `${matchedContact.name} called ${minutesAgo < 60 ? `${minutesAgo} minutes` : `${Math.round(minutesAgo / 60)} hours`} ago and you missed it.${record.voicemailLeft ? " They left a voicemail." : ""} Inbound interest from a known contact should be followed up immediately.`,
          suggestedAction: `Call ${matchedContact.name} back at ${otherNumber} — they reached out and couldn't get through.`,
          expectedOutcome: "Return the call promptly to demonstrate responsiveness and capture any inbound opportunity.",
          urgencyScore: urgency,
          playLabel: play?.name || null,
          status: "visible",
          createdAt: new Date().toISOString(),
        });

        createdNbaCards.push(nbaCard);
        log(`Created missed-call NBA card for ${matchedContact.name}`);
      } catch (err) {
        log(`Failed to create missed-call NBA card: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    if (!record.answered) continue;

    try {
      const callDate = new Date(record.startTime);
      const durationMin = Math.ceil(record.duration / 60);
      const dirLabel = record.direction === "ORIGINATING" ? "Outbound" : "Inbound";
      const company = matchedContact.companyId
        ? await storage.getCompany(matchedContact.companyId)
        : null;

      let notes = `[Webex CDR: ${record.id}] ${dirLabel} call with ${matchedContact.name} (${otherNumber}), duration: ${durationMin} min.`;

      if (record.recordingId) {
        try {
          const audioBuffer = await fetchCallRecording(record.recordingId);
          if (audioBuffer) {
            log(`Transcribing recording ${record.recordingId} (${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

            const file = new File([audioBuffer], "recording.webm", { type: "audio/webm" });
            const transcription = await openai.audio.transcriptions.create({
              file,
              model: "whisper-1",
              language: "en",
            });

            if (transcription.text) {
              notes += `\n\nCall Transcript:\n${transcription.text.slice(0, 3000)}`;
            }
          }
        } catch (recErr) {
          log(`Recording retrieval failed: ${recErr instanceof Error ? recErr.message : String(recErr)}`);
        }
      }

      let aiSentiment: string | null = null;
      let aiPlayLabel: string | null = null;
      let aiSummary: string | null = null;

      const hasTranscript = notes.includes("Call Transcript:");

      if (hasTranscript && notes.length > 100) {
        try {
          const playLabels = getAllPlayLabels();
          const postCallPrompt = `You are a freight brokerage CRM assistant. Analyze these post-call notes and generate a structured summary.

Company: ${company?.name || "Unknown"}
Contact: ${matchedContact.name}${matchedContact.title ? ` (${matchedContact.title})` : ""}
Notes: "${notes.slice(0, 3000)}"

Available play labels (match the closest one if applicable): ${playLabels.join(", ")}

Respond with valid JSON only (no markdown):
{
  "summary": "2-3 sentence structured summary of what was discussed and key outcomes",
  "followUps": [
    {"title": "short task title", "dueDays": number_of_days_from_now, "priority": "high"|"medium"|"low"}
  ],
  "playExecuted": "exact play label from the list above, or null if none clearly applies",
  "suggestedNextTouch": {
    "type": "call"|"email"|"text"|"site_visit",
    "timing": "specific timing suggestion",
    "dueDays": number_of_days_until_next_touch,
    "reason": "why this timing and type"
  },
  "sentiment": "positive"|"neutral"|"negative",
  "keyIntel": "one-sentence strategic intelligence extracted, or null"
}`;

          const resp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: postCallPrompt }],
            max_tokens: 600,
            temperature: 0.2,
          });

          const raw = resp.choices[0]?.message?.content?.trim() || "";
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const aiResult = JSON.parse(jsonMatch[0]);
            aiSentiment = aiResult.sentiment || null;
            aiPlayLabel = aiResult.playExecuted
              ? (getPlayByLabel(aiResult.playExecuted) ? aiResult.playExecuted : null)
              : null;
            aiSummary = aiResult.summary || null;

            if (aiResult.summary) {
              notes += `\n\nAI Summary: ${aiResult.summary}`;
            }
            if (aiResult.keyIntel) {
              notes += `\nKey Intel: ${aiResult.keyIntel}`;
            }

            if (aiResult.followUps && Array.isArray(aiResult.followUps)) {
              for (const fu of aiResult.followUps.slice(0, 5)) {
                if (!fu.title) continue;
                try {
                  const due = new Date();
                  due.setDate(due.getDate() + (fu.dueDays || 7));
                  await storage.createTask({
                    title: fu.title,
                    notes: `Auto-created from Webex call with ${matchedContact.name}`,
                    status: "open",
                    dueDate: due.toISOString().split("T")[0],
                    assignedTo: defaultUserId,
                    assignedBy: defaultUserId,
                    companyId: matchedContact.companyId || "",
                    contactId: matchedContact.id,
                    createdAt: new Date().toISOString(),
                  });
                } catch (taskErr) {
                  log(`Auto follow-up task creation failed: ${taskErr instanceof Error ? taskErr.message : String(taskErr)}`);
                }
              }
            }
          }
        } catch (aiErr) {
          log(`Post-call capture AI failed: ${aiErr instanceof Error ? aiErr.message : String(aiErr)}`);
        }
      } else {
        const aiInsights = await analyzeTouchpointNote(
          notes,
          matchedContact.name,
          company?.name,
        ).catch(() => null);

        if (aiInsights?.hasFollowUp && aiInsights.followUpTitle && aiInsights.followUpDueDays != null) {
          try {
            const due = new Date();
            due.setDate(due.getDate() + aiInsights.followUpDueDays);
            await storage.createTask({
              title: aiInsights.followUpTitle,
              notes: `Auto-created from Webex call with ${matchedContact.name}`,
              status: "open",
              dueDate: due.toISOString().split("T")[0],
              assignedTo: defaultUserId,
              assignedBy: defaultUserId,
              companyId: matchedContact.companyId || "",
              contactId: matchedContact.id,
              createdAt: new Date().toISOString(),
            });
          } catch (taskErr) {
            log(`Auto follow-up task creation failed: ${taskErr instanceof Error ? taskErr.message : String(taskErr)}`);
          }
        }

        if (aiInsights?.suggestMeaningful) {
          aiSentiment = null;
        }
      }

      const tp = await storage.createTouchpoint({
        contactId: matchedContact.id,
        companyId: matchedContact.companyId || "",
        type: "call",
        date: callDate.toISOString().split("T")[0],
        notes: notes.slice(0, 4000),
        sentiment: aiSentiment,
        isMeaningful: hasTranscript || record.duration >= 120,
        loggedById: defaultUserId,
        playLabel: aiPlayLabel,
        createdAt: callDate.toISOString(),
      });

      createdTouchpoints.push(tp);

      try {
        if (matchedContact.companyId) {
          const gs = await computeGrowthScore(matchedContact.companyId, orgId, storage);
          const savedGs = await storage.upsertGrowthScore({
            companyId: matchedContact.companyId,
            organizationId: orgId,
            score: gs.score,
            band: gs.band,
            drivers: gs.drivers,
            calculatedAt: new Date().toISOString(),
          });
          checkAndFireMomentumDropNotification(matchedContact.companyId, gs.band, savedGs.previousBand, storage).catch(() => {});
        }
      } catch (gsErr) {
        log(`Growth score recalc failed: ${gsErr instanceof Error ? gsErr.message : String(gsErr)}`);
      }

      log(`Created touchpoint for ${matchedContact.name} — ${dirLabel} call, ${durationMin} min`);
    } catch (tpErr) {
      log(`Failed to create touchpoint: ${tpErr instanceof Error ? tpErr.message : String(tpErr)}`);
    }
  }

  return { touchpoints: createdTouchpoints, nbaCards: createdNbaCards };
}

export function registerWebexRoutes(app: Express) {

  app.get("/api/webex/status", requireAuth, async (_req: Request, res: Response) => {
    res.json({ configured: webexCredentialsConfigured() });
  });

  app.get("/api/webex/deep-link/:phone", requireAuth, async (req: Request, res: Response) => {
    const phone = req.params.phone;
    if (!phone) return res.status(400).json({ error: "Phone number required" });
    res.json({ deepLink: buildWebexCallDeepLink(phone) });
  });

  app.get("/api/webex/presence/:phone", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!webexCredentialsConfigured()) {
        return res.json({ status: "unknown", configured: false });
      }

      const phone = req.params.phone;
      if (!phone) return res.status(400).json({ error: "Phone number required" });

      const cached = presenceCache.get(phone);
      if (cached && Date.now() - cached.fetchedAt < PRESENCE_CACHE_TTL) {
        return res.json({ status: cached.status, configured: true });
      }

      const people = await fetchWebexPeople(phone);
      if (people.length === 0) {
        presenceCache.set(phone, { status: "unknown", fetchedAt: Date.now() });
        return res.json({ status: "unknown", configured: true });
      }

      const status = await fetchPersonStatus(people[0].id);
      presenceCache.set(phone, { status, fetchedAt: Date.now() });

      res.json({ status, configured: true });
    } catch (err) {
      log(`Presence error: ${err instanceof Error ? err.message : String(err)}`);
      res.json({ status: "unknown", configured: true });
    }
  });

  app.post("/api/webex/sync-calls", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      if (!webexCredentialsConfigured()) {
        return res.status(400).json({ error: "Webex credentials not configured" });
      }

      const hoursBack = Math.min(Number(req.body?.hoursBack) || 24, 168);

      if (hoursBack <= 48) {
        const result = await syncCallsForOrg(user.organizationId, hoursBack);
        return res.json({
          synced: result.touchpoints.length,
          missedCallCards: result.nbaCards.length,
          touchpoints: result.touchpoints,
          nbaCards: result.nbaCards,
        });
      }

      let totalTouchpoints: any[] = [];
      let totalNbaCards: any[] = [];
      const now = Date.now();
      const chunkHours = 48;
      for (let offset = 0; offset < hoursBack; offset += chunkHours) {
        const chunkEndMs = now - offset * 3600_000;
        const chunkSize = Math.min(chunkHours, hoursBack - offset);
        log(`Batch sync chunk: ${chunkSize}h ending at ${new Date(chunkEndMs).toISOString()}`);
        const result = await syncCallsForOrg(user.organizationId, chunkSize, chunkEndMs);
        totalTouchpoints = totalTouchpoints.concat(result.touchpoints);
        totalNbaCards = totalNbaCards.concat(result.nbaCards);
      }

      res.json({
        synced: totalTouchpoints.length,
        missedCallCards: totalNbaCards.length,
        touchpoints: totalTouchpoints,
        nbaCards: totalNbaCards,
      });
    } catch (err) {
      log(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to sync Webex calls" });
    }
  });

  app.post("/api/webex/presence-batch", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!webexCredentialsConfigured()) {
        return res.json({ presenceMap: {}, configured: false });
      }

      const { phones = [] } = req.body || {};
      if (!Array.isArray(phones) || phones.length === 0) {
        return res.json({ presenceMap: {}, configured: true });
      }

      const presenceMap: Record<string, string> = {};
      const toFetch: string[] = [];

      for (const phone of phones.slice(0, 20)) {
        const cached = presenceCache.get(phone);
        if (cached && Date.now() - cached.fetchedAt < PRESENCE_CACHE_TTL) {
          presenceMap[phone] = cached.status;
        } else {
          toFetch.push(phone);
        }
      }

      for (const phone of toFetch) {
        try {
          const people = await fetchWebexPeople(phone);
          if (people.length > 0) {
            const status = await fetchPersonStatus(people[0].id);
            presenceMap[phone] = status;
            presenceCache.set(phone, { status, fetchedAt: Date.now() });
          } else {
            presenceMap[phone] = "unknown";
            presenceCache.set(phone, { status: "unknown", fetchedAt: Date.now() });
          }
        } catch {
          presenceMap[phone] = "unknown";
        }
      }

      res.json({ presenceMap, configured: true });
    } catch (err) {
      log(`Presence batch error: ${err instanceof Error ? err.message : String(err)}`);
      res.json({ presenceMap: {}, configured: true });
    }
  });
}

export function initWebexSyncScheduler(): void {
  if (!webexCredentialsConfigured()) {
    log("Webex credentials not configured — sync scheduler not started");
    return;
  }

  cron.schedule("*/30 * * * *", async () => {
    log("Background call sync starting...");
    try {
      const { db } = await import("../storage");
      const { organizations } = await import("../../shared/schema");
      const orgs = await db.select().from(organizations);

      for (const org of orgs) {
        try {
          const result = await syncCallsForOrg(org.id, 1);
          if (result.touchpoints.length > 0 || result.nbaCards.length > 0) {
            log(`Org ${org.id}: synced ${result.touchpoints.length} calls, ${result.nbaCards.length} missed-call cards`);
          }
        } catch (orgErr) {
          log(`Org ${org.id} sync error: ${orgErr instanceof Error ? orgErr.message : String(orgErr)}`);
        }
      }
      log("Background call sync complete");
    } catch (err) {
      log(`Background sync error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  log("Webex call sync scheduler started (every 30 minutes)");
}
