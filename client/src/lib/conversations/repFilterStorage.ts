// Per-user persistence of the Conversations Rep filter.
// URL `?rep=` takes precedence on first load; the chosen value is
// mirrored into localStorage so a follow-up reload without a query
// string still lands on the rep's last selection.

export const REP_FILTER_KEY_PREFIX = "conversations:repFilter:";

export function repFilterKey(userId: string | null | undefined): string | null {
  return userId ? `${REP_FILTER_KEY_PREFIX}${userId}` : null;
}

// "all" / "unassigned" / a concrete user id are the only valid shapes.
// Anything else (no user, missing window, empty string) → "all".
export function loadRepFilter(userId: string | null | undefined): string {
  if (typeof window === "undefined") return "all";
  const k = repFilterKey(userId);
  if (!k) return "all";
  const v = window.localStorage.getItem(k);
  if (!v) return "all";
  return v;
}
