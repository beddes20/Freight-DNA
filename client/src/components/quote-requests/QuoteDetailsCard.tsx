/**
 * Task #863 — Editable structured quote card.
 *
 * Drawer card that lets the owner (or an elevated role) update the
 * three structured fields a quote opportunity carries beyond its lane
 * identity: quoted amount, valid-through, and free-text notes. Submits
 * via PATCH /api/customer-quotes/quote/:id and invalidates the per-quote
 * detail + the page-level list/snapshot so the table mirror updates.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, Save } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface QuoteShape {
  id: string;
  quotedAmount: string | null;
  validThrough: string | null;
  notes: string | null;
}

interface QuoteEventShape {
  eventType: string;
  occurredAt: string | Date;
  actor?: string | { name?: string | null; email?: string | null } | null;
  payload?: { changes?: Record<string, unknown> } | null;
}

function isoToDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function formatRelative(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

/** Find the most recent event whose payload.changes mentions any of `keys`. */
function findLastEditFor(
  events: QuoteEventShape[] | undefined, keys: string[],
): QuoteEventShape | null {
  if (!events || events.length === 0) return null;
  // Events come back newest-first from the detail endpoint, but be
  // defensive and sort by occurredAt desc anyway.
  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.occurredAt).getTime();
    const tb = new Date(b.occurredAt).getTime();
    return tb - ta;
  });
  for (const ev of sorted) {
    if (ev.eventType !== "updated" && ev.eventType !== "revised" && ev.eventType !== "quoted") continue;
    const changes = ev.payload?.changes;
    if (!changes) continue;
    if (keys.some(k => Object.prototype.hasOwnProperty.call(changes, k))) return ev;
  }
  return null;
}

function actorLabel(ev: QuoteEventShape | null): string {
  if (!ev) return "";
  const actor = ev.actor;
  if (!actor) return "someone";
  if (typeof actor === "string") return actor.trim() || "someone";
  return actor.name?.trim() || actor.email?.trim() || "someone";
}

export function QuoteDetailsCard({
  quote, canEdit, onSaved, events,
}: {
  quote: QuoteShape;
  canEdit: boolean;
  onSaved: () => void;
  events?: QuoteEventShape[];
}): JSX.Element {
  const { toast } = useToast();
  const [amount, setAmount] = useState(quote.quotedAmount ?? "");
  const [validThrough, setValidThrough] = useState(isoToDate(quote.validThrough));
  const [notes, setNotes] = useState(quote.notes ?? "");

  // Re-sync local state when the parent passes a different quote (or the
  // server-side detail refresh returns updated values).
  useEffect(() => {
    setAmount(quote.quotedAmount ?? "");
    setValidThrough(isoToDate(quote.validThrough));
    setNotes(quote.notes ?? "");
  }, [quote.id, quote.quotedAmount, quote.validThrough, quote.notes]);

  const dirty =
    (amount ?? "") !== (quote.quotedAmount ?? "") ||
    (validThrough ?? "") !== isoToDate(quote.validThrough) ||
    (notes ?? "") !== (quote.notes ?? "");

  const saveMut = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      const trimmedAmt = amount.trim();
      body.quotedAmount = trimmedAmt === "" ? null : trimmedAmt;
      body.validThrough = validThrough
        ? new Date(`${validThrough}T12:00:00Z`).toISOString()
        : null;
      body.notes = notes.trim() === "" ? null : notes.trim();
      const res = await apiRequest("PATCH", `/api/customer-quotes/quote/${quote.id}`, body);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
      return json;
    },
    onSuccess: () => {
      toast({ title: "Quote updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/quote", quote.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      onSaved();
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Could not save quote",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const lastStructuredEdit = findLastEditFor(events, ["quotedAmount", "validThrough"]);
  const lastNotesEdit = findLastEditFor(events, ["notes"]);

  // ⌘/Ctrl+S to save while focus is anywhere inside the card. Reps move
  // through many quotes per hour; tabbing back to a Save button between
  // every edit is friction. We intercept before the browser's default
  // "save page" dialog grabs the keystroke.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const dirtyRef = useRef(dirty);
  const canEditRef = useRef(canEdit);
  const isPendingRef = useRef(saveMut.isPending);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { canEditRef.current = canEdit; }, [canEdit]);
  useEffect(() => { isPendingRef.current = saveMut.isPending; }, [saveMut.isPending]);
  useEffect(() => {
    const node = cardRef.current;
    if (!node) return;
    const handler = (e: KeyboardEvent) => {
      const isSave = (e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S");
      if (!isSave) return;
      if (!canEditRef.current || !dirtyRef.current || isPendingRef.current) return;
      e.preventDefault();
      saveMut.mutate();
    };
    node.addEventListener("keydown", handler);
    return () => node.removeEventListener("keydown", handler);
  }, [saveMut]);

  return (
    <Card ref={cardRef} className="border-border/60 shadow-sm p-4" data-testid="card-quote-details">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Quote details
        </h4>
        {canEdit && dirty && (
          <Button
            size="sm"
            className="h-7 px-2"
            disabled={saveMut.isPending}
            onClick={() => saveMut.mutate()}
            data-testid="button-save-quote-details"
          >
            {saveMut.isPending
              ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              : <Save className="h-3 w-3 mr-1" />}
            Save
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Quoted amount
          </Label>
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={!canEdit}
            inputMode="decimal"
            placeholder="$"
            className="h-8 text-sm mt-1"
            data-testid="input-edit-quoted-amount"
          />
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Valid through
          </Label>
          <Input
            type="date"
            value={validThrough}
            onChange={(e) => setValidThrough(e.target.value)}
            disabled={!canEdit}
            className="h-8 text-sm mt-1"
            data-testid="input-edit-valid-through"
          />
        </div>
      </div>
      {lastStructuredEdit && (
        <div
          className="mt-1 text-[11px] text-muted-foreground"
          data-testid="text-quote-details-last-edit"
        >
          Last edited by {actorLabel(lastStructuredEdit)} · {formatRelative(lastStructuredEdit.occurredAt)}
        </div>
      )}
      <div className="mt-3">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Notes
        </Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={!canEdit}
          rows={3}
          placeholder="Add context, follow-ups, or instructions for the next rep…"
          className="text-sm mt-1"
          data-testid="textarea-edit-notes"
        />
        {lastNotesEdit && (
          <div
            className="mt-1 text-[11px] text-muted-foreground"
            data-testid="text-notes-last-edit"
          >
            Last edited by {actorLabel(lastNotesEdit)} · {formatRelative(lastNotesEdit.occurredAt)}
          </div>
        )}
      </div>
      {!canEdit && (
        <div className="mt-2 text-[11px] text-muted-foreground italic">
          You can only edit your own quotes (or any quote with manager permissions).
        </div>
      )}
    </Card>
  );
}
