import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Phone,
  Mail,
  MessageSquare,
  MapPin,
  Printer,
  User,
  Clock,
  ClipboardList,
  AlertTriangle,
  TrendingUp,
  Trophy,
  Activity,
  DollarSign,
  Building2,
  Sparkles,
  Loader2,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { fmtMoney } from "@/lib/rep-utils";
import type { Company, Contact, Touchpoint, Rfp, Award } from "@shared/schema";
import { ContactIntelModal } from "@/components/contact-intel-modal";

type TaskLike = { id: string | number; title: string; status: string; dueDate?: string | null };
type FinancialSummary = { totalLoads: number; totalMargin: number; totalRevenue?: number } | null;

interface HealthFactor { name: string; score: number; max: number; label: string }
interface HealthScore { score: number; grade: string; color: string; factors: HealthFactor[] }

interface PreCallPlannerProps {
  open: boolean;
  onClose: () => void;
  company: Company;
  contacts: Contact[];
  touchpoints: Touchpoint[];
  tasks: TaskLike[];
  rfps: Rfp[];
  awards: Award[];
  financialSummary: FinancialSummary;
  healthScore: HealthScore | null | undefined;
}

const touchTypeIcon = (type: string) => {
  if (type === "call")      return <Phone className="h-3.5 w-3.5 text-blue-500" />;
  if (type === "email")     return <Mail className="h-3.5 w-3.5 text-purple-500" />;
  if (type === "text")      return <MessageSquare className="h-3.5 w-3.5 text-green-500" />;
  if (type === "site_visit")return <MapPin className="h-3.5 w-3.5 text-orange-500" />;
  return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
};

const healthColor = (color: string) => {
  if (color === "green") return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
  if (color === "blue")  return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
  if (color === "amber") return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
};

export function PreCallPlanner({
  open,
  onClose,
  company,
  contacts,
  touchpoints,
  tasks,
  rfps,
  awards,
  financialSummary,
  healthScore,
}: PreCallPlannerProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const [talkingPoints, setTalkingPoints] = useState<string[]>([]);
  const [loadingPoints, setLoadingPoints] = useState(false);
  const [selectedContactForIntel, setSelectedContactForIntel] = useState<Contact | null>(null);

  const generateTalkingPoints = async () => {
    setLoadingPoints(true);
    try {
      const res = await apiRequest("POST", "/api/ai/talking-points", {
        company,
        contacts,
        touchpoints,
        tasks,
        rfps,
        financialSummary: financialSummary ? { ytdLoads: financialSummary.totalLoads, ytdMargin: financialSummary.totalMargin } : null,
        accountIntelligence: { quirks: (company as any).accountQuirks, spotProcess: (company as any).spotProcess },
      });
      const data = await res.json();
      setTalkingPoints(data.points || []);
    } catch {
      setTalkingPoints(["Unable to generate talking points. Try again."]);
    } finally {
      setLoadingPoints(false);
    }
  };

  const handlePrint = () => {
    const win = window.open("", "_blank");
    if (!win || !printRef.current) return;
    win.document.write(`
      <html><head><title>Pre-Call Brief — ${company.name}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; padding: 24px; max-width: 800px; margin: 0 auto; font-size: 13px; }
        h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
        h2 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; margin: 16px 0 8px; }
        .meta { color: #6b7280; font-size: 12px; }
        .row { display: flex; gap: 16px; margin-bottom: 6px; }
        .label { font-weight: 600; min-width: 120px; color: #374151; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; background: #dbeafe; color: #1e40af; }
        .badge.green { background: #dcfce7; color: #166534; }
        .badge.amber { background: #fef3c7; color: #92400e; }
        .badge.red { background: #fee2e2; color: #991b1b; }
        .tp-row { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 6px; border-bottom: 1px solid #f3f4f6; padding-bottom: 6px; }
        .tp-date { color: #6b7280; min-width: 90px; font-size: 12px; }
        .tp-type { min-width: 70px; font-weight: 600; font-size: 12px; }
        .tp-note { flex: 1; font-size: 12px; }
        .contact-card { border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; }
        .contact-name { font-weight: 600; }
        .contact-title { color: #6b7280; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; }
        td, th { text-align: left; padding: 4px 8px; font-size: 12px; border-bottom: 1px solid #f3f4f6; }
        th { font-weight: 600; color: #6b7280; }
        .alert { background: #fef3c7; border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; font-size: 12px; }
      </style>
      </head><body>
      ${printRef.current.innerHTML}
      <p class="meta" style="margin-top:24px;color:#9ca3af;">Generated ${new Date().toLocaleString()}</p>
      </body></html>
    `);
    win.document.close();
    win.print();
  };

  const recentTouchpoints = [...touchpoints]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);

  const openTasks = tasks.filter(t => t.status !== "complete" && t.status !== "completed");
  const companyRfps = rfps.filter(r => r.companyId === company.id);
  const companyAwards = awards.filter(a => a.companyId === company.id);
  const activeRfp = companyRfps.find(r => r.status === "open" || r.status === "pending");

  return (
    <>
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-primary" />
              Pre-Call Brief
            </DialogTitle>
            <div className="flex items-center gap-2 mr-8">
              <Button variant="outline" size="sm" onClick={generateTalkingPoints} disabled={loadingPoints} data-testid="button-ai-talking-points">
                {loadingPoints ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1.5 text-purple-500" />}
                {loadingPoints ? "Generating..." : "AI Points"}
              </Button>
              <Button variant="outline" size="sm" onClick={handlePrint} data-testid="button-print-precall">
                <Printer className="h-4 w-4 mr-1.5" />
                Print
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div ref={printRef} className="space-y-5 py-2">
          {/* AI Talking Points */}
          {talkingPoints.length > 0 && (
            <section className="bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 rounded-lg p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-700 dark:text-purple-300 mb-2 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5" /> AI Talking Points
              </h3>
              <ol className="space-y-2">
                {talkingPoints.map((pt, i) => (
                  <li key={i} className="flex gap-2 text-sm" data-testid={`precall-talking-point-${i}`}>
                    <span className="font-bold text-purple-600 dark:text-purple-400 shrink-0">{i + 1}.</span>
                    <span>{pt}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* Company Header */}
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <Building2 className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-semibold" data-testid="precall-company-name">{company.name}</h2>
                {healthScore && (
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${healthColor(healthScore.color)}`}>
                    <Activity className="h-3 w-3" />
                    {healthScore.grade} · {healthScore.score}/100
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap mt-0.5">
                {company.industry && <span>{company.industry}</span>}
                {company.website && (
                  <a href={company.website.startsWith("http") ? company.website : `https://${company.website}`} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                    {company.website}
                  </a>
                )}
              </div>
              {((company as any).shippingModes?.length > 0) && (
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  {((company as any).shippingModes as string[]).map((m: string) => (
                    <span key={m} className="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/30">{m}</span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Financial Snapshot */}
          {financialSummary && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1 mb-2 flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5" /> Financial Snapshot
              </h3>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="bg-muted/40 rounded-md px-3 py-2 text-center">
                  <div className="font-bold text-base">{financialSummary.totalLoads.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">YTD Loads</div>
                </div>
                <div className="bg-muted/40 rounded-md px-3 py-2 text-center">
                  <div className="font-bold text-base">{fmtMoney(financialSummary.totalMargin)}</div>
                  <div className="text-xs text-muted-foreground">YTD Margin</div>
                </div>
                {financialSummary.totalRevenue != null && (
                  <div className="bg-muted/40 rounded-md px-3 py-2 text-center">
                    <div className="font-bold text-base">{fmtMoney(financialSummary.totalRevenue)}</div>
                    <div className="text-xs text-muted-foreground">YTD Revenue</div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Last Meaningful Conversation */}
          {(() => {
            const lastMeaningful = [...touchpoints]
              .filter(t => (t as any).isMeaningful)
              .sort((a, b) => b.date.localeCompare(a.date))[0];
            if (!lastMeaningful) return null;
            const contact = contacts.find(c => c.id === lastMeaningful.contactId);
            const daysAgo = Math.floor((Date.now() - new Date(lastMeaningful.date).getTime()) / 86400000);
            return (
              <section className="bg-green-50/60 dark:bg-green-950/20 border border-green-200/70 dark:border-green-800/40 rounded-lg p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-green-700 dark:text-green-400 mb-2 flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" /> Last Meaningful Conversation
                </h3>
                <div className="text-sm space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{contact?.name || "Unknown contact"}</span>
                    <span className="text-xs text-muted-foreground">{daysAgo}d ago · {lastMeaningful.date}</span>
                  </div>
                  {lastMeaningful.notes && (
                    <p className="text-xs text-muted-foreground italic">"{lastMeaningful.notes}"</p>
                  )}
                </div>
              </section>
            );
          })()}

          {/* Key Contacts */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1 mb-2 flex items-center gap-1.5">
              <User className="h-3.5 w-3.5" /> Key Contacts
            </h3>
            {contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No contacts on file</p>
            ) : (
              <div className="space-y-2">
                {contacts.slice(0, 6).map(c => {
                  const lastTp = touchpoints
                    .filter(t => t.contactId === c.id)
                    .sort((a, b) => b.date.localeCompare(a.date))[0];
                  const hasGeo = (c.lanes && c.lanes.length > 0) || (c.regions && c.regions.length > 0);
                  return (
                    <button
                      key={c.id}
                      onClick={() => setSelectedContactForIntel(c)}
                      className="w-full text-left flex items-start justify-between gap-2 text-sm border rounded-md px-3 py-2 hover:bg-muted/50 hover:border-primary/40 transition-colors group"
                      data-testid={`precall-contact-${c.id}`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium flex items-center gap-1.5">
                          {c.name}
                          {hasGeo && (
                            <MapPin className="h-3 w-3 text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{c.title}{c.email && ` · ${c.email}`}{c.phone && ` · ${c.phone}`}</div>
                      </div>
                      <div className="text-xs text-muted-foreground shrink-0 text-right">
                        {lastTp && <div>Last: {lastTp.date}</div>}
                        <div className="text-primary opacity-0 group-hover:opacity-100 transition-opacity text-xs">View intel →</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Recent Touchpoints */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1 mb-2 flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" /> Recent Activity (Last 5)
            </h3>
            {recentTouchpoints.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No touchpoints logged yet</p>
            ) : (
              <div className="space-y-1.5">
                {recentTouchpoints.map(tp => (
                  <div key={tp.id} className="flex items-start gap-2 text-sm" data-testid={`precall-tp-${tp.id}`}>
                    <span className="shrink-0 pt-0.5">{touchTypeIcon(tp.type)}</span>
                    <span className="text-muted-foreground shrink-0 w-24 text-xs pt-0.5">{tp.date}</span>
                    <span className="capitalize text-xs font-medium shrink-0 w-16 pt-0.5">{tp.type.replace("_", " ")}</span>
                    <span className="text-xs text-muted-foreground line-clamp-2">{tp.notes || <em>No notes</em>}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Open Tasks */}
          {openTasks.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1 mb-2 flex items-center gap-1.5">
                <ClipboardList className="h-3.5 w-3.5" /> Open Tasks ({openTasks.length})
              </h3>
              <div className="space-y-1">
                {openTasks.slice(0, 5).map(t => (
                  <div key={t.id} className="flex items-center justify-between text-sm gap-2" data-testid={`precall-task-${t.id}`}>
                    <span className="line-clamp-1">{t.title}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {t.dueDate && <span className="text-xs text-muted-foreground">{t.dueDate}</span>}
                      <Badge variant="outline" className="text-xs capitalize">{t.status.replace("_", " ")}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* RFP / Award Activity */}
          {(companyRfps.length > 0 || companyAwards.length > 0) && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1 mb-2 flex items-center gap-1.5">
                <Trophy className="h-3.5 w-3.5" /> RFP & Awards
              </h3>
              <div className="space-y-1">
                {companyRfps.map(r => (
                  <div key={r.id} className="flex items-center justify-between text-sm gap-2">
                    <span className="line-clamp-1">{r.title}</span>
                    <Badge variant="outline" className="text-xs capitalize shrink-0">{r.status}</Badge>
                  </div>
                ))}
                {companyAwards.map(a => (
                  <div key={a.id} className="flex items-center justify-between text-sm gap-2">
                    <span className="line-clamp-1">{a.title}</span>
                    <Badge className="text-xs bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 shrink-0">Award</Badge>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Account Intelligence */}
          {(company.accountQuirks || company.spotProcess || company.tenderStyle || company.dlEmail || company.processNotes) && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1 mb-2 flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" /> Account Intelligence
              </h3>
              <div className="space-y-2 text-sm">
                {company.tenderStyle && (
                  <div className="flex gap-2"><span className="font-medium text-xs w-28 shrink-0 text-muted-foreground pt-0.5">Tender Style</span><span>{company.tenderStyle}</span></div>
                )}
                {company.spotProcess && (
                  <div className="flex gap-2"><span className="font-medium text-xs w-28 shrink-0 text-muted-foreground pt-0.5">Spot Process</span><span>{company.spotProcess}</span></div>
                )}
                {company.dlEmail && (
                  <div className="flex gap-2"><span className="font-medium text-xs w-28 shrink-0 text-muted-foreground pt-0.5">Dispatch Email</span><span>{company.dlEmail}</span></div>
                )}
                {company.accountQuirks && (
                  <div className="flex gap-2"><span className="font-medium text-xs w-28 shrink-0 text-muted-foreground pt-0.5">Quirks</span><span>{company.accountQuirks}</span></div>
                )}
                {company.processNotes && (
                  <div className="flex gap-2"><span className="font-medium text-xs w-28 shrink-0 text-muted-foreground pt-0.5">Process Notes</span><span>{company.processNotes}</span></div>
                )}
              </div>
            </section>
          )}

          {/* Health Score Breakdown */}
          {healthScore && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1 mb-2 flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5" /> Relationship Health — {healthScore.grade} ({healthScore.score}/100)
              </h3>
              <div className="space-y-1.5">
                {healthScore.factors.map(f => (
                  <div key={f.name} className="flex items-center gap-3 text-sm">
                    <div className="w-40 text-xs text-muted-foreground shrink-0">{f.name}</div>
                    <div className="flex-1 bg-muted rounded-full h-1.5">
                      <div
                        className={`h-1.5 rounded-full ${f.score >= f.max * 0.8 ? "bg-green-500" : f.score >= f.max * 0.5 ? "bg-blue-500" : f.score >= f.max * 0.2 ? "bg-amber-500" : "bg-red-500"}`}
                        style={{ width: `${(f.score / f.max) * 100}%` }}
                      />
                    </div>
                    <div className="text-xs font-medium w-12 text-right shrink-0">{f.score}/{f.max}</div>
                    <div className="text-xs text-muted-foreground line-clamp-1 flex-1 hidden sm:block">{f.label}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>

    <ContactIntelModal
      contact={selectedContactForIntel}
      open={!!selectedContactForIntel}
      onClose={() => setSelectedContactForIntel(null)}
    />
    </>
  );
}
