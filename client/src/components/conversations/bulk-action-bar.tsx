// Conversations Bulk Action Bar — thin wrapper over the shared
// `BulkActionBar` in `client/src/components/workflow-os/BulkActionBar.tsx`.
//
// The original conversations bar was generalized into the workflow-os
// version (Workflow OS spec section D, Task #907). This wrapper preserves
// the existing call site by composing the conversations-specific actions
// (resolve / reopen / archive / snooze / assign) into the shared slots.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Check, Archive, Inbox, UserPlus, ChevronDown } from "lucide-react";
import { SnoozePopover } from "./snooze-popover";
import {
  BulkActionBar as SharedBulkActionBar,
  type BulkAction,
} from "@/components/workflow-os/BulkActionBar";

interface Rep {
  id: string;
  fullName: string;
  email: string;
}

interface BulkActionBarProps {
  count: number;
  busy: boolean;
  onClear: () => void;
  onResolve: () => void;
  onReopen: () => void;
  onArchive: () => void;
  onSnooze: (until: Date) => void | Promise<void>;
  onAssign: (ownerUserId: string | null) => void;
  reps: Rep[];
  currentUserId?: string;
}

export function BulkActionBar({
  count,
  busy,
  onClear,
  onResolve,
  onReopen,
  onArchive,
  onSnooze,
  onAssign,
  reps,
  currentUserId,
}: BulkActionBarProps) {
  const [assignOpen, setAssignOpen] = useState(false);

  // Conversations actions are unconditionally available against any
  // selection — eligibility is gated by row state at the inbox level,
  // not per-action.
  const ALWAYS_AVAILABLE = { state: "available" } as const;

  const resolve: BulkAction = {
    id: "resolve",
    label: "Resolve",
    icon: Check,
    onSelect: onResolve,
    testId: "button-bulk-resolve",
    availability: ALWAYS_AVAILABLE,
  };
  const reopen: BulkAction = {
    id: "reopen",
    label: "Reopen",
    icon: Inbox,
    onSelect: onReopen,
    testId: "button-bulk-reopen",
    availability: ALWAYS_AVAILABLE,
  };
  const archive: BulkAction = {
    id: "archive",
    label: "Archive",
    icon: Archive,
    onSelect: onArchive,
    testId: "button-bulk-archive",
    availability: ALWAYS_AVAILABLE,
  };
  const snooze: BulkAction = {
    id: "snooze",
    label: "Snooze",
    onSelect: () => {},
    availability: ALWAYS_AVAILABLE,
    render: ({ disabled }) => (
      <SnoozePopover
        onSnooze={onSnooze}
        disabled={disabled}
        testId="button-bulk-snooze"
      />
    ),
  };
  const assign: BulkAction = {
    id: "assign",
    label: "Assign",
    onSelect: () => {},
    availability: ALWAYS_AVAILABLE,
    render: ({ disabled }) => (
      <DropdownMenu open={assignOpen} onOpenChange={setAssignOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1"
            disabled={disabled}
            data-testid="button-bulk-assign"
          >
            <UserPlus className="w-3 h-3" />
            Assign
            <ChevronDown className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
          <DropdownMenuLabel className="text-xs">Assign owner</DropdownMenuLabel>
          {currentUserId && (
            <DropdownMenuItem
              onClick={() => onAssign(currentUserId)}
              data-testid="bulk-assign-me"
            >
              Assign to me
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => onAssign(null)}
            data-testid="bulk-assign-unassign"
          >
            Unassign
          </DropdownMenuItem>
          {reps.length > 0 && <DropdownMenuSeparator />}
          {reps.map((r) => (
            <DropdownMenuItem
              key={r.id}
              onClick={() => onAssign(r.id)}
              data-testid={`bulk-assign-${r.id}`}
            >
              <span className="truncate">{r.fullName}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  };

  return (
    <SharedBulkActionBar
      count={count}
      busy={busy}
      onClear={onClear}
      primary={resolve}
      secondary={[reopen, archive, snooze, assign]}
      // Conversations renders the toolbar at the top of the inbox column.
      stickPosition="top"
    />
  );
}
