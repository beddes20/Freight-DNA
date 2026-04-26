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
import { useLiveSync } from "@/hooks/useLiveSync";
import { ClerkProvider, useClerk } from "@clerk/clerk-react";
import { dark } from "@clerk/themes";
import { GlobalLogTouchButton, GlobalLogTouchDialog } from "@/components/global-log-touch-button";
import { LaneSwitchboard } from "@/components/lane-switchboard";
import { LogTouchFab, useKeyboardShortcut } from "@/components/log-touch-fab";
import { LogTouchProvider } from "@/context/log-touch-context";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import { TourProvider } from "@/components/app-tour";
import NotFound from "@/pages/not-found";
import AgenticIndexPage from "@/pages/agentic";
import AgentDetailPage from "@/pages/agentic/agent-detail";
import PodsPage from "@/pages/agentic/pods";
import ApprovalsPage from "@/pages/agentic/approvals";
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
import AdminCopilotAnalyticsPage from "@/pages/admin-copilot-analytics";
import AdminCarriers from "@/pages/admin-carriers";
import AdminWebexHealth from "@/pages/admin-webex-health";
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
import LaneInboxPage from "@/pages/lane-inbox";
import TodayQueuePage from "@/pages/today";
import MyProcurementPage from "@/pages/my-procurement";
import ConversationsPage from "@/pages/conversations";
import ContactSuggestionsPage from "@/pages/contact-suggestions";
import EmailIntelligencePage from "@/pages/email-intelligence";
import ProvenTacticsPage from "@/pages/proven-tactics";
import PlaybookPage from "@/pages/playbook";
import CoachingPage from "@/pages/coaching";
import PlaybookAnalyticsPage from "@/pages/playbook-analytics";
import AIIntelligencePage from "@/pages/ai-intelligence";
import ValueIQPage from "@/pages/valueiq";
import AdminMonitoredMailboxesPage from "@/pages/admin-monitored-mailboxes";
import AdminPodIntakePage from "@/pages/admin-pod-intake";
import MyPodsPage from "@/pages/my-pods";
import AdminFreightOutreachTemplatesPage from "@/pages/admin-freight-outreach-templates";
import AdminCarrierIntelligencePage from "@/pages/admin-carrier-intelligence";
import AdminCarrierIntelligenceScoringPage from "@/pages/admin-carrier-intelligence-scoring";
import ProfilePage from "@/pages/profile";
import AiAgentPortal from "@/pages/ai-agent";
import AiCenterPage from "@/pages/ai-center";
import AvailableFreightPage from "@/pages/available-freight";
import AvailableFreightDetailPage from "@/pages/available-freight-detail";
import AdminAvailableFreightImports from "@/pages/admin-available-freight-imports";
import PhoneUsagePage from "@/pages/phone-usage";
import CarrierIntelligenceScorecardPage from "@/pages/carrier-intelligence-scorecard";
import CarrierIntelligenceAvailableLoadsPage from "@/pages/carrier-intelligence-available-loads";
import CarrierIntelligenceLanePricingPage from "@/pages/carrier-intelligence-lane-pricing";
import CarrierIntelligenceSettingsPage from "@/pages/carrier-intelligence-settings";
import AdminSidebarTooltipsPage from "@/pages/admin-sidebar-tooltips";
import CustomerQuotesPage from "@/pages/customer-quotes";
import FreightCapturePage from "@/pages/freight-capture";
import DailyPrioritiesPage from "@/pages/daily-priorities";

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

// Task #639 — landing redirect.
//
// New default for "/" is the Today queue, but each user can opt back to
// the classic dashboard via PATCH /api/users/me/landing-preference. The
// flag rides on the cached /api/auth/me payload so we don't add an extra
// round-trip; the toggle invalidates that key after a write.
//
// The redirect runs only when the path is exactly "/" so that direct
// links to /dashboard always show the dashboard regardless of the pref.
function HomeLandingRouter(): JSX.Element {
  const { user, isLoading } = useAuth();
  const [, navigate] = useLocation();
  // While we don't yet know the user's preference, render the dashboard
  // skeleton (the existing default) so we don't bounce visited reps off a
  // page they didn't ask for. Once the user object resolves and signals a
  // Today preference, we redirect to /today so the URL reflects the page.
  const prefersToday = user?.defaultToTodayQueue === true;
  useEffect(() => {
    if (!isLoading && prefersToday) {
      navigate("/today", { replace: true });
    }
  }, [isLoading, prefersToday, navigate]);
  return <Dashboard />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeLandingRouter} />
      <Route path="/today" component={TodayQueuePage} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/customers" component={Customers} />
      <Route path="/customer-quotes" component={CustomerQuotesPage} />
      <Route path="/freight-capture" component={FreightCapturePage} />
      <Route path="/daily-priorities" component={DailyPrioritiesPage} />
      <Route path="/companies/:id" component={CompanyDetail} />
      <Route path="/rfp-awards" component={RfpAwards} />
      <Route path="/rfp-lane-search" component={RfpLaneSearch} />
      <Route path="/carrier-lane-search" component={CarrierLaneSearch} />
      <Route path="/carrier-hub" component={CarrierHub} />
      <Route path="/research-tasks" component={ResearchTasks} />
      <Route path="/admin/users" component={AdminUsers} />
      <Route path="/admin/sidebar-tooltips" component={AdminSidebarTooltipsPage} />
      <Route path="/admin/copilot-analytics" component={AdminCopilotAnalyticsPage} />
      <Route path="/admin/carriers" component={AdminCarriers} />
      <Route path="/admin/webex-health" component={AdminWebexHealth} />
      <Route path="/admin/monitored-mailboxes" component={AdminMonitoredMailboxesPage} />
      <Route path="/admin/pod-intake" component={AdminPodIntakePage} />
      <Route path="/my-pods" component={MyPodsPage} />
      <Route path="/admin/freight-outreach-templates" component={AdminFreightOutreachTemplatesPage} />
      <Route path="/admin/carrier-intelligence" component={AdminCarrierIntelligencePage} />
      <Route path="/admin/carrier-intelligence/scoring" component={AdminCarrierIntelligenceScoringPage} />
      <Route path="/admin/carrier-intelligence/imports" component={AdminCarrierIntelligencePage} />
      <Route path="/admin/carrier-intelligence/settings" component={CarrierIntelligenceSettingsPage} />
      <Route path="/carrier-intelligence/scorecard" component={CarrierIntelligenceScorecardPage} />
      <Route path="/carrier-intelligence/available-loads" component={CarrierIntelligenceAvailableLoadsPage} />
      <Route path="/carrier-intelligence/lane-pricing" component={CarrierIntelligenceLanePricingPage} />
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
      <Route path="/phone-usage" component={PhoneUsagePage} />
      <Route path="/touchpoint-history" component={TouchpointHistoryPage} />
      <Route path="/rfp-calendar" component={RfpCalendarPage} />
      <Route path="/rep-scorecard" component={RepScorecardPage} />
      <Route path="/lm-checkin-history">
        <PortletErrorBoundary label="LM Check-In Log">
          <LmCheckinHistoryPage />
        </PortletErrorBoundary>
      </Route>
      <Route path="/lanes/work-queue" component={LaneWorkQueuePage} />
      <Route path="/lane-inbox" component={LaneInboxPage} />
      <Route path="/available-freight" component={AvailableFreightPage} />
      <Route path="/available-freight/:id" component={AvailableFreightDetailPage} />
      <Route path="/admin/available-freight/imports" component={AdminAvailableFreightImports} />
      <Route path="/my-procurement" component={MyProcurementPage} />
      <Route path="/intel">{() => { window.location.replace("/valueiq?tab=insights"); return null; }}</Route>
      <Route path="/conversations" component={ConversationsPage} />
      <Route path="/contact-suggestions" component={ContactSuggestionsPage} />
      <Route path="/email-intelligence" component={EmailIntelligencePage} />
      <Route path="/proven-tactics" component={ProvenTacticsPage} />
      <Route path="/playbook" component={PlaybookPage} />
      <Route path="/coaching" component={CoachingPage} />
      <Route path="/playbook/analytics" component={PlaybookAnalyticsPage} />
      <Route path="/valueiq" component={ValueIQPage} />
      <Route path="/ai-intelligence">{() => { window.location.replace("/valueiq?tab=insights"); return null; }}</Route>
      <Route path="/ai-intelligence-legacy" component={AIIntelligencePage} />
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/terms" component={TermsPage} />
      <Route path="/profile" component={ProfilePage} />
      {/* Unified AI Center — single management module for every AI capability. */}
      <Route path="/ai" component={AiCenterPage} />
      <Route path="/ai/agents" component={AiCenterPage} />
      <Route path="/ai/agents/:slug" component={AiCenterPage} />
      <Route path="/ai/approvals" component={AiCenterPage} />
      <Route path="/ai/pods" component={AiCenterPage} />
      <Route path="/ai/adapters" component={AiCenterPage} />
      <Route path="/ai/admin" component={AiCenterPage} />

      {/* Legacy redirects — old standalone pages now live as AI Center tabs. */}
      <Route path="/ai-agent">{() => { window.location.replace("/ai/admin"); return null; }}</Route>
      <Route path="/agents">{() => { window.location.replace("/ai/agents"); return null; }}</Route>
      <Route path="/agents/:slug">{(p: { slug: string }) => { window.location.replace(`/ai/agents/${p.slug}`); return null; }}</Route>
      <Route path="/pods">{() => { window.location.replace("/ai/pods"); return null; }}</Route>
      <Route path="/approvals">{() => { window.location.replace("/ai/approvals"); return null; }}</Route>
      <Route path="/settings/ai-assistant">{() => { window.location.replace("/ai/admin#my-assistant"); return null; }}</Route>
      <Route path="/admin/ai-permissions">{() => { window.location.replace("/ai/admin#permissions"); return null; }}</Route>
      <Route path="/agent-activity">{() => { window.location.replace("/ai/admin#activity"); return null; }}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

const DEV_BYPASS = import.meta.env.DEV && import.meta.env.VITE_DEV_AUTH_BYPASS === "true";

function AuthenticatedAppInner() {
  const { user, unprovisioned, isLoading } = useAuth();
  const { signOut } = useClerk();

  const handleInactivityLogout = useCallback(async () => {
    try {
      await signOut();
    } catch {}
    queryClient.clear();
    window.location.href = "/";
  }, [signOut]);

  if (!isLoading && unprovisioned) {
    return <UnprovisionedScreen email={unprovisioned.email} onSignOut={handleInactivityLogout} />;
  }

  return <AuthenticatedAppContent user={user} isLoading={isLoading} handleInactivityLogout={handleInactivityLogout} />;
}

function AuthenticatedAppBypass() {
  const { user, unprovisioned, isLoading } = useAuth();

  const handleInactivityLogout = useCallback(async () => {
    queryClient.clear();
    window.location.href = "/";
  }, []);

  if (!isLoading && unprovisioned) {
    return <UnprovisionedScreen email={unprovisioned.email} onSignOut={handleInactivityLogout} />;
  }

  return <AuthenticatedAppContent user={user} isLoading={isLoading} handleInactivityLogout={handleInactivityLogout} />;
}

function UnprovisionedScreen({ email, onSignOut }: { email: string | null; onSignOut: () => void }) {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 text-center"
      data-testid="screen-unprovisioned"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-amber-500">
        <UserX className="h-6 w-6" />
      </div>
      <div className="max-w-md space-y-2">
        <h1 className="text-2xl font-semibold" data-testid="text-unprovisioned-title">
          Your account hasn't been provisioned yet
        </h1>
        <p className="text-muted-foreground" data-testid="text-unprovisioned-body">
          You signed in successfully{email ? <> as <strong className="text-foreground">{email}</strong></> : null},
          but no account has been set up for you in this workspace yet.
          Please contact your administrator to finish provisioning your account.
        </p>
      </div>
      <Button onClick={onSignOut} variant="outline" data-testid="button-unprovisioned-sign-out">
        Sign out
      </Button>
    </div>
  );
}

function AuthenticatedApp() {
  if (DEV_BYPASS) return <AuthenticatedAppBypass />;
  return <AuthenticatedAppInner />;
}

function useGlobalKeyboardShortcuts(openSwitchboard: () => void) {
  const [, navigate] = useLocation();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isEditable =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        (e.target as HTMLElement).isContentEditable;

      // `?` (Shift+/) — open Lane Switchboard. Checked BEFORE the `/`
      // handler because Shift+/ produces "?" on most US layouts; we
      // explicitly require shiftKey so a bare "/" still focuses search.
      // Skip on /daily-priorities so the page-local shortcuts dialog
      // owns `?` there (otherwise both fire simultaneously).
      if (
        e.key === "?" &&
        e.shiftKey &&
        !isEditable &&
        !e.metaKey &&
        !e.ctrlKey &&
        !window.location.pathname.startsWith("/daily-priorities")
      ) {
        e.preventDefault();
        openSwitchboard();
        return;
      }

      if (e.key === "/" && !isEditable && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
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
  }, [navigate, openSwitchboard]);
}

function AuthenticatedAppContent({ user, isLoading, handleInactivityLogout }: {
  user: ReturnType<typeof useAuth>["user"];
  isLoading: boolean;
  handleInactivityLogout: () => void;
}) {
  const [switchboardOpen, setSwitchboardOpen] = useState(false);
  const openSwitchboard = useCallback(() => setSwitchboardOpen(true), []);
  useGlobalKeyboardShortcuts(openSwitchboard);

  const { warningVisible, secondsLeft, staySignedIn } = useInactivityTimeout(
    user ? handleInactivityLogout : () => {}
  );

  // Cross-tab UX (option A) — single SSE connection per tab. Mounts here
  // (inside the authed shell) so the stream only opens for signed-in users
  // and tears down automatically on logout when this component unmounts.
  useLiveSync();

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
              <div className="flex items-center justify-between px-4 py-2 bg-amber-400 dark:bg-amber-600 text-amber-950 dark:text-white text-sm font-medium shrink-0" data-testid="banner-impersonation">
                <div className="flex items-center gap-2">
                  <UserX className="w-4 h-4" />
                  <span>You are viewing as <strong>{user.name}</strong> ({user.role?.replace(/_/g, " ")})</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs border-amber-700 dark:border-amber-200 bg-white dark:bg-amber-900 text-amber-900 dark:text-white hover:bg-amber-100 dark:hover:bg-amber-800 hover:text-amber-950 dark:hover:text-white"
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
      <LaneSwitchboard open={switchboardOpen} onOpenChange={setSwitchboardOpen} />
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
