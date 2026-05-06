import { queryClient } from "./queryClient";

/**
 * Centralized cache invalidation after any touchpoint creation or deletion.
 * Call this in the onSuccess callback of every touchpoint mutation to refresh
 * only the surfaces that the just-saved touchpoint actually changed:
 *   - Today's Touchpoints / company-summary list (the new row needs to show up)
 *   - The specific company's touchpoints/touch-logs timeline
 *   - The specific company's NBA card and growth score band
 *
 * Org-wide aggregates (`/api/growth-scores`, `/api/next-best-actions`) are
 * intentionally NOT invalidated here — they refresh via the live-sync
 * `daily_workspace` event published by the server once the background growth
 * score recompute finishes, or via normal stale-time. Invalidating them on
 * every single-touch save was triggering broad refetches that made the dialog
 * feel slow even after the API responded.
 */
export function invalidateAfterTouchpoint(companyId?: string | null) {
  queryClient.invalidateQueries({ queryKey: ["/api/touchpoints/today"] });
  queryClient.invalidateQueries({ queryKey: ["/api/touchpoints/company-summary"] });

  if (companyId) {
    queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "touchpoints"] });
    queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "touch-logs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "next-best-action"] });
    queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "growth-score"] });
  }
}
