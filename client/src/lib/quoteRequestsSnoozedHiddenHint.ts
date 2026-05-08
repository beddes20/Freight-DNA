export type SnoozedHiddenHintInputs = {
  includeSnoozed: boolean;
  snoozedHidden: number | null | undefined;
};

export function shouldShowSnoozedHiddenHint(
  inputs: SnoozedHiddenHintInputs,
): boolean {
  if (inputs.includeSnoozed) return false;
  const n = inputs.snoozedHidden;
  return typeof n === "number" && n > 0;
}
