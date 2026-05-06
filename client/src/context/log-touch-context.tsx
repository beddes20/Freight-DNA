import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";

interface LogTouchContextValue {
  open: boolean;
  prefillCompanyId: string | null;
  prefillCompanyName: string | null;
  openDialog: (opts?: { companyId?: string; companyName?: string }) => void;
  closeDialog: () => void;
}

const LogTouchContext = createContext<LogTouchContextValue | null>(null);

export function LogTouchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [prefillCompanyId, setPrefillCompanyId] = useState<string | null>(null);
  const [prefillCompanyName, setPrefillCompanyName] = useState<string | null>(null);

  const openDialog = useCallback((opts?: { companyId?: string; companyName?: string }) => {
    setPrefillCompanyId(opts?.companyId ?? null);
    setPrefillCompanyName(opts?.companyName ?? null);
    setOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setOpen(false);
    setPrefillCompanyId(null);
    setPrefillCompanyName(null);
  }, []);

  return (
    <LogTouchContext.Provider value={{ open, prefillCompanyId, prefillCompanyName, openDialog, closeDialog }}>
      {children}
    </LogTouchContext.Provider>
  );
}

export function useLogTouch() {
  const ctx = useContext(LogTouchContext);
  if (!ctx) throw new Error("useLogTouch must be used within LogTouchProvider");
  return ctx;
}
