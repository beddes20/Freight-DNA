// Global Lane Switchboard (Task #652)
//
// Keyboard-driven palette opened with `?` (Shift+/). Accepts a flexible
// lane signature like "ATL → DAL", "Atlanta to Dallas reefer", or
// "Memphis, TN -> Chicago, IL flatbed", parses it client-side via
// laneSwitchboardParser, and fans out to /api/lane-switchboard.
//
// Three columns deep-link to LWQ, AF, and CQ respectively. The empty
// state suggests CTAs to keep the operator productive when nothing
// matches.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Truck, Radio, FileText, ArrowRight, Search, AlertCircle } from "lucide-react";
import { parseSwitchboardInput, buildSwitchboardQuery } from "@/lib/laneSwitchboardParser";

interface SwitchboardRecurringRow {
  laneId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  companyName: string | null;
  ownerName: string | null;
  ownerUserId: string | null;
  carriersContactedCount: number | null;
  laneScore: number | null;
}
interface SwitchboardLiveRow {
  opportunityId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  status: string;
  pickupWindowStart: string | null;
  loadCount: number | null;
  laneSignature: string;
}
interface SwitchboardHistoricalRow {
  quoteId: string;
  customerName: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string | null;
  outcomeStatus: string | null;
  quotedAmount: number | null;
  requestDate: string;
}
interface SwitchboardResponse {
  parsed: {
    originCity: string;
    originState: string | null;
    destCity: string;
    destState: string | null;
    equipment: string | null;
  };
  recurring: SwitchboardRecurringRow[];
  live: SwitchboardLiveRow[];
  historical: SwitchboardHistoricalRow[];
  totals: { recurring: number; live: number; historical: number };
}

interface LaneSwitchboardProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function LaneSwitchboard({ open, onOpenChange }: LaneSwitchboardProps) {
  const [, navigate] = useLocation();
  const [input, setInput] = useState("");
  const debounced = useDebounced(input, 250);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state on close so the next open is a clean slate.
  useEffect(() => {
    if (!open) {
      setInput("");
      return;
    }
    // Autofocus when opened.
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const parsed = useMemo(() => parseSwitchboardInput(debounced), [debounced]);

  // buildSwitchboardQuery returns a URL-encoded query string when the
  // parsed input is "ok", otherwise null — null disables the query.
  const queryString = useMemo(
    () => (parsed.status === "ok" ? buildSwitchboardQuery(parsed) : null),
    [parsed],
  );
  const ready = parsed.status === "ok" && !!queryString;

  const { data, isFetching, error } = useQuery<SwitchboardResponse>({
    queryKey: ["/api/lane-switchboard", queryString ?? ""],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/lane-switchboard?${queryString}`);
      return res.json();
    },
    enabled: ready && open,
    staleTime: 30_000,
  });

  const handleClose = () => onOpenChange(false);

  const goLwq = (laneId: string) => {
    handleClose();
    navigate(`/lanes/work-queue?laneId=${encodeURIComponent(laneId)}`);
  };
  const goAf = (sig: string) => {
    handleClose();
    navigate(`/freight?lane=${encodeURIComponent(sig)}`);
  };
  const goCq = () => {
    if (parsed.status !== "ok" || !parsed.originCity || !parsed.destCity) return;
    handleClose();
    const params = new URLSearchParams();
    params.set("pickupCity", parsed.originCity);
    if (parsed.originState) params.set("pickupState", parsed.originState);
    params.set("deliveryCity", parsed.destCity);
    if (parsed.destState) params.set("deliveryState", parsed.destState);
    if (parsed.equipment) params.set("equipment", parsed.equipment);
    navigate(`/customer-quotes?${params.toString()}`);
  };
  const goCqRow = (row: SwitchboardHistoricalRow) => {
    handleClose();
    const params = new URLSearchParams();
    params.set("pickupCity", row.originCity);
    params.set("pickupState", row.originState);
    params.set("deliveryCity", row.destCity);
    params.set("deliveryState", row.destState);
    if (row.equipment) params.set("equipment", row.equipment);
    navigate(`/customer-quotes?${params.toString()}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl p-0 gap-0 overflow-hidden"
        data-testid="dialog-lane-switchboard"
      >
        <DialogTitle className="sr-only">Lane Switchboard</DialogTitle>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='Lane sig: "ATL → DAL", "Atlanta to Dallas reefer", "Memphis, TN -> Chicago, IL"'
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
            data-testid="input-lane-switchboard"
            onKeyDown={(e) => {
              if (e.key === "Escape") handleClose();
            }}
          />
          <kbd className="hidden md:inline-flex items-center rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
            esc
          </kbd>
        </div>

        {/* Parser hint row */}
        <div className="px-4 py-2 border-b bg-muted/30 text-xs text-muted-foreground min-h-[34px] flex items-center gap-2">
          {!input.trim() ? (
            <span>Type a lane to search across recurring lanes, live freight, and customer quotes.</span>
          ) : parsed.status !== "ok" || !parsed.originCity || !parsed.destCity ? (
            <span data-testid="text-switchboard-parse-hint">
              Couldn't parse — try "Origin → Destination" or "Origin to Destination".
            </span>
          ) : (
            <span data-testid="text-switchboard-parsed">
              <strong className="text-foreground">{titleCase(parsed.originCity)}</strong>
              {parsed.originState ? `, ${parsed.originState}` : ""}
              <ArrowRight className="inline h-3 w-3 mx-1" />
              <strong className="text-foreground">{titleCase(parsed.destCity)}</strong>
              {parsed.destState ? `, ${parsed.destState}` : ""}
              {parsed.equipment ? <> · <Badge variant="outline" className="ml-1 capitalize">{parsed.equipment}</Badge></> : null}
              {(!parsed.originState || !parsed.destState) && (
                <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertCircle className="h-3 w-3" /> Add state codes for richer historical matches
                </span>
              )}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 max-h-[60vh]">
          <Column
            title="Recurring Lanes"
            icon={<Truck className="h-4 w-4" />}
            isLoading={ready && isFetching && !data}
            empty={
              parsed && data && data.recurring.length === 0 ? (
                <EmptyState
                  message="No recurring lanes match."
                  ctaLabel="Open Lane Work Queue"
                  onCta={() => { handleClose(); navigate("/lanes/work-queue"); }}
                  ctaTestId="button-empty-lwq"
                />
              ) : null
            }
            testId="column-switchboard-recurring"
          >
            {data?.recurring.map((r) => (
              <Row
                key={r.laneId}
                onClick={() => goLwq(r.laneId)}
                testId={`row-switchboard-lwq-${r.laneId}`}
                primary={`${formatCity(r.origin)}${r.originState ? `, ${r.originState}` : ""} → ${formatCity(r.destination)}${r.destinationState ? `, ${r.destinationState}` : ""}`}
                secondary={r.companyName ?? "Unassigned company"}
                tertiary={[
                  r.equipmentType ?? null,
                  r.ownerName ? `Owner: ${r.ownerName}` : "Unowned",
                  r.carriersContactedCount != null ? `${r.carriersContactedCount} carriers contacted` : null,
                ].filter(Boolean).join(" · ")}
              />
            ))}
          </Column>

          <Column
            title="Live Freight"
            icon={<Radio className="h-4 w-4" />}
            isLoading={ready && isFetching && !data}
            empty={
              parsed && data && data.live.length === 0 ? (
                <EmptyState
                  message="No open opportunities on this lane."
                  ctaLabel="Browse Available Freight"
                  onCta={() => { handleClose(); navigate("/freight"); }}
                  ctaTestId="button-empty-af"
                />
              ) : null
            }
            testId="column-switchboard-live"
          >
            {data?.live.map((r) => (
              <Row
                key={r.opportunityId}
                onClick={() => goAf(r.laneSignature)}
                testId={`row-switchboard-af-${r.opportunityId}`}
                primary={`${formatCity(r.origin)}${r.originState ? `, ${r.originState}` : ""} → ${formatCity(r.destination)}${r.destinationState ? `, ${r.destinationState}` : ""}`}
                secondary={
                  r.pickupWindowStart
                    ? `Pickup ${new Date(r.pickupWindowStart).toLocaleDateString()}`
                    : "Pickup window unset"
                }
                tertiary={[
                  r.equipmentType ?? null,
                  prettyStatus(r.status),
                  r.loadCount != null && r.loadCount > 1 ? `${r.loadCount} loads` : null,
                ].filter(Boolean).join(" · ")}
              />
            ))}
          </Column>

          <Column
            title="Historical Quotes"
            icon={<FileText className="h-4 w-4" />}
            isLoading={ready && isFetching && !data}
            empty={
              parsed && data && data.historical.length === 0 ? (
                <EmptyState
                  message={
                    parsed.originState && parsed.destState
                      ? "No prior quotes on this lane."
                      : "Add state codes (e.g. ATL, GA) to surface prior quotes."
                  }
                  ctaLabel="Open Customer Quotes"
                  onCta={goCq}
                  ctaTestId="button-empty-cq"
                />
              ) : null
            }
            testId="column-switchboard-historical"
          >
            {data?.historical.map((r) => (
              <Row
                key={r.quoteId}
                onClick={() => goCqRow(r)}
                testId={`row-switchboard-cq-${r.quoteId}`}
                primary={`${formatCity(r.originCity)}, ${r.originState} → ${formatCity(r.destCity)}, ${r.destState}`}
                secondary={r.customerName || "Unknown customer"}
                tertiary={[
                  r.equipment ?? null,
                  r.outcomeStatus ? prettyStatus(r.outcomeStatus) : null,
                  r.quotedAmount != null ? `$${Math.round(r.quotedAmount).toLocaleString()}` : null,
                  new Date(r.requestDate).toLocaleDateString(),
                ].filter(Boolean).join(" · ")}
              />
            ))}
          </Column>
        </div>

        {error && (
          <div className="border-t px-4 py-2 text-xs text-destructive" data-testid="text-switchboard-error">
            Switchboard failed: {(error as Error).message}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Column({
  title, icon, isLoading, empty, testId, children,
}: {
  title: string;
  icon: React.ReactNode;
  isLoading: boolean;
  empty: React.ReactNode;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-r last:border-r-0 flex flex-col min-h-[220px] max-h-[60vh] overflow-hidden" data-testid={testId}>
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </div>
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-3 space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : empty ? (
          empty
        ) : (
          <div className="divide-y">{children}</div>
        )}
      </div>
    </div>
  );
}

function Row({
  primary, secondary, tertiary, onClick, testId,
}: {
  primary: string;
  secondary: string;
  tertiary: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="w-full text-left px-3 py-2 hover:bg-accent focus:bg-accent focus:outline-none transition-colors"
    >
      <div className="text-sm font-medium text-foreground truncate">{primary}</div>
      <div className="text-xs text-muted-foreground truncate">{secondary}</div>
      {tertiary && <div className="text-[11px] text-muted-foreground/80 truncate mt-0.5">{tertiary}</div>}
    </button>
  );
}

function EmptyState({ message, ctaLabel, onCta, ctaTestId }: {
  message: string;
  ctaLabel: string;
  onCta: () => void;
  ctaTestId: string;
}) {
  return (
    <div className="p-4 flex flex-col items-start gap-2">
      <p className="text-xs text-muted-foreground">{message}</p>
      <Button size="sm" variant="outline" onClick={onCta} data-testid={ctaTestId}>
        {ctaLabel}
      </Button>
    </div>
  );
}

function titleCase(s: string) {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
function formatCity(s: string) {
  return titleCase(s);
}
function prettyStatus(s: string) {
  return s.replace(/_/g, " ");
}
