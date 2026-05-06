// Unit tests for the selection-cleared Undo helper.

import { describe, it, expect, vi } from "vitest";

// Stub ToastAction so the helper's JSX expands to a plain shape we can
// introspect — onClick lives on `props`.
type StubbedToastAction = {
  type: "ToastAction";
  props: { onClick?: () => void | Promise<void> } & Record<string, unknown>;
};

vi.mock("@/components/ui/toast", () => ({
  ToastAction: (props: Record<string, unknown>): StubbedToastAction => ({
    type: "ToastAction",
    props: props as StubbedToastAction["props"],
  }),
}));

const { runWithUndo } = await import("@/lib/workflow-os/withUndo");

type ToastArg = {
  title: string;
  description?: string;
  duration?: number;
  action?: StubbedToastAction;
  variant?: string;
};

function makeToastSpy() {
  const calls: ToastArg[] = [];
  const toast = vi.fn((arg: ToastArg) => {
    calls.push(arg);
    return { id: String(calls.length), dismiss: () => undefined, update: () => undefined };
  });
  return { toast, calls };
}

function actionOnClick(arg: ToastArg): (() => void | Promise<void>) | undefined {
  return arg.action?.props?.onClick;
}

describe("runWithUndo", () => {
  it("runs perform and clears selection on success", async () => {
    const { toast, calls } = makeToastSpy();
    const clearSelection = vi.fn();
    const perform = vi.fn(async () => ({ ok: true }));

    const r = await runWithUndo(
      {
        perform,
        toastTitle: "Done",
        toast,
        clearSelection,
      },
      { x: 1 },
    );
    expect(r).toEqual({ ok: true });
    expect(perform).toHaveBeenCalledWith({ x: 1 });
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(calls[0].title).toBe("Done");
    // No invert provided → no action prop.
    expect(calls[0].action).toBeUndefined();
  });

  it("invokes invert exactly once when Undo is clicked twice", async () => {
    const { toast, calls } = makeToastSpy();
    const invert = vi.fn(async () => undefined);

    await runWithUndo(
      {
        perform: async () => ({ id: "result-1" }),
        invert,
        toastTitle: "Reassigned",
        toast,
      },
      { x: 1 },
    );
    const onClick = actionOnClick(calls[0]);
    expect(onClick).toBeTypeOf("function");
    await onClick!();
    await onClick!(); // second click should be ignored
    expect(invert).toHaveBeenCalledTimes(1);
    expect(invert).toHaveBeenCalledWith({ id: "result-1" }, { x: 1 });
  });

  it("restores prior selection when Undo succeeds", async () => {
    const { toast, calls } = makeToastSpy();
    const captureSelection = vi.fn(() => ["L1", "L2", "L3"] as ReadonlyArray<string>);
    const restoreSelection = vi.fn();
    const clearSelection = vi.fn();

    await runWithUndo(
      {
        perform: async () => undefined,
        invert: async () => undefined,
        toastTitle: "Reassigned",
        toast,
        captureSelection,
        restoreSelection,
        clearSelection,
      },
      {},
    );

    expect(captureSelection).toHaveBeenCalledTimes(1);
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(restoreSelection).not.toHaveBeenCalled();

    const onClick = actionOnClick(calls[0]);
    await onClick!();
    expect(restoreSelection).toHaveBeenCalledTimes(1);
    expect(restoreSelection).toHaveBeenCalledWith(["L1", "L2", "L3"]);
  });

  it("does NOT restore selection when Undo throws", async () => {
    const { toast, calls } = makeToastSpy();
    const captureSelection = vi.fn(() => ["L1"] as ReadonlyArray<string>);
    const restoreSelection = vi.fn();

    await runWithUndo(
      {
        perform: async () => undefined,
        invert: async () => {
          throw new Error("nope");
        },
        toastTitle: "Reassigned",
        toast,
        captureSelection,
        restoreSelection,
      },
      {},
    );
    const onClick = actionOnClick(calls[0]);
    await onClick!();
    expect(restoreSelection).not.toHaveBeenCalled();
    // A second toast was emitted reporting the failure.
    expect(calls.length).toBe(2);
    expect(calls[1].variant).toBe("destructive");
  });

  it("captures selection BEFORE perform runs (prevents racing user changes)", async () => {
    const { toast } = makeToastSpy();
    let snapshot: ReadonlyArray<string> | null = null;
    const captureSelection = vi.fn(() => {
      snapshot = ["A", "B"];
      return snapshot;
    });
    const restoreSelection = vi.fn();
    const performStartedAt: { capturedFirst: boolean } = { capturedFirst: false };

    await runWithUndo(
      {
        perform: async () => {
          // By the time perform runs, captureSelection must have already
          // executed. This proves the helper snapshots BEFORE clearing.
          performStartedAt.capturedFirst = captureSelection.mock.calls.length === 1;
          return undefined;
        },
        invert: async () => undefined,
        toastTitle: "x",
        toast,
        captureSelection,
        restoreSelection,
      },
      {},
    );
    expect(performStartedAt.capturedFirst).toBe(true);
  });

  it("uses an 8-second toast duration by default", async () => {
    const { toast, calls } = makeToastSpy();
    await runWithUndo(
      {
        perform: async () => undefined,
        invert: async () => undefined,
        toastTitle: "x",
        toast,
      },
      {},
    );
    expect(calls[0].duration).toBe(8_000);
  });
});
