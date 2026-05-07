// Phase 1.5 S8 — Subtle trust label for monthly financial-upload-backed
// portlets (Trending Accounts, Margin Metrics).
//
// Renders one of three states (mirrors decidePortletState's vocabulary
// but at the *header* of cards-present portlets, not as a banner that
// replaces them — the underlying numbers are always shown):
//
//   - asOfLabel + freshness.status === "ok"      → "As of <Month YYYY> upload"
//   - freshness.status === "stale"               → "Data may be stale — last monthly refresh <Month YYYY>"
//   - freshness.status === "unknown" (or no fr.) → "Freshness unavailable"
//   - asOfLabel only (no freshness)              → "As of <Month YYYY> upload"
//
// Never escalates unknown → stale (Task #1109a invariant). Render is
// suppressed when there is genuinely nothing to say.
import type { PortletFreshness } from "@shared/schema";

export interface AsOfLabelProps {
  asOfLabel?: string | null;
  freshness?: PortletFreshness | null;
  testId: string;
}

export function AsOfLabel({ asOfLabel, freshness, testId }: AsOfLabelProps) {
  let text: string | null = null;
  let state: "ok" | "stale" | "unknown" = "ok";

  if (freshness?.status === "stale") {
    state = "stale";
    // Strip the leading "As of " so we can re-frame as "last monthly refresh".
    const monthYear = asOfLabel?.replace(/^As of\s+/, "").replace(/\s+upload$/, "") ?? null;
    text = monthYear
      ? `Data may be stale — last monthly refresh ${monthYear}`
      : "Data may be stale";
  } else if (freshness?.status === "unknown" || (!asOfLabel && !freshness)) {
    state = "unknown";
    text = "Freshness unavailable";
  } else if (asOfLabel) {
    text = asOfLabel;
  }

  if (!text) return null;

  const tone =
    state === "stale"
      ? "text-amber-600 dark:text-amber-400"
      : state === "unknown"
      ? "text-muted-foreground italic"
      : "text-muted-foreground";

  return (
    <span
      className={`text-[11px] font-normal ${tone}`}
      data-testid={testId}
      data-asof-state={state}
    >
      {text}
    </span>
  );
}
