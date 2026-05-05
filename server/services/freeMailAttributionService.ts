/**
 * Free-mail attribution recovery (Task #1056 / Email→Exec 5).
 *
 * Tiered, SAFE attribution for inbound emails sent from a free-mail
 * provider (Gmail / Yahoo / Outlook / iCloud / etc.). Free-mail senders
 * carry no usable domain signal, so the existing webhook pipeline only
 * hard-attaches them via:
 *   - a CRM contact match (sender email is a known person), or
 *   - thread continuity (this `conversationId` already mapped to an
 *     account), or
 *   - the (free-mail-blocked) domain fallback in
 *     `matchAccountByEmailDomain`.
 *
 * Anything that misses all three lands in the unknown-first-touch
 * `PERSIST-UNKNOWN` bucket — the inbound preservation contract — but
 * with no link to the customer the rep can see in the UI.
 *
 * This service layers two ADDITIONAL recovery tiers on top of the
 * existing pipeline. CRITICALLY: neither tier is allowed to hard-attach
 * a row. Both produce a SUGGESTION the rep confirms with one click; the
 * row stays unlinked until then so the existing inbound preservation
 * + Customer Quotes stability contracts hold.
 *
 *   - Tier 1 ("thread"):      already handled by `processUserMailboxEmail`
 *                             (see graphWebhook.ts lines ~595-625). This
 *                             service does NOT re-implement it; the hook
 *                             call site stamps `attribution_inference_source =
 *                             'thread'` so the UI can render the badge.
 *   - Tier 2 ("signature"):   parse the inbound message with the shared
 *                             `extractCompanyFromText` helper (Task #578
 *                             / sub-task 4). On a unique strong company-
 *                             name match in the SAME org, write a
 *                             `confirm_account_attribution` suggestion.
 *   - Tier 3 ("weak"):        when the From-display-name (or the
 *                             extracted text) only loosely matches a
 *                             single org-scoped company name (token
 *                             overlap, no suffix), write a low-confidence
 *                             suggestion with `tier='weak'` so the rep
 *                             knows we're guessing.
 *
 * Org isolation: every match runs through
 * `storage.getCompanies(orgId)` and is filtered by `orgId` before it
 * leaves this module. There is no cross-org query path.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import {
  conversationThreadSuggestions,
  emailConversationThreads,
  type EmailConversationThread,
} from "@shared/schema";
import {
  extractCompanyFromText,
  isFreeMailDomain,
  parseFromHeader,
} from "./customerNameResolver";

export type AttributionTier = "thread" | "signature" | "weak" | "none";

export type AttributionInferenceSource =
  | "contact"
  | "domain"
  | "thread"
  | "signature"
  | "weak"
  // Confirmed variants — written by the confirm-attribution route when
  // a rep one-click-confirms a Tier-2/3 inference. Preserves the
  // original tier so the audit trail isn't laundered into 'contact'.
  | "confirmed_signature"
  | "confirmed_weak";

export interface AttributionEvidence {
  /** Compact human-readable label describing the matching signal. */
  label: string;
  /** What text the matcher saw (signature snippet, display name, etc.). */
  matchedText?: string;
  /** Display name of the suggested customer at match time. */
  suggestedCompanyName?: string;
  /** Sender email at match time — useful for the rep to confirm. */
  senderEmail?: string;
  /** Sender display name at match time. */
  senderDisplayName?: string;
  /** User id of the rep who confirmed the suggestion (confirm route). */
  confirmedBy?: string;
  /** Original tier the confirm flow was launched from ('signature'|'weak'|null). */
  confirmedFromTier?: string | null;
  /** Allow forward-compatible evidence keys without losing typecheck. */
  [key: string]: unknown;
}

export interface FreeMailAttributionResult {
  tier: AttributionTier;
  /** Set ONLY when the matcher resolved to a single org-scoped company. */
  suggestedCompanyId: string | null;
  suggestedCompanyName: string | null;
  evidence: AttributionEvidence | null;
}

export interface ClassifyInput {
  orgId: string;
  fromEmail: string;
  fromName?: string | null;
  subject?: string | null;
  body?: string | null;
  /**
   * Test seam — when set, used in place of `storage.getCompanies(orgId)`.
   * Keeps the production path one line and dependency-free while letting
   * the unit test exercise the matching logic without a live database.
   */
  _companiesOverride?: Array<{ id: string; name: string }>;
}

/**
 * Normalize a company / signature string for comparison. Lower-cases,
 * strips punctuation, collapses whitespace, and drops the most common
 * legal suffixes (LLC, Inc, Corp, etc.) so "Acme Logistics LLC" matches
 * "Acme Logistics" / "ACME LOGISTICS, LLC" / etc.
 */
function normalizeForMatch(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'"`]/g, " ")
    .replace(/\b(llc|l\.l\.c\.|inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.|company|ltd|ltd\.|limited|lp|llp|pllc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classify an inbound free-mail email's attribution evidence. Returns
 * `tier='none'` for any non-free-mail sender (the existing pipeline
 * handles those just fine) and for free-mail senders we couldn't
 * recover a single unambiguous match for.
 *
 * Org-scoped: company list is loaded via `storage.getCompanies(orgId)`.
 */
export async function classifyFreeMailAttribution(
  input: ClassifyInput,
): Promise<FreeMailAttributionResult> {
  const noResult: FreeMailAttributionResult = {
    tier: "none",
    suggestedCompanyId: null,
    suggestedCompanyName: null,
    evidence: null,
  };

  const from = parseFromHeader(input.fromEmail);
  if (!from || !isFreeMailDomain(from.domain)) return noResult;

  const companies = input._companiesOverride
    ?? (await storage
      .getCompanies(input.orgId)
      .catch(() => [] as Awaited<ReturnType<typeof storage.getCompanies>>));
  if (companies.length === 0) return noResult;

  // Build a normalized → company lookup for O(1) Tier-2 matches and a
  // token index for the looser Tier-3 fallback. Both indexes are built
  // strictly off the org-scoped company list above.
  // Build a normalized → company lookup, BUT track collisions: if two
  // org-scoped companies normalize to the same key (e.g. "Acme
  // Logistics LLC" and "Acme Logistics Inc"), Tier-2 must NOT pick one
  // — that's exactly the ambiguity we promise to suppress. Collisions
  // get marked `null` and treated as "no unique match" downstream.
  const byNormName = new Map<string, { id: string; name: string } | null>();
  const tokenIndex = new Map<string, Set<string>>();
  for (const c of companies) {
    if (!c.name) continue;
    const norm = normalizeForMatch(c.name);
    if (norm) {
      if (byNormName.has(norm)) {
        const existing = byNormName.get(norm);
        if (existing && existing.id !== c.id) byNormName.set(norm, null);
      } else {
        byNormName.set(norm, { id: c.id, name: c.name });
      }
    }
    for (const tok of norm.split(" ")) {
      if (tok.length < 4) continue; // skip "the", "co", noisy stems
      if (!tokenIndex.has(tok)) tokenIndex.set(tok, new Set());
      tokenIndex.get(tok)!.add(c.id);
    }
  }

  // ── Tier 2: signature / company-text match ─────────────────────────────
  const signatureCompany = extractCompanyFromText(
    input.subject ?? "",
    input.body ?? "",
  );
  if (signatureCompany) {
    const norm = normalizeForMatch(signatureCompany);
    if (norm) {
      const exact = byNormName.get(norm);
      if (exact) {
        return {
          tier: "signature",
          suggestedCompanyId: exact.id,
          suggestedCompanyName: exact.name,
          evidence: {
            label: `Signature mentions "${signatureCompany}" — matches ${exact.name}`,
            matchedText: signatureCompany,
            suggestedCompanyName: exact.name,
            senderEmail: from.email,
            senderDisplayName: input.fromName ?? from.displayName ?? null ?? undefined,
          },
        };
      }
    }
  }

  // ── Tier 3: weak / display-name token match ────────────────────────────
  // Take the From display name (or the unmatched signature company text)
  // and look for the SINGLE most-overlapping company by long-token
  // intersection. A tie or a multi-company hit drops back to 'none' so
  // we never invent a confident answer where there isn't one.
  const weakProbe = input.fromName?.trim() || from.displayName?.trim() || signatureCompany || "";
  if (weakProbe) {
    const probeNorm = normalizeForMatch(weakProbe);
    const probeTokens = probeNorm.split(" ").filter(t => t.length >= 4);
    if (probeTokens.length > 0) {
      const candidateScores = new Map<string, number>();
      for (const tok of probeTokens) {
        const hits = tokenIndex.get(tok);
        if (!hits) continue;
        for (const id of hits) {
          candidateScores.set(id, (candidateScores.get(id) ?? 0) + 1);
        }
      }
      if (candidateScores.size > 0) {
        let bestId: string | null = null;
        let bestScore = 0;
        let tied = false;
        for (const [id, score] of candidateScores) {
          if (score > bestScore) {
            bestId = id;
            bestScore = score;
            tied = false;
          } else if (score === bestScore && id !== bestId) {
            tied = true;
          }
        }
        if (bestId && !tied) {
          const company = companies.find(c => c.id === bestId);
          if (company) {
            return {
              tier: "weak",
              suggestedCompanyId: company.id,
              suggestedCompanyName: company.name,
              evidence: {
                label: `Sender name "${weakProbe}" loosely matches ${company.name}`,
                matchedText: weakProbe,
                suggestedCompanyName: company.name,
                senderEmail: from.email,
                senderDisplayName: input.fromName ?? from.displayName ?? null ?? undefined,
              },
            };
          }
        }
      }
    }
  }

  return noResult;
}

/**
 * Stamp `attribution_inference_source` + `attribution_evidence` on the
 * thread row. Used by the graphWebhook hook to record HOW a thread came
 * to be linked or merely suggested-linked. Pure metadata write — does
 * NOT touch `linkedAccountId`, `linkedCarrierId`, or the row-version
 * clock contract (we route through a normal UPDATE so `updatedAt`
 * advances correctly, mirroring the rest of `applyMessageToThread`).
 *
 * Idempotent: writing the same source/evidence is a no-op for the rep.
 * Best-effort: failures are logged and swallowed so ingestion can never
 * be broken by a missing column on a partially-migrated env.
 */
export async function stampThreadAttributionSource(opts: {
  orgId: string;
  threadId: string;
  source: AttributionInferenceSource;
  evidence: AttributionEvidence | null;
}): Promise<void> {
  try {
    await db
      .update(emailConversationThreads)
      .set({
        attributionInferenceSource: opts.source,
        attributionEvidence: opts.evidence as unknown as Record<string, unknown> | null,
      })
      .where(
        and(
          eq(emailConversationThreads.orgId, opts.orgId),
          eq(emailConversationThreads.threadId, opts.threadId),
        ),
      );
  } catch (err) {
    console.error(
      `[free-mail-attribution] stampThreadAttributionSource failed (org=${opts.orgId} thread=${opts.threadId}):`,
      err,
    );
  }
}

/**
 * Persist a free-mail attribution suggestion against the thread. Reuses
 * the existing `conversation_thread_suggestions` table (one row per
 * thread, upserted) so the UI's existing dismiss / feedback affordances
 * apply automatically.
 *
 * The action type is the new `confirm_account_attribution` value; the
 * frontend treats it as a one-click "Confirm: this thread is from
 * <Company>" affordance. We deliberately seed the row with a placeholder
 * `contentHash` keyed on (sender, suggested company) so that:
 *   1. The cached suggestion sticks across re-ingestions of the same
 *      message, and
 *   2. A NEW message in the same thread (which would otherwise
 *      regenerate the cache) re-runs the standard suggestion service
 *      and replaces this row with the real next-action card. That's the
 *      desired UX: once the rep confirms attribution, the suggestion
 *      naturally rotates back to "draft reply" / "send quote" / etc.
 *
 * Best-effort: failures NEVER propagate to the ingestion path.
 */
export async function recordFreeMailAttributionSuggestion(opts: {
  orgId: string;
  threadId: string;
  result: FreeMailAttributionResult;
}): Promise<void> {
  const { orgId, threadId, result } = opts;
  if (
    (result.tier !== "signature" && result.tier !== "weak") ||
    !result.suggestedCompanyId ||
    !result.suggestedCompanyName
  ) {
    return;
  }
  try {
    const reason =
      result.tier === "signature"
        ? `Free-mail sender — signature/company text matches ${result.suggestedCompanyName}.`
        : `Free-mail sender — weak match against ${result.suggestedCompanyName}; confirm before linking.`;
    const label =
      result.tier === "signature"
        ? `Confirm: this is from ${result.suggestedCompanyName}`
        : `Looks like ${result.suggestedCompanyName}?`;
    const evidence = result.evidence ?? null;
    const contentHash = `freemail:${result.tier}:${result.suggestedCompanyId}`;
    await db
      .insert(conversationThreadSuggestions)
      .values({
        orgId,
        threadId,
        actionType: "confirm_account_attribution",
        actionLabel: label,
        actionReason: reason,
        actionParams: {
          suggestedCompanyId: result.suggestedCompanyId,
          suggestedCompanyName: result.suggestedCompanyName,
          tier: result.tier,
          evidence,
        },
        contentHash,
        generatedAt: new Date(),
        dismissedAt: null,
        dismissedByUserId: null,
        feedbackKind: null,
        feedbackNotes: null,
        feedbackAt: null,
        feedbackByUserId: null,
      })
      .onConflictDoUpdate({
        target: [
          conversationThreadSuggestions.orgId,
          conversationThreadSuggestions.threadId,
        ],
        // Only refresh when the cached row is ALSO an attribution
        // suggestion — never overwrite a real next-action suggestion
        // (`draft_reply` / `quote_request_reply` / etc.) the standard
        // service has already produced for this thread.
        set: {
          actionType: sql`CASE
            WHEN ${conversationThreadSuggestions.actionType} = 'confirm_account_attribution'
            THEN 'confirm_account_attribution'
            ELSE ${conversationThreadSuggestions.actionType}
          END`,
          actionLabel: sql`CASE
            WHEN ${conversationThreadSuggestions.actionType} = 'confirm_account_attribution'
            THEN ${label}
            ELSE ${conversationThreadSuggestions.actionLabel}
          END`,
          actionReason: sql`CASE
            WHEN ${conversationThreadSuggestions.actionType} = 'confirm_account_attribution'
            THEN ${reason}
            ELSE ${conversationThreadSuggestions.actionReason}
          END`,
          actionParams: sql`CASE
            WHEN ${conversationThreadSuggestions.actionType} = 'confirm_account_attribution'
            THEN ${JSON.stringify({
              suggestedCompanyId: result.suggestedCompanyId,
              suggestedCompanyName: result.suggestedCompanyName,
              tier: result.tier,
              evidence,
            })}::jsonb
            ELSE ${conversationThreadSuggestions.actionParams}
          END`,
          contentHash: sql`CASE
            WHEN ${conversationThreadSuggestions.actionType} = 'confirm_account_attribution'
            THEN ${contentHash}
            ELSE ${conversationThreadSuggestions.contentHash}
          END`,
          generatedAt: sql`CASE
            WHEN ${conversationThreadSuggestions.actionType} = 'confirm_account_attribution'
            THEN now()
            ELSE ${conversationThreadSuggestions.generatedAt}
          END`,
        },
      });
  } catch (err) {
    console.error(
      `[free-mail-attribution] recordFreeMailAttributionSuggestion failed (org=${orgId} thread=${threadId}):`,
      err,
    );
  }
}

/**
 * Single entry-point used by `processUserMailboxEmail`. Decides which
 * attribution source to stamp on the thread and (for Tier 2/3) writes
 * the suggestion row. Returns the chosen `AttributionInferenceSource`
 * so the caller can include it in the structured log line.
 *
 * Pre-conditions enforced by the caller (NOT re-checked here so the
 * call site stays the single source of truth on inbound preservation):
 *   - `direction === "inbound"` (outbound mail never carries attribution
 *     evidence we want to surface)
 *   - The message has been persisted upstream (we only write metadata)
 *
 * `hardAttachedSource` reflects the pre-existing webhook decision:
 *   - "contact" / "domain" / "thread" → caller already hard-attached;
 *     we just stamp the source for the badge.
 *   - null                            → caller did NOT hard-attach;
 *     run Tier 2/3 and stamp the resulting source (or leave NULL).
 */
export async function applyFreeMailAttribution(opts: {
  orgId: string;
  threadId: string;
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  body: string | null;
  hardAttachedSource: AttributionInferenceSource | null;
  /** Existing thread row (post-upsert), so we can avoid clobbering an
   *  already-stamped strong source on a retry / repeat ingest. */
  existingThread: EmailConversationThread | null;
}): Promise<AttributionInferenceSource | null> {
  // Stable hard-attach paths take precedence over Tier 2/3 inference.
  if (opts.hardAttachedSource) {
    await stampThreadAttributionSource({
      orgId: opts.orgId,
      threadId: opts.threadId,
      source: opts.hardAttachedSource,
      evidence: {
        label:
          opts.hardAttachedSource === "thread"
            ? "Matched via existing thread continuity"
            : opts.hardAttachedSource === "contact"
              ? "Sender matches a known CRM contact"
              : "Sender domain matches a known company website",
        senderEmail: opts.fromEmail,
        senderDisplayName: opts.fromName ?? undefined,
      },
    });
    return opts.hardAttachedSource;
  }

  // Free-mail-only beyond this point. Non-free-mail unknown senders
  // fall through to the existing PERSIST-UNKNOWN behaviour with no
  // attribution stamp.
  const result = await classifyFreeMailAttribution({
    orgId: opts.orgId,
    fromEmail: opts.fromEmail,
    fromName: opts.fromName,
    subject: opts.subject,
    body: opts.body,
  });
  if (result.tier === "none") return null;

  // Don't downgrade an already-strong stamp on a re-ingest. If the
  // thread previously got 'thread' / 'contact' / 'domain' / 'signature'
  // we keep that and skip writing 'weak' on top.
  const STRENGTH: Record<AttributionInferenceSource, number> = {
    weak: 1,
    signature: 2,
    confirmed_weak: 3,
    confirmed_signature: 4,
    domain: 5,
    contact: 6,
    thread: 7,
  };
  const incomingSource: AttributionInferenceSource =
    result.tier === "signature" ? "signature" : "weak";
  const existingSource = opts.existingThread?.attributionInferenceSource as
    | AttributionInferenceSource
    | null
    | undefined;
  if (existingSource && STRENGTH[existingSource] >= STRENGTH[incomingSource]) {
    return existingSource;
  }

  await stampThreadAttributionSource({
    orgId: opts.orgId,
    threadId: opts.threadId,
    source: incomingSource,
    evidence: result.evidence,
  });
  await recordFreeMailAttributionSuggestion({
    orgId: opts.orgId,
    threadId: opts.threadId,
    result,
  });
  return incomingSource;
}
