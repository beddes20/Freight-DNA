import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Mail, Send, X, AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

interface OutlookComposeProps {
  open: boolean;
  onClose: () => void;
  toEmail?: string;
  toName?: string;
  defaultSubject?: string;
  defaultBody?: string;
  companyName?: string;
  contactId?: string;
  companyId?: string;
}

function plainTextToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split(/\n\n+/)
    .map(para => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("")
    .replace(/<p><\/p>/g, "<p><br></p>");
}

function isHtmlContent(str: string): boolean {
  return /<[a-z][\s\S]*>/i.test(str);
}

export function OutlookComposeDialog({
  open,
  onClose,
  toEmail = "",
  toName = "",
  defaultSubject = "",
  defaultBody = "",
  companyName = "",
  contactId,
  companyId,
}: OutlookComposeProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [to, setTo] = useState(toEmail);
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [sent, setSent] = useState(false);

  const signature = user?.emailSignature ?? null;
  const hasHtmlSignature = signature ? isHtmlContent(signature) : false;

  function buildEmailHtml(): string {
    const bodyHtml = plainTextToHtml(body.trim());
    if (!signature) return bodyHtml;
    if (hasHtmlSignature) {
      return `${bodyHtml}<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">${signature}`;
    }
    const sigHtml = plainTextToHtml(signature);
    return `${bodyHtml}<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">${sigHtml}`;
  }

  useEffect(() => {
    if (open) {
      setTo(toEmail);
      setSubject(defaultSubject);
      setBody(defaultBody);
      setCc("");
      setSent(false);
    }
  }, [open, toEmail, defaultSubject, defaultBody]);

  const { data: statusData } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/outlook/status"],
    staleTime: 60_000,
  });
  const outlookEnabled = statusData?.enabled ?? false;

  const sendMutation = useMutation({
    mutationFn: async () => {
      const ccEmails = cc
        .split(",")
        .map(s => s.trim())
        .filter(s => s.includes("@"));
      const res = await apiRequest("POST", "/api/outlook/send", {
        toEmail: to.trim(),
        toName,
        subject: subject.trim(),
        body: buildEmailHtml(),
        ccEmails,
        isHtml: true,
        contactId: contactId || undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSent(true);
        toast({ title: "Email sent!", description: `Your email to ${to} was sent from your Outlook.` });
        if (contactId) {
          queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "touchpoints"] });
          queryClient.invalidateQueries({ queryKey: ["/api/dashboard/cold-contacts"] });
          if (companyId) {
            queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "touchpoints"] });
          }
        }
      } else {
        toast({
          title: "Failed to send",
          description: data.error || "Something went wrong",
          variant: "destructive",
        });
      }
    },
    onError: () => {
      toast({ title: "Error", description: "Could not send email. Check your connection and try again.", variant: "destructive" });
    },
  });

  const draftMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ai/draft-email", {
        contactId: contactId || undefined,
        companyId: companyId || undefined,
        subject: subject.trim() || undefined,
        toName: toName || undefined,
        companyName: companyName || undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.draft) {
        setBody(data.draft);
        toast({ title: "Draft ready!", description: "AI draft inserted — review and edit before sending." });
      } else {
        toast({ title: "No draft returned", description: "Try again or write manually.", variant: "destructive" });
      }
    },
    onError: () => {
      toast({ title: "Draft failed", description: "Could not generate a draft. Write manually.", variant: "destructive" });
    },
  });

  const canSend = to.includes("@") && subject.trim() && body.trim() && outlookEnabled && !sendMutation.isPending && !sent;
  const canDraft = !draftMutation.isPending && !sent;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-[600px]" data-testid="dialog-outlook-compose">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-blue-500" />
            Compose Email
            {toName && <span className="text-muted-foreground font-normal text-sm">→ {toName}</span>}
          </DialogTitle>
        </DialogHeader>

        {!outlookEnabled && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800/40 p-3 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-amber-800 dark:text-amber-200">
              Outlook is not connected yet. Set your Azure credentials in the server configuration to enable email sending.
            </p>
          </div>
        )}

        {sent ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle2 className="h-12 w-12 text-emerald-500" />
            <div>
              <p className="font-semibold">Email Sent!</p>
              <p className="text-sm text-muted-foreground mt-1">Your email to <strong>{to}</strong> was sent from your Outlook and saved to Sent Items.</p>
            </div>
            <Button variant="outline" onClick={onClose} className="mt-2" data-testid="button-outlook-close-success">
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="outlook-to" className="text-xs font-medium">To</Label>
              <Input
                id="outlook-to"
                value={to}
                onChange={e => setTo(e.target.value)}
                placeholder="recipient@company.com"
                data-testid="input-outlook-to"
                className="text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="outlook-cc" className="text-xs font-medium text-muted-foreground">CC <span className="font-normal">(optional, comma-separated)</span></Label>
              <Input
                id="outlook-cc"
                value={cc}
                onChange={e => setCc(e.target.value)}
                placeholder="cc@company.com, another@company.com"
                data-testid="input-outlook-cc"
                className="text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="outlook-subject" className="text-xs font-medium">Subject</Label>
              <Input
                id="outlook-subject"
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="Email subject"
                data-testid="input-outlook-subject"
                className="text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="outlook-body" className="text-xs font-medium">Message</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs gap-1.5 text-purple-600 border-purple-200 hover:bg-purple-50 hover:border-purple-400 dark:text-purple-400 dark:border-purple-800 dark:hover:bg-purple-950/40"
                  onClick={() => draftMutation.mutate()}
                  disabled={!canDraft}
                  data-testid="button-ai-draft"
                >
                  {draftMutation.isPending ? (
                    <><Loader2 className="h-3 w-3 animate-spin" />Drafting…</>
                  ) : (
                    <><Sparkles className="h-3 w-3" />Draft for me</>
                  )}
                </Button>
              </div>
              <Textarea
                id="outlook-body"
                value={body}
                onChange={e => setBody(e.target.value)}
                placeholder="Write your message here, or click 'Draft for me' to generate a personalized draft…"
                rows={8}
                data-testid="textarea-outlook-body"
                className="text-sm resize-none"
              />
              {draftMutation.isSuccess && (
                <p className="text-xs text-purple-600 dark:text-purple-400 flex items-center gap-1">
                  <Sparkles className="h-3 w-3" />
                  AI draft generated — review before sending.
                </p>
              )}
            </div>

            {signature && (
              <div className="rounded-md border border-border bg-muted/30 overflow-hidden">
                <p className="text-[10px] text-muted-foreground px-3 py-1.5 border-b border-border bg-muted/60 uppercase tracking-wide font-medium">Signature preview</p>
                <div
                  className="px-3 py-2 text-sm prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: hasHtmlSignature ? signature : signature.replace(/\n/g, "<br>") }}
                />
              </div>
            )}

            {companyName && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs font-normal">
                  Re: {companyName}
                </Badge>
                <span className="text-xs text-muted-foreground">Sent from your Outlook, saved to Sent Items.</span>
              </div>
            )}
          </div>
        )}

        {!sent && (
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={onClose} data-testid="button-outlook-cancel">
              <X className="h-4 w-4 mr-1.5" />
              Cancel
            </Button>
            <Button
              onClick={() => sendMutation.mutate()}
              disabled={!canSend}
              className="gap-2"
              data-testid="button-outlook-send"
            >
              {sendMutation.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin" />Sending…</>
              ) : (
                <><Send className="h-4 w-4" />Send via Outlook</>
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
