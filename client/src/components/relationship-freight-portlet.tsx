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
import { ChevronDown, ChevronUp, TrendingUp, Users, Package, DollarSign, Truck, Plus, Info, Loader2, ArrowUpCircle, Building2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const BASE_CONFIG: Record<string, { label: string; color: string; bg: string; border: string; emoji: string }> = {
  "1st": { label: "1st Base",  color: "text-blue-600 dark:text-blue-400",    bg: "bg-blue-50 dark:bg-blue-950/40",    border: "border-blue-200 dark:border-blue-800/40",    emoji: "🟦" },
  "2nd": { label: "2nd Base",  color: "text-yellow-600 dark:text-yellow-400", bg: "bg-yellow-50 dark:bg-yellow-950/40", border: "border-yellow-200 dark:border-yellow-800/40", emoji: "🟨" },
  "3rd": { label: "3rd Base",  color: "text-orange-600 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950/40", border: "border-orange-200 dark:border-orange-800/40", emoji: "🟧" },
  "hr":  { label: "Home Run",  color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/40", border: "border-emerald-200 dark:border-emerald-800/40", emoji: "🟩" },
  "home":{ label: "Home Run",  color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/40", border: "border-emerald-200 dark:border-emerald-800/40", emoji: "🟩" },
  "unknown": { label: "Unassigned", color: "text-muted-foreground", bg: "bg-muted/40", border: "border-border/40", emoji: "⬜" },
};

function fmt$(n: number | null | undefined) {
  if (n == null || isNaN(n as number)) return "—";
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
  marginPct: number | null;
  contractedPct: number | null;
  spotPct: number | null;
}

// ── Dashboard-level portlet ───────────────────────────────────────────────────
export function RelationshipFreightDashboardPortlet({ externalData }: { externalData?: { summary: SummaryRow[]; totalContacts: number; totalLoads: number; totalMargin: number } }) {
  const [collapsed, setCollapsed] = useState(false);
  const { data: fetchedData, isLoading } = useQuery<{ summary: SummaryRow[]; totalContacts: number; totalLoads: number; totalMargin: number }>({
    queryKey: ["/api/relationship-freight-summary"],
    enabled: !externalData,
  });
  const data = externalData ?? fetchedData;

  const hasAnyLoads = (data?.summary ?? []).some(r => r.loads > 0);

  return (
    <Card data-testid="card-relationship-freight-dashboard">
      <CardHeader className="pb-2 cursor-pointer" onClick={() => setCollapsed(p => !p)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-amber-500" />
            <CardTitle className="text-sm font-semibold">Relationship Freight Performance</CardTitle>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  Contacts grouped by relationship level (1st/2nd/3rd/HR). Each level shows the total freight for the companies where you have relationships at that tier.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <div className="flex items-center gap-3">
            {!collapsed && data && (
              <span className="text-xs text-muted-foreground">{data.totalContacts} contacts · {data.totalLoads.toLocaleString()} loads · {fmt$(data.totalMargin)} margin</span>
            )}
            {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
          </div>
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading...
            </div>
          ) : !data || data.summary.length === 0 ? (
            <EmptyState message="No lanes assigned yet. Go to a contact sheet, set their relationship base (1st/2nd/3rd/HR), then assign their lanes using the + button. Freight is only counted when specific lanes are attributed to a contact." />
          ) : (
            <div className="space-y-2">
              {!hasAnyLoads && (
                <div className="text-xs text-muted-foreground bg-muted/50 rounded px-3 py-2 mb-3">
                  Contacts have base levels set but no matching financial data found. Make sure a financial upload is on file and company names match.
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
  marginPerLoad: number | null;
  contractedPct: number | null;
  spotPct: number | null;
  attributions: any[];
  coverageLaneCount: number;
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

  // Each contact shows their own lane-specific freight
  const contacts = data?.contacts ?? [];
  const hasContacts = contacts.length > 0;
  const totalLoads = contacts.reduce((s, c) => s + c.loads, 0);
  const totalMargin = contacts.reduce((s, c) => s + c.margin, 0);
  const hasAnyAttributions = hasContacts && totalLoads > 0;

  // Group contacts by base
  const baseOrder = ["hr", "home", "3rd", "2nd", "1st", "unknown"];
  const grouped: Record<string, CompanyContact[]> = {};
  for (const c of contacts) {
    const key = c.relationshipBase || "unknown";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(c);
  }

  return (
    <Card data-testid="card-relationship-freight-company">
      <CardHeader className="pb-2 cursor-pointer" onClick={() => setCollapsed(p => !p)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-amber-500" />
            <CardTitle className="text-sm font-semibold">Contact Freight Attribution</CardTitle>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  Shows freight attributed to each contact based on their assigned lanes and coverage assignments. Contacts appear if they have a relationship base set and either explicit lane attributions or facility coverage assignments (from the RFP Coverage tab). Add explicit lanes with the + button for more precise attribution.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <div className="flex items-center gap-3">
            {!collapsed && hasAnyAttributions && (
              <span className="text-xs text-muted-foreground">{totalLoads} loads · {fmt$(totalMargin)}</span>
            )}
            {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
          </div>
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading...
            </div>
          ) : !hasContacts ? (
            <EmptyState message="No contacts with a relationship base and lane or coverage assignments found. Set a contact's base level (1st/2nd/3rd/HR) in their contact sheet, then assign lanes there or via the RFP Coverage tab." />
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

  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 group" data-testid={`row-contact-freight-${contact.contactId}`}>
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: cfg.color.includes("emerald") ? "#34d399" : cfg.color.includes("blue") ? "#60a5fa" : cfg.color.includes("yellow") ? "#facc15" : cfg.color.includes("orange") ? "#fb923c" : "#a1a1aa" }} />
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground truncate">{contact.contactName}</p>
          {contact.contactTitle && <p className="text-[10px] text-muted-foreground truncate">{contact.contactTitle}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 ml-2">
        {hasLoads ? (
          <>
            <span className="text-xs text-foreground font-mono">{contact.loads.toLocaleString()} loads</span>
            <span className="text-xs text-emerald-600 dark:text-emerald-400 font-mono">{fmt$(contact.margin)}</span>
            {contact.marginPerLoad != null && (
              <span className="text-[10px] text-muted-foreground font-mono">{fmt$(contact.marginPerLoad)}/ld</span>
            )}
            {contact.contractedPct != null && (
              <span className="text-[10px] text-muted-foreground">{contact.contractedPct.toFixed(0)}% ct</span>
            )}
          </>
        ) : (
          <span className="text-[10px] text-muted-foreground italic">no matching data</span>
        )}
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-amber-500 opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); onAddLane(); }} data-testid={`button-add-lane-${contact.contactId}`} title="Add lane attribution">
          <Plus className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );
}

function SummaryTable({ rows }: { rows: SummaryRow[] }) {
  // Only show rows that have at least one contact with lanes assigned
  const activeRows = rows.filter(r => r.contacts > 0);
  if (activeRows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b">
            <th className="text-left py-2 text-muted-foreground font-medium">Level</th>
            <th className="text-right py-2 text-muted-foreground font-medium px-2">Contacts</th>
            <th className="text-right py-2 text-muted-foreground font-medium px-2">Loads</th>
            <th className="text-right py-2 text-muted-foreground font-medium px-2">Margin</th>
            <th className="text-right py-2 text-muted-foreground font-medium px-2">$/Load</th>
            <th className="text-right py-2 text-muted-foreground font-medium px-2">Contract %</th>
            <th className="text-right py-2 text-muted-foreground font-medium px-2">Spot %</th>
          </tr>
        </thead>
        <tbody>
          {activeRows.map(row => {
            const cfg = BASE_CONFIG[row.base] ?? BASE_CONFIG["unknown"];
            return (
              <tr key={row.base} className="border-b hover:bg-muted/40" data-testid={`row-relationship-${row.base}`}>
                <td className="py-2">
                  <span className={`font-semibold ${cfg.color}`}>{cfg.emoji} {cfg.label}</span>
                </td>
                <td className="text-right py-2 px-2 text-foreground">{row.contacts}</td>
                <td className="text-right py-2 px-2 text-foreground font-mono">{row.loads > 0 ? row.loads.toLocaleString() : <span className="text-muted-foreground">—</span>}</td>
                <td className="text-right py-2 px-2 font-mono">
                  {row.loads > 0 ? <span className="text-emerald-600 dark:text-emerald-400">{fmt$(row.margin)}</span> : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="text-right py-2 px-2 font-mono">
                  {row.marginPct != null ? <span className="text-amber-600 dark:text-amber-400">{fmt$(row.marginPct)}</span> : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="text-right py-2 px-2 text-foreground">
                  {row.contractedPct != null ? `${row.contractedPct.toFixed(0)}%` : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="text-right py-2 px-2 text-foreground">
                  {row.spotPct != null ? `${row.spotPct.toFixed(0)}%` : <span className="text-muted-foreground">—</span>}
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
      <Package className="w-8 h-8 text-muted-foreground/40" />
      <p className="text-xs text-muted-foreground max-w-xs">{message}</p>
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
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Assign Lane to Contact</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Origin City</Label>
            <Input value={originCity} onChange={e => setOriginCity(e.target.value)} placeholder="e.g. Carlisle" className="text-xs h-8" data-testid="input-origin-city" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Origin State</Label>
            <Input value={originState} onChange={e => setOriginState(e.target.value.toUpperCase())} placeholder="e.g. PA" maxLength={2} className="text-xs h-8 uppercase" data-testid="input-origin-state" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Dest City</Label>
            <Input value={destCity} onChange={e => setDestCity(e.target.value)} placeholder="any" className="text-xs h-8" data-testid="input-dest-city" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Dest State</Label>
            <Input value={destState} onChange={e => setDestState(e.target.value.toUpperCase())} placeholder="any" maxLength={2} className="text-xs h-8 uppercase" data-testid="input-dest-state" />
          </div>
          <div className="col-span-2">
            <Label className="text-xs text-muted-foreground mb-1 block">Notes (optional)</Label>
            <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. All Carlisle PA outbound" className="text-xs h-8" data-testid="input-lane-notes" />
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">Leave a field blank to match any value. E.g. Origin: PA with no city matches all Pennsylvania origins.</p>
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
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
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Lane Attributions</p>
        <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)} className="h-6 px-2 text-[10px] text-amber-500 hover:text-amber-600" data-testid="button-add-lane-attrib">
          <Plus className="w-3 h-3 mr-1" /> Add Lane
        </Button>
      </div>
      {isLoading ? (
        <div className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading...</div>
      ) : attributions.length === 0 ? (
        <p className="text-[10px] text-muted-foreground italic">No lanes assigned yet. Add lane patterns to attribute freight to this contact.</p>
      ) : (
        <div className="space-y-1">
          {attributions.map((a: any) => (
            <div key={a.id} className="flex items-center justify-between px-2 py-1.5 rounded bg-muted/50 text-xs group" data-testid={`lane-attrib-${a.id}`}>
              <div className="flex items-center gap-2 min-w-0">
                <Truck className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                <span className="text-foreground truncate">
                  {[a.originCity, a.originState].filter(Boolean).join(" ") || "Any origin"}
                  {" → "}
                  {[a.destinationCity, a.destinationState].filter(Boolean).join(" ") || "Any dest"}
                </span>
                {a.notes && <span className="text-muted-foreground text-[10px] truncate">· {a.notes}</span>}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                <Badge variant="outline" className="text-[9px] h-4 px-1 capitalize">{a.source}</Badge>
                <button
                  onClick={() => deleteMutation.mutate(a.id)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 ml-1 transition-opacity"
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

// ── Relationship Base Distribution portlet ────────────────────────────────────
type ContactEntry = {
  contactId: string;
  contactName: string;
  contactTitle: string | null;
  companyId: string;
  companyName: string;
  baseAdvancedAt: string | null;
  recentlyAdvanced: boolean;
};
type BaseLevel = { base: string; label: string; companies: number; contacts: number; contactList: ContactEntry[] };
type RecentAdvance = { base: string; label: string; count: number };
type DistributionData = {
  levels: BaseLevel[];
  recentAdvances: RecentAdvance[];
  totalCompanies: number;
  totalContacts: number;
  greenfieldCount?: number;
};

// Light-mode–safe progress bar colors keyed by level
const BAR_COLOR: Record<string, string> = {
  hr: "bg-blue-500",
  "3rd": "bg-yellow-500",
  "2nd": "bg-orange-500",
  "1st": "bg-emerald-500",
  unknown: "bg-muted-foreground/40",
};

// Light-mode–safe label colors
const LABEL_COLOR: Record<string, string> = {
  hr: "text-blue-600 dark:text-blue-400",
  "3rd": "text-yellow-600 dark:text-yellow-400",
  "2nd": "text-orange-600 dark:text-orange-400",
  "1st": "text-emerald-600 dark:text-emerald-400",
  unknown: "text-muted-foreground",
};

export function RelationshipBaseDistributionPortlet({ externalData }: { externalData?: DistributionData }) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedBase, setExpandedBase] = useState<string | null>(null);

  const { data: fetchedData, isLoading } = useQuery<DistributionData>({
    queryKey: ["/api/relationship-base-distribution"],
    enabled: !externalData,
  });
  const data = externalData ?? fetchedData;

  const maxCompanies = Math.max(1, ...(data?.levels ?? []).map(l => l.companies));

  function toggleLevel(base: string) {
    setExpandedBase(prev => (prev === base ? null : base));
  }

  return (
    <Card data-testid="card-relationship-base-distribution">
      <CardHeader className="pb-2 cursor-pointer" onClick={() => setCollapsed(p => !p)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-amber-500" />
            <CardTitle className="text-sm font-semibold">Relationship Coverage by Level</CardTitle>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  How many customers have contacts at each relationship level. Click any level to see the contacts. Contacts advanced in the last 30 days are highlighted.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <div className="flex items-center gap-3">
            {!collapsed && data && (
              <span className="text-xs text-muted-foreground">
                {data.totalContacts} contacts · {data.totalCompanies} customers
              </span>
            )}
            {collapsed
              ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
              : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
          </div>
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="pt-0 space-y-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading...
            </div>
          ) : !data || data.levels.length === 0 ? (
            <EmptyState message="No contacts assigned to relationship levels yet." />
          ) : (
            <>
              {/* Greenfield — accounts with zero relationship contacts mapped */}
              {(data.greenfieldCount ?? 0) > 0 && (
                <div className="flex items-center justify-between text-xs px-2 py-1.5 rounded-md bg-muted/40 border border-dashed border-muted-foreground/30 text-muted-foreground mb-1">
                  <span className="flex items-center gap-1.5 font-medium">
                    <span className="text-base leading-none">🌱</span> Unworked Accounts
                  </span>
                  <span className="font-mono">{data.greenfieldCount} customer{(data.greenfieldCount ?? 0) !== 1 ? "s" : ""} — no contacts mapped yet</span>
                </div>
              )}

              {/* Level rows */}
              <div className="space-y-1">
                {data.levels.map(level => {
                  const cfg = BASE_CONFIG[level.base] ?? BASE_CONFIG["unknown"];
                  const barPct = Math.round((level.companies / maxCompanies) * 100);
                  const advance = data.recentAdvances.find(r => r.base === level.base);
                  const isOpen = expandedBase === level.base;

                  return (
                    <div key={level.base} data-testid={`row-distribution-${level.base}`}>
                      {/* Clickable level row */}
                      <button
                        className="w-full text-left rounded-md px-2 py-1.5 hover:bg-muted/60 transition-colors group"
                        onClick={() => toggleLevel(level.base)}
                        data-testid={`btn-expand-level-${level.base}`}
                      >
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className={`font-semibold flex items-center gap-1.5 ${LABEL_COLOR[level.base] ?? "text-muted-foreground"}`}>
                            {cfg.emoji} {cfg.label}
                            {isOpen
                              ? <ChevronUp className="w-3 h-3 opacity-60" />
                              : <ChevronDown className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity" />}
                          </span>
                          <div className="flex items-center gap-3">
                            {advance && (
                              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                                <ArrowUpCircle className="w-3 h-3" />
                                +{advance.count} this month
                              </span>
                            )}
                            <span className="text-foreground font-mono">
                              {level.companies} customer{level.companies !== 1 ? "s" : ""}
                            </span>
                            <span className="text-muted-foreground font-mono">
                              {level.contacts} contact{level.contacts !== 1 ? "s" : ""}
                            </span>
                          </div>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${BAR_COLOR[level.base] ?? "bg-muted-foreground/40"}`}
                            style={{ width: `${barPct}%` }}
                          />
                        </div>
                      </button>

                      {/* Expanded contact list */}
                      {isOpen && level.contactList.length > 0 && (
                        <div className="mt-1 mb-2 mx-1 rounded-md border bg-muted/30 overflow-hidden">
                          <div className="max-h-64 overflow-y-auto divide-y divide-border">
                            {level.contactList.map(c => (
                              <a
                                key={c.contactId}
                                href={`/companies/${c.companyId}`}
                                className="flex items-center justify-between px-3 py-2 text-xs hover:bg-muted/60 transition-colors"
                                data-testid={`link-contact-${c.contactId}`}
                              >
                                <div className="min-w-0">
                                  <span className="font-medium text-foreground truncate block">{c.contactName}</span>
                                  <span className="text-muted-foreground truncate block">
                                    {c.contactTitle ? `${c.contactTitle} · ` : ""}{c.companyName}
                                  </span>
                                </div>
                                {c.recentlyAdvanced && (
                                  <span className="ml-2 shrink-0 flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium whitespace-nowrap">
                                    <ArrowUpCircle className="w-3 h-3" />
                                    {c.baseAdvancedAt
                                      ? new Date(c.baseAdvancedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                                      : "Recently"}
                                  </span>
                                )}
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Recent advances footer */}
              {data.recentAdvances.length > 0 && (
                <div className="pt-2 border-t">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-2 px-2">
                    Last 30 Days — Relationship Advances
                  </p>
                  <div className="flex flex-wrap gap-2 px-2 pb-1">
                    {data.recentAdvances.map(adv => {
                      const cfg = BASE_CONFIG[adv.base] ?? BASE_CONFIG["unknown"];
                      return (
                        <div
                          key={adv.base}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${cfg.bg} ${cfg.border} ${cfg.color}`}
                          data-testid={`badge-advance-${adv.base}`}
                        >
                          <ArrowUpCircle className="w-3 h-3" />
                          {adv.count} → {cfg.label}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ── T006: Consolidated dashboard section — single API call for both portlets ──
type ConsolidatedData = {
  distribution: DistributionData;
  summary: { summary: SummaryRow[]; totalContacts: number; totalLoads: number; totalMargin: number };
};

export function RelationshipDashboardSection() {
  const { data } = useQuery<ConsolidatedData>({
    queryKey: ["/api/dashboard-relationship-summary"],
  });

  return (
    <div className="space-y-3">
      <RelationshipFreightDashboardPortlet externalData={data?.summary} />
      <RelationshipBaseDistributionPortlet externalData={data?.distribution} />
    </div>
  );
}
