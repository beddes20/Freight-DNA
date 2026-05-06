// Shared state for the LWQ row windowing wrapper (LazyLaneRow). The
// page uses page-level scroll, so virtualization is implemented as
// IntersectionObserver-driven mount/unmount of LaneRow against a
// per-lane height cache populated via ResizeObserver. Module scope is
// intentional: a row that drops out of the viewport can re-enter with
// the same correct placeholder height even if React unmounts it.

const heightCache = new Map<string, number>();

const DEFAULT_ROW_HEIGHT_PX = 140;

export const LWQ_VIEWPORT_MARGIN_PX = 1000;

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
