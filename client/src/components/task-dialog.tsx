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
import type { Company, Task, User } from "@shared/schema";

type SafeUser = Omit<User, "password">;

interface TaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId?: string;
  editingTask?: Task;
}

export function TaskDialog({ open, onOpenChange, companyId, editingTask }: TaskDialogProps) {
  const { user } = useAuth();
  const { toast } = useToast();

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [status, setStatus] = useState("open");
  const [selectedCompanyId, setSelectedCompanyId] = useState("");

  const { data: teamMembers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
  });

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
    enabled: !companyId,
  });

  useEffect(() => {
    if (open) {
      if (editingTask) {
        setTitle(editingTask.title);
        setNotes(editingTask.notes || "");
        setDueDate(editingTask.dueDate || "");
        setAssignedTo(editingTask.assignedTo);
        setStatus(editingTask.status);
        setSelectedCompanyId(editingTask.companyId || "");
      } else {
        setTitle("");
        setNotes("");
        setDueDate("");
        setAssignedTo(user?.id || "");
        setStatus("open");
        setSelectedCompanyId(companyId || "");
      }
    }
  }, [open, editingTask, companyId, user?.id]);

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/tasks", {
        title,
        notes: notes || null,
        status,
        dueDate: dueDate || null,
        assignedTo,
        companyId: selectedCompanyId && selectedCompanyId !== "none" ? selectedCompanyId : null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: ["/api/tasks/company", selectedCompanyId] });
      }
      toast({ title: "Task created" });
      onOpenChange(false);
    },
    onError: () => toast({ title: "Failed to create task", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/tasks/${editingTask!.id}`, {
        title,
        notes: notes || null,
        dueDate: dueDate || null,
        status,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      if (editingTask?.companyId) {
        queryClient.invalidateQueries({ queryKey: ["/api/tasks/company", editingTask.companyId] });
      }
      toast({ title: "Task updated" });
      onOpenChange(false);
    },
    onError: () => toast({ title: "Failed to update task", variant: "destructive" }),
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (editingTask) {
      updateMutation.mutate();
    } else {
      createMutation.mutate();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle data-testid="text-task-dialog-title">
            {editingTask ? "Edit Task" : "New Task"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Call JBS Foods about Q3 rates"
              required
              data-testid="input-task-title"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-notes">Notes</Label>
            <Textarea
              id="task-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Additional details..."
              rows={3}
              data-testid="input-task-notes"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="task-due">Due Date</Label>
              <Input
                id="task-due"
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                data-testid="input-task-due-date"
              />
            </div>

            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger data-testid="select-task-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {!editingTask && (
            <div className="space-y-2">
              <Label>Assign To</Label>
              <Select value={assignedTo} onValueChange={setAssignedTo}>
                <SelectTrigger data-testid="select-task-assignee">
                  <SelectValue placeholder="Select person" />
                </SelectTrigger>
                <SelectContent>
                  {teamMembers.map(u => (
                    <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {!companyId && !editingTask && (
            <div className="space-y-2">
              <Label>Link to Account (optional)</Label>
              <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
                <SelectTrigger data-testid="select-task-company">
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

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-task-cancel">
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !title.trim() || (!editingTask && !assignedTo)} data-testid="button-task-save">
              {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {editingTask ? "Save Changes" : "Create Task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
