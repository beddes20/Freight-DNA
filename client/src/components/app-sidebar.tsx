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

const navItems = [
  { title: "Dashboard",         url: "/",                 icon: LayoutGrid    },
  { title: "Customers",         url: "/customers",        icon: Network       },
  { title: "Top Opportunities", url: "/top-opportunities",icon: Zap           },
  { title: "1:1 Meetings",      url: "/one-on-one",       icon: MessagesSquare },
  { title: "Tasks",             url: "/tasks",            icon: ListTodo      },
  {
    title: "Team Performance",
    url: "/team-performance",
    icon: TrendingUp,
    roles: ["admin", "director", "national_account_manager", "sales", "sales_director"],
  },
  { title: "Goals",           url: "/goals",      icon: Target         },
  { title: "My Report Card",  url: "/report/me",  icon: FileBarChart2  },
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
        <div className="flex flex-col items-center justify-center py-1 gap-1 group-data-[collapsible=icon]:hidden">
          <img src={vtLogoWhite} alt="Value Truck" className="h-10 w-auto object-contain" />
          <p className="text-[10px] tracking-wide text-sidebar-foreground/60 text-center" data-testid="text-dna-tagline-sidebar">
            <span className="font-bold text-sidebar-foreground/80">DNA</span>
            {" · "}
            <span className="font-bold text-sidebar-foreground/80">D</span>own{" "}
            <span className="font-bold text-sidebar-foreground/80">N</span>ot{" "}
            <span className="font-bold text-sidebar-foreground/80">A</span>cross
          </p>
        </div>
        <div className="hidden group-data-[collapsible=icon]:flex justify-center py-1">
          <img src={vtLogoWhite} alt="VT" className="h-6 w-6 object-contain" />
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

        {/* ── Pipeline ── */}
        <SidebarGroup>
          <SidebarGroupLabel>Pipeline</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {pipelineItems.map(item => <NavLink key={item.title} item={item} isActive={isActive(item.url)} />)}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

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
