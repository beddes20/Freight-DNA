/**
 * Re-exports the shared org-local-date helpers so server callers continue to
 * import from `server/lib/orgLocalDate`. The implementation now lives in
 * `shared/orgLocalDate.ts` so the cockpit client filter and the cockpit
 * server SQL aggregates anchor on the same definition of "today" — see
 * task #875.
 */
export {
  ORG_LOCAL_TIMEZONE,
  todayIsoInOrgTz,
  isPastOrgLocalDay,
} from "../../shared/orgLocalDate";
