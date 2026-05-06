import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, Calendar, Trophy, ListTodo, AlertCircle } from "lucide-react";
import type { Rfp } from "@shared/schema";

interface TaskItem {
  id: string;
  title: string;
  dueDate: string | null;
  status: string;
  companyName?: string;
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function RfpCalendarPage() {
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());

  const { data: rfps = [] } = useQuery<Rfp[]>({ queryKey: ["/api/rfps"] });
  const { data: tasks = [] } = useQuery<TaskItem[]>({ queryKey: ["/api/tasks"] });

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };
  const goToToday = () => { setViewYear(now.getFullYear()); setViewMonth(now.getMonth()); };

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDow = getFirstDayOfWeek(viewYear, viewMonth);
  const todayStr = now.toISOString().split("T")[0];
  const monthStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}`;

  // Events by day number
  const rfpsByDay = useMemo(() => {
    const map = new Map<number, Rfp[]>();
    for (const rfp of rfps) {
      if (!rfp.dueDate || !rfp.dueDate.startsWith(monthStr)) continue;
      const day = parseInt(rfp.dueDate.split("-")[2], 10);
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(rfp);
    }
    return map;
  }, [rfps, monthStr]);

  const tasksByDay = useMemo(() => {
    const map = new Map<number, TaskItem[]>();
    for (const task of tasks) {
      if (!task.dueDate || !task.dueDate.startsWith(monthStr) || task.status === "completed") continue;
      const day = parseInt(task.dueDate.split("-")[2], 10);
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(task);
    }
    return map;
  }, [tasks, monthStr]);

  // Upcoming RFPs across all months (next 60 days)
  const upcomingRfps = useMemo(() => {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() + 60);
    const cutoffStr = cutoff.toISOString().split("T")[0];
    return rfps
      .filter(r => r.dueDate && r.dueDate >= todayStr && r.dueDate <= cutoffStr && r.status === "pending")
      .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
  }, [rfps, todayStr]);

  // Build calendar grid
  const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length < totalCells) cells.push(null);

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="max-w-6xl mx-auto w-full px-6 py-6 space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Calendar className="h-6 w-6 text-primary" />
              RFP & Task Calendar
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">Track RFP deadlines and task due dates in one view</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={goToToday} data-testid="button-cal-today">Today</Button>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" onClick={prevMonth} data-testid="button-cal-prev">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-semibold w-36 text-center" data-testid="text-cal-month">
                {MONTH_NAMES[viewMonth]} {viewYear}
              </span>
              <Button variant="ghost" size="icon" onClick={nextMonth} data-testid="button-cal-next">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Calendar Grid */}
          <div className="lg:col-span-2">
            <Card>
              <CardContent className="p-4">
                {/* Legend */}
                <div className="flex items-center gap-4 mb-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500 inline-block" />RFP Deadline</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-blue-500 inline-block" />Task Due</span>
                </div>

                {/* Day headers */}
                <div className="grid grid-cols-7 mb-1">
                  {DAY_NAMES.map(d => (
                    <div key={d} className="text-center text-xs font-medium text-muted-foreground py-1">{d}</div>
                  ))}
                </div>

                {/* Calendar cells */}
                <div className="grid grid-cols-7 gap-px bg-border rounded-md overflow-hidden">
                  {cells.map((day, idx) => {
                    const dayStr = day ? `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}` : "";
                    const isToday = dayStr === todayStr;
                    const dayRfps = day ? (rfpsByDay.get(day) ?? []) : [];
                    const dayTasks = day ? (tasksByDay.get(day) ?? []) : [];
                    const hasEvents = dayRfps.length > 0 || dayTasks.length > 0;

                    return (
                      <div
                        key={idx}
                        className={`bg-background min-h-[80px] p-1.5 ${!day ? "opacity-30" : ""} ${isToday ? "ring-2 ring-inset ring-primary/40" : ""}`}
                        data-testid={day ? `cal-day-${dayStr}` : undefined}
                      >
                        {day && (
                          <>
                            <div className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full ${isToday ? "bg-primary text-primary-foreground" : "text-foreground"}`}>
                              {day}
                            </div>
                            <div className="space-y-0.5">
                              {dayRfps.slice(0, 2).map(rfp => (
                                <div key={rfp.id} className="text-[10px] leading-tight px-1 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 truncate" title={rfp.title ?? ""} data-testid={`cal-rfp-${rfp.id}`}>
                                  <Trophy className="h-2.5 w-2.5 inline mr-0.5" />
                                  {rfp.title || "RFP"}
                                </div>
                              ))}
                              {dayTasks.slice(0, 2).map(task => (
                                <div key={task.id} className="text-[10px] leading-tight px-1 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 truncate" title={task.title} data-testid={`cal-task-${task.id}`}>
                                  <ListTodo className="h-2.5 w-2.5 inline mr-0.5" />
                                  {task.title}
                                </div>
                              ))}
                              {(dayRfps.length + dayTasks.length) > 4 && (
                                <div className="text-[10px] text-muted-foreground px-1">+{(dayRfps.length + dayTasks.length) - 4} more</div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Upcoming RFPs sidebar */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-red-500" />
                  Upcoming RFP Deadlines
                  {upcomingRfps.length > 0 && <Badge variant="secondary" className="ml-1 font-normal">{upcomingRfps.length}</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {upcomingRfps.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No upcoming RFP deadlines in the next 60 days.</p>
                ) : (
                  <div className="space-y-2">
                    {upcomingRfps.map(rfp => {
                      const due = new Date(rfp.dueDate + "T00:00:00");
                      const diff = Math.round((due.getTime() - now.getTime()) / 86400000);
                      const urgency = diff <= 3 ? "text-red-600 dark:text-red-400" : diff <= 7 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
                      return (
                        <div key={rfp.id} className="flex items-start gap-2 p-2 rounded-md border border-border hover:bg-muted/50 transition-colors" data-testid={`upcoming-rfp-${rfp.id}`}>
                          <Trophy className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">{rfp.title || "Untitled RFP"}</p>
                            <p className={`text-xs ${urgency} font-medium`}>
                              {diff === 0 ? "Due today!" : diff === 1 ? "Due tomorrow" : `${diff} days left`}
                              {" · "}{rfp.dueDate}
                            </p>
                          </div>
                          {rfp.value && (
                            <span className="text-xs text-muted-foreground shrink-0">${Number(rfp.value).toLocaleString()}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Month stats */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">This Month</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-1.5"><Trophy className="h-3.5 w-3.5 text-red-500" />RFP Deadlines</span>
                  <span className="font-medium">{rfpsByDay.size > 0 ? Array.from(rfpsByDay.values()).flat().length : 0}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-1.5"><ListTodo className="h-3.5 w-3.5 text-blue-500" />Tasks Due</span>
                  <span className="font-medium">{tasksByDay.size > 0 ? Array.from(tasksByDay.values()).flat().length : 0}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
