// Task #692 — Cross-tab breadcrumb for lane surfaces.
//
// The four lane surfaces (Available Freight, Lane Work Queue, Carrier Hub,
// Lane Inbox) are heavily cross-linked. Without a breadcrumb, the only
// way back is the browser back button, which often loses scroll/filter
// state. This component renders a single-hop trail when the current URL
// includes a `from=<sourceSlug>` query param, and restores the source
// page's filter context from `fromQuery` (a URL-encoded query string the
// originating chip captured at click time).
//
// When `from` is missing or unknown, the component renders nothing — direct
// visits to the lane pages don't get an empty bar of vertical space.

import { Link } from "wouter";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

/** Stable slugs used in the `from=` query param. Keep in sync with
 *  buildCrossTabFromParam below and any chip that links between surfaces. */
export type LaneSurfaceSlug =
  | "available-freight"
  | "lane-work-queue"
  | "carrier-hub"
  | "lane-inbox";

const SURFACE_LABELS: Record<LaneSurfaceSlug, { label: string; path: string }> = {
  "available-freight": { label: "Available Freight", path: "/available-freight" },
  "lane-work-queue":   { label: "Lane Work Queue",   path: "/lanes/work-queue" },
  "carrier-hub":       { label: "Carrier Hub",       path: "/carrier-hub" },
  "lane-inbox":        { label: "Lane Inbox",        path: "/lane-inbox" },
};

function isLaneSurface(slug: string): slug is LaneSurfaceSlug {
  // Object.prototype.hasOwnProperty.call avoids matching inherited keys
  // ("toString", "constructor", etc.) that a plain `slug in SURFACE_LABELS`
  // check would falsely accept and render a broken breadcrumb for.
  return Object.prototype.hasOwnProperty.call(SURFACE_LABELS, slug);
}

/**
 * Build a query-string fragment that a chip should append when linking from
 * one lane surface to another. Captures the source slug and (optionally) the
 * source page's current `location.search` so the back-link can restore
 * filters and scroll context.
 *
 * Returns a leading "?" or "&" depending on whether the target URL already
 * has a query string — callers compose:
 *   `${targetPath}${buildCrossTabFromParam(...)}`
 *   `${targetPath}?already=1${buildCrossTabFromParam(..., "&")}`
 */
export function buildCrossTabFromParam(
  source: LaneSurfaceSlug,
  sourceSearch?: string,
  joiner: "?" | "&" = "?",
): string {
  const params = new URLSearchParams();
  params.set("from", source);
  if (sourceSearch) {
    // Strip any leading "?" and any pre-existing `from`/`fromQuery` so
    // breadcrumbs don't accumulate hop-by-hop into a stale chain.
    const cleaned = new URLSearchParams(sourceSearch.replace(/^\?/, ""));
    cleaned.delete("from");
    cleaned.delete("fromQuery");
    const cleanedStr = cleaned.toString();
    if (cleanedStr) params.set("fromQuery", cleanedStr);
  }
  return `${joiner}${params.toString()}`;
}

/**
 * Append `from=<slug>` (and optionally `fromQuery=<encoded>`) to an
 * arbitrary target URL. Handles both `?already=1` and bare paths.
 */
export function appendCrossTabFromParam(
  targetUrl: string,
  source: LaneSurfaceSlug,
  sourceSearch?: string,
): string {
  const joiner = targetUrl.includes("?") ? "&" : "?";
  return `${targetUrl}${buildCrossTabFromParam(source, sourceSearch, joiner)}`;
}

/**
 * Renders the cross-tab breadcrumb if the URL has a recognized `from=` slug.
 * `current` is the slug of the page rendering the breadcrumb (the trailing
 * non-link crumb).
 */
export function CrossTabBreadcrumb({ current }: { current: LaneSurfaceSlug }) {
  // Read directly from window.location so this works without Wouter context
  // and stays cheap (no re-render churn from a useLocation subscriber).
  const search = typeof window === "undefined" ? "" : window.location.search;
  const params = new URLSearchParams(search);
  const fromRaw = params.get("from") ?? "";
  if (!fromRaw || !isLaneSurface(fromRaw) || fromRaw === current) return null;

  const fromQuery = params.get("fromQuery") ?? "";
  const sourceMeta = SURFACE_LABELS[fromRaw];
  const currentMeta = SURFACE_LABELS[current];
  const backHref = fromQuery
    ? `${sourceMeta.path}?${fromQuery}`
    : sourceMeta.path;

  return (
    <Breadcrumb className="mb-3" data-testid={`breadcrumb-cross-tab-${current}`}>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href={backHref} data-testid={`breadcrumb-link-${fromRaw}`}>
              {sourceMeta.label}
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage data-testid={`breadcrumb-current-${current}`}>
            {currentMeta.label}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
