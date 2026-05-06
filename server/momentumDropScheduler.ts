/**
 * Weekly Momentum Drop Digest — fires every Monday morning.
 *
 * For each rep across all organisations, queries their accounts whose growth
 * score band changed in the past 7 days (up or down). Sends a single digest
 * notification per user summarising all changes.  Users with no changes are
 * skipped.
 */

import cron from "node-cron";
import { storage } from "./storage";

function log(msg: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [momentum-digest] ${msg}`);
}

const BAND_LABEL: Record<string, string> = {
  at_risk:        "At Risk",
  stable:         "Stable",
  growth_ready:   "Growth Ready",
  high_expansion: "Primed to Grow",
};

const BAND_RANK: Record<string, number> = {
  at_risk:        0,
  stable:         1,
  growth_ready:   2,
  high_expansion: 3,
};

async function sendWeeklyMomentumDigests(): Promise<void> {
  log("Running weekly momentum drop digest...");

  const orgs = await storage.getOrganizations();
  if (orgs.length === 0) { log("No organisations found, skipping."); return; }

  let totalDigests = 0;

  for (const org of orgs) {
    try {
      const allUsers     = await storage.getUsers(org.id);
      const allCompanies = await storage.getCompanies(org.id);

      const activeCompanyIds = allCompanies
        .filter((c: { archivedAt?: string | null }) => !c.archivedAt)
        .map((c: { id: string }) => c.id);

      if (activeCompanyIds.length === 0) continue;

      const allScores = await storage.getGrowthScoresByOrg(org.id, activeCompanyIds);
      const scoreByCompany = new Map(allScores.map(s => [s.companyId, s]));

      // 7-day cutoff — only count band changes recorded within this window
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const reps = allUsers.filter((u: { role: string }) =>
        ["account_manager", "national_account_manager", "sales"].includes(u.role),
      );

      for (const user of reps) {
        const myCompanies = allCompanies.filter(
          (c: { assignedTo?: string | null; archivedAt?: string | null }) =>
            c.assignedTo === user.id && !c.archivedAt,
        );

        const changes: Array<{
          company: { id: string; name: string };
          fromBand: string;
          toBand: string;
          direction: "up" | "down";
        }> = [];

        for (const company of myCompanies) {
          const score = scoreByCompany.get(company.id);
          if (!score) continue;
          if (!score.previousBand) continue;
          if (score.band === score.previousBand) continue;
          if (!score.calculatedAt || score.calculatedAt < cutoff) continue;

          const fromRank = BAND_RANK[score.previousBand] ?? -1;
          const toRank   = BAND_RANK[score.band]         ?? -1;
          if (fromRank === -1 || toRank === -1) continue;

          changes.push({
            company: { id: company.id, name: company.name },
            fromBand: score.previousBand,
            toBand:   score.band,
            direction: toRank < fromRank ? "down" : "up",
          });
        }

        if (changes.length === 0) continue;

        // Drops first, then improvements; within each group sort alphabetically
        changes.sort((a, b) => {
          if (a.direction !== b.direction) return a.direction === "down" ? -1 : 1;
          return a.company.name.localeCompare(b.company.name);
        });

        const drops        = changes.filter(c => c.direction === "down");
        const improvements = changes.filter(c => c.direction === "up");

        const titleParts: string[] = [];
        if (drops.length > 0)        titleParts.push(`${drops.length} drop${drops.length > 1 ? "s" : ""}`);
        if (improvements.length > 0) titleParts.push(`${improvements.length} improvement${improvements.length > 1 ? "s" : ""}`);
        const title = `📊 Weekly momentum recap: ${titleParts.join(", ")} across your accounts`;

        const bodyLines = changes.slice(0, 10).map(c => {
          const arrow = c.direction === "down" ? "↓" : "↑";
          return `${arrow} ${c.company.name}: ${BAND_LABEL[c.fromBand] ?? c.fromBand} → ${BAND_LABEL[c.toBand] ?? c.toBand}`;
        });
        if (changes.length > 10) bodyLines.push(`...and ${changes.length - 10} more.`);

        try {
          await storage.createNotification({
            userId:    user.id,
            type:      "momentum_weekly_digest",
            title,
            body:      bodyLines.join("\n"),
            link:      "/customers",
            read:      false,
          });
          totalDigests++;
          log(`Digest sent to ${user.name} (org: ${org.id}): ${titleParts.join(", ")}`);
        } catch (err) {
          log(`Failed to send digest to ${user.name} (org: ${org.id}): ${err}`);
        }
      }
    } catch (orgErr) {
      log(`Error processing org ${org.id}: ${orgErr instanceof Error ? orgErr.message : orgErr}`);
    }
  }

  if (totalDigests === 0) {
    log("No momentum changes in the past 7 days — no digests needed.");
  } else {
    log(`Weekly momentum digest complete — ${totalDigests} rep(s) notified across ${orgs.length} org(s).`);
  }
}

export function initMomentumDropScheduler(): void {
  // Every Monday at 07:00 Chicago time
  const cronExpression = process.env.MOMENTUM_DIGEST_CRON || "0 7 * * 1";
  cron.schedule(cronExpression, () => {
    sendWeeklyMomentumDigests().catch(err =>
      log(`Error in momentum drop scheduler: ${err instanceof Error ? err.message : err}`),
    );
  }, { timezone: "America/Chicago" });
  log(`Weekly momentum digest scheduler initialized (cron: ${cronExpression})`);
}
