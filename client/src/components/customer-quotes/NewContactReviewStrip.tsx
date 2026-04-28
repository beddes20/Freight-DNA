/**
 * Task #803 — Quote Lifecycle Autopilot prompt strip.
 *
 * Renders a compact callout above the Quote Opportunities table for every
 * inbound quote whose sender domain matched a known customer but whose
 * full email address was new to our CRM. Each row offers two one-click
 * actions:
 *   - Add as contact: looks up the customer's CRM company by email
 *     domain, inserts a contacts row, clears the prompt, writes an
 *     `auto:new_sender` quote_event for audit.
 *   - Dismiss: clears the prompt and writes the same audit event with
 *     `action: 'dismiss'`.
 *
 * The list is fetched fresh via TanStack Query and invalidated on every
 * action so the strip empties out as the rep clears prompts.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { UserPlus, X, Sparkles } from "lucide-react";

interface ReviewItem {
  quoteId: string;
  customerId: string;
  customerName: string;
  senderEmail: string;
  senderName: string | null;
  detectedAt: string | null;
  lane: string;
  requestDate: string;
}

interface ListResponse { items: ReviewItem[]; }

const QK = ["/api/customer-quotes/new-contact-reviews"] as const;

export function NewContactReviewStrip(): JSX.Element | null {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<ListResponse>({
    queryKey: QK,
    staleTime: 30_000,
  });

  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const setDraft = (id: string, value: string) =>
    setDraftNames(prev => ({ ...prev, [id]: value }));

  const action = useMutation({
    mutationFn: async (vars: { quoteId: string; action: "add" | "dismiss"; name?: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/customer-quotes/quote/${vars.quoteId}/new-contact-review`,
        { action: vars.action, ...(vars.name ? { name: vars.name } : {}) },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: QK });
      // The list query and any open quote-detail queries should refresh
      // so the lifecycle event shows up immediately.
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      toast({
        title: vars.action === "add" ? "Contact added" : "Prompt dismissed",
        description: vars.action === "add"
          ? "We've added them to the customer's CRM contacts."
          : "We won't ask about this sender again.",
      });
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Could not update prompt",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  if (isLoading) return null;
  const items = data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <div
      className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700/40 p-3"
      data-testid="new-contact-review-strip"
    >
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-foreground">
          New contacts to review
        </span>
        <span className="text-xs text-muted-foreground">
          ({items.length} pending)
        </span>
      </div>
      <ul className="space-y-1.5">
        {items.map(item => {
          const draft = draftNames[item.quoteId] ?? item.senderName ?? "";
          const pending = action.isPending && action.variables?.quoteId === item.quoteId;
          return (
            <li
              key={item.quoteId}
              className="flex flex-wrap items-center gap-2 text-xs bg-background/60 rounded px-2 py-1.5 border border-amber-200/40 dark:border-amber-800/40"
              data-testid={`new-contact-review-row-${item.quoteId}`}
            >
              <span className="font-medium text-foreground">
                New contact at {item.customerName}
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="text-foreground/80" data-testid={`text-sender-${item.quoteId}`}>
                {item.senderEmail}
              </span>
              <span className="text-muted-foreground hidden md:inline">· {item.lane}</span>
              <div className="flex items-center gap-1.5 ml-auto">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(item.quoteId, e.target.value)}
                  placeholder="Display name"
                  className="h-7 text-xs w-44"
                  data-testid={`input-contact-name-${item.quoteId}`}
                />
                <Button
                  size="sm"
                  className="h-7 px-2"
                  disabled={pending}
                  onClick={() => action.mutate({
                    quoteId: item.quoteId,
                    action: "add",
                    name: draft.trim() || undefined,
                  })}
                  data-testid={`button-add-contact-${item.quoteId}`}
                >
                  <UserPlus className="h-3.5 w-3.5 mr-1" /> Add
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-muted-foreground"
                  disabled={pending}
                  onClick={() => action.mutate({ quoteId: item.quoteId, action: "dismiss" })}
                  data-testid={`button-dismiss-contact-${item.quoteId}`}
                >
                  <X className="h-3.5 w-3.5 mr-1" /> Dismiss
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
