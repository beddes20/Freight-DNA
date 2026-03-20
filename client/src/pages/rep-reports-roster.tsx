import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { FileBarChart2, ChevronRight } from "lucide-react";
import type { User } from "@shared/schema";

type SafeUser = Omit<User, "password">;

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  director: "Director",
  national_account_manager: "National Account Manager",
  account_manager: "Account Manager",
  sales: "Sales",
  sales_director: "Sales Director",
  logistics_manager: "Logistics Manager",
  logistics_coordinator: "Logistics Coordinator",
};

const REP_ROLES = ["account_manager", "national_account_manager", "sales", "logistics_manager", "sales_director", "director"];

export default function RepReportsRosterPage() {
  const { user: currentUser } = useAuth();
  const [, navigate] = useLocation();

  const { data: users = [], isLoading } = useQuery<SafeUser[]>({ queryKey: ["/api/users"] });

  const isAdminOrDirector = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "sales_director";
  const isNAM = currentUser?.role === "national_account_manager";

  const reps = users.filter(u => {
    if (!REP_ROLES.includes(u.role)) return false;
    if (isAdminOrDirector) return true;
    if (isNAM) return u.managerId === currentUser?.id || u.id === currentUser?.id;
    return u.id === currentUser?.id;
  }).sort((a, b) => a.name.localeCompare(b.name));

  function getInitials(name: string) {
    return name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-reports-title">
          <FileBarChart2 className="w-6 h-6 text-blue-600" />
          Report Cards
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          {isAdminOrDirector ? "View progress reports for all reps" : "View your team's progress reports"}
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : reps.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          No reps found.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {reps.map(rep => {
            const initials = getInitials(rep.name);
            const roleLabel = ROLE_LABELS[rep.role] || rep.role;
            const isSelf = rep.id === currentUser?.id;
            return (
              <button
                key={rep.id}
                onClick={() => navigate(`/report/${rep.id}`)}
                className="group flex items-center gap-4 p-4 rounded-xl border bg-card hover:border-blue-400 hover:shadow-sm transition-all text-left w-full"
                data-testid={`card-rep-${rep.id}`}
              >
                <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center text-white font-bold text-sm shrink-0">
                  {initials}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">
                    {rep.name}
                    {isSelf && <span className="ml-2 text-xs text-blue-500 font-normal">You</span>}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{roleLabel}</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-blue-500 transition-colors shrink-0" />
              </button>
            );
          })}
        </div>
      )}

      <div className="pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/report/${currentUser?.id}`)}
          data-testid="button-my-report"
          className="gap-1.5"
        >
          <FileBarChart2 className="w-4 h-4" />
          View My Own Report Card
        </Button>
      </div>
    </div>
  );
}
