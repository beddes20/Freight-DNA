import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Users, Building2, Trophy, CheckCircle2, AlertTriangle, Clock, TrendingUp, BarChart3
} from "lucide-react";

interface RepPerf {
  userId: string;
  name: string;
  role: string;
  managerId?: string;
  openTasks: number;
  overdueTasks: number;
  completedTasks: number;
  companyCount: number;
  rfpCount: number;
}

function StatPill({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="flex flex-col items-center px-3 py-2 rounded-lg bg-muted/50 min-w-[64px]">
      <span className={`text-lg font-bold ${color}`}>{value}</span>
      <span className="text-[10px] text-muted-foreground leading-tight text-center">{label}</span>
    </div>
  );
}

function RepCard({ rep }: { rep: RepPerf }) {
  const [, navigate] = useLocation();
  const initials = rep.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
  const colors = ["bg-blue-500", "bg-green-500", "bg-purple-500", "bg-amber-500", "bg-red-500", "bg-cyan-500", "bg-pink-500", "bg-indigo-500"];
  const color = colors[rep.name.charCodeAt(0) % colors.length];
  const totalTasks = rep.openTasks + rep.completedTasks;
  const completionPct = totalTasks > 0 ? Math.round((rep.completedTasks / totalTasks) * 100) : 0;

  return (
    <Card
      className="hover:shadow-md transition-shadow cursor-pointer"
      data-testid={`card-rep-${rep.userId}`}
      onClick={() => navigate(`/reps/${rep.userId}`)}
    >
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start gap-3 mb-4">
          <div className={`h-10 w-10 rounded-full shrink-0 flex items-center justify-center text-white text-sm font-semibold ${color}`}>
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate" data-testid={`text-rep-name-${rep.userId}`}>{rep.name}</p>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 mt-0.5 capitalize">
              {rep.role.replace(/_/g, " ")}
            </Badge>
          </div>
          {rep.overdueTasks > 0 && (
            <div className="shrink-0 flex items-center gap-1 text-red-600 text-xs font-medium" data-testid={`badge-overdue-${rep.userId}`}>
              <AlertTriangle className="h-3.5 w-3.5" />
              {rep.overdueTasks} overdue
            </div>
          )}
        </div>

        <div className="grid grid-cols-4 gap-2 mb-4">
          <StatPill value={rep.openTasks} label="Open" color={rep.openTasks > 5 ? "text-amber-600" : "text-foreground"} />
          <StatPill value={rep.overdueTasks} label="Overdue" color={rep.overdueTasks > 0 ? "text-red-600" : "text-foreground"} />
          <StatPill value={rep.companyCount} label="Accounts" color="text-blue-600" />
          <StatPill value={rep.rfpCount} label="RFPs" color="text-purple-600" />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Task completion</span>
            <span className="font-medium text-foreground">{completionPct}%</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${completionPct >= 80 ? "bg-green-500" : completionPct >= 50 ? "bg-amber-500" : "bg-red-500"}`}
              style={{ width: `${completionPct}%` }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function TeamPerformancePage() {
  const { user } = useAuth();

  const { data: reps = [], isLoading } = useQuery<RepPerf[]>({
    queryKey: ["/api/team/performance"],
  });

  if (!user || user.role === "account_manager") {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>Access denied</p>
      </div>
    );
  }

  const ams = reps.filter(r => r.role === "account_manager");
  const nams = reps.filter(r => r.role === "national_account_manager" || r.role === "director");

  const totalOpenTasks = reps.reduce((sum, r) => sum + r.openTasks, 0);
  const totalOverdue = reps.reduce((sum, r) => sum + r.overdueTasks, 0);
  const totalAccounts = reps.reduce((sum, r) => sum + r.companyCount, 0);
  const totalRfps = reps.reduce((sum, r) => sum + r.rfpCount, 0);

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-lg bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
          <BarChart3 className="h-5 w-5 text-blue-600 dark:text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold" data-testid="text-page-title">Team Performance</h1>
          <p className="text-sm text-muted-foreground">KPIs across your team — tasks, accounts, and RFPs</p>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Open Tasks", value: totalOpenTasks, icon: <Clock className="h-5 w-5 text-amber-500" />, color: "text-amber-600" },
              { label: "Overdue", value: totalOverdue, icon: <AlertTriangle className="h-5 w-5 text-red-500" />, color: "text-red-600" },
              { label: "Total Accounts", value: totalAccounts, icon: <Building2 className="h-5 w-5 text-blue-500" />, color: "text-blue-600" },
              { label: "Active RFPs", value: totalRfps, icon: <Trophy className="h-5 w-5 text-purple-500" />, color: "text-purple-600" },
            ].map(stat => (
              <Card key={stat.label}>
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-center gap-2 mb-1">
                    {stat.icon}
                    <span className="text-xs text-muted-foreground">{stat.label}</span>
                  </div>
                  <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {nams.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Directors & NAMs</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {nams.map(rep => <RepCard key={rep.userId} rep={rep} />)}
              </div>
            </div>
          )}

          {ams.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Account Managers</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {ams.map(rep => <RepCard key={rep.userId} rep={rep} />)}
              </div>
            </div>
          )}

          {reps.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="text-base font-medium">No team members found</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
