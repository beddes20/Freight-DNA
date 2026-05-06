/**
 * Hero Slice admin page (Task #1073).
 *
 * Single-page editor for the email→quote→won→load auto-assignment loop.
 * Backed by:
 *   GET/PUT /api/admin/hero-slices                         (slice list)
 *   GET/PUT /api/admin/hero-slices/auto-handoff            (global toggle)
 *
 * Editing model is "edit local, save the full list" — the backend route
 * always replaces the entire list so a partial save can never silently
 * orphan a slice. The page mirrors the layout of the carrier-intel
 * scoring admin page so admins build one mental model for both.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Trash2, Save, ShieldCheck, Truck, AlertTriangle } from "lucide-react";

type HeroSlice = {
  id: string;
  customerNamePattern: string;
  originStatePattern?: string | null;
  destinationStatePattern?: string | null;
  equipmentPattern?: string | null;
  lmUserId: string;
};

type LmUser = { id: string; name: string; username: string; role: string };

type GetResponse = {
  ok: true;
  slices: HeroSlice[];
  autoHandoffEnabled: boolean;
  lmUsers: LmUser[];
};

function emptySlice(): HeroSlice {
  return {
    id: `slice-${Date.now().toString(36)}`,
    customerNamePattern: "",
    originStatePattern: "",
    destinationStatePattern: "",
    equipmentPattern: "",
    lmUserId: "",
  };
}

export default function AdminHeroSlicePage() {
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery<GetResponse>({
    queryKey: ["/api/admin/hero-slices"],
  });

  const [slices, setSlices] = useState<HeroSlice[] | null>(null);
  const [autoEnabled, setAutoEnabled] = useState<boolean | null>(null);

  // Hydrate local edit state from the server payload exactly once per fetch.
  useEffect(() => {
    if (data && slices === null) setSlices(data.slices.map(s => ({ ...s })));
    if (data && autoEnabled === null) setAutoEnabled(data.autoHandoffEnabled);
  }, [data, slices, autoEnabled]);

  const saveSlicesMut = useMutation({
    mutationFn: async (next: HeroSlice[]) => {
      return await apiRequest("PUT", "/api/admin/hero-slices", { slices: next });
    },
    onSuccess: () => {
      toast({ title: "Hero slices saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/hero-slices"] });
    },
    onError: (err: any) => {
      toast({
        title: "Save failed",
        description: err?.message ?? "Could not persist hero slice config",
        variant: "destructive",
      });
    },
  });

  const toggleHandoffMut = useMutation({
    mutationFn: async (enabled: boolean) => {
      return await apiRequest("PUT", "/api/admin/hero-slices/auto-handoff", { enabled });
    },
    onSuccess: (_res, enabled) => {
      toast({
        title: enabled
          ? "Auto-handoff enabled — won quotes will create freight"
          : "Auto-handoff disabled — won quotes will NOT create freight",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/hero-slices"] });
    },
    onError: (err: any) => {
      toast({
        title: "Toggle failed",
        description: err?.message ?? "Could not flip the auto-handoff toggle",
        variant: "destructive",
      });
      // Revert optimistic UI.
      if (data) setAutoEnabled(data.autoHandoffEnabled);
    },
  });

  function update(idx: number, patch: Partial<HeroSlice>) {
    if (!slices) return;
    const next = slices.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    setSlices(next);
  }

  function addSlice() {
    setSlices([...(slices ?? []), emptySlice()]);
  }

  function removeSlice(idx: number) {
    if (!slices) return;
    setSlices(slices.filter((_, i) => i !== idx));
  }

  function handleSave() {
    if (!slices) return;
    // Block save with a visible toast if any slice is missing required
    // fields — surfaces the problem before the round trip.
    const invalid = slices.find(s =>
      !s.id.trim() || !s.customerNamePattern.trim() || !s.lmUserId,
    );
    if (invalid) {
      toast({
        title: "Cannot save — incomplete slice",
        description: `Slice "${invalid.id || "(unnamed)"}" is missing id, customer pattern, or LM.`,
        variant: "destructive",
      });
      return;
    }
    const ids = slices.map(s => s.id.trim());
    if (new Set(ids).size !== ids.length) {
      toast({
        title: "Cannot save — duplicate slice ids",
        description: "Each slice id must be unique.",
        variant: "destructive",
      });
      return;
    }
    saveSlicesMut.mutate(slices);
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-muted-foreground" data-testid="loading-hero-slice">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading hero slice config…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" /> Failed to load hero slice config
            </CardTitle>
            <CardDescription>
              Make sure you're signed in as an admin. The server returned no
              response or a non-2xx status.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const lmUsers = data.lmUsers;
  const handoffOn = autoEnabled ?? data.autoHandoffEnabled;

  return (
    <div className="container max-w-5xl py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="heading-hero-slice">
          <Truck className="h-6 w-6" /> Hero Slice — Email → Won Quote → Available Freight
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure the narrow customer/lane/equipment slices where a won
          customer quote should auto-create a freight opportunity already
          delegated to a logistics manager (skipping the NAM/AM popup).
          Outside these slices the existing approval flow is unchanged.
        </p>
      </div>

      <Card data-testid="card-auto-handoff-toggle">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" /> Auto-handoff (global)
            </CardTitle>
            <CardDescription>
              Master switch. When OFF, won quotes do NOT create freight opportunities at all.
            </CardDescription>
          </div>
          <Switch
            checked={!!handoffOn}
            data-testid="switch-auto-handoff"
            onCheckedChange={(checked) => {
              setAutoEnabled(checked);
              toggleHandoffMut.mutate(checked);
            }}
            disabled={toggleHandoffMut.isPending}
          />
        </CardHeader>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Slices</CardTitle>
            <CardDescription>
              First matching slice wins. Empty origin/destination/equipment patterns mean "any".
              Patterns are case-insensitive substrings; pipe-separated state lists are matched as tokens.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" data-testid="badge-slice-count">{slices?.length ?? 0} configured</Badge>
            <Button onClick={addSlice} size="sm" variant="outline" data-testid="button-add-slice">
              <Plus className="h-4 w-4 mr-1" /> Add slice
            </Button>
            <Button onClick={handleSave} size="sm" disabled={saveSlicesMut.isPending} data-testid="button-save-slices">
              {saveSlicesMut.isPending
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Saving</>
                : <><Save className="h-4 w-4 mr-1" /> Save all</>}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {(slices ?? []).length === 0 && (
            <div
              className="text-sm text-muted-foreground text-center py-6 border border-dashed rounded-md"
              data-testid="empty-slices"
            >
              No slices configured. Won quotes will fall back to the legacy NAM/AM approval popup.
            </div>
          )}
          {(slices ?? []).map((s, idx) => (
            <div
              key={`${s.id}-${idx}`}
              className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end border rounded-md p-3"
              data-testid={`row-slice-${s.id}`}
            >
              <div className="md:col-span-2">
                <Label htmlFor={`slice-id-${idx}`}>Slice ID</Label>
                <Input
                  id={`slice-id-${idx}`}
                  value={s.id}
                  onChange={(e) => update(idx, { id: e.target.value })}
                  placeholder="acme-mw-se-vans"
                  data-testid={`input-slice-id-${idx}`}
                />
              </div>
              <div className="md:col-span-3">
                <Label htmlFor={`slice-customer-${idx}`}>Customer name (substring)</Label>
                <Input
                  id={`slice-customer-${idx}`}
                  value={s.customerNamePattern}
                  onChange={(e) => update(idx, { customerNamePattern: e.target.value })}
                  placeholder="ACME LOGISTICS"
                  data-testid={`input-slice-customer-${idx}`}
                />
              </div>
              <div className="md:col-span-1">
                <Label htmlFor={`slice-origin-${idx}`}>Origin</Label>
                <Input
                  id={`slice-origin-${idx}`}
                  value={s.originStatePattern ?? ""}
                  onChange={(e) => update(idx, { originStatePattern: e.target.value })}
                  placeholder="IL|IN|OH"
                  data-testid={`input-slice-origin-${idx}`}
                />
              </div>
              <div className="md:col-span-1">
                <Label htmlFor={`slice-dest-${idx}`}>Dest</Label>
                <Input
                  id={`slice-dest-${idx}`}
                  value={s.destinationStatePattern ?? ""}
                  onChange={(e) => update(idx, { destinationStatePattern: e.target.value })}
                  placeholder="GA|FL|NC"
                  data-testid={`input-slice-dest-${idx}`}
                />
              </div>
              <div className="md:col-span-2">
                <Label htmlFor={`slice-equipment-${idx}`}>Equipment</Label>
                <Input
                  id={`slice-equipment-${idx}`}
                  value={s.equipmentPattern ?? ""}
                  onChange={(e) => update(idx, { equipmentPattern: e.target.value })}
                  placeholder="VAN"
                  data-testid={`input-slice-equipment-${idx}`}
                />
              </div>
              <div className="md:col-span-2">
                <Label>Logistics manager</Label>
                <Select
                  value={s.lmUserId || undefined}
                  onValueChange={(v) => update(idx, { lmUserId: v })}
                >
                  <SelectTrigger data-testid={`select-slice-lm-${idx}`}>
                    <SelectValue placeholder="Pick LM…" />
                  </SelectTrigger>
                  <SelectContent>
                    {lmUsers.length === 0 && (
                      <SelectItem value="__none__" disabled>
                        No logistics managers in this org
                      </SelectItem>
                    )}
                    {lmUsers.map(u => (
                      <SelectItem key={u.id} value={u.id} data-testid={`option-lm-${u.id}`}>
                        {u.name || u.username} <span className="text-xs text-muted-foreground ml-1">({u.role})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="md:col-span-1 flex justify-end">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeSlice(idx)}
                  data-testid={`button-remove-slice-${idx}`}
                  aria-label="Remove slice"
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
