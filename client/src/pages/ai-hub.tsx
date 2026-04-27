/**
 * Task #742 — AI Hub.
 *
 * Composition-only wrapper that consolidates seven previously-scattered AI
 * surfaces into a single tabbed page mounted at `/ai-hub`. Each tab renders
 * an existing page component unchanged so behavior, role gating, and test
 * IDs are preserved exactly.
 *
 * URL is the source of truth for the active tab:
 *   - `/ai-hub?hub=<key>` is the canonical URL the sidebar links to.
 *     The hub uses the `hub` query param (NOT `tab`) so it doesn't
 *     collide with any underlying page that owns its own `?tab=` state
 *     (e.g. ValueIQ uses `?tab=insights|threads|library`).
 *   - The seven legacy URLs (`/daily-priorities`, `/valueiq`,
 *     `/email-intelligence`, `/contact-suggestions`, `/ai*`,
 *     `/admin/ai-engagement`, `/admin/copilot-analytics`) all resolve to
 *     this page with the matching tab pre-selected, so bookmarks and any
 *     in-app/email links keep working.
 *
 * The hub does not duplicate logic from the underlying pages and does not
 * touch their internal layouts — it just renders the right component below
 * the sticky tab strip.
 */
import { useEffect, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ClipboardList, Brain, MailCheck, UserPlus, Sparkles, Activity, BarChart3,
  ShieldAlert, type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";

import DailyPrioritiesPage from "@/pages/daily-priorities";
import ValueIQPage from "@/pages/valueiq";
import EmailIntelligencePage from "@/pages/email-intelligence";
import ContactSuggestionsPage from "@/pages/contact-suggestions";
import AiCenterPage from "@/pages/ai-center";
import AdminAiEngagementPage from "@/pages/admin-ai-engagement";
import AdminCopilotAnalyticsPage from "@/pages/admin-copilot-analytics";

export type AiHubTabKey =
  | "priorities"
  | "valueiq"
  | "email"
  | "contacts"
  | "center"
  | "engagement"
  | "copilot";

interface TabSpec {
  key: AiHubTabKey;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  roles: string[];
  blurb: string;
  Component: React.ComponentType;
}

// Role lists are copied verbatim from the per-page guards / sidebar role
// lists so visibility is preserved exactly. If any underlying page changes
// its role check, update the matching entry here too.
export const AI_HUB_TABS: readonly TabSpec[] = [
  {
    key: "priorities",
    label: "Today's Priorities",
    shortLabel: "Priorities",
    icon: ClipboardList,
    roles: ["admin", "director", "national_account_manager", "account_manager", "sales", "sales_director"],
    blurb: "All active NBA signals bucketed by action type.",
    Component: DailyPrioritiesPage,
  },
  {
    key: "valueiq",
    label: "ValueIQ",
    shortLabel: "ValueIQ",
    icon: Brain,
    roles: ["admin", "director", "national_account_manager", "account_manager", "sales", "sales_director"],
    blurb: "Daily AI briefing, threads, and personal library.",
    Component: ValueIQPage,
  },
  {
    key: "email",
    label: "Email Intelligence",
    shortLabel: "Email",
    icon: MailCheck,
    roles: ["admin", "director", "national_account_manager", "sales_director"],
    blurb: "AI signals extracted from your inbound email.",
    Component: EmailIntelligencePage,
  },
  {
    key: "contacts",
    label: "Contact Suggestions",
    shortLabel: "Contacts",
    icon: UserPlus,
    roles: ["admin", "director", "sales_director", "national_account_manager", "account_manager", "logistics_manager"],
    blurb: "Suggested new contacts to add to accounts.",
    Component: ContactSuggestionsPage,
  },
  {
    key: "center",
    label: "AI Center",
    shortLabel: "Center",
    icon: Sparkles,
    roles: ["admin", "manager", "director", "national_account_manager", "sales_director"],
    blurb: "Manage AI agents, approvals, pods, and adapters.",
    Component: AiCenterPage,
  },
  {
    key: "engagement",
    label: "Engagement",
    shortLabel: "Engagement",
    icon: Activity,
    roles: ["admin", "director", "sales_director"],
    blurb: "Per-surface impressions, CTR, and zero-engagement candidates.",
    Component: AdminAiEngagementPage,
  },
  {
    key: "copilot",
    label: "Copilot Analytics",
    shortLabel: "Copilot",
    icon: BarChart3,
    roles: ["admin", "director", "sales_director"],
    blurb: "Top questions, failure modes, latency, and audit trail.",
    Component: AdminCopilotAnalyticsPage,
  },
] as const;

/**
 * Union of every role that can see at least one tab. The sidebar uses this
 * to decide whether the AI row is visible at all.
 */
export const AI_HUB_ANY_TAB_ROLES: string[] = Array.from(
  new Set(AI_HUB_TABS.flatMap((t) => t.roles)),
);

/**
 * Resolve the active tab from the current URL. Pathname wins over query
 * param so the seven legacy URLs always pre-select the right tab.
 */
export function resolveAiHubTab(pathname: string, search: string): AiHubTabKey {
  if (pathname.startsWith("/daily-priorities")) return "priorities";
  if (pathname.startsWith("/valueiq")) return "valueiq";
  if (pathname.startsWith("/email-intelligence")) return "email";
  if (pathname.startsWith("/contact-suggestions")) return "contacts";
  if (pathname.startsWith("/admin/ai-engagement")) return "engagement";
  if (pathname.startsWith("/admin/copilot-analytics")) return "copilot";
  if (pathname === "/ai" || pathname.startsWith("/ai/")) return "center";
  // /ai-hub — pull from the query string. We use the `hub` param (NOT
  // `tab`) so we don't shadow query state owned by underlying pages
  // like ValueIQ, which interprets `?tab=` as its own internal tab.
  const params = new URLSearchParams(search);
  const t = params.get("hub") as AiHubTabKey | null;
  if (t && AI_HUB_TABS.some((tab) => tab.key === t)) return t;
  return "priorities";
}

function useDailyWorkspaceCount(enabled: boolean) {
  const { data } = useQuery<{ totalCards: number }>({
    queryKey: ["/api/nba/daily-workspace"],
    enabled,
    refetchInterval: 5 * 60_000,
    staleTime: 4 * 60_000,
    retry: false,
  });
  return data?.totalCards ?? 0;
}

export default function AiHubPage() {
  const { user } = useAuth();
  const [location, setLocation] = useLocation();
  // wouter's useLocation only tracks the pathname; we need search too so
  // clicking a hub tab (which only changes ?hub=) re-resolves activeTab.
  const search = useSearch();

  const visibleTabs = useMemo(
    () => AI_HUB_TABS.filter((t) => user?.role && t.roles.includes(user.role)),
    [user?.role],
  );

  const activeTab = useMemo<AiHubTabKey>(
    () => resolveAiHubTab(location, search ? `?${search}` : ""),
    [location, search],
  );

  // If the resolved tab isn't visible to this user, fall back to the first
  // tab they can see. Avoid render-time navigation by using an effect.
  const fallbackTab = visibleTabs[0]?.key;
  useEffect(() => {
    if (!user) return;
    const tabIsVisible = visibleTabs.some((t) => t.key === activeTab);
    if (!tabIsVisible && fallbackTab) {
      setLocation(`/ai-hub?hub=${fallbackTab}`, { replace: true });
    }
  }, [user, activeTab, visibleTabs, fallbackTab, setLocation]);

  const dailyCount = useDailyWorkspaceCount(
    !!user && AI_HUB_TABS[0].roles.includes(user.role),
  );

  // Render guard rail for users with no AI access at all.
  if (user && visibleTabs.length === 0) {
    return (
      <div className="p-8" data-testid="ai-hub-forbidden">
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <ShieldAlert className="h-10 w-10 text-amber-500 mx-auto" />
            <p className="font-semibold">No AI surfaces available</p>
            <p className="text-sm text-muted-foreground">
              Your role doesn't grant access to any of the AI Hub tabs. Ask an
              admin if you should have access.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleTabChange = (next: string) => {
    setLocation(`/ai-hub?hub=${next}`);
  };

  // Render the body for the active tab. Each underlying page owns its own
  // header, padding, and inner tab logic — we don't wrap or duplicate.
  const ActiveBody = useMemo(() => {
    const tab = AI_HUB_TABS.find((t) => t.key === activeTab);
    return tab?.Component ?? null;
  }, [activeTab]);

  return (
    <div data-testid="page-ai-hub">
      {/* Sticky tab strip — sits below the app header so it's always reachable
          while the underlying page scrolls. */}
      <div
        className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border"
        data-testid="ai-hub-tabbar"
      >
        <div className="px-4 md:px-6 py-2">
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList className="h-auto flex-wrap justify-start gap-1 bg-transparent p-0">
              {visibleTabs.map((t) => {
                const Icon = t.icon;
                const showBadge = t.key === "priorities" && dailyCount > 0;
                return (
                  <TabsTrigger
                    key={t.key}
                    value={t.key}
                    className="data-[state=active]:bg-muted data-[state=active]:shadow-none gap-1.5 px-3 py-1.5"
                    data-testid={`ai-hub-tab-${t.key}`}
                    title={t.blurb}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="hidden sm:inline">{t.label}</span>
                    <span className="sm:hidden">{t.shortLabel}</span>
                    {showBadge && (
                      <Badge
                        variant="secondary"
                        className="ml-1 h-5 min-w-5 px-1 bg-emerald-600 text-white hover:bg-emerald-600"
                        data-testid="ai-hub-tab-badge-priorities"
                      >
                        {dailyCount > 99 ? "99+" : dailyCount}
                      </Badge>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div data-testid={`ai-hub-body-${activeTab}`}>
        {ActiveBody ? <ActiveBody /> : null}
      </div>
    </div>
  );
}
