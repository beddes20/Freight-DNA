import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { PhoneCall } from "lucide-react";
import { useLogTouch } from "@/context/log-touch-context";
import { queryClient } from "@/lib/queryClient";

function useCompanyPageInfo() {
  const [location] = useLocation();
  const match = location.match(/^\/companies\/([^/]+)/);
  if (!match) return null;
  const companyId = match[1];
  const company = queryClient.getQueryData<{ id: string; name: string }>(["/api/companies", companyId]);
  return { companyId, companyName: company?.name ?? null };
}

function useIsKeyboardOpen() {
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const THRESHOLD = 0.75;

    function checkKeyboard() {
      if (typeof window.visualViewport !== "undefined") {
        const ratio = window.visualViewport!.height / window.screen.height;
        setKeyboardOpen(ratio < THRESHOLD);
      }
    }

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", checkKeyboard);
      return () => vv.removeEventListener("resize", checkKeyboard);
    }
  }, []);

  return keyboardOpen;
}

export function LogTouchFab() {
  const [location] = useLocation();
  const { openDialog } = useLogTouch();
  const companyInfo = useCompanyPageInfo();
  const keyboardOpen = useIsKeyboardOpen();

  const isDashboard = location === "/";

  if (isDashboard || keyboardOpen) return null;

  function handleClick() {
    if (companyInfo?.companyName) {
      openDialog({ companyId: companyInfo.companyId, companyName: companyInfo.companyName });
    } else if (companyInfo?.companyId) {
      openDialog({ companyId: companyInfo.companyId });
    } else {
      openDialog();
    }
  }

  return (
    <button
      data-testid="button-log-touch-fab"
      onClick={handleClick}
      title="Log Touch (Shift+T)"
      aria-label="Log a touch"
      className="fixed bottom-24 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-full shadow-lg bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 transition-all duration-150 text-sm font-medium"
      style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.25)" }}
    >
      <PhoneCall className="h-4 w-4 shrink-0" />
      <span className="hidden sm:inline">Log Touch</span>
    </button>
  );
}

export function useKeyboardShortcut() {
  const { openDialog, open } = useLogTouch();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.shiftKey || e.key !== "T") return;
      const target = e.target as HTMLElement;
      const tag = target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable) return;
      if (open) return;
      openDialog();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [openDialog, open]);
}
