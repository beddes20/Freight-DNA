import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, Users, Truck, Inbox, Sparkles } from "lucide-react";

type Silo = { label: string; note?: string };

const customerSilos: Silo[] = [
  { label: "Customers", note: "list view" },
  { label: "Customer Quotes", note: "35 unread" },
  { label: "Freight Capture / Top Opportunities" },
  { label: "RFP & Awards" },
  { label: "Email Intelligence" },
  { label: "Contact Suggestions" },
  { label: "Conversations Inbox" },
  { label: "Lane Patterns / Touchpoints" },
];

const carrierSilos: Silo[] = [
  { label: "Carrier Hub", note: "overview" },
  { label: "Carrier Intelligence — Scorecard" },
  { label: "Carrier Intelligence — Available Loads" },
  { label: "Carrier Intelligence — Lane Pricing" },
  { label: "Lane Work Queue" },
  { label: "Spot Quote Search" },
  { label: "Available Freight Cockpit" },
  { label: "Carrier outreach", note: "Webex + email" },
];

type Panel = { title: string; lines: string[] };

const customerPanels: Panel[] = [
  { title: "Next Best Action", lines: ['"Memphis → Dallas capacity tightens this week — call Joan"'] },
  { title: "Open Quotes (3)", lines: ["Q-2841 · waiting", "Q-2843 · sent", "Q-2839 · won 3d"] },
  { title: "Inbox (5 new)", lines: ["Re: Q-2841", "Capacity update", "Holiday schedule"] },
  { title: "Lane Patterns", lines: ["Memphis → Dallas · weekly · 84%", "Atlanta → Miami · monthly · 71%", "Chicago → Houston · spot · 12%"] },
  { title: "Touchpoints (12 / 30d)", lines: ["Sarah · call · 2d ago", "Mike · email · 5d ago", "Sarah · meeting · 8d ago"] },
  { title: "RFP / Awards", lines: ["2026 SE-bid · in progress", "2025 award · 2,400 lds · margin 11%"] },
  { title: "Contacts", lines: ["Joan Smith · VP Logistics", "Tom Reed · Ops Manager"] },
];

const carrierPanels: Panel[] = [
  { title: "Reliability", lines: ["On-time 94%", "Tracking 91%", "Margin 11.4%"] },
  { title: "In-flight (7)", lines: ["L-44128 · MEM→DAL", "L-44131 · ATL→MIA", "L-44135 · CHI→HOU"] },
  { title: "Available today (3)", lines: ["MEM · empty Tue", "ATL · tractor Wed", "DAL · power-only Thu"] },
  { title: "Lanes covered", lines: ["Memphis → Dallas · 154 lds · $2.18", "Atlanta → Miami · 89 lds · $1.94", "Chicago → Houston · 42 lds · $2.41"] },
  { title: "Outreach (Webex + email)", lines: ["Mark · called 1h ago", "Mark · email Tue · replied", "Mark · email Mon · no rsp"] },
  { title: "Pricing vs market", lines: ["MEM→DAL  -3% under spot · won 9/12", "ATL→MIA  +2% over · won 4/9"] },
  { title: "Contacts", lines: ["Lisa Park · Dispatcher", "Rob Cole · Sales · primary"] },
];

function SiloColumn({ silos }: { silos: Silo[] }) {
  return (
    <div className="flex-1 space-y-2" data-testid="silo-column">
      <p className="text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400 mb-3">
        Today · {silos.length} sidebar entries
      </p>
      {silos.map((s, i) => (
        <Card
          key={i}
          className="border-amber-300 bg-amber-50 dark:border-amber-800/60 dark:bg-amber-950/30"
          data-testid={`silo-card-${i}`}
        >
          <CardContent className="p-3 flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-amber-950 dark:text-amber-100">{s.label}</span>
            {s.note && (
              <Badge variant="secondary" className="text-[10px] uppercase">
                {s.note}
              </Badge>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function WorkbenchMockup({
  title,
  subtitle,
  url,
  headerStats,
  tabs,
  panels,
}: {
  title: string;
  subtitle: string;
  url: string;
  headerStats: { label: string; value: string }[];
  tabs: string[];
  panels: Panel[];
}) {
  return (
    <Card
      className="flex-[2] border-green-300 bg-green-50/40 dark:border-green-800/60 dark:bg-green-950/20"
      data-testid="workbench-mockup"
    >
      <CardHeader className="pb-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">
          Tomorrow · one workbench per object
        </p>
        <CardTitle className="flex items-center justify-between gap-3 mt-1">
          <span>{title}</span>
          <code className="text-xs font-mono text-muted-foreground">{url}</code>
        </CardTitle>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-background p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {headerStats.map((s, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-muted-foreground text-xs uppercase tracking-wide">{s.label}</span>
                <span className="font-medium">{s.value}</span>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-1 mt-3 pt-3 border-t">
            {tabs.map((t, i) => (
              <Badge
                key={i}
                variant={i === 0 ? "default" : "outline"}
                className="text-xs"
              >
                {t}
              </Badge>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {panels.map((p, i) => (
            <div
              key={i}
              className="rounded-md border bg-background p-3"
              data-testid={`workbench-panel-${i}`}
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {p.title}
              </p>
              <ul className="space-y-1">
                {p.lines.map((l, j) => (
                  <li key={j} className="text-xs text-foreground">
                    {l}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Section({
  icon,
  title,
  subtitle,
  silos,
  workbench,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  silos: Silo[];
  workbench: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-primary/10 text-primary p-2">{icon}</div>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 items-stretch">
        <SiloColumn silos={silos} />
        <div className="flex items-center justify-center lg:px-2 py-4 lg:py-0">
          <ArrowRight className="h-8 w-8 text-blue-500" />
        </div>
        {workbench}
      </div>
    </section>
  );
}

export default function ArchitectureSketchPage() {
  return (
    <div className="p-6 md:p-8 max-w-[1600px] mx-auto space-y-12" data-testid="page-architecture-sketch">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Architecture sketch · object-centered consolidation
        </p>
        <h1 className="text-3xl font-bold tracking-tight">
          From silos to workbenches
        </h1>
        <p className="text-base text-muted-foreground max-w-3xl">
          Same data, same business logic. Different navigation. Each customer and each carrier becomes
          one URL where everything that matters about them lives in one surface — instead of being
          scattered across eight pages each.
        </p>
      </header>

      <Section
        icon={<Users className="h-5 w-5" />}
        title="Customer-facing"
        subtitle="A sales rep stops thinking 'which page do I need?' and starts thinking 'which customer am I working on?'"
        silos={customerSilos}
        workbench={
          <WorkbenchMockup
            title="Acme Logistics"
            subtitle="Customer Workbench — every signal about Acme on one page"
            url="/customers/acme"
            headerStats={[
              { label: "Health", value: "84" },
              { label: "Owner", value: "Sarah" },
              { label: "Last touch", value: "2d ago" },
              { label: "MTD revenue", value: "$184k" },
            ]}
            tabs={["Overview", "People", "Quotes & RFPs", "Lanes", "Conversations", "AI Insights"]}
            panels={customerPanels}
          />
        }
      />

      <Section
        icon={<Truck className="h-5 w-5" />}
        title="Carrier-facing"
        subtitle="Carrier intelligence already touches four pages today — they share the same object."
        silos={carrierSilos}
        workbench={
          <WorkbenchMockup
            title="Swift Transport"
            subtitle="Carrier Workbench — reliability, capacity, pricing, and outreach in one place"
            url="/carriers/swift-transport"
            headerStats={[
              { label: "MC", value: "1234567" },
              { label: "Reliability", value: "92" },
              { label: "Tier", value: "A" },
              { label: "In-flight", value: "7" },
            ]}
            tabs={["Overview", "Lanes Covered", "Pricing History", "Outreach", "Available Match"]}
            panels={carrierPanels}
          />
        }
      />

      <section className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary/10 text-primary p-2">
            <Inbox className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">What stays as a queue</h2>
            <p className="text-sm text-muted-foreground">
              Not everything collapses into a workbench. Some surfaces are genuinely queue-shaped.
            </p>
          </div>
        </div>

        <Card className="border-blue-200 bg-blue-50/40 dark:border-blue-900/60 dark:bg-blue-950/20">
          <CardContent className="p-6 space-y-5">
            <div>
              <p className="text-sm font-medium mb-2">Stay top-level (queue-shaped):</p>
              <ul className="space-y-1 text-sm text-foreground/90 pl-4">
                <li>• Daily Priorities Workspace — your morning queue across every customer & carrier</li>
                <li>• Lane Inbox / Lane Work Queue — assignable lane workflow, cross-account</li>
                <li>• Conversations Inbox — unread emails across all customers (drill-in opens the workbench)</li>
              </ul>
            </div>

            <div className="rounded-md border bg-background p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                The rule of thumb
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div className="flex items-start gap-2">
                  <Sparkles className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <span className="font-medium">Object-shaped</span>
                    <p className="text-muted-foreground text-xs">
                      Acme Corp · Swift Transport · MEM→DAL lane → <strong>Workbench</strong>
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <Inbox className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <span className="font-medium">Queue-shaped</span>
                    <p className="text-muted-foreground text-xs">
                      Today's calls · unassigned lanes · new emails → <strong>Top-level inbox</strong>
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <p className="text-sm font-medium mb-2">Result:</p>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>Sidebar collapses from ~15 entries to three groupings:</span>
                <Badge variant="outline">Customers</Badge>
                <span>·</span>
                <Badge variant="outline">Carriers</Badge>
                <span>·</span>
                <Badge variant="outline">My Work</Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <footer className="border-t pt-6 text-xs text-muted-foreground">
        This page is a sketch — none of these workbench routes exist yet. The orange cards on the left
        are real pages today; the green panels on the right are how they'd consolidate.
      </footer>
    </div>
  );
}
