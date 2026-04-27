import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, ChevronRight, DollarSign, Loader2, Package, TrendingUp, UserPlus } from "lucide-react";
import { apiRequest, queryClient as appQueryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type RowType = "unworked_account" | "unattributed_lane" | "unassigned_contact";

interface UnworkedAccountRow {
  id: string;
  type: "unworked_account";
  companyId: string;
  companyName: string;
  margin: number;
  loads: number;
  contacts: Array<{ id: string; name: string; title: string | null; relationshipBase: string | null }>;
}

interface UnattributedLaneRow {
  id: string;
  type: "unattributed_lane";
  companyId: string;
  companyName: string;
  margin: number;
  loads: number;
  originCity: string | null;
  originState: string | null;
  destinationCity: string | null;
  destinationState: string | null;
  originLabel: string;
  destinationLabel: string;
  reason: "no_coverage" | "no_matching_lane" | "broad_matcher_suppressed";
  workedContacts: Array<{ id: string; name: string; title: string | null; relationshipBase: string }>;
}

interface UnassignedContactRow {
  id: string;
  type: "unassigned_contact";
  companyId: string;
  companyName: string;
  margin: number;
  loads: number;
  contactId: string;
  contactName: string;
  contactTitle: string | null;
}

type TriageRow = UnworkedAccountRow | UnattributedLaneRow | UnassignedContactRow;

interface TriageResponse {
  rows: TriageRow[];
  totalMargin: number;
  totalLoads: number;
  counts: Record<RowType, number>;
}

const BASE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "1st", label: "1st Base" },
  { value: "2nd", label: "2nd Base" },
  { value: "3rd", label: "3rd Base" },
  { value: "hr", label: "Home Run" },
];

function fmt$(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function baseLabel(b: string | null | undefined) {
  if (!b) return "—";
  const m = BASE_OPTIONS.find(o => o.value === b);
  return m ? m.label : b;
}

const TYPE_CONFIG: Record<RowType, { label: string; pluralLabel: string; icon: typeof Building2; tone: string }> = {
  unworked_account: { label: "Unworked Account", pluralLabel: "Unworked Accounts", icon: Building2, tone: "text-orange-600 dark:text-orange-400" },
  unattributed_lane: { label: "Unattributed Lane", pluralLabel: "Unattributed Lanes", icon: Package, tone: "text-amber-600 dark:text-amber-400" },
  unassigned_contact: { label: "Unassigned Contact", pluralLabel: "Unassigned Contacts", icon: UserPlus, tone: "text-blue-600 dark:text-blue-400" },
};

const TRIAGE_QUERY_KEY = ["/api/freight-attribution-triage"] as const;

function invalidateAll() {
  appQueryClient.invalidateQueries({ queryKey: TRIAGE_QUERY_KEY });
  appQueryClient.invalidateQueries({ queryKey: ["/api/relationship-freight-summary"] });
  appQueryClient.invalidateQueries({ queryKey: ["/api/dashboard-relationship-summary"] });
  appQueryClient.invalidateQueries({ queryKey: ["/api/dashboard/summary"] });
  appQueryClient.invalidateQueries({ queryKey: ["/api/relationship-base-distribution"] });
  // Company-level summaries are keyed per company; invalidate the prefix.
  appQueryClient.invalidateQueries({ queryKey: ["/api/companies"] });
}

// Optimistic helper: drops a row from the cached triage feed immediately so the
// worklist reflects a successful one-click resolution before the server round-
// trip completes. Returns a snapshot for rollback on error.
function optimisticallyRemoveRow(rowId: string): TriageResponse | undefined {
  const snapshot = appQueryClient.getQueryData<TriageResponse>(TRIAGE_QUERY_KEY);
  if (!snapshot) return undefined;
  const remaining = snapshot.rows.filter(r => r.id !== rowId);
  const counts: Record<RowType, number> = {
    unworked_account: remaining.filter(r => r.type === "unworked_account").length,
    unattributed_lane: remaining.filter(r => r.type === "unattributed_lane").length,
    unassigned_contact: remaining.filter(r => r.type === "unassigned_contact").length,
  };
  appQueryClient.setQueryData<TriageResponse>(TRIAGE_QUERY_KEY, {
    rows: remaining,
    totalMargin: remaining.reduce((s, r) => s + r.margin, 0),
    totalLoads: remaining.reduce((s, r) => s + r.loads, 0),
    counts,
  });
  return snapshot;
}

function rollbackTriageCache(snapshot: TriageResponse | undefined) {
  if (snapshot) appQueryClient.setQueryData<TriageResponse>(TRIAGE_QUERY_KEY, snapshot);
}

export default function FreightTriagePage() {
  const [typeFilter, setTypeFilter] = useState<"all" | RowType>("all");
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [baseFilter, setBaseFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data, isLoading, isError } = useQuery<TriageResponse>({
    queryKey: TRIAGE_QUERY_KEY,
  });

  const allRows = data?.rows ?? [];

  const accountOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of allRows) map.set(r.companyId, r.companyName);
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allRows]);

  // Base-level filter applies to the suggested contact for each row:
  //   - Unworked: when set, the picker pre-selects this base AND the row only
  //     shows if the account has at least one contact (any will do — none have
  //     a base yet by definition).
  //   - Unattributed: row is shown only when at least one worked contact at
  //     the account has the chosen base (since picking that contact will roll
  //     the lane up under their base).
  //   - Unassigned: row is shown only when this base would be a candidate
  //     fix (always true) and the picker pre-selects this base.
  const filteredRows = useMemo(() => {
    return allRows.filter(r => {
      if (typeFilter !== "all" && r.type !== typeFilter) return false;
      if (accountFilter !== "all" && r.companyId !== accountFilter) return false;
      if (baseFilter !== "all") {
        if (r.type === "unattributed_lane") {
          if (!r.workedContacts.some(c => c.relationshipBase === baseFilter)) return false;
        }
        // For unworked & unassigned, baseFilter just changes the picker default,
        // so all rows remain visible.
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${r.companyName} ${r.type === "unattributed_lane" ? `${r.originLabel} ${r.destinationLabel}` : ""} ${r.type === "unassigned_contact" ? r.contactName : ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allRows, typeFilter, accountFilter, baseFilter, search]);

  const filteredMargin = filteredRows.reduce((s, r) => s + r.margin, 0);
  const filteredLoads = filteredRows.reduce((s, r) => s + r.loads, 0);

  return (
    <div className="container max-w-6xl py-6 space-y-4" data-testid="page-freight-triage">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-amber-500" />
          <h1 className="text-2xl font-semibold" data-testid="text-freight-triage-title">Freight Attribution Triage</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Margin-sorted gaps from your relationship-freight book. Resolve a row in one click and the matching callout disappears from the dashboard portlet.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile
          icon={DollarSign}
          label="Potential margin to recover"
          value={fmt$(filteredMargin)}
          subtitle={`${filteredLoads.toLocaleString()} loads`}
          testId="tile-triage-margin"
        />
        <SummaryTile
          icon={Building2}
          label="Unworked accounts"
          value={String(data?.counts.unworked_account ?? 0)}
          subtitle="No contact has a base set"
          testId="tile-triage-unworked"
        />
        <SummaryTile
          icon={Package}
          label="Unattributed lanes"
          value={String(data?.counts.unattributed_lane ?? 0)}
          subtitle="On worked accounts, unclaimed"
          testId="tile-triage-lanes"
        />
        <SummaryTile
          icon={UserPlus}
          label="Unassigned contacts"
          value={String(data?.counts.unassigned_contact ?? 0)}
          subtitle="Has lanes, no base"
          testId="tile-triage-unassigned"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <CardTitle className="text-sm">Worklist</CardTitle>
            <div className="flex flex-col md:flex-row gap-2 md:items-center">
              <Input
                placeholder="Search account, lane, or contact…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-8 text-xs md:w-64"
                data-testid="input-triage-search"
              />
              <Select value={accountFilter} onValueChange={setAccountFilter}>
                <SelectTrigger className="h-8 text-xs md:w-56" data-testid="select-triage-account">
                  <SelectValue placeholder="All accounts" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All accounts</SelectItem>
                  {accountOptions.map(([id, name]) => (
                    <SelectItem key={id} value={id}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={baseFilter} onValueChange={setBaseFilter}>
                <SelectTrigger className="h-8 text-xs md:w-40" data-testid="select-triage-base">
                  <SelectValue placeholder="Any base" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any base</SelectItem>
                  {BASE_OPTIONS.map(o => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Tabs value={typeFilter} onValueChange={v => setTypeFilter(v as typeof typeFilter)} className="mt-2">
            <TabsList data-testid="tabs-triage-type">
              <TabsTrigger value="all" data-testid="tab-triage-all">All ({data?.rows.length ?? 0})</TabsTrigger>
              <TabsTrigger value="unworked_account" data-testid="tab-triage-unworked">Unworked ({data?.counts.unworked_account ?? 0})</TabsTrigger>
              <TabsTrigger value="unattributed_lane" data-testid="tab-triage-lanes">Lanes ({data?.counts.unattributed_lane ?? 0})</TabsTrigger>
              <TabsTrigger value="unassigned_contact" data-testid="tab-triage-unassigned">Contacts ({data?.counts.unassigned_contact ?? 0})</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="space-y-2" data-testid="state-triage-loading">
              {[0, 1, 2].map(i => <Skeleton key={i} className="h-24" />)}
            </div>
          ) : isError ? (
            <div className="py-8 text-center text-sm text-destructive" data-testid="state-triage-error">
              Failed to load triage data. Try again later.
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground" data-testid="state-triage-empty">
              {allRows.length === 0
                ? "No attribution gaps detected — every account is worked and every lane is claimed."
                : "No rows match these filters."}
            </div>
          ) : (
            <ul className="divide-y divide-border" data-testid="list-triage-rows">
              {filteredRows.map(row => (
                <li key={row.id} className="py-3" data-testid={`row-triage-${row.id}`}>
                  <TriageRowCard row={row} baseFilter={baseFilter} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryTile({ icon: Icon, label, value, subtitle, testId }: {
  icon: typeof DollarSign;
  label: string;
  value: string;
  subtitle: string;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="w-3.5 h-3.5" />
          <span>{label}</span>
        </div>
        <div className="mt-1 text-2xl font-semibold" data-testid={`${testId}-value`}>{value}</div>
        <div className="text-[11px] text-muted-foreground">{subtitle}</div>
      </CardContent>
    </Card>
  );
}

function TriageRowCard({ row, baseFilter }: { row: TriageRow; baseFilter: string }) {
  const cfg = TYPE_CONFIG[row.type];
  const Icon = cfg.icon;
  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
      <div className="md:col-span-7 space-y-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className={`w-3.5 h-3.5 ${cfg.tone}`} />
          <span className={`font-medium ${cfg.tone}`}>{cfg.label}</span>
          <span>·</span>
          <Link href={`/companies/${row.companyId}`} className="hover:underline" data-testid={`link-row-company-${row.companyId}`}>
            {row.companyName}
          </Link>
        </div>
        {row.type === "unworked_account" && (
          <div className="text-xs text-foreground">
            No contact at this account has a relationship base set. Pick a contact to mark as your starting point.
          </div>
        )}
        {row.type === "unattributed_lane" && (
          <div className="text-xs text-foreground">
            <span className="font-medium">{row.originLabel}</span>
            <ChevronRight className="inline w-3 h-3 mx-0.5 text-muted-foreground" />
            <span className="font-medium">{row.destinationLabel}</span>
            <span className="ml-2 text-muted-foreground" data-testid={`text-lane-reason-${row.id}`}>{laneReasonText(row.reason)}</span>
          </div>
        )}
        {row.type === "unassigned_contact" && (
          <div className="text-xs text-foreground">
            <span className="font-medium">{row.contactName}</span>
            {row.contactTitle && <span className="text-muted-foreground"> · {row.contactTitle}</span>}
            <span className="ml-2 text-muted-foreground">has lanes but no relationship base.</span>
          </div>
        )}
      </div>

      <div className="md:col-span-2 flex md:flex-col gap-3 md:gap-0 text-xs">
        <div>
          <div className="text-[11px] text-muted-foreground">Margin</div>
          <div className="font-semibold tabular-nums" data-testid={`text-row-margin-${row.id}`}>{fmt$(row.margin)}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">Loads</div>
          <div className="font-semibold tabular-nums">{row.loads.toLocaleString()}</div>
        </div>
      </div>

      <div className="md:col-span-3">
        {row.type === "unworked_account" && <UnworkedAction row={row} baseFilter={baseFilter} />}
        {row.type === "unattributed_lane" && <UnattributedAction row={row} baseFilter={baseFilter} />}
        {row.type === "unassigned_contact" && <UnassignedContactAction row={row} baseFilter={baseFilter} />}
      </div>
    </div>
  );
}

function laneReasonText(reason: "no_coverage" | "no_matching_lane" | "broad_matcher_suppressed") {
  if (reason === "no_coverage") return "No worked contact at this account has any lane data.";
  if (reason === "broad_matcher_suppressed") return "Broad state matcher suppressed by a more specific lane.";
  return "No worked contact's lanes cover this O/D.";
}

// ── Inline action: Unworked account ─────────────────────────────────────────
function UnworkedAction({ row, baseFilter }: { row: UnworkedAccountRow; baseFilter: string }) {
  const { toast } = useToast();
  const [contactId, setContactId] = useState<string>(row.contacts[0]?.id ?? "");
  const initialBase = baseFilter !== "all" ? baseFilter : "1st";
  const [base, setBase] = useState<string>(initialBase);

  // Keep the base picker in sync with the page-level base filter so that
  // changing the filter while a row is mounted updates its default selection.
  useEffect(() => {
    setBase(baseFilter !== "all" ? baseFilter : "1st");
  }, [baseFilter]);

  // If the contacts list shifts (e.g. cache update) and the current selection
  // is no longer present, fall back to the first available contact.
  useEffect(() => {
    if (!row.contacts.some(c => c.id === contactId)) {
      setContactId(row.contacts[0]?.id ?? "");
    }
  }, [row.contacts, contactId]);

  const mutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/contacts/${contactId}`, { relationshipBase: base }),
    onMutate: () => {
      // Optimistic: drop this row from the cached worklist immediately.
      const snapshot = optimisticallyRemoveRow(row.id);
      return { snapshot };
    },
    onSuccess: () => {
      toast({ title: "Base set", description: "Contact marked as your starting relationship at this account." });
      invalidateAll();
    },
    onError: (_err, _vars, ctx) => {
      rollbackTriageCache(ctx?.snapshot);
      toast({ title: "Error", description: "Failed to set base.", variant: "destructive" });
    },
  });

  if (row.contacts.length === 0) {
    return (
      <Link href={`/companies/${row.companyId}`} className="text-xs underline" data-testid={`link-add-contact-${row.companyId}`}>
        Add a contact →
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Select value={contactId} onValueChange={setContactId}>
        <SelectTrigger className="h-8 text-xs" data-testid={`select-unworked-contact-${row.companyId}`}>
          <SelectValue placeholder="Pick contact" />
        </SelectTrigger>
        <SelectContent>
          {row.contacts.map(c => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}{c.title ? ` · ${c.title}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex gap-2">
        <Select value={base} onValueChange={setBase}>
          <SelectTrigger className="h-8 text-xs" data-testid={`select-unworked-base-${row.companyId}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BASE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          className="h-8 text-xs"
          disabled={!contactId || mutation.isPending}
          onClick={() => mutation.mutate()}
          data-testid={`button-unworked-save-${row.companyId}`}
        >
          {mutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Set"}
        </Button>
      </div>
    </div>
  );
}

// ── Inline action: Unattributed lane ────────────────────────────────────────
function UnattributedAction({ row, baseFilter }: { row: UnattributedLaneRow; baseFilter: string }) {
  const { toast } = useToast();
  // When a base filter is active, default the picker to the first worked contact
  // matching that base (otherwise fall back to the first worked contact).
  const pickPreferredContact = (filter: string) => {
    if (filter !== "all") {
      const match = row.workedContacts.find(c => c.relationshipBase === filter);
      if (match) return match;
    }
    return row.workedContacts[0];
  };
  const [contactId, setContactId] = useState<string>(pickPreferredContact(baseFilter)?.id ?? "");

  // Re-derive the default contact whenever the base filter changes or the
  // worked-contacts list shifts. If the user's current selection no longer
  // matches the active filter (or has disappeared), snap it to the
  // best-matching contact.
  useEffect(() => {
    const current = row.workedContacts.find(c => c.id === contactId);
    const stillMatchesFilter = baseFilter === "all"
      || (current?.relationshipBase === baseFilter);
    if (!current || !stillMatchesFilter) {
      const next = pickPreferredContact(baseFilter);
      setContactId(next?.id ?? "");
    }
    // pickPreferredContact closes over row.workedContacts, so depending on the
    // list + filter + current selection is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseFilter, row.workedContacts]);

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/contacts/${contactId}/lane-attributions`, {
      originCity: row.originCity,
      originState: row.originState,
      destinationCity: row.destinationCity,
      destinationState: row.destinationState,
      source: "manual",
      notes: `Triage: ${row.originLabel} → ${row.destinationLabel}`,
    }),
    onMutate: () => {
      const snapshot = optimisticallyRemoveRow(row.id);
      return { snapshot };
    },
    onSuccess: () => {
      toast({ title: "Lane attributed", description: "This lane is now claimed by the contact." });
      invalidateAll();
    },
    onError: (_err, _vars, ctx) => {
      rollbackTriageCache(ctx?.snapshot);
      toast({ title: "Error", description: "Failed to attribute lane.", variant: "destructive" });
    },
  });

  if (row.workedContacts.length === 0) {
    // No worked contacts at this company — point to the company so the user can fix it.
    return (
      <Link href={`/companies/${row.companyId}`} className="text-xs underline" data-testid={`link-open-company-${row.companyId}`}>
        Open account →
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Select value={contactId} onValueChange={setContactId}>
        <SelectTrigger className="h-8 text-xs" data-testid={`select-lane-contact-${row.id}`}>
          <SelectValue placeholder="Pick contact" />
        </SelectTrigger>
        <SelectContent>
          {row.workedContacts.map(c => (
            <SelectItem key={c.id} value={c.id}>
              {c.name} ({baseLabel(c.relationshipBase)})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        className="h-8 text-xs"
        disabled={!contactId || mutation.isPending}
        onClick={() => mutation.mutate()}
        data-testid={`button-lane-attribute-${row.id}`}
      >
        {mutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Attribute"}
      </Button>
    </div>
  );
}

// ── Inline action: Unassigned contact ───────────────────────────────────────
function UnassignedContactAction({ row, baseFilter }: { row: UnassignedContactRow; baseFilter: string }) {
  const { toast } = useToast();
  const initialBase = baseFilter !== "all" ? baseFilter : "1st";
  const [base, setBase] = useState<string>(initialBase);

  // Keep the base picker in sync with the page-level base filter.
  useEffect(() => {
    setBase(baseFilter !== "all" ? baseFilter : "1st");
  }, [baseFilter]);

  const mutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/contacts/${row.contactId}`, { relationshipBase: base }),
    onMutate: () => {
      const snapshot = optimisticallyRemoveRow(row.id);
      return { snapshot };
    },
    onSuccess: () => {
      toast({ title: "Base set", description: "Contact's lanes will now roll up under their base level." });
      invalidateAll();
    },
    onError: (_err, _vars, ctx) => {
      rollbackTriageCache(ctx?.snapshot);
      toast({ title: "Error", description: "Failed to set base.", variant: "destructive" });
    },
  });

  return (
    <div className="flex gap-2">
      <Select value={base} onValueChange={setBase}>
        <SelectTrigger className="h-8 text-xs" data-testid={`select-unassigned-base-${row.contactId}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BASE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        className="h-8 text-xs"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
        data-testid={`button-unassigned-save-${row.contactId}`}
      >
        {mutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Set"}
      </Button>
    </div>
  );
}
