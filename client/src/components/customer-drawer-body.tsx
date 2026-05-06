import { useQuery } from "@tanstack/react-query";
import { Loader2, Building2, Phone, Mail, FileText, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { registerDrawerRenderer, type DrawerSpec } from "@/components/detail-drawer";
import type { Company, Touchpoint } from "@shared/schema";

interface QuoteRow {
  id: string;
  originCity?: string | null;
  originState?: string | null;
  destCity?: string | null;
  destState?: string | null;
  equipment?: string | null;
  requestDate?: string | Date | null;
  outcomeStatus?: string | null;
}

function fmtDate(s: string | Date | null | undefined): string {
  if (!s) return "—";
  const d = typeof s === "string" ? new Date(s) : s;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function CustomerDrawerBody({ spec }: { spec: DrawerSpec }) {
  const id = spec.id;

  const companyQ = useQuery<Company>({
    queryKey: [`/api/companies/${id}`],
    staleTime: 60_000,
    retry: false,
  });

  const touchpointsQ = useQuery<Touchpoint[]>({
    queryKey: [`/api/companies/${id}/touchpoints`],
    staleTime: 30_000,
    retry: false,
  });

  const quotesQ = useQuery<QuoteRow[]>({
    queryKey: ["/api/customer-quotes/list", `customerId=${id}&pageSize=10`],
    queryFn: async () => {
      const res = await fetch(`/api/customer-quotes/list?customerId=${id}&pageSize=10`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load quotes");
      const json = await res.json();
      return Array.isArray(json) ? json : (json?.rows ?? json?.items ?? []);
    },
    staleTime: 30_000,
    retry: false,
  });

  const c = companyQ.data;
  const recentTouchpoints = (touchpointsQ.data ?? []).slice(0, 5);
  const openQuotes = (quotesQ.data ?? []).filter(q =>
    !q.outcomeStatus || ["pending", "quoted", "follow_up", "negotiating"].includes(String(q.outcomeStatus))
  ).slice(0, 5);

  return (
    <div className="space-y-5" data-testid={`drawer-body-customer-${id}`}>
      <section>
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
          <Building2 className="h-3.5 w-3.5" />
          Overview
        </div>
        {companyQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : !c ? (
          <p className="text-sm text-muted-foreground">Company details unavailable.</p>
        ) : (
          <div className="space-y-1.5 text-sm">
            {c.industry && (
              <div className="text-muted-foreground">
                Industry: <span className="text-foreground">{c.industry}</span>
              </div>
            )}
            {c.website && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Globe className="h-3.5 w-3.5" />
                <span className="truncate">{c.website}</span>
              </div>
            )}
            {c.tenderStyle && (
              <div>
                <Badge variant="secondary" data-testid={`drawer-tender-${id}`}>{c.tenderStyle}</Badge>
              </div>
            )}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <FileText className="h-3.5 w-3.5" />
            Open Quotes
          </div>
          <span className="text-[11px] text-muted-foreground tabular-nums">{openQuotes.length}</span>
        </div>
        {quotesQ.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading…
          </div>
        ) : openQuotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open quotes.</p>
        ) : (
          <ul className="space-y-1.5">
            {openQuotes.map(q => (
              <li
                key={q.id}
                className="text-sm border rounded-md px-2.5 py-1.5"
                data-testid={`drawer-quote-${q.id}`}
              >
                <div className="font-medium truncate">
                  {q.originCity ?? "?"}, {q.originState ?? "?"} → {q.destCity ?? "?"}, {q.destState ?? "?"}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <span>{q.equipment ?? "—"}</span>
                  <span>·</span>
                  <span>{fmtDate(q.requestDate)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <Phone className="h-3.5 w-3.5" />
            Recent Touchpoints
          </div>
          <span className="text-[11px] text-muted-foreground tabular-nums">{recentTouchpoints.length}</span>
        </div>
        {touchpointsQ.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading…
          </div>
        ) : recentTouchpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">No touchpoints yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {recentTouchpoints.map(t => (
              <li
                key={t.id}
                className="text-sm border rounded-md px-2.5 py-1.5"
                data-testid={`drawer-touchpoint-${t.id}`}
              >
                <div className="flex items-center gap-2">
                  {t.type === "email" ? <Mail className="h-3.5 w-3.5 text-muted-foreground" /> : <Phone className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className="capitalize">{t.type}</span>
                  <span className="text-xs text-muted-foreground ml-auto">{fmtDate(t.createdAt)}</span>
                </div>
                {t.notes && <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{t.notes}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

registerDrawerRenderer("customer", (spec) => <CustomerDrawerBody spec={spec} />);

export {};
