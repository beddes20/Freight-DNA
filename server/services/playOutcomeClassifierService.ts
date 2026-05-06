/**
 * Play Outcome Classifier (Task #302)
 *
 * Closes the learning loop on email plays by classifying inbound replies
 * (or detecting bounces) and writing the resulting label to play_outcomes.
 *
 *   • lookupRunsForInboundEmail(orgId, conversationId)
 *       → finds open play_runs whose pending outcome should be evaluated
 *   • classifyAndPersistInboundReply({...})
 *       → bounce-detect first, otherwise gpt-4o-mini classify, then upsert
 *         the play_outcome row, complete the play_run, fan out to
 *         proven_tactics where applicable, and notify the rep.
 *
 * Bounced replies (mailer-daemon, postmaster, "undeliverable" subject) are
 * tagged `bounced`, do NOT count toward win rate, and trigger a
 * contact-health notification on the rep so they can fix the address.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { playRuns, playOutcomes, plays, provenTactics, emailSignals, emailMessages } from "@shared/schema";

export type ClassifierLabel = "won" | "lost" | "partial" | "no_response" | "bounced";

const BOUNCE_FROM_PATTERNS = [
  "mailer-daemon@", "postmaster@", "no-reply@", "noreply@",
  "bounce@", "bounces@", "delivery-status@",
];
const BOUNCE_SUBJECT_PATTERNS = [
  "undeliverable", "delivery status notification", "delivery failure",
  "mail delivery failed", "returned mail", "failure notice",
];

export function detectBounce(fromEmail: string, subject: string, body: string): boolean {
  const f = fromEmail.toLowerCase();
  const s = subject.toLowerCase();
  const b = body.toLowerCase();
  if (BOUNCE_FROM_PATTERNS.some(p => f.includes(p))) return true;
  if (BOUNCE_SUBJECT_PATTERNS.some(p => s.includes(p))) return true;
  // Fallback: explicit DSN markers anywhere in body
  if (b.includes("delivery has failed") || b.includes("address you sent to")) return true;
  return false;
}

interface OpenPlayRunForReply {
  runId: string;
  playId: string;
  playName: string;
  signalType: string | null;
  outcomeWindowHours: number;
  repUserId: string | null;
  accountName: string | null;
  startedAt: Date | null;
  templateBody: string;
  outcomeId: string | null;
  outcomeStatus: string | null;
}

/**
 * Find any pending-outcome play_runs for this org+thread. A run is eligible
 * when (a) thread_id matches the inbound conversationId, (b) its outcome
 * row is still in 'pending' status (or no outcome row exists yet — we treat
 * that as pending too for backward compatibility with runs created before
 * #302 shipped).
 */
export async function lookupRunsForInboundEmail(
  orgId: string,
  conversationId: string,
): Promise<OpenPlayRunForReply[]> {
  if (!conversationId) return [];
  type Row = {
    run_id: string;
    play_id: string;
    play_name: string;
    signal_type: string | null;
    outcome_window_hours: number;
    rep_user_id: string | null;
    account_name: string | null;
    started_at: Date | null;
    template_body: string;
    outcome_id: string | null;
    outcome_status: string | null;
  };
  // Deterministic 1-row attribution: even if a rep ran the same play twice
  // in the same Outlook conversation, the most recent send is the one whose
  // pending outcome should resolve. We never fan a single inbound reply out
  // to multiple play_runs — that would over-count wins/losses.
  const result = await db.execute<Row>(sql`
    SELECT
      r.id AS run_id, r.play_id, p.name AS play_name, p.signal_type,
      p.outcome_window_hours, r.rep_user_id, r.account_name, r.started_at,
      p.template_body, o.id AS outcome_id, o.status AS outcome_status
    FROM play_runs r
    JOIN plays p ON p.id = r.play_id
    LEFT JOIN play_outcomes o ON o.play_run_id = r.id
    WHERE r.org_id = ${orgId}
      AND r.thread_id = ${conversationId}
      AND r.status IN ('open', 'completed')
      AND (o.status IS NULL OR o.status = 'pending')
    ORDER BY r.sent_at DESC NULLS LAST, r.started_at DESC
    LIMIT 1
  `);
  return (result.rows ?? []).map(r => ({
    runId: r.run_id,
    playId: r.play_id,
    playName: r.play_name,
    signalType: r.signal_type,
    outcomeWindowHours: r.outcome_window_hours,
    repUserId: r.rep_user_id,
    accountName: r.account_name,
    startedAt: r.started_at,
    templateBody: r.template_body,
    outcomeId: r.outcome_id,
    outcomeStatus: r.outcome_status,
  }));
}

interface ClassifierResult {
  label: ClassifierLabel;
  confidence: number;            // 0..100
  reasoning: string;
  quotedText: string;
}

/**
 * gpt-4o-mini classifier. Falls back to a lightweight keyword heuristic if
 * the OpenAI call fails so we never silently lose an outcome.
 */
async function classifyWithLLM(
  playName: string,
  templateBody: string,
  inboundSubject: string,
  inboundBody: string,
): Promise<ClassifierResult> {
  const sys = `You classify replies to sales/procurement outreach emails into one of:
- won: prospect agrees, accepts, asks for next steps, requests booking/contract/quote acceptance
- lost: prospect declines, says no, gives flat rejection, says they're going with someone else
- partial: prospect engages but with conditions/objections/requests for changes
- no_response: auto-replies (OOO), unrelated content, or non-substantive forwards
Return strict JSON: { "label": "...", "confidence": 0-100, "reasoning": "1 sentence", "quotedText": "<= 160 chars from reply that drove the call" }.`;
  const usr = `PLAY: ${playName}
ORIGINAL OUTREACH (truncated):
${(templateBody || "").slice(0, 600)}

REPLY SUBJECT: ${inboundSubject}
REPLY BODY (truncated):
${(inboundBody || "").slice(0, 1800)}`;

  try {
    const OpenAI = (await import("openai")).default;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");
    const client = new OpenAI({ apiKey });
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: usr },
      ],
    });
    const raw = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    const label = (["won", "lost", "partial", "no_response"].includes(parsed.label) ? parsed.label : "no_response") as ClassifierLabel;
    const confidence = Math.max(0, Math.min(100, Number(parsed.confidence ?? 50)));
    return {
      label,
      confidence,
      reasoning: String(parsed.reasoning ?? "").slice(0, 400),
      quotedText: String(parsed.quotedText ?? "").slice(0, 320),
    };
  } catch (err) {
    // Heuristic fallback — keyword-based, never throws.
    const b = (inboundBody || "").toLowerCase();
    const s = (inboundSubject || "").toLowerCase();
    if (s.includes("out of office") || s.includes("automatic reply") || b.includes("out of the office")) {
      return { label: "no_response", confidence: 70, reasoning: "Auto-reply detected (heuristic fallback)", quotedText: "" };
    }
    if (/\b(no thanks|not interested|pass|going with|chose another|already set)\b/.test(b)) {
      return { label: "lost", confidence: 60, reasoning: "Decline keywords (heuristic fallback)", quotedText: "" };
    }
    if (/\b(yes|sounds good|let's|book it|move forward|send the contract|approved)\b/.test(b)) {
      return { label: "won", confidence: 60, reasoning: "Acceptance keywords (heuristic fallback)", quotedText: "" };
    }
    if (/\b(but|however|cheaper|too high|other|change|modify)\b/.test(b)) {
      return { label: "partial", confidence: 50, reasoning: "Engaged with objections (heuristic fallback)", quotedText: "" };
    }
    return { label: "no_response", confidence: 40, reasoning: "Inconclusive (heuristic fallback)", quotedText: "" };
  }
}

// Map classifier label → legacy outcome enum so existing analytics that
// FILTER on outcome IN ('success','fail','no_response') still work.
// Bounced rows write outcome='no_response' but are excluded from win-rate
// because callers should filter by status != 'bounced'.
function legacyOutcomeFor(label: ClassifierLabel): "success" | "fail" | "no_response" {
  if (label === "won") return "success";
  if (label === "lost") return "fail";
  if (label === "partial") return "success"; // engaged → counted as a win for the play
  return "no_response";
}

export async function classifyAndPersistInboundReply(params: {
  orgId: string;
  conversationId: string;
  fromEmail: string;
  subject: string;
  bodyFull: string;
  providerMessageId: string;
  /** Pre-extracted email signal IDs (preferred). If omitted, we look them
   *  up from the email_signals table by providerMessageId/threadId. */
  signalIds?: string[];
}): Promise<{ matched: number }> {
  const { orgId, conversationId, fromEmail, subject, bodyFull, providerMessageId } = params;
  const runs = await lookupRunsForInboundEmail(orgId, conversationId);
  if (!runs.length) return { matched: 0 };

  const isBounce = detectBounce(fromEmail, subject, bodyFull);

  // Pull any existing email_signals for this inbound message so the classifier
  // result is grounded in the existing signal pipeline (intent_type +
  // confidence). The webhook inserts the email_message synchronously but the
  // signal-extraction scheduler runs every 2 min, so signals may not exist
  // yet — that's fine, we degrade gracefully to message-text + GPT.
  let resolvedSignalIds: string[] = params.signalIds ?? [];
  let signalEvidence: Array<{ id: string; intentType: string; intentSubtype: string | null; confidence: number }> = [];
  if (resolvedSignalIds.length === 0 && providerMessageId) {
    try {
      const sigs = await db.select({
        id: emailSignals.id,
        intentType: emailSignals.intentType,
        intentSubtype: emailSignals.intentSubtype,
        confidence: emailSignals.confidence,
      })
        .from(emailSignals)
        .innerJoin(emailMessages, eq(emailSignals.messageId, emailMessages.id))
        .where(and(
          eq(emailMessages.orgId, orgId),
          eq(emailMessages.providerMessageId, providerMessageId),
        ))
        .limit(10);
      resolvedSignalIds = sigs.map(s => s.id);
      signalEvidence = sigs.map(s => ({
        id: s.id,
        intentType: s.intentType,
        intentSubtype: s.intentSubtype,
        confidence: s.confidence,
      }));
    } catch (e) {
      console.warn("[playOutcomeClassifier] signal lookup failed (non-fatal):", e);
    }
  }

  for (const run of runs) {
    let label: ClassifierLabel;
    let confidence: number;
    let reasoning: string;
    let quotedText: string;

    if (isBounce) {
      label = "bounced";
      confidence = 95;
      reasoning = `Bounce signature detected (from=${fromEmail}, subject=${subject.slice(0, 80)})`;
      quotedText = "";
    } else {
      const result = await classifyWithLLM(run.playName, run.templateBody, subject, bodyFull);
      label = result.label;
      confidence = result.confidence;
      reasoning = result.reasoning;
      quotedText = result.quotedText;
    }

    const startedAt = run.startedAt ?? new Date();
    const hours = Math.max(1, Math.round((Date.now() - new Date(startedAt).getTime()) / 36e5));
    const evidence = {
      reasoning,
      quotedText,
      fromEmail,
      subject: subject.slice(0, 240),
      providerMessageId,
      classifiedAt: new Date().toISOString(),
      // Attach the email-pipeline signals that informed this classification
      // so the "Why this label?" UI can show the trail of intent_type +
      // confidence values picked up by the existing signal extractor.
      signals: signalEvidence,
    };
    const status = isBounce ? "bounced" : "classified";
    const legacyOutcome = legacyOutcomeFor(label);

    if (run.outcomeId) {
      await db.update(playOutcomes).set({
        status,
        classifierLabel: label,
        classifierConfidence: confidence,
        outcome: legacyOutcome,
        evidence,
        sourceSignalIds: resolvedSignalIds,
        timeToOutcomeHours: hours,
        recordedAt: new Date(),
      }).where(eq(playOutcomes.id, run.outcomeId));
    } else {
      await db.insert(playOutcomes).values({
        playRunId: run.runId,
        outcome: legacyOutcome,
        status,
        classifierLabel: label,
        classifierConfidence: confidence,
        evidence,
        sourceSignalIds: resolvedSignalIds,
        timeToOutcomeHours: hours,
      }).onConflictDoNothing();
    }

    await db.update(playRuns).set({
      status: "completed",
      completedAt: new Date(),
    }).where(eq(playRuns.id, run.runId));

    // Bounce → fire a contact-health alert. We piggy-back on the existing
    // notifications-as-alerts pipeline (same shape that healthAlertScheduler
    // uses for `health_drop`) so the alert shows up in the rep's feed AND
    // shows up under the company's contact-health surface via the
    // /companies/:id deep-link, where the rep can correct the bad address.
    if (isBounce && run.repUserId) {
      try {
        const [runRow] = await db.select().from(playRuns).where(eq(playRuns.id, run.runId));
        const accountId = runRow?.accountId ?? null;
        const contactId = runRow?.contactId ?? null;
        await storage.createNotification({
          userId: run.repUserId,
          type: "contact_email_bounce",        // contact-health alert pipeline
          title: `⚠️ Bad contact email — ${run.accountName ?? "contact"}`,
          body: `Your "${run.playName}" play email bounced from ${fromEmail}. The contact's address looks invalid; please update it before re-running this play.`,
          link: accountId ? `/companies/${accountId}` : `/playbook`,
          relatedId: contactId ?? accountId ?? run.runId,
          read: false,
        });
      } catch (e) {
        console.warn("[playOutcomeClassifier] bounce contact-health alert failed (non-fatal):", e);
      }
    } else if (run.repUserId) {
      // Light-touch notification so reps see the auto-classified outcome.
      try {
        await storage.createNotification({
          userId: run.repUserId,
          type: "play_outcome",
          title: `Play outcome: ${label} — ${run.accountName ?? "reply"}`,
          body: `"${run.playName}" was auto-tagged ${label} (${confidence}% confidence). Override on the playbook page if wrong.`,
          link: `/playbook`,
          relatedId: run.runId,
          read: false,
        });
      } catch (e) {
        // non-fatal
      }
    }

    // Roll up to proven_tactics: for plays bound to a signal type, treat won
    // as positive evidence and lost as negative for the most recent pending
    // tactic of that signal type in the org (best-effort, idempotent via
    // recordTacticOutcome's "skip if not pending" guard).
    if (!isBounce && run.signalType && (label === "won" || label === "lost")) {
      try {
        const [tactic] = await db.select().from(provenTactics)
          .where(and(
            eq(provenTactics.orgId, orgId),
            eq(provenTactics.signalType, run.signalType),
            eq(provenTactics.outcome, "pending"),
          ))
          .orderBy(desc(provenTactics.createdAt))
          .limit(1);
        if (tactic) {
          const { recordTacticOutcome } = await import("./tacticalLearningService");
          await recordTacticOutcome(tactic.id, label === "won" ? "won" : "lost", orgId);
        }
      } catch (e) {
        console.warn("[playOutcomeClassifier] proven_tactics rollup failed (non-fatal):", e);
      }
    }
  }

  return { matched: runs.length };
}
