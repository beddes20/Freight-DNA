import { useState } from "react";
import { useLocation } from "wouter";
import {
  TrendingUp, Network, FileSearch, MousePointerClick, BarChart3,
  Target, Map, Users, CheckCircle, ClipboardList, CalendarCheck,
  BookOpen, Zap, ChevronRight,
} from "lucide-react";
import ScheduleDemoModal from "@/components/ScheduleDemoModal";
import sidebarImg from "@assets/image_1774288850565.png";

const stats = [
  { value: "6", label: "Core Modules" },
  { value: "360°", label: "Account Visibility" },
  { value: "Real-time", label: "Data & Alerts" },
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
    description: "Log calls, emails, site visits, and texts in seconds. Surface contacts going cold with automated \"Needs Attention\" alerts.",
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
];

const modules = [
  { icon: Users, name: "Customers", desc: "Full account profiles with financials, contacts, modes, and intelligence notes." },
  { icon: Zap, name: "Top Opportunities", desc: "Auto-surfaced accounts with the highest untapped wallet share potential." },
  { icon: CalendarCheck, name: "1:1 Meetings", desc: "Structured NAM-AM session topics, follow-ups, and threaded discussion threads." },
  { icon: ClipboardList, name: "Tasks", desc: "Assign and track account-linked tasks with due dates and priority levels." },
  { icon: BarChart3, name: "Report Cards", desc: "Per-rep scorecards showing load count, margin, touchpoints, and goal progress." },
  { icon: BookOpen, name: "PTO Passoff", desc: "Structured handoff documents so accounts never slip during out-of-office periods." },
  { icon: FileSearch, name: "RFP & Awards", desc: "Full pipeline management for bids, awards, and lane-level analysis." },
  { icon: Map, name: "Lane Analytics", desc: "Heat maps and corridor analysis from financial and RFP upload data." },
];

const howItWorks = [
  {
    step: "01",
    title: "Map your accounts",
    body: "Build org charts, log contact details, and capture account intelligence — portal credentials, spot process, tendering style, dispatch email — all in one place.",
  },
  {
    step: "02",
    title: "Track every touchpoint",
    body: "Every call, email, text, and site visit is logged in seconds. The system flags contacts going cold so nothing falls through the cracks.",
  },
  {
    step: "03",
    title: "Win more freight",
    body: "Use RFP intelligence, wallet share analysis, and lane data to show up to every conversation with a better story than your competition.",
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
          Know your accounts
          <br />
          <span style={{ color: "#ffc333" }}>down, not across.</span>
        </h1>

        <p
          className="max-w-xl text-lg md:text-xl leading-relaxed mb-10"
          style={{ color: "rgba(255,255,255,0.5)" }}
          data-testid="text-hero-subheadline"
        >
          Freight DNA gives your team the relationship depth, pipeline visibility, and competitive intelligence to win more freight — consistently.
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
          {/* Sidebar screenshot */}
          <div
            className="flex-shrink-0 rounded-xl overflow-hidden"
            style={{ border: "1px solid rgba(255,180,0,0.15)", boxShadow: "0 0 40px rgba(255,180,0,0.06)" }}
          >
            <img
              src={sidebarImg}
              alt="Freight DNA platform navigation"
              className="w-48 md:w-56 block"
              data-testid="img-platform-sidebar"
            />
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
        <div className="max-w-5xl mx-auto py-16 px-6 md:px-12 grid grid-cols-1 md:grid-cols-3 gap-10">
          {[
            { check: "Built for freight", body: "Not a generic CRM. Every field, workflow, and report is designed around how transportation brokers actually sell." },
            { check: "Replaces the spreadsheet", body: "Org charts, lane data, RFP history, touchpoints, and goals — all in one place instead of scattered across Excel files and email threads." },
            { check: "Coaches your team", body: "NAMs get a live view of every AM's activity. Coaches replace guesswork with facts on touchpoints, pipeline, and account health." },
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
      </footer>

    </div>
  );
}
