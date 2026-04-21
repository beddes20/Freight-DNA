import { useState, useCallback } from "react";

export interface PortletDef {
  id: string;
  label: string;
  description: string;
  directorOnly?: boolean;
}

export interface PortletLayout {
  visible: boolean;
  order: number;
}

export type DashboardLayout = Record<string, PortletLayout>;

export const DIRECTOR_PORTLETS: PortletDef[] = [
  { id: "todays-briefing", label: "Today's Briefing",        description: "Tasks due today, at-risk accounts, contacts needing attention, and unread notifications" },
  { id: "recently-visited", label: "Recently Visited",       description: "Last 8 accounts you navigated to — click to jump back" },
  { id: "pinned-accounts", label: "Pinned Accounts",          description: "Quick-access portlet for up to 10 starred/pinned accounts" },
  { id: "intel-snapshot",  label: "Intel Snapshot",          description: "Daily market pulse and top lane alerts from Sonar intelligence" },
  { id: "dir-activity",    label: "Activity Stats",          description: "Team activity counts — relationships moved, meaningful conversations, new contacts, touches today", directorOnly: true },
  { id: "dir-trending",    label: "Trending Accounts",       description: "Accounts trending up or down vs. 3-month rolling average", directorOnly: true },
  { id: "dir-margin",      label: "Margin Performance",      description: "NAM and AM margin metrics with goal progress bars", directorOnly: true },
  { id: "dir-recent-wins", label: "Recent Wins",             description: "Opportunities logged as won this month", directorOnly: true },
  { id: "top-opportunities", label: "Top Opportunities",     description: "Accounts ranked by untapped wallet share potential" },
  { id: "churn-risk",      label: "Churn Risk",              description: "Accounts with significant load volume drops vs. prior period" },
  { id: "market-share",    label: "Market Share",            description: "Market share trend portlet" },
  { id: "goals-leaderboard", label: "Goals Leaderboard",     description: "Top performers per goal metric across the team" },
  { id: "relationship",    label: "Relationship Intel",      description: "Freight performance and contact coverage by relationship level" },
  { id: "one-on-one",      label: "1:1 Sessions",            description: "Manager-rep 1:1 discussion topics and session history" },
  { id: "team-directory",  label: "Team Directory",          description: "NAM and AM roster with account counts" },
  { id: "tasks",           label: "My Tasks",                description: "Tasks assigned to you or created by you" },
  { id: "missed-inbound",  label: "Missed Inbound Calls",    description: "Unanswered Webex calls (known + unknown) with click-to-callback" },
  { id: "cold-contacts",   label: "Cold Contacts",           description: "Contacts with no touchpoint in 30+ days" },
  { id: "meaningful-overdue", label: "Meaningful Conversations", description: "Contacts overdue for a meaningful conversation" },
  { id: "feed",            label: "Activity Feed",           description: "Team posts, trends, and internal communications" },
];

const DEFAULT_ORDER = DIRECTOR_PORTLETS.map((p, i) => ({ id: p.id, order: i }));

function buildDefaultLayout(): DashboardLayout {
  const layout: DashboardLayout = {};
  DEFAULT_ORDER.forEach(({ id, order }) => {
    layout[id] = { visible: true, order };
  });
  return layout;
}

function storageKey(userId: string) {
  return `dashboardLayout_v2_${userId}`;
}

export function useDashboardLayout(userId: string | undefined) {
  const [layout, setLayoutState] = useState<DashboardLayout>(() => {
    const defaults = buildDefaultLayout();
    if (!userId) return defaults;
    try {
      const stored = localStorage.getItem(storageKey(userId));
      if (stored) {
        const parsed = JSON.parse(stored) as DashboardLayout;
        return { ...defaults, ...parsed };
      }
    } catch { /* ignore */ }
    return defaults;
  });

  const saveLayout = useCallback((next: DashboardLayout) => {
    setLayoutState(next);
    if (!userId) return;
    try { localStorage.setItem(storageKey(userId), JSON.stringify(next)); } catch { /* ignore */ }
  }, [userId]);

  const isVisible = useCallback((id: string) => layout[id]?.visible ?? true, [layout]);
  const getOrder  = useCallback((id: string) => layout[id]?.order  ?? 999,  [layout]);

  const resetLayout = useCallback(() => saveLayout(buildDefaultLayout()), [saveLayout]);

  return { layout, saveLayout, isVisible, getOrder, resetLayout };
}
