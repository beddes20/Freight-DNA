import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcrypt";
import {
  organizations,
  users,
  companies,
  contacts,
  touchpoints,
  rfps,
  tasks,
  taskComments,
  goals,
  oneOnOneSessions,
  oneOnOneTopics,
  oneOnOneTopicReplies,
  feedPosts,
  feedPostReactions,
  marketShareEntries,
  ptoPassoffs,
  ptoPassoffItems,
  financialUploads,
  promotionNominations,
  callouts,
  reportCardSnapshots,
  toolLinks,
  promotionCriteria,
  appSettings,
  type User,
  type Company,
  type Contact,
} from "../shared/schema";

const DEMO_SLUG = "demo";
const DEMO_ORG_NAME = "Demo Org";
const DEFAULT_PASSWORD = "Demo1234!";
const DEMO_FILE_PREFIX = "Demo_Financials_";
const JAN_START = "2026-01-01";
const JAN_END = "2026-01-31";
const FEB_START = "2026-02-01";
const FEB_END = "2026-02-28";

function ts(d: Date): string {
  return d.toISOString();
}

function dateStr(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

interface CompanyDef {
  name: string;
  industry: string;
  assignedToKey: keyof AmMap;
  financialAlias: string;
  tenderStyle: string;
  spotProcess: string;
  accountQuirks: string;
  shippingModes: string[];
  estimatedFreightSpend: string;
  accountSummary: string;
}

interface ContactDef {
  name: string;
  title: string;
  relationship: string;
  email: string;
  phone: string;
  regions: string[];
  lanes: string[] | null;
  spend: string | null;
  spot: string | null;
  interests: string | null;
}

interface LaneDef {
  id: string;
  origin: string;
  destination: string;
  volume: number;
  rate: string;
  equipment: string;
  status: "awarded" | "open";
}

interface TaskDef {
  title: string;
  notes: string;
  status: "open" | "completed";
  dueDate: string;
  assignedToKey: keyof AmMap;
  assignedByKey: keyof NamMap;
  companyName: string;
  laneData: { origin: string; destination: string; equipment: string; volume: number } | null;
}

interface GoalDef {
  amKey: keyof AmMap;
  namKey: keyof NamMap;
  metric: string;
  period: string;
  target: string;
  current: string;
  title: string;
  customLabel: string;
  startDate: string;
  endDate: string;
}

interface SessionTopicDef {
  text: string;
  tag: string;
  status: string;
  reply?: string;
}

interface SessionDef {
  namKey: keyof NamMap;
  amKey: keyof AmMap;
  meetingDate: string;
  notes: string;
  topics: SessionTopicDef[];
  isLatest: boolean;
}

interface FeedReactionDef {
  userKey: keyof AllUserMap;
  emoji: string;
}

interface FeedPostDef {
  content: string;
  category: string;
  authorKey: keyof AllUserMap;
  createdAt: string;
  reactions: FeedReactionDef[];
}

interface MarketShareDef {
  companyName: string;
  label: string;
  start: string;
  end: string;
  total: number;
  vt: number;
  spot: number;
}

type AmMap = { am1: User; am2: User; am3: User; am4: User; am5: User; am6: User };
type NamMap = { nam1: User; nam2: User };
type AllUserMap = AmMap & NamMap & { admin: User; director: User };

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  try {
    console.log("=== DEMO ORG SEED SCRIPT ===\n");

    // ─── IDEMPOTENCY: wipe and repopulate ───────────────────────────────────
    console.log("Step 0: Checking for existing demo org…");
    const [existingOrg] = await db.select().from(organizations).where(eq(organizations.slug, DEMO_SLUG));

    let orgId: string;
    if (existingOrg) {
      orgId = existingOrg.id;
      console.log(`  Found demo org (id: ${orgId}). Wiping data…`);

      const demoUsers = await db.select({ id: users.id }).from(users).where(eq(users.organizationId, orgId));
      const userIds = demoUsers.map((u) => u.id);

      const demoCompanies = await db.select({ id: companies.id }).from(companies).where(eq(companies.organizationId, orgId));
      const companyIds = demoCompanies.map((c) => c.id);

      // Wipe in correct dependency order, unconditionally (handles fresh + post-interactive-use reruns)

      // 1. Delete task comments then tasks (tasks.assignedTo/assignedBy → users, no cascade)
      if (userIds.length > 0) {
        const demoTasks = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(inArray(tasks.assignedTo, userIds));
        const taskIds = demoTasks.map((t) => t.id);
        if (taskIds.length > 0) {
          await db.delete(taskComments).where(inArray(taskComments.taskId, taskIds));
          await db.delete(tasks).where(inArray(tasks.id, taskIds));
        }
      }

      // 2. Delete callouts authored by demo users (callouts.authorId → users, no cascade)
      if (userIds.length > 0) {
        await db.delete(callouts).where(inArray(callouts.authorId, userIds));
      }

      // 3. Delete 1:1 sessions (cascade handles topics + replies)
      if (userIds.length > 0) {
        const demoSessions = await db
          .select({ id: oneOnOneSessions.id })
          .from(oneOnOneSessions)
          .where(inArray(oneOnOneSessions.namId, userIds));
        const sessionIds = demoSessions.map((s) => s.id);
        if (sessionIds.length > 0) {
          await db.delete(oneOnOneSessions).where(inArray(oneOnOneSessions.id, sessionIds));
        }
      }

      // 4. Delete goals
      if (userIds.length > 0) {
        await db.delete(goals).where(inArray(goals.amId, userIds));
      }

      // 5. Delete feed posts and reactions
      if (userIds.length > 0) {
        const demoPosts = await db
          .select({ id: feedPosts.id })
          .from(feedPosts)
          .where(inArray(feedPosts.authorId, userIds));
        const postIds = demoPosts.map((p) => p.id);
        if (postIds.length > 0) {
          await db.delete(feedPostReactions).where(inArray(feedPostReactions.feedPostId, postIds));
          await db.delete(feedPosts).where(inArray(feedPosts.id, postIds));
        }
      }

      // 6. Delete PTO passoffs (cascade handles passoff items)
      if (userIds.length > 0) {
        await db.delete(ptoPassoffs).where(inArray(ptoPassoffs.createdById, userIds));
      }

      // 7. Delete promotion nominations
      if (userIds.length > 0) {
        await db.delete(promotionNominations).where(inArray(promotionNominations.nomineeId, userIds));
      }

      // 8. Delete financial uploads by org ownership (uploadedBy ∈ demo userIds)
      //    Handles all uploads regardless of filename — safe for interactive use reruns.
      if (userIds.length > 0) {
        await db.delete(financialUploads).where(inArray(financialUploads.uploadedBy, userIds));
      }

      // 9. Delete report card snapshots saved by demo users (savedById → users, no cascade)
      if (userIds.length > 0) {
        await db.delete(reportCardSnapshots).where(inArray(reportCardSnapshots.savedById, userIds));
      }

      // 10. Delete tool links created by demo users (createdById → users, no cascade)
      if (userIds.length > 0) {
        await db.delete(toolLinks).where(inArray(toolLinks.createdById, userIds));
      }

      // 11. Null out promotionCriteria.updatedById if set to a demo user (nullable FK, no cascade)
      if (userIds.length > 0) {
        await pool.query(
          `UPDATE promotion_criteria SET updated_by_id = NULL WHERE updated_by_id = ANY($1::text[])`,
          [userIds],
        );
      }

      // 12. Null out appSettings.updatedById if set to a demo user (nullable FK, no cascade)
      if (userIds.length > 0) {
        await pool.query(
          `UPDATE app_settings SET updated_by_id = NULL WHERE updated_by_id = ANY($1::text[])`,
          [userIds],
        );
      }

      // 13. Delete companies (cascade handles contacts, touchpoints, rfps, market share)
      if (companyIds.length > 0) {
        await db.delete(companies).where(inArray(companies.id, companyIds));
      }

      // 9. Delete users last
      if (userIds.length > 0) {
        await db.delete(users).where(inArray(users.id, userIds));
      }

      console.log("  Wiped all demo org data.\n");
    } else {
      const [org] = await db
        .insert(organizations)
        .values({ name: DEMO_ORG_NAME, slug: DEMO_SLUG })
        .returning();
      orgId = org.id;
      console.log(`  Created demo org (id: ${orgId})\n`);
    }

    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    // ─── STEP 1: USERS ───────────────────────────────────────────────────────
    console.log("Step 1: Creating users…");

    const [admin] = await db.insert(users).values({
      organizationId: orgId,
      username: "admin@freightdna-demo.com",
      password: hashedPassword,
      name: "Rachel Torres",
      role: "admin",
      managerId: null,
      financialRepId: "demo-admin",
      createdAt: "2025-06-01T00:00:00.000Z",
    }).returning();
    console.log(`  Created Admin: ${admin.name} (${admin.username})`);

    const [director] = await db.insert(users).values({
      organizationId: orgId,
      username: "director@freightdna-demo.com",
      password: hashedPassword,
      name: "Marcus Webb",
      role: "director",
      managerId: admin.id,
      financialRepId: "demo-mwebb",
      createdAt: "2025-06-15T00:00:00.000Z",
    }).returning();
    console.log(`  Created Director: ${director.name} (${director.username})`);

    const [nam1] = await db.insert(users).values({
      organizationId: orgId,
      username: "nam1@freightdna-demo.com",
      password: hashedPassword,
      name: "Sandra Chen",
      role: "national_account_manager",
      managerId: director.id,
      financialRepId: "demo-schen",
      createdAt: "2025-07-01T00:00:00.000Z",
    }).returning();
    console.log(`  Created NAM: ${nam1.name} (${nam1.username})`);

    const [nam2] = await db.insert(users).values({
      organizationId: orgId,
      username: "nam2@freightdna-demo.com",
      password: hashedPassword,
      name: "Derek Hollis",
      role: "national_account_manager",
      managerId: director.id,
      financialRepId: "demo-dhollis",
      createdAt: "2025-07-15T00:00:00.000Z",
    }).returning();
    console.log(`  Created NAM: ${nam2.name} (${nam2.username})`);

    const [am1] = await db.insert(users).values({
      organizationId: orgId,
      username: "am1@freightdna-demo.com",
      password: hashedPassword,
      name: "Tyler Benson",
      role: "account_manager",
      managerId: nam1.id,
      financialRepId: "demo-tbenson",
      createdAt: "2025-08-01T00:00:00.000Z",
    }).returning();
    console.log(`  Created AM: ${am1.name} (${am1.username})`);

    const [am2] = await db.insert(users).values({
      organizationId: orgId,
      username: "am2@freightdna-demo.com",
      password: hashedPassword,
      name: "Priya Patel",
      role: "account_manager",
      managerId: nam1.id,
      financialRepId: "demo-ppatel",
      createdAt: "2025-08-15T00:00:00.000Z",
    }).returning();
    console.log(`  Created AM: ${am2.name} (${am2.username})`);

    const [am3] = await db.insert(users).values({
      organizationId: orgId,
      username: "am3@freightdna-demo.com",
      password: hashedPassword,
      name: "Jason Kowalski",
      role: "account_manager",
      managerId: nam1.id,
      financialRepId: "demo-jkowalski",
      createdAt: "2025-09-01T00:00:00.000Z",
    }).returning();
    console.log(`  Created AM: ${am3.name} (${am3.username})`);

    const [am4] = await db.insert(users).values({
      organizationId: orgId,
      username: "am4@freightdna-demo.com",
      password: hashedPassword,
      name: "Lexi Navarro",
      role: "account_manager",
      managerId: nam2.id,
      financialRepId: "demo-lnavarro",
      createdAt: "2025-08-01T00:00:00.000Z",
    }).returning();
    console.log(`  Created AM: ${am4.name} (${am4.username})`);

    const [am5] = await db.insert(users).values({
      organizationId: orgId,
      username: "am5@freightdna-demo.com",
      password: hashedPassword,
      name: "Marcus Dunn",
      role: "account_manager",
      managerId: nam2.id,
      financialRepId: "demo-mdunn",
      createdAt: "2025-09-01T00:00:00.000Z",
    }).returning();
    console.log(`  Created AM: ${am5.name} (${am5.username})`);

    const [am6] = await db.insert(users).values({
      organizationId: orgId,
      username: "am6@freightdna-demo.com",
      password: hashedPassword,
      name: "Brianna Okafor",
      role: "account_manager",
      managerId: nam2.id,
      financialRepId: "demo-bokafor",
      createdAt: "2025-10-01T00:00:00.000Z",
    }).returning();
    console.log(`  Created AM: ${am6.name} (${am6.username})`);

    const amMap: AmMap = { am1, am2, am3, am4, am5, am6 };
    const namMap: NamMap = { nam1, nam2 };
    const allUserMap: AllUserMap = { ...amMap, ...namMap, admin, director };

    // ─── STEP 2: COMPANIES ───────────────────────────────────────────────────
    console.log("\nStep 2: Creating companies…");

    const companyDefs: CompanyDef[] = [
      {
        name: "Summit Frozen Foods",
        industry: "Food & Beverage",
        assignedToKey: "am1",
        financialAlias: "Summit Frozen Foods",
        tenderStyle: "EDI tender with 2-hour accept window; rejects go to spot board",
        spotProcess: "Posts spot loads to DAT with a 90-minute bid window; prefers flat rates",
        accountQuirks: "Very sensitive to on-time pickup — one miss triggers an escalation call with their VP",
        shippingModes: ["Reefer", "Dry Van"],
        estimatedFreightSpend: "18500000",
        accountSummary: "High-volume reefer shipper out of Chicago. Strong growth trajectory in Q1.",
      },
      {
        name: "Heartland Building Products",
        industry: "Building Materials",
        assignedToKey: "am1",
        financialAlias: "Heartland Building Products",
        tenderStyle: "Manual tender via email; no EDI, reply expected within 4 hours",
        spotProcess: "Uses Truckstop for spot; multiple carriers bid and they pick lowest cost",
        accountQuirks: "Always wants drop trailers at their Elgin facility — non-negotiable",
        shippingModes: ["Flatbed", "Dry Van"],
        estimatedFreightSpend: "9200000",
        accountSummary: "Consistent flatbed shipper with seasonal volume spikes in spring.",
      },
      {
        name: "Riverview Chemical",
        industry: "Chemical",
        assignedToKey: "am2",
        financialAlias: "Riverview Chemical",
        tenderStyle: "Dedicated carrier program for contracted lanes; spot only for overflow",
        spotProcess: "Internal spot board — carrier must be pre-approved for hazmat",
        accountQuirks: "Requires HAZMAT-certified drivers; will not use brokers who can't confirm in writing",
        shippingModes: ["Tanker", "Dry Van"],
        estimatedFreightSpend: "24000000",
        accountSummary: "Specialty chemical shipper with strict compliance requirements.",
      },
      {
        name: "Pacific Coast Produce",
        industry: "Agriculture",
        assignedToKey: "am2",
        financialAlias: "Pacific Coast Produce",
        tenderStyle: "Spot-heavy; RFP for core lanes, everything else goes to DAT daily",
        spotProcess: "Bids open at 6 AM daily; carriers have 45 minutes to respond before they move on",
        accountQuirks: "Extremely time-sensitive — produce goes from cold storage to destination, no delays tolerated",
        shippingModes: ["Reefer"],
        estimatedFreightSpend: "31000000",
        accountSummary: "Large reefer produce shipper on the West Coast with daily spot needs.",
      },
      {
        name: "Great Plains Distribution",
        industry: "Third-Party Logistics",
        assignedToKey: "am3",
        financialAlias: "Great Plains Distribution",
        tenderStyle: "Mixed: some EDI for large retail customers, rest is manual",
        spotProcess: "Uses a broker portal for spot; rate must beat their internal benchmark by 5%",
        accountQuirks: "Pays net-60; slow invoicing process — always follow up on outstanding AR",
        shippingModes: ["Dry Van", "Flatbed", "Reefer"],
        estimatedFreightSpend: "42000000",
        accountSummary: "Regional 3PL managing freight for several retail accounts.",
      },
      {
        name: "MidAmerica Steel Works",
        industry: "Manufacturing",
        assignedToKey: "am3",
        financialAlias: "MidAmerica Steel Works",
        tenderStyle: "Dedicated lanes with quarterly rate reviews; no spot except emergencies",
        spotProcess: "Only uses spot for emergency overflow — calls directly and needs same-day coverage",
        accountQuirks: "Heavy freight — most loads are 42k–44k lbs; carrier must have air-ride or specialty equipment for coils",
        shippingModes: ["Flatbed", "Step Deck"],
        estimatedFreightSpend: "15700000",
        accountSummary: "Steel manufacturer shipping heavy coil and structural steel nationwide.",
      },
      {
        name: "Bayshore Consumer Brands",
        industry: "Consumer Packaged Goods",
        assignedToKey: "am4",
        financialAlias: "Bayshore Consumer Brands",
        tenderStyle: "RFP-driven with 12-month lanes; spot for overflow during promo windows",
        spotProcess: "Quotes via email; broker has 2 hours to respond with a rate and carrier",
        accountQuirks: "Heavy on compliance — all carriers must complete their carrier onboarding packet before first load",
        shippingModes: ["Dry Van"],
        estimatedFreightSpend: "27500000",
        accountSummary: "CPG manufacturer shipping to major retailers across the Southeast.",
      },
      {
        name: "Northstar Lumber Co.",
        industry: "Forest Products",
        assignedToKey: "am5",
        financialAlias: "Northstar Lumber Co.",
        tenderStyle: "Manual email tender with a 3-hour window; sometimes calls directly for urgent loads",
        spotProcess: "Posts to DAT and Truckstop simultaneously; takes first carrier that matches their rate",
        accountQuirks: "Backhaul-friendly — loads returning from their MN facilities are easy capacity wins",
        shippingModes: ["Flatbed", "Dry Van"],
        estimatedFreightSpend: "8900000",
        accountSummary: "Regional lumber distributor with strong backhaul opportunities.",
      },
      {
        name: "Keystone Pharma Logistics",
        industry: "Pharmaceutical",
        assignedToKey: "am5",
        financialAlias: "Keystone Pharma Logistics",
        tenderStyle: "Highly controlled — all tenders go through their 3PL partner (CTSI); no direct contact",
        spotProcess: "No open spot market; all overflow routes through CTSI pre-approved carrier list",
        accountQuirks: "Temperature excursion = automatic claim; requires GPS tracking on every load",
        shippingModes: ["Reefer", "Temperature-Controlled"],
        estimatedFreightSpend: "19200000",
        accountSummary: "Pharmaceutical logistics shipper with strict temp-control requirements.",
      },
      {
        name: "Laredo Cross-Border Trading",
        industry: "Import/Export",
        assignedToKey: "am6",
        financialAlias: "Laredo Cross-Border Trading",
        tenderStyle: "Spot-first for cross-border; dedicated for domestic legs",
        spotProcess: "Cross-border bids posted on their internal system at 7 AM; 1-hour response window",
        accountQuirks: "Mexico-domiciled loads need a drayage partner at the border; they'll ask us to coordinate",
        shippingModes: ["Dry Van", "Reefer"],
        estimatedFreightSpend: "22300000",
        accountSummary: "Cross-border freight shipper specializing in US-Mexico trade lanes.",
      },
    ];

    const companyByName = new Map<string, Company>();
    for (const def of companyDefs) {
      const [co] = await db.insert(companies).values({
        organizationId: orgId,
        name: def.name,
        industry: def.industry,
        assignedTo: amMap[def.assignedToKey].id,
        financialAlias: def.financialAlias,
        tenderStyle: def.tenderStyle,
        spotProcess: def.spotProcess,
        accountQuirks: def.accountQuirks,
        shippingModes: def.shippingModes,
        estimatedFreightSpend: def.estimatedFreightSpend,
        accountSummary: def.accountSummary,
        notes: null,
        archivedAt: null,
      }).returning();
      companyByName.set(def.name, co);
      console.log(`  Created company: ${co.name}`);
    }

    // ─── STEP 3: CONTACTS ────────────────────────────────────────────────────
    console.log("\nStep 3: Creating contacts…");

    const contactDefsByCompany: Record<string, ContactDef[]> = {
      "Summit Frozen Foods": [
        { name: "Gloria Marchetti", title: "VP of Supply Chain", relationship: "2nd", email: "g.marchetti@summitfrozen.com", phone: "312-555-0101", regions: ["National"], lanes: null, spend: "18500000", spot: "Approves spot bids over $3k — call her directly", interests: "Carrier reliability scores, winter capacity planning" },
        { name: "Rick Davenport", title: "Director of Transportation", relationship: "1st", email: "r.davenport@summitfrozen.com", phone: "312-555-0202", regions: ["Midwest", "Southeast"], lanes: ["Chicago, IL", "Memphis, TN", "Atlanta, GA"], spend: "9000000", spot: "Posts spot to DAT after 30 min of no EDI response", interests: "Drop trailer programs, backhaul opportunities" },
        { name: "Tanya Reyes", title: "Transportation Planner", relationship: "1st", email: "t.reyes@summitfrozen.com", phone: "312-555-0303", regions: ["Midwest"], lanes: ["Chicago, IL", "Minneapolis, MN"], spend: "4200000", spot: null, interests: "Consistent reefer coverage on Monday mornings" },
        { name: "Owen Hughes", title: "Logistics Coordinator", relationship: "3rd", email: "o.hughes@summitfrozen.com", phone: "312-555-0404", regions: ["Southeast"], lanes: ["Nashville, TN", "Birmingham, AL"], spend: "2100000", spot: null, interests: null },
      ],
      "Heartland Building Products": [
        { name: "Bill Stratton", title: "VP of Logistics", relationship: "2nd", email: "b.stratton@heartlandbp.com", phone: "847-555-0110", regions: ["National"], lanes: null, spend: "9200000", spot: "Reviews spot bids weekly with his team", interests: "Fleet optimization, flatbed availability in spring" },
        { name: "Carmen Delgado", title: "Logistics Manager", relationship: "1st", email: "c.delgado@heartlandbp.com", phone: "847-555-0211", regions: ["Midwest", "South"], lanes: ["Elgin, IL", "Dallas, TX", "Nashville, TN"], spend: "5500000", spot: "Posts to Truckstop at 8 AM; needs rate by 10 AM", interests: "Drop trailer, step-deck capacity" },
        { name: "Aaron Finch", title: "Transportation Coordinator", relationship: "2nd", email: "a.finch@heartlandbp.com", phone: "847-555-0312", regions: ["Midwest"], lanes: ["Indianapolis, IN", "Columbus, OH"], spend: "2100000", spot: null, interests: null },
      ],
      "Riverview Chemical": [
        { name: "Dr. Janet Liu", title: "VP of Logistics & Compliance", relationship: "3rd", email: "j.liu@riverviewchem.com", phone: "630-555-0120", regions: ["National"], lanes: null, spend: "24000000", spot: "All spot goes through compliance review first — 24hr lead time minimum", interests: "Carrier safety ratings, HAZMAT compliance" },
        { name: "Steve Paulson", title: "Director of Transportation", relationship: "2nd", email: "s.paulson@riverviewchem.com", phone: "630-555-0221", regions: ["Midwest", "Gulf Coast"], lanes: ["Chicago, IL", "Houston, TX", "New Orleans, LA"], spend: "12000000", spot: "Calls directly for urgent overflow; needs HAZMAT cert on file", interests: "Dedicated lane coverage, tanker capacity" },
        { name: "Monica Vasquez", title: "Transportation Planner", relationship: "1st", email: "m.vasquez@riverviewchem.com", phone: "630-555-0322", regions: ["Gulf Coast"], lanes: ["Houston, TX", "Beaumont, TX"], spend: "6000000", spot: null, interests: "Reefer for specialty chemical loads" },
        { name: "Earl Thompson", title: "Logistics Coordinator", relationship: "1st", email: "e.thompson@riverviewchem.com", phone: "630-555-0423", regions: ["Midwest"], lanes: ["Chicago, IL"], spend: "3200000", spot: null, interests: null },
        { name: "Nadia Goldstein", title: "Compliance Specialist", relationship: "3rd", email: "n.goldstein@riverviewchem.com", phone: "630-555-0524", regions: ["National"], lanes: null, spend: null, spot: null, interests: "DOT compliance, carrier certification" },
      ],
      "Pacific Coast Produce": [
        { name: "Carlos Mendez", title: "VP of Transportation", relationship: "2nd", email: "c.mendez@pcproduce.com", phone: "559-555-0130", regions: ["West Coast", "National"], lanes: null, spend: "31000000", spot: "Approves new spot carriers; calls directly for large lane wins", interests: "Pre-cooling programs, carrier reliability" },
        { name: "Lisa Yamamoto", title: "Director of Logistics", relationship: "1st", email: "l.yamamoto@pcproduce.com", phone: "559-555-0231", regions: ["West Coast", "Southwest"], lanes: ["Fresno, CA", "Los Angeles, CA", "Phoenix, AZ"], spend: "15000000", spot: "DAT bids open 6 AM PST; 45 min response window", interests: "Reefer capacity during summer peak" },
        { name: "Jake Ramos", title: "Transportation Coordinator", relationship: "1st", email: "j.ramos@pcproduce.com", phone: "559-555-0332", regions: ["Southwest"], lanes: ["Phoenix, AZ", "Las Vegas, NV"], spend: "7500000", spot: null, interests: "Backhaul opportunities from Phoenix" },
        { name: "Sandra Kim", title: "Logistics Planner", relationship: "2nd", email: "s.kim@pcproduce.com", phone: "559-555-0433", regions: ["Pacific Northwest"], lanes: ["Seattle, WA", "Portland, OR"], spend: "5200000", spot: null, interests: null },
      ],
      "Great Plains Distribution": [
        { name: "Howard Blaine", title: "President of Operations", relationship: "3rd", email: "h.blaine@greatplainsdist.com", phone: "402-555-0140", regions: ["National"], lanes: null, spend: "42000000", spot: "Only involved in strategic decisions — don't call for spot", interests: "Tech integration, TMS efficiency" },
        { name: "Rachel Kim", title: "VP of Carrier Relations", relationship: "1st", email: "r.kim@greatplainsdist.com", phone: "402-555-0241", regions: ["Midwest", "Southeast"], lanes: ["Omaha, NE", "Kansas City, MO", "Memphis, TN"], spend: "20000000", spot: "Posts on broker portal; rate must beat benchmark by 5%", interests: "Carrier performance scorecards, QBRs" },
        { name: "Trevor Hanks", title: "Logistics Manager - Retail", relationship: "2nd", email: "t.hanks@greatplainsdist.com", phone: "402-555-0342", regions: ["Midwest"], lanes: ["Chicago, IL", "Des Moines, IA"], spend: "10000000", spot: null, interests: "Drop trailer availability" },
        { name: "Cassandra Wright", title: "Logistics Manager - CPG", relationship: "2nd", email: "c.wright@greatplainsdist.com", phone: "402-555-0443", regions: ["Southwest", "West"], lanes: ["Dallas, TX", "Denver, CO"], spend: "8000000", spot: null, interests: "Flatbed capacity for oversized CPG pallets" },
        { name: "Owen Bradley", title: "Transportation Coordinator", relationship: "1st", email: "o.bradley@greatplainsdist.com", phone: "402-555-0544", regions: ["Central"], lanes: ["Wichita, KS", "Sioux Falls, SD"], spend: "3000000", spot: null, interests: null },
      ],
      "MidAmerica Steel Works": [
        { name: "Frank Russo", title: "VP of Supply Chain", relationship: "2nd", email: "f.russo@midamericasteel.com", phone: "314-555-0150", regions: ["National"], lanes: null, spend: "15700000", spot: "Emergency-only spot; needs call from AM directly", interests: "Heavy haul specialists, flatbed reliability" },
        { name: "Dana Pierce", title: "Director of Transportation", relationship: "1st", email: "d.pierce@midamericasteel.com", phone: "314-555-0251", regions: ["Midwest", "Northeast"], lanes: ["St. Louis, MO", "Pittsburgh, PA", "Cleveland, OH"], spend: "8000000", spot: "Calls Jason directly for emergency coil moves", interests: "Step deck availability, air-ride flatbed" },
        { name: "Mike Gallagher", title: "Transportation Coordinator", relationship: "1st", email: "m.gallagher@midamericasteel.com", phone: "314-555-0352", regions: ["Midwest"], lanes: ["Kansas City, MO", "Indianapolis, IN"], spend: "4500000", spot: null, interests: "Consistent carriers who know steel" },
        { name: "Patricia Shields", title: "Logistics Planner", relationship: "3rd", email: "p.shields@midamericasteel.com", phone: "314-555-0453", regions: ["Southeast"], lanes: ["Nashville, TN", "Birmingham, AL"], spend: "2100000", spot: null, interests: null },
      ],
      "Bayshore Consumer Brands": [
        { name: "Angela Moss", title: "VP of Supply Chain", relationship: "2nd", email: "a.moss@bayshorebrand.com", phone: "813-555-0160", regions: ["National"], lanes: null, spend: "27500000", spot: "Escalation contact only — don't call for routine loads", interests: "On-time delivery KPIs, carrier compliance" },
        { name: "Tom Greenberg", title: "Director of Logistics", relationship: "1st", email: "t.greenberg@bayshorebrand.com", phone: "813-555-0261", regions: ["Southeast", "Northeast"], lanes: ["Tampa, FL", "Charlotte, NC", "Philadelphia, PA"], spend: "14000000", spot: "Quotes via email; needs rate+carrier within 2 hours", interests: "Drop trailer programs at DCs" },
        { name: "Shana Baptiste", title: "Logistics Manager", relationship: "1st", email: "s.baptiste@bayshorebrand.com", phone: "813-555-0362", regions: ["Southeast"], lanes: ["Miami, FL", "Atlanta, GA"], spend: "7000000", spot: null, interests: "Reefer capacity for seasonal SKUs" },
        { name: "Dillon Carter", title: "Transportation Planner", relationship: "2nd", email: "d.carter@bayshorebrand.com", phone: "813-555-0463", regions: ["Northeast"], lanes: ["New York, NY", "Boston, MA"], spend: "4000000", spot: null, interests: null },
      ],
      "Northstar Lumber Co.": [
        { name: "Glen Larson", title: "VP of Logistics", relationship: "2nd", email: "g.larson@northstarlumber.com", phone: "612-555-0170", regions: ["National"], lanes: null, spend: "8900000", spot: "Reviews weekly DAT activity; open to strategic conversations", interests: "Backhaul optimization, lumber market trends" },
        { name: "Wendy Olson", title: "Transportation Manager", relationship: "1st", email: "w.olson@northstarlumber.com", phone: "612-555-0271", regions: ["Midwest", "West"], lanes: ["Minneapolis, MN", "Boise, ID", "Seattle, WA"], spend: "5000000", spot: "DAT and Truckstop simultaneously; takes first compliant rate", interests: "Drop trailer for mill facilities" },
        { name: "Brad Jensen", title: "Logistics Coordinator", relationship: "1st", email: "b.jensen@northstarlumber.com", phone: "612-555-0372", regions: ["Midwest"], lanes: ["Milwaukee, WI", "Grand Rapids, MI"], spend: "2000000", spot: null, interests: null },
      ],
      "Keystone Pharma Logistics": [
        { name: "Dr. Patricia Walsh", title: "VP of Cold Chain Logistics", relationship: "3rd", email: "p.walsh@keystonepharma.com", phone: "215-555-0180", regions: ["National"], lanes: null, spend: "19200000", spot: "No spot market access — all through CTSI", interests: "GDP compliance, cold chain audit results" },
        { name: "Nathan Graves", title: "Logistics Director - CTSI Liaison", relationship: "2nd", email: "n.graves@keystonepharma.com", phone: "215-555-0281", regions: ["Northeast", "Midwest"], lanes: ["Philadelphia, PA", "Chicago, IL"], spend: "9500000", spot: "Routes all spot through CTSI pre-approved list", interests: "GPS tracking integration, temp excursion prevention" },
        { name: "Allison Park", title: "Transportation Coordinator", relationship: "1st", email: "a.park@keystonepharma.com", phone: "215-555-0382", regions: ["Southeast"], lanes: ["Charlotte, NC", "Atlanta, GA"], spend: "5500000", spot: null, interests: "Temperature monitoring technology" },
        { name: "Greg Tanner", title: "Cold Chain Planner", relationship: "1st", email: "g.tanner@keystonepharma.com", phone: "215-555-0483", regions: ["West"], lanes: ["Los Angeles, CA", "San Francisco, CA"], spend: "3000000", spot: null, interests: null },
      ],
      "Laredo Cross-Border Trading": [
        { name: "Sofia Gutierrez", title: "VP of International Logistics", relationship: "2nd", email: "s.gutierrez@laredotrade.com", phone: "956-555-0190", regions: ["US-Mexico Border", "National"], lanes: null, spend: "22300000", spot: "Strategic sign-off on new cross-border carrier relationships", interests: "Customs brokerage integration, cross-border capacity" },
        { name: "Hector Reyna", title: "Director of Border Operations", relationship: "1st", email: "h.reyna@laredotrade.com", phone: "956-555-0291", regions: ["Texas", "Mexico"], lanes: ["Laredo, TX", "El Paso, TX", "San Antonio, TX"], spend: "12000000", spot: "Internal system bids at 7 AM; 1-hour response for cross-border", interests: "Drayage partners, border crossing efficiency" },
        { name: "Ana Flores", title: "Logistics Manager - Domestic", relationship: "1st", email: "a.flores@laredotrade.com", phone: "956-555-0392", regions: ["Texas", "Southeast"], lanes: ["Houston, TX", "Dallas, TX"], spend: "6000000", spot: null, interests: "Spot reefer capacity for fresh food from Mexico" },
        { name: "Marco Salinas", title: "Transportation Coordinator", relationship: "2nd", email: "m.salinas@laredotrade.com", phone: "956-555-0493", regions: ["Border Region"], lanes: ["Laredo, TX"], spend: "3000000", spot: null, interests: null },
        { name: "Carla Medina", title: "Customs & Logistics Coordinator", relationship: "3rd", email: "c.medina@laredotrade.com", phone: "956-555-0594", regions: ["National"], lanes: null, spend: null, spot: null, interests: "Import documentation, customs clearance timing" },
      ],
    };

    const contactsByCompanyId = new Map<string, Contact[]>();

    for (const def of companyDefs) {
      const co = companyByName.get(def.name)!;
      const defs = contactDefsByCompany[def.name] ?? [];
      const amUserId = amMap[def.assignedToKey].id;

      const created: Contact[] = [];
      let vpId: string | null = null;
      let dirId: string | null = null;

      for (let i = 0; i < defs.length; i++) {
        const cd = defs[i];
        let reportsToId: string | null = null;
        if (i === 1 && vpId) reportsToId = vpId;
        else if (i >= 2 && dirId) reportsToId = dirId;
        else if (i >= 2 && vpId) reportsToId = vpId;

        // Spread contact creation dates: last 1-2 per company are recent (March 2026)
        const contactCreatedAt =
          i === defs.length - 1 ? dateStr(2026, 3, randomBetween(21, 24)) :
          i === defs.length - 2 ? dateStr(2026, 3, randomBetween(10, 18)) :
          dateStr(2025, randomBetween(10, 11), randomBetween(1, 28));

        // ~50% of contacts had their relationship base advanced in March 2026
        const baseAdvancedAt = i % 2 === 0 ? dateStr(2026, 3, randomBetween(1, 23)) : null;

        const [contact] = await db.insert(contacts).values({
          companyId: co.id,
          name: cd.name,
          title: cd.title,
          relationshipBase: cd.relationship,
          email: cd.email,
          phone: cd.phone,
          reportsToId,
          lanes: cd.lanes,
          regions: cd.regions,
          freightSpend: cd.spend,
          spotBiddingProcess: cd.spot,
          interests: cd.interests,
          notes: null,
          createdAt: contactCreatedAt,
          createdBy: amUserId,
          baseAdvancedAt,
        }).returning();

        if (i === 0) vpId = contact.id;
        if (i === 1) dirId = contact.id;
        created.push(contact);
        console.log(`  [${def.name}] Created contact: ${contact.name} (${contact.title})`);
      }

      contactsByCompanyId.set(co.id, created);
    }

    // ─── STEP 4: TOUCHPOINTS ─────────────────────────────────────────────────
    console.log("\nStep 4: Creating touchpoints…");

    const touchpointNotesByCompany: Record<string, string[]> = {
      "Summit Frozen Foods": [
        "Called Rick re: dry van overflow on Chicago–Memphis — he's open to adding volume next week",
        "Emailed Tanya about Monday morning reefer coverage for Q1 push — waiting on her load board access",
        "Caught up with Rick on their reefer lanes — wide open on Mondays, told him we can cover consistent",
        "Site visit at Summit's Chicago DC — toured the facility with Rick; they're adding 3 dock doors in March",
        "Checked in with Gloria on carrier scorecards — she wants a QBR in Q2, put it on the calendar",
        "Rick reached out about a 53' reefer spot load Chicago→Atlanta for Friday — confirmed coverage at $2.25/mi",
        "Tanya shared their spring produce schedule — reefer needs spike April through June",
        "Email follow-up with Owen on Birmingham loads — he's scheduling out 2 weeks now, asked to pre-book",
        "Called Gloria ahead of Q2 planning — she's excited about our service consistency numbers",
        "Text with Rick confirming 4 loads out of Chicago Monday — he appreciated the quick confirm",
        "Emailed Tanya reefer options for next week including weekend loads — she responded same hour",
        "Rick called with 2 emergency loads Friday night — we covered both, earned serious goodwill",
        "Quarterly check-in with Gloria — she mentioned we're their #2 broker by volume now",
        "Caught Tanya at her desk, walked through March load plan together — she locked in 18 loads with us",
        "Owen mentioned Birmingham DC is expanding — flagged for future opportunity",
        "Rick connected me with their new Nashville DC manager — big opportunity developing",
      ],
      "Heartland Building Products": [
        "Spoke with Carmen about drop trailer program at Elgin — she wants at least 3 trailers staged by Feb 15",
        "Emailed Aaron flatbed rates for Columbus→Nashville — he'll run it by Carmen",
        "Called Carmen on open flatbed spot loads — 4 loads from Elgin this week, covered all of them",
        "Bill wants a quarterly review — scheduled for March 10 at their office in Elgin",
        "Covered 2 emergency flatbed loads when their primary carrier no-showed on a Monday morning",
        "Aaron confirmed they're adding a Nashville distribution point starting March 1 — big volume opportunity",
        "Texted Carmen about weekend flatbed availability — she confirmed 3 loads on Saturday",
        "Called Bill ahead of QBR to prep the agenda — he wants to see carrier performance by lane",
        "Aaron mentioned their Columbus volume is up 20% this spring — big opportunity to grow",
        "Emailed Carmen the drop trailer staging plan — she approved it immediately",
        "Bill's QBR went great — he's signing a 6-month flatbed commitment starting April",
        "Aaron asked about step deck options for oversized pallets — quoted and booked same day",
        "Called Carmen to confirm March staging is on track — she said we're the only broker she trusts",
      ],
      "Riverview Chemical": [
        "Emailed Steve on HAZMAT overflow capacity — he forwarded our cert to their compliance team",
        "Monica confirmed we're approved for their Gulf Coast tanker lanes — two loads per week starting Feb",
        "Called Steve about a Houston spot load — needed same-day coverage for a product transfer",
        "Earl shared their load board access credentials for Midwest lanes — set up in our TMS",
        "Nadia requested updated insurance certs — sent same day",
        "Site visit to Riverview's Elgin facility with Steve — walked the loading dock, met the dock manager",
        "Steve confirmed our QBR is April 15 — he wants a carrier performance deep-dive",
        "Monica called about 3 urgent tanker loads — covered all of them within 4 hours",
        "Earl texted about Midwest lane changes — updated our routing matrix",
        "Checked in with Nadia on compliance calendar — we're audit-ready on all carriers",
        "Steve mentioned they're expanding to a new Gulf Coast terminal — could add 8 loads/week",
        "Called Janet Liu's office to introduce our dedicated chemical program — assistant said she'd pass it on",
        "Monica shared that they're renewing our contract — we're their #1 HAZMAT carrier relationship",
      ],
      "Pacific Coast Produce": [
        "Called Lisa on daily reefer availability — she's been burned by no-shows, emphasized our 98% tender acceptance",
        "Covered 6 reefer loads out of Fresno last week — Carlos sent a note saying 'good week'",
        "Jake asked about backhaul opportunities from Phoenix — connected him with our Phoenix ops team",
        "Lisa invited us to a produce logistics summit in February — confirming attendance",
        "Emailed Carlos a competitive rate analysis on their LA→Phoenix core lane",
        "Covered a weekend emergency move from Fresno to Las Vegas — temperature-controlled, no excursion",
        "Caught up with Sandra on their Pacific Northwest volume — she's adding Portland to the program in March",
        "Jake texted confirming 5 spot loads out of Fresno Monday — we've got them covered",
        "Called Lisa after the produce summit — she wants to expand our coverage to Portland",
        "Carlos reached out praising our weekend team — best service he's had all year",
        "Sandra confirmed the Portland lane is live — 8 loads per week starting mid-March",
        "Called Lisa on Q2 capacity planning — she's locking in 60% of volume with us through June",
        "Jake confirmed backhaul program from Phoenix is delivering — saving them $1.10/mi",
        "Carlos invited us to their annual carrier awards dinner — we're up for 'Most Reliable'",
      ],
      "Great Plains Distribution": [
        "Called Rachel to introduce our new carrier performance dashboard — she wants a demo",
        "Covered 8 loads for Great Plains this week; beat their benchmark rate on 6 of them",
        "Trevor asked about drop trailer availability in Chicago — we have 4 positioned there now",
        "Cassandra needs flatbed for oversize pallets to Denver — specialty move, quoted $3.10/mi",
        "Rachel wants a QBR for Q2 — booked for April 8",
        "Owen confirmed 12 Wichita–Sioux Falls loads for February — steady dry van volume",
        "Followed up on AR issue — invoice 10842 is 45 days out; Trevor said finance is backed up",
        "Howard's team is evaluating TMS integrations — positioned our API capabilities",
        "Rachel loved the carrier dashboard demo — asked us to present to her leadership team",
        "AR issue resolved — Trevor confirmed payment processed, relationship back on solid ground",
        "Cassandra called about flatbed expansion for the Denver route — wants to add 3 more lanes",
        "Owen flagged that Wichita volume is growing — confirmed capacity through April",
        "Howard connected us with their IT director to discuss TMS integration — big strategic win",
        "Called Rachel after the leadership presentation — they're voting on preferred carrier status",
      ],
      "MidAmerica Steel Works": [
        "Dana called for emergency coil move from St. Louis to Pittsburgh — covered same afternoon",
        "Mike confirmed 6 flatbed loads for this week; 4 are step deck for oversized coil",
        "Called Frank to discuss quarterly flatbed availability — he's open to adding 5 dedicated lanes",
        "Patricia asked about Nashville capacity — we have consistent carriers running that lane",
        "Covered 3 emergency loads when their primary flatbed carrier had equipment issues",
        "Dana appreciated the same-day coverage last week — said she'll 'remember that'",
        "Mike texted about a last-minute coil move — covered within 90 minutes",
        "Frank agreed to pilot the 5-lane dedicated program — signing the agreement next week",
        "Dana reached out about adding a Cleveland lane — confirmed capacity immediately",
        "Called Patricia to follow up on Nashville route expansion — she's ready to move forward",
        "Frank signed the dedicated lane agreement — 5 lanes locked in through Q3",
        "Mike confirmed the Pittsburgh carrier is doing great — zero claims this quarter",
      ],
      "Bayshore Consumer Brands": [
        "Called Tom on drop trailer availability at their Tampa DC — confirmed 2 staged for Feb",
        "Shana asked about reefer capacity for seasonal SKUs — confirmed coverage through Q2",
        "Emailed Tom rates for Charlotte→Philadelphia — he accepted within 1 hour",
        "Dillon confirmed they're adding a New York DC in Q2 — big dry van volume coming",
        "Angela's team completed our carrier onboarding — fully compliant now",
        "Tom wants bi-weekly check-ins — set up recurring Friday calls",
        "Shana confirmed spring promo loads starting April — 15+ reefer loads per week",
        "Tom called after our Friday check-in — he's our biggest advocate inside the company",
        "Angela asked for a case study on our compliance process — sent it and she shared with her team",
        "Dillon confirmed NY DC plans — we're first call for all volume out of that location",
        "Called Tom about the Charlotte lane rate adjustment — he appreciated the transparency",
        "Shana texted confirming Q2 reefer coverage — she said we're the easiest broker they use",
      ],
      "Northstar Lumber Co.": [
        "Called Wendy on flatbed availability for Seattle runs — she's been using us 3 loads per week",
        "Glen mentioned they're interested in a backhaul program from their MN mills — great opportunity",
        "Covered 5 loads from Minneapolis to Boise this week — Wendy happy with the coverage",
        "Brad confirmed 4 Milwaukee–Grand Rapids loads for February",
        "Wendy shared that their primary carrier raised rates 8% — positioned us as a better value",
        "Glen wants to discuss a dedicated lane program for their top 5 routes — set meeting for Feb 20",
        "Dedicated lane meeting with Glen was productive — he wants a proposal by March 1",
        "Sent Glen the dedicated lane proposal — 5 lanes, 90-day trial, fixed rates",
        "Brad texted that Milwaukee volume is picking up — added 2 more loads this week",
        "Glen called back excited about the proposal — he's taking it to his CFO",
        "Wendy mentioned Boise runs are their most consistent lane — we're covering 100% of them now",
        "Glen's CFO approved the dedicated lane trial — contract starts April 1",
      ],
      "Keystone Pharma Logistics": [
        "Called Nathan to confirm our GPS tracking is CTSI-compliant — verified and documented",
        "Allison confirmed 2 reefer loads Charlotte→Atlanta for this week — temp excursion zero",
        "Emailed Greg on LA–SF cold chain loads — he needs 3 dedicated reefer carriers on pre-approval list",
        "Nathan impressed with our temp monitoring reports — said he's recommending us for 2 more lanes",
        "Patricia reviewed our Q1 performance data — 100% on-time, zero excursions",
        "CTSI portal updated with our carrier additions — all cleared for Keystone lanes",
        "Greg confirmed West Coast volume doubles in Q2 — need to plan capacity now",
        "Called Nathan with Q2 capacity plan — he said we're exactly what they need",
        "Allison confirmed we've now handled 50 loads with zero excursions — company record",
        "Patricia asked for a meeting with our cold chain director — setting that up",
        "Greg's team added us to 3 more West Coast lanes — validation of our reliability",
        "Nathan confirmed annual contract renewal — they're expanding our scope by 40%",
      ],
      "Laredo Cross-Border Trading": [
        "Called Hector about drayage partner options at the Laredo border crossing — shared 3 options",
        "Ana confirmed 4 dry van loads Houston→Dallas for this week",
        "Sofia wants a call about strategic capacity planning for cross-border in Q2",
        "Marco confirmed drayage timing for 2 crossings this week — both cleared customs without issues",
        "Hector liked our same-day border coverage — said they'll add 3 more lanes in March",
        "Carla asked for documentation on our Mexico cross-border SOP — sent the deck",
        "Ana called about spot reefer from Monterrey to San Antonio — covered within 2 hours",
        "Hector wants a sit-down with Sofia and Brianna to talk about Q2 capacity strategy",
        "Strategic Q2 call with Sofia and Hector — they want us as primary cross-border partner",
        "Ana confirmed 3 new lanes added for March — Houston, Dallas, San Antonio",
        "Marco praised our customs timing — fastest clearance they've had in 6 months",
        "Hector texted that Sofia approved us as preferred cross-border partner — huge win",
        "Called Sofia to confirm Q2 lane structure — she's ready to sign a formal agreement",
        "Carla asked for updated compliance docs — sent same day, she confirmed receipt",
      ],
    };

    // "Current week" meaningful touchpoints (March 23-28, 2026) with substantive notes
    const currentWeekTouchpoints: Array<{
      companyName: string;
      amKey: keyof AmMap;
      contactIdx: number;
      type: string;
      date: string;
      notes: string;
      meaningful: boolean;
    }> = [
      { companyName: "Summit Frozen Foods", amKey: "am1", contactIdx: 1, type: "call", date: "2026-03-24", notes: "Spoke with Rick about locking in Q2 reefer volume — he confirmed 45 loads per month, real freight need. This is a $180K incremental margin opportunity if we execute.", meaningful: true },
      { companyName: "Summit Frozen Foods", amKey: "am1", contactIdx: 0, type: "email", date: "2026-03-23", notes: "Sent Gloria our Q1 performance report — 99.2% tender acceptance, zero temp excursions. She replied saying we're their top-ranked broker.", meaningful: false },
      { companyName: "Heartland Building Products", amKey: "am1", contactIdx: 1, type: "call", date: "2026-03-24", notes: "Called Carmen post-QBR to recap commitments — she's signing the 6-month flatbed agreement. Confirmed rates and start date of April 7.", meaningful: true },
      { companyName: "Riverview Chemical", amKey: "am2", contactIdx: 1, type: "call", date: "2026-03-24", notes: "Steve called with news — they're expanding to Port Arthur, TX with 6 loads/week. We're first on the list if we can confirm HAZMAT capability. This is a $90K/month opportunity.", meaningful: true },
      { companyName: "Riverview Chemical", amKey: "am2", contactIdx: 2, type: "email", date: "2026-03-23", notes: "Emailed Monica with updated Gulf Coast capacity plan for Q2 — she confirmed it looks strong.", meaningful: false },
      { companyName: "Pacific Coast Produce", amKey: "am2", contactIdx: 1, type: "call", date: "2026-03-25", notes: "Called Lisa on April produce season — she wants 80 reefer loads committed before April 1. Discussed rates, service levels, and the Portland expansion. Real strategic conversation.", meaningful: true },
      { companyName: "Pacific Coast Produce", amKey: "am2", contactIdx: 2, type: "text", date: "2026-03-23", notes: "Jake texted confirming 8 Monday loads — covered all, zero issues.", meaningful: false },
      { companyName: "Great Plains Distribution", amKey: "am3", contactIdx: 1, type: "call", date: "2026-03-24", notes: "Rachel called after her leadership team meeting — we've been approved for preferred carrier status. This opens up an additional $300K in annual volume for us to compete for.", meaningful: true },
      { companyName: "Great Plains Distribution", amKey: "am3", contactIdx: 2, type: "email", date: "2026-03-23", notes: "Trevor confirmed the AR balance is cleared — relationship back on good terms.", meaningful: false },
      { companyName: "MidAmerica Steel Works", amKey: "am3", contactIdx: 1, type: "call", date: "2026-03-25", notes: "Dana called to discuss adding 2 more dedicated lanes — St. Louis to Cleveland and Pittsburgh to Indianapolis. She says Frank is fully behind it. Real opportunity.", meaningful: true },
      { companyName: "Bayshore Consumer Brands", amKey: "am4", contactIdx: 1, type: "call", date: "2026-03-24", notes: "Tom confirmed they're expanding to the New York DC a month early — June 1 instead of July. This brings forward ~20 dry van loads/week. Locked in our capacity commitment.", meaningful: true },
      { companyName: "Bayshore Consumer Brands", amKey: "am4", contactIdx: 2, type: "email", date: "2026-03-23", notes: "Shana emailed confirming spring promo reefer loads — 18/week confirmed for April through May.", meaningful: false },
      { companyName: "Northstar Lumber Co.", amKey: "am5", contactIdx: 0, type: "call", date: "2026-03-24", notes: "Glen called to say the CFO signed off on the dedicated lane agreement — 5 lanes, April 1 start, fixed rates. Biggest new commitment we've had this year.", meaningful: true },
      { companyName: "Keystone Pharma Logistics", amKey: "am5", contactIdx: 1, type: "call", date: "2026-03-25", notes: "Nathan called with great news — Keystone is renewing our contract and expanding scope by 40%. They're adding 4 more lanes including two high-value West Coast routes.", meaningful: true },
      { companyName: "Laredo Cross-Border Trading", amKey: "am6", contactIdx: 0, type: "call", date: "2026-03-24", notes: "Sofia confirmed preferred cross-border partner agreement — formalizing in writing next week. This locks in $2.2M in annual freight volume with us as primary.", meaningful: true },
      { companyName: "Laredo Cross-Border Trading", amKey: "am6", contactIdx: 2, type: "email", date: "2026-03-23", notes: "Ana confirmed 6 Houston→Dallas loads for this week — all covered same day.", meaningful: false },
    ];

    const touchpointTypes = ["call", "email", "visit", "call", "email", "call"];

    for (const def of companyDefs) {
      const co = companyByName.get(def.name)!;
      const notes = touchpointNotesByCompany[def.name] ?? [];
      const assignedUserId = amMap[def.assignedToKey].id;
      const compContacts = contactsByCompanyId.get(co.id) ?? [];

      // Distribute dates across Dec 2025, Jan 2026, Feb 2026, early March 2026
      const decCount = Math.floor(notes.length * 0.15);
      const janCount = Math.floor(notes.length * 0.35);
      const febCount = Math.floor(notes.length * 0.30);
      const marchCount = notes.length - decCount - janCount - febCount;
      const tpDates: string[] = [];
      for (let i = 0; i < decCount; i++) tpDates.push(dateStr(2025, 12, randomBetween(3, 28)));
      for (let i = 0; i < janCount; i++) tpDates.push(dateStr(2026, 1, randomBetween(3, 28)));
      for (let i = 0; i < febCount; i++) tpDates.push(dateStr(2026, 2, randomBetween(3, 24)));
      for (let i = 0; i < marchCount; i++) tpDates.push(dateStr(2026, 3, randomBetween(3, 20)));
      tpDates.sort();

      for (let i = 0; i < notes.length; i++) {
        const contactId = compContacts.length > 0
          ? compContacts[i % compContacts.length].id
          : null;
        await db.insert(touchpoints).values({
          companyId: co.id,
          contactId,
          type: pick(touchpointTypes),
          date: tpDates[i],
          notes: notes[i],
          sentiment: pick(["positive", "positive", "neutral", "positive"]),
          isMeaningful: i % 4 === 0,
          loggedById: assignedUserId,
          createdAt: ts(new Date(tpDates[i])),
        });
      }
      console.log(`  [${def.name}] Created ${notes.length} historical touchpoints`);
    }

    // Insert current-week meaningful touchpoints
    let weeklyTouchCount = 0;
    for (const wt of currentWeekTouchpoints) {
      const co = companyByName.get(wt.companyName);
      if (!co) continue;
      const assignedUserId = amMap[wt.amKey].id;
      const compContacts = contactsByCompanyId.get(co.id) ?? [];
      const contactId = compContacts.length > wt.contactIdx ? compContacts[wt.contactIdx].id : (compContacts[0]?.id ?? null);
      await db.insert(touchpoints).values({
        companyId: co.id,
        contactId,
        type: wt.type,
        date: wt.date,
        notes: wt.notes,
        sentiment: "positive",
        isMeaningful: wt.meaningful,
        loggedById: assignedUserId,
        createdAt: ts(new Date(wt.date + "T14:00:00.000Z")),
      });
      weeklyTouchCount++;
    }
    console.log(`  Created ${weeklyTouchCount} current-week touchpoints (including meaningful conversations)`);

    // ─── STEP 5: FINANCIAL DATA ───────────────────────────────────────────────
    console.log("\nStep 5: Creating financial uploads…");

    // Transaction-level row spec for one load
    interface TxRow {
      "Customer": string;
      "Operations user": string;
      "Order type": string;
      "Status": string;
      "Shipper city": string;
      "Shipper state": string;
      "Consignee city": string;
      "Consignee state": string;
      "Date ordered": string;
      "Order number": string;
      "Total revenue": number;
      "Margin $": number;
    }

    // Company-level load templates: [customerName, opsUser, origCity, origState, destCity, destState, spotFraction, baseMarginPerLoad, baseRevenuePerLoad]
    interface CompanyLoadTemplate {
      customer: string;
      opsUser: string;
      lanes: Array<{ origCity: string; origState: string; destCity: string; destState: string }>;
      spotFraction: number;
      baseMarginPerLoad: number;
      baseRevenuePerLoad: number;
      baseLoadsPerMonth: number;
    }

    const companyTemplates: CompanyLoadTemplate[] = [
      {
        customer: "Summit Frozen Foods", opsUser: "Tyler Benson",
        lanes: [
          { origCity: "Chicago", origState: "IL", destCity: "Memphis", destState: "TN" },
          { origCity: "Chicago", origState: "IL", destCity: "Atlanta", destState: "GA" },
          { origCity: "Minneapolis", origState: "MN", destCity: "Chicago", destState: "IL" },
        ],
        spotFraction: 0.25, baseMarginPerLoad: 374, baseRevenuePerLoad: 2670, baseLoadsPerMonth: 38,
      },
      {
        customer: "Heartland Building Products", opsUser: "Tyler Benson",
        lanes: [
          { origCity: "Elgin", origState: "IL", destCity: "Dallas", destState: "TX" },
          { origCity: "Elgin", origState: "IL", destCity: "Nashville", destState: "TN" },
          { origCity: "Indianapolis", origState: "IN", destCity: "Columbus", destState: "OH" },
        ],
        spotFraction: 0.40, baseMarginPerLoad: 242, baseRevenuePerLoad: 1727, baseLoadsPerMonth: 12,
      },
      {
        customer: "Riverview Chemical", opsUser: "Priya Patel",
        lanes: [
          { origCity: "Chicago", origState: "IL", destCity: "Houston", destState: "TX" },
          { origCity: "Chicago", origState: "IL", destCity: "New Orleans", destState: "LA" },
          { origCity: "Houston", origState: "TX", destCity: "Beaumont", destState: "TX" },
        ],
        spotFraction: 0.15, baseMarginPerLoad: 376, baseRevenuePerLoad: 2686, baseLoadsPerMonth: 34,
      },
      {
        customer: "Pacific Coast Produce", opsUser: "Priya Patel",
        lanes: [
          { origCity: "Fresno", origState: "CA", destCity: "Los Angeles", destState: "CA" },
          { origCity: "Fresno", origState: "CA", destCity: "Phoenix", destState: "AZ" },
          { origCity: "Los Angeles", origState: "CA", destCity: "Phoenix", destState: "AZ" },
        ],
        spotFraction: 0.60, baseMarginPerLoad: 189, baseRevenuePerLoad: 1350, baseLoadsPerMonth: 34,
      },
      {
        customer: "Great Plains Distribution", opsUser: "Jason Kowalski",
        lanes: [
          { origCity: "Omaha", origState: "NE", destCity: "Chicago", destState: "IL" },
          { origCity: "Kansas City", origState: "MO", destCity: "Memphis", destState: "TN" },
          { origCity: "Des Moines", origState: "IA", destCity: "Chicago", destState: "IL" },
        ],
        spotFraction: 0.20, baseMarginPerLoad: 371, baseRevenuePerLoad: 2650, baseLoadsPerMonth: 42,
      },
      {
        customer: "MidAmerica Steel Works", opsUser: "Jason Kowalski",
        lanes: [
          { origCity: "St. Louis", origState: "MO", destCity: "Pittsburgh", destState: "PA" },
          { origCity: "St. Louis", origState: "MO", destCity: "Cleveland", destState: "OH" },
          { origCity: "Kansas City", origState: "MO", destCity: "Indianapolis", destState: "IN" },
        ],
        spotFraction: 0.05, baseMarginPerLoad: 224, baseRevenuePerLoad: 1600, baseLoadsPerMonth: 14,
      },
      {
        customer: "Bayshore Consumer Brands", opsUser: "Lexi Navarro",
        lanes: [
          { origCity: "Tampa", origState: "FL", destCity: "Charlotte", destState: "NC" },
          { origCity: "Tampa", origState: "FL", destCity: "Philadelphia", destState: "PA" },
          { origCity: "Miami", origState: "FL", destCity: "Atlanta", destState: "GA" },
        ],
        spotFraction: 0.30, baseMarginPerLoad: 384, baseRevenuePerLoad: 2743, baseLoadsPerMonth: 31,
      },
      {
        customer: "Northstar Lumber Co.", opsUser: "Marcus Dunn",
        lanes: [
          { origCity: "Minneapolis", origState: "MN", destCity: "Boise", destState: "ID" },
          { origCity: "Minneapolis", origState: "MN", destCity: "Seattle", destState: "WA" },
          { origCity: "Milwaukee", origState: "WI", destCity: "Grand Rapids", destState: "MI" },
        ],
        spotFraction: 0.50, baseMarginPerLoad: 248, baseRevenuePerLoad: 1771, baseLoadsPerMonth: 18,
      },
      {
        customer: "Keystone Pharma Logistics", opsUser: "Marcus Dunn",
        lanes: [
          { origCity: "Philadelphia", origState: "PA", destCity: "Chicago", destState: "IL" },
          { origCity: "Charlotte", origState: "NC", destCity: "Atlanta", destState: "GA" },
          { origCity: "Los Angeles", origState: "CA", destCity: "San Francisco", destState: "CA" },
        ],
        spotFraction: 0.00, baseMarginPerLoad: 372, baseRevenuePerLoad: 2657, baseLoadsPerMonth: 18,
      },
      {
        customer: "Laredo Cross-Border Trading", opsUser: "Brianna Okafor",
        lanes: [
          { origCity: "Laredo", origState: "TX", destCity: "San Antonio", destState: "TX" },
          { origCity: "Laredo", origState: "TX", destCity: "Houston", destState: "TX" },
          { origCity: "Houston", origState: "TX", destCity: "Dallas", destState: "TX" },
        ],
        spotFraction: 0.55, baseMarginPerLoad: 378, baseRevenuePerLoad: 2700, baseLoadsPerMonth: 27,
      },
    ];

    // Deterministic pseudo-noise so Feb always > Jan per company (no Math.random)
    function deterministicNoise(seed: number, range: number): number {
      return ((seed * 2654435761) >>> 0) % (range * 2 + 1) - range;
    }

    function makeTransactionRows(month: "January" | "February" | "March"): TxRow[] {
      const monthNum = month === "January" ? 1 : month === "February" ? 2 : 3;
      const daysInMonth = month === "January" ? 31 : month === "February" ? 28 : 24; // March up to 24th
      const year = 2026;
      const rows: TxRow[] = [];
      let orderSeq = month === "January" ? 100000 : month === "February" ? 102000 : 104000;
      // Growth multipliers: Jan = base, Feb = +18%, March = +28% (strong Q1 close)
      const baseMult = month === "January" ? 1.0 : month === "February" ? 1.18 : 1.28;

      for (let ci = 0; ci < companyTemplates.length; ci++) {
        const tmpl = companyTemplates[ci];
        const loadsThisMonth = Math.ceil(tmpl.baseLoadsPerMonth * baseMult);
        for (let i = 0; i < loadsThisMonth; i++) {
          const lane = tmpl.lanes[i % tmpl.lanes.length];
          const isSpot = (i % Math.round(1 / Math.max(tmpl.spotFraction, 0.01))) === 0 && tmpl.spotFraction > 0;
          const day = Math.min(daysInMonth, Math.floor((i / loadsThisMonth) * daysInMonth) + 1);
          const dateStr2 = `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const margNoise = deterministicNoise(ci * 10000 + i + (monthNum * 50000), Math.floor(tmpl.baseMarginPerLoad * 0.04));
          const revNoise = deterministicNoise(ci * 20000 + i + (monthNum * 50000), Math.floor(tmpl.baseRevenuePerLoad * 0.04));
          const margin = Math.round(tmpl.baseMarginPerLoad * baseMult + margNoise);
          const revenue = Math.round(tmpl.baseRevenuePerLoad * baseMult + revNoise);
          orderSeq++;
          rows.push({
            "Customer": tmpl.customer,
            "Operations user": tmpl.opsUser,
            "Order type": isSpot ? "Spot" : "Contract",
            "Status": "delivered",
            "Shipper city": lane.origCity,
            "Shipper state": lane.origState,
            "Consignee city": lane.destCity,
            "Consignee state": lane.destState,
            "Date ordered": dateStr2,
            "Order number": `DEMO-${orderSeq}`,
            "Total revenue": revenue,
            "Margin $": margin,
          });
        }
      }
      return rows;
    }

    const janRows = makeTransactionRows("January");
    const febRows = makeTransactionRows("February");
    const marchRows = makeTransactionRows("March");

    // Jan-only upload (historical)
    const [janUpload] = await db.insert(financialUploads).values({
      fileName: `${DEMO_FILE_PREFIX}January_2026.xlsx`,
      uploadedAt: "2026-02-03T09:00:00.000Z",
      uploadedBy: admin.id,
      rowCount: janRows.length,
      rows: janRows,
      summaryRows: [],
      bestDealDaysSpot: [],
      bestDealDaysAll: [],
      trendAnalysis: [],
      averagesData: [],
      dailyAcquisition: [],
    }).returning();
    console.log(`  Created January financial upload: ${janRows.length} transaction rows`);

    const [febUpload] = await db.insert(financialUploads).values({
      fileName: `${DEMO_FILE_PREFIX}February_2026.xlsx`,
      uploadedAt: "2026-03-03T09:00:00.000Z",
      uploadedBy: admin.id,
      rowCount: febRows.length,
      rows: febRows,
      summaryRows: [],
      bestDealDaysSpot: [],
      bestDealDaysAll: [],
      trendAnalysis: [],
      averagesData: [],
      dailyAcquisition: [],
    }).returning();
    console.log(`  Created February financial upload: ${febRows.length} transaction rows`);

    // March upload = ALL 3 months combined — this is the "latest" upload the trending endpoint reads.
    // By including Jan + Feb + March rows, trending can compare Feb vs March and show growth/decline.
    const allRows = [...janRows, ...febRows, ...marchRows];
    const [marchUpload] = await db.insert(financialUploads).values({
      fileName: `${DEMO_FILE_PREFIX}March_2026.xlsx`,
      uploadedAt: "2026-03-24T09:00:00.000Z",
      uploadedBy: admin.id,
      rowCount: allRows.length,
      rows: allRows,
      summaryRows: [],
      bestDealDaysSpot: [],
      bestDealDaysAll: [],
      trendAnalysis: [],
      averagesData: [],
      dailyAcquisition: [],
    }).returning();
    console.log(`  Created March financial upload: ${allRows.length} total rows (Jan + Feb + March — used for trending)`);

    // ─── STEP 6: RFPs ────────────────────────────────────────────────────────
    console.log("\nStep 6: Creating RFPs…");

    const summitCo = companyByName.get("Summit Frozen Foods")!;
    const pacificCo = companyByName.get("Pacific Coast Produce")!;
    const greatPlainsCo = companyByName.get("Great Plains Distribution")!;

    const summitLanes: LaneDef[] = [
      { id: "SFF-001", origin: "Chicago, IL", destination: "Memphis, TN", volume: 120, rate: "$2.15", equipment: "Reefer", status: "awarded" },
      { id: "SFF-002", origin: "Chicago, IL", destination: "Atlanta, GA", volume: 85, rate: "$2.35", equipment: "Reefer", status: "awarded" },
      { id: "SFF-003", origin: "Minneapolis, MN", destination: "Chicago, IL", volume: 60, rate: "$1.90", equipment: "Reefer", status: "awarded" },
      { id: "SFF-004", origin: "Chicago, IL", destination: "Nashville, TN", volume: 45, rate: "$2.05", equipment: "Dry Van", status: "open" },
      { id: "SFF-005", origin: "Chicago, IL", destination: "Dallas, TX", volume: 38, rate: "$2.75", equipment: "Reefer", status: "open" },
      { id: "SFF-006", origin: "Memphis, TN", destination: "Birmingham, AL", volume: 32, rate: "$1.65", equipment: "Reefer", status: "open" },
      { id: "SFF-007", origin: "Chicago, IL", destination: "Kansas City, MO", volume: 55, rate: "$1.85", equipment: "Dry Van", status: "awarded" },
      { id: "SFF-008", origin: "Milwaukee, WI", destination: "Indianapolis, IN", volume: 28, rate: "$1.75", equipment: "Dry Van", status: "open" },
    ];

    await db.insert(rfps).values({
      companyId: summitCo.id,
      title: "Summit Frozen Foods 2026 Annual RFP",
      status: "pending",
      dueDate: "2026-03-31",
      notes: "Annual reefer and dry van RFP covering all national lanes. High priority — Gloria wants coverage confirmed before Q2.",
      fileName: "Summit_Frozen_Foods_2026_RFP.xlsx",
      laneCount: summitLanes.length,
      totalVolume: String(summitLanes.reduce((s, l) => s + l.volume, 0)),
      originStates: ["IL", "MN", "TN", "WI"],
      destinationStates: ["TN", "GA", "IL", "TX", "AL", "MO", "IN"],
      fileData: {
        rows: summitLanes.map((l) => ({ "Lane #": l.id, "Origin": l.origin, "Destination": l.destination, "Annual Volume": l.volume, "Rate": l.rate, "Equipment": l.equipment, "Status": l.status })),
        headers: ["Lane #", "Origin", "Destination", "Annual Volume", "Rate", "Equipment", "Status"],
        highVolumeLanes: summitLanes.filter((l) => l.volume > 50),
        analysis: { laneCount: summitLanes.length, totalVolume: "463", awardedCount: summitLanes.filter((l) => l.status === "awarded").length, openCount: summitLanes.filter((l) => l.status === "open").length },
      },
    });
    console.log("  Created Summit Frozen Foods RFP");

    const pacificLanes: LaneDef[] = [
      { id: "PCP-001", origin: "Fresno, CA", destination: "Los Angeles, CA", volume: 200, rate: "$1.45", equipment: "Reefer", status: "awarded" },
      { id: "PCP-002", origin: "Fresno, CA", destination: "Phoenix, AZ", volume: 150, rate: "$2.10", equipment: "Reefer", status: "awarded" },
      { id: "PCP-003", origin: "Fresno, CA", destination: "Las Vegas, NV", volume: 90, rate: "$1.95", equipment: "Reefer", status: "awarded" },
      { id: "PCP-004", origin: "Fresno, CA", destination: "Seattle, WA", volume: 65, rate: "$2.85", equipment: "Reefer", status: "open" },
      { id: "PCP-005", origin: "Fresno, CA", destination: "Portland, OR", volume: 55, rate: "$2.65", equipment: "Reefer", status: "open" },
      { id: "PCP-006", origin: "Los Angeles, CA", destination: "Phoenix, AZ", volume: 80, rate: "$1.80", equipment: "Reefer", status: "awarded" },
      { id: "PCP-007", origin: "Fresno, CA", destination: "Denver, CO", volume: 40, rate: "$2.95", equipment: "Reefer", status: "open" },
      { id: "PCP-008", origin: "Sacramento, CA", destination: "Las Vegas, NV", volume: 35, rate: "$1.85", equipment: "Reefer", status: "open" },
      { id: "PCP-009", origin: "Fresno, CA", destination: "Salt Lake City, UT", volume: 30, rate: "$2.40", equipment: "Reefer", status: "open" },
    ];

    await db.insert(rfps).values({
      companyId: pacificCo.id,
      title: "Pacific Coast Produce 2026 Core Lane Bid",
      status: "pending",
      dueDate: "2026-04-15",
      notes: "All reefer lanes — produce season critical. Coverage gaps on PNW lanes (Seattle/Portland). Lisa needs dedicated carriers confirmed before April 1.",
      fileName: "Pacific_Coast_Produce_2026_RFP.xlsx",
      laneCount: pacificLanes.length,
      totalVolume: String(pacificLanes.reduce((s, l) => s + l.volume, 0)),
      originStates: ["CA"],
      destinationStates: ["CA", "AZ", "NV", "WA", "OR", "CO", "UT"],
      fileData: {
        rows: pacificLanes.map((l) => ({ "Lane #": l.id, "Origin": l.origin, "Destination": l.destination, "Annual Volume": l.volume, "Rate": l.rate, "Equipment": l.equipment, "Status": l.status })),
        headers: ["Lane #", "Origin", "Destination", "Annual Volume", "Rate", "Equipment", "Status"],
        highVolumeLanes: pacificLanes.filter((l) => l.volume > 60),
        analysis: { laneCount: pacificLanes.length, totalVolume: "745", awardedCount: pacificLanes.filter((l) => l.status === "awarded").length, openCount: pacificLanes.filter((l) => l.status === "open").length, coverageGaps: ["Seattle, WA", "Portland, OR", "Denver, CO"] },
      },
    });
    console.log("  Created Pacific Coast Produce RFP");

    const gpLanes: LaneDef[] = [
      { id: "GPD-001", origin: "Omaha, NE", destination: "Chicago, IL", volume: 110, rate: "$1.70", equipment: "Dry Van", status: "awarded" },
      { id: "GPD-002", origin: "Kansas City, MO", destination: "Memphis, TN", volume: 95, rate: "$1.85", equipment: "Dry Van", status: "awarded" },
      { id: "GPD-003", origin: "Des Moines, IA", destination: "Chicago, IL", volume: 75, rate: "$1.60", equipment: "Dry Van", status: "awarded" },
      { id: "GPD-004", origin: "Dallas, TX", destination: "Denver, CO", volume: 60, rate: "$2.45", equipment: "Flatbed", status: "open" },
      { id: "GPD-005", origin: "Wichita, KS", destination: "Sioux Falls, SD", volume: 50, rate: "$1.95", equipment: "Dry Van", status: "open" },
    ];

    await db.insert(rfps).values({
      companyId: greatPlainsCo.id,
      title: "Great Plains Distribution Q2 2026 Lane Bid",
      status: "pending",
      dueDate: "2026-03-15",
      notes: "Quarterly lane refresh covering Midwest core routes. Dallas–Denver flatbed has coverage gaps — no qualified carriers in current pool.",
      fileName: "Great_Plains_Q2_2026_RFP.xlsx",
      laneCount: gpLanes.length,
      totalVolume: String(gpLanes.reduce((s, l) => s + l.volume, 0)),
      originStates: ["NE", "MO", "IA", "TX", "KS"],
      destinationStates: ["IL", "TN", "CO", "SD"],
      fileData: {
        rows: gpLanes.map((l) => ({ "Lane #": l.id, "Origin": l.origin, "Destination": l.destination, "Annual Volume": l.volume, "Rate": l.rate, "Equipment": l.equipment, "Status": l.status })),
        headers: ["Lane #", "Origin", "Destination", "Annual Volume", "Rate", "Equipment", "Status"],
        highVolumeLanes: gpLanes.filter((l) => l.volume > 60),
        analysis: { laneCount: gpLanes.length, totalVolume: "390", awardedCount: gpLanes.filter((l) => l.status === "awarded").length, openCount: gpLanes.filter((l) => l.status === "open").length },
      },
    });
    console.log("  Created Great Plains Distribution RFP");

    // ─── STEP 7: TASKS ───────────────────────────────────────────────────────
    console.log("\nStep 7: Creating tasks…");

    const taskDefs: TaskDef[] = [
      { title: "Follow up with Rick at Summit on Q2 reefer commitment", notes: "He mentioned 40+ loads per month starting April. Get a written LOI before end of February.", status: "open", dueDate: "2026-02-28", assignedToKey: "am1", assignedByKey: "nam1", companyName: "Summit Frozen Foods", laneData: { origin: "Chicago, IL", destination: "Memphis, TN", equipment: "Reefer", volume: 40 } },
      { title: "Get Summit Frozen Foods RFP awarded lanes confirmed in TMS", notes: "Lanes SFF-001, SFF-002, SFF-003 are awarded — make sure they're in the system.", status: "completed", dueDate: "2026-02-10", assignedToKey: "am1", assignedByKey: "nam1", companyName: "Summit Frozen Foods", laneData: null },
      { title: "Stage drop trailers at Heartland Elgin facility", notes: "Carmen needs 3 trailers staged by Feb 15. Coordinate with ops team.", status: "completed", dueDate: "2026-02-15", assignedToKey: "am1", assignedByKey: "nam1", companyName: "Heartland Building Products", laneData: null },
      { title: "Schedule Heartland quarterly review with Bill Stratton", notes: "Bill requested a QBR for March. Block his calendar for March 10 at their office.", status: "open", dueDate: "2026-03-10", assignedToKey: "am1", assignedByKey: "nam1", companyName: "Heartland Building Products", laneData: null },
      { title: "Send Riverview Chemical updated HAZMAT carrier certs", notes: "Nadia needs our updated cert package before their compliance review on March 1.", status: "open", dueDate: "2026-02-28", assignedToKey: "am2", assignedByKey: "nam1", companyName: "Riverview Chemical", laneData: null },
      { title: "Confirm Pacific Coast Produce coverage for April produce season", notes: "Lisa said reefer needs spike hard in April. Get carrier commitments in place by mid-March.", status: "open", dueDate: "2026-03-15", assignedToKey: "am2", assignedByKey: "nam1", companyName: "Pacific Coast Produce", laneData: { origin: "Fresno, CA", destination: "Phoenix, AZ", equipment: "Reefer", volume: 60 } },
      { title: "Resolve Great Plains AR issue — invoice 10842 (45 days)", notes: "Trevor said finance is backed up. Escalate to Rachel if not cleared by Feb 28.", status: "open", dueDate: "2026-02-28", assignedToKey: "am3", assignedByKey: "nam1", companyName: "Great Plains Distribution", laneData: null },
      { title: "Propose dedicated flatbed program to Frank Russo at MidAmerica Steel", notes: "Frank wants 5 dedicated lanes. Draft proposal for 3 flatbed and 2 step-deck lanes.", status: "open", dueDate: "2026-03-05", assignedToKey: "am3", assignedByKey: "nam1", companyName: "MidAmerica Steel Works", laneData: { origin: "St. Louis, MO", destination: "Pittsburgh, PA", equipment: "Flatbed", volume: 24 } },
      { title: "Complete Bayshore Consumer Brands carrier onboarding", notes: "Angela's team needs onboarding packet signed and returned. It's been pending 10 days.", status: "completed", dueDate: "2026-02-08", assignedToKey: "am4", assignedByKey: "nam2", companyName: "Bayshore Consumer Brands", laneData: null },
      { title: "Set up bi-weekly check-in calls with Tom Greenberg at Bayshore", notes: "Tom requested bi-weekly Friday calls. Get it on both calendars.", status: "completed", dueDate: "2026-02-12", assignedToKey: "am4", assignedByKey: "nam2", companyName: "Bayshore Consumer Brands", laneData: null },
      { title: "Discuss dedicated lane program with Glen Larson at Northstar Lumber", notes: "Glen mentioned top 5 routes as candidates. Meet Feb 20 to discuss structure.", status: "open", dueDate: "2026-02-20", assignedToKey: "am5", assignedByKey: "nam2", companyName: "Northstar Lumber Co.", laneData: { origin: "Minneapolis, MN", destination: "Boise, ID", equipment: "Flatbed", volume: 30 } },
      { title: "Add Keystone Pharma carriers to CTSI pre-approval list", notes: "Greg needs 3 new reefer carriers added to the CTSI portal before they can cover West Coast lanes.", status: "open", dueDate: "2026-03-01", assignedToKey: "am5", assignedByKey: "nam2", companyName: "Keystone Pharma Logistics", laneData: null },
      { title: "Prepare Laredo cross-border capacity plan for Q2 call with Sofia", notes: "Sofia wants a strategic capacity overview for cross-border lanes in Q2. Pull DAT data and build a summary.", status: "open", dueDate: "2026-03-08", assignedToKey: "am6", assignedByKey: "nam2", companyName: "Laredo Cross-Border Trading", laneData: { origin: "Laredo, TX", destination: "San Antonio, TX", equipment: "Dry Van", volume: 45 } },
      { title: "Follow up with Hector at Laredo on March lane additions", notes: "Hector said they're adding 3 more lanes in March. Get details and confirm coverage.", status: "open", dueDate: "2026-03-10", assignedToKey: "am6", assignedByKey: "nam2", companyName: "Laredo Cross-Border Trading", laneData: null },
    ];

    let firstTaskId: string | null = null;
    for (const def of taskDefs) {
      const co = companyByName.get(def.companyName);
      const [task] = await db.insert(tasks).values({
        title: def.title,
        notes: def.notes,
        status: def.status,
        dueDate: def.dueDate,
        assignedTo: amMap[def.assignedToKey].id,
        assignedBy: namMap[def.assignedByKey].id,
        companyId: co?.id ?? null,
        contactId: null,
        createdAt: ts(new Date("2026-02-01T10:00:00.000Z")),
        attachedLaneData: def.laneData,
      }).returning();
      if (!firstTaskId) firstTaskId = task.id;
      console.log(`  Created task: ${task.title.substring(0, 60)}…`);
    }

    if (firstTaskId) {
      await db.insert(taskComments).values({ taskId: firstTaskId, authorId: am1.id, content: "Spoke with Rick this morning — he's in, needs formal LOI by March 1. Loop in Sandra before we commit to carrier pricing.", createdAt: ts(new Date("2026-02-22T14:00:00.000Z")) });
      await db.insert(taskComments).values({ taskId: firstTaskId, authorId: nam1.id, content: "I'll draft the LOI template today. Tyler, send me the rate targets and I'll get it finalized.", createdAt: ts(new Date("2026-02-22T15:00:00.000Z")) });
      console.log("  Added comments to first task");
    }

    // ─── STEP 8: GOALS ───────────────────────────────────────────────────────
    console.log("\nStep 8: Creating goals…");

    const goalDefs: GoalDef[] = [
      // Tyler Benson (am1) — Jan + Feb: loads, touchpoints, new_contacts, margin
      { amKey: "am1", namKey: "nam1", metric: "loads_booked", period: "monthly", target: "35", current: "38", title: "January Loads", customLabel: "Jan loads", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am1", namKey: "nam1", metric: "loads_booked", period: "monthly", target: "42", current: "45", title: "February Loads", customLabel: "Feb loads", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am1", namKey: "nam1", metric: "touchpoints", period: "monthly", target: "30", current: "34", title: "January Touchpoints", customLabel: "Jan touches", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am1", namKey: "nam1", metric: "touchpoints", period: "monthly", target: "35", current: "38", title: "February Touchpoints", customLabel: "Feb touches", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am1", namKey: "nam1", metric: "new_contacts", period: "monthly", target: "4", current: "5", title: "January New Contacts", customLabel: "Jan contacts", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am1", namKey: "nam1", metric: "new_contacts", period: "monthly", target: "5", current: "6", title: "February New Contacts", customLabel: "Feb contacts", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am1", namKey: "nam1", metric: "margin", period: "monthly", target: "13000", current: "14200", title: "January Margin", customLabel: "Jan margin", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am1", namKey: "nam1", metric: "margin", period: "monthly", target: "16000", current: "16756", title: "February Margin", customLabel: "Feb margin", startDate: FEB_START, endDate: FEB_END },
      // Priya Patel (am2)
      { amKey: "am2", namKey: "nam1", metric: "loads_booked", period: "monthly", target: "30", current: "34", title: "January Loads", customLabel: "Jan loads", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am2", namKey: "nam1", metric: "loads_booked", period: "monthly", target: "38", current: "40", title: "February Loads", customLabel: "Feb loads", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am2", namKey: "nam1", metric: "new_contacts", period: "monthly", target: "5", current: "6", title: "January New Contacts", customLabel: "Jan contacts", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am2", namKey: "nam1", metric: "new_contacts", period: "monthly", target: "5", current: "7", title: "February New Contacts", customLabel: "Feb contacts", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am2", namKey: "nam1", metric: "touchpoints", period: "monthly", target: "28", current: "31", title: "January Touchpoints", customLabel: "Jan touches", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am2", namKey: "nam1", metric: "touchpoints", period: "monthly", target: "32", current: "36", title: "February Touchpoints", customLabel: "Feb touches", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am2", namKey: "nam1", metric: "margin", period: "monthly", target: "12000", current: "12800", title: "January Margin", customLabel: "Jan margin", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am2", namKey: "nam1", metric: "margin", period: "monthly", target: "14500", current: "15104", title: "February Margin", customLabel: "Feb margin", startDate: FEB_START, endDate: FEB_END },
      // Jason Kowalski (am3)
      { amKey: "am3", namKey: "nam1", metric: "loads_booked", period: "monthly", target: "40", current: "42", title: "January Loads", customLabel: "Jan loads", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am3", namKey: "nam1", metric: "loads_booked", period: "monthly", target: "48", current: "50", title: "February Loads", customLabel: "Feb loads", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am3", namKey: "nam1", metric: "touchpoints", period: "monthly", target: "35", current: "40", title: "January Touchpoints", customLabel: "Jan touches", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am3", namKey: "nam1", metric: "touchpoints", period: "monthly", target: "40", current: "44", title: "February Touchpoints", customLabel: "Feb touches", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am3", namKey: "nam1", metric: "new_contacts", period: "monthly", target: "4", current: "5", title: "January New Contacts", customLabel: "Jan contacts", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am3", namKey: "nam1", metric: "new_contacts", period: "monthly", target: "5", current: "5", title: "February New Contacts", customLabel: "Feb contacts", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am3", namKey: "nam1", metric: "margin", period: "monthly", target: "15000", current: "15600", title: "January Margin", customLabel: "Jan margin", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am3", namKey: "nam1", metric: "margin", period: "monthly", target: "18000", current: "18408", title: "February Margin", customLabel: "Feb margin", startDate: FEB_START, endDate: FEB_END },
      // Lexi Navarro (am4)
      { amKey: "am4", namKey: "nam2", metric: "loads_booked", period: "monthly", target: "28", current: "31", title: "January Loads", customLabel: "Jan loads", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am4", namKey: "nam2", metric: "loads_booked", period: "monthly", target: "35", current: "37", title: "February Loads", customLabel: "Feb loads", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am4", namKey: "nam2", metric: "new_contacts", period: "monthly", target: "4", current: "5", title: "January New Contacts", customLabel: "Jan contacts", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am4", namKey: "nam2", metric: "new_contacts", period: "monthly", target: "4", current: "4", title: "February New Contacts", customLabel: "Feb contacts", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am4", namKey: "nam2", metric: "touchpoints", period: "monthly", target: "26", current: "28", title: "January Touchpoints", customLabel: "Jan touches", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am4", namKey: "nam2", metric: "touchpoints", period: "monthly", target: "30", current: "33", title: "February Touchpoints", customLabel: "Feb touches", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am4", namKey: "nam2", metric: "margin", period: "monthly", target: "11000", current: "11900", title: "January Margin", customLabel: "Jan margin", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am4", namKey: "nam2", metric: "margin", period: "monthly", target: "13000", current: "14042", title: "February Margin", customLabel: "Feb margin", startDate: FEB_START, endDate: FEB_END },
      // Marcus Dunn (am5)
      { amKey: "am5", namKey: "nam2", metric: "loads_booked", period: "monthly", target: "33", current: "36", title: "January Loads", customLabel: "Jan loads", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am5", namKey: "nam2", metric: "loads_booked", period: "monthly", target: "40", current: "43", title: "February Loads", customLabel: "Feb loads", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am5", namKey: "nam2", metric: "touchpoints", period: "monthly", target: "30", current: "32", title: "January Touchpoints", customLabel: "Jan touches", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am5", namKey: "nam2", metric: "touchpoints", period: "monthly", target: "34", current: "37", title: "February Touchpoints", customLabel: "Feb touches", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am5", namKey: "nam2", metric: "new_contacts", period: "monthly", target: "4", current: "4", title: "January New Contacts", customLabel: "Jan contacts", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am5", namKey: "nam2", metric: "new_contacts", period: "monthly", target: "5", current: "6", title: "February New Contacts", customLabel: "Feb contacts", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am5", namKey: "nam2", metric: "margin", period: "monthly", target: "12500", current: "13400", title: "January Margin", customLabel: "Jan margin", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am5", namKey: "nam2", metric: "margin", period: "monthly", target: "15000", current: "15812", title: "February Margin", customLabel: "Feb margin", startDate: FEB_START, endDate: FEB_END },
      // Brianna Okafor (am6)
      { amKey: "am6", namKey: "nam2", metric: "loads_booked", period: "monthly", target: "25", current: "27", title: "January Loads", customLabel: "Jan loads", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am6", namKey: "nam2", metric: "loads_booked", period: "monthly", target: "30", current: "32", title: "February Loads", customLabel: "Feb loads", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am6", namKey: "nam2", metric: "new_contacts", period: "monthly", target: "5", current: "4", title: "January New Contacts", customLabel: "Jan contacts", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am6", namKey: "nam2", metric: "new_contacts", period: "monthly", target: "6", current: "4", title: "February New Contacts (stretch)", customLabel: "Feb contacts", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am6", namKey: "nam2", metric: "touchpoints", period: "monthly", target: "22", current: "24", title: "January Touchpoints", customLabel: "Jan touches", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am6", namKey: "nam2", metric: "touchpoints", period: "monthly", target: "26", current: "28", title: "February Touchpoints", customLabel: "Feb touches", startDate: FEB_START, endDate: FEB_END },
      { amKey: "am6", namKey: "nam2", metric: "margin", period: "monthly", target: "9500", current: "10200", title: "January Margin", customLabel: "Jan margin", startDate: JAN_START, endDate: JAN_END },
      { amKey: "am6", namKey: "nam2", metric: "margin", period: "monthly", target: "11500", current: "12036", title: "February Margin", customLabel: "Feb margin", startDate: FEB_START, endDate: FEB_END },
    ];

    for (const def of goalDefs) {
      await db.insert(goals).values({
        namId: namMap[def.namKey].id,
        amId: amMap[def.amKey].id,
        metric: def.metric,
        period: def.period,
        target: def.target,
        currentValue: def.current,
        title: def.title,
        customLabel: def.customLabel,
        notes: null,
        startDate: def.startDate,
        endDate: def.endDate,
        createdAt: ts(new Date(def.startDate)),
        createdById: namMap[def.namKey].id,
      });
    }
    console.log(`  Created ${goalDefs.length} goals across all AMs (loads, touchpoints, new_contacts, margin)`);

    // ─── STEP 9: 1:1 SESSIONS ────────────────────────────────────────────────
    console.log("\nStep 9: Creating 1:1 sessions…");

    async function createSession(namId: string, amId: string, meetingDate: string, notes: string, topics: SessionTopicDef[], isLatest: boolean) {
      const [session] = await db.insert(oneOnOneSessions).values({
        namId,
        amId,
        status: isLatest ? "active" : "closed",
        startDate: meetingDate,
        notes,
        meetingDate,
        meetingLink: "https://meet.google.com/demo-link",
      }).returning();

      for (const topic of topics) {
        const [t] = await db.insert(oneOnOneTopics).values({
          sessionId: session.id,
          addedById: namId,
          text: topic.text,
          tag: topic.tag,
          status: topic.status,
          createdAt: ts(new Date(meetingDate)),
        }).returning();

        if (topic.reply) {
          await db.insert(oneOnOneTopicReplies).values({
            topicId: t.id,
            authorId: amId,
            text: topic.reply,
            createdAt: ts(new Date(meetingDate)),
          });
        }
      }
      return session;
    }

    const sessionDefs: SessionDef[] = [
      // NAM1 (Sandra) <> Tyler Benson
      { namKey: "nam1", amKey: "am1", meetingDate: "2026-01-10", isLatest: false, notes: "Good meeting. Tyler is building strong momentum with Summit and Heartland.", topics: [
        { text: "Review Summit Frozen Foods Q1 reefer strategy", tag: "account", status: "completed", reply: "Talked through the Monday morning coverage gap — going to reach out to Rick this week." },
        { text: "Tyler's January load target: 35 loads", tag: "goal", status: "completed", reply: "Hit 38 — really happy with the momentum." },
        { text: "Discuss Heartland drop trailer program", tag: "account", status: "completed" },
      ]},
      { namKey: "nam1", amKey: "am1", meetingDate: "2026-02-07", isLatest: false, notes: "Tyler tracking well above February goal. Big RFP opportunity at Summit.", topics: [
        { text: "Summit RFP awarded lanes — confirm TMS setup", tag: "action_item", status: "completed", reply: "Done. SFF-001, 002, 003 are live." },
        { text: "Set March QBR with Bill Stratton at Heartland", tag: "action_item", status: "pending" },
        { text: "Tyler load goal Feb: 42 loads — on pace for 45+", tag: "goal", status: "pending", reply: "Feeling good. Summit volume is pulling me forward." },
      ]},
      { namKey: "nam1", amKey: "am1", meetingDate: "2026-02-21", isLatest: true, notes: "Discussed career growth — Tyler is performing at Senior AM level.", topics: [
        { text: "Tyler's performance is tracking Senior AM criteria — discuss promotion path", tag: "development", status: "pending", reply: "Really appreciate the recognition. I want to start tracking those benchmarks officially." },
        { text: "Q2 strategy: deepen Summit relationship, grow Heartland flatbed volume", tag: "strategy", status: "pending" },
      ]},
      // NAM1 (Sandra) <> Priya Patel
      { namKey: "nam1", amKey: "am2", meetingDate: "2026-01-08", isLatest: false, notes: "Priya had a strong January with Riverview and Pacific Coast.", topics: [
        { text: "Review Riverview HAZMAT approval status", tag: "action_item", status: "completed", reply: "We're approved for Gulf Coast lanes — 2 loads per week starting Feb." },
        { text: "Pacific Coast produce season prep — reefer capacity", tag: "account", status: "completed" },
      ]},
      { namKey: "nam1", amKey: "am2", meetingDate: "2026-02-05", isLatest: false, notes: "Priya crushing new contacts goal. Pacific RFP is a huge opportunity.", topics: [
        { text: "Pacific Coast RFP coverage gaps — PNW lanes need carriers", tag: "action_item", status: "pending", reply: "Working on it — talking to our Seattle carrier base this week." },
        { text: "Priya's Feb load goal: 38 loads, on pace for 40", tag: "goal", status: "pending" },
        { text: "Celebrate: 7 new contacts in Feb so far, goal was 5", tag: "win", status: "completed", reply: "Carlos at Pacific introduced me to his whole team — that unlocked everything." },
      ]},
      { namKey: "nam1", amKey: "am2", meetingDate: "2026-02-19", isLatest: true, notes: "Deep dive on Pacific Coast strategy and Riverview compliance docs.", topics: [
        { text: "Send Riverview updated HAZMAT certs before March 1 deadline", tag: "action_item", status: "pending" },
        { text: "Schedule QBR with Steve Paulson at Riverview for April 15", tag: "action_item", status: "pending" },
      ]},
      // NAM1 (Sandra) <> Jason Kowalski
      { namKey: "nam1", amKey: "am3", meetingDate: "2026-01-06", isLatest: false, notes: "Jason is one of our top performers — hitting 42 loads in January.", topics: [
        { text: "Great Plains AR issue — 45-day invoice problem", tag: "account", status: "completed", reply: "Escalated to Rachel Kim — she's working on it with finance." },
        { text: "Discuss MidAmerica Steel dedicated lane proposal", tag: "strategy", status: "completed" },
      ]},
      { namKey: "nam1", amKey: "am3", meetingDate: "2026-02-03", isLatest: true, notes: "Jason landed 50 loads in Feb so far — tracking for a record month.", topics: [
        { text: "Jason Feb goal: 48 loads — currently at 50", tag: "goal", status: "pending" },
        { text: "Draft MidAmerica 5-lane flatbed proposal for Frank Russo", tag: "action_item", status: "pending", reply: "Working on it. Frank wants 3 flatbed + 2 step deck. Getting carrier quotes now." },
      ]},
      // NAM2 (Derek) <> Lexi Navarro
      { namKey: "nam2", amKey: "am4", meetingDate: "2026-01-09", isLatest: false, notes: "Lexi getting Bayshore fully onboarded — took some persistence.", topics: [
        { text: "Bayshore carrier onboarding — need signed packet", tag: "action_item", status: "completed", reply: "Sent it 3 times — finally got it back. All cleared now." },
        { text: "Lexi load goal Jan: 28 loads — finished at 31", tag: "goal", status: "completed" },
      ]},
      { namKey: "nam2", amKey: "am4", meetingDate: "2026-02-06", isLatest: true, notes: "Bayshore is fully operational — Lexi building great rapport with Tom.", topics: [
        { text: "Set up bi-weekly call with Tom Greenberg", tag: "action_item", status: "completed" },
        { text: "Discuss Dillon's NYC DC opening in Q2 — plan for new volume", tag: "strategy", status: "pending", reply: "Dillon confirmed April 1 opening. Going to pre-position 2 dry van carriers in the Northeast." },
      ]},
      // NAM2 (Derek) <> Marcus Dunn
      { namKey: "nam2", amKey: "am5", meetingDate: "2026-01-07", isLatest: false, notes: "Marcus doing well with Northstar but Keystone needs attention.", topics: [
        { text: "Keystone GPS tracking compliance — confirm with Nathan", tag: "action_item", status: "completed", reply: "Confirmed. Nathan verified our tracking is CTSI-compliant." },
        { text: "Northstar dedicated lane opportunity — prep for Glen meeting", tag: "strategy", status: "pending" },
      ]},
      { namKey: "nam2", amKey: "am5", meetingDate: "2026-02-04", isLatest: true, notes: "Marcus hit 43 loads in Feb — strong growth from January.", topics: [
        { text: "Add 3 reefer carriers to Keystone CTSI pre-approval list", tag: "action_item", status: "pending" },
        { text: "Schedule dedicated lane meeting with Glen Larson — Feb 20", tag: "action_item", status: "pending", reply: "On the calendar. Prepping a lane analysis for his top 5 routes." },
      ]},
      // NAM2 (Derek) <> Brianna Okafor
      { namKey: "nam2", amKey: "am6", meetingDate: "2026-01-11", isLatest: false, notes: "Brianna newest to the team — Laredo account is complex but high potential.", topics: [
        { text: "Brianna getting comfortable with cross-border process", tag: "development", status: "completed", reply: "Hector has been really helpful explaining the drayage side." },
        { text: "Identify drayage partner options at Laredo border", tag: "action_item", status: "completed" },
      ]},
      { namKey: "nam2", amKey: "am6", meetingDate: "2026-02-10", isLatest: true, notes: "Hector added 3 more lanes in March — Brianna has a big Q2 ahead.", topics: [
        { text: "Prep Q2 capacity plan for Sofia call — March 8", tag: "action_item", status: "pending" },
        { text: "Follow up on March lane additions with Hector", tag: "action_item", status: "pending", reply: "He wants dry van and reefer options — will put together a proposal." },
      ]},
    ];

    for (const def of sessionDefs) {
      await createSession(
        namMap[def.namKey].id,
        amMap[def.amKey].id,
        def.meetingDate,
        def.notes,
        def.topics,
        def.isLatest,
      );
    }
    console.log(`  Created ${sessionDefs.length} 1:1 sessions with topics and replies`);

    // ─── STEP 10: FEED POSTS ─────────────────────────────────────────────────
    console.log("\nStep 10: Creating feed posts…");

    const feedPostDefs: FeedPostDef[] = [
      { content: "🚛 Big week for the team — we covered 6 reefer loads for Summit Frozen Foods and had zero tender rejections. Tyler, that's what building trust looks like. Keep it up!", category: "win", authorKey: "nam1", createdAt: "2026-02-21T09:00:00.000Z", reactions: [{ userKey: "am1", emoji: "🔥" }, { userKey: "am2", emoji: "👏" }, { userKey: "director", emoji: "💪" }] },
      { content: "Market callout: dry van rates out of Chicago are ticking up this week — DAT showing $2.05/mi avg on Midwest lanes. Our contracted rates are well-positioned. Good time to have a rate renewal convo with any accounts that are spot-heavy.", category: "market", authorKey: "director", createdAt: "2026-02-19T11:30:00.000Z", reactions: [{ userKey: "nam1", emoji: "👍" }, { userKey: "am3", emoji: "💡" }] },
      { content: "Capacity alert: reefer capacity on West Coast lanes (Fresno → Phoenix, LA) is tightening heading into produce season. Start locking in dedicated carriers NOW for April. Priya, this is especially relevant for Pacific Coast Produce.", category: "alert", authorKey: "nam1", createdAt: "2026-02-17T14:00:00.000Z", reactions: [{ userKey: "am2", emoji: "🙏" }, { userKey: "director", emoji: "⚠️" }] },
      { content: "Huge win — Laredo Cross-Border Trading is adding 3 more lanes in March! Brianna has been grinding on that account since October. Cross-border is not easy and she's building real credibility with Hector. 🎉", category: "win", authorKey: "nam2", createdAt: "2026-02-15T10:00:00.000Z", reactions: [{ userKey: "am6", emoji: "🙌" }, { userKey: "admin", emoji: "🔥" }, { userKey: "director", emoji: "👏" }] },
      { content: "Quick reminder on spot board discipline: when carriers hit that 1-hour bid window with Pacific Coast, we CANNOT miss it. Lisa Yamamoto has been testing our responsiveness. Set your phone alerts. Spot = relationship.", category: "reminder", authorKey: "nam1", createdAt: "2026-02-13T08:00:00.000Z", reactions: [{ userKey: "am2", emoji: "✅" }] },
      { content: "Backhaul alert: Northstar Lumber mills in MN have open backhaul freight every Mon/Tue. Easy coverage if you have carriers coming out of the Twin Cities. Marcus, worth surfacing to any carrier partners heading that direction.", category: "market", authorKey: "director", createdAt: "2026-02-10T13:00:00.000Z", reactions: [{ userKey: "am5", emoji: "💡" }, { userKey: "nam2", emoji: "👍" }] },
      { content: "MidAmerica Steel emergency coverage story: Dana Pierce called at 7 AM on a Monday needing same-day flatbed for a coil move. Jason answered, had a carrier confirmed by 8:30. Dana said 'I'll remember that.' THAT is how you win dedicated business. 💪", category: "win", authorKey: "nam1", createdAt: "2026-02-07T16:00:00.000Z", reactions: [{ userKey: "am3", emoji: "💪" }, { userKey: "director", emoji: "🔥" }, { userKey: "admin", emoji: "👏" }] },
      { content: "Reminder: Keystone Pharma requires GPS tracking on every single load. Zero exceptions. If a carrier doesn't have it, do NOT book them on any Keystone lane. One missed temp excursion = automatic claim.", category: "reminder", authorKey: "nam2", createdAt: "2026-02-05T09:30:00.000Z", reactions: [{ userKey: "am5", emoji: "✅" }, { userKey: "am4", emoji: "✅" }] },
      { content: "February is shaping up to be our best month since Q3 last year. Team is up 18% on loads YoY. Great Plains, Summit, and Pacific Coast are all trending up. Keep the pedal down — Q1 close is our moment. 🚀", category: "update", authorKey: "director", createdAt: "2026-02-03T10:00:00.000Z", reactions: [{ userKey: "nam1", emoji: "🚀" }, { userKey: "nam2", emoji: "🚀" }, { userKey: "am1", emoji: "🔥" }, { userKey: "am3", emoji: "💪" }] },
      { content: "New lane win: we just got awarded 3 reefer lanes in Summit's 2026 RFP (Chicago→Memphis, Chicago→Atlanta, Minneapolis→Chicago). Total volume ~265 loads annually. Tyler and Sandra — great work on the RFP response.", category: "win", authorKey: "director", createdAt: "2026-01-28T14:00:00.000Z", reactions: [{ userKey: "am1", emoji: "🙌" }, { userKey: "nam1", emoji: "🎉" }, { userKey: "am2", emoji: "👏" }] },
    ];

    for (const def of feedPostDefs) {
      const [post] = await db.insert(feedPosts).values({
        content: def.content,
        category: def.category,
        authorId: allUserMap[def.authorKey].id,
        createdAt: def.createdAt,
        parentId: null,
        pinned: false,
      }).returning();

      for (const reaction of def.reactions) {
        await db.insert(feedPostReactions).values({
          feedPostId: post.id,
          userId: allUserMap[reaction.userKey].id,
          emoji: reaction.emoji,
          createdAt: def.createdAt,
        });
      }
    }
    console.log(`  Created ${feedPostDefs.length} feed posts with reactions`);

    // ─── STEP 11: MARKET SHARE ENTRIES ───────────────────────────────────────
    console.log("\nStep 11: Creating market share entries…");

    const msEntries: MarketShareDef[] = [
      { companyName: "Summit Frozen Foods", label: "January 2026", start: JAN_START, end: JAN_END, total: 480, vt: 38, spot: 12 },
      { companyName: "Summit Frozen Foods", label: "February 2026", start: FEB_START, end: FEB_END, total: 500, vt: 52, spot: 18 },
      { companyName: "Pacific Coast Produce", label: "January 2026", start: JAN_START, end: JAN_END, total: 820, vt: 65, spot: 30 },
      { companyName: "Pacific Coast Produce", label: "February 2026", start: FEB_START, end: FEB_END, total: 850, vt: 82, spot: 40 },
      { companyName: "Great Plains Distribution", label: "January 2026", start: JAN_START, end: JAN_END, total: 1200, vt: 95, spot: 25 },
      { companyName: "Great Plains Distribution", label: "February 2026", start: FEB_START, end: FEB_END, total: 1250, vt: 118, spot: 32 },
    ];

    for (const ms of msEntries) {
      const co = companyByName.get(ms.companyName)!;
      await db.insert(marketShareEntries).values({
        companyId: co.id,
        entryType: "monthly",
        periodLabel: ms.label,
        periodStart: ms.start,
        periodEnd: ms.end,
        totalMarketLoads: ms.total,
        vtLoads: ms.vt,
        spotLoads: ms.spot,
        notes: null,
        createdAt: ms.end,
        createdBy: admin.id,
      });
    }
    console.log(`  Created ${msEntries.length} market share entries`);

    // ─── STEP 12: PTO PASSOFF ────────────────────────────────────────────────
    console.log("\nStep 12: Creating PTO passoff…");

    const gpCo = companyByName.get("Great Plains Distribution")!;
    const msCo = companyByName.get("MidAmerica Steel Works")!;

    const [passoff] = await db.insert(ptoPassoffs).values({
      createdById: am3.id,
      coveringUserId: am1.id,
      startDate: "2026-03-10",
      endDate: "2026-03-14",
      emergencyContact: "Jason Kowalski — 314-555-9999",
      generalNotes: "Out March 10–14 for spring break. Tyler is covering my accounts. Great Plains needs the AR follow-up on invoice 10842 — Tyler has the context. MidAmerica Steel proposal to Frank should be sent by March 8 before I leave.",
      status: "active",
      createdAt: ts(new Date("2026-03-05T10:00:00.000Z")),
    }).returning();

    await db.insert(ptoPassoffItems).values({
      passoffId: passoff.id,
      companyId: gpCo.id,
      priority: "high",
      spotFreightHandler: "Tyler Benson",
      keyCustomerContact: "Rachel Kim — r.kim@greatplainsdist.com — 402-555-0241",
      openItems: "Invoice 10842 is 45 days out — needs escalation to Rachel if not cleared by March 12. Trevor said finance is backed up.",
      processNotes: "They post spot loads on their broker portal. Rate must beat their benchmark by 5%. Tyler knows their portal login.",
      activeDeals: "Q2 lane bid in progress — 5 lanes, due March 15",
      acknowledged: false,
      emailForwardingSet: true,
      spotBoardUpdated: true,
      avgWeeklySpotLoads: "8",
      avgWeeklyTotalLoads: "24",
    });

    await db.insert(ptoPassoffItems).values({
      passoffId: passoff.id,
      companyId: msCo.id,
      priority: "medium",
      spotFreightHandler: "Tyler Benson",
      keyCustomerContact: "Dana Pierce — d.pierce@midamericasteel.com — 314-555-0251",
      openItems: "5-lane flatbed proposal being drafted for Frank Russo — needs to be sent by March 8. Includes 3 flatbed + 2 step-deck lanes.",
      processNotes: "They only use spot for emergencies — Dana calls directly. Don't post to DAT for this account.",
      activeDeals: "Dedicated flatbed proposal — Frank's decision timeline is March 20",
      acknowledged: false,
      emailForwardingSet: true,
      spotBoardUpdated: false,
      avgWeeklySpotLoads: "1",
      avgWeeklyTotalLoads: "6",
    });

    console.log(`  Created PTO passoff (id: ${passoff.id}) with 2 account items`);

    // ─── STEP 13: CAREER MILESTONES (promotion nominations) ──────────────────
    console.log("\nStep 13: Creating career milestone entries…");

    await db.insert(promotionNominations).values({
      nomineeId: am1.id,
      nominatedById: nam1.id,
      notes: "Tyler has consistently exceeded his load and touchpoint goals for 3 consecutive months. He turned around the Summit Frozen Foods relationship from minimal to a major RFP award. Tracking at Senior AM criteria — recommending for review.",
      status: "active",
      nominatedAt: "2026-02-21T09:00:00.000Z",
    });

    await db.insert(promotionNominations).values({
      nomineeId: am3.id,
      nominatedById: nam1.id,
      notes: "Jason hit 50 loads in February — a personal record. He handled the MidAmerica Steel emergency coverage with complete professionalism and Dana Pierce is now considering a dedicated program. Strong candidate for Senior AM.",
      status: "active",
      nominatedAt: "2026-02-24T09:00:00.000Z",
    });

    console.log("  Created 2 promotion nominations (career milestones)");

    // ─── SUMMARY ─────────────────────────────────────────────────────────────
    const totalContacts = Array.from(contactsByCompanyId.values()).flat().length;
    const totalTouchpoints = Object.values(touchpointNotesByCompany).reduce((s, n) => s + n.length, 0);

    console.log("\n" + "=".repeat(60));
    console.log("DEMO ORG SEED COMPLETE");
    console.log("=".repeat(60));
    console.log(`\nOrg: ${DEMO_ORG_NAME} (slug: ${DEMO_SLUG})\n`);
    console.log("LOGIN CREDENTIALS (password for all: Demo1234!)");
    console.log("-".repeat(60));
    console.log(`  Admin:     admin@freightdna-demo.com        (Rachel Torres)`);
    console.log(`  Director:  director@freightdna-demo.com     (Marcus Webb)`);
    console.log(`  NAM 1:     nam1@freightdna-demo.com         (Sandra Chen)`);
    console.log(`  NAM 2:     nam2@freightdna-demo.com         (Derek Hollis)`);
    console.log(`  AM 1:      am1@freightdna-demo.com          (Tyler Benson)`);
    console.log(`  AM 2:      am2@freightdna-demo.com          (Priya Patel)`);
    console.log(`  AM 3:      am3@freightdna-demo.com          (Jason Kowalski)`);
    console.log(`  AM 4:      am4@freightdna-demo.com          (Lexi Navarro)`);
    console.log(`  AM 5:      am5@freightdna-demo.com          (Marcus Dunn)`);
    console.log(`  AM 6:      am6@freightdna-demo.com          (Brianna Okafor)`);
    console.log("-".repeat(60));
    console.log("\nData created:");
    console.log(`  Users:             10 (1 Admin, 1 Director, 2 NAMs, 6 AMs)`);
    console.log(`  Companies:         ${companyDefs.length} fictional freight shippers`);
    console.log(`  Contacts:          ${totalContacts} contacts with full org chart hierarchy`);
    console.log(`  Touchpoints:       ${totalTouchpoints} across Jan–Feb 2026`);
    console.log(`  Financial uploads: 2 (January + February with 18% growth)`);
    console.log(`  RFPs:              3 (Summit Frozen Foods, Pacific Coast Produce, Great Plains)`);
    console.log(`  Tasks:             ${taskDefs.length} (mix of open and completed, with comments)`);
    console.log(`  Goals:             ${goalDefs.length} across all AMs (loads, touchpoints, new_contacts, margin)`);
    console.log(`  1:1 Sessions:      ${sessionDefs.length} with topics and action items`);
    console.log(`  Feed posts:        ${feedPostDefs.length} with emoji reactions`);
    console.log(`  Market share:      ${msEntries.length} entries for 3 companies`);
    console.log(`  PTO passoff:       1 with 2 account items`);
    console.log(`  Promo nominations: 2 career milestone entries`);
    console.log("\nAll demo data is fully isolated in the 'demo' organization.");
    console.log("=".repeat(60));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
