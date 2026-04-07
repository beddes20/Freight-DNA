import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Sparkles, RefreshCw, Loader2 } from "lucide-react";
import type { EnrichedProspect } from "../types";

export function SalesIntelTab({ prospect }: { prospect: EnrichedProspect }) {
  const { toast } = useToast();
  const [brief, setBrief] = useState<string>(prospect.intelBrief ?? "");
  const [loading, setLoading] = useState(false);

  const generate = async (force: boolean) => {
    setLoading(true);
    try {
      const res = await apiRequest("POST", `/api/prospects/${prospect.id}/intel`, { force });
      const data = await res.json();
      if (data.brief) {
        setBrief(data.brief);
        queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
        if (!force) toast({ title: "Sales Intel Brief generated!" });
        else toast({ title: "Brief regenerated" });
      }
    } catch {
      toast({ title: "Failed to generate brief", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const sections = brief
    ? brief.split(/\n(?=##\s)/).map(block => {
        const lines = block.trim().split("\n");
        const header = lines[0].replace(/^##\s+/, "").trim();
        const bullets = lines.slice(1).filter(l => l.trim()).map(l => l.replace(/^[-*]\s*/, "").trim());
        return { header, bullets };
      }).filter(s => s.header)
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">AI Sales Intel Brief</p>
          <p className="text-xs text-muted-foreground mt-0.5">GPT-4o-mini cross-references your customer network to surface overlap and talking points</p>
        </div>
        {brief ? (
          <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs shrink-0" onClick={() => generate(true)} disabled={loading} data-testid="button-intel-regenerate">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Regenerate
          </Button>
        ) : (
          <Button size="sm" className="gap-1.5 h-8 text-xs shrink-0 bg-violet-600 hover:bg-violet-700 text-white" onClick={() => generate(false)} disabled={loading} data-testid="button-intel-generate">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            Generate Brief
          </Button>
        )}
      </div>

      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {!loading && !brief && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Sparkles className="h-8 w-8 text-violet-400 mx-auto mb-2" />
          <p className="text-sm font-medium text-foreground">No brief yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
            Generate a brief to see network overlap, conversation starters, industry pain points, and competitive tips.
          </p>
        </div>
      )}

      {!loading && sections.length > 0 && (
        <div className="space-y-4">
          {sections.map((section, i) => (
            <div key={i} className="border rounded-lg p-3 space-y-2">
              <p className="text-sm font-semibold text-foreground">{section.header}</p>
              <ul className="space-y-1.5">
                {section.bullets.map((bullet, j) => (
                  <li key={j} className="flex gap-2 text-xs text-foreground/80">
                    <span className="text-violet-500 mt-0.5 shrink-0">•</span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground text-right">Powered by GPT-4o-mini · Cached result</p>
        </div>
      )}

      {!loading && brief && sections.length === 0 && (
        <div className="text-sm text-foreground/80 whitespace-pre-wrap bg-muted/30 rounded-lg p-3">{brief}</div>
      )}
    </div>
  );
}
