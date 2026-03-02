import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  TruckIcon,
  Search,
  BarChart3,
  MapPin,
  FileText,
  Building2,
  CheckCircle,
  Clock,
  UserPlus,
  AlertTriangle,
} from "lucide-react";
import { ResearchLaneDialog } from "@/components/research-lane-dialog";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Company } from "@shared/schema";

interface ResearchTask {
  rfpId: string;
  rfpTitle: string;
  companyId: string;
  laneIndex: number;
  lane: string;
  origin: string;
  destination: string;
  originState: string;
  destinationState: string;
  volume: number;
  rate: string;
  status: string;
  contactId: string | null;
}

export default function ResearchTasks() {
  const [, navigate] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "open" | "completed">("all");
  const { toast } = useToast();
  const [researchDialogOpen, setResearchDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<ResearchTask | null>(null);

  const markResearchedMutation = useMutation({
    mutationFn: async (task: ResearchTask) => {
      await apiRequest("PATCH", `/api/rfps/${task.rfpId}/lanes/${task.laneIndex}/status`, {
        status: "researched",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/research-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      toast({
        title: "Lane marked as researched",
        className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800",
      });
    },
  });

  const { data: tasks, isLoading } = useQuery<ResearchTask[]>({
    queryKey: ["/api/research-tasks"],
  });

  const { data: companies } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const companiesMap = new Map(companies?.map((c) => [c.id, c]) || []);

  const filteredTasks = tasks?.filter((task) => {
    const matchesSearch =
      task.lane.toLowerCase().includes(searchQuery.toLowerCase()) ||
      task.rfpTitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
      companiesMap.get(task.companyId)?.name.toLowerCase().includes(searchQuery.toLowerCase());

    if (filter === "open") return matchesSearch && (task.status === "open");
    if (filter === "completed") return matchesSearch && (task.status !== "open");
    return matchesSearch;
  }) || [];

  const openCount = tasks?.filter(t => t.status === "open").length || 0;
  const completedCount = tasks?.filter(t => t.status !== "open").length || 0;

  const handleAssign = (task: ResearchTask) => {
    setSelectedTask(task);
    setResearchDialogOpen(true);
  };

  const getStatusBadge = (status: string) => {
    if (status === "open") {
      return <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400"><Clock className="h-3 w-3 mr-1" />Open</Badge>;
    }
    if (status === "contact_added") {
      return <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400"><UserPlus className="h-3 w-3 mr-1" />Contact Added</Badge>;
    }
    if (status === "researched") {
      return <Badge className="bg-green-500/10 text-green-600 dark:text-green-400"><CheckCircle className="h-3 w-3 mr-1" />Researched</Badge>;
    }
    return <Badge variant="secondary">{status}</Badge>;
  };

  return (
    <div className="flex flex-col gap-4 sm:gap-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold" data-testid="text-research-tasks-title">
          My Research Tasks
        </h1>
        <p className="text-muted-foreground">
          Track and complete lane research assignments across all RFPs
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Tasks</p>
                <p className="text-2xl font-bold">{tasks?.length || 0}</p>
              </div>
              <TruckIcon className="h-8 w-8 text-muted-foreground/50" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Open</p>
                <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{openCount}</p>
              </div>
              <AlertTriangle className="h-8 w-8 text-amber-500/50" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Completed</p>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">{completedCount}</p>
              </div>
              <CheckCircle className="h-8 w-8 text-green-500/50" />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-tasks"
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant={filter === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter("all")}
            data-testid="button-filter-all"
          >
            All ({tasks?.length || 0})
          </Button>
          <Button
            variant={filter === "open" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter("open")}
            data-testid="button-filter-open"
          >
            Open ({openCount})
          </Button>
          <Button
            variant={filter === "completed" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter("completed")}
            data-testid="button-filter-completed"
          >
            Completed ({completedCount})
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-6 w-3/4 mb-3" />
                <Skeleton className="h-4 w-1/2 mb-2" />
                <Skeleton className="h-4 w-1/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredTasks.length > 0 ? (
        <div className="space-y-2">
          {filteredTasks.map((task, i) => {
            const company = companiesMap.get(task.companyId);
            return (
              <Card
                key={`${task.rfpId}-${task.laneIndex}`}
                className={`transition-colors ${
                  task.status !== "open" ? "bg-muted/30" : "hover-elevate"
                }`}
                data-testid={`card-task-${i}`}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4 min-w-0 flex-1">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-full flex-shrink-0 ${
                        task.status === "open"
                          ? "bg-amber-100 dark:bg-amber-900/50"
                          : "bg-green-100 dark:bg-green-900/50"
                      }`}>
                        <TruckIcon className={`h-5 w-5 ${
                          task.status === "open"
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-green-600 dark:text-green-400"
                        }`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-sm">{task.lane}</p>
                          {getStatusBadge(task.status)}
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
                          <span className="flex items-center gap-1">
                            <BarChart3 className="h-3 w-3" />
                            {task.volume.toLocaleString()} shipments/yr
                          </span>
                          {company && (
                            <span className="flex items-center gap-1">
                              <Building2 className="h-3 w-3" />
                              {company.name}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <FileText className="h-3 w-3" />
                            {task.rfpTitle}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {task.status === "open" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-400"
                          onClick={() => handleAssign(task)}
                          data-testid={`button-assign-task-${i}`}
                        >
                          <UserPlus className="h-4 w-4 mr-1" />
                          Assign to AM
                        </Button>
                      ) : task.status === "contact_added" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-green-300 text-green-700 hover:bg-green-100 dark:border-green-700 dark:text-green-400"
                          onClick={() => markResearchedMutation.mutate(task)}
                          disabled={markResearchedMutation.isPending}
                          data-testid={`button-mark-complete-${i}`}
                        >
                          <CheckCircle className="h-4 w-4 mr-1" />
                          Mark Complete
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => navigate(`/companies/${task.companyId}`)}
                          data-testid={`button-view-company-${i}`}
                        >
                          View Contact
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <TruckIcon className="h-12 w-12 text-muted-foreground/50 mb-3" />
            <h3 className="font-medium mb-1">
              {searchQuery || filter !== "all" ? "No matching tasks" : "No research tasks yet"}
            </h3>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              {searchQuery || filter !== "all"
                ? "Try adjusting your search or filter"
                : "Upload an RFP with lane data to generate research tasks for high-volume lanes"}
            </p>
          </CardContent>
        </Card>
      )}

      {selectedTask && (
        <ResearchLaneDialog
          open={researchDialogOpen}
          onOpenChange={setResearchDialogOpen}
          lane={selectedTask}
          laneIndex={selectedTask.laneIndex}
          rfpId={selectedTask.rfpId}
          companyId={selectedTask.companyId}
        />
      )}
    </div>
  );
}
