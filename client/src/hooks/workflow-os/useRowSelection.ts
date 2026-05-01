// Workflow OS — shared row-selection hook.
//
// Set<string>-keyed selection state. Surface-agnostic; the surface owns
// the row type and projects rows to a stable `id` string before passing
// them in. See docs/workflow-os-spec.md section C.
//
// This hook intentionally does not couple to React Table or any specific
// list/table library — both AF (custom table) and LWQ (virtualized
// react-window list) need to use it.

import { useCallback, useMemo, useState } from "react";

// Pure state transitions — exported so the contract can be unit-tested
// without booting React. Each helper returns the SAME Set reference when
// no change is needed so the hook doesn't trigger spurious re-renders.

export function toggleSelection(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function setSelected_(
  prev: Set<string>,
  id: string,
  selected: boolean,
): Set<string> {
  const has = prev.has(id);
  if (has === selected) return prev;
  const next = new Set(prev);
  if (selected) next.add(id);
  else next.delete(id);
  return next;
}

export function selectAllVisibleIds(
  prev: Set<string>,
  visible: ReadonlyArray<string>,
): Set<string> {
  const next = new Set(prev);
  for (const id of visible) next.add(id);
  return next;
}

export interface UseRowSelectionResult {
  selectedIds: ReadonlyArray<string>;
  selectedCount: number;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  set: (id: string, selected: boolean) => void;
  selectAllVisible: (visibleIds: ReadonlyArray<string>) => void;
  clear: () => void;
  // Replace the entire selection with the given ids. Useful when restoring
  // from a saved view or a deeplink.
  replace: (ids: ReadonlyArray<string>) => void;
}

export function useRowSelection(initial?: ReadonlyArray<string>): UseRowSelectionResult {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initial ?? []),
  );

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => toggleSelection(prev, id));
  }, []);

  const set = useCallback((id: string, sel: boolean) => {
    setSelected((prev) => setSelected_(prev, id, sel));
  }, []);

  const selectAllVisible = useCallback((visibleIds: ReadonlyArray<string>) => {
    setSelected((prev) => selectAllVisibleIds(prev, visibleIds));
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const replace = useCallback((ids: ReadonlyArray<string>) => {
    setSelected(new Set(ids));
  }, []);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  return {
    selectedIds,
    selectedCount: selected.size,
    isSelected,
    toggle,
    set,
    selectAllVisible,
    clear,
    replace,
  };
}
