/**
 * POD Intake Service — getpaid@valuetruckaz.com AR mailbox
 *
 * Pipeline:
 *   1. classifyPod()          → keyword first, AI fallback on misses
 *   2. extractOrderIds()      → regex over subject + body + attachment names
 *   3. matchOrderIdToLoad()   → load_fact lookup, picks the most recent
 *                                load when an id occurs in multiple rows
 *   4. resolveRecipients()    → dispatcher (name → user.username), account
 *                                owner (companies.assignedTo → user.username),
 *                                org team-fallback email
 *   5. forwardPod()           → Outlook send with original attachments
 *
 * The classifier and extractor are pure and deterministic (apart from the
 * optional AI call) so they can be unit-tested without DB or network.
 */

import { db } from "../storage";
import { and, eq, sql, desc, inArray } from "drizzle-orm";
import OpenAI from "openai";
import {
  loadFact,
  companies,
  users,
  podIntakeSettings,
  freightOpportunities,
  type PodIntakeEmail,
} from "@shared/schema";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PodCandidateAttachment {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  /** Base64 file contents (Graph `contentBytes`). Optional — only required
   *  when actually forwarding; classification + extraction work on metadata. */
  contentBase64?: string;
}

export interface PodCandidateMessage {
  subject: string;
  bodyText: string;
  bodyPreview?: string;
  fromEmail?: string;
  fromName?: string;
  attachments: PodCandidateAttachment[];
}

export type PodClassification = "pod_keyword" | "pod_ai" | "not_pod" | "error";

export interface PodClassificationResult {
  classification: PodClassification;
  method: "keyword" | "ai" | "none";
  confidence: number; // 0..1
  reason: string;
}

export interface ResolvedRecipients {
  dispatcher: { email: string; name?: string; userId?: string } | null;
  accountOwner: { email: string; name?: string; userId?: string } | null;
  teamFallback: { email: string } | null;
}

// ── Constants ───────────────────────────────────────────────────────────────

const POD_KEYWORDS = [
  "proof of delivery",
  "signed pod",
  "signed bol",
  "signed bill of lading",
  "delivery receipt",
  "delivery confirmation",
  "driver receipt",
  "pod attached",
  "pod for",
  "bol attached",
  "bill of lading",
  // Standalone tokens — must be a whole word
] as const;
const POD_TOKEN_KEYWORDS = ["pod", "bol"];

const POD_ATTACHMENT_MIME_PREFIXES = [
  "application/pdf",
  "image/",
  "application/octet-stream", // some scanners send PDF as octet-stream
];

// Filenames frequently use `_` and `-` as token separators (e.g.
// "VT123_signed_POD.pdf"), and `\b` treats `_` as a word character so it
// won't fire there. Use explicit alphanumeric boundaries instead.
const POD_FILENAME_HINT_REGEX =
  /(?<![A-Za-z0-9])(pod|bol|bill[\s_-]*of[\s_-]*lading|delivery[\s_-]*receipt|signed[\s_-]*(?:pod|bol)|proof[\s_-]*of[\s_-]*delivery)(?![A-Za-z0-9])/i;

/**
 * Order ID patterns (in order of specificity, most-specific first).
 *   - VT###### : the canonical Value Truck order id (4-8 digits, optional dash)
 *   - "Order #12345" / "Load #12345" / "Order 12345" : generic fallback
 *   - Standalone 6-9 digit runs are intentionally NOT matched globally —
 *     too noisy. Only matched when adjacent to an order/load keyword.
 */
// Use explicit alphanumeric boundaries (instead of `\b`) so the patterns
// also fire inside attachment filenames like "VT123456_signed_pod.pdf".
const ORDER_ID_PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])VT[\s\-]?(\d{4,8})(?![A-Za-z0-9])/gi,
  /(?<![A-Za-z0-9])(?:order|load|shipment|pro|tracking)[\s#:_\-]*(?:no\.?|number|#)?[\s#:_\-]*(\d{4,9})(?![A-Za-z0-9])/gi,
];

// ── Pure helpers ────────────────────────────────────────────────────────────

function lowerSafe(s: string | undefined | null): string {
  return (s || "").toLowerCase();
}

/** Minimal HTML escaper for inbound-derived text we embed in forwarded mail. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


function attachmentLooksLikePod(att: PodCandidateAttachment): boolean {
  if (!att.contentType) return false;
  const ct = att.contentType.toLowerCase();
  const looksRightMime = POD_ATTACHMENT_MIME_PREFIXES.some((p) =>
    ct.startsWith(p),
  );
  if (!looksRightMime) return false;
  // Reasonable POD size: > 4KB (smaller is usually a signature image embedded
  // inline) and < 25MB (Graph attachment cap).
  if (att.sizeBytes < 4 * 1024 || att.sizeBytes > 25 * 1024 * 1024) return false;
  return true;
}

export function hasPodKeywordHit(msg: PodCandidateMessage): {
  hit: boolean;
  matchedKeyword?: string;
  matchedAttachmentName?: string;
} {
  const subject = lowerSafe(msg.subject);
  const body = lowerSafe(msg.bodyText);
  const haystack = `${subject}\n${body}`;

  for (const kw of POD_KEYWORDS) {
    if (haystack.includes(kw)) {
      return { hit: true, matchedKeyword: kw };
    }
  }
  // Whole-word check for short tokens to avoid e.g. "tripod" / "carbol".
  for (const tok of POD_TOKEN_KEYWORDS) {
    const re = new RegExp(`\\b${tok}\\b`, "i");
    if (re.test(haystack)) {
      return { hit: true, matchedKeyword: tok };
    }
  }
  for (const att of msg.attachments) {
    if (POD_FILENAME_HINT_REGEX.test(att.name)) {
      return { hit: true, matchedAttachmentName: att.name };
    }
  }
  return { hit: false };
}

/**
 * Classify whether a message is a POD using the keyword detector first.
 * If `useAiFallback` is true and the keyword detector misses but the message
 * has at least one PDF/image attachment of plausible POD size, fall back to
 * the AI classifier.
 *
 * AI calls can be stubbed in tests via `aiClassifierFn`.
 */
export async function classifyPod(
  msg: PodCandidateMessage,
  opts: {
    useAiFallback: boolean;
    aiClassifierFn?: (m: PodCandidateMessage) => Promise<{
      isPod: boolean;
      confidence: number;
      reason: string;
    }>;
  },
): Promise<PodClassificationResult> {
  const candidateAttachments = msg.attachments.filter(attachmentLooksLikePod);
  const hasCandidateAttachment = candidateAttachments.length > 0;

  const kw = hasPodKeywordHit(msg);
  if (kw.hit && hasCandidateAttachment) {
    const reason = kw.matchedKeyword
      ? `Keyword "${kw.matchedKeyword}" + ${candidateAttachments.length} attachment(s)`
      : `Attachment name "${kw.matchedAttachmentName}" matched POD pattern`;
    return {
      classification: "pod_keyword",
      method: "keyword",
      confidence: 0.95,
      reason,
    };
  }

  // Without an attachment, a POD is impossible regardless of keywords.
  if (!hasCandidateAttachment) {
    return {
      classification: "not_pod",
      method: "keyword",
      confidence: 0.99,
      reason: "No PDF/image attachment of plausible POD size",
    };
  }

  if (!opts.useAiFallback) {
    return {
      classification: "not_pod",
      method: "keyword",
      confidence: 0.7,
      reason: "Has attachment but no POD keyword (AI fallback disabled)",
    };
  }

  try {
    const classifier = opts.aiClassifierFn ?? defaultAiClassifier;
    const ai = await classifier(msg);
    return {
      classification: ai.isPod ? "pod_ai" : "not_pod",
      method: "ai",
      confidence: ai.confidence,
      reason: ai.reason,
    };
  } catch (err) {
    return {
      classification: "error",
      method: "ai",
      confidence: 0,
      reason: `AI classifier error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function defaultAiClassifier(msg: PodCandidateMessage): Promise<{
  isPod: boolean;
  confidence: number;
  reason: string;
}> {
  if (!process.env.OPENAI_API_KEY) {
    return { isPod: false, confidence: 0.5, reason: "OPENAI_API_KEY not set" };
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const attachmentSummary = msg.attachments
    .slice(0, 5)
    .map(
      (a) =>
        `- ${a.name} (${a.contentType}, ${Math.round(a.sizeBytes / 1024)} KB)`,
    )
    .join("\n");

  const prompt = `You are classifying a single inbound email at a freight broker's
accounts-receivable inbox. Decide whether this message is a Proof of Delivery
(POD) — meaning a freight delivery receipt, signed BOL, or signed driver
receipt — that the broker should forward to the dispatcher and account owner.

NOT-POD examples: invoices, invoice queries, payment remittance, rate
confirmations, generic carrier introductions, marketing, spam.

Reply with strict JSON: {"isPod": boolean, "confidence": 0..1, "reason": "<one sentence>"}.

From: ${msg.fromName ?? "?"} <${msg.fromEmail ?? "?"}>
Subject: ${msg.subject}
Body preview: ${(msg.bodyPreview || msg.bodyText || "").slice(0, 500)}
Attachments (${msg.attachments.length}):
${attachmentSummary || "(none)"}`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = resp.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);
  return {
    isPod: Boolean(parsed.isPod),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

/**
 * Extract candidate order ids from subject, body, and attachment filenames.
 * Returns deduped, uppercased canonical ids, e.g. "VT123456".
 */
export function extractOrderIds(msg: PodCandidateMessage): string[] {
  const haystacks = [
    msg.subject || "",
    msg.bodyText || "",
    ...msg.attachments.map((a) => a.name),
  ];
  const found = new Set<string>();

  for (const text of haystacks) {
    for (const pattern of ORDER_ID_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text)) !== null) {
        const digits = m[1];
        if (!digits) continue;
        // VT-prefixed → emit canonical "VT######"
        if (/VT/i.test(m[0])) {
          found.add(`VT${digits}`);
        } else {
          // Generic fallback — emit both bare digits AND VT-prefixed so the
          // matcher can try either. Order ids in load_fact may or may not
          // include the prefix depending on TMS source.
          found.add(digits);
          found.add(`VT${digits}`);
        }
      }
    }
  }
  return Array.from(found);
}

// ── DB-aware helpers ────────────────────────────────────────────────────────

export interface MatchedLoad {
  loadFactId: string;
  orderId: string;
  companyId: string | null;
  customerName: string | null;
  dispatcher: string | null;
  pickupDate: string | null;
  deliveryDate: string | null;
}

/**
 * Look up `load_fact` for any candidate order id within an org. Returns the
 * most recent match (by createdAt desc) so a re-used legacy id resolves to
 * the latest load.
 */
export async function matchOrderIdToLoad(
  orgId: string,
  candidates: string[],
): Promise<MatchedLoad | null> {
  if (candidates.length === 0) return null;
  const rows = await db
    .select({
      id: loadFact.id,
      orderId: loadFact.orderId,
      companyId: loadFact.companyId,
      customerName: loadFact.customerName,
      dispatcher: loadFact.dispatcher,
      pickupDate: loadFact.pickupDate,
      deliveryDate: loadFact.deliveryDate,
      lastChangedAt: loadFact.lastChangedAt,
    })
    .from(loadFact)
    .where(and(eq(loadFact.orgId, orgId), inArray(loadFact.orderId, candidates)))
    .orderBy(desc(loadFact.lastChangedAt))
    .limit(1);

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    loadFactId: r.id,
    orderId: r.orderId,
    companyId: r.companyId ?? null,
    customerName: r.customerName ?? null,
    dispatcher: r.dispatcher ?? null,
    pickupDate: r.pickupDate ?? null,
    deliveryDate: r.deliveryDate ?? null,
  };
}

/**
 * Resolve dispatcher (text name → user.username) and account-owner
 * (companies.assignedTo → user.username) emails for a matched load.
 *
 * `users.username` is treated as the email per the existing convention
 * (this app stores email addresses in the username column).
 */
export async function resolveRecipients(
  orgId: string,
  match: MatchedLoad | null,
): Promise<ResolvedRecipients> {
  const settings = await db
    .select({ teamFallbackEmail: podIntakeSettings.teamFallbackEmail })
    .from(podIntakeSettings)
    .where(eq(podIntakeSettings.orgId, orgId))
    .limit(1);
  const teamEmail = settings[0]?.teamFallbackEmail || null;

  const result: ResolvedRecipients = {
    dispatcher: null,
    accountOwner: null,
    teamFallback: teamEmail ? { email: teamEmail } : null,
  };

  if (!match) return result;

  // Dispatcher: load_fact.dispatcher is a text name. Try to resolve to a
  // user via case-insensitive name match within the org. If multiple users
  // share the name we deliberately don't guess.
  if (match.dispatcher) {
    const dispatcherUsers = await db
      .select({ id: users.id, username: users.username, name: users.name })
      .from(users)
      .where(
        and(
          eq(users.organizationId, orgId),
          sql`lower(${users.name}) = lower(${match.dispatcher})`,
        ),
      )
      .limit(2);
    if (dispatcherUsers.length === 1) {
      result.dispatcher = {
        email: dispatcherUsers[0].username,
        name: dispatcherUsers[0].name || match.dispatcher,
        userId: dispatcherUsers[0].id,
      };
    }
  }

  // Account owner: companies.assignedTo → users.username
  if (match.companyId) {
    const companyRow = await db
      .select({ assignedTo: companies.assignedTo, salesPersonId: companies.salesPersonId })
      .from(companies)
      .where(eq(companies.id, match.companyId))
      .limit(1);
    const ownerUserId = companyRow[0]?.assignedTo || companyRow[0]?.salesPersonId || null;
    if (ownerUserId) {
      const ownerRow = await db
        .select({ id: users.id, username: users.username, name: users.name })
        .from(users)
        .where(and(eq(users.id, ownerUserId), eq(users.organizationId, orgId)))
        .limit(1);
      if (ownerRow.length === 1) {
        result.accountOwner = {
          email: ownerRow[0].username,
          name: ownerRow[0].name || undefined,
          userId: ownerRow[0].id,
        };
      }
    }
  }

  return result;
}

/**
 * Build the bucket label surfaced in the admin UI from a row's status.
 *
 * "delivered_in_app" is grouped under the "forwarded" bucket so reps and
 * admins still see all matched-and-delivered PODs together; the
 * `deliveryMethod` column distinguishes how the rep was actually notified.
 */
export function bucketForRow(row: PodIntakeEmail): "forwarded" | "unmatched" | "not_pod" | "pending" {
  if (row.classification === "not_pod") return "not_pod";
  if (row.forwardStatus === "forwarded") return "forwarded";
  if (row.forwardStatus === "delivered_in_app") return "forwarded";
  if (row.forwardStatus === "unmatched") return "unmatched";
  return "pending";
}

// ── Attachment download from Microsoft Graph ───────────────────────────────

/**
 * Fetch the attachments of a Graph message. Returns metadata + base64 bytes
 * for inline-attachable files (≤ 3MB). Larger attachments come back without
 * `contentBase64` so they're surfaced in the admin UI for manual handling.
 */
export async function downloadGraphAttachments(
  mailboxAddress: string,
  graphMessageId: string,
): Promise<PodCandidateAttachment[]> {
  const { getGraphAccessToken } = await import("../graphService");
  const token = await getGraphAccessToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
    mailboxAddress,
  )}/messages/${encodeURIComponent(graphMessageId)}/attachments`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Graph attachments fetch failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    value?: Array<{
      id?: string;
      name?: string;
      contentType?: string;
      size?: number;
      contentBytes?: string;
      "@odata.type"?: string;
      isInline?: boolean;
    }>;
  };
  const out: PodCandidateAttachment[] = [];
  for (const att of json.value || []) {
    if (att["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;
    if (att.isInline) continue;
    const sizeBytes = att.size ?? 0;
    out.push({
      id: att.id || "",
      name: att.name || "attachment",
      contentType: att.contentType || "application/octet-stream",
      sizeBytes,
      // Only retain payload for inline-sendable size (3MB threshold)
      contentBase64: sizeBytes <= 3 * 1024 * 1024 ? att.contentBytes : undefined,
    });
  }
  return out;
}

// ── Forwarding ──────────────────────────────────────────────────────────────

export interface ForwardPodResult {
  ok: boolean;
  to: string[];
  error?: string;
}

/**
 * Forward a POD email + attachments via Outlook to the resolved recipients.
 * Sends as the AR mailbox (so replies go back there). Returns per-recipient
 * results.
 *
 * `sender` is the function that actually emits the email — defaults to
 * `sendOutlookEmail` but can be stubbed in tests.
 */
export async function forwardPod(args: {
  fromMailbox: string;
  recipients: ResolvedRecipients;
  match: MatchedLoad | null;
  msg: PodCandidateMessage;
  attachments: PodCandidateAttachment[];
  sender?: (opts: import("../outlookService").OutlookSendOptions) => Promise<{ ok: boolean; error?: string }>;
}): Promise<ForwardPodResult> {
  const sender =
    args.sender ?? (await import("../outlookService")).sendOutlookEmail;

  // Build recipient list. Dispatcher is primary (To); account owner + team
  // fallback go on Cc. If dispatcher resolution failed, the account owner
  // becomes To. If neither resolves, team fallback becomes To.
  let primary: { email: string; name?: string } | null = null;
  const ccs: string[] = [];

  if (args.recipients.dispatcher) {
    primary = args.recipients.dispatcher;
    if (args.recipients.accountOwner) ccs.push(args.recipients.accountOwner.email);
  } else if (args.recipients.accountOwner) {
    primary = args.recipients.accountOwner;
  } else if (args.recipients.teamFallback) {
    primary = { email: args.recipients.teamFallback.email };
  }

  if (args.recipients.teamFallback) {
    if (!primary || primary.email !== args.recipients.teamFallback.email) {
      ccs.push(args.recipients.teamFallback.email);
    }
  }

  if (!primary) {
    return { ok: false, to: [], error: "No recipients resolved (no dispatcher, no account owner, no team fallback)" };
  }

  // Escape every inbound-derived string before embedding in the forwarded
  // HTML — a malicious POD email could otherwise inject <script>, tracking
  // pixels, or spoofed text into the message we send to the dispatcher /
  // account owner. Body HTML from inbound mail is intentionally NOT
  // re-rendered as HTML; we forward it as escaped plain text.
  const matchLine = args.match
    ? `Order ${escapeHtml(args.match.orderId)} — ${escapeHtml(args.match.customerName ?? "(unknown customer)")}` +
      (args.match.dispatcher ? ` — Dispatcher: ${escapeHtml(args.match.dispatcher)}` : "") +
      (args.match.deliveryDate ? ` — Delivered: ${escapeHtml(String(args.match.deliveryDate))}` : "")
    : "Unmatched POD — no load found in load_fact";

  const sendable = args.attachments.filter((a) => a.contentBase64 && a.sizeBytes <= 3 * 1024 * 1024);
  const oversize = args.attachments.filter((a) => !a.contentBase64 || a.sizeBytes > 3 * 1024 * 1024);

  const safeFromName = escapeHtml(args.msg.fromName || "");
  const safeFromEmail = escapeHtml(args.msg.fromEmail || "");
  const safeSubject = escapeHtml(args.msg.subject || "(no subject)");
  const safeBody = escapeHtml(args.msg.bodyText || args.msg.bodyPreview || "").replace(
    /\n/g,
    "<br/>",
  );

  const introHtml = `
    <div style="font-family: Arial, sans-serif; font-size: 13px;">
      <p><strong>Auto-forwarded POD</strong> from FreightDNA POD intake.</p>
      <p>${matchLine}</p>
      <p><strong>Original sender:</strong> ${safeFromName} &lt;${safeFromEmail}&gt;<br/>
      <strong>Original subject:</strong> ${safeSubject}</p>
      ${oversize.length > 0
        ? `<p style="color: #b00;"><strong>Note:</strong> ${oversize.length} attachment(s) exceeded the 3MB inline-forwarding limit and are not included. View them in the FreightDNA POD intake admin to download.</p>`
        : ""}
      <hr/>
      <div>${safeBody}</div>
    </div>`.trim();

  const result = await sender({
    fromEmail: args.fromMailbox,
    toEmail: primary.email,
    toName: primary.name,
    ccEmails: ccs,
    subject: `FW: ${args.msg.subject || "POD"}`,
    body: introHtml,
    isHtml: true,
    saveToSentItems: true,
    attachments: sendable.map((a) => ({
      name: a.name,
      contentType: a.contentType,
      contentBase64: a.contentBase64!,
    })),
  });

  return {
    ok: result.ok,
    to: [primary.email, ...ccs],
    error: result.error,
  };
}

// ── Ingestion entry point (called from graphWebhook) ────────────────────────

export interface IngestPodEmailInput {
  orgId: string;
  mailboxId: string | null;
  mailboxAddress: string;
  graphMessageId: string;
  internetMessageId: string | null;
  receivedAt: Date;
  fromEmail: string;
  fromName: string;
  subject: string;
  bodyText: string;
  bodyPreview: string;
  /** Provided when the webhook handler has already pre-loaded attachments
   *  (e.g. integration tests). When omitted, we fetch from Graph. */
  attachments?: PodCandidateAttachment[];
}

/**
 * Optional dependency-injection hooks for `ingestPodEmail`. In production
 * these default to the real exports in this module; tests can pass stubs
 * to avoid touching the database / Outlook.
 */
export interface IngestPodEmailDeps {
  matchOrderIdToLoad?: typeof matchOrderIdToLoad;
  resolveRecipients?: typeof resolveRecipients;
  forwardPod?: typeof forwardPod;
}

/**
 * Full pipeline: classify → extract → match → resolve → forward → persist.
 * Idempotent on (orgId, providerMessageId) via the unique index — re-deliveries
 * from Graph that hit this function update the existing row rather than
 * inserting a duplicate.
 */
export async function ingestPodEmail(
  input: IngestPodEmailInput,
  deps: IngestPodEmailDeps = {},
): Promise<{
  rowId: string;
  classification: PodClassification;
  forwardStatus: string;
}> {
  const matchFn = deps.matchOrderIdToLoad ?? matchOrderIdToLoad;
  const resolveFn = deps.resolveRecipients ?? resolveRecipients;
  const forwardFn = deps.forwardPod ?? forwardPod;
  const { storage } = await import("../storage");

  // Look up settings to know whether AI fallback is on for this org and
  // whether auto-forward email is enabled (Task #614 — when off, the row
  // is still classified, matched, persisted, and reps are notified
  // in-app; only the Outlook send is skipped).
  const settingsRow = await db
    .select()
    .from(podIntakeSettings)
    .where(eq(podIntakeSettings.orgId, input.orgId))
    .limit(1);
  const useAiFallback = settingsRow[0]?.useAiFallback ?? true;
  const autoForwardEmail = settingsRow[0]?.autoForwardEmail ?? true;

  // Fetch attachments unless already provided.
  let attachments: PodCandidateAttachment[];
  if (input.attachments) {
    attachments = input.attachments;
  } else {
    try {
      attachments = await downloadGraphAttachments(input.mailboxAddress, input.graphMessageId);
    } catch (err) {
      attachments = [];
      console.warn(`[pod-intake] attachment fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const candidate: PodCandidateMessage = {
    subject: input.subject,
    bodyText: input.bodyText,
    bodyPreview: input.bodyPreview,
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    attachments,
  };

  const classification = await classifyPod(candidate, { useAiFallback });
  const orderIds = extractOrderIds(candidate);

  let match: MatchedLoad | null = null;
  let recipients: ResolvedRecipients = {
    dispatcher: null,
    accountOwner: null,
    teamFallback: null,
  };
  let forwardResult: ForwardPodResult | null = null;
  let forwardStatus:
    | "forwarded"
    | "unmatched"
    | "not_pod"
    | "failed"
    | "pending"
    | "delivered_in_app" = "pending";
  let deliveryMethod: "email" | "in_app" | null = null;

  const isPod =
    classification.classification === "pod_keyword" ||
    classification.classification === "pod_ai";

  if (!isPod) {
    forwardStatus = "not_pod";
  } else {
    match = await matchFn(input.orgId, orderIds);
    recipients = await resolveFn(input.orgId, match);

    if (autoForwardEmail) {
      forwardResult = await forwardFn({
        fromMailbox: input.mailboxAddress,
        recipients,
        match,
        msg: candidate,
        attachments,
      });

      if (forwardResult.ok) {
        forwardStatus = match ? "forwarded" : "unmatched";
        if (match) deliveryMethod = "email";
      } else {
        forwardStatus = "failed";
      }
    } else {
      // Fully in-DNA mode: skip Outlook send. Matched PODs are still
      // persisted + reps notified in-app. Unmatched PODs still need
      // operator triage so they land in the "unmatched" bucket.
      if (match) {
        forwardStatus = "delivered_in_app";
        deliveryMethod = "in_app";
      } else {
        forwardStatus = "unmatched";
      }
    }
  }

  const row = await storage.upsertPodIntakeEmail({
    orgId: input.orgId,
    mailboxId: input.mailboxId,
    providerMessageId: input.graphMessageId,
    internetMessageId: input.internetMessageId,
    receivedAt: input.receivedAt,
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    subject: input.subject,
    bodyPreview: input.bodyPreview.slice(0, 2000),
    bodyText: input.bodyText.slice(0, 50_000),
    hasAttachments: attachments.length > 0,
    attachmentMeta: attachments.map((a) => ({
      id: a.id,
      name: a.name,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      isPodCandidate: attachmentLooksLikePodPublic(a),
    })),
    classification: classification.classification,
    classifierMethod: classification.method,
    classifierConfidence: String(classification.confidence),
    classifierReason: classification.reason,
    extractedOrderIds: orderIds,
    matchedOrderId: match?.orderId ?? null,
    matchedLoadFactId: match?.loadFactId ?? null,
    matchedCompanyId: match?.companyId ?? null,
    forwardStatus,
    forwardedAt: forwardResult?.ok || forwardStatus === "delivered_in_app" ? new Date() : null,
    forwardedTo:
      forwardResult?.ok || forwardStatus === "delivered_in_app"
        ? {
            dispatcher: recipients.dispatcher
              ? { email: recipients.dispatcher.email, name: recipients.dispatcher.name }
              : null,
            accountOwner: recipients.accountOwner
              ? { email: recipients.accountOwner.email, name: recipients.accountOwner.name }
              : null,
            teamFallback: recipients.teamFallback,
          }
        : null,
    forwardError: forwardResult && !forwardResult.ok ? forwardResult.error || "send failed" : null,
    deliveryMethod,
    dispatcherUserId: recipients.dispatcher?.userId ?? null,
    accountOwnerUserId: recipients.accountOwner?.userId ?? null,
  });

  // ── In-app notifications ──────────────────────────────────────────────
  // Fire notifications for the resolved dispatcher + account owner whenever
  // we successfully matched a POD email to a load. This is independent of
  // the auto-forward toggle and of Outlook send success — if the POD was
  // matched, the rep needs to know, even if the upstream Outlook send later
  // failed (the row is still visible on /my-pods and the load detail page).
  // We still skip not_pod / unmatched rows — those land in the admin queue
  // for operator triage.
  if (isPod && match) {
    const orderLabel = match?.orderId ?? "POD";
    const customerLabel = match?.customerName ?? "(unknown customer)";

    // Deep-link the notification to the matched load on the available-freight
    // detail page when we can resolve a freight opportunity for this orderId.
    // Otherwise fall back to the rep "My PODs" page so the link is always usable.
    let link = "/my-pods";
    if (match?.orderId) {
      try {
        const oppRows = await db
          .select({ id: freightOpportunities.id })
          .from(freightOpportunities)
          .where(
            and(
              eq(freightOpportunities.orgId, input.orgId),
              sql`${freightOpportunities.sourceRef}->>'orderId' = ${match.orderId}`,
            ),
          )
          .orderBy(desc(freightOpportunities.generatedAt))
          .limit(1);
        if (oppRows[0]?.id) {
          link = `/available-freight/${oppRows[0].id}`;
        }
      } catch (err) {
        console.warn(
          `[pod-intake] FO lookup for deep-link failed (orderId=${match.orderId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const notified = new Set<string>();
    const targets: Array<{ userId: string; role: "dispatcher" | "account_owner" }> = [];
    if (recipients.dispatcher?.userId) {
      targets.push({ userId: recipients.dispatcher.userId, role: "dispatcher" });
    }
    if (recipients.accountOwner?.userId) {
      targets.push({ userId: recipients.accountOwner.userId, role: "account_owner" });
    }
    for (const t of targets) {
      if (notified.has(t.userId)) continue;
      notified.add(t.userId);
      try {
        await storage.createNotification({
          userId: t.userId,
          type: "pod_received",
          title: `POD received — Order ${orderLabel}`,
          body: `Proof of delivery for ${customerLabel}${
            input.fromName || input.fromEmail
              ? ` from ${input.fromName || input.fromEmail}`
              : ""
          }.`,
          link,
          relatedId: row.id,
        });
      } catch (err) {
        console.warn(
          `[pod-intake] notification create failed for user ${t.userId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  return {
    rowId: row.id,
    classification: classification.classification,
    forwardStatus,
  };
}

// Re-export the size/mime gate for storage of meta on each attachment row.
export function attachmentLooksLikePodPublic(att: PodCandidateAttachment): boolean {
  return attachmentLooksLikePod(att);
}
