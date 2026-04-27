/**
 * Tiny request-input narrowing helpers.
 *
 * `@types/express-serve-static-core` declares `ParamsDictionary` and
 * `ParsedQs` so that values may be `string | string[] | …`. At runtime,
 * route params are always strings, and we treat the first array element
 * as the canonical value for query strings. These helpers make the
 * narrowing explicit at every call site so we don't sprinkle `as string`
 * casts that hide actual `string[]` arrivals.
 */
import type { ParsedQs } from "qs";

type QueryVal = undefined | string | ParsedQs | (string | ParsedQs)[];
type ParamVal = undefined | string | string[];

/** Narrow a route param to a string. Returns `""` if absent. */
export function pStr(v: ParamVal): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

/** Narrow a query value to a string. Returns `""` if absent or non-string. */
export function qStr(v: QueryVal): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

/** Narrow a query value to `string | undefined`. */
export function qOptStr(v: QueryVal): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

/** Narrow a query value to `string[]`. Splits comma-separated strings. */
export function qStrArr(v: QueryVal): string[] {
  if (typeof v === "string") return v.split(",").map(s => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** Coerce a query value to a positive integer, falling back to `fallback`. */
export function qInt(v: QueryVal, fallback: number): number {
  const s = qStr(v);
  if (!s) return fallback;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce a query value to a boolean ("true" / "1" / "yes" / "on" → true). */
export function qBool(v: QueryVal, fallback = false): boolean {
  const s = qStr(v).toLowerCase();
  if (!s) return fallback;
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

/**
 * Pull the standard pagination + sort + flag bag off a request in one call.
 *
 * - `page` defaults to 1, clamped >= 1
 * - `pageSize` defaults to 20, clamped to [1, maxPageSize] (default cap 100)
 * - `sort` defaults to "" (caller picks its own default)
 * - `flags` is a record of every additional query param coerced to a boolean
 *   via `qBool`, useful for things like `?includeArchived=true`.
 *
 * Pass an explicit list of `boolKeys` to limit which params are coerced into
 * the flags bag (otherwise every query param is included).
 */
export function extractListFilters(
  req: { query: Record<string, QueryVal> },
  opts?: { defaultSort?: string; defaultPageSize?: number; maxPageSize?: number; boolKeys?: string[] }
): { page: number; pageSize: number; sort: string; flags: Record<string, boolean> } {
  const defaultSort = opts?.defaultSort ?? "";
  const defaultPageSize = opts?.defaultPageSize ?? 20;
  const maxPageSize = opts?.maxPageSize ?? 100;

  const page = Math.max(1, qInt(req.query.page, 1));
  const pageSizeRaw = qInt(req.query.pageSize, defaultPageSize);
  const pageSize = Math.min(maxPageSize, Math.max(1, pageSizeRaw));
  const sort = qStr(req.query.sort) || defaultSort;

  const flags: Record<string, boolean> = {};
  const keys = opts?.boolKeys ?? Object.keys(req.query);
  for (const k of keys) {
    if (k === "page" || k === "pageSize" || k === "sort") continue;
    flags[k] = qBool(req.query[k]);
  }
  return { page, pageSize, sort, flags };
}
