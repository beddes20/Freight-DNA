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
import { Check, Archive, Inbox, UserPlus, X, ChevronDown } from "lucide-react";
import { SnoozePopover } from "./snooze-popover";

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

  if (count === 0) return null;

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 border-b bg-primary/5 sticky top-0 z-10"
      data-testid="bulk-action-bar"
    >
      <span className="text-sm font-medium" data-testid="text-bulk-count">
        {count} selected
      </span>
      <div className="h-4 w-px bg-border mx-1" />
      <Button
        size="sm"
        variant="outline"
        className="h-8 text-xs gap-1"
        onClick={onResolve}
        disabled={busy}
        data-testid="button-bulk-resolve"
      >
        <Check className="w-3 h-3" />
        Resolve
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-8 text-xs gap-1"
        onClick={onReopen}
        disabled={busy}
        data-testid="button-bulk-reopen"
      >
        <Inbox className="w-3 h-3" />
        Reopen
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-8 text-xs gap-1"
        onClick={onArchive}
        disabled={busy}
        data-testid="button-bulk-archive"
      >
        <Archive className="w-3 h-3" />
        Archive
      </Button>
      <SnoozePopover
        onSnooze={onSnooze}
        disabled={busy}
        testId="button-bulk-snooze"
      />
      <DropdownMenu open={assignOpen} onOpenChange={setAssignOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1"
            disabled={busy}
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
          {reps.map(r => (
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
      <div className="flex-1" />
      <Button
        size="sm"
        variant="ghost"
        className="h-8 text-xs gap-1"
        onClick={onClear}
        disabled={busy}
        data-testid="button-bulk-clear"
      >
        <X className="w-3 h-3" />
        Clear
      </Button>
    </div>
  );
}
