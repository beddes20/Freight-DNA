// Shortcut-target registry — pages register a callback for a key
// (e.g. "lwq.focusFirstRow"); invocations queue until registered.

type Cb = () => void;

const _targets = new Map<string, Cb>();
const _pending = new Set<string>();

function safeInvoke(key: string, cb: Cb): void {
  try {
    cb();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[shortcutTargets] callback for "${key}" threw`, err);
  }
}

export function registerShortcutTarget(key: string, cb: Cb): () => void {
  _targets.set(key, cb);
  if (_pending.has(key)) {
    _pending.delete(key);
    safeInvoke(key, cb);
  }
  return () => {
    if (_targets.get(key) === cb) _targets.delete(key);
  };
}

export function invokeShortcutTarget(key: string): boolean {
  const cb = _targets.get(key);
  if (cb) {
    safeInvoke(key, cb);
    return true;
  }
  _pending.add(key);
  return false;
}

export function hasPendingShortcutInvocation(key: string): boolean {
  return _pending.has(key);
}

/** Drop a queued invocation without firing it (e.g. app navigates away). */
export function consumePendingShortcutInvocation(key: string): boolean {
  return _pending.delete(key);
}

/** Test-only reset. */
export function _resetShortcutTargetsForTests(): void {
  _targets.clear();
  _pending.clear();
}
