import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Sparkles, ThumbsUp, ThumbsDown, MessageSquarePlus, User as UserIcon, Bot } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface AccountReviewSourceSnapshots {
  contactCount: number;
  touchpointCount: number;
  rfpCount: number;
  awardCount: number;
  crossSellCount: number;
  growthScoreId: number | null;
}

interface AccountReview {
  id: string;
  weekOf: string;
  body: string;
  rating: number | null;
  generatedBy: string;
  createdAt: string;
  repUserId: string;
  followUpThreadId: string | null;
  sections: Record<string, unknown> | null;
  sourceSnapshots: AccountReviewSourceSnapshots | null;
}

interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  agentName?: string | null;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
}

interface FollowUpThreadResponse {
  threadId: string | null;
  messages: ThreadMessage[];
}

interface Props {
  companyId: string;
  companyName: string;
}

function FollowUpThread({ reviewId, hasThread }: { reviewId: string; hasThread: boolean }) {
  const { data } = useQuery<FollowUpThreadResponse>({
    queryKey: ["/api/account-reviews", reviewId, "follow-up"],
    enabled: hasThread,
  });
  if (!hasThread || !data || !data.messages.length) return null;
  // Skip the seed assistant message (the review body) — we render that above.
  const conversation = data.messages
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(1);
  if (!conversation.length) return null;
  return (
    <div className="mt-3 space-y-2" data-testid={`thread-messages-${reviewId}`}>
      {conversation.map(m => (
        <div
          key={m.id}
          className={`flex gap-2 text-sm rounded-md p-2 ${m.role === "user" ? "bg-muted/50" : "bg-primary/5"}`}
          data-testid={`thread-message-${m.id}`}
        >
          <div className="mt-0.5 shrink-0 text-muted-foreground">
            {m.role === "user" ? <UserIcon className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
          </div>
          <div className="whitespace-pre-wrap leading-relaxed">{m.content}</div>
        </div>
      ))}
    </div>
  );
}

export function AccountReviewsTab({ companyId, companyName }: Props) {
  const { toast } = useToast();
  const [followUp, setFollowUp] = useState<Record<string, string>>({});

  const { data: reviews, isLoading } = useQuery<AccountReview[]>({
    queryKey: ["/api/account-reviews/company", companyId],
  });

  const generateMut = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/account-reviews/generate", { companyId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/account-reviews/company", companyId] });
      toast({ title: "Account review generated", description: `Latest review for ${companyName} is ready.` });
    },
    onError: (e: unknown) => toast({ title: "Could not generate", description: e instanceof Error ? e.message : String(e), variant: "destructive" }),
  });

  const rateMut = useMutation({
    mutationFn: async ({ id, rating }: { id: string; rating: "up" | "down" }) =>
      apiRequest("POST", `/api/account-reviews/${id}/rate`, { rating }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/account-reviews/company", companyId] });
      toast({ title: "Thanks for the feedback" });
    },
  });

  const followUpMut = useMutation({
    mutationFn: async ({ id, message }: { id: string; message: string }) =>
      apiRequest("POST", `/api/account-reviews/${id}/follow-up`, { message }),
    onSuccess: (_data, vars) => {
      setFollowUp(prev => ({ ...prev, [vars.id]: "" }));
      queryClient.invalidateQueries({ queryKey: ["/api/account-reviews/company", companyId] });
      queryClient.invalidateQueries({ queryKey: ["/api/account-reviews", vars.id, "follow-up"] });
      toast({ title: "Agent replied in thread" });
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Auto Weekly Account Review
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Generated every Friday for top-25 accounts. Showing the rolling last 8 weeks.
            </p>
          </div>
          <Button
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
            data-testid="button-generate-review"
          >
            {generateMut.isPending ? "Generating…" : "Generate now"}
          </Button>
        </CardHeader>
      </Card>

      {isLoading ? (
        <div className="space-y-2"><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></div>
      ) : !reviews || reviews.length === 0 ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground" data-testid="text-no-reviews">
          No account reviews yet. Click <strong>Generate now</strong> to create one for this account.
        </CardContent></Card>
      ) : (
        <div className="space-y-4">
          {reviews.map(r => (
            <Card key={r.id} data-testid={`card-review-${r.id}`}>
              <CardHeader>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <CardTitle className="text-base">
                    Week of {r.weekOf}
                    <Badge variant={r.generatedBy === "manual" ? "secondary" : "outline"} className="ml-2 text-xs">
                      {r.generatedBy}
                    </Badge>
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={r.rating === 1 ? "default" : "outline"}
                      onClick={() => rateMut.mutate({ id: r.id, rating: "up" })}
                      data-testid={`button-thumbs-up-${r.id}`}
                    >
                      <ThumbsUp className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant={r.rating === -1 ? "default" : "outline"}
                      onClick={() => rateMut.mutate({ id: r.id, rating: "down" })}
                      data-testid={`button-thumbs-down-${r.id}`}
                    >
                      <ThumbsDown className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed" data-testid={`text-review-body-${r.id}`}>
                  {r.body}
                </pre>
                <div className="mt-4 border-t pt-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                    <span>Ask a follow-up — the agent will respond with the review as context</span>
                  </div>
                  <FollowUpThread reviewId={r.id} hasThread={!!r.followUpThreadId} />
                  <Textarea
                    rows={2}
                    placeholder="What's the next step or context to capture?"
                    value={followUp[r.id] ?? ""}
                    onChange={e => setFollowUp(prev => ({ ...prev, [r.id]: e.target.value }))}
                    data-testid={`input-follow-up-${r.id}`}
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={!followUp[r.id]?.trim() || followUpMut.isPending}
                      onClick={() => followUpMut.mutate({ id: r.id, message: followUp[r.id].trim() })}
                      data-testid={`button-add-follow-up-${r.id}`}
                    >
                      Log follow-up
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
