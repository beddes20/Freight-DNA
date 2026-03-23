import { useState } from "react";
import {
  LayoutDashboard, Building2, Users, FileText, Trophy, CheckSquare,
  MessageSquare, Target, TrendingUp, Bell, Search, ChevronDown,
  Truck, Star, ArrowUpRight, Phone, Mail, Calendar, ClipboardList,
  BarChart3, Activity, Zap, LogOut, Settings, UserCircle
} from "lucide-react";

const GOLD = "#ffb400";
const GOLD_LIGHT = "#ffc333";
const BLACK = "#0a0a0a";
const SIDEBAR_BG = "#111111";
const SIDEBAR_HOVER = "#1e1e1e";
const SIDEBAR_ACTIVE_BG = "#1f1800";
const HEADER_BG = "#0a0a0a";

const navItems = [
  { icon: LayoutDashboard, label: "Dashboard", active: true },
  { icon: Building2, label: "Customers" },
  { icon: Users, label: "Team Performance" },
  { icon: FileText, label: "RFPs & Awards" },
  { icon: Trophy, label: "Goals" },
  { icon: Target, label: "1:1 Sessions" },
  { icon: MessageSquare, label: "Callouts Feed" },
  { icon: CheckSquare, label: "Tasks" },
  { icon: TrendingUp, label: "Financials" },
  { icon: BarChart3, label: "Rep Reports" },
];

const kpiCards = [
  { label: "Total Accounts", value: "142", change: "+3", up: true, icon: Building2 },
  { label: "Touchpoints (MTD)", value: "87", change: "+12", up: true, icon: Phone },
  { label: "Margin (MTD)", value: "$184K", change: "+18%", up: true, icon: TrendingUp },
  { label: "Open RFPs", value: "7", change: "-2", up: false, icon: FileText },
];

const recentTouchpoints = [
  { contact: "Sarah Mitchell", company: "Acuity Brands", type: "Call", time: "2h ago", meaningful: true },
  { contact: "Derek Pham", company: "Dewell Corp", type: "Email", time: "4h ago", meaningful: false },
  { contact: "Lisa Torres", company: "Pacific Coast Freight", type: "Site Visit", time: "Yesterday", meaningful: true },
  { contact: "Marcus Webb", company: "Midwest Logistics", type: "Text", time: "Yesterday", meaningful: false },
];

const alerts = [
  { text: "RFP due in 3 days", sub: "Pacific Coast Q2 2026", color: "red" },
  { text: "5 contacts need attention", sub: "No touch in 14+ days", color: "amber" },
  { text: "Goal milestone reached!", sub: "Mason Moore — 90% margin goal", color: "green" },
];

export function BlackGold() {
  const [activeNav, setActiveNav] = useState("Dashboard");

  return (
    <div className="flex h-screen w-full overflow-hidden" style={{ fontFamily: "'Inter', sans-serif", background: "#f0f2f5" }}>
      {/* Sidebar */}
      <div className="flex flex-col w-56 flex-shrink-0" style={{ background: SIDEBAR_BG, borderRight: "1px solid #222" }}>
        {/* Logo */}
        <div className="flex items-center px-3 py-3" style={{ borderBottom: "1px solid #222" }}>
          <img
            src="/__mockup/images/vt-logo-full.png"
            alt="Value Truck — DNA Down Not Across"
            className="w-full"
            style={{ maxHeight: "56px", objectFit: "contain", objectPosition: "left center" }}
          />
        </div>

        {/* Search */}
        <div className="px-3 py-3">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded" style={{ background: "#1a1a1a", border: "1px solid #2a2a2a" }}>
            <Search className="w-3 h-3 flex-shrink-0" style={{ color: "#666" }} />
            <span className="text-xs" style={{ color: "#555" }}>Search...</span>
          </div>
        </div>

        {/* Nav Items */}
        <nav className="flex-1 px-2 pb-2 overflow-y-auto space-y-0.5">
          {navItems.map(({ icon: Icon, label }) => {
            const isActive = activeNav === label;
            return (
              <button
                key={label}
                onClick={() => setActiveNav(label)}
                className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded text-left transition-all"
                style={{
                  background: isActive ? SIDEBAR_ACTIVE_BG : "transparent",
                  color: isActive ? GOLD : "#f0f0f0",
                  borderLeft: isActive ? `3px solid ${GOLD}` : "3px solid transparent",
                  paddingLeft: isActive ? "9px" : "10px",
                }}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = SIDEBAR_HOVER; }}
                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-xs font-medium">{label}</span>
              </button>
            );
          })}
        </nav>

        {/* User Footer */}
        <div className="px-3 py-3" style={{ borderTop: "1px solid #222" }}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={{ background: GOLD, color: BLACK }}>
              BB
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold truncate" style={{ color: "#fff" }}>Ben Beddes</div>
              <div className="text-xs truncate" style={{ color: "#666", fontSize: "10px" }}>Admin</div>
            </div>
            <Settings className="w-3.5 h-3.5 flex-shrink-0" style={{ color: "#555" }} />
          </div>
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header */}
        <div className="flex items-center justify-between px-5 flex-shrink-0" style={{ background: HEADER_BG, borderBottom: "1px solid #222", height: "52px" }}>
          {/* Left: page title */}
          <div className="flex-shrink-0">
            <h1 className="text-sm font-semibold" style={{ color: "#fff" }}>Dashboard</h1>
            <p className="text-xs" style={{ color: "#555" }}>Monday, March 23, 2026</p>
          </div>

          {/* Center: mantras */}
          <div className="flex items-center gap-2 mx-6 overflow-hidden">
            {["Service Exceptionally", "Move Fast", "Build Relationships", "Hunt Opportunities", "Grow Relentlessly"].map((m, i, arr) => (
              <span key={m} className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: GOLD_LIGHT }}>{m}</span>
                {i < arr.length - 1 && <span className="text-xs" style={{ color: "#333" }}>•</span>}
              </span>
            ))}
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold"
              style={{ background: GOLD, color: BLACK, border: "none" }}
            >
              <Zap className="w-3 h-3" />
              Log Touch
            </button>
            <div className="relative">
              <Bell className="w-4 h-4" style={{ color: "#666" }} />
              <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full flex items-center justify-center text-white" style={{ background: "#ef4444", fontSize: "8px" }}>3</span>
            </div>
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: GOLD, color: BLACK }}>
              BB
            </div>
          </div>
        </div>

        {/* Hero Banner */}
        <div className="px-5 pt-4 pb-4 flex-shrink-0" style={{ background: "#0a0a0a", borderBottom: "1px solid #1a1a1a" }}>
          <div className="flex items-center gap-4">
            {/* VT Circle Emblem */}
            <div className="flex-shrink-0" style={{ width: "60px", height: "60px", borderRadius: "50%", overflow: "hidden", boxShadow: `0 0 20px rgba(255,180,0,0.3)` }}>
              <img src="/__mockup/images/vt-logo-circle.png" alt="VT" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
            {/* Text */}
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: GOLD }}>Good morning, Ben</span>
              </div>
              <h2 className="text-lg font-bold" style={{ color: "#fff" }}>Your sales pulse for today</h2>
            </div>
            {/* Streak */}
            <div className="flex items-center gap-2 text-xs flex-shrink-0" style={{ color: "#666" }}>
              <Activity className="w-3.5 h-3.5" style={{ color: GOLD }} />
              <span>Streak: <span style={{ color: GOLD, fontWeight: 700 }}>5 days</span></span>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {/* Alert strip */}
          <div className="flex gap-3">
            {alerts.map((a, i) => (
              <div key={i} className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: "#fff", border: `1px solid ${a.color === "red" ? "#fecaca" : a.color === "amber" ? "#fde68a" : "#bbf7d0"}` }}>
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: a.color === "red" ? "#ef4444" : a.color === "amber" ? GOLD : "#22c55e" }} />
                <div>
                  <p className="text-xs font-semibold text-gray-800">{a.text}</p>
                  <p className="text-xs text-gray-500">{a.sub}</p>
                </div>
              </div>
            ))}
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-4 gap-3">
            {kpiCards.map(({ label, value, change, up, icon: Icon }) => (
              <div key={label} className="rounded-xl p-4 shadow-sm" style={{ background: "#fff", border: "1px solid #e5e7eb" }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-500 font-medium">{label}</span>
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "#1f1800" }}>
                    <Icon className="w-3.5 h-3.5" style={{ color: GOLD }} />
                  </div>
                </div>
                <div className="text-xl font-bold text-gray-900">{value}</div>
                <div className="flex items-center gap-1 mt-1">
                  <ArrowUpRight className="w-3 h-3" style={{ color: up ? "#22c55e" : "#ef4444", transform: up ? "none" : "rotate(90deg)" }} />
                  <span className="text-xs font-medium" style={{ color: up ? "#22c55e" : "#ef4444" }}>{change} this month</span>
                </div>
              </div>
            ))}
          </div>

          {/* Bottom two panels */}
          <div className="grid grid-cols-3 gap-4">
            {/* Recent Touchpoints */}
            <div className="col-span-2 rounded-xl overflow-hidden shadow-sm" style={{ background: "#fff", border: "1px solid #e5e7eb" }}>
              <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid #f0f0f0" }}>
                <h3 className="text-sm font-semibold text-gray-800">Recent Touchpoints</h3>
                <button className="text-xs font-medium" style={{ color: GOLD }}>View all →</button>
              </div>
              <div className="divide-y divide-gray-50">
                {recentTouchpoints.map((t, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={{ background: "#1f1800", color: GOLD }}>
                      {t.contact[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-800 truncate">{t.contact}</p>
                      <p className="text-xs text-gray-400 truncate">{t.company}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {t.meaningful && (
                        <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: "#dcfce7", color: "#166534" }}>Meaningful</span>
                      )}
                      <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: "#f3f4f6", color: "#6b7280" }}>{t.type}</span>
                      <span className="text-xs text-gray-400">{t.time}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Goal Progress */}
            <div className="rounded-xl overflow-hidden shadow-sm" style={{ background: "#fff", border: "1px solid #e5e7eb" }}>
              <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid #f0f0f0" }}>
                <h3 className="text-sm font-semibold text-gray-800">Goal Progress</h3>
                <Star className="w-3.5 h-3.5" style={{ color: GOLD }} />
              </div>
              <div className="p-4 space-y-4">
                {[
                  { name: "Mason Moore", metric: "Margin", pct: 134, color: "#22c55e" },
                  { name: "Adan Castaneda", metric: "Margin", pct: 97, color: GOLD },
                  { name: "Legrand Toia", metric: "Loads", pct: 63, color: "#ef4444" },
                ].map((g, i) => (
                  <div key={i}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs font-medium text-gray-700">{g.name}</span>
                      <span className="text-xs font-bold" style={{ color: g.color }}>{g.pct}%</span>
                    </div>
                    <div className="h-1.5 rounded-full" style={{ background: "#f0f0f0" }}>
                      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(g.pct, 100)}%`, background: g.color }} />
                    </div>
                    <span className="text-xs text-gray-400">{g.metric}</span>
                  </div>
                ))}

                {/* Accent CTA */}
                <button className="w-full mt-2 py-2 rounded-lg text-xs font-semibold" style={{ background: GOLD, color: BLACK }}>
                  Set New Goals
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
