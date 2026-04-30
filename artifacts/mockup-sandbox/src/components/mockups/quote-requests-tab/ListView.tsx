import { useState } from "react";
import {
  Inbox,
  Search,
  Filter,
  RefreshCw,
  Plus,
  ChevronDown,
  Mail,
  Truck,
  Clock,
  AlertTriangle,
  Sparkles,
  Bookmark,
  CheckSquare,
  Square,
  MoreHorizontal,
  ArrowUpDown,
  ArrowUp,
  Zap,
  AlertCircle,
} from "lucide-react";

type Sla = "ok" | "warning" | "breached";
type Status = "pending" | "quoted" | "won" | "lost_price" | "no_response";
type Confidence = number;
type SenderType = "free_email" | "known_customer" | "unknown_domain";

type Row = {
  id: string;
  selected?: boolean;
  senderName: string;
  senderEmail: string;
  customerName: string;
  customerKnown: boolean;
  lane: string;
  equipment: string;
  requestedAt: string;
  ageRel: string;
  sla: Sla;
  slaCopy: string;
  status: Status;
  rep: { name: string; initials: string; color: string } | null;
  confidence: Confidence;
  lastActivity: string;
  senderType: SenderType;
  attachedSignals?: number;
};

const ROWS: Row[] = [
  {
    id: "qr-1041",
    senderName: "Marcus Webb",
    senderEmail: "marcus.webb@dewell.com",
    customerName: "Dewell Container",
    customerKnown: true,
    lane: "ATLANTA, GA → DALLAS, TX",
    equipment: "Dry Van",
    requestedAt: "Apr 30, 8:14 AM",
    ageRel: "23m",
    sla: "ok",
    slaCopy: "On track",
    status: "pending",
    rep: null,
    confidence: 0.94,
    lastActivity: "Auto-created 23m ago",
    senderType: "known_customer",
  },
  {
    id: "qr-1040",
    senderName: "Sarah Hensley",
    senderEmail: "shensley@acuitybrands.com",
    customerName: "Acuity Brands",
    customerKnown: true,
    lane: "CONYERS, GA → CHICAGO, IL",
    equipment: "Dry Van · 42k lbs",
    requestedAt: "Apr 30, 6:50 AM",
    ageRel: "1h 47m",
    sla: "warning",
    slaCopy: "SLA in 13m",
    status: "pending",
    rep: { name: "Adan Castaneda", initials: "AC", color: "bg-violet-500" },
    confidence: 0.91,
    lastActivity: "Customer replied 12m ago",
    senderType: "known_customer",
    attachedSignals: 2,
  },
  {
    id: "qr-1039",
    senderName: "Linda Tran",
    senderEmail: "linda.tran@pacificfoods.com",
    customerName: "Pacific Foods",
    customerKnown: true,
    lane: "TUALATIN, OR → PHOENIX, AZ",
    equipment: "Reefer",
    requestedAt: "Apr 30, 5:02 AM",
    ageRel: "3h 35m",
    sla: "warning",
    slaCopy: "SLA at 4h",
    status: "quoted",
    rep: { name: "Erin Patel", initials: "EP", color: "bg-emerald-500" },
    confidence: 0.88,
    lastActivity: "You replied 1h ago",
    senderType: "known_customer",
  },
  {
    id: "qr-1038",
    senderName: "Tomás Rivera",
    senderEmail: "trivera@jcilaredo.com",
    customerName: "JCI Laredo",
    customerKnown: true,
    lane: "LAREDO, TX → ELIZABETH, NJ",
    equipment: "Dry Van",
    requestedAt: "Apr 29, 10:11 PM",
    ageRel: "11h",
    sla: "breached",
    slaCopy: "Breached 7h",
    status: "pending",
    rep: { name: "Adan Castaneda", initials: "AC", color: "bg-violet-500" },
    confidence: 0.96,
    lastActivity: "Customer replied 22m ago",
    senderType: "known_customer",
    attachedSignals: 1,
  },
  {
    id: "qr-1037",
    senderName: "k.mendoza",
    senderEmail: "k.mendoza@gmail.com",
    customerName: "Unknown — needs review",
    customerKnown: false,
    lane: "FRESNO, CA → SEATTLE, WA",
    equipment: "Reefer",
    requestedAt: "Apr 29, 6:33 PM",
    ageRel: "14h",
    sla: "breached",
    slaCopy: "Breached 10h",
    status: "pending",
    rep: null,
    confidence: 0.74,
    lastActivity: "Auto-created 14h ago",
    senderType: "free_email",
  },
  {
    id: "qr-1036",
    senderName: "Diane Ferraro",
    senderEmail: "dferraro@atlas-logistics.io",
    customerName: "Atlas Logistics",
    customerKnown: true,
    lane: "INDIANAPOLIS, IN → MEMPHIS, TN",
    equipment: "Flatbed",
    requestedAt: "Apr 29, 3:18 PM",
    ageRel: "17h",
    sla: "breached",
    slaCopy: "Breached 13h",
    status: "no_response",
    rep: { name: "Tyrell James", initials: "TJ", color: "bg-amber-500" },
    confidence: 0.82,
    lastActivity: "No reply in 17h",
    senderType: "known_customer",
  },
  {
    id: "qr-1035",
    senderName: "Patel Logistics",
    senderEmail: "ops@patel-logistics.com",
    customerName: "Patel Logistics",
    customerKnown: true,
    lane: "OAKLAND, CA → DENVER, CO",
    equipment: "Dry Van",
    requestedAt: "Apr 29, 11:02 AM",
    ageRel: "21h",
    sla: "breached",
    slaCopy: "Breached 17h",
    status: "won",
    rep: { name: "Erin Patel", initials: "EP", color: "bg-emerald-500" },
    confidence: 0.93,
    lastActivity: "Won 4h ago · $2,450",
    senderType: "known_customer",
  },
];

function slaPill(sla: Sla, copy: string) {
  const cls =
    sla === "ok"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : sla === "warning"
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : "bg-rose-50 text-rose-800 border-rose-200";
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}
    >
      {sla === "breached" && <AlertTriangle className="h-3 w-3" />}
      {sla === "warning" && <Clock className="h-3 w-3" />}
      {copy}
    </span>
  );
}

const STATUS_CFG: Record<Status, { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  quoted: { label: "Quoted", cls: "bg-violet-50 text-violet-700 border-violet-200" },
  won: { label: "Won", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  lost_price: { label: "Lost — price", cls: "bg-rose-50 text-rose-800 border-rose-200" },
  no_response: { label: "No response", cls: "bg-zinc-100 text-zinc-600 border-zinc-200" },
};

function statusPill(s: Status) {
  const c = STATUS_CFG[s];
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${c.cls}`}
    >
      {c.label}
    </span>
  );
}

function confidenceCell(c: Confidence) {
  const tone =
    c >= 0.9 ? "text-emerald-700" : c >= 0.8 ? "text-sky-700" : "text-amber-700";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-12 h-1.5 rounded-full bg-zinc-100 overflow-hidden">
        <div
          className={`h-full ${
            c >= 0.9 ? "bg-emerald-500" : c >= 0.8 ? "bg-sky-500" : "bg-amber-500"
          }`}
          style={{ width: `${Math.round(c * 100)}%` }}
        />
      </div>
      <span className={`text-[11px] tabular-nums ${tone}`}>{c.toFixed(2)}</span>
    </div>
  );
}

const PRESETS = [
  { key: "myOpen", label: "My open", count: 14, active: true },
  { key: "unassigned", label: "Unassigned", count: 6 },
  { key: "sla", label: "SLA breaching", count: 4 },
  { key: "free", label: "Free-email senders", count: 3 },
  { key: "all", label: "All open", count: 41 },
  { key: "closed", label: "Closed", count: 312 },
];

const KPIS = [
  { label: "Open requests", value: 41, sub: "Across all reps" },
  { label: "Unassigned", value: 6, sub: "Pending pickup" },
  { label: "SLA breaching today", value: 4, tone: "rose" as const, sub: "Need a reply now" },
  { label: "Won this week", value: 11, tone: "emerald" as const, sub: "$28,420 booked" },
];

export default function ListView() {
  const [selected, setSelected] = useState<Set<string>>(new Set(["qr-1040", "qr-1038"]));
  const allSelected = selected.size === ROWS.length;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(ROWS.map((r) => r.id)));
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="px-6 py-4 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-md bg-zinc-900 flex items-center justify-center">
              <Inbox className="h-4 w-4 text-amber-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                Quote Requests
              </h1>
              <p className="text-xs text-zinc-500">
                Every customer email quote request, one row each ·{" "}
                <span className="font-mono">source = email_signal</span>
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
              <input
                type="text"
                placeholder="Search sender, lane, customer…"
                className="pl-7 pr-3 py-1.5 text-xs border rounded w-64 focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
            <button className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs border rounded hover:bg-zinc-50">
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <button className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs border rounded hover:bg-zinc-50">
              <Bookmark className="h-3.5 w-3.5" />
              Saved views
              <ChevronDown className="h-3 w-3" />
            </button>
            <button className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-zinc-900 text-white rounded hover:bg-zinc-800">
              <Plus className="h-3.5 w-3.5" />
              New from email
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div className="px-6 pb-3 grid grid-cols-4 gap-2">
          {KPIS.map((k) => (
            <button
              key={k.label}
              className="text-left rounded border bg-white px-3 py-2 hover:border-amber-400 transition"
            >
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                {k.label}
              </div>
              <div
                className={`text-2xl font-semibold tabular-nums ${
                  k.tone === "rose"
                    ? "text-rose-700"
                    : k.tone === "emerald"
                    ? "text-emerald-700"
                    : "text-zinc-900"
                }`}
              >
                {k.value}
              </div>
              <div className="text-[10px] text-zinc-500">{k.sub}</div>
            </button>
          ))}
        </div>
      </header>

      <div className="flex">
        {/* Filter rail */}
        <aside className="w-60 shrink-0 border-r bg-white p-4 space-y-5 min-h-[calc(100vh-160px)]">
          <div>
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
              <Filter className="h-3 w-3" />
              Presets
            </div>
            <div className="space-y-0.5">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-xs ${
                    p.active
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-700 hover:bg-zinc-100"
                  }`}
                >
                  <span>{p.label}</span>
                  <span
                    className={`tabular-nums ${
                      p.active ? "text-amber-300" : "text-zinc-400"
                    }`}
                  >
                    {p.count}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
              Status
            </div>
            <div className="space-y-1.5">
              {["Pending", "Quoted", "Won", "Lost", "No response", "Expired"].map(
                (s) => (
                  <label
                    key={s}
                    className="flex items-center gap-2 text-xs text-zinc-700"
                  >
                    <input
                      type="checkbox"
                      defaultChecked={s === "Pending" || s === "Quoted"}
                      className="rounded"
                    />
                    {s}
                  </label>
                ),
              )}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
              Age
            </div>
            <div className="grid grid-cols-2 gap-1">
              {["< 1h", "1–4h", "4–24h", "1–3d", "> 3d"].map((a) => (
                <button
                  key={a}
                  className="text-[11px] border rounded px-1.5 py-1 hover:bg-zinc-50"
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
              Sender type
            </div>
            <div className="space-y-1.5 text-xs">
              {[
                { l: "Known customer", c: 32 },
                { l: "Free email", c: 7 },
                { l: "Unknown domain", c: 2 },
              ].map((x) => (
                <label
                  key={x.l}
                  className="flex items-center justify-between gap-2 text-zinc-700"
                >
                  <span className="flex items-center gap-2">
                    <input type="checkbox" defaultChecked className="rounded" />
                    {x.l}
                  </span>
                  <span className="text-zinc-400 tabular-nums">{x.c}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
              <span>Confidence floor</span>
              <span className="text-emerald-600">≥ 0.70</span>
            </div>
            <input
              type="range"
              min={50}
              max={100}
              defaultValue={70}
              className="w-full"
            />
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 p-4">
          {/* Bulk action bar */}
          {selected.size > 0 && (
            <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded border border-amber-300 bg-amber-50">
              <CheckSquare className="h-4 w-4 text-amber-700" />
              <span className="text-xs text-amber-900 font-medium">
                {selected.size} selected
              </span>
              <div className="ml-auto flex items-center gap-1">
                {[
                  "Assign to me",
                  "Assign to…",
                  "Snooze 1d",
                  "Mark lost — no response",
                  "Escalate to Leak Queue",
                ].map((l) => (
                  <button
                    key={l}
                    className="text-[11px] px-2 py-1 rounded bg-white border border-amber-300 hover:bg-amber-100"
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Table */}
          <div className="bg-white rounded border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-zinc-50 text-[10px] uppercase tracking-wider text-zinc-500 border-b">
                <tr>
                  <th className="w-8 px-3 py-2 text-left">
                    <button onClick={toggleAll}>
                      {allSelected ? (
                        <CheckSquare className="h-3.5 w-3.5 text-zinc-700" />
                      ) : (
                        <Square className="h-3.5 w-3.5 text-zinc-400" />
                      )}
                    </button>
                  </th>
                  <th className="text-left px-2 py-2">Sender</th>
                  <th className="text-left px-2 py-2">Customer</th>
                  <th className="text-left px-2 py-2">Lane</th>
                  <th className="text-left px-2 py-2">
                    <span className="inline-flex items-center gap-1">
                      Requested
                      <ArrowUp className="h-3 w-3" />
                    </span>
                  </th>
                  <th className="text-left px-2 py-2">SLA</th>
                  <th className="text-left px-2 py-2">Status</th>
                  <th className="text-left px-2 py-2">Rep</th>
                  <th className="text-left px-2 py-2">
                    <span className="inline-flex items-center gap-1">
                      Conf.
                      <ArrowUpDown className="h-3 w-3 opacity-40" />
                    </span>
                  </th>
                  <th className="text-left px-2 py-2">Last activity</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => {
                  const isSel = selected.has(r.id);
                  return (
                    <tr
                      key={r.id}
                      className={`border-b last:border-b-0 hover:bg-amber-50/40 cursor-pointer ${
                        isSel ? "bg-amber-50/60" : ""
                      }`}
                    >
                      <td className="px-3 py-2.5 align-top">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(r.id);
                          }}
                        >
                          {isSel ? (
                            <CheckSquare className="h-3.5 w-3.5 text-amber-700" />
                          ) : (
                            <Square className="h-3.5 w-3.5 text-zinc-400" />
                          )}
                        </button>
                      </td>
                      <td className="px-2 py-2.5 align-top max-w-[180px]">
                        <div className="font-medium text-zinc-900 truncate">
                          {r.senderName}
                        </div>
                        <div className="font-mono text-[10px] text-zinc-500 truncate">
                          {r.senderEmail}
                        </div>
                        {r.senderType === "free_email" && (
                          <span className="mt-0.5 inline-block text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                            Free email
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 align-top">
                        <div
                          className={`truncate ${
                            r.customerKnown
                              ? "text-zinc-900"
                              : "text-amber-700 italic"
                          }`}
                        >
                          {r.customerName}
                        </div>
                      </td>
                      <td className="px-2 py-2.5 align-top max-w-[260px]">
                        <div className="text-zinc-900 truncate">{r.lane}</div>
                        <div className="text-[10px] text-zinc-500 inline-flex items-center gap-1 mt-0.5">
                          <Truck className="h-3 w-3" />
                          {r.equipment}
                        </div>
                      </td>
                      <td className="px-2 py-2.5 align-top whitespace-nowrap">
                        <div>{r.ageRel}</div>
                        <div className="text-[10px] text-zinc-500">
                          {r.requestedAt}
                        </div>
                      </td>
                      <td className="px-2 py-2.5 align-top">
                        {slaPill(r.sla, r.slaCopy)}
                      </td>
                      <td className="px-2 py-2.5 align-top">
                        {statusPill(r.status)}
                        {r.attachedSignals && (
                          <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-zinc-500">
                            <Mail className="h-3 w-3" />+{r.attachedSignals}{" "}
                            attached
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2.5 align-top">
                        {r.rep ? (
                          <div className="inline-flex items-center gap-1.5">
                            <span
                              className={`h-5 w-5 rounded-full ${r.rep.color} text-white text-[10px] font-medium flex items-center justify-center`}
                            >
                              {r.rep.initials}
                            </span>
                            <span className="text-zinc-700">
                              {r.rep.name.split(" ")[0]}
                            </span>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 border border-zinc-200">
                            Unassigned
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 align-top">
                        {confidenceCell(r.confidence)}
                      </td>
                      <td className="px-2 py-2.5 align-top text-zinc-600">
                        {r.lastActivity}
                      </td>
                      <td className="px-2 py-2.5 align-top">
                        <button className="text-zinc-400 hover:text-zinc-700">
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="flex items-center justify-between px-3 py-2 border-t bg-zinc-50 text-[11px] text-zinc-500">
              <span>
                Showing 7 of 41 open · default sort{" "}
                <span className="font-mono">requested ASC</span>
              </span>
              <div className="flex items-center gap-2">
                <button className="px-2 py-1 border rounded bg-white hover:bg-zinc-100">
                  Load more
                </button>
              </div>
            </div>
          </div>

          {/* Footer hint strip */}
          <div className="mt-3 flex items-center gap-3 text-[11px] text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              j/k navigate · Enter open · w mark won · l mark lost · s snooze · ?
              shortcuts
            </span>
            <span className="ml-auto inline-flex items-center gap-1">
              <Zap className="h-3 w-3" />
              Auto-refresh 30s
            </span>
          </div>

          {/* Quote-opp boundary callout */}
          <div className="mt-4 rounded border border-sky-200 bg-sky-50 p-3 text-[11px] text-sky-900 flex items-start gap-2">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div>
              <span className="font-medium">Boundary reminder:</span>{" "}
              <span className="font-mono">source='manual'</span> and{" "}
              <span className="font-mono">source='tms'</span> rows live on the
              legacy <span className="underline">Customer Quotes</span>{" "}
              dashboard, not here. Capture-Leak-Queue (admin-only) catches
              anything the autopilot skipped.
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
