import {
  Inbox,
  Mail,
  ExternalLink,
  Sparkles,
  RefreshCw,
  Plus,
  Search,
  Filter,
  Bookmark,
  ChevronDown,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

export default function EmptyState() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      {/* Same chrome as ListView for context */}
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
                Every customer email quote request, one row each
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
              <input
                type="text"
                placeholder="Search…"
                className="pl-7 pr-3 py-1.5 text-xs border rounded w-48"
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
      </header>

      <div className="flex">
        <aside className="w-60 shrink-0 border-r bg-white p-4 min-h-[calc(100vh-72px)]">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
            <Filter className="h-3 w-3" />
            Presets
          </div>
          <div className="space-y-0.5">
            {[
              { label: "My open", count: 0, active: true },
              { label: "Unassigned", count: 0 },
              { label: "SLA breaching", count: 0 },
              { label: "Free-email senders", count: 0 },
              { label: "All open", count: 0 },
              { label: "Closed", count: 312 },
            ].map((p, i) => (
              <button
                key={i}
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
        </aside>

        <main className="flex-1 p-8">
          {/* Primary empty card */}
          <section className="max-w-2xl mx-auto">
            <div className="rounded-lg border bg-white p-10 text-center">
              <div className="mx-auto h-14 w-14 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-4">
                <Inbox className="h-7 w-7 text-amber-600" />
              </div>
              <h2 className="text-lg font-semibold text-zinc-900">
                No quote requests in this window
              </h2>
              <p className="mt-2 text-sm text-zinc-600 max-w-md mx-auto">
                When a customer emails you a quote, it lands here as one row
                with full lifecycle state. Make sure your inbox is connected so
                the autopilot can keep watching.
              </p>
              <div className="mt-5 flex items-center justify-center gap-2">
                <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-zinc-900 text-white rounded hover:bg-zinc-800">
                  <Mail className="h-4 w-4" />
                  Open Conversations
                </button>
                <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded hover:bg-zinc-50">
                  <ExternalLink className="h-4 w-4" />
                  Inbox connection settings
                </button>
              </div>
            </div>

            {/* Health signals beneath the empty state */}
            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="rounded border bg-white p-4">
                <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2">
                  <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                  Autopilot health (last 24h)
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-2xl font-semibold tabular-nums text-emerald-700">
                      14
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                      Created
                    </div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold tabular-nums text-sky-700">
                      8
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                      Attached
                    </div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold tabular-nums text-zinc-700">
                      2
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                      Skipped (internal)
                    </div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold tabular-nums text-amber-700">
                      1
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                      Skipped (low conf.)
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-zinc-500">
                  Counters live on the admin tile — shown here for context only.
                </div>
              </div>

              <div className="rounded border bg-white p-4">
                <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  System checks
                </div>
                <ul className="space-y-1.5 text-xs">
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    Microsoft 365 mailbox connected · last poll 38s ago
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    Webhook subscription active
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    Autopilot dry-run gate OFF (live mode)
                  </li>
                  <li className="flex items-center gap-2 text-zinc-500">
                    <AlertCircle className="h-3.5 w-3.5 text-zinc-400" />
                    Internal-domain guard: 4 domains
                  </li>
                </ul>
              </div>
            </div>

            {/* Variant: filters return zero */}
            <div className="mt-8">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
                Variant — filters return zero
              </div>
              <div className="rounded-lg border bg-white p-6 text-center">
                <div className="mx-auto h-10 w-10 rounded-full bg-zinc-100 border flex items-center justify-center mb-3">
                  <Filter className="h-5 w-5 text-zinc-500" />
                </div>
                <h3 className="text-sm font-semibold">
                  No requests match your filters
                </h3>
                <p className="mt-1 text-xs text-zinc-500 max-w-sm mx-auto">
                  Try widening the date range or clearing the assignment
                  filter.
                </p>
                <div className="mt-3">
                  <button className="px-3 py-1 text-xs border rounded hover:bg-zinc-50">
                    Clear filters
                  </button>
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
