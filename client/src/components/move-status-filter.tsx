import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type MoveStatus = "realized" | "active" | "available";

export const MOVE_STATUS_LABEL: Record<MoveStatus, string> = {
  realized: "Realized",
  active: "Active",
  available: "Available",
};

const COLOR: Record<MoveStatus, { on: string; off: string }> = {
  realized: {
    on: "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    off: "border-border text-muted-foreground hover:border-emerald-500/50",
  },
  active: {
    on: "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    off: "border-border text-muted-foreground hover:border-amber-500/50",
  },
  available: {
    on: "border-sky-500 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    off: "border-border text-muted-foreground hover:border-sky-500/50",
  },
};

export interface MoveStatusFilterProps {
  value: MoveStatus[];
  onChange: (next: MoveStatus[]) => void;
  /** Locks specific buckets ON (e.g. always-Available on the Available board). */
  lockedOn?: MoveStatus[];
  /** Hides specific buckets entirely (e.g. Lane Pricing only cares about Realized). */
  hidden?: MoveStatus[];
  className?: string;
  testIdPrefix?: string;
}

/**
 * Shared move-status chip filter used across every Carrier Intelligence
 * surface. Buckets map directly to the load_fact bucket / scorecard splits:
 *   realized  = executed loads (loads, revenue, margin, on-time)
 *   active    = in-flight (picked up, not yet delivered)
 *   available = open opportunities not yet covered
 *
 * Default selection: Realized + Active (Available is opt-in) so dashboards
 * show the org's executed truth without bleeding open opportunities into
 * margin math.
 */
export function MoveStatusFilter({
  value,
  onChange,
  lockedOn = [],
  hidden = [],
  className,
  testIdPrefix = "chip-move-status",
}: MoveStatusFilterProps) {
  const all: MoveStatus[] = ["realized", "active", "available"];
  const visible = all.filter((s) => !hidden.includes(s));

  const toggle = (s: MoveStatus) => {
    if (lockedOn.includes(s)) return;
    const set = new Set(value);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    onChange(visible.filter((v) => set.has(v) || lockedOn.includes(v)));
  };

  return (
    <div
      className={cn("inline-flex flex-wrap items-center gap-2", className)}
      role="group"
      aria-label="Move status filter"
      data-testid="move-status-filter"
    >
      <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">
        Move Status
      </span>
      {visible.map((s) => {
        const on = value.includes(s) || lockedOn.includes(s);
        const locked = lockedOn.includes(s);
        return (
          <button
            key={s}
            type="button"
            onClick={() => toggle(s)}
            disabled={locked}
            aria-pressed={on}
            data-testid={`${testIdPrefix}-${s}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              on ? COLOR[s].on : COLOR[s].off,
              locked && "opacity-90 cursor-default",
            )}
          >
            {on && <Check className="h-3 w-3" />}
            {MOVE_STATUS_LABEL[s]}
          </button>
        );
      })}
    </div>
  );
}

/** Convenience helper used by every page when summing scorecard rows. */
export function sumByMoveStatus(
  row: { loads?: number | null; activeLoads?: number | null; availableLoads?: number | null },
  selected: MoveStatus[],
): number {
  let n = 0;
  if (selected.includes("realized")) n += Number(row.loads ?? 0);
  if (selected.includes("active")) n += Number(row.activeLoads ?? 0);
  if (selected.includes("available")) n += Number(row.availableLoads ?? 0);
  return n;
}
