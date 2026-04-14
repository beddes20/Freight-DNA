import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sparkles,
  Copy,
  Check,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Database,
  Loader2,
  AlertCircle,
  Wand2,
} from "lucide-react";

interface DraftEmailModalProps {
  open: boolean;
  onClose: () => void;
  accountId?: string | null;
  contactId?: string | null;
  threadId?: string | null;
  defaultPlayType?: string;
  companyName?: string;
  contactName?: string;
}

interface DataAnchor {
  type: string;
  label: string;
  value: string;
}

interface DraftResponse {
  draft: string;
  playLabel: string;
  playType: string;
  dataAnchors: DataAnchor[];
  voiceProfileAvailable: boolean;
  voiceProfileSampleCount: number;
}

interface PlayType {
  value: string;
  label: string;
  intent: string;
}

export function DraftEmailModal({
  open,
  onClose,
  accountId,
  contactId,
  threadId,
  defaultPlayType = "general",
  companyName,
  contactName,
}: DraftEmailModalProps) {
  const [playType, setPlayType] = useState(defaultPlayType);
  const [draft, setDraft] = useState("");
  const [draftResponse, setDraftResponse] = useState<DraftResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [showAnchors, setShowAnchors] = useState(false);
  const [additionalContext, setAdditionalContext] = useState("");
  const { toast } = useToast();

  const { data: playTypes = [] } = useQuery<PlayType[]>({
    queryKey: ["/api/email-drafts/play-types"],
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/email-drafts/generate", {
        accountId: accountId || undefined,
        contactId: contactId || undefined,
        playType,
        threadId: threadId || undefined,
        additionalContext: additionalContext || undefined,
      });
      return res.json() as Promise<DraftResponse>;
    },
    onSuccess: (data) => {
      setDraft(data.draft);
      setDraftResponse(data);
    },
    onError: () => {
      toast({ title: "Failed to generate draft", variant: "destructive" });
    },
  });

  function handleGenerate() {
    generateMutation.mutate();
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      toast({ title: "Draft copied to clipboard" });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Unable to copy — please select and copy manually", variant: "destructive" });
    }
  }

  function handleRegenerate() {
    generateMutation.mutate();
  }

  function handleClose() {
    setDraft("");
    setDraftResponse(null);
    setCopied(false);
    setShowAnchors(false);
    setAdditionalContext("");
    onClose();
  }

  const isLoading = generateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-lg" data-testid="draft-email-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            Draft Email
            {companyName && (
              <span className="text-sm font-normal text-muted-foreground">
                — {companyName}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Play</label>
              <Select value={playType} onValueChange={setPlayType}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-play-type">
                  <SelectValue placeholder="Select play type" />
                </SelectTrigger>
                <SelectContent>
                  {playTypes.map((pt) => (
                    <SelectItem key={pt.value} value={pt.value} className="text-xs">
                      {pt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {contactName && (
              <div className="text-xs text-muted-foreground pt-4">
                To: <span className="font-medium text-foreground">{contactName}</span>
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Additional context (optional)
            </label>
            <Textarea
              value={additionalContext}
              onChange={(e) => setAdditionalContext(e.target.value)}
              placeholder="e.g., They mentioned rate concerns last call..."
              className="h-16 text-xs resize-none"
              data-testid="input-additional-context"
            />
          </div>

          {!draftResponse && !isLoading && (
            <Button
              onClick={handleGenerate}
              className="w-full gap-2"
              data-testid="button-generate-draft"
            >
              <Wand2 className="w-4 h-4" />
              Generate Draft
            </Button>
          )}

          {isLoading && (
            <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground" data-testid="draft-loading">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Generating personalized draft...</span>
            </div>
          )}

          {draftResponse && !isLoading && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-xs gap-1" data-testid="badge-play-label">
                  <Sparkles className="w-3 h-3" />
                  {draftResponse.playLabel}
                </Badge>
                {draftResponse.voiceProfileAvailable ? (
                  <Badge variant="secondary" className="text-xs" data-testid="badge-voice-profile">
                    Voice matched ({draftResponse.voiceProfileSampleCount} emails)
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs text-amber-600 border-amber-300" data-testid="badge-no-voice">
                    <AlertCircle className="w-3 h-3 mr-1" />
                    No voice profile — generic tone
                  </Badge>
                )}
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Email Draft
                </label>
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="min-h-[120px] text-sm"
                  data-testid="textarea-draft"
                />
              </div>

              {draftResponse.dataAnchors.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowAnchors(!showAnchors)}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    data-testid="button-toggle-anchors"
                  >
                    <Database className="w-3 h-3" />
                    Data Anchors ({draftResponse.dataAnchors.length})
                    {showAnchors ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                  {showAnchors && (
                    <div className="mt-2 p-3 rounded-lg bg-muted/50 border space-y-1.5" data-testid="data-anchors-section">
                      {draftResponse.dataAnchors.map((anchor, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs" data-testid={`data-anchor-${anchor.type}`}>
                          <span className="font-medium text-muted-foreground min-w-[100px] shrink-0">
                            {anchor.label}:
                          </span>
                          <span className="text-foreground">{anchor.value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {draftResponse && !isLoading && (
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRegenerate}
              className="gap-1"
              data-testid="button-regenerate-draft"
            >
              <RefreshCw className="w-3 h-3" />
              Regenerate
            </Button>
            <Button
              size="sm"
              onClick={handleCopy}
              className="gap-1"
              data-testid="button-copy-draft"
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied ? "Copied!" : "Copy to Clipboard"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
