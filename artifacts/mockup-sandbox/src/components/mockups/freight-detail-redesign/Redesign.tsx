import { useState } from "react";
import {
  ArrowLeft,
  Activity,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GripVertical,
  Search,
  Send,
  Sparkles,
  TrendingUp,
  AlertTriangle,
  Phone,
  Mail,
  Info,
  CheckCircle2,
  XCircle,
  Clock,
  DollarSign,
  Truck,
  Eye,
  MoreHorizontal,
} from "lucide-react";

type Bucket = "proven" | "strong" | "exploratory";

type Carrier = {
  id: string;
  name: string;
  mc: string;
  fitScore: number;
  bucket: Bucket;
  lastRate: number | null;
  lastQuoteDaysAgo: number | null;
  loadsOnLane90d: number;
  responsivenessHours: number | null;
  flags: Array<"passed_last_time" | "replied_other_opp" | "incumbent" | "fast_responder">;
  why: {
    history: string;
    rate: string;
    region: string;
    responsiveness: string;
  };
  email: string | null;
  phone: string | null;
};

type Excluded = {
  id: string;
  name: string;
  reason: "recent_contact" | "daily_cap" | "do_not_use" | "not_approved" | "opted_out";
};

const PROVEN: Carrier[] = [
  {
    id: "c1",
    name: "Midwest Reefer Lines",
    mc: "MC 487213",
    fitScore: 94,
    bucket: "proven",
    lastRate: 2350,
    lastQuoteDaysAgo: 12,
    loadsOnLane90d: 6,
    responsivenessHours: 1.5,
    flags: ["incumbent", "fast_responder"],
    why: {
      history: "Hauled this lane 6× in last 90d (Lactalis · BELVIDERE→STURTEVANT)",
      rate: "Last booked $2,350 · 12 days ago · within market band",
      region: "Domiciled in Rockford, IL · 18 mi from origin",
      responsiveness: "Replies within ~1.5h on average · 92% reply rate",
    },
    email: "dispatch@midwestreefer.com",
    phone: "(815) 555-0142",
  },
  {
    id: "c2",
    name: "Heartland Cold Chain",
    mc: "MC 612998",
    fitScore: 89,
    bucket: "proven",
    lastRate: 2425,
    lastQuoteDaysAgo: 21,
    loadsOnLane90d: 4,
    responsivenessHours: 3.2,
    flags: ["incumbent"],
    why: {
      history: "4 loads on this corridor + 11 across other Lactalis lanes",
      rate: "Last booked $2,425 · 21 days ago · slightly above market",
      region: "Network covers IL/WI dairy lanes weekly",
      responsiveness: "Replies within ~3h · 88% reply rate",
    },
    email: "ops@heartlandcoldchain.com",
    phone: "(563) 555-0188",
  },
  {
    id: "c3",
    name: "Stateline Refrigerated",
    mc: "MC 552410",
    fitScore: 86,
    bucket: "proven",
    lastRate: 2280,
    lastQuoteDaysAgo: 6,
    loadsOnLane90d: 3,
    responsivenessHours: 2.1,
    flags: ["replied_other_opp"],
    why: {
      history: "3 loads on this lane · replied 'interested' on another Lactalis lane yesterday",
      rate: "Last booked $2,280 · 6 days ago · best-in-shortlist rate",
      region: "Janesville, WI domicile · 22 mi from destination",
      responsiveness: "Replies within ~2h · 95% reply rate",
    },
    email: "carriersales@statelinerefrig.com",
    phone: "(608) 555-0177",
  },
];

const STRONG: Carrier[] = [
  {
    id: "c4",
    name: "Polar Logistics Group",
    mc: "MC 718245",
    fitScore: 78,
    bucket: "strong",
    lastRate: 2510,
    lastQuoteDaysAgo: 45,
    loadsOnLane90d: 1,
    responsivenessHours: 4.0,
    flags: ["fast_responder"],
    why: {
      history: "1 load on this lane · 8 loads on adjacent IL→WI corridors",
      rate: "Last booked $2,510 · 45 days ago · above current market",
      region: "Strong WI dairy lane coverage · underused on this exact O/D",
      responsiveness: "Replies within ~4h · 81% reply rate",
    },
    email: "freight@polarlogistics.com",
    phone: "(414) 555-0199",
  },
  {
    id: "c5",
    name: "Cornbelt Refrigerated",
    mc: "MC 829441",
    fitScore: 74,
    bucket: "strong",
    lastRate: null,
    lastQuoteDaysAgo: null,
    loadsOnLane90d: 0,
    responsivenessHours: 5.5,
    flags: [],
    why: {
      history: "No history on this exact lane · 14 loads on Lactalis since Jan",
      rate: "No prior quote · suggested $2,300–$2,450 buy",
      region: "Iowa-based with weekly WI runs",
      responsiveness: "Replies within ~5h · 72% reply rate",
    },
    email: "dispatch@cornbeltref.com",
    phone: "(319) 555-0166",
  },
  {
    id: "c6",
    name: "Great Lakes Cold",
    mc: "MC 401829",
    fitScore: 71,
    bucket: "strong",
    lastRate: 2390,
    lastQuoteDaysAgo: 33,
    loadsOnLane90d: 2,
    responsivenessHours: 6.0,
    flags: ["passed_last_time"],
    why: {
      history: "2 loads · passed on last AVL request 11 days ago (rate too low)",
      rate: "Last booked $2,390 · 33 days ago",
      region: "Michigan domicile, deadheads into IL weekly",
      responsiveness: "Replies within ~6h · 68% reply rate",
    },
    email: "loads@greatlakescold.com",
    phone: "(231) 555-0144",
  },
];

const EXPLORATORY: Carrier[] = [
  {
    id: "c7",
    name: "Northstar Reefer Co.",
    mc: "MC 902118",
    fitScore: 62,
    bucket: "exploratory",
    lastRate: null,
    lastQuoteDaysAgo: null,
    loadsOnLane90d: 0,
    responsivenessHours: null,
    flags: [],
    why: {
      history: "New to FreightDNA · no prior history with Lactalis",
      rate: "No prior quote · market $2,300–$2,500",
      region: "Minneapolis-based · runs MN→WI weekly",
      responsiveness: "No prior outreach data",
    },
    email: "ops@northstarreefer.com",
    phone: "(612) 555-0190",
  },
  {
    id: "c8",
    name: "Prairie Freight Systems",
    mc: "MC 711034",
    fitScore: 58,
    bucket: "exploratory",
    lastRate: null,
    lastQuoteDaysAgo: null,
    loadsOnLane90d: 0,
    responsivenessHours: null,
    flags: [],
    why: {
      history: "New prospect · domiciled near origin",
      rate: "No prior quote",
      region: "Beloit, WI · 28 mi from destination",
      responsiveness: "No prior outreach data",
    },
    email: "info@prairiefreight.com",
    phone: "(608) 555-0123",
  },
];

const EXCLUDED: Excluded[] = [
  { id: "e1", name: "FreshHaul Trucking", reason: "recent_contact" },
  { id: "e2", name: "Coldline Express", reason: "recent_contact" },
  { id: "e3", name: "ArcticWay Logistics", reason: "daily_cap" },
  { id: "e4", name: "Snowbelt Carriers", reason: "daily_cap" },
  { id: "e5", name: "Tundra Reefer Co.", reason: "do_not_use" },
  { id: "e6", name: "ChillStream Inc.", reason: "not_approved" },
  { id: "e7", name: "RefrigeRoute LLC", reason: "opted_out" },
];

const EXCLUDED_LABEL: Record<Excluded["reason"], string> = {
  recent_contact: "Recently contacted (48h)",
  daily_cap: "Daily cap reached",
  do_not_use: "Do not use",
  not_approved: "Not on Lactalis approved list",
  opted_out: "Opted out",
};

function flagBadge(flag: Carrier["flags"][number]) {
  switch (flag) {
    case "incumbent":
      return { label: "Incumbent", cls: "bg-amber-100 text-amber-900 border-amber-300" };
    case "fast_responder":
      return { label: "Fast responder", cls: "bg-emerald-100 text-emerald-900 border-emerald-300" };
    case "passed_last_time":
      return { label: "Passed last time", cls: "bg-rose-100 text-rose-900 border-rose-300" };
    case "replied_other_opp":
      return { label: "Replied to another Lactalis lane yesterday", cls: "bg-yellow-100 text-yellow-900 border-yellow-300" };
  }
}

function CarrierRow({ c, selected, onToggle }: { c: Carrier; selected: boolean; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [rate, setRate] = useState("");

  return (
    <div className="border-b border-zinc-200 last:border-b-0 hover:bg-zinc-50 transition-colors">
      <div className="flex items-center gap-3 px-4 py-3">
        <GripVertical className="h-4 w-4 text-zinc-300 cursor-grab shrink-0" />
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-zinc-300 accent-amber-500"
          checked={selected}
          onChange={onToggle}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-zinc-900 text-sm">{c.name}</span>
            <span className="text-[11px] text-zinc-500">{c.mc}</span>
            {c.flags.map((f) => {
              const b = flagBadge(f);
              return (
                <span key={f} className={`text-[10px] px-1.5 py-0.5 rounded border ${b.cls} font-medium`}>
                  {b.label}
                </span>
              );
            })}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-600">
            <span className="inline-flex items-center gap-1">
              <Truck className="h-3 w-3" />
              {c.loadsOnLane90d} loads · 90d
            </span>
            <span className="inline-flex items-center gap-1">
              <DollarSign className="h-3 w-3" />
              {c.lastRate ? `$${c.lastRate.toLocaleString()} · ${c.lastQuoteDaysAgo}d ago` : "no prior quote"}
            </span>
            {c.responsivenessHours !== null && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                ~{c.responsivenessHours}h reply
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <div className="text-right">
            <div className="text-base font-semibold text-zinc-900 leading-none">{c.fitScore}</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">fit</div>
          </div>
          <button
            onClick={() => setOpen((v) => !v)}
            className="ml-2 p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-900"
            title="Why this carrier?"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          <button className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-900">
            <Phone className="h-3.5 w-3.5" />
          </button>
          <button className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-900">
            <Mail className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {open && (
        <div className="px-4 pb-3 -mt-1">
          <div className="bg-zinc-50 border border-zinc-200 rounded-md p-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs text-zinc-700">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">History</div>
              <div className="mt-0.5">{c.why.history}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">Rate context</div>
              <div className="mt-0.5">{c.why.rate}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">Region</div>
              <div className="mt-0.5">{c.why.region}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">Responsiveness</div>
              <div className="mt-0.5">{c.why.responsiveness}</div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span className="text-[11px] text-zinc-500 mr-1">Log outcome:</span>
            {[
              { k: "interested_now", label: "Interested", cls: "bg-emerald-600 hover:bg-emerald-700 text-white" },
              { k: "interested_few_days", label: "Maybe (later)", cls: "bg-amber-500 hover:bg-amber-600 text-white" },
              { k: "not_interested", label: "Pass", cls: "bg-zinc-200 hover:bg-zinc-300 text-zinc-800" },
              { k: "no_reply", label: "No reply", cls: "bg-zinc-200 hover:bg-zinc-300 text-zinc-800" },
            ].map((o) => (
              <button
                key={o.k}
                onClick={() => setOutcome(o.k)}
                className={`text-[11px] px-2 py-1 rounded font-medium ${o.cls} ${
                  outcome === o.k ? "ring-2 ring-offset-1 ring-zinc-900" : ""
                }`}
              >
                {o.label}
              </button>
            ))}
            {(outcome === "interested_now" || outcome === "interested_few_days") && (
              <>
                <span className="text-zinc-400">·</span>
                <div className="relative">
                  <DollarSign className="h-3 w-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                  <input
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                    placeholder="quoted rate"
                    className="text-[11px] pl-5 pr-2 py-1 border border-zinc-300 rounded w-24"
                  />
                </div>
                <button className="text-[11px] px-2 py-1 rounded font-medium bg-zinc-900 text-white hover:bg-zinc-800">
                  Save
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BucketSection({
  title,
  count,
  hint,
  defaultOpen,
  carriers,
  selected,
  onToggle,
}: {
  title: string;
  count: number;
  hint: string;
  defaultOpen: boolean;
  carriers: Carrier[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-zinc-200 rounded-lg bg-white overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-zinc-50 hover:bg-zinc-100 border-b border-zinc-200"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
          <span className="text-sm font-semibold text-zinc-900">{title}</span>
          <span className="text-xs text-zinc-500">·</span>
          <span className="text-xs text-zinc-600">{count} carriers</span>
          <span className="text-xs text-zinc-400 hidden md:inline">· {hint}</span>
        </div>
        <span className="text-[11px] text-zinc-500">{selected.size > 0 ? `${[...selected].filter((id) => carriers.some((c) => c.id === id)).length} selected` : ""}</span>
      </button>
      {open && (
        <div>
          {carriers.map((c) => (
            <CarrierRow key={c.id} c={c} selected={selected.has(c.id)} onToggle={() => onToggle(c.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Redesign() {
  const [selected, setSelected] = useState<Set<string>>(new Set(["c1", "c3"]));
  const [intelOpen, setIntelOpen] = useState(false);
  const [excludedOpen, setExcludedOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [search, setSearch] = useState("");

  const toggle = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const allEligible = [...PROVEN, ...STRONG, ...EXPLORATORY];
  const totalSelected = selected.size;

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900 font-['Inter',system-ui,sans-serif]">
      {/* ── STICKY HEADER ──────────────────────────────────────────────── */}
      <div className="sticky top-0 z-30 bg-white border-b border-zinc-200 shadow-sm">
        <div className="px-6 py-2.5 flex items-center gap-3">
          <button className="text-zinc-500 hover:text-zinc-900 inline-flex items-center gap-1 text-sm">
            <ArrowLeft className="h-4 w-4" /> Queue
          </button>
          <div className="h-5 w-px bg-zinc-200" />
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-zinc-900 truncate">Lactalis American Group</span>
            <span className="text-zinc-300">·</span>
            <span className="text-sm text-zinc-700 truncate">BELVIDERE, IL → STURTEVANT, WI</span>
            <span className="text-[11px] px-1.5 py-0.5 bg-zinc-100 border border-zinc-200 rounded text-zinc-600 font-medium">Reefer</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setActivityOpen((v) => !v)}
              className="text-xs px-2.5 py-1.5 inline-flex items-center gap-1.5 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 rounded"
              title="Activity log"
            >
              <Activity className="h-3.5 w-3.5" /> Activity
            </button>
            <button className="text-xs px-2.5 py-1.5 inline-flex items-center gap-1.5 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 rounded">
              <ExternalLink className="h-3.5 w-3.5" /> Compare to LWQ
            </button>
            <button className="text-xs px-2.5 py-1.5 inline-flex items-center gap-1 text-zinc-500 hover:bg-zinc-100 rounded">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* One-line opportunity summary */}
        <div className="px-6 py-2 border-t border-zinc-100 bg-zinc-50/50">
          <div className="flex items-center gap-4 text-[12px] text-zinc-700 flex-wrap">
            <span className="inline-flex items-center gap-1.5">
              <Truck className="h-3.5 w-3.5 text-zinc-400" />
              <span className="font-medium">1 load</span>
            </span>
            <span className="text-zinc-300">·</span>
            <span>Pickup <span className="font-medium">Apr 26</span> · 3 days lead</span>
            <span className="text-zinc-300">·</span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Normal confidence
            </span>
            <span className="text-zinc-300">·</span>
            <span><span className="font-medium">0 / 25</span> sent</span>
            <span className="text-zinc-300">·</span>
            <span>0 replies</span>
            <span className="text-zinc-300">·</span>
            <span className="text-emerald-700 inline-flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> Auto-covered yesterday by Midwest Reefer @ $2,350
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-[1340px] mx-auto px-6 py-5 space-y-4">
        {/* ── CARRIER INTELLIGENCE (collapsed band) ──────────────────────── */}
        <div className="border border-zinc-200 rounded-lg bg-white overflow-hidden">
          <button
            onClick={() => setIntelOpen((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-zinc-50"
          >
            <div className="flex items-center gap-2">
              {intelOpen ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
              <Sparkles className="h-4 w-4 text-amber-500" />
              <span className="text-sm font-semibold">Carrier Intelligence — Suggested buy</span>
              <span className="text-zinc-300">·</span>
              <span className="text-sm font-mono font-semibold text-zinc-900">$2,300 – $2,450</span>
              <span className="text-[11px] text-zinc-500 ml-1">SONAR + your realized history</span>
            </div>
            <span className="text-[11px] text-zinc-500">{intelOpen ? "Hide" : "Show details"}</span>
          </button>
          {intelOpen && (
            <div className="px-4 pb-4 pt-1 grid grid-cols-3 gap-4 text-xs">
              <div className="border border-zinc-200 rounded p-3">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">SONAR market</div>
                <div className="mt-1 font-mono text-base font-semibold">$2,380</div>
                <div className="text-[11px] text-zinc-500 mt-0.5">7-day avg · IL→WI Reefer</div>
              </div>
              <div className="border border-zinc-200 rounded p-3">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">Your last 8 loads</div>
                <div className="mt-1 font-mono text-base font-semibold">$2,335</div>
                <div className="text-[11px] text-zinc-500 mt-0.5">avg paid · 90d window</div>
              </div>
              <div className="border border-zinc-200 rounded p-3">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">TRAC forecast</div>
                <div className="mt-1 font-mono text-base font-semibold inline-flex items-center gap-1">
                  $2,400 <TrendingUp className="h-3.5 w-3.5 text-amber-500" />
                </div>
                <div className="text-[11px] text-zinc-500 mt-0.5">3-week · slight upward pressure</div>
              </div>
            </div>
          )}
        </div>

        {/* ── RANKED CARRIERS ────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">Ranked carriers</h2>
              <p className="text-[12px] text-zinc-500 mt-0.5">
                Grouped into buckets by fit. Drag to reorder within a bucket. Excluded carriers stay visible below.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter carriers"
                  className="pl-8 pr-3 py-1.5 border border-zinc-300 rounded text-sm w-56"
                />
              </div>
            </div>
          </div>

          <BucketSection
            title="Proven"
            count={PROVEN.length}
            hint="hauled this exact lane recently"
            defaultOpen
            carriers={PROVEN}
            selected={selected}
            onToggle={toggle}
          />
          <BucketSection
            title="Strong fit · underused"
            count={STRONG.length}
            hint="high score, low recent activity on this lane"
            defaultOpen={false}
            carriers={STRONG}
            selected={selected}
            onToggle={toggle}
          />
          <BucketSection
            title="Exploratory"
            count={EXPLORATORY.length}
            hint="new prospects worth a try"
            defaultOpen={false}
            carriers={EXPLORATORY}
            selected={selected}
            onToggle={toggle}
          />
        </div>

        {/* ── EXCLUDED (collapsed) ───────────────────────────────────────── */}
        <div className="border border-zinc-200 rounded-lg bg-white">
          <button
            onClick={() => setExcludedOpen((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-zinc-50"
          >
            <div className="flex items-center gap-2 text-sm">
              {excludedOpen ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
              <span className="font-medium text-zinc-700">Excluded by guardrails</span>
              <span className="text-zinc-400">({EXCLUDED.length})</span>
            </div>
            <div className="flex items-center gap-1.5">
              {Object.entries(
                EXCLUDED.reduce<Record<string, number>>((m, e) => {
                  m[e.reason] = (m[e.reason] ?? 0) + 1;
                  return m;
                }, {}),
              ).map(([r, n]) => (
                <span key={r} className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-200 bg-zinc-50 text-zinc-600">
                  {EXCLUDED_LABEL[r as Excluded["reason"]]}: {n}
                </span>
              ))}
            </div>
          </button>
          {excludedOpen && (
            <div className="border-t border-zinc-200 divide-y divide-zinc-100">
              {EXCLUDED.map((e) => (
                <div key={e.id} className="flex items-center gap-3 px-4 py-2 text-sm text-zinc-700">
                  <XCircle className="h-3.5 w-3.5 text-zinc-400" />
                  <span className="flex-1">{e.name}</span>
                  <span className="text-[11px] text-zinc-500">{EXCLUDED_LABEL[e.reason]}</span>
                  <button className="text-[11px] text-amber-700 hover:underline">Override</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="h-20" />
      </div>

      {/* ── ACTIVITY DRAWER ─────────────────────────────────────────────── */}
      {activityOpen && (
        <>
          <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setActivityOpen(false)} />
          <div className="fixed top-0 right-0 bottom-0 w-96 bg-white border-l border-zinc-200 z-50 shadow-xl flex flex-col">
            <div className="px-4 py-3 border-b border-zinc-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-zinc-500" />
                <span className="font-semibold text-sm">Activity</span>
              </div>
              <button onClick={() => setActivityOpen(false)} className="text-zinc-400 hover:text-zinc-900 text-xs">Close</button>
            </div>
            <div className="overflow-y-auto p-4 text-xs space-y-3">
              {[
                ["10:01 AM", "SLA nudge sent to overseer", "system"],
                ["7:50 AM", "Opportunity generated from morning import", "import"],
                ["Yesterday 4:12 PM", "Auto-covered by Midwest Reefer @ $2,350", "covered"],
                ["Yesterday 2:08 PM", "Stateline Refrigerated replied 'interested' on a related Lactalis lane", "signal"],
                ["Apr 21 9:00 AM", "Generated by daily importer", "import"],
              ].map(([t, msg, kind], i) => (
                <div key={i} className="flex gap-3">
                  <div className="text-[11px] text-zinc-400 w-24 shrink-0">{t}</div>
                  <div className="flex-1 text-zinc-700">{msg}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── BULK ACTION BAR (when selected) ─────────────────────────────── */}
      {totalSelected > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-zinc-200 bg-white shadow-lg">
          <div className="max-w-[1340px] mx-auto px-6 py-3 flex items-center gap-3">
            <span className="text-sm font-medium text-zinc-900">
              {totalSelected} carrier{totalSelected === 1 ? "" : "s"} selected
            </span>
            <span className="text-xs text-zinc-500">
              · est. delivery 2:14 PM · 3 buckets · combined daily-cap ok
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button className="text-xs px-3 py-1.5 rounded border border-zinc-300 text-zinc-700 hover:bg-zinc-50 inline-flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5" /> Preview wave
              </button>
              <button className="text-xs px-3 py-1.5 rounded border border-zinc-300 text-zinc-700 hover:bg-zinc-50">
                Schedule…
              </button>
              <button className="text-xs px-3 py-1.5 rounded bg-amber-500 text-zinc-900 font-semibold hover:bg-amber-400 inline-flex items-center gap-1.5">
                <Send className="h-3.5 w-3.5" /> Send wave to {totalSelected}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── BULK SEND CALLOUT (across opportunities) ───────────────────── */}
      <div className="fixed top-24 right-6 z-20 max-w-xs bg-amber-50 border border-amber-200 rounded-lg p-3 shadow-sm">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
          <div className="text-[12px] text-amber-900">
            <div className="font-semibold">3 nearby Lactalis lanes also need outreach today.</div>
            <div className="mt-1 text-amber-800">Bulk send to top proven carriers across all 4 lanes — one click, deduped automatically.</div>
            <button className="mt-2 text-[11px] font-semibold text-amber-900 hover:underline">Open bulk sender →</button>
          </div>
        </div>
      </div>
    </div>
  );
}
