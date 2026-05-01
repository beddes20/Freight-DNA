// Workflow OS — generalized Bulk Action Bar.
//
// Generalized from `client/src/components/conversations/bulk-action-bar.tsx`
// (which now wraps this component). Renders the canonical bulk action bar
// shared by Available Freight, Lane Work Queue, Available Loads, and the
// conversations inbox. See docs/workflow-os-spec.md section D.
//
// Layout: [count] [primary] [secondary…] [overflow] [spacer] [Clear]

import { type ReactNode, type ComponentType } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";

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
  render?: (props: { disabled: boolean }) => ReactNode;
}

interface BulkActionBarProps {
  count: number;
  busy?: boolean;
  onClear: () => void;
  // Primary action — rendered first, prominently.
  primary?: BulkAction;
  // Secondary actions — rendered in fixed left-to-right order.
  secondary?: BulkAction[];
  // Overflow actions — surface-specific extras tucked behind a "…" menu.
  overflow?: BulkAction[];
  // Optional left-side label override; defaults to "N selected".
  label?: ReactNode;
  // Optional "Select all visible (M)" affordance shown when only a page
  // of rows is currently selected.
  selectAllAffordance?: {
    visibleCount: number;
    onSelectAllVisible: () => void;
  };
  // Sticky position. Defaults to "bottom" (the spec). The conversations
  // bar opts into "top" because its scroll container puts the toolbar at
  // the top of the inbox.
  stickPosition?: "top" | "bottom";
  className?: string;
  testId?: string;
}

export function BulkActionBar({
  count,
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

      {primary && <BulkActionButton action={primary} busy={busy} variant="default" />}
      {secondary.map((a) => (
        <BulkActionButton key={a.id} action={a} busy={busy} variant="outline" />
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
              return (
                <DropdownMenuItem
                  key={a.id}
                  onClick={() => void a.onSelect()}
                  disabled={busy || a.disabled}
                  data-testid={a.testId ?? `bulk-overflow-${a.id}`}
                >
                  {Icon && <Icon className="w-3 h-3 mr-2" />}
                  {a.label}
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
}: {
  action: BulkAction;
  busy: boolean;
  variant: "default" | "outline";
}) {
  const disabled = busy || !!action.disabled;
  if (action.render) return <>{action.render({ disabled })}</>;
  const Icon = action.icon;
  return (
    <Button
      size="sm"
      variant={variant}
      className="h-8 text-xs gap-1"
      onClick={() => void action.onSelect()}
      disabled={disabled}
      data-testid={action.testId ?? `button-bulk-${action.id}`}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {action.label}
    </Button>
  );
}
