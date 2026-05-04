// Task #967 — Shared owner-scope picker (canonical front-end primitive).
//
// Sibling to the existing `OwnerFilterSelect` — that one is wired into
// AF / LWQ / Available Loads through their own historical contracts.
// This component is the recommended choice for *new* surfaces (and the
// future migration of Customer Quotes + Conversations) because it speaks
// the canonical wire-protocol grammar in `shared/workflowOs/ownerScope.ts`
// directly, with no per-tab translation layer.
//
// The picker accepts a single token (most ops tabs only need one) and
// renders the canonical base options plus an optional flat list of
// per-team / per-user options. It deliberately avoids a free-form
// combobox so the option set stays surveyable — picker UIs that grow
// to thousands of names are how surfaces drift out of conformance.

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
  CANONICAL_OWNER_SCOPE_OPTIONS,
  ownerScopeBaseLabel,
  type OwnerScopeSurface,
  type OwnerScopeToken,
} from "@shared/workflowOs/ownerScope";

export interface OwnerScopePickerUser {
  id: string;
  label: string;
}

export interface OwnerScopePickerTeam {
  id: string;
  label: string;
}

export interface OwnerScopePickerProps {
  value: OwnerScopeToken;
  onChange: (next: OwnerScopeToken) => void;
  surface: OwnerScopeSurface;
  /** Optional team list. Empty = no Teams group. */
  teams?: ReadonlyArray<OwnerScopePickerTeam>;
  /** Optional specific-user list. Empty = no Users group. */
  users?: ReadonlyArray<OwnerScopePickerUser>;
  className?: string;
  disabled?: boolean;
  testId?: string;
}

export function OwnerScopePicker({
  value,
  onChange,
  surface,
  teams,
  users,
  className,
  disabled,
  testId,
}: OwnerScopePickerProps): JSX.Element {
  const triggerTestId = testId ?? "select-owner-scope";
  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v as OwnerScopeToken)} disabled={disabled}>
      <SelectTrigger
        className={"h-8 text-xs " + (className ?? "")}
        data-testid={triggerTestId}
      >
        <SelectValue placeholder="All owners" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Scope
          </SelectLabel>
          {CANONICAL_OWNER_SCOPE_OPTIONS.map((opt) => (
            <SelectItem
              key={opt.token}
              value={opt.token}
              data-testid={opt.testId}
            >
              {ownerScopeBaseLabel(opt.labelKey, surface)}
            </SelectItem>
          ))}
        </SelectGroup>

        {teams && teams.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Teams
              </SelectLabel>
              {teams.map((t) => (
                <SelectItem
                  key={`team:${t.id}`}
                  value={`team:${t.id}`}
                  data-testid={`owner-scope-team-${t.id}`}
                >
                  {t.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}

        {users && users.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Specific user
              </SelectLabel>
              {users.map((u) => (
                <SelectItem
                  key={u.id}
                  value={u.id}
                  data-testid={`owner-scope-user-${u.id}`}
                >
                  {u.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}
