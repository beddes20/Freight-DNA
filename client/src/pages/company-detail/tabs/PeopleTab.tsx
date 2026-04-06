import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PhoneCall, Network, Users, Plus, Upload, Search, Clock } from "lucide-react";
import { OrgChart } from "@/components/org-chart";
import type { Contact, Company, Touchpoint, User } from "@shared/schema";
import type { TaskWithCount } from "../types";

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
  setQuickTouchContactId: (v: string) => void;
  setQuickTouchOpen: (v: boolean) => void;
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
  setQuickTouchContactId,
  setQuickTouchOpen,
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
              onLogTouch={(c) => { setQuickTouchContactId(c.id); setQuickTouchOpen(true); }}
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
