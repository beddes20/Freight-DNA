import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserPlus, MoreHorizontal, Mail, Check, EyeOff, Clock, Ban } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ContactSuggestion {
  id: string;
  accountId: string;
  orgId: string;
  emailAddress: string;
  suggestedName: string | null;
  suggestedTitle: string | null;
  suggestedPhone: string | null;
  suggestionSource: string;
  confidenceScore: number;
  status: string;
  threadCount: number;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SuggestedContactsPanelProps {
  companyId: string;
}

function ConfidenceBadge({ score }: { score: number }) {
  if (score >= 65) {
    return (
      <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 text-xs font-normal" data-testid="badge-confidence-high">
        High
      </Badge>
    );
  }
  if (score >= 40) {
    return (
      <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 text-xs font-normal" data-testid="badge-confidence-medium">
        Medium
      </Badge>
    );
  }
  return (
    <Badge className="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 text-xs font-normal" data-testid="badge-confidence-low">
      Low
    </Badge>
  );
}

const ROLE_OPTIONS = [
  "Decision Maker",
  "Influencer",
  "Champion",
  "End User",
  "Finance/Procurement",
  "Operations",
  "IT/Technical",
  "Executive",
  "Other",
];

export function SuggestedContactsPanel({ companyId }: SuggestedContactsPanelProps) {
  const { toast } = useToast();
  const [addRoleOpen, setAddRoleOpen] = useState(false);
  const [roleForSuggestion, setRoleForSuggestion] = useState<ContactSuggestion | null>(null);
  const [selectedRole, setSelectedRole] = useState<string>("");

  const { data: suggestions = [], isLoading } = useQuery<ContactSuggestion[]>({
    queryKey: ["/api/internal/accounts", companyId, "contact-suggestions"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/accounts/${companyId}/contact-suggestions`);
      if (!res.ok) throw new Error("Failed to fetch suggestions");
      return res.json();
    },
  });

  const pendingSuggestions = suggestions.filter(
    s => s.status === "pending" || (s.status === "snoozed" && (!s.snoozedUntil || new Date(s.snoozedUntil) <= new Date())),
  );

  const acceptMutation = useMutation({
    mutationFn: async ({ id, roleType }: { id: string; roleType?: string }) => {
      return apiRequest("POST", `/api/internal/accounts/${companyId}/contact-suggestions/${id}/accept`, { roleType });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts", companyId, "contact-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", companyId] });
      queryClient.invalidateQueries({ queryKey: [`/api/companies/${companyId}/contacts`] });
      toast({ title: "Contact added successfully" });
      setAddRoleOpen(false);
      setRoleForSuggestion(null);
      setSelectedRole("");
    },
    onError: () => {
      toast({ title: "Failed to add contact", variant: "destructive" });
    },
  });

  const ignoreMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("POST", `/api/internal/accounts/${companyId}/contact-suggestions/${id}/ignore`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts", companyId, "contact-suggestions"] });
      toast({ title: "Suggestion dismissed" });
    },
  });

  const snoozeMutation = useMutation({
    mutationFn: async (id: string) => {
      const snoozedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      return apiRequest("POST", `/api/internal/accounts/${companyId}/contact-suggestions/${id}/snooze`, { snoozedUntil });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts", companyId, "contact-suggestions"] });
      toast({ title: "Suggestion snoozed for 7 days" });
    },
  });

  const neverSuggestMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("POST", `/api/internal/accounts/${companyId}/contact-suggestions/${id}/never-suggest`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts", companyId, "contact-suggestions"] });
      toast({ title: "Address permanently suppressed" });
    },
  });

  if (isLoading || pendingSuggestions.length === 0) return null;

  return (
    <>
      <Card data-testid="card-suggested-contacts">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-blue-500" />
            Suggested Contacts
            <Badge variant="secondary" className="ml-1 font-normal" data-testid="badge-suggestion-count">
              {pendingSuggestions.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {pendingSuggestions.map(suggestion => (
            <div
              key={suggestion.id}
              className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30 hover:bg-muted/50 transition-colors"
              data-testid={`suggestion-card-${suggestion.id}`}
            >
              <Mail className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate" data-testid={`suggestion-email-${suggestion.id}`}>
                    {suggestion.emailAddress}
                  </span>
                  <ConfidenceBadge score={suggestion.confidenceScore} />
                </div>
                {suggestion.suggestedName && (
                  <p className="text-xs text-muted-foreground mt-0.5" data-testid={`suggestion-name-${suggestion.id}`}>
                    {suggestion.suggestedName}
                    {suggestion.suggestedTitle && ` · ${suggestion.suggestedTitle}`}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5" data-testid={`suggestion-source-${suggestion.id}`}>
                  {suggestion.suggestionSource === "email_thread" ? "From email thread" : "From email"}{" · "}
                  {suggestion.threadCount} thread{suggestion.threadCount !== 1 ? "s" : ""}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => acceptMutation.mutate({ id: suggestion.id })}
                  disabled={acceptMutation.isPending}
                  data-testid={`button-accept-${suggestion.id}`}
                >
                  <Check className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setRoleForSuggestion(suggestion);
                    setSelectedRole("");
                    setAddRoleOpen(true);
                  }}
                  data-testid={`button-add-role-${suggestion.id}`}
                >
                  Add + Role
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => ignoreMutation.mutate(suggestion.id)}
                  disabled={ignoreMutation.isPending}
                  data-testid={`button-ignore-${suggestion.id}`}
                >
                  <EyeOff className="h-3.5 w-3.5 mr-1" />
                  Ignore
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" data-testid={`button-more-${suggestion.id}`}>
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => snoozeMutation.mutate(suggestion.id)}
                      data-testid={`menu-snooze-${suggestion.id}`}
                    >
                      <Clock className="h-4 w-4 mr-2" />
                      Snooze 7 days
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => neverSuggestMutation.mutate(suggestion.id)}
                      className="text-destructive focus:text-destructive"
                      data-testid={`menu-never-suggest-${suggestion.id}`}
                    >
                      <Ban className="h-4 w-4 mr-2" />
                      Never suggest
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={addRoleOpen} onOpenChange={setAddRoleOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Contact with Role</DialogTitle>
          </DialogHeader>
          {roleForSuggestion && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                Adding <span className="font-medium text-foreground">{roleForSuggestion.emailAddress}</span>
              </p>
              <div className="space-y-1">
                <label className="text-sm font-medium">Role</label>
                <Select value={selectedRole} onValueChange={setSelectedRole}>
                  <SelectTrigger data-testid="select-role">
                    <SelectValue placeholder="Select role..." />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map(opt => (
                      <SelectItem key={opt} value={opt} data-testid={`role-option-${opt.replace(/\s+/g, "-").toLowerCase()}`}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddRoleOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                if (roleForSuggestion) {
                  acceptMutation.mutate({ id: roleForSuggestion.id, roleType: selectedRole || undefined });
                }
              }}
              disabled={acceptMutation.isPending}
              data-testid="button-confirm-add-role"
            >
              Add Contact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
