// Task #1109 — Banner above the profile shell for companies that were
// auto-created by the inbound-email pipeline (`is_email_derived=true`).
// Per-session dismiss only; informational — no destructive actions.

import { useState, useEffect } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  companyId: string;
  companyName: string;
}

const SESSION_KEY_PREFIX = "profile-email-derived-dismissed:";

export function EmailDerivedBanner({ companyId, companyName }: Props) {
  const sessionKey = `${SESSION_KEY_PREFIX}${companyId}`;
  const [dismissed, setDismissed] = useState<boolean>(false);

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(sessionKey) === "1");
    } catch {
      setDismissed(false);
    }
  }, [sessionKey]);

  if (dismissed) return null;

  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 px-4 py-3"
      data-testid="banner-email-derived-company"
      role="status"
    >
      <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-amber-800 dark:text-amber-300" data-testid="text-email-derived-title">
          Unverified — derived from inbound email
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
          <span data-testid="text-email-derived-company-name">{companyName}</span> was auto-created from an inbound email and has not been verified by a rep. Confirm the contacts, financials, and lanes before treating any data here as authoritative.
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 h-7 w-7 p-0 text-amber-700 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-200"
        onClick={() => {
          try { sessionStorage.setItem(sessionKey, "1"); } catch { /* ignore */ }
          setDismissed(true);
        }}
        aria-label="Dismiss banner for this session"
        data-testid="button-dismiss-email-derived-banner"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
