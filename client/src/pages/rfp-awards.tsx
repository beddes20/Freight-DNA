import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Trophy,
  Plus,
  Search,
  FileText,
  Calendar,
  DollarSign,
  Building2,
  CheckCircle,
  Clock,
  XCircle,
  Pencil,
  Trash2,
  Send,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RfpDialog } from "@/components/rfp-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Rfp, Company } from "@shared/schema";

const statusConfig = {
  pending: { label: "Pending", icon: Clock, color: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" },
  submitted: { label: "Submitted", icon: Send, color: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  won: { label: "Won", icon: CheckCircle, color: "bg-green-500/10 text-green-600 dark:text-green-400" },
  lost: { label: "Lost", icon: XCircle, color: "bg-red-500/10 text-red-600 dark:text-red-400" },
};

interface RfpCardProps {
  rfp: Rfp;
  company?: Company;
  onEdit: (rfp: Rfp) => void;
  onDelete: (rfp: Rfp) => void;
}

function RfpCard({ rfp, company, onEdit, onDelete }: RfpCardProps) {
  const status = statusConfig[rfp.status as keyof typeof statusConfig] || statusConfig.pending;
  const StatusIcon = status.icon;

  return (
    <Card className="hover-elevate" data-testid={`card-rfp-${rfp.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-medium truncate">{rfp.title}</h3>
            {company && (
              <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                <Building2 className="h-3 w-3" />
                <span className="truncate">{company.name}</span>
              </div>
            )}
          </div>
          <Badge className={status.color}>
            <StatusIcon className="h-3 w-3 mr-1" />
            {status.label}
          </Badge>
        </div>

        <div className="space-y-2 text-sm">
          {rfp.value && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <DollarSign className="h-3.5 w-3.5" />
              <span>${Number(rfp.value).toLocaleString()}</span>
            </div>
          )}
          {rfp.dueDate && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Calendar className="h-3.5 w-3.5" />
              <span>Due: {new Date(rfp.dueDate).toLocaleDateString()}</span>
            </div>
          )}
          {rfp.notes && (
            <p className="text-muted-foreground line-clamp-2">{rfp.notes}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-1 mt-3 pt-3 border-t">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onEdit(rfp)}
            data-testid={`button-edit-rfp-${rfp.id}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onDelete(rfp)}
            data-testid={`button-delete-rfp-${rfp.id}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function RfpAwards() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRfp, setEditingRfp] = useState<Rfp | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Rfp | null>(null);

  const { data: rfps, isLoading: rfpsLoading } = useQuery<Rfp[]>({
    queryKey: ["/api/rfps"],
  });

  const { data: companies } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/rfps/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      toast({ title: "RFP deleted successfully" });
      setDeleteTarget(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error deleting RFP", description: error.message, variant: "destructive" });
    },
  });

  const companiesMap = new Map(companies?.map((c) => [c.id, c]) || []);

  const activeRfps = rfps?.filter((rfp) =>
    (rfp.status === "pending" || rfp.status === "submitted") &&
    (rfp.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    rfp.status.toLowerCase().includes(searchQuery.toLowerCase()) ||
    companiesMap.get(rfp.companyId)?.name.toLowerCase().includes(searchQuery.toLowerCase()))
  ) || [];

  const awards = rfps?.filter((rfp) =>
    (rfp.status === "won" || rfp.status === "lost") &&
    (rfp.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    rfp.status.toLowerCase().includes(searchQuery.toLowerCase()) ||
    companiesMap.get(rfp.companyId)?.name.toLowerCase().includes(searchQuery.toLowerCase()))
  ) || [];

  const handleEdit = (rfp: Rfp) => {
    setEditingRfp(rfp);
    setDialogOpen(true);
  };

  const handleAdd = () => {
    setEditingRfp(undefined);
    setDialogOpen(true);
  };

  const stats = {
    total: rfps?.length || 0,
    pending: rfps?.filter((r) => r.status === "pending").length || 0,
    submitted: rfps?.filter((r) => r.status === "submitted").length || 0,
    won: rfps?.filter((r) => r.status === "won").length || 0,
    lost: rfps?.filter((r) => r.status === "lost").length || 0,
    totalValue: rfps?.reduce((acc, r) => acc + (r.value ? parseFloat(r.value) : 0), 0) || 0,
    wonValue: rfps?.filter((r) => r.status === "won").reduce((acc, r) => acc + (r.value ? parseFloat(r.value) : 0), 0) || 0,
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-rfp-awards-title">
            RFP & Awards
          </h1>
          <p className="text-muted-foreground">
            Track your RFP submissions and awarded business
          </p>
        </div>
        <Button onClick={handleAdd} data-testid="button-add-rfp">
          <Plus className="h-4 w-4 mr-2" />
          Add RFP
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active RFPs</p>
                <p className="text-2xl font-bold">{stats.pending + stats.submitted}</p>
              </div>
              <FileText className="h-8 w-8 text-muted-foreground/50" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Win Rate</p>
                <p className="text-2xl font-bold">
                  {stats.won + stats.lost > 0 
                    ? `${Math.round((stats.won / (stats.won + stats.lost)) * 100)}%`
                    : "N/A"}
                </p>
              </div>
              <Trophy className="h-8 w-8 text-muted-foreground/50" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Pipeline</p>
                <p className="text-2xl font-bold">${(stats.totalValue / 1000000).toFixed(1)}M</p>
              </div>
              <DollarSign className="h-8 w-8 text-muted-foreground/50" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Won Value</p>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                  ${(stats.wonValue / 1000000).toFixed(1)}M
                </p>
              </div>
              <CheckCircle className="h-8 w-8 text-green-500/50" />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search RFPs and awards..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search-rfps"
        />
      </div>

      {rfpsLoading ? (
        <div className="space-y-8">
          <div>
            <Skeleton className="h-8 w-32 mb-4" />
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[1, 2].map((i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="h-6 w-3/4 mb-3" />
                    <Skeleton className="h-4 w-1/2 mb-2" />
                    <Skeleton className="h-4 w-1/3" />
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          <section>
            <div className="flex items-center gap-2 mb-4">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold" data-testid="text-rfp-section-title">
                RFPs
              </h2>
              <Badge variant="secondary" className="ml-1">
                {activeRfps.length}
              </Badge>
            </div>

            {activeRfps.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {activeRfps.map((rfp) => (
                  <RfpCard
                    key={rfp.id}
                    rfp={rfp}
                    company={companiesMap.get(rfp.companyId)}
                    onEdit={handleEdit}
                    onDelete={setDeleteTarget}
                  />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-8">
                  <FileText className="h-10 w-10 text-muted-foreground/50 mb-3" />
                  <h3 className="font-medium mb-1">No active RFPs</h3>
                  <p className="text-sm text-muted-foreground text-center max-w-sm">
                    {searchQuery
                      ? "No RFPs match your search"
                      : "Start by adding your first RFP to track"}
                  </p>
                  {!searchQuery && (
                    <Button onClick={handleAdd} className="mt-3" size="sm" data-testid="button-add-first-rfp">
                      <Plus className="h-4 w-4 mr-2" />
                      Add RFP
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
          </section>

          <section>
            <div className="flex items-center gap-2 mb-4">
              <Trophy className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold" data-testid="text-awards-section-title">
                Awards
              </h2>
              <Badge variant="secondary" className="ml-1">
                {awards.length}
              </Badge>
            </div>

            {awards.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {awards.map((rfp) => (
                  <RfpCard
                    key={rfp.id}
                    rfp={rfp}
                    company={companiesMap.get(rfp.companyId)}
                    onEdit={handleEdit}
                    onDelete={setDeleteTarget}
                  />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-8">
                  <Trophy className="h-10 w-10 text-muted-foreground/50 mb-3" />
                  <h3 className="font-medium mb-1">No awards yet</h3>
                  <p className="text-sm text-muted-foreground text-center max-w-sm">
                    {searchQuery
                      ? "No awards match your search"
                      : "Won or lost RFPs will appear here"}
                  </p>
                </CardContent>
              </Card>
            )}
          </section>
        </div>
      )}

      <RfpDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingRfp(undefined);
        }}
        rfp={editingRfp}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete RFP</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteTarget?.title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-rfp">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-rfp"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
