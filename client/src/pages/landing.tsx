import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import {
  TrendingUp, Network, FileSearch, MousePointerClick, BarChart3,
  Target, Map, Users, CheckCircle, ClipboardList, CalendarCheck,
  BookOpen, Zap, TrendingUp as CareerIcon,
  GitBranch, Phone, Sparkles, Bot, ArrowRight,
  LayoutGrid, MessagesSquare, ListTodo, Trophy, Wrench, GraduationCap,
  UserCog, LineChart, Loader2, Kanban, RefreshCw, Send, X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import ScheduleDemoModal from "@/components/ScheduleDemoModal";

const stats = [
  { value: "20+", label: "Platform Modules" },
  { value: "360°", label: "Account Visibility" },
  { value: "AI-Powered", label: "Sales Intelligence" },
  { value: "~1 Week", label: "Avg. Onboarding Time" },
];

const features = [
  {
    icon: Network,
    title: "Org Chart & Relationship Mapping",
    description: "Map every stakeholder — procurement, operations, finance — and track who owns each decision. Know your accounts down, not across.",
  },
  {
    icon: Kanban,
    title: "Sales Pipeline & AI Prospect Intel",
    description: "Manage every prospect through a visual Kanban pipeline. One click generates an AI-powered brief: network overlap, conversation starters, industry pain points, and competitive tips — before you ever pick up the phone.",
  },
  {
    icon: FileSearch,
    title: "RFP Intelligence Engine",
    description: "Upload RFP lane data, analyze corridors, track bid history, and compare awards. Walk into every bid knowing exactly how to win.",
  },
  {
    icon: MousePointerClick,
    title: "Touchpoint Tracking",
    description: "Log a touchpoint in seconds from anywhere in the platform. Calls, emails, texts, and site visits in one click — automated alerts surface contacts going cold before it costs you freight.",
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
];

const modules = [
  { icon: Kanban, name: "Sales Pipeline", desc: "Kanban board for every prospect — import via CSV, track stages, and generate AI Sales Intel Briefs in one click." },
  { icon: Users, name: "Customers", desc: "Full account profiles with financials, contacts, modes, and intelligence notes." },
  { icon: Zap, name: "Top Opportunities", desc: "Auto-surfaced accounts with the highest untapped wallet share potential." },
  { icon: GitBranch, name: "Org Charts & Contacts", desc: "Visual org charts for every account — map decision-makers, influencers, and key contacts." },
  { icon: Phone, name: "Touchpoint Log", desc: "Every call, email, text, and site visit in a unified timeline. AI flags cold contacts before they cost you freight." },
  { icon: CalendarCheck, name: "1:1's", desc: "Structured NAM-AM session topics, follow-ups, and threaded discussion threads." },
  { icon: BarChart3, name: "Report Cards", desc: "Per-rep scorecards showing load count, margin, touchpoints, and goal progress." },
  { icon: FileSearch, name: "RFP & Awards", desc: "Full pipeline management for bids, awards, and lane-level analysis." },
  { icon: Target, name: "Goals & Accountability", desc: "Set and auto-track targets for loads, margin, touchpoints, and new contacts against live platform data." },
  { icon: BarChart3, name: "Team Performance", desc: "Period-over-period activity and revenue tracking with rep rankings — turn coaching from opinions into evidence." },
];


const personas = [
  {
    role: "NAMs & Account Executives",
    tagline: "Your whole book in one place.",
    bullets: [
      "Full account org charts with contact ownership and decision-maker mapping",
      "One-click touchpoint logging from anywhere — calls, emails, texts, site visits",
      "AI-flagged cold contacts so no relationship slips through the cracks",
      "AI Sales Intel Briefs with wallet share scoring, RFP history, network overlap, and conversation starters — before every pitch",
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

function formatPrice(unitAmount: number | null, currency: string) {
  if (!unitAmount) return "Contact us";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "usd",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(unitAmount / 100);
}

interface StripePrice {
  id: string;
  unitAmount: number | null;
  currency: string;
  recurring: { interval: string; interval_count: number } | null;
}

interface StripeProduct {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  prices: StripePrice[];
}

function PricingSection() {
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState<string | null>(null); // priceId waiting for info
  const [companyName, setCompanyName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");

  const { data: productsData, isLoading } = useQuery<{ products: StripeProduct[] }>({
    queryKey: ["/api/stripe/products"],
  });

  const products = productsData?.products ?? [];

  const subscriptionProduct = products.find(
    p => p.metadata?.type === "subscription" || p.prices.some(pr => pr.recurring !== null)
  );
  const addonProduct = products.find(
    p => p.metadata?.type === "one_time" || p.prices.some(pr => pr.recurring === null)
  );

  const handleGetStarted = async (priceId: string, cName: string, aEmail: string) => {
    setCheckoutLoading(priceId);
    setCheckoutError(null);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId, companyName: cName, adminEmail: aEmail }),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
      } else {
        setCheckoutError(data.error ?? "Unable to start checkout. Please try again.");
      }
    } catch {
      setCheckoutError("Unable to start checkout. Please try again.");
    } finally {
      setCheckoutLoading(null);
    }
  };

  const openForm = (priceId: string) => {
    setShowForm(priceId);
    setCheckoutError(null);
  };

  const submitForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!showForm) return;
    if (!companyName.trim() || !adminEmail.trim()) return;
    const priceId = showForm;
    setShowForm(null);
    handleGetStarted(priceId, companyName.trim(), adminEmail.trim());
  };

  const subPrice = subscriptionProduct?.prices?.[0];
  const addonPrice = addonProduct?.prices?.[0];

  const staticPlans = [
    {
      name: "Freight DNA Monthly",
      price: "$1,750",
      period: "/month",
      description: "Full platform access for your entire freight brokerage team.",
      features: [
        "All 15+ platform modules",
        "Unlimited team members",
        "AI-powered cold contact alerts",
        "RFP intelligence & bid tracking",
        "Team performance dashboards",
        "Career progression tracking",
        "Touchpoint & relationship mapping",
        "Dedicated onboarding support",
      ],
      priceId: subPrice?.id,
      mode: "subscription" as const,
      badge: "Most Popular",
      highlight: true,
    },
    {
      name: "Custom Feature Buildout",
      price: "$5,000",
      period: " one-time",
      description: "A custom feature built specifically for your brokerage's unique workflow.",
      features: [
        "Scoped to your exact requirements",
        "Dedicated project manager",
        "Full development & deployment",
        "Ongoing support for new feature",
        "Priority roadmap access",
        "Integration with existing modules",
      ],
      priceId: addonPrice?.id,
      mode: "payment" as const,
      badge: "Add-On",
      highlight: false,
    },
  ];

  return (
    <section className="py-24 px-6 md:px-12 max-w-5xl mx-auto w-full" data-testid="section-pricing" id="pricing">
      <p className="text-xs uppercase tracking-[0.22em] font-semibold mb-4 text-center" style={{ color: "rgba(255,180,0,0.65)" }}>
        Pricing
      </p>
      <h2
        className="text-3xl md:text-4xl font-bold text-center mb-4 tracking-tight"
        style={{ letterSpacing: "-0.02em" }}
        data-testid="text-pricing-heading"
      >
        Simple, transparent pricing.
      </h2>
      <p className="text-center text-sm mb-16 max-w-md mx-auto" style={{ color: "rgba(255,255,255,0.4)" }}>
        No per-seat fees. No hidden costs. One flat rate gives your whole team full access to every module.
      </p>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: "#ffc333" }} />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {staticPlans.map((plan, i) => {
            const livePrice = i === 0 ? subPrice : addonPrice;
            const displayPrice = livePrice
              ? formatPrice(livePrice.unitAmount, livePrice.currency)
              : plan.price;

            return (
              <div
                key={i}
                className="relative flex flex-col p-8 rounded-2xl"
                style={{
                  background: plan.highlight ? "linear-gradient(135deg, #111200 0%, #0f0f00 100%)" : "#0f0f0f",
                  border: plan.highlight ? "1.5px solid rgba(255,195,51,0.35)" : "1px solid rgba(255,180,0,0.14)",
                  boxShadow: plan.highlight ? "0 0 40px rgba(255,195,51,0.07)" : "none",
                }}
                data-testid={`card-plan-${i}`}
              >
                {plan.badge && (
                  <span
                    className="absolute top-4 right-4 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full"
                    style={{
                      background: plan.highlight ? "rgba(255,195,51,0.18)" : "rgba(255,255,255,0.07)",
                      color: plan.highlight ? "#ffc333" : "rgba(255,255,255,0.45)",
                      border: plan.highlight ? "1px solid rgba(255,195,51,0.3)" : "1px solid rgba(255,255,255,0.1)",
                    }}
                  >
                    {plan.badge}
                  </span>
                )}

                <div className="mb-6">
                  <p className="text-xs uppercase tracking-[0.18em] font-semibold mb-2" style={{ color: "rgba(255,180,0,0.6)" }}>
                    {plan.name}
                  </p>
                  <div className="flex items-end gap-1 mb-3">
                    <span className="text-4xl font-extrabold tracking-tight" style={{ letterSpacing: "-0.03em" }}>
                      {displayPrice}
                    </span>
                    <span className="text-sm mb-1" style={{ color: "rgba(255,255,255,0.4)" }}>{plan.period}</span>
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.45)" }}>
                    {plan.description}
                  </p>
                </div>

                <ul className="flex flex-col gap-3 mb-8 flex-1">
                  {plan.features.map((feature, j) => (
                    <li key={j} className="flex items-start gap-2.5" data-testid={`text-plan-${i}-feature-${j}`}>
                      <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: "#ffc333" }} />
                      <span className="text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.55)" }}>{feature}</span>
                    </li>
                  ))}
                </ul>

                {checkoutError && (
                  <p className="text-xs text-red-400 mb-3">{checkoutError}</p>
                )}

                <button
                  onClick={() => {
                    if (plan.priceId) {
                      openForm(plan.priceId);
                    } else {
                      window.location.href = "mailto:info@freight-dna.com?subject=Freight DNA Subscription Inquiry";
                    }
                  }}
                  disabled={checkoutLoading === plan.priceId}
                  className="w-full flex items-center justify-center gap-2 text-sm font-bold px-6 py-3 rounded transition-all duration-150"
                  style={{
                    background: plan.highlight ? "#ffc333" : "transparent",
                    color: plan.highlight ? "#0a0a0a" : "#ffc333",
                    border: plan.highlight ? "none" : "1px solid rgba(255,195,51,0.4)",
                  }}
                  data-testid={`button-plan-${i}-cta`}
                  onMouseEnter={e => {
                    const el = e.currentTarget as HTMLElement;
                    if (plan.highlight) el.style.background = "#ffb400";
                    else { el.style.background = "rgba(255,195,51,0.08)"; el.style.borderColor = "#ffc333"; }
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget as HTMLElement;
                    if (plan.highlight) el.style.background = "#ffc333";
                    else { el.style.background = "transparent"; el.style.borderColor = "rgba(255,195,51,0.4)"; }
                  }}
                >
                  {checkoutLoading === plan.priceId ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : null}
                  {plan.priceId ? "Get Started" : "Contact Us"}
                  {!checkoutLoading && plan.priceId && <ArrowRight className="w-4 h-4" />}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-center text-xs mt-8" style={{ color: "rgba(255,255,255,0.25)" }}>
        Questions? Reach us at{" "}
        <a href="mailto:info@freight-dna.com" className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.35)" }}>
          info@freight-dna.com
        </a>
      </p>

      {showForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setShowForm(null)}
          data-testid="modal-checkout-info"
        >
          <form
            onClick={e => e.stopPropagation()}
            onSubmit={submitForm}
            className="w-full max-w-sm p-8 rounded-2xl flex flex-col gap-5"
            style={{ background: "#111", border: "1.5px solid rgba(255,195,51,0.3)" }}
          >
            <h3 className="text-xl font-bold" style={{ letterSpacing: "-0.02em" }}>Before we go to checkout</h3>
            <p className="text-sm" style={{ color: "rgba(255,255,255,0.45)" }}>
              Tell us a bit about your brokerage so we can set up your account after payment.
            </p>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold" style={{ color: "rgba(255,180,0,0.7)" }}>Company Name</label>
              <input
                type="text"
                required
                autoFocus
                value={companyName}
                onChange={e => setCompanyName(e.target.value)}
                placeholder="ValueTruck Logistics"
                className="w-full px-3 py-2.5 rounded text-sm outline-none"
                style={{ background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.1)", color: "#fff" }}
                data-testid="input-checkout-company"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold" style={{ color: "rgba(255,180,0,0.7)" }}>Your Work Email</label>
              <input
                type="email"
                required
                value={adminEmail}
                onChange={e => setAdminEmail(e.target.value)}
                placeholder="you@yourcompany.com"
                className="w-full px-3 py-2.5 rounded text-sm outline-none"
                style={{ background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.1)", color: "#fff" }}
                data-testid="input-checkout-email"
              />
            </div>
            {checkoutError && (
              <p className="text-xs text-red-400">{checkoutError}</p>
            )}
            <button
              type="submit"
              disabled={!!checkoutLoading}
              className="w-full flex items-center justify-center gap-2 text-sm font-bold px-6 py-3 rounded transition-all duration-150"
              style={{ background: "#ffc333", color: "#0a0a0a" }}
              data-testid="button-checkout-submit"
            >
              {checkoutLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Continue to Checkout
              {!checkoutLoading && <ArrowRight className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(null)}
              className="text-xs text-center"
              style={{ color: "rgba(255,255,255,0.3)" }}
            >
              Cancel
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const GREETING: ChatMessage = {
  role: "assistant",
  content: "Hey there! I'm Dana, your Freight DNA guide. Whether you're curious about features, pricing, how we compare to other CRMs, or just want to know if this is right for your team — I'm here to help. What's on your mind?",
};

function MarketingChatWidget({ onScheduleDemo }: { onScheduleDemo: () => void }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/marketing-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json() as { reply?: string; error?: string };
      setMessages(prev => [...prev, { role: "assistant", content: data.reply ?? "Sorry, something went wrong. Try again!" }]);
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Hmm, I had trouble connecting. Give it another try!" }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-6 right-6 z-50 flex items-center justify-center w-14 h-14 rounded-full shadow-lg transition-all duration-200"
        style={{ background: "#ffc333", color: "#0a0a0a", boxShadow: "0 4px 24px rgba(255,195,51,0.35)" }}
        data-testid="button-marketing-chat-toggle"
        aria-label="Chat with Dana"
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#ffb400"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#ffc333"; }}
      >
        {open ? <X className="w-6 h-6" /> : <MessagesSquare className="w-6 h-6" />}
      </button>

      {/* Chat panel */}
      {open && (
        <div
          className="fixed bottom-24 right-6 z-50 flex flex-col rounded-2xl overflow-hidden"
          style={{
            width: "min(380px, calc(100vw - 24px))",
            height: "min(520px, calc(100vh - 120px))",
            background: "#111",
            border: "1px solid rgba(255,180,0,0.25)",
            boxShadow: "0 8px 40px rgba(0,0,0,0.6), 0 0 60px rgba(255,180,0,0.08)",
          }}
          data-testid="panel-marketing-chat"
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 flex-shrink-0"
            style={{ background: "#0d0d0d", borderBottom: "1px solid rgba(255,180,0,0.15)" }}
          >
            <div className="flex items-center gap-2.5">
              <div
                className="flex items-center justify-center w-8 h-8 rounded-full"
                style={{ background: "rgba(255,195,51,0.15)", border: "1px solid rgba(255,195,51,0.3)" }}
              >
                <Bot className="w-4 h-4" style={{ color: "#ffc333" }} />
              </div>
              <div>
                <p className="text-sm font-bold leading-none" style={{ color: "#ffc333" }}>Dana</p>
                <p className="text-[10px] mt-0.5" style={{ color: "rgba(255,255,255,0.35)" }}>Freight DNA Sales Assistant</p>
              </div>
            </div>
            <button
              onClick={() => onScheduleDemo()}
              className="text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded transition-all duration-150"
              style={{ background: "rgba(255,195,51,0.12)", color: "#ffc333", border: "1px solid rgba(255,195,51,0.25)" }}
              data-testid="button-chat-schedule-demo"
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,195,51,0.22)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,195,51,0.12)"; }}
            >
              Schedule Demo
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3" data-testid="list-chat-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {msg.role === "assistant" && (
                  <div
                    className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mr-2 mt-0.5"
                    style={{ background: "rgba(255,195,51,0.12)", border: "1px solid rgba(255,195,51,0.2)" }}
                  >
                    <Bot className="w-3 h-3" style={{ color: "#ffc333" }} />
                  </div>
                )}
                <div
                  className="max-w-[78%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed"
                  style={
                    msg.role === "user"
                      ? { background: "#ffc333", color: "#0a0a0a", borderBottomRightRadius: "4px" }
                      : { background: "#1a1a1a", color: "rgba(255,255,255,0.85)", border: "1px solid rgba(255,255,255,0.06)", borderBottomLeftRadius: "4px" }
                  }
                  data-testid={`msg-${msg.role}-${i}`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div
                  className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mr-2 mt-0.5"
                  style={{ background: "rgba(255,195,51,0.12)", border: "1px solid rgba(255,195,51,0.2)" }}
                >
                  <Bot className="w-3 h-3" style={{ color: "#ffc333" }} />
                </div>
                <div
                  className="rounded-xl px-3.5 py-2.5 flex items-center gap-1.5"
                  style={{ background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.06)", borderBottomLeftRadius: "4px" }}
                  data-testid="msg-typing"
                >
                  {[0, 1, 2].map(d => (
                    <span
                      key={d}
                      className="w-1.5 h-1.5 rounded-full animate-bounce"
                      style={{ background: "rgba(255,195,51,0.6)", animationDelay: `${d * 0.15}s` }}
                    />
                  ))}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div
            className="flex-shrink-0 flex items-center gap-2 px-3 py-3"
            style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Ask anything about Freight DNA…"
              disabled={loading}
              className="flex-1 text-sm px-3 py-2 rounded-lg outline-none"
              style={{ background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.1)", color: "#fff" }}
              data-testid="input-chat-message"
            />
            <button
              onClick={send}
              disabled={!input.trim() || loading}
              className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0 transition-all duration-150"
              style={{
                background: input.trim() && !loading ? "#ffc333" : "rgba(255,195,51,0.15)",
                color: input.trim() && !loading ? "#0a0a0a" : "rgba(255,195,51,0.4)",
              }}
              data-testid="button-chat-send"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default function LandingPage() {
  const [, navigate] = useLocation();
  const [demoOpen, setDemoOpen] = useState(false);
  const [showCancelledBanner, setShowCancelledBanner] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("checkout") === "cancelled";
  });

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#0a0a0a", color: "#fff" }}>
      {showCancelledBanner && (
        <div
          className="flex items-center justify-between px-4 py-3 text-sm"
          style={{ background: "rgba(255,100,60,0.12)", borderBottom: "1px solid rgba(255,100,60,0.25)" }}
          data-testid="banner-checkout-cancelled"
        >
          <span style={{ color: "rgba(255,200,180,0.9)" }}>
            Your checkout was cancelled — no charge was made. You can try again any time.
          </span>
          <button
            onClick={() => setShowCancelledBanner(false)}
            className="ml-4 text-xs opacity-60 hover:opacity-100 transition-opacity"
            style={{ color: "rgba(255,200,180,0.9)" }}
            data-testid="button-dismiss-cancel-banner"
          >
            ✕
          </button>
        </div>
      )}

      <ScheduleDemoModal open={demoOpen} onClose={() => setDemoOpen(false)} />

      {/* Fixed top nav */}
      <header
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 md:px-12 h-16"
        style={{ background: "rgba(10,10,10,0.92)", borderBottom: "1px solid rgba(255,180,0,0.12)", backdropFilter: "blur(8px)" }}
      >
        <button
          className="flex items-center gap-3 cursor-pointer"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          data-testid="nav-wordmark"
        >
          <div
            className="flex items-center justify-center w-8 h-8 rounded-full"
            style={{ border: "1.5px solid #ffb400", background: "#111" }}
          >
            <TrendingUp className="w-4 h-4" style={{ color: "#ffb400" }} />
          </div>
          <span className="text-base font-bold tracking-tight" style={{ color: "#ffb400" }}>
            freight · dna
          </span>
        </button>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setDemoOpen(true)}
            className="text-sm font-semibold px-4 py-2 rounded transition-all duration-150"
            style={{ color: "rgba(255,255,255,0.65)", background: "transparent" }}
            data-testid="link-nav-schedule-demo"
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#fff"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.65)"; }}
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
      <section className="flex flex-col items-center justify-center text-center pt-40 pb-24 px-6 relative" style={{ minHeight: "88vh" }}>
        <div
          className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full"
          style={{ background: "radial-gradient(ellipse, rgba(255,180,0,0.14) 0%, transparent 70%)" }}
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
          className="max-w-lg text-lg md:text-xl leading-relaxed mb-10"
          style={{ color: "rgba(255,255,255,0.5)" }}
          data-testid="text-hero-subheadline"
        >
          Stop chasing new logos. The freight you're leaving behind is already in your book — Freight DNA gives your team the intelligence to find it and win it.
        </p>

        <div className="flex items-center gap-4">
          <button
            onClick={() => setDemoOpen(true)}
            className="text-sm font-bold px-8 py-3.5 rounded transition-all duration-150"
            style={{ background: "#ffc333", color: "#0a0a0a" }}
            data-testid="button-hero-schedule-demo"
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#ffb400"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#ffc333"; }}
          >
            Schedule Demo
          </button>
          <a
            href="#pricing"
            onClick={e => { e.preventDefault(); document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" }); }}
            className="text-sm font-semibold px-8 py-3.5 rounded transition-all duration-150 flex items-center gap-2"
            style={{ border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.65)" }}
            data-testid="button-hero-cta"
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.35)";
              (e.currentTarget as HTMLElement).style.color = "#fff";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.15)";
              (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.65)";
            }}
          >
            See Pricing <ArrowRight className="w-3.5 h-3.5" />
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
                { icon: Kanban, label: "Sales Pipeline", active: true },
                { icon: Trophy, label: "RFP & Awards" },
                { icon: ClipboardList, label: "Lane Research" },
              ].map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-[10px] font-medium"
                  style={{
                    background: item.active ? "rgba(255,180,0,0.12)" : "transparent",
                    color: item.active ? "#ffb400" : "rgba(255,255,255,0.55)",
                  }}
                >
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 flex-1">
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

      {/* Built Around You */}
      <section className="py-24 px-6 md:px-12 max-w-5xl mx-auto w-full" data-testid="section-built-around-you">
        <p className="text-xs uppercase tracking-[0.22em] font-semibold mb-4 text-center" style={{ color: "rgba(255,180,0,0.65)" }}>
          Getting Started
        </p>
        <h2
          className="text-3xl md:text-4xl font-bold text-center mb-4 tracking-tight"
          style={{ letterSpacing: "-0.02em" }}
          data-testid="text-onboarding-heading"
        >
          Up and running in days — not months.
        </h2>
        <p className="text-center text-sm mb-16 max-w-lg mx-auto" style={{ color: "rgba(255,255,255,0.4)" }}>
          No two brokerages operate the same way. We don't expect you to change how you work — we configure the platform to match it.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            {
              icon: Zap,
              title: "Live in ~1 Week",
              body: "We handle the full setup — data import, team configuration, and role permissions. Most brokerages are up and running within a week. Your team shows up on day one ready to sell.",
            },
            {
              icon: Wrench,
              title: "Tailored to Your Workflow",
              body: "Field labels, stages, reporting views, team hierarchy — we configure all of it to match how you actually operate. You shouldn't have to adapt to a tool. The tool should adapt to you.",
            },
            {
              icon: RefreshCw,
              title: "We Build What You Need",
              body: "Need a custom report? A new field? A workflow that doesn't exist yet? Tell us. We move fast, and we're easy to work with. The platform evolves alongside your business — not on a six-month release cycle.",
            },
          ].map((card, i) => {
            const Icon = card.icon;
            return (
              <div
                key={i}
                className="flex flex-col gap-5 p-7 rounded-xl"
                style={{ background: "#0d0d0d", border: "1px solid rgba(255,180,0,0.14)" }}
                data-testid={`card-onboarding-${i}`}
              >
                <div
                  className="flex items-center justify-center w-10 h-10 rounded"
                  style={{ background: "rgba(255,195,51,0.1)", border: "1px solid rgba(255,195,51,0.2)" }}
                >
                  <Icon className="w-5 h-5" style={{ color: "#ffc333" }} />
                </div>
                <div>
                  <h3 className="text-base font-bold mb-2 tracking-tight">{card.title}</h3>
                  <p className="text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.45)" }}>{card.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

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
                Now Live
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

      {/* Footer CTA */}
      <section className="py-24 px-6 flex flex-col items-center text-center" data-testid="section-footer-cta">
        <div
          className="relative w-full max-w-4xl mx-auto rounded-2xl px-10 py-16 md:py-20 flex flex-col items-center overflow-hidden"
          style={{ background: "#0d0d0d", border: "1px solid rgba(255,180,0,0.2)" }}
        >
          {/* Glow */}
          <div
            className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[500px] h-[300px] rounded-full"
            style={{ background: "radial-gradient(ellipse, rgba(255,180,0,0.1) 0%, transparent 70%)" }}
          />
          <p
            className="text-xs uppercase tracking-[0.22em] font-semibold mb-4 relative"
            style={{ color: "rgba(255,180,0,0.65)" }}
          >
            Ready to go deeper?
          </p>
          <h2
            className="text-3xl md:text-5xl font-extrabold mb-4 tracking-tight relative"
            style={{ letterSpacing: "-0.03em" }}
            data-testid="text-footer-cta-heading"
          >
            Build relationships that last.
          </h2>
          <p className="text-base mb-10 max-w-md relative" style={{ color: "rgba(255,255,255,0.4)" }}>
            Your competitive advantage starts with knowing your customers better than anyone else. Let's get you there.
          </p>
          <div className="flex flex-col sm:flex-row items-center gap-4 relative">
            <button
              onClick={() => setDemoOpen(true)}
              className="text-sm font-bold px-8 py-3.5 rounded transition-all duration-150"
              style={{ background: "#ffc333", color: "#0a0a0a" }}
              data-testid="button-footer-schedule-demo"
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#ffb400"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#ffc333"; }}
            >
              Schedule Demo
            </button>
            <a
              href="#pricing"
              onClick={e => { e.preventDefault(); document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" }); }}
              className="text-sm font-semibold px-8 py-3.5 rounded transition-all duration-150"
              style={{ border: "1px solid rgba(255,180,0,0.5)", color: "#ffb400", background: "transparent" }}
              data-testid="button-footer-cta"
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.background = "rgba(255,180,0,0.08)";
                (e.currentTarget as HTMLElement).style.borderColor = "#ffb400";
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
                (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,180,0,0.5)";
              }}
            >
              View Pricing
            </a>
          </div>
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

      <MarketingChatWidget onScheduleDemo={() => setDemoOpen(true)} />
    </div>
  );
}
