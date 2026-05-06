import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useToast } from "@/hooks/use-toast";
import {
  UserRound,
  AlertTriangle,
  PhoneOff,
  TimerReset,
  TrendingUp,
  FileText,
  MessageSquarePlus,
  Trash2,
  ExternalLink,
  Inbox,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────
type Severity = "info" | "watch" | "urgent";
type SubjectKind =
  | "account_risk"
  | "play_not_run"
  | "flagged_call"
  | "response_outlier"
  | "promotion_ready";

interface CoachingItem {
  subjectKind: SubjectKind;
  subjectId: string | null;
  title: string;
  detail: string;
  severity: Severity;
  href?: string;
  meta?: Record<string, unknown>;
}

interface CoachingCard {
  rep: { id: string; name: string; email: string; role: string };
  accountsAtRisk: CoachingItem[];
  playsNotRun: CoachingItem[];
  flaggedCalls: CoachingItem[];
  responseOutliers: CoachingItem[];
  promotionReady: CoachingItem | null;
  tenureDays: number;
  activeAccounts: number;
  weekStart: string;
  weekEnd: string;
}

interface CardsResponse {
  weekStart: string;
  weekEnd: string;
  cards: CoachingCard[];
}

interface CoachingNote {
  id: string;
  repId: string;
  managerId: string;
  subjectKind: SubjectKind | "general";
  subjectId: string | null;
  subjectLabel: string | null;
  body: string;
  createdAt: string;
  deliveredAt: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function sevColor(s: Severity): string {
  if (s === "urgent") return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30";
  if (s === "watch") return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30";
}

function totalItems(card: CoachingCard): number {
  return card.accountsAtRisk.length
    + card.flaggedCalls.length
    + card.playsNotRun.length
    + card.responseOutliers.length
    + (card.promotionReady ? 1 : 0);
}

function useQueryParam(key: string): string | null {
  const [location] = useLocation();
  const q = location.split("?")[1] || "";
  const p = new URLSearchParams(q);
  return p.get(key);
}

// ── Note panel ─────────────────────────────────────────────────────────────
function NotesForItem({
  repId,
  item,
  notes,
  onAdded,
}: {
  repId: string;
  item: CoachingItem;
  notes: CoachingNote[];
  onAdded: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const key = `${item.subjectKind}:${item.subjectId || ""}`;
  const itemNotes = notes.filter(n => `${n.subjectKind}:${n.subjectId || ""}` === key);

  const addNote = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/coaching/notes", {
        repId,
        subjectKind: item.subjectKind,
        subjectId: item.subjectId,
        subjectLabel: item.title,
        body: body.trim(),
      });
    },
    onSuccess: () => {
      toast({ title: "Coaching note saved", description: "Your rep will see this in tomorrow's Today thread." });
      setBody("");
      setOpen(false);
      onAdded();
    },
    onError: () => toast({ title: "Failed to save note", variant: "destructive" }),
  });

  const removeNote = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/coaching/notes/${id}`);
    },
    onSuccess: () => onAdded(),
  });

  return (
    <div className="mt-2 space-y-2">
      {itemNotes.length > 0 && (
        <div className="space-y-1">
          {itemNotes.map(n => (
            <div
              key={n.id}
              className="flex items-start justify-between gap-2 rounded border bg-muted/30 px-2.5 py-1.5 text-xs"
              data-testid={`note-existing-${n.id}`}
            >
              <div>
                <p className="text-foreground">{n.body}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {new Date(n.createdAt).toLocaleDateString()} • {n.deliveredAt ? "Delivered to rep" : "Queued for next Today thread"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={() => removeNote.mutate(n.id)}
                data-testid={`button-delete-note-${n.id}`}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {open ? (
        <div className="space-y-1">
          <Textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="What should the rep do differently?"
            className="min-h-[72px] text-xs"
            data-testid={`textarea-note-${key}`}
          />
          <div className="flex justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => { setBody(""); setOpen(false); }} data-testid={`button-cancel-note-${key}`}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => body.trim() && addNote.mutate()}
              disabled={!body.trim() || addNote.isPending}
              data-testid={`button-save-note-${key}`}
            >
              {addNote.isPending ? "Saving…" : "Save note"}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => setOpen(true)}
          data-testid={`button-add-note-${key}`}
        >
          <MessageSquarePlus className="h-3 w-3 mr-1" />
          Leave coaching note
        </Button>
      )}
    </div>
  );
}

// ── Item row ───────────────────────────────────────────────────────────────
function ItemRow({
  item,
  repId,
  notes,
  onNotesChanged,
}: {
  item: CoachingItem;
  repId: string;
  notes: CoachingNote[];
  onNotesChanged: () => void;
}) {
  const sevLabel = item.severity === "urgent" ? "URGENT" : item.severity === "watch" ? "WATCH" : "INFO";
  return (
    <div className="rounded-md border p-3" data-testid={`item-${item.subjectKind}-${item.subjectId || "x"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`text-[10px] font-semibold ${sevColor(item.severity)}`}>
              {sevLabel}
            </Badge>
            <p className="font-medium text-sm truncate">{item.title}</p>
          </div>
          <p className="text-xs text-muted-foreground mt-1">{item.detail}</p>
        </div>
        {item.href && (
          <Link href={item.href}>
            <Button variant="ghost" size="sm" className="h-7 gap-1" data-testid={`link-evidence-${item.subjectKind}-${item.subjectId || "x"}`}>
              Evidence <ExternalLink className="h-3 w-3" />
            </Button>
          </Link>
        )}
      </div>
      <NotesForItem repId={repId} item={item} notes={notes} onAdded={onNotesChanged} />
    </div>
  );
}

// ── Category section ───────────────────────────────────────────────────────
function CategorySection({
  title,
  icon: Icon,
  items,
  repId,
  notes,
  onNotesChanged,
  emptyMsg,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  items: CoachingItem[];
  repId: string;
  notes: CoachingNote[];
  onNotesChanged: () => void;
  emptyMsg: string;
}) {
  return (
    <AccordionItem value={title}>
      <AccordionTrigger className="py-2 text-sm" data-testid={`accordion-${title.replace(/\s+/g, "-").toLowerCase()}`}>
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span>{title}</span>
          <Badge variant="secondary" className="ml-1 text-[10px]">{items.length}</Badge>
        </div>
      </AccordionTrigger>
      <AccordionContent>
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground italic px-2 py-1">{emptyMsg}</p>
        ) : (
          <div className="space-y-2">
            {items.map(it => (
              <ItemRow
                key={`${it.subjectKind}-${it.subjectId || Math.random()}-${it.title}`}
                item={it}
                repId={repId}
                notes={notes}
                onNotesChanged={onNotesChanged}
              />
            ))}
          </div>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}

// ── Rep card ───────────────────────────────────────────────────────────────
function RepCoachingCard({
  card,
  notesForRep,
  onNotesChanged,
  defaultOpen = false,
}: {
  card: CoachingCard;
  notesForRep: CoachingNote[];
  onNotesChanged: () => void;
  defaultOpen?: boolean;
}) {
  const total = totalItems(card);
  return (
    <Card data-testid={`card-coaching-rep-${card.rep.id}`} id={`rep-${card.rep.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
              <UserRound className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base" data-testid={`text-rep-name-${card.rep.id}`}>{card.rep.name}</CardTitle>
              <p className="text-xs text-muted-foreground capitalize">{card.rep.role.replace(/_/g, " ")} • {card.activeAccounts} accounts</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={total === 0 ? "secondary" : "default"} data-testid={`badge-total-${card.rep.id}`}>
              {total} items
            </Badge>
            <Link href={`/report/${card.rep.id}`}>
              <Button variant="outline" size="sm" data-testid={`link-scorecard-${card.rep.id}`}>
                Scorecard
              </Button>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {total === 0 ? (
          <p className="text-sm text-muted-foreground italic py-2">No coaching items this week — nice.</p>
        ) : (
          <Accordion
            type="multiple"
            defaultValue={defaultOpen ? ["Accounts at risk", "Calls flagged for coaching", "Plays not run", "Response-time outliers", "Promotion-readiness"] : ["Accounts at risk"]}
            className="w-full"
          >
            <CategorySection
              title="Accounts at risk"
              icon={AlertTriangle}
              items={card.accountsAtRisk}
              repId={card.rep.id}
              notes={notesForRep}
              onNotesChanged={onNotesChanged}
              emptyMsg="No accounts flagged this week."
            />
            <CategorySection
              title="Calls flagged for coaching"
              icon={PhoneOff}
              items={card.flaggedCalls}
              repId={card.rep.id}
              notes={notesForRep}
              onNotesChanged={onNotesChanged}
              emptyMsg="No negative-sentiment calls on at-risk accounts."
            />
            <CategorySection
              title="Plays not run"
              icon={FileText}
              items={card.playsNotRun}
              repId={card.rep.id}
              notes={notesForRep}
              onNotesChanged={onNotesChanged}
              emptyMsg="Rep acted on every triggered play."
            />
            <CategorySection
              title="Response-time outliers"
              icon={TimerReset}
              items={card.responseOutliers}
              repId={card.rep.id}
              notes={notesForRep}
              onNotesChanged={onNotesChanged}
              emptyMsg="Cadence is consistent across accounts."
            />
            <CategorySection
              title="Promotion-readiness"
              icon={TrendingUp}
              items={card.promotionReady ? [card.promotionReady] : []}
              repId={card.rep.id}
              notes={notesForRep}
              onNotesChanged={onNotesChanged}
              emptyMsg="Not hitting promotion signals yet."
            />
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function CoachingPage() {
  const { user } = useAuth();
  const focusRepId = useQueryParam("rep");

  const { data, isLoading, error, refetch } = useQuery<CardsResponse>({
    queryKey: ["/api/coaching/cards"],
  });

  const { data: allNotes, refetch: refetchNotes } = useQuery<CoachingNote[]>({
    queryKey: ["/api/coaching/all-notes-for-cards"],
    queryFn: async () => {
      const cards = data?.cards || [];
      if (cards.length === 0) return [];
      const res = await Promise.all(cards.map(async c => {
        const r = await fetch(`/api/coaching/notes?repId=${encodeURIComponent(c.rep.id)}`, { credentials: "include" });
        if (!r.ok) return [];
        return (await r.json()) as CoachingNote[];
      }));
      return res.flat();
    },
    enabled: !!data?.cards?.length,
  });

  const onNotesChanged = () => {
    refetchNotes();
    queryClient.invalidateQueries({ queryKey: ["/api/coaching/all-notes-for-cards"] });
  };

  const managerRoles = useMemo(() => new Set(["admin", "director", "sales_director", "national_account_manager"]), []);

  if (!user) return null;
  if (!managerRoles.has(user.role)) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground" data-testid="text-coaching-access-denied">
          Coaching Mode is available to managers and admins.
        </p>
      </div>
    );
  }

  const cards = data?.cards ?? [];
  const notes = allNotes ?? [];
  const notesByRep = new Map<string, CoachingNote[]>();
  for (const n of notes) {
    const arr = notesByRep.get(n.repId) || [];
    arr.push(n);
    notesByRep.set(n.repId, arr);
  }

  const sorted = [...cards].sort((a, b) => totalItems(b) - totalItems(a));
  const focused = focusRepId ? sorted.filter(c => c.rep.id === focusRepId) : [];
  const rest = focusRepId ? sorted.filter(c => c.rep.id !== focusRepId) : sorted;

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="max-w-5xl mx-auto w-full px-6 py-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Inbox className="h-6 w-6 text-primary" />
              Coaching Mode
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-coaching-subtitle">
              {data?.weekStart ? `Week of ${data.weekStart} — ${data.weekEnd}` : "Weekly coaching brief across your direct reports"}
            </p>
          </div>
          <p className="text-xs text-muted-foreground max-w-sm">
            Notes you leave show up in the rep's next ValueIQ Today thread the following morning.
            A digest of top items is emailed to you Monday 7 AM.
          </p>
        </div>

        {isLoading && (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-40 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {error && (
          <Card><CardContent className="py-8 text-center text-muted-foreground">Failed to load coaching cards.</CardContent></Card>
        )}

        {!isLoading && !error && cards.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground" data-testid="text-no-direct-reports">
              You don't have any direct reports yet. Assign reps to see their Coaching Cards here.
            </CardContent>
          </Card>
        )}

        {focused.map(card => (
          <RepCoachingCard
            key={card.rep.id}
            card={card}
            notesForRep={notesByRep.get(card.rep.id) ?? []}
            onNotesChanged={onNotesChanged}
            defaultOpen
          />
        ))}
        {rest.map(card => (
          <RepCoachingCard
            key={card.rep.id}
            card={card}
            notesForRep={notesByRep.get(card.rep.id) ?? []}
            onNotesChanged={onNotesChanged}
          />
        ))}
      </div>
    </div>
  );
}
