/**
 * Task #863 — Collapsible Spot Quote Search panel.
 *
 * Wraps the existing <SpotQuoteSearch /> component with a header that
 * collapses the panel by default so reps who don't use lane lookups
 * keep the table viewport tall. State is local; the search itself
 * holds its own internal form/results state and is preserved across
 * collapse/expand toggles (the panel just hides via CSS).
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SpotQuoteSearch, type SpotQuoteNewQuotePrefill } from "@/components/SpotQuoteSearch";

interface CustomerOption {
  id: string;
  organizationId?: string;
  name: string;
  segment?: string | null;
  partyType?: "customer" | "carrier" | "unknown";
}

export function SpotQuoteSearchPanel({
  customers,
  onApplyLaneFilter,
  onPickQuote,
  onPickCustomer,
  onStartNewQuote,
}: {
  customers: CustomerOption[];
  onApplyLaneFilter: (laneSearch: string) => void;
  onPickQuote: (id: string) => void;
  onPickCustomer: (id: string) => void;
  onStartNewQuote?: (prefill: SpotQuoteNewQuotePrefill) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-6 pt-3 shrink-0">
      <Card className="border-border/60 shadow-sm overflow-hidden" data-testid="panel-spot-quote-search">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/40 transition-colors"
          data-testid="toggle-spot-quote-search"
        >
          <div className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm font-medium">Spot Quote Search</span>
            <span className="text-[11px] text-muted-foreground">
              · search lane history, build a deal sheet, or paste an inbound RFQ
            </span>
          </div>
          {open
            ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </button>
        {open && (
          <div className="border-t border-border/60 p-4 bg-muted/10">
            <SpotQuoteSearch
              customers={customers}
              onApplyLaneFilter={onApplyLaneFilter}
              onPickQuote={onPickQuote}
              onPickCustomer={onPickCustomer}
              onStartNewQuote={onStartNewQuote}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
