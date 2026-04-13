/**
 * KMA (Key Market Area) code mapping for FreightWaves TRAC API.
 * Maps common city names / TMS city strings to their nearest TRAC KMA code.
 * KMA codes are airport-style codes used by FreightWaves to define freight markets.
 */

interface KmaEntry {
  kma: string;
  label: string; // human-readable label for the market
}

const CITY_TO_KMA: Record<string, KmaEntry> = {
  // --- Pacific Northwest ---
  "seattle": { kma: "SEA", label: "Seattle, WA" },
  "tacoma": { kma: "SEA", label: "Seattle, WA" },
  "kent": { kma: "SEA", label: "Seattle, WA" },
  "renton": { kma: "SEA", label: "Seattle, WA" },
  "auburn": { kma: "SEA", label: "Seattle, WA" },
  "everett": { kma: "SEA", label: "Seattle, WA" },
  "bellingham": { kma: "SEA", label: "Seattle, WA" },
  "portland": { kma: "PDX", label: "Portland, OR" },
  "beaverton": { kma: "PDX", label: "Portland, OR" },
  "hillsboro": { kma: "PDX", label: "Portland, OR" },
  "gresham": { kma: "PDX", label: "Portland, OR" },
  "eugene": { kma: "EUG", label: "Eugene, OR" },
  "medford": { kma: "MFR", label: "Medford, OR" },
  "spokane": { kma: "GEG", label: "Spokane, WA" },

  // --- California ---
  "los angeles": { kma: "LAX", label: "Los Angeles, CA" },
  "long beach": { kma: "LAX", label: "Los Angeles, CA" },
  "compton": { kma: "LAX", label: "Los Angeles, CA" },
  "gardena": { kma: "LAX", label: "Los Angeles, CA" },
  "torrance": { kma: "LAX", label: "Los Angeles, CA" },
  "inglewood": { kma: "LAX", label: "Los Angeles, CA" },
  "carson": { kma: "LAX", label: "Los Angeles, CA" },
  "wilmington": { kma: "LAX", label: "Los Angeles, CA" },
  "san pedro": { kma: "LAX", label: "Los Angeles, CA" },
  "hawthorne": { kma: "LAX", label: "Los Angeles, CA" },
  "el segundo": { kma: "LAX", label: "Los Angeles, CA" },
  "culver city": { kma: "LAX", label: "Los Angeles, CA" },
  "ontario": { kma: "ONT", label: "Ontario/IE, CA" },
  "riverside": { kma: "ONT", label: "Ontario/IE, CA" },
  "fontana": { kma: "ONT", label: "Ontario/IE, CA" },
  "rialto": { kma: "ONT", label: "Ontario/IE, CA" },
  "san bernardino": { kma: "ONT", label: "Ontario/IE, CA" },
  "rancho cucamonga": { kma: "ONT", label: "Ontario/IE, CA" },
  "chino": { kma: "ONT", label: "Ontario/IE, CA" },
  "perris": { kma: "ONT", label: "Ontario/IE, CA" },
  "mira loma": { kma: "ONT", label: "Ontario/IE, CA" },
  "colton": { kma: "ONT", label: "Ontario/IE, CA" },
  "san diego": { kma: "SAN", label: "San Diego, CA" },
  "el cajon": { kma: "SAN", label: "San Diego, CA" },
  "chula vista": { kma: "SAN", label: "San Diego, CA" },
  "otay mesa": { kma: "SAN", label: "San Diego, CA" },
  "san francisco": { kma: "SFO", label: "San Francisco, CA" },
  "san jose": { kma: "SJC", label: "San Jose, CA" },
  "oakland": { kma: "OAK", label: "Oakland, CA" },
  "hayward": { kma: "OAK", label: "Oakland, CA" },
  "fremont": { kma: "OAK", label: "Oakland, CA" },
  "richmond": { kma: "OAK", label: "Oakland, CA" },
  "stockton": { kma: "SCK", label: "Stockton, CA" },
  "lodi": { kma: "SCK", label: "Stockton, CA" },
  "tracy": { kma: "SCK", label: "Stockton, CA" },
  "modesto": { kma: "SCK", label: "Stockton, CA" },
  "sacramento": { kma: "SMF", label: "Sacramento, CA" },
  "west sacramento": { kma: "SMF", label: "Sacramento, CA" },
  "elk grove": { kma: "SMF", label: "Sacramento, CA" },
  "fresno": { kma: "FAT", label: "Fresno, CA" },
  "visalia": { kma: "FAT", label: "Fresno, CA" },
  "bakersfield": { kma: "BFL", label: "Bakersfield, CA" },
  "salinas": { kma: "MRY", label: "Salinas/Monterey, CA" },
  "watsonville": { kma: "MRY", label: "Salinas/Monterey, CA" },

  // --- Mountain ---
  "salt lake city": { kma: "SLC", label: "Salt Lake City, UT" },
  "ogden": { kma: "SLC", label: "Salt Lake City, UT" },
  "provo": { kma: "SLC", label: "Salt Lake City, UT" },
  "west valley city": { kma: "SLC", label: "Salt Lake City, UT" },
  "layton": { kma: "SLC", label: "Salt Lake City, UT" },
  "west jordan": { kma: "SLC", label: "Salt Lake City, UT" },
  "murray": { kma: "SLC", label: "Salt Lake City, UT" },
  "boise": { kma: "BOI", label: "Boise, ID" },
  "nampa": { kma: "BOI", label: "Boise, ID" },
  "caldwell": { kma: "BOI", label: "Boise, ID" },
  "meridian": { kma: "BOI", label: "Boise, ID" },
  "twin falls": { kma: "TWF", label: "Twin Falls, ID" },
  "pocatello": { kma: "PIH", label: "Pocatello, ID" },
  "denver": { kma: "DEN", label: "Denver, CO" },
  "aurora": { kma: "DEN", label: "Denver, CO" },
  "arvada": { kma: "DEN", label: "Denver, CO" },
  "westminster": { kma: "DEN", label: "Denver, CO" },
  "thornton": { kma: "DEN", label: "Denver, CO" },
  "lakewood": { kma: "DEN", label: "Denver, CO" },
  "commerce city": { kma: "DEN", label: "Denver, CO" },
  "colorado springs": { kma: "COS", label: "Colorado Springs, CO" },
  "pueblo": { kma: "PUB", label: "Pueblo, CO" },
  "grand junction": { kma: "GJT", label: "Grand Junction, CO" },
  "phoenix": { kma: "PHX", label: "Phoenix, AZ" },
  "tempe": { kma: "PHX", label: "Phoenix, AZ" },
  "chandler": { kma: "PHX", label: "Phoenix, AZ" },
  "mesa": { kma: "PHX", label: "Phoenix, AZ" },
  "gilbert": { kma: "PHX", label: "Phoenix, AZ" },
  "glendale": { kma: "PHX", label: "Phoenix, AZ" },
  "scottsdale": { kma: "PHX", label: "Phoenix, AZ" },
  "peoria": { kma: "PHX", label: "Phoenix, AZ" },
  "goodyear": { kma: "PHX", label: "Phoenix, AZ" },
  "tucson": { kma: "TUS", label: "Tucson, AZ" },
  "reno": { kma: "RNO", label: "Reno, NV" },
  "sparks": { kma: "RNO", label: "Reno, NV" },
  "las vegas": { kma: "LAS", label: "Las Vegas, NV" },
  "henderson": { kma: "LAS", label: "Las Vegas, NV" },
  "north las vegas": { kma: "LAS", label: "Las Vegas, NV" },
  "albuquerque": { kma: "ABQ", label: "Albuquerque, NM" },
  "missoula": { kma: "MSO", label: "Missoula, MT" },
  "billings": { kma: "BIL", label: "Billings, MT" },
  "great falls": { kma: "GTF", label: "Great Falls, MT" },
  "butte": { kma: "BTM", label: "Butte, MT" },
  "casper": { kma: "CPR", label: "Casper, WY" },
  "cheyenne": { kma: "CYS", label: "Cheyenne, WY" },
  "rapid city": { kma: "RAP", label: "Rapid City, SD" },

  // --- Southwest ---
  "dallas": { kma: "DFW", label: "Dallas/Fort Worth, TX" },
  "fort worth": { kma: "DFW", label: "Dallas/Fort Worth, TX" },
  "irving": { kma: "DFW", label: "Dallas/Fort Worth, TX" },
  "arlington": { kma: "DFW", label: "Dallas/Fort Worth, TX" },
  "garland": { kma: "DFW", label: "Dallas/Fort Worth, TX" },
  "mesquite": { kma: "DFW", label: "Dallas/Fort Worth, TX" },
  "plano": { kma: "DFW", label: "Dallas/Fort Worth, TX" },
  "carrollton": { kma: "DFW", label: "Dallas/Fort Worth, TX" },
  "grand prairie": { kma: "DFW", label: "Dallas/Fort Worth, TX" },
  "houston": { kma: "IAH", label: "Houston, TX" },
  "pasadena": { kma: "IAH", label: "Houston, TX" },
  "baytown": { kma: "IAH", label: "Houston, TX" },
  "stafford": { kma: "IAH", label: "Houston, TX" },
  "conroe": { kma: "IAH", label: "Houston, TX" },
  "san antonio": { kma: "SAT", label: "San Antonio, TX" },
  "austin": { kma: "AUS", label: "Austin, TX" },
  "round rock": { kma: "AUS", label: "Austin, TX" },
  "el paso": { kma: "ELP", label: "El Paso, TX" },
  "laredo": { kma: "LRD", label: "Laredo, TX" },
  "mcallen": { kma: "MFE", label: "McAllen, TX" },
  "harlingen": { kma: "HRL", label: "Harlingen, TX" },
  "lubbock": { kma: "LBB", label: "Lubbock, TX" },
  "amarillo": { kma: "AMA", label: "Amarillo, TX" },
  "waco": { kma: "ACT", label: "Waco, TX" },
  "corpus christi": { kma: "CRP", label: "Corpus Christi, TX" },
  "oklahoma city": { kma: "OKC", label: "Oklahoma City, OK" },
  "tulsa": { kma: "TUL", label: "Tulsa, OK" },

  // --- Midwest ---
  "chicago": { kma: "ORD", label: "Chicago, IL" },
  "des plaines": { kma: "ORD", label: "Chicago, IL" },
  "elk grove village": { kma: "ORD", label: "Chicago, IL" },
  "bolingbrook": { kma: "ORD", label: "Chicago, IL" },
  "aurora": { kma: "ORD", label: "Chicago, IL" },
  "joliet": { kma: "ORD", label: "Chicago, IL" },
  "elgin": { kma: "ORD", label: "Chicago, IL" },
  "romeoville": { kma: "ORD", label: "Chicago, IL" },
  "addison": { kma: "ORD", label: "Chicago, IL" },
  "carol stream": { kma: "ORD", label: "Chicago, IL" },
  "naperville": { kma: "ORD", label: "Chicago, IL" },
  "melrose park": { kma: "ORD", label: "Chicago, IL" },
  "franklin park": { kma: "ORD", label: "Chicago, IL" },
  "hodgkins": { kma: "ORD", label: "Chicago, IL" },
  "bedford park": { kma: "ORD", label: "Chicago, IL" },
  "cicero": { kma: "ORD", label: "Chicago, IL" },
  "milwaukee": { kma: "MKE", label: "Milwaukee, WI" },
  "kenosha": { kma: "MKE", label: "Milwaukee, WI" },
  "racine": { kma: "MKE", label: "Milwaukee, WI" },
  "waukesha": { kma: "MKE", label: "Milwaukee, WI" },
  "madison": { kma: "MSN", label: "Madison, WI" },
  "green bay": { kma: "GRB", label: "Green Bay, WI" },
  "appleton": { kma: "ATW", label: "Appleton, WI" },
  "detroit": { kma: "DTW", label: "Detroit, MI" },
  "dearborn": { kma: "DTW", label: "Detroit, MI" },
  "warren": { kma: "DTW", label: "Detroit, MI" },
  "sterling heights": { kma: "DTW", label: "Detroit, MI" },
  "ann arbor": { kma: "DTW", label: "Detroit, MI" },
  "pontiac": { kma: "DTW", label: "Detroit, MI" },
  "flint": { kma: "FNT", label: "Flint, MI" },
  "grand rapids": { kma: "GRR", label: "Grand Rapids, MI" },
  "kalamazoo": { kma: "AZO", label: "Kalamazoo, MI" },
  "lansing": { kma: "LAN", label: "Lansing, MI" },
  "minneapolis": { kma: "MSP", label: "Minneapolis, MN" },
  "saint paul": { kma: "MSP", label: "Minneapolis, MN" },
  "st paul": { kma: "MSP", label: "Minneapolis, MN" },
  "st. paul": { kma: "MSP", label: "Minneapolis, MN" },
  "bloomington": { kma: "MSP", label: "Minneapolis, MN" },
  "brooklyn park": { kma: "MSP", label: "Minneapolis, MN" },
  "brooklyn center": { kma: "MSP", label: "Minneapolis, MN" },
  "minnetonka": { kma: "MSP", label: "Minneapolis, MN" },
  "eagan": { kma: "MSP", label: "Minneapolis, MN" },
  "eden prairie": { kma: "MSP", label: "Minneapolis, MN" },
  "duluth": { kma: "DLH", label: "Duluth, MN" },
  "fargo": { kma: "FAR", label: "Fargo, ND" },
  "sioux falls": { kma: "FSD", label: "Sioux Falls, SD" },
  "kansas city": { kma: "MCI", label: "Kansas City, MO" },
  "lee's summit": { kma: "MCI", label: "Kansas City, MO" },
  "lees summit": { kma: "MCI", label: "Kansas City, MO" },
  "overland park": { kma: "MCI", label: "Kansas City, MO" },
  "olathe": { kma: "MCI", label: "Kansas City, MO" },
  "independence": { kma: "MCI", label: "Kansas City, MO" },
  "liberty": { kma: "MCI", label: "Kansas City, MO" },
  "st. louis": { kma: "STL", label: "St. Louis, MO" },
  "st louis": { kma: "STL", label: "St. Louis, MO" },
  "saint louis": { kma: "STL", label: "St. Louis, MO" },
  "hazelwood": { kma: "STL", label: "St. Louis, MO" },
  "earth city": { kma: "STL", label: "St. Louis, MO" },
  "springfield": { kma: "SGF", label: "Springfield, MO" },
  "columbia": { kma: "COU", label: "Columbia, MO" },
  "omaha": { kma: "OMA", label: "Omaha, NE" },
  "lincoln": { kma: "LNK", label: "Lincoln, NE" },
  "des moines": { kma: "DSM", label: "Des Moines, IA" },
  "cedar rapids": { kma: "CID", label: "Cedar Rapids, IA" },
  "davenport": { kma: "MLI", label: "Davenport/Quad Cities, IA" },
  "moline": { kma: "MLI", label: "Davenport/Quad Cities, IA" },
  "rock island": { kma: "MLI", label: "Davenport/Quad Cities, IA" },
  "indianapolis": { kma: "IND", label: "Indianapolis, IN" },
  "carmel": { kma: "IND", label: "Indianapolis, IN" },
  "fishers": { kma: "IND", label: "Indianapolis, IN" },
  "anderson": { kma: "IND", label: "Indianapolis, IN" },
  "fort wayne": { kma: "FWA", label: "Fort Wayne, IN" },
  "south bend": { kma: "SBN", label: "South Bend, IN" },
  "evansville": { kma: "EVV", label: "Evansville, IN" },
  "columbus": { kma: "CMH", label: "Columbus, OH" },
  "cleveland": { kma: "CLE", label: "Cleveland, OH" },
  "akron": { kma: "CLE", label: "Cleveland, OH" },
  "lorain": { kma: "CLE", label: "Cleveland, OH" },
  "elyria": { kma: "CLE", label: "Cleveland, OH" },
  "cincinnati": { kma: "CVG", label: "Cincinnati, OH" },
  "dayton": { kma: "DAY", label: "Dayton, OH" },
  "toledo": { kma: "TOL", label: "Toledo, OH" },
  "youngstown": { kma: "YNG", label: "Youngstown, OH" },
  "pittsburgh": { kma: "PIT", label: "Pittsburgh, PA" },
  "bethlehem": { kma: "ABE", label: "Allentown, PA" },
  "allentown": { kma: "ABE", label: "Allentown, PA" },

  // --- Southeast ---
  "atlanta": { kma: "ATL", label: "Atlanta, GA" },
  "savannah": { kma: "SAV", label: "Savannah, GA" },
  "augusta": { kma: "AGS", label: "Augusta, GA" },
  "macon": { kma: "MCN", label: "Macon, GA" },
  "nashville": { kma: "BNA", label: "Nashville, TN" },
  "memphis": { kma: "MEM", label: "Memphis, TN" },
  "knoxville": { kma: "TYS", label: "Knoxville, TN" },
  "chattanooga": { kma: "CHA", label: "Chattanooga, TN" },
  "louisville": { kma: "SDF", label: "Louisville, KY" },
  "lexington": { kma: "LEX", label: "Lexington, KY" },
  "charlotte": { kma: "CLT", label: "Charlotte, NC" },
  "concord": { kma: "CLT", label: "Charlotte, NC" },
  "gastonia": { kma: "CLT", label: "Charlotte, NC" },
  "greensboro": { kma: "GSO", label: "Greensboro, NC" },
  "raleigh": { kma: "RDU", label: "Raleigh/Durham, NC" },
  "durham": { kma: "RDU", label: "Raleigh/Durham, NC" },
  "greenville": { kma: "GSP", label: "Greenville/Spartanburg, SC" },
  "spartanburg": { kma: "GSP", label: "Greenville/Spartanburg, SC" },
  "columbia sc": { kma: "CAE", label: "Columbia, SC" },
  "charleston": { kma: "CHS", label: "Charleston, SC" },
  "birmingham": { kma: "BHM", label: "Birmingham, AL" },
  "huntsville": { kma: "HSV", label: "Huntsville, AL" },
  "montgomery": { kma: "MGM", label: "Montgomery, AL" },
  "mobile": { kma: "MOB", label: "Mobile, AL" },
  "jackson": { kma: "JAN", label: "Jackson, MS" },
  "new orleans": { kma: "MSY", label: "New Orleans, LA" },
  "baton rouge": { kma: "BTR", label: "Baton Rouge, LA" },
  "shreveport": { kma: "SHV", label: "Shreveport, LA" },
  "little rock": { kma: "LIT", label: "Little Rock, AR" },
  "fayetteville": { kma: "XNA", label: "Fayetteville, AR" },
  "springdale": { kma: "XNA", label: "Fayetteville, AR" },
  "bentonville": { kma: "XNA", label: "Fayetteville, AR" },
  "miami": { kma: "MIA", label: "Miami, FL" },
  "fort lauderdale": { kma: "FLL", label: "Fort Lauderdale, FL" },
  "hialeah": { kma: "MIA", label: "Miami, FL" },
  "west palm beach": { kma: "PBI", label: "West Palm Beach, FL" },
  "orlando": { kma: "MCO", label: "Orlando, FL" },
  "kissimmee": { kma: "MCO", label: "Orlando, FL" },
  "lakeland": { kma: "LAL", label: "Lakeland, FL" },
  "tampa": { kma: "TPA", label: "Tampa, FL" },
  "st. petersburg": { kma: "TPA", label: "Tampa, FL" },
  "st. pete": { kma: "TPA", label: "Tampa, FL" },
  "jacksonville": { kma: "JAX", label: "Jacksonville, FL" },
  "tallahassee": { kma: "TLH", label: "Tallahassee, FL" },
  "pensacola": { kma: "PNS", label: "Pensacola, FL" },
  "panama city": { kma: "ECP", label: "Panama City, FL" },

  // --- Northeast / Mid-Atlantic ---
  "new york": { kma: "JFK", label: "New York, NY" },
  "brooklyn": { kma: "JFK", label: "New York, NY" },
  "bronx": { kma: "JFK", label: "New York, NY" },
  "queens": { kma: "JFK", label: "New York, NY" },
  "newark": { kma: "EWR", label: "Newark, NJ" },
  "jersey city": { kma: "EWR", label: "Newark, NJ" },
  "elizabeth": { kma: "EWR", label: "Newark, NJ" },
  "boston": { kma: "BOS", label: "Boston, MA" },
  "worcester": { kma: "ORH", label: "Worcester, MA" },
  "providence": { kma: "PVD", label: "Providence, RI" },
  "hartford": { kma: "BDL", label: "Hartford, CT" },
  "bridgeport": { kma: "BDL", label: "Hartford, CT" },
  "philadelphia": { kma: "PHL", label: "Philadelphia, PA" },
  "norristown": { kma: "PHL", label: "Philadelphia, PA" },
  "wilmington de": { kma: "ILG", label: "Wilmington, DE" },
  "baltimore": { kma: "BWI", label: "Baltimore, MD" },
  "washington": { kma: "IAD", label: "Washington, DC" },
  "richmond": { kma: "RIC", label: "Richmond, VA" },
  "norfolk": { kma: "ORF", label: "Norfolk, VA" },
  "virginia beach": { kma: "ORF", label: "Norfolk, VA" },
  "roanoke": { kma: "ROA", label: "Roanoke, VA" },
  "buffalo": { kma: "BUF", label: "Buffalo, NY" },
  "rochester": { kma: "ROC", label: "Rochester, NY" },
  "albany": { kma: "ALB", label: "Albany, NY" },
  "syracuse": { kma: "SYR", label: "Syracuse, NY" },
  "harrisburg": { kma: "MDT", label: "Harrisburg, PA" },
};

/**
 * Convert a city name (from TMS/LWQ) to a TRAC KMA code.
 * Strips state abbreviation, lowercases, and fuzzy-matches.
 */
export function cityToKma(cityName: string, stateName?: string | null): { kma: string; label: string } | null {
  if (!cityName) return null;

  // Normalize: strip state suffix like ", UT" or " UT", lowercase, trim
  const normalized = cityName
    .toLowerCase()
    .replace(/,\s*[a-z]{2}$/i, "")
    .trim();

  const entry = CITY_TO_KMA[normalized];
  if (entry) return entry;

  // Try partial match — useful for things like "Salt Lake" → SLC
  for (const [key, val] of Object.entries(CITY_TO_KMA)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return val;
    }
  }

  return null;
}

/**
 * Build the KMA label for display (e.g. "SLC" or "Salt Lake City, UT").
 */
export function getKmaLabel(kma: string): string {
  for (const entry of Object.values(CITY_TO_KMA)) {
    if (entry.kma === kma) return entry.label;
  }
  return kma;
}

/**
 * Map TMS equipment type string to TRAC equipment type.
 */
export function toTracEquipment(equip: string | null | undefined): "VAN" | "REEFER" | "FLATBED" {
  if (!equip) return "VAN";
  const u = equip.toUpperCase();
  if (u.includes("REEFER") || u.includes("REFR") || u.includes("TEMP") || u.includes("REFRIG")) return "REEFER";
  if (u.includes("FLAT") || u.includes("STEP") || u.includes("RGN") || u.includes("RGON")) return "FLATBED";
  return "VAN";
}
