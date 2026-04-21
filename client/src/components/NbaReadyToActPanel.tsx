import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sparkles, RefreshCcw, Mail, MessageSquare, PhoneCall, DollarSign, ListChecks, UserCircle, Loader2,
} from "lucide-react";
import { NbaLogTouchDialog } from "./NbaLogTouchDialog";

interface ReadyToActContact {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  relationshipBase: string | null;
  reason: string;
}

interface QuoteHint {
  laneLabel: string;
  basis: string;
  suggestedRange: string;
}

interface ReadyToActPayload {
  shape: "email" | "sms" | "call" | "lane_capacity";
  draftLabel: string;
  playLabel: string;
  defaultTouchType: "call" | "email" | "text" | "site_visit";
  recommendedContact: ReadyToActContact | null;
  talkingPoints: string[];
  draft: string;
  callPoints: string[];
  voiceProfileAvailable: boolean;
  voiceProfileSampleCount: number;
  quoteHint: QuoteHint | null;
  tone: string;
}

interface NbaReadyToActPanelProps {
  cardId: string;
  companyId: string;
  companyName: string | null;
  cardContactId: string | null;
  onActioned: () => void;
}

const TONE_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "warm",    label: "Warm" },
  { value: "concise", label: "Concise" },
  { value: "firm",    label: "Firm" },
  { value: "curious", label: "Curious" },
];

const SHAPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  email: Mail,
  sms:   MessageSquare,
  call:  PhoneCall,
};

export function NbaReadyToActPanel({ cardId, companyId, companyName, cardContactId, onActioned }: NbaReadyToActPanelProps) {
  const [tone, setTone] = useState<string>("default");
  const [contactOverride, setContactOverride] = useState<string | undefined>(undefined);
  const [editedDraft, setEditedDraft] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [showLogTouch, setShowLogTouch] = useState(false);

  const queryParams = new URLSearchParams();
  if (contactOverride) queryParams.set("contactId", contactOverride);
  if (tone !== "default") queryParams.set("tone", tone);
  if (refreshKey > 0) queryParams.set("regenerate", "1");

  const { data, isLoading, isFetching, error, refetch } = useQuery<ReadyToActPayload>({
    queryKey: ["/api/nba/cards", cardId, "ready-to-act", contactOverride ?? "", tone, refreshKey],
    queryFn: async () => {
      const url = `/api/nba/cards/${cardId}/ready-to-act${queryParams.toString() ? `?${queryParams}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 4 * 60 * 1000,
  });

  // Reset draft when fresh payload arrives
  useEffect(() => {
    if (data?.draft) setEditedDraft(data.draft);
  }, [data?.draft]);

  const { data: contacts = [] } = useQuery<{ id: string; name: string; title?: string | null }[]>({
    queryKey: ["/api/companies", companyId, "contacts"],
    enabled: !!companyId,
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-3 flex items-center gap-2 text-xs text-white/50" data-testid={`nba-ready-loading-${cardId}`}>
        <Loader2 className="w-3 h-3 animate-spin" />
        Building ready-to-act draft…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-xs text-red-300" data-testid={`nba-ready-error-${cardId}`}>
        Couldn't build draft. <button onClick={() => refetch()} className="underline">Retry</button>
      </div>
    );
  }

  if (data.shape === "lane_capacity") {
    return (
      <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-white/60">
        Use the carrier-outreach panel above for this lane-capacity card.
      </div>
    );
  }

  const ShapeIcon = SHAPE_ICON[data.shape] ?? Sparkles;

  function handleRegenerate() {
    setRefreshKey(k => k + 1);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(editedDraft);
    } catch { /* no-op */ }
  }

  return (
    <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-3 flex flex-col gap-2.5" data-testid={`nba-ready-panel-${cardId}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <ShapeIcon className="w-3.5 h-3.5 text-amber-300" />
          <span className="text-[11px] font-semibold text-white/80">{data.draftLabel}</span>
          {data.voiceProfileAvailable && (
            <span className="text-[10px] text-white/40">· voice-matched ({data.voiceProfileSampleCount})</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Select value={tone} onValueChange={setTone}>
            <SelectTrigger className="h-6 text-[10px] bg-white/5 border-white/10 px-2 w-[88px]" data-testid={`nba-ready-tone-${cardId}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TONE_OPTIONS.map(t => (
                <SelectItem key={t.value} value={t.value} className="text-[11px]">{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            onClick={handleRegenerate}
            disabled={isFetching}
            className="text-[10px] flex items-center gap-1 px-2 py-1 rounded bg-white/8 border border-white/12 text-white/65 hover:bg-white/15 disabled:opacity-50"
            data-testid={`nba-ready-regenerate-${cardId}`}
          >
            <RefreshCcw className={`w-3 h-3 ${isFetching ? "animate-spin" : ""}`} />
            Regenerate
          </button>
        </div>
      </div>

      {/* Recommended contact */}
      {data.recommendedContact && (
        <div className="flex items-start gap-2 rounded bg-blue-500/8 border border-blue-500/15 px-2 py-1.5" data-testid={`nba-ready-contact-${cardId}`}>
          <UserCircle className="w-3.5 h-3.5 text-blue-300 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-semibold text-blue-200">{data.recommendedContact.name}</span>
              {data.recommendedContact.title && <span className="text-[10px] text-blue-200/60">· {data.recommendedContact.title}</span>}
              {data.recommendedContact.relationshipBase && (
                <span className="text-[10px] text-blue-200/60">· {data.recommendedContact.relationshipBase}</span>
              )}
            </div>
            <p className="text-[10px] text-white/50 leading-tight">Why: {data.recommendedContact.reason}</p>
          </div>
          {contacts.length > 1 && (
            <Select value={contactOverride ?? data.recommendedContact.id} onValueChange={setContactOverride}>
              <SelectTrigger className="h-6 text-[10px] bg-white/5 border-white/10 px-2 w-[120px]" data-testid={`nba-ready-contact-select-${cardId}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {contacts.map(c => (
                  <SelectItem key={c.id} value={c.id} className="text-[11px]">{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* Talking points */}
      {data.talkingPoints.length > 0 && (
        <div data-testid={`nba-ready-talking-points-${cardId}`}>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-white/40 mb-1 flex items-center gap-1">
            <ListChecks className="w-3 h-3" /> What to reference
          </p>
          <ul className="flex flex-col gap-0.5">
            {data.talkingPoints.map((p, i) => (
              <li key={i} className="text-[11px] text-white/65 flex items-start gap-1.5 leading-snug">
                <span className="mt-1 w-1 h-1 rounded-full bg-white/30 shrink-0" />
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Quote hint */}
      {data.quoteHint && (
        <div className="rounded bg-emerald-500/8 border border-emerald-500/20 px-2 py-1.5 flex items-start gap-2" data-testid={`nba-ready-quote-${cardId}`}>
          <DollarSign className="w-3.5 h-3.5 text-emerald-300 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-emerald-200">{data.quoteHint.suggestedRange}</p>
            <p className="text-[10px] text-emerald-200/70">{data.quoteHint.laneLabel} · {data.quoteHint.basis}</p>
          </div>
        </div>
      )}

      {/* Draft body — editable */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-white/40 mb-1">
          {data.shape === "call" ? "Call talking-points (editable)" : data.shape === "sms" ? "Text draft (editable)" : "Email draft (editable)"}
        </p>
        <textarea
          value={editedDraft}
          onChange={e => setEditedDraft(e.target.value)}
          rows={data.shape === "sms" ? 2 : 5}
          className="w-full bg-black/30 border border-white/12 rounded p-2 text-[11px] text-white/85 leading-snug resize-y focus:outline-none focus:ring-1 focus:ring-amber-400/40"
          data-testid={`nba-ready-draft-${cardId}`}
        />
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-1.5">
        <button
          onClick={handleCopy}
          className="text-[10px] px-2 py-1 rounded bg-white/8 border border-white/12 text-white/65 hover:bg-white/15"
          data-testid={`nba-ready-copy-${cardId}`}
        >
          Copy
        </button>
        <Button
          size="sm"
          onClick={() => setShowLogTouch(true)}
          className="h-6 text-[10px] px-2 bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-200 border border-emerald-500/30"
          data-testid={`nba-ready-log-touch-${cardId}`}
        >
          <Sparkles className="w-3 h-3 mr-0.5" />
          Log this touch
        </Button>
      </div>

      {showLogTouch && (
        <NbaLogTouchDialog
          open={showLogTouch}
          onClose={() => setShowLogTouch(false)}
          cardId={cardId}
          companyId={companyId}
          companyName={companyName ?? ""}
          contactId={contactOverride ?? data.recommendedContact?.id ?? cardContactId ?? null}
          defaultTouchType={data.defaultTouchType}
          defaultNote={editedDraft.slice(0, 1000)}
          defaultPlayLabel={data?.playLabel ?? undefined}
          onActioned={() => {
            onActioned();
            setShowLogTouch(false);
          }}
        />
      )}
    </div>
  );
}
