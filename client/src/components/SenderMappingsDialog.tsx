/**
 * Customer Quotes #3 — admin dialog for the learned sender→customer
 * mappings. The list is read-only here; admins can DELETE rows that
 * mis-route a sender (e.g. a domain that started routing to the wrong
 * customer because of an early miscategorization). Rows are recreated
 * automatically the next time a rep manually moves a quote out of the
 * Unknown bucket.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mailbox, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface Mapping {
  id: string;
  senderDomain: string | null;
  senderEmail: string | null;
  customerId: string;
  customerName: string;
  source: string;
  sampleCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}
interface ListResponse { mappings: Mapping[] }

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const dt = Date.now() - t;
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return `${Math.round(dt / 86_400_000)}d ago`;
}

export function SenderMappingsDialog({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const listQuery = useQuery<ListResponse>({
    queryKey: ["/api/customer-quotes/sender-mappings"],
    queryFn: async () => {
      const res = await fetch("/api/customer-quotes/sender-mappings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load sender mappings");
      return await res.json() as ListResponse;
    },
    enabled: open && canEdit,
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/customer-quotes/sender-mappings/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/sender-mappings"] });
      void qc.invalidateQueries({ queryKey: ["/api/customer-quotes/sender-mappings"] });
      toast({ title: "Mapping deleted" });
    },
    onError: (err: Error) => toast({
      title: "Delete failed",
      description: err.message,
      variant: "destructive",
    }),
  });

  if (!canEdit) return null;
  const mappings = listQuery.data?.mappings ?? [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="border-border hover:bg-muted"
          data-testid="button-sender-mappings"
        >
          <Mailbox className="h-3.5 w-3.5 mr-1.5" /> Sender mappings
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Learned sender mappings</DialogTitle>
          <DialogDescription>
            When a rep moves a quote out of the "Unknown — needs review" bucket,
            the sender's domain (or full email, for free-mail providers) is
            recorded here. Future inbound quotes from the same sender skip the
            Unknown bucket and route directly to the learned customer. Delete a
            mapping if a sender should no longer auto-classify — it will be
            re-learned the next time a rep makes the same correction.
          </DialogDescription>
        </DialogHeader>

        <div className="border border-border rounded-md max-h-[480px] overflow-y-auto" data-testid="list-sender-mappings">
          {listQuery.isLoading && (
            <div className="p-6 text-sm text-muted-foreground" data-testid="text-mappings-loading">
              Loading…
            </div>
          )}
          {!listQuery.isLoading && mappings.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground" data-testid="text-mappings-empty">
              No learned mappings yet. Reassign a Needs-Review quote to a real
              customer and the sender will be remembered here.
            </div>
          )}
          {!listQuery.isLoading && mappings.length > 0 && (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Sender</th>
                  <th className="text-left font-medium px-3 py-2">Customer</th>
                  <th className="text-right font-medium px-3 py-2">Hits</th>
                  <th className="text-left font-medium px-3 py-2">Last used</th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => {
                  const sender = m.senderEmail ?? (m.senderDomain ? `@${m.senderDomain}` : "—");
                  const isDomain = !m.senderEmail && !!m.senderDomain;
                  return (
                    <tr
                      key={m.id}
                      className="border-t border-border hover:bg-muted/30"
                      data-testid={`row-mapping-${m.id}`}
                    >
                      <td className="px-3 py-2 font-mono text-xs" data-testid={`text-mapping-sender-${m.id}`}>
                        {sender}
                        {isDomain && (
                          <span className="ml-2 text-[10px] uppercase text-muted-foreground">domain</span>
                        )}
                      </td>
                      <td className="px-3 py-2" data-testid={`text-mapping-customer-${m.id}`}>
                        {m.customerName}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums" data-testid={`text-mapping-hits-${m.id}`}>
                        {m.sampleCount}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground text-xs" data-testid={`text-mapping-last-${m.id}`}>
                        {formatRelative(m.lastUsedAt)}
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-600"
                          onClick={() => deleteMut.mutate(m.id)}
                          disabled={deleteMut.isPending}
                          data-testid={`button-delete-mapping-${m.id}`}
                          aria-label="Delete mapping"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} data-testid="button-mappings-close">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
