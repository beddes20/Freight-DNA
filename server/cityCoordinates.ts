/**
 * City coordinate lookup for freight lane proximity matching.
 *
 * Used by carrierRankingService to determine whether a carrier's historical
 * lane is within a configurable radius of the requested lane (both origin
 * and destination endpoints).
 *
 * Key is normalized "city, st" (all lowercase, trimmed).
 * Value is [latitude, longitude] in decimal degrees.
 *
 * Covers ~350 US freight cities including all markets seen in VT TMS data.
 */
const CITY_COORDS: Record<string, [number, number]> = {
  // ── Arizona ──────────────────────────────────────────────────────────────
  "phoenix, az":         [33.4484, -112.0740],
  "tempe, az":           [33.4255, -111.9400],
  "scottsdale, az":      [33.4942, -111.9261],
  "mesa, az":            [33.4152, -111.8315],
  "chandler, az":        [33.3062, -111.8413],
  "gilbert, az":         [33.3528, -111.7890],
  "glendale, az":        [33.5387, -112.1860],
  "goodyear, az":        [33.4353, -112.3576],
  "surprise, az":        [33.6292, -112.3679],
  "peoria, az":          [33.5806, -112.2374],
  "avondale, az":        [33.4356, -112.3496],
  "tucson, az":          [32.2226, -110.9747],
  "flagstaff, az":       [35.1983, -111.6513],
  "yuma, az":            [32.6927, -114.6277],
  "el mirage, az":       [33.6112, -112.3271],
  "laveen, az":          [33.3625, -112.1679],
  // ── Washington ───────────────────────────────────────────────────────────
  "seattle, wa":         [47.6062, -122.3321],
  "kent, wa":            [47.3809, -122.2348],
  "auburn, wa":          [47.3073, -122.2285],
  "renton, wa":          [47.4829, -122.2171],
  "tukwila, wa":         [47.4741, -122.2629],
  "burien, wa":          [47.4701, -122.3465],
  "federal way, wa":     [47.3223, -122.3126],
  "tacoma, wa":          [47.2529, -122.4443],
  "puyallup, wa":        [47.1854, -122.2929],
  "fife, wa":            [47.2376, -122.3651],
  "milton, wa":          [47.2470, -122.3151],
  "sumner, wa":          [47.2034, -122.2340],
  "lakewood, wa":        [47.1718, -122.5185],
  "olympia, wa":         [47.0379, -122.9007],
  "everett, wa":         [47.9790, -122.2021],
  "marysville, wa":      [48.0518, -122.1771],
  "lynnwood, wa":        [47.8209, -122.3151],
  "edmonds, wa":         [47.8107, -122.3779],
  "mukilteo, wa":        [47.9468, -122.3051],
  "snohomish, wa":       [47.9129, -122.0985],
  "algona, wa":          [47.2759, -122.2576],
  "bellevue, wa":        [47.6101, -122.2015],
  "kirkland, wa":        [47.6815, -122.2087],
  "redmond, wa":         [47.6740, -122.1215],
  "bothell, wa":         [47.7601, -122.2048],
  "spokane, wa":         [47.6588, -117.4260],
  "spokane valley, wa":  [47.6732, -117.2394],
  "richland, wa":        [46.2804, -119.2752],
  "pasco, wa":           [46.2396, -119.1006],
  "kennewick, wa":       [46.2113, -119.1372],
  "yakima, wa":          [46.6021, -120.5059],
  "vancouver, wa":       [45.6387, -122.6615],
  "longview, wa":        [46.1382, -122.9382],
  "bellingham, wa":      [48.7519, -122.4787],
  "walla walla, wa":     [46.0646, -118.3430],
  // ── Oregon ───────────────────────────────────────────────────────────────
  "portland, or":        [45.5051, -122.6750],
  "beaverton, or":       [45.4871, -122.8037],
  "hillsboro, or":       [45.5229, -122.9898],
  "tigard, or":          [45.4312, -122.7714],
  "tualatin, or":        [45.3840, -122.7629],
  "wilsonville, or":     [45.2996, -122.7737],
  "lake oswego, or":     [45.4207, -122.7007],
  "oregon city, or":     [45.3565, -122.6067],
  "clackamas, or":       [45.4040, -122.5660],
  "gresham, or":         [45.4990, -122.4302],
  "troutdale, or":       [45.5357, -122.3882],
  "milwaukie, or":       [45.4457, -122.6393],
  "salem, or":           [44.9429, -123.0351],
  "eugene, or":          [44.0521, -123.0868],
  "springfield, or":     [44.0462, -122.9271],
  "bend, or":            [44.0582, -121.3153],
  "medford, or":         [42.3265, -122.8756],
  "ashland, or":         [42.1946, -122.7095],
  "klamath falls, or":   [42.2249, -121.7817],
  "riddle, or":          [42.9540, -123.3671],
  "roseburg, or":        [43.2165, -123.3417],
  "coos bay, or":        [43.3665, -124.2179],
  "astoria, or":         [46.1879, -123.8313],
  "albany, or":          [44.6365, -123.1059],
  "corvallis, or":       [44.5646, -123.2620],
  "grants pass, or":     [42.4390, -123.3285],
  // ── California ───────────────────────────────────────────────────────────
  "los angeles, ca":     [34.0522, -118.2437],
  "long beach, ca":      [33.7701, -118.1937],
  "compton, ca":         [33.8958, -118.2201],
  "carson, ca":          [33.8316, -118.2819],
  "rancho dominguez, ca":[33.8700, -118.2534],
  "gardena, ca":         [33.8883, -118.3089],
  "torrance, ca":        [33.8358, -118.3406],
  "san pedro, ca":       [33.7361, -118.2922],
  "wilmington, ca":      [33.7803, -118.2614],
  "commerce, ca":        [34.0001, -118.1592],
  "fontana, ca":         [34.0922, -117.4350],
  "rialto, ca":          [34.1064, -117.3703],
  "ontario, ca":         [34.0633, -117.6509],
  "san bernardino, ca":  [34.1083, -117.2898],
  "riverside, ca":       [33.9533, -117.3961],
  "mira loma, ca":       [33.9952, -117.5139],
  "perris, ca":          [33.7825, -117.2286],
  "moreno valley, ca":   [33.9425, -117.2297],
  "san francisco, ca":   [37.7749, -122.4194],
  "san jose, ca":        [37.3382, -121.8863],
  "oakland, ca":         [37.8044, -122.2712],
  "fremont, ca":         [37.5485, -121.9886],
  "san leandro, ca":     [37.7249, -122.1561],
  "hayward, ca":         [37.6688, -122.0808],
  "union city, ca":      [37.5935, -122.0438],
  "tracy, ca":           [37.7397, -121.4252],
  "stockton, ca":        [37.9577, -121.2908],
  "modesto, ca":         [37.6391, -120.9969],
  "fresno, ca":          [36.7378, -119.7871],
  "sacramento, ca":      [38.5816, -121.4944],
  "west sacramento, ca": [38.5805, -121.5310],
  "woodland, ca":        [38.6785, -121.7734],
  "lathrop, ca":         [37.8227, -121.2758],
  "dixon, ca":           [38.4457, -121.8235],
  "vacaville, ca":       [38.3566, -121.9877],
  "fairfield, ca":       [38.2494, -122.0400],
  "san diego, ca":       [32.7157, -117.1611],
  "chula vista, ca":     [32.6401, -117.0842],
  "el cajon, ca":        [32.7948, -116.9625],
  "bakersfield, ca":     [35.3733, -119.0187],
  "visalia, ca":         [36.3302, -119.2921],
  "tulare, ca":          [36.2077, -119.3473],
  // ── Nevada ───────────────────────────────────────────────────────────────
  "las vegas, nv":       [36.1699, -115.1398],
  "henderson, nv":       [36.0395, -114.9817],
  "north las vegas, nv": [36.1989, -115.1175],
  "reno, nv":            [39.5296, -119.8138],
  "sparks, nv":          [39.5349, -119.7527],
  "fernley, nv":         [39.6082, -119.2521],
  "elko, nv":            [40.8324, -115.7631],
  // ── Utah ─────────────────────────────────────────────────────────────────
  "salt lake city, ut":  [40.7608, -111.8910],
  "south salt lake, ut": [40.7185, -111.8883],
  "murray, ut":          [40.6669, -111.8880],
  "sandy, ut":           [40.5649, -111.8389],
  "west valley city, ut":[40.6916, -112.0011],
  "west jordan, ut":     [40.6097, -111.9391],
  "draper, ut":          [40.5246, -111.8638],
  "cottonwood heights, ut":[40.6199, -111.8149],
  "taylorsville, ut":    [40.6677, -111.9388],
  "millcreek, ut":       [40.6863, -111.8752],
  "midvale, ut":         [40.6113, -111.9002],
  "riverton, ut":        [40.5218, -111.9400],
  "herriman, ut":        [40.5140, -112.0330],
  "ogden, ut":           [41.2230, -111.9738],
  "roy, ut":             [41.1616, -112.0263],
  "layton, ut":          [41.0602, -111.9710],
  "clearfield, ut":      [41.1080, -112.0249],
  "syracuse, ut":        [41.0896, -112.0655],
  "provo, ut":           [40.2338, -111.6585],
  "orem, ut":            [40.2969, -111.6946],
  "lehi, ut":            [40.3916, -111.8508],
  "american fork, ut":   [40.3769, -111.7952],
  "spanish fork, ut":    [40.1150, -111.6549],
  "springville, ut":     [40.1694, -111.6099],
  "logan, ut":           [41.7370, -111.8338],
  "st. george, ut":      [37.0965, -113.5684],
  // ── Idaho ────────────────────────────────────────────────────────────────
  "boise, id":           [43.6150, -116.2023],
  "nampa, id":           [43.5407, -116.5635],
  "meridian, id":        [43.6121, -116.3915],
  "caldwell, id":        [43.6629, -116.6874],
  "twin falls, id":      [42.5629, -114.4609],
  "idaho falls, id":     [43.4927, -112.0408],
  "pocatello, id":       [42.8713, -112.4455],
  "coeur d'alene, id":   [47.6777, -116.7805],
  "lewiston, id":        [46.4165, -117.0177],
  // ── Montana ──────────────────────────────────────────────────────────────
  "billings, mt":        [45.7833, -108.5007],
  "missoula, mt":        [46.8787, -113.9966],
  "great falls, mt":     [47.4941, -111.2833],
  "bozeman, mt":         [45.6770, -111.0429],
  "helena, mt":          [46.5958, -112.0270],
  "kalispell, mt":       [48.1920, -114.3169],
  "butte, mt":           [46.0038, -112.5348],
  // ── Colorado ─────────────────────────────────────────────────────────────
  "denver, co":          [39.7392, -104.9903],
  "aurora, co":          [39.7294, -104.8319],
  "lakewood, co":        [39.7047, -105.0814],
  "arvada, co":          [39.8028, -105.0875],
  "westminster, co":     [39.8367, -105.0372],
  "commerce city, co":   [39.8083, -104.9339],
  "thornton, co":        [39.8680, -104.9719],
  "brighton, co":        [39.9853, -104.8197],
  "pueblo, co":          [38.2544, -104.6091],
  "colorado springs, co":[38.8339, -104.8214],
  "fort collins, co":    [40.5853, -105.0844],
  "greeley, co":         [40.4233, -104.7091],
  "grand junction, co":  [39.0639, -108.5506],
  // ── New Mexico ───────────────────────────────────────────────────────────
  "albuquerque, nm":     [35.0844, -106.6504],
  "santa fe, nm":        [35.6870, -105.9378],
  // ── Texas ────────────────────────────────────────────────────────────────
  "houston, tx":         [29.7604, -95.3698],
  "dallas, tx":          [32.7767, -96.7970],
  "fort worth, tx":      [32.7555, -97.3308],
  "san antonio, tx":     [29.4241, -98.4936],
  "austin, tx":          [30.2672, -97.7431],
  "laredo, tx":          [27.5306, -99.4803],
  "el paso, tx":         [31.7619, -106.4850],
  "grand prairie, tx":   [32.7460, -97.0197],
  "irving, tx":          [32.8140, -96.9489],
  "mesquite, tx":        [32.7668, -96.5992],
  "carrollton, tx":      [32.9537, -96.8903],
  "mckinney, tx":        [33.1972, -96.6397],
  "plano, tx":           [33.0198, -96.6989],
  "richardson, tx":      [32.9483, -96.7299],
  "balch springs, tx":   [32.7218, -96.6233],
  "hutchins, tx":        [32.6401, -96.7067],
  "wilmer, tx":          [32.5957, -96.6825],
  "lancaster, tx":       [32.5918, -96.7561],
  "desoto, tx":          [32.5896, -96.8572],
  "duncanville, tx":     [32.6518, -96.9083],
  "corpus christi, tx":  [27.8006, -97.3964],
  "midland, tx":         [31.9974, -102.0779],
  "odessa, tx":          [31.8457, -102.3676],
  "lubbock, tx":         [33.5779, -101.8552],
  "amarillo, tx":        [35.2220, -101.8313],
  "abilene, tx":         [32.4487, -99.7331],
  "waco, tx":            [31.5493, -97.1467],
  // ── Illinois ─────────────────────────────────────────────────────────────
  "chicago, il":         [41.8781, -87.6298],
  "elgin, il":           [42.0354, -88.2826],
  "aurora, il":          [41.7606, -88.3201],
  "joliet, il":          [41.5250, -88.0817],
  "naperville, il":      [41.7508, -88.1535],
  "bolingbrook, il":     [41.6986, -88.0684],
  "romeoville, il":      [41.6475, -88.0895],
  "hodgkins, il":        [41.7742, -87.8590],
  "melrose park, il":    [41.9003, -87.8579],
  "cicero, il":          [41.8456, -87.7539],
  "addison, il":         [41.9317, -87.9889],
  "elk grove village, il":[42.0042, -87.9970],
  "des plaines, il":     [42.0334, -87.8834],
  "franklin park, il":   [41.9317, -87.8779],
  "rock island, il":     [41.5095, -90.5785],
  "peoria, il":          [40.6936, -89.5890],
  "springfield, il":     [39.7817, -89.6501],
  "decatur, il":         [39.8403, -88.9548],
  // ── Tennessee ────────────────────────────────────────────────────────────
  "memphis, tn":         [35.1495, -90.0490],
  "nashville, tn":       [36.1627, -86.7816],
  "knoxville, tn":       [35.9606, -83.9207],
  "chattanooga, tn":     [35.0456, -85.3097],
  "jackson, tn":         [35.6145, -88.8139],
  // ── Georgia ──────────────────────────────────────────────────────────────
  "atlanta, ga":         [33.7490, -84.3880],
  "savannah, ga":        [32.0835, -81.0998],
  "augusta, ga":         [33.4735, -82.0105],
  // ── Florida ──────────────────────────────────────────────────────────────
  "miami, fl":           [25.7617, -80.1918],
  "jacksonville, fl":    [30.3322, -81.6557],
  "orlando, fl":         [28.5383, -81.3792],
  "tampa, fl":           [27.9506, -82.4572],
  "st. pete, fl":        [27.7676, -82.6403],
  // ── Ohio ─────────────────────────────────────────────────────────────────
  "columbus, oh":        [39.9612, -82.9988],
  "cleveland, oh":       [41.4993, -81.6944],
  "cincinnati, oh":      [39.1031, -84.5120],
  "akron, oh":           [41.0814, -81.5190],
  "toledo, oh":          [41.6639, -83.5552],
  "dayton, oh":          [39.7589, -84.1916],
  "youngstown, oh":      [41.0998, -80.6495],
  // ── Michigan ─────────────────────────────────────────────────────────────
  "detroit, mi":         [42.3314, -83.0458],
  "grand rapids, mi":    [42.9634, -85.6681],
  "warren, mi":          [42.5145, -83.0146],
  "sterling heights, mi":[42.5803, -83.0302],
  "flint, mi":           [43.0125, -83.6875],
  "lansing, mi":         [42.7325, -84.5555],
  // ── Pennsylvania ─────────────────────────────────────────────────────────
  "philadelphia, pa":    [39.9526, -75.1652],
  "pittsburgh, pa":      [40.4406, -79.9959],
  "allentown, pa":       [40.6023, -75.4714],
  "erie, pa":            [42.1292, -80.0851],
  "harrisburg, pa":      [40.2732, -76.8867],
  "pittston, pa":        [41.3273, -75.7896],
  "scranton, pa":        [41.4090, -75.6624],
  // ── New York ─────────────────────────────────────────────────────────────
  "new york, ny":        [40.7128, -74.0060],
  "buffalo, ny":         [42.8864, -78.8784],
  "rochester, ny":       [43.1566, -77.6088],
  "albany, ny":          [42.6526, -73.7562],
  "syracuse, ny":        [43.0481, -76.1474],
  // ── Indiana ──────────────────────────────────────────────────────────────
  "indianapolis, in":    [39.7684, -86.1581],
  "fort wayne, in":      [41.0793, -85.1394],
  "gary, in":            [41.5934, -87.3465],
  "south bend, in":      [41.6764, -86.2520],
  // ── Wisconsin ────────────────────────────────────────────────────────────
  "milwaukee, wi":       [43.0389, -87.9065],
  "madison, wi":         [43.0731, -89.4012],
  "green bay, wi":       [44.5133, -88.0133],
  "kenosha, wi":         [42.5847, -87.8212],
  "racine, wi":          [42.7261, -87.7829],
  // ── Minnesota ────────────────────────────────────────────────────────────
  "minneapolis, mn":     [44.9778, -93.2650],
  "saint paul, mn":      [44.9537, -93.0900],
  "bloomington, mn":     [44.8408, -93.3477],
  "eagan, mn":           [44.8041, -93.1669],
  "inver grove heights, mn":[44.8547, -93.0433],
  "mankato, mn":         [44.1636, -93.9994],
  "rochester, mn":       [44.0121, -92.4802],
  // ── Missouri ─────────────────────────────────────────────────────────────
  "st. louis, mo":       [38.6270, -90.1994],
  "kansas city, mo":     [39.0997, -94.5786],
  "springfield, mo":     [37.2153, -93.2982],
  "columbia, mo":        [38.9517, -92.3341],
  "joplin, mo":          [37.0842, -94.5133],
  "earth city, mo":      [38.7333, -90.4001],
  // ── Nebraska ─────────────────────────────────────────────────────────────
  "omaha, ne":           [41.2565, -95.9345],
  "lincoln, ne":         [40.8136, -96.7026],
  "grand island, ne":    [40.9250, -98.3420],
  // ── Kansas ───────────────────────────────────────────────────────────────
  "kansas city, ks":     [39.1142, -94.6275],
  "wichita, ks":         [37.6872, -97.3301],
  "topeka, ks":          [39.0473, -95.6752],
  // ── Oklahoma ─────────────────────────────────────────────────────────────
  "oklahoma city, ok":   [35.4676, -97.5164],
  "tulsa, ok":           [36.1540, -95.9928],
  // ── Arkansas ─────────────────────────────────────────────────────────────
  "little rock, ar":     [34.7465, -92.2896],
  "fort smith, ar":      [35.3859, -94.3985],
  // ── Louisiana ────────────────────────────────────────────────────────────
  "new orleans, la":     [29.9511, -90.0715],
  "baton rouge, la":     [30.4515, -91.1871],
  "shreveport, la":      [32.5252, -93.7502],
  // ── Mississippi ──────────────────────────────────────────────────────────
  "jackson, ms":         [32.2988, -90.1848],
  // ── Alabama ──────────────────────────────────────────────────────────────
  "birmingham, al":      [33.5186, -86.8104],
  "montgomery, al":      [32.3617, -86.2792],
  "mobile, al":          [30.6954, -88.0399],
  "huntsville, al":      [34.7304, -86.5861],
  // ── South Carolina ───────────────────────────────────────────────────────
  "charleston, sc":      [32.7765, -79.9311],
  "columbia, sc":        [34.0007, -81.0348],
  "greenville, sc":      [34.8526, -82.3940],
  "spartanburg, sc":     [34.9496, -81.9321],
  // ── North Carolina ───────────────────────────────────────────────────────
  "charlotte, nc":       [35.2271, -80.8431],
  "raleigh, nc":         [35.7796, -78.6382],
  "greensboro, nc":      [36.0726, -79.7920],
  "durham, nc":          [35.9940, -78.8986],
  "winston-salem, nc":   [36.0999, -80.2442],
  // ── Virginia ─────────────────────────────────────────────────────────────
  "richmond, va":        [37.5407, -77.4360],
  "norfolk, va":         [36.8508, -76.2859],
  "virginia beach, va":  [36.8529, -75.9780],
  // ── Maryland ─────────────────────────────────────────────────────────────
  "baltimore, md":       [39.2904, -76.6122],
  // ── New Jersey ───────────────────────────────────────────────────────────
  "newark, nj":          [40.7357, -74.1724],
  "edison, nj":          [40.5187, -74.4121],
  "elizabeth, nj":       [40.6640, -74.2107],
  // ── Connecticut ──────────────────────────────────────────────────────────
  "hartford, ct":        [41.7637, -72.6851],
  "bridgeport, ct":      [41.1865, -73.1952],
  // ── Massachusetts ────────────────────────────────────────────────────────
  "boston, ma":          [42.3601, -71.0589],
  "worcester, ma":       [42.2626, -71.8023],
  "springfield, ma":     [42.1015, -72.5898],
  "westfield, ma":       [42.1251, -72.7496],
  // ── Kentucky ─────────────────────────────────────────────────────────────
  "louisville, ky":      [38.2527, -85.7585],
  "lexington, ky":       [38.0406, -84.5037],
  // ── Maryland / DC ────────────────────────────────────────────────────────
  "washington, dc":      [38.9072, -77.0369],
};

/**
 * Look up approximate coordinates for a city+state string.
 * Input can be in any form: "PHOENIX, AZ", "phoenix, az", "Phoenix AZ".
 * Returns null if the city is not in the lookup table.
 */
export function getCityCoords(rawCityState: string): [number, number] | null {
  if (!rawCityState) return null;

  // Normalize to "city, st" lowercase
  const normalized = rawCityState
    .trim()
    .toLowerCase()
    // Replace "st." / "ft." / "mt." abbreviations with full form for lookup consistency
    .replace(/^st\. /, "saint ")
    .replace(/\bft\. /, "fort ")
    .replace(/\bmt\. /, "mount ");

  // Direct lookup
  if (CITY_COORDS[normalized]) return CITY_COORDS[normalized];

  // Try without the state abbreviation (e.g. "phoenix" → try adding states, or strip trailing)
  // Also handle "city, state_abbr" with extra whitespace
  const cleaned = normalized.replace(/\s+/g, " ").replace(/,\s+/, ", ");
  if (CITY_COORDS[cleaned]) return CITY_COORDS[cleaned];

  return null;
}

/**
 * Compute the great-circle distance between two lat/lng points, in miles.
 * Uses the Haversine formula.
 */
export function haversineDistanceMiles(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 3958.8; // Earth's radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Get the distance in miles between two city/state strings.
 * Returns null if either city is not in the coordinate lookup table.
 */
export function cityDistanceMiles(rawCity1: string, rawCity2: string): number | null {
  const c1 = getCityCoords(rawCity1);
  const c2 = getCityCoords(rawCity2);
  if (!c1 || !c2) return null;
  return haversineDistanceMiles(c1[0], c1[1], c2[0], c2[1]);
}
