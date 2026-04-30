import {
  X,
  ExternalLink,
  Mail,
  Truck,
  MapPin,
  Sparkles,
  ChevronDown,
  Send,
  UserPlus,
  Award,
  XCircle,
  Link as LinkIcon,
  AlertTriangle,
  Clock,
  Zap,
  Copy,
  MoreHorizontal,
  ArrowUpRight,
  CheckCircle2,
} from "lucide-react";

const ATTACHED = [
  {
    id: "sig-9821",
    ts: "Apr 30, 9:02 AM",
    from: "Sarah Hensley",
    intent: "follow_up",
    confidence: 0.89,
    snippet: "Any update on that quote? We need to book by EOD…",
  },
  {
    id: "sig-9817",
    ts: "Apr 30, 8:41 AM",
    from: "Sarah Hensley",
    intent: "clarification",
    confidence: 0.84,
    snippet: "Forgot to mention — pickup needs to be after 10 AM Tuesday.",
  },
];

const RELATED = [
  {
    id: "qr-1011",
    when: "Apr 18",
    lane: "CONYERS, GA → CHICAGO, IL",
    status: "Won · $2,650",
    rep: "Adan Castaneda",
  },
  {
    id: "qr-0982",
    when: "Apr 04",
    lane: "CONYERS, GA → CHICAGO, IL",
    status: "Lost — price",
    rep: "Erin Patel",
  },
  {
    id: "qr-0951",
    when: "Mar 22",
    lane: "CONYERS, GA → CHICAGO, IL",
    status: "Won · $2,580",
    rep: "Adan Castaneda",
  },
];

type Tone = "neutral" | "ai" | "won" | "lost" | "warn";
const TIMELINE: { ts: string; label: string; detail?: string; tone: Tone }[] = [
  {
    ts: "Apr 30, 6:50 AM",
    label: "Auto-created from email signal",
    detail:
      "Confidence 0.91 · matched intent phrase 'request a quote' · sender domain matches Acuity Brands",
    tone: "ai",
  },
  {
    ts: "Apr 30, 6:51 AM",
    label: "Assigned to Adan Castaneda",
    detail: "Owner mapping: acuitybrands.com → AC",
    tone: "neutral",
  },
  {
    ts: "Apr 30, 8:41 AM",
    label: "Customer reply attached",
    detail: "Signal sig-9817 linked — clarification on pickup time",
    tone: "ai",
  },
  {
    ts: "Apr 30, 9:02 AM",
    label: "Customer reply attached",
    detail: "Signal sig-9821 linked — follow-up nudge",
    tone: "ai",
  },
  {
    ts: "Apr 30, 9:14 AM",
    label: "SLA approaching",
    detail: "13 minutes to 2-hour SLA threshold",
    tone: "warn",
  },
];

function toneCls(t: Tone) {
  switch (t) {
    case "ai":
      return "bg-violet-100 text-violet-700 border-violet-200";
    case "won":
      return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "lost":
      return "bg-rose-100 text-rose-700 border-rose-200";
    case "warn":
      return "bg-amber-100 text-amber-800 border-amber-200";
    default:
      return "bg-zinc-100 text-zinc-700 border-zinc-200";
  }
}

export default function DetailDrawer() {
  return (
    <div className="min-h-screen bg-zinc-900/40 flex justify-end p-4 font-sans">
      {/* Drawer panel */}
      <aside className="w-full max-w-2xl bg-white shadow-2xl rounded-l-lg flex flex-col max-h-screen">
        {/* Sticky header */}
        <header className="px-5 py-4 border-b">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <a className="text-base font-semibold tracking-tight text-zinc-900 hover:underline cursor-pointer">
                  Acuity Brands
                </a>
                <span className="text-zinc-300">·</span>
                <span className="text-xs text-zinc-500 font-mono">qr-1040</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border bg-sky-50 text-sky-700 border-sky-200">
                  Pending
                </span>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-amber-50 text-amber-800 border-amber-200">
                  <Clock className="h-3 w-3" />
                  SLA in 13m
                </span>
                <span className="text-[11px] text-zinc-500">
                  Requested 1h 47m ago
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded border bg-zinc-50">
                <span className="h-5 w-5 rounded-full bg-violet-500 text-white text-[10px] font-medium flex items-center justify-center">
                  AC
                </span>
                <span className="text-xs text-zinc-700">Adan Castaneda</span>
                <ChevronDown className="h-3 w-3 text-zinc-400" />
              </div>
              <button className="p-1.5 rounded border hover:bg-zinc-50">
                <MoreHorizontal className="h-4 w-4 text-zinc-500" />
              </button>
              <button className="p-1.5 rounded hover:bg-zinc-100">
                <X className="h-4 w-4 text-zinc-500" />
              </button>
            </div>
          </div>
        </header>

        {/* Scroll body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Origin email card */}
          <section className="rounded border bg-white">
            <div className="px-3 py-2 border-b bg-zinc-50 flex items-center gap-2">
              <Mail className="h-3.5 w-3.5 text-zinc-500" />
              <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">
                Origin email
              </span>
              <button className="ml-auto inline-flex items-center gap-1 text-[11px] text-sky-700 hover:underline">
                Open in Conversations
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
            <div className="px-3 py-3 space-y-2">
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <div className="text-sm">
                    <span className="font-medium">Sarah Hensley</span>{" "}
                    <span className="text-zinc-500">
                      &lt;shensley@acuitybrands.com&gt;
                    </span>
                  </div>
                  <div className="text-xs text-zinc-500">
                    Apr 30, 6:50 AM · Re: Quote request — CONYERS to CHICAGO
                  </div>
                </div>
                <button className="text-zinc-400 hover:text-zinc-700">
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="text-xs text-zinc-700 leading-relaxed bg-zinc-50 rounded p-3 border">
                Hi team — can you{" "}
                <mark className="bg-amber-200 text-amber-950 px-0.5 rounded">
                  send me a quote
                </mark>{" "}
                on a dry van load picking up Tuesday at our Conyers, GA DC
                going to our Chicago RDC? Around 42k lbs, palletised. We
                normally see $2,500–$2,700 here. Need to book by EOD Wednesday.
                Thanks, Sarah
              </div>
            </div>
          </section>

          {/* Parsed lane */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">
                Parsed lane
              </span>
              <button className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-900">
                Edit
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded border bg-white p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  Origin
                </div>
                <div className="text-sm font-medium">CONYERS, GA</div>
                <div className="text-[10px] text-emerald-700 mt-0.5">
                  conf 0.96
                </div>
              </div>
              <div className="rounded border bg-white p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  Destination
                </div>
                <div className="text-sm font-medium">CHICAGO, IL</div>
                <div className="text-[10px] text-emerald-700 mt-0.5">
                  conf 0.94
                </div>
              </div>
              <div className="rounded border bg-white p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 flex items-center gap-1">
                  <Truck className="h-3 w-3" />
                  Equipment
                </div>
                <div className="text-sm font-medium">Dry Van · 42k lbs</div>
                <div className="text-[10px] text-emerald-700 mt-0.5">
                  conf 0.91
                </div>
              </div>
              <div className="rounded border bg-white p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Pickup window
                </div>
                <div className="text-sm font-medium">Tue, May 5 (after 10)</div>
                <div className="text-[10px] text-amber-700 mt-0.5">
                  conf 0.71
                </div>
              </div>
            </div>
          </section>

          {/* Confidence + reasoning */}
          <section className="rounded border bg-white">
            <button className="w-full px-3 py-2 flex items-center gap-2 text-left">
              <Sparkles className="h-3.5 w-3.5 text-violet-500" />
              <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">
                Autopilot reasoning
              </span>
              <span className="text-[11px] text-zinc-700">
                overall confidence{" "}
                <span className="text-emerald-700 font-medium">0.91</span>
              </span>
              <ChevronDown className="ml-auto h-3.5 w-3.5 text-zinc-400" />
            </button>
            <div className="px-3 pb-3 text-xs text-zinc-700 space-y-1.5">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5" />
                Matched intent phrase: <em>"send me a quote"</em>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5" />
                Sender domain <span className="font-mono">acuitybrands.com</span>{" "}
                matches customer (3 prior won opps)
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5" />
                Origin / destination extracted from explicit city names
              </div>
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mt-0.5" />
                Pickup window inferred from "Tuesday" — no calendar date in body
              </div>
            </div>
          </section>

          {/* Attached signals */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">
                Attached signals
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 border border-zinc-200">
                {ATTACHED.length}
              </span>
              <span className="ml-auto text-[11px] text-zinc-500">
                Same thread · NOT separate rows
              </span>
            </div>
            <div className="space-y-1.5">
              {ATTACHED.map((s) => (
                <div
                  key={s.id}
                  className="rounded border bg-white p-2.5 text-xs flex items-start gap-2"
                >
                  <Mail className="h-3.5 w-3.5 text-zinc-400 mt-0.5" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-900">{s.from}</span>
                      <span className="text-zinc-400">·</span>
                      <span className="text-zinc-500">{s.ts}</span>
                      <span className="ml-auto text-[10px] px-1 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200">
                        {s.intent} · {s.confidence.toFixed(2)}
                      </span>
                    </div>
                    <div className="text-zinc-600 mt-1">"{s.snippet}"</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Related opportunities */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">
                Related on this lane
              </span>
              <span className="ml-auto text-[11px] text-sky-700 hover:underline cursor-pointer">
                See all →
              </span>
            </div>
            <div className="rounded border overflow-hidden bg-white">
              <table className="w-full text-xs">
                <thead className="bg-zinc-50 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium">When</th>
                    <th className="text-left px-2 py-1.5 font-medium">Status</th>
                    <th className="text-left px-2 py-1.5 font-medium">Rep</th>
                    <th className="w-6" />
                  </tr>
                </thead>
                <tbody>
                  {RELATED.map((r) => (
                    <tr
                      key={r.id}
                      className="border-t hover:bg-amber-50/40 cursor-pointer"
                    >
                      <td className="px-2 py-1.5">{r.when}</td>
                      <td className="px-2 py-1.5">{r.status}</td>
                      <td className="px-2 py-1.5">{r.rep}</td>
                      <td className="px-2 py-1.5">
                        <ArrowUpRight className="h-3 w-3 text-zinc-400" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Activity timeline */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">
                Activity
              </span>
            </div>
            <ol className="space-y-2">
              {TIMELINE.map((e, i) => (
                <li key={i} className="flex items-start gap-2">
                  <div
                    className={`mt-0.5 h-5 w-5 rounded-full flex items-center justify-center border ${toneCls(
                      e.tone,
                    )}`}
                  >
                    {e.tone === "ai" ? (
                      <Sparkles className="h-3 w-3" />
                    ) : e.tone === "warn" ? (
                      <AlertTriangle className="h-3 w-3" />
                    ) : (
                      <Zap className="h-3 w-3" />
                    )}
                  </div>
                  <div className="flex-1 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-900">
                        {e.label}
                      </span>
                      <span className="text-zinc-400">·</span>
                      <span className="text-zinc-500">{e.ts}</span>
                    </div>
                    {e.detail && (
                      <div className="text-zinc-600 mt-0.5">{e.detail}</div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        {/* Sticky action footer */}
        <footer className="border-t bg-white px-5 py-3">
          <div className="flex items-center gap-2">
            <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-zinc-900 text-white rounded hover:bg-zinc-800">
              <Send className="h-3.5 w-3.5" />
              Send quote reply
            </button>
            <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded hover:bg-zinc-50 text-emerald-700 border-emerald-300">
              <Award className="h-3.5 w-3.5" />
              Mark won
            </button>
            <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded hover:bg-zinc-50 text-rose-700 border-rose-300">
              <XCircle className="h-3.5 w-3.5" />
              Mark lost
            </button>
            <div className="ml-auto flex items-center gap-1">
              <button
                title="Assign rep · e"
                className="p-1.5 rounded border hover:bg-zinc-50"
              >
                <UserPlus className="h-3.5 w-3.5 text-zinc-600" />
              </button>
              <button
                title="Snooze · s"
                className="p-1.5 rounded border hover:bg-zinc-50"
              >
                <Clock className="h-3.5 w-3.5 text-zinc-600" />
              </button>
              <button
                title="Attach to existing opp · a"
                className="p-1.5 rounded border hover:bg-zinc-50"
              >
                <LinkIcon className="h-3.5 w-3.5 text-zinc-600" />
              </button>
              <button
                title="Escalate to Leak Queue"
                className="px-2 py-1.5 text-[11px] rounded border hover:bg-zinc-50 text-amber-800 border-amber-300"
              >
                Escalate
              </button>
            </div>
          </div>
        </footer>
      </aside>
    </div>
  );
}
