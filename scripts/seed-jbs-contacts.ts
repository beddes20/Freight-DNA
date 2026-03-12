import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { contacts } from "../shared/schema";

const JBS_COMPANY_ID = "9e8ae5e3-7b60-495b-a0c0-8da42f8288ff";

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  try {
    const [vp] = await db.insert(contacts).values({
      companyId: JBS_COMPANY_ID,
      name: "Karen Mitchell",
      title: "VP of Transportation",
      relationshipBase: "2nd",
      email: "karen.mitchell@jbssa.com",
      phone: "970-555-0100",
      reportsToId: null,
      lanes: null,
      regions: ["National"],
      freightSpend: "45000000",
      spotBiddingProcess: "Uses DAT and internal bid board for spot freight",
      interests: "Cost reduction, carrier diversification",
      notes: "Decision maker for national RFPs. Prefers quarterly reviews.",
    }).returning();
    console.log(`Created VP: ${vp.name} (id: ${vp.id})`);

    const [logMgr] = await db.insert(contacts).values({
      companyId: JBS_COMPANY_ID,
      name: "Derek Alvarez",
      title: "Logistics Manager - Southeast",
      relationshipBase: "1st",
      email: "derek.alvarez@jbssa.com",
      phone: "970-555-0201",
      reportsToId: vp.id,
      lanes: ["Atlanta, GA", "Charlotte, NC"],
      regions: ["Southeast"],
      freightSpend: "12000000",
      spotBiddingProcess: "Posts to Truckstop for spot loads, 2-hour response window",
      interests: "Temperature-controlled capacity in summer months",
      notes: null,
    }).returning();
    console.log(`Created Logistics Manager: ${logMgr.name} (id: ${logMgr.id})`);

    const [planner1] = await db.insert(contacts).values({
      companyId: JBS_COMPANY_ID,
      name: "Marcus Thompson",
      title: "Transportation Planner",
      relationshipBase: "1st",
      email: "marcus.thompson@jbssa.com",
      phone: "970-555-0302",
      reportsToId: vp.id,
      lanes: ["Jacksonville, FL"],
      regions: ["Florida"],
      freightSpend: "8500000",
      spotBiddingProcess: null,
      interests: null,
      notes: "Owns all inbound and outbound at Jacksonville facility",
    }).returning();
    console.log(`Created Planner: ${planner1.name} (id: ${planner1.id})`);

    const [planner2] = await db.insert(contacts).values({
      companyId: JBS_COMPANY_ID,
      name: "Lisa Chen",
      title: "Transportation Planner",
      relationshipBase: "3rd",
      email: "lisa.chen@jbssa.com",
      phone: "970-555-0403",
      reportsToId: vp.id,
      lanes: ["Chicago, IL", "Dallas, TX"],
      regions: ["Midwest", "South Central"],
      freightSpend: "15000000",
      spotBiddingProcess: null,
      interests: "Drop trailer programs",
      notes: null,
    }).returning();
    console.log(`Created Planner: ${planner2.name} (id: ${planner2.id})`);

    const [admin] = await db.insert(contacts).values({
      companyId: JBS_COMPANY_ID,
      name: "Ryan Foster",
      title: "Administrative Coordinator",
      relationshipBase: "1st",
      email: "ryan.foster@jbssa.com",
      phone: "970-555-0504",
      reportsToId: logMgr.id,
      lanes: null,
      regions: null,
      freightSpend: null,
      spotBiddingProcess: null,
      interests: null,
      notes: "Handles BOLs and appointment scheduling",
    }).returning();
    console.log(`Created Admin: ${admin.name} (id: ${admin.id})`);

    console.log("\nOrg Chart:");
    console.log(`  ${vp.name} (VP)`);
    console.log(`    ├── ${logMgr.name} (Logistics Mgr) — lanes: Atlanta, Charlotte`);
    console.log(`    │   └── ${admin.name} (Admin) — no lanes`);
    console.log(`    ├── ${planner1.name} (Planner) — lanes: Jacksonville`);
    console.log(`    └── ${planner2.name} (Planner) — lanes: Chicago, Dallas`);
    console.log(`\n5 contacts created for JBS Foods.`);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
