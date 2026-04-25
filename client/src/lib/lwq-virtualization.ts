/**
 * Task #648 — Lane Work Queue list virtualization helpers.
 *
 * The LWQ page uses page-level scroll: a single `overflow-y-auto` container
 * holds four stacked buckets, each with multiple customer-group cards, each
 * in turn containing a variable number of `LaneRow` cards. On real orgs
 * this means hundreds of `LaneRow` instances mount up front — every one
 * with badges, conditional progress bars, lane-coverage queries, hover
 * prefetch handlers, etc. That makes first paint slow and scroll janky.
 *
 * Strict react-window virtualization expects a fixed-height scroll viewport
 * per list, which would force four chopped-up internal scroll regions and
 * lose the smooth top-to-bottom skim users rely on. Instead we keep
 * page-level scroll and "virtualize" by lazy-mounting each `LaneRow` on
 * viewport intersection (see `LazyLaneRow` in `lane-work-queue.tsx`).
 *
 * This module owns two pieces of shared state used by that wrapper:
 *
 *   1. A module-scoped height cache keyed by `laneId`. The wrapper
 *      populates it via `ResizeObserver` on first mount, and reads back
 *      from it the next time the same lane scrolls into view (eg after
 *      collapse/expand, bucket toggle, or page rerender). Using cached
 *      heights for placeholder rows keeps the document layout stable —
 *      no jumpy reflow as the user scrolls.
 *
 *   2. A `LWQ_VIEWPORT_MARGIN_PX` constant for the IntersectionObserver
 *      `rootMargin`, exported so tests can lock in a sane value and so
 *      the wrapper doesn't hardcode it inline.
 */

const heightCache = new Map<string, number>();

// Reasonable fallback for never-measured rows — enough to fit customer
// label, lane label, badges row, metrics row without obvious jumps.
const DEFAULT_ROW_HEIGHT_PX = 140;

// Mount rows whose placeholders are within this many pixels of the
// viewport. Generous enough that users effectively never see a blank
// placeholder during a flick scroll, small enough to keep mounted-row
// counts low even on long buckets.
export const LWQ_VIEWPORT_MARGIN_PX = 800;

export function getCachedRowHeight(
  laneId: string,
  fallback: number = DEFAULT_ROW_HEIGHT_PX,
): number {
  const cached = heightCache.get(laneId);
  if (cached !== undefined && cached > 0) return cached;
  return fallback;
}

export function setCachedRowHeight(laneId: string, height: number): void {
  if (!Number.isFinite(height) || height <= 0) return;
  heightCache.set(laneId, height);
}

export function clearRowHeightCache(): void {
  heightCache.clear();
}
