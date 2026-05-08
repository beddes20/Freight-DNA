// Dialog body that renders a CQ bulk-mutation partial failure: count
// line, expandable list of affected ids, copy-ids affordance, and the
// no_rep_mapping branch with an optional admin link.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import type { BulkMutationErrorInfo } from "@/lib/bulkMutationError";

export function BulkMutationErrorDetails({
  info,
  totalAttempted,
  successCount,
  repMappingHref,
}: {
  info: BulkMutationErrorInfo;
  /** Optional: number of rows the rep selected, for "X of Y" framing. */
  totalAttempted?: number;
  /** Optional: number of rows that DID succeed (server returns this on the
   *  happy-path subset; surfacing it keeps the rep oriented). */
  successCount?: number;
  /** Optional: route to the rep-mapping admin page, used only on the
   *  no_rep_mapping branch. Pass `null` / omit to hide the link. */
  repMappingHref?: string | null;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const ids = useMemo(
    () =>
      info.reason === "forbidden"
        ? info.deniedIds
        : info.reason === "not_found"
        ? info.missingIds
        : [],
    [info],
  );

  const handleCopy = async () => {
    if (ids.length === 0) return;
    try {
      await navigator.clipboard.writeText(ids.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked; the expanded list is still selectable.
    }
  };

  if (info.reason === "no_rep_mapping") {
    return (
      <div className="space-y-2 text-sm" data-testid="bulk-error-no-rep-mapping">
        <p>
          You're not mapped to a quote rep, so the bulk action can't run on
          your behalf. Ask an admin to add you to <code>quote_reps</code>.
        </p>
        {repMappingHref ? (
          <Link
            href={repMappingHref}
            className="text-primary underline underline-offset-2"
            data-testid="link-rep-mapping-admin"
          >
            Open rep mapping admin
          </Link>
        ) : null}
      </div>
    );
  }

  if (ids.length === 0) {
    // Unknown / generic — the title already carries the server message.
    return (
      <p className="text-sm" data-testid="bulk-error-generic">
        {info.message}
      </p>
    );
  }

  const noun = info.reason === "not_found" ? "missing" : "denied";
  return (
    <div className="space-y-2 text-sm" data-testid={`bulk-error-${noun}`}>
      <p data-testid="text-bulk-error-summary">
        {ids.length}
        {typeof totalAttempted === "number" && totalAttempted > 0
          ? ` of ${totalAttempted}`
          : ""}{" "}
        quote{ids.length === 1 ? "" : "s"} {noun === "missing" ? "could not be found" : "belong to another rep"}
        {typeof successCount === "number" && successCount > 0
          ? `; ${successCount} succeeded`
          : ""}
        .
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setExpanded(v => !v)}
          data-testid="button-bulk-error-toggle"
        >
          {expanded ? "Hide ids" : `View ${ids.length === 1 ? "id" : "ids"}`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={handleCopy}
          data-testid="button-bulk-error-copy"
        >
          {copied ? "Copied" : "Copy ids"}
        </Button>
      </div>
      {expanded ? (
        <ul
          className="max-h-40 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs"
          data-testid="list-bulk-error-ids"
        >
          {ids.map(id => (
            <li key={id} data-testid={`bulk-error-id-${id}`}>
              {id}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
