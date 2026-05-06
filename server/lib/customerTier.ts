// Shared customer-tier derivation.
//
// The `companies` table doesn't carry an explicit account-tier column today,
// so every surface that needs a tier badge derives one from the company's
// `estimated_freight_spend` (decimal stored as string by drizzle). Keeping
// the thresholds in one place ensures the tier shown in the Lane Cockpit
// overlay matches the one shown on AF, the Today Queue, and the freight
// opportunity cockpit. When a real `account_tier` column or CRM-enriched
// source lands, only this helper needs to change.

export function deriveCustomerTier(
  estimatedFreightSpend: string | number | null | undefined,
): string | null {
  if (estimatedFreightSpend === null || estimatedFreightSpend === undefined || estimatedFreightSpend === "") {
    return null;
  }
  const spend = typeof estimatedFreightSpend === "number"
    ? estimatedFreightSpend
    : Number.parseFloat(String(estimatedFreightSpend));
  if (!Number.isFinite(spend) || spend <= 0) return null;
  if (spend >= 1_000_000) return "platinum";
  if (spend >= 500_000) return "gold";
  if (spend >= 100_000) return "silver";
  return "bronze";
}
