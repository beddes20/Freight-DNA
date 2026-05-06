// Workflow OS — saved views + URL state shared library.
//
// Defines the canonical filter shape and the URL ↔ prefs round-trip
// helpers. Every surface persists the same key vocabulary; surface-
// specific keys live under `surfaceSpecific.<surface>.*` so saved views
// round-trip across surfaces. See spec section G and ADR-005.

import { z } from "zod";
import {
  PICKUP_SCOPE_VALUES,
  type PickupScopeValue,
  DEFAULT_PICKUP_SCOPE,
} from "@shared/workflowOs/actionability";

export const ownerFilterValueSchema = z.union([
  z.literal("all"),
  z.literal("me"),
  z.literal("am_book"),
  z.literal("unassigned"),
  z.object({ specificUserId: z.string().min(1) }),
]);

export const pickupScopeValueSchema = z.enum(PICKUP_SCOPE_VALUES);

export const sharedFiltersSchema = z.object({
  owner: ownerFilterValueSchema.optional(),
  customer: z.string().optional(),
  status: z.string().optional(),
  pickupScope: pickupScopeValueSchema.optional(),
  sort: z.string().optional(),
  group: z.string().optional(),
  q: z.string().optional(),
  // Surface-specific bag. Keyed by surface so a view authored on AF
  // doesn't collide with one authored on LWQ when round-tripping.
  surfaceSpecific: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
});

export type SharedFilters = z.infer<typeof sharedFiltersSchema>;

export const SAVED_VIEW_KEYS = [
  "owner",
  "customer",
  "status",
  "pickupScope",
  "sort",
  "group",
  "q",
] as const;

export type SavedViewKey = typeof SAVED_VIEW_KEYS[number];

// Built-in saved view available on every surface (see spec section G).
// `sort` is intentionally surface-agnostic; surfaces that name their
// "soonest pickup" sort differently can pass it through `surfaceSpecific`.
export function myWorkTodayView(): SharedFilters {
  return {
    owner: "me",
    pickupScope: "actionable",
    sort: "pickup_soonest",
  };
}

// Serialize a filter set to URL query params. Returns the URLSearchParams
// instance so callers can append surface-private keys after.
export function serializeFiltersToUrl(filters: SharedFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.owner !== undefined) {
    params.set("owner", encodeOwner(filters.owner));
  }
  if (filters.customer) params.set("customer", filters.customer);
  if (filters.status) params.set("status", filters.status);
  if (filters.pickupScope) params.set("pickupScope", filters.pickupScope);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.group) params.set("group", filters.group);
  if (filters.q) params.set("q", filters.q);
  if (filters.surfaceSpecific) {
    for (const [surface, bag] of Object.entries(filters.surfaceSpecific)) {
      for (const [k, v] of Object.entries(bag)) {
        if (v === undefined || v === null) continue;
        params.set(`s.${surface}.${k}`, typeof v === "string" ? v : JSON.stringify(v));
      }
    }
  }
  return params;
}

// Inverse of `serializeFiltersToUrl`. Unknown keys are ignored. Invalid
// values fall back to undefined rather than throwing — saved views may
// be hand-edited.
export function deserializeFiltersFromUrl(
  search: string | URLSearchParams,
): SharedFilters {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const out: SharedFilters = {};
  const owner = params.get("owner");
  if (owner) {
    const decoded = decodeOwner(owner);
    if (decoded !== undefined) out.owner = decoded;
  }
  const customer = params.get("customer");
  if (customer) out.customer = customer;
  const status = params.get("status");
  if (status) out.status = status;
  const pickup = params.get("pickupScope");
  if (pickup && (PICKUP_SCOPE_VALUES as readonly string[]).includes(pickup)) {
    out.pickupScope = pickup as PickupScopeValue;
  }
  const sort = params.get("sort");
  if (sort) out.sort = sort;
  const group = params.get("group");
  if (group) out.group = group;
  const q = params.get("q");
  if (q) out.q = q;

  const surfaceSpecific: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of params.entries()) {
    if (!k.startsWith("s.")) continue;
    const parts = k.split(".");
    if (parts.length < 3) continue;
    const surface = parts[1];
    const key = parts.slice(2).join(".");
    if (!surfaceSpecific[surface]) surfaceSpecific[surface] = {};
    surfaceSpecific[surface][key] = tryJson(v);
  }
  if (Object.keys(surfaceSpecific).length > 0) {
    out.surfaceSpecific = surfaceSpecific;
  }
  return out;
}

// Apply a filter set to a per-user prefs object. Returns a new object;
// the caller persists. Surfaces with their own prefs columns
// (`cockpit_prefs` for AF) can spread this into the column.
export function applyFiltersToPrefs(
  existing: Record<string, unknown>,
  filters: SharedFilters,
): Record<string, unknown> {
  return {
    ...existing,
    workflowOsFilters: filters,
  };
}

function encodeOwner(v: SharedFilters["owner"]): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  return `specific:${v.specificUserId}`;
}

function decodeOwner(s: string): SharedFilters["owner"] | undefined {
  if (s === "all" || s === "me" || s === "am_book" || s === "unassigned") {
    return s;
  }
  if (s.startsWith("specific:")) {
    const id = s.slice("specific:".length);
    if (id) return { specificUserId: id };
  }
  return undefined;
}

function tryJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export { DEFAULT_PICKUP_SCOPE };
