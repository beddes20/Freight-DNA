/**
 * Intelligence card — Task #926 step 9.
 *
 * Renders a single `copilot_intelligence` row: lane/customer/carrier fit
 * scores, price band, risks, opportunities, and a citations rail.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, TrendingUp, ShieldCheck } from "lucide-react";
import { EvidenceChip, type Evidence } from "./evidence-chip";

export interface IntelligenceRow {
  id: string;
  documentId: string;
  laneKey: string | null;
  customerId: string | null;
  laneFitScore: number | null;
  customerFitScore: number | null;
  carrierFitScore: number | null;
  priceLow: string | null;
  priceMid: string | null;
  priceHigh: string | null;
  risks: Array<{ label: string; severity: "high" | "medium" | "low"; evidence: Evidence[] }>;
  opportunities: Array<{ label: string; evidence: Evidence[] }>;
  evidenceRefs: Evidence[];
  confidence: "high" | "medium" | "low";
  scoringVersion: number;
  computedAt: string;
}

function confidenceColor(c: string) {
  if (c === "high") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (c === "medium") return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "bg-rose-500/10 text-rose-700 dark:text-rose-400";
}

function ScoreChip({ label, value, testId }: { label: string; value: number | null; testId: string }) {
  const color =
    value == null ? "bg-muted text-muted-foreground"
    : value >= 70 ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    : value >= 40 ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    : "bg-rose-500/15 text-rose-700 dark:text-rose-300";
  return (
    <div className={`rounded-lg px-3 py-2 text-center ${color}`} data-testid={testId}>
      <div className="text-xs uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-2xl font-semibold">{value ?? "—"}</div>
    </div>
  );
}

export function IntelligenceCard({ row }: { row: IntelligenceRow }) {
  const lane = row.laneKey ?? "—";
  const lo = row.priceLow != null ? `$${Number(row.priceLow).toFixed(2)}/mi` : "—";
  const md = row.priceMid != null ? `$${Number(row.priceMid).toFixed(2)}/mi` : "—";
  const hi = row.priceHigh != null ? `$${Number(row.priceHigh).toFixed(2)}/mi` : "—";

  return (
    <Card data-testid={`card-intelligence-${row.id}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">
          Intelligence <span className="text-muted-foreground font-normal">— {lane}</span>
        </CardTitle>
        <Badge className={confidenceColor(row.confidence)} data-testid={`badge-confidence-${row.id}`}>
          {row.confidence} confidence
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <ScoreChip label="Lane fit" value={row.laneFitScore} testId={`chip-lane-fit-${row.id}`} />
          <ScoreChip label="Customer fit" value={row.customerFitScore} testId={`chip-customer-fit-${row.id}`} />
          <ScoreChip label="Carrier fit" value={row.carrierFitScore} testId={`chip-carrier-fit-${row.id}`} />
        </div>

        <div className="rounded-lg border p-3 bg-muted/40">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Price band</div>
          <div className="flex items-baseline gap-3">
            <span className="text-sm" data-testid={`text-price-low-${row.id}`}>{lo}</span>
            <span className="text-sm text-muted-foreground">·</span>
            <span className="text-lg font-semibold" data-testid={`text-price-mid-${row.id}`}>{md}</span>
            <span className="text-sm text-muted-foreground">·</span>
            <span className="text-sm" data-testid={`text-price-high-${row.id}`}>{hi}</span>
          </div>
        </div>

        {row.risks.length > 0 && (
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
              <AlertTriangle className="h-3.5 w-3.5" /> Risks
            </div>
            <ul className="space-y-1">
              {row.risks.map((r, i) => (
                <li key={i} className="text-sm flex items-start gap-2" data-testid={`text-risk-${row.id}-${i}`}>
                  <Badge variant="outline" className={r.severity === "high" ? "border-rose-500/40 text-rose-700 dark:text-rose-300" : r.severity === "medium" ? "border-amber-500/40 text-amber-700 dark:text-amber-300" : ""}>
                    {r.severity}
                  </Badge>
                  <span>{r.label}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {row.opportunities.length > 0 && (
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
              <TrendingUp className="h-3.5 w-3.5" /> Opportunities
            </div>
            <ul className="space-y-1">
              {row.opportunities.map((o, i) => (
                <li key={i} className="text-sm" data-testid={`text-opportunity-${row.id}-${i}`}>{o.label}</li>
              ))}
            </ul>
          </div>
        )}

        {row.evidenceRefs.length > 0 && (
          <>
            <Separator />
            <div>
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
                <ShieldCheck className="h-3.5 w-3.5" /> Evidence ({row.evidenceRefs.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {row.evidenceRefs.slice(0, 12).map((e, i) => (
                  <EvidenceChip key={i} evidence={e} />
                ))}
                {row.evidenceRefs.length > 12 && (
                  <Badge variant="outline" className="text-xs font-normal">
                    +{row.evidenceRefs.length - 12} more
                  </Badge>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
