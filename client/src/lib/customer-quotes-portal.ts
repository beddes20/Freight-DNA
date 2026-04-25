// Task #650 — Shared portal-target context for the Customer Quotes page.
//
// The Customer Quotes page renders its own theme wrapper and an in-wrapper
// portal target (`[data-testid="cq-overlay-portal"]`). All Radix overlays
// (Dialog/Sheet/Popover/Select/AlertDialog) on this page must portal into
// that target so they inherit the page-scoped CSS variables instead of
// the global `<html>` theme.
//
// This module lives outside `pages/customer-quotes.tsx` so that helper
// components rendered inside the page (and defined in `client/src/components/`)
// can import the same context without a circular dependency back into the
// page module. When a component is rendered outside Customer Quotes the
// context value is `null` and consumers fall back to Radix's default
// (portal to `document.body`).
import { createContext, useContext } from "react";

export const CustomerQuotesPortalContext = createContext<HTMLElement | null>(null);

export function useCqOverlayPortal(): HTMLElement | null {
  return useContext(CustomerQuotesPortalContext);
}
