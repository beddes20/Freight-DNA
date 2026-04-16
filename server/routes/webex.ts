import type { Express, Request, Response } from "express";
import { requireAuth, getCurrentUser } from "../auth";
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
  fetchWebexPeople,
  fetchPersonStatus,
  fetchCallRecording,
  phonesMatch,
  phoneMatchKey,
  buildWebexCallDeepLink,
  type WebexCallRecord,
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
import { insertWebexUserMappingSchema } from "@shared/schema";
import OpenAI from "openai";
import cron from "node-cron";
import crypto from "crypto";

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

  const records = opts?.forUser
    ? await fetchCallHistory(startTime, endTime, 200, { accessToken: opts.forUser.accessToken, scope: "user" })
    : await fetchCallHistory(startTime, endTime);
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
    if (existingCallIds.has(record.id)) continue;

    const otherNumber = record.direction === "ORIGINATING"
      ? record.calledNumber
      : record.callingNumber;

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

    if (!matchedContact) continue;

    // Resolve which internal user this Webex call should be attributed to.
    // In per-user (forUser) mode the token already belongs to a specific rep
    // so attribute directly. Otherwise look up the webex_user_mappings row.
    let attributedUserId = defaultUserId;
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

  app.get("/api/webex/authorize", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const mode = (req.query.mode as string) === "personal" ? "personal" : "org";
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
      log(`Authorize error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to generate authorization URL" });
    }
  });

  app.get("/api/webex/debug-config", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user || user.role !== "admin") {
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
      const errParam = req.query.error as string | undefined;
      const errDesc = req.query.error_description as string | undefined;
      if (errParam) {
        log(`Callback error from Webex: ${errParam} — ${errDesc ?? ""}`);
        return renderError(400, `Webex returned an error: ${errParam}${errDesc ? ` — ${errDesc}` : ""}`);
      }

      const code = req.query.code as string;
      if (!code) {
        return renderError(400, "No authorization code was returned by Webex.");
      }

      const stateParam = (req.query.state as string) || "";
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
      res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Webex Connected Successfully!</h2>
          <p>FreightDNA can now sync your call history.</p>
          <p>You can close this window and return to the app.</p>
          <script>setTimeout(() => window.close(), 3000)</script>
        </body></html>
      `);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Callback error: ${msg}`);
      log(`Callback error context — redirect_uri=${info.redirectUri} (source=${info.source})`);
      renderError(500, msg);
    }
  });

  app.get("/api/webex/status", requireAuth, async (req: Request, res: Response) => {
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

  app.get("/api/webex/my-connection", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const record = await storage.getWebexUserToken(user.id);
      res.json({
        configured: webexCredentialsConfigured(),
        connected: !!record && !record.needsReauth,
        needsReauth: !!record?.needsReauth,
        webexEmail: record?.webexEmail ?? null,
        webexDisplayName: record?.webexDisplayName ?? null,
        webexPersonId: record?.webexPersonId ?? null,
        connectedAt: record?.connectedAt ?? null,
        accessTokenExpiresAt: record?.accessTokenExpiresAt ?? null,
        lastRefreshAt: record?.lastRefreshAt ?? null,
        lastRefreshError: record?.lastRefreshError ?? null,
      });
    } catch (err) {
      log(`my-connection error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to load personal Webex connection" });
    }
  });

  app.delete("/api/webex/my-connection", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const deleted = await disconnectUserWebex(user.id);
      log(`User ${user.id} disconnected their personal Webex account (deleted=${deleted})`);
      res.json({ deleted });
    } catch (err) {
      log(`my-connection delete error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to disconnect Webex" });
    }
  });

  app.post("/api/webex/sync-my-calls", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
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
      log(`sync-my-calls error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to sync personal Webex calls" });
    }
  });

  app.post("/api/webex/sync-calls", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

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
      log(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to sync Webex calls" });
    }
  });

  // ── Webex user mappings (Task #258) ───────────────────────────────────────

  app.get("/api/webex/user-mappings", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const mappings = await storage.getWebexUserMappings(user.organizationId);
      const orgUsers = await storage.getUsers(user.organizationId);
      res.json({
        mappings,
        users: orgUsers.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role })),
      });
    } catch (err) {
      log(`List mappings error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to load Webex user mappings" });
    }
  });

  app.post("/api/webex/user-mappings/seed", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const result = await seedWebexUserMappings(user.organizationId);
      res.json(result);
    } catch (err) {
      log(`Seed mappings error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to seed Webex user mappings" });
    }
  });

  app.post("/api/webex/backfill-attribution", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin only" });
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
      log(`Backfill attribution error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to backfill attribution" });
    }
  });

  app.post("/api/webex/user-mappings", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const parsed = insertWebexUserMappingSchema.parse({
        ...req.body,
        orgId: user.organizationId,
      });
      const row = await storage.upsertWebexUserMapping(parsed);
      res.json(row);
    } catch (err) {
      log(`Upsert mapping error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid mapping data" });
    }
  });

  app.patch("/api/webex/user-mappings/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin only" });
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
      const row = await storage.updateWebexUserMapping(req.params.id, user.organizationId, updates);
      if (!row) return res.status(404).json({ error: "Mapping not found" });
      res.json(row);
    } catch (err) {
      log(`Update mapping error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to update mapping" });
    }
  });

  app.delete("/api/webex/user-mappings/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const ok = await storage.deleteWebexUserMapping(req.params.id, user.organizationId);
      res.json({ deleted: ok });
    } catch (err) {
      log(`Delete mapping error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to delete mapping" });
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
      log(`Proactive refresh error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  log("Webex token auto-refresh scheduler started (every 5 minutes)");

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
      log(`Background sync error: ${err instanceof Error ? err.message : String(err)}`);
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
      log(`Bootstrap seed scheduling error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 15_000);

  // Follow-up reminder for the needs-reauth state. Runs hourly but only
  // re-notifies admins at most once every 24 hours while disconnected.
  cron.schedule("17 * * * *", async () => {
    await maybeSendWebexReauthReminder();
    await sendPendingWebexUserReauthEmails();
  });

  log("Webex re-auth reminder scheduler started (hourly check, ~24h cadence)");
}
