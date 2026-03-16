import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useAuth } from "@/hooks/use-auth";
import { GlobalSearch } from "@/components/global-search";
import { NotificationBell } from "@/components/notification-bell";
import { Loader2 } from "lucide-react";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import CompanyDetail from "@/pages/company-detail";
import RfpAwards from "@/pages/rfp-awards";
import ResearchTasks from "@/pages/research-tasks";
import Customers from "@/pages/customers";
import LoginPage from "@/pages/login";
import AdminUsers from "@/pages/admin-users";
import RepCustomers from "@/pages/rep-customers";
import Financials from "@/pages/financials";
import HistoricalData from "@/pages/historical-data";
import TopOpportunities from "@/pages/top-opportunities";
import OneOnOnePage from "@/pages/one-on-one";
import TasksPage from "@/pages/tasks";
import TeamPerformancePage from "@/pages/team-performance";
import GoalsPage from "@/pages/goals";
import PtoPassoffPage from "@/pages/pto-passoff";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/customers" component={Customers} />
      <Route path="/companies/:id" component={CompanyDetail} />
      <Route path="/rfp-awards" component={RfpAwards} />
      <Route path="/research-tasks" component={ResearchTasks} />
      <Route path="/admin/users" component={AdminUsers} />
      <Route path="/reps/:userId" component={RepCustomers} />
      <Route path="/financials" component={Financials} />
      <Route path="/historical-data" component={HistoricalData} />
      <Route path="/top-opportunities" component={TopOpportunities} />
      <Route path="/one-on-one" component={OneOnOnePage} />
      <Route path="/tasks" component={TasksPage} />
      <Route path="/team-performance" component={TeamPerformancePage} />
      <Route path="/goals" component={GoalsPage} />
      <Route path="/pto-passoff" component={PtoPassoffPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthenticatedApp() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 overflow-hidden">
          <header className="flex items-center gap-2 p-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <div className="flex-1 flex items-center justify-center overflow-hidden px-4">
              <p className="hidden md:flex items-center gap-0 text-xs italic text-muted-foreground/70 whitespace-nowrap select-none tracking-wide">
                {[
                  "Service exceptionally",
                  "Move fast",
                  "Build relationships",
                  "Hunt opportunities",
                  "Grow relentlessly",
                ].map((phrase, i) => (
                  <span key={i} className="flex items-center gap-0">
                    {i > 0 && <span className="mx-2.5 text-muted-foreground/30 not-italic font-light">·</span>}
                    <span className="hover:text-foreground transition-colors duration-200">{phrase}</span>
                  </span>
                ))}
              </p>
            </div>
            <GlobalSearch />
            <NotificationBell />
          </header>
          <main className="flex-1 overflow-auto">
            <Router />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthenticatedApp />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
