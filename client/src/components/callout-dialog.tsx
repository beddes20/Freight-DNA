import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
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
import { Loader2 } from "lucide-react";
import type { Company } from "@shared/schema";

interface CalloutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId?: string;
  parentId?: string;
  parentTitle?: string;
}

export function CalloutDialog({ open, onOpenChange, companyId, parentId, parentTitle }: CalloutDialogProps) {
  const { toast } = useToast();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tag, setTag] = useState("");
  const [selectedCompanyId, setSelectedCompanyId] = useState("");

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
    enabled: !companyId && !parentId,
  });

  useEffect(() => {
    if (open) {
      setTitle("");
      setBody("");
      setTag("");
      setSelectedCompanyId(companyId || "");
    }
  }, [open, companyId]);

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

          <div className="space-y-2">
            <Label htmlFor="callout-body">Notes</Label>
            <Textarea
              id="callout-body"
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Additional details..."
              rows={3}
              data-testid="input-callout-body"
            />
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
