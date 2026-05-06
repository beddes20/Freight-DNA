import { useQuery } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { AttributionBadge } from "@/components/conversations/badges";

// Canonical assignment-rule taxonomy. Today the server emits only
// `account_owner` (rep owns the recipient inbox) and `fallback`
// (manual entry); `lane_pattern` and `last_toucher` are reserved for
// follow-up #980 when the assignment-rule audit row lands. The drawer
// renders all four labels so the type stays forward-compatible.
export type AttributionRule = "account_owner" | "lane_pattern" | "last_toucher" | "fallback";

export type QuoteAttribution = {
  ok: true;
  quoteId: string;
  customer: { id: string; name: string } | null;
  rep: { id: string; name: string; email: string | null } | null;
  contact: {
    id: string;
    name: string | null;
    email: string | null;
    title: string | null;
  } | null;
  sender: {
    email: string | null;
    name: string | null;
    recipientEmail: string | null;
    subject: string | null;
    sentAt: string | null;
  } | null;
  rule: {
    name: AttributionRule;
    description: string;
    decidedAt: string | null;
    inputs: Record<string, string | null> | null;
  };
  // Task #1056 — Tier+evidence carried over from the conversation
  // thread that produced this quote. Drives the AttributionBadge so
  // a rep can see at a glance how a free-mail sender got linked.
  threadAttribution: {
    source: string;
    evidence: Record<string, unknown> | null;
  } | null;
};

interface AttributionDrawerProps {
  quoteId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AttributionDrawer({ quoteId, open, onOpenChange }: AttributionDrawerProps) {
  const { data, isLoading, isError, error } = useQuery<QuoteAttribution>({
    queryKey: ["/api/customer-quotes/quote", quoteId, "attribution"],
    enabled: open && !!quoteId,
    queryFn: async () => {
      const res = await fetch(`/api/customer-quotes/quote/${encodeURIComponent(quoteId!)}/attribution`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-md w-full overflow-y-auto"
        data-testid="drawer-attribution"
      >
        <SheetHeader>
          <SheetTitle data-testid="text-attribution-title">Why this rep?</SheetTitle>
          <SheetDescription>
            How the system assigned the customer + rep on this quote.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {isLoading && (
            <div className="space-y-3" data-testid="state-attribution-loading">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}

          {isError && (
            <div
              className="text-sm text-red-600 dark:text-red-400"
              data-testid="state-attribution-error"
            >
              Failed to load attribution: {error instanceof Error ? error.message : String(error)}
            </div>
          )}

          {data && (
            <>
              {data.threadAttribution && (
                <section data-testid="section-attribution-inference">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                    Inference
                  </div>
                  <AttributionBadge
                    thread={{
                      attributionInferenceSource: data.threadAttribution.source as
                        | "contact" | "domain" | "thread" | "signature" | "weak"
                        | "confirmed_signature" | "confirmed_weak",
                      attributionEvidence: data.threadAttribution.evidence ?? null,
                    }}
                  />
                </section>
              )}

              <section>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                  Rule
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="font-mono text-[11px]"
                    data-testid="badge-attribution-rule"
                  >
                    {data.rule.name}
                  </Badge>
                  {data.rule.decidedAt && (
                    <span
                      className="text-[10px] text-muted-foreground"
                      data-testid="text-attribution-decided-at"
                      title={new Date(data.rule.decidedAt).toISOString()}
                    >
                      decided {new Date(data.rule.decidedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                </div>
                <p className="text-sm mt-2 text-muted-foreground" data-testid="text-attribution-rule-description">
                  {data.rule.description}
                </p>
                {data.rule.inputs && (
                  <ul className="text-[11px] text-muted-foreground mt-2 space-y-0.5 font-mono">
                    {Object.entries(data.rule.inputs)
                      .filter(([, v]) => v != null)
                      .map(([k, v]) => (
                        <li key={k} data-testid={`text-attribution-input-${k}`}>
                          <span className="text-muted-foreground/70">{k}:</span> {v}
                        </li>
                      ))}
                  </ul>
                )}
              </section>

              <section className="border-t pt-3">
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                  Customer
                </div>
                {data.customer ? (
                  <div className="text-sm font-medium" data-testid="text-attribution-customer-name">
                    {data.customer.name}
                  </div>
                ) : (
                  <div className="text-sm italic text-muted-foreground" data-testid="text-attribution-customer-empty">
                    No customer linked.
                  </div>
                )}
              </section>

              <section className="border-t pt-3">
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                  Rep
                </div>
                {data.rep ? (
                  <div className="text-sm">
                    <div className="font-medium" data-testid="text-attribution-rep-name">
                      {data.rep.name}
                    </div>
                    {data.rep.email && (
                      <div className="text-muted-foreground text-xs" data-testid="text-attribution-rep-email">
                        {data.rep.email}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm italic text-muted-foreground" data-testid="text-attribution-rep-empty">
                    Unassigned.
                  </div>
                )}
              </section>

              <section className="border-t pt-3">
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                  Matched contact
                </div>
                {data.contact ? (
                  <div className="text-sm" data-testid="text-attribution-contact">
                    <div className="font-medium">{data.contact.name ?? data.contact.email ?? "(unnamed)"}</div>
                    <div className="text-xs text-muted-foreground">
                      {[data.contact.title, data.contact.email].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm italic text-muted-foreground" data-testid="text-attribution-contact-empty">
                    No CRM contact matched the sender email.
                  </div>
                )}
              </section>

              <section className="border-t pt-3">
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                  Source email
                </div>
                {data.sender ? (
                  <div className="text-sm space-y-1">
                    <div data-testid="text-attribution-sender">
                      <span className="text-muted-foreground">From: </span>
                      <span className="font-medium">
                        {data.sender.name ? `${data.sender.name} <${data.sender.email ?? "?"}>` : (data.sender.email ?? "(unknown)")}
                      </span>
                    </div>
                    {data.sender.recipientEmail && (
                      <div data-testid="text-attribution-recipient">
                        <span className="text-muted-foreground">To: </span>
                        <span className="font-mono text-xs">{data.sender.recipientEmail}</span>
                      </div>
                    )}
                    {data.sender.subject && (
                      <div className="text-xs text-muted-foreground truncate" data-testid="text-attribution-subject">
                        Subject: {data.sender.subject}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm italic text-muted-foreground" data-testid="text-attribution-sender-empty">
                    Quote has no email source (manual entry).
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
