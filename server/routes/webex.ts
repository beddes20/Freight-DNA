import type { Express, Request, Response } from "express";
import { pStr, qStr, qOptStr } from "../lib/req";
import { getCurrentUser, requireAuth, requireUser } from "../auth";
import { storage } from "../storage";
import {
  webexCredentialsConfigured,
  getWebexOAuthUrl,
  getWebexRedirectUri,
  getWebexRedirectUriInfo,
  exchangeWebexCode,
  setWebexRefreshToken,
  setWebexRefreshTokenRotatedHandler,
  setWebexNeedsReauthHandler,
  refreshWebexAccessToken,
  getWebexAuthState,
  hasWebexTokens,
  webexNeedsReauth,
  fetchCallHistory,
  fetchCallDetail,
  fetchWebexPeople,
  fetchPersonStatus,
  fetchCallRecording,
  gradeCallQuality,
  phonesMatch,
  phoneMatchKey,
  buildWebexCallDeepLink,
  listWebexDevices,
  categorizeWebexCallDevice,
  WEBEX_OAUTH_SCOPES,
  webexFetch,
  type WebexCallRecord,
  type DeviceCategory,
} from "../webexService";
import { db } from "../storage";
import {
  notifyAdminsOfWebexReauthNeeded,
  maybeSendWebexReauthReminder,
  resetWebexReauthReminderState,
  initWebexReauthState,
} from "../webexReauthNotifications";
import { sendPendingWebexUserReauthEmails } from "../webexUserTokenService";
import { analyzeTouchpointNote } from "../aiTouchpoint";
import { computeGrowthScore } from "../growthScoreCalculator";
import { checkAndFireMomentumDropNotification } from "../momentumNotifications";
import { getPlayForRuleType, getPlayByLabel, getAllPlayLabels } from "../playsRegistry";
import {
  seedWebexUserMappings,
  resolveInternalUserIdForCall,
} from "../webexUserMappingService";
import { backfillWebexAttribution } from "../webexAttributionBackfill";
import {
  getUserWebexAccessToken,
  connectUserWebex,
  disconnectUserWebex,
} from "../webexUserTokenService";
import { enqueueEnrichmentJob, runEnrichmentSweep } from "../webexEnrichmentWorker";
import { kickOffOrgBackfill, MAX_BACKFILL_DAYS } from "../webexBackfillOrchestrator";
import { insertWebexUserMappingSchema, touchpoints, type WebexSyncState } from "@shared/schema";
import { and, eq, lte, inArray, sql } from "drizzle-orm";
import OpenAI from "openai";
import cron from "node-cron";
import crypto from "crypto";
import { getErrorMessage } from "../lib/errors";

const WEBEX_STATE_TTL_MS = 10 * 60 * 1000;
const WEBEX_STATE_RUNTIME_SECRET = crypto.randomBytes(32).toString("hex");
const _webexUsedNonces = new Map<string, number>();
function rememberWebexNonce(nonce: string) {
  _webexUsedNonces.set(nonce, Date.now());
}
function consumeWebexNonce(nonce: string): boolean {
  const now = Date.now();
  for (const [k, t] of _webexUsedNonces) {
    if (now - t > WEBEX_STATE_TTL_MS) _webexUsedNonces.delete(k);
  }
  if (_webexUsedNonces.has(nonce)) return false;
  _webexUsedNonces.set(nonce, now);
  return true;
}
function webexStateSecret(): string {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) return envSecret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET (>=16 chars) is required in production to sign per-user Webex OAuth state",
    );
  }
  // Non-production fallback: a per-process random secret. This keeps dev
  // usable while still being unpredictable across restarts, and it will
  // refuse to run entirely in production without a real secret.
  return WEBEX_STATE_RUNTIME_SECRET;
}
function signWebexUserState(userId: string): string {
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${userId}.${ts}.${nonce}`;
  const sig = crypto.createHmac("sha256", webexStateSecret()).update(payload).digest("hex");
  rememberWebexNonce(nonce);
  return `webex_oauth_user.${userId}.${ts}.${nonce}.${sig}`;
}
function verifyWebexUserState(state: string): { userId: string; nonce: string } | null {
  const parts = state.split(".");
  if (parts.length !== 5 || parts[0] !== "webex_oauth_user") return null;
  const [, userId, tsStr, nonce, sig] = parts;
  if (!userId || !tsStr || !nonce || !sig) return null;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || Date.now() - ts > WEBEX_STATE_TTL_MS) return null;
  const expected = crypto.createHmac("sha256", webexStateSecret()).update(`${userId}.${tsStr}.${nonce}`).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { userId, nonce };
}

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

/**
 * Classify a call as "after hours" for quality/after-hours scorecards.
 * Business hours are 7am–7pm local server time, Monday–Friday.
 */
function isAfterHoursCall(startIso: string): boolean {
  if (!startIso) return false;
  const d = new Date(startIso);
  if (isNaN(d.getTime())) return false;
  const hour = d.getHours();
  const dow = d.getDay();
  return dow === 0 || dow === 6 || hour < 7 || hour >= 19;
}

/**
 * Persist a Webex CDR's quality/talk-time analytics. Runs on every sync
 * pass (including for CDRs that already have a touchpoint) so first-run
 * backfills and later analytics-scope enablement catch up historical rows
 * without bloating the touchpoints table.
 */
async function persistCallAnalytics(
  orgId: string,
  record: WebexCallRecord,
  attributedUserId: string | null,
  matchedContact: { id: string; companyId: string | null } | null,
): Promise<void> {
  if (!record.id) return;
  try {
    const otherNumber = record.direction === "ORIGINATING" ? record.calledNumber : record.callingNumber;
    const grade = gradeCallQuality({
      mosScore: record.mosScore ?? null,
      jitterMs: record.jitterMs ?? null,
      packetLossPct: record.packetLossPct ?? null,
    });
    await storage.upsertWebexCallAnalytics({
      orgId,
      callId: record.id,
      userId: attributedUserId,
      webexPersonId: record.webexPersonId ?? null,
      webexUserEmail: record.webexUserEmail ?? null,
      direction: record.direction,
      remoteNumber: otherNumber || null,
      startTime: record.startTime ? new Date(record.startTime) : null,
      durationSeconds: record.duration ?? 0,
      answered: record.answered === true,
      talkTimeSeconds: record.talkTimeSeconds ?? Math.max(0, (record.duration ?? 0) - (record.holdTimeSeconds ?? 0)),
      holdTimeSeconds: record.holdTimeSeconds ?? 0,
      silenceSeconds: record.silenceSeconds ?? 0,
      ringTimeSeconds: record.ringTimeSeconds ?? 0,
      mosScore: record.mosScore != null ? String(record.mosScore) : null,
      jitterMs: record.jitterMs != null ? String(record.jitterMs) : null,
      packetLossPct: record.packetLossPct != null ? String(record.packetLossPct) : null,
      qualityGrade: grade,
      afterHours: isAfterHoursCall(record.startTime),
      companyId: matchedContact?.companyId || null,
      contactId: matchedContact?.id || null,
      touchpointId: null,
    });
  } catch (err) {
    log(`persistCallAnalytics failed for CDR ${record.id}: ${getErrorMessage(err)}`);
  }
}

async function syncCallsForOrg(
  orgId: string,
  hoursBack: number,
  customEndMs?: number,
  opts?: { forUser?: { userId: string; accessToken: string } },
): Promise<{
  touchpoints: any[];
  nbaCards: any[];
}> {
  const endMs = customEndMs ?? Date.now();
  const endTime = new Date(endMs).toISOString();
  const startTime = new Date(endMs - hoursBack * 3600 * 1000).toISOString();

  const scope = opts?.forUser ? `user ${opts.forUser.userId}` : `org ${orgId}`;
  log(`Syncing calls for ${scope}: ${startTime} → ${endTime}`);

  // Webex API failures are logged inside webexService.webexFetch (console
  // log + retry/backoff). The DB-backed failure audit log proposed in the
  // mid-refactor #466 work was abandoned (table never landed), so we no
  // longer try to mirror failures into a non-existent webex_api_failures
  // table from this hot path.
  const records = opts?.forUser
    ? await fetchCallHistory(startTime, endTime, 200, { accessToken: opts.forUser.accessToken, scope: "user" })
    : await fetchCallHistory(startTime, endTime, 200);
  if (records.length === 0) return { touchpoints: [], nbaCards: [] };

  const orgCompanies = await storage.getCompanies(orgId);
  const orgCompanyIds = orgCompanies.map(c => c.id);
  // Load all org contacts once for this sync so we can match inbound/outbound
  // call phone numbers against every known CRM contact without issuing one
  // query per record. We build an in-memory index keyed by the normalized
  // last-10-digit phone key that `storage.getContactByPhone` also uses, so
  // both paths share identical normalization rules.
  const allContacts = orgCompanyIds.length > 0
    ? await storage.getContactsByCompanyIds(orgCompanyIds)
    : [];
  type OrgContact = typeof allContacts[0];
  const contactsByPhoneKey = new Map<string, OrgContact>();
  for (const contact of allContacts) {
    // Index every known phone number for this contact so that calls placed
    // to/from either a direct line or mobile will resolve to the same CRM
    // record. First-write-wins on key collisions keeps behavior deterministic.
    const numbers = [contact.phone, contact.mobile].filter((n): n is string => !!n);
    for (const number of numbers) {
      const key = phoneMatchKey(number);
      if (key.length >= 7 && !contactsByPhoneKey.has(key)) {
        contactsByPhoneKey.set(key, contact);
      }
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
  const defaultUserId = opts?.forUser?.userId ?? orgUsers[0]?.id;
  if (!defaultUserId) {
    log(`No users in org ${orgId}, skipping sync`);
    return { touchpoints: [], nbaCards: [] };
  }

  const createdTouchpoints: any[] = [];
  const createdNbaCards: any[] = [];

  for (const record of records) {
    // ── Analytics persistence (Task #315) ─────────────────────────────
    // Resolve attribution up-front so we can store it alongside quality
    // metrics regardless of whether the call already has a touchpoint.
    const otherNumberEarly = record.direction === "ORIGINATING"
      ? record.calledNumber
      : record.callingNumber;
    let earlyMatchedContact: (typeof allContacts[0]) | null = null;
    if (otherNumberEarly) {
      const keyEarly = phoneMatchKey(otherNumberEarly);
      if (keyEarly.length >= 7) earlyMatchedContact = contactsByPhoneKey.get(keyEarly) ?? null;
    }
    let earlyAttributedUserId: string | null = defaultUserId;
    if (opts?.forUser) {
      earlyAttributedUserId = opts.forUser.userId;
    } else {
      try {
        const resolved = await resolveInternalUserIdForCall(
          orgId,
          record.webexPersonId,
          record.webexUserEmail,
        );
        earlyAttributedUserId = resolved.userId ?? defaultUserId;
      } catch {
        earlyAttributedUserId = defaultUserId;
      }
    }
    // Persist what we have inline (fast — uses fields already on the CDR), then
    // enqueue a tracked enrichment job for the deeper /telephony/calls/{id}
    // detail pull. The cron sweep retries 429s + transient 5xx with exponential
    // backoff so analytics don't silently get dropped (Task #466).
    persistCallAnalytics(orgId, record, earlyAttributedUserId, earlyMatchedContact).catch(() => {});
    void enqueueEnrichmentJob(orgId, record.id, earlyAttributedUserId);

    if (existingCallIds.has(record.id)) continue;

    const otherNumber = otherNumberEarly;

    // Resolve the remote party (customer/prospect) to a known CRM contact by
    // normalized phone number. This auto-attaches the synced call to the right
    // contact + account instead of letting it become an orphaned activity.
    // Falls back to skipping the record when no contact matches.
    let matchedContact: (typeof allContacts[0]) | null = null;
    if (otherNumber) {
      const key = phoneMatchKey(otherNumber);
      if (key.length >= 7) {
        matchedContact = contactsByPhoneKey.get(key) ?? null;
      }
      if (!matchedContact) {
        // Fallback: tolerant suffix match for international/short numbers that
        // the primary 10-digit key may miss. Checks every number on the
        // contact (direct + mobile) so secondary lines still auto-attach.
        for (const contact of allContacts) {
          const numbers = [contact.phone, contact.mobile].filter((n): n is string => !!n);
          if (numbers.some(n => phonesMatch(n, otherNumber))) {
            matchedContact = contact;
            break;
          }
        }
      }
    }

    // Resolve which internal user this Webex call should be attributed to.
    // In per-user (forUser) mode the token already belongs to a specific rep
    // so attribute directly. Otherwise look up the webex_user_mappings row.
    let attributedUserId: string | null = defaultUserId ?? null;
    if (opts?.forUser) {
      attributedUserId = opts.forUser.userId;
    } else {
      try {
        const resolved = await resolveInternalUserIdForCall(
          orgId,
          record.webexPersonId,
          record.webexUserEmail,
        );
        if (resolved.userId) {
          attributedUserId = resolved.userId;
        } else if (resolved.mapping?.status === "ignored") {
          log(`Skipping attribution for CDR ${record.id} — Webex person ${resolved.mapping.webexDisplayName ?? resolved.mapping.webexPersonId} is marked ignored; using default user`);
        } else {
          log(`No Webex user mapping for personId=${record.webexPersonId ?? "?"} email=${record.webexUserEmail ?? "?"} (CDR ${record.id}); falling back to default user`);
        }
      } catch (mapErr) {
        log(`Mapping lookup failed for CDR ${record.id}: ${mapErr instanceof Error ? mapErr.message : String(mapErr)}`);
      }
    }

    if (!record.answered && record.direction === "TERMINATING") {
      // Persist every missed inbound — known and unknown callers — so the
      // Missed Inbound portlet and weekly recap have a complete picture
      // regardless of whether the caller matches a CRM contact.
      try {
        const startDate = new Date(record.startTime);
        const localHour = startDate.getHours();
        const afterHours = localHour < 8 || localHour >= 18 || startDate.getDay() === 0 || startDate.getDay() === 6;
        await storage.upsertMissedInboundCall({
          orgId,
          cdrId: record.id,
          callingNumber: record.callingNumber,
          calledNumber: record.calledNumber ?? null,
          ringDurationSeconds: record.duration ?? 0,
          voicemailLeft: !!record.voicemailLeft,
          startTime: record.startTime,
          contactId: matchedContact?.id ?? null,
          companyId: matchedContact?.companyId ?? null,
          attributedUserId: attributedUserId ?? null,
          webexPersonId: record.webexPersonId ?? null,
          webexUserEmail: record.webexUserEmail ?? null,
          afterHours,
          nbaCardId: null,
          callbackCreatedAt: null,
          createdAt: new Date().toISOString(),
        });
      } catch (miErr) {
        log(`Failed to record missed inbound call ${record.id}: ${miErr instanceof Error ? miErr.message : String(miErr)}`);
      }

      if (!matchedContact) continue;
      if (!attributedUserId) continue;
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
          userId: attributedUserId,
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

        // Link the NBA card back to the missed_inbound_calls row so the
        // callback endpoint short-circuits instead of creating a duplicate
        // card when the coordinator clicks "Call back" on the portlet.
        try {
          const missedRow = await storage.getMissedInboundCallByCdr(orgId, record.id);
          if (missedRow && !missedRow.nbaCardId) {
            await storage.setMissedInboundCallback(missedRow.id, nbaCard.id);
          }
        } catch (linkErr) {
          log(`Failed to link NBA card to missed_inbound_calls: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`);
        }

        log(`Created missed-call NBA card for ${matchedContact.name}`);
      } catch (err) {
        log(`Failed to create missed-call NBA card: ${getErrorMessage(err)}`);
      }
      continue;
    }

    if (!record.answered) continue;
    if (!matchedContact) continue;
    if (!attributedUserId) continue;

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
                    assignedTo: attributedUserId,
                    assignedBy: attributedUserId,
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
              assignedTo: attributedUserId,
              assignedBy: attributedUserId,
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
        loggedById: attributedUserId,
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

// ── Auto-backfill on Webex (re)connect ───────────────────────────────────────
// Delegates to `kickOffOrgBackfill` (in webexBackfillOrchestrator.ts), which
// is the single canonical, fire-and-forget backfill entry point. Progress is
// tracked in `webex_sync_state` per data source so the admin Health panel can
// surface freshness and errors without an extra job-tracking table.
//
// NOTE: An earlier mid-refactor of #466 introduced a parallel set of helpers
// (runWebexHistoryBackfill, processWebexEnrichmentBatch, snapshot syncers,
// recordWebexApiFailure) that referenced tables which were never created
// (`webex_backfill_jobs`, `webex_api_failures`, `webex_workspaces`,
// `webex_locations`, `webex_call_queues`, `webex_hunt_groups`,
// `webex_devices_snapshot`, `webex_admin_reports`). Those helpers crashed
// every time they ran. They've been deleted in favor of the working
// orchestrator + storage-backed sync state.
export const WEBEX_DEFAULT_BACKFILL_DAYS = MAX_BACKFILL_DAYS;
export const WEBEX_MAX_BACKFILL_DAYS = MAX_BACKFILL_DAYS;

/** Reentrancy guard so two near-simultaneous OAuth callbacks don't
 *  each schedule their own deep backfill. The orchestrator has its own
 *  guard too, but we early-out here to avoid even logging duplicates. */
const _autoBackfillScheduled = new Set<string>();

/**
 * Kick off a deep backfill the first time an org connects Webex.
 * Idempotent: if a successful CDR-history sync state row already exists for
 * the org, we skip. Otherwise we delegate to `kickOffOrgBackfill`, which
 * runs snapshots (devices, workspaces, locations, queues, hunt groups) plus
 * the CDR attribution backfill in the background.
 */
async function maybeAutoBackfillOnConnect(orgId: string): Promise<void> {
  if (!orgId) return;
  if (_autoBackfillScheduled.has(orgId)) return;
  _autoBackfillScheduled.add(orgId);
  try {
    // Skip if any prior CDR backfill has already completed for this org.
    let existing: WebexSyncState[] = [];
    try {
      existing = await storage.getWebexSyncStatesForOrg(orgId);
    } catch (err) {
      log(`Auto-backfill sync-state lookup failed for org=${orgId}: ${getErrorMessage(err)}`);
    }
    const cdrRow = existing.find(
      (r) => r.dataSource === "cdr_history" && r.backfillCompletedAt,
    );
    if (cdrRow) {
      log(`Auto-backfill skipped for org=${orgId} — prior CDR backfill already on record`);
      return;
    }
    log(`Auto-backfill triggered for org=${orgId} (first Webex connect)`);
    kickOffOrgBackfill(orgId, MAX_BACKFILL_DAYS);
  } catch (err) {
    log(`Auto-backfill error org=${orgId}: ${getErrorMessage(err)}`);
  } finally {
    // Clear the in-flight marker after a short delay so future explicit
    // reconnects can retrigger if the prior run truly failed before
    // recording a sync_state row.
    setTimeout(() => _autoBackfillScheduled.delete(orgId), 60_000);
  }
}

export function registerWebexRoutes(app: Express) {

  async function loadStoredRefreshToken() {
    try {
      const result = await storage.pool.query(
        `SELECT response FROM api_response_cache WHERE cache_key = 'webex_refresh_token' LIMIT 1`
      );
      const row = result.rows?.[0];
      if (row?.response?.token) {
        setWebexRefreshToken(row.response.token);
        log("Loaded stored refresh token from DB");
        // Eagerly mint an access token at boot so the first request is fast
        // and so we surface a needs_reauth state immediately if revoked.
        try {
          await refreshWebexAccessToken();
        } catch (e) {
          log(`Initial token refresh failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      log(`No stored refresh token found`);
    }

    // Always restore the persisted needs-reauth flag (if any). Must run
    // AFTER the refresh-token load attempt so that a successful boot-time
    // refresh wins over a stale persisted disconnect flag.
    try {
      await initWebexReauthState();
    } catch (e) {
      log(`Reauth state init failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Task #466: bump every per-user token whose granted scope_version is
    // behind the current set. They get prompted to reconnect once so the
    // new analytics/admin scopes are granted; then everything lights up.
    try {
      const { WEBEX_SCOPES_VERSION } = await import("../webexService");
      const result = await storage.pool.query(
        `UPDATE webex_user_tokens
           SET needs_reauth = TRUE,
               reauth_reason = $1,
               last_reauth_email_at = NULL,
               updated_at = NOW()
         WHERE COALESCE(scope_version, 0) < $2
           AND needs_reauth = FALSE`,
        ["scope_upgrade_v" + WEBEX_SCOPES_VERSION, WEBEX_SCOPES_VERSION],
      );
      if ((result.rowCount ?? 0) > 0) {
        log(`Marked ${result.rowCount} per-user Webex tokens as needs-reauth (scope_version < ${WEBEX_SCOPES_VERSION})`);
      }
    } catch (e) {
      log(`Scope-version reauth bump failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function saveRefreshToken(token: string) {
    await storage.pool.query(
      `INSERT INTO api_response_cache (cache_key, response, fetched_at, ttl_seconds, source)
       VALUES ('webex_refresh_token', $1::jsonb, NOW(), 7776000, 'webex')
       ON CONFLICT (cache_key) DO UPDATE SET response = $1::jsonb, fetched_at = NOW()`,
      [JSON.stringify({ token })]
    );
  }

  async function deleteStoredRefreshToken() {
    try {
      await storage.pool.query(
        `DELETE FROM api_response_cache WHERE cache_key = 'webex_refresh_token'`
      );
      log("Deleted stored refresh token (re-authorization required)");
    } catch (e) {
      log(`Failed to delete stored refresh token: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  setWebexRefreshTokenRotatedHandler(async (token) => {
    try {
      await saveRefreshToken(token);
      log("Persisted rotated refresh token");
    } catch (e) {
      log(`Failed to persist rotated refresh token: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  setWebexNeedsReauthHandler(async (reason) => {
    log(`Webex needs re-authorization — clearing stored token and notifying admins. Reason: ${reason}`);
    await deleteStoredRefreshToken();
    await notifyAdminsOfWebexReauthNeeded(reason);
  });

  loadStoredRefreshToken();

  app.get("/api/webex/authorize", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const mode = (qStr(req.query.mode)) === "personal" ? "personal" : "org";
      if (mode === "org" && user.role !== "admin") {
        return res.status(403).json({ error: "Only admins can authorize the org-level Webex connection" });
      }
      if (!webexCredentialsConfigured()) {
        return res.status(400).json({ error: "Webex credentials not configured" });
      }
      const info = getWebexRedirectUriInfo(req);
      const state =
        mode === "personal"
          ? signWebexUserState(user.id)
          : `webex_oauth_org_${Date.now()}`;
      const authUrl = getWebexOAuthUrl(info.redirectUri, state);
      log(`Authorize (${mode}) → redirect_uri=${info.redirectUri} (source=${info.source})`);
      res.redirect(authUrl);
    } catch (err) {
      log(`Authorize error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to generate authorization URL" });
    }
  });

  app.get("/api/webex/debug-config", requireUser, async (req: Request, res: Response) => {
    const user = req.user!;
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }
    const info = getWebexRedirectUriInfo(req);
    res.json({
      configured: webexCredentialsConfigured(),
      authorized: hasWebexTokens(),
      redirectUri: info.redirectUri,
      redirectUriSource: info.source,
      fallbackRedirectUri: info.fallbackRedirectUri,
      envOverrides: {
        WEBEX_REDIRECT_URI: !!process.env.WEBEX_REDIRECT_URI?.trim(),
        APP_URL: !!process.env.APP_URL?.trim(),
      },
      clientIdSet: !!process.env.WEBEX_CLIENT_ID?.trim(),
      clientSecretSet: !!process.env.WEBEX_CLIENT_SECRET?.trim(),
      orgIdSet: !!process.env.WEBEX_ORG_ID?.trim(),
      portalUrl: "https://developer.webex.com/my-apps",
      hint: "Register the redirectUri above EXACTLY in your Webex Service App's Redirect URIs.",
    });
  });

  app.get("/api/webex/callback", async (req: Request, res: Response) => {
    const info = getWebexRedirectUriInfo(req);
    const renderError = (status: number, detail: string) => {
      const safeDetail = detail.replace(/[<>]/g, c => (c === "<" ? "&lt;" : "&gt;"));
      const safeUri = info.redirectUri.replace(/[<>"]/g, "");
      res.status(status).send(`
        <html><head><title>Webex Authorization Failed</title></head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:60px auto;padding:24px;color:#111">
          <h2 style="color:#b91c1c;margin-bottom:8px">Webex Authorization Failed</h2>
          <p style="color:#374151">${safeDetail}</p>
          <p style="margin-top:16px"><strong>Redirect URI used by this app:</strong><br/><code style="background:#f3f4f6;padding:4px 8px;border-radius:4px;display:inline-block;margin-top:4px">${safeUri}</code></p>
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:12px 16px;margin-top:20px">
            <p style="margin:0;font-weight:600;color:#92400e">Common cause: redirect URI mismatch</p>
            <p style="margin:6px 0 0 0;color:#78350f;font-size:14px">The redirect URI shown above must EXACTLY match one of the Redirect URIs registered for your Webex Service App at
              <a href="https://developer.webex.com/my-apps" target="_blank" rel="noopener" style="color:#b45309">developer.webex.com/my-apps</a>.
              Set the <code>WEBEX_REDIRECT_URI</code> or <code>APP_URL</code> env var to lock the value across environments.
            </p>
          </div>
          <p style="margin-top:20px;color:#6b7280;font-size:13px">You can close this window and try again from the admin settings.</p>
        </body></html>
      `);
    };

    try {
      const errParam = qOptStr(req.query.error);
      const errDesc = qOptStr(req.query.error_description);
      if (errParam) {
        log(`Callback error from Webex: ${errParam} — ${errDesc ?? ""}`);
        return renderError(400, `Webex returned an error: ${errParam}${errDesc ? ` — ${errDesc}` : ""}`);
      }

      const code = qStr(req.query.code);
      if (!code) {
        return renderError(400, "No authorization code was returned by Webex.");
      }

      const stateParam = (qStr(req.query.state)) || "";
      if (stateParam.startsWith("webex_oauth_user")) {
        // Per-user (Task #261) flow — verify signed state, confirm the
        // current browser session matches the initiating user, and consume
        // the one-time nonce to block replay.
        const verified = verifyWebexUserState(stateParam);
        if (!verified) {
          log(`Rejected per-user callback: state signature invalid or expired`);
          return renderError(400, "This Webex authorization link has expired or is invalid. Please start the connection again from your profile.");
        }
        const sessionUser = await getCurrentUser(req);
        if (!sessionUser) {
          return renderError(401, "You must be signed in to FreightDNA in this browser to complete Webex authorization. Please sign in and try again from your profile.");
        }
        if (sessionUser.id !== verified.userId) {
          log(`Rejected per-user callback: session user ${sessionUser.id} does not match state user ${verified.userId}`);
          return renderError(403, "This Webex authorization link belongs to a different FreightDNA user. Please start the connection from your own profile.");
        }
        if (!consumeWebexNonce(verified.nonce)) {
          log(`Rejected per-user callback: nonce already used or expired`);
          return renderError(400, "This Webex authorization link has already been used. Please start the connection again from your profile.");
        }
        const u = await storage.getUser(verified.userId);
        if (!u) {
          return renderError(400, "The user who started this connection could not be found.");
        }
        await connectUserWebex(u.organizationId, u.id, code, info.redirectUri);
        log(`Per-user OAuth complete for user ${u.id}`);
        // Auto-seed full history trendlines for this org (idempotent, async)
        void maybeAutoBackfillOnConnect(u.organizationId);
        // Task #466: kick off the full 13-month / max-window backfill across
        // CDRs + workspaces + locations + devices + queues + hunt groups.
        kickOffOrgBackfill(u.organizationId, MAX_BACKFILL_DAYS);
        return res.send(`
          <html><body style="font-family:sans-serif;text-align:center;padding:60px">
            <h2>Your Webex account is connected!</h2>
            <p>FreightDNA can now pull your personal call history and presence.</p>
            <p>You can close this window and return to the app.</p>
            <script>setTimeout(() => window.close(), 3000)</script>
          </body></html>
        `);
      }

      const tokens = await exchangeWebexCode(code, info.redirectUri);
      await saveRefreshToken(tokens.refresh_token);
      await resetWebexReauthReminderState();

      log(`OAuth complete — org tokens stored (redirect_uri=${info.redirectUri})`);
      // Auto-seed 90d history trendlines for the admin's org (idempotent, async)
      const sessionUser = await getCurrentUser(req);
      if (sessionUser?.organizationId) {
        void maybeAutoBackfillOnConnect(sessionUser.organizationId);
        kickOffOrgBackfill(sessionUser.organizationId, MAX_BACKFILL_DAYS);
      }
      res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Webex Connected Successfully!</h2>
          <p>FreightDNA can now sync your call history.</p>
          <p>You can close this window and return to the app.</p>
          <script>setTimeout(() => window.close(), 3000)</script>
        </body></html>
      `);
    } catch (err) {
      const msg = getErrorMessage(err);
      log(`Callback error: ${msg}`);
      log(`Callback error context — redirect_uri=${info.redirectUri} (source=${info.source})`);
      renderError(500, msg);
    }
  });

  app.get("/api/webex/status", requireUser, async (req: Request, res: Response) => {
    const info = getWebexRedirectUriInfo(req);
    const authState = getWebexAuthState();
    res.json({
      configured: authState.configured,
      authorized: hasWebexTokens(),
      needsReauth: authState.needsReauth,
      accessTokenExpiresAt: authState.accessTokenExpiresAt,
      lastRefreshAt: authState.lastRefreshAt,
      lastRefreshError: authState.lastRefreshError,
      redirectUri: info.redirectUri,
      redirectUriSource: info.source,
      portalUrl: "https://developer.webex.com/my-apps",
    });
  });

  app.get("/api/webex/deep-link/:phone", requireUser, async (req: Request, res: Response) => {
    const phone = pStr(req.params.phone);
    if (!phone) return res.status(400).json({ error: "Phone number required" });
    res.json({ deepLink: buildWebexCallDeepLink(phone) });
  });

  app.get("/api/webex/presence/:phone", requireUser, async (req: Request, res: Response) => {
    try {
      if (!webexCredentialsConfigured()) {
        return res.json({ status: "unknown", configured: false });
      }

      const phone = pStr(req.params.phone);
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
      log(`Presence error: ${getErrorMessage(err)}`);
      res.json({ status: "unknown", configured: true });
    }
  });

  app.get("/api/webex/my-connection", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const record = await storage.getWebexUserToken(user.id);
      const { WEBEX_SCOPES_VERSION } = await import("../webexService");
      const grantedScopes = (record?.scopes ?? "").split(/\s+/).filter(Boolean);
      const scopeUpgradeAvailable = !!record && (record.scopeVersion ?? 0) < WEBEX_SCOPES_VERSION;
      res.json({
        configured: webexCredentialsConfigured(),
        connected: !!record && !record.needsReauth,
        needsReauth: !!record?.needsReauth,
        reauthReason: record?.reauthReason ?? null,
        webexEmail: record?.webexEmail ?? null,
        webexDisplayName: record?.webexDisplayName ?? null,
        webexPersonId: record?.webexPersonId ?? null,
        connectedAt: record?.connectedAt ?? null,
        accessTokenExpiresAt: record?.accessTokenExpiresAt ?? null,
        lastRefreshAt: record?.lastRefreshAt ?? null,
        lastRefreshError: record?.lastRefreshError ?? null,
        grantedScopes,
        scopeVersion: record?.scopeVersion ?? 0,
        currentScopeVersion: WEBEX_SCOPES_VERSION,
        scopeUpgradeAvailable,
      });
    } catch (err) {
      log(`my-connection error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to load personal Webex connection" });
    }
  });

  app.delete("/api/webex/my-connection", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const deleted = await disconnectUserWebex(user.id);
      log(`User ${user.id} disconnected their personal Webex account (deleted=${deleted})`);
      res.json({ deleted });
    } catch (err) {
      log(`my-connection delete error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to disconnect Webex" });
    }
  });

  // Task #466: Admin Webex Health panel — surfaces per-user scope coverage,
  // last-success per data source, backfill progress %, and recent enrichment
  // failures in one view so admins can spot-check the integration.
  app.get("/api/webex/health", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      if (!user.organizationId) return res.status(400).json({ error: "User has no organization" });

      const { WEBEX_SCOPES_VERSION, WEBEX_OAUTH_SCOPES } = await import("../webexService");
      const requiredScopes = WEBEX_OAUTH_SCOPES.split(/\s+/).filter(Boolean);

      const [tokensResult, syncStatesResult, jobCountsResult, recentFailuresResult, inventoryCountsResult] = await Promise.all([
        storage.pool.query(
          `SELECT user_id, webex_email, webex_display_name, scopes,
                  COALESCE(scope_version, 0) AS scope_version,
                  needs_reauth, last_refresh_at, last_refresh_error,
                  connected_at, access_token_expires_at
             FROM webex_user_tokens
            WHERE org_id = $1
            ORDER BY connected_at DESC NULLS LAST`,
          [user.organizationId],
        ),
        storage.pool.query(
          `SELECT data_source, user_id, last_success_at, last_attempt_at,
                  last_error, cursor,
                  backfill_total_days, backfill_completed_days,
                  backfill_started_at, backfill_completed_at
             FROM webex_sync_state
            WHERE org_id = $1
            ORDER BY data_source, user_id NULLS FIRST`,
          [user.organizationId],
        ),
        storage.pool.query(
          `SELECT status, COUNT(*)::int AS count
             FROM webex_call_enrichment_jobs
            WHERE org_id = $1
            GROUP BY status`,
          [user.organizationId],
        ),
        storage.pool.query(
          `SELECT call_id, attempts, last_error, next_retry_at, updated_at
             FROM webex_call_enrichment_jobs
            WHERE org_id = $1
              AND status IN ('failed', 'dead_letter')
            ORDER BY updated_at DESC
            LIMIT 20`,
          [user.organizationId],
        ),
        storage.pool.query(
          `SELECT kind, COUNT(*)::int AS count, MAX(last_seen_at) AS last_updated_at
             FROM webex_inventory
            WHERE org_id = $1
            GROUP BY kind`,
          [user.organizationId],
        ),
      ]);

      const users = tokensResult.rows.map((row: any) => {
        const granted: string[] = (row.scopes ?? "").split(/\s+/).filter(Boolean);
        const grantedSet = new Set(granted);
        const missingScopes = requiredScopes.filter((s) => !grantedSet.has(s));
        return {
          userId: row.user_id,
          webexEmail: row.webex_email,
          webexDisplayName: row.webex_display_name,
          scopeVersion: row.scope_version,
          needsReauth: !!row.needs_reauth,
          scopeUpgradeAvailable: row.scope_version < WEBEX_SCOPES_VERSION,
          grantedScopes: granted,
          missingScopes,
          lastRefreshAt: row.last_refresh_at,
          lastRefreshError: row.last_refresh_error,
          connectedAt: row.connected_at,
          accessTokenExpiresAt: row.access_token_expires_at,
        };
      });

      const jobCounts: Record<string, number> = {
        pending: 0, running: 0, succeeded: 0, failed: 0, dead_letter: 0,
      };
      for (const r of jobCountsResult.rows) jobCounts[r.status] = r.count;

      const syncState = syncStatesResult.rows.map((row: any) => {
        const target = Number(row.backfill_total_days ?? 0);
        const done = Number(row.backfill_completed_days ?? 0);
        return {
          dataSource: row.data_source,
          userId: row.user_id,
          lastSuccessAt: row.last_success_at,
          lastAttemptAt: row.last_attempt_at,
          lastError: row.last_error,
          cursor: row.cursor,
          backfillTotalDays: target,
          backfillCompletedDays: done,
          backfillStartedAt: row.backfill_started_at,
          backfillCompletedAt: row.backfill_completed_at,
          progressPct: target > 0 ? Math.min(100, Math.round((done / target) * 100)) : null,
        };
      });

      const inventory = inventoryCountsResult.rows.map((row: any) => ({
        kind: row.kind,
        count: row.count,
        lastUpdatedAt: row.last_updated_at,
      }));

      res.json({
        currentScopeVersion: WEBEX_SCOPES_VERSION,
        requiredScopes,
        maxBackfillDays: MAX_BACKFILL_DAYS,
        users,
        syncState,
        enrichmentJobs: {
          counts: jobCounts,
          recentFailures: recentFailuresResult.rows.map((r: any) => ({
            callId: r.call_id,
            attempts: r.attempts,
            lastError: r.last_error,
            nextRetryAt: r.next_retry_at,
            updatedAt: r.updated_at,
          })),
        },
        inventory,
      });
    } catch (err) {
      log(`webex health error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to load Webex health" });
    }
  });

  app.post("/api/webex/sync-my-calls", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (!webexCredentialsConfigured()) {
        return res.status(400).json({ error: "Webex credentials not configured" });
      }
      const tokenResult = await getUserWebexAccessToken(user.id);
      if (!tokenResult) {
        return res.status(400).json({ error: "Your Webex account is not connected. Reconnect from your profile." });
      }
      const hoursBack = Math.min(Number(req.body?.hoursBack) || 24, 168);
      const result = await syncCallsForOrg(user.organizationId, hoursBack, undefined, {
        forUser: { userId: user.id, accessToken: tokenResult.token },
      });
      res.json({
        synced: result.touchpoints.length,
        missedCallCards: result.nbaCards.length,
        touchpoints: result.touchpoints,
        nbaCards: result.nbaCards,
      });
    } catch (err) {
      log(`sync-my-calls error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post("/api/webex/sync-calls", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;

      if (!webexCredentialsConfigured()) {
        return res.status(400).json({ error: "Webex credentials not configured" });
      }

      // Prefer the rep's own Webex token (Task #261) when available so calls
      // are sourced from their personal history; otherwise fall back to the
      // org-level token + user-mapping resolution. Transient refresh errors
      // are logged but do not block org fallback.
      let tokenResult: Awaited<ReturnType<typeof getUserWebexAccessToken>> = null;
      try {
        tokenResult = await getUserWebexAccessToken(user.id);
      } catch (e) {
        log(`Per-user token refresh failed, falling back to org token: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (tokenResult) {
        const hoursBack = Math.min(Number(req.body?.hoursBack) || 24, 168);
        const result = await syncCallsForOrg(user.organizationId, hoursBack, undefined, {
          forUser: { userId: user.id, accessToken: tokenResult.token },
        });
        return res.json({
          synced: result.touchpoints.length,
          missedCallCards: result.nbaCards.length,
          touchpoints: result.touchpoints,
          nbaCards: result.nbaCards,
          source: "user_token",
        });
      }

      if (!hasWebexTokens()) {
        return res.status(400).json({ error: "Webex not authorized. Visit /api/webex/authorize to connect." });
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
      log(`Sync error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to sync Webex calls" });
    }
  });

  // ── 90-day history backfill (Task #316) ──────────────────────────────────
  // Chunked call-history pull extending well past the 48h CDR visibility cap
  // so trendlines can be seeded the first time the analytics scope is enabled.
  app.post("/api/webex/backfill-history", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (user.role !== "admin" && user.role !== "director") {
        return res.status(403).json({ error: "Admin or director only" });
      }
      if (!webexCredentialsConfigured()) {
        return res.status(400).json({ error: "Webex credentials not configured" });
      }
      if (!hasWebexTokens()) {
        return res.status(400).json({ error: "Webex not authorized. Visit /api/webex/authorize to connect." });
      }
      if (webexNeedsReauth()) {
        return res.status(400).json({ error: "Webex needs re-authorization before a backfill can run." });
      }
      const daysBackRaw = Number(req.body?.daysBack);
      const daysBack = Number.isFinite(daysBackRaw) && daysBackRaw > 0
        ? Math.min(MAX_BACKFILL_DAYS, Math.floor(daysBackRaw))
        : 90;
      // Delegate to the orchestrator — it kicks off snapshots + CDR
      // attribution backfill in the background, tracks per-data-source
      // progress in `webex_sync_state`, and is reentrancy-safe.
      kickOffOrgBackfill(user.organizationId, daysBack);
      res.json({
        ok: true,
        scheduled: true,
        daysBack,
        message:
          "Backfill scheduled. Watch the admin Webex Health panel (Sync State) for per-data-source progress.",
      });
    } catch (err) {
      log(`backfill-history error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ── Webex user mappings (Task #258) ───────────────────────────────────────

  app.get("/api/webex/user-mappings", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const mappings = await storage.getWebexUserMappings(user.organizationId);
      const orgUsers = await storage.getUsers(user.organizationId);
      res.json({
        mappings,
        users: orgUsers.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role })),
      });
    } catch (err) {
      log(`List mappings error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to load Webex user mappings" });
    }
  });

  app.post("/api/webex/user-mappings/seed", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const result = await seedWebexUserMappings(user.organizationId);
      res.json(result);
    } catch (err) {
      log(`Seed mappings error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to seed Webex user mappings" });
    }
  });

  app.post("/api/webex/backfill-attribution", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      if (!webexCredentialsConfigured()) {
        return res.status(400).json({ error: "Webex credentials not configured" });
      }
      if (!hasWebexTokens()) {
        return res.status(400).json({ error: "Webex not authorized. Visit /api/webex/authorize to connect." });
      }
      if (webexNeedsReauth()) {
        return res.status(400).json({ error: "Webex needs re-authorization before a backfill can run." });
      }
      const daysBack = Number(req.body?.daysBack);
      const result = await backfillWebexAttribution(
        user.organizationId,
        Number.isFinite(daysBack) && daysBack > 0 ? daysBack : undefined,
      );
      if (result.chunkFetches.attempted > 0 && result.chunkFetches.succeeded === 0) {
        return res.status(502).json({
          error: "Unable to fetch any Webex call history — check Webex connectivity and try again.",
          result,
        });
      }
      res.json(result);
    } catch (err) {
      log(`Backfill attribution error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post("/api/webex/user-mappings", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const parsed = insertWebexUserMappingSchema.parse({
        ...req.body,
        orgId: user.organizationId,
      });
      const row = await storage.upsertWebexUserMapping(parsed);
      res.json(row);
    } catch (err) {
      log(`Upsert mapping error: ${getErrorMessage(err)}`);
      res.status(400).json({ error: getErrorMessage(err) });
    }
  });

  app.patch("/api/webex/user-mappings/:id", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const ALLOWED_STATUS = new Set(["needs_review", "auto_matched", "confirmed", "ignored"]);
      const updates: any = {};
      if ("userId" in req.body) updates.userId = req.body.userId || null;
      if ("status" in req.body) {
        if (!ALLOWED_STATUS.has(req.body.status)) {
          return res.status(400).json({ error: `Invalid status. Allowed: ${Array.from(ALLOWED_STATUS).join(", ")}` });
        }
        updates.status = req.body.status;
      }
      if ("notes" in req.body) updates.notes = req.body.notes;
      const row = await storage.updateWebexUserMapping(pStr(req.params.id), user.organizationId, updates);
      if (!row) return res.status(404).json({ error: "Mapping not found" });
      res.json(row);
    } catch (err) {
      log(`Update mapping error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to update mapping" });
    }
  });

  app.delete("/api/webex/user-mappings/:id", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const ok = await storage.deleteWebexUserMapping(pStr(req.params.id), user.organizationId);
      res.json({ deleted: ok });
    } catch (err) {
      log(`Delete mapping error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to delete mapping" });
    }
  });

  // ── Device & Workspace Usage Analytics (Task #319) ────────────────────────
  //
  // Admin-only read-only view. Aggregates per-rep device mix over the window
  // and surfaces unused provisioned devices. Attribution is via the existing
  // webex_user_mappings table (CDR personId/email -> internal userId).
  app.get("/api/webex/device-usage", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      if (!webexCredentialsConfigured()) {
        return res.status(400).json({ error: "Webex credentials not configured" });
      }
      if (!hasWebexTokens()) {
        return res.status(400).json({ error: "Webex not authorized. Visit /api/webex/authorize to connect." });
      }
      if (webexNeedsReauth()) {
        return res.status(400).json({ error: "Webex needs re-authorization." });
      }

      const daysRaw = Number(qStr(req.query.days));
      const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 90) : 30;
      const managerFilter = (qOptStr(req.query.managerId))?.trim() || null;

      // Fetch CDRs across the window in chunks (Webex caps windows). We page
      // 48h at a time and cap total records to keep the admin call bounded.
      const chunkHours = 48;
      const endMs = Date.now();
      const allRecords: WebexCallRecord[] = [];
      const MAX_RECORDS = 5000;
      for (let offset = 0; offset < days * 24 && allRecords.length < MAX_RECORDS; offset += chunkHours) {
        const chunkEndMs = endMs - offset * 3600_000;
        const chunkStartMs = chunkEndMs - Math.min(chunkHours, days * 24 - offset) * 3600_000;
        try {
          const chunk = await fetchCallHistory(
            new Date(chunkStartMs).toISOString(),
            new Date(chunkEndMs).toISOString(),
            Math.min(500, MAX_RECORDS - allRecords.length),
          );
          allRecords.push(...chunk);
        } catch (e) {
          log(`device-usage chunk fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Build person -> internal user index from mappings.
      const mappings = await storage.getWebexUserMappings(user.organizationId);
      const byPersonId = new Map<string, typeof mappings[number]>();
      const byEmail = new Map<string, typeof mappings[number]>();
      for (const m of mappings) {
        if (m.webexPersonId) byPersonId.set(m.webexPersonId, m);
        if (m.webexEmail) byEmail.set(m.webexEmail.toLowerCase(), m);
      }

      const orgUsers = await storage.getUsers(user.organizationId);
      const usersById = new Map(orgUsers.map(u => [u.id, u]));

      // Manager filter = direct reports of this manager (managerId match).
      const includeUserId = (uid: string | null | undefined): boolean => {
        if (!managerFilter) return true;
        if (!uid) return false;
        const u = usersById.get(uid);
        if (!u) return false;
        return u.managerId === managerFilter;
      };

      type PerRep = {
        userId: string;
        userName: string;
        webexDisplayName: string | null;
        totalCalls: number;
        deskAppCalls: number;
        mobileCalls: number;
        deskPhoneCalls: number;
        otherCalls: number;
        headsetCalls: number;
        lastCallAt: string | null;
      };
      const perRep = new Map<string, PerRep>();
      const lastUseByMac = new Map<string, string>();
      const lastUseByPersonId = new Map<string, Map<DeviceCategory, string>>();

      for (const rec of allRecords) {
        // Track device last-use by MAC even if we can't attribute the call.
        if (rec.deviceMac) {
          const prev = lastUseByMac.get(rec.deviceMac);
          if (!prev || rec.startTime > prev) lastUseByMac.set(rec.deviceMac, rec.startTime);
        }

        // Attribute call to internal user via mapping table.
        let mapping = rec.webexPersonId ? byPersonId.get(rec.webexPersonId) : undefined;
        if (!mapping && rec.webexUserEmail) mapping = byEmail.get(rec.webexUserEmail.toLowerCase());
        const internalUserId = mapping?.userId ?? null;
        if (!internalUserId) continue;
        if (!includeUserId(internalUserId)) continue;

        const userRec = usersById.get(internalUserId);
        const key = internalUserId;
        let entry = perRep.get(key);
        if (!entry) {
          entry = {
            userId: internalUserId,
            userName: userRec?.name || userRec?.username || "Unknown",
            webexDisplayName: mapping?.webexDisplayName ?? null,
            totalCalls: 0,
            deskAppCalls: 0,
            mobileCalls: 0,
            deskPhoneCalls: 0,
            otherCalls: 0,
            headsetCalls: 0,
            lastCallAt: null,
          };
          perRep.set(key, entry);
        }
        entry.totalCalls++;
        if (!entry.lastCallAt || rec.startTime > entry.lastCallAt) entry.lastCallAt = rec.startTime;
        const cat = categorizeWebexCallDevice(rec);
        if (cat === "desk_app") entry.deskAppCalls++;
        else if (cat === "mobile") entry.mobileCalls++;
        else if (cat === "desk_phone") entry.deskPhoneCalls++;
        else entry.otherCalls++;
        if (rec.headsetModel || rec.headsetMake) entry.headsetCalls++;

        // Track personId-level last-use-by-category for person-owned devices.
        if (rec.webexPersonId) {
          let catMap = lastUseByPersonId.get(rec.webexPersonId);
          if (!catMap) { catMap = new Map(); lastUseByPersonId.set(rec.webexPersonId, catMap); }
          const prev = catMap.get(cat);
          if (!prev || rec.startTime > prev) catMap.set(cat, rec.startTime);
        }
      }

      // Pull device list and compute unused flags.
      let devices: Awaited<ReturnType<typeof listWebexDevices>> = [];
      try {
        devices = await listWebexDevices();
      } catch (e) {
        log(`device-usage: listWebexDevices failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      const nowMs = Date.now();
      const UNUSED_THRESHOLD_MS = 30 * 24 * 3600 * 1000;
      const deviceRows = devices.map(d => {
        const categoryGuess: DeviceCategory =
          /headset/i.test(d.product ?? "") || /headset/i.test(d.productType ?? "") ? "other" :
          /phone/i.test(d.product ?? "") || /phone/i.test(d.productType ?? "") ? "desk_phone" :
          /app|client|desktop|mobile/i.test(d.productType ?? "") ? "desk_app" : "other";

        // Prefer MAC-level last use from CDRs; fall back to connectionStatus
        // last-seen timestamp, then finally to "unknown".
        let lastUsedAt: string | null = null;
        if (d.mac && lastUseByMac.has(d.mac)) lastUsedAt = lastUseByMac.get(d.mac)!;
        else if (d.personId && categoryGuess !== "other") {
          const catMap = lastUseByPersonId.get(d.personId);
          if (catMap) lastUsedAt = catMap.get(categoryGuess) ?? null;
        }
        if (!lastUsedAt) lastUsedAt = d.lastConnectionAt ?? null;

        const lastUsedMs = lastUsedAt ? new Date(lastUsedAt).getTime() : null;
        const daysSinceLastUse =
          lastUsedMs && Number.isFinite(lastUsedMs)
            ? Math.floor((nowMs - lastUsedMs) / (24 * 3600 * 1000))
            : null;
        const unused = daysSinceLastUse === null || daysSinceLastUse >= 30;

        // Map Webex personId -> our internal user when possible, so admins
        // can see "John Smith's desk phone" rather than a raw Webex ID.
        let assignedUserId: string | null = null;
        let assignedUserName: string | null = null;
        if (d.personId) {
          const m = byPersonId.get(d.personId);
          if (m?.userId) {
            assignedUserId = m.userId;
            const u = usersById.get(m.userId);
            assignedUserName = u?.name ?? u?.username ?? null;
          }
        }

        return {
          id: d.id,
          displayName: d.displayName,
          product: d.product,
          productType: d.productType,
          type: d.type,
          mac: d.mac,
          connectionStatus: d.connectionStatus,
          lastUsedAt,
          daysSinceLastUse,
          unused,
          assignedUserId,
          assignedUserName,
          webexPersonId: d.personId,
          workspaceId: d.workspaceId,
        };
      });

      // Managers for the dropdown (users who have at least one direct report).
      const managerIds = new Set<string>();
      for (const u of orgUsers) if (u.managerId) managerIds.add(u.managerId);
      const managers = orgUsers
        .filter(u => managerIds.has(u.id))
        .map(u => ({ id: u.id, name: u.name || u.username }));

      res.json({
        days,
        totalCalls: allRecords.length,
        truncated: allRecords.length >= MAX_RECORDS,
        perRep: Array.from(perRep.values()).sort((a, b) => b.totalCalls - a.totalCalls),
        devices: deviceRows
          .filter(d => !managerFilter || !d.assignedUserId || includeUserId(d.assignedUserId))
          .sort((a, b) => {
            if (a.unused !== b.unused) return a.unused ? -1 : 1;
            return (b.daysSinceLastUse ?? 0) - (a.daysSinceLastUse ?? 0);
          }),
        managers,
      });
    } catch (err) {
      log(`device-usage error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ─── Missed Inbound Visibility (Task #317) ────────────────────────────────
  // Returns missed inbound calls for the current user's org within the
  // requested window, hydrated with contact/company/attributed-rep details
  // so the portlet can render callback actions without follow-up requests.
  app.get("/api/webex/missed-inbound", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;

      const hours = Math.min(Math.max(parseInt((qStr(req.query.hours)) || "48", 10) || 48, 1), 24 * 14);
      const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const rows = await storage.getMissedInboundCallsForOrg(user.organizationId, sinceIso);

      const contactIds = Array.from(new Set(rows.map(r => r.contactId).filter((v): v is string => !!v)));
      const companyIds = Array.from(new Set(rows.map(r => r.companyId).filter((v): v is string => !!v)));
      const userIds = Array.from(new Set(rows.map(r => r.attributedUserId).filter((v): v is string => !!v)));

      const [contacts, companies, users] = await Promise.all([
        Promise.all(contactIds.map(id => storage.getContact(id))),
        Promise.all(companyIds.map(id => storage.getCompany(id))),
        Promise.all(userIds.map(id => storage.getUser(id))),
      ]);
      const contactMap = new Map(contacts.filter(Boolean).map(c => [c!.id, c!]));
      const companyMap = new Map(companies.filter(Boolean).map(c => [c!.id, c!]));
      const userMap = new Map(users.filter(Boolean).map(u => [u!.id, u!]));

      // Repeat-caller detection within the window — surfaces patterns like
      // "this number has called 3 times today" so coordinators prioritize.
      const byPhone = new Map<string, number>();
      for (const r of rows) {
        const key = phoneMatchKey(r.callingNumber);
        byPhone.set(key, (byPhone.get(key) ?? 0) + 1);
      }

      const hydrated = rows.map(r => {
        const contact = r.contactId ? contactMap.get(r.contactId) : null;
        const company = r.companyId ? companyMap.get(r.companyId) : null;
        const attributedUser = r.attributedUserId ? userMap.get(r.attributedUserId) : null;
        return {
          id: r.id,
          cdrId: r.cdrId,
          callingNumber: r.callingNumber,
          calledNumber: r.calledNumber,
          ringDurationSeconds: r.ringDurationSeconds,
          voicemailLeft: r.voicemailLeft,
          startTime: r.startTime,
          afterHours: r.afterHours,
          callbackCreatedAt: r.callbackCreatedAt,
          nbaCardId: r.nbaCardId,
          contact: contact ? { id: contact.id, name: contact.name, title: contact.title ?? null } : null,
          company: company ? { id: company.id, name: company.name } : null,
          attributedUser: attributedUser ? { id: attributedUser.id, name: attributedUser.name } : null,
          repeatCount: byPhone.get(phoneMatchKey(r.callingNumber)) ?? 1,
          known: !!r.contactId,
        };
      });

      res.json({ calls: hydrated, windowHours: hours });
    } catch (err) {
      log(`Missed inbound list error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to load missed inbound calls" });
    }
  });

  // Click-to-callback: creates a `webex_missed_call` NBA card on the
  // attributed rep (or the calling user when no rep is attributed / caller is
  // unknown) and returns a navigation target so the UI can open the contact
  // record or a quick-add screen for unknown numbers.
  app.post("/api/webex/missed-inbound/:id/callback", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;

      const missed = await storage.getMissedInboundCall(pStr(req.params.id));
      if (!missed || missed.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Missed call not found" });
      }

      // Short-circuit if a callback NBA card has already been created for
      // this missed call — return the existing navigation target so the
      // client can simply deep-link the user into the contact/unknown flow.
      if (missed.nbaCardId) {
        return res.json({
          nbaCardId: missed.nbaCardId,
          contactId: missed.contactId,
          companyId: missed.companyId,
          navigate: missed.contactId
            ? { kind: "contact", contactId: missed.contactId }
            : { kind: "unknown", phone: missed.callingNumber },
        });
      }

      // Unknown callers (no CRM contact match) route to a coordinator queue
      // rather than the clicking user — otherwise an admin or ops lead
      // investigating the portlet would silently own every stranger that
      // dials in. Prefer the rep the call actually rang; if there's no
      // attribution, pick the first available coordinator/ops user in the
      // org, and only fall back to the clicking user as a last resort.
      async function pickCoordinator(): Promise<string> {
        try {
          const orgUsers = await storage.getUsers(user!.organizationId);
          const coord = orgUsers.find(u =>
            u.role === "logistics_coordinator" ||
            u.role === "coordinator" ||
            u.role === "operations"
          );
          return coord?.id ?? user!.id;
        } catch {
          return user!.id;
        }
      }
      const assignTo = missed.contactId
        ? (missed.attributedUserId ?? user.id)
        : (missed.attributedUserId ?? await pickCoordinator());
      const play = getPlayForRuleType("webex_missed_call");
      const contact = missed.contactId ? await storage.getContact(missed.contactId) : null;
      const company = missed.companyId ? await storage.getCompany(missed.companyId) : null;

      const minutesAgo = Math.floor((Date.now() - new Date(missed.startTime).getTime()) / 60_000);
      const urgency = minutesAgo < 60 ? 90 : minutesAgo < 360 ? 60 : 40;
      const callerLabel = contact?.name ?? `unknown caller ${missed.callingNumber}`;

      const nbaCard = await storage.createNbaCard({
        orgId: missed.orgId,
        userId: assignTo,
        companyId: missed.companyId ?? null,
        contactId: missed.contactId ?? null,
        companyName: company?.name ?? null,
        ruleType: "webex_missed_call",
        outcomeType: "protect",
        confidence: contact ? "high" : "medium",
        signalCount: 1,
        signalSummary: [
          `Missed ${missed.voicemailLeft ? "call + voicemail" : "call"} from ${callerLabel} (${missed.callingNumber}) [CDR:${missed.cdrId}]`,
          `Call time: ${new Date(missed.startTime).toLocaleString()}${missed.afterHours ? " (after hours)" : ""}`,
        ],
        whyThisNow: contact
          ? `${contact.name} called and you missed it.${missed.voicemailLeft ? " They left a voicemail." : ""} Inbound interest from a known contact should be returned promptly.`
          : `An unknown number (${missed.callingNumber}) reached out and no one picked up.${missed.voicemailLeft ? " They left a voicemail." : ""} Qualify the caller and add them to the CRM if warranted.`,
        suggestedAction: contact
          ? `Call ${contact.name} back at ${missed.callingNumber}.`
          : `Call ${missed.callingNumber} back and capture who they are.`,
        expectedOutcome: "Return the call and capture any inbound opportunity.",
        urgencyScore: urgency,
        playLabel: play?.name ?? null,
        status: "visible",
        createdAt: new Date().toISOString(),
      });

      await storage.setMissedInboundCallback(missed.id, nbaCard.id);

      res.json({
        nbaCardId: nbaCard.id,
        contactId: missed.contactId,
        companyId: missed.companyId,
        navigate: missed.contactId
          ? { kind: "contact", contactId: missed.contactId }
          : { kind: "unknown", phone: missed.callingNumber },
      });
    } catch (err) {
      log(`Missed inbound callback error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to create callback" });
    }
  });

  // ── Org-wide phone usage report (Task #318) ───────────────────────────────
  // Aggregates Webex-synced call touchpoints into KPIs, a dow×hour heatmap,
  // and a ranked rep table with 30-day baseline deltas. Read-only; built on
  // top of the existing call touchpoint records (notes contain `[Webex CDR:`).
  app.get("/api/webex/usage-report", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (!["admin", "sales_director", "director", "national_account_manager"].includes(user.role)) {
        return res.status(403).json({ error: "Access restricted to leadership roles" });
      }

      const range = qStr(req.query.range) || "7d";
      const managerId = (qOptStr(req.query.managerId)) || null;

      const rangeDays = range === "today" ? 1 : range === "30d" ? 30 : range === "90d" ? 90 : 7;
      const now = Date.now();
      // For "today" use start of today; otherwise rolling N-day window.
      let startMs: number;
      if (range === "today") {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        startMs = d.getTime();
      } else {
        startMs = now - rangeDays * 24 * 3600 * 1000;
      }
      const baselineStartMs = now - 30 * 24 * 3600 * 1000;

      // Pull org users and resolve "team" (direct reports of selected managerId).
      const orgUsers = await storage.getUsers(user.organizationId);
      const userById = new Map(orgUsers.map(u => [u.id, u] as const));

      // Build the candidate user-id set for the selected team filter.
      let scopedUserIds: Set<string> | null = null;
      if (managerId) {
        const team = orgUsers.filter(u => u.managerId === managerId || u.id === managerId);
        scopedUserIds = new Set(team.map(u => u.id));
      } else if (user.role === "director") {
        // Task #525: a Director with no managerId filter used to see every
        // rep's calls in the org. Default-scope to the director's own
        // recursive reporting tree. Admin / Sales Director / NAM keep their
        // existing org-wide-or-managerId-filtered behaviour.
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        scopedUserIds = new Set(teamIds);
      }
      // If the caller passed a managerId that isn't in the director's tree,
      // collapse the visible set to the intersection so they can't pivot to
      // another team's data via URL tampering.
      if (managerId && user.role === "director") {
        const teamIds = new Set(await storage.getTeamMemberIds(user.id, user.organizationId));
        scopedUserIds = new Set(Array.from(scopedUserIds ?? new Set<string>()).filter(id => teamIds.has(id)));
      }

      // Pull all call touchpoints for the org once. Filtered downstream by
      // CDR marker (Webex-sourced) and by time window.
      const allTouchpoints = await storage.getTouchpointsByOrg(user.organizationId);
      const callTps = allTouchpoints.filter(tp =>
        tp.type === "call" && typeof tp.notes === "string" && tp.notes.includes("[Webex CDR:")
      );

      const inWindow = (tp: typeof callTps[number]) => {
        const t = Date.parse(tp.createdAt);
        return Number.isFinite(t) && t >= startMs && t <= now;
      };
      const inBaseline = (tp: typeof callTps[number]) => {
        const t = Date.parse(tp.createdAt);
        return Number.isFinite(t) && t >= baselineStartMs && t <= now;
      };
      const matchesScope = (tp: typeof callTps[number]) =>
        !scopedUserIds || scopedUserIds.has(tp.loggedById);

      const rangeTps = callTps.filter(tp => inWindow(tp) && matchesScope(tp));
      const baselineTps = callTps.filter(tp => inBaseline(tp) && matchesScope(tp));

      // KPIs.
      let inboundCalls = 0;
      let outboundCalls = 0;
      let afterHoursCalls = 0;
      const heatmap: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      const repCounts = new Map<string, { count: number; inbound: number; outbound: number }>();

      for (const tp of rangeTps) {
        const isInbound = tp.notes?.startsWith("[Webex CDR:") && / Inbound /i.test(tp.notes);
        const isOutbound = tp.notes?.startsWith("[Webex CDR:") && / Outbound /i.test(tp.notes);
        if (isInbound) inboundCalls++;
        else if (isOutbound) outboundCalls++;

        const d = new Date(tp.createdAt);
        const dow = d.getDay();
        const hour = d.getHours();
        heatmap[dow][hour]++;
        if (hour < 8 || hour >= 18 || dow === 0 || dow === 6) afterHoursCalls++;

        const r = repCounts.get(tp.loggedById) ?? { count: 0, inbound: 0, outbound: 0 };
        r.count++;
        if (isInbound) r.inbound++;
        if (isOutbound) r.outbound++;
        repCounts.set(tp.loggedById, r);
      }

      const totalCalls = rangeTps.length;
      const repsWithActivity = repCounts.size;
      const totalReps = scopedUserIds ? scopedUserIds.size : orgUsers.length;
      const avgCallsPerRep = totalReps > 0 ? Math.round((totalCalls / totalReps) * 10) / 10 : 0;
      const pctAfterHours = totalCalls > 0 ? Math.round((afterHoursCalls / totalCalls) * 100) : 0;

      // Per-rep 30-day baseline (avg calls/day).
      const baselineByRep = new Map<string, number>();
      for (const tp of baselineTps) {
        baselineByRep.set(tp.loggedById, (baselineByRep.get(tp.loggedById) ?? 0) + 1);
      }

      const reps = Array.from(repCounts.entries()).map(([userId, r]) => {
        const u = userById.get(userId);
        const baselineTotal = baselineByRep.get(userId) ?? 0;
        const baselineAvgPerDay = baselineTotal / 30;
        const expectedForWindow = baselineAvgPerDay * rangeDays;
        let deltaPct = 0;
        if (expectedForWindow > 0) {
          deltaPct = Math.round(((r.count - expectedForWindow) / expectedForWindow) * 100);
        } else if (r.count > 0) {
          deltaPct = 100;
        }
        let flag: "spike" | "drop" | null = null;
        // Only flag when we have meaningful baseline (>=5 calls in 30d) and
        // the current window represents a real shift, not single-day noise.
        if (baselineTotal >= 5) {
          if (deltaPct >= 50 && r.count >= 3) flag = "spike";
          else if (deltaPct <= -50 && rangeDays >= 7) flag = "drop";
        }
        return {
          userId,
          name: u?.name || u?.username || "Unknown",
          managerId: u?.managerId ?? null,
          count: r.count,
          inbound: r.inbound,
          outbound: r.outbound,
          baselineAvgPerDay: Math.round(baselineAvgPerDay * 10) / 10,
          deltaPct,
          flag,
        };
      });

      // Surface reps with zero activity in the range when they have a baseline
      // — these are the "drop-offs" leadership most wants to see.
      if (rangeDays >= 7) {
        for (const [userId, baselineTotal] of baselineByRep.entries()) {
          if (repCounts.has(userId)) continue;
          if (scopedUserIds && !scopedUserIds.has(userId)) continue;
          if (baselineTotal < 5) continue;
          const u = userById.get(userId);
          if (!u) continue;
          const baselineAvgPerDay = baselineTotal / 30;
          reps.push({
            userId,
            name: u.name || u.username || "Unknown",
            managerId: u.managerId ?? null,
            count: 0,
            inbound: 0,
            outbound: 0,
            baselineAvgPerDay: Math.round(baselineAvgPerDay * 10) / 10,
            deltaPct: -100,
            flag: "drop",
          });
        }
      }

      reps.sort((a, b) => b.count - a.count);

      // Distinct managers with at least one direct report — used to populate
      // the team filter dropdown on the client.
      const managerIds = new Set<string>();
      for (const u of orgUsers) {
        if (u.managerId) managerIds.add(u.managerId);
      }
      const teams = Array.from(managerIds)
        .map(mid => {
          const mgr = userById.get(mid);
          if (!mgr) return null;
          const repCount = orgUsers.filter(u => u.managerId === mid).length;
          return { managerId: mid, managerName: mgr.name || mgr.username || "Manager", repCount };
        })
        .filter((t): t is { managerId: string; managerName: string; repCount: number } => !!t)
        .sort((a, b) => b.repCount - a.repCount);

      res.json({
        range,
        startISO: new Date(startMs).toISOString(),
        endISO: new Date(now).toISOString(),
        kpis: {
          totalCalls,
          inboundCalls,
          outboundCalls,
          avgCallsPerRep,
          pctAfterHours,
          afterHoursCalls,
          totalReps,
          repsWithActivity,
        },
        heatmap,
        reps,
        teams,
      });
    } catch (err) {
      log(`Usage report error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to load Webex usage report" });
    }
  });

  /**
   * GET /api/webex/usage-report/rep-calls
   * Drill-down for the Phone Usage rep-ranking row. Returns the individual
   * Webex call touchpoints attributed to a single rep within the same
   * date range + team-scope filter the user already has applied on the
   * Phone Usage page (Task #329).
   *
   * Query params:
   *   userId    — required, the rep whose calls to list
   *   range     — "today" | "7d" | "30d" | "90d" (matches usage-report)
   *   managerId — optional team scope; if set, the rep must belong to it
   */
  app.get("/api/webex/usage-report/rep-calls", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (!["admin", "sales_director", "director", "national_account_manager"].includes(user.role)) {
        return res.status(403).json({ error: "Access restricted to leadership roles" });
      }

      const userId = (qStr(req.query.userId) || "").trim();
      if (!userId) return res.status(400).json({ error: "userId is required" });

      const range = qStr(req.query.range) || "7d";
      const managerId = (qOptStr(req.query.managerId)) || null;
      const rangeDays = range === "today" ? 1 : range === "30d" ? 30 : range === "90d" ? 90 : 7;
      const now = Date.now();
      let startMs: number;
      if (range === "today") {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        startMs = d.getTime();
      } else {
        startMs = now - rangeDays * 24 * 3600 * 1000;
      }

      // Confirm the rep exists in this org and respect the team filter when set.
      const orgUsers = await storage.getUsers(user.organizationId);
      const rep = orgUsers.find(u => u.id === userId);
      if (!rep) return res.status(404).json({ error: "Rep not found in this organization" });
      if (managerId && rep.managerId !== managerId && rep.id !== managerId) {
        return res.status(403).json({ error: "Rep is outside the selected team" });
      }
      // Task #525 / #538: Directors AND National Account Managers may only
      // inspect call logs for reps within their own reporting tree, even
      // when a target userId is guessed. Admin and Sales Director keep
      // org-wide visibility for oversight.
      if (
        rep.id !== user.id &&
        (user.role === "director" || user.role === "national_account_manager")
      ) {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        if (!teamIds.includes(rep.id)) {
          return res.status(403).json({ error: "Rep is outside your reporting tree" });
        }
      }

      // Pull the rep's call-type touchpoints in the window. We use the
      // existing per-user fetch to avoid scanning every org touchpoint.
      const sinceISO = new Date(startMs).toISOString();
      const repTps = await storage.getTouchpointsByUser(userId, sinceISO);
      const callTps = repTps.filter(tp =>
        tp.type === "call" &&
        typeof tp.notes === "string" &&
        tp.notes.includes("[Webex CDR:") &&
        Date.parse(tp.createdAt) >= startMs &&
        Date.parse(tp.createdAt) <= now,
      );

      // Hydrate company + contact display names in batched lookups. Resolve
      // contacts by their actual contactId (not by company) so reassigned
      // contacts still display the right name even if they no longer belong
      // to the company on the touchpoint.
      const companyIds = Array.from(new Set(callTps.map(tp => tp.companyId).filter((v): v is string => !!v)));
      const contactIds = Array.from(new Set(callTps.map(tp => tp.contactId).filter((v): v is string => !!v)));

      const companies = companyIds.length > 0
        ? await storage.getCompaniesByIds(companyIds, user.organizationId)
        : [];
      const companyById = new Map(companies.map(c => [c.id, c] as const));

      const resolvedContacts = contactIds.length > 0
        ? await Promise.all(contactIds.map(id => storage.getContact(id)))
        : [];
      const contactById = new Map(
        resolvedContacts
          .filter((c): c is NonNullable<typeof c> => !!c)
          .map(c => [c.id, c] as const),
      );

      // Notes format: "[Webex CDR: <id>] <Direction> call with <name> (<num>), duration: <min> min."
      const calls = callTps
        .map(tp => {
          const notes = tp.notes ?? "";
          const cdrMatch = notes.match(/\[Webex CDR:\s*([^\]]+)\]/);
          const dirMatch = notes.match(/\b(Inbound|Outbound)\b/i);
          const durMatch = notes.match(/duration:\s*(\d+)\s*min/i);
          const company = tp.companyId ? companyById.get(tp.companyId) ?? null : null;
          const contact = tp.contactId ? contactById.get(tp.contactId) ?? null : null;
          return {
            touchpointId: tp.id,
            cdrId: cdrMatch?.[1] ?? null,
            timestamp: tp.createdAt,
            direction: (dirMatch?.[1] ?? "").toLowerCase() as "inbound" | "outbound" | "",
            durationMinutes: durMatch ? parseInt(durMatch[1], 10) : null,
            companyId: tp.companyId,
            companyName: company?.name ?? null,
            contactId: tp.contactId,
            contactName: contact?.name ?? null,
            sentiment: tp.sentiment ?? null,
          };
        })
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

      res.json({
        userId,
        repName: rep.name || rep.username || "Rep",
        range,
        startISO: new Date(startMs).toISOString(),
        endISO: new Date(now).toISOString(),
        totalCalls: calls.length,
        calls,
      });
    } catch (err) {
      log(`Rep call drill-down error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to load rep call detail" });
    }
  });

  app.post("/api/webex/presence-batch", requireUser, async (req: Request, res: Response) => {
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
      log(`Presence batch error: ${getErrorMessage(err)}`);
      res.json({ presenceMap: {}, configured: true });
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Rep Call Quality Scorecards (Task #315)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * GET /api/webex/call-quality/scorecard
   *
   * Aggregated per-rep scorecard rollup over a trailing window.
   * Query params:
   *   days     — trailing window in days (default 30, max 90)
   *   userId   — when provided, returns a single-rep rollup (permissions enforced upstream)
   *
   * Returns per-rep metrics (calls, connect rate, avg talk minutes, hold %,
   * dead-air %, avg MOS, avg jitter, avg loss, after-hours %, grade mix) and
   * flags the reps who need coaching attention.
   */
  app.get("/api/webex/call-quality/scorecard", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;

      const daysRaw = parseInt(qStr(req.query.days) || "30", 10);
      const days = Math.min(90, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 30));
      const singleUserId = qStr(req.query.userId) || null;

      const params: any[] = [user.organizationId, days];
      let userFilter = "";
      if (singleUserId) {
        params.push(singleUserId);
        userFilter = ` AND a.user_id = $${params.length}`;
      }

      const rollupSql = `
        SELECT
          a.user_id                                                AS user_id,
          u.name                                           AS rep_name,
          u.username                                               AS username,
          COUNT(*)::int                                            AS total_calls,
          SUM(CASE WHEN a.answered THEN 1 ELSE 0 END)::int         AS connected_calls,
          SUM(CASE WHEN a.answered AND a.direction = 'ORIGINATING' THEN 1 ELSE 0 END)::int AS outbound_connected,
          SUM(CASE WHEN a.direction = 'ORIGINATING' THEN 1 ELSE 0 END)::int AS outbound_calls,
          SUM(CASE WHEN a.after_hours THEN 1 ELSE 0 END)::int      AS after_hours_calls,
          COALESCE(SUM(a.talk_time_seconds), 0)::int               AS total_talk_seconds,
          COALESCE(SUM(a.hold_time_seconds), 0)::int               AS total_hold_seconds,
          COALESCE(SUM(a.silence_seconds), 0)::int                 AS total_silence_seconds,
          COALESCE(AVG(NULLIF(a.mos_score, 0)), 0)::float          AS avg_mos,
          COALESCE(AVG(NULLIF(a.jitter_ms, 0)), 0)::float          AS avg_jitter_ms,
          COALESCE(AVG(NULLIF(a.packet_loss_pct, 0)), 0)::float    AS avg_packet_loss_pct,
          SUM(CASE WHEN a.quality_grade = 'A' THEN 1 ELSE 0 END)::int AS grade_a,
          SUM(CASE WHEN a.quality_grade = 'B' THEN 1 ELSE 0 END)::int AS grade_b,
          SUM(CASE WHEN a.quality_grade = 'C' THEN 1 ELSE 0 END)::int AS grade_c,
          SUM(CASE WHEN a.quality_grade = 'D' THEN 1 ELSE 0 END)::int AS grade_d,
          COUNT(DISTINCT a.start_time::date)::int                  AS active_days
        FROM webex_call_analytics a
        LEFT JOIN users u ON u.id = a.user_id
        WHERE a.org_id = $1
          AND a.start_time >= NOW() - ($2::int || ' days')::interval
          AND a.user_id IS NOT NULL
          ${userFilter}
        GROUP BY a.user_id, u.name, u.username
        ORDER BY total_calls DESC
      `;

      const { rows } = await storage.pool.query(rollupSql, params);

      const reps = rows.map((r: any) => {
        const total = Number(r.total_calls) || 0;
        const connected = Number(r.connected_calls) || 0;
        const outbound = Number(r.outbound_calls) || 0;
        const outboundConnected = Number(r.outbound_connected) || 0;
        const talk = Number(r.total_talk_seconds) || 0;
        const hold = Number(r.total_hold_seconds) || 0;
        const silence = Number(r.total_silence_seconds) || 0;
        const activeDays = Number(r.active_days) || 0;
        const connectRate = total > 0 ? connected / total : 0;
        const outboundConnectRate = outbound > 0 ? outboundConnected / outbound : 0;
        const avgTalkSecondsPerConnected = connected > 0 ? talk / connected : 0;
        const holdRatio = talk + hold > 0 ? hold / (talk + hold) : 0;
        const deadAirRatio = talk > 0 ? silence / talk : 0;
        const callsPerDay = activeDays > 0 ? total / activeDays : 0;
        const afterHoursRate = total > 0 ? Number(r.after_hours_calls) / total : 0;

        // Weighted attention score: more calls + lower connect + low talk-time +
        // high hold/dead-air + poor quality grade bump the score. Higher = more
        // coaching attention.
        const qualityD = Number(r.grade_d) || 0;
        const qualityC = Number(r.grade_c) || 0;
        const qualityBadRate = total > 0 ? (qualityC + 2 * qualityD) / total : 0;
        const attentionScore =
          (1 - outboundConnectRate) * 30 +
          Math.max(0, 120 - avgTalkSecondsPerConnected) / 120 * 20 +
          holdRatio * 15 +
          deadAirRatio * 15 +
          qualityBadRate * 20;

        return {
          userId: r.user_id,
          repName: r.rep_name || r.username || "Unknown",
          totalCalls: total,
          connectedCalls: connected,
          outboundCalls: outbound,
          outboundConnectedCalls: outboundConnected,
          connectRate,
          outboundConnectRate,
          avgTalkSecondsPerConnected,
          totalTalkSeconds: talk,
          totalHoldSeconds: hold,
          totalSilenceSeconds: silence,
          holdRatio,
          deadAirRatio,
          callsPerDay,
          afterHoursRate,
          avgMos: Number(r.avg_mos) || null,
          avgJitterMs: Number(r.avg_jitter_ms) || null,
          avgPacketLossPct: Number(r.avg_packet_loss_pct) || null,
          gradeMix: {
            A: Number(r.grade_a) || 0,
            B: Number(r.grade_b) || 0,
            C: Number(r.grade_c) || 0,
            D: Number(r.grade_d) || 0,
          },
          activeDays,
          attentionScore: Math.round(attentionScore * 10) / 10,
        };
      });

      reps.sort((a, b) => b.attentionScore - a.attentionScore);

      // Team rollup
      const teamTotals = reps.reduce(
        (acc, r) => {
          acc.totalCalls += r.totalCalls;
          acc.connectedCalls += r.connectedCalls;
          acc.outboundCalls += r.outboundCalls;
          acc.outboundConnectedCalls += r.outboundConnectedCalls;
          acc.totalTalkSeconds += r.totalTalkSeconds;
          acc.totalHoldSeconds += r.totalHoldSeconds;
          acc.totalSilenceSeconds += r.totalSilenceSeconds;
          acc.afterHoursCalls += Math.round(r.afterHoursRate * r.totalCalls);
          return acc;
        },
        {
          totalCalls: 0,
          connectedCalls: 0,
          outboundCalls: 0,
          outboundConnectedCalls: 0,
          totalTalkSeconds: 0,
          totalHoldSeconds: 0,
          totalSilenceSeconds: 0,
          afterHoursCalls: 0,
        },
      );

      const mosVals = reps.map(r => r.avgMos).filter((v): v is number => v != null && v > 0);
      const jitterVals = reps.map(r => r.avgJitterMs).filter((v): v is number => v != null && v > 0);
      const lossVals = reps.map(r => r.avgPacketLossPct).filter((v): v is number => v != null && v >= 0);

      res.json({
        days,
        team: {
          ...teamTotals,
          connectRate: teamTotals.totalCalls > 0 ? teamTotals.connectedCalls / teamTotals.totalCalls : 0,
          outboundConnectRate: teamTotals.outboundCalls > 0 ? teamTotals.outboundConnectedCalls / teamTotals.outboundCalls : 0,
          avgMos: mosVals.length ? mosVals.reduce((a, b) => a + b, 0) / mosVals.length : null,
          avgJitterMs: jitterVals.length ? jitterVals.reduce((a, b) => a + b, 0) / jitterVals.length : null,
          avgPacketLossPct: lossVals.length ? lossVals.reduce((a, b) => a + b, 0) / lossVals.length : null,
          repCount: reps.length,
        },
        reps,
      });
    } catch (err) {
      log(`Call quality scorecard error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to build call quality scorecard" });
    }
  });

  /**
   * GET /api/webex/call-quality/calls
   *
   * Drill-in call list for a given rep (or team) over the same trailing
   * window. Used by the Exec Analytics "Call Quality" panel to jump from a
   * row to the underlying calls.
   */
  app.get("/api/webex/call-quality/calls", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const daysRaw = parseInt(qStr(req.query.days) || "30", 10);
      const days = Math.min(90, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 30));
      const userIdFilter = qOptStr(req.query.userId) ?? null;
      const gradeFilter = qOptStr(req.query.grade)?.toUpperCase() ?? null;
      const limitRaw = parseInt(qStr(req.query.limit) || "200", 10);
      const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200));

      const params: any[] = [user.organizationId, days];
      let sql = `
        SELECT a.*, u.name AS rep_name, c.name AS contact_name, co.name AS company_name
        FROM webex_call_analytics a
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN contacts c ON c.id = a.contact_id
        LEFT JOIN companies co ON co.id = a.company_id
        WHERE a.org_id = $1
          AND a.start_time >= NOW() - ($2::int || ' days')::interval
      `;
      if (userIdFilter) {
        params.push(userIdFilter);
        sql += ` AND a.user_id = $${params.length}`;
      }
      if (gradeFilter && ["A", "B", "C", "D"].includes(gradeFilter)) {
        params.push(gradeFilter);
        sql += ` AND a.quality_grade = $${params.length}`;
      }
      sql += ` ORDER BY a.start_time DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const { rows } = await storage.pool.query(sql, params);
      res.json({ calls: rows, days, total: rows.length });
    } catch (err) {
      log(`Call quality drill-in error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Failed to load call list" });
    }
  });

  /**
   * POST /api/webex/call-quality/backfill
   *
   * Admin-triggered backfill that hydrates the `webex_call_analytics` table
   * with up to ~13 months (395 days) of history. Idempotent — safe to
   * re-run; existing rows are upserted.
   */
  app.post("/api/webex/call-quality/backfill", requireUser, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (user.role !== "admin" && user.role !== "owner") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const daysRaw = parseInt(String((req.body as any)?.days ?? String(WEBEX_DEFAULT_BACKFILL_DAYS)), 10);
      const days = Math.min(WEBEX_MAX_BACKFILL_DAYS, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : WEBEX_DEFAULT_BACKFILL_DAYS));

      if (!hasWebexTokens()) {
        return res.status(400).json({ error: "Webex is not authorized. Connect Webex first." });
      }

      // Walk backward in 24-hour chunks to stay under the max=50 page cap
      // and so partial failures don't lose everything. syncCallsForOrg
      // already handles analytics persistence for every record.
      let synced = 0;
      const orgId = user.organizationId;
      const nowMs = Date.now();
      for (let d = 0; d < days; d++) {
        const endMs = nowMs - d * 24 * 3600 * 1000;
        try {
          const result = await syncCallsForOrg(orgId, 24, endMs);
          synced += result.touchpoints.length;
        } catch (e) {
          log(`Backfill day offset=${d} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      res.json({ ok: true, days, newTouchpoints: synced });
    } catch (err) {
      log(`Call quality backfill error: ${getErrorMessage(err)}`);
      res.status(500).json({ error: "Backfill failed" });
    }
  });

}

export function initWebexSyncScheduler(): void {
  if (!webexCredentialsConfigured()) {
    log("Webex credentials not configured — sync scheduler not started");
    return;
  }

  // Proactive token refresh — runs every 5 minutes, refreshes if the access
  // token expires within the next 10 minutes (or has no cached token yet).
  cron.schedule("*/5 * * * *", async () => {
    if (!hasWebexTokens()) return;
    try {
      const state = getWebexAuthState();
      const now = Date.now();
      const REFRESH_LEAD_MS = 10 * 60 * 1000;
      if (
        state.accessTokenExpiresAt == null ||
        state.accessTokenExpiresAt - now < REFRESH_LEAD_MS
      ) {
        log("Proactive token refresh triggered");
        await refreshWebexAccessToken();
      }
    } catch (err) {
      // refreshWebexAccessToken already handles invalid_grant -> needs_reauth.
      // Transient failures are logged inside the helper; nothing more to do here.
      log(`Proactive refresh error: ${getErrorMessage(err)}`);
    }
  });

  log("Webex token auto-refresh scheduler started (every 5 minutes)");

  // Task #466: enrichment job sweep — drains the webex_call_enrichment_jobs
  // queue every 5 minutes. Honors per-job nextRetryAt so 429/5xx responses
  // get exponential backoff instead of a tight retry loop.
  cron.schedule("*/5 * * * *", async () => {
    try {
      const summary = await runEnrichmentSweep();
      if (summary.processed > 0 || summary.failed > 0 || summary.deadLettered > 0) {
        log(
          `Enrichment sweep: processed=${summary.processed} ` +
            `succeeded=${summary.succeeded} failed=${summary.failed} ` +
            `deadLettered=${summary.deadLettered}`,
        );
      }
    } catch (err) {
      log(`Enrichment sweep error: ${getErrorMessage(err)}`);
    }
  });
  log("Webex enrichment-job sweep scheduler started (every 5 minutes)");

  cron.schedule("*/30 * * * *", async () => {
    log("Background call sync starting...");
    try {
      const { db } = await import("../storage");
      const { organizations } = await import("../../shared/schema");
      const orgs = await db.select().from(organizations);

      // Per-user (Task #261) sync — iterate each rep with a connected
      // Webex account and pull their personal call history. Runs regardless
      // of org-level token state.
      for (const org of orgs) {
        try {
          const tokens = await storage.getWebexUserTokensForOrg(org.id);
          for (const t of tokens) {
            if (t.needsReauth) continue;
            try {
              const res = await getUserWebexAccessToken(t.userId);
              if (!res) continue;
              const result = await syncCallsForOrg(org.id, 1, undefined, {
                forUser: { userId: t.userId, accessToken: res.token },
              });
              if (result.touchpoints.length > 0 || result.nbaCards.length > 0) {
                log(`User ${t.userId}: synced ${result.touchpoints.length} calls, ${result.nbaCards.length} missed-call cards (personal token)`);
              }
            } catch (userErr) {
              log(`User ${t.userId} personal sync error: ${userErr instanceof Error ? userErr.message : String(userErr)}`);
            }
          }
        } catch (e) {
          log(`Org ${org.id} per-user sync listing failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (webexNeedsReauth()) {
        log("Background org call sync skipped — Webex org token needs re-authorization");
        return;
      }
      if (!hasWebexTokens()) return;

      for (const org of orgs) {
        if (webexNeedsReauth()) {
          log("Aborting remaining org syncs — Webex flipped to needs-reauth mid-run");
          break;
        }
        try {
          const result = await syncCallsForOrg(org.id, 1);
          if (result.touchpoints.length > 0 || result.nbaCards.length > 0) {
            log(`Org ${org.id}: synced ${result.touchpoints.length} calls, ${result.nbaCards.length} missed-call cards`);
          }
        } catch (orgErr) {
          log(`Org ${org.id} sync error: ${orgErr instanceof Error ? orgErr.message : String(orgErr)}`);
          if (webexNeedsReauth()) {
            log("Aborting remaining org syncs — Webex token rejected during sync");
            break;
          }
        }
      }
      log("Background call sync complete");
    } catch (err) {
      log(`Background sync error: ${getErrorMessage(err)}`);
    }
  });

  log("Webex call sync scheduler started (every 30 minutes)");

  // Bootstrap auto-seed of Webex user mappings on startup for any org that
  // has zero mappings yet. Runs once, in the background, so it doesn't block
  // server boot. Uses Webex People API when authorized, CSV fallback otherwise.
  setTimeout(async () => {
    try {
      const { db } = await import("../storage");
      const { organizations, webexUserMappings } = await import("../../shared/schema");
      const { seedWebexUserMappings } = await import("../webexUserMappingService");
      const { sql } = await import("drizzle-orm");
      const orgs = await db.select().from(organizations);
      for (const org of orgs) {
        try {
          const existing = await db
            .select({ c: sql<number>`count(*)::int` })
            .from(webexUserMappings)
            .where(sql`${webexUserMappings.orgId} = ${org.id}`);
          const count = existing[0]?.c ?? 0;
          if (count > 0) continue;
          const result = await seedWebexUserMappings(org.id);
          log(
            `Org ${org.id}: bootstrap-seeded ${result.candidatesProcessed} Webex mappings ` +
              `(matched=${result.matched}, needs_review=${result.needsReview}, source=${result.source})`,
          );
        } catch (orgErr) {
          log(
            `Org ${org.id}: bootstrap seed error: ${orgErr instanceof Error ? orgErr.message : String(orgErr)}`,
          );
        }
      }
    } catch (err) {
      log(`Bootstrap seed scheduling error: ${getErrorMessage(err)}`);
    }
  }, 15_000);

  // Follow-up reminder for the needs-reauth state. Runs hourly but only
  // re-notifies admins at most once every 24 hours while disconnected.
  cron.schedule("17 * * * *", async () => {
    await maybeSendWebexReauthReminder();
    await sendPendingWebexUserReauthEmails();
  });

  log("Webex re-auth reminder scheduler started (hourly check, ~24h cadence)");

  // NOTE: Earlier #466 work introduced a 2-minute enrichment sweep, a
  // nightly snapshot-refresh cron, and a backfill-resume init block here.
  // All three referenced tables that were never created and crashed every
  // interval. Replacements that work end-to-end:
  //   - The 5-minute `runEnrichmentSweep` cron above already drains the
  //     enrichment queue with proper exp-backoff via the storage helpers.
  //   - Snapshot refreshes happen inside `kickOffOrgBackfill` on each
  //     reconnect / explicit "Backfill history" request, and refresh-on-demand
  //     from the admin Webex Health page.
  //   - Backfill resume isn't needed because the orchestrator's per-source
  //     `webex_sync_state` rows are append-only and the next reconnect or
  //     scheduled sync will simply continue from where it left off.
}

