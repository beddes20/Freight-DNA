import { ClipboardList, LayoutGrid, Network, Trophy, Users, LogOut, BarChart3, History, Zap, MessagesSquare, ListTodo, TrendingUp, Target, Plane, GraduationCap, Wrench, FileBarChart2 } from "lucide-react";
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
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import vtLogoWhite from "@assets/value-truck-logo-white.png";

const SALES_ROLES = ["admin", "director", "national_account_manager", "account_manager", "sales", "sales_director"];

const navItems = [
  { title: "Dashboard",         url: "/",                 icon: LayoutGrid    },
  { title: "Customers",         url: "/customers",        icon: Network,       roles: SALES_ROLES },
  { title: "Top Opportunities", url: "/top-opportunities",icon: Zap,           roles: SALES_ROLES },
  { title: "1:1 Meetings",      url: "/one-on-one",       icon: MessagesSquare },
  { title: "Tasks",             url: "/tasks",            icon: ListTodo      },
  {
    title: "Team Performance",
    url: "/team-performance",
    icon: TrendingUp,
    roles: ["admin", "director", "national_account_manager", "sales", "sales_director"],
  },
  { title: "Goals",           url: "/goals",      icon: Target         },
  { title: "Report Cards",    url: "/reports",    icon: FileBarChart2, roles: ["admin", "director", "national_account_manager", "sales_director"] },
  { title: "My Report Card",  url: "/report/me",  icon: FileBarChart2, roles: ["account_manager", "sales", "logistics_manager", "logistics_coordinator"] },
  { title: "PTO Passoff",     url: "/pto-passoff",icon: Plane          },
];

const pipelineItems = [
  { title: "RFP & Awards",   url: "/rfp-awards",     icon: Trophy       },
  { title: "Research Tasks", url: "/research-tasks", icon: ClipboardList },
];

const toolItems = [
  { title: "Tools",    url: "/tools",    icon: Wrench        },
  { title: "Training", url: "/training", icon: GraduationCap },
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

function NavLink({ item, isActive }: { item: { title: string; url: string; icon: React.ElementType }; isActive: boolean }) {
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
        <Link href={item.url} data-testid={`link-${item.title.toLowerCase().replace(/[\s&]+/g, "-")}`}>
          <Icon className="h-4 w-4" />
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const [location] = useLocation();
  const { user, logout } = useAuth();

  const isActive = (url: string) =>
    url === "/"
      ? location === "/"
      : location.startsWith(url) || (url === "/customers" && location.startsWith("/companies/"));

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4 border-b border-sidebar-border">
        {/* Expanded sidebar header */}
        <div className="flex flex-col items-center justify-center py-1 gap-1 group-data-[collapsible=icon]:hidden">
          {(user as any)?.organizationSlug === "demo" ? (
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
              <path d="M 74,5 C 108,5 108,41 74,41" fill="none" stroke="#ffb400" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="74" y1="5" x2="74" y2="41" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="60" y1="23" x2="122" y2="23" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round"/>
              <polygon points="116,17 124,23 116,29" fill="#ffb400"/>
              <path d="M 70,23 L 65,17 L 61,23" fill="none" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M 70,23 L 65,29 L 61,23" fill="none" stroke="#ffb400" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>
        {/* Collapsed icon */}
        <div className="hidden group-data-[collapsible=icon]:flex justify-center py-1">
          {(user as any)?.organizationSlug === "demo" ? (
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
                .map(item => <NavLink key={item.title} item={item} isActive={isActive(item.url)} />)}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ── Pipeline (hidden for LM/LC roles) ── */}
        {SALES_ROLES.includes(user?.role ?? "") && (
          <SidebarGroup>
            <SidebarGroupLabel>Pipeline</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pipelineItems.map(item => <NavLink key={item.title} item={item} isActive={isActive(item.url)} />)}
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
                      <span>Numbers</span>
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
        )}
        <div className="flex items-center justify-between group-data-[collapsible=icon]:hidden">
          <span className="text-xs text-sidebar-foreground/60">Theme</span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
