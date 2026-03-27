import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronDown, ChevronUp, TrendingUp, Users, Package, DollarSign, Truck, Plus, Info, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const BASE_CONFIG: Record<string, { label: string; color: string; bg: string; border: string; emoji: string }> = {
  "1st": { label: "1st Base",  color: "text-blue-400",   bg: "bg-blue-950/40",   border: "border-blue-800/40",   emoji: "🟦" },
  "2nd": { label: "2nd Base",  color: "text-yellow-400",  bg: "bg-yellow-950/40", border: "border-yellow-800/40", emoji: "🟨" },
  "3rd": { label: "3rd Base",  color: "text-orange-400",  bg: "bg-orange-950/40", border: "border-orange-800/40", emoji: "🟧" },
  "hr":  { label: "Home Run",  color: "text-emerald-400", bg: "bg-emerald-950/40",border: "border-emerald-800/40",emoji: "🟩" },
  "home":{ label: "Home Run",  color: "text-emerald-400", bg: "bg-emerald-950/40",border: "border-emerald-800/40",emoji: "🟩" },
  "unknown": { label: "Unassigned", color: "text-zinc-400", bg: "bg-zinc-900/40", border: "border-zinc-700/40",   emoji: "⬜" },
};

function fmt$(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

interface SummaryRow {
  base: string;
  label: string;
  contacts: number;
  loads: number;
  margin: number;
  contractedLoads: number;
  spotLoads: number;
  contractedPct: number | null;
  spotPct: number | null;
}

// ── Dashboard-level portlet ───────────────────────────────────────────────────
export function RelationshipFreightDashboardPortlet() {
  const [collapsed, setCollapsed] = useState(false);
  const { data, isLoading } = useQuery<{ summary: SummaryRow[]; totalContacts: number; totalLoads: number; totalMargin: number }>({
    queryKey: ["/api/relationship-freight-summary"],
  });

  const hasAnyLoads = (data?.summary ?? []).some(r => r.loads > 0);

  return (
    <Card className="bg-zinc-900 border-zinc-800" data-testid="card-relationship-freight-dashboard">
      <CardHeader className="pb-2 cursor-pointer" onClick={() => setCollapsed(p => !p)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-amber-400" />
            <CardTitle className="text-sm font-semibold text-white">Relationship Freight Performance</CardTitle>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-3.5 h-3.5 text-zinc-500 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  Loads attributed to contacts via lane patterns. Assign lane attributions in each contact profile to populate this data.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <div className="flex items-center gap-3">
            {!collapsed && data && (
              <span className="text-xs text-zinc-500">{data.totalContacts} contacts · {data.totalLoads.toLocaleString()} loads · {fmt$(data.totalMargin)} margin</span>
            )}
            {collapsed ? <ChevronDown className="w-4 h-4 text-zinc-500" /> : <ChevronUp className="w-4 h-4 text-zinc-500" />}
          </div>
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-6 text-zinc-500">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading...
            </div>
          ) : !data || data.summary.length === 0 ? (
            <EmptyState message="No lane attributions yet. Open a contact and assign lanes to start tracking." />
          ) : (
            <div className="space-y-2">
              {!hasAnyLoads && (
                <div className="text-xs text-zinc-500 bg-zinc-800/50 rounded px-3 py-2 mb-3">
                  Lane attributions exist but no matching loads found in financial data. Make sure financial data is uploaded and company names match.
                </div>
              )}
              <SummaryTable rows={data.summary} />
              <ProgressionCallout summary={data.summary} />
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ── Company-level portlet ─────────────────────────────────────────────────────
interface CompanyContact {
  contactId: string;
  contactName: string;
  contactTitle: string | null;
  relationshipBase: string;
  baseLabel: string;
  attributionCount: number;
  loads: number;
  margin: number;
  contractedLoads: number;
  spotLoads: number;
  attributions: any[];
}

interface CompanyPortletProps {
  companyId: string;
  companyName?: string;
}

export function RelationshipFreightCompanyPortlet({ companyId, companyName }: CompanyPortletProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [addOpen, setAddOpen] = useState<string | null>(null); // contactId being edited
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ contacts: CompanyContact[]; companyId: string }>({
    queryKey: ["/api/companies", companyId, "relationship-freight-summary"],
    queryFn: () => fetch(`/api/companies/${companyId}/relationship-freight-summary`, { credentials: "include" }).then(r => r.json()),
  });

  const contacts = data?.contacts ?? [];
  const hasContacts = contacts.length > 0;
  const hasAnyAttributions = contacts.some(c => c.attributionCount > 0);
  const totalLoads = contacts.reduce((s, c) => s + c.loads, 0);
  const totalMargin = contacts.reduce((s, c) => s + c.margin, 0);

  // Group contacts by base
  const baseOrder = ["hr", "home", "3rd", "2nd", "1st", "unknown"];
  const grouped: Record<string, CompanyContact[]> = {};
  for (const c of contacts) {
    const key = c.relationshipBase || "unknown";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(c);
  }

  return (
    <Card className="bg-zinc-900 border-zinc-800" data-testid="card-relationship-freight-company">
      <CardHeader className="pb-2 cursor-pointer" onClick={() => setCollapsed(p => !p)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-amber-400" />
            <CardTitle className="text-sm font-semibold text-white">Contact Freight Attribution</CardTitle>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-3.5 h-3.5 text-zinc-500 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  Freight loads attributed to each contact based on their lane patterns. Go deeper in relationships to see these numbers grow.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <div className="flex items-center gap-3">
            {!collapsed && hasAnyAttributions && (
              <span className="text-xs text-zinc-500">{totalLoads} loads · {fmt$(totalMargin)}</span>
            )}
            {collapsed ? <ChevronDown className="w-4 h-4 text-zinc-500" /> : <ChevronUp className="w-4 h-4 text-zinc-500" />}
          </div>
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-6 text-zinc-500">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading...
            </div>
          ) : !hasContacts ? (
            <EmptyState message="No contacts yet. Add contacts to this company to start tracking relationship freight." />
          ) : !hasAnyAttributions ? (
            <EmptyState message="No lane attributions yet. Open a contact and assign their lanes to start attributing freight." />
          ) : (
            <div className="space-y-4">
              {baseOrder.filter(b => grouped[b]?.length).map(base => {
                const cfg = BASE_CONFIG[base] ?? BASE_CONFIG["unknown"];
                const group = grouped[base];
                return (
                  <div key={base}>
                    <div className={`flex items-center gap-2 px-2 py-1 rounded-md mb-2 ${cfg.bg} border ${cfg.border}`}>
                      <span className="text-xs font-bold uppercase tracking-wider" style={{ color: cfg.color.replace("text-", "") }}>
                        {cfg.emoji} {cfg.label}
                      </span>
                      <span className={`text-xs ${cfg.color}`}>({group.length} contact{group.length !== 1 ? "s" : ""})</span>
                    </div>
                    <div className="space-y-1 pl-2">
                      {group.map(contact => (
                        <ContactFreightRow
                          key={contact.contactId}
                          contact={contact}
                          onAddLane={() => setAddOpen(contact.contactId)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {addOpen && (
            <AddLaneDialog
              contactId={addOpen}
              onClose={() => setAddOpen(null)}
              onSaved={() => {
                queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "relationship-freight-summary"] });
                queryClient.invalidateQueries({ queryKey: ["/api/contacts", addOpen, "lane-attributions"] });
                setAddOpen(null);
              }}
            />
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ContactFreightRow({ contact, onAddLane }: { contact: CompanyContact; onAddLane: () => void }) {
  const cfg = BASE_CONFIG[contact.relationshipBase] ?? BASE_CONFIG["unknown"];
  const hasLoads = contact.loads > 0;
  const marginPerLoad = hasLoads ? contact.margin / contact.loads : 0;
  const contractedPct = hasLoads ? Math.round(contact.contractedLoads / contact.loads * 100) : null;

  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-zinc-800/50 group" data-testid={`row-contact-freight-${contact.contactId}`}>
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: cfg.color.replace("text-", "").replace("-400", "") === "emerald" ? "#34d399" : cfg.color.includes("blue") ? "#60a5fa" : cfg.color.includes("yellow") ? "#facc15" : cfg.color.includes("orange") ? "#fb923c" : "#a1a1aa" }} />
        <div className="min-w-0">
          <p className="text-xs font-medium text-white truncate">{contact.contactName}</p>
          {contact.contactTitle && <p className="text-[10px] text-zinc-500 truncate">{contact.contactTitle}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 ml-2">
        {hasLoads ? (
          <>
            <span className="text-xs text-zinc-300 font-mono">{contact.loads.toLocaleString()} loads</span>
            <span className="text-xs text-emerald-400 font-mono">{fmt$(contact.margin)}</span>
            {contractedPct !== null && (
              <span className="text-[10px] text-zinc-500">{contractedPct}% contract</span>
            )}
          </>
        ) : contact.attributionCount > 0 ? (
          <span className="text-[10px] text-zinc-600 italic">{contact.attributionCount} lane{contact.attributionCount !== 1 ? "s" : ""} assigned · no data</span>
        ) : (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-zinc-600 hover:text-amber-400 opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); onAddLane(); }} data-testid={`button-add-lane-${contact.contactId}`}>
            <Plus className="w-3 h-3 mr-1" /> Assign Lane
          </Button>
        )}
      </div>
    </div>
  );
}

function SummaryTable({ rows }: { rows: SummaryRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-zinc-800">
            <th className="text-left py-2 text-zinc-500 font-medium">Level</th>
            <th className="text-right py-2 text-zinc-500 font-medium px-2">Contacts</th>
            <th className="text-right py-2 text-zinc-500 font-medium px-2">Loads</th>
            <th className="text-right py-2 text-zinc-500 font-medium px-2">Margin</th>
            <th className="text-right py-2 text-zinc-500 font-medium px-2">Contract %</th>
            <th className="text-right py-2 text-zinc-500 font-medium px-2">Spot %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const cfg = BASE_CONFIG[row.base] ?? BASE_CONFIG["unknown"];
            return (
              <tr key={row.base} className="border-b border-zinc-800/50 hover:bg-zinc-800/30" data-testid={`row-relationship-${row.base}`}>
                <td className="py-2">
                  <span className={`font-semibold ${cfg.color}`}>{cfg.emoji} {cfg.label}</span>
                </td>
                <td className="text-right py-2 px-2 text-zinc-300">{row.contacts}</td>
                <td className="text-right py-2 px-2 text-zinc-300 font-mono">{row.loads > 0 ? row.loads.toLocaleString() : <span className="text-zinc-600">—</span>}</td>
                <td className="text-right py-2 px-2 font-mono">
                  {row.loads > 0 ? <span className="text-emerald-400">{fmt$(row.margin)}</span> : <span className="text-zinc-600">—</span>}
                </td>
                <td className="text-right py-2 px-2 text-zinc-300">
                  {row.contractedPct !== null ? `${row.contractedPct.toFixed(0)}%` : <span className="text-zinc-600">—</span>}
                </td>
                <td className="text-right py-2 px-2 text-zinc-300">
                  {row.spotPct !== null ? `${row.spotPct.toFixed(0)}%` : <span className="text-zinc-600">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProgressionCallout({ summary }: { summary: SummaryRow[] }) {
  const base1 = summary.find(r => r.base === "1st");
  const hr = summary.find(r => r.base === "hr" || r.base === "home");
  if (!base1 || !hr || base1.loads === 0 || hr.loads === 0) return null;
  const loadRatio = hr.loads / Math.max(base1.loads, 1);
  const marginRatio = (hr.loads > 0 && base1.loads > 0)
    ? (hr.margin / hr.loads) / (base1.margin / Math.max(base1.loads, 1))
    : null;
  if (loadRatio < 1.2 && !marginRatio) return null;
  return (
    <div className="mt-3 rounded-md border border-amber-800/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-300/80" data-testid="callout-progression">
      <span className="font-semibold text-amber-300">Down, Not Across:</span>{" "}
      {loadRatio >= 1.2 && `Home Run contacts generate ${loadRatio.toFixed(1)}x more loads than 1st Base contacts. `}
      {marginRatio !== null && marginRatio > 1.1 && `Margin per load is ${marginRatio.toFixed(1)}x higher at Home Run level.`}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
      <Package className="w-8 h-8 text-zinc-700" />
      <p className="text-xs text-zinc-500 max-w-xs">{message}</p>
    </div>
  );
}

// ── Add Lane Dialog ───────────────────────────────────────────────────────────
interface AddLaneDialogProps {
  contactId: string;
  onClose: () => void;
  onSaved: () => void;
}

export function AddLaneDialog({ contactId, onClose, onSaved }: AddLaneDialogProps) {
  const [originCity, setOriginCity] = useState("");
  const [originState, setOriginState] = useState("");
  const [destCity, setDestCity] = useState("");
  const [destState, setDestState] = useState("");
  const [notes, setNotes] = useState("");
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/contacts/${contactId}/lane-attributions`, {
      originCity: originCity || null,
      originState: originState || null,
      destinationCity: destCity || null,
      destinationState: destState || null,
      notes: notes || null,
      source: "manual",
    }),
    onSuccess: () => {
      toast({ title: "Lane assigned", description: "This lane pattern is now attributed to the contact." });
      onSaved();
    },
    onError: () => toast({ title: "Error", description: "Failed to save lane attribution.", variant: "destructive" }),
  });

  const isValid = originState || originCity || destState || destCity;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="bg-zinc-900 border-zinc-700 max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-white text-sm">Assign Lane to Contact</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">
          <div>
            <Label className="text-xs text-zinc-400 mb-1 block">Origin City</Label>
            <Input value={originCity} onChange={e => setOriginCity(e.target.value)} placeholder="e.g. Carlisle" className="bg-zinc-800 border-zinc-700 text-white text-xs h-8" data-testid="input-origin-city" />
          </div>
          <div>
            <Label className="text-xs text-zinc-400 mb-1 block">Origin State</Label>
            <Input value={originState} onChange={e => setOriginState(e.target.value.toUpperCase())} placeholder="e.g. PA" maxLength={2} className="bg-zinc-800 border-zinc-700 text-white text-xs h-8 uppercase" data-testid="input-origin-state" />
          </div>
          <div>
            <Label className="text-xs text-zinc-400 mb-1 block">Dest City</Label>
            <Input value={destCity} onChange={e => setDestCity(e.target.value)} placeholder="any" className="bg-zinc-800 border-zinc-700 text-white text-xs h-8" data-testid="input-dest-city" />
          </div>
          <div>
            <Label className="text-xs text-zinc-400 mb-1 block">Dest State</Label>
            <Input value={destState} onChange={e => setDestState(e.target.value.toUpperCase())} placeholder="any" maxLength={2} className="bg-zinc-800 border-zinc-700 text-white text-xs h-8 uppercase" data-testid="input-dest-state" />
          </div>
          <div className="col-span-2">
            <Label className="text-xs text-zinc-400 mb-1 block">Notes (optional)</Label>
            <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. All Carlisle PA outbound" className="bg-zinc-800 border-zinc-700 text-white text-xs h-8" data-testid="input-lane-notes" />
          </div>
        </div>
        <p className="text-[10px] text-zinc-500">Leave a field blank to match any value. E.g. Origin: PA with no city matches all Pennsylvania origins.</p>
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} className="text-zinc-400">Cancel</Button>
          <Button size="sm" onClick={() => mutation.mutate()} disabled={!isValid || mutation.isPending} className="bg-amber-500 hover:bg-amber-400 text-black" data-testid="button-save-lane">
            {mutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Assign Lane
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Inline lane management in contact detail ──────────────────────────────────
interface ContactLaneManagerProps {
  contactId: string;
}

export function ContactLaneManager({ contactId }: ContactLaneManagerProps) {
  const [addOpen, setAddOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: attributions = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/contacts", contactId, "lane-attributions"],
    queryFn: () => fetch(`/api/contacts/${contactId}/lane-attributions`, { credentials: "include" }).then(r => r.json()),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/contact-lane-attributions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "lane-attributions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/relationship-freight-summary"] });
      toast({ title: "Lane removed" });
    },
  });

  return (
    <div className="space-y-2" data-testid="section-lane-manager">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Lane Attributions</p>
        <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)} className="h-6 px-2 text-[10px] text-amber-400 hover:text-amber-300" data-testid="button-add-lane-attrib">
          <Plus className="w-3 h-3 mr-1" /> Add Lane
        </Button>
      </div>
      {isLoading ? (
        <div className="text-xs text-zinc-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading...</div>
      ) : attributions.length === 0 ? (
        <p className="text-[10px] text-zinc-600 italic">No lanes assigned yet. Add lane patterns to attribute freight to this contact.</p>
      ) : (
        <div className="space-y-1">
          {attributions.map((a: any) => (
            <div key={a.id} className="flex items-center justify-between px-2 py-1.5 rounded bg-zinc-800/50 text-xs group" data-testid={`lane-attrib-${a.id}`}>
              <div className="flex items-center gap-2 min-w-0">
                <Truck className="w-3 h-3 text-zinc-500 flex-shrink-0" />
                <span className="text-zinc-300 truncate">
                  {[a.originCity, a.originState].filter(Boolean).join(" ") || "Any origin"}
                  {" → "}
                  {[a.destinationCity, a.destinationState].filter(Boolean).join(" ") || "Any dest"}
                </span>
                {a.notes && <span className="text-zinc-600 text-[10px] truncate">· {a.notes}</span>}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                <Badge variant="outline" className="text-[9px] h-4 px-1 border-zinc-700 text-zinc-500 capitalize">{a.source}</Badge>
                <button
                  onClick={() => deleteMutation.mutate(a.id)}
                  className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 ml-1 transition-opacity"
                  data-testid={`button-remove-lane-${a.id}`}
                  title="Remove lane"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {addOpen && (
        <AddLaneDialog
          contactId={contactId}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "lane-attributions"] });
            queryClient.invalidateQueries({ queryKey: ["/api/relationship-freight-summary"] });
            setAddOpen(false);
          }}
        />
      )}
    </div>
  );
}
