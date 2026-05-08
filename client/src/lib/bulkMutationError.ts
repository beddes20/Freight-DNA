// Parser for partial-failure responses from the CQ bulk routes
// (`bulk-status`, `bulk-reassign-customer`). `apiRequest` collapses
// non-2xx responses into `Error("<status>: <raw-body>")`; this helper
// recovers the structured `{ error, deniedIds, missingIds }` payload so
// the UI can name precisely which ids were affected instead of showing
// a generic "Forbidden" / "Not Found" string.

export type BulkMutationErrorReason =
  | "forbidden"
  | "no_rep_mapping"
  | "not_found"
  | "unknown";

export type BulkMutationErrorInfo = {
  status: number | null;
  reason: BulkMutationErrorReason;
  message: string;
  deniedIds: string[];
  missingIds: string[];
  affectedCount: number;
};

const PREFIX = /^(\d{3}):\s*/;

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out;
}

export function parseBulkMutationError(err: unknown): BulkMutationErrorInfo {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  let status: number | null = null;
  let body = raw;
  const m = raw.match(PREFIX);
  if (m) {
    status = Number(m[1]);
    body = raw.slice(m[0].length);
  }
  const json = safeParseJson(body);
  const message =
    (json && typeof json.error === "string" && json.error) ||
    (body && body.length > 0 ? body : "Bulk action failed");
  const deniedIds = json ? asStringArray(json.deniedIds) : [];
  const missingIds = json ? asStringArray(json.missingIds) : [];

  let reason: BulkMutationErrorReason = "unknown";
  if (deniedIds.length > 0) {
    reason = "forbidden";
  } else if (missingIds.length > 0) {
    reason = "not_found";
  } else if (status === 403 && /no rep mapping/i.test(message)) {
    reason = "no_rep_mapping";
  } else if (status === 403) {
    reason = "forbidden";
  } else if (status === 404) {
    reason = "not_found";
  }

  return {
    status,
    reason,
    message,
    deniedIds,
    missingIds,
    affectedCount: deniedIds.length + missingIds.length,
  };
}

export function formatBulkMutationErrorTitle(
  info: BulkMutationErrorInfo,
  totalAttempted?: number,
  operationLabel?: string,
): string {
  if (info.reason === "no_rep_mapping") {
    const op = operationLabel && operationLabel.length > 0 ? operationLabel : "bulk action";
    return `You're not mapped to a quote rep — ${op} cannot proceed`;
  }
  const tail =
    typeof totalAttempted === "number" && totalAttempted > 0
      ? ` of ${totalAttempted}`
      : "";
  if (info.reason === "forbidden" && info.deniedIds.length > 0) {
    const n = info.deniedIds.length;
    if (n === 1 && !tail) return `1 quote belongs to another rep and was skipped`;
    return `${n}${tail} quotes belong to another rep and were skipped`;
  }
  if (info.reason === "not_found" && info.missingIds.length > 0) {
    const n = info.missingIds.length;
    if (n === 1 && !tail) return `1 quote could not be found`;
    return `${n}${tail} quotes could not be found`;
  }
  return info.message;
}
