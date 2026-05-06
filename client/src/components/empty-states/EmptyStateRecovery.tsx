// Task #967 — Shared trust layer: filtered-empty recovery component.
//
// Every ops surface eventually shows a "no rows" pane. There are two very
// different reasons for it:
//
//   1. Genuinely empty — there's nothing for the user to do (inbox zero).
//   2. Filtered to nothing — the active filter combo is hiding rows that
//      otherwise would show.
//
// Reps consistently misread (2) as (1) — a "you've cleared your inbox!"
// message during a busy day breaks trust the moment they realise their
// "Mine only" toggle was on. <EmptyStateRecovery /> is the shared empty
// pane for the filtered case: it names the active filters and offers a
// one-click "Reset filters" escape hatch alongside any other recovery
// actions (deep-links, alternate views, etc).
//
// The genuinely-empty case keeps using the existing `<EmptyState />` in
// `client/src/components/ui/empty-state.tsx`. This component wraps it,
// so the visual rhythm stays the same.

import { Inbox, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export interface EmptyStateRecoveryAction {
  label: string;
  onClick: () => void;
  testId?: string;
  /** Visual emphasis. `primary` is the recommended escape hatch (Reset). */
  variant?: "primary" | "secondary";
}

export interface EmptyStateRecoveryProps {
  icon?: LucideIcon;
  /**
   * Headline. Defaults differ depending on whether `activeFilterLabels`
   * is non-empty; pass an explicit string when the surface has its own
   * voice.
   */
  title?: string;
  /** Sub-copy below the title. */
  description?: string;
  /**
   * Plain-text labels for filters currently in effect. When non-empty
   * the component renders them as muted chips above the actions so the
   * rep can see exactly *what* is hiding rows. Empty list → renders the
   * generic empty state with no chip strip.
   */
  activeFilterLabels?: ReadonlyArray<string>;
  /**
   * The recovery escape hatch. Required when filters are active (the
   * whole point of this component); optional when the surface only uses
   * EmptyStateRecovery as a stylistic alias for EmptyState.
   */
  onResetFilters?: () => void;
  /** Override the "Reset filters" button label. */
  resetLabel?: string;
  /**
   * Surface-specific extra actions (e.g. "Open Capture Leak Queue",
   * "Switch to default view"). Rendered after the Reset button.
   */
  extraActions?: ReadonlyArray<EmptyStateRecoveryAction>;
  testId?: string;
  className?: string;
}

export function EmptyStateRecovery({
  icon: Icon = Inbox,
  title,
  description,
  activeFilterLabels,
  onResetFilters,
  resetLabel = "Reset filters",
  extraActions,
  testId,
  className = "",
}: EmptyStateRecoveryProps): JSX.Element {
  const filters = activeFilterLabels ?? [];
  const hasFilters = filters.length > 0;
  const rootTestId = testId ?? "empty-state-recovery";

  // Default copy adapts to whether filters are active, because the
  // headline is the most-misread piece of empty-state UI.
  const resolvedTitle =
    title ??
    (hasFilters
      ? "No matches for the current filters"
      : "Nothing to show here yet");
  const resolvedDescription =
    description ??
    (hasFilters
      ? "Adjust or reset your filters to bring more rows back into view."
      : "When new work lands, it'll appear here automatically.");

  // When there's no filter context AND no extra actions, fall through to
  // the canonical EmptyState so we don't introduce a second visual style
  // for "genuinely empty".
  if (!hasFilters && (!extraActions || extraActions.length === 0)) {
    return (
      <EmptyState
        icon={Icon}
        title={resolvedTitle}
        description={resolvedDescription}
        action={
          onResetFilters
            ? { label: resetLabel, onClick: onResetFilters }
            : undefined
        }
        testId={rootTestId}
        className={className}
      />
    );
  }

  return (
    <div
      className={`flex flex-col items-center justify-center text-center py-12 px-4 ${className}`}
      data-testid={rootTestId}
    >
      <div className="rounded-full bg-muted/40 p-3 mb-3">
        <Icon className="h-8 w-8 text-muted-foreground" />
      </div>
      <p
        className="text-sm font-semibold text-foreground"
        data-testid={`${rootTestId}-title`}
      >
        {resolvedTitle}
      </p>
      <p
        className="text-xs text-muted-foreground mt-1 max-w-md"
        data-testid={`${rootTestId}-description`}
      >
        {resolvedDescription}
      </p>

      {hasFilters && (
        <div
          className="mt-3 flex flex-wrap items-center justify-center gap-1.5 max-w-md"
          data-testid={`${rootTestId}-filters`}
        >
          {filters.map((label, i) => (
            <span
              key={`${label}-${i}`}
              className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
              data-testid={`${rootTestId}-filter-${i}`}
            >
              {label}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {onResetFilters && (
          <Button
            size="sm"
            variant="default"
            onClick={onResetFilters}
            data-testid={`${rootTestId}-reset`}
          >
            {resetLabel}
          </Button>
        )}
        {(extraActions ?? []).map((a, i) => (
          <Button
            key={a.testId ?? `${a.label}-${i}`}
            size="sm"
            variant={a.variant === "primary" ? "default" : "outline"}
            onClick={a.onClick}
            data-testid={a.testId ?? `${rootTestId}-action-${i}`}
          >
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
