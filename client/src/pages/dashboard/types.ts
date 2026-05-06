import type { User, FeedPost } from "@shared/schema";

export type SafeUser = Omit<User, "password">;
export type FeedPostWithReplies = FeedPost & { replies: FeedPost[] };

export type ActionItem = {
  id: string; text: string; tag: string; status: string; createdAt: string;
  sessionId: string; addedById: string; namId: string; amId: string;
  withUserName: string; addedByName: string;
};
export type TrendingAccount = { name: string; delta: number; isNew?: boolean; companyId?: string };
export type TrendingResponse = { up: TrendingAccount[]; down: TrendingAccount[]; monthFraction?: number; isPartialMonth?: boolean; curMonthLabel?: string };
export type StaleAccount = { id: string; name: string; daysSince: number };
export type TodaysFiveItem = { id: string; name: string; daysSince: number | null; openTasks: number; hasUrgentRfp: boolean; score: number; reasons: string[] };
export type AmRow = { id: string; name: string; touchesWeek: number; touchesMonth: number; coldAccounts: number; openTasks: number; companyCount: number; goalPct: number | null; goalTarget: number | null };
export type TeamActivity = { touches: number; meaningful: number; newContacts: number };
export type RelationshipsMovedData = { count: number };
export type MarginUserMetric = {
  userId: string; name: string; role: string; margin: number;
  goal: { id: string; target: number } | null;
};
export type MarginMetrics = { nams: MarginUserMetric[]; ams: MarginUserMetric[] };
export type PersonalMetrics = { relationshipsMovedThisMonth: number; meaningfulToday: number; contactsAddedToday: number; touchesToday: number };
export type WeeklyRep = { userId: string; name: string; total: number; call: number; email: number; text: number; site_visit: number; meaningful: number };
export type OpportunityLog = { id: string; repId: string; companyId: string | null; type: string; category: string; title: string; description: string | null; estimatedLoads: number | null; estimatedValue: string | null; loggedAt: string; createdAt: string };
