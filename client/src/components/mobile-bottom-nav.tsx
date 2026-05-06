import { useLocation } from "wouter";
import { LayoutDashboard, Building2, ListTodo, TrendingUp, Menu } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSidebar } from "@/components/ui/sidebar";

const tabs = [
  { label: "Dashboard", icon: LayoutDashboard, path: "/" },
  { label: "Customers", icon: Building2, path: "/customers" },
  { label: "Tasks", icon: ListTodo, path: "/tasks" },
  { label: "Pipeline", icon: TrendingUp, path: "/top-opportunities" },
] as const;

export function MobileBottomNav() {
  const isMobile = useIsMobile();
  const [location, navigate] = useLocation();
  const { toggleSidebar } = useSidebar();

  if (!isMobile) return null;

  const isActive = (path: string) => {
    if (path === "/") return location === "/";
    return location.startsWith(path);
  };

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-50 border-t bg-background/95 backdrop-blur-sm"
      style={{ borderColor: "hsl(var(--border))", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      data-testid="mobile-bottom-nav"
    >
      <div className="flex items-stretch justify-around" style={{ height: "3.5rem" }}>
      {tabs.map(({ label, icon: Icon, path }) => {
        const active = isActive(path);
        return (
          <button
            key={path}
            onClick={() => navigate(path)}
            className={`flex flex-col items-center justify-center flex-1 gap-0.5 text-[10px] font-medium transition-colors ${
              active
                ? "text-primary"
                : "text-muted-foreground"
            }`}
            data-testid={`nav-${label.toLowerCase()}`}
          >
            <Icon className="h-5 w-5" />
            <span>{label}</span>
          </button>
        );
      })}
      <button
        onClick={toggleSidebar}
        className="flex flex-col items-center justify-center flex-1 gap-0.5 text-[10px] font-medium text-muted-foreground transition-colors"
        data-testid="nav-more"
      >
        <Menu className="h-5 w-5" />
        <span>More</span>
      </button>
      </div>
    </nav>
  );
}

export const MOBILE_NAV_HEIGHT = "3.5rem";
