/**
 * Read-only admin console: Email-derived stub companies.
 *
 * Surfaces companies that look auto-created by the inbound-email pipeline
 * (no owner, no industry, 0 contacts) so an admin can review the volume
 * before any cleanup decision is made.
 *
 * READ-ONLY by contract: this page renders data only. There are no
 * archive / merge / delete actions wired up.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ShieldCheck, AlertTriangle, Mail, Building2, ExternalLink } from "lucide-react";

type Row = {
  companyId: string;
  companyName: string;
  organizationId: string | null;
  inboundEmailCount: number;
  threadCount: number;
  firstInboundAt: string | null;
  lastInboundAt: string | null;
  quoteOpportunityCount: number;
  freightOpportunityCount: number;
};

type Resp = {
  ok: true;
  generatedAt: string;
  organizationId: string;
  totalCompanies: number;
  matched: number;
  matchedWithInboundEmail: number;
  rows: Row[];
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function daysAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const d = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (d <= 0) return "today";
  if (d === 1) return "1 day ago";
  return `${d} days ago`;
}

export default function AdminEmailDerivedCompaniesPage(): JSX.Element {
  const { user } = useAuth();
  const [filter, setFilter] = useState("");

  const { data, isLoading, error } = useQuery<Resp>({
    queryKey: ["/api/admin/email-derived-companies"],
    enabled: !!user && user.role === "admin",
  });

  const filtered = useMemo(() => {
    if (!data?.rows) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return data.rows;
    return data.rows.filter((r) => r.companyName.toLowerCase().includes(q));
  }, [data, filter]);

  if (!user) return <div className="p-8" data-testid="text-loading">Loading…</div>;

  if (user.role !== "admin") {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Admin access required
            </CardTitle>
            <CardDescription data-testid="text-access-denied">
              This console is restricted to administrators.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-page-title">
            <Building2 className="h-6 w-6" />
            Email-Derived Companies
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Companies auto-created by the inbound-email pipeline that never matured into
            real customers — no owner, no industry, no saved contacts, but at least one
            inbound email landed against them. <strong>Read-only diagnostic view.</strong>
          </p>
        </div>
        <Badge variant="outline" className="text-emerald-700 border-emerald-300 dark:text-emerald-300 dark:border-emerald-800">
          <ShieldCheck className="h-3.5 w-3.5 mr-1" />
          Read-only
        </Badge>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total companies in org</CardDescription>
            <CardTitle className="text-2xl" data-testid="stat-total-companies">
              {isLoading ? "…" : (data?.totalCompanies ?? 0).toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Matching stub companies</CardDescription>
            <CardTitle className="text-2xl text-amber-600 dark:text-amber-400" data-testid="stat-matched">
              {isLoading ? "…" : (data?.matched ?? 0).toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>… with inbound email link</CardDescription>
            <CardTitle className="text-2xl" data-testid="stat-matched-with-email">
              {isLoading ? "…" : (data?.matchedWithInboundEmail ?? 0).toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Snapshot generated</CardDescription>
            <CardTitle className="text-sm font-mono" data-testid="text-generated-at">
              {isLoading ? "…" : fmtDate(data?.generatedAt ?? null)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Stub companies with inbound email
          </CardTitle>
          <CardDescription>
            Sorted by most recent inbound email. {data?.matched ?? 0} of {data?.totalCompanies ?? 0} companies match.
          </CardDescription>
          <div className="pt-2">
            <Input
              type="text"
              placeholder="Filter by company name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-sm"
              data-testid="input-filter-name"
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="py-12 text-center text-muted-foreground" data-testid="text-loading-rows">Loading…</div>
          )}
          {error && (
            <div className="py-12 text-center text-red-600" data-testid="text-error">
              Failed to load. {(error as Error).message}
            </div>
          )}
          {!isLoading && !error && filtered.length === 0 && (
            <div className="py-12 text-center text-muted-foreground" data-testid="text-empty">
              No matching stub companies found.
            </div>
          )}
          {!isLoading && !error && filtered.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead className="text-right">Inbound emails</TableHead>
                    <TableHead className="text-right">Threads</TableHead>
                    <TableHead>First inbound</TableHead>
                    <TableHead>Last inbound</TableHead>
                    <TableHead className="text-right">Quote opps</TableHead>
                    <TableHead className="text-right">Freight opps</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => (
                    <TableRow key={r.companyId} data-testid={`row-company-${r.companyId}`}>
                      <TableCell className="font-medium" data-testid={`text-name-${r.companyId}`}>
                        {r.companyName}
                      </TableCell>
                      <TableCell className="text-right tabular-nums" data-testid={`text-inbound-${r.companyId}`}>
                        {r.inboundEmailCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums" data-testid={`text-threads-${r.companyId}`}>
                        {r.threadCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div>{fmtDate(r.firstInboundAt)}</div>
                        <div className="text-muted-foreground">{daysAgo(r.firstInboundAt)}</div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div>{fmtDate(r.lastInboundAt)}</div>
                        <div className="text-muted-foreground">{daysAgo(r.lastInboundAt)}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums" data-testid={`text-qo-${r.companyId}`}>
                        {r.quoteOpportunityCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums" data-testid={`text-fo-${r.companyId}`}>
                        {r.freightOpportunityCount.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/companies/${r.companyId}`}
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                          data-testid={`link-open-${r.companyId}`}
                        >
                          Open <ExternalLink className="h-3 w-3" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">What this view is</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            A row appears here when a company in your org meets <em>all</em> of:
            no <code>owner_rep_id</code>, no <code>industry</code>, not archived,
            and zero rows in <code>contacts</code>.
          </p>
          <p>
            Inbound email evidence (<code>email_messages.linked_account_id</code>
            and <code>email_conversation_threads.linked_account_id</code>) is
            shown as columns rather than required as a filter, because in
            production those link columns are sparsely populated — most
            stub companies created by the email→company pipeline do not have
            their emails linked back to the company row. The "… with inbound
            email link" stat above tells you how many do.
          </p>
          <p>
            These are the typical signature of email-derived stub companies created
            by Tasks #1052 / #1056. The view does not delete, merge, or archive
            anything — use it to size the cleanup before deciding on the next step.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
