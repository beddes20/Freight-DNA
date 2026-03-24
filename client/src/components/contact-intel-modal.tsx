import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  MapPin,
  Phone,
  Mail,
  Clock,
  ClipboardList,
  TrendingUp,
  Search,
  AlertCircle,
  ArrowRight,
  User,
  MessageSquare,
} from "lucide-react";
import type { Contact } from "@shared/schema";

type ExtractedLane = {
  lane: string;
  origin: string;
  originState: string;
  destination: string;
  destState: string;
  volume: number;
  rfpTitle: string;
  rfpId: string;
};

type LaneIntel = {
  contact: Contact;
  hasData: boolean;
  ownedLanes: string[];
  ownedRegions: string[];
  stateHints?: string[];
  matchedRfpLanes: ExtractedLane[];
  relatedLanes: ExtractedLane[];
  recentTouchpoints: { id: string; date: string; type: string; notes?: string | null; isMeaningful?: boolean | null }[];
  openTasks: { id: string | number; title: string; status: string; dueDate?: string | null }[];
};

interface ContactIntelModalProps {
  contact: Contact | null;
  open: boolean;
  onClose: () => void;
}

const touchTypeIcon = (type: string) => {
  if (type === "call")       return <Phone className="h-3.5 w-3.5 text-blue-500" />;
  if (type === "email")      return <Mail className="h-3.5 w-3.5 text-purple-500" />;
  if (type === "text")       return <MessageSquare className="h-3.5 w-3.5 text-green-500" />;
  if (type === "site_visit") return <MapPin className="h-3.5 w-3.5 text-orange-500" />;
  return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
};

function LaneRow({ el, highlight }: { el: ExtractedLane; highlight?: boolean }) {
  return (
    <div className={`flex items-start gap-3 rounded-md px-3 py-2 text-sm ${highlight ? "bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800" : "bg-muted/40 border border-border"}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 font-medium flex-wrap">
          <span className="text-foreground">{el.origin || "—"}</span>
          {(el.origin || el.destination) && <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />}
          <span className="text-foreground">{el.destination || "—"}</span>
          {el.originState && <Badge variant="outline" className="text-xs px-1.5 py-0">{el.originState}</Badge>}
          {el.destState && el.destState !== el.originState && <Badge variant="outline" className="text-xs px-1.5 py-0">{el.destState}</Badge>}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 truncate">{el.rfpTitle}</div>
      </div>
      {el.volume > 0 && (
        <div className="text-xs font-semibold text-right shrink-0">
          <div className="text-foreground">{el.volume.toLocaleString()}</div>
          <div className="text-muted-foreground">loads</div>
        </div>
      )}
    </div>
  );
}

export function ContactIntelModal({ contact, open, onClose }: ContactIntelModalProps) {
  const { data: intel, isLoading } = useQuery<LaneIntel>({
    queryKey: ["/api/contacts", contact?.id, "lane-intel"],
    queryFn: async () => {
      const res = await fetch(`/api/contacts/${contact!.id}/lane-intel`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load lane intel");
      return res.json();
    },
    enabled: open && !!contact,
    staleTime: 60000,
  });

  if (!contact) return null;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid="contact-intel-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-4 w-4 text-muted-foreground" />
            {contact.name}
          </DialogTitle>
          {contact.title && (
            <p className="text-sm text-muted-foreground pt-0.5">{contact.title}</p>
          )}
        </DialogHeader>

        {/* Contact quick-info */}
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {contact.email && (
            <a href={`mailto:${contact.email}`} className="flex items-center gap-1 hover:text-foreground transition-colors">
              <Mail className="h-3 w-3" />{contact.email}
            </a>
          )}
          {contact.phone && (
            <a href={`tel:${contact.phone}`} className="flex items-center gap-1 hover:text-foreground transition-colors">
              <Phone className="h-3 w-3" />{contact.phone}
            </a>
          )}
        </div>

        <Separator />

        {isLoading ? (
          <div className="space-y-3 py-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-12 bg-muted animate-pulse rounded-md" />
            ))}
          </div>
        ) : !intel ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Failed to load data.</div>
        ) : !intel.hasData ? (
          <div className="py-6 space-y-3">
            <div className="flex flex-col items-center gap-2 text-center">
              <Search className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground">No lane data on file for {contact.name}</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                No lane assignments, regions, or geographic signals are linked to this contact yet. Use this conversation to find out what freight they own.
              </p>
            </div>
            <div className="bg-muted/40 border border-border rounded-md px-4 py-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground text-sm mb-1.5">Suggested questions to ask:</p>
              <p>• "What lanes are you most responsible for managing day to day?"</p>
              <p>• "Are there specific regions or facilities you focus on?"</p>
              <p>• "Who else on your team handles the other freight?"</p>
            </div>
            {/* Still show touchpoints if any */}
            {intel.recentTouchpoints.length > 0 && (
              <>
                <Separator />
                <TouchpointSection tps={intel.recentTouchpoints} />
              </>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Geo signals */}
            {(intel.ownedLanes.length > 0 || intel.ownedRegions.length > 0 || (intel.stateHints && intel.stateHints.length > 0)) && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5" /> Known Coverage
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {intel.ownedLanes.map(l => (
                    <Badge key={l} variant="secondary" className="text-xs">{l}</Badge>
                  ))}
                  {intel.ownedRegions.map(r => (
                    <Badge key={r} variant="outline" className="text-xs">{r}</Badge>
                  ))}
                  {intel.stateHints?.map(s => (
                    <Badge key={s} variant="outline" className="text-xs text-muted-foreground">{s} (from title)</Badge>
                  ))}
                </div>
              </section>
            )}

            {/* Matched RFP lanes */}
            {intel.matchedRfpLanes.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 text-green-600" />
                  <span>Lanes They Likely Own</span>
                  <Badge variant="secondary" className="text-xs ml-auto">{intel.matchedRfpLanes.length}</Badge>
                </h3>
                <div className="space-y-1.5">
                  {intel.matchedRfpLanes.map((el, i) => (
                    <LaneRow key={`${el.rfpId}-${i}`} el={el} />
                  ))}
                </div>
              </section>
            )}

            {/* Related corridors */}
            {intel.relatedLanes.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Search className="h-3.5 w-3.5 text-amber-600" />
                  <span>Related Corridors to Explore</span>
                  <Badge variant="secondary" className="text-xs ml-auto">{intel.relatedLanes.length}</Badge>
                </h3>
                <p className="text-xs text-muted-foreground mb-2">In their region — ask if they touch these too.</p>
                <div className="space-y-1.5">
                  {intel.relatedLanes.map((el, i) => (
                    <LaneRow key={`${el.rfpId}-related-${i}`} el={el} highlight />
                  ))}
                </div>
              </section>
            )}

            {/* No RFP lanes but has geo data */}
            {intel.matchedRfpLanes.length === 0 && intel.relatedLanes.length === 0 && (
              <div className="flex items-start gap-2 text-sm rounded-md bg-muted/40 border border-border px-3 py-2.5">
                <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-foreground">No RFP lane data matched yet</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Geographic signal exists, but no uploaded RFP lane rows matched {contact.name}'s coverage area. Ask about their specific lanes to build a more complete picture.</p>
                </div>
              </div>
            )}

            {/* Touchpoints */}
            {intel.recentTouchpoints.length > 0 && (
              <>
                <Separator />
                <TouchpointSection tps={intel.recentTouchpoints} />
              </>
            )}

            {/* Open tasks */}
            {intel.openTasks.length > 0 && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                    <ClipboardList className="h-3.5 w-3.5" /> Open Tasks
                  </h3>
                  <div className="space-y-1">
                    {intel.openTasks.map(t => (
                      <div key={String(t.id)} className="flex items-start justify-between gap-2 text-sm rounded-md bg-muted/40 px-3 py-1.5" data-testid={`intel-task-${t.id}`}>
                        <span className="text-foreground">{t.title}</span>
                        {t.dueDate && <span className="text-xs text-muted-foreground shrink-0">Due {t.dueDate}</span>}
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TouchpointSection({ tps }: { tps: { id: string; date: string; type: string; notes?: string | null; isMeaningful?: boolean | null }[] }) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5" /> Recent Activity
      </h3>
      <div className="space-y-1.5">
        {tps.map(tp => (
          <div key={tp.id} className="flex items-start gap-2 text-sm" data-testid={`intel-tp-${tp.id}`}>
            <span className="shrink-0 pt-0.5">{touchTypeIcon(tp.type)}</span>
            <span className="text-muted-foreground shrink-0 text-xs pt-0.5 w-24">{tp.date}</span>
            <span className="capitalize text-xs font-medium shrink-0 w-16 pt-0.5">{tp.type.replace("_", " ")}</span>
            <span className="text-xs text-muted-foreground line-clamp-2">{tp.notes || <em>No notes</em>}</span>
            {tp.isMeaningful && <Badge className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 shrink-0">Meaningful</Badge>}
          </div>
        ))}
      </div>
    </section>
  );
}
