/**
 * Contact Suggestions — Org-wide batch review of AI-detected contacts from email threads.
 * Reps and managers can review, accept, or ignore suggestions across all their accounts.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  UserPlus, Mail, Check, EyeOff, Building2, Search, RefreshCw, Inbox,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ContactSuggestion {
  id: string;
  accountId: string;
  accountName?: string;
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
}

interface SuggestionCountRow {
  accountId: string;
  accountName: string;
  pendingCount: number;
}

const ROLE_OPTIONS = [
  "Decision Maker", "Influencer", "Champion", "End User",
  "Finance/Procurement", "Operations", "IT/Technical", "Executive", "Other",
];

function ConfidenceBadge({ score }: { score: number }) {
  if (score >= 65) {
    return <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 text-xs">High</Badge>;
  }
  if (score >= 40) {
    return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 text-xs">Medium</Badge>;
  }
  return <Badge className="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 text-xs">Low</Badge>;
}

export default function ContactSuggestionsPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [addRoleOpen, setAddRoleOpen] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState<ContactSuggestion | null>(null);
  const [selectedRole, setSelectedRole] = useState("");

  // Fetch all accounts with pending suggestions
  const { data: counts = [], isLoading: countsLoading, refetch } = useQuery<SuggestionCountRow[]>({
    queryKey: ["/api/internal/accounts/suggestion-counts"],
    queryFn: async () => {
      const res = await fetch("/api/internal/accounts/suggestion-counts", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch suggestion counts");
      return res.json();
    },
    staleTime: 30_000,
  });

  const accountsWithSuggestions = counts.filter(c => c.pendingCount > 0);
  const filteredAccounts = search.trim()
    ? accountsWithSuggestions.filter(a => a.accountName.toLowerCase().includes(search.toLowerCase()))
    : accountsWithSuggestions;

  const totalPending = accountsWithSuggestions.reduce((sum, a) => sum + a.pendingCount, 0);

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="border-b px-6 py-4 bg-card shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-primary" />
              Contact Suggestions
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              AI-detected contacts from email threads — review and add to your accounts
            </p>
          </div>
          <div className="flex items-center gap-2">
            {totalPending > 0 && (
              <Badge variant="secondary" className="text-sm px-3 py-1" data-testid="badge-total-pending">
                {totalPending} pending
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-refresh">
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {/* Search */}
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search accounts…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-accounts"
          />
        </div>

        {countsLoading && (
          <div className="space-y-3">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}
          </div>
        )}

        {!countsLoading && filteredAccounts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Inbox className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-muted-foreground font-medium">
              {accountsWithSuggestions.length === 0 ? "No pending contact suggestions" : "No accounts match your search"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {accountsWithSuggestions.length === 0
                ? "Suggestions appear when new people are detected in account-linked email threads."
                : "Try a different search term."}
            </p>
          </div>
        )}

        {filteredAccounts.map(account => (
          <AccountSuggestionGroup
            key={account.accountId}
            accountId={account.accountId}
            accountName={account.accountName}
            pendingCount={account.pendingCount}
            onNavigate={(id) => navigate(`/companies/${id}`)}
            onAddRole={(s) => { setSelectedSuggestion(s); setSelectedRole(""); setAddRoleOpen(true); }}
          />
        ))}
      </div>

      <Dialog open={addRoleOpen} onOpenChange={setAddRoleOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Contact with Role</DialogTitle>
          </DialogHeader>
          {selectedSuggestion && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                Adding <span className="font-medium text-foreground">{selectedSuggestion.emailAddress}</span>
                {selectedSuggestion.accountName && <> to <span className="font-medium text-foreground">{selectedSuggestion.accountName}</span></>}
              </p>
              <div className="space-y-1">
                <label className="text-sm font-medium">Role</label>
                <Select value={selectedRole} onValueChange={setSelectedRole}>
                  <SelectTrigger data-testid="select-role-dialog"><SelectValue placeholder="Select role..." /></SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map(opt => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddRoleOpen(false)}>Cancel</Button>
            <AcceptWithRoleButton
              suggestion={selectedSuggestion}
              role={selectedRole}
              onSuccess={() => { setAddRoleOpen(false); toast({ title: "Contact added successfully" }); }}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AcceptWithRoleButton({ suggestion, role, onSuccess }: {
  suggestion: ContactSuggestion | null;
  role: string;
  onSuccess: () => void;
}) {
  const mutation = useMutation({
    mutationFn: async () => {
      if (!suggestion) return;
      await apiRequest("POST", `/api/internal/accounts/${suggestion.accountId}/contact-suggestions/${suggestion.id}/accept`, { roleType: role || undefined });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts/suggestion-counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts", suggestion?.accountId, "contact-suggestions"] });
      onSuccess();
    },
  });
  return (
    <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !suggestion} data-testid="button-confirm-add-role">
      {mutation.isPending ? "Adding..." : "Add Contact"}
    </Button>
  );
}

function AccountSuggestionGroup({ accountId, accountName, pendingCount, onNavigate, onAddRole }: {
  accountId: string;
  accountName: string;
  pendingCount: number;
  onNavigate: (id: string) => void;
  onAddRole: (s: ContactSuggestion) => void;
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(true);

  const { data: suggestions = [], isLoading } = useQuery<ContactSuggestion[]>({
    queryKey: ["/api/internal/accounts", accountId, "contact-suggestions"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/accounts/${accountId}/contact-suggestions`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    staleTime: 60_000,
  });

  const pending = suggestions.filter(
    s => s.status === "pending" || (s.status === "snoozed" && (!s.snoozedUntil || new Date(s.snoozedUntil) <= new Date())),
  ).map(s => ({ ...s, accountName }));

  const acceptMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/internal/accounts/${accountId}/contact-suggestions/${id}/accept`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts", accountId, "contact-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts/suggestion-counts"] });
      toast({ title: "Contact added" });
    },
    onError: () => toast({ title: "Failed to add contact", variant: "destructive" }),
  });

  const ignoreMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/internal/accounts/${accountId}/contact-suggestions/${id}/ignore`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts", accountId, "contact-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/accounts/suggestion-counts"] });
      toast({ title: "Suggestion dismissed" });
    },
  });

  if (pending.length === 0 && !isLoading) return null;

  return (
    <Card data-testid={`card-account-${accountId}`}>
      <CardHeader className="pb-3 cursor-pointer" onClick={() => setExpanded(v => !v)}>
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <button
              className="hover:underline text-foreground"
              onClick={(e) => { e.stopPropagation(); onNavigate(accountId); }}
              data-testid={`link-account-${accountId}`}
            >
              {accountName}
            </button>
            <Badge variant="secondary" className="text-xs" data-testid={`badge-count-${accountId}`}>
              {isLoading ? "…" : pending.length}
            </Badge>
          </span>
          <span className="text-xs text-muted-foreground font-normal">{expanded ? "Collapse" : "Expand"}</span>
        </CardTitle>
      </CardHeader>
      {expanded && (
        <CardContent className="pt-0 space-y-2">
          {isLoading && <Skeleton className="h-16 w-full" />}
          {!isLoading && pending.map(suggestion => (
            <div
              key={suggestion.id}
              className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30 hover:bg-muted/50 transition-colors"
              data-testid={`row-suggestion-${suggestion.id}`}
            >
              <Mail className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium" data-testid={`text-email-${suggestion.id}`}>
                    {suggestion.emailAddress}
                  </span>
                  <ConfidenceBadge score={suggestion.confidenceScore} />
                  {suggestion.suggestionSource === "email_domain_match" && (
                    <Badge variant="outline" className="text-[10px] text-teal-600 border-teal-500/30 dark:text-teal-400">Domain</Badge>
                  )}
                  {suggestion.suggestionSource === "email_thread" && (
                    <Badge variant="outline" className="text-[10px] text-blue-600 border-blue-500/30 dark:text-blue-400">Thread</Badge>
                  )}
                </div>
                {suggestion.suggestedName && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {suggestion.suggestedName}
                    {suggestion.suggestedTitle && ` · ${suggestion.suggestedTitle}`}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  {suggestion.threadCount} thread{suggestion.threadCount !== 1 ? "s" : ""} ·{" "}
                  {suggestion.suggestionSource === "email_thread"
                    ? "Email thread"
                    : suggestion.suggestionSource === "email_domain_match"
                    ? "Domain match"
                    : suggestion.suggestionSource === "email_message"
                    ? "Email message"
                    : suggestion.suggestionSource}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => acceptMutation.mutate(suggestion.id)}
                  disabled={acceptMutation.isPending}
                  data-testid={`btn-accept-${suggestion.id}`}
                >
                  <Check className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => onAddRole(suggestion)}
                  data-testid={`btn-add-role-${suggestion.id}`}
                >
                  + Role
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => ignoreMutation.mutate(suggestion.id)}
                  disabled={ignoreMutation.isPending}
                  data-testid={`btn-ignore-${suggestion.id}`}
                >
                  <EyeOff className="h-3.5 w-3.5 mr-1" />
                  Ignore
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}
