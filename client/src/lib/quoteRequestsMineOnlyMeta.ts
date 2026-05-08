// Task #1149 — Mine-Only meta resolver.
//
// The Quote Requests page surfaces an "honesty banner" + an inline
// toggle warning when the rep has Mine Only on but isn't mapped to a
// quote_reps row (Task #1007 contract). The server returns the same
// `mineOnlyMeta` shape on BOTH the snapshot and the list endpoints.
//
// Originally the page only read `snapshotQuery.data?.mineOnlyMeta`,
// so a degraded snapshot (500 / 503 / network blip) hid the banner
// even though the list response was still un-narrowed and carrying
// the same warning code. This resolver fixes that by preferring the
// snapshot (historical source of truth — Task #1007 steady state)
// and falling back to the list when the snapshot is unavailable.
//
// Kept as a tiny pure module (rather than inlined in the page) so it
// can be unit-tested without a React-DOM render harness — the repo
// runs vitest in `environment: "node"` and does not ship
// @testing-library/react.

export type MineOnlyMeta = {
  requested: boolean;
  applied: boolean;
  myRepId: string | null;
  warningCode: "NO_QUOTE_REP_MAPPING" | null;
};

type MaybeMetaCarrier = { mineOnlyMeta?: MineOnlyMeta } | undefined | null;

/**
 * Resolve the mineOnlyMeta the UI should render against, given the
 * current snapshot and list query payloads.
 *
 * Order matters: snapshot is the historical source of truth so a
 * fresh snapshot always outvotes a stale list. The list is only
 * consulted when the snapshot is missing the field (degraded
 * snapshot, fetch error, still loading).
 *
 * Returns `undefined` when neither side has the field — the banner
 * and toggle indicator stay hidden in that case.
 */
export function resolveEffectiveMineOnlyMeta(
  snapshot: MaybeMetaCarrier,
  list: MaybeMetaCarrier,
): MineOnlyMeta | undefined {
  return snapshot?.mineOnlyMeta ?? list?.mineOnlyMeta ?? undefined;
}

/**
 * Convenience predicate that mirrors the inline check the page uses
 * at both the banner and the toggle indicator. The page deliberately
 * also inlines the literal `warningCode === "NO_QUOTE_REP_MAPPING"`
 * comparison (Section 1007 of `tests/code-quality-guardrails.test.ts`
 * pins that literal in `quote-requests.tsx`); this helper exists so
 * unit tests can pin the contract in one place.
 */
export function shouldShowMineOnlyWarning(
  meta: MineOnlyMeta | undefined,
): boolean {
  return meta?.warningCode === "NO_QUOTE_REP_MAPPING";
}
