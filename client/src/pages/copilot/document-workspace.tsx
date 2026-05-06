/**
 * Document workspace — Task #926 step 9.
 *
 * Side-by-side layout: extracted document on the left, intelligence +
 * recommended plays on the right. Used after a rep drops a doc into the
 * copilot inbox so they can review citations + accept/dismiss plays.
 *
 * Route: /copilot/documents/:docId
 */
import { useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { DocumentViewer, type DocumentForViewer } from "@/components/dna-copilot/document-viewer";
import { IntelligenceRowCard, type IntelligenceRow } from "@/components/dna-copilot/intelligence-card";
import { PlayRecommendationCard, type PlayRecommendation } from "@/components/dna-copilot/play-recommendation-card";

interface ExtractionsResp {
  extractions: Array<{
    id: string;
    documentId: string;
    classLabel: string;
    payload: Record<string, unknown>;
    resolvedEntities: Record<string, unknown> | null;
    needsHumanReview: boolean;
    extractedAt: string;
  }>;
  document: DocumentForViewer & { id: string };
}

interface DocPagesResp {
  pages: Array<{ pageNumber: number; text: string | null }>;
}

export default function DocumentWorkspacePage() {
  const params = useParams<{ docId: string }>();
  const docId = params?.docId ?? "";
  const [focus, setFocus] = useState<{ page: number | null; snippet: string | null }>({ page: null, snippet: null });

  const extractionsQuery = useQuery<ExtractionsResp>({
    queryKey: ["/api/copilot/extractions/by-doc", docId],
    enabled: !!docId,
  });
  const intelligenceQuery = useQuery<{ intelligence: IntelligenceRow[] }>({
    queryKey: ["/api/copilot/intelligence/by-doc", docId],
    enabled: !!docId,
  });
  const playsQuery = useQuery<{ plays: PlayRecommendation[] }>({
    queryKey: ["/api/copilot/plays/by-doc", docId],
    enabled: !!docId,
  });
  const pagesQuery = useQuery<DocPagesResp>({
    queryKey: ["/api/documents", docId, "pages"],
    enabled: !!docId,
  });

  if (extractionsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (extractionsQuery.error || !extractionsQuery.data) {
    return (
      <Card className="m-6">
        <CardContent className="p-6 text-sm text-muted-foreground" data-testid="text-error-doc">
          Could not load this document.
        </CardContent>
      </Card>
    );
  }

  const doc = { ...extractionsQuery.data.document, pages: pagesQuery.data?.pages ?? [] };
  const ex = extractionsQuery.data.extractions[0] ?? null;
  const intel = intelligenceQuery.data?.intelligence ?? [];
  const plays = playsQuery.data?.plays ?? [];
  const resolvedNote = ex?.resolvedEntities as { customerName?: string; customerConfidence?: string } | null;

  return (
    <div className="p-4 md:p-6 grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="page-doc-workspace">
      <div className="space-y-4">
        <DocumentViewer doc={doc as DocumentForViewer} focusPage={focus.page} focusSnippet={focus.snippet} />
        {ex && (
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Extracted fields ({ex.classLabel})
                {ex.needsHumanReview && <span className="ml-2 text-rose-600">· needs review</span>}
              </div>
              <ul className="text-sm space-y-1" data-testid="list-extracted-fields">
                {Object.entries(ex.payload).map(([key, raw]) => {
                  const v = raw as { value?: unknown; confidence?: string; citation?: { page?: number; snippet?: string } } | null;
                  if (v == null || typeof v !== "object" || Array.isArray(v) || !("value" in v)) {
                    return (
                      <li key={key} className="flex items-center gap-2">
                        <span className="text-muted-foreground w-32 shrink-0">{key}</span>
                        <span className="font-mono text-xs">{Array.isArray(raw) ? `[${raw.length}]` : String(raw)}</span>
                      </li>
                    );
                  }
                  const page = v.citation?.page ?? null;
                  const snippet = v.citation?.snippet ?? null;
                  return (
                    <li key={key} className="flex items-center gap-2" data-testid={`row-field-${key}`}>
                      <span className="text-muted-foreground w-32 shrink-0">{key}</span>
                      <span className="font-mono text-xs">{String(v.value ?? "—")}</span>
                      {v.confidence && <span className="text-xs text-muted-foreground">({v.confidence})</span>}
                      {page != null && (
                        <button
                          type="button"
                          onClick={() => setFocus({ page, snippet })}
                          className={
                            "text-xs rounded px-1.5 py-0.5 border " +
                            (focus.page === page
                              ? "bg-amber-200/70 dark:bg-amber-400/20 border-amber-400 text-amber-900 dark:text-amber-200"
                              : "bg-muted/40 border-transparent hover:border-border text-muted-foreground hover:text-foreground")
                          }
                          data-testid={`button-citation-${key}`}
                          title={snippet ? `Source: "${snippet.slice(0, 120)}…"` : `Jump to page ${page}`}
                        >
                          p.{page}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {resolvedNote?.customerName && (
                <div className="text-xs text-muted-foreground pt-2 border-t" data-testid="text-resolved-customer">
                  Resolved customer: {resolvedNote.customerName}
                  {resolvedNote.customerConfidence ? ` (${resolvedNote.customerConfidence})` : ""}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="space-y-4">
        {intel.length === 0 && (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground" data-testid="text-no-intelligence">
              No intelligence rows yet for this document.
            </CardContent>
          </Card>
        )}
        {intel.map((row) => <IntelligenceRowCard key={row.id} row={row} />)}

        {plays.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Recommended plays</div>
            {plays.map((p) => <PlayRecommendationCard key={p.id} rec={p} />)}
          </div>
        )}
        {plays.length === 0 && intel.length > 0 && (
          <Card>
            <CardContent className="p-4 text-sm text-muted-foreground" data-testid="text-no-plays">
              No plays were called for this document — evidence may be too thin or NBA cards already cover it.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
