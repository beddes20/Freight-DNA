import type { ComponentType } from "react";
import ListView from "./ListView";
import DetailDrawer from "./DetailDrawer";
import EmptyState from "./EmptyState";

type Frame = {
  label: string;
  caption: string;
  url: string;
  Render: ComponentType;
};

const FRAMES: Frame[] = [
  {
    label: "List view (populated)",
    caption:
      "Default rep landing — preset rail, KPI strip, sortable table, bulk-action bar, SLA pills, confidence column, attached-signal hint.",
    url: "/__mockup/preview/quote-requests-tab/ListView",
    Render: ListView,
  },
  {
    label: "Detail drawer (populated)",
    caption:
      "Right-side Sheet — origin email card with highlighted intent phrase, parsed lane chips, autopilot reasoning, attached signals nested inside the parent (NOT separate rows), related opps, activity timeline, sticky quick-action footer.",
    url: "/__mockup/preview/quote-requests-tab/DetailDrawer",
    Render: DetailDrawer,
  },
  {
    label: "Empty state",
    caption:
      "First-load empty + filters-return-zero variant + autopilot health context (the four 2b counters appear here for visibility but live on the admin tile).",
    url: "/__mockup/preview/quote-requests-tab/EmptyState",
    Render: EmptyState,
  },
];

export default function CanvasIndex() {
  return (
    <div className="min-h-screen bg-zinc-100 p-6 font-sans">
      <header className="max-w-[1800px] mx-auto mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
          Quote Requests Tab — Post-2d UX Mockups
        </h1>
        <p className="text-sm text-zinc-600 mt-1 max-w-3xl">
          Visual reference set accompanying{" "}
          <code className="px-1 py-0.5 bg-zinc-200 rounded text-[11px]">
            docs/quote-requests-tab-post-2d-spec.md
          </code>
          . These are mockups, not production components — they live in the
          mockup sandbox so they can be embedded as iframes on the project
          Canvas without polluting the main app bundle.
        </p>
      </header>

      <div className="max-w-[1800px] mx-auto grid grid-cols-1 xl:grid-cols-3 gap-6">
        {FRAMES.map((f) => (
          <section
            key={f.label}
            className="rounded-lg border bg-white shadow-sm overflow-hidden flex flex-col"
          >
            <header className="px-4 py-3 border-b bg-zinc-50">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-900">
                  {f.label}
                </h2>
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-sky-700 hover:underline"
                >
                  Open ↗
                </a>
              </div>
              <p className="text-[11px] text-zinc-600 mt-1 leading-relaxed">
                {f.caption}
              </p>
            </header>
            <div className="relative bg-zinc-50 overflow-hidden flex-1">
              {/* Scaled preview container — everything fits without scrolling */}
              <div
                style={{
                  transform: "scale(0.42)",
                  transformOrigin: "top left",
                  width: "238%",
                  height: "238%",
                }}
                className="pointer-events-none"
              >
                <f.Render />
              </div>
            </div>
            <footer className="px-4 py-2 border-t bg-white text-[10px] text-zinc-500 font-mono">
              {f.url}
            </footer>
          </section>
        ))}
      </div>

      <footer className="max-w-[1800px] mx-auto mt-8 text-[11px] text-zinc-500">
        Embed any of the URLs above as iframes on the project Canvas to review
        side-by-side. The composite at{" "}
        <code className="px-1 py-0.5 bg-zinc-200 rounded">CanvasIndex</code>{" "}
        is a ready-made three-up layout.
      </footer>
    </div>
  );
}
