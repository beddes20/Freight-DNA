import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, Info, Mail, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";

const COVERAGE_BANNER_ROLES = new Set(["admin", "director", "sales_director"]);

type Severity = "ok" | "info" | "warn" | "error";

type CoverageResponse = {
  severity: Severity;
  reasons: string[];
  eligibleUsers: number;
  enrolledMailboxes: number;
  totalMailboxes: number;
  backfills: { succeeded: number; failed: number; neverRun: number; windowDays: number };
  spotQuotesFromBackfill30d: number;
  mailReadConsent: {
    status: "granted" | "pending" | "denied" | "unknown";
    lastCheckedAt: string | null;
    lastError: string | null;
    configured: boolean;
    mailbox: string | null;
  };
};

const REASON_COPY: Record<string, string> = {
  zero_enrolled: "No mailboxes enrolled — reps' inboxes aren't being read.",
  mail_read_missing: "Mail.Read tenant consent is missing — Outlook ingestion is blocked.",
  mail_read_pending: "Mail.Read consent hasn't been checked yet — enroll a mailbox to verify.",
  backfill_failed: "One or more 30-day mailbox backfills failed.",
  backfill_pending: "Enrolled mailboxes are waiting for their first 30-day backfill.",
};

const STYLES: Record<Severity, { wrap: string; icon: JSX.Element; label: string }> = {
  ok: {
    wrap: "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100",
    icon: <Mail className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />,
    label: "Email coverage healthy",
  },
  info: {
    wrap: "border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-100",
    icon: <Info className="h-4 w-4 text-sky-600 dark:text-sky-400" />,
    label: "Email coverage",
  },
  warn: {
    wrap: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100",
    icon: <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
    label: "Email coverage needs attention",
  },
  error: {
    wrap: "border-red-500/40 bg-red-500/10 text-red-900 dark:text-red-100",
    icon: <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" />,
    label: "Email ingestion blocked",
  },
};

/**
 * Coverage banner shown at the top of Email Intelligence + Customer
 * Quoting tabs. Surfaces three failure modes — zero enrolled, Mail.Read
 * consent missing, failed backfills — so admins (and reps) know when
 * upstream ingestion is dormant rather than silently empty.
 *
 * Stays mounted but hidden when severity === "ok" so rendering is cheap
 * and there's no layout flicker once everything's healthy.
 */
export function EmailCoverageBanner({ className = "" }: { className?: string }): JSX.Element | null {
  const { user } = useAuth();
  const allowed = !!user && COVERAGE_BANNER_ROLES.has(user.role);

  const { data, isLoading } = useQuery<CoverageResponse>({
    queryKey: ["/api/internal/admin/monitored-mailboxes/coverage"],
    refetchOnWindowFocus: false,
    staleTime: 60_000,
    enabled: allowed,
  });

  if (!allowed) return null;
  if (isLoading || !data) return null;
  if (data.severity === "ok") return null;

  const style = STYLES[data.severity];
  const messages = data.reasons
    .map(r => REASON_COPY[r])
    .filter((s): s is string => Boolean(s));

  return (
    <div
      className={`mx-6 mt-3 rounded-md border px-4 py-3 ${style.wrap} ${className}`}
      data-testid="banner-email-coverage"
      role="status"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5">{style.icon}</div>
          <div className="min-w-0">
            <div className="text-sm font-semibold" data-testid="text-coverage-label">{style.label}</div>
            <ul className="mt-1 text-xs font-medium leading-snug list-disc list-inside space-y-0.5">
              {messages.map(m => (
                <li key={m} data-testid={`text-coverage-reason-${m.slice(0, 16).replace(/\W+/g, "-")}`}>{m}</li>
              ))}
            </ul>
            <div className="mt-1 text-[11px] font-medium" data-testid="text-coverage-stats">
              {data.enrolledMailboxes}/{data.eligibleUsers} eligible reps enrolled
              {" · "}{data.backfills.succeeded} backfills OK
              {data.backfills.failed > 0 ? ` · ${data.backfills.failed} failed` : ""}
              {data.backfills.neverRun > 0 ? ` · ${data.backfills.neverRun} pending` : ""}
              {" · "}{data.spotQuotesFromBackfill30d} spot-quote opportunities (30d)
            </div>
          </div>
        </div>
        <Link href="/admin/monitored-mailboxes">
          <Button size="sm" variant="outline" className="shrink-0" data-testid="button-coverage-fix">
            Manage mailboxes
          </Button>
        </Link>
      </div>
    </div>
  );
}
