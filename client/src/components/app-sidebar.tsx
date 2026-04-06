import { ClipboardList, LayoutGrid, Network, Trophy, Users, LogOut, BarChart3, History, Zap, MessagesSquare, ListTodo, TrendingUp, Target, Plane, GraduationCap, Wrench, FileBarChart2, KeyRound, Inbox, Crosshair, LineChart, MapPin, Truck, Calendar, Medal, Settings } from "lucide-react";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
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
} from "@/components/ui/sidebar";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { useNotificationCounts } from "@/hooks/use-notifications";
import { NotificationBell } from "@/components/notification-bell";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import vtLogoWhite from "@assets/value-truck-logo-white.png";

const SALES_ROLES = ["admin", "director", "national_account_manager", "account_manager", "sales", "sales_director"];

const PROSPECTS_ROLES = ["admin", "sales", "sales_director"];

const navItems = [
  { title: "Dashboard",         url: "/",                 icon: LayoutGrid    },
  { title: "Sales Pipeline",    url: "/prospects",        icon: Crosshair,     roles: PROSPECTS_ROLES },
  { title: "Customers",         url: "/customers",        icon: Network,       roles: SALES_ROLES },
  { title: "Top Opportunities", url: "/top-opportunities",icon: Zap,           roles: SALES_ROLES },
  { title: "1:1's",             url: "/one-on-one",       icon: MessagesSquare },
  { title: "Tasks",             url: "/tasks",            icon: ListTodo      },
  { title: "Touch History",     url: "/touchpoint-history", icon: History      },
  {
    title: "Team Performance",
    url: "/team-performance",
    icon: TrendingUp,
    roles: ["admin", "director", "national_account_manager", "sales", "sales_director"],
  },
  { title: "Goals",           url: "/goals",      icon: Target         },
  { title: "My Report Card",  url: "/report/me",  icon: FileBarChart2, roles: ["account_manager", "sales", "logistics_manager", "logistics_coordinator"] },
  { title: "PTO Passoff",     url: "/pto-passoff",icon: Plane          },
  {
    title: "Coordinators Corner",
    url: "/coordinators-corner",
    icon: KeyRound,
    roles: ["admin", "director", "national_account_manager", "logistics_manager", "logistics_coordinator"],
  },
];

const pipelineItems = [
  { title: "RFP & Awards",       url: "/rfp-awards",         icon: Trophy,    roles: undefined },
  { title: "RFP Calendar",       url: "/rfp-calendar",       icon: Calendar,  roles: undefined },
  { title: "Rep Scorecard",      url: "/rep-scorecard",      icon: Medal,     roles: ["admin", "director", "national_account_manager", "sales_director"] },
  { title: "Pipeline Analytics", url: "/pipeline-analytics", icon: LineChart, roles: ["admin", "sales_director"] },
];

const laneToolItems = [
  { title: "Lane Research",       url: "/research-tasks",      icon: ClipboardList, roles: undefined },
  { title: "RFP Lane Search",     url: "/rfp-lane-search",     icon: MapPin,        roles: undefined },
  { title: "Carrier Lane Search", url: "/carrier-lane-search", icon: Truck,         roles: undefined },
];

const toolItems = [
  { title: "Resources", url: "/tools",    icon: Wrench        },
  { title: "Training",  url: "/training", icon: GraduationCap },
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

function NotificationBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:-top-1 group-data-[collapsible=icon]:-right-1 group-data-[collapsible=icon]:h-4 group-data-[collapsible=icon]:min-w-4 group-data-[collapsible=icon]:text-[9px]"
      data-testid="badge-notification-count"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function NavLink({ item, isActive, badge }: { item: { title: string; url: string; icon: React.ElementType }; isActive: boolean; badge?: number }) {
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
        <Link href={item.url} data-testid={`link-${item.title.toLowerCase().replace(/[\s&]+/g, "-")}`} className="relative">
          <Icon className="h-4 w-4" />
          <span>{item.title}</span>
          {badge !== undefined && <NotificationBadge count={badge} />}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const { taskCount, suggestionCount } = useNotificationCounts();
  const { toast } = useToast();
  const [profileOpen, setProfileOpen] = useState(false);
  const [signature, setSignature] = useState("");

  const saveSignatureMutation = useMutation({
    mutationFn: async (sig: string) => {
      const res = await apiRequest("PATCH", `/api/users/${user?.id}`, { emailSignature: sig.trim() || null });
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
      : location.startsWith(url) || (url === "/customers" && location.startsWith("/companies/"));

  return (
    <>
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4 border-b border-sidebar-border">
        {/* Expanded sidebar header */}
        <div className="flex flex-col items-center justify-center py-1 gap-1 group-data-[collapsible=icon]:hidden">
          {user?.organizationSlug === "demo" ? (
            <div className="flex flex-col items-center gap-0.5">
              <svg viewBox="0 0 120 36" width="110" height="33" aria-label="Freight DNA">
                {/* Stylized truck outline */}
                <rect x="2" y="10" width="70" height="20" rx="3" fill="none" stroke="#ffb400" strokeWidth="2"/>
                <rect x="72" y="16" width="26" height="14" rx="2" fill="none" stroke="#ffb400" strokeWidth="2"/>
                <circle cx="18" cy="32" r="4" fill="#ffb400"/>
                <circle cx="52" cy="32" r="4" fill="#ffb400"/>
                <circle cx="88" cy="32" r="4" fill="#ffb400"/>
                <line x1="72" y1="23" x2="72" y2="30" stroke="#ffb400" strokeWidth="1.5"/>
                {/* DNA double helix hint */}
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
          {/* Farmer → Hunter icon */}
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
                .filter(item => !('roles' in item) || (user?.role && (item as any).roles.includes(user.role)))
                .map(item => (
                  <NavLink
                    key={item.title}
                    item={item}
                    isActive={isActive(item.url)}
                    badge={item.title === "Tasks" ? taskCount : undefined}
                  />
                ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ── Pipeline (hidden for LM/LC roles) ── */}
        {SALES_ROLES.includes(user?.role ?? "") && (
          <SidebarGroup>
            <SidebarGroupLabel>Pipeline</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pipelineItems
                  .filter(item => !item.roles || (user?.role && item.roles.includes(user.role)))
                  .map(item => <NavLink key={item.title} item={item} isActive={isActive(item.url)} />)}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* ── Lane Tools (hidden for LM/LC roles) ── */}
        {SALES_ROLES.includes(user?.role ?? "") && (
          <SidebarGroup>
            <SidebarGroupLabel>Lane Tools</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {laneToolItems
                  .filter(item => !item.roles || (user?.role && item.roles.includes(user.role)))
                  .map(item => <NavLink key={item.title} item={item} isActive={isActive(item.url)} />)}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* ── Tools ── */}
        <SidebarGroup>
          <SidebarGroupLabel>Tools</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {toolItems.map(item => <NavLink key={item.title} item={item} isActive={isActive(item.url)} />)}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ── Admin / Team ── */}
        {(user?.role === "admin" || user?.role === "director" || user?.role === "national_account_manager" || user?.role === "sales" || user?.role === "sales_director") && (
          <SidebarGroup>
            <SidebarGroupLabel>{user?.role === "admin" ? "Admin" : "Team"}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={location === "/admin/users"}>
                    <Link href="/admin/users" data-testid="link-admin-users">
                      <Users className="h-4 w-4" />
                      <span>{user?.role === "admin" ? "User Management" : "My Team"}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={location === "/financials"}>
                    <Link href="/financials" data-testid="link-financials">
                      <BarChart3 className="h-4 w-4" />
                      <span>Financials</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={location === "/historical-data"}>
                    <Link href="/historical-data" data-testid="link-historical-data">
                      <History className="h-4 w-4" />
                      <span>Lane Analytics</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {(user?.role === "admin" || user?.role === "director") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/feedback-inbox"}>
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
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
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
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                onClick={openProfile}
                data-testid="button-my-profile"
                title="My profile"
              >
                <Settings className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                onClick={() => logout.mutate()}
                data-testid="button-logout"
                title="Log out"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between group-data-[collapsible=icon]:hidden">
          <span className="text-xs text-sidebar-foreground/60">Theme</span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>

    <Dialog open={profileOpen} onOpenChange={(v) => !v && setProfileOpen(false)}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-my-profile">
        <DialogHeader>
          <DialogTitle>My Profile</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">{user?.name}</p>
            <p className="text-xs text-muted-foreground">{user?.username}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="email-signature">Email Signature</Label>
            <Textarea
              id="email-signature"
              placeholder="e.g. John Smith | Value Truck&#10;📞 555-867-5309"
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              rows={5}
              data-testid="textarea-profile-email-signature"
            />
            <p className="text-xs text-muted-foreground">
              Appended automatically to every email you compose. Leave blank to send without a signature.
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
