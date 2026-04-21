import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Settings, Sliders, Database, Trophy, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import AdminCarrierIntelligencePage from "@/pages/admin-carrier-intelligence";
import AdminCarrierIntelligenceScoringPage from "@/pages/admin-carrier-intelligence-scoring";
import { useCarrierIntelPrefs } from "@/lib/carrier-intelligence";

const ADMIN_ROLES = new Set(["admin", "director"]);

export default function CarrierIntelligenceSettingsPage() {
  const { user } = useAuth();
  const allowed = ADMIN_ROLES.has(user?.role ?? "");
  const [tab, setTab] = useState<"defaults" | "scoring" | "imports">("defaults");

  if (user && !allowed) {
    return (
      <div className="p-8 max-w-2xl mx-auto" data-testid="text-not-authorized">
        <Card><CardContent className="pt-6">Admin or director access required.</CardContent></Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-[1200px] mx-auto" data-testid="page-carrier-intelligence-settings">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
          <Settings className="h-6 w-6" /> Carrier Intelligence Settings
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          One place to manage import health, scoring math, and the org-wide UI defaults that ship to every rep's surfaces.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="grid grid-cols-3 max-w-lg" data-testid="tabs-settings">
          <TabsTrigger value="defaults" data-testid="tab-defaults"><Sliders className="h-4 w-4 mr-1" /> UI Defaults</TabsTrigger>
          <TabsTrigger value="scoring" data-testid="tab-scoring"><Trophy className="h-4 w-4 mr-1" /> Scoring</TabsTrigger>
          <TabsTrigger value="imports" data-testid="tab-imports"><Database className="h-4 w-4 mr-1" /> Imports</TabsTrigger>
        </TabsList>

        <TabsContent value="defaults" className="mt-4">
          <UiDefaultsTab />
        </TabsContent>
        <TabsContent value="scoring" className="mt-4">
          <AdminCarrierIntelligenceScoringPage />
        </TabsContent>
        <TabsContent value="imports" className="mt-4">
          <AdminCarrierIntelligencePage />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface OrgDefaultsResp {
  defaults: {
    thresholds: {
      marginGreenPct: number; marginYellowPct: number;
      onTimeGreenPct: number; onTimeYellowPct: number;
      urgencyRedHours: number; urgencyYellowHours: number;
    };
    scorecard: { moveStatus: string[]; minLoads: number; tier: string; equipment: string; sort: string };
    availableLoads: { equipment: string; accountManager: string; urgency: string; sort: string };
  };
}

function UiDefaultsTab() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<OrgDefaultsResp>({
    queryKey: ["/api/admin/carrier-intelligence/ui-defaults"],
  });
  const [draft, setDraft] = useState<OrgDefaultsResp["defaults"] | null>(null);
  const cur = draft ?? data?.defaults ?? null;

  const saveMutation = useMutation({
    mutationFn: async (payload: OrgDefaultsResp["defaults"]) => {
      const res = await apiRequest("PUT", "/api/admin/carrier-intelligence/ui-defaults", payload);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Defaults saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/carrier-intelligence/ui-defaults"] });
      queryClient.invalidateQueries({ queryKey: ["/api/carrier-intelligence/prefs"] });
      setDraft(null);
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading || !cur) return <Card><CardContent className="pt-6 text-muted-foreground">Loading defaults…</CardContent></Card>;

  function updateThreshold<K extends keyof OrgDefaultsResp["defaults"]["thresholds"]>(k: K, v: number) {
    setDraft({ ...cur!, thresholds: { ...cur!.thresholds, [k]: v } });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Threshold colors</CardTitle>
          <CardDescription>Cutoffs that drive green/amber/red badging across every Carrier Intelligence surface.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Margin green ≥ %" v={cur.thresholds.marginGreenPct} onChange={(v) => updateThreshold("marginGreenPct", v)} testId="input-margin-green" />
          <Field label="Margin yellow ≥ %" v={cur.thresholds.marginYellowPct} onChange={(v) => updateThreshold("marginYellowPct", v)} testId="input-margin-yellow" />
          <div />
          <Field label="On-time green ≥ %" v={cur.thresholds.onTimeGreenPct} onChange={(v) => updateThreshold("onTimeGreenPct", v)} testId="input-on-time-green" />
          <Field label="On-time yellow ≥ %" v={cur.thresholds.onTimeYellowPct} onChange={(v) => updateThreshold("onTimeYellowPct", v)} testId="input-on-time-yellow" />
          <div />
          <Field label="Urgency RED ≤ hours" v={cur.thresholds.urgencyRedHours} onChange={(v) => updateThreshold("urgencyRedHours", v)} testId="input-urgency-red" />
          <Field label="Urgency YELLOW ≤ hours" v={cur.thresholds.urgencyYellowHours} onChange={(v) => updateThreshold("urgencyYellowHours", v)} testId="input-urgency-yellow" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Default views</CardTitle>
          <CardDescription>What new reps see before they save their own filters.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <Label className="text-xs">Scorecard min loads</Label>
            <Input type="number" value={cur.scorecard.minLoads}
              onChange={(e) => setDraft({ ...cur, scorecard: { ...cur.scorecard, minLoads: Number(e.target.value) || 0 } })}
              data-testid="input-default-min-loads" />
          </div>
          <div>
            <Label className="text-xs">Scorecard equipment default</Label>
            <Input value={cur.scorecard.equipment}
              onChange={(e) => setDraft({ ...cur, scorecard: { ...cur.scorecard, equipment: e.target.value } })}
              data-testid="input-default-equipment" />
          </div>
          <div>
            <Label className="text-xs">Available Loads urgency default</Label>
            <Input value={cur.availableLoads.urgency}
              onChange={(e) => setDraft({ ...cur, availableLoads: { ...cur.availableLoads, urgency: e.target.value } })}
              data-testid="input-default-urgency" />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate(cur)} disabled={saveMutation.isPending} data-testid="button-save-defaults">
          <RefreshCw className={`h-4 w-4 mr-1 ${saveMutation.isPending ? "animate-spin" : ""}`} /> Save defaults
        </Button>
      </div>
    </div>
  );
}

function Field({ label, v, onChange, testId }: { label: string; v: number; onChange: (n: number) => void; testId: string }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input type="number" value={v} onChange={(e) => onChange(Number(e.target.value) || 0)} data-testid={testId} />
    </div>
  );
}
