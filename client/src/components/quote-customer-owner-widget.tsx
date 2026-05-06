// Account Owner widget for the company-detail Overview tab. (Originally
// shipped as Task #1012 "Quote Owner Rep" — relabeled to Account Owner
// as part of the unification on `companies.ownerRepId`.)
//
// NOTE: this widget continues to write to `quote_customers.owner_rep_id`
// for backward-compat. The canonical Account Owner field lives on
// `companies.ownerRepId` and is edited from the Intel tab Account
// Information portlet. Quote Requests Rep fallback now reads from the
// canonical field — this widget remains as a secondary surface during
// burn-in and will be retired once telemetry confirms zero divergence.
//
// Empty state ("Not yet a quote customer") is the honest answer when
// the company hasn't received any quotes yet — no row is created
// pre-emptively here.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { UserCircle2 } from "lucide-react";

type Rep = { id: string; organizationId: string; name: string; email: string | null };

// Snapshot endpoint shape we depend on. Only `reps` is needed; other
// fields are ignored to keep this widget independent of the larger
// quote-requests page contract.
type SnapshotForReps = { reps: Rep[] };

type CustomerLookup = {
  customer: {
    id: string;
    name: string;
    ownerRepId: string | null;
  };
  ownerRepName: string | null;
};

interface Props {
  companyName: string;
}

export function QuoteCustomerOwnerWidget({ companyName }: Props) {
  const { toast } = useToast();
  const { user } = useAuth();
  // Task #1012 — must mirror the server-side guard
  // (`isRepAuditAdmin` in server/routes/customerQuotes.ts). Non-admins
  // see the current owner read-only; the picker + Save button only
  // render for admins so we don't tease an action that will 403.
  const canEdit = user?.role === "admin";
  const [pendingRepId, setPendingRepId] = useState<string | null>(null);

  // 404 is the expected "no quote_customer yet" path; treat it as data,
  // not error, so the empty state renders cleanly.
  const customerQuery = useQuery<CustomerLookup | null>({
    queryKey: ["/api/customer-quotes/customers/by-name", companyName],
    queryFn: async () => {
      const res = await fetch(
        `/api/customer-quotes/customers/by-name/${encodeURIComponent(companyName)}`,
        { credentials: "include" },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to load quote customer");
      return res.json();
    },
    enabled: !!companyName,
  });

  // Reps come from the snapshot endpoint (already filtered to
  // customer-facing, non-suppressed reps server-side).
  const snapshotQuery = useQuery<SnapshotForReps>({
    queryKey: ["/api/customer-quotes/snapshot"],
    queryFn: async () => {
      const res = await fetch(`/api/customer-quotes/snapshot`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load reps");
      return res.json();
    },
  });

  const customer = customerQuery.data?.customer ?? null;
  const ownerRepName = customerQuery.data?.ownerRepName ?? null;
  const reps = useMemo(() => snapshotQuery.data?.reps ?? [], [snapshotQuery.data]);

  // Sync the local select value to whatever the server says is current,
  // so re-opening the page doesn't show a stale picked-but-not-saved value.
  useEffect(() => {
    setPendingRepId(customer?.ownerRepId ?? null);
  }, [customer?.ownerRepId]);

  const setOwnerMutation = useMutation({
    mutationFn: async (ownerRepId: string | null) => {
      if (!customer) throw new Error("No quote customer to update");
      return apiRequest(
        "PATCH",
        `/api/customer-quotes/customers/${customer.id}/owner`,
        { ownerRepId },
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["/api/customer-quotes/customers/by-name", companyName],
      });
      toast({ title: "Account Owner updated" });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Could not update Account Owner";
      toast({ title: "Update failed", description: msg, variant: "destructive" });
    },
  });

  if (customerQuery.isLoading) {
    return (
      <Card data-testid="card-quote-customer-owner">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <UserCircle2 className="h-4 w-4" /> Account Owner
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!customer) {
    return (
      <Card data-testid="card-quote-customer-owner">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <UserCircle2 className="h-4 w-4" /> Account Owner
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p
            className="text-xs text-muted-foreground"
            data-testid="text-quote-customer-empty"
          >
            Not yet a quote customer. The owner rep can be set after this
            account receives its first quote request.
          </p>
        </CardContent>
      </Card>
    );
  }

  const dirty = (pendingRepId ?? null) !== (customer.ownerRepId ?? null);
  const selectValue = pendingRepId ?? "__none__";

  return (
    <Card data-testid="card-quote-customer-owner">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <UserCircle2 className="h-4 w-4" /> Account Owner
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Current:</span>
          {ownerRepName ? (
            <Badge variant="secondary" data-testid="badge-current-owner-rep">
              {ownerRepName}
            </Badge>
          ) : (
            <span data-testid="text-no-owner-rep">No owner set</span>
          )}
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
            <Select
              value={selectValue}
              onValueChange={(v) => setPendingRepId(v === "__none__" ? null : v)}
            >
              <SelectTrigger className="h-8 text-xs" data-testid="select-owner-rep">
                <SelectValue placeholder="Pick a rep…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__" data-testid="option-owner-rep-none">
                  No owner
                </SelectItem>
                {reps.map((r) => (
                  <SelectItem
                    key={r.id}
                    value={r.id}
                    data-testid={`option-owner-rep-${r.id}`}
                  >
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              size="sm"
              disabled={!dirty || setOwnerMutation.isPending}
              onClick={() => setOwnerMutation.mutate(pendingRepId ?? null)}
              data-testid="button-save-owner-rep"
            >
              {setOwnerMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground leading-snug">
          {canEdit
            ? "Account Owner is the fallback rep on inbound quote requests when the sender/inbox doesn't already resolve to one, and is shown on unassigned Quote Requests rows linked to this account. The canonical Account Owner field lives on the Intel tab → Account Information portlet."
            : "Account Owner is the fallback for unassigned quote requests. Only admins can change it."}
        </p>
      </CardContent>
    </Card>
  );
}
