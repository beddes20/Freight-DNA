import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateAfterTouchpoint } from "@/lib/invalidations";
import { useToast } from "@/hooks/use-toast";
import { ResponsiveDialog } from "@/components/responsive-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PhoneCall, Mail, MessageSquare, Building2, BookOpen } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Contact {
  id: string;
  name: string;
  title?: string | null;
}

interface NbaLogTouchDialogProps {
  open: boolean;
  onClose: () => void;
  cardId: string;
  companyId: string;
  companyName: string;
  /** Pre-selected contact id when the card targets a specific contact */
  contactId?: string | null;
  /** Pre-fill the touch type (e.g. when launched from "Log this touch" on a Ready-to-Act card) */
  defaultTouchType?: "call" | "email" | "text" | "site_visit";
  /** Pre-fill the note (e.g. with the draft body) */
  defaultNote?: string;
  /** Pre-tag a play executed */
  defaultPlayLabel?: string;
  onActioned: () => void;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const TOUCH_TYPES = [
  { value: "call",       label: "Call",       icon: PhoneCall },
  { value: "email",      label: "Email",      icon: Mail },
  { value: "text",       label: "Text",       icon: MessageSquare },
  { value: "site_visit", label: "Site Visit", icon: Building2 },
] as const;

const PLAY_OPTIONS = [
  "Stabilize At-Risk Account",
  "Expand Contact Coverage",
  "Re-Engage Stale Account",
  "Clear Overdue Commitment",
  "Consolidate Spot → Mini-Bid",
  "RFP Defense / Expansion",
  "Activate Stalled Awards",
  "Carrier Bench Strengthen",
  "Market Tightening Outreach",
  "Market Loosening Opportunity",
  "Geography Expansion",
  "Wallet Share Capture",
  "Market Signal Outreach",
];

const VIBES = [
  { value: "positive", label: "😊 Positive", cls: "border-green-500 bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300" },
  { value: "neutral",  label: "😐 Neutral",  cls: "border-yellow-500 bg-yellow-50 dark:bg-yellow-950/40 text-yellow-700 dark:text-yellow-300" },
  { value: "negative", label: "😟 Negative", cls: "border-red-500 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300" },
] as const;

// ── Component ──────────────────────────────────────────────────────────────────

export function NbaLogTouchDialog({
  open,
  onClose,
  cardId,
  companyId,
  companyName,
  contactId,
  defaultTouchType,
  defaultNote,
  defaultPlayLabel,
  onActioned,
}: NbaLogTouchDialogProps) {
  const { toast } = useToast();
  const [selectedContactId, setSelectedContactId] = useState(contactId ?? "");
  const [touchType, setTouchType]   = useState<string>(defaultTouchType ?? "call");
  const [vibe, setVibe]             = useState("");
  const [note, setNote]             = useState(defaultNote ?? "");
  const [meaningful, setMeaningful] = useState(false);
  const [playLabel, setPlayLabel]   = useState(defaultPlayLabel ?? "");

  // Fetch company contacts so the rep can choose when no contactId is pre-set
  const { data: contacts = [], isLoading: contactsLoading } = useQuery<Contact[]>({
    queryKey: ["/api/companies", companyId, "contacts"],
    enabled: open && !!companyId,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!selectedContactId && contacts.length > 0) {
      setSelectedContactId(contacts[0].id);
    }
  }, [contacts, selectedContactId]);

  const logMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/touch-logs", {
        companyId,
        contactId: selectedContactId || null,
        type:        touchType,
        isMeaningful: meaningful,
        sentiment:   vibe || null,
        notes:       note.trim() || null,
        playLabel:   playLabel && playLabel !== "__none__" ? playLabel : null,
      });
      await apiRequest("PATCH", `/api/nba/cards/${cardId}/resolve`, { action: "actioned" });
    },
    onSuccess: () => {
      invalidateAfterTouchpoint(companyId);
      queryClient.invalidateQueries({ queryKey: ["/api/nba/cards"] });
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: ["/api/nba/company", companyId, "card"] });
      }
      toast({ title: "Touch logged", description: `Logged for ${companyName}.` });
      onActioned();
      handleClose();
    },
    onError: () => toast({ title: "Failed to log touch", variant: "destructive" }),
  });

  function handleClose() {
    setSelectedContactId(contactId ?? "");
    setTouchType(defaultTouchType ?? "call");
    setVibe("");
    setNote(defaultNote ?? "");
    setMeaningful(false);
    setPlayLabel(defaultPlayLabel ?? "");
    onClose();
  }

  const canSubmit = !!selectedContactId && !logMutation.isPending;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(v) => { if (!v) handleClose(); }}
      title="Log Touch"
      className="sm:max-w-sm"
      footer={
        <div className="flex justify-end gap-2 w-full">
          <Button variant="outline" onClick={handleClose} data-testid="nba-touch-cancel">Cancel</Button>
          <Button onClick={() => logMutation.mutate()} disabled={!canSubmit || (meaningful && !note.trim())} data-testid="nba-touch-submit">
            {logMutation.isPending ? "Saving…" : "Log Touch"}
          </Button>
        </div>
      }
    >
        <div className="space-y-3 py-1" data-testid="dialog-nba-log-touch">
          {/* Read-only company label */}
          <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="font-medium truncate">{companyName}</span>
          </div>

          {/* Contact picker */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Contact</label>
            {contactsLoading ? (
              <div className="h-9 rounded-md bg-muted animate-pulse" />
            ) : (
              <Select
                value={selectedContactId}
                onValueChange={setSelectedContactId}
              >
                <SelectTrigger data-testid="select-nba-touch-contact">
                  <SelectValue placeholder="Select a contact…" />
                </SelectTrigger>
                <SelectContent>
                  {contacts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}{c.title ? ` · ${c.title}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Touch type */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Type</label>
            <div className="flex gap-2 flex-wrap">
              {TOUCH_TYPES.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTouchType(value)}
                  data-testid={`nba-touch-type-${value}`}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border transition-colors ${
                    touchType === value
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background border-input hover:bg-muted"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Meaningful toggle */}
          <div className="flex items-center gap-3 py-0.5">
            <button
              type="button"
              onClick={() => setMeaningful((v) => !v)}
              data-testid="nba-touch-meaningful-toggle"
              className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${
                meaningful ? "bg-green-500" : "bg-muted border border-border"
              }`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                  meaningful ? "left-4" : "left-0.5"
                }`}
              />
            </button>
            <span className="text-sm">Meaningful conversation?</span>
          </div>

          {/* Play executed */}
          <div className="space-y-1">
            <label className="text-sm font-medium">
              Play Executed <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Select value={playLabel} onValueChange={setPlayLabel}>
              <SelectTrigger data-testid="select-nba-touch-play">
                <SelectValue placeholder="Tag a play…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No play</SelectItem>
                {PLAY_OPTIONS.map(p => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Vibe */}
          <div className="space-y-1">
            <label className="text-sm font-medium">
              Vibe <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <div className="flex gap-2">
              {VIBES.map(({ value, label, cls }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setVibe((v) => (v === value ? "" : value))}
                  data-testid={`nba-touch-vibe-${value}`}
                  className={`flex-1 py-1 text-xs rounded border font-medium transition-colors ${
                    vibe === value
                      ? cls
                      : "border-border bg-background text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Note */}
          <div className="space-y-1">
            <label className="text-sm font-medium">
              Note{" "}
              {meaningful ? (
                <span className="text-red-500 font-normal">*required</span>
              ) : (
                <span className="text-muted-foreground font-normal">(optional)</span>
              )}
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={meaningful ? "What made this meaningful?" : "Quick note…"}
              data-testid="nba-touch-note"
              className={`w-full h-9 rounded-md border bg-background px-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                meaningful && !note.trim()
                  ? "border-red-300 dark:border-red-700"
                  : "border-input"
              }`}
            />
          </div>
        </div>
    </ResponsiveDialog>
  );
}
