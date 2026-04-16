import { Switch, Route, useLocation } from "wouter";
import { queryClient, apiRequest } from "./lib/queryClient";
import { QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useAuth } from "@/hooks/use-auth";
import { GlobalSearch } from "@/components/global-search";
import { NotificationBell } from "@/components/notification-bell";
import { NotificationToasts } from "@/components/notification-toasts";
import { CrmChatbot } from "@/components/crm-chatbot";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Loader2, UserX, Clock } from "lucide-react";
import React, { useEffect, useCallback, useState } from "react";
import { useInactivityTimeout } from "@/hooks/use-inactivity-timeout";
import { ClerkProvider, useClerk } from "@clerk/clerk-react";
import { dark } from "@clerk/themes";
import { GlobalLogTouchButton, GlobalLogTouchDialog } from "@/components/global-log-touch-button";
import { LogTouchFab, useKeyboardShortcut } from "@/components/log-touch-fab";
import { LogTouchProvider } from "@/context/log-touch-context";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import { TourProvider } from "@/components/app-tour";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import CompanyDetail from "@/pages/company-detail";
import RfpAwards from "@/pages/rfp-awards";
import RfpLaneSearch from "@/pages/rfp-lane-search";
import CarrierLaneSearch from "@/pages/carrier-lane-search";
import CarrierHub from "@/pages/carrier-hub";
import ResearchTasks from "@/pages/research-tasks";
import Customers from "@/pages/customers";
import LoginPage from "@/pages/login";
import ResetPasswordPage from "@/pages/reset-password";
import LandingPage from "@/pages/landing";
import PrivacyPage from "@/pages/privacy";
import TermsPage from "@/pages/terms";
import AdminUsers from "@/pages/admin-users";
import AdminCarriers from "@/pages/admin-carriers";
import RepCustomers from "@/pages/rep-customers";
import Financials from "@/pages/financials";
import HistoricalData from "@/pages/historical-data";
import TopOpportunities from "@/pages/top-opportunities";
import OneOnOnePage from "@/pages/one-on-one";
import TasksPage from "@/pages/tasks";
import TeamPerformancePage from "@/pages/team-performance";
import TeamPerformanceDetailPage from "@/pages/team-performance-detail";
import GoalsPage from "@/pages/goals";
import PtoPassoffPage from "@/pages/pto-passoff";
import TrainingPage from "@/pages/training";
import ToolsPage from "@/pages/tools";
import RepReportPage from "@/pages/rep-report";
import RepReportsRosterPage from "@/pages/rep-reports-roster";
import NotificationsPage from "@/pages/notifications";
import CoordinatorsCornerPage from "@/pages/coordinators-corner";
import FeedbackInboxPage from "@/pages/feedback-inbox";
import ProspectsPage from "@/pages/prospects";
import CheckoutSuccessPage from "@/pages/checkout-success";
import TouchpointHistoryPage from "@/pages/touchpoint-history";
import RfpCalendarPage from "@/pages/rfp-calendar";
import RepScorecardPage from "@/pages/rep-scorecard";
import LmCheckinHistoryPage from "@/pages/lm-checkin-history";
import { PortletErrorBoundary } from "@/components/portlet-error-boundary";
import LaneWorkQueuePage from "@/pages/lane-work-queue";
import MyProcurementPage from "@/pages/my-procurement";
import IntelPage from "@/pages/intel";
import ConversationsPage from "@/pages/conversations";
import ContactSuggestionsPage from "@/pages/contact-suggestions";
import EmailIntelligencePage from "@/pages/email-intelligence";
import ProvenTacticsPage from "@/pages/proven-tactics";
import AIIntelligencePage from "@/pages/ai-intelligence";
import AdminMonitoredMailboxesPage from "@/pages/admin-monitored-mailboxes";
import ProfilePage from "@/pages/profile";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Caught error:", error);
    console.error("[ErrorBoundary] Component stack:", info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen gap-4 text-center px-4">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="text-muted-foreground">An unexpected error occurred. Please reload the page to continue.</p>
          <Button onClick={() => window.location.reload()} data-testid="button-error-reload">
            Reload page
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

function LogTouchFabWithShortcut() {
  useKeyboardShortcut();
  return <LogTouchFab />;
}

function PipelineAnalyticsRedirect() {
  const [, nav] = useLocation();
  useEffect(() => { nav("/prospects?tab=analytics"); }, []);
  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/customers" component={Customers} />
      <Route path="/companies/:id" component={CompanyDetail} />
      <Route path="/rfp-awards" component={RfpAwards} />
      <Route path="/rfp-lane-search" component={RfpLaneSearch} />
      <Route path="/carrier-lane-search" component={CarrierLaneSearch} />
      <Route path="/carrier-hub" component={CarrierHub} />
      <Route path="/research-tasks" component={ResearchTasks} />
      <Route path="/admin/users" component={AdminUsers} />
      <Route path="/admin/carriers" component={AdminCarriers} />
      <Route path="/admin/monitored-mailboxes" component={AdminMonitoredMailboxesPage} />
      <Route path="/reps/:userId" component={RepCustomers} />
      <Route path="/financials" component={Financials} />
      <Route path="/historical-data" component={HistoricalData} />
      <Route path="/top-opportunities" component={TopOpportunities} />
      <Route path="/one-on-one" component={OneOnOnePage} />
      <Route path="/tasks" component={TasksPage} />
      <Route path="/team-performance" component={TeamPerformancePage} />
      <Route path="/team-performance/detail/:metric" component={TeamPerformanceDetailPage} />
      <Route path="/goals" component={GoalsPage} />
      <Route path="/pto-passoff" component={PtoPassoffPage} />
      <Route path="/training" component={TrainingPage} />
      <Route path="/tools" component={ToolsPage} />
      <Route path="/reports" component={RepReportsRosterPage} />
      <Route path="/report/me" component={RepReportPage} />
      <Route path="/report/:userId" component={RepReportPage} />
      <Route path="/notifications" component={NotificationsPage} />
      <Route path="/coordinators-corner" component={CoordinatorsCornerPage} />
      <Route path="/feedback-inbox" component={FeedbackInboxPage} />
      <Route path="/prospects" component={ProspectsPage} />
      <Route path="/pipeline-analytics" component={PipelineAnalyticsRedirect} />
      <Route path="/touchpoint-history" component={TouchpointHistoryPage} />
      <Route path="/rfp-calendar" component={RfpCalendarPage} />
      <Route path="/rep-scorecard" component={RepScorecardPage} />
      <Route path="/lm-checkin-history">
        <PortletErrorBoundary label="LM Check-In Log">
          <LmCheckinHistoryPage />
        </PortletErrorBoundary>
      </Route>
      <Route path="/lanes/work-queue" component={LaneWorkQueuePage} />
      <Route path="/my-procurement" component={MyProcurementPage} />
      <Route path="/intel" component={IntelPage} />
      <Route path="/conversations" component={ConversationsPage} />
      <Route path="/contact-suggestions" component={ContactSuggestionsPage} />
      <Route path="/email-intelligence" component={EmailIntelligencePage} />
      <Route path="/proven-tactics" component={ProvenTacticsPage} />
      <Route path="/ai-intelligence" component={AIIntelligencePage} />
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/terms" component={TermsPage} />
      <Route path="/profile" component={ProfilePage} />
      <Route component={NotFound} />
    </Switch>
  );
}

const DEV_BYPASS = import.meta.env.DEV && import.meta.env.VITE_DEV_AUTH_BYPASS === "true";

function AuthenticatedAppInner() {
  const { user, isLoading } = useAuth();
  const { signOut } = useClerk();

  const handleInactivityLogout = useCallback(async () => {
    try {
      await signOut();
    } catch {}
    queryClient.clear();
    window.location.href = "/";
  }, [signOut]);

  return <AuthenticatedAppContent user={user} isLoading={isLoading} handleInactivityLogout={handleInactivityLogout} />;
}

function AuthenticatedAppBypass() {
  const { user, isLoading } = useAuth();

  const handleInactivityLogout = useCallback(async () => {
    queryClient.clear();
    window.location.href = "/";
  }, []);

  return <AuthenticatedAppContent user={user} isLoading={isLoading} handleInactivityLogout={handleInactivityLogout} />;
}

function AuthenticatedApp() {
  if (DEV_BYPASS) return <AuthenticatedAppBypass />;
  return <AuthenticatedAppInner />;
}

function useGlobalKeyboardShortcuts() {
  const [, navigate] = useLocation();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isEditable =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        (e.target as HTMLElement).isContentEditable;

      if (e.key === "/" && !isEditable && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>("[data-testid='input-global-search']");
        if (input) { input.focus(); input.select(); }
        return;
      }

      // ⌘K / Ctrl+K — focus global search (same as "/")
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>("[data-testid='input-global-search']");
        if (input) { input.focus(); input.select(); }
        return;
      }

      if (e.shiftKey && !isEditable && !e.metaKey && !e.ctrlKey) {
        if (e.key === "A") { e.preventDefault(); navigate("/customers"); return; }
        if (e.key === "D") { e.preventDefault(); navigate("/"); return; }
        if (e.key === "L") { e.preventDefault(); navigate("/lanes/work-queue"); return; }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [navigate]);
}

function AuthenticatedAppContent({ user, isLoading, handleInactivityLogout }: {
  user: ReturnType<typeof useAuth>["user"];
  isLoading: boolean;
  handleInactivityLogout: () => void;
}) {
  useGlobalKeyboardShortcuts();

  const { warningVisible, secondsLeft, staySignedIn } = useInactivityTimeout(
    user ? handleInactivityLogout : () => {}
  );

  const minutesLeft = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const countdownLabel = minutesLeft > 0
    ? `${minutesLeft}:${String(secs).padStart(2, "0")}`
    : `${secs}s`;

  useEffect(() => {
    if (!user) return;
    const prefetch = (key: string) =>
      queryClient.prefetchQuery({ queryKey: [key] });
    prefetch("/api/companies");
    prefetch("/api/contacts");
    prefetch("/api/users");
    prefetch("/api/tasks");
    prefetch("/api/notifications");
    prefetch("/api/feed-posts");
  }, [user?.id]);

  const stopImpersonatingMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/stop-impersonating");
      return res.json();
    },
    onSuccess: () => {
      queryClient.clear();
      window.location.href = "/admin/users";
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return (
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route path="/reset-password" component={ResetPasswordPage} />
        <Route path="/checkout/success" component={CheckoutSuccessPage} />
        <Route path="/privacy" component={PrivacyPage} />
        <Route path="/terms" component={TermsPage} />
        <Route component={LandingPage} />
      </Switch>
    );
  }

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <>
      <Dialog open={warningVisible && !!user} onOpenChange={(open) => { if (!open) staySignedIn(); }}>
        <DialogContent className="sm:max-w-sm" data-testid="dialog-inactivity-warning">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-amber-500" />
              Are you still there?
            </DialogTitle>
            <DialogDescription>
              You've been inactive for a while. For your security, you'll be automatically signed out in:
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center py-4">
            <span className="text-4xl font-bold tabular-nums text-amber-500" data-testid="text-inactivity-countdown">
              {countdownLabel}
            </span>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={handleInactivityLogout} data-testid="button-inactivity-sign-out">
              Sign out now
            </Button>
            <Button onClick={staySignedIn} data-testid="button-inactivity-stay">
              Stay signed in
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SidebarProvider style={style as React.CSSProperties}>
        <div className="flex h-screen w-full">
          <AppSidebar />
          <div className="flex flex-col flex-1 overflow-hidden">
            {user?.isImpersonating && (
              <div className="flex items-center justify-between px-4 py-2 bg-amber-400 text-amber-950 text-sm font-medium shrink-0" data-testid="banner-impersonation">
                <div className="flex items-center gap-2">
                  <UserX className="w-4 h-4" />
                  <span>You are viewing as <strong>{user.name}</strong> ({user.role?.replace(/_/g, " ")})</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs border-amber-700 text-amber-900 hover:bg-amber-500"
                  onClick={() => stopImpersonatingMutation.mutate()}
                  disabled={stopImpersonatingMutation.isPending}
                  data-testid="button-stop-impersonating"
                >
                  {stopImpersonatingMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Return to my account"}
                </Button>
              </div>
            )}
            <header className="flex items-center gap-2 p-2 border-b" style={{ backgroundColor: "hsl(var(--sidebar))", borderColor: "hsl(var(--sidebar-border))" }}>
              <SidebarTrigger className="hidden md:flex text-white/80 hover:text-white hover:bg-white/10" data-testid="button-sidebar-toggle" />
              <div className="flex-1 flex items-center justify-center overflow-hidden px-4">
                <p className="hidden md:flex items-center gap-0 text-xs font-semibold uppercase tracking-widest whitespace-nowrap select-none" style={{ color: "#ffc333" }}>
                  {[
                    "Service exceptionally",
                    "Move fast",
                    "Build relationships",
                    "Hunt opportunities",
                    "Grow relentlessly",
                  ].map((phrase, i) => (
                    <span key={i} className="flex items-center gap-0">
                      {i > 0 && <span className="mx-2.5 not-italic font-light" style={{ color: "#555" }}>·</span>}
                      <span className="hover:text-white transition-colors duration-200">{phrase}</span>
                    </span>
                  ))}
                </p>
              </div>
              <span data-tour="tour-log-touch"><GlobalLogTouchButton /></span>
              <span data-tour="tour-global-search"><GlobalSearch navBar /></span>
              <NotificationBell navBar />
            </header>
            <main className="flex-1 overflow-auto pb-14 md:pb-0">
              <Router />
            </main>
          </div>
        </div>
        <MobileBottomNav />
      </SidebarProvider>
      <GlobalLogTouchDialog />
      <LogTouchFabWithShortcut />
      <CrmChatbot />
      <NotificationToasts />
    </>
  );
}

function AppCore() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <LogTouchProvider>
            <TourProvider>
              <AuthenticatedApp />
            </TourProvider>
            <Toaster />
          </LogTouchProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

function App() {
  const [clerkKey, setClerkKey] = useState<string | null | false>(DEV_BYPASS ? false : null);

  useEffect(() => {
    if (DEV_BYPASS) return;
    fetch("/api/config/public")
      .then(r => r.json())
      .then(cfg => setClerkKey(cfg.clerkPublishableKey || null))
      .catch(() => setClerkKey(null));
  }, []);

  if (DEV_BYPASS) {
    return <AppCore />;
  }

  if (!clerkKey) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ClerkProvider
      publishableKey={clerkKey as string}
      appearance={{ baseTheme: dark }}
    >
      <AppCore />
    </ClerkProvider>
  );
}

export default App;
