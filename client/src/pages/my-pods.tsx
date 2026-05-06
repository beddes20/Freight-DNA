import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Loader2, MailCheck, FileDown, ExternalLink } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface AttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  isPodCandidate: boolean;
}

interface MyPodRow {
  id: string;
  receivedAt: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  bodyPreview: string | null;
  bodyText: string | null;
  matchedOrderId: string | null;
  matchedLoadFactId: string | null;
  matchedCompanyId: string | null;
  matchedCustomerName: string | null;
  matchedFreightOpportunityId: string | null;
  forwardStatus: string;
  deliveryMethod: "email" | "in_app" | null;
  hasAttachments: boolean;
  attachmentMeta: AttachmentMeta[] | null;
  dispatcherUserId: string | null;
  accountOwnerUserId: string | null;
  unread: boolean;
  unreadNotificationIds: string[];
  everNotified: boolean;
}

interface MyPodsResponse {
  count: number;
  rows: MyPodRow[];
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MyPodsPage() {
  const { toast } = useToast();
  const [openRowId, setOpenRowId] = useState<string | null>(null);

  const listQuery = useQuery<MyPodsResponse>({
    queryKey: ["/api/my-pods"],
    refetchInterval: 60_000,
  });

  const detailRow =
    listQuery.data?.rows.find((r) => r.id === openRowId) ?? null;

  const seenMutation = useMutation({
    mutationFn: async (id: string) =>
      apiRequest("POST", `/api/my-pods/${id}/seen`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/my-pods"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
  });

  // Mark a POD's notifications read as soon as the rep opens its preview.
  // Idempotent server-side; safe to call on every open.
  useEffect(() => {
    if (!detailRow || !detailRow.unread) return;
    seenMutation.mutate(detailRow.id);
    // We intentionally trigger only on the row opening, not on mutation churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailRow?.id]);

  return (
    <div className="container mx-auto p-6 space-y-6" data-testid="page-my-pods">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MailCheck className="h-6 w-6" />
          My PODs
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Proofs of delivery received for loads where you are the dispatcher
          or the account owner. New PODs show an "unread" badge until you
          open them.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent PODs</CardTitle>
          <CardDescription>
            Click a row to preview the email, see the matched load, and
            download attachments.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {listQuery.isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {!listQuery.isLoading && (listQuery.data?.count ?? 0) === 0 && (
            <p
              className="text-sm text-muted-foreground py-12 text-center"
              data-testid="text-my-pods-empty"
            >
              No PODs yet. New proofs of delivery will appear here as they
              arrive.
            </p>
          )}
          {!listQuery.isLoading && (listQuery.data?.count ?? 0) > 0 && (
            <div className="space-y-2">
              {listQuery.data!.rows.map((row) => (
                <button
                  key={row.id}
                  data-testid={`row-my-pod-${row.id}`}
                  onClick={() => setOpenRowId(row.id)}
                  className="w-full text-left border rounded-md p-3 hover:bg-accent transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm flex-wrap">
                        <span className="font-medium truncate">
                          {row.subject || "(no subject)"}
                        </span>
                        {row.matchedOrderId && (
                          <Badge
                            variant="outline"
                            className="shrink-0"
                            data-testid={`badge-order-${row.id}`}
                          >
                            {row.matchedOrderId}
                          </Badge>
                        )}
                        {row.matchedCustomerName && (
                          <Badge
                            variant="secondary"
                            className="shrink-0 text-[10px]"
                            data-testid={`badge-customer-${row.id}`}
                          >
                            {row.matchedCustomerName}
                          </Badge>
                        )}
                        {row.unread && (
                          <Badge
                            className="shrink-0 bg-emerald-600 hover:bg-emerald-600"
                            data-testid={`badge-unread-${row.id}`}
                          >
                            New
                          </Badge>
                        )}
                        {row.deliveryMethod && (
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[10px]"
                          >
                            {row.deliveryMethod === "email"
                              ? "via email"
                              : "in-app"}
                          </Badge>
                        )}
                        {row.hasAttachments && (
                          <Badge
                            variant="secondary"
                            className="shrink-0 text-[10px]"
                          >
                            {(row.attachmentMeta ?? []).length} file
                            {(row.attachmentMeta ?? []).length === 1 ? "" : "s"}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 truncate">
                        {row.fromName || row.fromEmail || "(unknown)"}
                        {row.fromEmail && row.fromName
                          ? ` <${row.fromEmail}>`
                          : ""}
                        {" · "}
                        {format(new Date(row.receivedAt), "MMM d, yyyy h:mm a")}
                      </div>
                      {row.bodyPreview && (
                        <div className="text-xs text-muted-foreground mt-1 line-clamp-1">
                          {row.bodyPreview}
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet
        open={openRowId !== null}
        onOpenChange={(o) => !o && setOpenRowId(null)}
      >
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {detailRow && (
            <>
              <SheetHeader>
                <SheetTitle data-testid="text-pod-subject">
                  {detailRow.subject || "(no subject)"}
                </SheetTitle>
                <SheetDescription>
                  From {detailRow.fromName || detailRow.fromEmail || "(unknown)"} ·{" "}
                  {format(new Date(detailRow.receivedAt), "PPpp")}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 mt-4 text-sm">
                <div>
                  <Label className="text-xs uppercase text-muted-foreground">
                    Matched load
                  </Label>
                  <div data-testid="text-pod-matched-load">
                    {detailRow.matchedOrderId ? (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span>
                          Order <strong>{detailRow.matchedOrderId}</strong>
                          {detailRow.matchedCustomerName && (
                            <>
                              {" "}
                              <span
                                className="text-muted-foreground"
                                data-testid="text-pod-customer"
                              >
                                · {detailRow.matchedCustomerName}
                              </span>
                            </>
                          )}
                        </span>
                        {detailRow.matchedFreightOpportunityId && (
                          <Link
                            href={`/available-freight/${detailRow.matchedFreightOpportunityId}`}
                          >
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              data-testid="link-pod-load"
                            >
                              <ExternalLink className="h-3 w-3 mr-1" /> Open load
                            </Button>
                          </Link>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        no match yet — admins will manually link this POD
                      </span>
                    )}
                  </div>
                </div>

                {detailRow.attachmentMeta &&
                  detailRow.attachmentMeta.length > 0 && (
                    <div>
                      <Label className="text-xs uppercase text-muted-foreground">
                        Attachments
                      </Label>
                      <ul className="space-y-1 mt-1">
                        {detailRow.attachmentMeta.map((a) => (
                          <li
                            key={a.id}
                            className="flex items-center justify-between gap-2 border rounded-md px-2 py-1.5"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-mono truncate">
                                {a.name}
                              </div>
                              <div className="text-[10px] text-muted-foreground flex items-center gap-2">
                                <span>{fmtBytes(a.sizeBytes)}</span>
                                {a.isPodCandidate && (
                                  <Badge variant="outline" className="text-[10px]">
                                    POD
                                  </Badge>
                                )}
                              </div>
                            </div>
                            <a
                              href={`/api/pods/${detailRow.id}/attachments/${a.id}/download`}
                              data-testid={`button-download-${a.id}`}
                              onClick={(e) => {
                                // Let the browser navigate to the download URL;
                                // the server returns Content-Disposition: attachment.
                                // No client-side fetch needed — keeps streaming simple.
                                e.stopPropagation();
                              }}
                            >
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2"
                                onClick={() =>
                                  toast({
                                    title: "Downloading",
                                    description: a.name,
                                  })
                                }
                              >
                                <FileDown className="h-3.5 w-3.5" />
                              </Button>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                {detailRow.bodyText ? (
                  <div>
                    <Label className="text-xs uppercase text-muted-foreground">
                      Email body
                    </Label>
                    <div className="text-xs whitespace-pre-wrap rounded-md border p-2 max-h-72 overflow-y-auto bg-muted/30">
                      {detailRow.bodyText}
                    </div>
                  </div>
                ) : (
                  detailRow.bodyPreview && (
                    <div>
                      <Label className="text-xs uppercase text-muted-foreground">
                        Preview
                      </Label>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                        {detailRow.bodyPreview}
                      </p>
                    </div>
                  )
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
