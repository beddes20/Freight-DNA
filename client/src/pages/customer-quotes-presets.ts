/**
 * Customer Quotes — sub-view preset helpers.
 *
 * Pure functions that map preset chips to existing filter/sort
 * combinations on the Customer Quotes page. No backend or schema
 * change; presets are a frontend convenience layer over the
 * `Filters` and `SortKey` state already owned by the page.
 *
 * Approved scope (Customer Quotes UX pass): the 5 presets below cover
 * the common rep workflows. They DO NOT replace Saved Views — a user
 * can drop out of any preset by hand-editing filters and the chip
 * will stop showing as active.
 *
 * Lives in its own module (rather than inside customer-quotes.tsx)
 * so the unit tests at tests/customer-quotes-presets.test.ts and
 * tests/customer-quotes-default-sort.test.ts can import the helpers
 * without pulling React, recharts, etc. into the test process.
 */

export type PresetFilters = {
  customerId?: string;
  startDate?: string;
  endDate?: string;
  equipment?: string;
  repId?: string;
  outcomeStatus?: string;
  outcomeReasonId?: string;
  laneSearch?: string;
  laneGroupId?: string;
  wonOnly?: boolean;
  activeOnly?: boolean;
  lostOnly?: boolean;
  expiringOnly?: boolean;
};

export type PresetSortKey =
  | "requestDate" | "customerName" | "originCity" | "destCity" | "equipment"
  | "quotedAmount" | "validThrough" | "outcomeStatus" | "outcomeReasonLabel"
  | "repName" | "responseTimeHours" | "source" | "score";

export type PresetSortDir = "asc" | "desc";

export type PresetKey = "myOpen" | "stale" | "wonWeek" | "lost" | "all";

/**
 * Default sort for the Customer Quotes table — `requestDate desc`
 * (newest first) so the portlet behaves like a recent Customer
 * Quotes list at first paint and after `clearAll`. The SLA / oldest-
 * first workflow remains one click away via the My Open and Stale
 * presets, both of which pin their own `requestDate asc` sort
 * (see `presetToFilters`). Reps can still flip the column header.
 *
 * History:
 *   - Original default: `requestDate desc` (newest-first).
 *   - Task #780 era: flipped to `asc` to surface oldest-actionable.
 *   - Task #837: flipped back to `desc` after the SLA workflow was
 *     fully covered by the My Open / Stale preset chips, so the
 *     default surface no longer needs to double as the SLA queue.
 */
export const DEFAULT_SORT_KEY: PresetSortKey = "requestDate";
export const DEFAULT_SORT_DIR: PresetSortDir = "desc";

/**
 * Task #837 — true when the server-resolved `repName` should render as
 * the literal "Unassigned" pill on the Quote Opportunities table. The
 * server returns the em-dash placeholder ("—") both when no rep is
 * attached AND when the rep is hidden by the funnel-eligibility filter
 * (Task #752). From the rep-on-the-page POV both cases are
 * "this row needs a real owner", so we collapse them to one literal
 * label rather than letting the dash bleed through.
 *
 * Lives in the presets module so the test suite can exercise it
 * without dragging React, recharts, etc. into the test process.
 */
export function isRepUnassigned(name: string | null | undefined): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (trimmed === "—" || trimmed === "-") return true;
  return false;
}

export interface PresetState {
  filters: PresetFilters;
  sortKey: PresetSortKey;
  sortDir: PresetSortDir;
}

export interface PresetDescriptor {
  key: PresetKey;
  label: string;
  testId: string;
}

export const PRESETS: PresetDescriptor[] = [
  { key: "myOpen",  label: "My Open",       testId: "preset-my-open" },
  { key: "stale",   label: "Stale",         testId: "preset-stale" },
  { key: "wonWeek", label: "Won This Week", testId: "preset-won-week" },
  { key: "lost",    label: "Lost",          testId: "preset-lost" },
  { key: "all",     label: "All",           testId: "preset-all" },
];

/**
 * Compute the Monday 00:00 of the same calendar week as `now`,
 * formatted as `YYYY-MM-DD` for the existing `startDate` filter.
 * Week starts Monday (ISO convention).
 */
export function startOfWeekMondayIso(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = d.getDay(); // 0 = Sun … 6 = Sat
  const offset = day === 0 ? 6 : day - 1; // Monday = 0 days back
  d.setDate(d.getDate() - offset);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Map a preset key to the exact `{ filters, sortKey, sortDir }` the
 * page should apply when the chip is clicked.
 *
 * `myRepId` is the `quote_reps.id` matched to the current user (by
 * email) — pass `null` if the current user has no quote-rep mapping;
 * the My Open chip is rendered disabled in that case (the preset
 * still resolves, with `repId: undefined`, so it stays a pure
 * function).
 */
export function presetToFilters(
  preset: PresetKey,
  myRepId: string | null,
  now: Date,
): PresetState {
  switch (preset) {
    case "myOpen":
      return {
        filters: {
          activeOnly: true,
          repId: myRepId ?? undefined,
        },
        sortKey: "requestDate",
        sortDir: "asc",
      };
    case "stale":
      return {
        filters: { activeOnly: true },
        sortKey: "requestDate",
        sortDir: "asc",
      };
    case "wonWeek":
      return {
        filters: {
          wonOnly: true,
          startDate: startOfWeekMondayIso(now),
        },
        sortKey: "requestDate",
        sortDir: "desc",
      };
    case "lost":
      return {
        filters: { lostOnly: true },
        sortKey: "requestDate",
        sortDir: "desc",
      };
    case "all":
      return {
        filters: {},
        sortKey: DEFAULT_SORT_KEY,
        sortDir: DEFAULT_SORT_DIR,
      };
  }
}

/**
 * Best-effort detect: is the current `(filters, sortKey, sortDir)`
 * exactly one of our preset signatures? Returns `null` if the user
 * has drifted off-preset by editing any other filter.
 *
 * Order matters — myOpen (which carries `repId`) is checked before
 * stale so that a logged-in rep viewing their own active queue
 * lights up "My Open" rather than the looser "Stale" chip.
 */
export function detectActivePreset(
  filters: PresetFilters,
  sortKey: PresetSortKey,
  sortDir: PresetSortDir,
  myRepId: string | null,
  now: Date,
): PresetKey | null {
  const order: PresetKey[] = ["myOpen", "wonWeek", "lost", "stale", "all"];
  for (const key of order) {
    if (key === "myOpen" && !myRepId) continue;
    const target = presetToFilters(key, myRepId, now);
    if (
      filtersEqual(filters, target.filters)
      && sortKey === target.sortKey
      && sortDir === target.sortDir
    ) {
      return key;
    }
  }
  return null;
}

function filtersEqual(a: PresetFilters, b: PresetFilters): boolean {
  const keys = new Set<keyof PresetFilters>([
    ...Object.keys(a) as (keyof PresetFilters)[],
    ...Object.keys(b) as (keyof PresetFilters)[],
  ]);
  for (const k of keys) {
    if (normalize(a[k]) !== normalize(b[k])) return false;
  }
  return true;
}

function normalize(v: unknown): unknown {
  if (v === undefined || v === "" || v === false) return undefined;
  return v;
}
