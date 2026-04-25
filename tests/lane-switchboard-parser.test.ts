// Pure parser tests for the Global Lane Switchboard (Task #652).
//
// Run via: `npx tsx tests/lane-switchboard-parser.test.ts`
// or `node --test --import tsx tests/lane-switchboard-parser.test.ts`.
//
// We don't go through tsx's --test runner here (the project's other unit
// tests use plain assertions inside a single file). This script exits 0
// on success and 1 on any assertion failure.

import {
  parseSwitchboardInput,
  buildSwitchboardQuery,
} from "../client/src/lib/laneSwitchboardParser";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  ✗ ${label}\n`);
    if (detail !== undefined) {
      process.stdout.write(`      ${JSON.stringify(detail)}\n`);
    }
  }
}

console.log("Lane Switchboard parser — Task #652\n");

// 1. Arrow form, 3-letter codes, no equipment
{
  const p = parseSwitchboardInput("ATL → DAL");
  check("ATL → DAL parses", p.status === "ok", p);
  check("origin city = atlanta", p.originCity?.toLowerCase() === "atlanta", p.originCity);
  check("origin state = GA", p.originState === "GA", p.originState);
  check("dest city = dallas", p.destCity?.toLowerCase() === "dallas", p.destCity);
  check("dest state = TX", p.destState === "TX", p.destState);
  check("equipment is null", p.equipment === null);
}

// 2. "to" form, equipment word
{
  const p = parseSwitchboardInput("Atlanta to Dallas reefer");
  check("Atlanta to Dallas reefer parses", p.status === "ok");
  check("equipment = reefer", p.equipment === "reefer", p.equipment);
  check("origin = atlanta", p.originCity?.toLowerCase() === "atlanta");
  check("dest = dallas", p.destCity?.toLowerCase() === "dallas");
}

// 3. City + state form with comma
{
  const p = parseSwitchboardInput("Memphis, TN -> Chicago, IL flatbed");
  check("city,state -> city,state parses", p.status === "ok", p);
  check("origin state = TN", p.originState === "TN");
  check("dest state = IL", p.destState === "IL");
  check("equipment = flatbed", p.equipment === "flatbed");
}

// 4. Empty / garbage falls back gracefully
{
  const p = parseSwitchboardInput("");
  check("empty input → status missing", p.status === "missing");
}
{
  const p = parseSwitchboardInput("just one side");
  check("no separator → status missing", p.status === "missing", p);
}

// 5. buildSwitchboardQuery returns null for non-ok parses,
//    and a usable query string for ok parses.
{
  const okParsed = parseSwitchboardInput("ATL > DAL van");
  const qs = buildSwitchboardQuery(okParsed);
  check("query string built for ok parse", typeof qs === "string" && qs.includes("originCity"), qs);
  const params = new URLSearchParams(qs ?? "");
  check("query has originCity=atlanta", params.get("originCity")?.toLowerCase() === "atlanta", params.get("originCity"));
  check("query has destCity=dallas", params.get("destCity")?.toLowerCase() === "dallas");
  check("query has equipment=van", params.get("equipment") === "van");
}
{
  const bad = parseSwitchboardInput("");
  check("query null for empty parse", buildSwitchboardQuery(bad) === null);
}

// 6. Single-letter equipment shorthand only matches at end of input
{
  const p = parseSwitchboardInput("Dover, DE to Fresno, CA");
  // Should NOT match "F" inside "FRESNO" or "DOVER"
  check("Dover→Fresno equipment is null (no spurious match)", p.equipment === null, p.equipment);
}
{
  const p = parseSwitchboardInput("Memphis to Chicago r");
  check("trailing 'r' → reefer", p.equipment === "reefer");
}

console.log(`\n${failures === 0 ? "All parser tests passed" : `${failures} failure(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
