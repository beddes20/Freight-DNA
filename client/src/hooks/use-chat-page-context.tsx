/**
 * useChatPageContext — derives `{ route, entityType, entityId, entityName }`
 * from the current wouter location and the document title. The DNA copilot
 * sends this on every turn so the bot can resolve "this account" / "this
 * carrier" without the rep typing the name.
 *
 * Pages that hold an entity name in document.title (most company / carrier /
 * lane detail pages do) get free entityName resolution. Pages that don't can
 * still rely on the entityId from the URL.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";

export type ChatEntityType = "company" | "carrier" | "lane" | "rfp" | "task" | "contact" | "prospect";

export interface ChatPageContext {
  route: string;
  entityType: ChatEntityType | null;
  entityId: string | null;
  entityName: string | null;
}

interface ParsedRoute {
  entityType: ChatEntityType | null;
  entityId: string | null;
}

function parseRoute(loc: string): ParsedRoute {
  const m = (re: RegExp) => loc.match(re);
  let r;
  r = m(/^\/companies\/([^/?#]+)/);          if (r) return { entityType: "company",  entityId: r[1] };
  // Carriers: support both the canonical /carriers/:id and the legacy
  // /carrier-hub/:id route the app currently uses.
  r = m(/^\/(?:carriers|carrier-hub)\/([^/?#]+)/);   if (r) return { entityType: "carrier", entityId: r[1] };
  // Lanes: support both /lanes/:id and the actual /available-freight/:id
  // detail route. Skip /lanes/work-queue (no entity id).
  r = m(/^\/lanes\/(?!work-queue)([^/?#]+)/);        if (r) return { entityType: "lane", entityId: r[1] };
  r = m(/^\/available-freight\/([^/?#]+)/);          if (r) return { entityType: "lane", entityId: r[1] };
  // RFPs: canonical /rfps/:id plus the existing /rfp-awards/:id and
  // /rfp-lane-search/:id patterns.
  r = m(/^\/rfps\/([^/?#]+)/);                       if (r) return { entityType: "rfp", entityId: r[1] };
  r = m(/^\/rfp-(?:awards|lane-search)\/([^/?#]+)/); if (r) return { entityType: "rfp", entityId: r[1] };
  r = m(/^\/prospects\/([^/?#]+)/);           if (r) return { entityType: "prospect", entityId: r[1] };
  r = m(/^\/contacts\/([^/?#]+)/);            if (r) return { entityType: "contact",  entityId: r[1] };
  // Tasks page (no specific id)
  if (/^\/tasks(?:[/?#]|$)/.test(loc)) return { entityType: "task", entityId: null };
  return { entityType: null, entityId: null };
}

export function useChatPageContext(): ChatPageContext {
  const [location] = useLocation();
  const [entityName, setEntityName] = useState<string | null>(null);

  useEffect(() => {
    // Best-effort entity name: read document.title's leading segment.
    // Most pages set "Company Name | Freight DNA" so split on "|".
    const t = (document.title || "").split("|")[0].trim();
    setEntityName(t || null);
    // Re-read on DOM changes — many pages set the title async after data load.
    const obs = new MutationObserver(() => {
      const next = (document.title || "").split("|")[0].trim();
      setEntityName(next || null);
    });
    const titleEl = document.querySelector("title");
    if (titleEl) obs.observe(titleEl, { childList: true });
    return () => obs.disconnect();
  }, [location]);

  const { entityType, entityId } = parseRoute(location);

  return {
    route: location,
    entityType,
    entityId,
    entityName: entityType ? entityName : null,
  };
}
