// Task #1020 — Available Freight: One scope, one truth.
//
// Pure helpers that turn the page's many filter inputs (URL params, saved
// view, bucket chip, owner combobox, pickup scope, lane / carrier / search)
// into a SINGLE ResolvedScope object. The same object drives:
//   • the visible row pipeline (`applyCockpitFilters`)
//   • the KPI tiles (`kpisFromFiltered`)
//   • the bucket chip counts (`countBuckets`)
//   • the ROI snapshot
//   • the human-readable scope summary above the row list
//
// Splitting these helpers out of `available-freight.tsx` lets us unit-test
// the contract — "what does the queue currently show, and which clause came
// from where?" — without rendering the page.

import { BUCKETS, type BucketKey } from "@shared/cockpitBuckets";

export type PickupScope = "actionable" | "recent" | "upcoming" | "all";
export type ViewMergeMode = "replace" | "merge";

/** A single human-readable scope clause with one-click remove + provenance. */
export interface ScopeClause {
  /** Stable id (used for React keys + the per-clause testid suffix). */
  key: string;
  /** Logical filter dimension. Drives conflict detection. */
  dimension:
    | "search"
    | "customer"
    | "owner"
    | "status"
    | "bucket"
    | "lane"
    | "carrier"
    | "pickupScope"
    | "view"
    | "viewExtra";
  /** Display label (e.g. `Owner: my team`, `Pickup: actionable`). */
  label: string;
  /** Where the clause came from. "view" clauses include the saved-view name. */
  source: "page" | "view";
  /** Saved-view name when source==="view"; null otherwise. */
  viewName?: string | null;
  /**
   * True when the user can remove this clause from the scope summary
   * (search/customer/owner/etc. are clearable; the saved-view extras
   * cannot be cleared independently of switching off the view itself).
   */
  clearable: boolean;
}

/** A detected disagreement between two clauses on the same dimension. */
export interface ScopeConflict {
  /** Stable id used for the inline resolver testid. */
  key: string;
  /** Dimension on which the two sources disagree. */
  dimension: ScopeClause["dimension"];
  /** Plain-English explanation rendered next to the resolver. */
  message: string;
  /**
   * Deterministic winner per the task spec ("saved view yields"). We always
   * default to the page-local clause winning so the rep's most recent
   * gesture (clicking a bucket, picking a pickup scope) is honored.
   */
  resolution: "page-wins" | "view-wins";
}

/** All scope inputs collected from the page. */
export interface ScopeInput {
  search: string;
  companyId: string; // "all" or id
  ownerTokens: string[]; // empty = "all"
  ownerLabels: Record<string, string>; // token -> human label
  statusFilter: string; // "active" | "all" | <status>
  bucket: BucketKey;
  pickupScope: PickupScope;
  laneFilter: string | null;
  carrierIdFilter: string | null;
  carrierName?: string | null;
  customerName?: string | null;
  view: {
    id: string;
    name: string;
    mergeMode: ViewMergeMode;
    /** Extras that the view layers on top of the page state. Only matters
     *  in "merge" mode (in "replace" mode the activation effect mirrors
     *  scalar fields back into page state and extras are dropped). */
    extras: {
      pickupWithinHours?: number;
      pickupAfterHours?: number;
      confidenceFlag?: "low" | "medium" | "high";
      sentNoReplyMinAgeMin?: number;
      statuses?: string[];
    };
  } | null;
}

/** Subset of saved-view extras that survive conflict resolution. The
 *  page's row pipeline AND its bucket-count pipeline both apply exactly
 *  these (never the raw `view.extras`) so the visible Scope Summary, the
 *  row count, the bucket counts, the KPIs, and the ROI snapshot can
 *  never disagree about which view rules are in force. */
export type EffectiveViewExtras = NonNullable<ScopeInput["view"]>["extras"];

export interface ResolvedScope {
  clauses: ScopeClause[];
  conflicts: ScopeConflict[];
  /**
   * Saved-view extras to apply downstream after conflict resolution.
   * In replace mode this is `{}`; in merge mode it's `view.extras`
   * minus any keys the conflict resolver decided to drop.
   */
  effectiveExtras: EffectiveViewExtras;
  /** Keys removed from `view.extras` by conflict resolution. Exposed
   *  for diagnostics + test assertions. */
  droppedExtraKeys: ReadonlySet<keyof EffectiveViewExtras>;
  /** True iff the scope contains zero filter clauses (the rep is at
   *  the operational default). */
  isDefault: boolean;
}

const PICKUP_SCOPE_LABELS: Record<PickupScope, string> = {
  actionable: "actionable (≤24h overdue)",
  recent: "recent + upcoming",
  upcoming: "upcoming only",
  all: "all dates",
};

function ownerTokenLabel(tok: string, labels: Record<string, string>): string {
  if (labels[tok]) return labels[tok];
  const lower = tok.toLowerCase();
  if (lower === "me") return "me";
  if (lower === "my-team" || lower === "myteam") return "my team";
  if (lower === "unassigned") return "unassigned";
  if (lower === "am_book") return "my AM book";
  if (lower.startsWith("team:")) return `team ${tok.slice("team:".length).slice(0, 8)}`;
  return tok.slice(0, 8);
}

/**
 * Build the ResolvedScope from the page's filter inputs. The order in which
 * clauses are emitted is the order the scope summary renders them.
 */
export function resolveScope(input: ScopeInput): ResolvedScope {
  const clauses: ScopeClause[] = [];
  const view = input.view;
  const isMerge = view?.mergeMode === "merge";

  // 1. Saved view header clause (always first when active).
  if (view) {
    clauses.push({
      key: `view:${view.id}`,
      dimension: "view",
      label:
        view.mergeMode === "merge"
          ? `Merged with view: ${view.name}`
          : `View: ${view.name}`,
      source: "view",
      viewName: view.name,
      clearable: true,
    });
  }

  // 2. Pickup scope is always shown (it's the strongest queue gate).
  clauses.push({
    key: "pickupScope",
    dimension: "pickupScope",
    label: `Pickup: ${PICKUP_SCOPE_LABELS[input.pickupScope]}`,
    source: "page",
    clearable: input.pickupScope !== "actionable",
  });

  if (input.search.trim().length > 0) {
    clauses.push({
      key: "search",
      dimension: "search",
      label: `Search: "${input.search.trim().slice(0, 24)}"`,
      source: "page",
      clearable: true,
    });
  }

  if (input.companyId !== "all") {
    clauses.push({
      key: "customer",
      dimension: "customer",
      label: `Customer: ${input.customerName ?? input.companyId}`,
      source: "page",
      clearable: true,
    });
  }

  for (const tok of input.ownerTokens) {
    clauses.push({
      key: `owner:${tok}`,
      dimension: "owner",
      label: `Owner: ${ownerTokenLabel(tok, input.ownerLabels)}`,
      source: "page",
      clearable: true,
    });
  }

  if (input.statusFilter !== "active") {
    clauses.push({
      key: "status",
      dimension: "status",
      label: `Status: ${input.statusFilter}`,
      source: "page",
      clearable: true,
    });
  }

  if (input.bucket !== "all") {
    clauses.push({
      key: "bucket",
      dimension: "bucket",
      label: `Queue: ${BUCKETS[input.bucket]?.label ?? input.bucket}`,
      source: "page",
      clearable: true,
    });
  }

  if (input.laneFilter) {
    clauses.push({
      key: "lane",
      dimension: "lane",
      label: "Lane (deep-link)",
      source: "page",
      clearable: true,
    });
  }

  if (input.carrierIdFilter) {
    clauses.push({
      key: "carrier",
      dimension: "carrier",
      label: `Carrier: ${input.carrierName ?? "deep-link"}`,
      source: "page",
      clearable: true,
    });
  }

  const conflicts = detectScopeConflicts(input);

  // Compute the *effective* view extras: in replace mode none of the
  // saved view's extras apply; in merge mode all of `view.extras` apply
  // EXCEPT the keys that conflict resolution decided to drop. This
  // single derivation drives both the visible chips below AND the row /
  // bucket pipelines in the page (see `useEffectiveScope` consumers).
  const droppedExtraKeys = new Set<keyof EffectiveViewExtras>();
  for (const c of conflicts) {
    if (c.resolution !== "page-wins") continue;
    if (c.key === "bucket-vs-pickupAfterHours" || c.key === "bucket-vs-pickupAfterHours-risk") {
      droppedExtraKeys.add("pickupAfterHours");
    }
    if (c.key === "bucket-vs-pickupWithinHours") {
      droppedExtraKeys.add("pickupWithinHours");
    }
  }
  const effectiveExtras: EffectiveViewExtras = {};
  if (view && isMerge) {
    for (const [k, v] of Object.entries(view.extras)) {
      if (droppedExtraKeys.has(k as keyof EffectiveViewExtras)) continue;
      (effectiveExtras as Record<string, unknown>)[k] = v;
    }
  }

  // 3. Saved-view extras only contribute additional clauses in merge mode.
  //    Any extra dropped by conflict resolution is intentionally NOT
  //    rendered as an active clause — the conflict resolver below is
  //    the single place it surfaces.
  if (view && isMerge) {
    const x = effectiveExtras;
    if (typeof x.pickupWithinHours === "number") {
      clauses.push({
        key: "viewExtra:pickupWithinHours",
        dimension: "viewExtra",
        label: `View rule: pickup ≤${x.pickupWithinHours}h`,
        source: "view",
        viewName: view.name,
        clearable: false,
      });
    }
    if (typeof x.pickupAfterHours === "number") {
      clauses.push({
        key: "viewExtra:pickupAfterHours",
        dimension: "viewExtra",
        label: `View rule: pickup ≥${x.pickupAfterHours}h ahead`,
        source: "view",
        viewName: view.name,
        clearable: false,
      });
    }
    if (x.confidenceFlag) {
      clauses.push({
        key: "viewExtra:confidenceFlag",
        dimension: "viewExtra",
        label: `View rule: ${x.confidenceFlag} confidence`,
        source: "view",
        viewName: view.name,
        clearable: false,
      });
    }
    if (typeof x.sentNoReplyMinAgeMin === "number") {
      clauses.push({
        key: "viewExtra:sentNoReplyMinAgeMin",
        dimension: "viewExtra",
        label: `View rule: sent ≥${x.sentNoReplyMinAgeMin}m, no reply`,
        source: "view",
        viewName: view.name,
        clearable: false,
      });
    }
    if (x.statuses && x.statuses.length > 0) {
      clauses.push({
        key: "viewExtra:statuses",
        dimension: "viewExtra",
        label: `View rule: status ∈ {${x.statuses.join(", ")}}`,
        source: "view",
        viewName: view.name,
        clearable: false,
      });
    }
  }

  // The "operational default" is: pickup=actionable, no view, no other
  // clauses. (We always render the pickup-scope clause, but it's the only
  // one in default state.)
  const isDefault =
    !view &&
    input.pickupScope === "actionable" &&
    input.search.trim().length === 0 &&
    input.companyId === "all" &&
    input.ownerTokens.length === 0 &&
    input.statusFilter === "active" &&
    input.bucket === "all" &&
    !input.laneFilter &&
    !input.carrierIdFilter;

  return { clauses, conflicts, effectiveExtras, droppedExtraKeys, isDefault };
}

/**
 * Detect contradictions between the saved view's pickup-window extras and
 * the user's bucket / pickupScope picks. Per the spec the saved view
 * "yields" — i.e. the page clause wins — and we surface the conflict
 * inline so the rep can swap the resolution if needed.
 */
export function detectScopeConflicts(input: ScopeInput): ScopeConflict[] {
  const out: ScopeConflict[] = [];
  const view = input.view;
  if (!view || view.mergeMode !== "merge") return out;
  const x = view.extras;

  // Bucket "pickup_today" requires today's pickup. View rule
  // `pickupAfterHours >= 24` excludes today entirely.
  if (input.bucket === "pickup_today" && typeof x.pickupAfterHours === "number" && x.pickupAfterHours >= 24) {
    out.push({
      key: "bucket-vs-pickupAfterHours",
      dimension: "bucket",
      message: `Bucket "Pickup today" can never match view "${view.name}" (requires pickup ≥${x.pickupAfterHours}h ahead).`,
      resolution: "page-wins",
    });
  }
  // Bucket "pickup_tomorrow" needs ~24-48h ahead. View rule
  // `pickupWithinHours <= 24` excludes tomorrow.
  if (input.bucket === "pickup_tomorrow" && typeof x.pickupWithinHours === "number" && x.pickupWithinHours <= 24) {
    out.push({
      key: "bucket-vs-pickupWithinHours",
      dimension: "bucket",
      message: `Bucket "Pickup tomorrow" can never match view "${view.name}" (requires pickup within ≤${x.pickupWithinHours}h).`,
      resolution: "page-wins",
    });
  }
  // Bucket "at_risk_24h" needs pickup within 24h. View rule
  // `pickupAfterHours >= 24` excludes that.
  if (input.bucket === "at_risk_24h" && typeof x.pickupAfterHours === "number" && x.pickupAfterHours >= 24) {
    out.push({
      key: "bucket-vs-pickupAfterHours-risk",
      dimension: "bucket",
      message: `Bucket "At-risk ≤24h" can never match view "${view.name}" (requires pickup ≥${x.pickupAfterHours}h ahead).`,
      resolution: "page-wins",
    });
  }
  // pickupScope=upcoming + view's recent-only pickup rule (statuses include
  // covered-only states is hard to detect generically). We stick with the
  // bucket-vs-extras checks above which cover the spec example.

  return out;
}

/** Single human-sentence rendering of the resolved scope. */
export function summarizeScope(resolved: ResolvedScope): string {
  if (resolved.isDefault) {
    return "Showing the operational default queue (actionable pickup window).";
  }
  const parts = resolved.clauses.map((c) => c.label);
  return `Showing rows where ${parts.join(" · ")}.`;
}
