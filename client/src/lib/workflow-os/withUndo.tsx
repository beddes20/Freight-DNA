// Selection-cleared Undo helper for bulk actions: runs `perform`,
// clears selection on success, and surfaces an 8s "Undo" toast that
// replays `invert` once.

import { ToastAction } from "@/components/ui/toast";
import type { useToast } from "@/hooks/use-toast";

export interface RunWithUndoArgs<TParams, TResult> {
  perform: (params: TParams) => Promise<TResult>;
  /** Inverse mutation; omit for terminal actions (e.g. permanent dismiss). */
  invert?: (result: TResult, params: TParams) => Promise<unknown>;
  /** Toast title shown after the forward mutation succeeds. */
  toastTitle: string;
  /** Optional secondary line under the title (e.g. "5 lanes reassigned to Sara"). */
  toastDescription?: string;
  /** Toast duration; defaults to 8 000 ms (the spec's bulk-action Undo window). */
  durationMs?: number;
  /** Toast surface — pass `useToast().toast` from the calling component. */
  toast: ReturnType<typeof useToast>["toast"];
  /** Called once on the success path so the surface can clear its row selection. */
  clearSelection?: () => void;
  /**
   * Optional. If supplied, the helper captures the selection BEFORE
   * `clearSelection` runs and replays it through `restoreSelection`
   * when the rep clicks Undo. Surfaces use this to put the rep right
   * back where they were if they regret a bulk action — clearing on
   * success is the spec, but Undo is supposed to be fully reversible,
   * including the visible selection state.
   */
  captureSelection?: () => ReadonlyArray<string>;
  restoreSelection?: (ids: ReadonlyArray<string>) => void;
  /** Toast title shown if the user fires Undo and it succeeds. */
  undoSuccessTitle?: string;
  /** Toast title shown if the Undo replay throws. */
  undoFailureTitle?: string;
}

export async function runWithUndo<TParams, TResult>(
  args: RunWithUndoArgs<TParams, TResult>,
  params: TParams,
): Promise<TResult> {
  // Snapshot the prior selection BEFORE we clear it so Undo can put the
  // rep back where they were. Captured eagerly so a slow `perform` can't
  // race a user-initiated selection change.
  const priorSelection = args.captureSelection ? args.captureSelection() : null;
  const result = await args.perform(params);
  args.clearSelection?.();

  let undone = false;
  args.toast({
    title: args.toastTitle,
    description: args.toastDescription,
    duration: args.durationMs ?? 8_000,
    action: args.invert ? (
      <ToastAction
        altText="Undo"
        data-testid="toast-action-undo"
        onClick={async () => {
          if (undone) return;
          undone = true;
          try {
            await args.invert!(result, params);
            // Replay the prior selection so the rep can re-pick a
            // different action without reselecting their rows.
            if (priorSelection && args.restoreSelection) {
              args.restoreSelection(priorSelection);
            }
            args.toast({
              title: args.undoSuccessTitle ?? "Undone",
              duration: 4_000,
            });
          } catch (err) {
            args.toast({
              title: args.undoFailureTitle ?? "Undo failed",
              description: (err as { message?: string })?.message ?? undefined,
              variant: "destructive",
              duration: 5_000,
            });
          }
        }}
      >
        Undo
      </ToastAction>
    ) : undefined,
  });

  return result;
}
