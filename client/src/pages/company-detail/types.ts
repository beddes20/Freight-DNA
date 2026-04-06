import type { Touchpoint, Task } from "@shared/schema";

export interface ResearchTask {
  rfpId: string;
  rfpTitle: string;
  companyId: string;
  laneIndex: number;
  lane: string;
  laneId?: string;
  origin: string;
  destination: string;
  originState: string;
  destinationState: string;
  volume: number;
  rate: string;
  equipment?: string;
  status: string;
  contactId: string | null;
}

export interface Facility {
  facility: string;
  state: string;
  type: "origin" | "destination";
  totalVolume: number;
  laneCount: number;
  lanes: string[];
  rfpTitles: string[];
  fullName: string;
  covered: boolean;
  coveredBy: string | null;
}

export interface FacilityCoverage {
  facilities: Facility[];
  summary: { total: number; gaps: number; covered: number };
}

export interface Corridor {
  origin: string;
  originState: string;
  destination: string;
  destinationState: string;
  totalVolume: number;
  count: number;
  rfpTitles: string[];
  lane: string;
  appearsInMultipleRfps: boolean;
}

export interface Hub {
  facility: string;
  state: string;
  inboundVolume: number;
  outboundVolume: number;
  inboundCount: number;
  outboundCount: number;
  fullName: string;
  totalVolume: number;
}

export interface StateCorridor {
  originState: string;
  destinationState: string;
  totalVolume: number;
  laneCount: number;
  corridor: string;
}

export interface LanePatterns {
  topCorridors: Corridor[];
  hubs: Hub[];
  stateCorridors: StateCorridor[];
}

export interface LaneMatch {
  ourCity: string;
  ourState: string;
  ourWeeklyLoads: number;
  ourTotalLoads: number;
  customerCity: string;
  customerState: string;
  distance: number;
  totalVolume: number;
  matchingLanes: Array<{ rfpTitle: string; rfpId: string; lane: string; volume: number }>;
}

export interface LaneMatching {
  ourDeliveriesToTheirPickups: LaneMatch[];
  theirDeliveriesToOurPickups: LaneMatch[];
  hasHistoricalData: boolean;
  hasRfpData: boolean;
}

export type TouchLogEntry = Touchpoint & { loggedByName: string; contactName: string | null };
export type MonthBucket = { totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue?: number };
export type HealthFactor = { name: string; score: number; max: number; label: string };
export type HealthScore = { score: number; grade: string; color: string; momentum: "up" | "flat" | "down"; momentumLabel: string; factors: HealthFactor[] };
export type TrendMonth = { monthKey: string; totalLoads: number; spotLoads: number; totalMargin: number };
export type TrendDest = { city: string; state: string; count: number };
export type TrendCorridor = { origin: string; destination: string; loads: number };
export type TrendsData = { months: TrendMonth[]; topDestinations: TrendDest[]; topCorridors: TrendCorridor[]; totalLoads: number; spotLoads: number; totalMargin: number };
export type SharedRepEntry = { userId: string; territoryNote: string; name: string };
export type TaskWithCount = Task & { commentCount?: number };

export type AccountPerf = {
  ytd: MonthBucket;
  lastMonth: MonthBucket;
  thisMonth: MonthBucket;
  lastMonthKey: string;
  thisMonthKey: string;
} | null | undefined;
