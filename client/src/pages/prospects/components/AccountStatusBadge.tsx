import { ACCOUNT_STATUS_LABELS, ACCOUNT_STATUS_COLORS, type AccountStatus } from "@shared/schema";
import { ACCOUNT_STATUS_DOT } from "../types";

const ACCOUNT_STATUS_STALE_DAYS = 14;

export function AccountStatusBadge({ status, changedAt }: { status?: string | null; changedAt?: string | Date | null }) {
  const s = (status ?? "prospecting") as AccountStatus;
  const label = ACCOUNT_STATUS_LABELS[s] ?? s;
  const badge = ACCOUNT_STATUS_COLORS[s] ?? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  const dot = ACCOUNT_STATUS_DOT[s] ?? "bg-slate-400";
  const daysInStatus = changedAt
    ? Math.floor((Date.now() - new Date(changedAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const isStaleStatus = daysInStatus != null && daysInStatus >= ACCOUNT_STATUS_STALE_DAYS;
  return (
    <span className="flex items-center gap-0.5 flex-wrap">
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold flex items-center gap-0.5 ${badge}`}
        data-testid="badge-account-status"
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
        {label}
      </span>
      {isStaleStatus && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 font-semibold" data-testid="badge-status-stale" title={`${daysInStatus} days in this status`}>
          {daysInStatus}d
        </span>
      )}
    </span>
  );
}
