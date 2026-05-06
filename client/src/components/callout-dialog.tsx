import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Crown, ShieldCheck } from "lucide-react";
import type { Company, User } from "@shared/schema";

type SafeUser = Omit<User, "password">;

interface CalloutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId?: string;
  parentId?: string;
  parentTitle?: string;
}

function detectMention(body: string, cursorPos: number) {
  if (cursorPos <= 0) return null;
  let i = cursorPos - 1;
  while (i >= 0 && body[i] !== "@" && body[i] !== " " && body[i] !== "\n") {
    i--;
  }
  if (i < 0 || body[i] !== "@") return null;
  if (i > 0 && body[i - 1] !== " " && body[i - 1] !== "\n") return null;
  const query = body.slice(i + 1, cursorPos);
  return { mentionStart: i, query };
}

export function CalloutDialog({ open, onOpenChange, companyId, parentId, parentTitle }: CalloutDialogProps) {
  const { toast } = useToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tag, setTag] = useState("");
  const [selectedCompanyId, setSelectedCompanyId] = useState("");

  const [mentionState, setMentionState] = useState<{ mentionStart: number; query: string } | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
    enabled: !companyId && !parentId,
  });

  const { data: teamMembers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
  });

  const mentionableUsers = teamMembers.filter(
    u => u.role === "admin" || u.role === "director"
  );

  const filteredMentions = mentionState
    ? mentionableUsers.filter(u => {
        const firstName = u.name.split(" ")[0];
        return firstName.toLowerCase().startsWith(mentionState.query.toLowerCase());
      })
    : [];

  useEffect(() => {
    if (open) {
      setTitle("");
      setBody("");
      setTag("");
      setSelectedCompanyId(companyId || "");
      setMentionState(null);
      setSelectedIndex(0);
    }
  }, [open, companyId]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [mentionState?.query]);

  const insertMention = useCallback((user: SafeUser) => {
    if (!mentionState || !textareaRef.current) return;
    const firstName = user.name.split(" ")[0];
    const before = body.slice(0, mentionState.mentionStart);
    const after = body.slice(textareaRef.current.selectionStart);
    const newBody = before + "@" + firstName + " " + after;
    setBody(newBody);
    setMentionState(null);
    setSelectedIndex(0);

    const newCursorPos = mentionState.mentionStart + firstName.length + 2;
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
      }
    });
  }, [mentionState, body]);

  const handleBodyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newBody = e.target.value;
    setBody(newBody);
    const cursorPos = e.target.selectionStart;
    const detection = detectMention(newBody, cursorPos);
    setMentionState(detection);
  };

  const handleBodyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionState || filteredMentions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % filteredMentions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + filteredMentions.length) % filteredMentions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      insertMention(filteredMentions[selectedIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMentionState(null);
    }
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/callouts", {
        title,
        body: body || null,
        tag: tag && tag !== "none" ? tag : null,
        companyId: selectedCompanyId && selectedCompanyId !== "none" ? selectedCompanyId : null,
        parentId: parentId || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/callouts"] });
      if (selectedCompanyId && selectedCompanyId !== "none") {
        queryClient.invalidateQueries({ queryKey: ["/api/callouts/company", selectedCompanyId] });
      }
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: ["/api/callouts/company", companyId] });
      }
      toast({ title: parentId ? "Reply posted" : "Callout created" });
      onOpenChange(false);
    },
    onError: () => toast({ title: parentId ? "Failed to post reply" : "Failed to create callout", variant: "destructive" }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    createMutation.mutate();
  };

  const roleIcon = (role: string) => {
    if (role === "director") return <Crown className="h-3 w-3 text-indigo-500" />;
    return <ShieldCheck className="h-3 w-3 text-red-500" />;
  };

  const roleLabel = (role: string) => {
    if (role === "director") return "Director";
    return "Admin";
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle data-testid="text-callout-dialog-title">
            {parentId ? `Reply to: ${parentTitle}` : "New Callout"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="callout-title">Title</Label>
            <Input
              id="callout-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={parentId ? "Your reply..." : "e.g. Reefer rates trending up in the Midwest"}
              required
              data-testid="input-callout-title"
            />
          </div>

          <div className="space-y-2 relative">
            <Label htmlFor="callout-body">Notes</Label>
            <Textarea
              ref={textareaRef}
              id="callout-body"
              value={body}
              onChange={handleBodyChange}
              onKeyDown={handleBodyKeyDown}
              placeholder="Additional details... Type @ to mention admins or directors"
              rows={3}
              data-testid="input-callout-body"
            />
            {mentionState && filteredMentions.length > 0 && (
              <div
                className="absolute left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md"
                data-testid="mention-dropdown"
              >
                {filteredMentions.map((user, idx) => (
                  <button
                    key={user.id}
                    type="button"
                    className={`flex items-center gap-2 w-full px-3 py-2 text-left text-sm transition-colors ${
                      idx === selectedIndex
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted"
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertMention(user);
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    data-testid={`mention-option-${user.id}`}
                  >
                    {roleIcon(user.role)}
                    <span className="font-medium">{user.name}</span>
                    <span className="text-xs text-muted-foreground ml-auto">{roleLabel(user.role)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {!parentId && (
            <>
              <div className="space-y-2">
                <Label>Tag (optional)</Label>
                <Select value={tag} onValueChange={setTag}>
                  <SelectTrigger data-testid="select-callout-tag">
                    <SelectValue placeholder="No tag" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No tag</SelectItem>
                    <SelectItem value="Trend">Trend</SelectItem>
                    <SelectItem value="Callout">Callout</SelectItem>
                    <SelectItem value="Idea">Idea</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {!companyId && (
                <div className="space-y-2">
                  <Label>Link to Account (optional)</Label>
                  <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
                    <SelectTrigger data-testid="select-callout-company">
                      <SelectValue placeholder="No account linked" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No account linked</SelectItem>
                      {companies.map(c => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-callout-cancel">
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending || !title.trim()} data-testid="button-callout-save">
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {parentId ? "Post Reply" : "Create Callout"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
