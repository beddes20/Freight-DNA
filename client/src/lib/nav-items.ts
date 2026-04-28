// Shared sidebar / command-palette nav data.
//
// app-sidebar.tsx imports the three section arrays below for the
// rendered sidebar. The command palette imports the same arrays plus
// `adminItems` so every navigation destination the user can reach from
// the sidebar is also reachable via cmd-K. Keep both consumers in sync
// by editing this one file.

import {
  ClipboardList, LayoutGrid, Network, Trophy, Users, BarChart3, History, Zap,
  MessagesSquare, ListTodo, TrendingUp, Target, Plane, FileBarChart2, KeyRound,
  Inbox, Crosshair, Truck, Calendar, Medal, Settings, Phone, PhoneCall,
  ListFilter, Building2, Briefcase, MessageSquare, UserPlus, HelpCircle,
  MailCheck, Sparkles, Activity, Compass, GitMerge, Filter, BotMessageSquare,
  type LucideIcon,
} from "lucide-react";
import { AI_HUB_ANY_TAB_ROLES } from "@/pages/ai-hub";
import { QUOTE_OPPORTUNITIES_ROLES } from "@shared/quoteOpportunitiesRoles";

export type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  description: string;
  roles?: string[];
  badge?: number;
};

export const SALES_ROLES = ["admin", "director", "national_account_manager", "account_manager", "sales", "sales_director"];
export const PROSPECTS_ROLES = ["admin", "sales", "sales_director"];
export const DAILY_PRIORITIES_ROLES = ["admin", "director", "national_account_manager", "account_manager", "sales", "sales_director"];
export const CARRIER_INTEL_ROLES = ["admin", "director", "national_account_manager", "logistics_manager", "logistics_coordinator", "sales_director"];
export const CARRIER_INTEL_SETTINGS_ROLES = ["admin", "director"];

const QUOTE_OPPORTUNITIES_SIDEBAR_ROLES: string[] = Array.from(QUOTE_OPPORTUNITIES_ROLES);

export const navItems: NavItem[] = [
  { title: "Dashboard",    url: "/",           icon: LayoutGrid,    description: "Your home view with daily priorities and updates." },
  { title: "1:1's",        url: "/one-on-one", icon: MessagesSquare, description: "Manager check-ins and one-on-one notes." },
  { title: "Tasks",        url: "/tasks",      icon: ListTodo,      description: "Your personal to-do list and reminders." },
  { title: "Goals",        url: "/goals",      icon: Target,        description: "Track personal and team sales goals." },
  { title: "My Scorecard", url: "/report/me",  icon: FileBarChart2, description: "Your individual performance scorecard.", roles: ["account_manager", "sales", "logistics_manager", "logistics_coordinator"] },
  {
    title: "Team Performance",
    url: "/team-performance",
    icon: TrendingUp,
    description: "Team metrics, leaderboards, and performance trends.",
    roles: ["admin", "director", "national_account_manager", "sales", "sales_director"],
  },
];

export const customerFacingItems: NavItem[] = [
  { title: "Launchpad",         url: "/prospects",        icon: Crosshair,     description: "Find and qualify new prospects to pursue.", roles: PROSPECTS_ROLES },
  { title: "Customers",         url: "/customers",        icon: Network,       description: "Browse customer accounts and account history.", roles: SALES_ROLES },
  { title: "Customer Quotes",   url: "/customer-quotes",  icon: FileBarChart2, description: "Quote requests, outcomes, and lane performance — drillable analytics across customers and reps.", roles: QUOTE_OPPORTUNITIES_SIDEBAR_ROLES },
  { title: "Freight Capture",   url: "/freight-capture",  icon: Filter,        description: "Quote-to-book funnel: stages from request received through win, with loss reasons and best/worst performers.", roles: ["admin", "director", "sales_director", "national_account_manager", "account_manager", "sales"] },
  { title: "Top Opportunities", url: "/top-opportunities",icon: Zap,           description: "High-value opportunities ranked by potential impact.", roles: SALES_ROLES },
  { title: "RFP & Awards",      url: "/rfp-awards",       icon: Trophy,        description: "Active RFPs and awarded business tracking." },
  { title: "RFP Calendar",      url: "/rfp-calendar",     icon: Calendar,      description: "Upcoming RFP deadlines and key dates." },
  {
    title: "Email Intelligence",
    url: "/email-intelligence",
    icon: MailCheck,
    description: "AI signals extracted from your inbound email — urgency, win/loss patterns, and recent activity.",
    roles: ["admin", "director", "national_account_manager", "sales_director"],
  },
  {
    title: "Contact Suggestions",
    url: "/contact-suggestions",
    icon: UserPlus,
    description: "Suggested new contacts to add to accounts, learned from inbound email.",
    roles: ["admin", "director", "sales_director", "national_account_manager", "account_manager", "logistics_manager"],
  },
  {
    title: "Proven Tactics",
    url: "/proven-tactics",
    icon: ClipboardList,
    description: "Reusable plays that have closed deals.",
    roles: ["admin", "director", "national_account_manager", "logistics_manager", "account_manager"],
  },
  {
    title: "Playbook",
    url: "/playbook",
    icon: ClipboardList,
    description: "Step-by-step guides for common sales situations.",
    roles: ["admin", "director", "national_account_manager", "sales_director", "logistics_manager", "account_manager", "sales"],
  },
  {
    title: "Freight Attribution Triage",
    url: "/freight-triage",
    icon: GitMerge,
    description: "Margin-sorted gaps from your relationship-freight book — unworked accounts, unattributed lanes, and unassigned contacts in one ranked worklist.",
    roles: SALES_ROLES,
  },
  { title: "Coaching",      url: "/coaching",       icon: Sparkles, description: "Coaching notes and rep development plans.", roles: ["admin", "director", "national_account_manager", "sales_director"] },
  { title: "Rep Scorecard", url: "/rep-scorecard",  icon: Medal,    description: "Compare reps and review performance metrics.", roles: ["admin", "director", "national_account_manager", "sales_director"] },
  {
    title: "Conversations",
    url: "/conversations",
    icon: MessageSquare,
    description: "Inbound carrier and customer messages.",
    roles: ["admin", "director", "national_account_manager", "sales_director", "account_manager", "sales"],
  },
];

export const aiHubItem: NavItem = {
  title: "AI",
  url: "/ai-hub",
  icon: BotMessageSquare,
  description: "Today's Priorities, ValueIQ, AI Center, Engagement, and Copilot Analytics — all in one tabbed page.",
  roles: AI_HUB_ANY_TAB_ROLES,
};

export const carrierFacingItems: NavItem[] = [
  { title: "Lane Intelligence", url: "/research-tasks",   icon: ClipboardList, description: "Research lanes and gather pricing intelligence." },
  { title: "My Procurement",    url: "/my-procurement",   icon: Briefcase,     description: "Lanes you're actively procuring carriers for." },
  { title: "Lane Work Queue",   url: "/lanes/work-queue", icon: ListFilter,    description: "Lanes awaiting your reply or next action." },
  { title: "Lane Inbox",        url: "/lane-inbox",       icon: Inbox,         description: "Cross-surface activity feed — AF, LWQ, Customer Quotes, Carrier Hub." },
  { title: "My PODs",           url: "/my-pods",          icon: MailCheck,     description: "Proofs of delivery received for loads you cover or own." },
  {
    title: "Available Freight",
    url: "/available-freight",
    icon: Truck,
    description: "Freight loads currently available to cover.",
    roles: ["admin", "director", "national_account_manager", "sales_director", "logistics_manager", "account_manager", "sales"],
  },
  {
    title: "Carrier Hub",
    url: "/carrier-hub",
    icon: Building2,
    description: "Manage carriers and review their submitted intel.",
    roles: ["admin", "director", "national_account_manager", "logistics_manager"],
  },
  {
    title: "Conversations",
    url: "/conversations",
    icon: MessageSquare,
    description: "Inbound carrier and customer messages.",
    roles: ["admin", "director", "national_account_manager", "logistics_manager", "account_manager"],
  },
  { title: "Phone Usage",      url: "/phone-usage",        icon: Phone,    description: "Org-wide phone usage trends and rep activity.", roles: ["admin", "director", "national_account_manager", "sales_director"] },
  { title: "Call Performance", url: "/calls",              icon: PhoneCall, description: "Org-wide call pace, weekly trendline, and quality scorecard under one shared window.", roles: ["admin", "director", "national_account_manager", "sales_director"] },
  { title: "LM Check-In Log",  url: "/lm-checkin-history", icon: History,  description: "History of logistics manager check-ins.", roles: ["admin", "director", "national_account_manager", "account_manager", "sales_director"] },
  { title: "Carrier Scorecard", url: "/carrier-intelligence/scorecard",       icon: Trophy,  description: "Tiered carrier performance from realized loads, with active and available counts.", roles: CARRIER_INTEL_ROLES },
  { title: "Available Loads",   url: "/carrier-intelligence/available-loads", icon: Truck,   description: "Open loads ranked with the top 3 suggested carriers and a target buy rate.", roles: CARRIER_INTEL_ROLES },
  { title: "Lane Pricing",      url: "/carrier-intelligence/lane-pricing",    icon: Compass, description: "Blend Sonar TRAC with your realized history and a confidence chip.", roles: CARRIER_INTEL_ROLES },
  { title: "Settings",          url: "/admin/carrier-intelligence/settings",  icon: Settings, description: "Imports, scoring math, and org-wide UI defaults.", roles: CARRIER_INTEL_SETTINGS_ROLES },
];

const ADMIN_GROUP_ROLES = ["admin", "director", "national_account_manager", "sales", "sales_director"];

// adminItems mirrors the inline JSX in app-sidebar.tsx so the palette
// can offer every admin/team destination too. Keep titles and roles in
// sync; the sidebar still renders these inline (intentional — its
// per-item conditional logic is more readable than a generic loop).
export const adminItems: NavItem[] = [
  { title: "User Management",     url: "/admin/users",                       icon: Users,      description: "Manage users, roles, and team structure.", roles: ADMIN_GROUP_ROLES },
  { title: "Carrier Catalog",     url: "/admin/carriers",                    icon: Truck,      description: "Org-wide carrier catalog and reviewable intel.", roles: ["admin", "director"] },
  { title: "Monitored Mailboxes", url: "/admin/monitored-mailboxes",         icon: MailCheck,  description: "Mailboxes scanned for inbound carrier and customer email.", roles: ["admin", "director", "sales_director"] },
  { title: "FC Rep Audit",        url: "/admin/freight-capture-rep-audit",   icon: Filter,     description: "Audit names appearing as 'Rep' on the Freight Capture funnel and link, suppress, or merge them.", roles: ["admin"] },
  { title: "POD Intake",          url: "/admin/pod-intake",                  icon: MailCheck,  description: "AR mailbox proof-of-delivery routing.", roles: ["admin", "director", "sales_director"] },
  { title: "Freight Import Health", url: "/admin/available-freight/imports", icon: Truck,      description: "Per-import health and lane coverage for available freight.", roles: ["admin", "director", "national_account_manager", "sales_director", "logistics_manager"] },
  { title: "Carrier Intel Admin", url: "/admin/carrier-intelligence",        icon: GitMerge,   description: "Backfill load_fact, parity reports, and import audits.", roles: ["admin", "director"] },
  { title: "Webex Health",        url: "/admin/webex-health",                icon: Activity,   description: "Scope coverage, backfill progress, and enrichment-job retry queue.", roles: ["admin"] },
  { title: "Integrations Health", url: "/admin/integrations-health",         icon: Activity,   description: "Live status of every external integration (SONAR, Graph, Webex, ZoomInfo, OneDrive, TRAC, Stripe).", roles: ["admin"] },
  { title: "Endpoint Perf",       url: "/admin/endpoint-perf",               icon: Activity,   description: "Per-route p50/p95/p99 latency vs. budget.", roles: ["admin"] },
  { title: "Financials",          url: "/financials",                        icon: BarChart3,  description: "Revenue, margin, and financial reports.", roles: ADMIN_GROUP_ROLES },
  { title: "Lane Analytics",      url: "/historical-data",                   icon: History,    description: "Historical lane volumes and pricing trends.", roles: ADMIN_GROUP_ROLES },
  { title: "Coordinators Corner", url: "/coordinators-corner",               icon: KeyRound,   description: "Coordinators corner with shared work queues.", roles: ["admin", "director", "national_account_manager", "logistics_manager", "logistics_coordinator"] },
  { title: "PTO Passoff",         url: "/pto-passoff",                       icon: Plane,      description: "PTO coverage handoffs.", roles: ADMIN_GROUP_ROLES },
  { title: "Touchpoint History",  url: "/touchpoint-history",                icon: Phone,      description: "Review tool — every touchpoint logged across the org.", roles: ADMIN_GROUP_ROLES },
  { title: "Sidebar Tooltips",    url: "/admin/sidebar-tooltips",            icon: HelpCircle, description: "Edit per-item sidebar tooltip overrides.", roles: ["admin"] },
  { title: "Feedback Inbox",      url: "/feedback-inbox",                    icon: Inbox,      description: "User feedback and app suggestions.", roles: ["admin", "director"] },
  { title: "Notifications",       url: "/notifications",                     icon: Inbox,      description: "Full notification history.", roles: ADMIN_GROUP_ROLES },
];

export function visibleNavItems(items: NavItem[], role: string | undefined): NavItem[] {
  if (!role) return items.filter(i => !i.roles);
  return items.filter(i => !i.roles || i.roles.includes(role));
}

export function allVisibleDestinations(role: string | undefined): NavItem[] {
  const all = [
    ...navItems,
    ...customerFacingItems,
    aiHubItem,
    ...carrierFacingItems,
    ...adminItems,
  ];
  // Deduplicate by URL — Conversations appears in both sections, etc.
  const seen = new Set<string>();
  const result: NavItem[] = [];
  for (const item of visibleNavItems(all, role)) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
  }
  return result;
}
