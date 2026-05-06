/**
 * Legacy in-bubble action cards: log_touchpoint, create_task, complete_task,
 * mark_meaningful, approve_freight_opportunity. The newer draft_email and
 * open_filtered_queue cards live in `extra-action-cards.tsx`; this component
 * dispatches to those when appropriate so the message renderer only has to
 * mount one `<ActionCard />`.
 */
import { useState } from "react";
import {
  Check, AlertTriangle, ClipboardList, CheckCircle2, Star, Phone, Mail, MessageSquareText, MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DraftEmailCard, OpenQueueCard } from "./extra-action-cards";
import type { ChatMessage } from "./types";

function TouchpointTypeIcon({ type }: { type: string }) {
  if (type === "call") return <Phone className="h-4 w-4 text-blue-500" />;
  if (type === "email") return <Mail className="h-4 w-4 text-purple-500" />;
  if (type === "text") return <MessageSquareText className="h-4 w-4 text-green-500" />;
  if (type === "site_visit") return <MapPin className="h-4 w-4 text-orange-500" />;
  return <Phone className="h-4 w-4 text-blue-500" />;
}

const fieldCls = "w-full mt-0.5 text-xs rounded border bg-background px-2 py-1 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-indigo-400";

export function ActionCard({
  action,
  onConfirm,
  onDismiss,
}: {
  action: NonNullable<ChatMessage["action"]>;
  onConfirm: (editedArgs: Record<string, string>) => void;
  onDismiss: () => void;
}) {
  const [editedArgs, setEditedArgs] = useState<Record<string, string>>({ ...action.args });
  const set = (key: string, val: string) => setEditedArgs((prev) => ({ ...prev, [key]: val }));

  if (action.tool === "draft_email") {
    return <DraftEmailCard args={action.args} confirmed={action.confirmed} failed={action.failed} onConfirm={onConfirm} onDismiss={onDismiss} />;
  }
  if (action.tool === "open_filtered_queue") {
    return <OpenQueueCard args={action.args} confirmed={action.confirmed} failed={action.failed} onConfirm={onConfirm} onDismiss={onDismiss} />;
  }

  if (action.confirmed) {
    const labels: Record<string, string> = {
      log_touchpoint: "Touchpoint logged!",
      create_task: "Task created!",
      complete_task: "Task marked complete!",
      mark_meaningful: "Marked as meaningful!",
      approve_freight_opportunity: "Freight opportunity approved!",
    };
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
        <Check className="h-3.5 w-3.5" />
        {labels[action.tool] ?? "Done!"}
      </div>
    );
  }
  if (action.failed) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-red-500">
        <AlertTriangle className="h-3.5 w-3.5" />
        Action failed. Try again from the main app.
      </div>
    );
  }

  if (action.tool === "log_touchpoint") {
    return (
      <div className="mt-2 border border-blue-200 dark:border-blue-800 rounded-xl bg-blue-50 dark:bg-blue-950/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300">
          <TouchpointTypeIcon type={editedArgs.type} />
          Log Touchpoint
        </div>
        <div className="space-y-1.5">
          <div>
            <label className="text-xs text-muted-foreground">Type</label>
            <select value={editedArgs.type || "call"} onChange={(e) => set("type", e.target.value)} className={fieldCls}>
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="text">Text</option>
              <option value="site_visit">Site Visit</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Account</label>
            <input type="text" value={editedArgs.company_name || ""} onChange={(e) => set("company_name", e.target.value)} placeholder="Company name" className={fieldCls} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Contact (optional)</label>
            <input type="text" value={editedArgs.contact_name || ""} onChange={(e) => set("contact_name", e.target.value)} placeholder="Contact name" className={fieldCls} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Note</label>
            <textarea value={editedArgs.note || ""} onChange={(e) => set("note", e.target.value)} placeholder="Add a note..." rows={2} className={`${fieldCls} resize-none`} />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="h-7 text-xs bg-blue-600 hover:bg-blue-700 text-white flex-1" onClick={() => onConfirm(editedArgs)} data-testid="action-confirm-touchpoint">
            <Check className="h-3.5 w-3.5 mr-1" /> Log it
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
        </div>
      </div>
    );
  }

  if (action.tool === "create_task") {
    return (
      <div className="mt-2 border border-amber-200 dark:border-amber-800 rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
          <ClipboardList className="h-4 w-4" />
          Create Task
        </div>
        <div className="space-y-1.5">
          <div>
            <label className="text-xs text-muted-foreground">Task</label>
            <input type="text" value={editedArgs.title || ""} onChange={(e) => set("title", e.target.value)} placeholder="Task title" className={fieldCls} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Due date (optional)</label>
            <input type="date" value={editedArgs.due_date || ""} onChange={(e) => set("due_date", e.target.value)} className={fieldCls} />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white flex-1" onClick={() => onConfirm(editedArgs)} data-testid="action-confirm-task">
            <Check className="h-3.5 w-3.5 mr-1" /> Create it
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
        </div>
      </div>
    );
  }

  if (action.tool === "complete_task") {
    return (
      <div className="mt-2 border border-green-200 dark:border-green-800 rounded-xl bg-green-50 dark:bg-green-950/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-green-700 dark:text-green-300">
          <CheckCircle2 className="h-4 w-4" />
          Complete Task
        </div>
        <p className="text-xs font-medium text-foreground">{editedArgs.task_title}</p>
        {editedArgs.due_date && (
          <p className="text-xs text-muted-foreground">Due: {new Date(editedArgs.due_date + "T12:00:00").toLocaleDateString()}</p>
        )}
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white flex-1" onClick={() => onConfirm(editedArgs)} data-testid="action-confirm-complete-task">
            <Check className="h-3.5 w-3.5 mr-1" /> Mark complete
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
        </div>
      </div>
    );
  }

  if (action.tool === "approve_freight_opportunity") {
    return (
      <div className="mt-2 border border-emerald-200 dark:border-emerald-800 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" />
          Approve Freight Opportunity
        </div>
        <div className="text-xs space-y-0.5">
          <p><span className="text-muted-foreground">Account:</span> <span className="font-medium">{editedArgs.company_name}</span></p>
          <p><span className="text-muted-foreground">Lane:</span> {editedArgs.origin} → {editedArgs.destination}</p>
          {editedArgs.pickup && <p><span className="text-muted-foreground">Pickup:</span> {editedArgs.pickup}</p>}
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white flex-1" onClick={() => onConfirm(editedArgs)} data-testid="action-confirm-approve-freight">
            <Check className="h-3.5 w-3.5 mr-1" /> Approve
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
        </div>
      </div>
    );
  }

  if (action.tool === "mark_meaningful") {
    const typeLabel = ({ call: "Call", email: "Email", text: "Text", site_visit: "Site Visit" } as Record<string, string>)[editedArgs.type] ?? editedArgs.type;
    return (
      <div className="mt-2 border border-amber-200 dark:border-amber-800 rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
          <Star className="h-4 w-4" />
          Mark Meaningful
        </div>
        <div className="text-xs space-y-0.5">
          <p><span className="text-muted-foreground">Account:</span> <span className="font-medium">{editedArgs.company_name}</span></p>
          {editedArgs.type && <p><span className="text-muted-foreground">Type:</span> {typeLabel}</p>}
          {editedArgs.date && <p><span className="text-muted-foreground">Date:</span> {editedArgs.date}</p>}
          {editedArgs.note && <p className="text-muted-foreground italic">"{editedArgs.note.slice(0, 80)}{editedArgs.note.length > 80 ? "..." : ""}"</p>}
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white flex-1" onClick={() => onConfirm(editedArgs)} data-testid="action-confirm-meaningful">
            <Star className="h-3.5 w-3.5 mr-1" /> Mark meaningful
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
        </div>
      </div>
    );
  }

  return null;
}
