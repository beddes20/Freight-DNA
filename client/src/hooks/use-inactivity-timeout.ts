import { useState, useEffect, useRef, useCallback } from "react";

const INACTIVE_MS = 2 * 60 * 60 * 1000;
const WARNING_MS = 5 * 60 * 1000;
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"] as const;

export function useInactivityTimeout(onTimeout: () => void) {
  const [warningVisible, setWarningVisible] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const clearAll = useCallback(() => {
    if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }, []);

  const resetTimers = useCallback(() => {
    clearAll();
    setWarningVisible(false);

    warningTimerRef.current = setTimeout(() => {
      setWarningVisible(true);
      setSecondsLeft(Math.round(WARNING_MS / 1000));
      countdownRef.current = setInterval(() => {
        setSecondsLeft(prev => Math.max(0, prev - 1));
      }, 1000);
    }, INACTIVE_MS - WARNING_MS);

    logoutTimerRef.current = setTimeout(() => {
      onTimeoutRef.current();
    }, INACTIVE_MS);
  }, [clearAll]);

  useEffect(() => {
    const handler = () => {
      if (!warningVisible) resetTimers();
    };
    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, handler, { passive: true }));
    resetTimers();
    return () => {
      ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, handler));
      clearAll();
    };
  }, [resetTimers, clearAll, warningVisible]);

  const staySignedIn = useCallback(() => {
    resetTimers();
  }, [resetTimers]);

  return { warningVisible, secondsLeft, staySignedIn };
}
