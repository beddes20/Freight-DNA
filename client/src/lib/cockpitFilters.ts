export interface CockpitFilterItem {
  opportunity: {
    origin?: string | null;
    destination?: string | null;
    equipmentType?: string | null;
    pickupWindowStart?: string | null;
    status: string;
  };
  chips: Array<{ carrierName: string }>;
  coverage: { sent: number; responded: number };
  suggestedBuy: { confidence?: string | null } | null;
  freshnessMinutes: number | null;
  owner: { id: string; name?: string | null } | null;
}

export interface CockpitViewFilters {
  ownerScope?: "mine" | "team";
  pickupWithinHours?: number;
  pickupAfterHours?: number;
  confidenceFlag?: "low" | "medium" | "high";
  sentNoReplyMinAgeMin?: number;
  statuses?: string[];
}

export function applyCockpitFilters<T extends CockpitFilterItem>(
  items: T[],
  search: string,
  viewFilters: CockpitViewFilters,
  currentUserId: string | null,
  now: number,
): T[] {
  const q = search.trim().toLowerCase();
  return items.filter((it) => {
    const opp = it.opportunity;
    if (q) {
      const hay = [
        opp.origin ?? "",
        opp.destination ?? "",
        opp.equipmentType ?? "",
        ...it.chips.map((c) => c.carrierName),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (viewFilters.statuses && viewFilters.statuses.length > 0) {
      if (!viewFilters.statuses.includes(opp.status)) return false;
    }
    if (viewFilters.ownerScope === "mine") {
      if (!currentUserId || it.owner?.id !== currentUserId) return false;
    } else if (viewFilters.ownerScope === "team") {
      if (currentUserId && it.owner?.id === currentUserId) return false;
    }
    if (typeof viewFilters.pickupWithinHours === "number") {
      if (!opp.pickupWindowStart) return false;
      const dt = new Date(opp.pickupWindowStart).getTime();
      if (dt - now > viewFilters.pickupWithinHours * 3600_000) return false;
      if (dt < now) return false;
    }
    if (typeof viewFilters.pickupAfterHours === "number") {
      if (!opp.pickupWindowStart) return false;
      const dt = new Date(opp.pickupWindowStart).getTime();
      if (dt - now < viewFilters.pickupAfterHours * 3600_000) return false;
    }
    if (viewFilters.confidenceFlag) {
      if (it.suggestedBuy?.confidence !== viewFilters.confidenceFlag) return false;
    }
    if (typeof viewFilters.sentNoReplyMinAgeMin === "number") {
      if (it.coverage.sent === 0 || it.coverage.responded > 0) return false;
      if ((it.freshnessMinutes ?? 0) < viewFilters.sentNoReplyMinAgeMin) return false;
    }
    return true;
  });
}
