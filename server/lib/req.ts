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
