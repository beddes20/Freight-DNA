import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PhoneCall, Network, Users, Plus, Upload, Search, Clock, Globe } from "lucide-react";
import { OrgChart } from "@/components/org-chart";
import type { Contact, Company, Touchpoint, User } from "@shared/schema";
import type { TaskWithCount } from "../types";
import { SuggestedContactsPanel } from "../components/SuggestedContactsPanel";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ─── Geo Lane Ownership Panel ─────────────────────────────────────────────────

interface GeoResp {
  id: string;
  contactId: string;
  lanePatternId: string;
  status: string;
  confidenceScore: number;
  responsibilityType: string | null;
  evidenceCount: number;
  sourceTypes: string[] | null;
  pattern: {
    id: string;
    name: string;
    originRegion: string;
    destinationRegion: string;
    namedCorridor: string | null;
  } | null;
}

function GeoLaneOwnershipPanel({ companyId, contacts }: { companyId: string; contacts: Contact[] }) {
  const { toast } = useToast();

  const { data: responsibilities = [], isLoading } = useQuery<GeoResp[]>({
    queryKey: ["/api/internal/accounts", companyId, "geographic-responsibilities"],
    queryFn: () => fetch(`/api/internal/accounts/${companyId}/geographic-responsibilities`, { credentials: "include" }).then(r => r.json()),
  });

  const confirmMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/internal/geographic-responsibilities/${id}/confirm`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts", companyId, "geographic-responsibilities"] });
      toast({ title: "Responsibility confirmed" });
    },
    onError: () => toast({ title: "Failed to confirm", variant: "destructive" }),
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/internal/geographic-responsibilities/${id}/dismiss`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts", companyId, "geographic-responsibilities"] });
      toast({ title: "Responsibility dismissed" });
    },
    onError: () => toast({ title: "Failed to dismiss", variant: "destructive" }),
  });

  const visible = responsibilities.filter(r => r.status !== "dismissed");

  if (!isLoading && visible.length === 0) return null;

  const grouped = visible.reduce<Record<string, GeoResp[]>>((acc, r) => {
    const key = r.pattern?.name ?? "Unknown";
    if (!acc[key]) acc[key] = [];
    acc[key].push(r);
    return acc;
  }, {});

  return (
    <Card data-testid="card-geo-lane-ownership">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Globe className="h-4 w-4 text-emerald-500" />
          Who Owns Which Geographies?
          {!isLoading && <Badge variant="secondary" className="ml-1 font-normal">{visible.length} lane pattern{visible.length !== 1 ? "s" : ""}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {isLoading && (
          <div className="space-y-2">
            {[1, 2, 3].map(i => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}
          </div>
        )}
        {Object.entries(grouped).map(([patternName, rows]) => {
          const best = rows.slice().sort((a, b) => b.confidenceScore - a.confidenceScore)[0];
          const contact = contacts.find(c => c.id === best.contactId);
          const others = rows.length > 1 ? rows.slice(1).map(r => contacts.find(c => c.id === r.contactId)?.name).filter(Boolean) : [];
          return (
            <div key={patternName} className="rounded-md border p-3 space-y-2" data-testid={`geo-ownership-row-${best.id}`}>
              <div className="flex items-start gap-2 flex-wrap">
                <span className="text-sm font-medium flex-1 min-w-0">{patternName}</span>
                {best.confidenceScore >= 70
                  ? <Badge className="text-xs bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">High confidence</Badge>
                  : best.confidenceScore >= 40
                  ? <Badge className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Medium confidence</Badge>
                  : <Badge className="text-xs bg-muted text-muted-foreground">Low confidence</Badge>
                }
                {best.status === "confirmed"
                  ? <Badge className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">Confirmed</Badge>
                  : <Badge className="text-xs bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">Suggested</Badge>
                }
              </div>
              <p className="text-sm">
                <span className="text-muted-foreground">Primary: </span>
                <span className="font-medium">{contact?.name ?? "Unknown contact"}</span>
                {contact?.title && <span className="text-muted-foreground"> · {contact.title}</span>}
              </p>
              {others.length > 0 && (
                <p className="text-xs text-muted-foreground">Also: {others.join(", ")}</p>
              )}
              <p className="text-xs text-muted-foreground">{best.evidenceCount} evidence event{best.evidenceCount !== 1 ? "s" : ""} · {(best.sourceTypes ?? []).join(", ") || "unknown source"}</p>
              {best.status === "suggested" && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs text-blue-600 border-blue-200 hover:bg-blue-50 dark:text-blue-400 dark:border-blue-800"
                    onClick={() => confirmMutation.mutate(best.id)}
                    disabled={confirmMutation.isPending}
                    data-testid={`button-confirm-ownership-${best.id}`}
                  >
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => dismissMutation.mutate(best.id)}
                    disabled={dismissMutation.isPending}
                    data-testid={`button-dismiss-ownership-${best.id}`}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

interface ActivityItem {
  type: string;
  title: string;
  description: string | null;
  date: string;
  userName: string | null;
}

interface PeopleTabProps {
  company: Company;
  contacts: Contact[] | undefined;
  companyTouchpoints: Touchpoint[];
  activityItems: ActivityItem[];
  handleAddContact: () => void;
  handleEditContact: (c: Contact) => void;
  setZoomInfoOpen: (v: boolean) => void;
  setImportDialogOpen: (v: boolean) => void;
  setViewContact: (v: Contact | null) => void;
  setIntelContact: (v: Contact | null) => void;
  onLogTouch: (contactId: string) => void;
  setEditingTaskItem: (v: TaskWithCount | undefined) => void;
  setForceLanePrefill: (v: { title: string; notes?: string; attachedLaneData?: any[] } | undefined) => void;
  setTaskDialogOpen: (v: boolean) => void;
  setOrgEmailContact: (v: Contact | null) => void;
  currentUser: Omit<User, "password"> | null | undefined;
}

export function PeopleTab({
  company,
  contacts,
  companyTouchpoints,
  activityItems,
  handleAddContact,
  handleEditContact,
  setZoomInfoOpen,
  setImportDialogOpen,
  setViewContact,
  setIntelContact,
  onLogTouch,
  setEditingTaskItem,
  setForceLanePrefill,
  setTaskDialogOpen,
  setOrgEmailContact,
}: PeopleTabProps) {
  const TYPE_LABELS: Record<string, string> = { call: "Call", email: "Email", text: "Text", site_visit: "Site Visit" };
  const TYPE_COLORS: Record<string, string> = {
    call:       "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    email:      "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
    text:       "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    site_visit: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  };

  return (
    <>
      <SuggestedContactsPanel companyId={company.id} />

      {company.notes && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{company.notes}</p>
          </CardContent>
        </Card>
      )}

      {companyTouchpoints.length > 0 && (() => {
        const now = new Date();
        const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
        const monthTps = companyTouchpoints.filter(tp => tp.date >= monthStart);
        const uniqueContacts = new Set(monthTps.map(tp => tp.contactId)).size;
        const recentTps = [...companyTouchpoints].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
        return (
          <Card data-testid="card-touchpoints-summary">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <PhoneCall className="h-4 w-4 text-cyan-500" />
                Touchpoints
                <Badge variant="secondary" className="ml-1 font-normal">{monthTps.length} this month · {uniqueContacts} contacts</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-1">
              {recentTps.map(tp => {
                const dateStr = (() => {
                  try { return new Date(tp.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
                  catch { return tp.date; }
                })();
                const cnt = contacts?.find(c => c.id === tp.contactId);
                return (
                  <div
                    key={tp.id}
                    className="flex items-center gap-2 py-1.5 cursor-pointer hover:bg-muted/40 rounded px-1"
                    onClick={() => cnt && setViewContact(cnt)}
                    data-testid={`tp-row-${tp.id}`}
                  >
                    <span className={`inline-flex text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${TYPE_COLORS[tp.type] ?? "bg-muted text-muted-foreground"}`}>
                      {TYPE_LABELS[tp.type] ?? tp.type}
                    </span>
                    <span className="text-sm truncate">{cnt?.name ?? "Unknown"}</span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">{dateStr}</span>
                    {tp.notes && <span className="text-xs text-muted-foreground truncate max-w-[120px]">· {tp.notes}</span>}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })()}

      {activityItems.length > 0 && (
        <Card data-testid="card-activity-timeline">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4 text-violet-500" />
              Account Activity
              <Badge variant="secondary" className="ml-1 font-normal">{activityItems.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="relative space-y-0">
              {activityItems.slice(0, 10).map((item, i) => {
                const iconColor =
                  item.type === "task_completed" ? "bg-green-500" :
                  item.type === "task_created" ? "bg-blue-500" :
                  item.type === "callout" ? "bg-orange-500" :
                  item.type === "rfp" ? "bg-violet-500" : "bg-muted-foreground";
                const dateStr = (() => {
                  try {
                    const d = new Date(item.date);
                    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                  } catch { return item.date; }
                })();
                return (
                  <div key={i} className="flex gap-3 pb-4 relative" data-testid={`activity-item-${i}`}>
                    <div className="flex flex-col items-center">
                      <div className={`h-2 w-2 rounded-full mt-1.5 shrink-0 ${iconColor}`} />
                      {i < activityItems.slice(0, 10).length - 1 && (
                        <div className="w-px flex-1 bg-border mt-1" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 pb-1">
                      <p className="text-sm font-medium leading-tight">{item.title}</p>
                      {item.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.description}</p>}
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                        <span>{dateStr}</span>
                        {item.userName && <><span>·</span><span>{item.userName}</span></>}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <GeoLaneOwnershipPanel companyId={company.id} contacts={contacts ?? []} />

      <Card data-testid="card-org-chart-section">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Network className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              <h2 className="text-base font-medium">Org Chart</h2>
              <Badge variant="secondary">{contacts?.length || 0} contacts</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setZoomInfoOpen(true)} className="border-amber-400/50 text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30" data-testid="button-zoominfo-suggest">
                <Search className="h-3.5 w-3.5 mr-1.5" />
                Find Contacts
              </Button>
              <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)} data-testid="button-import-contacts">
                <Upload className="h-4 w-4 mr-1.5" />
                Import
              </Button>
              <Button onClick={handleAddContact} data-testid="button-add-contact-top">
                <Plus className="h-4 w-4 mr-2" />
                Add Contact
              </Button>
            </div>
          </div>
          {contacts && contacts.length > 0 ? (
            <OrgChart
              contacts={contacts}
              touchpoints={companyTouchpoints}
              onEditContact={handleEditContact}
              onViewContact={setViewContact}
              onLogTouch={(c) => onLogTouch(c.id)}
              onIntelClick={setIntelContact}
              onCreateTask={(c) => {
                setEditingTaskItem(undefined);
                setForceLanePrefill({
                  title: `Follow up with ${c.name}`,
                  notes: `Contact: ${c.name}${c.title ? ` — ${c.title}` : ""}${c.email ? `\nEmail: ${c.email}` : ""}${c.phone ? `\nPhone: ${c.phone}` : ""}`,
                });
                setTaskDialogOpen(true);
              }}
              onSendEmail={(c) => setOrgEmailContact(c)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-8">
              <Users className="h-10 w-10 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground text-center max-w-sm">
                Start building your org chart by adding the first contact for this company
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
