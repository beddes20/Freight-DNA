import { queryClient } from "./queryClient";

/**
 * Centralized cache invalidation after any touchpoint creation or deletion.
 * Call this in the onSuccess callback of every touchpoint mutation to ensure
 * all affected surfaces (Today's Touchpoints, Account Growth portlet, NBA, etc.)
 * reflect the latest data without waiting for stale-time expiry.
 */
export function invalidateAfterTouchpoint(companyId?: string | null) {
  queryClient.invalidateQueries({ queryKey: ["/api/touchpoints/today"] });
  queryClient.invalidateQueries({ queryKey: ["/api/touchpoints/company-summary"] });
  queryClient.invalidateQueries({ queryKey: ["/api/growth-scores"] });
  queryClient.invalidateQueries({ queryKey: ["/api/next-best-actions"] });

  if (companyId) {
    queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "touchpoints"] });
    queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "touch-logs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "next-best-action"] });
    queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "growth-score"] });
  }
}
