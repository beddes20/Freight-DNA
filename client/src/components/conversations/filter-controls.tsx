import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  Bookmark,
  Calendar as CalendarIcon,
  ChevronDown,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { RepFilterCombobox } from "./rep-filter-combobox";
import type { ConversationBucket, ConversationGroupBy } from "./types";

// ─── Date popover ──────────────────────────────────────────────────────────
// Single button that surfaces the active date range as its label and opens
// a popover with From/To inputs, presets, and a Clear control. Replaces the
// old four-control date strip so the bar can stay one line tall.
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDateLabel(iso: string): string {
  // iso is yyyy-mm-dd from <input type=date>; parse as local to avoid TZ slips.
  const [yStr, mStr, dStr] = iso.split("-");
  const y = Number(yStr), m = Number(mStr) - 1, d = Number(dStr);
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return iso;
  return `${MONTHS_SHORT[m]} ${d}, ${y}`;
}

export function describeDateRange(dateFrom: string, dateTo: string): string {
  if (!dateFrom && !dateTo) return "Date";
  if (dateFrom && dateTo) {
    if (dateFrom === dateTo) return formatDateLabel(dateFrom);
    const [yFrom, mFrom, dFrom] = dateFrom.split("-");
    const [yTo, mTo, dTo] = dateTo.split("-");
    if (yFrom === yTo) {
      const fromShort = `${MONTHS_SHORT[Number(mFrom) - 1]} ${Number(dFrom)}`;
      const toShort = `${MONTHS_SHORT[Number(mTo) - 1]} ${Number(dTo)}, ${yTo}`;
      return `${fromShort} – ${toShort}`;
    }
    return `${formatDateLabel(dateFrom)} – ${formatDateLabel(dateTo)}`;
  }
  if (dateFrom) return `From ${formatDateLabel(dateFrom)}`;
  return `Until ${formatDateLabel(dateTo)}`;
}

interface DatePopoverProps {
  dateFrom: string;
  dateTo: string;
  onChangeFrom: (v: string) => void;
  onChangeTo: (v: string) => void;
  onApplyPreset: (preset: "today" | "last7" | "last30" | "thisMonth") => void;
  onClear: () => void;
  isInvalid: boolean;
}

export function DatePopover({
  dateFrom,
  dateTo,
  onChangeFrom,
  onChangeTo,
  onApplyPreset,
  onClear,
  isInvalid,
}: DatePopoverProps) {
  const hasValue = !!(dateFrom || dateTo);
  const label = describeDateRange(dateFrom, dateTo);
  return (
    // Wrapper carries the legacy `date-range-filter` testid so existing
    // tests that scope their queries to "the date range filter region"
    // keep working against the new popover layout.
    <span data-testid="date-range-filter">
      <Popover>
        <PopoverTrigger asChild>
          {/* Legacy `button-date-preset` testid preserved on the trigger:
              it used to open a Quick-range dropdown; it now opens the
              full date popover that includes the same presets. */}
          <Button
            variant={hasValue ? "default" : "outline"}
            size="sm"
            className={cn(
              "h-8 text-xs gap-1.5 font-normal",
              isInvalid && "border-destructive text-destructive",
            )}
            data-testid="button-date-preset"
            aria-invalid={isInvalid}
          >
            <CalendarIcon className="w-3 h-3" />
            <span className="truncate max-w-[180px]">{label}</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </Button>
        </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">Quick range</Label>
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onApplyPreset("today")}
                data-testid="option-date-preset-today"
              >
                Today
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onApplyPreset("last7")}
                data-testid="option-date-preset-last7"
              >
                Last 7 days
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onApplyPreset("last30")}
                data-testid="option-date-preset-last30"
              >
                Last 30 days
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onApplyPreset("thisMonth")}
                data-testid="option-date-preset-this-month"
              >
                This month
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="input-date-from" className="text-xs text-muted-foreground">From</Label>
            <Input
              id="input-date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => onChangeFrom(e.target.value)}
              max={dateTo || undefined}
              className={cn(
                "h-8 text-xs",
                isInvalid && "border-destructive focus-visible:ring-destructive",
              )}
              data-testid="input-date-from"
              aria-invalid={isInvalid}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="input-date-to" className="text-xs text-muted-foreground">To</Label>
            <Input
              id="input-date-to"
              type="date"
              value={dateTo}
              onChange={(e) => onChangeTo(e.target.value)}
              min={dateFrom || undefined}
              className={cn(
                "h-8 text-xs",
                isInvalid && "border-destructive focus-visible:ring-destructive",
              )}
              data-testid="input-date-to"
              aria-invalid={isInvalid}
            />
          </div>
          {isInvalid && (
            <p
              className="text-xs text-destructive"
              role="alert"
              data-testid="text-date-range-error"
            >
              "From" must be on or before "To".
            </p>
          )}
          <div className="flex items-center justify-end pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={onClear}
              disabled={!hasValue}
              data-testid="button-clear-date-range"
            >
              <X className="w-3 h-3 mr-1" />
              Clear dates
            </Button>
          </div>
        </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

// ─── Filters popover ───────────────────────────────────────────────────────
// Houses everything that *isn't* the headline (Audience, bucket, Date) — so
// the bar stays compact and scannable. Shows a count badge with the number
// of non-default selections inside.
interface Rep { id: string; fullName: string; email: string }

interface FiltersPopoverProps {
  bucket: ConversationBucket;
  groupBy: ConversationGroupBy;
  setGroupBy: (v: ConversationGroupBy) => void;
  filterState: string;
  setFilterState: (v: string) => void;
  filterPriority: string;
  setFilterPriority: (v: string) => void;
  filterOverdue: boolean;
  setFilterOverdue: (v: boolean) => void;
  filterRep: string;
  setFilterRep: (v: string) => void;
  reps: Rep[];
}

function countActiveFilters(p: FiltersPopoverProps): number {
  let n = 0;
  if (p.groupBy !== "none") n++;
  if (p.bucket !== "mine" && p.bucket !== "unowned" && p.filterRep !== "all") n++;
  if (p.bucket === "all") {
    if (p.filterState !== "all") n++;
    if (p.filterPriority !== "all") n++;
    if (p.filterOverdue) n++;
  }
  return n;
}

export function FiltersPopover(props: FiltersPopoverProps) {
  const [open, setOpen] = useState(false);
  const activeCount = countActiveFilters(props);
  const repFilterShown = props.bucket !== "mine" && props.bucket !== "unowned";
  const allBucket = props.bucket === "all";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={activeCount > 0 ? "default" : "outline"}
          size="sm"
          className="h-8 text-xs gap-1.5 font-normal"
          data-testid="button-filters-popover"
        >
          <SlidersHorizontal className="w-3 h-3" />
          Filters
          {activeCount > 0 && (
            <Badge
              variant="secondary"
              className="ml-0.5 h-4 px-1.5 text-[10px] bg-background/30 text-primary-foreground border-transparent"
              data-testid="badge-filters-count"
            >
              {activeCount}
            </Badge>
          )}
          <ChevronDown className="w-3 h-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Group by</Label>
            <Select
              value={props.groupBy}
              onValueChange={(v) => props.setGroupBy(v as ConversationGroupBy)}
            >
              <SelectTrigger className="h-8 text-xs" data-testid="select-group-by">
                <SelectValue placeholder="Group by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" data-testid="option-group-by-none">No grouping</SelectItem>
                <SelectItem value="account" data-testid="option-group-by-account">Group by account</SelectItem>
                <SelectItem value="carrier" data-testid="option-group-by-carrier">Group by carrier</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {repFilterShown && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Owner</Label>
              <RepFilterCombobox
                value={props.filterRep}
                onChange={props.setFilterRep}
                users={props.reps}
              />
            </div>
          )}

          {allBucket && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Waiting state</Label>
                <Select value={props.filterState} onValueChange={props.setFilterState}>
                  <SelectTrigger className="h-8 text-xs" data-testid="select-filter-state">
                    <SelectValue placeholder="Waiting state" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All states</SelectItem>
                    <SelectItem value="waiting_on_us">Waiting on us</SelectItem>
                    <SelectItem value="waiting_on_them">Waiting on them</SelectItem>
                    <SelectItem value="resolved">Resolved</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Priority</Label>
                <Select value={props.filterPriority} onValueChange={props.setFilterPriority}>
                  <SelectTrigger className="h-8 text-xs" data-testid="select-filter-priority">
                    <SelectValue placeholder="Priority" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All priorities</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="switch-filter-overdue" className="text-xs flex items-center gap-1.5 cursor-pointer">
                  <AlertTriangle className="w-3 h-3 text-amber-600" />
                  Overdue only
                </Label>
                <Switch
                  id="switch-filter-overdue"
                  checked={props.filterOverdue}
                  onCheckedChange={props.setFilterOverdue}
                  data-testid="button-filter-overdue"
                />
              </div>
            </>
          )}

          {activeCount > 0 && (
            <div className="flex items-center justify-end pt-1 border-t">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  props.setGroupBy("none");
                  props.setFilterState("all");
                  props.setFilterPriority("all");
                  props.setFilterOverdue(false);
                  props.setFilterRep("all");
                }}
                data-testid="button-filters-clear-all"
              >
                <X className="w-3 h-3 mr-1" />
                Clear filters
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Active-filter chip row ────────────────────────────────────────────────
// Renders a one-line summary of every active filter as dismissible chips so
// reps can see at a glance what's narrowing the list. The "Save as view"
// affordance lives on the same row instead of consuming its own bar.
interface ActiveFilterChipsProps {
  bucket: ConversationBucket;
  groupBy: ConversationGroupBy;
  setGroupBy: (v: ConversationGroupBy) => void;
  filterState: string;
  setFilterState: (v: string) => void;
  filterPriority: string;
  setFilterPriority: (v: string) => void;
  filterOverdue: boolean;
  setFilterOverdue: (v: boolean) => void;
  filterRep: string;
  setFilterRep: (v: string) => void;
  reps: Rep[];
  dateFrom: string;
  dateTo: string;
  isDateRangeInvalid: boolean;
  onClearDate: () => void;
  archiveSearch: string;
  onClearArchiveSearch: () => void;
  showSaveAsView: boolean;
  onSaveAsView: () => void;
}

const STATE_LABELS: Record<string, string> = {
  waiting_on_us: "Waiting on us",
  waiting_on_them: "Waiting on them",
  resolved: "Resolved",
};

const PRIORITY_LABELS: Record<string, string> = {
  high: "High priority",
  normal: "Normal priority",
  low: "Low priority",
};

function Chip({
  label,
  onClear,
  testId,
}: {
  label: React.ReactNode;
  onClear: () => void;
  testId: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-primary/10 text-primary text-xs"
      data-testid={testId}
    >
      <span className="truncate max-w-[180px]">{label}</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-4 w-4 hover:bg-primary/20 rounded-full"
        onClick={onClear}
        data-testid={`${testId}-clear`}
        aria-label="Remove filter"
      >
        <X className="w-3 h-3" />
      </Button>
    </span>
  );
}

export function ActiveFilterChips(props: ActiveFilterChipsProps) {
  const chips: React.ReactNode[] = [];

  if (props.groupBy !== "none") {
    chips.push(
      <Chip
        key="groupBy"
        testId="chip-group-by"
        label={props.groupBy === "account" ? "Grouped by account" : "Grouped by carrier"}
        onClear={() => props.setGroupBy("none")}
      />,
    );
  }

  if (
    props.bucket !== "mine" &&
    props.bucket !== "unowned" &&
    props.filterRep !== "all"
  ) {
    const repLabel =
      props.filterRep === "unassigned"
        ? "Unassigned"
        : props.reps.find(r => r.id === props.filterRep)?.fullName ?? "Owner";
    chips.push(
      <Chip
        key="rep"
        testId="chip-rep"
        label={`Owner: ${repLabel}`}
        onClear={() => props.setFilterRep("all")}
      />,
    );
  }

  if (props.bucket === "all") {
    if (props.filterState !== "all") {
      chips.push(
        <Chip
          key="state"
          testId="chip-state"
          label={STATE_LABELS[props.filterState] ?? props.filterState}
          onClear={() => props.setFilterState("all")}
        />,
      );
    }
    if (props.filterPriority !== "all") {
      chips.push(
        <Chip
          key="priority"
          testId="chip-priority"
          label={PRIORITY_LABELS[props.filterPriority] ?? props.filterPriority}
          onClear={() => props.setFilterPriority("all")}
        />,
      );
    }
    if (props.filterOverdue) {
      chips.push(
        <Chip
          key="overdue"
          testId="chip-overdue"
          label="Overdue only"
          onClear={() => props.setFilterOverdue(false)}
        />,
      );
    }
  }

  if ((props.dateFrom || props.dateTo) && !props.isDateRangeInvalid) {
    chips.push(
      <Chip
        key="date"
        testId="chip-date"
        label={describeDateRange(props.dateFrom, props.dateTo)}
        onClear={props.onClearDate}
      />,
    );
  }

  if (props.bucket === "archived" && props.archiveSearch) {
    chips.push(
      <Chip
        key="archiveSearch"
        testId="chip-archive-search"
        label={`Search: "${props.archiveSearch}"`}
        onClear={props.onClearArchiveSearch}
      />,
    );
  }

  if (chips.length === 0 && !props.showSaveAsView) return null;

  return (
    <div
      className="px-3 py-1.5 border-b shrink-0 flex items-center gap-2 flex-wrap bg-background"
      data-testid="active-filter-chips-row"
    >
      {chips}
      <div className="ml-auto flex items-center gap-1">
        {props.showSaveAsView && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1"
            onClick={props.onSaveAsView}
            data-testid="button-open-save-view"
          >
            <Bookmark className="w-3 h-3" />
            Save as view
          </Button>
        )}
      </div>
    </div>
  );
}
