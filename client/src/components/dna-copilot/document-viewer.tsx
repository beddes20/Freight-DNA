/**
 * Lightweight document viewer — Task #926 step 9.
 *
 * Renders the page-by-page text we've already extracted on the server.
 * Citations from extraction payloads scroll-target the matching page
 * via `data-page-anchor` so the rep can verify any field the engine
 * pulled out.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useEffect, useRef } from "react";

export interface DocumentForViewer {
  id: string;
  filename: string;
  classLabel: string;
  classConfidence: string | null;
  status: string;
  pageCount: number | null;
  ocrUsed: boolean;
  pages?: Array<{ pageNumber: number; text: string | null }>;
}

/**
 * Highlight a snippet inside the page text. We do a literal substring match
 * (case-insensitive) and wrap the first hit with a <mark>; if the snippet
 * isn't found verbatim we render the page text plain so the rep still sees
 * the source material.
 */
function renderPageText(text: string, snippet: string | null) {
  if (!snippet) return <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed">{text}</pre>;
  const trimmed = snippet.trim();
  if (!trimmed) return <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed">{text}</pre>;
  const idx = text.toLowerCase().indexOf(trimmed.toLowerCase());
  if (idx < 0) return <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed">{text}</pre>;
  return (
    <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed">
      {text.slice(0, idx)}
      <mark
        className="bg-amber-300/80 dark:bg-amber-400/40 rounded px-0.5"
        data-testid="mark-citation-snippet"
      >
        {text.slice(idx, idx + trimmed.length)}
      </mark>
      {text.slice(idx + trimmed.length)}
    </pre>
  );
}

export function DocumentViewer({
  doc,
  focusPage,
  focusSnippet,
}: {
  doc: DocumentForViewer;
  focusPage?: number | null;
  focusSnippet?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusPage == null || !ref.current) return;
    const el = ref.current.querySelector(`[data-page-anchor="${focusPage}"]`);
    if (el && "scrollIntoView" in el) {
      (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focusPage, focusSnippet]);

  return (
    <Card data-testid="card-document-viewer">
      <CardHeader className="pb-2 flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base" data-testid="text-doc-filename">{doc.filename}</CardTitle>
          <div className="text-xs text-muted-foreground mt-1">
            {doc.classLabel}
            {doc.classConfidence ? ` (conf ${(Number(doc.classConfidence) * 100).toFixed(0)}%)` : ""}
            {doc.pageCount ? ` · ${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}` : ""}
            {doc.ocrUsed ? " · OCR" : ""}
          </div>
        </div>
        <Badge variant={doc.status === "parsed" ? "default" : "outline"} data-testid="badge-doc-status">{doc.status}</Badge>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[28rem] border rounded-md bg-muted/30" ref={ref as never}>
          <div className="p-3 space-y-4">
            {(doc.pages ?? []).map((p) => {
              const isFocused = focusPage === p.pageNumber;
              return (
                <div
                  key={p.pageNumber}
                  data-page-anchor={p.pageNumber}
                  data-testid={`text-page-${p.pageNumber}`}
                  className={
                    isFocused
                      ? "rounded-md ring-2 ring-amber-500/60 bg-amber-50/50 dark:bg-amber-950/20 p-2 -m-2 transition-shadow"
                      : ""
                  }
                >
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    Page {p.pageNumber}
                    {isFocused && <span className="ml-2 text-amber-700 dark:text-amber-300">· cited</span>}
                  </div>
                  {renderPageText(p.text ?? "(no text on this page)", isFocused ? focusSnippet ?? null : null)}
                </div>
              );
            })}
            {!(doc.pages ?? []).length && (
              <div className="text-sm text-muted-foreground p-3">No pages available yet.</div>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
