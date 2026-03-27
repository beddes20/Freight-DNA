import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Bug, Lightbulb, Star, Search, Clock, CheckCircle2, Eye, Inbox, Send } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type FeedbackItem = {
  id: string;
  content: string;
  status: "new" | "reviewing" | "resolved";
  createdAt: string;
  submitterName: string;
  submitterRole: string;
  submittedById: string;
  submitterEmail?: string;
  adminResponse?: string | null;
  respondedAt?: string | null;
};

function detectType(content: string): "bug" | "improvement" | "feature" {
  const first = content.split("\n")[0].toUpperCase();
  if (first.includes("BUG")) return "bug";
  if (first.includes("IMPROVEMENT")) return "improvement";
  return "feature";
}

function TypeBadge({ type }: { type: "bug" | "improvement" | "feature" }) {
  if (type === "bug")
    return (
      <Badge className="gap-1 bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800">
        <Bug className="h-3 w-3" />
        Bug
      </Badge>
    );
  if (type === "improvement")
    return (
      <Badge className="gap-1 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-800">
        <Lightbulb className="h-3 w-3" />
        Improvement
      </Badge>
    );
  return (
    <Badge className="gap-1 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800">
      <Star className="h-3 w-3" />
      Feature
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "new")
    return (
      <Badge className="gap-1 bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 border-purple-200 dark:border-purple-800">
        <Inbox className="h-3 w-3" />
        New
      </Badge>
    );
  if (status === "reviewing")
    return (
      <Badge className="gap-1 bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800">
        <Eye className="h-3 w-3" />
        Reviewing
      </Badge>
    );
  return (
    <Badge className="gap-1 bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-800">
      <CheckCircle2 className="h-3 w-3" />
      Resolved
    </Badge>
  );
}

function roleLabel(role: string) {
  const map: Record<string, string> = {
    admin: "Admin",
    director: "Director",
    national_account_manager: "NAM",
    account_manager: "AM",
    logistics_manager: "LM",
    logistics_coordinator: "LC",
    sales_director: "Sales Director",
    sales: "Sales",
  };
  return map[role] ?? role;
}

function FeedbackCard({ item }: { item: FeedbackItem }) {
  const [expanded, setExpanded] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [responseText, setResponseText] = useState(item.adminResponse ?? "");
  const [savingResponse, setSavingResponse] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();
  const type = detectType(item.content);

  const contentLines = item.content.split("\n");
  const isLong = contentLines.length > 4 || item.content.length > 250;
  const displayContent = expanded || !isLong ? item.content : item.content.slice(0, 250) + "…";

  const updateStatus = async (status: string) => {
    setUpdating(true);
    try {
      await apiRequest("PATCH", `/api/chatbot/suggestions/${item.id}`, { status });
      qc.invalidateQueries({ queryKey: ["/api/chatbot/suggestions"] });
      toast({ title: "Status updated" });
    } catch {
      toast({ title: "Failed to update status", variant: "destructive" });
    } finally {
      setUpdating(false);
    }
  };

  const saveResponse = async () => {
    if (!responseText.trim()) return;
    setSavingResponse(true);
    try {
      await apiRequest("PATCH", `/api/chatbot/suggestions/${item.id}`, { adminResponse: responseText.trim() });
      qc.invalidateQueries({ queryKey: ["/api/chatbot/suggestions"] });
      toast({ title: "Response saved", description: item.submitterEmail ? "Submitter will be notified by email." : "Response saved." });
    } catch {
      toast({ title: "Failed to save response", variant: "destructive" });
    } finally {
      setSavingResponse(false);
    }
  };

  return (
    <Card
      className="border border-border/60 shadow-sm"
      data-testid={`feedback-card-${item.id}`}
    >
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex flex-col sm:flex-row sm:items-start gap-2 justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <TypeBadge type={type} />
            <StatusBadge status={item.status} />
            <span className="text-xs text-muted-foreground font-medium">
              {item.submitterName}
            </span>
            <span className="text-xs text-muted-foreground border border-border/50 rounded px-1.5 py-0.5">
              {roleLabel(item.submitterRole)}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
            </span>
          </div>
          <Select
            value={item.status}
            onValueChange={updateStatus}
            disabled={updating}
          >
            <SelectTrigger
              className="h-7 w-36 text-xs"
              data-testid={`feedback-status-select-${item.id}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="reviewing">Reviewing</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <Separator className="mb-1" />
        <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
          {displayContent}
        </pre>
        {isLong && (
          <button
            className="text-xs text-primary hover:underline"
            onClick={() => setExpanded((v) => !v)}
            data-testid={`feedback-expand-${item.id}`}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}

        {/* Admin response section */}
        <div className="pt-1">
          <Separator className="mb-3" />
          {item.adminResponse && (
            <div className="mb-3 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-3 py-2">
              <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 mb-1 uppercase tracking-wide">Admin Response{item.respondedAt ? ` · ${formatDistanceToNow(new Date(item.respondedAt), { addSuffix: true })}` : ""}</p>
              <p className="text-sm text-blue-900 dark:text-blue-200 whitespace-pre-wrap">{item.adminResponse}</p>
            </div>
          )}
          <div className="flex gap-2 items-start">
            <Textarea
              placeholder={item.adminResponse ? "Update response…" : "Write a response to the submitter (they'll be notified by email)…"}
              value={responseText}
              onChange={e => setResponseText(e.target.value)}
              className="text-sm resize-none flex-1"
              rows={2}
              data-testid={`feedback-response-input-${item.id}`}
            />
            <Button
              size="sm"
              className="shrink-0"
              onClick={saveResponse}
              disabled={savingResponse || !responseText.trim()}
              data-testid={`feedback-response-send-${item.id}`}
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

type FilterTab = "all" | "bug" | "improvement" | "feature" | "resolved";

export default function FeedbackInboxPage() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<FilterTab>("all");

  const { data: items = [], isLoading } = useQuery<FeedbackItem[]>({
    queryKey: ["/api/chatbot/suggestions"],
    enabled: !!user && (user.role === "admin" || user.role === "director"),
  });

  if (!user || (user.role !== "admin" && user.role !== "director")) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Access restricted to admins and directors.
      </div>
    );
  }

  const filtered = items.filter((item) => {
    const type = detectType(item.content);
    if (tab === "resolved") return item.status === "resolved";
    if (tab !== "all" && type !== tab) return false;
    if (tab !== "resolved" && item.status === "resolved") return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        item.content.toLowerCase().includes(q) ||
        item.submitterName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const counts = {
    all: items.filter((i) => i.status !== "resolved").length,
    bug: items.filter((i) => detectType(i.content) === "bug" && i.status !== "resolved").length,
    improvement: items.filter((i) => detectType(i.content) === "improvement" && i.status !== "resolved").length,
    feature: items.filter((i) => detectType(i.content) === "feature" && i.status !== "resolved").length,
    resolved: items.filter((i) => i.status === "resolved").length,
  };

  const tabs: { key: FilterTab; label: string; icon: React.ReactNode }[] = [
    { key: "all", label: "All Open", icon: <Inbox className="h-3.5 w-3.5" /> },
    { key: "bug", label: "Bugs", icon: <Bug className="h-3.5 w-3.5" /> },
    { key: "improvement", label: "Improvements", icon: <Lightbulb className="h-3.5 w-3.5" /> },
    { key: "feature", label: "Features", icon: <Star className="h-3.5 w-3.5" /> },
    { key: "resolved", label: "Resolved", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Feedback Inbox</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Bug reports, improvement suggestions, and feature requests submitted by reps via DNA Guru.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <Button
            key={t.key}
            size="sm"
            variant={tab === t.key ? "default" : "outline"}
            className="gap-1.5 h-8 text-xs"
            onClick={() => setTab(t.key)}
            data-testid={`feedback-tab-${t.key}`}
          >
            {t.icon}
            {t.label}
            {counts[t.key] > 0 && (
              <span
                className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  tab === t.key
                    ? "bg-white/20 text-white"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {counts[t.key]}
              </span>
            )}
          </Button>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-9 h-9 text-sm"
          placeholder="Search by content or rep name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="feedback-search"
        />
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <CheckCircle2 className="h-10 w-10 opacity-30" />
          <p className="text-sm">No feedback items found.</p>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((item) => (
          <FeedbackCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
