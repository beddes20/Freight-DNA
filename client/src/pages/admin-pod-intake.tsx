import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Mail, Send, RefreshCw, Link2 } from "lucide-react";
import { format } from "date-fns";

type Bucket = "forwarded" | "unmatched" | "not_pod";

interface PodIntakeRow {
  id: string;
  receivedAt: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  bodyPreview: string | null;
  classification: string;
  classifierMethod: string | null;
  extractedOrderIds: string[] | null;
  matchedOrderId: string | null;
  matchedLoadFactId: string | null;
  matchedCompanyId: string | null;
  forwardStatus: string;
  forwardedAt: string | null;
  forwardedTo: {
    dispatcher?: { email: string; name?: string } | null;
    accountOwner?: { email: string; name?: string } | null;
    teamFallback?: { email: string } | null;
  } | null;
  forwardError: string | null;
  hasAttachments: boolean;
  attachmentMeta: Array<{
    id: string;
    name: string;
    contentType: string;
    sizeBytes: number;
    isPodCandidate: boolean;
  }> | null;
  bucket: Bucket | "pending";
}

interface PodIntakeListResponse {
  bucket: Bucket;
  count: number;
  rows: PodIntakeRow[];
}

interface PodIntakeSettings {
  orgId: string;
  monitoredMailboxId: string | null;
  teamFallbackEmail: string | null;
  enabled: boolean;
  useAiFallback: boolean;
}

interface MonitoredMailbox {
  id: string;
  email: string;
  displayName: string | null;
}

const BUCKET_LABELS: Record<Bucket, string> = {
  forwarded: "Forwarded",
  unmatched: "Unmatched",
  not_pod: "Not a POD",
};

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AdminPodIntakePage() {
  const { toast } = useToast();
  const [bucket, setBucket] = useState<Bucket>("forwarded");
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [linkOrderId, setLinkOrderId] = useState("");

  // NB: the default queryFn joins queryKey segments with `/`, which would
  // hit the detail handler at `/api/admin/pod-intake/<bucket>`. The bucket
  // is a query-string filter, so build the URL explicitly here.
  const listQuery = useQuery<PodIntakeListResponse>({
    queryKey: ["/api/admin/pod-intake", { bucket }],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/pod-intake?bucket=${encodeURIComponent(bucket)}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        throw new Error(`${res.status}: ${(await res.text()) || res.statusText}`);
      }
      return res.json();
    },
  });

  const settingsQuery = useQuery<{ settings: PodIntakeSettings }>({
    queryKey: ["/api/admin/pod-intake/settings"],
  });

  const mailboxesQuery = useQuery<MonitoredMailbox[]>({
    queryKey: ["/api/internal/admin/monitored-mailboxes"],
    select: (data: any) => (Array.isArray(data) ? data : data?.mailboxes ?? []),
  });

  const detailRow =
    listQuery.data?.rows.find((r) => r.id === openRowId) ?? null;

  const linkMutation = useMutation({
    mutationFn: async (vars: { id: string; orderId: string }) =>
      apiRequest("POST", `/api/admin/pod-intake/${vars.id}/link`, {
        orderId: vars.orderId,
      }),
    onSuccess: () => {
      toast({ title: "Linked", description: "Order ID linked to row." });
      setLinkOrderId("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pod-intake"] });
    },
    onError: (err: Error) => {
      toast({ title: "Link failed", description: err.message, variant: "destructive" });
    },
  });

  const reforwardMutation = useMutation({
    mutationFn: async (id: string) =>
      apiRequest("POST", `/api/admin/pod-intake/${id}/reforward`, {}),
    onSuccess: () => {
      toast({ title: "Re-forward attempted", description: "Check the row status." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pod-intake"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Re-forward failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const settingsMutation = useMutation({
    mutationFn: async (patch: Partial<PodIntakeSettings>) =>
      apiRequest("PATCH", `/api/admin/pod-intake/settings`, patch),
    onSuccess: () => {
      toast({ title: "Settings saved" });
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/pod-intake/settings"],
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Save failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const settings = settingsQuery.data?.settings;
  const [draftSettings, setDraftSettings] = useState<Partial<PodIntakeSettings>>({});
  const merged: Partial<PodIntakeSettings> = {
    enabled: draftSettings.enabled ?? settings?.enabled ?? false,
    monitoredMailboxId:
      draftSettings.monitoredMailboxId ?? settings?.monitoredMailboxId ?? null,
    teamFallbackEmail:
      draftSettings.teamFallbackEmail ?? settings?.teamFallbackEmail ?? "",
    useAiFallback:
      draftSettings.useAiFallback ?? settings?.useAiFallback ?? true,
  };

  return (
    <div className="container mx-auto p-6 space-y-6" data-testid="page-admin-pod-intake">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Mail className="h-6 w-6" />
          POD Intake
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Auto-classify, match, and forward proof-of-delivery emails arriving at the AR mailbox.
        </p>
      </div>

      {/* ── Settings card ──────────────────────────────────────────── */}
      <Card data-testid="card-pod-intake-settings">
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>
            Pick the AR mailbox to monitor, set a team fallback for unmatched POD notifications, and toggle the AI classifier fallback.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="enabled-toggle">Enabled</Label>
              <p className="text-xs text-muted-foreground">
                When off, inbound notifications fall through to the standard customer-mailbox path.
              </p>
            </div>
            <Switch
              id="enabled-toggle"
              data-testid="switch-pod-intake-enabled"
              checked={merged.enabled ?? false}
              onCheckedChange={(v) =>
                setDraftSettings((s) => ({ ...s, enabled: v }))
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="ai-toggle">AI fallback classifier</Label>
              <p className="text-xs text-muted-foreground">
                Run GPT-4o-mini when the keyword detector misses.
              </p>
            </div>
            <Switch
              id="ai-toggle"
              data-testid="switch-pod-intake-ai"
              checked={merged.useAiFallback ?? true}
              onCheckedChange={(v) =>
                setDraftSettings((s) => ({ ...s, useAiFallback: v }))
              }
            />
          </div>

          <div className="grid gap-2">
            <Label>Monitored AR mailbox</Label>
            <Select
              value={merged.monitoredMailboxId ?? ""}
              onValueChange={(v) =>
                setDraftSettings((s) => ({
                  ...s,
                  monitoredMailboxId: v || null,
                }))
              }
            >
              <SelectTrigger data-testid="select-pod-intake-mailbox">
                <SelectValue placeholder="Select a monitored mailbox" />
              </SelectTrigger>
              <SelectContent>
                {(mailboxesQuery.data ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.email}
                    {m.displayName ? ` — ${m.displayName}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only mailboxes already enrolled under Monitored Mailboxes are listed.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="team-fallback">Team fallback email</Label>
            <Input
              id="team-fallback"
              data-testid="input-pod-intake-team-fallback"
              type="email"
              placeholder="ops@valuetruckaz.com"
              value={merged.teamFallbackEmail ?? ""}
              onChange={(e) =>
                setDraftSettings((s) => ({
                  ...s,
                  teamFallbackEmail: e.target.value || null,
                }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Cc'd on every forward and notified when an unmatched POD lands in the queue.
            </p>
          </div>

          <div className="flex justify-end">
            <Button
              data-testid="button-save-pod-intake-settings"
              disabled={settingsMutation.isPending}
              onClick={() => settingsMutation.mutate(merged)}
            >
              {settingsMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save settings
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Bucket tabs ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Recent intake</CardTitle>
          <CardDescription>
            Forwarded — sent to dispatcher + account owner. Unmatched — POD detected but no load_fact match. Not a POD — non-POD mail filed for review.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={bucket} onValueChange={(v) => setBucket(v as Bucket)}>
            <TabsList data-testid="tabs-pod-intake-buckets">
              <TabsTrigger value="forwarded" data-testid="tab-forwarded">
                {BUCKET_LABELS.forwarded}
              </TabsTrigger>
              <TabsTrigger value="unmatched" data-testid="tab-unmatched">
                {BUCKET_LABELS.unmatched}
              </TabsTrigger>
              <TabsTrigger value="not_pod" data-testid="tab-not-pod">
                {BUCKET_LABELS.not_pod}
              </TabsTrigger>
            </TabsList>

            {(["forwarded", "unmatched", "not_pod"] as Bucket[]).map((b) => (
              <TabsContent key={b} value={b} className="mt-4">
                {listQuery.isLoading && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                  </div>
                )}
                {!listQuery.isLoading && listQuery.data?.count === 0 && (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    No emails in this bucket.
                  </p>
                )}
                {!listQuery.isLoading && (listQuery.data?.count ?? 0) > 0 && (
                  <div className="space-y-2">
                    {listQuery.data!.rows.map((row) => (
                      <button
                        key={row.id}
                        data-testid={`row-pod-intake-${row.id}`}
                        onClick={() => {
                          setOpenRowId(row.id);
                          setLinkOrderId(row.matchedOrderId ?? "");
                        }}
                        className="w-full text-left border rounded-md p-3 hover:bg-accent transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-sm">
                              <span className="font-medium truncate">
                                {row.subject || "(no subject)"}
                              </span>
                              {row.matchedOrderId && (
                                <Badge variant="outline" className="shrink-0">
                                  {row.matchedOrderId}
                                </Badge>
                              )}
                              <Badge
                                variant={
                                  row.forwardStatus === "forwarded"
                                    ? "default"
                                    : row.forwardStatus === "unmatched"
                                      ? "secondary"
                                      : row.forwardStatus === "failed"
                                        ? "destructive"
                                        : "outline"
                                }
                                className="shrink-0"
                              >
                                {row.forwardStatus}
                              </Badge>
                            </div>
                            <div className="text-xs text-muted-foreground mt-1 truncate">
                              {row.fromName || row.fromEmail || "(unknown)"}
                              {row.fromEmail && row.fromName ? ` <${row.fromEmail}>` : ""}
                              {" · "}
                              {format(new Date(row.receivedAt), "MMM d, yyyy h:mm a")}
                            </div>
                            {row.bodyPreview && (
                              <div className="text-xs text-muted-foreground mt-1 line-clamp-1">
                                {row.bodyPreview}
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground whitespace-nowrap">
                            {row.classifierMethod ?? "—"}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      {/* ── Detail drawer ──────────────────────────────────────────── */}
      <Sheet
        open={openRowId !== null}
        onOpenChange={(o) => !o && setOpenRowId(null)}
      >
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {detailRow && (
            <>
              <SheetHeader>
                <SheetTitle>{detailRow.subject || "(no subject)"}</SheetTitle>
                <SheetDescription>
                  From {detailRow.fromName || detailRow.fromEmail || "(unknown)"} ·{" "}
                  {format(new Date(detailRow.receivedAt), "PPpp")}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 mt-4 text-sm">
                <div>
                  <Label className="text-xs uppercase text-muted-foreground">
                    Classification
                  </Label>
                  <div>
                    <Badge variant="outline">{detailRow.classification}</Badge>
                    {detailRow.classifierMethod && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        via {detailRow.classifierMethod}
                      </span>
                    )}
                  </div>
                </div>

                <div>
                  <Label className="text-xs uppercase text-muted-foreground">
                    Extracted order IDs
                  </Label>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {(detailRow.extractedOrderIds ?? []).length === 0 && (
                      <span className="text-muted-foreground text-xs">none</span>
                    )}
                    {(detailRow.extractedOrderIds ?? []).map((id) => (
                      <Badge key={id} variant="secondary">
                        {id}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div>
                  <Label className="text-xs uppercase text-muted-foreground">
                    Matched load
                  </Label>
                  <div data-testid="text-matched-load">
                    {detailRow.matchedOrderId ? (
                      <span>
                        Order <strong>{detailRow.matchedOrderId}</strong>
                        {detailRow.matchedLoadFactId && (
                          <span className="text-xs text-muted-foreground ml-2">
                            #{detailRow.matchedLoadFactId.slice(0, 8)}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        no match
                      </span>
                    )}
                  </div>
                </div>

                <div>
                  <Label className="text-xs uppercase text-muted-foreground">
                    Forwarded to
                  </Label>
                  <ul className="text-xs space-y-0.5 mt-1">
                    {detailRow.forwardedTo?.dispatcher && (
                      <li>
                        Dispatcher:{" "}
                        <span className="font-mono">
                          {detailRow.forwardedTo.dispatcher.email}
                        </span>
                      </li>
                    )}
                    {detailRow.forwardedTo?.accountOwner && (
                      <li>
                        Account owner:{" "}
                        <span className="font-mono">
                          {detailRow.forwardedTo.accountOwner.email}
                        </span>
                      </li>
                    )}
                    {detailRow.forwardedTo?.teamFallback && (
                      <li>
                        Team fallback:{" "}
                        <span className="font-mono">
                          {detailRow.forwardedTo.teamFallback.email}
                        </span>
                      </li>
                    )}
                    {!detailRow.forwardedTo && (
                      <li className="text-muted-foreground">
                        not forwarded yet
                      </li>
                    )}
                  </ul>
                </div>

                {detailRow.forwardError && (
                  <div>
                    <Label className="text-xs uppercase text-muted-foreground">
                      Forward error
                    </Label>
                    <p className="text-xs text-destructive">
                      {detailRow.forwardError}
                    </p>
                  </div>
                )}

                {detailRow.attachmentMeta &&
                  detailRow.attachmentMeta.length > 0 && (
                    <div>
                      <Label className="text-xs uppercase text-muted-foreground">
                        Attachments
                      </Label>
                      <ul className="text-xs space-y-1 mt-1">
                        {detailRow.attachmentMeta.map((a) => (
                          <li key={a.id} className="flex items-center gap-2">
                            <span className="font-mono">{a.name}</span>
                            <span className="text-muted-foreground">
                              {fmtBytes(a.sizeBytes)}
                            </span>
                            {a.isPodCandidate && (
                              <Badge variant="outline" className="text-[10px]">
                                POD candidate
                              </Badge>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                {detailRow.bodyPreview && (
                  <div>
                    <Label className="text-xs uppercase text-muted-foreground">
                      Preview
                    </Label>
                    <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                      {detailRow.bodyPreview}
                    </p>
                  </div>
                )}

                {/* Manual link form */}
                <div className="border rounded-md p-3 space-y-2">
                  <Label className="text-xs uppercase text-muted-foreground flex items-center gap-1">
                    <Link2 className="h-3 w-3" /> Manual link
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      value={linkOrderId}
                      onChange={(e) => setLinkOrderId(e.target.value)}
                      placeholder="VT123456"
                      data-testid="input-link-order-id"
                    />
                    <Button
                      size="sm"
                      data-testid="button-link-order-id"
                      disabled={
                        !linkOrderId.trim() || linkMutation.isPending
                      }
                      onClick={() =>
                        linkMutation.mutate({
                          id: detailRow.id,
                          orderId: linkOrderId.trim(),
                        })
                      }
                    >
                      {linkMutation.isPending && (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      )}
                      Link
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Stamps the row with the supplied order ID. Hit re-forward next to send the email.
                  </p>
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="button-reforward"
                    disabled={
                      !detailRow.matchedOrderId || reforwardMutation.isPending
                    }
                    onClick={() => reforwardMutation.mutate(detailRow.id)}
                  >
                    {reforwardMutation.isPending ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 h-3 w-3" />
                    )}
                    Re-forward
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
