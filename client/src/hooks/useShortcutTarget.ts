// Task #970 — React hook companion to `lib/shortcutTargets`.
//
// Pages that want to receive a queued shortcut invocation (e.g. the LWQ
// "focus first row" target fired from a different page's Shift+L
// handler) call this hook on mount. The hook keeps the latest callback
// reference fresh without re-registering on every render.

import { useEffect, useRef } from "react";
import { registerShortcutTarget } from "@/lib/shortcutTargets";

export function useShortcutTarget(key: string, cb: () => void): void {
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  }, [cb]);

  useEffect(() => {
    return registerShortcutTarget(key, () => cbRef.current());
  }, [key]);
}
