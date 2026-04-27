/**
 * Carrier Intel Suggestion expiration service (Task #769).
 *
 * Resolves long-pending carrier intel suggestions so the "Needs Review"
 * queue trends to zero instead of accumulating indefinitely. Run by a
 * nightly scheduler and exposed via an admin "Run cleanup now" button.
 *
 * Decision rules per stale suggestion (>= stalenessDays old):
 *   - Safe category + confidence >= softThreshold  -> auto_accepted
 *   - Otherwise (risky type or low confidence)     -> auto_dismissed
 *
 * Both terminal updates stamp resolution_reason = 'auto_resolved_stale'
 * so audit trails distinguish them from human accept/reject decisions.
 */
import { storage } from "../storage";

export const CARRIER_INTEL_NEEDS_REVIEW_SETTINGS_KEY = (orgId: string) =>
  `carrier_intel:needs_review:${orgId}`;

export interface NeedsReviewSettings {
  softThreshold: number;
  stalenessDays: number;
  dailyNudgeEnabled: boolean;
}

export const NEEDS_REVIEW_DEFAULTS: NeedsReviewSettings = {
  softThreshold: 60,
  stalenessDays: 14,
  dailyNudgeEnabled: true,
};

// "Safe" suggestion types eligible for auto-accept at the soft threshold
// when stale. Mirrors carrierIntelSuggestions.AUTO_ACCEPT_TYPES so the
// risky-but-stale rows always fall through to dismissal.
const SAFE_TYPES = new Set<string>([
  "lane_preference",
  "capacity_available",
  "capacity_unavailable",
  "equipment_capability",
  "region_preference",
]);

export const STALE_RESOLUTION_REASON = "auto_resolved_stale";

export async function getNeedsReviewSettings(orgId: string): Promise<NeedsReviewSettings> {
  const raw = await storage.getSetting(CARRIER_INTEL_NEEDS_REVIEW_SETTINGS_KEY(orgId));
  if (!raw) return { ...NEEDS_REVIEW_DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<NeedsReviewSettings>;
    return {
      softThreshold: clampInt(parsed.softThreshold, 0, 100, NEEDS_REVIEW_DEFAULTS.softThreshold),
      stalenessDays: clampInt(parsed.stalenessDays, 1, 365, NEEDS_REVIEW_DEFAULTS.stalenessDays),
      dailyNudgeEnabled: typeof parsed.dailyNudgeEnabled === "boolean"
        ? parsed.dailyNudgeEnabled
        : NEEDS_REVIEW_DEFAULTS.dailyNudgeEnabled,
    };
  } catch {
    return { ...NEEDS_REVIEW_DEFAULTS };
  }
}

export async function setNeedsReviewSettings(
  orgId: string,
  patch: Partial<NeedsReviewSettings>,
): Promise<NeedsReviewSettings> {
  const current = await getNeedsReviewSettings(orgId);
  const next: NeedsReviewSettings = {
    softThreshold: clampInt(patch.softThreshold, 0, 100, current.softThreshold),
    stalenessDays: clampInt(patch.stalenessDays, 1, 365, current.stalenessDays),
    dailyNudgeEnabled: typeof patch.dailyNudgeEnabled === "boolean"
      ? patch.dailyNudgeEnabled
      : current.dailyNudgeEnabled,
  };
  await storage.setSetting(CARRIER_INTEL_NEEDS_REVIEW_SETTINGS_KEY(orgId), JSON.stringify(next));
  return next;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export interface StaleCleanupResult {
  orgId: string;
  scanned: number;
  autoAccepted: number;
  autoDismissed: number;
  stalenessDays: number;
  softThreshold: number;
}

export async function runCarrierIntelStaleCleanupForOrg(orgId: string): Promise<StaleCleanupResult> {
  const settings = await getNeedsReviewSettings(orgId);
  return runCarrierIntelStaleCleanupForOrgWithSettings(orgId, settings);
}

export async function runCarrierIntelStaleCleanupForOrgWithSettings(
  orgId: string,
  settings: NeedsReviewSettings,
): Promise<StaleCleanupResult> {
  const result: StaleCleanupResult = {
    orgId,
    scanned: 0,
    autoAccepted: 0,
    autoDismissed: 0,
    stalenessDays: settings.stalenessDays,
    softThreshold: settings.softThreshold,
  };

  const stale = await storage.pool.query<{
    id: string;
    suggestion_type: string;
    confidence_score: number;
  }>(
    `SELECT id, suggestion_type, confidence_score
       FROM carrier_intel_suggestions
      WHERE org_id = $1
        AND status = 'pending'
        AND created_at < NOW() - ($2::int || ' days')::interval`,
    [orgId, settings.stalenessDays],
  );

  result.scanned = stale.rows.length;

  for (const row of stale.rows) {
    const safe = SAFE_TYPES.has(row.suggestion_type);
    const meetsThreshold = (row.confidence_score ?? 0) >= settings.softThreshold;
    const targetStatus: "auto_accepted" | "auto_dismissed" =
      safe && meetsThreshold ? "auto_accepted" : "auto_dismissed";

    try {
      await storage.updateSuggestionStatus(row.id, targetStatus, {
        resolutionReason: STALE_RESOLUTION_REASON,
      });
      if (targetStatus === "auto_accepted") result.autoAccepted++;
      else result.autoDismissed++;
    } catch (err) {
      console.error(
        `[carrier-intel-cleanup] failed to update suggestion ${row.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}

export async function runCarrierIntelStaleCleanupForAllOrgs(): Promise<StaleCleanupResult[]> {
  const orgs = await storage.getOrganizations();
  const results: StaleCleanupResult[] = [];
  for (const org of orgs) {
    try {
      results.push(await runCarrierIntelStaleCleanupForOrg(org.id));
    } catch (err) {
      console.error(
        `[carrier-intel-cleanup] org ${org.id} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return results;
}
