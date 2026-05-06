/**
 * Task #910 — Drop-zone for the DNA copilot panel.
 *
 * Tiny, controlled component:
 *   - Accepts drag-and-drop OR a file picker.
 *   - POSTs files to /api/copilot/documents with optional context (page
 *     path / linked entity) so the ingestion pipeline can scope visibility.
 *   - Shows a per-file pill with status (parsing / parsed / failed /
 *     deduped) so the rep can tell when a freshly-dropped doc is ready
 *     for the agent to use via find_documents.
 *
 * Stays disabled while another batch is in flight to avoid the
 * "uploaded twice while distracted" footgun. The dedup hash on the server
 * still protects us, but the UI feedback matters.
 */
import { useCallback, useRef, useState } from "react";
import { Upload, FileText, Check, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DocumentDropzoneProps {
  pageContext?: string | null;
  companyId?: string | null;
  className?: string;
  onUploaded?: (uploaded: { documentId: string; classLabel: string; status: string; deduped: boolean }[]) => void;
}

interface PendingFile {
  filename: string;
  status: "uploading" | "parsing" | "parsed" | "failed" | "deduped";
  classLabel?: string;
  errorReason?: string | null;
}

export function DocumentDropzone({ pageContext, companyId, className, onUploaded }: DocumentDropzoneProps) {
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<PendingFile[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files).filter((f) => f.size > 0);
      if (arr.length === 0) return;
      setBusy(true);
      // Optimistic pills
      const initial = arr.map<PendingFile>((f) => ({ filename: f.name, status: "uploading" }));
      setRecent((prev) => [...initial, ...prev].slice(0, 8));
      try {
        const fd = new FormData();
        for (const f of arr) fd.append("files", f, f.name);
        if (pageContext || companyId) {
          fd.append("context", JSON.stringify({ pagePath: pageContext ?? null, companyId: companyId ?? null }));
        }
        const res = await fetch("/api/copilot/documents", { method: "POST", body: fd, credentials: "include" });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        const json = await res.json();
        const results = (json?.results ?? []) as Array<{
          documentId: string;
          filename: string;
          classLabel: string;
          status: string;
          deduped: boolean;
          failed: boolean;
          errorReason: string | null;
        }>;
        // Merge by filename (last-in wins) onto the optimistic pills.
        setRecent((prev) => {
          const next = [...prev];
          for (const r of results) {
            const idx = next.findIndex((p) => p.filename === r.filename && p.status === "uploading");
            const status: PendingFile["status"] = r.deduped
              ? "deduped"
              : r.failed
                ? "failed"
                : r.status === "parsed"
                  ? "parsed"
                  : "parsing";
            const pill: PendingFile = { filename: r.filename, status, classLabel: r.classLabel, errorReason: r.errorReason };
            if (idx >= 0) next[idx] = pill;
            else next.unshift(pill);
          }
          return next.slice(0, 8);
        });
        onUploaded?.(
          results.map((r) => ({
            documentId: r.documentId,
            classLabel: r.classLabel,
            status: r.status,
            deduped: r.deduped,
          })),
        );
      } catch (err) {
        console.error("[DocumentDropzone] upload failed:", err);
        setRecent((prev) =>
          prev.map((p) => (p.status === "uploading" ? { ...p, status: "failed", errorReason: "Upload failed" } : p)),
        );
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [pageContext, companyId, onUploaded],
  );

  return (
    <div className={cn("rounded-xl border border-dashed border-border/60 bg-muted/20 px-3 py-2", className)} data-testid="copilot-dropzone">
      <div
        className={cn(
          "flex items-center justify-between gap-2 rounded-lg px-2 py-2 transition-colors",
          hover && "bg-primary/5 border border-primary/30",
          busy && "opacity-70",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHover(false);
          if (!busy) void upload(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Upload className="h-3.5 w-3.5" />
          <span>{hover ? "Drop to upload" : "Drop a rate con, BOL, RFP, or scorecard"}</span>
        </div>
        <button
          type="button"
          onClick={() => !busy && inputRef.current?.click()}
          disabled={busy}
          className="text-xs text-primary hover:underline disabled:opacity-50"
          data-testid="button-browse-documents"
        >
          {busy ? "Uploading…" : "Browse"}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.csv,.eml,.msg,.txt,.docx"
          onChange={(e) => e.target.files && upload(e.target.files)}
          data-testid="input-document-file"
        />
      </div>
      {recent.length > 0 && (
        <ul className="mt-2 space-y-1">
          {recent.map((p, i) => (
            <li
              key={`${p.filename}-${i}`}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              data-testid={`status-document-${i}`}
            >
              {p.status === "uploading" || p.status === "parsing" ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : p.status === "failed" ? (
                <X className="h-3 w-3 text-destructive" />
              ) : (
                <Check className="h-3 w-3 text-primary" />
              )}
              <FileText className="h-3 w-3" />
              <span className="truncate max-w-[180px]" title={p.filename}>{p.filename}</span>
              <span className="ml-auto uppercase text-[10px] tracking-wide">
                {p.status === "deduped" ? "duplicate" : p.status}
                {p.classLabel && p.status === "parsed" ? ` · ${p.classLabel}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
