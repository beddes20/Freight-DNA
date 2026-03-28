import { useState } from "react";
import { useLocation } from "wouter";
import {
  TrendingUp, Network, FileSearch, MousePointerClick, BarChart3,
  Target, Map, Users, CheckCircle, ClipboardList, CalendarCheck,
  BookOpen, Zap, ChevronRight, TrendingUp as CareerIcon,
  GitBranch, Phone, Key, Megaphone, Sparkles, Bot, ArrowRight,
  LayoutGrid, MessagesSquare, ListTodo, Trophy, Wrench, GraduationCap,
  UserCog, LineChart,
} from "lucide-react";
import ScheduleDemoModal from "@/components/ScheduleDemoModal";

const stats = [
  { value: "15+", label: "Platform Modules" },
  { value: "360°", label: "Account Visibility" },
  { value: "AI-Powered", label: "Analysis & Alerts" },
  { value: "Built for", label: "Freight Brokers" },
];

const features = [
  {
    icon: Network,
    title: "Org Chart & Relationship Mapping",
    description: "Map every stakeholder — procurement, operations, finance — and track who owns each decision. Know your accounts down, not across.",
  },
  {
    icon: FileSearch,
    title: "RFP Intelligence Engine",
    description: "Upload RFP lane data, analyze corridors, track bid history, and compare awards. Walk into every bid knowing exactly how to win.",
  },
  {
    icon: MousePointerClick,
    title: "Touchpoint Tracking",
    description: "Log a touchpoint in seconds from anywhere in the platform with the global Log Touch button. Calls, emails, texts, and site visits tracked in one click — automated \"Needs Attention\" alerts surface contacts going cold before it costs you freight.",
  },
  {
    icon: BarChart3,
    title: "Team Performance Dashboards",
    description: "Real-time dashboards show activity metrics, pipeline health, and rep rankings so leaders can coach with precision.",
  },
  {
    icon: Target,
    title: "Goals & Accountability",
    description: "Set quarterly targets for load count, margin, touchpoints, and new contacts — then watch progress auto-track against live data.",
  },
  {
    icon: Map,
    title: "Lane Analytics",
    description: "Identify top-volume corridors, spot market gaps, and build targeted proposals backed by historical freight data.",
  },
  {
    icon: CareerIcon,
    title: "Career Progression",
    description: "Track talent development from day one. Career conversations, progression milestones, and historical performance logs give managers a complete picture of every rep's growth trajectory — not just last quarter's numbers.",
  },
];

const modules = [
  { icon: Users, name: "Customers", desc: "Full account profiles with financials, contacts, modes, and intelligence notes." },
  { icon: Zap, name: "Top Opportunities", desc: "Auto-surfaced accounts with the highest untapped wallet share potential." },
  { icon: CalendarCheck, name: "1:1's", desc: "Structured NAM-AM session topics, follow-ups, and threaded discussion threads." },
  { icon: ClipboardList, name: "Tasks", desc: "Assign and track account-linked tasks with due dates and priority levels." },
  { icon: BarChart3, name: "Report Cards", desc: "Per-rep scorecards showing load count, margin, touchpoints, and goal progress." },
  { icon: BookOpen, name: "PTO Passoff", desc: "Structured handoff documents so accounts never slip during out-of-office periods." },
  { icon: FileSearch, name: "RFP & Awards", desc: "Full pipeline management for bids, awards, and lane-level analysis." },
  { icon: Map, name: "Lane Analytics", desc: "Heat maps and corridor analysis from financial and RFP upload data." },
  { icon: CareerIcon, name: "Career Progression", desc: "Career conversations, progression tracking, and performance history for every rep on your team." },
  { icon: BookOpen, name: "Playbook & Buckets", desc: "External resource links, sales playbooks, and account segmentation buckets for structured selling." },
  { icon: GitBranch, name: "Org Charts & Contacts", desc: "Visual org charts for every account — map decision-makers, influencers, and key contacts across the organization." },
  { icon: Phone, name: "Touchpoint Log", desc: "Every call, email, text, and site visit in a unified timeline. AI flags cold contacts before they cost you freight." },
  { icon: Key, name: "Portal Credentials (Coordinator's Corner)", desc: "Securely store and access customer portal logins, carrier onboarding credentials, and spot process details in one place." },
  { icon: BarChart3, name: "Team Performance", desc: "Period-over-period activity and revenue tracking with rep rankings — turn coaching from opinions into evidence." },
  { icon: Target, name: "Goals & Accountability", desc: "Set and auto-track targets for loads, margin, touchpoints, and new contacts against live platform data." },
  { icon: Megaphone, name: "Callouts / Trends Feed", desc: "Broadcast wins, flag at-risk accounts, and share market intel across your team in real time." },
];

const howItWorks = [
  {
    step: "01",
    title: "Map your accounts",
    body: "Build visual org charts, capture every contact's role and influence, log portal credentials and carrier intel in Coordinator's Corner — all the account DNA your team needs, right where they work.",
  },
  {
    step: "02",
    title: "Track every touchpoint",
    body: "Every call, email, text, and site visit is logged in seconds. Freight DNA's AI automatically flags contacts going cold — so your reps engage before the relationship costs you freight.",
  },
  {
    step: "03",
    title: "Win more freight",
    body: "AI-powered analysis surfaces wallet share gaps, RFP intelligence shows you where to bid and how to win, and real-time scoring tells you which accounts to prioritize today — not next quarter.",
  },
];

const personas = [
  {
    role: "NAMs & Account Executives",
    tagline: "Your whole book in one place.",
    bullets: [
      "Full account org charts with contact ownership and decision-maker mapping",
      "One-click touchpoint logging from anywhere — calls, emails, texts, site visits",
      "AI-flagged cold contacts so no relationship slips through the cracks",
      "Wallet share scoring and RFP history to walk into every conversation prepared",
    ],
  },
  {
    role: "Directors & Managers",
    tagline: "Coach with data, not opinions.",
    bullets: [
      "Real-time team performance dashboards with period-over-period comparisons",
      "Rep scorecards covering loads, margin, touchpoints, and goal progress",
      "1:1 tooling with threaded follow-ups and structured agendas",
      "Career progression tracking to develop talent from day one",
    ],
  },
  {
    role: "Admins & Operations",
    tagline: "Keep the platform running clean.",
    bullets: [
      "Multi-team and multi-org support with role-based access control",
      "Centralized portal credentials management via Coordinator's Corner",
      "PTO passoff workflows so accounts never slip during coverage gaps",
      "Playbook and bucket configuration to standardize how your team sells",
    ],
  },
];

export default function LandingPage() {
  const [, navigate] = useLocation();
  const [demoOpen, setDemoOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#0a0a0a", color: "#fff" }}>

      <ScheduleDemoModal open={demoOpen} onClose={() => setDemoOpen(false)} />

      {/* Fixed top nav */}
      <header
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 md:px-12 h-16"
        style={{ background: "rgba(10,10,10,0.92)", borderBottom: "1px solid rgba(255,180,0,0.12)", backdropFilter: "blur(8px)" }}
      >
        <div className="flex items-center gap-3" data-testid="nav-wordmark">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-full"
            style={{ border: "1.5px solid #ffb400", background: "#111" }}
          >
            <TrendingUp className="w-4 h-4" style={{ color: "#ffb400" }} />
          </div>
          <span className="text-base font-bold tracking-tight" style={{ color: "#ffb400" }}>
            freight · dna
          </span>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="/login"
            onClick={e => { e.preventDefault(); navigate("/login"); }}
            className="text-sm font-semibold px-4 py-2 rounded transition-all duration-150"
            style={{ border: "1px solid rgba(255,180,0,0.5)", color: "#ffb400", background: "transparent" }}
            data-testid="link-nav-login"
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = "#ffb400";
              (e.currentTarget as HTMLElement).style.color = "#0a0a0a";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
              (e.currentTarget as HTMLElement).style.color = "#ffb400";
            }}
          >
            Login
          </a>
        </div>
      </header>

      {/* Hero */}
      <section className="flex flex-col items-center justify-center text-center pt-40 pb-24 px-6 relative" style={{ minHeight: "88vh" }}>
        <div
          className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full"
          style={{ background: "radial-gradient(ellipse, rgba(255,180,0,0.07) 0%, transparent 70%)" }}
        />

        <p
          className="text-xs uppercase tracking-[0.22em] font-semibold mb-6"
          style={{ color: "rgba(255,180,0,0.65)" }}
          data-testid="text-hero-eyebrow"
        >
          Sales Intelligence for Freight Brokers
        </p>

        <h1
          className="text-5xl md:text-7xl font-extrabold leading-none tracking-tight mb-6"
          style={{ letterSpacing: "-0.03em" }}
          data-testid="text-hero-headline"
        >
          Know your customers
          <br />
          <span style={{ color: "#ffc333" }}>down, not across.</span>
        </h1>

        <p
          className="max-w-xl text-lg md:text-xl leading-relaxed mb-10"
          style={{ color: "rgba(255,255,255,0.5)" }}
          data-testid="text-hero-subheadline"
        >
          In today's freight market, the fastest path to exponential growth isn't chasing new logos — it's unlocking the wallet share you're leaving behind in the accounts you already own. Freight DNA gives your team the relationship intelligence and competitive data to grow deeper, not just wider.
        </p>

        <div className="flex items-center gap-4">
          <button
            onClick={() => setDemoOpen(true)}
            className="text-sm font-bold px-7 py-3 rounded transition-all duration-150"
            style={{ background: "#ffc333", color: "#0a0a0a" }}
            data-testid="button-hero-schedule-demo"
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#ffb400"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#ffc333"; }}
          >
            Schedule Demo
          </button>
          <a
            href="/login"
            onClick={e => { e.preventDefault(); navigate("/login"); }}
            className="text-sm font-semibold px-7 py-3 rounded transition-all duration-150"
            style={{ border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)" }}
            data-testid="button-hero-cta"
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.35)";
              (e.currentTarget as HTMLElement).style.color = "#fff";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.15)";
              (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.7)";
            }}
          >
            Get Started
          </a>
        </div>
      </section>

      {/* Stats bar */}
      <div style={{ borderTop: "1px solid rgba(255,180,0,0.12)", borderBottom: "1px solid rgba(255,180,0,0.12)", background: "#0d0d0d" }}>
        <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-4 divide-x" style={{ borderColor: "rgba(255,180,0,0.1)" }}>
          {stats.map((s, i) => (
            <div key={i} className="flex flex-col items-center justify-center py-8 px-4 text-center" data-testid={`stat-${i}`}>
              <span className="text-2xl md:text-3xl font-extrabold" style={{ color: "#ffc333", letterSpacing: "-0.02em" }}>{s.value}</span>
              <span className="text-xs mt-1 uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.35)" }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Down, Not Across Philosophy */}
      <section className="py-20 px-6 md:px-12 max-w-5xl mx-auto w-full text-center" data-testid="section-dna-philosophy">
        <div
          className="relative rounded-2xl px-10 py-14 md:py-16 overflow-hidden"
          style={{ background: "#0d0d0d", border: "1px solid rgba(255,180,0,0.18)" }}
        >
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: "radial-gradient(ellipse at center, rgba(255,180,0,0.06) 0%, transparent 70%)" }}
          />
          <p
            className="text-xs uppercase tracking-[0.22em] font-semibold mb-5"
            style={{ color: "rgba(255,180,0,0.6)" }}
          >
            The DNA Philosophy
          </p>
          <h2
            className="text-3xl md:text-5xl font-extrabold mb-6 tracking-tight leading-tight"
            style={{ letterSpacing: "-0.03em" }}
            data-testid="text-dna-philosophy-heading"
          >
            New logos are expensive.<br />
            <span style={{ color: "#ffc333" }}>Depth is exponential.</span>
          </h2>
          <p
            className="text-base md:text-lg leading-relaxed max-w-2xl mx-auto mb-8"
            style={{ color: "rgba(255,255,255,0.5)" }}
            data-testid="text-dna-philosophy-body"
          >
            In the current freight market, the brokers pulling ahead aren't the ones with the longest prospect list.
            They're the ones who know their existing accounts better than anyone — who ships what, where, how often, and through whom.
            Every percentage point of wallet share you unlock from a current account costs a fraction of what a new logo takes to close.
            Freight DNA is built to help your team go <em style={{ color: "rgba(255,255,255,0.75)", fontStyle: "normal", fontWeight: 600 }}>down, not across</em> — and grow exponentially because of it.
          </p>
          <div
            className="inline-flex items-center gap-3 px-5 py-2.5 rounded-full text-xs font-bold uppercase tracking-widest"
            style={{ background: "rgba(255,195,51,0.1)", border: "1px solid rgba(255,195,51,0.25)", color: "#ffc333" }}
          >
            <span>DNA</span>
            <span style={{ color: "rgba(255,180,0,0.35)" }}>·</span>
            <span>Down Not Across</span>
          </div>
        </div>
      </section>

      {/* Divider */}
      <div className="w-full px-6 md:px-12">
        <div style={{ height: "1px", background: "rgba(255,180,0,0.12)" }} />
      </div>

      {/* Platform Preview */}
      <section className="py-24 px-6 md:px-12 max-w-6xl mx-auto w-full">
        <p className="text-xs uppercase tracking-[0.22em] font-semibold mb-4 text-center" style={{ color: "rgba(255,180,0,0.65)" }}>
          Inside the Platform
        </p>
        <h2
          className="text-3xl md:text-4xl font-bold text-center mb-4 tracking-tight"
          style={{ letterSpacing: "-0.02em" }}
          data-testid="text-platform-heading"
        >
          One platform. Every tool your team needs.
        </h2>
        <p className="text-center text-sm mb-16 max-w-lg mx-auto" style={{ color: "rgba(255,255,255,0.4)" }}>
          Freight DNA is purpose-built for transportation brokerage sales — not a generic CRM bolted on top of someone else's workflow.
        </p>

        <div className="flex flex-col lg:flex-row gap-10 items-start">
          {/* Sidebar mockup */}
          <div
            className="flex-shrink-0 rounded-xl overflow-hidden w-48 md:w-52"
            style={{ background: "#111", border: "1px solid rgba(255,180,0,0.15)", boxShadow: "0 0 40px rgba(255,180,0,0.06)" }}
            data-testid="img-platform-sidebar"
          >
            {/* Header */}
            <div className="px-4 py-3 border-b" style={{ borderColor: "rgba(255,180,0,0.12)" }}>
              <span className="text-xs font-bold tracking-tight" style={{ color: "#ffb400" }}>freight · dna</span>
              <p className="text-[9px] mt-0.5" style={{ color: "rgba(255,255,255,0.3)" }}>DNA · Down Not Across</p>
            </div>
            {/* Nav items */}
            <div className="py-2 px-2">
              {[
                { icon: LayoutGrid, label: "Dashboard", active: true },
                { icon: Users, label: "Customers" },
                { icon: Zap, label: "Top Opportunities" },
                { icon: MessagesSquare, label: "1:1's" },
                { icon: ListTodo, label: "Tasks" },
                { icon: TrendingUp, label: "Team Performance" },
                { icon: Target, label: "Goals" },
                { icon: BarChart3, label: "Report Cards" },
                { icon: BookOpen, label: "PTO Passoff" },
              ].map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-[10px] font-medium"
                  style={{
                    background: item.active ? "rgba(255,180,0,0.15)" : "transparent",
                    color: item.active ? "#ffb400" : "rgba(255,255,255,0.55)",
                  }}
                >
                  <item.icon className="w-3 h-3 flex-shrink-0" />
                  <span>{item.label}</span>
                </div>
              ))}
              <p className="text-[8px] uppercase tracking-widest px-2 pt-3 pb-1" style={{ color: "rgba(255,180,0,0.4)" }}>Pipeline</p>
              {[
                { icon: Trophy, label: "RFP & Awards" },
                { icon: ClipboardList, label: "Lane Research" },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded text-[10px] font-medium" style={{ color: "rgba(255,255,255,0.55)" }}>
                  <item.icon className="w-3 h-3 flex-shrink-0" />
                  <span>{item.label}</span>
                </div>
              ))}
              <p className="text-[8px] uppercase tracking-widest px-2 pt-3 pb-1" style={{ color: "rgba(255,180,0,0.4)" }}>Tools</p>
              {[
                { icon: Wrench, label: "Resources" },
                { icon: GraduationCap, label: "Training" },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded text-[10px] font-medium" style={{ color: "rgba(255,255,255,0.55)" }}>
                  <item.icon className="w-3 h-3 flex-shrink-0" />
                  <span>{item.label}</span>
                </div>
              ))}
              <p className="text-[8px] uppercase tracking-widest px-2 pt-3 pb-1" style={{ color: "rgba(255,180,0,0.4)" }}>Admin</p>
              {[
                { icon: UserCog, label: "User Management" },
                { icon: LineChart, label: "Financials" },
                { icon: Map, label: "Lane Analytics" },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded text-[10px] font-medium" style={{ color: "rgba(255,255,255,0.55)" }}>
                  <item.icon className="w-3 h-3 flex-shrink-0" />
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Module grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1">
            {modules.map((mod, i) => {
              const Icon = mod.icon;
              return (
                <div
                  key={i}
                  className="flex gap-4 p-5 rounded-lg"
                  style={{ background: "#0f0f0f", border: "1px solid rgba(255,180,0,0.1)" }}
                  data-testid={`card-module-${i}`}
                >
                  <div
                    className="flex-shrink-0 flex items-center justify-center w-9 h-9 rounded"
                    style={{ background: "rgba(255,195,51,0.1)", border: "1px solid rgba(255,195,51,0.2)" }}
                  >
                    <Icon className="w-4 h-4" style={{ color: "#ffc333" }} />
                  </div>
                  <div>
                    <p className="text-sm font-bold mb-0.5">{mod.name}</p>
                    <p className="text-xs leading-relaxed" style={{ color: "rgba(255,255,255,0.4)" }}>{mod.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Divider */}
      <div className="w-full px-6 md:px-12">
        <div style={{ height: "1px", background: "rgba(255,180,0,0.12)" }} />
      </div>

      {/* Built for Every Role */}
      <section className="py-24 px-6 md:px-12 max-w-6xl mx-auto w-full">
        <p className="text-xs uppercase tracking-[0.22em] font-semibold mb-4 text-center" style={{ color: "rgba(255,180,0,0.65)" }}>
          Built for Every Role
        </p>
        <h2
          className="text-3xl md:text-4xl font-bold text-center mb-4 tracking-tight"
          style={{ letterSpacing: "-0.02em" }}
          data-testid="text-roles-heading"
        >
          Your whole team, one platform.
        </h2>
        <p className="text-center text-sm mb-16 max-w-lg mx-auto" style={{ color: "rgba(255,255,255,0.4)" }}>
          Freight DNA delivers distinct value to every person in the org — from the rep on the phone to the director running the quarter.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {personas.map((persona, i) => (
            <div
              key={i}
              className="flex flex-col gap-5 p-7 rounded-xl"
              style={{ background: "#0f0f0f", border: "1px solid rgba(255,180,0,0.14)" }}
              data-testid={`card-role-${i}`}
            >
              <div>
                <p className="text-xs uppercase tracking-[0.18em] font-semibold mb-2" style={{ color: "rgba(255,180,0,0.6)" }}>
                  {persona.role}
                </p>
                <h3 className="text-lg font-bold">{persona.tagline}</h3>
              </div>
              <ul className="flex flex-col gap-3">
                {persona.bullets.map((bullet, j) => (
                  <li key={j} className="flex items-start gap-2.5" data-testid={`text-role-${i}-bullet-${j}`}>
                    <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: "#ffc333" }} />
                    <span className="text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.5)" }}>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Divider */}
      <div className="w-full px-6 md:px-12">
        <div style={{ height: "1px", background: "rgba(255,180,0,0.12)" }} />
      </div>

      {/* How it works */}
      <section className="py-24 px-6 md:px-12 max-w-5xl mx-auto w-full">
        <p className="text-xs uppercase tracking-[0.22em] font-semibold mb-4 text-center" style={{ color: "rgba(255,180,0,0.65)" }}>
          How It Works
        </p>
        <h2
          className="text-3xl md:text-4xl font-bold text-center mb-16 tracking-tight"
          style={{ letterSpacing: "-0.02em" }}
        >
          Three steps to winning more freight.
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {howItWorks.map((step, i) => (
            <div key={i} className="flex flex-col gap-4" data-testid={`card-step-${i}`}>
              <div className="flex items-center gap-3">
                <span className="text-4xl font-extrabold" style={{ color: "rgba(255,180,0,0.2)", letterSpacing: "-0.04em" }}>{step.step}</span>
                {i < howItWorks.length - 1 && (
                  <ChevronRight className="w-4 h-4 hidden md:block" style={{ color: "rgba(255,180,0,0.2)" }} />
                )}
              </div>
              <h3 className="text-lg font-bold">{step.title}</h3>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.45)" }}>{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Divider */}
      <div className="w-full px-6 md:px-12">
        <div style={{ height: "1px", background: "rgba(255,180,0,0.12)" }} />
      </div>

      {/* AI Feature Teaser */}
      <section className="py-20 px-6 md:px-12 max-w-5xl mx-auto w-full" data-testid="section-ai-teaser">
        <div
          className="relative rounded-2xl overflow-hidden p-10 md:p-14 flex flex-col md:flex-row items-start md:items-center gap-8"
          style={{
            background: "linear-gradient(135deg, #0f0f0f 0%, #131008 60%, #1a1200 100%)",
            border: "1px solid rgba(255,180,0,0.22)",
            boxShadow: "0 0 60px rgba(255,180,0,0.06)",
          }}
        >
          {/* Glow */}
          <div
            className="pointer-events-none absolute top-0 right-0 w-[400px] h-[300px]"
            style={{ background: "radial-gradient(ellipse at top right, rgba(255,180,0,0.08) 0%, transparent 65%)" }}
          />

          <div
            className="flex-shrink-0 flex items-center justify-center w-16 h-16 rounded-2xl"
            style={{ background: "rgba(255,195,51,0.12)", border: "1.5px solid rgba(255,195,51,0.3)" }}
            data-testid="icon-ai-teaser"
          >
            <Bot className="w-8 h-8" style={{ color: "#ffc333" }} />
          </div>

          <div className="flex-1">
            <div className="flex items-center gap-3 mb-3">
              <span
                className="text-xs font-bold uppercase tracking-widest px-2.5 py-1 rounded-full"
                style={{ background: "rgba(255,195,51,0.15)", color: "#ffc333", border: "1px solid rgba(255,195,51,0.3)" }}
                data-testid="badge-ai-status"
              >
                Early Access
              </span>
            </div>
            <h2
              className="text-2xl md:text-3xl font-extrabold mb-3 tracking-tight"
              style={{ letterSpacing: "-0.02em" }}
              data-testid="text-ai-teaser-heading"
            >
              Introducing Freight DNA AI
            </h2>
            <p className="text-sm md:text-base leading-relaxed mb-5 max-w-xl" style={{ color: "rgba(255,255,255,0.5)" }}>
              Ask Freight DNA anything about your accounts — get instant answers from your data. Which contacts haven't been touched in 60 days? Which lanes are at-risk? What's my wallet share on this account? Your data, on demand.
            </p>
            <div className="flex items-center gap-5 flex-wrap">
              <div className="flex items-center gap-2" style={{ color: "rgba(255,180,0,0.6)" }}>
                <Sparkles className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-widest">Powered by your live platform data</span>
              </div>
              <a
                href="/login"
                onClick={e => { e.preventDefault(); navigate("/login"); }}
                className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest transition-opacity duration-150 hover:opacity-80"
                style={{ color: "#ffc333" }}
                data-testid="link-ai-teaser-cta"
              >
                Explore AI Assistant <ArrowRight className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Divider */}
      <div className="w-full px-6 md:px-12">
        <div style={{ height: "1px", background: "rgba(255,180,0,0.12)" }} />
      </div>

      {/* Features */}
      <section className="py-24 px-6 md:px-12 max-w-6xl mx-auto w-full">
        <p
          className="text-xs uppercase tracking-[0.22em] font-semibold mb-4 text-center"
          style={{ color: "rgba(255,180,0,0.65)" }}
        >
          Platform Capabilities
        </p>
        <h2
          className="text-3xl md:text-4xl font-bold text-center mb-16 tracking-tight"
          style={{ letterSpacing: "-0.02em" }}
          data-testid="text-features-heading"
        >
          Everything your team needs to win freight.
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px" style={{ border: "1px solid rgba(255,180,0,0.12)", borderRadius: "12px", overflow: "hidden" }}>
          {features.map((feature, i) => {
            const Icon = feature.icon;
            return (
              <div
                key={i}
                className="flex flex-col gap-4 p-8"
                style={{ background: "#0f0f0f", borderRight: "1px solid rgba(255,180,0,0.08)", borderBottom: "1px solid rgba(255,180,0,0.08)" }}
                data-testid={`card-feature-${i}`}
              >
                <div
                  className="flex items-center justify-center w-10 h-10 rounded"
                  style={{ background: "rgba(255,195,51,0.1)", border: "1px solid rgba(255,195,51,0.2)" }}
                >
                  <Icon className="w-5 h-5" style={{ color: "#ffc333" }} />
                </div>
                <div>
                  <h3 className="text-sm font-bold mb-1 tracking-tight" data-testid={`text-feature-title-${i}`}>
                    {feature.title}
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.45)" }}>
                    {feature.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Why Freight DNA highlight strip */}
      <div style={{ background: "#0d0d0d", borderTop: "1px solid rgba(255,180,0,0.12)", borderBottom: "1px solid rgba(255,180,0,0.12)" }}>
        <div className="max-w-6xl mx-auto py-16 px-6 md:px-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-10">
          {[
            { check: "Built for freight", body: "Not a generic CRM. Every field, workflow, and report is designed around how transportation brokers actually sell — not retrofitted from a software playbook." },
            { check: "Grow the book you have", body: "The average broker sees less than 20% of a shipper's total spend. Freight DNA surfaces the wallet share you're missing and gives your team the intelligence to go capture it — without adding a single new logo." },
            { check: "Develops your people", body: "1:1 tooling, career conversations, and historical report card logs give managers the full development picture. The period toggle on Team Performance turns coaching sessions from opinions into evidence." },
            { check: "Enterprise-ready", body: "Multi-team and multi-org support means Freight DNA scales with you — from a single brokerage desk to a national enterprise with dozens of teams operating independently under one platform." },
          ].map((item, i) => (
            <div key={i} className="flex flex-col gap-3" data-testid={`card-why-${i}`}>
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: "#ffc333" }} />
                <span className="text-sm font-bold">{item.check}</span>
              </div>
              <p className="text-sm leading-relaxed pl-6" style={{ color: "rgba(255,255,255,0.4)" }}>{item.body}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Footer CTA */}
      <section className="py-24 px-6 flex flex-col items-center text-center">
        <p
          className="text-xs uppercase tracking-[0.22em] font-semibold mb-4"
          style={{ color: "rgba(255,180,0,0.65)" }}
        >
          Ready to go deeper?
        </p>
        <h2
          className="text-3xl md:text-5xl font-extrabold mb-4 tracking-tight"
          style={{ letterSpacing: "-0.03em" }}
          data-testid="text-footer-cta-heading"
        >
          Build relationships that last.
        </h2>
        <p className="text-base mb-10 max-w-md" style={{ color: "rgba(255,255,255,0.4)" }}>
          DNA · Down Not Across. Your competitive advantage starts with knowing your customer better than anyone else.
        </p>
        <div className="flex flex-col sm:flex-row items-center gap-4">
          <a
            href="/login"
            onClick={e => { e.preventDefault(); navigate("/login"); }}
            className="text-sm font-bold px-8 py-3 rounded transition-all duration-150"
            style={{ background: "#ffc333", color: "#0a0a0a" }}
            data-testid="button-footer-cta"
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#ffb400"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#ffc333"; }}
          >
            Access the Platform
          </a>
          <button
            onClick={() => setDemoOpen(true)}
            className="text-sm font-semibold px-8 py-3 rounded transition-all duration-150"
            style={{ border: "1px solid rgba(255,180,0,0.5)", color: "#ffb400", background: "transparent" }}
            data-testid="button-footer-schedule-demo"
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = "rgba(255,180,0,0.08)";
              (e.currentTarget as HTMLElement).style.borderColor = "#ffb400";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,180,0,0.5)";
            }}
          >
            Schedule Demo
          </button>
        </div>
      </section>

      {/* Footer bar */}
      <footer
        className="w-full flex items-center justify-between px-6 md:px-12 py-5 text-xs"
        style={{ borderTop: "1px solid rgba(255,180,0,0.1)", color: "rgba(255,255,255,0.2)" }}
      >
        <span data-testid="text-footer-wordmark">freight · dna</span>
        <span>Sales intelligence for freight brokers.</span>
        <a
          href="mailto:info@freight-dna.com"
          data-testid="link-footer-email"
          style={{ color: "rgba(255,255,255,0.2)" }}
          className="hover:text-white transition-colors"
        >
          info@freight-dna.com
        </a>
      </footer>

    </div>
  );
}
