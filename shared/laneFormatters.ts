/**
 * Shared lane formatting helpers used across frontend, backend, and tests.
 */

/**
 * Title-cases a city name and uppercases a state abbreviation.
 * Collapses duplicate state values embedded in the city string
 * (e.g. "Macon, GA" with state "GA" → "Macon, GA" not "Macon, GA, GA").
 */
export function formatLaneLocation(city: string, state: string | null | undefined): string {
  const upperState = state ? state.trim().toUpperCase() : null;

  // Strip a trailing ", ST" from the raw city before title-casing so we don't
  // end up with "Macon, Ga" when the state was already embedded.
  // Pattern: optional comma + optional space + 2-letter state abbreviation at end.
  let rawCity = city.trim();
  if (upperState) {
    const trailingState = new RegExp(`,?\\s*${upperState}$`, "i");
    rawCity = rawCity.replace(trailingState, "").trim();
  }

  const titledCity = rawCity
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  if (!upperState) return titledCity;

  return `${titledCity}, ${upperState}`;
}

/**
 * Returns a full "Origin, ST → Destination, ST" lane display string.
 */
export function formatLaneDisplay(
  origin: string,
  originState: string | null | undefined,
  destination: string,
  destinationState: string | null | undefined,
): string {
  const o = formatLaneLocation(origin, originState);
  const d = formatLaneLocation(destination, destinationState);
  return `${o} → ${d}`;
}

/**
 * Converts a decimal loads-per-week value into a human-friendly range string.
 *
 * Examples:
 *   5.10 → "usually 5–7 a week"
 *   2.2  → "around 2–3 a week"
 *   0.9  → "about 1–2 a week"
 *   0.3  → "a few times a month"
 *   10.5 → "10 or more a week"
 */
export function formatWeeklyLoadRange(avgLoadsPerWeek: number | string | null | undefined): string {
  if (avgLoadsPerWeek === null || avgLoadsPerWeek === undefined) return "a few times a week";

  const n = typeof avgLoadsPerWeek === "number" ? avgLoadsPerWeek : parseFloat(String(avgLoadsPerWeek));
  if (isNaN(n)) return "a few times a week";

  if (n < 0.5) return "a few times a month";
  if (n < 1.5) return "about 1–2 a week";
  if (n < 2.5) return "around 2–3 a week";
  if (n < 4) return "around 3–4 a week";
  if (n < 5) return "usually 4–5 a week";
  if (n < 6.5) return "usually 5–7 a week";
  if (n < 8.5) return "usually 6–8 a week";
  if (n < 9.5) return "usually 8–10 a week";
  return `${Math.floor(n)} or more a week`;
}
