export function stripHtmlToText(input: string | null): string {
  if (!input) return "";
  const noStyle = input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const noTags = noStyle.replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z0-9#]+;/gi, " ");
  return decoded.replace(/\s+/g, " ").trim();
}

export function looksLikeHtml(input: string | null): boolean {
  if (!input) return false;
  return /<\/?(html|body|head|div|span|table|p|br|a|img|style|meta)\b/i.test(input);
}

export function formatAgo(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// Compact "Apr 10, 9:14 AM" style — used in the Conversations list to show
// the actual email-activity time inline (Phase 1: stop lying about freshness).
// Drops the year because the row already shows a relative-time tooltip on
// hover for the full date+year.
export function formatShortDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
