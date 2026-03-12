import pg from "pg";

const JBS_COMPANY_ID = "9e8ae5e3-7b60-495b-a0c0-8da42f8288ff";

const metros: { city: string; state: string }[] = [
  { city: "Chicago", state: "IL" },
  { city: "Dallas", state: "TX" },
  { city: "Houston", state: "TX" },
  { city: "Los Angeles", state: "CA" },
  { city: "Atlanta", state: "GA" },
  { city: "Phoenix", state: "AZ" },
  { city: "Denver", state: "CO" },
  { city: "Minneapolis", state: "MN" },
  { city: "Kansas City", state: "MO" },
  { city: "St. Louis", state: "MO" },
  { city: "Indianapolis", state: "IN" },
  { city: "Columbus", state: "OH" },
  { city: "Nashville", state: "TN" },
  { city: "Memphis", state: "TN" },
  { city: "Charlotte", state: "NC" },
  { city: "Jacksonville", state: "FL" },
  { city: "Tampa", state: "FL" },
  { city: "Miami", state: "FL" },
  { city: "San Antonio", state: "TX" },
  { city: "Philadelphia", state: "PA" },
  { city: "New York", state: "NY" },
  { city: "Boston", state: "MA" },
  { city: "Baltimore", state: "MD" },
  { city: "Richmond", state: "VA" },
  { city: "Raleigh", state: "NC" },
  { city: "Cincinnati", state: "OH" },
  { city: "Louisville", state: "KY" },
  { city: "Milwaukee", state: "WI" },
  { city: "Detroit", state: "MI" },
  { city: "Cleveland", state: "OH" },
  { city: "Pittsburgh", state: "PA" },
  { city: "Salt Lake City", state: "UT" },
  { city: "Portland", state: "OR" },
  { city: "Seattle", state: "WA" },
  { city: "Sacramento", state: "CA" },
  { city: "San Francisco", state: "CA" },
  { city: "Las Vegas", state: "NV" },
  { city: "Albuquerque", state: "NM" },
  { city: "Oklahoma City", state: "OK" },
  { city: "Omaha", state: "NE" },
  { city: "Des Moines", state: "IA" },
  { city: "Birmingham", state: "AL" },
  { city: "New Orleans", state: "LA" },
  { city: "Little Rock", state: "AR" },
  { city: "Boise", state: "ID" },
  { city: "El Paso", state: "TX" },
  { city: "Fresno", state: "CA" },
  { city: "Tucson", state: "AZ" },
  { city: "Spokane", state: "WA" },
  { city: "Greensboro", state: "NC" },
  { city: "Knoxville", state: "TN" },
  { city: "Grand Rapids", state: "MI" },
  { city: "Sioux Falls", state: "SD" },
  { city: "Wichita", state: "KS" },
  { city: "Amarillo", state: "TX" },
  { city: "Lubbock", state: "TX" },
  { city: "Savannah", state: "GA" },
  { city: "Charleston", state: "SC" },
  { city: "Norfolk", state: "VA" },
  { city: "Harrisburg", state: "PA" },
];

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
}

async function main() {
  const rand = seededRandom(42);

  const lanes: { origin: typeof metros[0]; destination: typeof metros[0]; volume: number }[] = [];
  const usedPairs = new Set<string>();

  while (lanes.length < 200) {
    const oi = Math.floor(rand() * metros.length);
    const di = Math.floor(rand() * metros.length);
    if (oi === di) continue;
    const key = `${oi}-${di}`;
    if (usedPairs.has(key)) continue;
    usedPairs.add(key);
    lanes.push({ origin: metros[oi], destination: metros[di], volume: 0 });
  }

  let totalTarget = 5000;
  for (let i = 0; i < lanes.length; i++) {
    lanes[i].volume = 5 + Math.floor(rand() * 15);
  }
  const baseTotal = lanes.reduce((s, l) => s + l.volume, 0);

  const topCount = 50;
  for (let i = 0; i < topCount; i++) {
    lanes[i].volume = 51 + Math.floor(rand() * 150);
  }
  const currentTotal = lanes.reduce((s, l) => s + l.volume, 0);
  const deficit = totalTarget - currentTotal;

  if (deficit > 0) {
    const perLane = Math.floor(deficit / topCount);
    const remainder = deficit % topCount;
    for (let i = 0; i < topCount; i++) {
      lanes[i].volume += perLane + (i < remainder ? 1 : 0);
    }
  } else if (deficit < 0) {
    let excess = -deficit;
    for (let i = topCount; i < lanes.length && excess > 0; i++) {
      const reduce = Math.min(lanes[i].volume - 1, excess);
      lanes[i].volume -= reduce;
      excess -= reduce;
    }
  }

  const finalTotal = lanes.reduce((s, l) => s + l.volume, 0);

  const originStates = [...new Set(lanes.map(l => l.origin.state))].sort();
  const destinationStates = [...new Set(lanes.map(l => l.destination.state))].sort();

  const rows = lanes.map((l, i) => ({
    "Lane #": `JBS-${String(i + 1).padStart(3, "0")}`,
    "Origin City": l.origin.city,
    "Origin State": l.origin.state,
    "Destination City": l.destination.city,
    "Destination State": l.destination.state,
    "Annual Volume": l.volume,
    "Equipment": "Dry Van",
    "Rate": `$${(1.5 + rand() * 2.5).toFixed(2)}`,
  }));

  const highVolumeLanes = lanes
    .map((l, i) => ({
      lane: `${l.origin.city}, ${l.origin.state} → ${l.destination.city}, ${l.destination.state}`,
      laneId: `JBS-${String(i + 1).padStart(3, "0")}`,
      origin: l.origin.city,
      destination: l.destination.city,
      originState: l.origin.state,
      destinationState: l.destination.state,
      volume: l.volume,
      rate: rows[i]["Rate"],
      equipment: "Dry Van",
      rawRow: rows[i],
      status: "open",
    }))
    .filter(l => l.volume > 50)
    .sort((a, b) => b.volume - a.volume);

  const fileData = {
    rows: rows.slice(0, 100),
    headers: ["Lane #", "Origin City", "Origin State", "Destination City", "Destination State", "Annual Volume", "Equipment", "Rate"],
    highVolumeLanes,
    analysis: {
      laneCount: 200,
      totalVolume: String(finalTotal),
      originStates,
      destinationStates,
      volumeColumn: "Annual Volume",
      rateColumn: "Rate",
      originColumn: "Origin City",
      destinationColumn: "Destination City",
      highVolumeLaneCount: highVolumeLanes.length,
      isWeeklyVolume: false,
    },
  };

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const result = await pool.query(
      `INSERT INTO rfps (id, company_id, title, status, due_date, notes, file_name, file_data, lane_count, total_volume, origin_states, destination_states)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, title`,
      [
        JBS_COMPANY_ID,
        "JBS Foods 2026 National RFP",
        "pending",
        "2026-12-31",
        "Test RFP with 200 metro-to-metro dry van lanes across major US cities",
        "JBS_Foods_2026_National_RFP.xlsx",
        JSON.stringify(fileData),
        200,
        String(finalTotal),
        originStates,
        destinationStates,
      ]
    );

    const rfp = result.rows[0];
    console.log(`Created RFP: ${rfp.title} (id: ${rfp.id})`);
    console.log(`  Lanes: 200 | Total volume: ${finalTotal} | High-volume: ${highVolumeLanes.length}`);
    console.log(`  Origin states: ${originStates.join(", ")}`);
    console.log(`  Destination states: ${destinationStates.join(", ")}`);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
