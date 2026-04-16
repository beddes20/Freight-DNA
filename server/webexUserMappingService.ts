import fs from "fs";
import path from "path";
import { storage } from "./storage";
import { listWebexPeople, type WebexPerson } from "./webexService";
import type { User, WebexUserMapping } from "@shared/schema";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [webex-mapping] ${msg}`);
}

const NICKNAMES: Record<string, string[]> = {
  bo: ["beau", "robert"],
  brad: ["bradley", "brado"],
  bri: ["brianna", "bridgette"],
  hannah: ["hanna"],
  joe: ["joseph"],
  josh: ["joshua"],
  kim: ["kimberly"],
  alex: ["alexander", "alexandra"],
  yuri: ["yury", "yuriy"],
};

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitFirstLast(displayName: string): { first: string; last: string | null } {
  const parts = normalizeName(displayName).split(" ").filter(Boolean);
  if (parts.length === 0) return { first: "", last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts[parts.length - 1] };
}

function namesMatch(a: { first: string; last: string | null }, b: { first: string; last: string | null }): boolean {
  if (!a.first || !b.first) return false;
  const firstMatch =
    a.first === b.first ||
    (NICKNAMES[a.first]?.includes(b.first)) ||
    (NICKNAMES[b.first]?.includes(a.first)) ||
    (a.first.length === 1 && b.first.startsWith(a.first)) ||
    (b.first.length === 1 && a.first.startsWith(b.first));
  if (!firstMatch) return false;

  // If either side has no last name (display-name-only Webex row),
  // accept the match only when first name is unique within the candidate pool.
  if (!a.last || !b.last) return true;
  return a.last === b.last;
}

export interface WebexUserCandidate {
  webexPersonId: string | null;
  webexEmail: string | null;
  webexDisplayName: string;
  source: "webex_api" | "csv";
}

const CSV_PATH = path.join(process.cwd(), "attached_assets", "Users_Report_04-16-2026_1-45-54_PM_1776368849635.csv");

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; } else { inQuote = !inQuote; }
    } else if (c === "," && !inQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

export function loadCsvWebexUsers(): WebexUserCandidate[] {
  if (!fs.existsSync(CSV_PATH)) {
    log(`CSV not found at ${CSV_PATH}`);
    return [];
  }
  const raw = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const out: WebexUserCandidate[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length < 2) continue;
    const displayName = (cells[0] || "").trim();
    const email = (cells[1] || "").trim().toLowerCase();
    if (!displayName) continue;
    out.push({
      webexPersonId: null,
      webexEmail: email || null,
      webexDisplayName: displayName,
      source: "csv",
    });
  }
  return out;
}

async function fetchWebexCandidates(): Promise<WebexUserCandidate[]> {
  try {
    const people: WebexPerson[] = await listWebexPeople();
    if (people.length === 0) return [];
    return people.map(p => ({
      webexPersonId: p.id,
      webexEmail: (p.emails?.[0] || "").toLowerCase() || null,
      webexDisplayName: p.displayName || p.emails?.[0] || "Unknown",
      source: "webex_api" as const,
    }));
  } catch (err) {
    log(`Webex People API fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export interface SeedResult {
  candidatesProcessed: number;
  matched: number;
  needsReview: number;
  preserved: number;
  source: "webex_api" | "csv" | "mixed";
}

/**
 * Seed/refresh Webex user mappings for the given org. Pulls candidates from
 * the Webex People API (preferred) and falls back to the attached CSV.
 *
 * Existing mappings that are `confirmed` or `ignored` are preserved as-is.
 * Existing `auto_matched` / `needs_review` rows can be re-evaluated.
 */
export async function seedWebexUserMappings(orgId: string): Promise<SeedResult> {
  let candidates = await fetchWebexCandidates();
  let source: SeedResult["source"] = "webex_api";

  const csvCandidates = loadCsvWebexUsers();
  if (candidates.length === 0) {
    candidates = csvCandidates;
    source = "csv";
  } else if (csvCandidates.length > 0) {
    // Merge: add CSV-only candidates (typically the new-domain @valuetruck.com pending users)
    // that aren't represented in the API result. Match by email or normalized display name.
    const knownEmails = new Set(candidates.map(c => c.webexEmail).filter(Boolean) as string[]);
    const knownNames = new Set(candidates.map(c => normalizeName(c.webexDisplayName)));
    for (const c of csvCandidates) {
      const emailKnown = c.webexEmail && knownEmails.has(c.webexEmail);
      const nameKnown = knownNames.has(normalizeName(c.webexDisplayName));
      if (!emailKnown && !nameKnown) {
        candidates.push(c);
        source = "mixed";
      }
    }
  }

  if (candidates.length === 0) {
    log(`No Webex candidates available for org ${orgId} (no API access and CSV missing)`);
    return { candidatesProcessed: 0, matched: 0, needsReview: 0, preserved: 0, source };
  }

  const orgUsers = await storage.getUsers(orgId);
  const usersWithNames = orgUsers
    .filter(u => u.name && u.name.trim().length > 0)
    .map(u => ({ user: u, parts: splitFirstLast(u.name) }));

  const existingMappings = await storage.getWebexUserMappings(orgId);
  const existingByPerson = new Map<string, WebexUserMapping>();
  const existingByEmail = new Map<string, WebexUserMapping>();
  for (const m of existingMappings) {
    if (m.webexPersonId) existingByPerson.set(m.webexPersonId, m);
    if (m.webexEmail) existingByEmail.set(m.webexEmail, m);
  }

  let matched = 0;
  let needsReview = 0;
  let preserved = 0;

  for (const cand of candidates) {
    const existing =
      (cand.webexPersonId ? existingByPerson.get(cand.webexPersonId) : undefined) ??
      (cand.webexEmail ? existingByEmail.get(cand.webexEmail) : undefined);

    // Preserve user-confirmed and ignored mappings — never re-guess them.
    if (existing && (existing.status === "confirmed" || existing.status === "ignored")) {
      // Still update personId/email/displayName if missing.
      if ((!existing.webexPersonId && cand.webexPersonId) || (!existing.webexEmail && cand.webexEmail)) {
        await storage.upsertWebexUserMapping({
          orgId,
          webexPersonId: cand.webexPersonId ?? existing.webexPersonId ?? null,
          webexEmail: cand.webexEmail ?? existing.webexEmail ?? null,
          webexDisplayName: cand.webexDisplayName ?? existing.webexDisplayName ?? null,
          userId: existing.userId,
          status: existing.status,
          matchSource: existing.matchSource,
        });
      }
      preserved++;
      continue;
    }

    const candParts = splitFirstLast(cand.webexDisplayName);
    const matches = usersWithNames.filter(u => namesMatch(u.parts, candParts));

    let userId: string | null = null;
    let status = "needs_review";
    let matchSource: string | null = `auto_${source}`;

    if (matches.length === 1) {
      userId = matches[0].user.id;
      status = "auto_matched";
      matched++;
    } else if (matches.length === 0) {
      // Fallback: try matching by email local-part (e.g. "h.bennett" → first initial + last)
      if (cand.webexEmail) {
        const local = cand.webexEmail.split("@")[0].toLowerCase();
        const dot = local.split(".");
        if (dot.length === 2) {
          const [firstInit, last] = dot;
          const emailMatches = usersWithNames.filter(u => {
            const p = u.parts;
            return p.last === last && p.first.startsWith(firstInit);
          });
          if (emailMatches.length === 1) {
            userId = emailMatches[0].user.id;
            status = "auto_matched";
            matchSource = `auto_${source}_email`;
            matched++;
          } else {
            needsReview++;
          }
        } else {
          needsReview++;
        }
      } else {
        needsReview++;
      }
    } else {
      needsReview++;
      matchSource = `${matchSource}_ambiguous`;
    }

    await storage.upsertWebexUserMapping({
      orgId,
      webexPersonId: cand.webexPersonId,
      webexEmail: cand.webexEmail,
      webexDisplayName: cand.webexDisplayName,
      userId,
      status,
      matchSource,
    });
  }

  log(`Seeded mappings for org ${orgId}: ${matched} matched, ${needsReview} needs review, ${preserved} preserved (source=${source})`);
  return { candidatesProcessed: candidates.length, matched, needsReview, preserved, source };
}

/**
 * Resolve which internal app user a Webex call should be attributed to.
 * Returns null if no confirmed/auto-matched mapping exists, in which case
 * the caller should fall back to its existing default-user behavior.
 */
export async function resolveInternalUserIdForCall(
  orgId: string,
  webexPersonId: string | undefined,
  webexUserEmail: string | undefined,
): Promise<{ userId: string | null; mapping: WebexUserMapping | null }> {
  let mapping: WebexUserMapping | undefined;
  if (webexPersonId) {
    mapping = await storage.getWebexUserMappingByPersonId(orgId, webexPersonId);
  }
  if (!mapping && webexUserEmail) {
    mapping = await storage.getWebexUserMappingByEmail(orgId, webexUserEmail.toLowerCase());
  }
  if (!mapping) return { userId: null, mapping: null };
  // Only honor mappings that have been auto-matched or explicitly confirmed.
  // `needs_review` and `ignored` rows must NOT route activity, even if a userId
  // was set manually — the rep should appear in the admin panel for review first.
  if (mapping.status !== "confirmed" && mapping.status !== "auto_matched") {
    return { userId: null, mapping };
  }
  return { userId: mapping.userId ?? null, mapping };
}
