// Workflow OS — canonical Bulk Action Bar shared by AF, LWQ, AL, and
// the conversations inbox. See docs/workflow-os-spec.md section D.
// Layout: [count] [primary] [secondary…] [overflow] [spacer] [Clear].
// Each action carries an `availability` descriptor:
//   { state: "available" }
//   { state: "partial",     eligibleCount, totalCount, reason? }
//   { state: "unavailable", reason }
// rendered as an inline count chip (partial) or a tooltip-wrapped
// disabled control (unavailable).

import { type ReactNode, type ComponentType } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MoreHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type BulkActionAvailability =
  | { state: "available" }
  | {
      state: "partial";
      eligibleCount: number;
      totalCount: number;
      reason?: string;
    }
  | { state: "unavailable"; reason: string };

// Availability context exposes the selected ids so per-action
// eligibility logic can live in the shared bar. Surfaces that omit
// `selectedIds` get an empty array; `selectedCount` stays authoritative.
export interface BulkActionAvailabilityContext {
  selectedCount: number;
  selectedIds: ReadonlyArray<string>;
}

export interface BulkAction {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  testId?: string;
  // When supplied, the action renders a custom trigger node instead of the
  // default <Button>. Use for actions that own their own popover (snooze,
  // assign).
  render?: (props: {
    disabled: boolean;
    availability: BulkActionAvailability;
  }) => ReactNode;
  /**
   * Per-action availability against the current selection. Either a
   * static descriptor or a function that derives one (e.g. by counting
   * eligible rows). Defaults to `{ state: "available" }` when omitted —
   * existing call sites need no migration.
   */
  availability?:
    | BulkActionAvailability
    | ((ctx: BulkActionAvailabilityContext) => BulkActionAvailability);
}

interface BulkActionBarProps {
  count: number;
  /** Selected row ids — required when any action's availability fn needs
   *  to inspect the actual selection. Defaults to an empty array; pages
   *  that only use static `available` actions can omit it. */
  selectedIds?: ReadonlyArray<string>;
  busy?: boolean;
  onClear: () => void;
  primary?: BulkAction;
  secondary?: BulkAction[];
  overflow?: BulkAction[];
  label?: ReactNode;
  selectAllAffordance?: {
    visibleCount: number;
    onSelectAllVisible: () => void;
  };
  stickPosition?: "top" | "bottom";
  className?: string;
  testId?: string;
}

/**
 * Resolve the availability descriptor for an action against the current
 * selection. Exported so callers (and tests) can compute the same value
 * the bar renders without re-implementing the default.
 */
export function resolveAvailability(
  action: BulkAction,
  ctx: BulkActionAvailabilityContext,
): BulkActionAvailability {
  if (!action.availability) return { state: "available" };
  if (typeof action.availability === "function") {
    return action.availability(ctx);
  }
  return action.availability;
}

export function BulkActionBar({
  count,
  selectedIds = [],
  busy = false,
  onClear,
  primary,
  secondary = [],
  overflow = [],
  label,
  selectAllAffordance,
  stickPosition = "bottom",
  className,
  testId = "bulk-action-bar",
}: BulkActionBarProps) {
  if (count <= 0) return null;

  const stickClass =
    stickPosition === "top"
      ? "sticky top-0 border-b"
      : "sticky bottom-0 border-t";

  const ctx: BulkActionAvailabilityContext = {
    selectedCount: count,
    selectedIds,
  };

  return (
    <div
      className={cn(
        "z-10 flex items-center gap-2 px-3 py-2 bg-primary/5",
        stickClass,
        className,
      )}
      data-testid={testId}
    >
      <span className="text-sm font-medium" data-testid="text-bulk-count">
        {label ?? `${count} selected`}
      </span>
      {selectAllAffordance && selectAllAffordance.visibleCount > count && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-xs px-2 underline underline-offset-2"
          onClick={selectAllAffordance.onSelectAllVisible}
          disabled={busy}
          data-testid="button-bulk-select-all-visible"
        >
          Select all visible ({selectAllAffordance.visibleCount})
        </Button>
      )}
      <div className="h-4 w-px bg-border mx-1" />

      {primary && (
        <BulkActionButton
          action={primary}
          busy={busy}
          variant="default"
          ctx={ctx}
        />
      )}
      {secondary.map((a) => (
        <BulkActionButton
          key={a.id}
          action={a}
          busy={busy}
          variant="outline"
          ctx={ctx}
        />
      ))}

      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1"
              disabled={busy}
              data-testid="button-bulk-overflow"
              aria-label="More bulk actions"
            >
              <MoreHorizontal className="w-3 h-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {overflow.map((a) => {
              const Icon = a.icon;
              const availability = resolveAvailability(a, ctx);
              const itemDisabled =
                busy || a.disabled || availability.state === "unavailable";
              return (
                <DropdownMenuItem
                  key={a.id}
                  onClick={() => void a.onSelect()}
                  disabled={itemDisabled}
                  data-testid={a.testId ?? `bulk-overflow-${a.id}`}
                  title={
                    availability.state !== "available"
                      ? "reason" in availability
                        ? availability.reason
                        : undefined
                      : undefined
                  }
                >
                  {Icon && <Icon className="w-3 h-3 mr-2" />}
                  {a.label}
                  {availability.state === "partial" && (
                    <span
                      className="ml-2 inline-flex items-center px-1.5 py-0 rounded-sm text-[10px] bg-muted text-muted-foreground"
                      data-testid={`badge-bulk-overflow-availability-${a.id}`}
                    >
                      {availability.eligibleCount} of {availability.totalCount}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <div className="flex-1" />
      <Button
        size="sm"
        variant="ghost"
        className="h-8 text-xs gap-1"
        onClick={onClear}
        disabled={busy}
        data-testid="button-bulk-clear"
        aria-label="Clear selection"
      >
        <X className="w-3 h-3" />
        Clear
      </Button>
    </div>
  );
}

function BulkActionButton({
  action,
  busy,
  variant,
  ctx,
}: {
  action: BulkAction;
  busy: boolean;
  variant: "default" | "outline";
  ctx: BulkActionAvailabilityContext;
}) {
  const availability = resolveAvailability(action, ctx);
  const unavailable = availability.state === "unavailable";
  const disabled = busy || !!action.disabled || unavailable;

  if (action.render) {
    const node = <>{action.render({ disabled, availability })}</>;
    return wrapWithReasonTooltip(node, availability);
  }

  const Icon = action.icon;
  const testId = action.testId ?? `button-bulk-${action.id}`;
  const button = (
    <Button
      size="sm"
      variant={variant}
      className="h-8 text-xs gap-1"
      onClick={() => void action.onSelect()}
      disabled={disabled}
      data-testid={testId}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {action.label}
      {availability.state === "partial" && (
        <span
          className="ml-1 inline-flex items-center px-1.5 py-0 rounded-sm text-[10px] bg-background/60 text-muted-foreground border border-border"
          data-testid={`badge-bulk-availability-${action.id}`}
        >
          {availability.eligibleCount} of {availability.totalCount}
        </span>
      )}
    </Button>
  );

  return wrapWithReasonTooltip(button, availability);
}

function wrapWithReasonTooltip(
  node: ReactNode,
  availability: BulkActionAvailability,
): ReactNode {
  if (availability.state === "available") return node;
  const reason =
    "reason" in availability && availability.reason
      ? availability.reason
      : null;
  if (!reason) return node;
  // Wrap in a span so disabled buttons (which don't fire pointer events)
  // still surface the tooltip via the wrapper.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{node}</span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="text-xs max-w-[260px]"
        data-testid="tooltip-bulk-availability-reason"
      >
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}
