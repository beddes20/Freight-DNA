// Workflow OS — shared Pickup scope dropdown.
//
// "Actionable" is the new platform default (see ADR-002). The dropdown
// is identical across AF, LWQ, and Available Loads; the per-surface
// `ACTIONABLE_OPEN_STATUSES` set defines what counts as "still open"
// for the soft-overdue tier.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type PickupScopeValue,
  isPickupScopeValue,
  DEFAULT_PICKUP_SCOPE,
} from "@shared/workflowOs/actionability";

interface PickupScopeSelectProps {
  value: PickupScopeValue;
  onChange: (next: PickupScopeValue) => void;
  className?: string;
  disabled?: boolean;
}

const OPTIONS: ReadonlyArray<{ value: PickupScopeValue; label: string }> = [
  { value: "actionable", label: "Actionable" },
  { value: "upcoming",   label: "Upcoming only" },
  { value: "recent",     label: "Recent (incl. soft-overdue)" },
  { value: "all",        label: "All (incl. stale)" },
];

export function PickupScopeSelect({
  value,
  onChange,
  className,
  disabled,
}: PickupScopeSelectProps) {
  const v: PickupScopeValue = isPickupScopeValue(value) ? value : DEFAULT_PICKUP_SCOPE;
  return (
    <Select
      value={v}
      onValueChange={(s) => isPickupScopeValue(s) && onChange(s)}
      disabled={disabled}
    >
      <SelectTrigger
        className={className}
        data-testid="select-pickup-scope"
        aria-label="Pickup scope"
      >
        <SelectValue placeholder="Actionable" />
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            data-testid={`pickup-scope-option-${o.value}`}
          >
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export { DEFAULT_PICKUP_SCOPE };
export type { PickupScopeValue };
