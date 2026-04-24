import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Settings2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface FloorsResponse { floors: Record<string, number> }

const COMMON_EQUIPMENT = ["Van", "Reefer", "Flatbed", "Stepdeck", "Power Only"];

export function MarginFloorsSettings({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Array<{ equipment: string; rpm: string }>>([]);

  const floorsQuery = useQuery<FloorsResponse>({
    queryKey: ["/api/customer-quotes/pricing-floors"],
    queryFn: async () => {
      const res = await fetch("/api/customer-quotes/pricing-floors", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return await res.json() as FloorsResponse;
    },
  });

  useEffect(() => {
    if (open) {
      const f = floorsQuery.data?.floors ?? {};
      const list = Object.entries(f).map(([equipment, rpm]) => ({ equipment, rpm: String(rpm) }));
      // Seed common equipment so admins see the slots even when empty.
      for (const eq of COMMON_EQUIPMENT) {
        if (!list.find(r => r.equipment.toLowerCase() === eq.toLowerCase())) {
          list.push({ equipment: eq, rpm: "" });
        }
      }
      setRows(list);
    }
  }, [open, floorsQuery.data]);

  const saveMut = useMutation({
    mutationFn: async (floors: Record<string, number>) => {
      const res = await apiRequest("PATCH", "/api/customer-quotes/pricing-floors", { floors });
      return await res.json() as FloorsResponse;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/customer-quotes/pricing-floors"] });
      toast({ title: "Floors saved" });
      setOpen(false);
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const floorCount = Object.values(floorsQuery.data?.floors ?? {}).filter(v => v > 0).length;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        data-testid="button-open-margin-floors"
        title={canEdit ? "Configure per-equipment $/mile floors" : "View per-equipment $/mile floors"}
      >
        <Settings2 className="h-3 w-3 mr-1" />
        Margin floors{floorCount > 0 ? ` (${floorCount})` : ""}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md bg-background border-border" data-testid="dialog-margin-floors">
          <DialogHeader>
            <DialogTitle className="text-foreground">Per-equipment margin floors</DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              Minimum $/mile we'll quote for each equipment type. Recommendation tiers below the floor get a warning chip. Leave blank to disable for that equipment.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2" data-testid={`row-floor-${i}`}>
                <Input
                  value={r.equipment}
                  onChange={e => setRows(rs => rs.map((row, j) => j === i ? { ...row, equipment: e.target.value } : row))}
                  className="h-8 bg-background border-border text-xs flex-1"
                  placeholder="Equipment"
                  disabled={!canEdit}
                  data-testid={`input-floor-equipment-${i}`}
                />
                <div className="relative w-28">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={r.rpm}
                    onChange={e => setRows(rs => rs.map((row, j) => j === i ? { ...row, rpm: e.target.value } : row))}
                    className="h-8 bg-background border-border text-xs pl-5 pr-7"
                    placeholder="0.00"
                    disabled={!canEdit}
                    data-testid={`input-floor-rpm-${i}`}
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">/mi</span>
                </div>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}
                    data-testid={`button-remove-floor-${i}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))}
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs w-full border-dashed border-border hover:bg-muted"
                onClick={() => setRows(rs => [...rs, { equipment: "", rpm: "" }])}
                data-testid="button-add-floor-row"
              >
                <Plus className="h-3 w-3 mr-1" /> Add equipment
              </Button>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} data-testid="button-cancel-floors">Cancel</Button>
            {canEdit && (
              <Button
                size="sm"
                onClick={() => {
                  const out: Record<string, number> = {};
                  for (const r of rows) {
                    const eq = r.equipment.trim();
                    const n = parseFloat(r.rpm);
                    if (eq && Number.isFinite(n) && n > 0) out[eq] = n;
                  }
                  saveMut.mutate(out);
                }}
                disabled={saveMut.isPending}
                data-testid="button-save-floors"
              >
                {saveMut.isPending ? "Saving…" : "Save"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
