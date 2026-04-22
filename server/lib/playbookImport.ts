/**
 * Playbook bulk-import parser & validator (Task #439)
 *
 * Pure functions used by both the import endpoint and the smoke-test suite.
 * Accepts header-keyed row objects (already parsed from .xlsx/.csv on either
 * client or server) and returns a structured preview with per-row validation
 * + duplicate detection so the UI can show inline errors before commit.
 */

import { insertPlaySchema } from "@shared/schema";

const VALID_AUDIENCE = new Set(["customer", "carrier"]);
const VALID_CHANNEL = new Set(["email", "call", "in_person"]);
const VALID_TRIGGER = new Set([
  "manual",
  "quote_no_response",
  "award_no_carrier",
  "sentiment_drop",
  "signal_match",
]);

export const PLAYBOOK_IMPORT_FIELDS = [
  { key: "name",                label: "Name *",                  required: true  },
  { key: "description",         label: "Description / Purpose",   required: false },
  { key: "audience",            label: "Audience",                required: false },
  { key: "channel",             label: "Channel",                 required: false },
  { key: "triggerType",         label: "Trigger Type",            required: false },
  { key: "recommendedSteps",    label: "Recommended Steps",       required: false },
  { key: "templateBody",        label: "Template / Talk-track",   required: false },
  { key: "successMetric",       label: "Success Metric",          required: false },
  { key: "outcomeWindowHours",  label: "Outcome Window (hours)",  required: false },
] as const;

export type PlaybookImportFieldKey = typeof PLAYBOOK_IMPORT_FIELDS[number]["key"];

export const PLAYBOOK_HEADER_SYNONYMS: Record<PlaybookImportFieldKey, string[]> = {
  name:               ["name", "play", "play name", "title"],
  description:        ["description", "purpose", "why", "summary"],
  audience:           ["audience", "for", "target"],
  channel:            ["channel", "medium"],
  triggerType:        ["trigger", "trigger type", "when", "fires when"],
  recommendedSteps:   ["steps", "recommended steps", "playbook", "actions"],
  templateBody:       ["template", "template body", "talk track", "talk-track", "script", "body", "message"],
  successMetric:      ["success", "success metric", "metric", "kpi", "outcome"],
  outcomeWindowHours: ["window", "outcome window", "outcome window hours", "hours", "window hours"],
};

export function autoDetectPlaybookMapping(headers: string[]): Record<PlaybookImportFieldKey, string> {
  const norm = headers.map(h => h.toLowerCase().trim());
  const mapping = {} as Record<PlaybookImportFieldKey, string>;
  for (const f of PLAYBOOK_IMPORT_FIELDS) {
    for (const syn of PLAYBOOK_HEADER_SYNONYMS[f.key]) {
      const idx = norm.indexOf(syn);
      if (idx !== -1) { mapping[f.key] = headers[idx]; break; }
    }
  }
  return mapping;
}

export interface ParsedPlayRow {
  name: string;
  description: string | null;
  audience: "customer" | "carrier";
  channel: "email" | "call" | "in_person";
  triggerType: "manual" | "quote_no_response" | "award_no_carrier" | "sentiment_drop" | "signal_match";
  recommendedSteps: string[];
  templateBody: string;
  successMetric: string;
  outcomeWindowHours: number;
}

export interface PreviewRow {
  rowIndex: number;        // 0-based position within the uploaded data rows
  raw: Record<string, string>;
  parsed: ParsedPlayRow | null;
  errors: string[];
  isDuplicate: boolean;
  duplicateReason: string | null;
}

function normalize(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function parseSteps(v: string): string[] {
  if (!v) return [];
  // Allow newline, semicolon, or numbered step separators.
  return v
    .split(/\r?\n|;|(?<=\.)\s+(?=\d+[\).])/)
    .map(s => s.replace(/^\s*\d+[\).]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 20);
}

export function validateRow(raw: Record<string, string>): { parsed: ParsedPlayRow | null; errors: string[] } {
  const errors: string[] = [];
  const name = normalize(raw.name);
  if (!name) errors.push("Missing name");
  if (name.length > 160) errors.push("Name exceeds 160 chars");

  const audienceRaw = normalize(raw.audience).toLowerCase() || "customer";
  if (!VALID_AUDIENCE.has(audienceRaw)) errors.push(`Invalid audience: ${audienceRaw}`);

  const channelRaw = normalize(raw.channel).toLowerCase().replace(/[\s-]/g, "_") || "email";
  if (!VALID_CHANNEL.has(channelRaw)) errors.push(`Invalid channel: ${channelRaw}`);

  const triggerRaw = normalize(raw.triggerType).toLowerCase().replace(/[\s-]/g, "_") || "manual";
  if (!VALID_TRIGGER.has(triggerRaw)) errors.push(`Invalid trigger: ${triggerRaw}`);

  const description = normalize(raw.description) || null;
  const templateBody = normalize(raw.templateBody);
  const successMetric = normalize(raw.successMetric);
  const recommendedSteps = parseSteps(normalize(raw.recommendedSteps));

  let outcomeWindowHours = 96;
  const winRaw = normalize(raw.outcomeWindowHours);
  if (winRaw) {
    const n = Number(winRaw);
    if (!Number.isFinite(n) || n < 1 || n > 24 * 60) {
      errors.push(`Invalid outcome window hours: ${winRaw}`);
    } else {
      outcomeWindowHours = Math.round(n);
    }
  }

  if (errors.length) return { parsed: null, errors };
  const parsed: ParsedPlayRow = {
    name,
    description,
    audience: audienceRaw as ParsedPlayRow["audience"],
    channel: channelRaw as ParsedPlayRow["channel"],
    triggerType: triggerRaw as ParsedPlayRow["triggerType"],
    recommendedSteps,
    templateBody,
    successMetric,
    outcomeWindowHours,
  };
  // Final parity gate: route every imported row through the SAME canonical
  // insertPlaySchema that manual play creation uses, so xlsx-imports can't
  // bypass DB-shape rules. orgId/createdBy are server-injected; triggerConfig
  // defaults to {} on insert.
  const dbCheck = insertPlaySchema
    .omit({ orgId: true, createdBy: true })
    .safeParse({ ...parsed, triggerConfig: {}, status: "draft" });
  if (!dbCheck.success) {
    return {
      parsed: null,
      errors: dbCheck.error.issues.map(i => `${i.path.join(".") || "row"}: ${i.message}`),
    };
  }
  return { parsed, errors: [] };
}

/**
 * Build a structured preview for an array of header-keyed import rows.
 *
 * `existingPlayNames` is the set of non-archived play names already in the
 * org (case-insensitive) so we can flag dupes before insert.
 */
export function buildPlaybookImportPreview(
  rows: Array<Record<string, string>>,
  existingPlayNames: Iterable<string>,
): PreviewRow[] {
  const existing = new Set(Array.from(existingPlayNames).map(n => n.toLowerCase()));
  const seenInThisFile = new Set<string>();
  return rows.map((raw, i) => {
    const { parsed, errors } = validateRow(raw);
    const nameKey = (parsed?.name ?? normalize(raw.name)).toLowerCase();
    let isDuplicate = false;
    let duplicateReason: string | null = null;
    if (nameKey) {
      if (existing.has(nameKey)) {
        isDuplicate = true;
        duplicateReason = "Matches existing play (will skip)";
      } else if (seenInThisFile.has(nameKey)) {
        isDuplicate = true;
        duplicateReason = "Duplicate name within this file";
      } else {
        seenInThisFile.add(nameKey);
      }
    }
    return { rowIndex: i, raw, parsed, errors, isDuplicate, duplicateReason };
  });
}
