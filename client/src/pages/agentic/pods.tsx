import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Pod } from "@shared/schema";

const POD_TYPES = ["vertical", "cross_border", "trailer_pool", "large_shipper", "other"];

export default function PodsPage() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ pods: Pod[] }>({ queryKey: ["/api/agentic/pods"] });
  const [name, setName] = useState("");
  const [podType, setPodType] = useState("vertical");
  const create = useMutation({
    mutationFn: () => apiRequest("POST", "/api/agentic/pods", { name, podType }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agentic/pods"] });
      setName("");
      toast({ title: "Pod created" });
    },
  });

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="page-pods">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Users className="h-6 w-6" /> Pod Cockpits</h1>
        <p className="text-sm text-muted-foreground mt-1">Small human + agent teams owning a book of business end-to-end.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Create a pod</CardTitle></CardHeader>
        <CardContent className="flex flex-col md:flex-row gap-3 items-end">
          <div className="flex-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Refrigerated Foods Pod" data-testid="input-pod-name" />
          </div>
          <div className="w-full md:w-56">
            <Label>Type</Label>
            <Select value={podType} onValueChange={setPodType}>
              <SelectTrigger data-testid="select-pod-type"><SelectValue /></SelectTrigger>
              <SelectContent>{POD_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button onClick={() => create.mutate()} disabled={!name || create.isPending} data-testid="button-create-pod">Create</Button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {(data?.pods ?? []).map((p) => (
          <Card key={p.id} data-testid={`card-pod-${p.id}`}>
            <CardHeader className="pb-3"><CardTitle className="text-base">{p.name}</CardTitle></CardHeader>
            <CardContent className="text-sm space-y-1">
              <div className="text-xs text-muted-foreground">Type: {p.podType}</div>
              {p.description && <div>{p.description}</div>}
            </CardContent>
          </Card>
        ))}
        {(data?.pods ?? []).length === 0 && !isLoading && (
          <div className="text-sm text-muted-foreground">No pods yet — create one above to start grouping reps + agents.</div>
        )}
      </div>
    </div>
  );
}
