/**
 * Truck-List Parser (Task #844)
 *
 * Detects inbound carrier "trucks available" / "capacity list" emails and
 * parses their body text plus xlsx/csv attachments into structured truck
 * postings.
 *
 * Input shapes:
 *   - Plain-text email body, one truck per line.
 *   - Inline blocks with origin / available date / equipment columns.
 *   - xlsx / csv attachments with a header row mentioning origin, date,
 *     equipment, etc.
 *
 * The output shape is intentionally the same regardless of source so the
 * downstream matching engine can treat every row identically.
 */

import XLSX from "xlsx";

export type ParsedTruckRow = {
  originCity: string | null;
  originState: string | null;
  destCity: string | null;
  destState: string | null;
  destPreference: string | null;
  availableDate: string | null;     // YYYY-MM-DD
  availableThrough: string | null;  // YYYY-MM-DD
  equipment: string | null;
  rateAsk: string | null;           // numeric string for decimal column
  notes: string | null;
  rawText: string;
};

const EQUIPMENT_TOKENS: Record<string, string> = {
  v: "Van", van: "Van", dryvan: "Van", "dry van": "Van",
  r: "Reefer", reefer: "Reefer", reef: "Reefer",
  f: "Flatbed", flat: "Flatbed", flatbed: "Flatbed", fb: "Flatbed",
  sd: "Step Deck", step: "Step Deck", stepdeck: "Step Deck", "step deck": "Step Deck",
  rgn: "RGN", lowboy: "Lowboy",
  power: "Power Only", "power only": "Power Only", po: "Power Only",
  ca: "Conestoga", conestoga: "Conestoga",
  hot: "Hotshot", hotshot: "Hotshot",
};

const STATE_RE = /\b([A-Z]{2})\b/;
const DATE_RE = /\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{4}-\d{2}-\d{2}|tomorrow|today|tom|tod|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
const RATE_RE = /\$\s*([\d,]+(?:\.\d{1,2})?)/;

const HEADER_KEYS = {
  origin: ["origin", "from", "pickup", "city", "current city", "current location", "location", "origin city"],
  originState: ["origin state", "o state", "from state", "state"],
  dest: ["dest", "destination", "to", "delivery", "drop", "deliver", "preferred", "pref", "dest city"],
  destState: ["dest state", "destination state", "to state", "d state"],
  date: ["available", "date", "avail", "ready", "pickup date", "pu date", "pu", "available date", "ready date"],
  through: ["through", "until", "thru", "expires"],
  equipment: ["equipment", "equip", "trailer", "type", "mode"],
  rate: ["rate", "price", "ask", "$"],
  notes: ["notes", "comments", "remarks"],
};

const SUBJECT_KEYWORDS = [
  "trucks available",
  "available trucks",
  "available truck",
  "capacity list",
  "capacity available",
  "trucks looking",
  "truck list",
  "outbound list",
  "preplan",
  "open trucks",
];

/**
 * Heuristic: is this email likely a multi-row truck list rather than a
 * single capacity_available signal?
 *
 * Signals: subject keywords, OR the body contains 2+ lines that look like
 * city/state + date + equipment, OR an attachment name like trucks.xlsx.
 */
export function looksLikeTruckList(opts: {
  subject?: string | null;
  body?: string | null;
  attachmentNames?: string[];
}): boolean {
  const subj = (opts.subject ?? "").toLowerCase();
  if (SUBJECT_KEYWORDS.some(k => subj.includes(k))) return true;

  for (const name of opts.attachmentNames ?? []) {
    const lower = name.toLowerCase();
    if (
      (/\.(xlsx|xls|csv)$/i.test(lower)) &&
      /(truck|capacity|outbound|avail|preplan)/i.test(lower)
    ) return true;
  }

  const body = opts.body ?? "";
  const candidateLines = body.split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    if (trimmed.length < 6 || trimmed.length > 200) return false;
    const hasCityState = /[A-Za-z]+,?\s+[A-Z]{2}\b/.test(trimmed);
    const hasDate = DATE_RE.test(trimmed);
    return hasCityState && hasDate;
  });
  return candidateLines.length >= 2;
}

function normalizeEquipment(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (EQUIPMENT_TOKENS[s]) return EQUIPMENT_TOKENS[s];
  for (const [tok, val] of Object.entries(EQUIPMENT_TOKENS)) {
    if (s.includes(tok)) return val;
  }
  return raw.trim();
}

function normalizeDate(raw: string | null | undefined, baseToday = new Date()): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const isoMatch = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (isoMatch) return isoMatch[0];

  const lower = s.toLowerCase();
  const today = new Date(baseToday);
  today.setHours(0, 0, 0, 0);
  if (/^(today|tod)\b/.test(lower)) return today.toISOString().slice(0, 10);
  if (/^(tomorrow|tom)\b/.test(lower)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  const dayMap: Record<string, number> = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
  };
  const dayKey = lower.split(/\W+/)[0];
  if (dayMap[dayKey] !== undefined) {
    const target = dayMap[dayKey];
    const d = new Date(today);
    const diff = (target - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  const slash = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (slash) {
    const month = parseInt(slash[1], 10);
    const day = parseInt(slash[2], 10);
    let year = slash[3] ? parseInt(slash[3], 10) : today.getFullYear();
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(year, month - 1, day);
    if (!slash[3] && d.getTime() < today.getTime() - 86_400_000 * 30) {
      d.setFullYear(year + 1);
    }
    return d.toISOString().slice(0, 10);
  }

  // Excel serial date (xlsx returns numbers when cellDates not enabled)
  const num = Number(s);
  if (!isNaN(num) && num > 30000 && num < 80000) {
    const epoch = Date.UTC(1899, 11, 30);
    const d = new Date(epoch + num * 86400_000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function splitCityState(raw: string | null | undefined): { city: string | null; state: string | null } {
  if (!raw) return { city: null, state: null };
  const s = String(raw).trim();
  if (!s) return { city: null, state: null };
  // "Phoenix, AZ" or "Phoenix AZ"
  const m = s.match(/^(.+?)[,\s]+([A-Z]{2})\b\.?$/);
  if (m) return { city: m[1].trim(), state: m[2].toUpperCase() };
  // Just a state
  const stateOnly = s.match(/^([A-Z]{2})$/);
  if (stateOnly) return { city: null, state: stateOnly[1].toUpperCase() };
  return { city: s, state: null };
}

/**
 * Parse a single body line like:
 *   "Phoenix, AZ → Dallas, TX  5/12  Reefer  $2400"
 *   "Truck in Atlanta GA available tomorrow, want SE returns. Van."
 */
function parseBodyLine(line: string, today = new Date()): ParsedTruckRow | null {
  const raw = line.trim();
  if (!raw) return null;

  // Look for a city,state pair. Take the first one as origin.
  const cityStateAll = [...raw.matchAll(/\b([A-Z][A-Za-z\.\s]{2,30}?)[,\s]+([A-Z]{2})\b/g)];
  if (cityStateAll.length === 0) return null;
  const originMatch = cityStateAll[0];
  const origin = { city: originMatch[1].trim(), state: originMatch[2].toUpperCase() };

  let dest: { city: string | null; state: string | null } = { city: null, state: null };
  if (cityStateAll.length > 1) {
    const destMatch = cityStateAll[1];
    dest = { city: destMatch[1].trim(), state: destMatch[2].toUpperCase() };
  } else {
    // "wants TX returns" or "→ SE"
    const arrow = raw.split(/[→\->]+/);
    if (arrow.length > 1) {
      const tail = arrow[arrow.length - 1].trim();
      const stateMatch = tail.match(/\b([A-Z]{2})\b/);
      if (stateMatch) dest.state = stateMatch[1];
    }
  }

  const dateMatch = raw.match(DATE_RE);
  const equipMatch = Object.keys(EQUIPMENT_TOKENS).find(tok => {
    const re = new RegExp(`\\b${tok}\\b`, "i");
    return re.test(raw);
  });
  const rateMatch = raw.match(RATE_RE);

  return {
    originCity: origin.city,
    originState: origin.state,
    destCity: dest.city,
    destState: dest.state,
    destPreference: dest.city ?? dest.state,
    availableDate: dateMatch ? normalizeDate(dateMatch[1], today) : null,
    availableThrough: null,
    equipment: equipMatch ? normalizeEquipment(equipMatch) : null,
    rateAsk: rateMatch ? rateMatch[1].replace(/,/g, "") : null,
    notes: null,
    rawText: raw,
  };
}

export function parseEmailBody(body: string, today = new Date()): ParsedTruckRow[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const out: ParsedTruckRow[] = [];
  for (const line of lines) {
    const parsed = parseBodyLine(line, today);
    if (parsed && (parsed.originCity || parsed.originState)) out.push(parsed);
  }
  return out;
}

/**
 * Find a header row in a sheet's first 10 rows.
 */
function detectHeaderRow(rows: any[][]): number {
  let bestIdx = -1;
  let bestScore = 0;
  const allHeaderTokens = Object.values(HEADER_KEYS).flat();
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const joined = rows[i].map(c => String(c ?? "").toLowerCase()).join(" ");
    const score = allHeaderTokens.filter(t => joined.includes(t)).length;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestScore >= 2 ? bestIdx : -1;
}

function findCol(headers: string[], keys: string[]): number {
  const lower = headers.map(h => String(h ?? "").trim().toLowerCase());
  for (const key of keys) {
    const idx = lower.findIndex(h => h === key);
    if (idx >= 0) return idx;
  }
  for (const key of keys) {
    const idx = lower.findIndex(h => h.includes(key));
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Parse an xlsx or csv attachment buffer into truck rows.
 */
export function parseAttachment(buffer: Buffer, filename: string, today = new Date()): ParsedTruckRow[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  } catch {
    return [];
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  if (rows.length === 0) return [];

  const headerIdx = detectHeaderRow(rows);
  let headers: string[];
  let dataRows: any[][];
  if (headerIdx >= 0) {
    headers = rows[headerIdx].map((h: any, i: number) => String(h ?? `col_${i}`).trim());
    dataRows = rows.slice(headerIdx + 1);
  } else {
    headers = rows[0].map((h: any, i: number) => String(h ?? `col_${i}`).trim());
    dataRows = rows.slice(1);
  }

  const colMap = {
    origin: findCol(headers, HEADER_KEYS.origin),
    originState: findCol(headers, HEADER_KEYS.originState),
    dest: findCol(headers, HEADER_KEYS.dest),
    destState: findCol(headers, HEADER_KEYS.destState),
    date: findCol(headers, HEADER_KEYS.date),
    through: findCol(headers, HEADER_KEYS.through),
    equipment: findCol(headers, HEADER_KEYS.equipment),
    rate: findCol(headers, HEADER_KEYS.rate),
    notes: findCol(headers, HEADER_KEYS.notes),
  };

  const out: ParsedTruckRow[] = [];
  for (const row of dataRows) {
    if (!row.some(c => c !== "" && c != null)) continue;
    const originRaw = colMap.origin >= 0 ? String(row[colMap.origin] ?? "").trim() : "";
    const originStateRaw = colMap.originState >= 0 ? String(row[colMap.originState] ?? "").trim() : "";
    const destRaw = colMap.dest >= 0 ? String(row[colMap.dest] ?? "").trim() : "";
    const destStateRaw = colMap.destState >= 0 ? String(row[colMap.destState] ?? "").trim() : "";

    let originCity: string | null = null;
    let originState: string | null = null;
    if (originStateRaw) {
      originCity = originRaw || null;
      originState = originStateRaw.toUpperCase().slice(0, 2);
    } else {
      const split = splitCityState(originRaw);
      originCity = split.city;
      originState = split.state;
    }
    if (!originCity && !originState) continue;

    let destCity: string | null = null;
    let destState: string | null = null;
    if (destStateRaw) {
      destCity = destRaw || null;
      destState = destStateRaw.toUpperCase().slice(0, 2);
    } else {
      const split = splitCityState(destRaw);
      destCity = split.city;
      destState = split.state;
    }

    const dateRaw = colMap.date >= 0 ? row[colMap.date] : null;
    const throughRaw = colMap.through >= 0 ? row[colMap.through] : null;
    const equipRaw = colMap.equipment >= 0 ? String(row[colMap.equipment] ?? "").trim() : null;
    const rateRaw = colMap.rate >= 0 ? String(row[colMap.rate] ?? "").trim() : "";
    const notesRaw = colMap.notes >= 0 ? String(row[colMap.notes] ?? "").trim() : "";

    let dateStr: string | null = null;
    if (dateRaw instanceof Date) {
      dateStr = dateRaw.toISOString().slice(0, 10);
    } else if (dateRaw != null && String(dateRaw).trim()) {
      dateStr = normalizeDate(String(dateRaw).trim(), today);
    }
    let throughStr: string | null = null;
    if (throughRaw instanceof Date) {
      throughStr = throughRaw.toISOString().slice(0, 10);
    } else if (throughRaw != null && String(throughRaw).trim()) {
      throughStr = normalizeDate(String(throughRaw).trim(), today);
    }

    const rateMatch = rateRaw.match(/(\d+(?:\.\d{1,2})?)/);

    out.push({
      originCity,
      originState,
      destCity,
      destState,
      destPreference: destCity ?? destState,
      availableDate: dateStr,
      availableThrough: throughStr,
      equipment: normalizeEquipment(equipRaw),
      rateAsk: rateMatch ? rateMatch[1] : null,
      notes: notesRaw || null,
      rawText: row.filter((c: any) => c !== "" && c != null).map((c: any) => String(c)).join(" | "),
    });
  }

  return out;
}

export const _internals = {
  normalizeDate,
  normalizeEquipment,
  splitCityState,
  parseBodyLine,
  detectHeaderRow,
};
