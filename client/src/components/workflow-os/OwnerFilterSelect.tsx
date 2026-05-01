// Workflow OS — shared Owner filter dropdown.
//
// One control across Available Freight, Lane Work Queue, and Available
// Loads. Same options, same predicate, same copy (only the "My …" label
// differs per surface). See docs/workflow-os-spec.md sections A & B and
// ADR-001.

import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type OwnerFilterValue,
  type WorkflowOsUser,
  isRepLikeRole,
} from "@shared/workflowOs/ownership";

export type WorkflowOsSurface = "af" | "lwq" | "available_loads";

const MINE_LABEL: Record<WorkflowOsSurface, string> = {
  af: "My freight",
  lwq: "My lanes",
  available_loads: "My loads",
};

/**
 * Canonical base options shown in the dropdown above the per-user
 * "Specific user…" group. Exported so tests (and any future migration
 * helpers) can assert the exact contract without rendering React.
 * Order matches what the user sees top-to-bottom.
 */
export const OWNER_FILTER_BASE_OPTIONS = [
  { value: "all",        testId: "owner-option-all",        labelKey: "all" as const        },
  { value: "me",         testId: "owner-option-me",         labelKey: "me" as const         },
  { value: "am_book",    testId: "owner-option-am-book",    labelKey: "am_book" as const    },
  { value: "unassigned", testId: "owner-option-unassigned", labelKey: "unassigned" as const },
] as const;

export type OwnerFilterBaseOption = (typeof OWNER_FILTER_BASE_OPTIONS)[number];

/**
 * Surface-aware label resolver for the canonical base options.
 * `me` is the only label that depends on surface (My freight / My lanes
 * / My loads); the rest are stable.
 */
export function ownerFilterBaseLabel(
  labelKey: OwnerFilterBaseOption["labelKey"],
  surface: WorkflowOsSurface,
): string {
  switch (labelKey) {
    case "all":        return "All owners";
    case "me":         return MINE_LABEL[surface];
    case "am_book":    return "My AM's book";
    case "unassigned": return "Unassigned";
  }
}

interface OwnerFilterSelectProps {
  value: OwnerFilterValue;
  onChange: (next: OwnerFilterValue) => void;
  orgUsers: ReadonlyArray<WorkflowOsUser>;
  currentUser: WorkflowOsUser | null | undefined;
  surface: WorkflowOsSurface;
  className?: string;
  disabled?: boolean;
}

// We collapse the structured `{ specificUserId }` value into a flat
// string for the underlying <Select>; the wrapper deserializes back.
const SPECIFIC_PREFIX = "specific:";

export function ownerValueToString(v: OwnerFilterValue): string {
  if (typeof v === "string") return v;
  return `${SPECIFIC_PREFIX}${v.specificUserId}`;
}

export function ownerValueFromString(s: string): OwnerFilterValue {
  if (s === "all" || s === "me" || s === "am_book" || s === "unassigned") return s;
  if (s.startsWith(SPECIFIC_PREFIX)) {
    return { specificUserId: s.slice(SPECIFIC_PREFIX.length) };
  }
  return "all";
}

function displayName(u: WorkflowOsUser): string {
  return u.name?.trim() || u.username?.trim() || u.email?.trim() || u.id;
}

export function OwnerFilterSelect({
  value,
  onChange,
  orgUsers,
  currentUser,
  surface,
  className,
  disabled,
}: OwnerFilterSelectProps) {
  const repList = useMemo(() => {
    // Spec: "Specific user…" is canonical rep-ish only — no admin /
    // director / non-rep injection, even when the current viewer
    // happens to be one. Non-rep viewers see the four base options
    // and the alphabetical rep list, which is intentional.
    const reps = orgUsers.filter((u) => isRepLikeRole(u.role));
    reps.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    if (currentUser) {
      const meIdx = reps.findIndex((u) => u.id === currentUser.id);
      if (meIdx > 0) {
        const [me] = reps.splice(meIdx, 1);
        reps.unshift(me);
      }
    }
    return reps;
  }, [orgUsers, currentUser]);

  return (
    <Select
      value={ownerValueToString(value)}
      onValueChange={(s) => onChange(ownerValueFromString(s))}
      disabled={disabled}
    >
      <SelectTrigger
        className={className}
        data-testid="select-owner-filter"
        aria-label="Owner filter"
      >
        <SelectValue placeholder="All owners" />
      </SelectTrigger>
      <SelectContent>
        {OWNER_FILTER_BASE_OPTIONS.map((opt) => (
          <SelectItem
            key={opt.value}
            value={opt.value}
            data-testid={opt.testId}
          >
            {ownerFilterBaseLabel(opt.labelKey, surface)}
          </SelectItem>
        ))}
        {repList.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel className="text-xs uppercase tracking-wider text-muted-foreground">
                Specific user…
              </SelectLabel>
              {repList.map((u) => {
                const isMe = currentUser?.id === u.id;
                return (
                  <SelectItem
                    key={u.id}
                    value={`${SPECIFIC_PREFIX}${u.id}`}
                    data-testid={`owner-option-user-${u.id}`}
                  >
                    {displayName(u)}
                    {isMe ? " (me)" : ""}
                  </SelectItem>
                );
              })}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}
