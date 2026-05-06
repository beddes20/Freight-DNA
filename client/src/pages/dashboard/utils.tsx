import { Calendar, CheckCircle2, PlayCircle, Circle } from "lucide-react";

export function dueDateBadge(dueDate: string | null) {
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + "T00:00:00");
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);

  let color = "bg-muted text-muted-foreground";
  if (diffDays < 0) color = "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  else if (diffDays === 0) color = "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";

  const label = diffDays < 0 ? `${Math.abs(diffDays)}d overdue` : diffDays === 0 ? "Today" : `${diffDays}d`;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md font-medium ${color}`}>
      <Calendar className="h-3 w-3" />
      {label}
    </span>
  );
}

export const statusIcon = (status: string) => {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === "in_progress") return <PlayCircle className="h-4 w-4 text-blue-500" />;
  return <Circle className="h-4 w-4 text-muted-foreground" />;
};

export const nextStatus = (s: string) => s === "open" ? "in_progress" : s === "in_progress" ? "completed" : "open";
