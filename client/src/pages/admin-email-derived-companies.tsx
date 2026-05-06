/**
 * Read-only admin console: Email-derived stub companies (with triage buckets).
 *
 * Surfaces companies that look auto-created by the inbound-email pipeline
 * (no owner, no industry, 0 contacts) so an admin can review the volume
 * AND triage each row into one of three buckets:
 *
 *   - real_incomplete       — has activity; likely worth promoting
 *   - duplicate_candidate   — name resembles an existing real customer
 *   - low_value_stub        — minimal evidence; likely safe to suppress later
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ShieldCheck, AlertTriangle, Mail, Building2, ExternalLink, Sparkles } from "lucide-react";

type Bucket = "real_incomplete" | "duplicate_candidate" | "low_value_stub";

type SimilarityHint = {
  companyId: string;
  companyName: string;
  score: number;
};

type Row = {
  companyId: string;
  companyName: string;
  organizationId: string | null;
  firstSeenAt: string | null;
  inboundEmailCount: number;
  threadCount: number;
  firstInboundAt: string | null;
  lastInboundAt: string | null;
  quoteOpportunityCount: number;
  freightOpportunityCount: number;
  bucket: Bucket;
  bucketReason: string;
  similarityHints: SimilarityHint[];
};

type Resp = {
  ok: true;
  generatedAt: string;
  organizationId: string;
  totalCompanies: number;
  matched: number;
  matchedWithInboundEmail: number;
  bucketCounts: Record<Bucket, number>;
  rows: Row[];
};

const BUCKET_LABEL: Record<Bucket, string> = {
  real_incomplete: "Likely real, incomplete",
  duplicate_candidate: "Likely duplicate / merge",
  low_value_stub: "Likely low-value stub",
};

const BUCKET_TONE: Record<Bucket, string> = {
  real_incomplete: "text-emerald-700 border-emerald-300 dark:text-emerald-300 dark:border-emerald-800",
  duplicate_candidate: "text-amber-700 border-amber-300 dark:text-amber-300 dark:border-amber-800",
  low_value_stub: "text-zinc-600 border-zinc-300 dark:text-zinc-400 dark:border-zinc-700",
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

function BucketBadge({ bucket }: { bucket: Bucket }): JSX.Element {
  return (
    <Badge variant="outline" className={BUCKET_TONE[bucket]} data-testid={`badge-bucket-${bucket}`}>
      {BUCKET_LABEL[bucket]}
    </Badge>
  );
}

export default function AdminEmailDerivedCompaniesPage(): JSX.Element {
  const { user } = useAuth();
  const [filter, setFilter] = useState("");
  const [bucketFilter, setBucketFilter] = useState<Bucket | "all">("all");

  const { data, isLoading, error } = useQuery<Resp>({
    queryKey: ["/api/admin/email-derived-companies"],
    enabled: !!user && user.role === "admin",
  });

  const filtered = useMemo(() => {
    if (!data?.rows) return [];
    const q = filter.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (bucketFilter !== "all" && r.bucket !== bucketFilter) return false;
      if (q && !r.companyName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, filter, bucketFilter]);

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

  const counts = data?.bucketCounts ?? { real_incomplete: 0, duplicate_candidate: 0, low_value_stub: 0 };

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
            real customers — no owner, no industry, no saved contacts. Each row is
            classified into a triage bucket so you can decide{" "}
            <strong>promote</strong>, <strong>merge-review</strong>, or{" "}
            <strong>likely suppress later</strong>. <strong>Read-only diagnostic view.</strong>
          </p>
        </div>
        <Badge variant="outline" className="text-emerald-700 border-emerald-300 dark:text-emerald-300 dark:border-emerald-800">
          <ShieldCheck className="h-3.5 w-3.5 mr-1" />
          Read-only
        </Badge>
      </div>

      {/* Top-level stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
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

      {/* Bucket-count tiles double as filter chips */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {(["real_incomplete", "duplicate_candidate", "low_value_stub"] as Bucket[]).map((b) => {
          const active = bucketFilter === b;
          return (
            <button
              key={b}
              type="button"
              onClick={() => setBucketFilter(active ? "all" : b)}
              className={`text-left rounded-lg border p-4 transition-colors hover:bg-muted/40 ${
                active ? "ring-2 ring-primary" : ""
              }`}
              data-testid={`filter-bucket-${b}`}
            >
              <div className="flex items-center justify-between mb-2">
                <BucketBadge bucket={b} />
                {active && <span className="text-xs text-primary">Filtered</span>}
              </div>
              <div className="text-3xl font-semibold tabular-nums" data-testid={`stat-bucket-${b}`}>
                {isLoading ? "…" : (counts[b] ?? 0).toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {b === "real_incomplete" && "Has freight/quote/email activity — likely promote"}
                {b === "duplicate_candidate" && "Name resembles an existing real customer — review for merge"}
                {b === "low_value_stub" && "Minimal evidence — likely safe to suppress later"}
              </div>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Stub companies — triage list
          </CardTitle>
          <CardDescription>
            Sorted by most recent activity. Showing {filtered.length} of {data?.matched ?? 0} matching rows.
          </CardDescription>
          <div className="pt-2 flex flex-wrap items-center gap-2">
            <Input
              type="text"
              placeholder="Filter by company name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-sm"
              data-testid="input-filter-name"
            />
            {bucketFilter !== "all" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBucketFilter("all")}
                data-testid="button-clear-bucket-filter"
              >
                Clear bucket filter
              </Button>
            )}
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
                    <TableHead>Bucket</TableHead>
                    <TableHead>First seen</TableHead>
                    <TableHead className="text-right">QO</TableHead>
                    <TableHead className="text-right">FO</TableHead>
                    <TableHead className="text-right">Inbound</TableHead>
                    <TableHead className="text-right">Threads</TableHead>
                    <TableHead>Last inbound</TableHead>
                    <TableHead>Possible duplicates</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => (
                    <TableRow key={r.companyId} data-testid={`row-company-${r.companyId}`}>
                      <TableCell className="font-medium align-top" data-testid={`text-name-${r.companyId}`}>
                        <div>{r.companyName}</div>
                        <div className="text-xs text-muted-foreground" data-testid={`text-saved-contacts-${r.companyId}`}>
                          0 saved contacts
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <BucketBadge bucket={r.bucket} />
                        <div className="text-xs text-muted-foreground mt-1 max-w-xs" data-testid={`text-bucket-reason-${r.companyId}`}>
                          {r.bucketReason}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs align-top" data-testid={`text-first-seen-${r.companyId}`}>
                        <div>{fmtDate(r.firstSeenAt)}</div>
                        <div className="text-muted-foreground">{daysAgo(r.firstSeenAt)}</div>
                        <div className="text-[10px] text-muted-foreground italic">derived</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums align-top" data-testid={`text-qo-${r.companyId}`}>
                        {r.quoteOpportunityCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums align-top" data-testid={`text-fo-${r.companyId}`}>
                        {r.freightOpportunityCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums align-top" data-testid={`text-inbound-${r.companyId}`}>
                        {r.inboundEmailCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums align-top" data-testid={`text-threads-${r.companyId}`}>
                        {r.threadCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs align-top">
                        <div>{fmtDate(r.lastInboundAt)}</div>
                        <div className="text-muted-foreground">{daysAgo(r.lastInboundAt)}</div>
                      </TableCell>
                      <TableCell className="align-top">
                        {r.similarityHints.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <ul className="space-y-1" data-testid={`hints-${r.companyId}`}>
                            {r.similarityHints.map((h) => (
                              <li key={h.companyId} className="text-xs flex items-center gap-1">
                                <Sparkles className="h-3 w-3 text-amber-500 shrink-0" />
                                <Link
                                  href={`/companies/${h.companyId}`}
                                  className="text-blue-600 hover:underline truncate"
                                  data-testid={`hint-${r.companyId}-${h.companyId}`}
                                >
                                  {h.companyName}
                                </Link>
                                <span className="text-muted-foreground tabular-nums">
                                  ({(h.score * 100).toFixed(0)}%)
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
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
          <CardTitle className="text-sm">How rows are classified</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            A row appears here when a company in your org meets <em>all</em> of:
            no <code>owner_rep_id</code>, no <code>industry</code>, not archived,
            and zero rows in <code>contacts</code>.
          </p>
          <p>
            <strong>First seen</strong> is derived (the <code>companies</code> table
            has no <code>created_at</code> column) — it's the earliest of the first
            inbound email, first quote opportunity, or first freight opportunity tied
            to the company.
          </p>
          <p>
            <strong>Possible duplicates</strong> are computed by comparing the stub
            name against every real company in your org (any one of: has owner, has
            industry, has contacts, or archived). Names are normalized (lowercased,
            corporate suffixes like <code>inc</code>, <code>llc</code>,{" "}
            <code>logistics</code>, <code>trucking</code> removed) and scored with a
            Dice coefficient on character bigrams. Hints with score ≥ 45% are shown;
            ≥ 65% promotes the row to the <em>duplicate / merge</em> bucket.
          </p>
          <p>
            <strong>Bucket rules:</strong>{" "}
            <em>duplicate / merge</em> if the top similarity hint is ≥ 65%;
            otherwise <em>likely real, incomplete</em> if there is any quote
            opportunity, any inbound email, any thread, or ≥ 3 freight
            opportunities; otherwise <em>likely low-value stub</em>.
          </p>
          <p>
            Inbound email evidence (<code>email_messages.linked_account_id</code>
            and <code>email_conversation_threads.linked_account_id</code>) is shown
            as columns rather than required as a filter, because in production those
            link columns are sparsely populated — most stub companies created by the
            email→company pipeline do not have their emails linked back to the
            company row. The "… with inbound email link" stat above tells you how
            many do.
          </p>
          <p>
            The view does not delete, merge, or archive anything — use it to triage
            before deciding on the next step.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
