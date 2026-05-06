/**
 * Seed script: Populate Carrier Hub with realistic sample carrier data.
 *
 * Inserts 18 carriers with varied statuses, equipment types, regions, and tags
 * into the demo org. Each carrier gets 1–3 contacts with different roles.
 * A subset of carriers get claimed lanes populated.
 * Adds outreach logs, email messages/threads, email signals, and conversation
 * threads to simulate realistic communications and negotiations.
 *
 * Idempotent: deletes all existing carriers for the demo org before re-seeding.
 * Carrier contacts and claimed lanes cascade-delete with their parent carrier.
 *
 * Run with: npx tsx scripts/seed-carriers.ts
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import {
  organizations,
  users,
  carriers,
  carrierContacts,
  carrierClaimedLanes,
  recurringLanes,
  carrierOutreachLogs,
  emailMessages,
  emailSignals,
  emailConversationThreads,
  laneCarrierInterest,
} from "../shared/schema";

const DEMO_SLUG = "demo";

interface CarrierDef {
  name: string;
  legalName: string;
  mcDot: string;
  dotNumber: string;
  phone: string;
  city: string;
  state: string;
  regions: string[];
  statesServed: string[];
  metroAreas: string[];
  equipmentTypes: string[];
  equipmentNotes: string | null;
  tags: string[];
  primaryEmail: string;
  backupEmail: string | null;
  notes: string | null;
  status: string;
  sourceChannel: string;
  contacts: ContactDef[];
  claimedLanes: ClaimedLaneDef[];
}

interface ContactDef {
  name: string;
  role: string;
  email: string;
  phone: string;
  extension: string | null;
  preferredMethod: string;
  notes: string | null;
  isPrimary: boolean;
}

interface ClaimedLaneDef {
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string;
  laneType: string;
  notes: string | null;
}

const carrierDefs: CarrierDef[] = [
  {
    name: "Apex Road Freight",
    legalName: "Apex Road Freight LLC",
    mcDot: "MC-482917",
    dotNumber: "DOT-2194583",
    phone: "615-555-0101",
    city: "Nashville",
    state: "TN",
    regions: ["Southeast", "Midwest"],
    statesServed: ["TN", "KY", "GA", "AL", "OH", "IN"],
    metroAreas: ["Nashville", "Atlanta", "Louisville"],
    equipmentTypes: ["van"],
    equipmentNotes: "53ft dry vans, 12 trucks in fleet",
    tags: ["reliable", "drop-trailer-capable"],
    primaryEmail: "dispatch@apexroadfreight.com",
    backupEmail: "ops@apexroadfreight.com",
    notes: "Very reliable on Southeast lanes. Always on time.",
    status: "active",
    sourceChannel: "manual",
    contacts: [
      { name: "Tom Bradley", role: "dispatcher", email: "tom@apexroadfreight.com", phone: "615-555-0102", extension: null, preferredMethod: "phone", notes: "Available 6am-6pm CT", isPrimary: true },
      { name: "Angela Hayes", role: "billing", email: "billing@apexroadfreight.com", phone: "615-555-0103", extension: "201", preferredMethod: "email", notes: null, isPrimary: false },
    ],
    claimedLanes: [
      { originCity: "Nashville", originState: "TN", destCity: "Atlanta", destState: "GA", equipment: "van", laneType: "prefer", notes: "Daily capacity" },
      { originCity: "Nashville", originState: "TN", destCity: "Louisville", destState: "KY", equipment: "van", laneType: "prefer", notes: null },
    ],
  },
  {
    name: "Blue Ridge Logistics",
    legalName: "Blue Ridge Logistics Inc",
    mcDot: "MC-561204",
    dotNumber: "DOT-3017842",
    phone: "704-555-0210",
    city: "Charlotte",
    state: "NC",
    regions: ["Southeast"],
    statesServed: ["NC", "SC", "VA", "GA", "FL"],
    metroAreas: ["Charlotte", "Raleigh", "Greenville"],
    equipmentTypes: ["van", "reefer"],
    equipmentNotes: "Mixed fleet: 20 dry vans, 8 reefers",
    tags: ["reefer-certified", "TWIC-card"],
    primaryEmail: "dispatch@blueridgelog.com",
    backupEmail: null,
    notes: "Strong in Carolinas corridor. Growing reefer division.",
    status: "active",
    sourceChannel: "dat",
    contacts: [
      { name: "Marcus Johnson", role: "dispatcher", email: "marcus@blueridgelog.com", phone: "704-555-0211", extension: null, preferredMethod: "text", notes: "Prefers text for load offers", isPrimary: true },
      { name: "Dana Wright", role: "after_hours", email: "afterhours@blueridgelog.com", phone: "704-555-0212", extension: null, preferredMethod: "phone", notes: "Nights and weekends", isPrimary: false },
      { name: "Kevin Park", role: "sales", email: "kevin@blueridgelog.com", phone: "704-555-0213", extension: null, preferredMethod: "email", notes: null, isPrimary: false },
    ],
    claimedLanes: [
      { originCity: "Charlotte", originState: "NC", destCity: "Miami", destState: "FL", equipment: "reefer", laneType: "prefer", notes: "3x/week capacity" },
      { originCity: "Charlotte", originState: "NC", destCity: "Richmond", destState: "VA", equipment: "van", laneType: "prefer", notes: null },
    ],
  },
  {
    name: "Midwest Express Carriers",
    legalName: "Midwest Express Carriers Corp",
    mcDot: "MC-339871",
    dotNumber: "DOT-1845623",
    phone: "312-555-0330",
    city: "Chicago",
    state: "IL",
    regions: ["Midwest", "Great Lakes"],
    statesServed: ["IL", "IN", "WI", "MI", "OH", "MN"],
    metroAreas: ["Chicago", "Indianapolis", "Milwaukee"],
    equipmentTypes: ["van"],
    equipmentNotes: "All 53ft dry vans. 35-truck fleet.",
    tags: ["high-volume", "EDI-capable"],
    primaryEmail: "loads@midwestexpress.com",
    backupEmail: "dispatch2@midwestexpress.com",
    notes: "High-volume Midwest carrier. EDI integrated.",
    status: "active",
    sourceChannel: "manual",
    contacts: [
      { name: "Lisa Chen", role: "dispatcher", email: "lisa@midwestexpress.com", phone: "312-555-0331", extension: null, preferredMethod: "email", notes: "Responds quickly via email", isPrimary: true },
    ],
    claimedLanes: [
      { originCity: "Chicago", originState: "IL", destCity: "Indianapolis", destState: "IN", equipment: "van", laneType: "prefer", notes: "Daily runs" },
      { originCity: "Chicago", originState: "IL", destCity: "Detroit", destState: "MI", equipment: "van", laneType: "prefer", notes: null },
      { originCity: "Chicago", originState: "IL", destCity: "Minneapolis", destState: "MN", equipment: "van", laneType: "prefer", notes: "2-3x/week" },
    ],
  },
  {
    name: "Summit Transport LLC",
    legalName: "Summit Transport LLC",
    mcDot: "MC-710345",
    dotNumber: "DOT-4102956",
    phone: "303-555-0440",
    city: "Denver",
    state: "CO",
    regions: ["Mountain West", "Southwest"],
    statesServed: ["CO", "UT", "NM", "AZ", "WY"],
    metroAreas: ["Denver", "Salt Lake City", "Albuquerque"],
    equipmentTypes: ["flatbed", "van"],
    equipmentNotes: "15 flatbeds, 10 dry vans. Certified for oversize loads.",
    tags: ["oversize-capable", "tarping-included"],
    primaryEmail: "dispatch@summittransportllc.com",
    backupEmail: null,
    notes: "Specializes in building materials and lumber in mountain region.",
    status: "active",
    sourceChannel: "dat",
    contacts: [
      { name: "Jake Morrison", role: "dispatcher", email: "jake@summittransportllc.com", phone: "303-555-0441", extension: null, preferredMethod: "phone", notes: null, isPrimary: true },
      { name: "Sarah Kline", role: "sales", email: "sarah@summittransportllc.com", phone: "303-555-0442", extension: null, preferredMethod: "email", notes: "Handles new lane inquiries", isPrimary: false },
    ],
    claimedLanes: [
      { originCity: "Denver", originState: "CO", destCity: "Salt Lake City", destState: "UT", equipment: "flatbed", laneType: "prefer", notes: "Core lane" },
      { originCity: "Denver", originState: "CO", destCity: "Phoenix", destState: "AZ", equipment: "flatbed", laneType: "prefer", notes: null },
    ],
  },
  {
    name: "Lone Star Hauling",
    legalName: "Lone Star Hauling Inc",
    mcDot: "MC-428190",
    dotNumber: "DOT-2567831",
    phone: "214-555-0550",
    city: "Dallas",
    state: "TX",
    regions: ["South Central", "Southwest"],
    statesServed: ["TX", "OK", "AR", "LA", "NM"],
    metroAreas: ["Dallas", "Houston", "San Antonio", "Oklahoma City"],
    equipmentTypes: ["van", "reefer", "flatbed"],
    equipmentNotes: "Large mixed fleet: 50+ trucks across all equipment types",
    tags: ["high-volume", "hazmat-endorsed"],
    primaryEmail: "dispatch@lonestarhauling.com",
    backupEmail: "night@lonestarhauling.com",
    notes: "Major Texas-based carrier. Hazmat endorsed for select drivers.",
    status: "active",
    sourceChannel: "manual",
    contacts: [
      { name: "Miguel Reyes", role: "dispatcher", email: "miguel@lonestarhauling.com", phone: "214-555-0551", extension: null, preferredMethod: "phone", notes: "Day shift dispatcher", isPrimary: true },
      { name: "Brenda Cox", role: "after_hours", email: "brenda@lonestarhauling.com", phone: "214-555-0552", extension: null, preferredMethod: "phone", notes: "After 6pm CT and weekends", isPrimary: false },
      { name: "Ray Nguyen", role: "billing", email: "ar@lonestarhauling.com", phone: "214-555-0553", extension: "305", preferredMethod: "email", notes: null, isPrimary: false },
    ],
    claimedLanes: [
      { originCity: "Dallas", originState: "TX", destCity: "Houston", destState: "TX", equipment: "van", laneType: "prefer", notes: "Multiple daily" },
      { originCity: "Houston", originState: "TX", destCity: "New Orleans", destState: "LA", equipment: "reefer", laneType: "prefer", notes: null },
    ],
  },
  {
    name: "Pacific Northwest Freight",
    legalName: "Pacific Northwest Freight Co",
    mcDot: "MC-615782",
    dotNumber: "DOT-3498127",
    phone: "206-555-0660",
    city: "Seattle",
    state: "WA",
    regions: ["Pacific Northwest", "West Coast"],
    statesServed: ["WA", "OR", "ID", "MT", "CA"],
    metroAreas: ["Seattle", "Portland", "Boise"],
    equipmentTypes: ["reefer"],
    equipmentNotes: "All reefer fleet. Temperature monitoring on every unit.",
    tags: ["reefer-only", "temp-controlled", "produce-specialist"],
    primaryEmail: "loads@pnwfreight.com",
    backupEmail: null,
    notes: "Dedicated reefer carrier for Pacific Northwest produce lanes.",
    status: "active",
    sourceChannel: "dat",
    contacts: [
      { name: "Chris Olson", role: "dispatcher", email: "chris@pnwfreight.com", phone: "206-555-0661", extension: null, preferredMethod: "email", notes: null, isPrimary: true },
      { name: "Amy Tanaka", role: "sales", email: "amy@pnwfreight.com", phone: "206-555-0662", extension: null, preferredMethod: "email", notes: "Lane development contact", isPrimary: false },
    ],
    claimedLanes: [
      { originCity: "Seattle", originState: "WA", destCity: "Los Angeles", destState: "CA", equipment: "reefer", laneType: "prefer", notes: "Core lane, daily capacity" },
      { originCity: "Portland", originState: "OR", destCity: "San Francisco", destState: "CA", equipment: "reefer", laneType: "prefer", notes: null },
    ],
  },
  {
    name: "Great Lakes Tanker Co",
    legalName: "Great Lakes Tanker Company LLC",
    mcDot: "MC-287456",
    dotNumber: "DOT-1523890",
    phone: "216-555-0770",
    city: "Cleveland",
    state: "OH",
    regions: ["Great Lakes", "Midwest"],
    statesServed: ["OH", "PA", "MI", "IN", "NY"],
    metroAreas: ["Cleveland", "Pittsburgh", "Detroit"],
    equipmentTypes: ["tanker"],
    equipmentNotes: "Food-grade and chemical tankers. DOT/HAZMAT certified.",
    tags: ["tanker-only", "hazmat-certified", "food-grade"],
    primaryEmail: "dispatch@greatlakestanker.com",
    backupEmail: "safety@greatlakestanker.com",
    notes: "Specialized tanker carrier. Strict safety record. Food-grade certified.",
    status: "active",
    sourceChannel: "manual",
    contacts: [
      { name: "Paul Krawczyk", role: "dispatcher", email: "paul@greatlakestanker.com", phone: "216-555-0771", extension: null, preferredMethod: "phone", notes: "Handles all dispatch", isPrimary: true },
      { name: "Nina Ferraro", role: "sales", email: "nina@greatlakestanker.com", phone: "216-555-0772", extension: null, preferredMethod: "email", notes: "New business development", isPrimary: false },
      { name: "Dave Simmons", role: "after_hours", email: "emergency@greatlakestanker.com", phone: "216-555-0773", extension: null, preferredMethod: "phone", notes: "Emergency only", isPrimary: false },
    ],
    claimedLanes: [],
  },
  {
    name: "Heartland Flatbed Services",
    legalName: "Heartland Flatbed Services Inc",
    mcDot: "MC-503268",
    dotNumber: "DOT-2891047",
    phone: "816-555-0880",
    city: "Kansas City",
    state: "MO",
    regions: ["Midwest", "South Central"],
    statesServed: ["MO", "KS", "NE", "IA", "OK", "TX"],
    metroAreas: ["Kansas City", "Omaha", "Tulsa"],
    equipmentTypes: ["flatbed"],
    equipmentNotes: "Step decks and standard flatbeds. Tarp service included.",
    tags: ["flatbed-specialist", "step-deck", "tarping-included"],
    primaryEmail: "dispatch@heartlandflatbed.com",
    backupEmail: null,
    notes: "Best-in-class flatbed carrier for steel and building materials.",
    status: "active",
    sourceChannel: "import_csv",
    contacts: [
      { name: "Randy Brooks", role: "dispatcher", email: "randy@heartlandflatbed.com", phone: "816-555-0881", extension: null, preferredMethod: "phone", notes: null, isPrimary: true },
    ],
    claimedLanes: [
      { originCity: "Kansas City", originState: "MO", destCity: "Dallas", destState: "TX", equipment: "flatbed", laneType: "prefer", notes: "2x/week" },
    ],
  },
  {
    name: "Coastal Carriers Group",
    legalName: "Coastal Carriers Group LLC",
    mcDot: "MC-674231",
    dotNumber: "DOT-3782914",
    phone: "904-555-0990",
    city: "Jacksonville",
    state: "FL",
    regions: ["Southeast"],
    statesServed: ["FL", "GA", "SC", "AL"],
    metroAreas: ["Jacksonville", "Orlando", "Tampa", "Savannah"],
    equipmentTypes: ["van", "reefer"],
    equipmentNotes: "Southeast corridor specialist. 25 trucks.",
    tags: ["Florida-specialist"],
    primaryEmail: "dispatch@coastalcarriers.com",
    backupEmail: "ops@coastalcarriers.com",
    notes: "Strong Florida intra-state and GA/SC corridor coverage.",
    status: "inactive",
    sourceChannel: "manual",
    contacts: [
      { name: "Carlos Diaz", role: "dispatcher", email: "carlos@coastalcarriers.com", phone: "904-555-0991", extension: null, preferredMethod: "phone", notes: "Currently limited availability", isPrimary: true },
      { name: "Jessica Moore", role: "billing", email: "billing@coastalcarriers.com", phone: "904-555-0992", extension: "110", preferredMethod: "email", notes: null, isPrimary: false },
    ],
    claimedLanes: [],
  },
  {
    name: "Northern Plains Trucking",
    legalName: "Northern Plains Trucking Inc",
    mcDot: "MC-391847",
    dotNumber: "DOT-2103759",
    phone: "701-555-1010",
    city: "Fargo",
    state: "ND",
    regions: ["Northern Plains", "Midwest"],
    statesServed: ["ND", "SD", "MN", "MT", "WI"],
    metroAreas: ["Fargo", "Sioux Falls", "Minneapolis"],
    equipmentTypes: ["van", "flatbed"],
    equipmentNotes: "Cold weather specialists. Winter-ready equipment.",
    tags: ["winter-capable", "agricultural"],
    primaryEmail: "dispatch@northernplains.com",
    backupEmail: null,
    notes: "Reliable in harsh winter conditions. Agricultural freight expertise.",
    status: "active",
    sourceChannel: "dat",
    contacts: [
      { name: "Steve Larson", role: "dispatcher", email: "steve@northernplains.com", phone: "701-555-1011", extension: null, preferredMethod: "phone", notes: null, isPrimary: true },
    ],
    claimedLanes: [
      { originCity: "Fargo", originState: "ND", destCity: "Minneapolis", destState: "MN", equipment: "van", laneType: "prefer", notes: "Daily" },
    ],
  },
  {
    name: "Sunbelt Refrigerated",
    legalName: "Sunbelt Refrigerated Transport LLC",
    mcDot: "MC-745193",
    dotNumber: "DOT-4256781",
    phone: "404-555-1120",
    city: "Atlanta",
    state: "GA",
    regions: ["Southeast", "South Central"],
    statesServed: ["GA", "FL", "AL", "MS", "LA", "TX"],
    metroAreas: ["Atlanta", "Birmingham", "Jackson"],
    equipmentTypes: ["reefer"],
    equipmentNotes: "All reefer fleet with real-time temp monitoring. 40 units.",
    tags: ["reefer-only", "temp-controlled", "FSMA-compliant"],
    primaryEmail: "dispatch@sunbeltreefer.com",
    backupEmail: "backup@sunbeltreefer.com",
    notes: "Premium reefer carrier. FSMA compliant. Excellent service record.",
    status: "active",
    sourceChannel: "manual",
    contacts: [
      { name: "Tamika Williams", role: "dispatcher", email: "tamika@sunbeltreefer.com", phone: "404-555-1121", extension: null, preferredMethod: "email", notes: "Email preferred for load tenders", isPrimary: true },
      { name: "Derek Jackson", role: "after_hours", email: "afterhours@sunbeltreefer.com", phone: "404-555-1122", extension: null, preferredMethod: "phone", notes: "Evenings and weekends only", isPrimary: false },
    ],
    claimedLanes: [
      { originCity: "Atlanta", originState: "GA", destCity: "Miami", destState: "FL", equipment: "reefer", laneType: "prefer", notes: "Core lane" },
      { originCity: "Atlanta", originState: "GA", destCity: "Dallas", destState: "TX", equipment: "reefer", laneType: "prefer", notes: null },
    ],
  },
  {
    name: "Rocky Mountain Movers",
    legalName: "Rocky Mountain Movers Corp",
    mcDot: "MC-592034",
    dotNumber: "DOT-3305612",
    phone: "801-555-1230",
    city: "Salt Lake City",
    state: "UT",
    regions: ["Mountain West"],
    statesServed: ["UT", "CO", "WY", "ID", "NV"],
    metroAreas: ["Salt Lake City", "Boise", "Reno"],
    equipmentTypes: ["van", "flatbed"],
    equipmentNotes: "Mountain pass experienced drivers. Chains always available.",
    tags: ["mountain-specialist", "chain-equipped"],
    primaryEmail: "dispatch@rockymtnmovers.com",
    backupEmail: null,
    notes: "Experienced with mountain passes and winter conditions in the Rockies.",
    status: "flagged",
    sourceChannel: "import_paste",
    contacts: [
      { name: "Brett Hansen", role: "dispatcher", email: "brett@rockymtnmovers.com", phone: "801-555-1231", extension: null, preferredMethod: "phone", notes: null, isPrimary: true },
      { name: "Carla Espinoza", role: "billing", email: "billing@rockymtnmovers.com", phone: "801-555-1232", extension: "400", preferredMethod: "email", notes: "Net-30 terms", isPrimary: false },
    ],
    claimedLanes: [
      { originCity: "Salt Lake City", originState: "UT", destCity: "Denver", destState: "CO", equipment: "van", laneType: "prefer", notes: null },
    ],
  },
  {
    name: "Tri-State Van Lines",
    legalName: "Tri-State Van Lines LLC",
    mcDot: "MC-461582",
    dotNumber: "DOT-2638914",
    phone: "973-555-1340",
    city: "Newark",
    state: "NJ",
    regions: ["Northeast"],
    statesServed: ["NJ", "NY", "PA", "CT", "MA"],
    metroAreas: ["Newark", "New York City", "Philadelphia"],
    equipmentTypes: ["van"],
    equipmentNotes: "Urban delivery experts. Liftgate equipped.",
    tags: ["liftgate", "urban-delivery", "Northeast-corridor"],
    primaryEmail: "dispatch@tristatevanlines.com",
    backupEmail: "ops@tristatevanlines.com",
    notes: "Excellent for NYC metro deliveries. Liftgate on every unit.",
    status: "active",
    sourceChannel: "manual",
    contacts: [
      { name: "Tony Russo", role: "dispatcher", email: "tony@tristatevanlines.com", phone: "973-555-1341", extension: null, preferredMethod: "phone", notes: "Best reached before 3pm ET", isPrimary: true },
      { name: "Linda Kowalczyk", role: "sales", email: "linda@tristatevanlines.com", phone: "973-555-1342", extension: null, preferredMethod: "email", notes: null, isPrimary: false },
      { name: "Frank DiNapoli", role: "after_hours", email: "frank@tristatevanlines.com", phone: "973-555-1343", extension: null, preferredMethod: "phone", notes: "After 5pm and Saturdays", isPrimary: false },
    ],
    claimedLanes: [
      { originCity: "Newark", originState: "NJ", destCity: "Boston", destState: "MA", equipment: "van", laneType: "prefer", notes: "Next-day service" },
      { originCity: "Newark", originState: "NJ", destCity: "Philadelphia", destState: "PA", equipment: "van", laneType: "prefer", notes: null },
    ],
  },
  {
    name: "Delta Freight Solutions",
    legalName: "Delta Freight Solutions Inc",
    mcDot: "MC-823491",
    dotNumber: "DOT-4679023",
    phone: "601-555-1450",
    city: "Memphis",
    state: "TN",
    regions: ["South Central", "Southeast"],
    statesServed: ["TN", "MS", "AR", "AL", "LA"],
    metroAreas: ["Memphis", "Jackson MS", "Little Rock"],
    equipmentTypes: ["van", "reefer"],
    equipmentNotes: "Memphis hub with cross-dock capability.",
    tags: ["cross-dock", "Memphis-hub"],
    primaryEmail: "dispatch@deltafreight.com",
    backupEmail: null,
    notes: "Strategic Memphis location. Cross-dock services available.",
    status: "active",
    sourceChannel: "dat",
    contacts: [
      { name: "Jerome Washington", role: "dispatcher", email: "jerome@deltafreight.com", phone: "601-555-1451", extension: null, preferredMethod: "phone", notes: null, isPrimary: true },
    ],
    claimedLanes: [
      { originCity: "Memphis", originState: "TN", destCity: "Atlanta", destState: "GA", equipment: "van", laneType: "prefer", notes: "Daily" },
      { originCity: "Memphis", originState: "TN", destCity: "Dallas", destState: "TX", equipment: "van", laneType: "prefer", notes: null },
    ],
  },
  {
    name: "Cascade Intermodal",
    legalName: "Cascade Intermodal Transport Inc",
    mcDot: "MC-537910",
    dotNumber: "DOT-3045682",
    phone: "503-555-1560",
    city: "Portland",
    state: "OR",
    regions: ["Pacific Northwest", "West Coast"],
    statesServed: ["OR", "WA", "CA", "NV"],
    metroAreas: ["Portland", "Seattle", "Sacramento"],
    equipmentTypes: ["van", "reefer", "flatbed"],
    equipmentNotes: "Full-service carrier with intermodal capabilities.",
    tags: ["intermodal", "drayage", "port-access"],
    primaryEmail: "dispatch@cascadeintermodal.com",
    backupEmail: "operations@cascadeintermodal.com",
    notes: "Intermodal specialist with port drayage capability at Portland and Seattle.",
    status: "inactive",
    sourceChannel: "import_csv",
    contacts: [
      { name: "Ryan Kawamoto", role: "dispatcher", email: "ryan@cascadeintermodal.com", phone: "503-555-1561", extension: null, preferredMethod: "email", notes: null, isPrimary: true },
      { name: "Michelle Torres", role: "sales", email: "michelle@cascadeintermodal.com", phone: "503-555-1562", extension: null, preferredMethod: "email", notes: "Handles new account setup", isPrimary: false },
    ],
    claimedLanes: [],
  },
  {
    name: "Iron Horse Logistics",
    legalName: "Iron Horse Logistics Group LLC",
    mcDot: "MC-408726",
    dotNumber: "DOT-2345178",
    phone: "412-555-1670",
    city: "Pittsburgh",
    state: "PA",
    regions: ["Northeast", "Midwest"],
    statesServed: ["PA", "OH", "WV", "NY", "MD"],
    metroAreas: ["Pittsburgh", "Columbus", "Baltimore"],
    equipmentTypes: ["flatbed", "van"],
    equipmentNotes: "Steel hauling expertise. Coil racks available.",
    tags: ["steel-hauling", "coil-racks", "overweight-permit"],
    primaryEmail: "dispatch@ironhorselogistics.com",
    backupEmail: null,
    notes: "Primary steel hauler. Overweight permits for PA/OH/WV.",
    status: "flagged",
    sourceChannel: "manual",
    contacts: [
      { name: "Mike Kowalski", role: "dispatcher", email: "mike@ironhorselogistics.com", phone: "412-555-1671", extension: null, preferredMethod: "phone", notes: "Steel loads only", isPrimary: true },
      { name: "Donna Bates", role: "billing", email: "donna@ironhorselogistics.com", phone: "412-555-1672", extension: "202", preferredMethod: "email", notes: "Handles all invoicing", isPrimary: false },
      { name: "Jim Paterno", role: "after_hours", email: "jim@ironhorselogistics.com", phone: "412-555-1673", extension: null, preferredMethod: "phone", notes: null, isPrimary: false },
    ],
    claimedLanes: [
      { originCity: "Pittsburgh", originState: "PA", destCity: "Cleveland", destState: "OH", equipment: "flatbed", laneType: "prefer", notes: "Steel coils" },
      { originCity: "Pittsburgh", originState: "PA", destCity: "Baltimore", destState: "MD", equipment: "flatbed", laneType: "prefer", notes: null },
      { originCity: "Pittsburgh", originState: "PA", destCity: "Detroit", destState: "MI", equipment: "flatbed", laneType: "avoid", notes: "Avoid — bridge restrictions" },
    ],
  },
  {
    name: "Southwest Xpress",
    legalName: "Southwest Xpress Trucking Inc",
    mcDot: "MC-692104",
    dotNumber: "DOT-3891456",
    phone: "602-555-1780",
    city: "Phoenix",
    state: "AZ",
    regions: ["Southwest", "West Coast"],
    statesServed: ["AZ", "NM", "NV", "CA", "TX"],
    metroAreas: ["Phoenix", "Tucson", "Las Vegas", "El Paso"],
    equipmentTypes: ["van", "reefer"],
    equipmentNotes: "Desert corridor specialist. All units have APUs for idling compliance.",
    tags: ["desert-corridor", "APU-equipped"],
    primaryEmail: "dispatch@southwestxpress.com",
    backupEmail: null,
    notes: "Strong Phoenix–LA and Phoenix–El Paso lanes. APU on every truck.",
    status: "active",
    sourceChannel: "dat",
    contacts: [
      { name: "Maria Gutierrez", role: "dispatcher", email: "maria@southwestxpress.com", phone: "602-555-1781", extension: null, preferredMethod: "text", notes: "Prefers text messages", isPrimary: true },
      { name: "Alex Ruiz", role: "sales", email: "alex@southwestxpress.com", phone: "602-555-1782", extension: null, preferredMethod: "email", notes: null, isPrimary: false },
    ],
    claimedLanes: [
      { originCity: "Phoenix", originState: "AZ", destCity: "Los Angeles", destState: "CA", equipment: "van", laneType: "prefer", notes: "Core lane, same-day available" },
      { originCity: "Phoenix", originState: "AZ", destCity: "El Paso", destState: "TX", equipment: "van", laneType: "prefer", notes: null },
    ],
  },
  {
    name: "Patriot Freight Systems",
    legalName: "Patriot Freight Systems LLC",
    mcDot: "MC-854312",
    dotNumber: "DOT-4893021",
    phone: "757-555-1890",
    city: "Norfolk",
    state: "VA",
    regions: ["Mid-Atlantic", "Southeast"],
    statesServed: ["VA", "NC", "MD", "DC", "SC"],
    metroAreas: ["Norfolk", "Richmond", "Washington DC"],
    equipmentTypes: ["van"],
    equipmentNotes: "Government contract experience. Security-cleared drivers available.",
    tags: ["government-approved", "security-cleared", "port-access"],
    primaryEmail: "dispatch@patriotfreight.com",
    backupEmail: "ops@patriotfreight.com",
    notes: "Government freight experience. Port of Norfolk access.",
    status: "active",
    sourceChannel: "manual",
    contacts: [
      { name: "William Turner", role: "dispatcher", email: "william@patriotfreight.com", phone: "757-555-1891", extension: null, preferredMethod: "phone", notes: null, isPrimary: true },
      { name: "Catherine Bell", role: "billing", email: "billing@patriotfreight.com", phone: "757-555-1892", extension: "501", preferredMethod: "email", notes: "Net-45 preferred", isPrimary: false },
    ],
    claimedLanes: [
      { originCity: "Norfolk", originState: "VA", destCity: "Washington", destState: "DC", equipment: "van", laneType: "prefer", notes: "Government loads" },
      { originCity: "Norfolk", originState: "VA", destCity: "Charlotte", destState: "NC", equipment: "van", laneType: "prefer", notes: null },
    ],
  },
];

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  try {
    console.log("=== CARRIER SEED SCRIPT ===\n");

    console.log("Step 0: Finding demo org…");
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, DEMO_SLUG));
    if (!org) {
      throw new Error("Demo org (slug='demo') not found. Run seed-demo-org.ts first.");
    }
    console.log(`  Found demo org (id: ${org.id})\n`);

    console.log("Step 1: Removing existing carriers for demo org (idempotency)…");
    const deleted = await db.delete(carriers).where(eq(carriers.orgId, org.id)).returning({ id: carriers.id });
    console.log(`  Deleted ${deleted.length} existing carrier(s) (contacts & claimed lanes cascade-deleted)\n`);

    console.log("Step 2: Inserting carriers…");
    let totalContacts = 0;
    let totalLanes = 0;

    for (const def of carrierDefs) {
      const [carrier] = await db.insert(carriers).values({
        orgId: org.id,
        name: def.name,
        legalName: def.legalName,
        mcDot: def.mcDot,
        dotNumber: def.dotNumber,
        phone: def.phone,
        city: def.city,
        state: def.state,
        regions: def.regions,
        statesServed: def.statesServed,
        metroAreas: def.metroAreas,
        equipmentTypes: def.equipmentTypes,
        equipmentNotes: def.equipmentNotes,
        tags: def.tags,
        primaryEmail: def.primaryEmail,
        backupEmail: def.backupEmail,
        notes: def.notes,
        status: def.status,
        sourceChannel: def.sourceChannel,
      }).returning();

      console.log(`  ✓ ${carrier.name} (${carrier.status}, ${def.equipmentTypes.join("/")})`);

      if (def.contacts.length > 0) {
        await db.insert(carrierContacts).values(
          def.contacts.map(c => ({
            carrierId: carrier.id,
            name: c.name,
            role: c.role,
            email: c.email,
            phone: c.phone,
            extension: c.extension,
            preferredMethod: c.preferredMethod,
            notes: c.notes,
            isPrimary: c.isPrimary,
          }))
        );
        totalContacts += def.contacts.length;
      }

      if (def.claimedLanes.length > 0) {
        await db.insert(carrierClaimedLanes).values(
          def.claimedLanes.map(l => ({
            carrierId: carrier.id,
            originCity: l.originCity,
            originState: l.originState,
            destCity: l.destCity,
            destState: l.destState,
            equipment: l.equipment,
            laneType: l.laneType,
            notes: l.notes,
          }))
        );
        totalLanes += def.claimedLanes.length;
      }
    }

    console.log(`\n  Carriers inserted: ${carrierDefs.length}`);
    console.log(`  Contacts inserted: ${totalContacts}`);
    console.log(`  Claimed lanes inserted: ${totalLanes}`);

    const allCarriers = await db.select().from(carriers).where(eq(carriers.orgId, org.id));
    const carrierByName = Object.fromEntries(allCarriers.map(c => [c.name, c]));

    const orgUsers = await db.select().from(users).where(eq(users.organizationId, org.id));
    if (orgUsers.length === 0) {
      console.log("  ⚠ No users in demo org — skipping communications seed.");
      console.log(`\n=== Carrier seed completed (no communications) ===\n`);
      return;
    }
    const adminUser = orgUsers.find(u => u.role === "admin") ?? orgUsers[0];
    const amUsers = orgUsers.filter(u => u.role === "account_manager");
    const actorUser = amUsers[0] ?? adminUser;
    const actorUser2 = amUsers[1] ?? adminUser;

    console.log("\nStep 3: Creating recurring lanes for carrier outreach…");

    await db.delete(emailConversationThreads).where(eq(emailConversationThreads.orgId, org.id));
    await db.delete(emailMessages).where(eq(emailMessages.orgId, org.id));
    await db.delete(carrierOutreachLogs).where(eq(carrierOutreachLogs.orgId, org.id));
    await db.delete(laneCarrierInterest).where(
      inArray(laneCarrierInterest.laneId,
        db.select({ id: recurringLanes.id }).from(recurringLanes).where(eq(recurringLanes.orgId, org.id))
      )
    );
    await db.delete(recurringLanes).where(eq(recurringLanes.orgId, org.id));

    const laneDefs = [
      { origin: "Chicago", originState: "IL", destination: "Indianapolis", destinationState: "IN", equipmentType: "Dry Van", avgLoadsPerWeek: "8.50", ownerUserId: actorUser.id },
      { origin: "Nashville", originState: "TN", destination: "Atlanta", destinationState: "GA", equipmentType: "Dry Van", avgLoadsPerWeek: "5.25", ownerUserId: actorUser.id },
      { origin: "Dallas", originState: "TX", destination: "Houston", destinationState: "TX", equipmentType: "Reefer", avgLoadsPerWeek: "12.00", ownerUserId: actorUser2.id },
      { origin: "Charlotte", originState: "NC", destination: "Miami", destinationState: "FL", equipmentType: "Reefer", avgLoadsPerWeek: "6.75", ownerUserId: actorUser2.id },
      { origin: "Pittsburgh", originState: "PA", destination: "Cleveland", destinationState: "OH", equipmentType: "Flatbed", avgLoadsPerWeek: "4.00", ownerUserId: actorUser.id },
      { origin: "Denver", originState: "CO", destination: "Phoenix", destinationState: "AZ", equipmentType: "Flatbed", avgLoadsPerWeek: "3.50", ownerUserId: actorUser2.id },
      { origin: "Seattle", originState: "WA", destination: "Los Angeles", destinationState: "CA", equipmentType: "Reefer", avgLoadsPerWeek: "9.00", ownerUserId: actorUser.id },
      { origin: "Memphis", originState: "TN", destination: "Dallas", destinationState: "TX", equipmentType: "Dry Van", avgLoadsPerWeek: "7.25", ownerUserId: actorUser2.id },
    ];

    const insertedLanes = [];
    for (const ld of laneDefs) {
      const [lane] = await db.insert(recurringLanes).values({
        orgId: org.id,
        origin: ld.origin,
        originState: ld.originState,
        destination: ld.destination,
        destinationState: ld.destinationState,
        equipmentType: ld.equipmentType,
        avgLoadsPerWeek: ld.avgLoadsPerWeek,
        isEligible: true,
        hasPreferredCarrierProgram: false,
        ownerUserId: ld.ownerUserId,
        carriersContactedCount: 0,
        eligibilityConfidence: "high",
        isManual: false,
      }).returning();
      insertedLanes.push(lane);
      console.log(`  ✓ ${lane.origin}, ${lane.originState} → ${lane.destination}, ${lane.destinationState} (${lane.equipmentType})`);
    }

    console.log("\nStep 4: Creating outreach logs & email communications…");

    const emailDefs = [
      {
        carrierName: "Apex Road Freight",
        laneIdx: 1,
        actor: actorUser,
        threads: [
          {
            threadId: "thread-apex-nashville-atl-001",
            subject: "Capacity Inquiry: Nashville, TN → Atlanta, GA (Dry Van)",
            messages: [
              { direction: "outbound", from: actorUser.username, to: "dispatch@apexroadfreight.com", body: "Hi Tom,\n\nWe have a recurring dry van lane from Nashville to Atlanta running about 5 loads/week. Would Apex Road Freight be interested in quoting on this? We're looking for consistent coverage starting next month.\n\nLet me know your availability and rate.\n\nBest regards", daysAgo: 12, intentType: null, actorType: null },
              { direction: "inbound", from: "tom@apexroadfreight.com", to: actorUser.username, body: "Hey there,\n\nAbsolutely — Nashville to Atlanta is one of our core lanes. We run it daily. We can commit to 3-4 loads per week right now and scale up to 5 if volume is consistent.\n\nOur rate would be $1,850 all-in per load. Happy to discuss.\n\nTom Bradley\nApex Road Freight", daysAgo: 11, intentType: "capacity_available", actorType: "carrier" },
              { direction: "outbound", from: actorUser.username, to: "tom@apexroadfreight.com", body: "Tom,\n\nThanks for the quick response. $1,850 is above our target — we're looking at $1,650-$1,700 range for this lane. Can you sharpen the pencil a bit?\n\nVolume is very consistent, 50+ loads/month.", daysAgo: 10, intentType: null, actorType: null },
              { direction: "inbound", from: "tom@apexroadfreight.com", to: actorUser.username, body: "I hear you. Best I can do is $1,725 if we can lock in a 3-month commitment with minimum 12 loads/month. That's below our posted rate but the volume makes it work.\n\nLet me know.\n\nTom", daysAgo: 9, intentType: "soft_commitment", actorType: "carrier" },
            ],
            waitingState: "waiting_on_us",
            responsePriority: "high",
          },
        ],
        interestStatus: "available_now",
        replySnippet: "Can commit 3-4 loads/week at $1,725 with 3-month min",
        fitScore: 92,
        fitReason: "Core lane match, daily capacity, competitive rate after negotiation",
      },
      {
        carrierName: "Blue Ridge Logistics",
        laneIdx: 3,
        actor: actorUser2,
        threads: [
          {
            threadId: "thread-blueridge-clt-mia-001",
            subject: "Reefer Capacity: Charlotte, NC → Miami, FL",
            messages: [
              { direction: "outbound", from: actorUser2.username, to: "dispatch@blueridgelog.com", body: "Hi Marcus,\n\nWe're looking for reefer carriers on our Charlotte to Miami lane. About 7 loads/week, temp-controlled produce. Is Blue Ridge interested?\n\nThanks", daysAgo: 8, intentType: null, actorType: null },
              { direction: "inbound", from: "marcus@blueridgelog.com", to: actorUser2.username, body: "Yes we're very interested. We have 8 reefers that run the I-95 corridor weekly. Charlotte to Miami is a lane we want to grow.\n\nWhat temp requirements? We can do multi-temp if needed. Our rate for that lane is $2,400 for single-temp reefer.\n\nMarcus", daysAgo: 7, intentType: "capacity_available", actorType: "carrier" },
              { direction: "outbound", from: actorUser2.username, to: "marcus@blueridgelog.com", body: "Marcus,\n\nSingle temp, 34°F. Rate is a bit high — market is closer to $2,100-$2,200 on this lane right now. Can you work with us on price?\n\nAlso need to confirm your reefer units have real-time temp monitoring.", daysAgo: 6, intentType: null, actorType: null },
              { direction: "inbound", from: "marcus@blueridgelog.com", to: actorUser2.username, body: "All our reefers have real-time temp monitoring via Carrier Transicold with TempTale data loggers.\n\nI can come down to $2,200 if we get at least 3 loads/week guaranteed. Below that I can't justify repositioning trucks.\n\nMarcus", daysAgo: 5, intentType: "soft_commitment", actorType: "carrier" },
            ],
            waitingState: "waiting_on_us",
            responsePriority: "normal",
          },
        ],
        interestStatus: "available_now",
        replySnippet: "Can do $2,200/load at 3/week min, all reefers have temp monitoring",
        fitScore: 88,
        fitReason: "Strong reefer fleet, I-95 corridor expertise, competitive after negotiation",
      },
      {
        carrierName: "Midwest Express Carriers",
        laneIdx: 0,
        actor: actorUser,
        threads: [
          {
            threadId: "thread-midwest-chi-indy-001",
            subject: "Re: Chicago → Indianapolis Dry Van — Volume Increase",
            messages: [
              { direction: "outbound", from: actorUser.username, to: "loads@midwestexpress.com", body: "Lisa,\n\nWe're ramping volume on the Chicago-Indianapolis lane to 8-9 loads/week starting next month. Can Midwest Express handle the increase at current rates?\n\nWe'd also like to discuss a dedicated truck option.", daysAgo: 15, intentType: null, actorType: null },
              { direction: "inbound", from: "lisa@midwestexpress.com", to: actorUser.username, body: "Hi,\n\nYes, we can absolutely handle the volume increase. We already run this lane daily and have capacity to spare.\n\nFor a dedicated truck, we'd need a 5-day/week minimum commitment. Rate would be $1,450/load for dedicated vs. $1,550 spot.\n\nLet me know how you'd like to proceed.\n\nLisa Chen\nMidwest Express Carriers", daysAgo: 14, intentType: "hard_commitment", actorType: "carrier" },
              { direction: "outbound", from: actorUser.username, to: "lisa@midwestexpress.com", body: "Lisa,\n\nLet's go with the dedicated truck at $1,450. I'll send over the commitment letter this week. Start date March 1.\n\nAppreciate the partnership.", daysAgo: 13, intentType: null, actorType: null },
              { direction: "inbound", from: "lisa@midwestexpress.com", to: actorUser.username, body: "Perfect — we'll have a truck assigned and driver selected by Feb 25. I'll send you the driver info and tracking setup details.\n\nLooking forward to it.\n\nLisa", daysAgo: 12, intentType: "hard_commitment", actorType: "carrier" },
            ],
            waitingState: "waiting_on_them",
            responsePriority: "low",
          },
        ],
        interestStatus: "available_now",
        replySnippet: "Committed to dedicated truck at $1,450/load, 5 days/week",
        fitScore: 96,
        fitReason: "Existing relationship, dedicated capacity confirmed, best rate in market",
      },
      {
        carrierName: "Lone Star Hauling",
        laneIdx: 2,
        actor: actorUser2,
        threads: [
          {
            threadId: "thread-lonestar-dal-hou-001",
            subject: "Reefer Lanes: Dallas → Houston Corridor",
            messages: [
              { direction: "outbound", from: actorUser2.username, to: "dispatch@lonestarhauling.com", body: "Miguel,\n\nWe have 12 reefer loads/week on Dallas-Houston. Looking for 2-3 carriers to share the volume. Interested?\n\nRequirements: temp-controlled 35°F, 48-hour delivery window.", daysAgo: 20, intentType: null, actorType: null },
              { direction: "inbound", from: "miguel@lonestarhauling.com", to: actorUser2.username, body: "Hey,\n\nWe can take 4-5 loads/week on that lane no problem. We run Dallas-Houston every day already.\n\nRate: $1,200/load for reefer. We have 15 reefer units in the DFW area.\n\nMiguel Reyes\nLone Star Hauling", daysAgo: 19, intentType: "capacity_available", actorType: "carrier" },
              { direction: "outbound", from: actorUser2.username, to: "miguel@lonestarhauling.com", body: "Miguel,\n\n$1,200 works. Can we do a trial run of 5 loads next week to validate service levels before committing to ongoing volume?\n\nI'll send load details Monday.", daysAgo: 18, intentType: null, actorType: null },
              { direction: "inbound", from: "miguel@lonestarhauling.com", to: actorUser2.username, body: "That works for us. Send over the load details when ready. We'll have drivers lined up.\n\nAlso, if you need hazmat loads on this corridor, we have 5 hazmat-endorsed drivers available.\n\nMiguel", daysAgo: 17, intentType: "hard_commitment", actorType: "carrier" },
              { direction: "outbound", from: actorUser2.username, to: "miguel@lonestarhauling.com", body: "Great news on hazmat — will definitely keep that in mind. Trial loads going out Monday. Details attached.\n\nThanks Miguel.", daysAgo: 16, intentType: null, actorType: null },
            ],
            waitingState: "resolved",
            responsePriority: "low",
          },
        ],
        interestStatus: "available_now",
        replySnippet: "Committed 4-5 loads/week at $1,200, hazmat drivers available",
        fitScore: 94,
        fitReason: "Trial completed successfully, hazmat capability, excellent DFW presence",
      },
      {
        carrierName: "Pacific Northwest Freight",
        laneIdx: 6,
        actor: actorUser,
        threads: [
          {
            threadId: "thread-pnw-sea-la-001",
            subject: "Reefer Capacity: Seattle → Los Angeles",
            messages: [
              { direction: "outbound", from: actorUser.username, to: "loads@pnwfreight.com", body: "Chris,\n\nWe need reliable reefer capacity on Seattle to LA — about 9 loads/week for produce season. PNW Freight came highly recommended.\n\nWhat can you offer?", daysAgo: 7, intentType: null, actorType: null },
              { direction: "inbound", from: "chris@pnwfreight.com", to: actorUser.username, body: "Hi,\n\nSeattle-LA is our bread and butter lane. We can handle 5-6 loads/week right now. During produce season (April-September) we can scale to 8-9.\n\nRate: $3,200/load for continuous temp reefer with real-time monitoring. All units are 2022 or newer.\n\nChris Olson\nPNW Freight", daysAgo: 6, intentType: "capacity_available", actorType: "carrier" },
              { direction: "outbound", from: actorUser.username, to: "chris@pnwfreight.com", body: "Chris,\n\n$3,200 is steep. We're seeing $2,800-$2,900 on this lane from other carriers. Any room to come down?\n\nWe can offer consistency — this is a year-round lane, not just seasonal.", daysAgo: 5, intentType: null, actorType: null },
              { direction: "inbound", from: "chris@pnwfreight.com", to: actorUser.username, body: "I understand the market comparison, but our service level is premium — 99.2% on-time, real-time temp monitoring with alerts, and we carry $2M cargo insurance specifically for produce.\n\nBest I can do is $3,050 for a year-round commitment of 5+ loads/week. During peak season surcharges would be waived.\n\nChris", daysAgo: 4, intentType: "price_pushback", actorType: "carrier" },
            ],
            waitingState: "waiting_on_us",
            responsePriority: "high",
          },
        ],
        interestStatus: "available_next_week",
        replySnippet: "$3,050/load for year-round, peak surcharges waived, premium service",
        fitScore: 85,
        fitReason: "Premium reefer service, strong on-time record, but rate is above market",
      },
      {
        carrierName: "Iron Horse Logistics",
        laneIdx: 4,
        actor: actorUser,
        threads: [
          {
            threadId: "thread-ironhorse-pit-cle-001",
            subject: "Flatbed Capacity: Pittsburgh → Cleveland (Steel Coils)",
            messages: [
              { direction: "outbound", from: actorUser.username, to: "dispatch@ironhorselogistics.com", body: "Mike,\n\nWe need flatbed carriers for steel coil loads from Pittsburgh to Cleveland. About 4 loads/week, 42k-44k lbs per load. Coil racks required.\n\nCan Iron Horse handle this?", daysAgo: 25, intentType: null, actorType: null },
              { direction: "inbound", from: "mike@ironhorselogistics.com", to: actorUser.username, body: "Steel coils is what we do. We have coil racks on every flatbed and our drivers are trained for steel securement.\n\n4 loads/week is no problem. Rate: $1,650/load. We also have overweight permits for PA and OH if any loads go over 44k.\n\nMike Kowalski\nIron Horse Logistics", daysAgo: 24, intentType: "capacity_available", actorType: "carrier" },
              { direction: "outbound", from: actorUser.username, to: "mike@ironhorselogistics.com", body: "Mike,\n\nGood to know on overweight permits. Rate is acceptable. One concern — I see you're flagged in our system. Can you clarify the situation?\n\nNeed to resolve before we can commit loads.", daysAgo: 23, intentType: null, actorType: null },
              { direction: "inbound", from: "mike@ironhorselogistics.com", to: actorUser.username, body: "The flag was from a late delivery 3 months ago — we had a driver mechanical breakdown near Youngstown. We've since added a backup driver protocol for all Pittsburgh-Cleveland runs.\n\nHappy to provide our updated safety record and references from US Steel if that helps.\n\nMike", daysAgo: 22, intentType: "paperwork_compliance", actorType: "carrier" },
              { direction: "outbound", from: actorUser.username, to: "mike@ironhorselogistics.com", body: "Mike,\n\nPlease send over the safety record and references. If everything checks out, we'll start with a probationary 2-week trial.\n\nAppreciate the transparency.", daysAgo: 21, intentType: null, actorType: null },
            ],
            waitingState: "waiting_on_them",
            responsePriority: "normal",
          },
        ],
        interestStatus: "future_interest",
        replySnippet: "Can handle steel coils at $1,650, addressing flag with safety docs",
        fitScore: 72,
        fitReason: "Steel expertise and coil racks, but flagged status needs resolution",
      },
      {
        carrierName: "Summit Transport LLC",
        laneIdx: 5,
        actor: actorUser2,
        threads: [
          {
            threadId: "thread-summit-den-phx-001",
            subject: "Flatbed Lanes: Denver → Phoenix",
            messages: [
              { direction: "outbound", from: actorUser2.username, to: "dispatch@summittransportllc.com", body: "Jake,\n\nWe have building materials moving Denver to Phoenix, about 3-4 flatbed loads/week. Is Summit Transport available for this lane?\n\nLoads are lumber and drywall, average 38k lbs.", daysAgo: 14, intentType: null, actorType: null },
              { direction: "inbound", from: "jake@summittransportllc.com", to: actorUser2.username, body: "Denver to Phoenix is one of our strongest lanes. We have 5 flatbeds that run this corridor weekly.\n\nRate: $2,100/load including tarping. We can start immediately.\n\nJake Morrison\nSummit Transport", daysAgo: 13, intentType: "capacity_available", actorType: "carrier" },
              { direction: "outbound", from: actorUser2.username, to: "jake@summittransportllc.com", body: "Jake,\n\nRate is right in our budget. Let's do a 4-week trial starting next Monday. I'll send the first batch of load tenders Friday.\n\nDo your drivers have experience with oversize loads? We may have some 10-wide lumber loads occasionally.", daysAgo: 12, intentType: null, actorType: null },
              { direction: "inbound", from: "jake@summittransportllc.com", to: actorUser2.username, body: "Yes, we're certified for oversize loads up to 12' wide. We carry all necessary permits for CO, NM, and AZ.\n\nLooking forward to the trial. Send those tenders over when ready.\n\nJake", daysAgo: 11, intentType: "hard_commitment", actorType: "carrier" },
            ],
            waitingState: "resolved",
            responsePriority: "low",
          },
        ],
        interestStatus: "available_now",
        replySnippet: "$2,100/load with tarping, oversize certified, trial started",
        fitScore: 91,
        fitReason: "Mountain corridor specialist, oversize capable, rate within budget",
      },
      {
        carrierName: "Sunbelt Refrigerated",
        laneIdx: 1,
        actor: actorUser,
        threads: [
          {
            threadId: "thread-sunbelt-atl-001",
            subject: "Reefer Coverage Inquiry: Atlanta Hub Lanes",
            messages: [
              { direction: "outbound", from: actorUser.username, to: "dispatch@sunbeltreefer.com", body: "Hi Tamika,\n\nWe're expanding our reefer carrier network for Atlanta-origin lanes. Sunbelt Refrigerated was recommended by several shippers. Can we set up a call to discuss capacity?\n\nPrimary lanes of interest:\n- Atlanta → Miami (reefer)\n- Atlanta → Dallas (reefer)\n\nBoth are 5+ loads/week.", daysAgo: 5, intentType: null, actorType: null },
              { direction: "inbound", from: "tamika@sunbeltreefer.com", to: actorUser.username, body: "Thank you for reaching out. We'd love to discuss.\n\nAtlanta-Miami is a lane we run daily — we can take 4-5 loads/week easily. Atlanta-Dallas is newer for us but we have 6 trucks that run that corridor.\n\nRates:\n- ATL-MIA: $1,950/load\n- ATL-DAL: $2,650/load\n\nBoth include real-time temp monitoring and FSMA compliance documentation.\n\nI'm available for a call Tuesday or Wednesday afternoon.\n\nTamika Williams\nSunbelt Refrigerated", daysAgo: 4, intentType: "capacity_available", actorType: "carrier" },
            ],
            waitingState: "waiting_on_us",
            responsePriority: "normal",
          },
        ],
        interestStatus: "available_now",
        replySnippet: "ATL-MIA $1,950, ATL-DAL $2,650, FSMA compliant, call scheduled",
        fitScore: 87,
        fitReason: "Premium reefer fleet, FSMA compliant, strong Southeast presence",
      },
      {
        carrierName: "Tri-State Van Lines",
        laneIdx: 0,
        actor: actorUser,
        threads: [
          {
            threadId: "thread-tristate-northeast-001",
            subject: "Northeast Corridor Dry Van — New Carrier Inquiry",
            messages: [
              { direction: "outbound", from: actorUser.username, to: "dispatch@tristatevanlines.com", body: "Tony,\n\nWe're looking for liftgate-equipped dry van carriers in the Northeast corridor. Heard great things about Tri-State Van Lines.\n\nWe need coverage on Newark to Boston and Newark to Philly. Combined volume is about 10 loads/week.", daysAgo: 3, intentType: null, actorType: null },
              { direction: "inbound", from: "tony@tristatevanlines.com", to: actorUser.username, body: "Hey,\n\nThanks for the inquiry. Northeast corridor is our specialty — we know every dock in the tri-state area.\n\nNewark-Boston: $1,800/load (next-day guaranteed)\nNewark-Philly: $850/load (same-day available)\n\nEvery truck has a liftgate and pallet jack. We also handle residential deliveries if needed.\n\nLet me know if you want to set up a trial.\n\nTony Russo\nTri-State Van Lines", daysAgo: 2, intentType: "lane_offer", actorType: "carrier" },
            ],
            waitingState: "waiting_on_us",
            responsePriority: "high",
          },
        ],
        interestStatus: "available_now",
        replySnippet: "Newark-Boston $1,800 next-day, Newark-Philly $850 same-day, liftgate equipped",
        fitScore: 90,
        fitReason: "Northeast specialist, liftgate standard, competitive rates, same-day capable",
      },
      {
        carrierName: "Delta Freight Solutions",
        laneIdx: 7,
        actor: actorUser2,
        threads: [
          {
            threadId: "thread-delta-mem-dal-001",
            subject: "Memphis → Dallas Dry Van Capacity",
            messages: [
              { direction: "outbound", from: actorUser2.username, to: "dispatch@deltafreight.com", body: "Jerome,\n\nWe need dry van coverage on Memphis to Dallas — about 7 loads/week. Is Delta Freight available?\n\nAlso interested in your cross-dock capability for potential consolidation loads.", daysAgo: 10, intentType: null, actorType: null },
              { direction: "inbound", from: "jerome@deltafreight.com", to: actorUser2.username, body: "We can handle 5 loads/week on Memphis-Dallas right now. Working on adding more trucks to this lane.\n\nRate: $1,550/load dry van.\n\nFor cross-dock, our Memphis facility has 20 doors and we can turn loads in 4-6 hours. Cross-dock fee is $75/pallet.\n\nJerome Washington\nDelta Freight Solutions", daysAgo: 9, intentType: "capacity_available", actorType: "carrier" },
              { direction: "outbound", from: actorUser2.username, to: "jerome@deltafreight.com", body: "Jerome,\n\nGood start — we need 7/week though. When can you scale to that volume?\n\n$1,550 is a bit high for this lane. We're targeting $1,400-$1,450. Can you work with that?", daysAgo: 8, intentType: null, actorType: null },
              { direction: "inbound", from: "jerome@deltafreight.com", to: actorUser2.username, body: "We can scale to 7/week by end of next month — I have 2 trucks being delivered.\n\nOn rate, $1,450 would work if we can get a 6-month commitment. Short-term I'd need to stay at $1,500 minimum.\n\nCross-dock is flexible — we can bundle the pricing if you're using both services.\n\nJerome", daysAgo: 7, intentType: "soft_commitment", actorType: "carrier" },
            ],
            waitingState: "waiting_on_us",
            responsePriority: "normal",
          },
        ],
        interestStatus: "available_next_week",
        replySnippet: "$1,450 with 6-month commitment, scaling to 7/week next month",
        fitScore: 79,
        fitReason: "Memphis hub advantage, cross-dock capability, but can't hit full volume yet",
      },
      {
        carrierName: "Coastal Carriers Group",
        laneIdx: 3,
        actor: actorUser2,
        threads: [
          {
            threadId: "thread-coastal-fl-001",
            subject: "Re: Florida Corridor Carrier Outreach",
            messages: [
              { direction: "outbound", from: actorUser2.username, to: "dispatch@coastalcarriers.com", body: "Carlos,\n\nWe're reaching out to carriers on the Charlotte-Miami reefer lane. Is Coastal Carriers still running this corridor?\n\nWe noticed you've been inactive in our system — wanted to check if your fleet is back in service.", daysAgo: 15, intentType: null, actorType: null },
              { direction: "inbound", from: "carlos@coastalcarriers.com", to: actorUser2.username, body: "Thanks for reaching out. We've been dealing with some fleet maintenance issues — had to pull 8 trucks off the road for DOT compliance upgrades.\n\nWe expect to be back at full capacity by mid-April. I can't commit to regular volume right now but would love to revisit in a few weeks.\n\nCarlos Diaz\nCoastal Carriers Group", daysAgo: 14, intentType: "capacity_unavailable", actorType: "carrier" },
            ],
            waitingState: "waiting_on_them",
            responsePriority: "low",
          },
        ],
        interestStatus: "future_interest",
        replySnippet: "Fleet down for DOT compliance upgrades, back mid-April",
        fitScore: 55,
        fitReason: "Good corridor fit but currently inactive, revisit mid-April",
      },
      {
        carrierName: "Rocky Mountain Movers",
        laneIdx: 5,
        actor: actorUser2,
        threads: [
          {
            threadId: "thread-rocky-slc-den-001",
            subject: "Salt Lake City → Denver Dry Van",
            messages: [
              { direction: "outbound", from: actorUser2.username, to: "dispatch@rockymtnmovers.com", body: "Brett,\n\nWe have dry van loads from Salt Lake City to Denver. I see Rocky Mountain Movers is flagged in our system — can you provide context?", daysAgo: 18, intentType: null, actorType: null },
              { direction: "inbound", from: "brett@rockymtnmovers.com", to: actorUser2.username, body: "Yeah, we had a late delivery issue in January — weather-related chain delays on I-70. We've since started routing through I-80/I-25 during winter months to avoid the worst passes.\n\nWe can do SLC to Denver 3x/week at $1,900/load. All our drivers are mountain-certified with chains always on board.\n\nBrett Hansen", daysAgo: 17, intentType: "capacity_available", actorType: "carrier" },
              { direction: "outbound", from: actorUser2.username, to: "brett@rockymtnmovers.com", body: "Brett,\n\n$1,900 seems high for 300 miles. Market is $1,500-$1,600. I understand mountain lanes have a premium but that's a big gap.\n\nAlso, before we can proceed, I'll need your updated safety record and the alternate routing plan documented.", daysAgo: 16, intentType: null, actorType: null },
              { direction: "inbound", from: "brett@rockymtnmovers.com", to: actorUser2.username, body: "Fair point on the rate. I can come down to $1,700 — the mountain premium covers our winter equipment costs (chains, APUs, extra insurance).\n\nI'll have our safety manager send over the updated record and routing plan by end of week.\n\nBrett", daysAgo: 15, intentType: "price_pushback", actorType: "carrier" },
            ],
            waitingState: "waiting_on_them",
            responsePriority: "normal",
          },
        ],
        interestStatus: "future_interest",
        replySnippet: "$1,700/load, sending safety docs, mountain premium justified",
        fitScore: 65,
        fitReason: "Mountain expertise but flagged, rate above market, pending safety review",
      },
      {
        carrierName: "Southwest Xpress",
        laneIdx: 5,
        actor: actorUser2,
        threads: [
          {
            threadId: "thread-swx-phx-la-001",
            subject: "Phoenix → LA Dry Van — Ongoing Capacity",
            messages: [
              { direction: "outbound", from: actorUser2.username, to: "dispatch@southwestxpress.com", body: "Maria,\n\nWe have consistent dry van volume from Phoenix to LA and are building out our carrier network. Is Southwest Xpress interested?\n\nVolume: 5-6 loads/week year-round.", daysAgo: 6, intentType: null, actorType: null },
              { direction: "inbound", from: "maria@southwestxpress.com", to: actorUser2.username, body: "Phoenix to LA is our #1 lane. We have same-day capacity most days.\n\nRate: $1,350/load dry van. We can commit to 4 loads/week guaranteed with overflow capacity available.\n\nAll trucks have APUs for California idling compliance.\n\nMaria Gutierrez\nSouthwest Xpress", daysAgo: 5, intentType: "capacity_available", actorType: "carrier" },
              { direction: "outbound", from: actorUser2.username, to: "maria@southwestxpress.com", body: "Maria,\n\n$1,350 is very competitive. Let's set up a trial for next week — 4 loads.\n\nCan you also quote Phoenix to El Paso? We have 2-3 loads/week on that lane too.", daysAgo: 4, intentType: null, actorType: null },
              { direction: "inbound", from: "maria@southwestxpress.com", to: actorUser2.username, body: "Phoenix to El Paso: $950/load dry van. We run that 3x/week already.\n\nTrial works for us — send load details when ready. Happy to bundle both lanes for simplified billing.\n\nMaria", daysAgo: 3, intentType: "lane_offer", actorType: "carrier" },
            ],
            waitingState: "resolved",
            responsePriority: "low",
          },
        ],
        interestStatus: "available_now",
        replySnippet: "PHX-LA $1,350, PHX-ElPaso $950, trial confirmed, APU compliant",
        fitScore: 93,
        fitReason: "Best rate on PHX-LA, same-day capable, multi-lane opportunity",
      },
    ];

    let totalOutreachLogs = 0;
    let totalEmailMessages = 0;
    let totalEmailSignals = 0;
    let totalThreads = 0;
    let totalBenchEntries = 0;

    for (const eDef of emailDefs) {
      const carrier = carrierByName[eDef.carrierName];
      if (!carrier) {
        console.log(`  ⚠ Carrier "${eDef.carrierName}" not found — skipping`);
        continue;
      }

      const lane = insertedLanes[eDef.laneIdx];
      if (!lane) {
        console.log(`  ⚠ Lane index ${eDef.laneIdx} not found — skipping`);
        continue;
      }

      const [outreachLog] = await db.insert(carrierOutreachLogs).values({
        orgId: org.id,
        laneId: lane.id,
        carrierIds: [carrier.id],
        carrierNames: [carrier.name],
        actorUserId: eDef.actor.id,
        ownerUserId: lane.ownerUserId,
        outreachMode: "lane_building",
        deliveryStatus: "sent",
        sentAt: new Date(Date.now() - eDef.threads[0].messages[0].daysAgo * 86400000),
        recipients: [{ carrierId: carrier.id, carrierName: carrier.name, email: carrier.primaryEmail, status: "sent" }],
        subject: eDef.threads[0].subject,
        direction: "outbound",
        fromEmail: eDef.actor.username,
        toEmail: carrier.primaryEmail,
      }).returning();
      totalOutreachLogs++;

      for (const thread of eDef.threads) {
        let lastMsgId: string | null = null;

        for (const msg of thread.messages) {
          const msgDate = new Date(Date.now() - msg.daysAgo * 86400000);

          const [emailMsg] = await db.insert(emailMessages).values({
            orgId: org.id,
            threadId: thread.threadId,
            direction: msg.direction,
            fromEmail: msg.from,
            toEmail: msg.to,
            subject: thread.subject,
            body: msg.body,
            linkedCarrierId: carrier.id,
            linkedLaneId: lane.id,
            linkedOutreachLogId: outreachLog.id,
            createdAt: msgDate,
          }).returning();
          lastMsgId = emailMsg.id;
          totalEmailMessages++;

          if (msg.intentType && msg.actorType) {
            await db.insert(emailSignals).values({
              messageId: emailMsg.id,
              intentType: msg.intentType,
              actorType: msg.actorType,
              confidence: msg.intentType === "hard_commitment" ? 95 : msg.intentType === "soft_commitment" ? 80 : msg.intentType === "capacity_available" ? 85 : msg.intentType === "price_pushback" ? 75 : 70,
              linkedCarrierId: carrier.id,
              linkedLaneId: lane.id,
              extractedData: { carrierName: carrier.name, lane: `${lane.origin} → ${lane.destination}` },
            });
            totalEmailSignals++;
          }
        }

        await db.insert(emailConversationThreads).values({
          orgId: org.id,
          threadId: thread.threadId,
          linkedCarrierId: carrier.id,
          ownerUserId: eDef.actor.id,
          waitingState: thread.waitingState,
          responsePriority: thread.responsePriority,
          lastMessageId: lastMsgId,
          lastIncomingAt: thread.messages.filter(m => m.direction === "inbound").length > 0
            ? new Date(Date.now() - thread.messages.filter(m => m.direction === "inbound").slice(-1)[0].daysAgo * 86400000)
            : null,
          lastOutgoingAt: thread.messages.filter(m => m.direction === "outbound").length > 0
            ? new Date(Date.now() - thread.messages.filter(m => m.direction === "outbound").slice(-1)[0].daysAgo * 86400000)
            : null,
        });
        totalThreads++;
      }

      await db.insert(laneCarrierInterest).values({
        laneId: lane.id,
        carrierId: carrier.id,
        carrierName: carrier.name,
        interestStatus: eDef.interestStatus,
        replySnippet: eDef.replySnippet,
        fitScore: eDef.fitScore,
        fitReason: eDef.fitReason,
        sourceType: "suggested",
        outreachSentAt: new Date(Date.now() - eDef.threads[0].messages[0].daysAgo * 86400000).toISOString(),
      });
      totalBenchEntries++;

      await db.update(recurringLanes).set({
        carriersContactedCount: (lane.carriersContactedCount ?? 0) + 1,
      }).where(eq(recurringLanes.id, lane.id));

      console.log(`  ✓ ${carrier.name}: ${eDef.threads[0].messages.length} emails, status=${eDef.interestStatus}`);
    }

    console.log(`\n=== Summary ===`);
    console.log(`  Carriers:           ${carrierDefs.length}`);
    console.log(`  Contacts:           ${totalContacts}`);
    console.log(`  Claimed Lanes:      ${totalLanes}`);
    console.log(`  Recurring Lanes:    ${insertedLanes.length}`);
    console.log(`  Outreach Logs:      ${totalOutreachLogs}`);
    console.log(`  Email Messages:     ${totalEmailMessages}`);
    console.log(`  Email Signals:      ${totalEmailSignals}`);
    console.log(`  Conv. Threads:      ${totalThreads}`);
    console.log(`  Bench Entries:      ${totalBenchEntries}`);
    console.log(`  Statuses:           ${[...new Set(carrierDefs.map(d => d.status))].join(", ")}`);
    console.log(`  Equipment:          ${[...new Set(carrierDefs.flatMap(d => d.equipmentTypes))].join(", ")}`);
    console.log(`\n=== Carrier seed completed successfully ===\n`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error("\n[SEED ERROR]", err.message ?? err);
  process.exit(1);
});
