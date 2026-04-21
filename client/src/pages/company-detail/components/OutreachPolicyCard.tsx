import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Truck, Save, ShieldOff } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { CompanyOutreachPolicy } from "@shared/schema";

interface PolicyResponse { policy: CompanyOutreachPolicy }

interface Draft {
  enabled: boolean;
  mode: "exact_load" | "lane_building" | "both";
  approvalRequired: boolean;
  maxCarriersPerOpportunity: number;
  leadTimeMinDays: number;
  leadTimeMaxDays: number;
  approvedCarrierOnly: boolean;
  doNotAutomate: boolean;
  specialNotes: string;
}

function policyToDraft(p: CompanyOutreachPolicy): Draft {
  return {
    enabled: !!p.enabled,
    mode: (p.mode as Draft["mode"]) || "exact_load",
    approvalRequired: p.approvalRequired ?? true,
    maxCarriersPerOpportunity: p.maxCarriersPerOpportunity ?? 25,
    leadTimeMinDays: p.leadTimeMinDays ?? 2,
    leadTimeMaxDays: p.leadTimeMaxDays ?? 7,
    approvedCarrierOnly: !!p.approvedCarrierOnly,
    doNotAutomate: !!p.doNotAutomate,
    specialNotes: p.specialNotes ?? "",
  };
}

export function OutreachPolicyCard({ companyId }: { companyId: string }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);

  const policyQuery = useQuery<PolicyResponse>({
    queryKey: ["/api/companies", companyId, "outreach-policy"],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/outreach-policy`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  useEffect(() => {
    if (policyQuery.data?.policy && !dirty) {
      setDraft(policyToDraft(policyQuery.data.policy));
    }
  }, [policyQuery.data?.policy, dirty]);

  const saveMutation = useMutation({
    mutationFn: async (d: Draft) => {
      const res = await apiRequest("PATCH", `/api/companies/${companyId}/outreach-policy`, {
        ...d,
        specialNotes: d.specialNotes.trim() ? d.specialNotes : null,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Eligibility saved" });
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "outreach-policy"] });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't save",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(prev => (prev ? { ...prev, [key]: value } : prev));
    setDirty(true);
  };

  if (policyQuery.isError) {
    return (
      <Card data-testid="card-outreach-policy">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Truck className="h-4 w-4" /> Available Freight eligibility
          </CardTitle>
        </CardHeader>
        <CardContent className="py-3 text-sm text-muted-foreground" data-testid="state-policy-error">
          Couldn't load eligibility settings. Please refresh and try again.
        </CardContent>
      </Card>
    );
  }

  if (policyQuery.isLoading || !draft) {
    return (
      <Card data-testid="card-outreach-policy">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Truck className="h-4 w-4" /> Available Freight eligibility
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-6 w-1/2" />
        </CardContent>
      </Card>
    );
  }

  const blocked = draft.doNotAutomate;

  return (
    <Card data-testid="card-outreach-policy">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Truck className="h-4 w-4" /> Available Freight eligibility
              {blocked && (
                <Badge variant="outline" className="bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30">
                  <ShieldOff className="h-3 w-3 mr-1" /> Do not automate
                </Badge>
              )}
              {!blocked && draft.enabled && (
                <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">
                  Active
                </Badge>
              )}
              {!blocked && !draft.enabled && (
                <Badge variant="outline">Off</Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              Controls whether this customer's unbooked freight feeds the proactive outreach engine.
            </CardDescription>
          </div>
          <Button
            size="sm"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => draft && saveMutation.mutate(draft)}
            data-testid="button-save-outreach-policy"
          >
            <Save className="h-3.5 w-3.5 mr-2" />
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <Label htmlFor="policy-enabled" className="text-sm">Enable outreach</Label>
              <p className="text-xs text-muted-foreground">Turn on automated carrier outreach for this customer.</p>
            </div>
            <Switch
              id="policy-enabled"
              checked={draft.enabled}
              onCheckedChange={(v) => update("enabled", v)}
              disabled={blocked}
              data-testid="switch-policy-enabled"
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <Label htmlFor="policy-do-not-automate" className="text-sm">Do not automate</Label>
              <p className="text-xs text-muted-foreground">Hard block — overrides every other setting.</p>
            </div>
            <Switch
              id="policy-do-not-automate"
              checked={draft.doNotAutomate}
              onCheckedChange={(v) => update("doNotAutomate", v)}
              data-testid="switch-policy-do-not-automate"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <Label className="text-xs">Mode</Label>
            <Select
              value={draft.mode}
              onValueChange={(v) => update("mode", v as Draft["mode"])}
              disabled={blocked}
            >
              <SelectTrigger data-testid="select-policy-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="exact_load">Exact load only</SelectItem>
                <SelectItem value="lane_building">Lane building only</SelectItem>
                <SelectItem value="both">Both</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Max carriers per opportunity</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={draft.maxCarriersPerOpportunity}
              onChange={(e) => update("maxCarriersPerOpportunity", Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
              disabled={blocked}
              data-testid="input-policy-max-carriers"
            />
          </div>
          <div className="flex items-end justify-between gap-3 rounded-md border p-3">
            <div>
              <Label htmlFor="policy-approval" className="text-sm">Require rep approval</Label>
              <p className="text-xs text-muted-foreground">Pause before sending.</p>
            </div>
            <Switch
              id="policy-approval"
              checked={draft.approvalRequired}
              onCheckedChange={(v) => update("approvalRequired", v)}
              disabled={blocked}
              data-testid="switch-policy-approval"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label className="text-xs">Lead time — min (days)</Label>
            <Input
              type="number"
              min={0}
              max={60}
              value={draft.leadTimeMinDays}
              onChange={(e) => update("leadTimeMinDays", Math.max(0, Math.min(60, parseInt(e.target.value) || 0)))}
              disabled={blocked}
              data-testid="input-policy-lead-min"
            />
          </div>
          <div>
            <Label className="text-xs">Lead time — max (days)</Label>
            <Input
              type="number"
              min={0}
              max={180}
              value={draft.leadTimeMaxDays}
              onChange={(e) => update("leadTimeMaxDays", Math.max(0, Math.min(180, parseInt(e.target.value) || 0)))}
              disabled={blocked}
              data-testid="input-policy-lead-max"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div>
            <Label htmlFor="policy-approved-only" className="text-sm">Approved carriers only</Label>
            <p className="text-xs text-muted-foreground">
              Restrict shortlists to carriers on the approved list (managed in Carrier Catalog).
            </p>
          </div>
          <Switch
            id="policy-approved-only"
            checked={draft.approvedCarrierOnly}
            onCheckedChange={(v) => update("approvedCarrierOnly", v)}
            disabled={blocked}
            data-testid="switch-policy-approved-only"
          />
        </div>

        <div>
          <Label className="text-xs">Notes for ops</Label>
          <Textarea
            value={draft.specialNotes}
            onChange={(e) => update("specialNotes", e.target.value)}
            placeholder="Anything special about this customer's outreach (preferred lanes, carriers to avoid, contact preferences)…"
            rows={2}
            disabled={blocked}
            data-testid="textarea-policy-notes"
          />
        </div>
      </CardContent>
    </Card>
  );
}
