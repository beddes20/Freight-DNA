/**
 * Task #752 — Freight Capture Rep Audit (admin-only).
 *
 * Lists every name appearing as a "Rep" on at least one quote in the
 * configured lookback window with link / suppress / merge actions, so
 * an admin can clean up unlinked or wrong-role reps that have been
 * leaking into the Freight Capture funnel via email-signature ingestion.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  CheckCircle2, AlertTriangle, Link2, Ban, GitMerge, Loader2, RefreshCw, Search, ArrowLeft,
} from "lucide-react";
import type { FunnelRepAuditStatus } from "@shared/quoteOpportunitiesRoles";

type RepAuditRow = {
  repId: string;
  name: string;
  email: string | null;
  suppressed: boolean;
  linkedUserId: string | null;
  linkedUserName: string | null;
  linkedUserRole: string | null;
  quoteCount: number;
  lastQuoteAt: string | null;
  status: FunnelRepAuditStatus;
};

type RepAuditResponse = {
  ok: true;
  rows: RepAuditRow[];
  summary: {
    total: number;
    ok: number;
    wrongRole: number;
    unlinked: number;
    suppressed: number;
  };
  lookbackDays: number;
};

type OrgUser = { id: string; name: string; username: string; role: string };

type SortKey = "status" | "name" | "quoteCount" | "lastQuoteAt";

function StatusBadge({ status }: { status: FunnelRepAuditStatus }): JSX.Element {
  switch (status) {
    case "ok":
      return (
        <Badge variant="outline" className="text-emerald-700 border-emerald-300 dark:text-emerald-300 dark:border-emerald-800" data-testid={`badge-status-ok`}>
          <CheckCircle2 className="h-3 w-3 mr-1" />OK
        </Badge>
      );
    case "wrong_role":
      return (
        <Badge variant="outline" className="text-amber-700 border-amber-300 dark:text-amber-300 dark:border-amber-800" data-testid={`badge-status-wrong-role`}>
          <AlertTriangle className="h-3 w-3 mr-1" />Wrong role
        </Badge>
      );
    case "unlinked":
      return (
        <Badge variant="outline" className="text-orange-700 border-orange-300 dark:text-orange-300 dark:border-orange-800" data-testid={`badge-status-unlinked`}>
          <Link2 className="h-3 w-3 mr-1" />Unlinked
        </Badge>
      );
    case "suppressed":
      return (
        <Badge variant="outline" className="text-zinc-700 border-zinc-300 dark:text-zinc-300 dark:border-zinc-700" data-testid={`badge-status-suppressed`}>
          <Ban className="h-3 w-3 mr-1" />Suppressed
        </Badge>
      );
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function AdminFreightCaptureRepAuditPage(): JSX.Element {
  const { user } = useAuth();
  const { toast } = useToast();
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [linkDialog, setLinkDialog] = useState<{ rep: RepAuditRow } | null>(null);
  const [mergeDialog, setMergeDialog] = useState<{ rep: RepAuditRow } | null>(null);
  const [confirmMerge, setConfirmMerge] = useState<{ source: RepAuditRow; target: RepAuditRow } | null>(null);

  // Task #752 — admin-only by spec. Mutates rep identity (link / suppress /
  // merge) and changes who appears in the funnel rep dropdown / column /
  // rankings.
  const isAuthorized = !!user && user.role === "admin";

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<RepAuditResponse>({
    queryKey: ["/api/customer-quotes/rep-audit"],
    enabled: isAuthorized,
  });

  const sortedRows = useMemo(() => {
    const rows = data?.rows ?? [];
    const dir = sortDir === "asc" ? 1 : -1;
    const statusOrder: Record<FunnelRepAuditStatus, number> = {
      wrong_role: 0, unlinked: 1, suppressed: 2, ok: 3,
    };
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case "status":
          return (statusOrder[a.status] - statusOrder[b.status]) * dir
            || b.quoteCount - a.quoteCount;
        case "name":
          return a.name.localeCompare(b.name) * dir;
        case "quoteCount":
          return (a.quoteCount - b.quoteCount) * dir;
        case "lastQuoteAt": {
          const av = a.lastQuoteAt ? new Date(a.lastQuoteAt).getTime() : 0;
          const bv = b.lastQuoteAt ? new Date(b.lastQuoteAt).getTime() : 0;
          return (av - bv) * dir;
        }
      }
    });
  }, [data, sortKey, sortDir]);

  const suppressMutation = useMutation({
    mutationFn: async (input: { repId: string; suppressed: boolean }) => {
      return apiRequest("POST", `/api/customer-quotes/rep-audit/${input.repId}/suppress`, { suppressed: input.suppressed });
    },
    onSuccess: () => {
      toast({ title: "Updated", description: "Suppression updated." });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/rep-audit"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/funnel"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const linkMutation = useMutation({
    mutationFn: async (input: { repId: string; userId: string | null }) => {
      return apiRequest("POST", `/api/customer-quotes/rep-audit/${input.repId}/link`, { userId: input.userId });
    },
    onSuccess: () => {
      toast({ title: "Linked", description: "Rep updated." });
      setLinkDialog(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/rep-audit"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/funnel"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to link", description: err.message, variant: "destructive" });
    },
  });

  const mergeMutation = useMutation({
    mutationFn: async (input: { sourceRepId: string; targetRepId: string }) => {
      // apiRequest returns a raw Response — parse JSON so we can read the
      // server's `reassigned` count for the success toast.
      const res = await apiRequest("POST", `/api/customer-quotes/rep-audit/merge`, input);
      return (await res.json()) as { reassigned?: number };
    },
    onSuccess: (res) => {
      toast({ title: "Merged", description: `Reassigned ${res?.reassigned ?? 0} quotes.` });
      setMergeDialog(null);
      setConfirmMerge(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/rep-audit"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/funnel"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to merge", description: err.message, variant: "destructive" });
    },
  });

  if (!isAuthorized) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Access denied</CardTitle>
            <CardDescription>You need admin access to view the Freight Capture rep audit.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const summary = data?.summary;

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto" data-testid="page-rep-audit">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/freight-capture" data-testid="link-back-to-funnel">
              <Button variant="ghost" size="sm" className="gap-1 -ml-2">
                <ArrowLeft className="h-4 w-4" />Freight Capture
              </Button>
            </Link>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">
            Freight Capture rep audit
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-page-summary">
            {summary
              ? `${summary.total} reps on the funnel — ${summary.ok} OK, ${summary.wrongRole} wrong role, ${summary.unlinked} unlinked, ${summary.suppressed} suppressed`
              : "Loading rep audit…"}
            {data?.lookbackDays ? ` · last ${data.lookbackDays} days` : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh">
          <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Reps surfacing on quotes</CardTitle>
          <CardDescription>
            Names that have appeared as the "Rep" on at least one quote in the last 90 days.
            Use <strong>Link</strong> to map a rep to a real user, <strong>Suppress</strong> to hide a rep from the funnel without
            deleting their quotes, or <strong>Merge</strong> to combine duplicates.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />Loading…
            </div>
          )}
          {isError && (
            <div className="text-sm text-destructive py-4" data-testid="text-error">
              Failed to load rep audit: {(error as Error)?.message ?? "unknown error"}
            </div>
          )}
          {!isLoading && !isError && sortedRows.length === 0 && (
            <div className="text-sm text-muted-foreground py-8 text-center" data-testid="text-empty">
              No reps with quotes in the lookback window.
            </div>
          )}
          {!isLoading && !isError && sortedRows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTh label="Status" k="status" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} />
                  <SortableTh label="Rep name" k="name" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} />
                  <TableHead>Email</TableHead>
                  <TableHead>Linked user</TableHead>
                  <TableHead>Role</TableHead>
                  <SortableTh label="Quotes" k="quoteCount" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} className="text-right" />
                  <SortableTh label="Last quote" k="lastQuoteAt" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} />
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRows.map(row => (
                  <TableRow key={row.repId} data-testid={`row-rep-${row.repId}`}>
                    <TableCell><StatusBadge status={row.status} /></TableCell>
                    <TableCell className="font-medium" data-testid={`text-name-${row.repId}`}>{row.name}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{row.email ?? "—"}</TableCell>
                    <TableCell className="text-sm" data-testid={`text-linked-user-${row.repId}`}>
                      {row.linkedUserName ?? <span className="text-muted-foreground italic">unlinked</span>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" data-testid={`text-linked-role-${row.repId}`}>
                      {row.linkedUserRole ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums" data-testid={`text-quote-count-${row.repId}`}>{row.quoteCount}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDate(row.lastQuoteAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setLinkDialog({ rep: row })}
                          data-testid={`button-link-${row.repId}`}
                        >
                          <Link2 className="h-3.5 w-3.5 mr-1" />Link
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={suppressMutation.isPending}
                          onClick={() => suppressMutation.mutate({ repId: row.repId, suppressed: !row.suppressed })}
                          data-testid={`button-suppress-${row.repId}`}
                        >
                          <Ban className="h-3.5 w-3.5 mr-1" />{row.suppressed ? "Unsuppress" : "Suppress"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setMergeDialog({ rep: row })}
                          data-testid={`button-merge-${row.repId}`}
                        >
                          <GitMerge className="h-3.5 w-3.5 mr-1" />Merge
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {linkDialog && (
        <LinkRepDialog
          rep={linkDialog.rep}
          onClose={() => setLinkDialog(null)}
          onSubmit={(userId) => linkMutation.mutate({ repId: linkDialog.rep.repId, userId })}
          submitting={linkMutation.isPending}
        />
      )}

      {mergeDialog && (
        <MergeRepDialog
          source={mergeDialog.rep}
          rows={sortedRows}
          onClose={() => setMergeDialog(null)}
          onPick={(target) => setConfirmMerge({ source: mergeDialog.rep, target })}
        />
      )}

      <AlertDialog open={!!confirmMerge} onOpenChange={(o) => !o && setConfirmMerge(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm merge</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmMerge && (
                <>
                  Reassign all <strong>{confirmMerge.source.quoteCount}</strong> quotes from
                  {" "}<strong>{confirmMerge.source.name}</strong> to <strong>{confirmMerge.target.name}</strong>
                  {" "}and delete the source rep. This cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-merge-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-merge-confirm"
              onClick={() => {
                if (confirmMerge) {
                  mergeMutation.mutate({
                    sourceRepId: confirmMerge.source.repId,
                    targetRepId: confirmMerge.target.repId,
                  });
                }
              }}
            >
              {mergeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Merge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SortableTh(props: {
  label: string; k: SortKey;
  sortKey: SortKey; sortDir: "asc" | "desc";
  setSortKey: (k: SortKey) => void; setSortDir: (d: "asc" | "desc") => void;
  className?: string;
}): JSX.Element {
  const { label, k, sortKey, sortDir, setSortKey, setSortDir, className } = props;
  const active = sortKey === k;
  return (
    <TableHead
      className={`cursor-pointer select-none ${className ?? ""}`}
      onClick={() => {
        if (active) setSortDir(sortDir === "asc" ? "desc" : "asc");
        else { setSortKey(k); setSortDir("asc"); }
      }}
      data-testid={`th-sort-${k}`}
    >
      {label}{active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
    </TableHead>
  );
}

function LinkRepDialog(props: {
  rep: RepAuditRow;
  onClose: () => void;
  onSubmit: (userId: string | null) => void;
  submitting: boolean;
}): JSX.Element {
  const { rep, onClose, onSubmit, submitting } = props;
  const [search, setSearch] = useState("");

  const { data: usersData, isLoading } = useQuery<{ ok: true; users: OrgUser[] }>({
    queryKey: ["/api/customer-quotes/rep-audit/users", search],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (search) qs.set("q", search);
      const res = await fetch(`/api/customer-quotes/rep-audit/users?${qs.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link rep to user</DialogTitle>
          <DialogDescription>
            Pick a user to associate with <strong>{rep.name}</strong>. Only AM and NAM users will appear on the funnel.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              data-testid="input-link-search"
            />
          </div>
          <div className="max-h-72 overflow-y-auto border rounded">
            {isLoading && (
              <div className="p-3 text-sm text-muted-foreground">Loading…</div>
            )}
            {!isLoading && (usersData?.users ?? []).length === 0 && (
              <div className="p-3 text-sm text-muted-foreground">No users match.</div>
            )}
            {(usersData?.users ?? []).map(u => (
              <button
                key={u.id}
                type="button"
                disabled={submitting}
                onClick={() => onSubmit(u.id)}
                className="w-full text-left px-3 py-2 hover:bg-muted/40 flex items-center justify-between border-b last:border-b-0"
                data-testid={`button-pick-user-${u.id}`}
              >
                <div>
                  <div className="text-sm font-medium">{u.name}</div>
                  <div className="text-xs text-muted-foreground">{u.username}</div>
                </div>
                <Badge variant="outline" className="text-xs">{u.role}</Badge>
              </button>
            ))}
          </div>
        </div>
        <DialogFooter className="justify-between sm:justify-between">
          {rep.linkedUserId ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={() => onSubmit(null)}
              data-testid="button-unlink"
            >
              Unlink
            </Button>
          ) : <div />}
          <Button variant="outline" onClick={onClose} data-testid="button-link-cancel">Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MergeRepDialog(props: {
  source: RepAuditRow;
  rows: RepAuditRow[];
  onClose: () => void;
  onPick: (target: RepAuditRow) => void;
}): JSX.Element {
  const { source, rows, onClose, onPick } = props;
  const [targetId, setTargetId] = useState<string>("");
  const others = rows.filter(r => r.repId !== source.repId);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge rep</DialogTitle>
          <DialogDescription>
            Move all <strong>{source.quoteCount}</strong> quotes from <strong>{source.name}</strong> to another rep, then delete <strong>{source.name}</strong>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Select value={targetId} onValueChange={setTargetId}>
            <SelectTrigger data-testid="select-merge-target">
              <SelectValue placeholder="Pick the rep to keep" />
            </SelectTrigger>
            <SelectContent>
              {others.length === 0 && (
                <SelectItem value="_none" disabled>No other reps to merge into</SelectItem>
              )}
              {others.map(r => (
                <SelectItem key={r.repId} value={r.repId} data-testid={`option-merge-target-${r.repId}`}>
                  {r.name} {r.linkedUserName ? `(${r.linkedUserName})` : ""} — {r.quoteCount} quotes
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-merge-pick-cancel">Cancel</Button>
          <Button
            disabled={!targetId || targetId === "_none"}
            onClick={() => {
              const target = others.find(r => r.repId === targetId);
              if (target) onPick(target);
            }}
            data-testid="button-merge-continue"
          >Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
