import { useState } from "react";
import { useLocation } from "wouter";
import { TrendingUp, Network, FileSearch, MousePointerClick, BarChart3, Target, Map } from "lucide-react";
import ScheduleDemoModal from "@/components/ScheduleDemoModal";

const features = [
  {
    icon: Network,
    title: "Org Chart Visualization",
    description: "Map every stakeholder at your accounts — procurement, operations, finance — and understand who owns each decision.",
  },
  {
    icon: FileSearch,
    title: "RFP Intelligence Engine",
    description: "Track bid history, award patterns, and competitive positioning so you walk into every RFP knowing exactly how to win.",
  },
  {
    icon: MousePointerClick,
    title: "Touchpoint Tracking",
    description: "Log every call, email, and meeting in seconds. Never lose track of where a relationship stands.",
  },
  {
    icon: BarChart3,
    title: "Team Performance",
    description: "Real-time dashboards surface activity metrics, pipeline health, and rep rankings so leaders can coach with precision.",
  },
  {
    icon: Target,
    title: "Goals System",
    description: "Set quarterly targets for revenue, touchpoints, and new accounts — then watch progress auto-update against live data.",
  },
  {
    icon: Map,
    title: "Lane Analytics",
    description: "Identify your most profitable lanes, spot market gaps, and build targeted proposals backed by historical volume data.",
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
          <button
            onClick={() => setDemoOpen(true)}
            className="text-sm font-bold px-4 py-2 rounded transition-all duration-150"
            style={{ background: "#ffc333", color: "#0a0a0a" }}
            data-testid="button-nav-schedule-demo"
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = "#ffb400";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = "#ffc333";
            }}
          >
            Schedule Demo
          </button>
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
      <section className="flex flex-col items-center justify-center text-center pt-40 pb-28 px-6 relative" style={{ minHeight: "92vh" }}>
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
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = "#ffb400";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = "#ffc333";
            }}
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

      {/* Divider */}
      <div className="w-full px-6 md:px-12">
        <div style={{ height: "1px", background: "rgba(255,180,0,0.12)" }} />
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
        <a
          href="/login"
          onClick={e => { e.preventDefault(); navigate("/login"); }}
          className="text-sm font-bold px-8 py-3 rounded transition-all duration-150"
          style={{ background: "#ffc333", color: "#0a0a0a" }}
          data-testid="button-footer-cta"
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.background = "#ffb400";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.background = "#ffc333";
          }}
        >
          Access the Platform
        </a>
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
