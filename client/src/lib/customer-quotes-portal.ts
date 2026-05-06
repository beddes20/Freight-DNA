import { createContext, useContext } from "react";

// Portal-target context shared by the Customer Quotes page and its child
// components. The page provides the in-wrapper portal node so descendants
// can forward it as the `container` prop on Radix overlays. When rendered
// outside Customer Quotes the value is `null` and Radix falls back to its
// default `document.body` portal.
export const CustomerQuotesPortalContext = createContext<HTMLElement | null>(null);

export function useCqOverlayPortal(): HTMLElement | null {
  return useContext(CustomerQuotesPortalContext);
}
