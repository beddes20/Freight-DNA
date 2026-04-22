import { ClipboardList, LayoutGrid, Network, Trophy, Users, LogOut, BarChart3, History, Zap, MessagesSquare, ListTodo, TrendingUp, Target, Plane, GraduationCap, Wrench, FileBarChart2, KeyRound, Inbox, Crosshair, Truck, Calendar, Medal, Settings, Phone, ListFilter, Building2, Briefcase, Radio, MessageSquare, PanelLeftClose, PanelLeftOpen, UserPlus, HelpCircle, Keyboard, BrainCircuit, Lightbulb, Brain, MailCheck, ChevronDown, Sparkles, Activity, Compass, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { SignatureEditor } from "@/components/signature-editor";
import { WebexMyConnection } from "@/components/webex-my-connection";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { useNotificationCounts } from "@/hooks/use-notifications";
import { NotificationBell } from "@/components/notification-bell";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { SIDEBAR_TOOLTIP_DEFAULT_MAP } from "@/lib/sidebar-tooltip-catalog";
import type { SidebarTooltip } from "@shared/schema";
import vtLogoWhite from "@assets/value-truck-logo-white.png";

const SALES_ROLES = ["admin", "director", "national_account_manager", "account_manager", "sales", "sales_director"];
const PROSPECTS_ROLES = ["admin", "sales", "sales_director"];

type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  description: string;
  roles?: string[];
  badge?: number;
};

const navItems: NavItem[] = [
  { title: "Dashboard",         url: "/",                 icon: LayoutGrid,    description: "Your home view with daily priorities and updates." },
  { title: "Launchpad",         url: "/prospects",        icon: Crosshair,     description: "Find and qualify new prospects to pursue.", roles: PROSPECTS_ROLES },
  { title: "Customers",         url: "/customers",        icon: Network,       description: "Browse customer accounts and account history.", roles: SALES_ROLES },
  { title: "Top Opportunities", url: "/top-opportunities",icon: Zap,           description: "High-value opportunities ranked by potential impact.", roles: SALES_ROLES },
  { title: "1:1's",             url: "/one-on-one",       icon: MessagesSquare,description: "Manager check-ins and one-on-one notes." },
  { title: "Tasks",             url: "/tasks",            icon: ListTodo,      description: "Your personal to-do list and reminders." },
  {
    title: "Team Performance",
    url: "/team-performance",
    icon: TrendingUp,
    description: "Team metrics, leaderboards, and performance trends.",
    roles: ["admin", "director", "national_account_manager", "sales", "sales_director"],
  },
  { title: "Goals",        url: "/goals",      icon: Target,        description: "Track personal and team sales goals." },
  { title: "My Scorecard", url: "/report/me",  icon: FileBarChart2, description: "Your individual performance scorecard.", roles: ["account_manager", "sales", "logistics_manager", "logistics_coordinator"] },
];

const pipelineItems: NavItem[] = [
  { title: "RFP & Awards",    url: "/rfp-awards",      icon: Trophy,   description: "Active RFPs and awarded business tracking." },
  { title: "RFP Calendar",    url: "/rfp-calendar",    icon: Calendar, description: "Upcoming RFP deadlines and key dates." },
  { title: "Rep Scorecard",   url: "/rep-scorecard",   icon: Medal,    description: "Compare reps and review performance metrics.", roles: ["admin", "director", "national_account_manager", "sales_director"] },
  { title: "Coaching",        url: "/coaching",        icon: Sparkles, description: "Coaching notes and rep development plans.", roles: ["admin", "director", "national_account_manager", "sales_director"] },
  { title: "Phone Usage",     url: "/phone-usage",     icon: Phone,    description: "Org-wide phone usage trends and rep activity.", roles: ["admin", "director", "national_account_manager", "sales_director"] },
  { title: "LM Check-In Log", url: "/lm-checkin-history", icon: History, description: "History of logistics manager check-ins.", roles: ["admin", "director", "national_account_manager", "account_manager", "sales_director"] },
];

const laneToolItems: NavItem[] = [
  { title: "Lane Intelligence",  url: "/research-tasks",  icon: ClipboardList, description: "Research lanes and gather pricing intelligence." },
  { title: "My Procurement",     url: "/my-procurement",  icon: Briefcase,     description: "Lanes you're actively procuring carriers for." },
  { title: "Lane Work Queue",    url: "/lanes/work-queue",icon: ListFilter,    description: "Lanes awaiting your reply or next action." },
  { title: "Available Freight",  url: "/available-freight", icon: Truck,
    description: "Freight loads currently available to cover.",
    roles: ["admin", "director", "national_account_manager", "sales_director", "logistics_manager", "account_manager", "sales"] },
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
  {
    title: "Contact Suggestions",
    url: "/contact-suggestions",
    icon: UserPlus,
    description: "Suggested new contacts to add to accounts.",
    roles: ["admin", "director", "national_account_manager", "account_manager"],
  },
  {
    title: "Email Intelligence",
    url: "/email-intelligence",
    icon: BrainCircuit,
    description: "AI insights pulled from your inbound emails.",
    roles: ["admin", "director", "national_account_manager", "sales_director"],
  },
  {
    title: "Proven Tactics",
    url: "/proven-tactics",
    icon: Lightbulb,
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
    title: "ValueIQ",
    url: "/valueiq",
    icon: Brain,
    description: "Daily AI briefing on your top accounts.",
    roles: ["admin", "director", "national_account_manager", "account_manager", "sales", "sales_director"],
  },
];

const CARRIER_INTEL_ROLES = ["admin", "director", "national_account_manager", "logistics_manager", "logistics_coordinator", "sales_director"];
const CARRIER_INTEL_SETTINGS_ROLES = ["admin", "director"];

const carrierIntelItems: NavItem[] = [
  {
    title: "Carrier Scorecard", url: "/carrier-intelligence/scorecard", icon: Trophy,
    description: "Tiered carrier performance from realized loads, with active and available counts.",
    roles: CARRIER_INTEL_ROLES,
  },
  {
    title: "Available Loads", url: "/carrier-intelligence/available-loads", icon: Truck,
    description: "Open loads ranked with the top 3 suggested carriers and a target buy rate.",
    roles: CARRIER_INTEL_ROLES,
  },
  {
    title: "Lane Pricing", url: "/carrier-intelligence/lane-pricing", icon: Compass,
    description: "Blend Sonar TRAC with your realized history and a confidence chip.",
    roles: CARRIER_INTEL_ROLES,
  },
  {
    title: "Settings", url: "/admin/carrier-intelligence/settings", icon: Settings,
    description: "Imports, scoring math, and org-wide UI defaults.",
    roles: CARRIER_INTEL_SETTINGS_ROLES,
  },
];

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

function CollapsibleGroup({ label, children, defaultOpen = true }: { label: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <SidebarGroup>
      <SidebarGroupLabel
        className="cursor-pointer select-none flex items-center justify-between pr-2 hover:text-sidebar-foreground/80 transition-colors"
        onClick={() => setOpen(v => !v)}
        data-testid={`toggle-group-${label.toLowerCase().replace(/[\s/]+/g, "-")}`}
      >
        <span>{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-sidebar-foreground/40 transition-transform duration-200 ${open ? "" : "-rotate-90"}`} />
      </SidebarGroupLabel>
      {open && (
        <SidebarGroupContent>
          <SidebarMenu>{children}</SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}

function NotificationBadge({ count, color = "red" }: { count: number; color?: "red" | "green" }) {
  if (count <= 0) return null;
  const bg = color === "green" ? "bg-green-600" : "bg-red-500";
  return (
    <span
      className={`ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full ${bg} px-1 text-[10px] font-semibold leading-none text-white group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:-top-1 group-data-[collapsible=icon]:-right-1 group-data-[collapsible=icon]:h-4 group-data-[collapsible=icon]:min-w-4 group-data-[collapsible=icon]:text-[9px]`}
      data-testid="badge-notification-count"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function navTooltip(title: string, description: string) {
  return {
    alwaysShow: true,
    children: (
      <div className="max-w-[15rem]">
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    ),
  };
}

function useSidebarTooltipOverrides() {
  const { user } = useAuth();
  const { data } = useQuery<{ items: SidebarTooltip[] }>({
    queryKey: ["/api/sidebar-tooltips"],
    enabled: !!user,
    staleTime: 60_000,
    retry: false,
  });
  const map: Record<string, string> = {};
  for (const t of data?.items ?? []) map[t.itemKey] = t.description;
  return map;
}

function resolveDescription(key: string, fallback: string, overrides?: Record<string, string>): string {
  const o = overrides?.[key];
  if (typeof o === "string" && o.trim().length > 0) return o;
  return fallback;
}

function NavLink({ item, isActive, badge, badgeColor, overrides }: { item: NavItem; isActive: boolean; badge?: number; badgeColor?: "red" | "green"; overrides?: Record<string, string> }) {
  const Icon = item.icon;
  const description = resolveDescription(item.title, item.description, overrides);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={navTooltip(item.title, description)}>
        <Link href={item.url} data-testid={`link-${item.title.toLowerCase().replace(/[\s&]+/g, "-")}`} className="relative">
          <Icon className="h-4 w-4" />
          <span>{item.title}</span>
          {badge !== undefined && <NotificationBadge count={badge} color={badgeColor} />}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function useUnactionedReplyCount() {
  const { user } = useAuth();
  const { data } = useQuery<{ count: number }>({
    queryKey: ["/api/recurring-lanes/unactioned-reply-count"],
    enabled: !!user,
    refetchInterval: 60_000,
    staleTime: 50_000,
    retry: false,
  });
  return data?.count ?? 0;
}

function useConversationsWaitingCount() {
  const { user } = useAuth();
  const { data } = useQuery<{ count: number }>({
    queryKey: ["/api/internal/conversations/my-count"],
    enabled: !!user,
    refetchInterval: 90_000,
    staleTime: 80_000,
    retry: false,
  });
  return data?.count ?? 0;
}

const INTEL_REVIEW_ROLES = ["admin", "director"];

function usePendingIntelCount() {
  const { user } = useAuth();
  const { data } = useQuery<{ count: number }>({
    queryKey: ["/api/carrier-hub/pending-intel-count"],
    enabled: !!user && INTEL_REVIEW_ROLES.includes(user.role),
    refetchInterval: 60_000,
    staleTime: 50_000,
    retry: false,
  });
  return data?.count ?? 0;
}

export function AppSidebar() {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const { taskCount, suggestionCount } = useNotificationCounts();
  const unactionedReplyCount = useUnactionedReplyCount();
  const conversationsWaitingCount = useConversationsWaitingCount();
  const pendingIntelCount = usePendingIntelCount();
  const tooltipOverrides = useSidebarTooltipOverrides();
  const desc = (key: string, fallback?: string) =>
    resolveDescription(key, fallback ?? SIDEBAR_TOOLTIP_DEFAULT_MAP[key] ?? "", tooltipOverrides);
  const { toast } = useToast();
  const [profileOpen, setProfileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [signature, setSignature] = useState("");
  const { toggleSidebar, open, isMobile } = useSidebar();

  const saveSignatureMutation = useMutation({
    mutationFn: async (sig: string) => {
      const cleaned = sig
        .replace(/<p[^>]*>(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, "")
        .replace(/(<br\s*\/?>\s*){3,}/gi, "<br><br>")
        .trim();
      const res = await apiRequest("PATCH", `/api/users/${user?.id}`, { emailSignature: cleaned || null });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Profile saved" });
      setProfileOpen(false);
    },
    onError: () => toast({ title: "Failed to save profile", variant: "destructive" }),
  });

  function openProfile() {
    setSignature(user?.emailSignature ?? "");
    setProfileOpen(true);
  }

  const isActive = (url: string) =>
    url === "/"
      ? location === "/"
      : location.startsWith(url) || (url === "/customers" && location.startsWith("/companies/")) ||
        (url === "/research-tasks" && (location.startsWith("/research-tasks") || location.startsWith("/rfp-lane-search") || location.startsWith("/carrier-lane-search")));

  return (
    <>
    <Sidebar collapsible="icon">
      {/* Desktop rail toggle button */}
      {!isMobile && (
        <button
          onClick={toggleSidebar}
          title={open ? "Collapse sidebar" : "Expand sidebar"}
          data-testid="button-sidebar-rail-toggle"
          className="absolute -right-3 top-20 z-50 hidden md:flex h-6 w-6 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent shadow-sm transition-colors"
          aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
        >
          {open ? (
            <PanelLeftClose className="h-3.5 w-3.5" />
          ) : (
            <PanelLeftOpen className="h-3.5 w-3.5" />
          )}
        </button>
      )}
      <SidebarHeader className="p-4 border-b border-sidebar-border">
        {/* Expanded sidebar header */}
        <div className="flex flex-col items-center justify-center py-1 gap-1 group-data-[collapsible=icon]:hidden">
          {user?.organizationSlug === "demo" ? (
            <div className="flex flex-col items-center gap-0.5">
              <svg viewBox="0 0 120 36" width="110" height="33" aria-label="Freight DNA">
                <rect x="2" y="10" width="70" height="20" rx="3" fill="none" stroke="#ffb400" strokeWidth="2"/>
                <rect x="72" y="16" width="26" height="14" rx="2" fill="none" stroke="#ffb400" strokeWidth="2"/>
                <circle cx="18" cy="32" r="4" fill="#ffb400"/>
                <circle cx="52" cy="32" r="4" fill="#ffb400"/>
                <circle cx="88" cy="32" r="4" fill="#ffb400"/>
                <line x1="72" y1="23" x2="72" y2="30" stroke="#ffb400" strokeWidth="1.5"/>
                <path d="M 100,12 Q 104,17 100,22 Q 96,27 100,32" fill="none" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M 108,12 Q 104,17 108,22 Q 112,27 108,32" fill="none" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="100" y1="17" x2="108" y2="17" stroke="#ffb400" strokeWidth="1"/>
                <line x1="100" y1="22" x2="108" y2="22" stroke="#ffb400" strokeWidth="1"/>
                <line x1="100" y1="27" x2="108" y2="27" stroke="#ffb400" strokeWidth="1"/>
              </svg>
              <span className="text-sm font-bold tracking-widest" style={{ color: "#ffb400" }}>FREIGHT DNA</span>
            </div>
          ) : (
            <img src={vtLogoWhite} alt="Value Truck" className="h-10 w-auto object-contain" />
          )}
          <p className="text-[10px] tracking-wide text-center" style={{ color: "#ffb400" }} data-testid="text-dna-tagline-sidebar">
            <span className="font-bold">DNA</span>
            {" · "}
            <span className="font-bold">D</span>own{" "}
            <span className="font-bold">N</span>ot{" "}
            <span className="font-bold">A</span>cross
          </p>
          <div className="flex items-center justify-center mt-1" title="Farmer → Hunter">
            <svg viewBox="0 0 134 46" width="90" height="30" aria-label="Farmer to Hunter">
              <line x1="38" y1="4" x2="24" y2="21" stroke="#ffb400" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="21" y1="19" x2="28" y2="24" stroke="#ffb400" strokeWidth="4.5" strokeLinecap="butt"/>
              <line x1="24" y1="22" x2="9"  y2="22" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="24" y1="22" x2="10" y2="27" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="24" y1="22" x2="12" y2="31" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="24" y1="22" x2="15" y2="35" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="24" y1="22" x2="19" y2="39" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="24" y1="22" x2="24" y2="41" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M 9,22 Q 14,37 24,41" fill="none" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="44" y1="23" x2="53" y2="23" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
              <polyline points="49,18 54,23 49,28" fill="none" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <g transform="rotate(-12, 92, 23)">
                <path d="M 74,5 C 108,5 108,41 74,41" fill="none" stroke="#ffb400" strokeWidth="2.5" strokeLinecap="round"/>
                <line x1="74" y1="5" x2="74" y2="41" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="69" y1="23" x2="122" y2="23" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
                <polygon points="116,17 124,23 116,29" fill="#ffb400"/>
              </g>
            </svg>
          </div>
        </div>
        {/* Collapsed icon */}
        <div className="hidden group-data-[collapsible=icon]:flex justify-center py-1">
          {user?.organizationSlug === "demo" ? (
            <svg viewBox="0 0 24 24" width="24" height="24" aria-label="FD">
              <rect x="1" y="6" width="14" height="10" rx="1.5" fill="none" stroke="#ffb400" strokeWidth="1.5"/>
              <rect x="15" y="9" width="8" height="7" rx="1" fill="none" stroke="#ffb400" strokeWidth="1.5"/>
              <circle cx="5" cy="17" r="2" fill="#ffb400"/>
              <circle cx="11" cy="17" r="2" fill="#ffb400"/>
              <circle cx="20" cy="17" r="2" fill="#ffb400"/>
            </svg>
          ) : (
            <img src={vtLogoWhite} alt="VT" className="h-6 w-6 object-contain" />
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* ── Navigation ── */}
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems
                .filter(item => !item.roles || (user?.role && item.roles.includes(user.role)))
                .map(item => (
                  <NavLink
                    key={item.title}
                    item={item}
                    isActive={isActive(item.url)}
                    badge={item.title === "Tasks" ? taskCount : undefined}
                    overrides={tooltipOverrides}
                  />
                ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ── Pipeline (hidden for LM/LC roles) ── */}
        {SALES_ROLES.includes(user?.role ?? "") && (
          <CollapsibleGroup label="Pipeline">
            {pipelineItems
              .filter(item => !item.roles || (user?.role && item.roles.includes(user.role)))
              .map(item => <NavLink key={item.title} item={item} isActive={isActive(item.url)} overrides={tooltipOverrides} />)}
          </CollapsibleGroup>
        )}

        {/* ── Lane Tools ── */}
        {(() => {
          const visibleLaneTools = laneToolItems.filter(item => !item.roles || (user?.role && item.roles.includes(user.role)));
          if (visibleLaneTools.length === 0) return null;
          return (
            <CollapsibleGroup label="Lane Tools">
              {visibleLaneTools.map(item => (
                <NavLink
                  key={item.title}
                  item={item}
                  isActive={isActive(item.url)}
                  overrides={tooltipOverrides}
                  badge={
                    (item.title === "Lane Work Queue" || item.title === "My Procurement")
                      ? unactionedReplyCount
                      : item.title === "Conversations"
                        ? conversationsWaitingCount
                        : item.title === "Carrier Hub"
                          ? pendingIntelCount
                          : undefined
                  }
                  badgeColor={item.title === "Conversations" ? "red" : item.title === "Carrier Hub" ? "red" : "green"}
                />
              ))}
            </CollapsibleGroup>
          );
        })()}

        {/* ── Carrier Intelligence ── */}
        {(() => {
          const visible = carrierIntelItems.filter(item => !item.roles || (user?.role && item.roles.includes(user.role)));
          if (visible.length === 0) return null;
          return (
            <CollapsibleGroup label="Carrier Intelligence">
              {visible.map(item => (
                <NavLink key={item.title} item={item} isActive={isActive(item.url)} overrides={tooltipOverrides} />
              ))}
            </CollapsibleGroup>
          );
        })()}

        {/* ── Admin / Team ── */}
        {(user?.role === "admin" || user?.role === "director" || user?.role === "national_account_manager" || user?.role === "sales" || user?.role === "sales_director") && (
          <CollapsibleGroup label={user?.role === "admin" ? "Admin" : "Team"} defaultOpen={false}>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={location === "/admin/users"} tooltip={navTooltip(user?.role === "admin" ? "User Management" : "My Team", desc("User Management"))}>
                    <Link href="/admin/users" data-testid="link-admin-users">
                      <Users className="h-4 w-4" />
                      <span>{user?.role === "admin" ? "User Management" : "My Team"}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {(user?.role === "admin" || user?.role === "director") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/admin/carriers"} tooltip={navTooltip("Carrier Catalog", desc("Carrier Catalog"))}>
                      <Link href="/admin/carriers" data-testid="link-admin-carriers">
                        <Truck className="h-4 w-4" />
                        <span>Carrier Catalog</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {(user?.role === "admin" || user?.role === "director" || user?.role === "sales_director") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/admin/monitored-mailboxes"} tooltip={navTooltip("Monitored Mailboxes", desc("Monitored Mailboxes"))}>
                      <Link href="/admin/monitored-mailboxes" data-testid="link-admin-monitored-mailboxes">
                        <MailCheck className="h-4 w-4" />
                        <span>Monitored Mailboxes</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {["admin", "director", "national_account_manager", "sales_director", "logistics_manager"].includes(user?.role ?? "") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/admin/available-freight/imports"} tooltip={navTooltip("Freight Import Health", desc("Freight Import Health"))}>
                      <Link href="/admin/available-freight/imports" data-testid="link-admin-freight-imports">
                        <Truck className="h-4 w-4" />
                        <span>Freight Import Health</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {["admin", "director", "sales_director"].includes(user?.role ?? "") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/admin/copilot-analytics"}>
                      <Link href="/admin/copilot-analytics" data-testid="link-copilot-analytics">
                        <Activity className="h-4 w-4" />
                        <span>Copilot Analytics</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {/* AI Center — single consolidated entry point for all AI management
                    (agents, approvals, pods, adapters, admin). Replaces the previous
                    four separate sidebar entries. ValueIQ stays its own rep workspace. */}
                {["admin", "manager", "director", "national_account_manager", "sales_director"].includes(user?.role ?? "") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location.startsWith("/ai")} tooltip={navTooltip("AI Center", "Configure AI agents, approvals, and adapters.")}>
                      <Link href="/ai" data-testid="link-ai-center">
                        <Sparkles className="h-4 w-4" />
                        <span>AI Center</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={location === "/financials"} tooltip={navTooltip("Financials", "Revenue, margin, and financial reports.")}>
                    <Link href="/financials" data-testid="link-financials">
                      <BarChart3 className="h-4 w-4" />
                      <span>Financials</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={location === "/historical-data"} tooltip={navTooltip("Lane Analytics", "Historical lane volumes and pricing trends.")}>
                    <Link href="/historical-data" data-testid="link-historical-data">
                      <History className="h-4 w-4" />
                      <span>Lane Analytics</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {/* Coordinators Corner moved here — role-specific, not main nav */}
                {["admin", "director", "national_account_manager", "logistics_manager", "logistics_coordinator"].includes(user?.role ?? "") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/coordinators-corner"} tooltip={navTooltip("Coordinators Corner", desc("Coordinators Corner"))}>
                      <Link href="/coordinators-corner" data-testid="link-coordinators-corner">
                        <KeyRound className="h-4 w-4" />
                        <span>Coordinators Corner</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {/* PTO Passoff moved here — used infrequently */}
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={location === "/pto-passoff"} tooltip={navTooltip("PTO Passoff", desc("PTO Passoff"))}>
                    <Link href="/pto-passoff" data-testid="link-pto-passoff">
                      <Plane className="h-4 w-4" />
                      <span>PTO Passoff</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {/* Touchpoint History moved here — review tool, not daily nav */}
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={location === "/touchpoint-history"} tooltip={navTooltip("Touchpoint History", desc("Touchpoint History"))}>
                    <Link href="/touchpoint-history" data-testid="link-touchpoint-history">
                      <Phone className="h-4 w-4" />
                      <span>Touchpoint History</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {user?.role === "admin" && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/admin/sidebar-tooltips"} tooltip={navTooltip("Sidebar Tooltips", desc("Sidebar Tooltips"))}>
                      <Link href="/admin/sidebar-tooltips" data-testid="link-admin-sidebar-tooltips">
                        <HelpCircle className="h-4 w-4" />
                        <span>Sidebar Tooltips</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {(user?.role === "admin" || user?.role === "director") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/feedback-inbox"} tooltip={navTooltip("Feedback Inbox", desc("Feedback Inbox"))}>
                      <Link href="/feedback-inbox" data-testid="link-feedback-inbox">
                        <Inbox className="h-4 w-4" />
                        <span>Feedback Inbox</span>
                        {suggestionCount > 0 && (
                          <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-black leading-none" data-testid="badge-feedback-count">
                            {suggestionCount > 9 ? "9+" : suggestionCount}
                          </span>
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
          </CollapsibleGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="p-3 border-t border-sidebar-border space-y-3">
        {user && (
          <div className="flex items-center justify-between group-data-[collapsible=icon]:justify-center">
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="text-sm font-medium truncate" data-testid="text-current-user">{user.name}</p>
              <p className="text-xs text-sidebar-foreground/60">{ROLE_LABELS[user.role] || user.role}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <NotificationBell />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                    onClick={() => setHelpOpen(true)}
                    data-testid="button-help"
                    aria-label="Help & Resources"
                  >
                    <HelpCircle className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" align="center">
                  <div className="max-w-[15rem]">
                    <p className="font-medium">Help &amp; Resources</p>
                    <p className="text-xs text-muted-foreground">{desc("Help & Resources")}</p>
                  </div>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                    onClick={openProfile}
                    data-testid="button-my-profile"
                    aria-label="My profile"
                  >
                    <Settings className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" align="center">
                  <div className="max-w-[15rem]">
                    <p className="font-medium">My Profile</p>
                    <p className="text-xs text-muted-foreground">{desc("My Profile")}</p>
                  </div>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                    onClick={() => logout.mutate()}
                    data-testid="button-logout"
                    aria-label="Sign out"
                  >
                    <LogOut className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" align="center">
                  <div className="max-w-[15rem]">
                    <p className="font-medium">Sign Out</p>
                    <p className="text-xs text-muted-foreground">{desc("Sign Out")}</p>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between group-data-[collapsible=icon]:hidden">
          <span className="text-xs text-sidebar-foreground/60">Theme</span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>

    {/* Help & Resources Dialog */}
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="sm:max-w-sm" data-testid="dialog-help">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4 text-blue-500" />
            Help & Resources
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-1">
          <Link
            href="/tools"
            onClick={() => setHelpOpen(false)}
            className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/50 transition-colors"
            data-testid="link-resources-help"
          >
            <Wrench className="h-4 w-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-sm font-medium">Resources</p>
              <p className="text-xs text-muted-foreground">Templates, guides, and reference materials</p>
            </div>
          </Link>
          <Link
            href="/training"
            onClick={() => setHelpOpen(false)}
            className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/50 transition-colors"
            data-testid="link-training-help"
          >
            <GraduationCap className="h-4 w-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-sm font-medium">Training</p>
              <p className="text-xs text-muted-foreground">Onboarding materials and learning content</p>
            </div>
          </Link>
          <div className="rounded-lg border p-3 space-y-2" data-testid="section-keyboard-shortcuts">
            <div className="flex items-center gap-2 mb-1">
              <Keyboard className="h-4 w-4 text-muted-foreground shrink-0" />
              <p className="text-sm font-medium">Keyboard Shortcuts</p>
            </div>
            {[
              { keys: ["/"], label: "Focus global search" },
              { keys: ["⌘", "K"], label: "Focus global search" },
              { keys: ["Shift", "T"], label: "Log a Touch" },
              { keys: ["Shift", "D"], label: "Go to Dashboard" },
              { keys: ["Shift", "A"], label: "Go to Customers" },
              { keys: ["Shift", "L"], label: "Open Lane Work Queue" },
            ].map(({ keys, label }) => (
              <div key={label + keys.join("")} className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{label}</span>
                <div className="flex items-center gap-1">
                  {keys.map((k, i) => (
                    <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-muted text-muted-foreground">{k}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setHelpOpen(false)} data-testid="button-help-close">Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Profile Dialog */}
    <Dialog open={profileOpen} onOpenChange={(v) => !v && setProfileOpen(false)}>
      <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col overflow-hidden" data-testid="dialog-my-profile">
        <DialogHeader>
          <DialogTitle>My Profile</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2 overflow-y-auto flex-1 min-h-0">
          <div className="space-y-1">
            <p className="text-sm font-medium">{user?.name}</p>
            <p className="text-xs text-muted-foreground">{user?.username}</p>
          </div>
          <div className="space-y-2">
            <Label>Email Signature</Label>
            <SignatureEditor value={signature} onChange={setSignature} />
            <p className="text-xs text-muted-foreground">
              Supports bold, italic, underline, color, alignment, links, and logos. Appended automatically to every email you compose.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Integrations</Label>
            <WebexMyConnection />
            <p className="text-xs text-muted-foreground">
              Need more settings? <Link href="/profile" onClick={() => setProfileOpen(false)} className="underline" data-testid="link-full-profile">Open the full profile page →</Link>
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setProfileOpen(false)} data-testid="button-cancel-profile">
            Cancel
          </Button>
          <Button
            onClick={() => saveSignatureMutation.mutate(signature)}
            disabled={saveSignatureMutation.isPending}
            data-testid="button-save-profile"
          >
            {saveSignatureMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
