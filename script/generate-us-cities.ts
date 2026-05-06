import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type CityEntry = {
  city: string;
  state: string;
  aliases: string[];
};

const repoRoot = resolve(import.meta.dirname, "..");
const zipPath = resolve(repoRoot, "server/zipcodes.json");
const citiesPath = resolve(repoRoot, "client/src/data/usCities.json");

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(" ")
    .map((word) =>
      word.length === 0 ? word : word[0].toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function key(city: string, state: string): string {
  return `${city.toLowerCase()}|${state.toUpperCase()}`;
}

type ExistingIndex = {
  /** Curated entries that rename a raw ZIP-derived name. Keyed by every alias. */
  redirects: Map<string, CityEntry>;
  /** Plain canonical lookup, used to preserve the existing capitalization. */
  byCanonical: Map<string, CityEntry>;
};

function loadExistingIndex(): ExistingIndex {
  const redirects = new Map<string, CityEntry>();
  const byCanonical = new Map<string, CityEntry>();
  let parsed: CityEntry[] = [];
  try {
    parsed = JSON.parse(readFileSync(citiesPath, "utf8")) as CityEntry[];
  } catch {
    return { redirects, byCanonical };
  }

  for (const entry of parsed) {
    if (!entry.city || !entry.state) continue;
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    const normalized: CityEntry = {
      city: entry.city,
      state: entry.state.toUpperCase(),
      aliases,
    };
    byCanonical.set(key(normalized.city, normalized.state), normalized);
    if (aliases.length > 0) {
      for (const alias of aliases) {
        redirects.set(key(alias, normalized.state), normalized);
      }
      // Also let the curated canonical win over a duplicate plain entry
      // when the ZIP feed happens to spell it that way.
      redirects.set(key(normalized.city, normalized.state), normalized);
    }
  }
  return { redirects, byCanonical };
}

function main(): void {
  const zipData = JSON.parse(readFileSync(zipPath, "utf8")) as Record<
    string,
    string
  >;
  const existing = loadExistingIndex();
  const seenKeys = new Set<string>();
  const entries: CityEntry[] = [];

  for (const value of Object.values(zipData)) {
    if (typeof value !== "string") continue;
    const lastComma = value.lastIndexOf(",");
    if (lastComma === -1) continue;
    const cityRaw = value.slice(0, lastComma).trim();
    const stateRaw = value.slice(lastComma + 1).trim().toUpperCase();
    if (!cityRaw || stateRaw.length !== 2) continue;

    const candidate = titleCase(cityRaw);
    const lookupKey = key(candidate, stateRaw);

    const entry: CityEntry =
      existing.redirects.get(lookupKey) ??
      existing.byCanonical.get(lookupKey) ??
      { city: candidate, state: stateRaw, aliases: [] };

    const dedupeKey = key(entry.city, entry.state);
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    entries.push(entry);
  }

  // Preserve any existing entries that the ZIP feed doesn't cover (e.g. cities
  // hand-added for autocomplete that aren't in zipcodes.json yet, or curated
  // alias-only entries whose ZIP-side spelling we couldn't reconcile). This
  // keeps the script strictly additive so reps never lose a recognized city.
  let preserved = 0;
  for (const entry of existing.byCanonical.values()) {
    const dedupeKey = key(entry.city, entry.state);
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    entries.push(entry);
    preserved++;
  }
  if (preserved > 0) {
    console.log(
      `[generate-us-cities] Preserved ${preserved} existing entr${preserved === 1 ? "y" : "ies"} not present in ZIP feed.`,
    );
  }

  entries.sort((a, b) => {
    if (a.state !== b.state) return a.state.localeCompare(b.state);
    return a.city.localeCompare(b.city);
  });

  const lines = entries.map((e) => `  ${JSON.stringify(e)}`);
  const output = `[\n${lines.join(",\n")}\n]\n`;
  writeFileSync(citiesPath, output, "utf8");

  console.log(
    `[generate-us-cities] Wrote ${entries.length} cities to ${citiesPath}`,
  );
}

main();
