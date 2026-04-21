import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, PhoneMissed, Voicemail, Moon, UserPlus, PhoneCall } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface MissedCall {
  id: string;
  cdrId: string;
  callingNumber: string;
  calledNumber: string | null;
  ringDurationSeconds: number;
  voicemailLeft: boolean;
  startTime: string;
  afterHours: boolean;
  callbackCreatedAt: string | null;
  nbaCardId: string | null;
  contact: { id: string; name: string; title: string | null } | null;
  company: { id: string; name: string } | null;
  attributedUser: { id: string; name: string } | null;
  repeatCount: number;
  known: boolean;
}

interface Props {
  hours?: number;
  defaultCollapsed?: boolean;
  title?: string;
  limit?: number;
}

function formatPhone(p: string): string {
  const digits = p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return p;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export function MissedInboundPortlet({
  hours = 48,
  defaultCollapsed = false,
  title = "Missed Inbound Calls",
  limit = 10,
}: Props) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data, isLoading } = useQuery<{ calls: MissedCall[]; windowHours: number }>({
    queryKey: ["/api/webex/missed-inbound", { hours }],
    queryFn: async () => {
      const res = await fetch(`/api/webex/missed-inbound?hours=${hours}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load missed calls");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const callbackMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/webex/missed-inbound/${id}/callback`);
      return res.json();
    },
    onSuccess: (result: { navigate: { kind: "contact"; contactId: string } | { kind: "unknown"; phone: string } }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/webex/missed-inbound"] });
      queryClient.invalidateQueries({ queryKey: ["/api/nba/cards"] });
      toast({ title: "Callback queued", description: "A Next Best Action card was created for the responsible rep." });
      if (result.navigate.kind === "contact") {
        navigate(`/contacts/${result.navigate.contactId}`);
      } else {
        navigate(`/contacts/new?phone=${encodeURIComponent(result.navigate.phone)}&source=missed_inbound`);
      }
    },
    onError: () => {
      toast({ title: "Couldn't create callback", variant: "destructive" });
    },
  });

  const rawCalls = data?.calls ?? [];
  // Sort: repeat callers (2+) first, then by recency. Matches the spec's
  // ask that repeat callers get surfaced ahead of one-off misses even if a
  // newer single-ring call arrived after them.
  const calls = [...rawCalls].sort((a, b) => {
    const aRepeat = a.repeatCount > 1 ? 1 : 0;
    const bRepeat = b.repeatCount > 1 ? 1 : 0;
    if (aRepeat !== bRepeat) return bRepeat - aRepeat;
    if (a.repeatCount !== b.repeatCount) return b.repeatCount - a.repeatCount;
    return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
  });
  const unknowns = calls.filter(c => !c.known).length;
  const afterHours = calls.filter(c => c.afterHours).length;
  const voicemails = calls.filter(c => c.voicemailLeft).length;

  return (
    <Card data-testid="card-missed-inbound">
      <CardHeader className={collapsed ? "pb-2" : "pb-3"}>
        <button
          onClick={() => setCollapsed(v => !v)}
          className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity"
          data-testid="button-toggle-missed-inbound"
        >
          {collapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
          <CardTitle className="flex items-center gap-2 text-base">
            <PhoneMissed className="h-4 w-4 text-red-500" />
            {title}
            <Badge variant="secondary" className="ml-auto font-normal" data-testid="badge-missed-count">{calls.length}</Badge>
          </CardTitle>
        </button>
      </CardHeader>
      {!collapsed && (
        <CardContent className="p-0">
          {isLoading ? (
            <div className="px-4 py-6 text-sm text-muted-foreground" data-testid="text-missed-loading">Loading missed calls…</div>
          ) : calls.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground" data-testid="text-missed-empty">
              No missed inbound calls in the last {hours}h.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-3 px-4 py-2 text-xs text-muted-foreground border-b" data-testid="text-missed-summary">
                <span>{unknowns} unknown</span>
                <span>·</span>
                <span className="flex items-center gap-1"><Voicemail className="h-3 w-3" /> {voicemails} voicemail{voicemails === 1 ? "" : "s"}</span>
                <span>·</span>
                <span className="flex items-center gap-1"><Moon className="h-3 w-3" /> {afterHours} after-hours</span>
              </div>
              <div className="divide-y">
                {calls.slice(0, limit).map(call => (
                  <div
                    key={call.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (call.callbackCreatedAt) {
                        if (call.contact) navigate(`/contacts/${call.contact.id}`);
                      } else if (!callbackMutation.isPending) {
                        callbackMutation.mutate(call.id);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (call.callbackCreatedAt) {
                          if (call.contact) navigate(`/contacts/${call.contact.id}`);
                        } else if (!callbackMutation.isPending) {
                          callbackMutation.mutate(call.id);
                        }
                      }
                    }}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors cursor-pointer"
                    data-testid={`missed-call-row-${call.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate" data-testid={`text-caller-${call.id}`}>
                          {call.contact?.name ?? formatPhone(call.callingNumber)}
                        </p>
                        {!call.known && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1" data-testid={`badge-unknown-${call.id}`}>unknown</Badge>
                        )}
                        {call.voicemailLeft && (
                          <Voicemail className="h-3 w-3 text-amber-500" aria-label="voicemail left" />
                        )}
                        {call.afterHours && (
                          <Moon className="h-3 w-3 text-indigo-500" aria-label="after hours" />
                        )}
                        {call.repeatCount > 1 && (
                          <Badge variant="destructive" className="text-[10px] h-4 px-1" data-testid={`badge-repeat-${call.id}`}>
                            ×{call.repeatCount}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate" data-testid={`text-meta-${call.id}`}>
                        {call.company?.name ?? formatPhone(call.callingNumber)}
                        {call.attributedUser ? ` · rang ${call.attributedUser.name}` : ""}
                        {call.calledNumber ? ` · line ${formatPhone(call.calledNumber)}` : ""}
                        {` · rang ${call.ringDurationSeconds}s`}
                        {` · ${formatRelative(call.startTime)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {call.callbackCreatedAt ? (
                        <Badge variant="secondary" className="text-[10px]" data-testid={`badge-queued-${call.id}`}>queued</Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => callbackMutation.mutate(call.id)}
                          disabled={callbackMutation.isPending}
                          data-testid={`button-callback-${call.id}`}
                        >
                          {call.known ? <PhoneCall className="h-3 w-3 mr-1" /> : <UserPlus className="h-3 w-3 mr-1" />}
                          {call.known ? "Call back" : "Add & call"}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
