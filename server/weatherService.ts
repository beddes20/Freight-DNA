/**
 * Open-Meteo Weather Disruption Service
 *
 * Fetches 48-hour weather forecasts for city lat/lon coordinates using the
 * Open-Meteo free API (https://api.open-meteo.com/v1/forecast).
 * No API key required.
 *
 * WMO weather interpretation codes >= 61 are considered "severe":
 *   61-67: Rain (moderate-heavy)
 *   71-77: Snowfall (moderate-heavy), blizzard
 *   80-82: Rain showers (moderate-heavy)
 *   85-86: Snow showers
 *   95:    Thunderstorm
 *   96-99: Thunderstorm with hail
 *
 * Results are cached for 2 hours per city to avoid hammering the API.
 */

import { getCityCoords } from "./cityCoordinates";

export interface WeatherFlag {
  city: string;
  severity: "severe" | "moderate";
  description: string;
  maxCode: number;
}

interface WeatherCacheEntry {
  flag: WeatherFlag | null;
  fetchedAt: number;
}

const WEATHER_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const weatherCache = new Map<string, WeatherCacheEntry>();

const WMO_DESCRIPTIONS: Record<number, string> = {
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Freezing rain (light)",
  67: "Freezing rain (heavy)",
  71: "Slight snowfall",
  73: "Moderate snowfall",
  75: "Heavy snowfall",
  77: "Snow grains/blizzard",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Heavy rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

function wmoDescription(code: number): string {
  const exact = WMO_DESCRIPTIONS[code];
  if (exact) return exact;
  if (code >= 95) return "Thunderstorm";
  if (code >= 85) return "Snow showers";
  if (code >= 80) return "Rain showers";
  if (code >= 77) return "Blizzard conditions";
  if (code >= 71) return "Snowfall";
  if (code >= 65) return "Heavy rain";
  if (code >= 61) return "Rain";
  return `Weather code ${code}`;
}

function isSevere(code: number): boolean {
  return code >= 61;
}

function isHighSeverity(code: number): boolean {
  return code === 65 || code === 67 || code >= 73;
}

async function fetchWeatherForCoords(lat: number, lon: number): Promise<number | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=weathercode&forecast_days=2&timeformat=unixtime`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) return null;
    const json = await resp.json() as {
      hourly?: {
        weathercode?: number[];
        time?: number[];
      }
    };
    const codes = json?.hourly?.weathercode ?? [];
    if (codes.length === 0) return null;
    const maxCode = Math.max(...codes.filter(c => typeof c === "number"));
    return maxCode;
  } catch {
    return null;
  }
}

export async function getWeatherFlagForCity(cityState: string): Promise<WeatherFlag | null> {
  const cacheKey = cityState.toLowerCase().trim();
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < WEATHER_CACHE_TTL) {
    return cached.flag;
  }

  const coords = getCityCoords(cityState);
  if (!coords) {
    weatherCache.set(cacheKey, { flag: null, fetchedAt: Date.now() });
    return null;
  }

  const [lat, lon] = coords;
  const maxCode = await fetchWeatherForCoords(lat, lon);

  let flag: WeatherFlag | null = null;
  if (maxCode !== null && isSevere(maxCode)) {
    flag = {
      city: cityState,
      severity: isHighSeverity(maxCode) ? "severe" : "moderate",
      description: wmoDescription(maxCode),
      maxCode,
    };
  }

  weatherCache.set(cacheKey, { flag, fetchedAt: Date.now() });
  return flag;
}

export async function getWeatherFlagsForCities(cityStates: string[]): Promise<Map<string, WeatherFlag>> {
  const result = new Map<string, WeatherFlag>();
  if (cityStates.length === 0) return result;

  const unique = Array.from(new Set(cityStates.map(c => c.toLowerCase().trim())));
  await Promise.all(
    unique.map(async (city) => {
      const flag = await getWeatherFlagForCity(city);
      if (flag) result.set(city, flag);
    })
  );
  return result;
}
