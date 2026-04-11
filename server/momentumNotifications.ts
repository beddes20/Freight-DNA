/**
 * Momentum Score Drop Notifications
 *
 * Fired after each growth score upsert when the band falls to a lower tier.
 * Also includes a weekly Monday digest for each user summarising all
 * momentum tier changes in the past 7 days.
 *
 * Band rank (higher = better):
 *   at_risk=0  stable=1  growth_ready=2  high_expansion=3
 */

import type { IStorage } from "./storage";

const BAND_RANK: Record<string, number> = {
  at_risk:        0,
  stable:         1,
  growth_ready:   2,
  high_expansion: 3,
};

const BAND_LABEL: Record<string, string> = {
  at_risk:        "At Risk",
  stable:         "Stable",
  growth_ready:   "Growth Ready",
  high_expansion: "Primed to Grow",
};

/**
 * Call this immediately after a successful `storage.upsertGrowthScore()`.
 *
 * @param companyId    The company whose score was just updated.
 * @param newBand      The band from the freshly-computed score.
 * @param previousBand The band stored before the upsert (null on first calc).
 * @param storage      IStorage instance for DB access.
 */
export async function checkAndFireMomentumDropNotification(
  companyId: string,
  newBand: string,
  previousBand: string | null | undefined,
  storage: IStorage,
): Promise<void> {
  if (!previousBand) return;
  if (BAND_RANK[newBand] === undefined || BAND_RANK[previousBand] === undefined) return;
  if (BAND_RANK[newBand] >= BAND_RANK[previousBand]) return; // not a drop

  try {
    const company = await storage.getCompany(companyId);
    if (!company) return;

    const repId = company.assignedTo;
    if (!repId) return;

    // Deduplication: direct DB query — does not rely on the capped 50-row fetch.
    const alreadyNotified = await storage.hasUnreadNotification(repId, "momentum_drop", companyId);
    if (alreadyNotified) return;

    const fromLabel = BAND_LABEL[previousBand] ?? previousBand;
    const toLabel   = BAND_LABEL[newBand]      ?? newBand;

    await storage.createNotification({
      userId:    repId,
      type:      "momentum_drop",
      title:     `⚠️ ${company.name} dropped to ${toLabel} — review their account`,
      body:      `Momentum score band fell from ${fromLabel} to ${toLabel}. Open the account to see what changed.`,
      link:      `/companies/${companyId}`,
      relatedId: companyId,
      read:      false,
    });
  } catch (err) {
    console.error("[momentumNotifications] Failed to fire momentum drop notification:", err);
  }
}
