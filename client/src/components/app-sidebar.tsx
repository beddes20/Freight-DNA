import { ClipboardList, LayoutGrid, Network, Trophy, Users, LogOut, BarChart3, History, Zap, BookOpen, FolderOpen, ExternalLink } from "lucide-react";
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

const menuItems = [
  {
    title: "Dashboard",
    url: "/",
    icon: LayoutGrid,
  },
  {
    title: "Customers",
    url: "/customers",
    icon: Network,
  },
  {
    title: "RFP & Awards",
    url: "/rfp-awards",
    icon: Trophy,
  },
  {
    title: "Research Tasks",
    url: "/research-tasks",
    icon: ClipboardList,
  },
  {
    title: "Top Opportunities",
    url: "/top-opportunities",
    icon: Zap,
  },
];

const externalItems = [
  {
    title: "Playbook",
    url: "https://valuetruck-my.sharepoint.com/:w:/p/ben_beddes/IQAxq4cjYozxTJHB-zYcZtBnAYWpGDvcP6Qj_AW6ULA_Oq8?rtime=s9jxtGeA3kg&ovuser=99d7bd71-9046-4915-be1c-3aae2baf1645%2Cben.beddes%40valuetruck.com&clickparams=eyJBcHBOYW1lIjoiVGVhbXMtRGVza3RvcCIsIkFwcFZlcnNpb24iOiI0OS8yNjAyMDEwMTEyMCIsIkhhc0ZlZGVyYXRlZFVzZXIiOmZhbHNlfQ%3D%3D",
    icon: BookOpen,
    testId: "link-playbook",
  },
  {
    title: "Buckets",
    url: "https://valuetruck-my.sharepoint.com/:p:/r/personal/ben_beddes_valuetruck_com/_layouts/15/Doc2.aspx?action=edit&sourcedoc=%7B088c48cc-a345-4d1a-9947-b49d3cd7112c%7D&wdOrigin=TEAMS-MAGLEV.undefined_ns.rwc&wdExp=TEAMS-TREATMENT&wdhostclicktime=1749156731495&web=1",
    icon: FolderOpen,
    testId: "link-buckets",
  },
];

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  director: "Director",
  national_account_manager: "National Account Manager",
  account_manager: "Account Manager",
};

export function AppSidebar() {
  const [location] = useLocation();
  const { user, logout } = useAuth();

  return (
    <Sidebar>
      <SidebarHeader className="p-4 border-b border-sidebar-border">
        <div className="flex items-center justify-center py-1">
          <img
            src={vtLogoWhite}
            alt="Value Truck"
            className="h-10 w-auto object-contain"
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => {
                const isActive = location === item.url ||
                  (item.url !== "/" && location.startsWith(item.url)) ||
                  (item.url === "/customers" && location.startsWith("/companies/"));
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={item.url} data-testid={`link-${item.title.toLowerCase().replace(/\s/g, "-")}`}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
              {externalItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={item.testId}
                    >
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                      <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {(user?.role === "admin" || user?.role === "director" || user?.role === "national_account_manager" || user?.role === "sales") && (
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
                      <span>Historical Data</span>
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
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate" data-testid="text-current-user">{user.name}</p>
              <p className="text-xs text-sidebar-foreground/60">{ROLE_LABELS[user.role] || user.role}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
              onClick={() => logout.mutate()}
              data-testid="button-logout"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-sidebar-foreground/60">Theme</span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
