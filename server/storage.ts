import { eq, inArray, ilike, or, and, asc, desc, isNull, isNotNull, gte, lte, lt, sql, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { cacheGet, cacheSet, cacheInvalidatePrefix } from "./cache";
import { assertNotFixtureEmail, isFixtureMailboxAddress } from "./lib/fixtureMailboxes";
import {
  users,
  companies,
  organizations,
  contacts,
  rfps,
  awards,
  marketShareEntries,
  financialUploads,
  appSettings,
  tasks,
  callouts,
  feedPosts,
  calloutReactions,
  feedPostReactions,
  oneOnOneSessions,
  oneOnOneTopics,
  oneOnOneTopicReplies,
  goals,
  goalComments,
  touchpoints,
  internalPosts,
  passwordResetTokens,
  laneCarriers,
  type Organization,
  type User,
  type InsertUser,
  type Company,
  type InsertCompany,
  type Contact,
  type InsertContact,
  type Rfp,
  type InsertRfp,
  type Award,
  type InsertAward,
  type FinancialUpload,
  type InsertFinancialUpload,
  type Task,
  type InsertTask,
  type Callout,
  type InsertCallout,
  type FeedPost,
  type InsertFeedPost,
  type CalloutReaction,
  type FeedPostReaction,
  type OneOnOneSession,
  type InsertOneOnOneSession,
  type OneOnOneTopic,
  type InsertOneOnOneTopic,
  type OneOnOneTopicReply,
  type InsertOneOnOneTopicReply,
  type Notification,
  type InsertNotification,
  notifications,
  type Goal,
  type InsertGoal,
  type GoalComment,
  type InsertGoalComment,
  type Touchpoint,
  type InsertTouchpoint,
  attachments,
  type Attachment,
  type InsertAttachment,
  personalAlerts,
  type PersonalAlert,
  type InsertPersonalAlert,
  vendorRouted,
  type VendorRouted,
  ptoPassoffs,
  type PtoPassoff,
  type InsertPtoPassoff,
  ptoPassoffItems,
  type PtoPassoffItem,
  type InsertPtoPassoffItem,
  taskComments,
  type TaskComment,
  type InsertTaskComment,
  type MarketShareEntry,
  type InsertMarketShareEntry,
  reportCardSnapshots,
  type ReportCardSnapshot,
  type InsertReportCardSnapshot,
  promotionCriteria,
  type PromotionCriteria,
  type InsertPromotionCriteria,
  promotionNominations,
  type PromotionNomination,
  type InsertPromotionNomination,
  developmentGoals,
  type DevelopmentGoal,
  type InsertDevelopmentGoal,
  toolLinks,
  type ToolLink,
  type InsertToolLink,
  lmDailyChecks,
  type LmDailyCheck,
  type InsertLmDailyCheck,
  opportunityLogs,
  type OpportunityLog,
  type InsertOpportunityLog,
  contactLaneAttributions,
  type ContactLaneAttribution,
  type InsertContactLaneAttribution,
  contactBaseHistory,
  type InternalPost,
  type LaneCarrier,
  type InsertLaneCarrier,
  nbaCards,
  type NbaCard,
  type InsertNbaCard,
  missedInboundCalls,
  type MissedInboundCall,
  type InsertMissedInboundCall,
  carriers,
  type Carrier,
  type InsertCarrier,
  carrierContacts,
  type CarrierContact,
  recurringLanes,
  type RecurringLane,
  type InsertRecurringLane,
  laneCarrierInterest,
  type LaneCarrierInterest,
  type InsertLaneCarrierInterest,
  carrierOutreachLogs,
  type CarrierOutreachLog,
  type InsertCarrierOutreachLog,
  featureFlags,
  sidebarTooltips,
  type SidebarTooltip,
  type FeatureFlag,
  carrierImportBatches,
  type CarrierImportBatch,
  type InsertCarrierImportBatch,
  laneCoverageProfiles,
  type LaneCoverageProfile,
  type InsertLaneCoverageProfile,
  laneCoverageProfileCarriers,
  type LaneCoverageProfileCarrier,
  type InsertLaneCoverageProfileCarrier,
  marketEvents,
  type MarketEvent,
  type InsertMarketEvent,
  marketSignals,
  type MarketSignal,
  type InsertMarketSignal,
  carrierMarketNbas,
  type CarrierMarketNba,
  type InsertCarrierMarketNba,
  carrierClaimedLanes,
  emailMessages,
  type EmailMessage,
  type InsertEmailMessage,
  emailSignals,
  type EmailSignal,
  type InsertEmailSignal,
  carrierEmailSuggestions,
  type CarrierEmailSuggestion,
  type InsertCarrierEmailSuggestion,
  carrierIntelSuggestions,
  type CarrierIntelSuggestion,
  type InsertCarrierIntelSuggestion,
  emailOutcomeLinks,
  type EmailOutcomeLink,
  type InsertEmailOutcomeLink,
  accountContactSuggestions,
  type AccountContactSuggestion,
  type InsertAccountContactSuggestion,
  laneSummaryCache,
  type LaneSummaryCache,
  type InsertLaneSummaryCache,
  emailConversationThreads,
  type EmailConversationThread,
  type InsertEmailConversationThread,
  emailConversationReadStates,
  type EmailConversationReadState,
  conversationSavedViews,
  type ConversationSavedView,
  type InsertConversationSavedView,
  geographicLanePatterns,
  type GeographicLanePattern,
  type InsertGeographicLanePattern,
  accountContactLanePatternResponsibilities,
  type AccountContactLanePatternResponsibility,
  type InsertAccountContactLanePatternResponsibility,
  pinnedCompanies,
  type PinnedCompany,
  contactGeographySuggestions,
  type ContactGeographySuggestion,
  type InsertContactGeographySuggestion,
  monitoredMailboxes,
  cronHeartbeats,
  type CronHeartbeat,
  type MonitoredMailbox,
  type InsertMonitoredMailbox,
  mailboxSyncFailures,
  type MailboxSyncFailure,
  type InsertMailboxSyncFailure,
  mailboxHealthAlerts,
  type MailboxHealthAlert,
  type InsertMailboxHealthAlert,
  mailboxHistoricalBackfills,
  type MailboxHistoricalBackfill,
  type InsertMailboxHistoricalBackfill,
  podIntakeEmails,
  podIntakeSettings,
  type PodIntakeEmail,
  type InsertPodIntakeEmail,
  type PodIntakeSettings,
  type InsertPodIntakeSettings,
  webexUserMappings,
  type WebexUserMapping,
  type InsertWebexUserMapping,
  webexUserTokens,
  type WebexUserToken,
  type InsertWebexUserToken,
  webexCallAnalytics,
  type WebexCallAnalytics,
  type InsertWebexCallAnalytics,
  webexSyncState,
  type WebexSyncState,
  type InsertWebexSyncState,
  webexCallEnrichmentJobs,
  type WebexCallEnrichmentJob,
  type InsertWebexCallEnrichmentJob,
  webexVoicemails,
  type WebexVoicemail,
  type InsertWebexVoicemail,
  webexInventory,
  type WebexInventory,
  type InsertWebexInventory,
  webexWebhookSubscriptions,
  type WebexWebhookSubscription,
  type InsertWebexWebhookSubscription,
  webexWebhookEvents,
  type WebexWebhookEvent,
  type InsertWebexWebhookEvent,
  apiResponseCache,
  type ApiResponseCache,
  accountReviews,
  type AccountReview,
  type InsertAccountReview,
  freightOpportunities,
  type FreightOpportunity,
  type InsertFreightOpportunity,
  freightOpportunityCarriers,
  type FreightOpportunityCarrier,
  type InsertFreightOpportunityCarrier,
  companyOutreachPolicies,
  type CompanyOutreachPolicy,
  type InsertCompanyOutreachPolicy,
  freightOpportunityResponses,
  type FreightOpportunityResponse,
  type InsertFreightOpportunityResponse,
  freightOpportunityAudit,
  type FreightOpportunityAudit,
  type InsertFreightOpportunityAudit,
  freightOutreachTemplates,
  type FreightOutreachTemplate,
  type InsertFreightOutreachTemplate,
  type FreightOutreachTemplateKind,
  freightOpportunitySavedViews,
  type FreightOpportunitySavedView,
  type InsertFreightOpportunitySavedView,
  userFreightCockpitPrefs,
  type UserFreightCockpitPrefs,
  type InsertUserFreightCockpitPrefs,
  userLaneInboxPrefs,
  type UserLaneInboxPrefs,
  type InsertUserLaneInboxPrefs,
  nbaCardEvents,
  type NbaCardEvent,
  type InsertNbaCardEvent,
  nbaCardOutcomes,
  type NbaCardOutcome,
  type InsertNbaCardOutcome,
  companyCollaborators,
  type CompanyCollaborator,
  type InsertCompanyCollaborator,
  truckPostings,
  type TruckPosting,
  type InsertTruckPosting,
  truckLoadMatches,
  type TruckLoadMatch,
  type InsertTruckLoadMatch,
  type TruckLoadMatchState,
} from "@shared/schema";
import { getStuckRunningThresholdMs } from "./lib/cronHeartbeat";

const { Pool } = pg;

export type ContactBaseHistoryRow = {
  id: number;
  fromBase: string | null;
  toBase: string;
  changedAt: Date | null;
  changedByName: string | null;
};

/**
 * Configurable daily email budget per carrier (cross-lane).
 * Change these constants to tune throttling without a code change.
 */
export const CARRIER_DAILY_BUDGET_CONFIG = {
  /** Maximum emails a single carrier can receive across all lanes in one calendar day. */
  dailyCap: 5,
  /** Minimum gap in hours between any two emails sent to the same carrier. */
  minGapHours: 4,
} as const;

export type CarrierDailyBudgetResult =
  | { allowed: true }
  | { allowed: false; reason: "daily_cap"; message: string; sentToday: number; cap: number }
  | { allowed: false; reason: "too_soon"; message: string; nextAvailableAt: Date; minGapHours: number };

export interface TeamMemberSummary {
  id: string;
  name: string;
  role: string;
  touchpoints: number;
  newContacts: number;
  tasks: { completed: number; open: number; overdue: number };
  goalsAvgPct: number;
  hasActiveGoals: boolean;
  accountsNeedingAttention: number;
}

export interface RepReportData {
  rep: { id: string; name: string; role: string; manager: string | null; director: string | null; createdAt: string | null; financialRepId: string | null };
  period: { type: string; label: string; start: string; end: string };
  goals: Array<{ id: string; label: string; metric: string; period: string; current: number; target: number; pct: number }>;
  touchpoints: { total: number; call: number; email: number; text: number; site_visit: number; meaningful: number; weeklyTrend: number[] };
  contacts: { newThisPeriod: number; contactsTouched: number };
  tasks: { completed: number; open: number; overdue: number };
  topAccounts: Array<{ name: string; touches: number; lastTouch: string }>;
  accountsNeedingAttention: number;
  wins: Array<{ id: string; text: string; category: string }>;
  teamMembers: TeamMemberSummary[];
}

export interface LaneReplySummary {
  totalReplied: number;       // carriers with interestStatus != 'needs_follow_up'
  hotCount: number;           // carriers with available_now | available_next_week
  topStatus: string | null;   // highest-priority status among replied carriers
  topCarrierName: string | null;
  needsAction: boolean;       // true when hotCount > 0 AND no open follow-up task exists for this lane
}

export interface LaneWorkQueueItem {
  lane: RecurringLane & { ownerName: string | null };
  contactableCount: number;   // carriers with phone or email in catalog
  totalBenchCount: number;    // all bench entries
  historicalCount: number;    // bench entries where sourceType = 'historical'
  missingContactCount: number; // historical carriers with no phone/email
  replySummary: LaneReplySummary;
}

export interface LaneWorkQueueResult {
  unassigned: LaneWorkQueueItem[];           // isEligible, ownerUserId IS NULL
  noContactable: LaneWorkQueueItem[];        // isEligible, assigned, 0 contactable carriers
  assignedUntouched: LaneWorkQueueItem[];    // isEligible, assigned, carriersContactedCount = 0
  inProgress: LaneWorkQueueItem[];           // 0 < carriersContactedCount < threshold
}

// Lean item sourced from lane_summary_cache — no replySummary, no full lane object
export interface LeanLaneQueueItem {
  laneId: string;
  laneScore: number | null;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  avgLoadsPerWeek: string | null;
  companyId: string | null;
  companyName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  carriersContactedCount: number;
  contactableCount: number;
  totalBenchCount: number;
  historicalCount: number;
  missingContactCount: number;
  dropTrailerShipper: boolean;
  dropTrailerReceiver: boolean;
  isManual: boolean;
}

export interface LeanLaneWorkQueueResult {
  unassigned: LeanLaneQueueItem[];
  noContactable: LeanLaneQueueItem[];
  assignedUntouched: LeanLaneQueueItem[];
  inProgress: LeanLaneQueueItem[];
}

export interface CarrierImportResult {
  carrier: Carrier;
  status: "new" | "matched";
  matchType?: "email_exact" | "mc_exact" | "name_fuzzy";
  addedToBench: boolean;
}

export interface CarrierSourcingChannel {
  sourceChannel: string;
  label: string;
  carriersImported: number;
  outreached: number;
  responded: number;
  responseRate: number;
}

export interface IStorage {
  getDefaultOrganization(): Promise<Organization | undefined>;
  getOrganizations(): Promise<Organization[]>;
  getOrganizationById(id: string): Promise<Organization | undefined>;
  createOrganization(data: { name: string; slug: string }): Promise<Organization>;

  /** Auth-only lookup by PK — trusted IDs only (session, FK chains). No org filter. */
  getUser(id: string): Promise<User | undefined>;
  /** Phase 5 (Task #425) — strict org-scoped lookup for analytics. Returns
   * undefined if the user is in a different organization. Use this for any
   * cross-user analytics endpoint to prevent IDOR-style data leaks. */
  getUserInOrg(id: string, organizationId: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByClerkId(clerkUserId: string): Promise<User | undefined>;
  createPasswordResetToken(userId: string, token: string, expiresAt: string): Promise<void>;
  getPasswordResetToken(token: string): Promise<{ userId: string; expiresAt: string } | undefined>;
  deletePasswordResetTokensByUser(userId: string): Promise<void>;
  getUsers(organizationId: string): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  /** Route-level update — scoped to org to prevent cross-tenant writes. */
  updateUser(id: string, organizationId: string, data: Partial<InsertUser>): Promise<User | undefined>;
  /** Route-level delete — scoped to org to prevent cross-tenant deletes. */
  deleteUser(id: string, organizationId: string): Promise<boolean>;
  /** Org-scoped team traversal — organizationId is mandatory. */
  getTeamMemberIds(userId: string, organizationId: string): Promise<string[]>;
  /** Walk the managerId chain upward, returning all ancestor manager IDs. */
  getManagerChainIds(userId: string, organizationId: string): Promise<string[]>;
  /**
   * Returns true if assigning `newManagerId` as the manager of `userId` would
   * create a self-reference or a circular reporting loop (i.e. `newManagerId`
   * is `userId` itself, or its manager chain transitively passes through
   * `userId`). Walking is bounded so a pre-existing cycle in the data never
   * loops forever.
   */
  wouldCreateManagerCycle(userId: string, newManagerId: string, organizationId: string): Promise<boolean>;

  getCompanies(organizationId: string): Promise<Company[]>;
  getCompaniesByIds(ids: string[], organizationId: string): Promise<Company[]>;
  /** Auth-only / FK-chain lookup by PK — trusted IDs only. No org filter. */
  getCompany(id: string): Promise<Company | undefined>;
  /** Route-level company lookup — scoped to org, returns undefined if not in org. */
  getCompanyInOrg(id: string, organizationId: string): Promise<Company | undefined>;
  createCompany(company: InsertCompany): Promise<Company>;
  bulkCreateCompanies(companiesList: InsertCompany[]): Promise<Company[]>;
  /** Route-level update — scoped to org to prevent cross-tenant writes. */
  updateCompany(id: string, organizationId: string, company: Partial<InsertCompany>): Promise<Company | undefined>;
  deleteCompany(id: string, organizationId: string): Promise<boolean>;
  archiveCompany(id: string, organizationId: string): Promise<Company | undefined>;
  unarchiveCompany(id: string, organizationId: string): Promise<Company | undefined>;
  // Account-level collaborators (manual visibility sharing)
  listCollaboratorsForCompany(companyId: string, organizationId: string): Promise<Array<CompanyCollaborator & { userName: string; userRole: string }>>;
  addCompanyCollaborator(input: InsertCompanyCollaborator): Promise<CompanyCollaborator>;
  removeCompanyCollaborator(companyId: string, userId: string, organizationId: string): Promise<boolean>;
  getCollaboratorCompanyIds(userId: string, organizationId: string): Promise<string[]>;
  getAccountsManageableForSharing(viewerId: string, viewerRole: string, organizationId: string): Promise<Company[]>;
  
  getContacts(): Promise<Contact[]>;
  /** Org-scoped: returns only contacts whose company belongs to the given org. */
  getContactsByOrg(organizationId: string): Promise<Contact[]>;
  getContactsByCompany(companyId: string): Promise<Contact[]>;
  getContactsByCompanyIds(companyIds: string[]): Promise<Contact[]>;
getContactsByIds(ids: string[]): Promise<Contact[]>;
  getContact(id: string): Promise<Contact | undefined>;
  logContactBaseHistory(contactId: string, fromBase: string | null, toBase: string, changedById: string): Promise<void>;
  getContactBaseHistory(contactId: string): Promise<ContactBaseHistoryRow[]>;
  createContact(contact: InsertContact): Promise<Contact>;
  bulkCreateContacts(contacts: InsertContact[]): Promise<Contact[]>;
  updateContact(id: string, contact: InsertContact): Promise<Contact | undefined>;
  deleteContact(id: string): Promise<boolean>;

  getLaneAttributionsByContact(contactId: string): Promise<ContactLaneAttribution[]>;
  getLaneAttributionsByCompany(companyId: string): Promise<ContactLaneAttribution[]>;
  getLaneAttributionsByCompanyIds(companyIds: string[]): Promise<ContactLaneAttribution[]>;
  createLaneAttribution(data: InsertContactLaneAttribution): Promise<ContactLaneAttribution>;
  deleteLaneAttribution(id: string): Promise<boolean>;
  
  getRfps(): Promise<Rfp[]>;
  /** Org-scoped: returns only RFPs whose company belongs to the given org. */
  getRfpsByOrg(organizationId: string): Promise<Rfp[]>;
  /** @deprecated Cross-tenant unsafe. Use getRfpInOrg(id, orgId) for any
   *  caller that derives orgId from the session — this returns rows
   *  regardless of organization and was the source of an IDOR fix-pack. */
  getRfp(id: string): Promise<Rfp | undefined>;
  /** Org-scoped RFP fetch. Joins through companies.organizationId since
   *  rfps has no orgId column directly. Returns undefined for cross-org IDs. */
  getRfpInOrg(id: string, orgId: string): Promise<Rfp | undefined>;
  /** Org-scoped: callers must validate `companyId` belongs to their org first
   *  (via getCompanyInOrg/canAccessCompany). Returns all RFPs for the company. */
  getRfpsByCompanyId(companyId: string): Promise<Rfp[]>;
  createRfp(rfp: InsertRfp): Promise<Rfp>;
  updateRfp(id: string, rfp: InsertRfp): Promise<Rfp | undefined>;
  deleteRfp(id: string): Promise<boolean>;

  getAwards(): Promise<Award[]>;
  /** Org-scoped: returns only awards whose company belongs to the given org. */
  getAwardsByOrg(organizationId: string): Promise<Award[]>;
  getAwardsByCompanyId(companyId: string): Promise<Award[]>;
  /** @deprecated Cross-tenant unsafe. Use getAwardInOrg(id, orgId). */
  getAward(id: string): Promise<Award | undefined>;
  /** Org-scoped award fetch via companies.organizationId join. */
  getAwardInOrg(id: string, orgId: string): Promise<Award | undefined>;
  createAward(award: InsertAward): Promise<Award>;
  updateAward(id: string, award: InsertAward): Promise<Award | undefined>;
  deleteAward(id: string): Promise<boolean>;

  getFinancialUploads(): Promise<FinancialUpload[]>;
  getFinancialUploadsForOrg(organizationId: string): Promise<FinancialUpload[]>;
  getLatestFinancialUpload(): Promise<FinancialUpload | undefined>;
  getLatestFinancialUploadForOrg(organizationId: string): Promise<FinancialUpload | undefined>;
  getFinancialUploadById(id: string): Promise<FinancialUpload | undefined>;
  createFinancialUpload(upload: InsertFinancialUpload): Promise<FinancialUpload>;
  deleteFinancialUpload(id: string): Promise<boolean>;
  deleteAllFinancialUploads(): Promise<void>;
  deleteEmptyFinancialUploads(): Promise<number>;
  appendFinancialRows(uploadId: string, rows: any[]): Promise<void>;

  searchCompanies(query: string, organizationId: string): Promise<Company[]>;
  searchUsers(query: string, roles: string[], organizationId: string): Promise<Omit<User, 'password'>[]>;

  getTasks(): Promise<Task[]>;
  getTasksByOrg(organizationId: string): Promise<Task[]>;
  getTasksByCompany(companyId: string): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  findProcurementTask(awardId: string, lane: string): Promise<Task | undefined>;
  countProcurementTasksByAward(awardId: string): Promise<number>;
  findRfpCoverageReviewTask(rfpId: string): Promise<Task | undefined>;
  findAwardOnboardingTask(awardId: string): Promise<Task | undefined>;
  /** Return an open lane-procurement task for a given lane+user (for dedup check). */
  findOpenLaneProcurementTask(laneId: string, assignedTo: string): Promise<Task | undefined>;
  /** Mark all open lane-procurement tasks for a lane as completed (call on lane resolution). */
  completeTasksForLane(laneId: string): Promise<void>;
  createTask(task: InsertTask): Promise<Task>;
  updateTask(id: string, data: Partial<InsertTask>): Promise<Task | undefined>;
  deleteTask(id: string): Promise<boolean>;
  getTaskComments(taskId: string): Promise<TaskComment[]>;
  getTaskCommentCounts(taskIds: string[]): Promise<Record<string, number>>;
  createTaskComment(comment: InsertTaskComment): Promise<TaskComment>;
  deleteTaskComment(id: string): Promise<boolean>;

  getCallouts(): Promise<Callout[]>;
  getCalloutsByCompany(companyId: string): Promise<Callout[]>;
  getCallout(id: string): Promise<Callout | undefined>;
  createCallout(callout: InsertCallout): Promise<Callout>;
  deleteCallout(id: string): Promise<boolean>;

  getFeedPosts(visibleAuthorIds?: string[]): Promise<FeedPost[]>;
  getFeedReplies(parentIds: string[]): Promise<FeedPost[]>;
  createFeedPost(post: InsertFeedPost): Promise<FeedPost>;
  getFeedPost(id: string): Promise<FeedPost | undefined>;
  deleteFeedPost(id: string): Promise<boolean>;
  pinFeedPost(id: string, pinned: boolean): Promise<FeedPost>;

  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;

  getReactionsByCalloutIds(calloutIds: string[]): Promise<CalloutReaction[]>;
  toggleReaction(calloutId: string, userId: string, emoji: string): Promise<{ action: "added" | "removed" }>;

  getReactionsByFeedPostIds(feedPostIds: string[]): Promise<FeedPostReaction[]>;
  toggleFeedPostReaction(feedPostId: string, userId: string, emoji: string): Promise<{ action: "added" | "removed" }>;

  getActiveSession(namId: string, amId: string): Promise<OneOnOneSession | undefined>;
  getActiveSessionsForManager(namId: string): Promise<OneOnOneSession[]>;
  getOrCreateActiveSession(namId: string, amId: string): Promise<OneOnOneSession>;
  getSessionsForSubordinates(subordinateIds: string[], orgId: string): Promise<Array<{
    session: OneOnOneSession;
    namUser: { id: string; name: string; role: string };
    amUser: { id: string; name: string; role: string };
    topics: Array<OneOnOneTopic & { replies: OneOnOneTopicReply[] }>;
  }>>;
  getSession(id: string): Promise<OneOnOneSession | undefined>;
  getSessionsByUser(userId: string): Promise<OneOnOneSession[]>;
  getAllSessions(): Promise<OneOnOneSession[]>;
  closeSession(sessionId: string, opts?: { carryForwardTopicIds?: string[]; moraleScore?: number; sessionSummary?: string }): Promise<OneOnOneSession | undefined>;
  getTopicsBySession(sessionId: string): Promise<OneOnOneTopic[]>;
  getTopic(id: string): Promise<OneOnOneTopic | undefined>;
  createTopic(topic: InsertOneOnOneTopic): Promise<OneOnOneTopic>;
  toggleTopicStatus(topicId: string): Promise<OneOnOneTopic | undefined>;
  updateTopicStatus(topicId: string, status: string): Promise<OneOnOneTopic | undefined>;
  deleteTopic(topicId: string): Promise<boolean>;
  getTopicReplies(topicId: string): Promise<OneOnOneTopicReply[]>;
  addTopicReply(reply: InsertOneOnOneTopicReply): Promise<OneOnOneTopicReply>;
  deleteTopicReply(replyId: string): Promise<boolean>;
  getArchivedSessions(namId: string, amId: string): Promise<OneOnOneSession[]>;
  updateSessionNotes(sessionId: string, notes: string): Promise<OneOnOneSession | undefined>;
  updateSessionMeetingDate(sessionId: string, meetingDate: string | null): Promise<OneOnOneSession | undefined>;
  updateSessionMeetingLink(sessionId: string, meetingLink: string | null): Promise<OneOnOneSession | undefined>;
  getActiveSessionsWithMeetingDate(): Promise<OneOnOneSession[]>;
  getActionItemsByPairing(namId: string, amId: string): Promise<{ session: OneOnOneSession; topics: OneOnOneTopic[] }[]>;

  searchContacts(query: string, organizationId: string): Promise<Contact[]>;
  searchRfps(query: string, organizationId: string): Promise<Rfp[]>;
  searchTasks(query: string, organizationId: string): Promise<Task[]>;
  searchCarriers(query: string, orgId: string): Promise<Carrier[]>;

  getCompanyActivity(companyId: string): Promise<Array<{ type: string; title: string; subtitle?: string; date: string; link?: string }>>;
  getTeamPerformance(managerIds: string[], startDate?: string, endDate?: string): Promise<Array<{ userId: string; openTasks: number; overdueTasks: number; completedTasks: number; companyCount: number; newContacts: number; callTouchpoints: number; textTouchpoints: number; emailTouchpoints: number; contactsTouched: number; baseAdvanced: number; meaningfulTouchpoints: number }>>;

  getNotifications(userId: string): Promise<import('../shared/schema').Notification[]>;
  hasUnreadNotification(userId: string, type: string, relatedId: string): Promise<boolean>;
  hasAnyNotification(userId: string, type: string, relatedId: string): Promise<boolean>;
  createNotification(data: import('../shared/schema').InsertNotification): Promise<import('../shared/schema').Notification>;
  markNotificationRead(id: string): Promise<void>;
  markAllNotificationsRead(userId: string): Promise<void>;
  markNotificationsReadByTypes(userId: string, types: string[]): Promise<void>;
  markNotificationsReadByIds(userId: string, ids: string[]): Promise<void>;

  getTouchpoint(id: string): Promise<Touchpoint | undefined>;
  getTouchpoints(): Promise<Touchpoint[]>;
  getTouchpointsSince(since: string): Promise<Touchpoint[]>;
  getTouchpointsByContact(contactId: string): Promise<Touchpoint[]>;
  getTouchpointsByCompany(companyId: string): Promise<Touchpoint[]>;
  getTouchpointByExternalId(externalId: string): Promise<Touchpoint | undefined>;
  getTouchpointsByUser(userId: string, since: string): Promise<Touchpoint[]>;
  getTouchpointsByOrg(organizationId: string): Promise<Touchpoint[]>;
  /**
   * @deprecated Prefer `createTouchpointWithDefaults` for new routes — it
   * fills safe defaults for sentiment/isMeaningful/playLabel/date/createdAt
   * so callers can't drift the shape (the historical source of touchpoint
   * NULL-date crashes and missing playLabel attribution). Direct calls are
   * still allowed for back-fills and migrations.
   */
  createTouchpoint(tp: InsertTouchpoint): Promise<Touchpoint>;
  createTouchpointWithDefaults(input: {
    companyId: string;
    loggedById: string;
    contactId?: string | null;
    type?: string;
    notes?: string | null;
    sentiment?: string | null;
    isMeaningful?: boolean;
    playLabel?: string | null;
    date?: string;
    createdAt?: string;
  }): Promise<Touchpoint>;
  updateTouchpoint(id: string, data: { isMeaningful?: boolean; notes?: string }): Promise<Touchpoint>;
  /** Re-attribute all touchpoints for a contact to a new company (used when a contact moves). */
  updateTouchpointCompanyByContact(contactId: string, newCompanyId: string): Promise<number>;
  deleteTouchpoint(id: string): Promise<boolean>;
  getColdContacts(assignedToUserId: string | null, daysSince: number, teamUserIds?: string[]): Promise<Array<{ contact: Contact; company: Company; daysSince: number; lastType: string | null }>>;
  getMeaningfulOverdueContacts(assignedToUserId: string | null, daysSince: number, teamUserIds?: string[]): Promise<Array<{ contact: Contact; company: Company; daysSinceLastMeaningful: number }>>;

  getTouchpointCountByAm(amId: string, startDate: string, endDate: string): Promise<number>;
  getMeaningfulTouchpointCountByAm(amId: string, startDate: string, endDate: string): Promise<number>;

  getRepReport(userId: string, period: "weekly" | "monthly"): Promise<RepReportData>;

  getAttachmentsByEntity(entityType: string, entityId: string): Promise<Attachment[]>;
  getAttachmentsByEntities(entityType: string, entityIds: string[]): Promise<Attachment[]>;
  createAttachment(attachment: InsertAttachment): Promise<Attachment>;
  getAttachment(id: string): Promise<Attachment | undefined>;
  deleteAttachment(id: string): Promise<boolean>;

  getGoals(filter: { namId?: string; amId?: string }): Promise<Goal[]>;
  getGoal(id: string): Promise<Goal | undefined>;
  createGoal(goal: InsertGoal): Promise<Goal>;
  updateGoal(id: string, data: Partial<InsertGoal>): Promise<Goal | undefined>;
  deleteGoal(id: string): Promise<boolean>;
  getAmsMissingMonthlyGoals(organizationId: string, namId?: string): Promise<Array<{ amId: string; amName: string }>>;
  getGoalComments(goalId: string): Promise<GoalComment[]>;
  getGoalComment(id: string): Promise<GoalComment | undefined>;
  createGoalComment(comment: InsertGoalComment): Promise<GoalComment>;
  deleteGoalComment(id: string): Promise<boolean>;
  getContactsAddedByAm(amId: string, startDate: string, endDate: string): Promise<number>;

  getPersonalAlerts(userId: string): Promise<PersonalAlert[]>;
  createPersonalAlert(alert: InsertPersonalAlert): Promise<PersonalAlert>;
  deletePersonalAlert(id: string, userId: string): Promise<boolean>;
  fireDueAlerts(userId: string): Promise<PersonalAlert[]>;
  getVendorRoutedByCompany(companyId: string): Promise<VendorRouted[]>;
  toggleVendorRouted(companyId: string, rowKey: string): Promise<{ active: boolean }>;

  /**
   * @deprecated Use `getPtoPassoffsByOrg` for org-scoped queries (admin views)
   * or pass an explicit `createdById`/`coveringUserId` for user-scoped views.
   * The `{all:true}` mode here returns passoffs from every org and was the
   * source of cross-org data leakage for admins.
   */
  getPtoPassoffs(filter: { createdById?: string; coveringUserId?: string; all?: boolean }): Promise<PtoPassoff[]>;
  /** Org-scoped passoff list. Use this from any admin/leadership route. */
  getPtoPassoffsByOrg(orgId: string, filter?: { createdById?: string; coveringUserId?: string }): Promise<PtoPassoff[]>;
  /**
   * @deprecated Use `getPtoPassoffInOrg(id, orgId)`. The un-scoped version
   * lets a caller load any passoff if they know its UUID, regardless of
   * which org owns it.
   */
  getPtoPassoff(id: string): Promise<PtoPassoff | undefined>;
  /** Org-scoped single-passoff fetch. Returns undefined if the passoff
   *  exists but is owned by a user outside `orgId`. */
  getPtoPassoffInOrg(id: string, orgId: string): Promise<PtoPassoff | undefined>;
  createPtoPassoff(data: InsertPtoPassoff & { createdAt: string }): Promise<PtoPassoff>;
  updatePtoPassoff(id: string, data: Partial<InsertPtoPassoff>): Promise<PtoPassoff | undefined>;
  deletePtoPassoff(id: string): Promise<boolean>;
  getPtoPassoffItems(passoffId: string): Promise<PtoPassoffItem[]>;
  createPtoPassoffItem(data: InsertPtoPassoffItem): Promise<PtoPassoffItem>;
  updatePtoPassoffItem(id: string, data: Partial<InsertPtoPassoffItem>): Promise<PtoPassoffItem | undefined>;
  deletePtoPassoffItem(id: string): Promise<boolean>;

  getInternalPosts(userId: string, role: string, orgUserIds: string[]): Promise<InternalPost[]>;
  createInternalPost(data: { content: string; authorId: string; recipientIds: string[]; parentId?: string | null; createdAt: string }): Promise<InternalPost>;
  deleteInternalPost(id: string): Promise<boolean>;

  getMarketShareEntries(companyId: string): Promise<MarketShareEntry[]>;
  getAllMarketShareEntries(): Promise<MarketShareEntry[]>;
  createMarketShareEntry(entry: InsertMarketShareEntry): Promise<MarketShareEntry>;
  updateMarketShareEntry(id: string, data: Partial<InsertMarketShareEntry>): Promise<MarketShareEntry | undefined>;
  deleteMarketShareEntry(id: string): Promise<boolean>;

  getReportCardSnapshots(userId: string): Promise<ReportCardSnapshot[]>;
  createReportCardSnapshot(data: InsertReportCardSnapshot): Promise<ReportCardSnapshot>;

  getPromotionCriteria(): Promise<PromotionCriteria[]>;
  upsertPromotionCriteria(fromRole: string, toRole: string, data: Partial<InsertPromotionCriteria>): Promise<PromotionCriteria>;
  deletePromotionCriteria(id: string): Promise<boolean>;

  getPromotionNominations(): Promise<PromotionNomination[]>;
  getNominationsByNominee(nomineeId: string): Promise<PromotionNomination[]>;
  createPromotionNomination(data: InsertPromotionNomination): Promise<PromotionNomination>;
  updatePromotionNomination(id: string, data: Partial<InsertPromotionNomination>): Promise<PromotionNomination | undefined>;
  deletePromotionNomination(id: string): Promise<boolean>;

  getDevelopmentGoals(namId: string, amId: string): Promise<DevelopmentGoal | undefined>;
  upsertDevelopmentGoals(namId: string, amId: string, content: string, updatedById: string): Promise<DevelopmentGoal>;

  getToolLinks(): Promise<ToolLink[]>;
  createToolLink(data: InsertToolLink): Promise<ToolLink>;
  updateToolLink(id: string, data: Partial<InsertToolLink>): Promise<ToolLink | undefined>;
  deleteToolLink(id: string): Promise<boolean>;

  createDemoRequest(data: import('../shared/schema').InsertDemoRequest): Promise<import('../shared/schema').DemoRequest>;

  getLmDailyChecks(lmUserId: string): Promise<LmDailyCheck[]>;
  upsertLmDailyCheck(data: { organizationId: string; lmUserId: string; checkedByUserId: string; date: string; callsBeforeSevenThirty?: boolean | null; checkoutCompleted?: boolean | null }): Promise<LmDailyCheck>;

  createOpportunityLog(data: InsertOpportunityLog & { createdAt: string }): Promise<OpportunityLog>;
  getOpportunityLogs(orgId: string, filters?: { repId?: string; companyId?: string; type?: string; startDate?: string; endDate?: string }): Promise<OpportunityLog[]>;
  updateOpportunityLog(id: string, data: { description?: string | null }): Promise<OpportunityLog | undefined>;
  deleteOpportunityLog(id: string): Promise<boolean>;
  getOpportunityLogSummary(repIds: string[], startDate: string, endDate: string): Promise<Array<{ repId: string; opportunities: number; wins: number }>>;

  // Prospect pipeline
  getProspects(organizationId: string, ownerId?: string): Promise<import('../shared/schema').Prospect[]>;
  getProspect(id: number): Promise<import('../shared/schema').Prospect | undefined>;
  createProspect(data: import('../shared/schema').InsertProspect): Promise<import('../shared/schema').Prospect>;
  updateProspect(id: number, data: Partial<import('../shared/schema').InsertProspect>): Promise<import('../shared/schema').Prospect | undefined>;
  deleteProspect(id: number): Promise<boolean>;
  getProspectActivities(prospectId: number): Promise<import('../shared/schema').ProspectActivity[]>;
  getOrgProspectActivitiesSince(prospectIds: number[], since: Date): Promise<import('../shared/schema').ProspectActivity[]>;
  createProspectActivity(data: import('../shared/schema').InsertProspectActivity): Promise<import('../shared/schema').ProspectActivity>;
  getProspectContacts(prospectId: number): Promise<import('../shared/schema').ProspectContact[]>;
  createProspectContact(data: import('../shared/schema').InsertProspectContact): Promise<import('../shared/schema').ProspectContact>;
  updateProspectContact(prospectId: number, contactId: number, data: Partial<import('../shared/schema').InsertProspectContact>): Promise<import('../shared/schema').ProspectContact | undefined>;
  deleteProspectContact(prospectId: number, contactId: number): Promise<boolean>;

  // Launchpad CRM — Opportunities
  getCrmOpportunities(prospectId: number): Promise<import('../shared/schema').CrmOpportunity[]>;
  getCrmOpportunitiesByCompanyId(companyId: string): Promise<import('../shared/schema').CrmOpportunity[]>;
  getCrmOpportunityById(id: number): Promise<import('../shared/schema').CrmOpportunity | undefined>;
  createCrmOpportunity(data: import('../shared/schema').InsertCrmOpportunity): Promise<import('../shared/schema').CrmOpportunity>;
  updateCrmOpportunity(id: number, data: Partial<import('../shared/schema').InsertCrmOpportunity>): Promise<import('../shared/schema').CrmOpportunity | undefined>;
  deleteCrmOpportunity(id: number): Promise<boolean>;

  // Launchpad CRM — Ownership Requests
  getCrmOwnershipRequests(organizationId: string): Promise<import('../shared/schema').CrmOwnershipRequest[]>;
  getCrmOwnershipRequestById(id: number): Promise<import('../shared/schema').CrmOwnershipRequest | undefined>;
  getPendingOwnershipRequestsForProspect(prospectId: number): Promise<import('../shared/schema').CrmOwnershipRequest[]>;
  createCrmOwnershipRequest(data: import('../shared/schema').InsertCrmOwnershipRequest): Promise<import('../shared/schema').CrmOwnershipRequest>;
  reviewCrmOwnershipRequest(id: number, status: string, reviewedById: string, adminNote?: string): Promise<import('../shared/schema').CrmOwnershipRequest | undefined>;

  // Launchpad CRM — Account History
  getCrmAccountHistory(prospectId: number): Promise<import('../shared/schema').CrmAccountHistory[]>;
  logCrmAccountHistory(data: { prospectId: number; organizationId: string; field: string; oldValue: string | null; newValue: string | null; changedById: string }): Promise<void>;

  // Stripe billing
  updateOrganizationBilling(id: string, data: {
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    billingStatus?: string;
    planName?: string | null;
    currentPeriodEnd?: Date | null;
  }): Promise<Organization | undefined>;
  getOrganizationByStripeCustomerId(stripeCustomerId: string): Promise<Organization | undefined>;

  // Lane carriers (procurement rolodex)
  getLaneCarrier(id: string): Promise<import('../shared/schema').LaneCarrier | undefined>;
  getLaneCarriersByTask(taskId: string): Promise<import('../shared/schema').LaneCarrier[]>;
  getLaneCarriersByAward(awardId: string): Promise<import('../shared/schema').LaneCarrier[]>;
  createLaneCarrier(data: import('../shared/schema').InsertLaneCarrier): Promise<import('../shared/schema').LaneCarrier>;
  updateLaneCarrier(id: string, data: Partial<import('../shared/schema').InsertLaneCarrier>): Promise<import('../shared/schema').LaneCarrier | undefined>;
  deleteLaneCarrier(id: string): Promise<boolean>;

  // Account Growth Score
  upsertGrowthScore(data: import('../shared/schema').InsertAccountGrowthScore): Promise<import('../shared/schema').AccountGrowthScore>;
  // ── Account Reviews (Auto Weekly Account Review) ─────────────────────────
  upsertAccountReview(data: InsertAccountReview): Promise<AccountReview>;
  getAccountReviewById(id: string, organizationId: string): Promise<AccountReview | undefined>;
  getAccountReviewByKey(repUserId: string, companyId: string, weekOf: string): Promise<AccountReview | undefined>;
  getAccountReviewsByCompany(companyId: string, organizationId: string, limit?: number): Promise<AccountReview[]>;
  getAccountReviewsByRep(repUserId: string, organizationId: string, weekOf?: string, limit?: number): Promise<AccountReview[]>;
  rateAccountReview(id: string, organizationId: string, rating: number | null): Promise<AccountReview | undefined>;

  getGrowthScore(companyId: string): Promise<import('../shared/schema').AccountGrowthScore | undefined>;
  getGrowthScoresByOrg(organizationId: string, companyIds: string[]): Promise<import('../shared/schema').AccountGrowthScore[]>;

  // Weekly Coaching Commitments
  getWeeklyCommitments(userId: string, orgId: string, weekStart?: string): Promise<import('../shared/schema').WeeklyCommitment[]>;
  getTeamWeeklyCommitments(orgId: string, weekStart: string): Promise<Array<import('../shared/schema').WeeklyCommitment & { userName: string; userRole: string }>>;
  createWeeklyCommitment(data: import('../shared/schema').InsertWeeklyCommitment): Promise<import('../shared/schema').WeeklyCommitment>;
  updateWeeklyCommitmentStatus(id: string, userId: string, status: string): Promise<import('../shared/schema').WeeklyCommitment | undefined>;
  deleteWeeklyCommitment(id: string, userId: string): Promise<boolean>;

  // NBA Phase 1 Persistent Cards
  createNbaCard(data: InsertNbaCard): Promise<NbaCard>;
  getVisibleNbaCards(userId: string, limit?: number): Promise<NbaCard[]>;
  getRecentNbaCardByType(companyId: string, ruleType: string, dayLimit: number): Promise<NbaCard | undefined>;
  /** Email NBA dedup: return active card for (companyId, ruleType, threadId) regardless of age. */
  getActiveNbaCardByThreadAndType(companyId: string, ruleType: string, threadId: string): Promise<NbaCard | undefined>;
  /** Stale quote follow-up dedup (Task #480): active card whose linkedCommitmentId == quoteId. */
  getActiveStaleQuoteFollowUpCard(orgId: string, quoteId: string): Promise<NbaCard | undefined>;
  getRecentNbaCardByLane(laneId: string, userId: string, dayLimit: number): Promise<NbaCard | undefined>;
  getNbaCard(id: string): Promise<NbaCard | undefined>;
  resolveNbaCard(id: string, userId: string, data: Record<string, unknown>): Promise<NbaCard | undefined>;
  supersedePreviousNbaCards(companyId: string, winningRuleType: string): Promise<void>;
  resolveNbaCardsForLane(laneId: string): Promise<void>;
  getVisibleNbaCardsForOrg(orgId: string, limit?: number): Promise<NbaCard[]>;
  getNbaCardForCompany(companyId: string): Promise<NbaCard | undefined>;
  processExpiredNbaCards(orgId: string, touchpointCompanyId?: string): Promise<void>;
  getNbaManagerSummary(orgId: string, weekStart: string): Promise<Array<{
    userId: string; userName: string; shown: number; actioned: number; dismissed: number; ignored: number;
  }>>;
  getNbaRulePerformance(orgId: string, daysBack?: number): Promise<Array<{
    ruleType: string; firedCount: number; shownCount: number; actionedCount: number;
    dismissedCount: number; avgHoursToAction: number | null; outcomeLinkCount: number;
    classifiedCount: number; workedCount: number; partialCount: number;
    noResponseCount: number; outcomeRate: number; dollarMoved: number;
  }>>;
  // ── NBA lifecycle events + outcome classification (Task #374) ──────────────
  recordNbaCardEvent(event: InsertNbaCardEvent): Promise<NbaCardEvent>;
  markNbaCardViewed(cardId: string, userId: string, orgId: string): Promise<NbaCard | undefined>;
  getNbaCardEvents(cardId: string): Promise<NbaCardEvent[]>;
  upsertNbaCardOutcome(data: InsertNbaCardOutcome): Promise<NbaCardOutcome>;
  getResolvedNbaCardsAwaitingClassification(orgId: string): Promise<NbaCard[]>;
  getNbaImpactForUser(userId: string, orgId: string, daysBack?: number): Promise<{
    daysBack: number; fired: number; viewed: number; actioned: number; dismissed: number;
    snoozed: number; expired: number; conversionRate: number;
    outcomesWorked: number; outcomesNoResponse: number; dollarMoved: number;
    byRule: Array<{ ruleType: string; fired: number; actioned: number; conversionRate: number; worked: number; dollarMoved: number }>;
  }>;
  getNbaTeamRollup(amUserIds: string[], orgId: string, daysBack?: number): Promise<{
    daysBack: number;
    perAm: Array<{
      userId: string; userName: string; open: number; untouched3d: number;
      fired: number; actioned: number; dismissed: number; conversionRate: number;
      worked: number; dollarMoved: number;
      dismissReasons: Array<{ reason: string; count: number }>;
    }>;
    dismissReasons: Array<{ reason: string; count: number }>;
    topUnworked: Array<{
      cardId: string; userId: string; userName: string;
      companyId: string | null; companyName: string | null;
      atStakeAmount: number; ruleType: string; ageDays: number;
    }>;
    totals: { open: number; untouched3d: number; conversionRate: number; dollarMoved: number; worked: number; fired: number };
  }>;
  getNbaCardsForUserReadonly(userId: string, orgId: string): Promise<NbaCard[]>;
  // Market Signal NBA methods
  getNbaCardsByMarketSignal(signalId: string): Promise<NbaCard[]>;
  getNbaCardsByCompanyAndRuleType(companyId: string, ruleType: string): Promise<NbaCard[]>;
  getNbaCardsByUserId(userId: string, ruleType?: string): Promise<NbaCard[]>;
  getNbaCardByMarketSignalDedup(companyId: string, signalId: string, ruleType: string): Promise<NbaCard | undefined>;
  dismissNbaCardsByMarketSignal(signalId: string): Promise<number>;

  // Missed Inbound Calls (Task #317)
  upsertMissedInboundCall(data: InsertMissedInboundCall): Promise<MissedInboundCall>;
  getMissedInboundCallByCdr(orgId: string, cdrId: string): Promise<MissedInboundCall | undefined>;
  getMissedInboundCall(id: string): Promise<MissedInboundCall | undefined>;
  getMissedInboundCallsForOrg(orgId: string, sinceIso: string): Promise<MissedInboundCall[]>;
  setMissedInboundCallback(id: string, nbaCardId: string): Promise<MissedInboundCall | undefined>;
  // Recurring lanes by company (for exposure matching)
  getRecurringLanesByCompany(companyId: string): Promise<RecurringLane[]>;

  // Forced Focus
  createForcedFocus(data: import('../shared/schema').InsertForcedFocus): Promise<import('../shared/schema').ForcedFocus>;
  getActiveForcedFocusForUser(userId: string): Promise<import('../shared/schema').ForcedFocus | undefined>;
  getTeamForcedFocus(orgId: string, teamMemberIds?: string[]): Promise<Array<import('../shared/schema').ForcedFocus & { assignedToName: string; assignedToRole: string }>>;
  deactivateForcedFocusForUser(userId: string): Promise<void>;
  getForcedFocus(id: string): Promise<import('../shared/schema').ForcedFocus | undefined>;
  updateForcedFocusStatus(id: string, status: string): Promise<import('../shared/schema').ForcedFocus | undefined>;
  updateForcedFocus(id: string, data: Partial<import('../shared/schema').InsertForcedFocus>): Promise<import('../shared/schema').ForcedFocus | undefined>;

  // Lane Carrier Outreach v1 — Carrier Catalog
  getCarriers(orgId: string): Promise<Carrier[]>;
  getCarrier(id: string): Promise<Carrier | undefined>;
  getCarriersByIds(ids: string[], orgId: string): Promise<Carrier[]>;
getCarrierInOrg(id: string, orgId: string): Promise<Carrier | undefined>;
  createCarrier(data: InsertCarrier): Promise<Carrier>;
  bulkCreateCarriers(data: InsertCarrier[]): Promise<number>;
  updateCarrier(id: string, orgId: string, data: Partial<Omit<InsertCarrier, 'orgId'>>): Promise<Carrier | undefined>;
  deleteCarrier(id: string, orgId: string): Promise<boolean>;
  bulkDeleteCarriers(ids: string[], orgId: string): Promise<number>;
  getCarrierByPayeeCode(orgId: string, payeeCode: string): Promise<Carrier | undefined>;
  getCarrierByMcNumber(orgId: string, mcNumber: string): Promise<Carrier | undefined>;
  getCarrierByNormalizedName(orgId: string, normalizedName: string): Promise<Carrier | undefined>;
  upsertCarrierByMcDot(orgId: string, mcDot: string, data: Omit<InsertCarrier, 'orgId'>): Promise<Carrier>;

  // Lane Carrier Outreach v1 — Recurring Lanes
  getRecurringLanes(orgId: string, userId?: string): Promise<RecurringLane[]>;
  getRecurringLane(id: string): Promise<RecurringLane | undefined>;
  upsertRecurringLane(data: InsertRecurringLane & { orgId: string; origin: string; destination: string; equipmentType?: string | null; companyId?: string | null }): Promise<RecurringLane>;
  createRecurringLane(data: InsertRecurringLane): Promise<RecurringLane>;
  updateRecurringLane(id: string, data: Partial<InsertRecurringLane>): Promise<RecurringLane | undefined>;
  deleteRecurringLane(id: string): Promise<boolean>;
  getEligibleRecurringLanes(orgId: string): Promise<RecurringLane[]>;
  retractIneligibleLanes(orgId: string, eligibleIds: string[]): Promise<void>;

  // Lane Carrier Outreach v1 — Carrier Bench (laneCarrierInterest)
  getLaneCarrierBench(laneId: string): Promise<LaneCarrierInterest[]>;
  /**
   * Org-wide bench lookup by lane signature (origin city/state, dest city/state, equipment).
   * Used by the proactive opportunity service when a synthetic AF opportunity has no
   * RecurringLane to anchor `getLaneCarrierBench` to — so bench-tier-0 promotion still
   * works for AF opps that mirror an org's recurring corridor.
   */
  getOrgWideBenchByLaneSignature(
    orgId: string,
    origin: string,
    originState: string | null,
    destination: string | null,
    destinationState: string | null,
    equipment: string | null,
  ): Promise<LaneCarrierInterest[]>;
  getLaneCarrierInterestById(id: string): Promise<LaneCarrierInterest | undefined>;
  upsertLaneCarrierInterest(data: InsertLaneCarrierInterest): Promise<LaneCarrierInterest>;
  updateLaneCarrierInterest(id: string, data: Partial<InsertLaneCarrierInterest>): Promise<LaneCarrierInterest | undefined>;

  // Lane Carrier Outreach v1 — Outreach Logs
  createCarrierOutreachLog(data: InsertCarrierOutreachLog): Promise<CarrierOutreachLog>;
  getCarrierOutreachLogs(laneId: string): Promise<CarrierOutreachLog[]>;
  updateCarrierOutreachLog(id: string, fields: Partial<InsertCarrierOutreachLog>): Promise<CarrierOutreachLog>;
  getCarrierOutreachLogByThreadId(threadId: string): Promise<CarrierOutreachLog | undefined>;
  getCarrierOutreachLogsByOrgAndThreadIds(orgId: string, threadIds: string[]): Promise<CarrierOutreachLog[]>;
  /** Subject-line fallback: find the most recent outreach log within 30 days whose email drafts contain a matching subject (case-insensitive, re: prefix stripped). Scoped to the given orgId to prevent cross-tenant mis-association. */
  getCarrierOutreachLogBySubjectFallback(orgId: string, normalizedSubject: string): Promise<CarrierOutreachLog | undefined>;
  /** Fetch all outreach logs for a given procurement task, ordered newest first. */
  getCarrierOutreachLogsByProcurementTaskId(orgId: string, procurementTaskId: string): Promise<CarrierOutreachLog[]>;
  recordOutreachReply(logId: string, replySnippet: string, replyReceivedAt: Date): Promise<CarrierOutreachLog>;

  // Two-way email foundation — Task #183
  getCarrierOutreachLogByProviderMessageId(providerMessageId: string): Promise<CarrierOutreachLog | undefined>;
  getCarrierOutreachLogByConversationId(conversationId: string, orgId: string): Promise<CarrierOutreachLog | undefined>;
  getCarriersByPrimaryEmail(email: string, orgId: string): Promise<Carrier[]>;
  getCarrierContactByEmail(email: string, orgId: string): Promise<CarrierContact | undefined>;
  getContactByEmailInOrg(email: string, orgId: string): Promise<{ contactId: string; companyId: string; contactName: string } | null>;
  getFirstOrg(): Promise<{ id: string; name: string } | undefined>;
  getFirstOrgAdmin(orgId: string): Promise<{ id: string } | undefined>;
  getOrgByOutlookMailbox(mailbox: string): Promise<{ id: string } | undefined>;

  // Lane Carrier Outreach v1 — Feature Flags
  getFeatureFlag(orgId: string, flagKey: string): Promise<boolean>;
  setFeatureFlag(orgId: string, flagKey: string, enabled: boolean, updatedById?: string): Promise<void>;
  getSidebarTooltips(orgId: string): Promise<SidebarTooltip[]>;
  upsertSidebarTooltip(orgId: string, itemKey: string, description: string, updatedById: string): Promise<SidebarTooltip>;
  deleteSidebarTooltip(orgId: string, itemKey: string): Promise<void>;
  getEmailLiveModeAcrossOrgs(): Promise<boolean>;

  // Lane Carrier Outreach v2 — External Import + Sourcing
  importCarriersForLane(
    orgId: string,
    laneId: string | null,
    userId: string,
    carriers: Array<{ name: string; email?: string; phone?: string; mcDot?: string }>,
    source: string,
    rawInput?: string
  ): Promise<{ batch: CarrierImportBatch; results: CarrierImportResult[] }>;
  getCarrierImportBatches(orgId: string, laneId?: string): Promise<CarrierImportBatch[]>;
  getCarrierSourcingPerformance(orgId: string): Promise<CarrierSourcingChannel[]>;

  // Lane Carrier Outreach v1.5 — Assignment + Work Queue
  assignLaneOwner(laneId: string, orgId: string, ownerUserId: string | null, assignedByUserId: string): Promise<RecurringLane | undefined>;
  /**
   * Returns the set of user IDs whose lanes should be visible to the requesting user,
   * plus a human-readable scope label and whether the user can see unassigned lanes.
   */
  resolveVisibleUserIds(requestingUserId: string, orgId: string, role: string): Promise<{
    visibleUserIds: string[];
    canSeeUnassigned: boolean;
    scopeLabel: string;
  }>;
  getLaneWorkQueue(orgId: string, completionThreshold: number, visibleUserIds: string[], canSeeUnassigned: boolean): Promise<LaneWorkQueueResult>;
  getLaneWorkQueueFromCache(orgId: string, visibleUserIds: string[], canSeeUnassigned: boolean): Promise<LeanLaneWorkQueueResult | null>;
  getBenchCountsForLanes(orgId: string, laneIds: string[]): Promise<Map<string, { contactableCount: number; totalBenchCount: number; historicalCount: number; missingContactCount: number }>>;
  getUnactionedHotReplyCount(orgId: string, visibleUserIds: string[], canSeeUnassigned: boolean): Promise<number>;
  upsertLaneSummaryCache(data: InsertLaneSummaryCache): Promise<LaneSummaryCache>;
  patchLaneSummaryCache(laneId: string, patch: Partial<InsertLaneSummaryCache>): Promise<void>;

  // Lane Coverage Profiles
  getLaneCoverageProfile(orgId: string, laneKey: string): Promise<import('@shared/schema').LaneCoverageProfile | undefined>;
  getLaneCoverageProfileById(id: string): Promise<import('@shared/schema').LaneCoverageProfile | undefined>;
  getLaneCoverageProfileByLaneId(laneId: string): Promise<import('@shared/schema').LaneCoverageProfile | undefined>;
  upsertLaneCoverageProfile(data: import('@shared/schema').InsertLaneCoverageProfile): Promise<import('@shared/schema').LaneCoverageProfile>;
  updateLaneCoverageProfile(id: string, data: Partial<import('@shared/schema').InsertLaneCoverageProfile>): Promise<import('@shared/schema').LaneCoverageProfile | undefined>;
  getLaneCoverageProfileCarriers(profileId: string): Promise<import('@shared/schema').LaneCoverageProfileCarrier[]>;
  upsertLaneCoverageProfileCarrier(data: import('@shared/schema').InsertLaneCoverageProfileCarrier): Promise<import('@shared/schema').LaneCoverageProfileCarrier>;
  deleteLaneCoverageProfileCarriers(profileId: string): Promise<void>;

  // Market Signal Intelligence Layer (Task #185)
  insertMarketEvent(data: import('@shared/schema').InsertMarketEvent): Promise<import('@shared/schema').MarketEvent>;
  getMarketEventsSince(since: Date, scope?: { scopeType?: string; scopeKey?: string }): Promise<import('@shared/schema').MarketEvent[]>;
  upsertMarketSignal(data: Omit<import('@shared/schema').InsertMarketSignal, 'firstDetectedAt'> & { lastEvaluatedAt: Date }, cooldownHours?: number): Promise<import('@shared/schema').MarketSignal>;
  updateMarketSignalStatus(id: string, status: string, now: Date): Promise<void>;
  getActiveMarketSignals(filters: {
    scopeType?: string;
    scopeKey?: string;
    equipmentType?: string | null;
    signalType?: string;
    status?: string | string[];
  }): Promise<import('@shared/schema').MarketSignal[]>;
  getMarketSignalById(id: string): Promise<import('@shared/schema').MarketSignal | undefined>;

  // Carrier Market NBAs (Task #187)
  upsertCarrierMarketNba(data: InsertCarrierMarketNba): Promise<CarrierMarketNba>;
  getCarrierMarketNbasBySignal(marketSignalId: string): Promise<CarrierMarketNba[]>;
  getCarrierMarketNbasByCarrier(carrierId: string): Promise<CarrierMarketNba[]>;
  /** Batch fetch NBAs for multiple carriers in a single query (Task #188, avoids N+1). */
  getCarrierMarketNbasBatch(carrierIds: string[]): Promise<CarrierMarketNba[]>;
  /**
   * Batch fetch active market-surge NBAs for multiple carriers, joined with their
   * market_signals to enable lane equipment-type and origin-region matching.
   * Returns only demand_surge_capacity / imbalance_outreach NBAs with status
   * pending/in_progress. Caller should filter by equipment+region using the returned
   * signalEquipmentType / signalScopeType / signalScopeKey fields.
   */
  getActiveCarrierMarketNbasBatch(
    carrierIds: string[],
    laneEquipmentType: string | null,
    laneOriginState: string | null,
  ): Promise<Array<{ carrierId: string; signalEquipmentType: string | null; signalScopeType: string | null; signalScopeKey: string | null }>>;
  /**
   * Fetch the most recent carrier_outreach_log row for each carrierId on a given lane.
   * Used to populate outreachHistory in CarrierFitExplanation.
   */
  getLatestCarrierOutreachLogsForLane(
    laneId: string,
    carrierIds: string[],
  ): Promise<Map<string, { deliveryStatus: string | null; sentAt: Date | null }>>;
  /**
   * Return the set of carrier IDs that were SUCCESSFULLY outreached on a given lane
   * within the specified time window (ms). Used for dedup guard to avoid blocking
   * on transient failures — only prevents re-contact after confirmed successful sends.
   */
  getRecentSuccessfulOutreachCarrierIds(laneId: string, windowMs: number): Promise<Set<string>>;
  /**
   * Cross-lane daily budget check for a single carrier within an org.
   * Returns allowed / blocked-daily-cap / blocked-too-soon with human-readable reason.
   */
  checkCarrierDailyBudget(orgId: string, carrierId: string): Promise<CarrierDailyBudgetResult>;
  getCarrierMarketNbaByDedup(carrierId: string, marketSignalId: string, recommendationType: string): Promise<CarrierMarketNba | undefined>;
  /** Dedup lookup by (carrierId, marketSignalId) only — ignores recommendationType. */
  getCarrierMarketNbaBySignalKey(carrierId: string, marketSignalId: string): Promise<CarrierMarketNba | undefined>;
  getCarriersByOrgForMarketSignal(orgId: string): Promise<import('@shared/schema').Carrier[]>;
  getCarrierClaimedLanesByCarrierId(carrierId: string): Promise<import('@shared/schema').CarrierClaimedLane[]>;
  getFinancialRowsForCarrierSignal(orgId: string, originRegion: string, equipmentType: string | null, since: Date): Promise<Array<{ carrierId: string | null; originRegion: string | null; occurredAt: Date }>>;

  // Email Intelligence Layer (Task #190)
  insertEmailMessage(data: import('@shared/schema').InsertEmailMessage): Promise<import('@shared/schema').EmailMessage>;
  /**
   * Insert an inbound email_message row, or return the existing row if a row
   * with the same (orgId, providerMessageId) already exists.
   * This prevents duplicate rows from replayed Graph API webhook notifications.
   * When providerMessageId is absent falls back to plain insert.
   */
  upsertInboundEmailMessage(data: import('@shared/schema').InsertEmailMessage): Promise<{ message: import('@shared/schema').EmailMessage; created: boolean }>;
  getEmailMessageByProviderId(orgId: string, providerMessageId: string): Promise<import('@shared/schema').EmailMessage | undefined>;
  updateEmailMessageLinks(id: string, links: {
    linkedAccountId?: string | null;
    linkedCarrierId?: string | null;
    linkedLaneId?: string | null;
    linkedLoadId?: string | null;
    linkedTaskId?: string | null;
    linkedNbaId?: string | null;
    linkedOutreachLogId?: string | null;
  }): Promise<import('@shared/schema').EmailMessage | undefined>;
  insertEmailSignals(signals: import('@shared/schema').InsertEmailSignal[]): Promise<import('@shared/schema').EmailSignal[]>;
  getEmailSignalsForAccount(accountId: string, limit?: number): Promise<import('@shared/schema').EmailSignal[]>;
  getEmailSignalsForCarrier(carrierId: string, limit?: number): Promise<import('@shared/schema').EmailSignal[]>;
  getEmailSignalsForLane(laneId: string, limit?: number): Promise<import('@shared/schema').EmailSignal[]>;
  getEmailSignalsForLoad(loadId: string, limit?: number): Promise<import('@shared/schema').EmailSignal[]>;
  getUnprocessedEmailMessages(limit?: number): Promise<import('@shared/schema').EmailMessage[]>;
  getUnprocessedEmailMessagesForOrg(orgId: string, limit?: number): Promise<import('@shared/schema').EmailMessage[]>;
  getRecentUnprocessedEmailMessages(sinceHours: number, limit?: number): Promise<import('@shared/schema').EmailMessage[]>;
  getEmailSignalsByThread(threadId: string, since?: Date): Promise<import('@shared/schema').EmailSignal[]>;
  markEmailMessageProcessed(id: string): Promise<void>;
  // Task #751 — backlog drain + ops view support
  getUnlinkedEmailMessages(orgId: string, limit: number, offset?: number): Promise<import('@shared/schema').EmailMessage[]>;
  relinkEmailMessage(id: string, links: { linkedCarrierId?: string | null; linkedAccountId?: string | null }): Promise<void>;
  getEmailPipelineHealth(orgId: string): Promise<{
    backlog: { unprocessed: number; oldestUnprocessedAt: Date | null };
    windows: Array<{
      label: string;
      sinceMs: number;
      ingested: number;
      linkedCarrier: number;
      linkedAccount: number;
      signals: number;
      signalsByIntent: Record<string, number>;
      suggestions: { pending: number; accepted: number; autoAccepted: number; rejected: number };
    }>;
  }>;
  // Email Signal Consumers (Task #191)
  insertCarrierEmailSuggestion(data: import('@shared/schema').InsertCarrierEmailSuggestion): Promise<import('@shared/schema').CarrierEmailSuggestion>;
  getCarrierEmailSuggestionByDedup(carrierId: string, threadId: string, suggestionType: string, payloadHash: string): Promise<import('@shared/schema').CarrierEmailSuggestion | undefined>;
  getCarrierEmailSuggestions(carrierId: string, status?: string): Promise<import('@shared/schema').CarrierEmailSuggestion[]>;
  insertEmailOutcomeLink(data: import('@shared/schema').InsertEmailOutcomeLink): Promise<import('@shared/schema').EmailOutcomeLink>;
  getEmailOutcomeLinksBySignal(emailSignalId: string): Promise<import('@shared/schema').EmailOutcomeLink[]>;
  getEmailOutcomeLinksByEntity(entityType: string, entityId: string): Promise<import('@shared/schema').EmailOutcomeLink[]>;
  getWinLossEmailSignals(outcomeType: 'won' | 'lost'): Promise<Array<{ signal: import('@shared/schema').EmailSignal; links: import('@shared/schema').EmailOutcomeLink[] }>>;
  updateEmailSignalLinks(signalId: string, links: { linkedAccountId?: string | null; linkedCarrierId?: string | null; linkedLaneId?: string | null; linkedOpportunityId?: string | null }): Promise<void>;
  // Carrier Intel Suggestions (Task #193 / #194)
  getEmailSignalsForOpportunity(opportunityId: string, limit?: number): Promise<import('@shared/schema').EmailSignal[]>;
  insertCarrierIntelSuggestion(data: import('@shared/schema').InsertCarrierIntelSuggestion): Promise<import('@shared/schema').CarrierIntelSuggestion>;
  getSuggestionsForCarrier(carrierId: string, status?: string): Promise<import('@shared/schema').CarrierIntelSuggestion[]>;
  getSuggestionById(id: string): Promise<import('@shared/schema').CarrierIntelSuggestion | undefined>;
  updateSuggestionStatus(id: string, status: 'accepted' | 'rejected' | 'auto_accepted' | 'auto_dismissed', opts: { userId?: string; comment?: string; resolutionReason?: string }): Promise<import('@shared/schema').CarrierIntelSuggestion | undefined>;
  findDuplicateSuggestion(carrierId: string, suggestionType: string, emailSignalId: string): Promise<import('@shared/schema').CarrierIntelSuggestion | undefined>;
  getCarrierIntelSuggestionByDedup(carrierId: string, suggestionType: string, emailSignalId: string): Promise<import('@shared/schema').CarrierIntelSuggestion | undefined>;
  getCarrierIntelSuggestions(carrierId: string, status?: string): Promise<import('@shared/schema').CarrierIntelSuggestion[]>;

  // Email Conversation Threads (Task #202)
  upsertEmailConversationThread(data: {
    orgId: string;
    threadId: string;
    linkedAccountId?: string | null;
    linkedCarrierId?: string | null;
    update: Partial<InsertEmailConversationThread>;
  }): Promise<EmailConversationThread>;
  getEmailConversationThreadById(id: string): Promise<EmailConversationThread | undefined>;
  getEmailConversationThreadByThreadId(orgId: string, threadId: string): Promise<EmailConversationThread | undefined>;
  listEmailConversationThreads(orgId: string, filters: {
    ownerUserId?: string | null;
    ownerUserIdIn?: string[];
    unowned?: boolean;
    waitingState?: string;
    responsePriority?: string;
    overdue?: boolean;
    linkedAccountId?: string;
    linkedCarrierId?: string;
    threadId?: string;
    limit?: number;
    cursor?: string;
    excludeArchived?: boolean;
    archivedOnly?: boolean;
    snoozedOnly?: boolean;
    includeSnoozed?: boolean;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    sort?: "priority" | "recency";
  }): Promise<{ threads: EmailConversationThread[]; nextCursor: string | null; totalCount: number }>;
  updateEmailConversationThread(id: string, orgId: string, data: Partial<InsertEmailConversationThread>): Promise<EmailConversationThread | undefined>;

  // Per-user thread read state (Task #532)
  getEmailConversationReadStates(userId: string, threadIds: string[]): Promise<Map<string, Date | null>>;
  markEmailConversationThreadRead(orgId: string, userId: string, threadId: string, when?: Date): Promise<void>;
  markEmailConversationThreadUnread(orgId: string, userId: string, threadId: string): Promise<void>;

  // Per-user saved views (Task #533)
  listConversationSavedViews(userId: string): Promise<ConversationSavedView[]>;
  getConversationSavedView(id: string): Promise<ConversationSavedView | undefined>;
  createConversationSavedView(data: InsertConversationSavedView): Promise<ConversationSavedView>;
  updateConversationSavedView(id: string, userId: string, data: Partial<InsertConversationSavedView>): Promise<ConversationSavedView | undefined>;
  deleteConversationSavedView(id: string, userId: string): Promise<boolean>;
  reorderConversationSavedViews(userId: string, orderedIds: string[]): Promise<void>;

  // Wake snoozed threads (Task #533)
  findExpiredSnoozedThreads(now?: Date): Promise<EmailConversationThread[]>;

  // Carrier Intel Suggestions — accepted preference helpers (Task #195)
  // Used by ranking and NBA services to consume accepted intelligence.
  getAcceptedLanePreferencesForCarrier(carrierId: string): Promise<import('@shared/schema').CarrierIntelSuggestion[]>;
  getAcceptedRegionPreferencesForCarrier(carrierId: string): Promise<import('@shared/schema').CarrierIntelSuggestion[]>;
  getAcceptedEquipmentCapabilitiesForCarrier(carrierId: string): Promise<import('@shared/schema').CarrierIntelSuggestion[]>;
  // Task #196: capacity and caution flag helpers
  getAcceptedCapacitySignalsForCarrier(carrierId: string): Promise<import('@shared/schema').CarrierIntelSuggestion[]>;
  getAcceptedCautionFlagsForCarrier(carrierId: string): Promise<import('@shared/schema').CarrierIntelSuggestion[]>;
  /**
   * Task #196: Batch-fetch all accepted intel suggestions for a list of carrier IDs in a
   * single query. Used by the ranking engine to eliminate per-carrier N+1 query patterns.
   * Returns a Map keyed by carrierId with all accepted intel rows.
   */
  getBatchAcceptedIntelForCarriers(carrierIds: string[]): Promise<Map<string, import('@shared/schema').CarrierIntelSuggestion[]>>;

  // Account Contact Suggestions (Task #201)
  upsertAccountContactSuggestion(data: import('@shared/schema').InsertAccountContactSuggestion): Promise<import('@shared/schema').AccountContactSuggestion>;
  getAccountContactSuggestions(accountId: string, status?: string): Promise<import('@shared/schema').AccountContactSuggestion[]>;
  countPendingContactSuggestionsByOrg(orgId: string, ownerScope?: string[]): Promise<{ accountId: string; accountName: string; pendingCount: number }[]>;
  getAccountContactSuggestion(id: string): Promise<import('@shared/schema').AccountContactSuggestion | undefined>;
  updateAccountContactSuggestionStatus(id: string, status: string, opts: { userId?: string; snoozedUntil?: Date | null }): Promise<import('@shared/schema').AccountContactSuggestion | undefined>;
  getContactByEmailAndCompany(email: string, companyId: string): Promise<import('@shared/schema').Contact | undefined>;

  // Geographic Lane Patterns (Task #203)
  getGeographicLanePatterns(orgId?: string): Promise<import('@shared/schema').GeographicLanePattern[]>;
  getGeographicLanePattern(id: string): Promise<import('@shared/schema').GeographicLanePattern | undefined>;
  createGeographicLanePattern(data: import('@shared/schema').InsertGeographicLanePattern): Promise<import('@shared/schema').GeographicLanePattern>;
  seedBaselinePatterns(): Promise<void>;

  // Account Contact Lane Pattern Responsibilities (Task #203)
  createResponsibility(data: Omit<import('@shared/schema').InsertAccountContactLanePatternResponsibility, 'evidenceEventKeys' | 'sourceTypes'> & { evidenceEventKeys?: string[]; sourceTypes?: string[] }): Promise<import('@shared/schema').AccountContactLanePatternResponsibility>;
  updateResponsibility(id: string, data: Partial<import('@shared/schema').AccountContactLanePatternResponsibility>): Promise<import('@shared/schema').AccountContactLanePatternResponsibility>;
  getResponsibilityByKey(accountId: string, contactId: string, lanePatternId: string): Promise<import('@shared/schema').AccountContactLanePatternResponsibility | undefined>;
  getResponsibilitiesByAccount(accountId: string, filters?: {
    contactId?: string;
    lanePatternId?: string;
    status?: string;
    minConfidence?: number;
    responsibilityType?: string;
  }): Promise<import('@shared/schema').AccountContactLanePatternResponsibility[]>;
  getResponsibilitiesByContact(contactId: string, filters?: {
    accountId?: string;
    status?: string;
    minConfidence?: number;
    responsibilityType?: string;
  }): Promise<import('@shared/schema').AccountContactLanePatternResponsibility[]>;
  getResponsibility(id: string): Promise<import('@shared/schema').AccountContactLanePatternResponsibility | undefined>;
  confirmResponsibility(id: string, userId: string): Promise<import('@shared/schema').AccountContactLanePatternResponsibility | undefined>;
  dismissResponsibility(id: string, userId: string): Promise<import('@shared/schema').AccountContactLanePatternResponsibility | undefined>;

  // Contact Geography Suggestions (Task #225)
  upsertContactGeographySuggestion(data: InsertContactGeographySuggestion): Promise<ContactGeographySuggestion>;
  getContactGeographySuggestions(accountId: string, filters?: { contactId?: string; status?: string }): Promise<ContactGeographySuggestion[]>;
  getContactGeographySuggestion(id: string): Promise<ContactGeographySuggestion | undefined>;
  updateContactGeographySuggestionStatus(id: string, status: string, opts: { userId?: string }): Promise<ContactGeographySuggestion | undefined>;

  // Pinned Companies (Task #206)
  getPinnedCompanies(userId: string): Promise<import('@shared/schema').PinnedCompany[]>;
  pinCompany(userId: string, companyId: string): Promise<import('@shared/schema').PinnedCompany>;
  unpinCompany(userId: string, companyId: string): Promise<boolean>;
  isPinnedCompany(userId: string, companyId: string): Promise<boolean>;

  // Monitored Mailboxes (Task #230)
  getMonitoredMailboxes(orgId: string): Promise<MonitoredMailbox[]>;
  getMonitoredMailbox(id: string): Promise<MonitoredMailbox | undefined>;
  getMonitoredMailboxByEmail(orgId: string, email: string): Promise<MonitoredMailbox | undefined>;
  getEnabledMonitoredMailboxes(orgId?: string): Promise<MonitoredMailbox[]>;
  createMonitoredMailbox(data: InsertMonitoredMailbox): Promise<MonitoredMailbox>;
  updateMonitoredMailbox(id: string, data: Partial<InsertMonitoredMailbox>): Promise<MonitoredMailbox | undefined>;
  deleteMonitoredMailbox(id: string): Promise<boolean>;
  getUserByEmailAddress(email: string, orgId: string): Promise<User | undefined>;
  getMonitoredMailboxBySubscriptionId(subscriptionId: string): Promise<MonitoredMailbox | undefined>;

  // Mailbox sync failures (Task #438) — per-message failure tracking.
  upsertMailboxSyncFailure(data: {
    orgId: string;
    mailboxId: string;
    folder: string;
    providerMessageId: string;
    errorCategory: string;
    errorMessage: string;
    nextAttemptAt: Date | null;
  }): Promise<MailboxSyncFailure>;
  markMailboxSyncFailureResolved(mailboxId: string, folder: string, providerMessageId: string): Promise<void>;
  markMailboxSyncFailureResolvedById(id: string): Promise<MailboxSyncFailure | undefined>;
  markMailboxSyncFailureDismissed(id: string, orgId: string): Promise<MailboxSyncFailure | undefined>;
  markMailboxSyncFailureGiveUp(id: string): Promise<void>;
  getMailboxSyncFailure(id: string): Promise<MailboxSyncFailure | undefined>;
  getUnresolvedMailboxSyncFailures(mailboxId: string): Promise<MailboxSyncFailure[]>;
  countUnresolvedMailboxSyncFailures(mailboxId: string): Promise<number>;
  getDueMailboxSyncFailures(now: Date): Promise<MailboxSyncFailure[]>;
  getDueMailboxSyncFailuresForMailbox(mailboxId: string, now: Date): Promise<MailboxSyncFailure[]>;

  // Mailbox health alerts (Task #867 — self-healing email ingestion).
  // Open/close alert rows keyed by (mailboxId, alertKey) so the watchdog can
  // dedupe a recurring condition into a single notification per incident.
  fireMailboxHealthAlert(input: {
    orgId: string;
    mailboxId: string;
    alertKey: string;
    severity?: "info" | "warning" | "critical";
    reason: string;
  }): Promise<{ alert: MailboxHealthAlert; isNew: boolean }>;
  resolveMailboxHealthAlert(mailboxId: string, alertKey: string): Promise<MailboxHealthAlert | undefined>;
  getOpenMailboxHealthAlerts(orgId: string): Promise<MailboxHealthAlert[]>;
  getOpenMailboxHealthAlertsForMailbox(mailboxId: string): Promise<MailboxHealthAlert[]>;

  // Cron heartbeats (never-fail-again pass) — every recurring background
  // job writes here so we can detect when one silently dies. See
  // server/lib/cronHeartbeat.ts for the wrapper that drives these.
  recordCronHeartbeatStart(jobName: string, expectedIntervalMs: number): Promise<void>;
  recordCronHeartbeatFinish(
    jobName: string,
    status: "success" | "error",
    durationMs: number,
    error?: string,
  ): Promise<void>;
  getCronHeartbeats(): Promise<CronHeartbeat[]>;
  getStaleCronHeartbeats(graceFactor?: number): Promise<CronHeartbeat[]>;

  // Webex user mappings (Task #258)
  getWebexUserMappings(orgId: string): Promise<WebexUserMapping[]>;
  getWebexUserMappingByPersonId(orgId: string, webexPersonId: string): Promise<WebexUserMapping | undefined>;
  getWebexUserMappingByEmail(orgId: string, webexEmail: string): Promise<WebexUserMapping | undefined>;
  upsertWebexUserMapping(data: InsertWebexUserMapping): Promise<WebexUserMapping>;
  updateWebexUserMapping(id: string, orgId: string, data: Partial<InsertWebexUserMapping>): Promise<WebexUserMapping | undefined>;
  deleteWebexUserMapping(id: string, orgId: string): Promise<boolean>;
  getMonitoredMailboxByAnySubscriptionId(subscriptionId: string): Promise<MonitoredMailbox | undefined>;

  // Task #589 — POD intake (getpaid@valuetruckaz.com AR mailbox).
  // Task #614 — adds delivery filter, per-user listing, per-load listing.
  upsertPodIntakeEmail(data: InsertPodIntakeEmail): Promise<PodIntakeEmail>;
  getPodIntakeEmail(orgId: string, id: string): Promise<PodIntakeEmail | undefined>;
  listPodIntakeEmails(orgId: string, opts: {
    bucket: "forwarded" | "unmatched" | "not_pod" | "pending" | "delivered_in_app" | "all";
    delivery?: "email" | "in_app" | "all";
    limit?: number;
  }): Promise<PodIntakeEmail[]>;
  listPodIntakeEmailsForUser(userId: string, orgId: string, opts?: { limit?: number }): Promise<PodIntakeEmail[]>;
  listPodIntakeEmailsByOrderId(orgId: string, orderId: string, opts?: { limit?: number }): Promise<PodIntakeEmail[]>;
  updatePodIntakeEmail(orgId: string, id: string, patch: Partial<InsertPodIntakeEmail>): Promise<PodIntakeEmail | undefined>;
  getPodIntakeSettings(orgId: string): Promise<PodIntakeSettings | undefined>;
  upsertPodIntakeSettings(data: InsertPodIntakeSettings): Promise<PodIntakeSettings>;

  // Task #508 — Mailbox 30-day historical backfill state.
  createMailboxHistoricalBackfill(data: InsertMailboxHistoricalBackfill): Promise<MailboxHistoricalBackfill>;
  updateMailboxHistoricalBackfill(id: string, data: Partial<InsertMailboxHistoricalBackfill>): Promise<MailboxHistoricalBackfill | undefined>;
  getMailboxHistoricalBackfill(id: string): Promise<MailboxHistoricalBackfill | undefined>;
  getLatestMailboxHistoricalBackfill(mailboxId: string): Promise<MailboxHistoricalBackfill | undefined>;
  getMailboxHistoricalBackfillsForOrg(orgId: string): Promise<MailboxHistoricalBackfill[]>;

  // Per-user Webex OAuth tokens (Task #261)
  getWebexUserToken(userId: string): Promise<WebexUserToken | undefined>;
  getWebexUserTokensForOrg(orgId: string): Promise<WebexUserToken[]>;
  upsertWebexUserToken(data: InsertWebexUserToken): Promise<WebexUserToken>;
  updateWebexUserToken(userId: string, updates: Partial<InsertWebexUserToken>): Promise<WebexUserToken | undefined>;
  deleteWebexUserToken(userId: string): Promise<boolean>;
  getWebexUserTokensNeedingReauthEmail(emailedBefore: Date): Promise<WebexUserToken[]>;

  // Webex call-quality analytics (Task #315)
  upsertWebexCallAnalytics(data: InsertWebexCallAnalytics): Promise<WebexCallAnalytics>;
  mergeWebexCallEnrichment(orgId: string, callId: string, metrics: {
    talkTimeSeconds?: number;
    holdTimeSeconds?: number;
    silenceSeconds?: number;
    ringTimeSeconds?: number;
    mosScore?: string | null;
    jitterMs?: string | null;
    packetLossPct?: string | null;
    qualityGrade?: string | null;
  }): Promise<void>;
  getWebexCallAnalyticsByCallId(orgId: string, callId: string): Promise<WebexCallAnalytics | undefined>;

  // Webex Full Coverage & Backfill (Task #466)
  getWebexSyncState(orgId: string, dataSource: string, userId?: string | null): Promise<WebexSyncState | undefined>;
  getWebexSyncStatesForOrg(orgId: string): Promise<WebexSyncState[]>;
  upsertWebexSyncState(data: InsertWebexSyncState): Promise<WebexSyncState>;
  enqueueWebexEnrichmentJob(data: InsertWebexCallEnrichmentJob): Promise<WebexCallEnrichmentJob>;
  claimDueWebexEnrichmentJobs(limit: number): Promise<WebexCallEnrichmentJob[]>;
  completeWebexEnrichmentJob(id: string): Promise<void>;
  failWebexEnrichmentJob(id: string, attempts: number, nextRetryAt: Date | null, lastError: string, terminal: boolean): Promise<void>;
  countWebexEnrichmentJobsByStatus(orgId: string): Promise<Record<string, number>>;
  upsertWebexVoicemail(data: InsertWebexVoicemail): Promise<WebexVoicemail>;
  upsertWebexInventoryItems(items: InsertWebexInventory[]): Promise<number>;
  getWebexInventoryByKind(orgId: string, kind: string): Promise<WebexInventory[]>;

  // Webex real-time webhooks (Task #741)
  listWebexWebhookSubscriptions(orgId: string): Promise<WebexWebhookSubscription[]>;
  getWebexWebhookSubscription(id: string): Promise<WebexWebhookSubscription | undefined>;
  findWebexWebhookSubscription(args: {
    orgId: string;
    userId: string | null;
    resource: string;
    event: string;
  }): Promise<WebexWebhookSubscription | undefined>;
  upsertWebexWebhookSubscription(data: InsertWebexWebhookSubscription): Promise<WebexWebhookSubscription>;
  updateWebexWebhookSubscription(id: string, updates: Partial<InsertWebexWebhookSubscription>): Promise<WebexWebhookSubscription | undefined>;
  recordWebexWebhookHit(id: string, receivedAt: Date): Promise<void>;
  deleteWebexWebhookSubscription(id: string): Promise<void>;
  insertWebexWebhookEvent(data: InsertWebexWebhookEvent): Promise<{ row: WebexWebhookEvent; inserted: boolean }>;
  markWebexWebhookEventProcessed(id: string, error?: string | null): Promise<void>;
  getWebexWebhookHealth(orgId: string): Promise<{
    subscriptions: WebexWebhookSubscription[];
    lastEventAt: Date | null;
    eventsLast7d: number;
    eventsLast24h: number;
    eventsLast15m: number;
    failedLast24h: number;
  }>;
  getLatestWebexWebhookEventAt(orgId: string): Promise<Date | null>;

  // API cache methods (Task #231)
  getCachedApiResponse(key: string): Promise<ApiResponseCache | undefined>;
  setCachedApiResponse(key: string, response: unknown, ttlSeconds: number, source: string): Promise<void>;
  getValidCachedApiResponses(source: string): Promise<ApiResponseCache[]>;
  getAllCachedApiResponses(source: string): Promise<ApiResponseCache[]>;
  cleanExpiredApiCache(): Promise<number>;

  // Proactive Available Freight Outreach Engine — Phase 2 (Task #304)
  getCompanyOutreachPolicy(orgId: string, companyId: string): Promise<CompanyOutreachPolicy | undefined>;
  upsertCompanyOutreachPolicy(data: InsertCompanyOutreachPolicy): Promise<CompanyOutreachPolicy>;
  listCompanyOutreachPolicies(orgId: string, opts?: { enabledOnly?: boolean }): Promise<CompanyOutreachPolicy[]>;

  createFreightOpportunity(data: InsertFreightOpportunity): Promise<FreightOpportunity>;
  getFreightOpportunity(orgId: string, id: string): Promise<FreightOpportunity | undefined>;
  listFreightOpportunities(orgId: string, opts?: {
    companyId?: string;
    status?: string | string[];
    limit?: number;
    offset?: number;
  }): Promise<FreightOpportunity[]>;
  updateFreightOpportunity(orgId: string, id: string, fields: Partial<FreightOpportunity>, opts?: { allowCoveredTransition?: boolean }): Promise<FreightOpportunity | undefined>;

  insertFreightOpportunityCarriers(rows: InsertFreightOpportunityCarrier[]): Promise<FreightOpportunityCarrier[]>;
  listFreightOpportunityCarriers(opportunityId: string): Promise<FreightOpportunityCarrier[]>;
  updateFreightOpportunityCarrier(id: string, fields: Partial<FreightOpportunityCarrier>): Promise<FreightOpportunityCarrier | undefined>;

  createFreightOpportunityResponse(data: InsertFreightOpportunityResponse): Promise<FreightOpportunityResponse>;
  listFreightOpportunityResponses(opportunityCarrierId: string): Promise<FreightOpportunityResponse[]>;

  appendFreightOpportunityAudit(data: InsertFreightOpportunityAudit): Promise<FreightOpportunityAudit>;
  listFreightOpportunityAudit(opportunityId: string): Promise<FreightOpportunityAudit[]>;
  /** Count opps that transitioned to a covered/partially_covered status since
   * `since` for this org — used by the cockpit "Covered today" KPI. */
  countFreightOpportunitiesCoveredSince(orgId: string, since: Date): Promise<number>;
  /** Distinct carrier IDs that received outreach within the given lookback window (cross-lane). */
  getRecentlyContactedCarrierIds(orgId: string, sinceDate: Date): Promise<string[]>;

  // PAFOE Phase 4 — outreach templates + scheduled-wave + thread lookup helpers
  listFreightOutreachTemplates(orgId: string): Promise<FreightOutreachTemplate[]>;
  getFreightOutreachTemplate(orgId: string, kind: FreightOutreachTemplateKind): Promise<FreightOutreachTemplate | undefined>;
  upsertFreightOutreachTemplate(data: InsertFreightOutreachTemplate): Promise<FreightOutreachTemplate>;
  /** Carrier rows due to send (scheduled_for <= now AND sent_at IS NULL). */
  listDueScheduledOpportunityCarriers(now: Date, limit?: number): Promise<FreightOpportunityCarrier[]>;
  /** Find any opportunity-carrier rows whose Outlook thread/message ID matches an inbound reply. */
  findOpportunityCarriersByThreadOrMessage(orgId: string, opts: { threadId?: string | null; internetMessageId?: string | null }): Promise<FreightOpportunityCarrier[]>;

  // Available Freight Cockpit (Task #601)
  listFreightOpportunitySavedViews(orgId: string, userId: string): Promise<FreightOpportunitySavedView[]>;
  createFreightOpportunitySavedView(data: InsertFreightOpportunitySavedView): Promise<FreightOpportunitySavedView>;
  updateFreightOpportunitySavedView(id: string, userId: string, fields: Partial<Pick<FreightOpportunitySavedView, "name" | "filters" | "isShared">>, orgId?: string): Promise<FreightOpportunitySavedView | undefined>;
  deleteFreightOpportunitySavedView(id: string, userId: string, orgId?: string): Promise<boolean>;
  getUserFreightCockpitPrefs(userId: string): Promise<UserFreightCockpitPrefs | undefined>;
  upsertUserFreightCockpitPrefs(data: InsertUserFreightCockpitPrefs): Promise<UserFreightCockpitPrefs>;
  getUserLaneInboxPrefs(userId: string): Promise<UserLaneInboxPrefs | undefined>;
  upsertUserLaneInboxPrefs(data: InsertUserLaneInboxPrefs): Promise<UserLaneInboxPrefs>;

  // ── Capacity Matches (Task #844) ───────────────────────────────────────────
  insertTruckPostings(rows: InsertTruckPosting[]): Promise<TruckPosting[]>;
  getTruckPosting(id: string): Promise<TruckPosting | undefined>;
  listTruckPostingsByOrg(orgId: string, opts?: { status?: string; limit?: number }): Promise<TruckPosting[]>;
  listActiveTruckPostingsByOrg(orgId: string): Promise<TruckPosting[]>;
  expireTruckPostings(now: Date): Promise<number>;
  updateTruckPostingStatus(id: string, status: string): Promise<void>;

  upsertTruckLoadMatch(data: InsertTruckLoadMatch): Promise<TruckLoadMatch>;
  getTruckLoadMatch(id: string): Promise<TruckLoadMatch | undefined>;
  listTruckLoadMatchesByOrg(orgId: string, opts?: {
    states?: TruckLoadMatchState[];
    assignedRepIds?: string[];
    minScore?: number;
    limit?: number;
  }): Promise<TruckLoadMatch[]>;
  listTruckLoadMatchesByPosting(postingId: string): Promise<TruckLoadMatch[]>;
  listTruckLoadMatchesByOpportunity(opportunityId: string): Promise<TruckLoadMatch[]>;
  updateTruckLoadMatchState(id: string, fields: {
    state: TruckLoadMatchState;
    actorUserId?: string | null;
    dismissedReason?: string | null;
  }): Promise<TruckLoadMatch | undefined>;
  markTruckLoadMatchNotified(id: string): Promise<void>;
  countTruckLoadMatchesByRep(orgId: string, opts?: { states?: TruckLoadMatchState[] }): Promise<Array<{ assignedRepId: string | null; count: number }>>;
  getTruckLoadMatchStats(orgId: string): Promise<{
    postingsActive: number;
    matchesActive: number;
    matchesStrong: number;
    bookedToday: number;
    contactedToday: number;
    parsedToday: number;
  }>;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(pool);
export { db };

export class DatabaseStorage implements IStorage {
  readonly pool = pool;

  // ── Financial uploads in-memory cache ──────────────────────────────────────
  // getFinancialUploadsForOrg loads potentially megabytes of JSONB on every
  // call and is used in 12+ routes (carrier ranking, historical data, lane
  // work queue, carrier hub, etc.).  A 5-minute TTL cache per org keeps the
  // data fresh enough while eliminating redundant full-table scans.
  private _finUploadsCache = new Map<string, { data: FinancialUpload[]; expiresAt: number }>();
  private readonly _FIN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /** Invalidate the financial uploads cache for an org (or all orgs). */
  private _invalidateFinCache(organizationId?: string) {
    if (organizationId) {
      this._finUploadsCache.delete(organizationId);
    } else {
      this._finUploadsCache.clear();
    }
  }

  /**
   * Pre-warm the cache by loading uploads for the org that owns `userId`.
   * Intended to be called fire-and-forget after an upload so the new data
   * is in cache before the next user request arrives.
   */
  private async _preWarmFinCacheForOrg(userId: string): Promise<void> {
    const [user] = await db.select({ organizationId: users.organizationId })
      .from(users).where(eq(users.id, userId)).limit(1);
    if (user?.organizationId) {
      await this.getFinancialUploadsForOrg(user.organizationId);
    }
  }

  /**
   * Pre-warm the financial uploads cache for all orgs at startup.
   * Called once in the background after the server is ready so the first
   * carrier-suggestions request doesn't hit a cold DB scan.
   */
  async preWarmFinancialUploadsCache(): Promise<void> {
    try {
      const orgs = await this.getOrganizations();
      for (const org of orgs) {
        try {
          await this.getFinancialUploadsForOrg(org.id);
          console.log(`[fin-cache] pre-warmed org ${org.slug ?? org.id}`);
        } catch {
          // Non-fatal — cache will miss for this org on first request
        }
      }
    } catch {
      // Non-fatal
    }
  }

  async getDefaultOrganization(): Promise<Organization | undefined> {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "valuetruck"));
    return org;
  }

  async getOrganizations(): Promise<Organization[]> {
    return db.select().from(organizations);
  }

  async getOrganizationById(id: string): Promise<Organization | undefined> {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, id));
    return org;
  }

  async createOrganization(data: { name: string; slug: string }): Promise<Organization> {
    const [org] = await db.insert(organizations).values(data).returning();
    return org;
  }

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserInOrg(id: string, organizationId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users)
      .where(and(eq(users.id, id), eq(users.organizationId, organizationId)));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async getUserByClerkId(clerkUserId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
    return user;
  }

  async createPasswordResetToken(userId: string, token: string, expiresAt: string): Promise<void> {
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
    await db.insert(passwordResetTokens).values({ userId, token, expiresAt, createdAt: new Date().toISOString() });
  }

  async getPasswordResetToken(token: string): Promise<{ userId: string; expiresAt: string } | undefined> {
    const [row] = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.token, token));
    if (!row) return undefined;
    return { userId: row.userId, expiresAt: row.expiresAt };
  }

  async deletePasswordResetTokensByUser(userId: string): Promise<void> {
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
  }

  async getUsers(organizationId: string): Promise<User[]> {
    return db.select().from(users).where(eq(users.organizationId, organizationId));
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    // Guard: users.username is the rep's login email and is auto-enrolled into
    // monitored_mailboxes by the bulk "enroll all" admin flow. A fixture
    // username (e.g. wq.test.*@example.com) would silently re-pollute the
    // mailbox subscription health rollup. Reject at the boundary so the
    // contamination cannot recur from this code path.
    assertNotFixtureEmail(insertUser.username, "users.username");
    const [user] = await db.insert(users).values({ ...insertUser, createdAt: insertUser.createdAt || new Date().toISOString() }).returning();
    return user;
  }

  async updateUser(id: string, organizationId: string, data: Partial<InsertUser>): Promise<User | undefined> {
    const [updated] = await db.update(users).set(data).where(and(eq(users.id, id), eq(users.organizationId, organizationId))).returning();
    return updated;
  }

  async deleteUser(id: string, organizationId: string): Promise<boolean> {
    const result = await db.delete(users).where(and(eq(users.id, id), eq(users.organizationId, organizationId))).returning();
    return result.length > 0;
  }

  async getTeamMemberIds(userId: string, organizationId: string): Promise<string[]> {
    const ids = [userId];
    const queue = [userId];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const directReports = await db.select().from(users).where(
        and(eq(users.managerId, currentId), eq(users.organizationId, organizationId))
      );
      for (const report of directReports) {
        if (!ids.includes(report.id)) {
          ids.push(report.id);
          queue.push(report.id);
        }
      }
    }
    return ids;
  }

  async getManagerChainIds(userId: string, organizationId: string): Promise<string[]> {
    const ids: string[] = [];
    let currentId = userId;
    while (true) {
      const [user] = await db.select().from(users).where(
        and(eq(users.id, currentId), eq(users.organizationId, organizationId))
      );
      if (!user || !user.managerId) break;
      if (ids.includes(user.managerId)) break;
      ids.push(user.managerId);
      currentId = user.managerId;
    }
    return ids;
  }

  async wouldCreateManagerCycle(userId: string, newManagerId: string, organizationId: string): Promise<boolean> {
    // Self-reference: a user can never report to themselves.
    if (userId === newManagerId) return true;
    // Walk the proposed manager's chain upward; if we hit `userId`, the new
    // assignment would close a cycle. Bounded by the seen-set so any
    // pre-existing cycle in the data exits cleanly instead of looping forever.
    const seen = new Set<string>();
    let currentId: string | null = newManagerId;
    while (currentId) {
      if (currentId === userId) return true;
      if (seen.has(currentId)) break;
      seen.add(currentId);
      const [user] = await db.select().from(users).where(
        and(eq(users.id, currentId), eq(users.organizationId, organizationId))
      );
      if (!user) break;
      currentId = user.managerId ?? null;
    }
    return false;
  }

  async getCompanies(organizationId: string): Promise<Company[]> {
    const key = `companies:${organizationId}`;
    const cached = cacheGet<Company[]>(key);
    if (cached) return cached;
    const result = await db.select().from(companies).where(eq(companies.organizationId, organizationId));
    cacheSet(key, result, 30_000);
    return result;
  }

  async getCompaniesByIds(ids: string[], organizationId: string): Promise<Company[]> {
    if (ids.length === 0) return [];
    return db.select().from(companies).where(and(inArray(companies.id, ids), eq(companies.organizationId, organizationId)));
  }

  async getCompany(id: string): Promise<Company | undefined> {
    const [company] = await db.select().from(companies).where(eq(companies.id, id));
    return company;
  }

  async getCompanyInOrg(id: string, organizationId: string): Promise<Company | undefined> {
    const [company] = await db.select().from(companies).where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)));
    return company;
  }

  async createCompany(company: InsertCompany): Promise<Company> {
    // Guard: companies.dl_email is read by outbound email schedulers (carrier
    // outreach, weekly review, intel digests). A fixture address there means
    // an org-wide message will silently land in /dev/null. Reject inserts.
    assertNotFixtureEmail(company.dlEmail, "companies.dl_email");
    const [created] = await db.insert(companies).values(company).returning();
    cacheInvalidatePrefix("companies:");
    return created;
  }

  async bulkCreateCompanies(companiesList: InsertCompany[]): Promise<Company[]> {
    if (companiesList.length === 0) return [];
    // Bulk variant — quarantine fixture rows by FILTERING them out rather
    // than throwing. A 5,000-row CSV import containing one accidental
    // @example.com address must not abort the entire batch (would turn a
    // data-quality issue into an outage). We log the count and the
    // single-row createCompany guard still throws for explicit unit
    // creates where the caller expects immediate feedback.
    const quarantined = companiesList.filter(c => isFixtureMailboxAddress(c.dlEmail));
    if (quarantined.length > 0) {
      console.warn(`[bulkCreateCompanies] dropped ${quarantined.length} rows with fixture dlEmail (e.g. ${quarantined[0].dlEmail})`);
      companiesList = companiesList.filter(c => !isFixtureMailboxAddress(c.dlEmail));
      if (companiesList.length === 0) return [];
    }
    const firstOrgId = companiesList[0].organizationId;
    const existing = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.organizationId, firstOrgId));
    const existingNamesLower = new Map(existing.map(c => [c.name.toLowerCase().trim(), c]));
    const toInsert = companiesList.filter(c => !existingNamesLower.has(c.name.toLowerCase().trim()));
    if (toInsert.length === 0) {
      cacheInvalidatePrefix("companies:");
      return [];
    }
    const created = await db.insert(companies).values(toInsert).returning();
    cacheInvalidatePrefix("companies:");
    return created;
  }

  async updateCompany(id: string, organizationId: string, company: Partial<InsertCompany>): Promise<Company | undefined> {
    const [updated] = await db
      .update(companies)
      .set(company)
      .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)))
      .returning();
    cacheInvalidatePrefix("companies:");
    return updated;
  }

  async deleteCompany(id: string, organizationId: string): Promise<boolean> {
    const result = await db.delete(companies).where(and(eq(companies.id, id), eq(companies.organizationId, organizationId))).returning();
    cacheInvalidatePrefix("companies:");
    return result.length > 0;
  }

  async archiveCompany(id: string, organizationId: string): Promise<Company | undefined> {
    const [updated] = await db
      .update(companies)
      .set({ archivedAt: new Date().toISOString() })
      .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)))
      .returning();
    cacheInvalidatePrefix("companies:");
    return updated;
  }

  async unarchiveCompany(id: string, organizationId: string): Promise<Company | undefined> {
    const [updated] = await db
      .update(companies)
      .set({ archivedAt: null })
      .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)))
      .returning();
    cacheInvalidatePrefix("companies:");
    return updated;
  }

  // ============= Company Collaborators (manual visibility sharing) =============

  async listCollaboratorsForCompany(companyId: string, organizationId: string): Promise<Array<CompanyCollaborator & { userName: string; userRole: string }>> {
    const rows = await db
      .select({
        id: companyCollaborators.id,
        organizationId: companyCollaborators.organizationId,
        companyId: companyCollaborators.companyId,
        userId: companyCollaborators.userId,
        addedByUserId: companyCollaborators.addedByUserId,
        createdAt: companyCollaborators.createdAt,
        userName: users.name,
        userRole: users.role,
      })
      .from(companyCollaborators)
      .innerJoin(users, eq(users.id, companyCollaborators.userId))
      .where(and(
        eq(companyCollaborators.companyId, companyId),
        eq(companyCollaborators.organizationId, organizationId),
      ));
    return rows;
  }

  async addCompanyCollaborator(input: InsertCompanyCollaborator): Promise<CompanyCollaborator> {
    const [row] = await db
      .insert(companyCollaborators)
      .values(input)
      .onConflictDoNothing({ target: [companyCollaborators.companyId, companyCollaborators.userId] })
      .returning();
    if (row) return row;
    // Conflict — return existing row
    const [existing] = await db
      .select()
      .from(companyCollaborators)
      .where(and(
        eq(companyCollaborators.companyId, input.companyId),
        eq(companyCollaborators.userId, input.userId),
      ));
    return existing;
  }

  async removeCompanyCollaborator(companyId: string, userId: string, organizationId: string): Promise<boolean> {
    const result = await db
      .delete(companyCollaborators)
      .where(and(
        eq(companyCollaborators.companyId, companyId),
        eq(companyCollaborators.userId, userId),
        eq(companyCollaborators.organizationId, organizationId),
      ))
      .returning();
    return result.length > 0;
  }

  /** Companies the given user is currently a collaborator on. */
  async getCollaboratorCompanyIds(userId: string, organizationId: string): Promise<string[]> {
    const rows = await db
      .select({ companyId: companyCollaborators.companyId })
      .from(companyCollaborators)
      .where(and(
        eq(companyCollaborators.userId, userId),
        eq(companyCollaborators.organizationId, organizationId),
      ));
    return rows.map(r => r.companyId);
  }

  /** All accounts on which `viewerId` may MANAGE collaborators. Per product policy:
   *  - admins / directors / sales_director: any company in the org
   *  - everyone else: companies they own + companies owned by their direct reports
   */
  async getAccountsManageableForSharing(viewerId: string, viewerRole: string, organizationId: string): Promise<Company[]> {
    const ADMIN_ROLES = new Set(["admin", "director", "sales_director"]);
    if (ADMIN_ROLES.has(viewerRole)) {
      return db.select().from(companies).where(and(
        eq(companies.organizationId, organizationId),
        isNull(companies.archivedAt),
      ));
    }
    // Owner OR owner-is-a-direct-report-of-viewer
    const directReports = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.managerId, viewerId), eq(users.organizationId, organizationId)));
    const allowedOwnerIds = [viewerId, ...directReports.map(r => r.id)];
    return db.select().from(companies).where(and(
      eq(companies.organizationId, organizationId),
      isNull(companies.archivedAt),
      inArray(companies.assignedTo, allowedOwnerIds),
    ));
  }

  async getContacts(): Promise<Contact[]> {
    return db.select().from(contacts);
  }

  async getContactsByOrg(organizationId: string): Promise<Contact[]> {
    return db
      .select({ c: contacts })
      .from(contacts)
      .innerJoin(companies, eq(companies.id, contacts.companyId))
      .where(eq(companies.organizationId, organizationId))
      .then((rows) => rows.map((r) => r.c));
  }

  async getContactsByCompany(companyId: string): Promise<Contact[]> {
    return db.select().from(contacts).where(eq(contacts.companyId, companyId));
  }

  async getContactsByCompanyIds(companyIds: string[]): Promise<Contact[]> {
    if (companyIds.length === 0) return [];
    return db.select().from(contacts).where(inArray(contacts.companyId, companyIds));
  }

  async getContactsByIds(ids: string[]): Promise<Contact[]> {
    if (ids.length === 0) return [];
    return db.select().from(contacts).where(inArray(contacts.id, ids));
  }

  async logContactBaseHistory(contactId: string, fromBase: string | null, toBase: string, changedById: string): Promise<void> {
    await db.insert(contactBaseHistory).values({ contactId, fromBase: fromBase ?? null, toBase, changedById });
  }

  async getContactBaseHistory(contactId: string): Promise<ContactBaseHistoryRow[]> {
    const rows = await db
      .select({
        id: contactBaseHistory.id,
        fromBase: contactBaseHistory.fromBase,
        toBase: contactBaseHistory.toBase,
        changedAt: contactBaseHistory.changedAt,
        changedByName: users.name,
      })
      .from(contactBaseHistory)
      .leftJoin(users, eq(contactBaseHistory.changedById, users.id))
      .where(eq(contactBaseHistory.contactId, contactId))
      .orderBy(desc(contactBaseHistory.changedAt));
    return rows;
  }

  async getContact(id: string): Promise<Contact | undefined> {
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, id));
    return contact;
  }

  async createContact(contact: InsertContact): Promise<Contact> {
    // Guard: contacts.email is the destination for AI-drafted emails, carrier
    // outreach, intel digests, and the customer touchpoint workflow. A
    // fixture address would silently absorb real outbound traffic.
    assertNotFixtureEmail(contact.email, "contacts.email");
    const [created] = await db.insert(contacts).values(contact).returning();
    return created;
  }

  async bulkCreateContacts(contactList: InsertContact[]): Promise<Contact[]> {
    if (contactList.length === 0) return [];
    // Bulk variant — quarantine fixture rows by FILTERING them out rather
    // than throwing. CSV imports must not abort because of a single
    // accidental @example.com entry. The single-row createContact guard
    // still throws for unit creates where caller wants immediate feedback.
    const quarantined = contactList.filter(c => isFixtureMailboxAddress(c.email));
    if (quarantined.length > 0) {
      console.warn(`[bulkCreateContacts] dropped ${quarantined.length} rows with fixture email (e.g. ${quarantined[0].email})`);
      contactList = contactList.filter(c => !isFixtureMailboxAddress(c.email));
      if (contactList.length === 0) return [];
    }
    const companyIds = [...new Set(contactList.map(c => c.companyId))];
    const existing = await db
      .select({ id: contacts.id, companyId: contacts.companyId, email: contacts.email, name: contacts.name })
      .from(contacts)
      .where(inArray(contacts.companyId, companyIds));
    const existingKeys = new Set(
      existing.map(c => {
        const emailKey = c.email ? `email:${c.companyId}:${c.email.toLowerCase().trim()}` : null;
        const nameKey = `name:${c.companyId}:${c.name.toLowerCase().trim()}`;
        return [emailKey, nameKey].filter(Boolean);
      }).flat()
    );
    const toInsert = contactList.filter(c => {
      const emailKey = c.email ? `email:${c.companyId}:${c.email.toLowerCase().trim()}` : null;
      const nameKey = `name:${c.companyId}:${c.name.toLowerCase().trim()}`;
      return !existingKeys.has(emailKey ?? "") && !existingKeys.has(nameKey);
    });
    if (toInsert.length === 0) return [];
    return db.insert(contacts).values(toInsert).returning();
  }

  async updateContact(id: string, contact: InsertContact): Promise<Contact | undefined> {
    const [updated] = await db
      .update(contacts)
      .set(contact)
      .where(eq(contacts.id, id))
      .returning();
    return updated;
  }

  async deleteContact(id: string): Promise<boolean> {
    const result = await db.delete(contacts).where(eq(contacts.id, id)).returning();
    return result.length > 0;
  }

  async getRfps(): Promise<Rfp[]> {
    return db.select().from(rfps);
  }

  async getRfpsByOrg(organizationId: string): Promise<Rfp[]> {
    return db
      .select({ r: rfps })
      .from(rfps)
      .innerJoin(companies, eq(companies.id, rfps.companyId))
      .where(eq(companies.organizationId, organizationId))
      .then((rows) => rows.map((r) => r.r));
  }

  async getRfp(id: string): Promise<Rfp | undefined> {
    const [rfp] = await db.select().from(rfps).where(eq(rfps.id, id));
    return rfp;
  }

  async getRfpInOrg(id: string, orgId: string): Promise<Rfp | undefined> {
    // RFPs reference companies; companies.organizationId is the tenant
    // boundary. Inner-join enforces it; cross-org IDs return undefined.
    const [row] = await db
      .select({ r: rfps })
      .from(rfps)
      .innerJoin(companies, eq(companies.id, rfps.companyId))
      .where(and(eq(rfps.id, id), eq(companies.organizationId, orgId)));
    return row?.r;
  }

  async getRfpsByCompanyId(companyId: string): Promise<Rfp[]> {
    return db.select().from(rfps).where(eq(rfps.companyId, companyId));
  }

  async createRfp(rfp: InsertRfp): Promise<Rfp> {
    const [created] = await db.insert(rfps).values(rfp).returning();
    return created;
  }

  async updateRfp(id: string, rfp: InsertRfp): Promise<Rfp | undefined> {
    const [updated] = await db
      .update(rfps)
      .set(rfp)
      .where(eq(rfps.id, id))
      .returning();
    return updated;
  }

  async deleteRfp(id: string): Promise<boolean> {
    const result = await db.delete(rfps).where(eq(rfps.id, id)).returning();
    return result.length > 0;
  }

  async getAwards(): Promise<Award[]> {
    return db.select().from(awards);
  }

  async getAwardsByOrg(organizationId: string): Promise<Award[]> {
    return db
      .select({ a: awards })
      .from(awards)
      .innerJoin(companies, eq(companies.id, awards.companyId))
      .where(eq(companies.organizationId, organizationId))
      .then((rows) => rows.map((r) => r.a));
  }

  async getAward(id: string): Promise<Award | undefined> {
    const [award] = await db.select().from(awards).where(eq(awards.id, id));
    return award;
  }

  async getAwardsByCompanyId(companyId: string): Promise<Award[]> {
    return db.select().from(awards).where(eq(awards.companyId, companyId));
  }

  async getAwardInOrg(id: string, orgId: string): Promise<Award | undefined> {
    // Same pattern as getRfpInOrg — enforce tenant via companies join.
    const [row] = await db
      .select({ a: awards })
      .from(awards)
      .innerJoin(companies, eq(companies.id, awards.companyId))
      .where(and(eq(awards.id, id), eq(companies.organizationId, orgId)));
    return row?.a;
  }

  async createAward(award: InsertAward): Promise<Award> {
    const [created] = await db.insert(awards).values(award).returning();
    return created;
  }

  async updateAward(id: string, award: InsertAward): Promise<Award | undefined> {
    const [updated] = await db
      .update(awards)
      .set(award)
      .where(eq(awards.id, id))
      .returning();
    return updated;
  }

  async deleteAward(id: string): Promise<boolean> {
    const result = await db.delete(awards).where(eq(awards.id, id)).returning();
    return result.length > 0;
  }

  async getFinancialUploads(): Promise<FinancialUpload[]> {
    return db.select().from(financialUploads);
  }

  async getFinancialUploadsForOrg(organizationId: string): Promise<FinancialUpload[]> {
    const cached = this._finUploadsCache.get(organizationId);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    const orgUserIds = (await this.getUsers(organizationId)).map(u => u.id);
    if (orgUserIds.length === 0) return [];
    const data = await db.select().from(financialUploads)
      .where(inArray(financialUploads.uploadedBy, orgUserIds))
      .orderBy(asc(financialUploads.uploadedAt));
    this._finUploadsCache.set(organizationId, { data, expiresAt: Date.now() + this._FIN_CACHE_TTL });
    return data;
  }

  async getLatestFinancialUpload(): Promise<FinancialUpload | undefined> {
    const [latest] = await db.select().from(financialUploads)
      .orderBy(desc(financialUploads.uploadedAt))
      .limit(1);
    return latest;
  }

  async getLatestFinancialUploadForOrg(organizationId: string): Promise<FinancialUpload | undefined> {
    const orgUserIds = (await this.getUsers(organizationId)).map(u => u.id);
    if (orgUserIds.length === 0) return undefined;
    const [latest] = await db.select().from(financialUploads)
      .where(inArray(financialUploads.uploadedBy, orgUserIds))
      .orderBy(desc(financialUploads.uploadedAt))
      .limit(1);
    return latest;
  }

  async getFinancialUploadById(id: string): Promise<FinancialUpload | undefined> {
    const [upload] = await db.select().from(financialUploads)
      .where(eq(financialUploads.id, id));
    return upload;
  }

  async createFinancialUpload(upload: InsertFinancialUpload): Promise<FinancialUpload> {
    console.log(`[createFinancialUpload] rows.length=${upload.rows ? (upload.rows as any[]).length : 0}, rowCount=${upload.rowCount}`);

    const result = await pool.query<FinancialUpload & { id: string }>(
      `INSERT INTO financial_uploads
        (file_name, uploaded_at, uploaded_by, row_count, rows, summary_rows,
         best_deal_days_spot, best_deal_days_all, trend_analysis, averages_data, daily_acquisition)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
       RETURNING *`,
      [
        upload.fileName,
        upload.uploadedAt,
        upload.uploadedBy,
        upload.rowCount,
        JSON.stringify(upload.rows ?? []),
        JSON.stringify(upload.summaryRows ?? []),
        JSON.stringify(upload.bestDealDaysSpot ?? []),
        JSON.stringify(upload.bestDealDaysAll ?? []),
        JSON.stringify(upload.trendAnalysis ?? []),
        JSON.stringify(upload.averagesData ?? []),
        JSON.stringify(upload.dailyAcquisition ?? []),
      ]
    );

    // pool.query() returns untyped rows; the RETURNING * clause guarantees the
    // shape matches FinancialUpload (all columns from the financial_uploads table).
    const created = result.rows[0] as unknown as FinancialUpload;

    const verifyResult = await pool.query<{ len: string }>(
      `SELECT jsonb_array_length(rows) AS len FROM financial_uploads WHERE id = $1`,
      [created.id]
    );
    const storedLength = parseInt(verifyResult.rows[0]?.len ?? "0", 10);
    console.log(`[createFinancialUpload] stored rows length=${storedLength}, expected=${upload.rowCount}`);

    if (storedLength !== upload.rowCount) {
      await pool.query(`DELETE FROM financial_uploads WHERE id = $1`, [created.id]);
      throw new Error(
        `Row storage mismatch: expected ${upload.rowCount} rows but only ${storedLength} were stored. Please retry the upload.`
      );
    }

    // Refresh the cache for this org immediately after upload so the new data
    // is available without waiting for TTL expiry. We do this asynchronously
    // so the upload response is not delayed by the re-load.
    this._invalidateFinCache(); // clear stale entry
    // Background refresh — don't await; caller gets a fast response
    this._preWarmFinCacheForOrg(created.uploadedBy).catch(() => {});
    return created;
  }

  async deleteFinancialUpload(id: string): Promise<boolean> {
    const result = await db.delete(financialUploads).where(eq(financialUploads.id, id)).returning();
    // Let TTL handle cache expiry on delete — avoid forcing an expensive reload
    return result.length > 0;
  }

  async deleteAllFinancialUploads(): Promise<void> {
    this._invalidateFinCache();
    await db.delete(financialUploads);
  }

  async deleteEmptyFinancialUploads(): Promise<number> {
    const result = await pool.query(
      `DELETE FROM financial_uploads WHERE jsonb_array_length(rows) = 0 RETURNING id`
    );
    const deleted = result.rowCount ?? 0;
    if (deleted > 0) {
      console.log(`[startup] Deleted ${deleted} financial upload record(s) with empty rows array.`);
    }
    return deleted;
  }

  async appendFinancialRows(uploadId: string, rows: any[]): Promise<void> {
    await pool.query(
      `UPDATE financial_uploads SET rows = rows || $1::jsonb WHERE id = $2`,
      [JSON.stringify(rows), uploadId]
    );
  }

  async searchCompanies(query: string, organizationId: string): Promise<Company[]> {
    return db.select().from(companies).where(and(eq(companies.organizationId, organizationId), ilike(companies.name, `%${query}%`))).limit(10);
  }

  async searchUsers(query: string, roles: string[], organizationId: string): Promise<Omit<User, 'password'>[]> {
    return db.select({
      id: users.id,
      organizationId: users.organizationId,
      username: users.username,
      name: users.name,
      role: users.role,
      managerId: users.managerId,
      lastLoginAt: users.lastLoginAt,
      financialRepId: users.financialRepId,
      createdAt: users.createdAt,
      emailSignature: users.emailSignature,
      clerkUserId: users.clerkUserId,
      valueiqLandingDisabled: users.valueiqLandingDisabled,
      defaultToTodayQueue: users.defaultToTodayQueue,
    }).from(users).where(
      and(
        eq(users.organizationId, organizationId),
        inArray(users.role, roles),
        or(
          ilike(users.name, `%${query}%`),
          ilike(users.username, `%${query}%`)
        )
      )
    ).limit(10);
  }

  async getTasks(): Promise<Task[]> {
    return db.select().from(tasks);
  }

  /**
   * Org-scoped task fetch — used by the tasks page and dashboard portlets so
   * we never pull every org's tasks into memory just to filter them out.
   * Includes legacy rows where org_id is null but the task links to a company
   * in the target org (the column was back-filled over time; some older rows
   * still have NULL).
   */
  async getTasksByOrg(organizationId: string): Promise<Task[]> {
    return db
      .select()
      .from(tasks)
      .where(
        or(
          eq(tasks.orgId, organizationId),
          sql`${tasks.orgId} IS NULL AND ${tasks.companyId} IN (SELECT id FROM companies WHERE organization_id = ${organizationId})`,
        ),
      );
  }

  async getTasksByCompany(companyId: string): Promise<Task[]> {
    return db.select().from(tasks).where(eq(tasks.companyId, companyId));
  }

  async getTask(id: string): Promise<Task | undefined> {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    return task;
  }

  async findProcurementTask(awardId: string, lane: string): Promise<Task | undefined> {
    // Normalize the input for comparison
    const normalizedLane = lane.trim().replace(/\s+/g, " ").toLowerCase();
    // Use SQL-level normalization on the stored lane value so legacy unnormalized rows
    // are matched without a second query. PostgreSQL jsonb_array_elements extracts each
    // element; we normalize the stored lane with lower(regexp_replace(...)) and compare
    // against the already-normalized input value.
    const results = await db.select().from(tasks).where(
      sql`EXISTS (
        SELECT 1 FROM jsonb_array_elements(attached_lane_data) elem
        WHERE elem->>'type' = 'carrier_procurement'
          AND elem->>'awardId' = ${awardId}
          AND lower(btrim(regexp_replace(elem->>'lane', '\\s+', ' ', 'g'))) = ${normalizedLane}
      )`
    ).orderBy(
      sql`CASE WHEN status = 'open' THEN 0 ELSE 1 END`,
      desc(tasks.createdAt)
    );
    return results[0];
  }

  async countProcurementTasksByAward(awardId: string): Promise<number> {
    // Count all carrier_procurement tasks for the given awardId, regardless of lane format
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(tasks).where(
      sql`attached_lane_data @> ${JSON.stringify([{ type: "carrier_procurement", awardId }])}::jsonb`
    );
    return row?.count ?? 0;
  }

  async findRfpCoverageReviewTask(rfpId: string): Promise<Task | undefined> {
    const results = await db.select().from(tasks).where(
      sql`attached_lane_data @> ${JSON.stringify([{ type: "rfp_coverage_review", rfpId }])}::jsonb`
    ).orderBy(desc(tasks.createdAt));
    return results[0];
  }

  async findAwardOnboardingTask(awardId: string): Promise<Task | undefined> {
    const results = await db.select().from(tasks).where(
      sql`attached_lane_data @> ${JSON.stringify([{ type: "award_onboarding", awardId }])}::jsonb`
    ).orderBy(desc(tasks.createdAt));
    return results[0];
  }

  async createTask(task: InsertTask): Promise<Task> {
    const [created] = await db.insert(tasks).values(task).returning();
    return created;
  }

  async updateTask(id: string, data: Partial<InsertTask>): Promise<Task | undefined> {
    const [updated] = await db.update(tasks).set(data).where(eq(tasks.id, id)).returning();
    return updated;
  }

  async deleteTask(id: string): Promise<boolean> {
    const result = await db.delete(tasks).where(eq(tasks.id, id)).returning();
    return result.length > 0;
  }

  async getTaskComments(taskId: string): Promise<TaskComment[]> {
    return db.select().from(taskComments).where(eq(taskComments.taskId, taskId));
  }

  async getTaskCommentCounts(taskIds: string[]): Promise<Record<string, number>> {
    if (taskIds.length === 0) return {};
    const rows = await db.select({ taskId: taskComments.taskId, count: sql<number>`count(*)::int` })
      .from(taskComments)
      .where(inArray(taskComments.taskId, taskIds))
      .groupBy(taskComments.taskId);
    return Object.fromEntries(rows.map(r => [r.taskId, r.count]));
  }

  async createTaskComment(comment: InsertTaskComment): Promise<TaskComment> {
    const [created] = await db.insert(taskComments).values(comment).returning();
    return created;
  }

  async deleteTaskComment(id: string): Promise<boolean> {
    const result = await db.delete(taskComments).where(eq(taskComments.id, id)).returning();
    return result.length > 0;
  }

  async getCallouts(): Promise<Callout[]> {
    return db.select().from(callouts);
  }

  async getCalloutsByCompany(companyId: string): Promise<Callout[]> {
    return db.select().from(callouts).where(eq(callouts.companyId, companyId));
  }

  async getCallout(id: string): Promise<Callout | undefined> {
    const [callout] = await db.select().from(callouts).where(eq(callouts.id, id));
    return callout;
  }

  async createCallout(callout: InsertCallout): Promise<Callout> {
    const [created] = await db.insert(callouts).values(callout).returning();
    return created;
  }

  async deleteCallout(id: string): Promise<boolean> {
    await db.delete(callouts).where(eq(callouts.parentId, id));
    const result = await db.delete(callouts).where(eq(callouts.id, id)).returning();
    return result.length > 0;
  }

  async getFeedPosts(visibleAuthorIds?: string[]): Promise<FeedPost[]> {
    if (visibleAuthorIds) {
      return db.select().from(feedPosts)
        .where(and(inArray(feedPosts.authorId, visibleAuthorIds), isNull(feedPosts.parentId)))
        .orderBy(desc(feedPosts.createdAt))
        .limit(30);
    }
    return db.select().from(feedPosts)
      .where(isNull(feedPosts.parentId))
      .orderBy(desc(feedPosts.createdAt))
      .limit(30);
  }

  async getFeedReplies(parentIds: string[]): Promise<FeedPost[]> {
    if (!parentIds.length) return [];
    return db.select().from(feedPosts)
      .where(inArray(feedPosts.parentId, parentIds))
      .orderBy(feedPosts.createdAt);
  }

  async createFeedPost(post: InsertFeedPost): Promise<FeedPost> {
    const [created] = await db.insert(feedPosts).values(post).returning();
    return created;
  }

  async getFeedPost(id: string): Promise<FeedPost | undefined> {
    const [post] = await db.select().from(feedPosts).where(eq(feedPosts.id, id));
    return post;
  }

  async deleteFeedPost(id: string): Promise<boolean> {
    const result = await db.delete(feedPosts).where(eq(feedPosts.id, id)).returning();
    return result.length > 0;
  }

  async pinFeedPost(id: string, pinned: boolean): Promise<FeedPost> {
    const [updated] = await db.update(feedPosts)
      .set({ pinned, pinnedAt: pinned ? new Date().toISOString() : null })
      .where(eq(feedPosts.id, id))
      .returning();
    return updated;
  }

  async getSetting(key: string): Promise<string | undefined> {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
    return row?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({
      target: appSettings.key,
      set: { value },
    });
  }

  async getReactionsByCalloutIds(calloutIds: string[]): Promise<CalloutReaction[]> {
    if (calloutIds.length === 0) return [];
    return db.select().from(calloutReactions).where(inArray(calloutReactions.calloutId, calloutIds));
  }

  async toggleReaction(calloutId: string, userId: string, emoji: string): Promise<{ action: "added" | "removed" }> {
    const [existing] = await db.select().from(calloutReactions).where(
      and(
        eq(calloutReactions.calloutId, calloutId),
        eq(calloutReactions.userId, userId),
        eq(calloutReactions.emoji, emoji),
      )
    );
    if (existing) {
      await db.delete(calloutReactions).where(eq(calloutReactions.id, existing.id));
      return { action: "removed" };
    }
    await db.insert(calloutReactions).values({
      calloutId,
      userId,
      emoji,
      createdAt: new Date().toISOString(),
    });
    return { action: "added" };
  }

  async getReactionsByFeedPostIds(feedPostIds: string[]): Promise<FeedPostReaction[]> {
    if (feedPostIds.length === 0) return [];
    return db.select().from(feedPostReactions).where(inArray(feedPostReactions.feedPostId, feedPostIds));
  }

  async toggleFeedPostReaction(feedPostId: string, userId: string, emoji: string): Promise<{ action: "added" | "removed" }> {
    const [existing] = await db.select().from(feedPostReactions).where(
      and(
        eq(feedPostReactions.feedPostId, feedPostId),
        eq(feedPostReactions.userId, userId),
        eq(feedPostReactions.emoji, emoji),
      )
    );
    if (existing) {
      await db.delete(feedPostReactions).where(eq(feedPostReactions.id, existing.id));
      return { action: "removed" };
    }
    await db.insert(feedPostReactions).values({
      feedPostId,
      userId,
      emoji,
      createdAt: new Date().toISOString(),
    });
    return { action: "added" };
  }

  async getSessionsForSubordinates(subordinateIds: string[], orgId: string): Promise<Array<{
    session: OneOnOneSession;
    namUser: { id: string; name: string; role: string };
    amUser: { id: string; name: string; role: string };
    topics: Array<OneOnOneTopic & { replies: OneOnOneTopicReply[] }>;
  }>> {
    if (subordinateIds.length === 0) return [];

    // Get all org users for name/role lookup
    const orgUsers = await db.select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.organizationId, orgId));
    const userMap = new Map(orgUsers.map(u => [u.id, u]));

    // Get sessions where nam or am is in the subordinate list
    const sessions = await db.select().from(oneOnOneSessions).where(
      or(
        inArray(oneOnOneSessions.namId, subordinateIds),
        inArray(oneOnOneSessions.amId, subordinateIds)
      )
    ).orderBy(desc(oneOnOneSessions.startDate));

    if (sessions.length === 0) return [];

    // Get topics for all sessions
    const sessionIds = sessions.map(s => s.id);
    const allTopics = await db.select().from(oneOnOneTopics)
      .where(inArray(oneOnOneTopics.sessionId, sessionIds))
      .orderBy(desc(oneOnOneTopics.createdAt));

    const topicIds = allTopics.map(t => t.id);
    const allReplies = topicIds.length > 0
      ? await db.select().from(oneOnOneTopicReplies)
          .where(inArray(oneOnOneTopicReplies.topicId, topicIds))
          .orderBy(oneOnOneTopicReplies.createdAt)
      : [];

    const repliesByTopic = new Map<string, OneOnOneTopicReply[]>();
    for (const reply of allReplies) {
      const arr = repliesByTopic.get(reply.topicId) ?? [];
      arr.push(reply);
      repliesByTopic.set(reply.topicId, arr);
    }

    const topicsBySession = new Map<string, Array<OneOnOneTopic & { replies: OneOnOneTopicReply[] }>>();
    for (const topic of allTopics) {
      const arr = topicsBySession.get(topic.sessionId) ?? [];
      arr.push({ ...topic, replies: repliesByTopic.get(topic.id) ?? [] });
      topicsBySession.set(topic.sessionId, arr);
    }

    return sessions.map(session => ({
      session,
      namUser: userMap.get(session.namId) ?? { id: session.namId, name: "Unknown", role: "" },
      amUser: userMap.get(session.amId) ?? { id: session.amId, name: "Unknown", role: "" },
      topics: topicsBySession.get(session.id) ?? [],
    }));
  }

  async getActiveSession(namId: string, amId: string): Promise<OneOnOneSession | undefined> {
    const [session] = await db.select().from(oneOnOneSessions).where(
      and(
        eq(oneOnOneSessions.namId, namId),
        eq(oneOnOneSessions.amId, amId),
        eq(oneOnOneSessions.status, "active")
      )
    );
    return session;
  }

  async getActiveSessionsForManager(namId: string): Promise<OneOnOneSession[]> {
    return db.select().from(oneOnOneSessions).where(
      and(
        eq(oneOnOneSessions.namId, namId),
        eq(oneOnOneSessions.status, "active")
      )
    );
  }

  async getSession(id: string): Promise<OneOnOneSession | undefined> {
    const [session] = await db.select().from(oneOnOneSessions).where(eq(oneOnOneSessions.id, id));
    return session;
  }

  async getOrCreateActiveSession(namId: string, amId: string): Promise<OneOnOneSession> {
    const existing = await this.getActiveSession(namId, amId);
    if (existing) return existing;
    const [session] = await db.insert(oneOnOneSessions).values({
      namId,
      amId,
      status: "active",
      startDate: new Date().toISOString(),
    }).returning();
    return session;
  }

  async getSessionsByUser(userId: string): Promise<OneOnOneSession[]> {
    return db.select().from(oneOnOneSessions).where(
      or(
        eq(oneOnOneSessions.namId, userId),
        eq(oneOnOneSessions.amId, userId)
      )
    );
  }

  async getAllSessions(): Promise<OneOnOneSession[]> {
    return db.select().from(oneOnOneSessions);
  }

  async closeSession(sessionId: string, opts?: { carryForwardTopicIds?: string[]; moraleScore?: number; sessionSummary?: string }): Promise<OneOnOneSession | undefined> {
    const [session] = await db.select().from(oneOnOneSessions).where(eq(oneOnOneSessions.id, sessionId));
    if (!session) return undefined;

    const allPendingTopics = await db.select().from(oneOnOneTopics).where(
      and(
        eq(oneOnOneTopics.sessionId, sessionId),
        eq(oneOnOneTopics.status, "pending")
      )
    );

    // If caller specified which IDs to carry forward, honour that; otherwise carry all pending
    const topicsToCarry = opts?.carryForwardTopicIds
      ? allPendingTopics.filter(t => opts.carryForwardTopicIds!.includes(t.id))
      : allPendingTopics;

    const closedAt = new Date().toISOString();

    await db.update(oneOnOneSessions)
      .set({
        status: "archived",
        closedAt,
        moraleScore: opts?.moraleScore ?? null,
        sessionSummary: opts?.sessionSummary ?? null,
      })
      .where(eq(oneOnOneSessions.id, sessionId));

    const [newSession] = await db.insert(oneOnOneSessions).values({
      namId: session.namId,
      amId: session.amId,
      status: "active",
      startDate: new Date().toISOString(),
    }).returning();

    for (const topic of topicsToCarry) {
      await db.insert(oneOnOneTopics).values({
        sessionId: newSession.id,
        addedById: topic.addedById,
        text: topic.text,
        tag: topic.tag,
        status: "pending",
        createdAt: topic.createdAt,
      });
    }

    return newSession;
  }

  async getTopicsBySession(sessionId: string): Promise<OneOnOneTopic[]> {
    return db.select().from(oneOnOneTopics)
      .where(eq(oneOnOneTopics.sessionId, sessionId))
      .orderBy(desc(oneOnOneTopics.createdAt));
  }

  async getTopic(id: string): Promise<OneOnOneTopic | undefined> {
    const [topic] = await db.select().from(oneOnOneTopics).where(eq(oneOnOneTopics.id, id));
    return topic;
  }

  async createTopic(topic: InsertOneOnOneTopic): Promise<OneOnOneTopic> {
    const [created] = await db.insert(oneOnOneTopics).values(topic).returning();
    return created;
  }

  async toggleTopicStatus(topicId: string): Promise<OneOnOneTopic | undefined> {
    const [topic] = await db.select().from(oneOnOneTopics).where(eq(oneOnOneTopics.id, topicId));
    if (!topic) return undefined;
    const newStatus = topic.status === "pending" ? "discussed" : "pending";
    const [updated] = await db.update(oneOnOneTopics)
      .set({ status: newStatus })
      .where(eq(oneOnOneTopics.id, topicId))
      .returning();
    return updated;
  }

  async updateTopicStatus(topicId: string, status: string): Promise<OneOnOneTopic | undefined> {
    const [updated] = await db.update(oneOnOneTopics)
      .set({ status })
      .where(eq(oneOnOneTopics.id, topicId))
      .returning();
    return updated;
  }

  async deleteTopic(topicId: string): Promise<boolean> {
    const result = await db.delete(oneOnOneTopics).where(eq(oneOnOneTopics.id, topicId)).returning();
    return result.length > 0;
  }

  async getTopicReplies(topicId: string): Promise<OneOnOneTopicReply[]> {
    return db.select().from(oneOnOneTopicReplies)
      .where(eq(oneOnOneTopicReplies.topicId, topicId))
      .orderBy(oneOnOneTopicReplies.createdAt);
  }

  async addTopicReply(reply: InsertOneOnOneTopicReply): Promise<OneOnOneTopicReply> {
    const [created] = await db.insert(oneOnOneTopicReplies).values(reply).returning();
    return created;
  }

  async deleteTopicReply(replyId: string): Promise<boolean> {
    const result = await db.delete(oneOnOneTopicReplies).where(eq(oneOnOneTopicReplies.id, replyId)).returning();
    return result.length > 0;
  }

  async getArchivedSessions(namId: string, amId: string): Promise<OneOnOneSession[]> {
    return db.select().from(oneOnOneSessions).where(
      and(
        eq(oneOnOneSessions.namId, namId),
        eq(oneOnOneSessions.amId, amId),
        eq(oneOnOneSessions.status, "archived")
      )
    ).orderBy(desc(oneOnOneSessions.startDate));
  }

  async updateSessionNotes(sessionId: string, notes: string): Promise<OneOnOneSession | undefined> {
    const [updated] = await db.update(oneOnOneSessions)
      .set({ notes })
      .where(eq(oneOnOneSessions.id, sessionId))
      .returning();
    return updated;
  }

  async updateSessionMeetingDate(sessionId: string, meetingDate: string | null): Promise<OneOnOneSession | undefined> {
    const [updated] = await db.update(oneOnOneSessions)
      .set({ meetingDate })
      .where(eq(oneOnOneSessions.id, sessionId))
      .returning();
    return updated;
  }

  async updateSessionMeetingLink(sessionId: string, meetingLink: string | null): Promise<OneOnOneSession | undefined> {
    const [updated] = await db.update(oneOnOneSessions)
      .set({ meetingLink })
      .where(eq(oneOnOneSessions.id, sessionId))
      .returning();
    return updated;
  }

  async getActiveSessionsWithMeetingDate(): Promise<OneOnOneSession[]> {
    return db.select().from(oneOnOneSessions).where(
      and(
        eq(oneOnOneSessions.status, "active"),
        isNotNull(oneOnOneSessions.meetingDate)
      )
    );
  }

  async getActionItemsByPairing(namId: string, amId: string): Promise<{ session: OneOnOneSession; topics: OneOnOneTopic[] }[]> {
    const sessions = await db.select().from(oneOnOneSessions).where(
      and(
        eq(oneOnOneSessions.namId, namId),
        eq(oneOnOneSessions.amId, amId)
      )
    ).orderBy(desc(oneOnOneSessions.startDate));

    if (sessions.length === 0) return [];

    // Load all action-item topics for all sessions in a single query instead
    // of one query per session (eliminates N+1 pattern).
    const sessionIds = sessions.map(s => s.id);
    const allTopics = await db.select().from(oneOnOneTopics).where(
      and(
        inArray(oneOnOneTopics.sessionId, sessionIds),
        eq(oneOnOneTopics.tag, "action_item")
      )
    ).orderBy(desc(oneOnOneTopics.createdAt));

    const topicsBySession = new Map<string, OneOnOneTopic[]>();
    for (const topic of allTopics) {
      const list = topicsBySession.get(topic.sessionId) ?? [];
      list.push(topic);
      topicsBySession.set(topic.sessionId, list);
    }

    return sessions
      .map(session => ({ session, topics: topicsBySession.get(session.id) ?? [] }))
      .filter(r => r.topics.length > 0);
  }

  async searchContacts(query: string, organizationId: string): Promise<Contact[]> {
    const orgCompanyIds = db.select({ id: companies.id }).from(companies)
      .where(eq(companies.organizationId, organizationId));
    return db.select().from(contacts).where(
      and(
        inArray(contacts.companyId, orgCompanyIds),
        or(ilike(contacts.name, `%${query}%`), ilike(contacts.title, `%${query}%`))
      )
    ).limit(8);
  }

  async searchRfps(query: string, organizationId: string): Promise<Rfp[]> {
    const orgCompanyIds = db.select({ id: companies.id }).from(companies)
      .where(eq(companies.organizationId, organizationId));
    return db.select().from(rfps).where(
      and(inArray(rfps.companyId, orgCompanyIds), ilike(rfps.title, `%${query}%`))
    ).limit(6);
  }

  async searchTasks(query: string, organizationId: string): Promise<Task[]> {
    const orgCompanyIds = db.select({ id: companies.id }).from(companies)
      .where(eq(companies.organizationId, organizationId));
    return db.select().from(tasks).where(
      and(
        inArray(tasks.companyId, orgCompanyIds),
        ilike(tasks.title, `%${query}%`)
      )
    ).limit(6);
  }

  async searchCarriers(query: string, orgId: string): Promise<Carrier[]> {
    return db.select().from(carriers).where(
      and(
        eq(carriers.orgId, orgId),
        ilike(carriers.name, `%${query}%`)
      )
    ).limit(8);
  }

  async getCompanyActivity(companyId: string): Promise<Array<{ type: string; title: string; subtitle?: string; date: string; link?: string }>> {
    const [companyTasks, companyCallouts, companyRfps] = await Promise.all([
      db.select().from(tasks).where(eq(tasks.companyId, companyId)),
      db.select().from(callouts).where(and(eq(callouts.companyId, companyId), isNull(callouts.parentId))),
      db.select().from(rfps).where(eq(rfps.companyId, companyId)),
    ]);

    const events: Array<{ type: string; title: string; subtitle?: string; date: string; link?: string }> = [];

    for (const t of companyTasks) {
      events.push({ type: "task", title: t.title, subtitle: t.status, date: t.createdAt, link: undefined });
    }
    for (const c of companyCallouts) {
      events.push({ type: "callout", title: c.title, subtitle: c.tag || undefined, date: c.createdAt });
    }
    for (const r of companyRfps) {
      events.push({ type: "rfp", title: r.title, subtitle: `${r.laneCount ?? 0} lanes`, date: r.dueDate || new Date().toISOString() });
    }

    return events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 30);
  }

  async getTeamPerformance(teamMemberIds: string[], startDate?: string, endDate?: string): Promise<Array<{ userId: string; openTasks: number; overdueTasks: number; completedTasks: number; companyCount: number; newContacts: number; callTouchpoints: number; textTouchpoints: number; emailTouchpoints: number; contactsTouched: number; baseAdvanced: number; meaningfulTouchpoints: number }>> {
    if (teamMemberIds.length === 0) return [];
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const periodStart = startDate ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const periodEnd = endDate ?? today;

    const [allTasks, allCompanies, allTouchpoints, allContacts] = await Promise.all([
      db.select().from(tasks).where(inArray(tasks.assignedTo, teamMemberIds)),
      db.select().from(companies).where(inArray(companies.assignedTo, teamMemberIds)),
      db.select().from(touchpoints).where(
        and(inArray(touchpoints.loggedById, teamMemberIds), gte(touchpoints.date, periodStart), lte(touchpoints.date, periodEnd))
      ),
      db.select().from(contacts),
    ]);

    return teamMemberIds.map(uid => {
      const userTasks = allTasks.filter(t => t.assignedTo === uid);
      const userCompanies = allCompanies.filter(c => c.assignedTo === uid);
      const userCompanyIds = userCompanies.map(c => c.id);
      const userTouchpoints = allTouchpoints.filter(t => t.loggedById === uid);
      const userContacts = allContacts.filter(c => userCompanyIds.includes(c.companyId));
      const touchedContactIds = new Set(userTouchpoints.map(tp => tp.contactId));

      return {
        userId: uid,
        openTasks: userTasks.filter(t => t.status === "open" || t.status === "in_progress").length,
        overdueTasks: userTasks.filter(t => (t.status === "open" || t.status === "in_progress") && t.dueDate && t.dueDate < today).length,
        completedTasks: userTasks.filter(t => t.status === "completed").length,
        companyCount: userCompanies.length,
        newContacts: userContacts.filter(c => { const d = c.createdAt?.slice(0, 10); return d && d >= periodStart && d <= periodEnd; }).length,
        callTouchpoints: userTouchpoints.filter(t => t.type === "call").length,
        textTouchpoints: userTouchpoints.filter(t => t.type === "text").length,
        emailTouchpoints: userTouchpoints.filter(t => t.type === "email").length,
        contactsTouched: touchedContactIds.size,
        baseAdvanced: userContacts.filter(c => { const d = c.baseAdvancedAt?.slice(0, 10); return d && d >= periodStart && d <= periodEnd; }).length,
        meaningfulTouchpoints: userTouchpoints.filter(t => t.isMeaningful).length,
      };
    });
  }

  async getNotifications(userId: string): Promise<Notification[]> {
    return db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(50);
  }

  async hasUnreadNotification(userId: string, type: string, relatedId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.type, type),
          eq(notifications.relatedId, relatedId),
          eq(notifications.read, false),
        ),
      )
      .limit(1);
    return !!row;
  }

  async hasAnyNotification(userId: string, type: string, relatedId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.type, type),
          eq(notifications.relatedId, relatedId),
        ),
      )
      .limit(1);
    return !!row;
  }

  async createNotification(data: InsertNotification): Promise<Notification> {
    const [created] = await db.insert(notifications).values(data).returning();
    return created;
  }

  async markNotificationRead(id: string): Promise<void> {
    await db.update(notifications).set({ read: true }).where(eq(notifications.id, id));
  }

  async markAllNotificationsRead(userId: string): Promise<void> {
    await db.update(notifications).set({ read: true }).where(eq(notifications.userId, userId));
  }

  async markNotificationsReadByTypes(userId: string, types: string[]): Promise<void> {
    await db.update(notifications).set({ read: true }).where(
      and(eq(notifications.userId, userId), inArray(notifications.type, types))
    );
  }

  async markNotificationsReadByIds(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.update(notifications).set({ read: true }).where(
      and(eq(notifications.userId, userId), inArray(notifications.id, ids))
    );
  }

  async getGoals(filter: { namId?: string; amId?: string }): Promise<Goal[]> {
    const conditions = [];
    if (filter.namId) conditions.push(eq(goals.namId, filter.namId));
    if (filter.amId) conditions.push(eq(goals.amId, filter.amId));
    if (conditions.length === 0) return db.select().from(goals).orderBy(desc(goals.createdAt));
    return db.select().from(goals).where(or(...conditions)).orderBy(desc(goals.createdAt));
  }

  async getGoal(id: string): Promise<Goal | undefined> {
    const [g] = await db.select().from(goals).where(eq(goals.id, id));
    return g;
  }

  async createGoal(goal: InsertGoal): Promise<Goal> {
    const [g] = await db.insert(goals).values(goal).returning();
    return g;
  }

  async updateGoal(id: string, data: Partial<InsertGoal>): Promise<Goal | undefined> {
    const [g] = await db.update(goals).set(data).where(eq(goals.id, id)).returning();
    return g;
  }

  async deleteGoal(id: string): Promise<boolean> {
    const result = await db.delete(goals).where(eq(goals.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async getAmsMissingMonthlyGoals(organizationId: string, namId?: string): Promise<Array<{ amId: string; amName: string }>> {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const allGoals = namId ? await this.getGoals({ namId }) : await this.getGoals({});
    const coveredAmIds = new Set(
      allGoals
        .filter(g => g.period === "monthly" && g.startDate >= firstDay && g.startDate <= lastDay)
        .map(g => g.amId)
    );
    const conditions: ReturnType<typeof eq>[] = [
      eq(users.role, "account_manager"),
      eq(users.organizationId, organizationId),
    ];
    if (namId) conditions.push(eq(users.managerId, namId));
    const ams = await db.select({ id: users.id, name: users.name })
      .from(users)
      .where(and(...conditions));
    return ams
      .filter(am => !coveredAmIds.has(am.id))
      .map(am => ({ amId: am.id, amName: am.name }));
  }

  async getGoalComments(goalId: string): Promise<GoalComment[]> {
    return db.select().from(goalComments).where(eq(goalComments.goalId, goalId)).orderBy(goalComments.createdAt);
  }

  async getGoalComment(id: string): Promise<GoalComment | undefined> {
    const [comment] = await db.select().from(goalComments).where(eq(goalComments.id, id));
    return comment;
  }

  async createGoalComment(comment: InsertGoalComment): Promise<GoalComment> {
    const [c] = await db.insert(goalComments).values(comment).returning();
    return c;
  }

  async deleteGoalComment(id: string): Promise<boolean> {
    const result = await db.delete(goalComments).where(eq(goalComments.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async getTouchpoint(id: string): Promise<Touchpoint | undefined> {
    const [tp] = await db.select().from(touchpoints).where(eq(touchpoints.id, id));
    return tp;
  }

  async getTouchpoints(): Promise<Touchpoint[]> {
    return db.select().from(touchpoints).orderBy(desc(touchpoints.date));
  }

  async getTouchpointsSince(since: string): Promise<Touchpoint[]> {
    return db.select().from(touchpoints).where(gte(touchpoints.date, since)).orderBy(desc(touchpoints.date));
  }

  async getTouchpointsByContact(contactId: string): Promise<Touchpoint[]> {
    return db.select().from(touchpoints).where(eq(touchpoints.contactId, contactId)).orderBy(desc(touchpoints.date));
  }

  async getTouchpointsByCompany(companyId: string): Promise<Touchpoint[]> {
    return db.select().from(touchpoints).where(eq(touchpoints.companyId, companyId)).orderBy(desc(touchpoints.date));
  }

  async getTouchpointsByUser(userId: string, since: string): Promise<Touchpoint[]> {
    return db.select().from(touchpoints).where(
      and(eq(touchpoints.loggedById, userId), gte(touchpoints.date, since))
    );
  }

  async getTouchpointsByOrg(organizationId: string): Promise<Touchpoint[]> {
    const result = await db
      .select({ tp: touchpoints })
      .from(touchpoints)
      .innerJoin(companies, eq(touchpoints.companyId, companies.id))
      .where(eq(companies.organizationId, organizationId))
      .orderBy(desc(touchpoints.date));
    return result.map(r => r.tp);
  }

  async createTouchpoint(tp: InsertTouchpoint): Promise<Touchpoint> {
    const [created] = await db.insert(touchpoints).values(tp).returning();
    return created;
  }

  /**
   * Canonical helper for creating a touchpoint from a route handler.
   * Fills in safe defaults (sentiment=null, isMeaningful=false,
   * playLabel=null, createdAt=now, date=today) so callers can't drift the
   * shape (e.g. omitting `date` causes a NOT NULL crash, omitting
   * `playLabel` breaks AI play attribution).
   *
   * Callers MUST still validate org ownership of companyId/contactId BEFORE
   * calling this — this helper is shape-only, not authorization.
   */
  async createTouchpointWithDefaults(
    input: {
      companyId: string;
      loggedById: string;
      contactId?: string | null;
      type?: string;
      notes?: string | null;
      sentiment?: string | null;
      isMeaningful?: boolean;
      playLabel?: string | null;
      date?: string;
      createdAt?: string;
      externalId?: string | null;
    },
  ): Promise<Touchpoint> {
    const now = new Date();
    return this.createTouchpoint({
      contactId: input.contactId ?? null,
      companyId: input.companyId,
      type: input.type ?? "call",
      date: input.date ?? now.toISOString().split("T")[0],
      notes: input.notes ?? null,
      sentiment: input.sentiment ?? null,
      isMeaningful: input.isMeaningful ?? false,
      loggedById: input.loggedById,
      playLabel: input.playLabel ?? null,
      createdAt: input.createdAt ?? now.toISOString(),
      externalId: input.externalId ?? null,
    });
  }

  async getTouchpointByExternalId(externalId: string): Promise<Touchpoint | undefined> {
    const [row] = await db.select().from(touchpoints).where(eq(touchpoints.externalId, externalId)).limit(1);
    return row;
  }

  async updateTouchpoint(id: string, data: { isMeaningful?: boolean; notes?: string }): Promise<Touchpoint> {
    const [updated] = await db.update(touchpoints).set(data).where(eq(touchpoints.id, id)).returning();
    return updated;
  }

  async updateTouchpointCompanyByContact(contactId: string, newCompanyId: string): Promise<number> {
    const result = await db
      .update(touchpoints)
      .set({ companyId: newCompanyId })
      .where(eq(touchpoints.contactId, contactId));
    return result.rowCount ?? 0;
  }

  async deleteTouchpoint(id: string): Promise<boolean> {
    const result = await db.delete(touchpoints).where(eq(touchpoints.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async getColdContacts(assignedToUserId: string | null, daysSince: number, teamUserIds?: string[]): Promise<Array<{ contact: Contact; company: Company; daysSince: number; lastType: string | null }>> {
    const cutoffStr = new Date(Date.now() - daysSince * 86400000).toISOString().split("T")[0];

    let companyFilter: string;
    const params: any[] = [cutoffStr];
    if (teamUserIds && teamUserIds.length > 0) {
      companyFilter = `co.assigned_to = ANY($2)`;
      params.push(teamUserIds);
    } else if (assignedToUserId) {
      companyFilter = `co.assigned_to = $2`;
      params.push(assignedToUserId);
    } else {
      companyFilter = `TRUE`;
    }

    const rankingSql = `
      SELECT
        c.id AS contact_id,
        c.company_id,
        lt.last_type,
        CASE WHEN lt.last_date IS NULL THEN 999
             ELSE GREATEST(0, (CURRENT_DATE - lt.last_date::date))
        END AS days_since
      FROM contacts c
      JOIN companies co ON co.id = c.company_id
      LEFT JOIN LATERAL (
        SELECT t.date AS last_date, t.type AS last_type
        FROM touchpoints t
        WHERE t.contact_id = c.id
        ORDER BY t.date DESC
        LIMIT 1
      ) lt ON TRUE
      WHERE ${companyFilter}
        AND (lt.last_date IS NULL OR lt.last_date < $1)
      ORDER BY days_since DESC
      LIMIT 20
    `;

    const { rows: ranked } = await pool.query(rankingSql, params);
    if (ranked.length === 0) return [];

    const contactIds = ranked.map((r: any) => r.contact_id);
    const companyIds = [...new Set(ranked.map((r: any) => r.company_id))];

    const [contactRows, companyRows] = await Promise.all([
      db.select().from(contacts).where(inArray(contacts.id, contactIds)),
      db.select().from(companies).where(inArray(companies.id, companyIds)),
    ]);

    const contactMap = new Map(contactRows.map(c => [c.id, c]));
    const companyMap = new Map(companyRows.map(c => [c.id, c]));

    return ranked
      .map((r: any) => {
        const contact = contactMap.get(r.contact_id);
        const company = companyMap.get(r.company_id);
        if (!contact || !company) return null;
        return { contact, company, daysSince: parseInt(r.days_since, 10), lastType: r.last_type || null };
      })
      .filter(Boolean) as Array<{ contact: Contact; company: Company; daysSince: number; lastType: string | null }>;
  }

  async getMeaningfulOverdueContacts(assignedToUserId: string | null, daysSince: number, teamUserIds?: string[]): Promise<Array<{ contact: Contact; company: Company; daysSinceLastMeaningful: number }>> {
    const cutoffStr = new Date(Date.now() - daysSince * 86400000).toISOString().split("T")[0];

    let companyFilter: string;
    const params: any[] = [cutoffStr];
    if (teamUserIds && teamUserIds.length > 0) {
      companyFilter = `co.assigned_to = ANY($2)`;
      params.push(teamUserIds);
    } else if (assignedToUserId) {
      companyFilter = `co.assigned_to = $2`;
      params.push(assignedToUserId);
    } else {
      companyFilter = `TRUE`;
    }

    const rankingSql = `
      SELECT
        c.id AS contact_id,
        c.company_id,
        CASE WHEN lm.last_date IS NULL THEN 999
             ELSE GREATEST(0, (CURRENT_DATE - lm.last_date::date))
        END AS days_since
      FROM contacts c
      JOIN companies co ON co.id = c.company_id
      LEFT JOIN LATERAL (
        SELECT MAX(t.date) AS last_date
        FROM touchpoints t
        WHERE t.contact_id = c.id AND t.is_meaningful = TRUE
      ) lm ON TRUE
      WHERE ${companyFilter}
        AND (lm.last_date IS NULL OR lm.last_date < $1)
      ORDER BY days_since DESC
      LIMIT 20
    `;

    const { rows: ranked } = await pool.query(rankingSql, params);
    if (ranked.length === 0) return [];

    const contactIds = ranked.map((r: any) => r.contact_id);
    const companyIds = [...new Set(ranked.map((r: any) => r.company_id))];

    const [contactRows, companyRows] = await Promise.all([
      db.select().from(contacts).where(inArray(contacts.id, contactIds)),
      db.select().from(companies).where(inArray(companies.id, companyIds)),
    ]);

    const contactMap = new Map(contactRows.map(c => [c.id, c]));
    const companyMap = new Map(companyRows.map(c => [c.id, c]));

    return ranked
      .map((r: any) => {
        const contact = contactMap.get(r.contact_id);
        const company = companyMap.get(r.company_id);
        if (!contact || !company) return null;
        return { contact, company, daysSinceLastMeaningful: parseInt(r.days_since, 10) };
      })
      .filter(Boolean) as Array<{ contact: Contact; company: Company; daysSinceLastMeaningful: number }>;
  }

  async getContactsAddedByAm(amId: string, startDate: string, endDate: string): Promise<number> {
    const allCompanies = await db.select().from(companies).where(eq(companies.assignedTo, amId));
    if (allCompanies.length === 0) return 0;
    const companyIds = allCompanies.map(c => c.id);
    const allContacts = await db.select().from(contacts).where(inArray(contacts.companyId, companyIds));
    return allContacts.filter(c => {
      if (!c.createdAt) return false;
      return c.createdAt >= startDate && c.createdAt <= endDate;
    }).length;
  }

  async getTouchpointCountByAm(amId: string, startDate: string, endDate: string): Promise<number> {
    const allCompanies = await db.select().from(companies).where(eq(companies.assignedTo, amId));
    if (allCompanies.length === 0) return 0;
    const companyIds = allCompanies.map(c => c.id);
    const allTps = await db.select().from(touchpoints).where(inArray(touchpoints.companyId, companyIds));
    return allTps.filter(tp => tp.date >= startDate && tp.date <= endDate).length;
  }

  async getMeaningfulTouchpointCountByAm(amId: string, startDate: string, endDate: string): Promise<number> {
    const allCompanies = await db.select().from(companies).where(eq(companies.assignedTo, amId));
    if (allCompanies.length === 0) return 0;
    const companyIds = allCompanies.map(c => c.id);
    const allTps = await db.select().from(touchpoints).where(
      and(inArray(touchpoints.companyId, companyIds), eq(touchpoints.isMeaningful, true))
    );
    return allTps.filter(tp => tp.date >= startDate && tp.date <= endDate).length;
  }

  async getRepReport(userId: string, period: "weekly" | "monthly"): Promise<RepReportData> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    let periodStart: string, periodEnd: string, periodLabel: string;
    if (period === "monthly") {
      periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      periodEnd = lastDay.toISOString().slice(0, 10);
      periodLabel = now.toLocaleString("en-US", { month: "long", year: "numeric" });
    } else {
      const day = now.getDay();
      const diffToMon = day === 0 ? -6 : 1 - day;
      const mon = new Date(now);
      mon.setDate(now.getDate() + diffToMon);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      periodStart = mon.toISOString().slice(0, 10);
      periodEnd = sun.toISOString().slice(0, 10);
      periodLabel = `${mon.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${sun.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    }

    const [allUsers, allTasks, userCompanies] = await Promise.all([
      db.select().from(users),
      db.select().from(tasks),
      db.select().from(companies).where(eq(companies.assignedTo, userId)),
    ]);

    const repUser = allUsers.find(u => u.id === userId);
    const manager = repUser?.managerId ? allUsers.find(u => u.id === repUser.managerId) : null;
    const director = (manager as any)?.managerId ? allUsers.find(u => u.id === (manager as any).managerId) : null;

    const userGoals = await this.getGoals({ amId: userId });
    const activeGoals = userGoals.filter(g => g.startDate <= periodEnd && g.endDate >= periodStart);
    const enrichedGoals = await Promise.all(activeGoals.map(async (g) => {
      let autoValue: number | null = null;
      if (g.metric === "contacts_added") {
        autoValue = await this.getContactsAddedByAm(userId, g.startDate, g.endDate);
      } else if (g.metric === "touchpoints") {
        autoValue = await this.getTouchpointCountByAm(userId, g.startDate, g.endDate);
      } else if (g.metric === "meaningful_touchpoints") {
        autoValue = await this.getMeaningfulTouchpointCountByAm(userId, g.startDate, g.endDate);
      }
      const displayCurrent = autoValue !== null ? autoValue : parseFloat(g.currentValue || "0");
      const target = parseFloat(g.target);
      const pct = target > 0 ? Math.min(100, Math.round((displayCurrent / target) * 100)) : 0;
      return {
        id: g.id,
        label: g.customLabel || g.title || g.metric,
        metric: g.metric,
        period: g.period,
        current: displayCurrent,
        target,
        pct,
      };
    }));

    const companyIds = userCompanies.map(c => c.id);
    let periodTps: typeof touchpoints.$inferSelect[] = [];
    if (companyIds.length > 0) {
      periodTps = await db.select().from(touchpoints).where(
        and(
          eq(touchpoints.loggedById, userId),
          gte(touchpoints.date, periodStart),
          lte(touchpoints.date, periodEnd)
        )
      );
    }

    const tpBreakdown = {
      total: periodTps.length,
      call: periodTps.filter(t => t.type === "call").length,
      email: periodTps.filter(t => t.type === "email").length,
      text: periodTps.filter(t => t.type === "text").length,
      site_visit: periodTps.filter(t => t.type === "site_visit").length,
      meaningful: periodTps.filter(t => t.isMeaningful).length,
    };

    const weeklyTrend: number[] = [];
    for (let i = 3; i >= 0; i--) {
      const refDate = new Date(now);
      refDate.setDate(now.getDate() - i * 7);
      const rd = refDate.getDay();
      const diff = rd === 0 ? -6 : 1 - rd;
      const wMon = new Date(refDate);
      wMon.setDate(refDate.getDate() + diff);
      const wSun = new Date(wMon);
      wSun.setDate(wMon.getDate() + 6);
      const cnt = await this.getTouchpointCountByAm(userId, wMon.toISOString().slice(0, 10), wSun.toISOString().slice(0, 10));
      weeklyTrend.push(cnt);
    }

    const newContactsCount = await this.getContactsAddedByAm(userId, periodStart, periodEnd);
    const contactsTouched = new Set(periodTps.map(t => t.contactId).filter(Boolean)).size;

    const userTasks = allTasks.filter(t => t.assignedTo === userId);
    const taskStats = {
      completed: userTasks.filter(t => t.status === "completed").length,
      open: userTasks.filter(t => t.status === "open" || t.status === "in_progress").length,
      overdue: userTasks.filter(t => (t.status === "open" || t.status === "in_progress") && t.dueDate && t.dueDate < today).length,
    };

    const companyTpMap: Record<string, { name: string; touches: number; lastTouch: string }> = {};
    for (const c of userCompanies) {
      const cTps = periodTps.filter(t => t.companyId === c.id);
      if (cTps.length > 0) {
        const sorted = [...cTps].sort((a, b) => b.date.localeCompare(a.date));
        companyTpMap[c.id] = { name: c.name, touches: cTps.length, lastTouch: sorted[0].date };
      }
    }
    const topAccounts = Object.values(companyTpMap).sort((a, b) => b.touches - a.touches).slice(0, 6);

    let allUserTps: typeof touchpoints.$inferSelect[] = [];
    if (companyIds.length > 0) {
      allUserTps = await db.select().from(touchpoints).where(
        and(eq(touchpoints.loggedById, userId))
      );
    }
    const twoWeeksAgo = new Date(now);
    twoWeeksAgo.setDate(now.getDate() - 14);
    const twoWeeksAgoStr = twoWeeksAgo.toISOString().slice(0, 10);
    const lastTouchByCompany: Record<string, string> = {};
    for (const tp of allUserTps) {
      if (!lastTouchByCompany[tp.companyId] || tp.date > lastTouchByCompany[tp.companyId]) {
        lastTouchByCompany[tp.companyId] = tp.date;
      }
    }
    const accountsNeedingAttention = userCompanies.filter(c => {
      const last = lastTouchByCompany[c.id];
      return !last || last < twoWeeksAgoStr;
    }).length;

    const winPosts = await db.select().from(feedPosts).where(
      and(eq(feedPosts.authorId, userId), gte(feedPosts.createdAt, periodStart), isNull(feedPosts.parentId))
    );
    const wins = winPosts
      .filter(p => ["growth", "celebrate", "win", "callout"].includes(p.category))
      .slice(0, 5)
      .map(p => ({ id: p.id, text: p.content, category: p.category }));

    // Compute team member summaries for direct reports
    const directReports = allUsers.filter(u => u.managerId === userId);
    const teamMembers: TeamMemberSummary[] = await Promise.all(
      directReports.map(async (dr) => {
        const drCompanies = await db.select().from(companies).where(eq(companies.assignedTo, dr.id));
        const drCompanyIds = drCompanies.map(c => c.id);

        let drPeriodTps: typeof touchpoints.$inferSelect[] = [];
        if (drCompanyIds.length > 0) {
          drPeriodTps = await db.select().from(touchpoints).where(
            and(
              eq(touchpoints.loggedById, dr.id),
              gte(touchpoints.date, periodStart),
              lte(touchpoints.date, periodEnd)
            )
          );
        }

        const drNewContacts = drCompanyIds.length > 0
          ? (await db.select().from(contacts).where(inArray(contacts.companyId, drCompanyIds)))
              .filter(c => c.createdAt && c.createdAt >= periodStart && c.createdAt <= periodEnd).length
          : 0;

        const drTasks = allTasks.filter(t => t.assignedTo === dr.id);
        const drTaskStats = {
          completed: drTasks.filter(t => t.status === "completed").length,
          open: drTasks.filter(t => t.status === "open" || t.status === "in_progress").length,
          overdue: drTasks.filter(t => (t.status === "open" || t.status === "in_progress") && t.dueDate && t.dueDate < today).length,
        };

        const drGoals = await this.getGoals({ amId: dr.id });
        const drActiveGoals = drGoals.filter(g => g.startDate <= periodEnd && g.endDate >= periodStart);
        const hasActiveGoals = drActiveGoals.length > 0;
        let drGoalsAvgPct = 0;
        if (hasActiveGoals) {
          const pcts = await Promise.all(drActiveGoals.map(async (g) => {
            let autoValue: number | null = null;
            if (g.metric === "contacts_added") {
              autoValue = await this.getContactsAddedByAm(dr.id, g.startDate, g.endDate);
            } else if (g.metric === "touchpoints") {
              autoValue = await this.getTouchpointCountByAm(dr.id, g.startDate, g.endDate);
            } else if (g.metric === "meaningful_touchpoints") {
              autoValue = await this.getMeaningfulTouchpointCountByAm(dr.id, g.startDate, g.endDate);
            }
            const displayCurrent = autoValue !== null ? autoValue : parseFloat(g.currentValue || "0");
            const target = parseFloat(g.target);
            return target > 0 ? Math.min(100, Math.round((displayCurrent / target) * 100)) : 0;
          }));
          drGoalsAvgPct = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
        }

        let drAllTps: typeof touchpoints.$inferSelect[] = [];
        if (drCompanyIds.length > 0) {
          drAllTps = await db.select().from(touchpoints).where(eq(touchpoints.loggedById, dr.id));
        }
        const twoWeeksAgo = new Date(now);
        twoWeeksAgo.setDate(now.getDate() - 14);
        const twoWeeksAgoStr = twoWeeksAgo.toISOString().slice(0, 10);
        const drLastTouchByCompany: Record<string, string> = {};
        for (const tp of drAllTps) {
          if (!drLastTouchByCompany[tp.companyId] || tp.date > drLastTouchByCompany[tp.companyId]) {
            drLastTouchByCompany[tp.companyId] = tp.date;
          }
        }
        const drAccountsNeedingAttention = drCompanies.filter(c => {
          const last = drLastTouchByCompany[c.id];
          return !last || last < twoWeeksAgoStr;
        }).length;

        return {
          id: dr.id,
          name: dr.name,
          role: dr.role,
          touchpoints: drPeriodTps.length,
          newContacts: drNewContacts,
          tasks: drTaskStats,
          goalsAvgPct: drGoalsAvgPct,
          hasActiveGoals,
          accountsNeedingAttention: drAccountsNeedingAttention,
        };
      })
    );

    return {
      rep: {
        id: userId,
        name: repUser?.name || "Unknown",
        role: repUser?.role || "account_manager",
        manager: manager?.name || null,
        director: director?.name || null,
        createdAt: repUser?.createdAt || null,
        financialRepId: repUser?.financialRepId || null,
      },
      period: { type: period, label: periodLabel, start: periodStart, end: periodEnd },
      goals: enrichedGoals,
      touchpoints: { ...tpBreakdown, weeklyTrend },
      contacts: { newThisPeriod: newContactsCount, contactsTouched },
      tasks: taskStats,
      topAccounts,
      accountsNeedingAttention,
      wins,
      teamMembers,
    };
  }

  async getAttachmentsByEntity(entityType: string, entityId: string): Promise<Attachment[]> {
    return db.select().from(attachments).where(
      and(eq(attachments.entityType, entityType), eq(attachments.entityId, entityId))
    );
  }

  async getAttachmentsByEntities(entityType: string, entityIds: string[]): Promise<Attachment[]> {
    if (entityIds.length === 0) return [];
    return db.select().from(attachments).where(
      and(eq(attachments.entityType, entityType), inArray(attachments.entityId, entityIds))
    );
  }

  async createAttachment(attachment: InsertAttachment): Promise<Attachment> {
    const [created] = await db.insert(attachments).values(attachment).returning();
    return created;
  }

  async getAttachment(id: string): Promise<Attachment | undefined> {
    const [att] = await db.select().from(attachments).where(eq(attachments.id, id));
    return att;
  }

  async deleteAttachment(id: string): Promise<boolean> {
    const result = await db.delete(attachments).where(eq(attachments.id, id)).returning();
    return result.length > 0;
  }

  async getPersonalAlerts(userId: string): Promise<PersonalAlert[]> {
    return db.select().from(personalAlerts)
      .where(eq(personalAlerts.userId, userId))
      .orderBy(desc(personalAlerts.scheduledDate));
  }

  async createPersonalAlert(alert: InsertPersonalAlert): Promise<PersonalAlert> {
    const [created] = await db.insert(personalAlerts).values(alert).returning();
    return created;
  }

  async deletePersonalAlert(id: string, userId: string): Promise<boolean> {
    const result = await db.delete(personalAlerts)
      .where(and(eq(personalAlerts.id, id), eq(personalAlerts.userId, userId)))
      .returning();
    return result.length > 0;
  }

  async fireDueAlerts(userId: string): Promise<PersonalAlert[]> {
    const today = new Date().toISOString().split("T")[0];
    const dueAlerts = await db.select().from(personalAlerts)
      .where(and(
        eq(personalAlerts.userId, userId),
        eq(personalAlerts.fired, false),
      ));

    const toFire = dueAlerts.filter(a => a.scheduledDate <= today);

    for (const alert of toFire) {
      await db.update(personalAlerts)
        .set({ fired: true })
        .where(eq(personalAlerts.id, alert.id));

      await db.insert(notifications).values({
        userId: alert.userId,
        type: "personal_alert",
        title: `Reminder: ${alert.title}`,
        body: alert.notes || undefined,
        link: "/tasks#alerts",
        read: false,
        relatedId: alert.id,
      });
    }

    return toFire;
  }

  async getVendorRoutedByCompany(companyId: string): Promise<VendorRouted[]> {
    return db.select().from(vendorRouted).where(
      and(eq(vendorRouted.companyId, companyId), eq(vendorRouted.active, true))
    );
  }

  async toggleVendorRouted(companyId: string, rowKey: string): Promise<{ active: boolean }> {
    const [upserted] = await db.insert(vendorRouted)
      .values({ companyId, rowKey, active: true })
      .onConflictDoUpdate({
        target: [vendorRouted.companyId, vendorRouted.rowKey],
        set: { active: sql`NOT vendor_routed.active` },
      })
      .returning();
    return { active: upserted.active };
  }

  async getPtoPassoffs(filter: { createdById?: string; coveringUserId?: string; all?: boolean }): Promise<PtoPassoff[]> {
    if (filter.all) {
      return db.select().from(ptoPassoffs).orderBy(desc(ptoPassoffs.createdAt));
    }
    if (filter.createdById && filter.coveringUserId) {
      return db.select().from(ptoPassoffs).where(
        or(eq(ptoPassoffs.createdById, filter.createdById), eq(ptoPassoffs.coveringUserId, filter.coveringUserId))
      ).orderBy(desc(ptoPassoffs.createdAt));
    }
    if (filter.createdById) {
      return db.select().from(ptoPassoffs).where(eq(ptoPassoffs.createdById, filter.createdById)).orderBy(desc(ptoPassoffs.createdAt));
    }
    if (filter.coveringUserId) {
      return db.select().from(ptoPassoffs).where(eq(ptoPassoffs.coveringUserId, filter.coveringUserId)).orderBy(desc(ptoPassoffs.createdAt));
    }
    return [];
  }

  async getPtoPassoff(id: string): Promise<PtoPassoff | undefined> {
    const [passoff] = await db.select().from(ptoPassoffs).where(eq(ptoPassoffs.id, id));
    return passoff;
  }

  async getPtoPassoffInOrg(id: string, orgId: string): Promise<PtoPassoff | undefined> {
    // PTO passoffs don't carry organizationId directly — they link to it
    // via users.organizationId on createdById. Inner-join enforces the org
    // boundary; cross-org IDs return undefined.
    const [row] = await db
      .select({ p: ptoPassoffs })
      .from(ptoPassoffs)
      .innerJoin(users, eq(users.id, ptoPassoffs.createdById))
      .where(and(eq(ptoPassoffs.id, id), eq(users.organizationId, orgId)));
    return row?.p;
  }

  async getPtoPassoffsByOrg(
    orgId: string,
    filter?: { createdById?: string; coveringUserId?: string },
  ): Promise<PtoPassoff[]> {
    const conds = [eq(users.organizationId, orgId)];
    if (filter?.createdById && filter?.coveringUserId) {
      conds.push(or(eq(ptoPassoffs.createdById, filter.createdById), eq(ptoPassoffs.coveringUserId, filter.coveringUserId))!);
    } else if (filter?.createdById) {
      conds.push(eq(ptoPassoffs.createdById, filter.createdById));
    } else if (filter?.coveringUserId) {
      conds.push(eq(ptoPassoffs.coveringUserId, filter.coveringUserId));
    }
    const rows = await db
      .select({ p: ptoPassoffs })
      .from(ptoPassoffs)
      .innerJoin(users, eq(users.id, ptoPassoffs.createdById))
      .where(and(...conds))
      .orderBy(desc(ptoPassoffs.createdAt));
    return rows.map(r => r.p);
  }

  async createPtoPassoff(data: InsertPtoPassoff & { createdAt: string }): Promise<PtoPassoff> {
    const [passoff] = await db.insert(ptoPassoffs).values(data).returning();
    return passoff;
  }

  async updatePtoPassoff(id: string, data: Partial<InsertPtoPassoff>): Promise<PtoPassoff | undefined> {
    const [updated] = await db.update(ptoPassoffs).set(data).where(eq(ptoPassoffs.id, id)).returning();
    return updated;
  }

  async deletePtoPassoff(id: string): Promise<boolean> {
    const result = await db.delete(ptoPassoffs).where(eq(ptoPassoffs.id, id)).returning();
    return result.length > 0;
  }

  async getPtoPassoffItems(passoffId: string): Promise<PtoPassoffItem[]> {
    return db.select().from(ptoPassoffItems).where(eq(ptoPassoffItems.passoffId, passoffId));
  }

  async createPtoPassoffItem(data: InsertPtoPassoffItem): Promise<PtoPassoffItem> {
    const [item] = await db.insert(ptoPassoffItems).values(data).returning();
    return item;
  }

  async updatePtoPassoffItem(id: string, data: Partial<InsertPtoPassoffItem>): Promise<PtoPassoffItem | undefined> {
    const [updated] = await db.update(ptoPassoffItems).set(data).where(eq(ptoPassoffItems.id, id)).returning();
    return updated;
  }

  async deletePtoPassoffItem(id: string): Promise<boolean> {
    const result = await db.delete(ptoPassoffItems).where(eq(ptoPassoffItems.id, id)).returning();
    return result.length > 0;
  }

  async getInternalPosts(userId: string, role: string, orgUserIds: string[]): Promise<InternalPost[]> {
    const isLeadership = role === "admin" || role === "director";
    if (isLeadership) {
      if (!orgUserIds.length) return [];
      return db.select().from(internalPosts)
        .where(inArray(internalPosts.authorId, orgUserIds))
        .orderBy(desc(internalPosts.createdAt));
    }
    // Non-leadership: only see top-level posts where they are a recipient, plus all replies under those threads
    const topLevel = await db.select().from(internalPosts)
      .where(and(isNull(internalPosts.parentId), sql`${userId} = ANY(${internalPosts.recipientIds})`))
      .orderBy(desc(internalPosts.createdAt));
    if (!topLevel.length) return [];
    const threadIds = topLevel.map(p => p.id);
    const replies = await db.select().from(internalPosts)
      .where(inArray(internalPosts.parentId, threadIds))
      .orderBy(internalPosts.createdAt);
    return [...topLevel, ...replies];
  }

  async createInternalPost(data: { content: string; authorId: string; recipientIds: string[]; parentId?: string | null; createdAt: string }): Promise<InternalPost> {
    const [created] = await db.insert(internalPosts).values(data).returning();
    return created;
  }

  async deleteInternalPost(id: string): Promise<boolean> {
    const result = await db.delete(internalPosts).where(eq(internalPosts.id, id)).returning();
    return result.length > 0;
  }

  async getMarketShareEntries(companyId: string): Promise<MarketShareEntry[]> {
    return db.select().from(marketShareEntries)
      .where(eq(marketShareEntries.companyId, companyId))
      .orderBy(marketShareEntries.periodStart, marketShareEntries.createdAt);
  }

  async getAllMarketShareEntries(): Promise<MarketShareEntry[]> {
    return db.select().from(marketShareEntries)
      .orderBy(marketShareEntries.companyId, marketShareEntries.periodStart, marketShareEntries.createdAt);
  }

  async createMarketShareEntry(entry: InsertMarketShareEntry): Promise<MarketShareEntry> {
    const [created] = await db.insert(marketShareEntries).values(entry).returning();
    return created;
  }

  async updateMarketShareEntry(id: string, data: Partial<InsertMarketShareEntry>): Promise<MarketShareEntry | undefined> {
    const [updated] = await db.update(marketShareEntries).set(data).where(eq(marketShareEntries.id, id)).returning();
    return updated;
  }

  async deleteMarketShareEntry(id: string): Promise<boolean> {
    const result = await db.delete(marketShareEntries).where(eq(marketShareEntries.id, id)).returning();
    return result.length > 0;
  }

  async getReportCardSnapshots(userId: string): Promise<ReportCardSnapshot[]> {
    return db.select().from(reportCardSnapshots)
      .where(eq(reportCardSnapshots.userId, userId))
      .orderBy(desc(reportCardSnapshots.snapshotDate));
  }

  async createReportCardSnapshot(data: InsertReportCardSnapshot): Promise<ReportCardSnapshot> {
    const [created] = await db.insert(reportCardSnapshots).values(data).returning();
    return created;
  }

  async getPromotionCriteria(): Promise<PromotionCriteria[]> {
    return db.select().from(promotionCriteria);
  }

  async upsertPromotionCriteria(fromRole: string, toRole: string, data: Partial<InsertPromotionCriteria>): Promise<PromotionCriteria> {
    const existing = await db.select().from(promotionCriteria)
      .where(and(eq(promotionCriteria.fromRole, fromRole), eq(promotionCriteria.toRole, toRole)));
    if (existing.length > 0) {
      const [updated] = await db.update(promotionCriteria)
        .set({ ...data, fromRole, toRole })
        .where(eq(promotionCriteria.id, existing[0].id))
        .returning();
      return updated;
    } else {
      const [created] = await db.insert(promotionCriteria)
        .values({ fromRole, toRole, ...data } as InsertPromotionCriteria)
        .returning();
      return created;
    }
  }

  async deletePromotionCriteria(id: string): Promise<boolean> {
    const result = await db.delete(promotionCriteria).where(eq(promotionCriteria.id, id)).returning();
    return result.length > 0;
  }

  async getPromotionNominations(): Promise<PromotionNomination[]> {
    return db.select().from(promotionNominations).orderBy(desc(promotionNominations.nominatedAt));
  }

  async getNominationsByNominee(nomineeId: string): Promise<PromotionNomination[]> {
    return db.select().from(promotionNominations)
      .where(eq(promotionNominations.nomineeId, nomineeId))
      .orderBy(desc(promotionNominations.nominatedAt));
  }

  async createPromotionNomination(data: InsertPromotionNomination): Promise<PromotionNomination> {
    const [created] = await db.insert(promotionNominations).values(data).returning();
    return created;
  }

  async updatePromotionNomination(id: string, data: Partial<InsertPromotionNomination>): Promise<PromotionNomination | undefined> {
    const [updated] = await db.update(promotionNominations).set(data).where(eq(promotionNominations.id, id)).returning();
    return updated;
  }

  async deletePromotionNomination(id: string): Promise<boolean> {
    const result = await db.delete(promotionNominations).where(eq(promotionNominations.id, id)).returning();
    return result.length > 0;
  }

  async getDevelopmentGoals(namId: string, amId: string): Promise<DevelopmentGoal | undefined> {
    const [row] = await db.select().from(developmentGoals)
      .where(and(eq(developmentGoals.namId, namId), eq(developmentGoals.amId, amId)));
    return row;
  }

  async upsertDevelopmentGoals(namId: string, amId: string, content: string, updatedById: string): Promise<DevelopmentGoal> {
    const now = new Date().toISOString();
    const [result] = await db.insert(developmentGoals)
      .values({ namId, amId, content, updatedAt: now, updatedById })
      .onConflictDoUpdate({
        target: [developmentGoals.namId, developmentGoals.amId],
        set: { content, updatedAt: now, updatedById },
      })
      .returning();
    return result;
  }

  async getToolLinks(): Promise<ToolLink[]> {
    return db.select().from(toolLinks).orderBy(toolLinks.sortOrder, toolLinks.createdAt);
  }

  async createToolLink(data: InsertToolLink): Promise<ToolLink> {
    const [link] = await db.insert(toolLinks).values(data).returning();
    return link;
  }

  async updateToolLink(id: string, data: Partial<InsertToolLink>): Promise<ToolLink | undefined> {
    const [link] = await db.update(toolLinks).set(data).where(eq(toolLinks.id, id)).returning();
    return link;
  }

  async deleteToolLink(id: string): Promise<boolean> {
    const result = await db.delete(toolLinks).where(eq(toolLinks.id, id)).returning();
    return result.length > 0;
  }

  async createDemoRequest(data: import('../shared/schema').InsertDemoRequest): Promise<import('../shared/schema').DemoRequest> {
    const { demoRequests } = await import('@shared/schema');
    const [record] = await db.insert(demoRequests).values(data).returning();
    return record;
  }

  async getLmDailyChecks(lmUserId: string): Promise<LmDailyCheck[]> {
    return db.select().from(lmDailyChecks)
      .where(eq(lmDailyChecks.lmUserId, lmUserId))
      .orderBy(desc(lmDailyChecks.date))
      .limit(30);
  }

  async upsertLmDailyCheck(data: { organizationId: string; lmUserId: string; checkedByUserId: string; date: string; callsBeforeSevenThirty?: boolean | null; checkoutCompleted?: boolean | null }): Promise<LmDailyCheck> {
    const existing = await db.select().from(lmDailyChecks)
      .where(and(eq(lmDailyChecks.lmUserId, data.lmUserId), eq(lmDailyChecks.date, data.date)))
      .limit(1);

    if (existing.length > 0) {
      const updateData: Partial<LmDailyCheck> = { checkedByUserId: data.checkedByUserId };
      if (data.callsBeforeSevenThirty !== undefined) updateData.callsBeforeSevenThirty = data.callsBeforeSevenThirty;
      if (data.checkoutCompleted !== undefined) updateData.checkoutCompleted = data.checkoutCompleted;
      const [updated] = await db.update(lmDailyChecks).set(updateData)
        .where(eq(lmDailyChecks.id, existing[0].id))
        .returning();
      return updated;
    } else {
      const [created] = await db.insert(lmDailyChecks).values({
        organizationId: data.organizationId,
        lmUserId: data.lmUserId,
        checkedByUserId: data.checkedByUserId,
        date: data.date,
        callsBeforeSevenThirty: data.callsBeforeSevenThirty ?? null,
        checkoutCompleted: data.checkoutCompleted ?? null,
      }).returning();
      return created;
    }
  }

  async createOpportunityLog(data: InsertOpportunityLog & { createdAt: string }): Promise<OpportunityLog> {
    const [log] = await db.insert(opportunityLogs).values(data).returning();
    return log;
  }

  async getOpportunityLogs(orgId: string, filters?: { repId?: string; companyId?: string; type?: string; startDate?: string; endDate?: string }): Promise<OpportunityLog[]> {
    const conditions = [eq(opportunityLogs.organizationId, orgId)];
    if (filters?.repId) conditions.push(eq(opportunityLogs.repId, filters.repId));
    if (filters?.companyId) conditions.push(eq(opportunityLogs.companyId, filters.companyId));
    if (filters?.type) conditions.push(eq(opportunityLogs.type, filters.type));
    if (filters?.startDate) conditions.push(gte(opportunityLogs.loggedAt, filters.startDate));
    if (filters?.endDate) conditions.push(lte(opportunityLogs.loggedAt, filters.endDate));
    return db.select().from(opportunityLogs).where(and(...conditions)).orderBy(desc(opportunityLogs.loggedAt));
  }

  async updateOpportunityLog(id: string, data: { description?: string | null }): Promise<OpportunityLog | undefined> {
    const [updated] = await db.update(opportunityLogs)
      .set({ description: data.description ?? null })
      .where(eq(opportunityLogs.id, id))
      .returning();
    return updated;
  }

  async deleteOpportunityLog(id: string): Promise<boolean> {
    const result = await db.delete(opportunityLogs).where(eq(opportunityLogs.id, id)).returning();
    return result.length > 0;
  }

  async getOpportunityLogSummary(repIds: string[], startDate: string, endDate: string): Promise<Array<{ repId: string; opportunities: number; wins: number }>> {
    if (repIds.length === 0) return [];
    const rows = await db.select().from(opportunityLogs)
      .where(and(
        inArray(opportunityLogs.repId, repIds),
        gte(opportunityLogs.loggedAt, startDate),
        lte(opportunityLogs.loggedAt, endDate)
      ));
    const summary: Record<string, { opportunities: number; wins: number }> = {};
    for (const r of rows) {
      if (!summary[r.repId]) summary[r.repId] = { opportunities: 0, wins: 0 };
      if (r.type === "win") summary[r.repId].wins++;
      else summary[r.repId].opportunities++;
    }
    return Object.entries(summary).map(([repId, s]) => ({ repId, ...s }));
  }

  async getLaneAttributionsByContact(contactId: string): Promise<ContactLaneAttribution[]> {
    return db.select().from(contactLaneAttributions)
      .where(eq(contactLaneAttributions.contactId, contactId))
      .orderBy(contactLaneAttributions.createdAt);
  }

  async getLaneAttributionsByCompany(companyId: string): Promise<ContactLaneAttribution[]> {
    return db.select().from(contactLaneAttributions)
      .where(eq(contactLaneAttributions.companyId, companyId));
  }

  async getLaneAttributionsByCompanyIds(companyIds: string[]): Promise<ContactLaneAttribution[]> {
    if (companyIds.length === 0) return [];
    return db.select().from(contactLaneAttributions)
      .where(inArray(contactLaneAttributions.companyId, companyIds));
  }

  async createLaneAttribution(data: InsertContactLaneAttribution): Promise<ContactLaneAttribution> {
    const [row] = await db.insert(contactLaneAttributions).values({
      ...data,
      createdAt: new Date().toISOString(),
    }).returning();
    return row;
  }

  async deleteLaneAttribution(id: string): Promise<boolean> {
    const result = await db.delete(contactLaneAttributions).where(eq(contactLaneAttributions.id, id)).returning();
    return result.length > 0;
  }

  // ── Prospect Pipeline ────────────────────────────────────────────────────────

  async getProspects(organizationId: string, ownerId?: string): Promise<import('../shared/schema').Prospect[]> {
    const { prospects } = await import('../shared/schema');
    const conditions = [eq(prospects.organizationId, organizationId)];
    if (ownerId) conditions.push(eq(prospects.ownerId, ownerId));
    return db.select().from(prospects)
      .where(and(...conditions))
      .orderBy(prospects.createdAt);
  }

  async getProspect(id: number): Promise<import('../shared/schema').Prospect | undefined> {
    const { prospects } = await import('../shared/schema');
    const [row] = await db.select().from(prospects).where(eq(prospects.id, id));
    return row;
  }

  async createProspect(data: import('../shared/schema').InsertProspect): Promise<import('../shared/schema').Prospect> {
    const { prospects } = await import('../shared/schema');
    const now = new Date();
    // Initialize accountStatusChangedAt so stale/velocity tracking works immediately
    const [row] = await db.insert(prospects).values({
      ...data,
      accountStatusChangedAt: now,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return row;
  }

  async updateProspect(id: number, data: Partial<import('../shared/schema').InsertProspect>): Promise<import('../shared/schema').Prospect | undefined> {
    const { prospects } = await import('../shared/schema');
    // If the stage is changing, stamp stageChangedAt so analytics can compute
    // time-in-stage as (now - stageChangedAt) instead of using updatedAt.
    let stageChangedAt: Date | undefined;
    let accountStatusChangedAt: Date | undefined;
    if (data.stage !== undefined || data.accountStatus !== undefined) {
      const [existing] = await db.select({ stage: prospects.stage, accountStatus: prospects.accountStatus }).from(prospects).where(eq(prospects.id, id));
      if (existing && data.stage !== undefined && existing.stage !== data.stage) {
        stageChangedAt = new Date();
      }
      if (existing && data.accountStatus !== undefined && existing.accountStatus !== data.accountStatus) {
        accountStatusChangedAt = new Date();
      }
    }
    const [row] = await db.update(prospects)
      .set({ ...data, updatedAt: new Date(), ...(stageChangedAt ? { stageChangedAt } : {}), ...(accountStatusChangedAt ? { accountStatusChangedAt } : {}) })
      .where(eq(prospects.id, id))
      .returning();
    return row;
  }

  async deleteProspect(id: number): Promise<boolean> {
    const { prospects } = await import('../shared/schema');
    const result = await db.delete(prospects).where(eq(prospects.id, id)).returning();
    return result.length > 0;
  }

  async getProspectActivities(prospectId: number): Promise<import('../shared/schema').ProspectActivity[]> {
    const { prospectActivities } = await import('../shared/schema');
    return db.select().from(prospectActivities)
      .where(eq(prospectActivities.prospectId, prospectId))
      .orderBy(prospectActivities.createdAt);
  }

  async getOrgProspectActivitiesSince(prospectIds: number[], since: Date): Promise<import('../shared/schema').ProspectActivity[]> {
    if (prospectIds.length === 0) return [];
    const { prospectActivities } = await import('../shared/schema');
    return db.select().from(prospectActivities)
      .where(and(inArray(prospectActivities.prospectId, prospectIds), gte(prospectActivities.createdAt, since)));
  }

  async createProspectActivity(data: import('../shared/schema').InsertProspectActivity): Promise<import('../shared/schema').ProspectActivity> {
    const { prospectActivities, prospects } = await import('../shared/schema');
    const [row] = await db.insert(prospectActivities).values({ ...data, createdAt: new Date() }).returning();
    // Bump prospect updatedAt so "days since last touch" reflects the new activity
    await db.update(prospects).set({ updatedAt: new Date() }).where(eq(prospects.id, data.prospectId));
    return row;
  }

  // ── Prospect Contacts ────────────────────────────────────────────────────────

  async getProspectContacts(prospectId: number): Promise<import('../shared/schema').ProspectContact[]> {
    const { prospectContacts } = await import('../shared/schema');
    return db.select().from(prospectContacts)
      .where(eq(prospectContacts.prospectId, prospectId))
      .orderBy(prospectContacts.createdAt);
  }

  async createProspectContact(data: import('../shared/schema').InsertProspectContact): Promise<import('../shared/schema').ProspectContact> {
    const { prospectContacts } = await import('../shared/schema');
    const [row] = await db.insert(prospectContacts).values({ ...data, createdAt: new Date() }).returning();
    return row;
  }

  async updateProspectContact(prospectId: number, contactId: number, data: Partial<import('../shared/schema').InsertProspectContact>): Promise<import('../shared/schema').ProspectContact | undefined> {
    const { prospectContacts } = await import('../shared/schema');
    const [row] = await db.update(prospectContacts)
      .set(data)
      .where(and(eq(prospectContacts.id, contactId), eq(prospectContacts.prospectId, prospectId)))
      .returning();
    return row;
  }

  async deleteProspectContact(prospectId: number, contactId: number): Promise<boolean> {
    const { prospectContacts } = await import('../shared/schema');
    const result = await db.delete(prospectContacts)
      .where(and(eq(prospectContacts.id, contactId), eq(prospectContacts.prospectId, prospectId)))
      .returning();
    return result.length > 0;
  }

  // ── Launchpad CRM ─────────────────────────────────────────────────────────────

  async getCrmOpportunities(prospectId: number): Promise<import('../shared/schema').CrmOpportunity[]> {
    const { crmOpportunities } = await import('../shared/schema');
    return db.select().from(crmOpportunities).where(eq(crmOpportunities.prospectId, prospectId)).orderBy(crmOpportunities.createdAt);
  }

  async getCrmOpportunitiesByCompanyId(companyId: string): Promise<import('../shared/schema').CrmOpportunity[]> {
    const { crmOpportunities } = await import('../shared/schema');
    return db.select().from(crmOpportunities).where(eq(crmOpportunities.companyId, companyId)).orderBy(desc(crmOpportunities.createdAt));
  }

  async getCrmOpportunityById(id: number): Promise<import('../shared/schema').CrmOpportunity | undefined> {
    const { crmOpportunities } = await import('../shared/schema');
    const [row] = await db.select().from(crmOpportunities).where(eq(crmOpportunities.id, id)).limit(1);
    return row;
  }

  async createCrmOpportunity(data: import('../shared/schema').InsertCrmOpportunity): Promise<import('../shared/schema').CrmOpportunity> {
    const { crmOpportunities } = await import('../shared/schema');
    const now = new Date();
    const [row] = await db.insert(crmOpportunities).values({ ...data, createdAt: now, updatedAt: now }).returning();
    return row;
  }

  async updateCrmOpportunity(id: number, data: Partial<import('../shared/schema').InsertCrmOpportunity>): Promise<import('../shared/schema').CrmOpportunity | undefined> {
    const { crmOpportunities } = await import('../shared/schema');
    const [row] = await db.update(crmOpportunities).set({ ...data, updatedAt: new Date() }).where(eq(crmOpportunities.id, id)).returning();
    return row;
  }

  async deleteCrmOpportunity(id: number): Promise<boolean> {
    const { crmOpportunities } = await import('../shared/schema');
    const result = await db.delete(crmOpportunities).where(eq(crmOpportunities.id, id)).returning();
    return result.length > 0;
  }

  async getCrmOwnershipRequests(organizationId: string): Promise<import('../shared/schema').CrmOwnershipRequest[]> {
    const { crmOwnershipRequests } = await import('../shared/schema');
    return db.select().from(crmOwnershipRequests)
      .where(eq(crmOwnershipRequests.organizationId, organizationId))
      .orderBy(crmOwnershipRequests.createdAt);
  }

  async getPendingOwnershipRequestsForProspect(prospectId: number): Promise<import('../shared/schema').CrmOwnershipRequest[]> {
    const { crmOwnershipRequests } = await import('../shared/schema');
    return db.select().from(crmOwnershipRequests)
      .where(and(eq(crmOwnershipRequests.prospectId, prospectId), eq(crmOwnershipRequests.status, 'pending')));
  }

  async createCrmOwnershipRequest(data: import('../shared/schema').InsertCrmOwnershipRequest): Promise<import('../shared/schema').CrmOwnershipRequest> {
    const { crmOwnershipRequests } = await import('../shared/schema');
    const [row] = await db.insert(crmOwnershipRequests).values({ ...data, createdAt: new Date() }).returning();
    return row;
  }

  async getCrmOwnershipRequestById(id: number): Promise<import('../shared/schema').CrmOwnershipRequest | undefined> {
    const { crmOwnershipRequests } = await import('../shared/schema');
    const [row] = await db.select().from(crmOwnershipRequests).where(eq(crmOwnershipRequests.id, id));
    return row;
  }

  async reviewCrmOwnershipRequest(id: number, status: string, reviewedById: string, adminNote?: string): Promise<import('../shared/schema').CrmOwnershipRequest | undefined> {
    const { crmOwnershipRequests } = await import('../shared/schema');
    const [row] = await db.update(crmOwnershipRequests)
      .set({ status, reviewedById, adminNote: adminNote ?? null, reviewedAt: new Date() })
      .where(eq(crmOwnershipRequests.id, id))
      .returning();
    return row;
  }

  async getCrmAccountHistory(prospectId: number): Promise<import('../shared/schema').CrmAccountHistory[]> {
    const { crmAccountHistory } = await import('../shared/schema');
    return db.select().from(crmAccountHistory)
      .where(eq(crmAccountHistory.prospectId, prospectId))
      .orderBy(crmAccountHistory.createdAt);
  }

  async logCrmAccountHistory(data: { prospectId: number; organizationId: string; field: string; oldValue: string | null; newValue: string | null; changedById: string }): Promise<void> {
    const { crmAccountHistory } = await import('../shared/schema');
    await db.insert(crmAccountHistory).values({ ...data, createdAt: new Date() });
  }

  // ── Stripe Billing ────────────────────────────────────────────────────────────

  async updateOrganizationBilling(id: string, data: {
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    billingStatus?: string;
    planName?: string | null;
    currentPeriodEnd?: Date | null;
  }): Promise<Organization | undefined> {
    type OrgUpdate = Partial<Pick<typeof organizations.$inferInsert,
      "stripeCustomerId" | "stripeSubscriptionId" | "billingStatus" | "planName" | "currentPeriodEnd">>;
    const updateData: OrgUpdate = {};
    if (data.stripeCustomerId !== undefined) updateData.stripeCustomerId = data.stripeCustomerId;
    if (data.stripeSubscriptionId !== undefined) updateData.stripeSubscriptionId = data.stripeSubscriptionId;
    if (data.billingStatus !== undefined) updateData.billingStatus = data.billingStatus;
    if (data.planName !== undefined) updateData.planName = data.planName;
    if (data.currentPeriodEnd !== undefined) updateData.currentPeriodEnd = data.currentPeriodEnd;
    const [updated] = await db.update(organizations).set(updateData).where(eq(organizations.id, id)).returning();
    return updated;
  }

  async getOrganizationByStripeCustomerId(stripeCustomerId: string): Promise<Organization | undefined> {
    const [org] = await db.select().from(organizations).where(eq(organizations.stripeCustomerId, stripeCustomerId));
    return org;
  }

  async getLaneCarrier(id: string): Promise<LaneCarrier | undefined> {
    const [carrier] = await db.select().from(laneCarriers).where(eq(laneCarriers.id, id));
    return carrier;
  }

  async getLaneCarriersByTask(taskId: string): Promise<LaneCarrier[]> {
    return db.select().from(laneCarriers).where(eq(laneCarriers.taskId, taskId)).orderBy(asc(laneCarriers.createdAt));
  }

  async getLaneCarriersByAward(awardId: string): Promise<LaneCarrier[]> {
    return db.select().from(laneCarriers).where(eq(laneCarriers.awardId, awardId)).orderBy(asc(laneCarriers.createdAt));
  }

  async createLaneCarrier(data: InsertLaneCarrier): Promise<LaneCarrier> {
    const [carrier] = await db.insert(laneCarriers).values(data).returning();
    return carrier;
  }

  async updateLaneCarrier(id: string, data: Partial<InsertLaneCarrier>): Promise<LaneCarrier | undefined> {
    const [updated] = await db.update(laneCarriers).set(data).where(eq(laneCarriers.id, id)).returning();
    return updated;
  }

  async deleteLaneCarrier(id: string): Promise<boolean> {
    const result = await db.delete(laneCarriers).where(eq(laneCarriers.id, id)).returning();
    return result.length > 0;
  }

  // Account Growth Score
  async upsertGrowthScore(data: import('../shared/schema').InsertAccountGrowthScore): Promise<import('../shared/schema').AccountGrowthScore> {
    const { accountGrowthScores } = await import('../shared/schema');
    const [row] = await db.insert(accountGrowthScores)
      .values(data)
      .onConflictDoUpdate({
        target: accountGrowthScores.companyId,
        set: {
          // Snapshot the current score/band as "previous" before overwriting —
          // referencing the table column (not sql`excluded`) reads the existing row value.
          previousScore: accountGrowthScores.score,
          previousBand:  accountGrowthScores.band,
          score:         data.score,
          band:          data.band,
          drivers:       data.drivers,
          calculatedAt:  data.calculatedAt,
        },
      })
      .returning();
    return row;
  }

  async getGrowthScore(companyId: string): Promise<import('../shared/schema').AccountGrowthScore | undefined> {
    const { accountGrowthScores } = await import('../shared/schema');
    const [row] = await db.select().from(accountGrowthScores).where(eq(accountGrowthScores.companyId, companyId)).limit(1);
    return row;
  }

  async getGrowthScoresByOrg(organizationId: string, companyIds: string[]): Promise<import('../shared/schema').AccountGrowthScore[]> {
    if (companyIds.length === 0) return [];
    const { accountGrowthScores } = await import('../shared/schema');
    return db.select().from(accountGrowthScores)
      .where(and(eq(accountGrowthScores.organizationId, organizationId), inArray(accountGrowthScores.companyId, companyIds)));
  }

  // ── Weekly Coaching Commitments ────────────────────────────────────────────

  async getWeeklyCommitments(userId: string, orgId: string, weekStart?: string): Promise<import('../shared/schema').WeeklyCommitment[]> {
    const { weeklyCommitments } = await import('../shared/schema');
    const conds = [eq(weeklyCommitments.userId, userId), eq(weeklyCommitments.orgId, orgId)];
    if (weekStart) conds.push(eq(weeklyCommitments.weekStart, weekStart));
    return db.select().from(weeklyCommitments).where(and(...conds)).orderBy(desc(weeklyCommitments.createdAt));
  }

  async getTeamWeeklyCommitments(orgId: string, weekStart: string): Promise<Array<import('../shared/schema').WeeklyCommitment & { userName: string; userRole: string }>> {
    const { weeklyCommitments } = await import('../shared/schema');
    const rows = await db
      .select({ wc: weeklyCommitments, userName: users.name, userRole: users.role })
      .from(weeklyCommitments)
      .innerJoin(users, eq(weeklyCommitments.userId, users.id))
      .where(and(eq(weeklyCommitments.orgId, orgId), eq(weeklyCommitments.weekStart, weekStart)))
      .orderBy(desc(weeklyCommitments.createdAt));
    return rows.map(r => ({ ...r.wc, userName: r.userName, userRole: r.userRole }));
  }

  async createWeeklyCommitment(data: import('../shared/schema').InsertWeeklyCommitment): Promise<import('../shared/schema').WeeklyCommitment> {
    const { weeklyCommitments } = await import('../shared/schema');
    const [row] = await db.insert(weeklyCommitments).values(data).returning();
    return row;
  }

  async updateWeeklyCommitmentStatus(id: string, userId: string, status: string): Promise<import('../shared/schema').WeeklyCommitment | undefined> {
    const { weeklyCommitments } = await import('../shared/schema');
    const now = new Date().toISOString();
    const setData: Record<string, string | null | undefined> = {
      status,
      updatedAt: now,
      completedAt: status === "completed" ? now : status === "pending" ? undefined : null,
    };
    const [row] = await db.update(weeklyCommitments)
      .set(setData as any)
      .where(and(eq(weeklyCommitments.id, id), eq(weeklyCommitments.userId, userId)))
      .returning();
    return row;
  }

  async deleteWeeklyCommitment(id: string, userId: string): Promise<boolean> {
    const { weeklyCommitments } = await import('../shared/schema');
    const result = await db.delete(weeklyCommitments)
      .where(and(eq(weeklyCommitments.id, id), eq(weeklyCommitments.userId, userId)));
    return (result.rowCount ?? 0) > 0;
  }

  // ── NBA Phase 1 Persistent Cards ────────────────────────────────────────────

  async createNbaCard(data: InsertNbaCard): Promise<NbaCard> {
    const now = new Date().toISOString();
    const [row] = await db.insert(nbaCards)
      .values({ ...data, createdAt: now } as any)
      .returning();
    try {
      await this.recordNbaCardEvent({
        cardId: row.id,
        orgId: row.orgId,
        userId: row.userId,
        eventType: "fired",
        actorUserId: null,
        reason: row.ruleType,
        metadata: { atStakeAmount: row.atStakeAmount ?? null, urgencyScore: row.urgencyScore ?? null },
      });
    } catch (err) {
      console.error("[nba-events] failed to record fired event", err);
    }
    return row;
  }

  async getVisibleNbaCards(userId: string, limit = 5): Promise<NbaCard[]> {
    const today = new Date().toISOString().split("T")[0];
    const rows = await db.select()
      .from(nbaCards)
      .where(
        and(
          eq(nbaCards.userId, userId),
          eq(nbaCards.status, "visible"),
        )
      )
      // Protect cards always surface first; within the same outcome tier, highest urgency wins
      .orderBy(
        sql`CASE ${nbaCards.outcomeType} WHEN 'protect' THEN 1 WHEN 'execute' THEN 2 WHEN 'grow' THEN 3 WHEN 'deepen' THEN 4 ELSE 5 END`,
        desc(nbaCards.urgencyScore),
        desc(nbaCards.createdAt),
      )
      .limit(limit);
    return rows.filter(r => !r.snoozeUntil || r.snoozeUntil <= today);
  }

  async getRecentNbaCardByType(companyId: string, ruleType: string, dayLimit: number): Promise<NbaCard | undefined> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - dayLimit);
    const cutoffStr = cutoff.toISOString();
    const rows = await db.select()
      .from(nbaCards)
      .where(
        and(
          eq(nbaCards.companyId, companyId),
          eq(nbaCards.ruleType, ruleType),
        )
      )
      .orderBy((t: any) => t.createdAt)
      .limit(10);
    return rows.filter(r => r.createdAt >= cutoffStr)[0];
  }

  async getActiveStaleQuoteFollowUpCard(orgId: string, quoteId: string): Promise<NbaCard | undefined> {
    const rows = await db.select()
      .from(nbaCards)
      .where(and(
        eq(nbaCards.orgId, orgId),
        eq(nbaCards.ruleType, "stale_quote_followup"),
        eq(nbaCards.linkedCommitmentId, quoteId),
        sql`${nbaCards.status} IN ('visible', 'generated', 'snoozed')`,
      ))
      .orderBy(desc(nbaCards.createdAt))
      .limit(1);
    return rows[0];
  }

  async getActiveNbaCardByThreadAndType(
    companyId: string,
    ruleType: string,
    threadId: string,
  ): Promise<NbaCard | undefined> {
    const rows = await db.select()
      .from(nbaCards)
      .where(and(
        eq(nbaCards.companyId, companyId),
        eq(nbaCards.ruleType, ruleType),
        sql`${nbaCards.signalSummary}::jsonb @> ${JSON.stringify([{ threadId }])}::jsonb`,
      ))
      .orderBy(desc(nbaCards.createdAt))
      .limit(1);
    return rows[0];
  }

  async getRecentNbaCardByLane(laneId: string, userId: string, dayLimit: number): Promise<NbaCard | undefined> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - dayLimit);
    const cutoffStr = cutoff.toISOString();
    const rows = await db.select()
      .from(nbaCards)
      .where(
        and(
          eq(nbaCards.linkedLaneId, laneId),
          eq(nbaCards.userId, userId),
          eq(nbaCards.ruleType, "recurring_lane_capacity"),
          // Only count truly active cards — superseded/actioned/resolved cards
          // must not block regeneration of a fresh card for the same lane+user
          sql`${nbaCards.status} IN ('visible', 'generated')`,
        )
      )
      .orderBy(desc(nbaCards.createdAt))
      .limit(5);
    return rows.filter(r => r.createdAt >= cutoffStr)[0];
  }

  async getNbaCard(id: string): Promise<NbaCard | undefined> {
    const [row] = await db.select().from(nbaCards).where(eq(nbaCards.id, id)).limit(1);
    return row;
  }

  async resolveNbaCard(id: string, userId: string, data: Record<string, unknown>): Promise<NbaCard | undefined> {
    const now = new Date().toISOString();
    const [row] = await db.update(nbaCards)
      .set({ ...data, resolvedAt: now } as any)
      .where(and(eq(nbaCards.id, id), eq(nbaCards.userId, userId)))
      .returning();
    return row;
  }

  async supersedePreviousNbaCards(companyId: string, winningRuleType: string): Promise<void> {
    // Mark any visible or generated card for this company with a DIFFERENT rule type as superseded.
    // Same rule type within the dedup window is blocked upstream; only cross-rule cards are superseded here.
    // IMPORTANT: recurring_lane_capacity cards are lane-scoped (not company winners) and must never
    // be touched by this function — they have their own dedup and lifecycle logic.
    await db.update(nbaCards)
      .set({ status: "superseded" } as any)
      .where(
        and(
          eq(nbaCards.companyId, companyId),
          sql`${nbaCards.status} IN ('visible', 'generated')`,
          sql`${nbaCards.ruleType} != ${winningRuleType}`,
          sql`${nbaCards.ruleType} != 'recurring_lane_capacity'`,
        )
      );
  }

  async resolveNbaCardsForLane(laneId: string): Promise<void> {
    const now = new Date().toISOString();
    const resolved = await db.update(nbaCards)
      .set({ status: "actioned", resolvedAt: now, resolutionAction: "auto_lane_threshold" } as any)
      .where(
        and(
          eq(nbaCards.linkedLaneId, laneId),
          eq(nbaCards.ruleType, "recurring_lane_capacity"),
          sql`${nbaCards.status} IN ('visible', 'generated')`,
        )
      )
      .returning({ id: nbaCards.id, orgId: nbaCards.orgId, userId: nbaCards.userId });
    for (const r of resolved) {
      try {
        await this.recordNbaCardEvent({
          cardId: r.id, orgId: r.orgId, userId: r.userId,
          eventType: "acted", actorUserId: r.userId, reason: "auto_lane_threshold", metadata: null,
        });
        await this.recordNbaCardEvent({
          cardId: r.id, orgId: r.orgId, userId: r.userId,
          eventType: "resolved", actorUserId: r.userId, reason: "auto_lane_threshold", metadata: null,
        });
      } catch (err) { console.error("[nba-events] resolveNbaCardsForLane event failed", err); }
    }
  }

  async findOpenLaneProcurementTask(laneId: string, assignedTo: string): Promise<Task | undefined> {
    const rows = await db.select().from(tasks).where(
      and(
        eq(tasks.assignedTo, assignedTo),
        sql`${tasks.laneContext}->>'laneId' = ${laneId}`,
        sql`${tasks.laneContext}->>'type' = 'lane_procurement'`,
        sql`${tasks.status} != 'completed'`,
      )
    ).limit(1);
    return rows[0];
  }

  async completeTasksForLane(laneId: string): Promise<void> {
    const now = new Date().toISOString();
    await db.update(tasks)
      .set({ status: "completed", updatedAt: now })
      .where(
        and(
          sql`${tasks.laneContext}->>'laneId' = ${laneId}`,
          sql`${tasks.laneContext}->>'type' = 'lane_procurement'`,
          sql`${tasks.status} != 'completed'`,
        )
      );
  }

  async getVisibleNbaCardsForOrg(orgId: string, limit = 20): Promise<NbaCard[]> {
    const today = new Date().toISOString().split("T")[0];
    const rows = await db.select()
      .from(nbaCards)
      .where(
        and(
          eq(nbaCards.orgId, orgId),
          eq(nbaCards.status, "visible"),
        )
      )
      .orderBy(
        sql`CASE ${nbaCards.outcomeType} WHEN 'protect' THEN 1 WHEN 'execute' THEN 2 WHEN 'grow' THEN 3 WHEN 'deepen' THEN 4 ELSE 5 END`,
        desc(nbaCards.urgencyScore),
        desc(nbaCards.createdAt),
      )
      .limit(limit);
    return rows.filter(r => !r.snoozeUntil || r.snoozeUntil <= today);
  }

  async getNbaCardForCompany(companyId: string): Promise<NbaCard | undefined> {
    const today = new Date().toISOString().split("T")[0];
    const rows = await db.select()
      .from(nbaCards)
      .where(
        and(
          eq(nbaCards.companyId, companyId),
          eq(nbaCards.status, "visible"),
        )
      )
      .orderBy(
        sql`CASE ${nbaCards.outcomeType} WHEN 'protect' THEN 1 WHEN 'execute' THEN 2 WHEN 'grow' THEN 3 WHEN 'deepen' THEN 4 ELSE 5 END`,
        desc(nbaCards.urgencyScore),
        desc(nbaCards.createdAt),
      )
      .limit(1);
    const card = rows[0];
    if (!card) return undefined;
    if (card.snoozeUntil && card.snoozeUntil > today) return undefined;
    return card;
  }

  async processExpiredNbaCards(orgId: string, touchpointCompanyId?: string): Promise<void> {
    // Expire visible cards older than 14 days that haven't been actioned
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = cutoff.toISOString();
    // Set resolvedAt + resolutionAction so the outcome classifier picks these
    // up (it requires resolved_at IS NOT NULL).
    const expiredRows = await db.update(nbaCards)
      .set({ status: "expired", resolvedAt: new Date().toISOString(), resolutionAction: "auto_expired" } as any)
      .where(
        and(
          eq(nbaCards.orgId, orgId),
          eq(nbaCards.status, "visible"),
          sql`${nbaCards.createdAt} < ${cutoffStr}`,
        )
      )
      .returning({ id: nbaCards.id, userId: nbaCards.userId, orgId: nbaCards.orgId });
    for (const r of expiredRows) {
      try {
        await this.recordNbaCardEvent({
          cardId: r.id, orgId: r.orgId, userId: r.userId,
          eventType: "expired", actorUserId: null, reason: "stale_no_action_14d", metadata: null,
        });
        await this.recordNbaCardEvent({
          cardId: r.id, orgId: r.orgId, userId: r.userId,
          eventType: "resolved", actorUserId: null, reason: "auto_expired", metadata: null,
        });
      } catch (err) { console.error("[nba-events] expire event failed", err); }
    }
    // If a touchpoint was logged, auto-resolve stale_account cards for that company
    if (touchpointCompanyId) {
      const autoResolved = await db.update(nbaCards)
        .set({ status: "actioned", resolutionAction: "auto_touchpoint", resolvedAt: new Date().toISOString() } as any)
        .where(
          and(
            eq(nbaCards.companyId, touchpointCompanyId),
            sql`${nbaCards.ruleType} IN ('stale_account','single_thread_risk')`,
            eq(nbaCards.status, "visible"),
          )
        )
        .returning({ id: nbaCards.id, userId: nbaCards.userId, orgId: nbaCards.orgId });
      for (const r of autoResolved) {
        try {
          await this.recordNbaCardEvent({
            cardId: r.id, orgId: r.orgId, userId: r.userId,
            eventType: "acted", actorUserId: r.userId, reason: "auto_touchpoint", metadata: null,
          });
          await this.recordNbaCardEvent({
            cardId: r.id, orgId: r.orgId, userId: r.userId,
            eventType: "resolved", actorUserId: r.userId, reason: "auto_touchpoint", metadata: null,
          });
        } catch (err) { console.error("[nba-events] auto-resolve event failed", err); }
      }
    }
  }

  async getNbaManagerSummary(orgId: string, weekStart: string): Promise<Array<{
    userId: string; userName: string; shown: number; actioned: number; dismissed: number; ignored: number;
  }>> {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndStr = weekEnd.toISOString();
    const rows = await db.select()
      .from(nbaCards)
      .where(
        and(
          eq(nbaCards.orgId, orgId),
          // cards created this week
        )
      );
    // Group by userId
    const map = new Map<string, { userId: string; shown: number; actioned: number; dismissed: number; ignored: number }>();
    for (const card of rows) {
      if (card.createdAt < weekStart || card.createdAt >= weekEndStr) continue;
      if (!map.has(card.userId)) {
        map.set(card.userId, { userId: card.userId, shown: 0, actioned: 0, dismissed: 0, ignored: 0 });
      }
      const entry = map.get(card.userId)!;
      if (card.status === "visible" || card.status === "actioned" || card.status === "dismissed" || card.status === "expired") {
        entry.shown++;
      }
      if (card.status === "actioned") entry.actioned++;
      if (card.status === "dismissed") entry.dismissed++;
      if (card.status === "expired") entry.ignored++;
    }
    // Attach user names
    const allUsers = await db.select({ id: users.id, name: users.name }).from(users);
    const nameMap = new Map(allUsers.map(u => [u.id, u.name]));
    return Array.from(map.values()).map(e => ({
      ...e,
      userName: nameMap.get(e.userId) ?? e.userId,
    }));
  }

  async getNbaRulePerformance(orgId: string, daysBack = 30): Promise<Array<{
    ruleType: string; firedCount: number; shownCount: number; actionedCount: number;
    dismissedCount: number; avgHoursToAction: number | null; outcomeLinkCount: number;
    classifiedCount: number; workedCount: number; partialCount: number; noResponseCount: number;
    outcomeRate: number; dollarMoved: number;
  }>> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const cutoffStr = cutoff.toISOString();
    const rows = await db.select()
      .from(nbaCards)
      .where(
        and(
          eq(nbaCards.orgId, orgId),
        )
      );
    const filtered = rows.filter(r => r.createdAt >= cutoffStr);
    const map = new Map<string, {
      ruleType: string; firedCount: number; shownCount: number; actionedCount: number;
      dismissedCount: number; hoursToAction: number[]; outcomeLinkCount: number;
    }>();
    for (const card of filtered) {
      if (!map.has(card.ruleType)) {
        map.set(card.ruleType, {
          ruleType: card.ruleType, firedCount: 0, shownCount: 0, actionedCount: 0,
          dismissedCount: 0, hoursToAction: [], outcomeLinkCount: 0,
        });
      }
      const e = map.get(card.ruleType)!;
      e.firedCount++;
      if (["visible","actioned","dismissed","expired"].includes(card.status)) e.shownCount++;
      if (card.status === "actioned") {
        e.actionedCount++;
        if (card.resolvedAt && card.createdAt) {
          const hours = (new Date(card.resolvedAt).getTime() - new Date(card.createdAt).getTime()) / 3_600_000;
          e.hoursToAction.push(hours);
        }
      }
      if (card.status === "dismissed") e.dismissedCount++;
      if (card.outcomeLinkedAt) e.outcomeLinkCount++;
    }
    // Per-rule classified outcomes (Task #374) — joined from nba_card_outcomes
    const outcomeRows = await db.select()
      .from(nbaCardOutcomes)
      .where(
        and(
          eq(nbaCardOutcomes.orgId, orgId),
          sql`${nbaCardOutcomes.classifiedAt} >= ${cutoffStr}`,
        )
      );
    const outcomeMap = new Map<string, { worked: number; partial: number; noResp: number; dollars: number; total: number }>();
    for (const o of outcomeRows) {
      const cur = outcomeMap.get(o.ruleType) ?? { worked: 0, partial: 0, noResp: 0, dollars: 0, total: 0 };
      cur.total++;
      if (o.outcome === "worked") cur.worked++;
      else if (o.outcome === "partial") cur.partial++;
      else if (o.outcome === "no_response") cur.noResp++;
      cur.dollars += Number(o.dollarImpact ?? 0);
      outcomeMap.set(o.ruleType, cur);
      if (!map.has(o.ruleType)) {
        map.set(o.ruleType, {
          ruleType: o.ruleType, firedCount: 0, shownCount: 0, actionedCount: 0,
          dismissedCount: 0, hoursToAction: [], outcomeLinkCount: 0,
        });
      }
    }
    return Array.from(map.values()).map(e => {
      const o = outcomeMap.get(e.ruleType) ?? { worked: 0, partial: 0, noResp: 0, dollars: 0, total: 0 };
      return {
        ruleType: e.ruleType,
        firedCount: e.firedCount,
        shownCount: e.shownCount,
        actionedCount: e.actionedCount,
        dismissedCount: e.dismissedCount,
        avgHoursToAction: e.hoursToAction.length > 0
          ? e.hoursToAction.reduce((a, b) => a + b, 0) / e.hoursToAction.length
          : null,
        outcomeLinkCount: e.outcomeLinkCount,
        classifiedCount: o.total,
        workedCount: o.worked,
        partialCount: o.partial,
        noResponseCount: o.noResp,
        outcomeRate: o.total > 0 ? (o.worked + o.partial * 0.5) / o.total : 0,
        dollarMoved: o.dollars,
      };
    });
  }

  // ── NBA Lifecycle Events + Outcomes (Task #374) ────────────────────────────

  async recordNbaCardEvent(event: InsertNbaCardEvent): Promise<NbaCardEvent> {
    const [row] = await db.insert(nbaCardEvents).values(event).returning();
    return row;
  }

  async markNbaCardViewed(cardId: string, userId: string, orgId: string): Promise<NbaCard | undefined> {
    // Conditional update: only set first_viewed_at when it is still NULL so we
    // don't overwrite the original timestamp (or emit duplicate "viewed" events)
    // under concurrent requests.
    const now = new Date().toISOString();
    const [updated] = await db.update(nbaCards)
      .set({ firstViewedAt: now })
      .where(and(
        eq(nbaCards.id, cardId),
        eq(nbaCards.userId, userId),
        sql`${nbaCards.firstViewedAt} IS NULL`,
      ))
      .returning();
    if (updated) {
      await this.recordNbaCardEvent({
        cardId, orgId, userId, eventType: "viewed", actorUserId: userId,
      });
      return updated;
    }
    // Either the card was already viewed, doesn't exist, or isn't this user's.
    const [existing] = await db.select().from(nbaCards).where(eq(nbaCards.id, cardId)).limit(1);
    if (!existing || existing.userId !== userId) return undefined;
    return existing;
  }

  async getNbaCardEvents(cardId: string): Promise<NbaCardEvent[]> {
    return db.select().from(nbaCardEvents)
      .where(eq(nbaCardEvents.cardId, cardId))
      .orderBy(nbaCardEvents.createdAt);
  }

  async upsertNbaCardOutcome(data: InsertNbaCardOutcome): Promise<NbaCardOutcome> {
    const existing = await db.select().from(nbaCardOutcomes)
      .where(eq(nbaCardOutcomes.cardId, data.cardId))
      .limit(1);
    if (existing[0]) {
      const [row] = await db.update(nbaCardOutcomes)
        .set({ ...data, classifiedAt: new Date() })
        .where(eq(nbaCardOutcomes.cardId, data.cardId))
        .returning();
      return row;
    }
    const [row] = await db.insert(nbaCardOutcomes).values(data).returning();
    return row;
  }

  /**
   * Find resolved cards that have not been classified yet AND whose
   * attribution window has elapsed. Used by the outcome classifier.
   */
  async getResolvedNbaCardsAwaitingClassification(orgId: string): Promise<NbaCard[]> {
    // Use Drizzle table select so we get camelCase NbaCard rows that the
    // outcome classifier can consume directly (raw SQL would return snake_case).
    const rows = await db.select()
      .from(nbaCards)
      .where(
        and(
          eq(nbaCards.orgId, orgId),
          sql`${nbaCards.status} IN ('actioned','dismissed','expired','snoozed','alternate')`,
          sql`${nbaCards.resolvedAt} IS NOT NULL`,
          sql`NOT EXISTS (SELECT 1 FROM ${nbaCardOutcomes} WHERE ${nbaCardOutcomes.cardId} = ${nbaCards.id})`,
        )
      )
      .orderBy(nbaCards.resolvedAt)
      .limit(500);
    return rows;
  }

  /**
   * Per-rep monthly NBA impact summary used by "Your NBA impact".
   */
  async getNbaImpactForUser(userId: string, orgId: string, daysBack = 30): Promise<{
    daysBack: number;
    fired: number;
    viewed: number;
    actioned: number;
    dismissed: number;
    snoozed: number;
    expired: number;
    conversionRate: number;
    outcomesWorked: number;
    outcomesNoResponse: number;
    dollarMoved: number;
    byRule: Array<{
      ruleType: string;
      fired: number;
      actioned: number;
      conversionRate: number;
      worked: number;
      dollarMoved: number;
    }>;
  }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const cutoffStr = cutoff.toISOString();
    const cards = await db.select().from(nbaCards).where(
      and(eq(nbaCards.userId, userId), eq(nbaCards.orgId, orgId)),
    );
    const filtered = cards.filter(c => c.createdAt >= cutoffStr);

    const outcomes = await db.select().from(nbaCardOutcomes)
      .where(and(eq(nbaCardOutcomes.userId, userId), eq(nbaCardOutcomes.orgId, orgId)));
    const outcomeByCard = new Map(outcomes.map(o => [o.cardId, o]));

    let fired = 0, viewed = 0, actioned = 0, dismissed = 0, snoozed = 0, expired = 0;
    let worked = 0, noResponse = 0, dollarMoved = 0;
    const ruleMap = new Map<string, { ruleType: string; fired: number; actioned: number; worked: number; dollarMoved: number }>();

    for (const c of filtered) {
      fired++;
      if (c.firstViewedAt) viewed++;
      if (c.status === "actioned") actioned++;
      if (c.status === "dismissed") dismissed++;
      if (c.status === "snoozed") snoozed++;
      if (c.status === "expired") expired++;
      if (!ruleMap.has(c.ruleType)) {
        ruleMap.set(c.ruleType, { ruleType: c.ruleType, fired: 0, actioned: 0, worked: 0, dollarMoved: 0 });
      }
      const rb = ruleMap.get(c.ruleType)!;
      rb.fired++;
      if (c.status === "actioned") rb.actioned++;
      const o = outcomeByCard.get(c.id);
      if (o) {
        if (o.outcome === "worked") { worked++; rb.worked++; }
        if (o.outcome === "no_response") noResponse++;
        if (o.dollarImpact) {
          const v = Number(o.dollarImpact);
          if (!Number.isNaN(v)) {
            dollarMoved += v;
            rb.dollarMoved += v;
          }
        }
      }
    }

    return {
      daysBack,
      fired, viewed, actioned, dismissed, snoozed, expired,
      conversionRate: fired > 0 ? actioned / fired : 0,
      outcomesWorked: worked,
      outcomesNoResponse: noResponse,
      dollarMoved,
      // Top-converting card types: rank by conversion rate (actioned / fired),
      // with fired count as the tiebreaker so a single 100%-actioned outlier
      // doesn't outrank a high-volume rule with a strong rate.
      byRule: Array.from(ruleMap.values()).map(r => ({
        ...r,
        conversionRate: r.fired > 0 ? r.actioned / r.fired : 0,
      })).sort((a, b) => (b.conversionRate - a.conversionRate) || (b.fired - a.fired)),
    };
  }

  /**
   * Team rollup for NAM / Director: per-AM open counts, untouched-3+-days,
   * dismiss-reason histogram, top high-$ unworked accounts, conversion rate,
   * and estimated $ moved.
   */
  async getNbaTeamRollup(amUserIds: string[], orgId: string, daysBack = 30): Promise<{
    daysBack: number;
    perAm: Array<{
      userId: string;
      userName: string;
      open: number;
      untouched3d: number;
      fired: number;
      actioned: number;
      dismissed: number;
      conversionRate: number;
      worked: number;
      dollarMoved: number;
      dismissReasons: Array<{ reason: string; count: number }>;
    }>;
    dismissReasons: Array<{ reason: string; count: number }>;
    topUnworked: Array<{
      cardId: string;
      userId: string;
      userName: string;
      companyId: string | null;
      companyName: string | null;
      atStakeAmount: number;
      ruleType: string;
      ageDays: number;
    }>;
    totals: { open: number; untouched3d: number; conversionRate: number; dollarMoved: number; worked: number; fired: number };
  }> {
    if (amUserIds.length === 0) {
      return { daysBack, perAm: [], dismissReasons: [], topUnworked: [], totals: { open: 0, untouched3d: 0, conversionRate: 0, dollarMoved: 0, worked: 0, fired: 0 } };
    }
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const cutoffStr = cutoff.toISOString();

    const cards = await db.select().from(nbaCards)
      .where(and(eq(nbaCards.orgId, orgId), inArray(nbaCards.userId, amUserIds)));

    const outcomes = await db.select().from(nbaCardOutcomes)
      .where(and(eq(nbaCardOutcomes.orgId, orgId), inArray(nbaCardOutcomes.userId, amUserIds)));
    const outcomeByCard = new Map(outcomes.map(o => [o.cardId, o]));

    const userRows = await db.select({ id: users.id, name: users.name }).from(users)
      .where(inArray(users.id, amUserIds));
    const userName = new Map(userRows.map(u => [u.id, u.name]));

    // Companies for unworked summary
    const companyIds = Array.from(new Set(cards.map(c => c.companyId).filter(Boolean) as string[]));
    const companyRows = companyIds.length
      ? await db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, companyIds))
      : [];
    const companyName = new Map(companyRows.map(c => [c.id, c.name]));

    const today = new Date();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const perAmMap = new Map<string, ReturnType<typeof initAm>>();
    function initAm(userId: string) {
      return {
        userId, userName: userName.get(userId) ?? userId,
        open: 0, untouched3d: 0, fired: 0, actioned: 0, dismissed: 0, worked: 0, dollarMoved: 0, conversionRate: 0,
        dismissReasons: [] as Array<{ reason: string; count: number }>,
        _dismissReasonMap: new Map<string, number>() as Map<string, number>,
      };
    }
    for (const uid of amUserIds) perAmMap.set(uid, initAm(uid));

    const dismissReasonCounts = new Map<string, number>();
    const unworked: Array<{ card: NbaCard; ageDays: number }> = [];

    for (const c of cards) {
      const am = perAmMap.get(c.userId)!;
      if (c.status === "visible") {
        am.open++;
        const created = new Date(c.createdAt).getTime();
        const ageMs = today.getTime() - created;
        if (!c.firstViewedAt && ageMs > threeDaysMs) am.untouched3d++;
        // "Unworked" = open + at-stake regardless of whether viewed; the rep
        // may have viewed but not acted, which still counts as unworked from
        // the manager's coaching standpoint.
        const atStake = c.atStakeAmount ? Number(c.atStakeAmount) : 0;
        if (atStake > 0) {
          unworked.push({ card: c, ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)) });
        }
      }
      if (c.createdAt >= cutoffStr) {
        am.fired++;
        if (c.status === "actioned") am.actioned++;
        if (c.status === "dismissed") {
          am.dismissed++;
          const r = c.dismissReason ?? "(unspecified)";
          dismissReasonCounts.set(r, (dismissReasonCounts.get(r) ?? 0) + 1);
          am._dismissReasonMap.set(r, (am._dismissReasonMap.get(r) ?? 0) + 1);
        }
        const o = outcomeByCard.get(c.id);
        if (o) {
          if (o.outcome === "worked") am.worked++;
          if (o.dollarImpact) {
            const v = Number(o.dollarImpact);
            if (!Number.isNaN(v)) am.dollarMoved += v;
          }
        }
      }
    }
    for (const am of Array.from(perAmMap.values())) {
      am.conversionRate = am.fired > 0 ? am.actioned / am.fired : 0;
      am.dismissReasons = Array.from(am._dismissReasonMap.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);
    }

    unworked.sort((a, b) => Number(b.card.atStakeAmount ?? 0) - Number(a.card.atStakeAmount ?? 0));
    const topUnworked = unworked.slice(0, 10).map(({ card, ageDays }) => ({
      cardId: card.id,
      userId: card.userId,
      userName: userName.get(card.userId) ?? card.userId,
      companyId: card.companyId ?? null,
      companyName: card.companyId ? (companyName.get(card.companyId) ?? null) : null,
      atStakeAmount: Number(card.atStakeAmount ?? 0),
      ruleType: card.ruleType,
      ageDays,
    }));

    const dismissReasons = Array.from(dismissReasonCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    const perAmList = Array.from(perAmMap.values())
      .map(({ _dismissReasonMap, ...rest }) => rest)
      .sort((a, b) => b.open - a.open);
    const totals = perAmList.reduce(
      (acc, am) => ({
        open: acc.open + am.open,
        untouched3d: acc.untouched3d + am.untouched3d,
        fired: acc.fired + am.fired,
        worked: acc.worked + am.worked,
        dollarMoved: acc.dollarMoved + am.dollarMoved,
        conversionRate: 0,
      }),
      { open: 0, untouched3d: 0, fired: 0, worked: 0, dollarMoved: 0, conversionRate: 0 },
    );
    const totalActioned = perAmList.reduce((s, a) => s + a.actioned, 0);
    totals.conversionRate = totals.fired > 0 ? totalActioned / totals.fired : 0;

    return { daysBack, perAm: perAmList, dismissReasons, topUnworked, totals };
  }

  /**
   * Read-only drill-in: visible NBA cards for any AM in the manager's scope.
   */
  async getNbaCardsForUserReadonly(userId: string, orgId: string): Promise<NbaCard[]> {
    const today = new Date().toISOString().split("T")[0];
    const rows = await db.select().from(nbaCards)
      .where(and(
        eq(nbaCards.orgId, orgId),
        eq(nbaCards.userId, userId),
        eq(nbaCards.status, "visible"),
      ))
      .orderBy(
        sql`CASE ${nbaCards.outcomeType} WHEN 'protect' THEN 1 WHEN 'execute' THEN 2 WHEN 'grow' THEN 3 WHEN 'deepen' THEN 4 ELSE 5 END`,
        desc(nbaCards.urgencyScore),
        desc(nbaCards.createdAt),
      );
    return rows.filter(r => !r.snoozeUntil || r.snoozeUntil <= today);
  }

  // ── Market Signal NBA methods ─────────────────────────────────────────────────

  async getNbaCardsByMarketSignal(signalId: string): Promise<NbaCard[]> {
    return db.select().from(nbaCards)
      .where(eq(nbaCards.marketSignalId, signalId))
      .orderBy(desc(nbaCards.createdAt));
  }

  async getNbaCardsByCompanyAndRuleType(companyId: string, ruleType: string): Promise<NbaCard[]> {
    return db.select().from(nbaCards)
      .where(and(eq(nbaCards.companyId, companyId), eq(nbaCards.ruleType, ruleType)))
      .orderBy(desc(nbaCards.createdAt));
  }

  async getNbaCardsByUserId(userId: string, ruleType?: string): Promise<NbaCard[]> {
    const cond = ruleType
      ? and(eq(nbaCards.userId, userId), eq(nbaCards.ruleType, ruleType))
      : eq(nbaCards.userId, userId);
    return db.select().from(nbaCards)
      .where(cond)
      .orderBy(desc(nbaCards.createdAt));
  }

  async getNbaCardByMarketSignalDedup(
    companyId: string,
    signalId: string,
    ruleType: string,
  ): Promise<NbaCard | undefined> {
    const rows = await db.select().from(nbaCards)
      .where(
        and(
          eq(nbaCards.companyId, companyId),
          eq(nbaCards.marketSignalId, signalId),
          eq(nbaCards.ruleType, ruleType),
          sql`${nbaCards.status} NOT IN ('dismissed', 'resolved', 'expired', 'superseded', 'actioned')`,
        )
      )
      .orderBy(desc(nbaCards.createdAt))
      .limit(1);
    return rows[0];
  }

  async dismissNbaCardsByMarketSignal(signalId: string): Promise<number> {
    const now = new Date().toISOString();
    const result = await db.update(nbaCards)
      .set({ status: "dismissed", dismissReason: "market_signal_resolved", resolvedAt: now } as any)
      .where(
        and(
          eq(nbaCards.marketSignalId, signalId),
          sql`${nbaCards.status} IN ('generated', 'visible')`,
        )
      );
    return result.rowCount ?? 0;
  }

  // ── Missed Inbound Calls (Task #317) ─────────────────────────────────────────

  async upsertMissedInboundCall(data: InsertMissedInboundCall): Promise<MissedInboundCall> {
    const [row] = await db.insert(missedInboundCalls)
      .values(data)
      .onConflictDoUpdate({
        target: [missedInboundCalls.orgId, missedInboundCalls.cdrId],
        set: {
          contactId: data.contactId ?? null,
          companyId: data.companyId ?? null,
          attributedUserId: data.attributedUserId ?? null,
          voicemailLeft: data.voicemailLeft ?? false,
          ringDurationSeconds: data.ringDurationSeconds ?? 0,
          afterHours: data.afterHours ?? false,
        } as any,
      })
      .returning();
    return row;
  }

  async getMissedInboundCallByCdr(orgId: string, cdrId: string): Promise<MissedInboundCall | undefined> {
    const [row] = await db.select().from(missedInboundCalls)
      .where(and(eq(missedInboundCalls.orgId, orgId), eq(missedInboundCalls.cdrId, cdrId)))
      .limit(1);
    return row;
  }

  async getMissedInboundCall(id: string): Promise<MissedInboundCall | undefined> {
    const [row] = await db.select().from(missedInboundCalls).where(eq(missedInboundCalls.id, id)).limit(1);
    return row;
  }

  async getMissedInboundCallsForOrg(orgId: string, sinceIso: string): Promise<MissedInboundCall[]> {
    return db.select().from(missedInboundCalls)
      .where(and(
        eq(missedInboundCalls.orgId, orgId),
        gte(missedInboundCalls.startTime, sinceIso),
      ))
      .orderBy(desc(missedInboundCalls.startTime));
  }

  async setMissedInboundCallback(id: string, nbaCardId: string): Promise<MissedInboundCall | undefined> {
    const now = new Date().toISOString();
    const [row] = await db.update(missedInboundCalls)
      .set({ nbaCardId, callbackCreatedAt: now } as any)
      .where(eq(missedInboundCalls.id, id))
      .returning();
    return row;
  }

  // ── Recurring lanes by company ────────────────────────────────────────────────

  async getRecurringLanesByCompany(companyId: string): Promise<RecurringLane[]> {
    return db.select().from(recurringLanes)
      .where(eq(recurringLanes.companyId, companyId))
      .orderBy(desc(recurringLanes.updatedAt));
  }

  // ── Forced Focus ─────────────────────────────────────────────────────────────

  async createForcedFocus(data: import('../shared/schema').InsertForcedFocus): Promise<import('../shared/schema').ForcedFocus> {
    const { forcedFocus } = await import('../shared/schema');
    await this.deactivateForcedFocusForUser(data.assignedToUserId);
    const [row] = await db.insert(forcedFocus).values(data).returning();
    return row;
  }

  async getActiveForcedFocusForUser(userId: string): Promise<import('../shared/schema').ForcedFocus | undefined> {
    const { forcedFocus } = await import('../shared/schema');
    const [row] = await db.select().from(forcedFocus)
      .where(and(eq(forcedFocus.assignedToUserId, userId), eq(forcedFocus.status, "active")))
      .orderBy(desc(forcedFocus.createdAt))
      .limit(1);
    return row;
  }

  async getTeamForcedFocus(orgId: string, teamMemberIds?: string[]): Promise<Array<import('../shared/schema').ForcedFocus & { assignedToName: string; assignedToRole: string }>> {
    const { forcedFocus } = await import('../shared/schema');
    if (teamMemberIds !== undefined && teamMemberIds.length === 0) {
      return [];
    }
    const orgCond = eq(forcedFocus.orgId, orgId);
    const statusCond = eq(forcedFocus.status, "active");
    const memberCond = teamMemberIds && teamMemberIds.length > 0
      ? inArray(forcedFocus.assignedToUserId, teamMemberIds)
      : undefined;
    const whereCond = memberCond ? and(orgCond, statusCond, memberCond) : and(orgCond, statusCond);
    const rows = await db
      .select({ ff: forcedFocus, assignedToName: users.name, assignedToRole: users.role })
      .from(forcedFocus)
      .innerJoin(users, eq(forcedFocus.assignedToUserId, users.id))
      .where(whereCond)
      .orderBy(desc(forcedFocus.createdAt));
    return rows.map(r => ({ ...r.ff, assignedToName: r.assignedToName, assignedToRole: r.assignedToRole }));
  }

  async deactivateForcedFocusForUser(userId: string): Promise<void> {
    const { forcedFocus } = await import('../shared/schema');
    await db.update(forcedFocus)
      .set({ status: "dismissed", updatedAt: new Date().toISOString() })
      .where(and(eq(forcedFocus.assignedToUserId, userId), eq(forcedFocus.status, "active")));
  }

  async getForcedFocus(id: string): Promise<import('../shared/schema').ForcedFocus | undefined> {
    const { forcedFocus } = await import('../shared/schema');
    const [row] = await db.select().from(forcedFocus).where(eq(forcedFocus.id, id));
    return row;
  }

  async updateForcedFocusStatus(id: string, status: string): Promise<import('../shared/schema').ForcedFocus | undefined> {
    const { forcedFocus } = await import('../shared/schema');
    const [row] = await db.update(forcedFocus)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(forcedFocus.id, id))
      .returning();
    return row;
  }

  async updateForcedFocus(id: string, data: Partial<import('../shared/schema').InsertForcedFocus>): Promise<import('../shared/schema').ForcedFocus | undefined> {
    const { forcedFocus } = await import('../shared/schema');
    const [row] = await db.update(forcedFocus)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(forcedFocus.id, id))
      .returning();
    return row;
  }

  // ── Lane Carrier Outreach v1 — Carrier Catalog ────────────────────────────

  async getCarriers(orgId: string): Promise<Carrier[]> {
    return db.select().from(carriers).where(eq(carriers.orgId, orgId)).orderBy(asc(carriers.name));
  }

  async getCarrier(id: string): Promise<Carrier | undefined> {
    const [row] = await db.select().from(carriers).where(eq(carriers.id, id));
    return row;
  }

  async getCarriersByIds(ids: string[], orgId: string): Promise<Carrier[]> {
    if (ids.length === 0) return [];
    return db.select().from(carriers).where(and(inArray(carriers.id, ids), eq(carriers.orgId, orgId)));
  }

  async getCarrierInOrg(id: string, orgId: string): Promise<Carrier | undefined> {
    const [row] = await db.select().from(carriers).where(and(eq(carriers.id, id), eq(carriers.orgId, orgId)));
    return row;
  }

  async createCarrier(data: InsertCarrier): Promise<Carrier> {
    const [row] = await db.insert(carriers).values(data).returning();
    return row;
  }

  async bulkCreateCarriers(data: InsertCarrier[]): Promise<number> {
    if (data.length === 0) return 0;
    const CHUNK = 500;
    let total = 0;
    for (let i = 0; i < data.length; i += CHUNK) {
      const chunk = data.slice(i, i + CHUNK);
      const result = await db.insert(carriers).values(chunk);
      total += result.rowCount ?? chunk.length;
    }
    return total;
  }

  async updateCarrier(id: string, orgId: string, data: Partial<Omit<InsertCarrier, 'orgId'>>): Promise<Carrier | undefined> {
    // Always enforce org constraint in WHERE to prevent cross-tenant updates
    const [row] = await db.update(carriers)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(carriers.id, id), eq(carriers.orgId, orgId)))
      .returning();
    return row;
  }

  async deleteCarrier(id: string, orgId: string): Promise<boolean> {
    const result = await db.delete(carriers).where(and(eq(carriers.id, id), eq(carriers.orgId, orgId)));
    return (result.rowCount ?? 0) > 0;
  }

  async bulkDeleteCarriers(ids: string[], orgId: string): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await db.delete(carriers).where(and(inArray(carriers.id, ids), eq(carriers.orgId, orgId)));
    return result.rowCount ?? 0;
  }

  async getCarrierByPayeeCode(orgId: string, payeeCode: string): Promise<Carrier | undefined> {
    const [row] = await db.select().from(carriers)
      .where(and(eq(carriers.orgId, orgId), eq(carriers.payeeCode, payeeCode)))
      .limit(1);
    return row;
  }

  async getCarrierByMcNumber(orgId: string, mcNumber: string): Promise<Carrier | undefined> {
    const normalized = mcNumber.trim().toUpperCase();
    const [row] = await db.select().from(carriers)
      .where(and(eq(carriers.orgId, orgId), sql`upper(trim(mc_dot)) = ${normalized}`))
      .limit(1);
    return row;
  }

  async getCarrierByNormalizedName(orgId: string, normalizedName: string): Promise<Carrier | undefined> {
    const upper = normalizedName.trim().toUpperCase().replace(/\s+/g, " ");
    const [row] = await db.select().from(carriers)
      .where(and(eq(carriers.orgId, orgId), sql`upper(regexp_replace(trim(name), '\\s+', ' ', 'g')) = ${upper}`))
      .limit(1);
    return row;
  }

  async upsertCarrierByMcDot(orgId: string, mcDot: string, data: Omit<InsertCarrier, 'orgId'>): Promise<Carrier> {
    const existing = await db.select().from(carriers)
      .where(and(eq(carriers.orgId, orgId), eq(carriers.mcDot, mcDot)))
      .limit(1);
    if (existing[0]) {
      const [row] = await db.update(carriers).set({ ...data, updatedAt: new Date() }).where(eq(carriers.id, existing[0].id)).returning();
      return row;
    }
    const [row] = await db.insert(carriers).values({ ...data, orgId }).returning();
    return row;
  }

  // ── Lane Carrier Outreach v2 — External Import + Sourcing ─────────────────

  /**
   * Strips common carrier name suffixes for fuzzy dedup matching.
   */
  private _normalizeCarrierName(name: string): string {
    return name
      .toUpperCase()
      .trim()
      .replace(/\b(LLC|INC|CORP|CORPORATION|LTD|CO|COMPANY|TRANSPORTATION|TRANSPORT|TRUCKING|LOGISTICS|FREIGHT|CARRIERS?|LINES?|EXPRESS|SERVICES?)\b/g, "")
      .replace(/[^A-Z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  async importCarriersForLane(
    orgId: string,
    laneId: string | null,
    userId: string,
    incomingCarriers: Array<{ name: string; email?: string; phone?: string; mcDot?: string }>,
    source: string,
    rawInput?: string
  ): Promise<{ batch: CarrierImportBatch; results: CarrierImportResult[] }> {
    const results: CarrierImportResult[] = [];
    let newCount = 0;
    let matchedCount = 0;

    // Pre-load all org carriers once for name-based dedup (avoid N queries)
    const allOrgCarriers = await db.select().from(carriers).where(eq(carriers.orgId, orgId));
    const normalizedNames = new Map<string, Carrier>();
    for (const c of allOrgCarriers) {
      const norm = this._normalizeCarrierName(c.name);
      if (norm) normalizedNames.set(norm, c);
    }

    for (const inc of incomingCarriers) {
      let matchedCarrier: Carrier | undefined;
      let matchType: CarrierImportResult["matchType"];

      // 1. Email exact match
      if (!matchedCarrier && inc.email) {
        const emailNorm = inc.email.trim().toLowerCase();
        const found = allOrgCarriers.find(
          c => c.primaryEmail?.trim().toLowerCase() === emailNorm || c.backupEmail?.trim().toLowerCase() === emailNorm
        );
        if (found) { matchedCarrier = found; matchType = "email_exact"; }
      }

      // 2. MC/DOT exact match
      if (!matchedCarrier && inc.mcDot) {
        const mcNorm = inc.mcDot.trim().toUpperCase().replace(/^MC[-\s]?/i, "");
        const found = allOrgCarriers.find(c => c.mcDot?.trim().toUpperCase().replace(/^MC[-\s]?/i, "") === mcNorm);
        if (found) { matchedCarrier = found; matchType = "mc_exact"; }
      }

      // 3. Normalized name fuzzy match
      if (!matchedCarrier) {
        const norm = this._normalizeCarrierName(inc.name);
        if (norm && normalizedNames.has(norm)) {
          matchedCarrier = normalizedNames.get(norm)!;
          matchType = "name_fuzzy";
        }
      }

      if (matchedCarrier) {
        // Update any new contact info on the matched carrier
        const updates: Partial<InsertCarrier> = {};
        if (inc.email && !matchedCarrier.primaryEmail) updates.primaryEmail = inc.email;
        if (inc.phone && !matchedCarrier.phone) updates.phone = inc.phone;
        if (Object.keys(updates).length > 0) {
          const [updated] = await db.update(carriers).set(updates).where(eq(carriers.id, matchedCarrier.id)).returning();
          matchedCarrier = updated;
          // Update in-memory list too
          const idx = allOrgCarriers.findIndex(c => c.id === matchedCarrier!.id);
          if (idx >= 0) allOrgCarriers[idx] = updated;
        }
        matchedCount++;
        results.push({ carrier: matchedCarrier, status: "matched", matchType, addedToBench: !!laneId });
      } else {
        // Create new carrier
        const [newCarrier] = await db.insert(carriers).values({
          orgId,
          name: inc.name.trim(),
          primaryEmail: inc.email?.trim() || null,
          phone: inc.phone?.trim() || null,
          mcDot: inc.mcDot?.trim() || null,
          sourceChannel: source,
          regions: [] as string[],
          equipmentTypes: [] as string[],
          tags: [] as string[],
        }).returning();
        allOrgCarriers.push(newCarrier);
        const norm = this._normalizeCarrierName(newCarrier.name);
        if (norm) normalizedNames.set(norm, newCarrier);
        newCount++;
        results.push({ carrier: newCarrier, status: "new", addedToBench: !!laneId });
      }
    }

    // Create batch record
    const [batch] = await db.insert(carrierImportBatches).values({
      orgId,
      laneId: laneId || null,
      source,
      createdBy: userId,
      carrierCount: incomingCarriers.length,
      newCount,
      matchedCount,
      rawInput: rawInput || null,
    }).returning();

    // Update importBatchId on newly created carriers
    const newCarrierIds = results.filter(r => r.status === "new").map(r => r.carrier.id);
    if (newCarrierIds.length > 0) {
      await db.update(carriers).set({ importBatchId: batch.id }).where(inArray(carriers.id, newCarrierIds));
    }

    // Upsert all imported carriers onto the lane bench (if lane context provided)
    if (laneId) {
      for (const result of results) {
        await db.insert(laneCarrierInterest).values({
          laneId,
          carrierId: result.carrier.id,
          carrierName: result.carrier.name,
          interestStatus: "needs_follow_up",
          sourceType: "manually_added",
          notes: `Imported via ${source}`,
        }).onConflictDoNothing();
      }
    }

    return { batch, results };
  }

  async getCarrierImportBatches(orgId: string, laneId?: string): Promise<CarrierImportBatch[]> {
    const conditions = [eq(carrierImportBatches.orgId, orgId)];
    if (laneId) conditions.push(eq(carrierImportBatches.laneId, laneId));
    return db.select().from(carrierImportBatches).where(and(...conditions)).orderBy(desc(carrierImportBatches.createdAt));
  }

  async getCarrierSourcingPerformance(orgId: string): Promise<CarrierSourcingChannel[]> {
    // Count carriers by source channel
    const channelRows = await pool.query<{ source_channel: string; cnt: string }>(
      `SELECT source_channel, COUNT(*)::int AS cnt FROM carriers WHERE org_id = $1 AND source_channel IS NOT NULL GROUP BY source_channel`,
      [orgId]
    );

    // For each channel's carriers, count how many have bench entries (outreached)
    // and how many bench entries have responded (available_now or available_next_week)
    const benchStats = await pool.query<{ source_channel: string; outreached: string; responded: string }>(
      `SELECT c.source_channel,
               COUNT(DISTINCT lci.carrier_id)::int AS outreached,
               COUNT(DISTINCT CASE WHEN lci.interest_status IN ('available_now','available_next_week') THEN lci.carrier_id END)::int AS responded
        FROM lane_carrier_interest lci
        JOIN carriers c ON c.id = lci.carrier_id
        WHERE c.org_id = $1 AND c.source_channel IS NOT NULL
        GROUP BY c.source_channel`,
      [orgId]
    );
    const benchMap = new Map<string, { outreached: number; responded: number }>();
    for (const row of benchStats.rows) {
      benchMap.set(row.source_channel, { outreached: Number(row.outreached), responded: Number(row.responded) });
    }

    const LABELS: Record<string, string> = {
      dat: "DAT",
      loadsmart: "Loadsmart",
      csv_paste: "Paste Import",
      manual: "Manual Entry",
      engine: "Engine Discovery",
      excel_seed: "Excel Seed",
      import_paste: "Paste Import",
      other: "Other",
    };

    return channelRows.rows.map(row => {
      const channel = row.source_channel;
      const bench = benchMap.get(channel) ?? { outreached: 0, responded: 0 };
      const carriersImported = Number(row.cnt);
      const rate = bench.outreached > 0 ? Math.round((bench.responded / bench.outreached) * 100) : 0;
      return {
        sourceChannel: channel,
        label: LABELS[channel] ?? channel,
        carriersImported,
        outreached: bench.outreached,
        responded: bench.responded,
        responseRate: rate,
      };
    });
  }

  // ── Lane Carrier Outreach v1 — Recurring Lanes ────────────────────────────

  async getRecurringLanes(orgId: string, userId?: string): Promise<RecurringLane[]> {
    const orgCond = eq(recurringLanes.orgId, orgId);
    const whereCond = userId
      ? and(orgCond, or(eq(recurringLanes.ownerUserId, userId), eq(recurringLanes.overseerUserId, userId)))
      : orgCond;
    return db.select().from(recurringLanes).where(whereCond).orderBy(desc(recurringLanes.laneScore));
  }

  async getRecurringLane(id: string): Promise<RecurringLane | undefined> {
    const [row] = await db.select().from(recurringLanes).where(eq(recurringLanes.id, id));
    return row;
  }

  async createRecurringLane(data: InsertRecurringLane): Promise<RecurringLane> {
    const [row] = await db.insert(recurringLanes).values(data).returning();
    return row;
  }

  async upsertRecurringLane(data: InsertRecurringLane & { orgId: string; origin: string; destination: string; equipmentType?: string | null; companyId?: string | null }): Promise<RecurringLane> {
    const baseCond = and(
      eq(recurringLanes.orgId, data.orgId),
      eq(recurringLanes.origin, data.origin),
      eq(recurringLanes.destination, data.destination),
      data.companyId ? eq(recurringLanes.companyId, data.companyId) : undefined,
      data.equipmentType ? eq(recurringLanes.equipmentType, data.equipmentType) : undefined,
    );
    const existing = await db.select().from(recurringLanes).where(baseCond).limit(1);
    if (existing[0]) {
      // Preserve operator-set fields — engine must not overwrite manual state changes
      const { hasPreferredCarrierProgram: _pcp, resolvedAt: _rat, snoozedUntil: _snu, ...engineUpdateData } = data;
      const [row] = await db.update(recurringLanes)
        .set({ ...engineUpdateData, updatedAt: new Date() })
        .where(eq(recurringLanes.id, existing[0].id))
        .returning();
      return row;
    }
    const [row] = await db.insert(recurringLanes).values(data).returning();
    return row;
  }

  async updateRecurringLane(id: string, data: Partial<InsertRecurringLane>): Promise<RecurringLane | undefined> {
    const [row] = await db.update(recurringLanes).set({ ...data, updatedAt: new Date() }).where(eq(recurringLanes.id, id)).returning();
    return row;
  }

  async deleteRecurringLane(id: string): Promise<boolean> {
    const result = await db.delete(recurringLanes).where(eq(recurringLanes.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async getEligibleRecurringLanes(orgId: string): Promise<RecurringLane[]> {
    const today = new Date().toISOString().split("T")[0];
    // Only return lanes the engine marked eligible in its most recent run.
    // isEligible=false means the lane fell out of the rolling 4-week criteria.
    return db.select().from(recurringLanes).where(
      and(
        eq(recurringLanes.orgId, orgId),
        eq(recurringLanes.isEligible, true),
        eq(recurringLanes.hasPreferredCarrierProgram, false),
        or(
          isNull(recurringLanes.snoozedUntil),
          sql`${recurringLanes.snoozedUntil} <= ${today}`,
        ),
      )
    ).orderBy(desc(recurringLanes.laneScore));
  }

  async retractIneligibleLanes(orgId: string, eligibleIds: string[]): Promise<void> {
    // Mark all lanes in this org that did NOT appear in the current engine run as ineligible.
    // This ensures stale lanes are excluded from NBA card generation and scoring.
    if (eligibleIds.length === 0) {
      // Nothing qualified — mark all org lanes ineligible
      await db.update(recurringLanes)
        .set({ isEligible: false })
        .where(eq(recurringLanes.orgId, orgId));
    } else {
      await db.update(recurringLanes)
        .set({ isEligible: false })
        .where(
          and(
            eq(recurringLanes.orgId, orgId),
            sql`${recurringLanes.id} NOT IN (${sql.join(eligibleIds.map(id => sql`${id}`), sql`, `)})`,
          )
        );
    }
  }

  // ── Lane Carrier Outreach v1 — Carrier Bench ──────────────────────────────

  async getLaneCarrierBench(laneId: string): Promise<LaneCarrierInterest[]> {
    return db.select().from(laneCarrierInterest).where(eq(laneCarrierInterest.laneId, laneId)).orderBy(desc(laneCarrierInterest.fitScore));
  }

  async getOrgWideBenchByLaneSignature(
    orgId: string,
    origin: string,
    originState: string | null,
    destination: string | null,
    destinationState: string | null,
    equipment: string | null,
  ): Promise<LaneCarrierInterest[]> {
    // Aggregate bench rows from any RecurringLane in the org whose
    // (origin, originState, destination, destinationState, equipment) match
    // the requested signature (case-insensitive). NULL state/equipment values
    // are normalized to '' on both sides so they compare equal.
    const norm = (s: string | null | undefined) => (s ?? "").toString().trim().toLowerCase();
    const conds: SQL[] = [
      eq(recurringLanes.orgId, orgId),
      sql`lower(trim(${recurringLanes.origin})) = ${norm(origin)}`,
      sql`coalesce(lower(trim(${recurringLanes.originState})), '') = ${norm(originState)}`,
      sql`lower(trim(${recurringLanes.destination})) = ${norm(destination)}`,
      sql`coalesce(lower(trim(${recurringLanes.destinationState})), '') = ${norm(destinationState)}`,
      sql`coalesce(lower(trim(${recurringLanes.equipmentType})), '') = ${norm(equipment)}`,
    ];
    const rows = await db
      .select({ b: laneCarrierInterest })
      .from(laneCarrierInterest)
      .innerJoin(recurringLanes, eq(recurringLanes.id, laneCarrierInterest.laneId))
      .where(and(...conds));
    return rows.map(r => r.b);
  }

  async getLaneCarrierInterestById(id: string): Promise<LaneCarrierInterest | undefined> {
    const [row] = await db.select().from(laneCarrierInterest).where(eq(laneCarrierInterest.id, id)).limit(1);
    return row;
  }

  async upsertLaneCarrierInterest(data: InsertLaneCarrierInterest): Promise<LaneCarrierInterest> {
    // Dedup strategy:
    // 1. When carrierId is set: look for existing id-keyed record first.
    //    If not found AND carrierName is provided, also look for a name-only record
    //    with the same carrierName and merge it (add carrierId) — this prevents the
    //    name-only → id-backed transition from creating a duplicate bench entry.
    // 2. When carrierId is null: look for existing name-only record.
    let existingId: string | undefined;
    if (data.carrierId) {
      const [byId] = await db.select({ id: laneCarrierInterest.id }).from(laneCarrierInterest)
        .where(and(eq(laneCarrierInterest.laneId, data.laneId), eq(laneCarrierInterest.carrierId, data.carrierId)))
        .limit(1);
      existingId = byId?.id;
      // Merge any pre-existing name-only entry for the same carrier into this record
      if (!existingId && data.carrierName) {
        const [byName] = await db.select({ id: laneCarrierInterest.id }).from(laneCarrierInterest)
          .where(and(
            eq(laneCarrierInterest.laneId, data.laneId),
            isNull(laneCarrierInterest.carrierId),
            eq(laneCarrierInterest.carrierName, data.carrierName),
          ))
          .limit(1);
        existingId = byName?.id;
      }
    } else if (data.carrierName) {
      const [existing] = await db.select({ id: laneCarrierInterest.id }).from(laneCarrierInterest)
        .where(and(
          eq(laneCarrierInterest.laneId, data.laneId),
          isNull(laneCarrierInterest.carrierId),
          eq(laneCarrierInterest.carrierName, data.carrierName),
        ))
        .limit(1);
      existingId = existing?.id;
    }
    if (existingId) {
      const [row] = await db.update(laneCarrierInterest).set({ ...data, updatedAt: new Date() }).where(eq(laneCarrierInterest.id, existingId)).returning();
      return row;
    }

    // INSERT — for null-carrierId rows the partial unique index may reject concurrent duplicates.
    // Catch PostgreSQL unique_violation (23505) and retry as update so concurrent requests
    // from the same user (e.g. double-click) merge cleanly instead of returning a 500.
    try {
      const [row] = await db.insert(laneCarrierInterest).values(data).returning();
      return row;
    } catch (insertErr: any) {
      if (insertErr?.code === "23505" && !data.carrierId && data.carrierName) {
        // Another request beat us to it — fetch the row it created and update instead
        const [existing] = await db.select({ id: laneCarrierInterest.id })
          .from(laneCarrierInterest)
          .where(and(
            eq(laneCarrierInterest.laneId, data.laneId),
            isNull(laneCarrierInterest.carrierId),
            eq(laneCarrierInterest.carrierName, data.carrierName),
          ))
          .limit(1);
        if (existing) {
          const [row] = await db.update(laneCarrierInterest)
            .set({ ...data, updatedAt: new Date() })
            .where(eq(laneCarrierInterest.id, existing.id))
            .returning();
          return row;
        }
      }
      throw insertErr;
    }
  }

  async updateLaneCarrierInterest(id: string, data: Partial<InsertLaneCarrierInterest>): Promise<LaneCarrierInterest | undefined> {
    const [row] = await db.update(laneCarrierInterest).set({ ...data, updatedAt: new Date() }).where(eq(laneCarrierInterest.id, id)).returning();
    return row;
  }

  // ── Lane Carrier Outreach v1 — Outreach Logs ──────────────────────────────

  async createCarrierOutreachLog(data: InsertCarrierOutreachLog): Promise<CarrierOutreachLog> {
    const [row] = await db.insert(carrierOutreachLogs).values(data).returning();
    return row;
  }

  async getCarrierOutreachLogs(laneId: string): Promise<CarrierOutreachLog[]> {
    return db.select().from(carrierOutreachLogs).where(eq(carrierOutreachLogs.laneId, laneId)).orderBy(desc(carrierOutreachLogs.timestamp));
  }

  async updateCarrierOutreachLog(id: string, fields: Partial<InsertCarrierOutreachLog>): Promise<CarrierOutreachLog> {
    const [row] = await db.update(carrierOutreachLogs).set(fields).where(eq(carrierOutreachLogs.id, id)).returning();
    // Task #637 — when an external open-tracking signal flips delivery_status
    // to 'opened' and we have a matched carrier + recurring lane on the row,
    // bump the open counter for (org, carrier, laneSig). Idempotent via
    // eventKey so duplicate webhook deliveries collapse.
    if (
      row
      && fields.deliveryStatus === "opened"
      && row.matchedCarrierId
      && row.matchedLaneId
    ) {
      try {
        const [lane] = await db.select().from(recurringLanes)
          .where(eq(recurringLanes.id, row.matchedLaneId)).limit(1);
        if (lane) {
          const { recordCarrierLaneOutcome } = await import("./services/carrierLaneOutcomes");
          await recordCarrierLaneOutcome({
            orgId: row.orgId,
            carrierId: row.matchedCarrierId,
            origin: lane.origin,
            originState: lane.originState,
            destination: lane.destination,
            destinationState: lane.destinationState,
            equipmentType: lane.equipmentType,
            event: "open",
            eventKey: `outreach-log:${row.id}:open`,
          });
        }
      } catch (err) {
        console.warn("[carrier-lane-outcomes] open wiring failed (non-fatal):", err instanceof Error ? err.message : err);
      }
    }
    return row;
  }

  async getCarrierOutreachLogByThreadId(threadId: string): Promise<CarrierOutreachLog | undefined> {
    // First try the fast path: threadId column (stores the primary/first recipient's ID)
    const [byColumn] = await db.select().from(carrierOutreachLogs)
      .where(eq(carrierOutreachLogs.threadId, threadId));
    if (byColumn) return byColumn;

    // Fallback: search the recipients JSONB array for any recipient whose
    // internetMessageId matches (covers multi-carrier batch outreach logs).
    // Uses a raw SQL jsonb operator for efficiency; safe because threadId is
    // sanitized by the caller (stripped of angle brackets).
    const [byRecipient] = await db.select().from(carrierOutreachLogs)
      .where(sql`recipients @> ${JSON.stringify([{ internetMessageId: threadId }])}::jsonb`)
      .limit(1);
    return byRecipient;
  }

  async getCarrierOutreachLogsByOrgAndThreadIds(orgId: string, threadIds: string[]): Promise<CarrierOutreachLog[]> {
    if (threadIds.length === 0) return [];
    // Build a filter that matches any record where:
    //   1) threadId column is one of the candidate IDs, OR
    //   2) recipients JSONB contains a recipient with a matching internetMessageId
    const conditions = threadIds.map(tid =>
      or(
        eq(carrierOutreachLogs.threadId, tid),
        sql`recipients @> ${JSON.stringify([{ internetMessageId: tid }])}::jsonb`
      )
    );
    return db.select().from(carrierOutreachLogs)
      .where(and(eq(carrierOutreachLogs.orgId, orgId), or(...conditions)));
  }

  async getCarrierOutreachLogsByProcurementTaskId(orgId: string, procurementTaskId: string): Promise<CarrierOutreachLog[]> {
    return db.select().from(carrierOutreachLogs)
      .where(
        and(
          eq(carrierOutreachLogs.orgId, orgId),
          eq(carrierOutreachLogs.procurementTaskId, procurementTaskId),
        )
      )
      .orderBy(desc(carrierOutreachLogs.timestamp));
  }

  async getCarrierOutreachLogBySubjectFallback(orgId: string, normalizedSubject: string): Promise<CarrierOutreachLog | undefined> {
    // Search recent outreach logs (last 30 days, unmatched) for a draft whose subject
    // matches when lower-cased. Scoped to the org to prevent cross-tenant mis-association.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await db.select().from(carrierOutreachLogs)
      .where(
        and(
          eq(carrierOutreachLogs.orgId, orgId),
          isNull(carrierOutreachLogs.replyReceivedAt),
          gte(carrierOutreachLogs.timestamp, cutoff),
          isNotNull(carrierOutreachLogs.sentAt),
        )
      )
      .orderBy(desc(carrierOutreachLogs.timestamp))
      .limit(200);

    for (const row of rows) {
      const drafts = Array.isArray(row.emailDrafts) ? row.emailDrafts as Array<{ subject?: string }> : [];
      const matched = drafts.some(d =>
        typeof d.subject === "string" &&
        d.subject.replace(/^(Re:\s*)+/i, "").trim().toLowerCase() === normalizedSubject
      );
      if (matched) return row;
    }
    return undefined;
  }

  async recordOutreachReply(logId: string, replySnippet: string, replyReceivedAt: Date): Promise<CarrierOutreachLog> {
    // Guard is idempotent: only write if replyReceivedAt is still null.
    // This prevents double-writes when Graph delivers the same notification
    // more than once (e.g. transient retry) or when two concurrent webhook
    // deliveries race for the same message.
    const [row] = await db.update(carrierOutreachLogs)
      .set({ replyReceivedAt, replySnippet })
      .where(and(eq(carrierOutreachLogs.id, logId), isNull(carrierOutreachLogs.replyReceivedAt)))
      .returning();
    // If row is undefined the reply was already recorded; fetch the current state
    if (row) return row;
    const [existing] = await db.select().from(carrierOutreachLogs)
      .where(eq(carrierOutreachLogs.id, logId));
    return existing;
  }

  // ── Lane Carrier Outreach v1 — Feature Flags ──────────────────────────────

  async getFeatureFlag(orgId: string, flagKey: string): Promise<boolean> {
    const [row] = await db.select().from(featureFlags)
      .where(and(eq(featureFlags.orgId, orgId), eq(featureFlags.flagKey, flagKey)));
    return row?.enabled ?? false;
  }

  async setFeatureFlag(orgId: string, flagKey: string, enabled: boolean, updatedById?: string): Promise<void> {
    await db.insert(featureFlags)
      .values({ orgId, flagKey, enabled, updatedById: updatedById ?? null })
      .onConflictDoUpdate({
        target: [featureFlags.orgId, featureFlags.flagKey],
        set: { enabled, updatedAt: new Date(), updatedById: updatedById ?? null },
      });
  }

  async getSidebarTooltips(orgId: string): Promise<SidebarTooltip[]> {
    return db.select().from(sidebarTooltips).where(eq(sidebarTooltips.orgId, orgId));
  }

  async upsertSidebarTooltip(orgId: string, itemKey: string, description: string, updatedById: string): Promise<SidebarTooltip> {
    const [row] = await db.insert(sidebarTooltips)
      .values({ orgId, itemKey, description, updatedById })
      .onConflictDoUpdate({
        target: [sidebarTooltips.orgId, sidebarTooltips.itemKey],
        set: { description, updatedAt: new Date(), updatedById },
      })
      .returning();
    return row;
  }

  async deleteSidebarTooltip(orgId: string, itemKey: string): Promise<void> {
    await db.delete(sidebarTooltips)
      .where(and(eq(sidebarTooltips.orgId, orgId), eq(sidebarTooltips.itemKey, itemKey)));
  }

  async getEmailLiveModeAcrossOrgs(): Promise<boolean> {
    const rows = await db.select().from(featureFlags)
      .where(eq(featureFlags.flagKey, "email_live_mode"));
    return rows.some(r => r.enabled);
  }

  // ── Lane Carrier Outreach v1.5 — Assignment + Work Queue ──────────────────

  async assignLaneOwner(laneId: string, orgId: string, ownerUserId: string | null, assignedByUserId: string): Promise<RecurringLane | undefined> {
    const [row] = await db.update(recurringLanes)
      .set({
        ownerUserId,
        assignedAt: new Date().toISOString(),
        assignedByUserId,
        updatedAt: new Date(),
      })
      .where(and(eq(recurringLanes.id, laneId), eq(recurringLanes.orgId, orgId)))
      .returning();
    return row;
  }

  async resolveVisibleUserIds(requestingUserId: string, orgId: string, role: string): Promise<{
    visibleUserIds: string[];
    canSeeUnassigned: boolean;
    scopeLabel: string;
  }> {
    if (role === "admin") {
      const allOrgUsers = await db.select({ id: users.id }).from(users).where(eq(users.organizationId, orgId));
      return {
        visibleUserIds: allOrgUsers.map(u => u.id),
        canSeeUnassigned: true,
        scopeLabel: "All org lanes",
      };
    }
    if (role === "director") {
      const teamIds = await this.getTeamMemberIds(requestingUserId, orgId);
      return {
        visibleUserIds: teamIds,
        canSeeUnassigned: true,
        scopeLabel: "Team hierarchy",
      };
    }
    if (role === "national_account_manager" || role === "logistics_manager") {
      const teamIds = await this.getTeamMemberIds(requestingUserId, orgId);
      return {
        visibleUserIds: teamIds,
        canSeeUnassigned: false,
        scopeLabel: "My team lanes",
      };
    }
    // AM / LM / sales and any other role: self only
    return {
      visibleUserIds: [requestingUserId],
      canSeeUnassigned: false,
      scopeLabel: "My lanes",
    };
  }

  async getUnactionedHotReplyCount(orgId: string, visibleUserIds: string[], canSeeUnassigned: boolean): Promise<number> {
    const today = new Date().toISOString().split("T")[0];
    const visibleSet = new Set(visibleUserIds);
    const allLanes = await db.select({ id: recurringLanes.id, ownerUserId: recurringLanes.ownerUserId })
      .from(recurringLanes)
      .where(and(
        eq(recurringLanes.orgId, orgId),
        eq(recurringLanes.isEligible, true),
        isNull(recurringLanes.resolvedAt),
        or(isNull(recurringLanes.snoozedUntil), sql`${recurringLanes.snoozedUntil} <= ${today}`),
      ));
    const visibleLaneIds = allLanes
      .filter(l => l.ownerUserId ? visibleSet.has(l.ownerUserId) : canSeeUnassigned)
      .map(l => l.id);
    if (visibleLaneIds.length === 0) return 0;
    // Lanes with at least one hot-status carrier reply
    const hotStatuses = ["available_now", "available_next_week"];
    const hotRows = await db.selectDistinct({ laneId: laneCarrierInterest.laneId })
      .from(laneCarrierInterest)
      .where(and(
        inArray(laneCarrierInterest.laneId, visibleLaneIds),
        inArray(laneCarrierInterest.interestStatus, hotStatuses),
      ));
    if (hotRows.length === 0) return 0;
    const hotLaneIds = hotRows.map(r => r.laneId);
    // Subtract lanes that already have an OPEN follow-up task (work is already owned).
    // A lane is "unactioned" only when a hot reply exists AND no one has taken ownership
    // by creating a follow-up task for it. Once a task is created (even open), the lane
    // no longer counts toward the unactioned badge — the rep has acknowledged it.
    const actionedResult = await this.pool.query<{ lane_id: string }>(
      `SELECT DISTINCT (lane_context->>'laneId')::text AS lane_id
         FROM tasks
        WHERE org_id = $1
          AND status != 'closed'
          AND lane_context->>'type' = 'carrier_reply_follow_up'
          AND (lane_context->>'laneId') = ANY($2::text[])`,
      [orgId, hotLaneIds]
    );
    const actionedLaneIds = new Set(actionedResult.rows.map(r => r.lane_id));
    return hotLaneIds.filter(id => !actionedLaneIds.has(id)).length;
  }

  async getLaneWorkQueue(orgId: string, completionThreshold: number, visibleUserIds: string[], canSeeUnassigned: boolean): Promise<LaneWorkQueueResult> {
    // Fetch all eligible, non-snoozed, non-preferred lanes for the org
    const today = new Date().toISOString().split("T")[0];
    const eligibleLanesAll = await db.select().from(recurringLanes).where(
      and(
        eq(recurringLanes.orgId, orgId),
        eq(recurringLanes.isEligible, true),
        eq(recurringLanes.hasPreferredCarrierProgram, false),
        or(isNull(recurringLanes.snoozedUntil), sql`${recurringLanes.snoozedUntil} <= ${today}`),
        isNull(recurringLanes.resolvedAt),
      )
    ).orderBy(desc(recurringLanes.laneScore));

    // Hierarchy scoping is applied per-lane in the main loop below using
    // visibleUserIds and canSeeUnassigned. No pre-filtering needed here.
    const eligibleLanes = eligibleLanesAll;

    if (eligibleLanes.length === 0) {
      return { unassigned: [], noContactable: [], assignedUntouched: [], inProgress: [] };
    }

    // Load all users for name resolution
    const allUsers = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.organizationId, orgId));
    const userNameMap = new Map(allUsers.map(u => [u.id, u.name]));

    // Load all bench entries for these lanes in one query
    const laneIds = eligibleLanes.map(l => l.id);
    const allBenchEntries = await db.select().from(laneCarrierInterest)
      .where(inArray(laneCarrierInterest.laneId, laneIds));

    // Load all carriers for this org to check contactability
    const allCarriersForOrg = await db.select({
      id: carriers.id,
      primaryEmail: carriers.primaryEmail,
      phone: carriers.phone,
    }).from(carriers).where(eq(carriers.orgId, orgId));
    const carrierContactMap = new Map(allCarriersForOrg.map(c => [c.id, { hasContact: !!(c.primaryEmail || c.phone) }]));

    // Group bench entries by laneId
    const benchByLane = new Map<string, typeof allBenchEntries>();
    for (const entry of allBenchEntries) {
      if (!benchByLane.has(entry.laneId)) benchByLane.set(entry.laneId, []);
      benchByLane.get(entry.laneId)!.push(entry);
    }

    // Load open follow-up tasks for all lanes in one query — used to compute needsAction
    const openFollowUpResult = await this.pool.query<{ lane_id: string }>(
      `SELECT DISTINCT (lane_context->>'laneId')::text AS lane_id
         FROM tasks
        WHERE org_id = $1
          AND status != 'closed'
          AND lane_context->>'type' = 'carrier_reply_follow_up'
          AND (lane_context->>'laneId') = ANY($2::text[])`,
      [orgId, laneIds]
    );
    const lanesWithOpenTask = new Set(openFollowUpResult.rows.map(r => r.lane_id));

    const visibleSet = new Set(visibleUserIds);
    const result: LaneWorkQueueResult = { unassigned: [], noContactable: [], assignedUntouched: [], inProgress: [] };

    for (const lane of eligibleLanes) {
      // Hierarchy-scoped visibility:
      // - Unassigned lanes: only shown when canSeeUnassigned is true (admin + director)
      // - Assigned lanes: only shown if the owner is in the requesting user's visible set
      if (!lane.ownerUserId) {
        if (!canSeeUnassigned) continue;
      } else {
        if (!visibleSet.has(lane.ownerUserId)) continue;
      }

      const bench = benchByLane.get(lane.id) ?? [];
      const historicalBench = bench.filter(b => b.sourceType === "historical");
      const contactableCount = bench.filter(b => b.carrierId && carrierContactMap.get(b.carrierId)?.hasContact).length;
      const missingContactCount = historicalBench.filter(b => !b.carrierId || !carrierContactMap.get(b.carrierId)?.hasContact).length;

      // Compute reply summary from bench entries
      const HOT_STATUSES = new Set(["available_now", "available_next_week"]);
      const STATUS_PRIORITY: Record<string, number> = { available_now: 4, available_next_week: 3, future_interest: 2, not_fit: 1 };
      const replied = bench.filter(b => b.interestStatus !== "needs_follow_up");
      let topEntry: (typeof bench)[0] | null = null;
      let topPriority = -1;
      for (const b of replied) {
        const p = STATUS_PRIORITY[b.interestStatus] ?? 0;
        if (p > topPriority) { topPriority = p; topEntry = b; }
      }
      const hotCount = replied.filter(b => HOT_STATUSES.has(b.interestStatus)).length;
      const replySummary: LaneReplySummary = {
        totalReplied: replied.length,
        hotCount,
        topStatus: topEntry?.interestStatus ?? null,
        topCarrierName: topEntry?.carrierName ?? null,
        needsAction: hotCount > 0 && !lanesWithOpenTask.has(lane.id),
      };

      const item: LaneWorkQueueItem = {
        lane: { ...lane, ownerName: lane.ownerUserId ? (userNameMap.get(lane.ownerUserId) ?? null) : null },
        contactableCount,
        totalBenchCount: bench.length,
        historicalCount: historicalBench.length,
        missingContactCount,
        replySummary,
      };

      const contacted = lane.carriersContactedCount ?? 0;

      if (!lane.ownerUserId) {
        result.unassigned.push(item);
      } else if (contactableCount === 0) {
        result.noContactable.push(item);
      } else if (contacted === 0) {
        result.assignedUntouched.push(item);
      } else {
        // inProgress: 1+ contacted but below threshold
        // Also catches edge case where contacted >= threshold but resolvedAt not yet set
        result.inProgress.push(item);
      }
    }

    return result;
  }

  // ── Lane Summary Cache ─────────────────────────────────────────────────────

  /**
   * Read the work queue from lane_summary_cache (pre-computed by scoreAllEligibleLanes).
   * Returns null when the cache is empty (scoring job has never run for this org),
   * so callers can fall back to getLaneWorkQueue().
   *
   * NO replySummary in the returned items — that is loaded lazily via the detail endpoint.
   */
  async getBenchCountsForLanes(orgId: string, laneIds: string[]): Promise<Map<string, { contactableCount: number; totalBenchCount: number; historicalCount: number; missingContactCount: number }>> {
    if (laneIds.length === 0) return new Map();

    const result = await this.pool.query<{
      lane_id: string;
      carrier_id: string | null;
      source_type: string;
      has_contact: boolean;
    }>(
      `SELECT
         lci.lane_id,
         lci.carrier_id,
         lci.source_type,
         (c.primary_email IS NOT NULL OR c.phone IS NOT NULL) AS has_contact
       FROM lane_carrier_interest lci
       LEFT JOIN carriers c ON c.id = lci.carrier_id AND c.org_id = $1
       WHERE lci.lane_id = ANY($2::text[])`,
      [orgId, laneIds]
    );

    const counts = new Map<string, { contactableCount: number; totalBenchCount: number; historicalCount: number; missingContactCount: number }>();
    for (const laneId of laneIds) {
      counts.set(laneId, { contactableCount: 0, totalBenchCount: 0, historicalCount: 0, missingContactCount: 0 });
    }
    for (const row of result.rows) {
      const c = counts.get(row.lane_id);
      if (!c) continue;
      c.totalBenchCount++;
      if (row.has_contact) c.contactableCount++;
      if (row.source_type === "historical") {
        c.historicalCount++;
        if (!row.has_contact) c.missingContactCount++;
      }
    }
    return counts;
  }

  async getLaneWorkQueueFromCache(orgId: string, visibleUserIds: string[], canSeeUnassigned: boolean): Promise<LeanLaneWorkQueueResult | null> {
    const today = new Date().toISOString().split("T")[0];

    const cacheRows = await this.pool.query<{
      lane_id: string;
      lane_score: number | null;
      origin: string;
      origin_state: string | null;
      destination: string;
      destination_state: string | null;
      equipment_type: string | null;
      avg_loads_per_week: string | null;
      company_id: string | null;
      company_name: string | null;
      owner_user_id: string | null;
      owner_name: string | null;
      carriers_contacted_count: number;
      contactable_count: number;
      total_bench_count: number;
      historical_count: number;
      missing_contact_count: number;
      snoozed_until: string | null;
      drop_trailer_shipper: boolean;
      drop_trailer_receiver: boolean;
      is_manual: boolean;
    }>(
      `SELECT
         c.lane_id,
         c.lane_score,
         c.origin,
         c.origin_state,
         c.destination,
         c.destination_state,
         c.equipment_type,
         c.avg_loads_per_week::text,
         c.company_id,
         c.company_name,
         c.owner_user_id,
         COALESCE(u.name, c.owner_name) AS owner_name,
         COALESCE(c.carriers_contacted_count, 0) AS carriers_contacted_count,
         COALESCE(c.contactable_count, 0)         AS contactable_count,
         COALESCE(c.total_bench_count, 0)         AS total_bench_count,
         COALESCE(c.historical_count, 0)          AS historical_count,
         COALESCE(c.missing_contact_count, 0)     AS missing_contact_count,
         c.snoozed_until,
         COALESCE(c.drop_trailer_shipper, false)  AS drop_trailer_shipper,
         COALESCE(c.drop_trailer_receiver, false)  AS drop_trailer_receiver,
         COALESCE(c.is_manual, false)             AS is_manual
       FROM lane_summary_cache c
       LEFT JOIN users u ON u.id = c.owner_user_id
       WHERE c.org_id = $1
         AND c.resolved_at IS NULL
         AND c.is_eligible = true
         AND c.has_preferred_carrier_program = false
         AND (c.snoozed_until IS NULL OR c.snoozed_until <= $2)
       ORDER BY c.lane_score DESC NULLS LAST, c.lane_id`,
      [orgId, today]
    );

    // Return null (fall back to full query) if the cache is empty for this org
    if (cacheRows.rows.length === 0) return null;

    const visibleSet = new Set(visibleUserIds);
    const result: LeanLaneWorkQueueResult = { unassigned: [], noContactable: [], assignedUntouched: [], inProgress: [] };

    for (const r of cacheRows.rows) {
      // Hierarchy visibility: unassigned lanes only for admin/directors; assigned only if owner in scope
      if (!r.owner_user_id) {
        if (!canSeeUnassigned) continue;
      } else {
        if (!visibleSet.has(r.owner_user_id)) continue;
      }

      const item: LeanLaneQueueItem = {
        laneId: r.lane_id,
        laneScore: r.lane_score,
        origin: r.origin,
        originState: r.origin_state,
        destination: r.destination,
        destinationState: r.destination_state,
        equipmentType: r.equipment_type,
        avgLoadsPerWeek: r.avg_loads_per_week,
        companyId: r.company_id,
        companyName: r.company_name,
        ownerUserId: r.owner_user_id,
        ownerName: r.owner_name,
        carriersContactedCount: r.carriers_contacted_count,
        contactableCount: r.contactable_count,
        totalBenchCount: r.total_bench_count,
        historicalCount: r.historical_count,
        missingContactCount: r.missing_contact_count,
        dropTrailerShipper: r.drop_trailer_shipper ?? false,
        dropTrailerReceiver: r.drop_trailer_receiver ?? false,
        isManual: r.is_manual ?? false,
      };

      const contacted = r.carriers_contacted_count ?? 0;
      if (!r.owner_user_id) {
        result.unassigned.push(item);
      } else if (r.contactable_count === 0) {
        result.noContactable.push(item);
      } else if (contacted === 0) {
        result.assignedUntouched.push(item);
      } else {
        result.inProgress.push(item);
      }
    }

    return result;
  }

  async upsertLaneSummaryCache(data: InsertLaneSummaryCache): Promise<LaneSummaryCache> {
    const [row] = await db
      .insert(laneSummaryCache)
      .values({ ...data, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: laneSummaryCache.laneId,
        set: {
          laneScore: data.laneScore,
          priority: data.priority ?? 0,
          origin: data.origin,
          originState: data.originState,
          destination: data.destination,
          destinationState: data.destinationState,
          equipmentType: data.equipmentType,
          avgLoadsPerWeek: data.avgLoadsPerWeek,
          companyId: data.companyId,
          companyName: data.companyName,
          ownerUserId: data.ownerUserId,
          ...(data.ownerName !== undefined ? { ownerName: data.ownerName } : {}),
          carriersContactedCount: data.carriersContactedCount ?? 0,
          contactableCount: data.contactableCount ?? 0,
          totalBenchCount: data.totalBenchCount ?? 0,
          historicalCount: data.historicalCount ?? 0,
          missingContactCount: data.missingContactCount ?? 0,
          orgId: data.orgId ?? null,
          isEligible: data.isEligible ?? true,
          hasPreferredCarrierProgram: data.hasPreferredCarrierProgram ?? false,
          snoozedUntil: data.snoozedUntil ?? null,
          resolvedAt: data.resolvedAt,
          dropTrailerShipper: data.dropTrailerShipper ?? false,
          dropTrailerReceiver: data.dropTrailerReceiver ?? false,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async patchLaneSummaryCache(laneId: string, patch: Partial<InsertLaneSummaryCache>): Promise<void> {
    await db
      .update(laneSummaryCache)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(laneSummaryCache.laneId, laneId));
  }

  // ── Lane Coverage Profiles ─────────────────────────────────────────────────

  async getLaneCoverageProfile(orgId: string, laneKey: string): Promise<LaneCoverageProfile | undefined> {
    const [row] = await db.select().from(laneCoverageProfiles)
      .where(and(eq(laneCoverageProfiles.orgId, orgId), eq(laneCoverageProfiles.laneKey, laneKey)));
    return row;
  }

  async getLaneCoverageProfileById(id: string): Promise<LaneCoverageProfile | undefined> {
    const [row] = await db.select().from(laneCoverageProfiles).where(eq(laneCoverageProfiles.id, id));
    return row;
  }

  async getLaneCoverageProfileByLaneId(laneId: string): Promise<LaneCoverageProfile | undefined> {
    const [row] = await db.select().from(laneCoverageProfiles)
      .where(eq(laneCoverageProfiles.laneId, laneId));
    return row;
  }

  async upsertLaneCoverageProfile(data: InsertLaneCoverageProfile): Promise<LaneCoverageProfile> {
    const now = new Date().toISOString();
    const [row] = await db.insert(laneCoverageProfiles)
      .values({ ...data, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [laneCoverageProfiles.orgId, laneCoverageProfiles.laneKey],
        set: {
          laneId: data.laneId,
          coverageStatus: data.coverageStatus,
          sampleSize: data.sampleSize,
          qualifiedCarrierCount: data.qualifiedCarrierCount,
          topCarrierCoverageShare: data.topCarrierCoverageShare,
          computedAt: data.computedAt,
          manualOverrideStatus: data.manualOverrideStatus,
          manualOverrideReason: data.manualOverrideReason,
          manuallyConfirmedByUserId: data.manuallyConfirmedByUserId,
          manuallyConfirmedAt: data.manuallyConfirmedAt,
          broadenSearchActive: data.broadenSearchActive,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async updateLaneCoverageProfile(id: string, data: Partial<InsertLaneCoverageProfile>): Promise<LaneCoverageProfile | undefined> {
    const [row] = await db.update(laneCoverageProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(laneCoverageProfiles.id, id))
      .returning();
    return row;
  }

  async getLaneCoverageProfileCarriers(profileId: string): Promise<LaneCoverageProfileCarrier[]> {
    return db.select().from(laneCoverageProfileCarriers)
      .where(eq(laneCoverageProfileCarriers.profileId, profileId))
      .orderBy(asc(laneCoverageProfileCarriers.incumbentRank));
  }

  async upsertLaneCoverageProfileCarrier(data: InsertLaneCoverageProfileCarrier): Promise<LaneCoverageProfileCarrier> {
    const [row] = await db.insert(laneCoverageProfileCarriers)
      .values({ ...data, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [laneCoverageProfileCarriers.profileId, laneCoverageProfileCarriers.carrierName],
        set: {
          carrierId: data.carrierId,
          incumbentRank: data.incumbentRank,
          successfulLoadCount: data.successfulLoadCount,
          recentLoadCount: data.recentLoadCount,
          coverageShare: data.coverageShare,
          lastUsedAt: data.lastUsedAt,
          lastSuccessAt: data.lastSuccessAt,
          isCurrentPrimary: data.isCurrentPrimary,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async deleteLaneCoverageProfileCarriers(profileId: string): Promise<void> {
    await db.delete(laneCoverageProfileCarriers).where(eq(laneCoverageProfileCarriers.profileId, profileId));
  }

  // ── Two-way email foundation — Task #183 ─────────────────────────────────

  async getCarrierOutreachLogByProviderMessageId(providerMessageId: string): Promise<CarrierOutreachLog | undefined> {
    const [row] = await db.select().from(carrierOutreachLogs)
      .where(eq(carrierOutreachLogs.providerMessageId, providerMessageId));
    return row;
  }

  async getCarrierOutreachLogByConversationId(conversationId: string, orgId: string): Promise<CarrierOutreachLog | undefined> {
    const [row] = await db.select().from(carrierOutreachLogs)
      .where(
        and(
          eq(carrierOutreachLogs.conversationId, conversationId),
          eq(carrierOutreachLogs.orgId, orgId),
          eq(carrierOutreachLogs.direction, "outbound")
        )
      )
      .orderBy(desc(carrierOutreachLogs.timestamp))
      .limit(1);
    return row;
  }

  async getCarriersByPrimaryEmail(email: string, orgId: string): Promise<Carrier[]> {
    return db.select().from(carriers)
      .where(and(eq(carriers.orgId, orgId), ilike(carriers.primaryEmail, email)));
  }

  async getCarrierContactByEmail(email: string, orgId: string): Promise<CarrierContact | undefined> {
    const results = await db.select({
      id: carrierContacts.id,
      carrierId: carrierContacts.carrierId,
      name: carrierContacts.name,
      role: carrierContacts.role,
      email: carrierContacts.email,
      phone: carrierContacts.phone,
      extension: carrierContacts.extension,
      preferredMethod: carrierContacts.preferredMethod,
      notes: carrierContacts.notes,
      isPrimary: carrierContacts.isPrimary,
      isActive: carrierContacts.isActive,
      createdAt: carrierContacts.createdAt,
      updatedAt: carrierContacts.updatedAt,
    })
      .from(carrierContacts)
      .innerJoin(carriers, eq(carrierContacts.carrierId, carriers.id))
      .where(
        and(
          eq(carriers.orgId, orgId),
          ilike(carrierContacts.email, email),
          eq(carrierContacts.isActive, true)
        )
      )
      .limit(1);
    return results[0];
  }

  async getContactByEmailInOrg(email: string, orgId: string): Promise<{ contactId: string; companyId: string; contactName: string } | null> {
    const normalized = email.trim().toLowerCase();
    const rows = await db.select({
      contactId: contacts.id,
      companyId: contacts.companyId,
      contactName: contacts.name,
    })
      .from(contacts)
      .innerJoin(companies, eq(contacts.companyId, companies.id))
      .where(
        and(
          eq(companies.organizationId, orgId),
          ilike(contacts.email, normalized)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getFirstOrg(): Promise<{ id: string; name: string } | undefined> {
    const [row] = await db.select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .orderBy(asc(organizations.createdAt))
      .limit(1);
    return row;
  }

  async getFirstOrgAdmin(orgId: string): Promise<{ id: string } | undefined> {
    const [row] = await db.select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, orgId)))
      .orderBy(asc(users.createdAt))
      .limit(1);
    return row;
  }

  async getOrgByOutlookMailbox(_mailbox: string): Promise<{ id: string } | undefined> {
    // In the current schema there is no explicit outlook_mailbox field on organizations.
    // This is a hook for future multi-tenant subscription routing.
    // For now we return undefined so the caller falls back to getFirstOrg().
    return undefined;
  }

  // ── Market Signal Intelligence Layer (Task #185) ───────────────────────────

  async insertMarketEvent(data: InsertMarketEvent): Promise<MarketEvent> {
    const [row] = await db.insert(marketEvents).values(data).returning();
    return row;
  }

  async getMarketEventsSince(
    since: Date,
    scope?: { scopeType?: string; scopeKey?: string },
  ): Promise<MarketEvent[]> {
    const conditions: SQL[] = [gte(marketEvents.occurredAt, since)];
    if (scope?.scopeType) conditions.push(eq(marketEvents.scopeType, scope.scopeType));
    if (scope?.scopeKey) conditions.push(eq(marketEvents.scopeKey, scope.scopeKey));
    return db.select().from(marketEvents).where(and(...conditions));
  }

  async upsertMarketSignal(
    data: Omit<InsertMarketSignal, 'firstDetectedAt'> & { lastEvaluatedAt: Date },
    cooldownHours?: number,
  ): Promise<MarketSignal> {
    const { lastEvaluatedAt, ...rest } = data;

    // Find an existing active/cooling signal for this scope/type/equipment
    const baseConditions = [
      eq(marketSignals.signalType, rest.signalType),
      eq(marketSignals.scopeType, rest.scopeType),
      eq(marketSignals.scopeKey, rest.scopeKey),
      or(eq(marketSignals.status, "active"), eq(marketSignals.status, "cooling")),
    ] as const;

    const equipCondition = rest.equipmentType != null
      ? eq(marketSignals.equipmentType, rest.equipmentType)
      : isNull(marketSignals.equipmentType);

    const [existing] = await db.select().from(marketSignals)
      .where(and(...baseConditions, equipCondition))
      .limit(1);

    if (existing) {
      // Enforce cooldown: if the signal is "cooling" and coolingStartedAt is within
      // the cooldown window, do not allow it to transition back to "active" yet.
      if (
        existing.status === "cooling" &&
        cooldownHours != null &&
        existing.coolingStartedAt != null
      ) {
        const cooledMs = lastEvaluatedAt.getTime() - new Date(existing.coolingStartedAt).getTime();
        const cooledHours = cooledMs / 3_600_000;
        if (cooledHours < cooldownHours) {
          // Still within cooldown — return existing signal without updating
          return existing;
        }
      }

      const [updated] = await db.update(marketSignals)
        .set({
          status: rest.status ?? "active",
          severity: rest.severity ?? "medium",
          confidence: rest.confidence,
          evidencePayload: rest.evidencePayload,
          explanation: rest.explanation,
          lastEvaluatedAt,
        })
        .where(eq(marketSignals.id, existing.id))
        .returning();
      return updated;
    }

    const insertData: InsertMarketSignal = {
      signalType: rest.signalType,
      scopeType: rest.scopeType,
      scopeKey: rest.scopeKey,
      equipmentType: rest.equipmentType,
      status: rest.status ?? "active",
      severity: rest.severity ?? "medium",
      confidence: rest.confidence,
      evidencePayload: rest.evidencePayload,
      explanation: rest.explanation,
      lastEvaluatedAt,
    };
    const [created] = await db.insert(marketSignals).values(insertData).returning();
    return created;
  }

  async updateMarketSignalStatus(id: string, status: string, now: Date): Promise<void> {
    if (status === "cooling") {
      await db.update(marketSignals)
        .set({ status, lastEvaluatedAt: now, coolingStartedAt: now })
        .where(eq(marketSignals.id, id));
    } else if (status === "resolved") {
      await db.update(marketSignals)
        .set({ status, lastEvaluatedAt: now, resolvedAt: now })
        .where(eq(marketSignals.id, id));
    } else {
      await db.update(marketSignals)
        .set({ status, lastEvaluatedAt: now })
        .where(eq(marketSignals.id, id));
    }
  }

  async getActiveMarketSignals(filters: {
    scopeType?: string;
    scopeKey?: string;
    equipmentType?: string | null;
    signalType?: string;
    status?: string | string[];
  }): Promise<MarketSignal[]> {
    const conditions: SQL[] = [];

    // Default: active or cooling
    const statusFilter = filters.status ?? ["active", "cooling"];
    if (Array.isArray(statusFilter) && statusFilter.length > 0) {
      conditions.push(inArray(marketSignals.status, statusFilter));
    } else if (typeof statusFilter === "string") {
      conditions.push(eq(marketSignals.status, statusFilter));
    }

    if (filters.scopeType) conditions.push(eq(marketSignals.scopeType, filters.scopeType));
    if (filters.scopeKey) conditions.push(eq(marketSignals.scopeKey, filters.scopeKey));
    if (filters.signalType) conditions.push(eq(marketSignals.signalType, filters.signalType));
    if (filters.equipmentType !== undefined) {
      if (filters.equipmentType === null) {
        conditions.push(isNull(marketSignals.equipmentType));
      } else {
        conditions.push(eq(marketSignals.equipmentType, filters.equipmentType));
      }
    }

    return db.select().from(marketSignals)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(marketSignals.lastEvaluatedAt));
  }

  async getMarketSignalById(id: string): Promise<MarketSignal | undefined> {
    const [row] = await db.select().from(marketSignals).where(eq(marketSignals.id, id));
    return row;
  }

  // ── Carrier Market NBAs (Task #187) ─────────────────────────────────────────

  async upsertCarrierMarketNba(data: InsertCarrierMarketNba): Promise<CarrierMarketNba> {
    const existing = await this.getCarrierMarketNbaByDedup(
      data.carrierId,
      data.marketSignalId,
      data.recommendationType,
    );

    const now = new Date();

    if (existing) {
      // Skip completed/dismissed rows — they remain as history
      if (existing.status === "completed" || existing.status === "dismissed") {
        return existing;
      }
      // Update pending/in_progress rows
      const [updated] = await db.update(carrierMarketNbas)
        .set({
          urgencyScore: data.urgencyScore ?? existing.urgencyScore,
          explanation: data.explanation ?? existing.explanation,
          updatedAt: now,
        })
        .where(eq(carrierMarketNbas.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await db.insert(carrierMarketNbas).values({
      ...data,
      status: data.status ?? "pending",
      createdAt: now,
      updatedAt: now,
      firstSeenAt: now,
    }).returning();
    return created;
  }

  async getCarrierMarketNbasBySignal(marketSignalId: string): Promise<CarrierMarketNba[]> {
    return db.select().from(carrierMarketNbas)
      .where(eq(carrierMarketNbas.marketSignalId, marketSignalId))
      .orderBy(desc(carrierMarketNbas.urgencyScore));
  }

  async getCarrierMarketNbasByCarrier(carrierId: string): Promise<CarrierMarketNba[]> {
    return db.select().from(carrierMarketNbas)
      .where(eq(carrierMarketNbas.carrierId, carrierId))
      .orderBy(desc(carrierMarketNbas.updatedAt));
  }

  async getCarrierMarketNbasBatch(carrierIds: string[]): Promise<CarrierMarketNba[]> {
    if (carrierIds.length === 0) return [];
    return db.select().from(carrierMarketNbas)
      .where(inArray(carrierMarketNbas.carrierId, carrierIds))
      .orderBy(desc(carrierMarketNbas.updatedAt));
  }

  async getActiveCarrierMarketNbasBatch(
    carrierIds: string[],
    laneEquipmentType: string | null,
    laneOriginState: string | null,
  ): Promise<Array<{ carrierId: string; signalEquipmentType: string | null; signalScopeType: string | null; signalScopeKey: string | null }>> {
    if (carrierIds.length === 0) return [];
    const MARKET_SURGE_TYPES = ["demand_surge_capacity", "imbalance_outreach"];
    const ACTIVE_STATUSES = ["pending", "in_progress"];
    // Single join query: carrier_market_nbas → market_signals for equipment+region filtering
    const rows = await db
      .select({
        carrierId: carrierMarketNbas.carrierId,
        signalEquipmentType: marketSignals.equipmentType,
        signalScopeType: marketSignals.scopeType,
        signalScopeKey: marketSignals.scopeKey,
      })
      .from(carrierMarketNbas)
      .leftJoin(marketSignals, eq(carrierMarketNbas.marketSignalId, marketSignals.id))
      .where(and(
        inArray(carrierMarketNbas.carrierId, carrierIds),
        inArray(carrierMarketNbas.recommendationType, MARKET_SURGE_TYPES),
        inArray(carrierMarketNbas.status, ACTIVE_STATUSES),
      ));
    // Application-level filter: match on equipment type (if lane has one)
    let filtered = laneEquipmentType
      ? rows.filter(r => !r.signalEquipmentType || r.signalEquipmentType.toLowerCase().trim() === laneEquipmentType.toLowerCase().trim())
      : rows;
    // Application-level filter: match on origin region (if lane has a state and signal has scope)
    if (laneOriginState) {
      const originSt = laneOriginState.toUpperCase().trim();
      filtered = filtered.filter(r => {
        if (!r.signalScopeType || r.signalScopeType === "national") return true;
        if (!r.signalScopeKey) return true;
        // For region/equipment_region: scopeKey should include the state code
        if (r.signalScopeType === "region" || r.signalScopeType === "equipment_region") {
          return r.signalScopeKey.toUpperCase().includes(originSt);
        }
        // For corridor: scopeKey format "IL-TX" — origin state appears in corridor key
        if (r.signalScopeType === "corridor") {
          return r.signalScopeKey.toUpperCase().includes(originSt);
        }
        return true;
      });
    }
    return filtered;
  }

  async getLatestCarrierOutreachLogsForLane(
    laneId: string,
    carrierIds: string[],
  ): Promise<Map<string, { deliveryStatus: string | null; sentAt: Date | null }>> {
    if (carrierIds.length === 0) return new Map();
    // Fetch outreach logs for this lane, look for any log that includes the carrierId
    const logs = await db
      .select({
        carrierIds: carrierOutreachLogs.carrierIds,
        deliveryStatus: carrierOutreachLogs.deliveryStatus,
        sentAt: carrierOutreachLogs.sentAt,
      })
      .from(carrierOutreachLogs)
      .where(eq(carrierOutreachLogs.laneId, laneId))
      .orderBy(desc(carrierOutreachLogs.sentAt));
    // Build a map: carrierId → most recent log (first match wins due to desc order)
    const result = new Map<string, { deliveryStatus: string | null; sentAt: Date | null }>();
    for (const log of logs) {
      const ids = log.carrierIds ?? [];
      for (const cid of ids) {
        if (carrierIds.includes(cid) && !result.has(cid)) {
          result.set(cid, { deliveryStatus: log.deliveryStatus, sentAt: log.sentAt });
        }
      }
    }
    return result;
  }

  async getRecentSuccessfulOutreachCarrierIds(laneId: string, windowMs: number): Promise<Set<string>> {
    const cutoff = new Date(Date.now() - windowMs);
    // Query outreach logs where deliveryStatus indicates confirmed delivery (not draft/failed)
    const logs = await db
      .select({ carrierIds: carrierOutreachLogs.carrierIds })
      .from(carrierOutreachLogs)
      .where(and(
        eq(carrierOutreachLogs.laneId, laneId),
        or(
          eq(carrierOutreachLogs.deliveryStatus, "sent"),
          eq(carrierOutreachLogs.deliveryStatus, "delivered"),
          eq(carrierOutreachLogs.deliveryStatus, "opened"),
        ),
        gte(carrierOutreachLogs.sentAt, cutoff),
      ));
    const result = new Set<string>();
    for (const log of logs) {
      for (const cid of log.carrierIds ?? []) {
        result.add(cid);
      }
    }
    return result;
  }

  async checkCarrierDailyBudget(orgId: string, carrierId: string): Promise<CarrierDailyBudgetResult> {
    const { dailyCap, minGapHours } = CARRIER_DAILY_BUDGET_CONFIG;
    const now = new Date();

    // ── Daily cap: count successful sends within the current calendar day ────
    // Scoped to today (UTC midnight) to count how many times this carrier
    // has been emailed today across all lanes in the org.
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);

    const todayLogs = await db
      .select({ sentAt: carrierOutreachLogs.sentAt })
      .from(carrierOutreachLogs)
      .where(and(
        eq(carrierOutreachLogs.orgId, orgId),
        sql`${carrierOutreachLogs.carrierIds} @> ARRAY[${carrierId}]::text[]`,
        or(
          eq(carrierOutreachLogs.deliveryStatus, "sent"),
          eq(carrierOutreachLogs.deliveryStatus, "delivered"),
          eq(carrierOutreachLogs.deliveryStatus, "opened"),
        ),
        gte(carrierOutreachLogs.sentAt, startOfDay),
      ))
      .orderBy(desc(carrierOutreachLogs.sentAt));

    const sentToday = todayLogs.length;

    // Check daily cap first (most restrictive)
    if (sentToday >= dailyCap) {
      return {
        allowed: false,
        reason: "daily_cap",
        message: `Daily limit reached for this carrier (${sentToday}/${dailyCap} emails sent today)`,
        sentToday,
        cap: dailyCap,
      };
    }

    // ── Minimum gap: check most recent send across any day ────────────────────
    // The gap window (4h) must span day boundaries. A carrier emailed at 11:30 PM
    // must still be blocked at 1:00 AM the next day. So we query independently
    // using a window of minGapHours back from now, without a day boundary cutoff.
    const minGapMs = minGapHours * 60 * 60 * 1000;
    const gapWindowCutoff = new Date(now.getTime() - minGapMs);

    const recentLog = await db
      .select({ sentAt: carrierOutreachLogs.sentAt })
      .from(carrierOutreachLogs)
      .where(and(
        eq(carrierOutreachLogs.orgId, orgId),
        sql`${carrierOutreachLogs.carrierIds} @> ARRAY[${carrierId}]::text[]`,
        or(
          eq(carrierOutreachLogs.deliveryStatus, "sent"),
          eq(carrierOutreachLogs.deliveryStatus, "delivered"),
          eq(carrierOutreachLogs.deliveryStatus, "opened"),
        ),
        gte(carrierOutreachLogs.sentAt, gapWindowCutoff),
      ))
      .orderBy(desc(carrierOutreachLogs.sentAt))
      .limit(1);

    if (recentLog.length > 0 && recentLog[0].sentAt) {
      const mostRecentSentAt = recentLog[0].sentAt;
      const nextAvailableAt = new Date(mostRecentSentAt.getTime() + minGapMs);
      if (now < nextAvailableAt) {
        const timeStr = nextAvailableAt.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        return {
          allowed: false,
          reason: "too_soon",
          message: `Next available send at ${timeStr} (${minGapHours}h minimum gap between emails)`,
          nextAvailableAt,
          minGapHours,
        };
      }
    }

    return { allowed: true };
  }

  async getCarrierMarketNbaByDedup(
    carrierId: string,
    marketSignalId: string,
    recommendationType: string,
  ): Promise<CarrierMarketNba | undefined> {
    const [row] = await db.select().from(carrierMarketNbas)
      .where(and(
        eq(carrierMarketNbas.carrierId, carrierId),
        eq(carrierMarketNbas.marketSignalId, marketSignalId),
        eq(carrierMarketNbas.recommendationType, recommendationType),
      ))
      .limit(1);
    return row;
  }

  async getCarrierMarketNbaBySignalKey(
    carrierId: string,
    marketSignalId: string,
  ): Promise<CarrierMarketNba | undefined> {
    const [row] = await db.select().from(carrierMarketNbas)
      .where(and(
        eq(carrierMarketNbas.carrierId, carrierId),
        eq(carrierMarketNbas.marketSignalId, marketSignalId),
      ))
      .limit(1);
    return row;
  }

  async getCarriersByOrgForMarketSignal(orgId: string): Promise<import('@shared/schema').Carrier[]> {
    return this.getCarriers(orgId);
  }

  async getCarrierClaimedLanesByCarrierId(carrierId: string): Promise<import('@shared/schema').CarrierClaimedLane[]> {
    return db.select().from(carrierClaimedLanes)
      .where(eq(carrierClaimedLanes.carrierId, carrierId));
  }

  async getFinancialRowsForCarrierSignal(
    orgId: string,
    originRegion: string,
    equipmentType: string | null,
    since: Date,
  ): Promise<Array<{ carrierId: string | null; originRegion: string | null; occurredAt: Date }>> {
    // Scope to carriers belonging to this org — prevents cross-tenant data bleed.
    const orgCarriers = await db.select({ id: carriers.id })
      .from(carriers)
      .where(eq(carriers.orgId, orgId));
    const orgCarrierIds = orgCarriers.map(c => c.id);

    if (orgCarrierIds.length === 0) return [];

    // Query market_events for carrier_capacity_declaration events within the lookback window
    // for carriers known to this org.
    const conditions: SQL[] = [
      eq(marketEvents.eventType, "carrier_capacity_declaration"),
      gte(marketEvents.occurredAt, since),
      inArray(marketEvents.carrierId, orgCarrierIds),
    ];

    // Apply equipment type filter at the query level when available.
    // market_events.equipmentType holds the normalized equipment string.
    if (equipmentType) {
      conditions.push(eq(marketEvents.equipmentType, equipmentType));
    }

    const rows = await db.select({
      carrierId: marketEvents.carrierId,
      originRegion: marketEvents.originRegion,
      equipmentType: marketEvents.equipmentType,
      occurredAt: marketEvents.occurredAt,
    })
      .from(marketEvents)
      .where(and(...conditions));

    // Filter by origin region in application code (normalized substring/token matching).
    const normalizeR = (r: string | null | undefined): string =>
      (r ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const sigRegion = normalizeR(originRegion);

    return rows.filter(row => {
      const rowRegion = normalizeR(row.originRegion);
      if (!rowRegion || !sigRegion) return false;
      if (rowRegion === sigRegion) return true;
      if (rowRegion.includes(sigRegion) || sigRegion.includes(rowRegion)) return true;
      const sigTokens = sigRegion.split("_").filter((t: string) => t.length === 2);
      const rowTokens = rowRegion.split("_").filter((t: string) => t.length === 2);
      return sigTokens.some((t: string) => rowTokens.includes(t));
    });
  }

  // ─── Email Intelligence Layer (Task #190) ──────────────────────────────────

  async insertEmailMessage(data: InsertEmailMessage): Promise<EmailMessage> {
    const [row] = await db.insert(emailMessages).values(data).returning();
    return row;
  }

  async upsertInboundEmailMessage(
    data: InsertEmailMessage,
  ): Promise<{ message: EmailMessage; created: boolean }> {
    // Task #727 — write-time customer-vs-carrier precedence guard.
    // The user-mailbox lane (processUserMailboxEmail) is the only
    // path that supplies linkedAccountId. If a caller ever supplies
    // BOTH a linked account and a linked carrier we drop the carrier
    // here so the customer lane always wins. The shared-mailbox
    // carrier path (logInboundCarrierEmail) doesn't supply
    // linkedAccountId at all so this is a no-op for it.
    if (data.linkedAccountId && data.linkedCarrierId) {
      data = { ...data, linkedCarrierId: null };
    }

    // No provider key — fall back to plain insert (cannot dedupe)
    if (!data.providerMessageId) {
      const msg = await this.insertEmailMessage(data);
      return { message: msg, created: true };
    }

    // Atomic insert-or-ignore using ON CONFLICT DO NOTHING on the
    // unique index (org_id, provider_message_id WHERE provider_message_id IS NOT NULL).
    // If a duplicate arrives the insert is silently skipped and we fall through
    // to the SELECT to return the existing row — no race window.
    const inserted = await db
      .insert(emailMessages)
      .values(data)
      .onConflictDoNothing()
      .returning();

    if (inserted.length > 0) {
      return { message: inserted[0], created: true };
    }

    // Row already existed — fetch and return it
    const [existing] = await db
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.orgId, data.orgId),
          eq(emailMessages.providerMessageId, data.providerMessageId),
        ),
      )
      .limit(1);

    return { message: existing, created: false };
  }

  async getEmailMessageByProviderId(orgId: string, providerMessageId: string): Promise<EmailMessage | undefined> {
    const [row] = await db.select().from(emailMessages)
      .where(and(
        eq(emailMessages.orgId, orgId),
        eq(emailMessages.providerMessageId, providerMessageId),
      ))
      .limit(1);
    return row;
  }

  async updateEmailMessageLinks(id: string, links: {
    linkedAccountId?: string | null;
    linkedCarrierId?: string | null;
    linkedLaneId?: string | null;
    linkedLoadId?: string | null;
    linkedTaskId?: string | null;
    linkedNbaId?: string | null;
    linkedOutreachLogId?: string | null;
  }): Promise<EmailMessage | undefined> {
    const [row] = await db.update(emailMessages)
      .set(links)
      .where(eq(emailMessages.id, id))
      .returning();
    return row;
  }

  async insertEmailSignals(signals: InsertEmailSignal[]): Promise<EmailSignal[]> {
    if (signals.length === 0) return [];
    return db.insert(emailSignals).values(signals).returning();
  }

  async getEmailSignalsForAccount(accountId: string, limit = 100): Promise<EmailSignal[]> {
    const msgs = await db.select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.linkedAccountId, accountId));
    if (msgs.length === 0) return [];
    return db.select().from(emailSignals)
      .where(inArray(emailSignals.messageId, msgs.map(m => m.id)))
      .orderBy(desc(emailSignals.createdAt))
      .limit(limit);
  }

  async getEmailSignalsForCarrier(carrierId: string, limit = 100): Promise<EmailSignal[]> {
    const msgs = await db.select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.linkedCarrierId, carrierId));
    if (msgs.length === 0) return [];
    return db.select().from(emailSignals)
      .where(inArray(emailSignals.messageId, msgs.map(m => m.id)))
      .orderBy(desc(emailSignals.createdAt))
      .limit(limit);
  }

  async getEmailSignalsForLane(laneId: string, limit = 100): Promise<EmailSignal[]> {
    const msgs = await db.select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.linkedLaneId, laneId));
    if (msgs.length === 0) return [];
    return db.select().from(emailSignals)
      .where(inArray(emailSignals.messageId, msgs.map(m => m.id)))
      .orderBy(desc(emailSignals.createdAt))
      .limit(limit);
  }

  async getEmailSignalsForLoad(loadId: string, limit = 100): Promise<EmailSignal[]> {
    const msgs = await db.select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.linkedLoadId, loadId));
    if (msgs.length === 0) return [];
    return db.select().from(emailSignals)
      .where(inArray(emailSignals.messageId, msgs.map(m => m.id)))
      .orderBy(desc(emailSignals.createdAt))
      .limit(limit);
  }

  async getUnprocessedEmailMessages(limit = 50): Promise<EmailMessage[]> {
    return db.select().from(emailMessages)
      .where(isNull(emailMessages.processedForSignalsAt))
      .orderBy(asc(emailMessages.createdAt))
      .limit(limit);
  }

  // Task #751: org-scoped variant used by the manual /drain endpoint so a
  // tenant admin can only burn quota processing their own org's backlog.
  async getUnprocessedEmailMessagesForOrg(orgId: string, limit = 50): Promise<EmailMessage[]> {
    return db.select().from(emailMessages)
      .where(and(
        eq(emailMessages.orgId, orgId),
        isNull(emailMessages.processedForSignalsAt),
      ))
      .orderBy(asc(emailMessages.createdAt))
      .limit(limit);
  }

  // Freshness-first companion to getUnprocessedEmailMessages — returns the
  // newest unprocessed messages from the last `sinceHours` window. Used by the
  // cron path so today's mail gets classified within ~2 minutes regardless of
  // how big the historical backlog is. Without this, a stalled extractor (e.g.
  // an OpenAI 500 storm followed by a 10k-message queue) leaves new inbound
  // mail untagged for hours, breaking signal-driven UI like Quote requests
  // and Win/loss analytics.
  async getRecentUnprocessedEmailMessages(sinceHours: number, limit = 50): Promise<EmailMessage[]> {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    return db.select().from(emailMessages)
      .where(and(
        isNull(emailMessages.processedForSignalsAt),
        gte(emailMessages.createdAt, since),
      ))
      .orderBy(desc(emailMessages.createdAt))
      .limit(limit);
  }

  async getEmailSignalsByThread(threadId: string, since?: Date): Promise<EmailSignal[]> {
    const msgs = await db.select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.threadId, threadId));
    if (msgs.length === 0) return [];
    const conditions: SQL[] = [inArray(emailSignals.messageId, msgs.map(m => m.id))];
    if (since) conditions.push(gte(emailSignals.createdAt, since));
    return db.select().from(emailSignals)
      .where(and(...conditions))
      .orderBy(desc(emailSignals.createdAt));
  }

  async markEmailMessageProcessed(id: string): Promise<void> {
    await db.update(emailMessages)
      .set({ processedForSignalsAt: new Date() })
      .where(eq(emailMessages.id, id));
  }

  // ── Task #751 — backlog drain + ops view support ─────────────────────────────

  async getUnlinkedEmailMessages(orgId: string, limit: number, offset = 0): Promise<EmailMessage[]> {
    return db.select().from(emailMessages)
      .where(and(
        eq(emailMessages.orgId, orgId),
        isNull(emailMessages.linkedCarrierId),
        isNull(emailMessages.linkedAccountId),
      ))
      .orderBy(asc(emailMessages.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async relinkEmailMessage(
    id: string,
    links: { linkedCarrierId?: string | null; linkedAccountId?: string | null },
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    if ("linkedCarrierId" in links) set.linkedCarrierId = links.linkedCarrierId ?? null;
    if ("linkedAccountId" in links) set.linkedAccountId = links.linkedAccountId ?? null;
    // Reset processedForSignalsAt so the scheduler re-extracts under the new link.
    set.processedForSignalsAt = null;
    if (Object.keys(set).length === 0) return;
    await db.update(emailMessages).set(set).where(eq(emailMessages.id, id));
  }

  async getEmailPipelineHealth(orgId: string): Promise<{
    backlog: { unprocessed: number; oldestUnprocessedAt: Date | null };
    windows: Array<{
      label: string;
      sinceMs: number;
      ingested: number;
      linkedCarrier: number;
      linkedAccount: number;
      signals: number;
      signalsByIntent: Record<string, number>;
      suggestions: { pending: number; accepted: number; autoAccepted: number; rejected: number };
    }>;
  }> {
    const now = Date.now();
    const windows = [
      { label: "24h", sinceMs: 24 * 60 * 60 * 1000 },
      { label: "7d", sinceMs: 7 * 24 * 60 * 60 * 1000 },
      { label: "30d", sinceMs: 30 * 24 * 60 * 60 * 1000 },
    ];

    // Backlog: messages still missing processedForSignalsAt
    function unwrapRows<T>(r: unknown): T[] {
      if (Array.isArray(r)) return r as T[];
      const wrapped = r as { rows?: T[] };
      return wrapped?.rows ?? [];
    }
    const backlogRows = await db.execute<{ count: string; oldest: Date | null }>(sql`
      SELECT COUNT(*)::text AS count, MIN(created_at) AS oldest
      FROM email_messages
      WHERE org_id = ${orgId} AND processed_for_signals_at IS NULL
    `);
    const backlogRow = unwrapRows<{ count: string; oldest: Date | null }>(backlogRows)[0]
      ?? { count: "0", oldest: null };
    const backlog = {
      unprocessed: parseInt(backlogRow.count ?? "0", 10),
      oldestUnprocessedAt: backlogRow.oldest ? new Date(backlogRow.oldest) : null,
    };

    const out: Array<{
      label: string;
      sinceMs: number;
      ingested: number;
      linkedCarrier: number;
      linkedAccount: number;
      signals: number;
      signalsByIntent: Record<string, number>;
      suggestions: { pending: number; accepted: number; autoAccepted: number; rejected: number };
    }> = [];

    for (const w of windows) {
      const since = new Date(now - w.sinceMs);
      const ingested = await db.execute<{
        ingested: string; linked_carrier: string; linked_account: string;
      }>(sql`
        SELECT
          COUNT(*)::text AS ingested,
          COUNT(*) FILTER (WHERE linked_carrier_id IS NOT NULL)::text AS linked_carrier,
          COUNT(*) FILTER (WHERE linked_account_id IS NOT NULL)::text AS linked_account
        FROM email_messages
        WHERE org_id = ${orgId} AND created_at >= ${since}
      `);
      const ing = unwrapRows<{ ingested: string; linked_carrier: string; linked_account: string }>(ingested)[0]
        ?? { ingested: "0", linked_carrier: "0", linked_account: "0" };

      // Signals grouped by intent_type — gives ops view of WHAT we're
      // learning per window (capacity, lane preferences, pricing, etc.).
      const sigByIntent = await db.execute<{ intent_type: string; count: string }>(sql`
        SELECT s.intent_type, COUNT(*)::text AS count
        FROM email_signals s
        INNER JOIN email_messages m ON m.id = s.message_id
        WHERE m.org_id = ${orgId} AND s.created_at >= ${since}
        GROUP BY s.intent_type
      `);
      const signalsByIntent: Record<string, number> = {};
      let sigCount = 0;
      for (const r of unwrapRows<{ intent_type: string; count: string }>(sigByIntent)) {
        const c = parseInt(r.count, 10);
        signalsByIntent[r.intent_type] = c;
        sigCount += c;
      }

      const sugRows = await db.execute<{ status: string; count: string }>(sql`
        SELECT status, COUNT(*)::text AS count
        FROM carrier_intel_suggestions
        WHERE org_id = ${orgId} AND created_at >= ${since}
        GROUP BY status
      `);
      const sugBuckets = { pending: 0, accepted: 0, autoAccepted: 0, rejected: 0 };
      for (const r of unwrapRows<{ status: string; count: string }>(sugRows)) {
        const c = parseInt(r.count, 10);
        if (r.status === "pending") sugBuckets.pending += c;
        else if (r.status === "accepted") sugBuckets.accepted += c;
        else if (r.status === "auto_accepted") sugBuckets.autoAccepted += c;
        else if (r.status === "rejected") sugBuckets.rejected += c;
      }

      out.push({
        label: w.label,
        sinceMs: w.sinceMs,
        ingested: parseInt(ing.ingested ?? "0", 10),
        linkedCarrier: parseInt(ing.linked_carrier ?? "0", 10),
        linkedAccount: parseInt(ing.linked_account ?? "0", 10),
        signals: sigCount,
        signalsByIntent,
        suggestions: sugBuckets,
      });
    }

    return { backlog, windows: out };
  }

  // ── Email Signal Consumers (Task #191) ──────────────────────────────────────

  async insertCarrierEmailSuggestion(data: InsertCarrierEmailSuggestion): Promise<CarrierEmailSuggestion> {
    const [row] = await db.insert(carrierEmailSuggestions).values(data).returning();
    return row;
  }

  async getCarrierEmailSuggestionByDedup(
    carrierId: string,
    threadId: string,
    suggestionType: string,
    payloadHash: string,
  ): Promise<CarrierEmailSuggestion | undefined> {
    const [row] = await db.select()
      .from(carrierEmailSuggestions)
      .where(
        and(
          eq(carrierEmailSuggestions.carrierId, carrierId),
          eq(carrierEmailSuggestions.threadId, threadId),
          eq(carrierEmailSuggestions.suggestionType, suggestionType),
          eq(carrierEmailSuggestions.payloadHash, payloadHash),
        ),
      )
      .limit(1);
    return row;
  }

  async getCarrierEmailSuggestions(carrierId: string, status?: string): Promise<CarrierEmailSuggestion[]> {
    const conditions: SQL[] = [eq(carrierEmailSuggestions.carrierId, carrierId)];
    if (status) conditions.push(eq(carrierEmailSuggestions.status, status));
    return db.select()
      .from(carrierEmailSuggestions)
      .where(and(...conditions))
      .orderBy(desc(carrierEmailSuggestions.createdAt));
  }

  async insertEmailOutcomeLink(data: InsertEmailOutcomeLink): Promise<EmailOutcomeLink> {
    const [row] = await db.insert(emailOutcomeLinks).values(data).returning();
    return row;
  }

  async getEmailOutcomeLinksBySignal(emailSignalId: string): Promise<EmailOutcomeLink[]> {
    return db.select()
      .from(emailOutcomeLinks)
      .where(eq(emailOutcomeLinks.emailSignalId, emailSignalId))
      .orderBy(desc(emailOutcomeLinks.createdAt));
  }

  async getEmailOutcomeLinksByEntity(entityType: string, entityId: string): Promise<EmailOutcomeLink[]> {
    return db.select()
      .from(emailOutcomeLinks)
      .where(
        and(
          eq(emailOutcomeLinks.entityType, entityType),
          eq(emailOutcomeLinks.entityId, entityId),
        ),
      )
      .orderBy(desc(emailOutcomeLinks.createdAt));
  }

  async getWinLossEmailSignals(
    outcomeType: "won" | "lost",
  ): Promise<Array<{ signal: EmailSignal; links: EmailOutcomeLink[] }>> {
    const links = await db.select()
      .from(emailOutcomeLinks)
      .where(eq(emailOutcomeLinks.outcomeType, outcomeType))
      .orderBy(desc(emailOutcomeLinks.createdAt));

    if (links.length === 0) return [];

    const signalIds = [...new Set(links.map(l => l.emailSignalId))];
    const signals = await db.select()
      .from(emailSignals)
      .where(inArray(emailSignals.id, signalIds));

    const signalMap = new Map(signals.map(s => [s.id, s]));
    const signalLinkMap = new Map<string, EmailOutcomeLink[]>();
    for (const link of links) {
      const existing = signalLinkMap.get(link.emailSignalId) ?? [];
      existing.push(link);
      signalLinkMap.set(link.emailSignalId, existing);
    }

    return signalIds
      .filter(id => signalMap.has(id))
      .map(id => ({
        signal: signalMap.get(id)!,
        links: signalLinkMap.get(id) ?? [],
      }));
  }

  async updateEmailSignalLinks(
    signalId: string,
    links: {
      linkedAccountId?: string | null;
      linkedCarrierId?: string | null;
      linkedLaneId?: string | null;
      linkedOpportunityId?: string | null;
    },
  ): Promise<void> {
    await db.update(emailSignals)
      .set(links)
      .where(eq(emailSignals.id, signalId));
  }

  // ── Carrier Intel Suggestions (Task #193 / #194) ────────────────────────────

  /**
   * Returns all email signals tied to a given opportunityId.
   * Looks up signals by:
   *   1. linkedOpportunityId on email_signals directly
   *   2. linkedLoadId on email_messages (load IDs are used as opportunityId proxies)
   * Results are deduped and ordered by createdAt desc.
   */
  async getEmailSignalsForOpportunity(opportunityId: string, limit = 100): Promise<EmailSignal[]> {
    // Path 1: direct signal link
    const directSignals = await db.select()
      .from(emailSignals)
      .where(eq(emailSignals.linkedOpportunityId, opportunityId))
      .orderBy(desc(emailSignals.createdAt))
      .limit(limit);

    // Path 2: via email_messages.linkedLoadId (load IDs often equal opportunityId)
    const msgs = await db.select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.linkedLoadId, opportunityId));

    if (msgs.length === 0) {
      return directSignals.slice(0, limit);
    }

    const msgIds = msgs.map(m => m.id);
    const messageSignals = await db.select()
      .from(emailSignals)
      .where(inArray(emailSignals.messageId, msgIds))
      .orderBy(desc(emailSignals.createdAt))
      .limit(limit);

    // Merge, dedup by id, sort, truncate
    const allById = new Map<string, EmailSignal>();
    for (const s of [...directSignals, ...messageSignals]) {
      allById.set(s.id, s);
    }
    return [...allById.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async insertCarrierIntelSuggestion(data: InsertCarrierIntelSuggestion): Promise<CarrierIntelSuggestion> {
    const [row] = await db.insert(carrierIntelSuggestions).values({
      ...data,
      updatedAt: new Date(),
    }).returning();
    return row;
  }

  async getSuggestionsForCarrier(carrierId: string, status?: string): Promise<CarrierIntelSuggestion[]> {
    const conditions: SQL[] = [eq(carrierIntelSuggestions.carrierId, carrierId)];
    if (status) conditions.push(eq(carrierIntelSuggestions.status, status));
    return db.select().from(carrierIntelSuggestions)
      .where(and(...conditions))
      .orderBy(desc(carrierIntelSuggestions.createdAt));
  }

  async getSuggestionById(id: string): Promise<CarrierIntelSuggestion | undefined> {
    const [row] = await db.select().from(carrierIntelSuggestions).where(eq(carrierIntelSuggestions.id, id));
    return row;
  }

  async updateSuggestionStatus(
    id: string,
    status: 'accepted' | 'rejected' | 'auto_accepted' | 'auto_dismissed',
    opts: { userId?: string; comment?: string; resolutionReason?: string }
  ): Promise<CarrierIntelSuggestion | undefined> {
    const now = new Date();
    const updates: Partial<CarrierIntelSuggestion> = {
      status,
      updatedAt: now,
    };
    if (opts.comment !== undefined) updates.comment = opts.comment;
    if (opts.resolutionReason !== undefined) updates.resolutionReason = opts.resolutionReason;
    if (status === 'accepted' || status === 'auto_accepted') {
      updates.acceptedAt = now;
      if (opts.userId) updates.acceptedByUserId = opts.userId;
    } else if (status === 'rejected' || status === 'auto_dismissed') {
      updates.rejectedAt = now;
      if (opts.userId) updates.rejectedByUserId = opts.userId;
    }
    const [row] = await db.update(carrierIntelSuggestions)
      .set(updates as any)
      .where(eq(carrierIntelSuggestions.id, id))
      .returning();
    return row;
  }

  async findDuplicateSuggestion(carrierId: string, suggestionType: string, emailSignalId: string): Promise<CarrierIntelSuggestion | undefined> {
    const [row] = await db.select().from(carrierIntelSuggestions)
      .where(and(
        eq(carrierIntelSuggestions.carrierId, carrierId),
        eq(carrierIntelSuggestions.suggestionType, suggestionType),
        eq(carrierIntelSuggestions.emailSignalId, emailSignalId),
      ))
      .limit(1);
    return row;
  }

  async getCarrierIntelSuggestionByDedup(
    carrierId: string,
    suggestionType: string,
    emailSignalId: string,
  ): Promise<CarrierIntelSuggestion | undefined> {
    return this.findDuplicateSuggestion(carrierId, suggestionType, emailSignalId);
  }

  async getCarrierIntelSuggestions(carrierId: string, status?: string): Promise<CarrierIntelSuggestion[]> {
    const conditions: SQL[] = [eq(carrierIntelSuggestions.carrierId, carrierId)];
    if (status) conditions.push(eq(carrierIntelSuggestions.status, status));
    return db.select()
      .from(carrierIntelSuggestions)
      .where(and(...conditions))
      .orderBy(desc(carrierIntelSuggestions.createdAt));
  }

  async getAcceptedLanePreferencesForCarrier(carrierId: string): Promise<CarrierIntelSuggestion[]> {
    return db.select().from(carrierIntelSuggestions)
      .where(and(
        eq(carrierIntelSuggestions.carrierId, carrierId),
        inArray(carrierIntelSuggestions.status, ['accepted', 'auto_accepted']),
        eq(carrierIntelSuggestions.suggestionType, 'lane_preference'),
      ))
      .orderBy(desc(carrierIntelSuggestions.acceptedAt));
  }

  async getAcceptedRegionPreferencesForCarrier(carrierId: string): Promise<CarrierIntelSuggestion[]> {
    return db.select().from(carrierIntelSuggestions)
      .where(and(
        eq(carrierIntelSuggestions.carrierId, carrierId),
        inArray(carrierIntelSuggestions.status, ['accepted', 'auto_accepted']),
        eq(carrierIntelSuggestions.suggestionType, 'region_preference'),
      ))
      .orderBy(desc(carrierIntelSuggestions.acceptedAt));
  }

  async getAcceptedEquipmentCapabilitiesForCarrier(carrierId: string): Promise<CarrierIntelSuggestion[]> {
    return db.select().from(carrierIntelSuggestions)
      .where(and(
        eq(carrierIntelSuggestions.carrierId, carrierId),
        inArray(carrierIntelSuggestions.status, ['accepted', 'auto_accepted']),
        eq(carrierIntelSuggestions.suggestionType, 'equipment_capability'),
      ))
      .orderBy(desc(carrierIntelSuggestions.acceptedAt));
  }

  async getAcceptedCapacitySignalsForCarrier(carrierId: string): Promise<CarrierIntelSuggestion[]> {
    return db.select().from(carrierIntelSuggestions)
      .where(and(
        eq(carrierIntelSuggestions.carrierId, carrierId),
        inArray(carrierIntelSuggestions.status, ['accepted', 'auto_accepted']),
        inArray(carrierIntelSuggestions.suggestionType, ['capacity_available', 'capacity_unavailable']),
      ))
      .orderBy(desc(carrierIntelSuggestions.acceptedAt));
  }

  async getAcceptedCautionFlagsForCarrier(carrierId: string): Promise<CarrierIntelSuggestion[]> {
    return db.select().from(carrierIntelSuggestions)
      .where(and(
        eq(carrierIntelSuggestions.carrierId, carrierId),
        inArray(carrierIntelSuggestions.status, ['accepted', 'auto_accepted']),
        inArray(carrierIntelSuggestions.suggestionType, ['price_sensitivity', 'service_risk']),
      ))
      .orderBy(desc(carrierIntelSuggestions.acceptedAt));
  }

  async getBatchAcceptedIntelForCarriers(carrierIds: string[]): Promise<Map<string, CarrierIntelSuggestion[]>> {
    const result = new Map<string, CarrierIntelSuggestion[]>();
    if (carrierIds.length === 0) return result;

    const rows = await db.select().from(carrierIntelSuggestions)
      .where(and(
        inArray(carrierIntelSuggestions.carrierId, carrierIds),
        inArray(carrierIntelSuggestions.status, ['accepted', 'auto_accepted']),
        inArray(carrierIntelSuggestions.suggestionType, [
          'lane_preference', 'region_preference', 'equipment_capability',
          'capacity_available', 'capacity_unavailable',
          'price_sensitivity', 'service_risk',
        ]),
      ))
      .orderBy(desc(carrierIntelSuggestions.acceptedAt));

    for (const row of rows) {
      const existing = result.get(row.carrierId);
      if (existing) {
        existing.push(row);
      } else {
        result.set(row.carrierId, [row]);
      }
    }
    return result;
  }

  // ── Account Contact Suggestions (Task #201) ───────────────────────────────

  async upsertAccountContactSuggestion(data: InsertAccountContactSuggestion): Promise<AccountContactSuggestion> {
    const now = new Date();
    // Try insert first; on conflict (accountId, emailAddress) update thread count + updatedAt
    // but preserve status unless it is 'ignored' or 'never_suggest' (don't re-open suppressed)
    const [existing] = await db.select()
      .from(accountContactSuggestions)
      .where(and(
        eq(accountContactSuggestions.accountId, data.accountId),
        eq(accountContactSuggestions.emailAddress, data.emailAddress),
      ))
      .limit(1);

    if (existing) {
      // If already permanently suppressed, don't update
      if (existing.status === "never_suggest" || existing.status === "ignored") {
        return existing;
      }
      // Update thread count, confidence, and name hints if they were null
      const [updated] = await db
        .update(accountContactSuggestions)
        .set({
          threadCount: existing.threadCount + 1,
          confidenceScore: Math.max(existing.confidenceScore, data.confidenceScore ?? 50),
          suggestedName: existing.suggestedName ?? data.suggestedName,
          suggestedTitle: existing.suggestedTitle ?? data.suggestedTitle,
          suggestedPhone: existing.suggestedPhone ?? data.suggestedPhone,
          emailMessageId: data.emailMessageId ?? existing.emailMessageId,
          threadId: data.threadId ?? existing.threadId,
          updatedAt: now,
        })
        .where(eq(accountContactSuggestions.id, existing.id))
        .returning();
      return updated;
    }

    const [inserted] = await db
      .insert(accountContactSuggestions)
      .values({ ...data, createdAt: now, updatedAt: now })
      .returning();
    return inserted;
  }

  async getAccountContactSuggestions(accountId: string, status?: string): Promise<AccountContactSuggestion[]> {
    const now = new Date();
    const rows = await db.select()
      .from(accountContactSuggestions)
      .where(
        status
          ? and(
              eq(accountContactSuggestions.accountId, accountId),
              eq(accountContactSuggestions.status, status),
            )
          : eq(accountContactSuggestions.accountId, accountId),
      )
      .orderBy(desc(accountContactSuggestions.confidenceScore), desc(accountContactSuggestions.createdAt));

    // Filter out snoozed suggestions whose snooze window has expired
    return rows.filter(row => {
      if (row.status === "snoozed" && row.snoozedUntil && row.snoozedUntil <= now) {
        // Automatically re-open — async fire-and-forget
        db.update(accountContactSuggestions)
          .set({ status: "pending", snoozedUntil: null, updatedAt: now })
          .where(eq(accountContactSuggestions.id, row.id))
          .catch(() => { /* ignore */ });
        return true; // show as pending to the caller
      }
      return true;
    });
  }

  async countPendingContactSuggestionsByOrg(orgId: string, ownerScope?: string[]): Promise<{ accountId: string; accountName: string; pendingCount: number }[]> {
    // When ownerScope is provided, restrict results to accounts whose sales
    // person is within the scope (user's own accounts + their direct/indirect
    // reports' accounts). Admins/directors pass undefined to see everything.
    const whereClauses = [
      eq(accountContactSuggestions.orgId, orgId),
      eq(companies.organizationId, orgId),
      or(
        eq(accountContactSuggestions.status, "pending"),
        and(
          eq(accountContactSuggestions.status, "snoozed"),
          lte(accountContactSuggestions.snoozedUntil, new Date()),
        ),
      ),
    ];
    if (ownerScope && ownerScope.length > 0) {
      whereClauses.push(inArray(companies.salesPersonId, ownerScope));
    } else if (ownerScope && ownerScope.length === 0) {
      // Empty scope = user owns nothing → return nothing rather than everything.
      return [];
    }
    const rows = await db
      .select({
        accountId: accountContactSuggestions.accountId,
        accountName: companies.name,
        pendingCount: sql<number>`count(*)::int`,
      })
      .from(accountContactSuggestions)
      .innerJoin(companies, eq(companies.id, accountContactSuggestions.accountId))
      .where(and(...whereClauses))
      .groupBy(accountContactSuggestions.accountId, companies.name);
    return rows as { accountId: string; accountName: string; pendingCount: number }[];
  }

  async getAccountContactSuggestion(id: string): Promise<AccountContactSuggestion | undefined> {
    const [row] = await db.select()
      .from(accountContactSuggestions)
      .where(eq(accountContactSuggestions.id, id))
      .limit(1);
    return row;
  }

  async updateAccountContactSuggestionStatus(
    id: string,
    status: string,
    opts: { userId?: string; snoozedUntil?: Date | null },
  ): Promise<AccountContactSuggestion | undefined> {
    const now = new Date();
    const [updated] = await db
      .update(accountContactSuggestions)
      .set({
        status,
        actedByUserId: opts.userId ?? null,
        snoozedUntil: opts.snoozedUntil ?? null,
        updatedAt: now,
      })
      .where(eq(accountContactSuggestions.id, id))
      .returning();
    return updated;
  }

  async getContactByEmailAndCompany(email: string, companyId: string): Promise<import('@shared/schema').Contact | undefined> {
    const [contact] = await db.select()
      .from(contacts)
      .where(and(
        eq(contacts.companyId, companyId),
        eq(contacts.email, email.toLowerCase()),
      ))
      .limit(1);
    return contact;
  }

  // ── Email Conversation Threads (Task #202) ───────────────────────────────────

  async upsertEmailConversationThread(data: {
    orgId: string;
    threadId: string;
    linkedAccountId?: string | null;
    linkedCarrierId?: string | null;
    update: Partial<InsertEmailConversationThread>;
  }): Promise<EmailConversationThread> {
    const existing = await this.getEmailConversationThreadByThreadId(data.orgId, data.threadId);

    if (existing) {
      // Task #727 — customer-wins precedence on the UPDATE branch.
      // The caller supplies the latest evidence as data.linkedAccountId /
      // data.linkedCarrierId. Without this block the existing-row branch
      // ignored both and a thread that was first created as carrier-linked
      // (e.g. in the shared-mailbox lane) would never adopt customer
      // linkage even after later customer-evidence messages arrived. Rules:
      //   - If new evidence supplies a customer account AND the existing
      //     row has none, adopt it and force the carrier to NULL.
      //   - If the existing row already has any customer account
      //     (whether the new evidence supplies one or not), keep that
      //     account and force the carrier to NULL — customer always wins.
      //   - Otherwise leave linkage as-is.
      const linkPatch: { linkedAccountId?: string | null; linkedCarrierId?: string | null } = {};
      if (data.linkedAccountId && !existing.linkedAccountId) {
        linkPatch.linkedAccountId = data.linkedAccountId;
        linkPatch.linkedCarrierId = null;
      } else if (existing.linkedAccountId && existing.linkedCarrierId) {
        linkPatch.linkedCarrierId = null;
      }
      const [updated] = await db.update(emailConversationThreads)
        .set({ ...data.update, ...linkPatch, updatedAt: new Date() })
        .where(eq(emailConversationThreads.id, existing.id))
        .returning();
      return updated;
    }

    // Insert new thread
    const [inserted] = await db.insert(emailConversationThreads).values({
      orgId: data.orgId,
      threadId: data.threadId,
      linkedAccountId: data.linkedAccountId ?? null,
      linkedCarrierId: data.linkedCarrierId ?? null,
      waitingState: "waiting_on_us",
      responsePriority: "normal",
      ...data.update,
    }).returning();
    return inserted;
  }

  async getEmailConversationThreadById(id: string): Promise<EmailConversationThread | undefined> {
    const [row] = await db.select().from(emailConversationThreads)
      .where(eq(emailConversationThreads.id, id))
      .limit(1);
    return row;
  }

  async getEmailConversationThreadByThreadId(orgId: string, threadId: string): Promise<EmailConversationThread | undefined> {
    const [row] = await db.select().from(emailConversationThreads)
      .where(and(
        eq(emailConversationThreads.orgId, orgId),
        eq(emailConversationThreads.threadId, threadId),
      ))
      .limit(1);
    return row;
  }

  async listEmailConversationThreads(orgId: string, filters: {
    ownerUserId?: string | null;
    ownerUserIdIn?: string[];
    teamAccountIdsIn?: string[];
    unowned?: boolean;
    waitingState?: string;
    responsePriority?: string;
    overdue?: boolean;
    linkedAccountId?: string;
    linkedCarrierId?: string;
    /**
     * High-level "who is this thread with?" filter:
     * - "customers" → threads linked to a customer account (linked_account_id IS NOT NULL)
     * - "carriers"  → threads linked to a carrier (linked_carrier_id IS NOT NULL)
     * Undefined / "all" returns both. Used by the Conversations page audience
     * toggle so reps can flip between customer-facing and carrier-facing inboxes
     * without losing their bucket / filter context.
     */
    audience?: "customers" | "carriers";
    threadId?: string;
    threadIdsIn?: string[];
    limit?: number;
    cursor?: string;
    excludeArchived?: boolean;
    archivedOnly?: boolean;
    snoozedOnly?: boolean;
    includeSnoozed?: boolean;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    sort?: "priority" | "recency";
  }): Promise<{ threads: EmailConversationThread[]; nextCursor: string | null; totalCount: number }> {
    const conditions: SQL[] = [eq(emailConversationThreads.orgId, orgId)];

    if (filters.archivedOnly) {
      conditions.push(isNotNull(emailConversationThreads.archivedAt));
    } else if (filters.excludeArchived !== false) {
      conditions.push(isNull(emailConversationThreads.archivedAt));
    }

    // ─── Snooze filtering (Task #533) ────────────────────────────────────────
    // - snoozedOnly=true   → only threads currently snoozed (the "Snoozed" bucket)
    // - includeSnoozed=true→ return everything including snoozed
    // - default            → exclude snoozed threads from the active inbox
    //   buckets so reps don't see threads they explicitly deferred. We also
    //   skip this exclusion when the caller is filtering by a specific
    //   threadId (deep-link lookup needs to find a snoozed thread).
    if (filters.snoozedOnly) {
      conditions.push(eq(emailConversationThreads.waitingState, "snoozed"));
    } else if (!filters.includeSnoozed && !filters.threadId) {
      conditions.push(sql`${emailConversationThreads.waitingState} != 'snoozed'`);
    }

    if (filters.unowned === true) {
      conditions.push(isNull(emailConversationThreads.ownerUserId));
    } else if (filters.ownerUserId !== undefined && filters.ownerUserId !== null) {
      conditions.push(eq(emailConversationThreads.ownerUserId, filters.ownerUserId));
    }

    if (filters.ownerUserIdIn) {
      if (filters.ownerUserIdIn.length === 0) {
        conditions.push(sql`false`);
      } else {
        // Team-scoped views include: (a) threads owned by team members, (b)
        // unowned threads (so managers can see and claim unassigned work), and
        // (c) threads linked to companies whose salesperson is on the team —
        // covers the common case where auto-sync created a thread without
        // ever stamping an owner on it, but the account itself is assigned.
        const teamOrs: SQL[] = [
          inArray(emailConversationThreads.ownerUserId, filters.ownerUserIdIn),
          isNull(emailConversationThreads.ownerUserId),
        ];
        if (filters.teamAccountIdsIn && filters.teamAccountIdsIn.length > 0) {
          teamOrs.push(inArray(emailConversationThreads.linkedAccountId, filters.teamAccountIdsIn));
        }
        conditions.push(or(...teamOrs)!);
      }
    }

    if (filters.waitingState) {
      conditions.push(eq(emailConversationThreads.waitingState, filters.waitingState));
    }

    if (filters.responsePriority) {
      conditions.push(eq(emailConversationThreads.responsePriority, filters.responsePriority));
    }

    if (filters.overdue === true) {
      conditions.push(isNotNull(emailConversationThreads.overdueAt));
      conditions.push(lte(emailConversationThreads.overdueAt, new Date()));
    }

    if (filters.linkedAccountId) {
      conditions.push(eq(emailConversationThreads.linkedAccountId, filters.linkedAccountId));
    }

    if (filters.linkedCarrierId) {
      conditions.push(eq(emailConversationThreads.linkedCarrierId, filters.linkedCarrierId));
    }

    // Audience toggle: customer-facing vs carrier-facing inbox slice. We
    // intentionally key off the link columns (not message direction) so a
    // customer thread without an account linkage doesn't accidentally show
    // up under "Customers" — better to under-count than to leak the wrong
    // audience.
    if (filters.audience === "customers") {
      conditions.push(isNotNull(emailConversationThreads.linkedAccountId));
    } else if (filters.audience === "carriers") {
      conditions.push(isNotNull(emailConversationThreads.linkedCarrierId));
    }

    if (filters.threadId) {
      conditions.push(eq(emailConversationThreads.threadId, filters.threadId));
    }

    if (filters.threadIdsIn) {
      if (filters.threadIdsIn.length === 0) {
        conditions.push(sql`false`);
      } else {
        conditions.push(inArray(emailConversationThreads.threadId, filters.threadIdsIn));
      }
    }

    // Date filter — Task #859: anchor to the denormalized
    // `last_email_at` column (single source of truth for "real email
    // activity", kept in sync by applyMessageToThread + the freshness
    // backfill in runMigrations). Replaces the GREATEST(...) predicate
    // Task #858 introduced — the row label, the date filter, and any
    // offline reports now all read from the same column. Archived
    // bucket keeps anchoring on archived_at.
    if (filters.dateFrom || filters.dateTo) {
      const isPlainDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (filters.archivedOnly) {
        if (filters.dateFrom) {
          conditions.push(gte(emailConversationThreads.archivedAt, new Date(filters.dateFrom)));
        }
        if (filters.dateTo) {
          const endOfDay = new Date(filters.dateTo);
          if (isPlainDate(filters.dateTo)) endOfDay.setUTCHours(23, 59, 59, 999);
          conditions.push(lte(emailConversationThreads.archivedAt, endOfDay));
        }
      } else {
        if (filters.dateFrom) {
          conditions.push(gte(emailConversationThreads.lastEmailAt, new Date(filters.dateFrom)));
        }
        if (filters.dateTo) {
          const endOfDay = new Date(filters.dateTo);
          if (isPlainDate(filters.dateTo)) endOfDay.setUTCHours(23, 59, 59, 999);
          conditions.push(lte(emailConversationThreads.lastEmailAt, endOfDay));
        }
      }
    }

    if (filters.search) {
      const searchPattern = `%${filters.search}%`;
      const accountIds = await db.select({ id: companies.id }).from(companies)
        .where(and(eq(companies.organizationId, orgId), ilike(companies.name, searchPattern)));
      const carrierIds = await db.select({ id: carriers.id }).from(carriers)
        .where(and(eq(carriers.orgId, orgId), ilike(carriers.name, searchPattern)));
      const matchingMsgThreadIds = await db.select({ threadId: emailMessages.threadId }).from(emailMessages)
        .where(and(eq(emailMessages.orgId, orgId), ilike(emailMessages.subject, searchPattern)));

      const searchConditions: SQL[] = [];
      if (accountIds.length > 0) {
        searchConditions.push(inArray(emailConversationThreads.linkedAccountId, accountIds.map(a => a.id)));
      }
      if (carrierIds.length > 0) {
        searchConditions.push(inArray(emailConversationThreads.linkedCarrierId, carrierIds.map(c => c.id)));
      }
      if (matchingMsgThreadIds.length > 0) {
        const uniqueThreadIds = [...new Set(matchingMsgThreadIds.map(m => m.threadId))].filter((t): t is string => t !== null);
        if (uniqueThreadIds.length > 0) {
          searchConditions.push(inArray(emailConversationThreads.threadId, uniqueThreadIds));
        }
      }

      if (searchConditions.length > 0) {
        conditions.push(or(...searchConditions)!);
      } else {
        conditions.push(sql`false`);
      }
    }

    const [countResult] = await db.select({ count: sql<number>`count(*)` })
      .from(emailConversationThreads)
      .where(and(...conditions));
    const totalCount = Number(countResult?.count ?? 0);

    const pageLimit = filters.limit ?? 50;

    if (filters.archivedOnly) {
      if (filters.cursor) {
        const [cursorTime, cursorId] = filters.cursor.split('|');
        if (cursorTime && cursorId) {
          conditions.push(
            or(
              sql`${emailConversationThreads.archivedAt} < ${new Date(cursorTime)}`,
              and(
                sql`${emailConversationThreads.archivedAt} = ${new Date(cursorTime)}`,
                sql`${emailConversationThreads.id} < ${cursorId}`,
              ),
            )!,
          );
        }
      }

      const rows = await db.select().from(emailConversationThreads)
        .where(and(...conditions))
        .orderBy(desc(emailConversationThreads.archivedAt), desc(emailConversationThreads.id))
        .limit(pageLimit + 1);

      const hasMore = rows.length > pageLimit;
      const threads = hasMore ? rows.slice(0, pageLimit) : rows;
      let nextCursor: string | null = null;
      if (hasMore && threads.length > 0) {
        const last = threads[threads.length - 1];
        nextCursor = `${(last.archivedAt ?? last.updatedAt).toISOString()}|${last.id}`;
      }
      return { threads, nextCursor, totalCount };
    }

    // Recency sort: simple "newest first" ordering by updated_at. Used by the
    // "All" tab where users expect a chronological firehose, not a triage
    // queue. Cursor format is "recency|<updatedAt>|<id>".
    if (filters.sort === "recency") {
      if (filters.cursor) {
        const parts = filters.cursor.split('|');
        if (parts.length === 3 && parts[0] === "recency") {
          const cursorUpd = new Date(parts[1]);
          const cursorId = parts[2];
          conditions.push(
            or(
              sql`${emailConversationThreads.updatedAt} < ${cursorUpd}`,
              and(
                sql`${emailConversationThreads.updatedAt} = ${cursorUpd}`,
                sql`${emailConversationThreads.id} < ${cursorId}`,
              ),
            )!,
          );
        }
      }

      const rows = await db.select().from(emailConversationThreads)
        .where(and(...conditions))
        .orderBy(desc(emailConversationThreads.updatedAt), desc(emailConversationThreads.id))
        .limit(pageLimit + 1);

      const hasMore = rows.length > pageLimit;
      const threads = hasMore ? rows.slice(0, pageLimit) : rows;
      let nextCursor: string | null = null;
      if (hasMore && threads.length > 0) {
        const last = threads[threads.length - 1];
        nextCursor = `recency|${last.updatedAt.toISOString()}|${last.id}`;
      }

      return { threads, nextCursor, totalCount };
    }

    if (filters.cursor) {
      const parts = filters.cursor.split('|');
      if (parts.length === 4) {
        const [cursorOverdueFlag, cursorWaiting, cursorUpdated, cursorId] = parts;
        const cursorOvRank = parseInt(cursorOverdueFlag, 10);
        const cursorUpd = new Date(cursorUpdated);

        if (cursorWaiting === "null") {
          conditions.push(
            sql`(
              (CASE WHEN ${emailConversationThreads.overdueAt} IS NOT NULL THEN 0 ELSE 1 END) > ${cursorOvRank}
              OR (
                (CASE WHEN ${emailConversationThreads.overdueAt} IS NOT NULL THEN 0 ELSE 1 END) = ${cursorOvRank}
                AND ${emailConversationThreads.waitingSinceAt} IS NULL
                AND (
                  ${emailConversationThreads.updatedAt} < ${cursorUpd}
                  OR (${emailConversationThreads.updatedAt} = ${cursorUpd} AND ${emailConversationThreads.id} < ${cursorId})
                )
              )
            )`,
          );
        } else {
          const cursorWs = new Date(cursorWaiting);
          conditions.push(
            sql`(
              (CASE WHEN ${emailConversationThreads.overdueAt} IS NOT NULL THEN 0 ELSE 1 END) > ${cursorOvRank}
              OR (
                (CASE WHEN ${emailConversationThreads.overdueAt} IS NOT NULL THEN 0 ELSE 1 END) = ${cursorOvRank}
                AND (
                  (${emailConversationThreads.waitingSinceAt} IS NOT NULL AND ${emailConversationThreads.waitingSinceAt} > ${cursorWs})
                  OR (
                    ${emailConversationThreads.waitingSinceAt} = ${cursorWs}
                    AND (
                      ${emailConversationThreads.updatedAt} < ${cursorUpd}
                      OR (${emailConversationThreads.updatedAt} = ${cursorUpd} AND ${emailConversationThreads.id} < ${cursorId})
                    )
                  )
                  OR ${emailConversationThreads.waitingSinceAt} IS NULL
                )
              )
            )`,
          );
        }
      }
    }

    const rows = await db.select().from(emailConversationThreads)
      .where(and(...conditions))
      .orderBy(
        sql`CASE WHEN ${emailConversationThreads.overdueAt} IS NOT NULL THEN 0 ELSE 1 END ASC`,
        sql`${emailConversationThreads.waitingSinceAt} ASC NULLS LAST`,
        desc(emailConversationThreads.updatedAt),
        desc(emailConversationThreads.id),
      )
      .limit(pageLimit + 1);

    const hasMore = rows.length > pageLimit;
    const threads = hasMore ? rows.slice(0, pageLimit) : rows;
    let nextCursor: string | null = null;
    if (hasMore && threads.length > 0) {
      const last = threads[threads.length - 1];
      const ovRank = last.overdueAt ? 0 : 1;
      const ws = last.waitingSinceAt ? last.waitingSinceAt.toISOString() : "null";
      nextCursor = `${ovRank}|${ws}|${last.updatedAt.toISOString()}|${last.id}`;
    }

    return { threads, nextCursor, totalCount };
  }

  async updateEmailConversationThread(id: string, orgId: string, data: Partial<InsertEmailConversationThread>): Promise<EmailConversationThread | undefined> {
    const [row] = await db.update(emailConversationThreads)
      .set({ ...data, updatedAt: new Date() })
      .where(and(
        eq(emailConversationThreads.id, id),
        eq(emailConversationThreads.orgId, orgId),
      ))
      .returning();
    return row;
  }

  // ─── Per-user thread read state (Task #532) ─────────────────────────────────

  async getEmailConversationReadStates(userId: string, threadIds: string[]): Promise<Map<string, Date | null>> {
    const result = new Map<string, Date | null>();
    if (!userId || threadIds.length === 0) return result;
    const rows = await db.select({
      threadId: emailConversationReadStates.threadId,
      lastReadAt: emailConversationReadStates.lastReadAt,
    })
      .from(emailConversationReadStates)
      .where(and(
        eq(emailConversationReadStates.userId, userId),
        inArray(emailConversationReadStates.threadId, threadIds),
      ));
    for (const r of rows) {
      result.set(r.threadId, r.lastReadAt);
    }
    return result;
  }

  async markEmailConversationThreadRead(orgId: string, userId: string, threadId: string, when: Date = new Date()): Promise<void> {
    if (!userId || !threadId) return;
    await db.insert(emailConversationReadStates)
      .values({ orgId, userId, threadId, lastReadAt: when })
      .onConflictDoUpdate({
        target: [emailConversationReadStates.userId, emailConversationReadStates.threadId],
        set: { lastReadAt: when, updatedAt: new Date() },
      });
  }

  async markEmailConversationThreadUnread(orgId: string, userId: string, threadId: string): Promise<void> {
    if (!userId || !threadId) return;
    // Setting lastReadAt to NULL means "the user has not viewed this thread
    // since its most recent inbound message", which the unread computation
    // (lastIncomingAt > lastReadAt) treats as unread.
    await db.insert(emailConversationReadStates)
      .values({ orgId, userId, threadId, lastReadAt: null })
      .onConflictDoUpdate({
        target: [emailConversationReadStates.userId, emailConversationReadStates.threadId],
        set: { lastReadAt: null, updatedAt: new Date() },
      });
  }

  // ─── Per-user saved views (Task #533) ──────────────────────────────────────

  async listConversationSavedViews(userId: string): Promise<ConversationSavedView[]> {
    if (!userId) return [];
    return db.select().from(conversationSavedViews)
      .where(eq(conversationSavedViews.userId, userId))
      .orderBy(asc(conversationSavedViews.sortOrder), asc(conversationSavedViews.createdAt));
  }

  async getConversationSavedView(id: string): Promise<ConversationSavedView | undefined> {
    const [row] = await db.select().from(conversationSavedViews)
      .where(eq(conversationSavedViews.id, id))
      .limit(1);
    return row;
  }

  async createConversationSavedView(data: InsertConversationSavedView): Promise<ConversationSavedView> {
    // Append new views to the end of the user's list so they don't displace
    // the existing ordering. We compute the next sortOrder atomically.
    const [maxRow] = await db.select({ max: sql<number>`COALESCE(MAX(${conversationSavedViews.sortOrder}), -1)` })
      .from(conversationSavedViews)
      .where(eq(conversationSavedViews.userId, data.userId));
    const nextSortOrder = (Number(maxRow?.max ?? -1)) + 1;
    const [row] = await db.insert(conversationSavedViews)
      .values({ ...data, sortOrder: data.sortOrder ?? nextSortOrder })
      .returning();
    return row;
  }

  async updateConversationSavedView(
    id: string,
    userId: string,
    data: Partial<InsertConversationSavedView>,
  ): Promise<ConversationSavedView | undefined> {
    const [row] = await db.update(conversationSavedViews)
      .set({ ...data, updatedAt: new Date() })
      .where(and(
        eq(conversationSavedViews.id, id),
        eq(conversationSavedViews.userId, userId),
      ))
      .returning();
    return row;
  }

  async deleteConversationSavedView(id: string, userId: string): Promise<boolean> {
    const rows = await db.delete(conversationSavedViews)
      .where(and(
        eq(conversationSavedViews.id, id),
        eq(conversationSavedViews.userId, userId),
      ))
      .returning({ id: conversationSavedViews.id });
    return rows.length > 0;
  }

  async reorderConversationSavedViews(userId: string, orderedIds: string[]): Promise<void> {
    if (!userId || orderedIds.length === 0) return;
    // Update in a single round-trip using a CASE expression. Only views the
    // user owns AND that appear in the requested order list are touched —
    // anything else is left as-is so a stale client can't accidentally
    // renumber another user's views (defence in depth alongside the userId
    // predicate).
    const cases = orderedIds.map((id, idx) => sql`WHEN ${id} THEN ${idx}`);
    await db.update(conversationSavedViews)
      .set({
        sortOrder: sql`CASE ${conversationSavedViews.id} ${sql.join(cases, sql` `)} ELSE ${conversationSavedViews.sortOrder} END`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(conversationSavedViews.userId, userId),
        inArray(conversationSavedViews.id, orderedIds),
      ));
  }

  // ─── Wake snoozed threads (Task #533) ──────────────────────────────────────

  async findExpiredSnoozedThreads(now: Date = new Date()): Promise<EmailConversationThread[]> {
    return db.select().from(emailConversationThreads)
      .where(and(
        eq(emailConversationThreads.waitingState, "snoozed"),
        isNotNull(emailConversationThreads.snoozedUntil),
        lte(emailConversationThreads.snoozedUntil, now),
      ));
  }

  // ─── Geographic Lane Patterns (Task #203) ──────────────────────────────────

  async getGeographicLanePatterns(orgId?: string): Promise<GeographicLanePattern[]> {
    const conditions = [];
    if (orgId) {
      conditions.push(or(eq(geographicLanePatterns.orgId, orgId), isNull(geographicLanePatterns.orgId)));
    }
    const rows = conditions.length > 0
      ? await db.select().from(geographicLanePatterns).where(and(...conditions))
      : await db.select().from(geographicLanePatterns);
    return rows;
  }

  async getGeographicLanePattern(id: string): Promise<GeographicLanePattern | undefined> {
    const [row] = await db.select().from(geographicLanePatterns).where(eq(geographicLanePatterns.id, id)).limit(1);
    return row;
  }

  async createGeographicLanePattern(data: InsertGeographicLanePattern): Promise<GeographicLanePattern> {
    const { randomUUID } = await import("crypto");
    const [row] = await db.insert(geographicLanePatterns).values({ id: randomUUID(), ...data }).returning();
    return row;
  }

  async seedBaselinePatterns(): Promise<void> {
    const { BASELINE_LANE_PATTERNS } = await import("./geographicLanePatternUtils");
    const { randomUUID } = await import("crypto");
    const existing = await db.select({ name: geographicLanePatterns.name, isBaseline: geographicLanePatterns.isBaseline })
      .from(geographicLanePatterns)
      .where(eq(geographicLanePatterns.isBaseline, true));
    const existingNames = new Set(existing.map(r => r.name));
    const toInsert = BASELINE_LANE_PATTERNS.filter(p => !existingNames.has(p.name));
    if (toInsert.length === 0) return;
    await db.insert(geographicLanePatterns).values(
      toInsert.map(p => ({
        id: randomUUID(),
        name: p.name,
        originRegion: p.originRegion,
        destinationRegion: p.destinationRegion,
        namedCorridor: p.namedCorridor,
        description: p.description,
        isBaseline: true,
        orgId: null,
      })),
    );
    console.log(`[geographicLanePatterns] seeded ${toInsert.length} baseline patterns`);
  }

  // ─── Account Contact Lane Pattern Responsibilities (Task #203) ─────────────

  async createResponsibility(
    data: Omit<InsertAccountContactLanePatternResponsibility, 'evidenceEventKeys' | 'sourceTypes'> & {
      evidenceEventKeys?: string[];
      sourceTypes?: string[];
    },
  ): Promise<AccountContactLanePatternResponsibility> {
    const { randomUUID } = await import("crypto");
    const [row] = await db.insert(accountContactLanePatternResponsibilities).values({
      id: randomUUID(),
      ...data,
      evidenceEventKeys: data.evidenceEventKeys ?? [],
      sourceTypes: data.sourceTypes ?? [],
    }).returning();
    return row;
  }

  async updateResponsibility(
    id: string,
    data: Partial<AccountContactLanePatternResponsibility>,
  ): Promise<AccountContactLanePatternResponsibility> {
    const [row] = await db.update(accountContactLanePatternResponsibilities)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(accountContactLanePatternResponsibilities.id, id))
      .returning();
    return row;
  }

  async getResponsibilityByKey(
    accountId: string,
    contactId: string,
    lanePatternId: string,
  ): Promise<AccountContactLanePatternResponsibility | undefined> {
    const [row] = await db.select()
      .from(accountContactLanePatternResponsibilities)
      .where(and(
        eq(accountContactLanePatternResponsibilities.accountId, accountId),
        eq(accountContactLanePatternResponsibilities.contactId, contactId),
        eq(accountContactLanePatternResponsibilities.lanePatternId, lanePatternId),
      ))
      .limit(1);
    return row;
  }

  async getResponsibilitiesByAccount(
    accountId: string,
    filters?: {
      contactId?: string;
      lanePatternId?: string;
      status?: string;
      minConfidence?: number;
      responsibilityType?: string;
    },
  ): Promise<AccountContactLanePatternResponsibility[]> {
    const conditions: SQL[] = [eq(accountContactLanePatternResponsibilities.accountId, accountId)];
    if (filters?.contactId) conditions.push(eq(accountContactLanePatternResponsibilities.contactId, filters.contactId));
    if (filters?.lanePatternId) conditions.push(eq(accountContactLanePatternResponsibilities.lanePatternId, filters.lanePatternId));
    if (filters?.status) conditions.push(eq(accountContactLanePatternResponsibilities.status, filters.status));
    if (filters?.minConfidence !== undefined) conditions.push(gte(accountContactLanePatternResponsibilities.confidenceScore, filters.minConfidence));
    if (filters?.responsibilityType) conditions.push(eq(accountContactLanePatternResponsibilities.responsibilityType, filters.responsibilityType));
    return db.select().from(accountContactLanePatternResponsibilities).where(and(...conditions))
      .orderBy(desc(accountContactLanePatternResponsibilities.confidenceScore));
  }

  async getResponsibilitiesByContact(
    contactId: string,
    filters?: {
      accountId?: string;
      status?: string;
      minConfidence?: number;
      responsibilityType?: string;
    },
  ): Promise<AccountContactLanePatternResponsibility[]> {
    const conditions: SQL[] = [eq(accountContactLanePatternResponsibilities.contactId, contactId)];
    if (filters?.accountId) conditions.push(eq(accountContactLanePatternResponsibilities.accountId, filters.accountId));
    if (filters?.status) conditions.push(eq(accountContactLanePatternResponsibilities.status, filters.status));
    if (filters?.minConfidence !== undefined) conditions.push(gte(accountContactLanePatternResponsibilities.confidenceScore, filters.minConfidence));
    if (filters?.responsibilityType) conditions.push(eq(accountContactLanePatternResponsibilities.responsibilityType, filters.responsibilityType));
    return db.select().from(accountContactLanePatternResponsibilities).where(and(...conditions))
      .orderBy(desc(accountContactLanePatternResponsibilities.confidenceScore));
  }

  async getResponsibility(id: string): Promise<AccountContactLanePatternResponsibility | undefined> {
    const [row] = await db.select()
      .from(accountContactLanePatternResponsibilities)
      .where(eq(accountContactLanePatternResponsibilities.id, id))
      .limit(1);
    return row;
  }

  async confirmResponsibility(id: string, userId: string): Promise<AccountContactLanePatternResponsibility | undefined> {
    const [row] = await db.update(accountContactLanePatternResponsibilities)
      .set({
        status: "confirmed",
        lastReviewedAt: new Date(),
        lastReviewedByUserId: userId,
        updatedAt: new Date(),
      })
      .where(eq(accountContactLanePatternResponsibilities.id, id))
      .returning();
    return row;
  }

  async dismissResponsibility(id: string, userId: string): Promise<AccountContactLanePatternResponsibility | undefined> {
    const [row] = await db.update(accountContactLanePatternResponsibilities)
      .set({
        status: "dismissed",
        lastReviewedAt: new Date(),
        lastReviewedByUserId: userId,
        updatedAt: new Date(),
      })
      .where(eq(accountContactLanePatternResponsibilities.id, id))
      .returning();
    return row;
  }

  // ── Contact Geography Suggestions (Task #225) ──────────────────────────────

  async upsertContactGeographySuggestion(data: InsertContactGeographySuggestion): Promise<ContactGeographySuggestion> {
    const now = new Date();
    const conditions: SQL[] = [
      eq(contactGeographySuggestions.accountId, data.accountId),
      eq(contactGeographySuggestions.contactId, data.contactId),
    ];
    if (data.suggestedRegion) {
      conditions.push(eq(contactGeographySuggestions.suggestedRegion, data.suggestedRegion));
    } else {
      conditions.push(isNull(contactGeographySuggestions.suggestedRegion));
    }
    if (data.suggestedLane) {
      conditions.push(eq(contactGeographySuggestions.suggestedLane, data.suggestedLane));
    } else {
      conditions.push(isNull(contactGeographySuggestions.suggestedLane));
    }

    const [existing] = await db.select()
      .from(contactGeographySuggestions)
      .where(and(...conditions))
      .limit(1);

    if (existing) {
      if (existing.status === "dismissed" || existing.status === "rejected") {
        return existing;
      }
      const [updated] = await db.update(contactGeographySuggestions)
        .set({
          confidenceScore: Math.max(existing.confidenceScore, data.confidenceScore ?? 50),
          sourceEvidence: data.sourceEvidence ?? existing.sourceEvidence,
          updatedAt: now,
        })
        .where(eq(contactGeographySuggestions.id, existing.id))
        .returning();
      return updated;
    }

    const [inserted] = await db.insert(contactGeographySuggestions)
      .values({ ...data, createdAt: now, updatedAt: now })
      .returning();
    return inserted;
  }

  async getContactGeographySuggestions(
    accountId: string,
    filters?: { contactId?: string; status?: string },
  ): Promise<ContactGeographySuggestion[]> {
    const conditions: SQL[] = [eq(contactGeographySuggestions.accountId, accountId)];
    if (filters?.contactId) conditions.push(eq(contactGeographySuggestions.contactId, filters.contactId));
    if (filters?.status) conditions.push(eq(contactGeographySuggestions.status, filters.status));
    return db.select()
      .from(contactGeographySuggestions)
      .where(and(...conditions))
      .orderBy(desc(contactGeographySuggestions.confidenceScore), desc(contactGeographySuggestions.createdAt));
  }

  async getContactGeographySuggestion(id: string): Promise<ContactGeographySuggestion | undefined> {
    const [row] = await db.select()
      .from(contactGeographySuggestions)
      .where(eq(contactGeographySuggestions.id, id))
      .limit(1);
    return row;
  }

  async updateContactGeographySuggestionStatus(
    id: string,
    status: string,
    opts: { userId?: string },
  ): Promise<ContactGeographySuggestion | undefined> {
    const [updated] = await db.update(contactGeographySuggestions)
      .set({
        status,
        actedByUserId: opts.userId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(contactGeographySuggestions.id, id))
      .returning();
    return updated;
  }

  // ── Pinned Companies (Task #206) ──────────────────────────────────────────
  async getPinnedCompanies(userId: string): Promise<PinnedCompany[]> {
    return db.select().from(pinnedCompanies).where(eq(pinnedCompanies.userId, userId)).orderBy(desc(pinnedCompanies.pinnedAt));
  }

  async pinCompany(userId: string, companyId: string): Promise<PinnedCompany> {
    const existing = await db.select().from(pinnedCompanies).where(and(eq(pinnedCompanies.userId, userId), eq(pinnedCompanies.companyId, companyId)));
    if (existing.length > 0) return existing[0];
    const [row] = await db.insert(pinnedCompanies).values({ userId, companyId }).returning();
    return row;
  }

  async unpinCompany(userId: string, companyId: string): Promise<boolean> {
    const result = await db.delete(pinnedCompanies).where(and(eq(pinnedCompanies.userId, userId), eq(pinnedCompanies.companyId, companyId)));
    return (result.rowCount ?? 0) > 0;
  }

  async isPinnedCompany(userId: string, companyId: string): Promise<boolean> {
    const rows = await db.select().from(pinnedCompanies).where(and(eq(pinnedCompanies.userId, userId), eq(pinnedCompanies.companyId, companyId)));
    return rows.length > 0;
  }

  // ── Monitored Mailboxes (Task #230) ─────────────────────────────────────────

  async getMonitoredMailboxes(orgId: string): Promise<MonitoredMailbox[]> {
    return db.select().from(monitoredMailboxes)
      .where(eq(monitoredMailboxes.orgId, orgId))
      .orderBy(asc(monitoredMailboxes.createdAt));
  }

  async getMonitoredMailbox(id: string): Promise<MonitoredMailbox | undefined> {
    const [row] = await db.select().from(monitoredMailboxes)
      .where(eq(monitoredMailboxes.id, id))
      .limit(1);
    return row;
  }

  async getMonitoredMailboxByEmail(orgId: string, email: string): Promise<MonitoredMailbox | undefined> {
    const [row] = await db.select().from(monitoredMailboxes)
      .where(and(
        eq(monitoredMailboxes.orgId, orgId),
        eq(monitoredMailboxes.email, email.toLowerCase()),
      ))
      .limit(1);
    return row;
  }

  async getEnabledMonitoredMailboxes(orgId?: string): Promise<MonitoredMailbox[]> {
    if (orgId) {
      return db.select().from(monitoredMailboxes)
        .where(and(
          eq(monitoredMailboxes.enabled, true),
          eq(monitoredMailboxes.orgId, orgId),
        ));
    }
    return db.select().from(monitoredMailboxes)
      .where(eq(monitoredMailboxes.enabled, true));
  }

  async createMonitoredMailbox(data: InsertMonitoredMailbox): Promise<MonitoredMailbox> {
    const [row] = await db.insert(monitoredMailboxes).values({
      ...data,
      email: data.email.toLowerCase(),
    }).returning();
    return row;
  }

  async updateMonitoredMailbox(id: string, data: Partial<InsertMonitoredMailbox>): Promise<MonitoredMailbox | undefined> {
    const [row] = await db.update(monitoredMailboxes)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(monitoredMailboxes.id, id))
      .returning();
    return row;
  }

  async deleteMonitoredMailbox(id: string): Promise<boolean> {
    const result = await db.delete(monitoredMailboxes).where(eq(monitoredMailboxes.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async getUserByEmailAddress(email: string, orgId: string): Promise<User | undefined> {
    const [row] = await db.select().from(users)
      .where(and(
        eq(users.organizationId, orgId),
        eq(users.username, email.toLowerCase()),
      ))
      .limit(1);
    return row;
  }

  async getMonitoredMailboxBySubscriptionId(subscriptionId: string): Promise<MonitoredMailbox | undefined> {
    const [row] = await db.select().from(monitoredMailboxes)
      .where(eq(monitoredMailboxes.subscriptionId, subscriptionId))
      .limit(1);
    return row;
  }

  async getMonitoredMailboxByAnySubscriptionId(subscriptionId: string): Promise<MonitoredMailbox | undefined> {
    const [row] = await db.select().from(monitoredMailboxes)
      .where(or(
        eq(monitoredMailboxes.subscriptionId, subscriptionId),
        eq(monitoredMailboxes.sentItemsSubscriptionId, subscriptionId),
      ))
      .limit(1);
    return row;
  }

  // ── Mailbox sync failures (Task #438) ───────────────────────────────────────

  async upsertMailboxSyncFailure(data: {
    orgId: string;
    mailboxId: string;
    folder: string;
    providerMessageId: string;
    errorCategory: string;
    errorMessage: string;
    nextAttemptAt: Date | null;
  }): Promise<MailboxSyncFailure> {
    const now = new Date();
    const truncatedMsg = data.errorMessage.slice(0, 1000);
    const [row] = await db
      .insert(mailboxSyncFailures)
      .values({
        orgId: data.orgId,
        mailboxId: data.mailboxId,
        folder: data.folder,
        providerMessageId: data.providerMessageId,
        errorCategory: data.errorCategory,
        errorMessage: truncatedMsg,
        attemptCount: 1,
        status: "pending",
        firstSeenAt: now,
        lastAttemptAt: now,
        nextAttemptAt: data.nextAttemptAt,
      })
      .onConflictDoUpdate({
        target: [mailboxSyncFailures.mailboxId, mailboxSyncFailures.folder, mailboxSyncFailures.providerMessageId],
        set: {
          errorCategory: data.errorCategory,
          errorMessage: truncatedMsg,
          attemptCount: sql`${mailboxSyncFailures.attemptCount} + 1`,
          lastAttemptAt: now,
          nextAttemptAt: data.nextAttemptAt,
          status: sql`CASE WHEN ${mailboxSyncFailures.status} = 'dismissed' THEN 'dismissed' ELSE 'pending' END`,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  async markMailboxSyncFailureResolved(mailboxId: string, folder: string, providerMessageId: string): Promise<void> {
    await db
      .update(mailboxSyncFailures)
      .set({ status: "resolved", resolvedAt: new Date(), nextAttemptAt: null, updatedAt: new Date() })
      .where(and(
        eq(mailboxSyncFailures.mailboxId, mailboxId),
        eq(mailboxSyncFailures.folder, folder),
        eq(mailboxSyncFailures.providerMessageId, providerMessageId),
        inArray(mailboxSyncFailures.status, ["pending", "give_up"]),
      ));
  }

  async markMailboxSyncFailureResolvedById(id: string): Promise<MailboxSyncFailure | undefined> {
    const [row] = await db
      .update(mailboxSyncFailures)
      .set({ status: "resolved", resolvedAt: new Date(), nextAttemptAt: null, updatedAt: new Date() })
      .where(eq(mailboxSyncFailures.id, id))
      .returning();
    return row;
  }

  async markMailboxSyncFailureDismissed(id: string, orgId: string): Promise<MailboxSyncFailure | undefined> {
    const [row] = await db
      .update(mailboxSyncFailures)
      .set({ status: "dismissed", nextAttemptAt: null, updatedAt: new Date() })
      .where(and(eq(mailboxSyncFailures.id, id), eq(mailboxSyncFailures.orgId, orgId)))
      .returning();
    return row;
  }

  async markMailboxSyncFailureGiveUp(id: string): Promise<void> {
    await db
      .update(mailboxSyncFailures)
      .set({ status: "give_up", nextAttemptAt: null, updatedAt: new Date() })
      .where(eq(mailboxSyncFailures.id, id));
  }

  async getMailboxSyncFailure(id: string): Promise<MailboxSyncFailure | undefined> {
    const [row] = await db.select().from(mailboxSyncFailures).where(eq(mailboxSyncFailures.id, id)).limit(1);
    return row;
  }

  async getUnresolvedMailboxSyncFailures(mailboxId: string): Promise<MailboxSyncFailure[]> {
    return db.select().from(mailboxSyncFailures)
      .where(and(
        eq(mailboxSyncFailures.mailboxId, mailboxId),
        inArray(mailboxSyncFailures.status, ["pending", "give_up"]),
      ))
      .orderBy(desc(mailboxSyncFailures.lastAttemptAt));
  }

  // ─── Cron heartbeats ───────────────────────────────────────────────────
  // upsert-on-start writes pending state and pushes nextExpectedAt forward
  // so the staleness detector can immediately see this job is "alive."
  // upsert-on-finish records duration and resets / increments the failure
  // counter so consecutive errors are observable.
  async recordCronHeartbeatStart(jobName: string, expectedIntervalMs: number): Promise<void> {
    const now = new Date();
    const nextExpectedAt = new Date(now.getTime() + expectedIntervalMs);

    // Reclaim a stuck-"running" heartbeat from a prior tick that never
    // finished (process SIGKILL'd mid-tick, OpenAI hang, infinite loop).
    // Without this, a corpse can sit in `lastStatus="running"` indefinitely
    // and was previously invisible to staleness detection — that's how the
    // email_intelligence_batch went silent for 3 hours on April 28.
    const prior = await db
      .select()
      .from(cronHeartbeats)
      .where(eq(cronHeartbeats.jobName, jobName))
      .limit(1);
    const priorRow = prior[0];
    if (priorRow?.lastStatus === "running" && priorRow.lastStartedAt) {
      const stuckThresholdMs = getStuckRunningThresholdMs(jobName, expectedIntervalMs);
      const ageMs = now.getTime() - priorRow.lastStartedAt.getTime();
      if (ageMs > stuckThresholdMs) {
        console.error(
          `[cron-heartbeat] reclaiming stuck '${jobName}' tick ` +
          `(was running for ${Math.round(ageMs / 60000)}m, threshold ${Math.round(stuckThresholdMs / 60000)}m)`,
        );
      }
    }

    await db
      .insert(cronHeartbeats)
      .values({
        jobName,
        expectedIntervalMs,
        lastStartedAt: now,
        lastStatus: "running",
        nextExpectedAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: cronHeartbeats.jobName,
        set: {
          expectedIntervalMs,
          lastStartedAt: now,
          lastStatus: "running",
          nextExpectedAt,
          updatedAt: now,
        },
      });
  }

  async recordCronHeartbeatFinish(
    jobName: string,
    status: "success" | "error",
    durationMs: number,
    error?: string,
  ): Promise<void> {
    const now = new Date();
    const existing = await db
      .select()
      .from(cronHeartbeats)
      .where(eq(cronHeartbeats.jobName, jobName))
      .limit(1);
    const consecutiveFailures = status === "error"
      ? (existing[0]?.consecutiveFailures ?? 0) + 1
      : 0;
    await db
      .update(cronHeartbeats)
      .set({
        lastFinishedAt: now,
        lastDurationMs: durationMs,
        lastStatus: status,
        lastError: status === "error" ? (error ?? null) : null,
        consecutiveFailures,
        updatedAt: now,
      })
      .where(eq(cronHeartbeats.jobName, jobName));
  }

  async getCronHeartbeats(): Promise<CronHeartbeat[]> {
    return await db.select().from(cronHeartbeats).orderBy(cronHeartbeats.jobName);
  }

  // A job is "stale" when:
  //   (a) nextExpectedAt + grace has passed AND it isn't mid-tick, OR
  //   (b) it claims to still be "running" but its lastStartedAt is older
  //       than max(expectedIntervalMs * 5, 10 min) — i.e. the prior tick
  //       died without recording a finish (process SIGKILL, OpenAI hang,
  //       infinite loop). Without (b), a corpse heartbeat is invisible
  //       to the pill — that's how email_intelligence_batch went silent
  //       for 3 hours on April 28.
  // graceFactor defaults to 1.5 so a job expected every 5 min isn't
  // flagged until 7.5 min after the last start. Tunable per call site.
  async getStaleCronHeartbeats(graceFactor: number = 1.5): Promise<CronHeartbeat[]> {
    const rows = await db.select().from(cronHeartbeats);
    const now = Date.now();
    return rows.filter(r => {
      // (b) Stuck-running detection.
      if (r.lastStatus === "running") {
        if (!r.lastStartedAt) return false;
        const stuckThresholdMs = getStuckRunningThresholdMs(r.jobName, r.expectedIntervalMs);
        return now - r.lastStartedAt.getTime() > stuckThresholdMs;
      }
      // (a) Standard "next tick is overdue" detection.
      if (!r.nextExpectedAt) return false;
      const grace = r.expectedIntervalMs * (graceFactor - 1);
      return now - r.nextExpectedAt.getTime() > grace;
    });
  }

  async countUnresolvedMailboxSyncFailures(mailboxId: string): Promise<number> {
    const rows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(mailboxSyncFailures)
      .where(and(
        eq(mailboxSyncFailures.mailboxId, mailboxId),
        inArray(mailboxSyncFailures.status, ["pending", "give_up"]),
      ));
    return rows[0]?.c ?? 0;
  }

  async getDueMailboxSyncFailures(now: Date): Promise<MailboxSyncFailure[]> {
    return db.select().from(mailboxSyncFailures)
      .where(and(
        eq(mailboxSyncFailures.status, "pending"),
        lte(mailboxSyncFailures.nextAttemptAt, now),
      ));
  }

  async getDueMailboxSyncFailuresForMailbox(mailboxId: string, now: Date): Promise<MailboxSyncFailure[]> {
    return db.select().from(mailboxSyncFailures)
      .where(and(
        eq(mailboxSyncFailures.mailboxId, mailboxId),
        eq(mailboxSyncFailures.status, "pending"),
        lte(mailboxSyncFailures.nextAttemptAt, now),
      ));
  }

  // ── Mailbox health alerts (Task #867) ───────────────────────────────────────

  async fireMailboxHealthAlert(input: {
    orgId: string;
    mailboxId: string;
    alertKey: string;
    severity?: "info" | "warning" | "critical";
    reason: string;
  }): Promise<{ alert: MailboxHealthAlert; isNew: boolean }> {
    const now = new Date();
    // Look for an existing OPEN row for this (mailbox, alertKey). The
    // partial unique index is "open rows only" so we can do this safely
    // without a composite key on resolvedAt.
    const [existing] = await db
      .select()
      .from(mailboxHealthAlerts)
      .where(and(
        eq(mailboxHealthAlerts.mailboxId, input.mailboxId),
        eq(mailboxHealthAlerts.alertKey, input.alertKey),
        sql`${mailboxHealthAlerts.resolvedAt} IS NULL`,
      ))
      .limit(1);
    if (existing) {
      const [updated] = await db.update(mailboxHealthAlerts)
        .set({
          lastFiredAt: now,
          reason: input.reason.slice(0, 1000),
          severity: input.severity ?? existing.severity,
          updatedAt: now,
        })
        .where(eq(mailboxHealthAlerts.id, existing.id))
        .returning();
      return { alert: updated, isNew: false };
    }
    const [inserted] = await db.insert(mailboxHealthAlerts).values({
      orgId: input.orgId,
      mailboxId: input.mailboxId,
      alertKey: input.alertKey,
      severity: input.severity ?? "warning",
      reason: input.reason.slice(0, 1000),
      firstFiredAt: now,
      lastFiredAt: now,
    }).returning();
    return { alert: inserted, isNew: true };
  }

  async resolveMailboxHealthAlert(mailboxId: string, alertKey: string): Promise<MailboxHealthAlert | undefined> {
    const now = new Date();
    const [row] = await db.update(mailboxHealthAlerts)
      .set({ resolvedAt: now, updatedAt: now })
      .where(and(
        eq(mailboxHealthAlerts.mailboxId, mailboxId),
        eq(mailboxHealthAlerts.alertKey, alertKey),
        sql`${mailboxHealthAlerts.resolvedAt} IS NULL`,
      ))
      .returning();
    return row;
  }

  async getOpenMailboxHealthAlerts(orgId: string): Promise<MailboxHealthAlert[]> {
    return db.select().from(mailboxHealthAlerts)
      .where(and(
        eq(mailboxHealthAlerts.orgId, orgId),
        sql`${mailboxHealthAlerts.resolvedAt} IS NULL`,
      ))
      .orderBy(desc(mailboxHealthAlerts.lastFiredAt));
  }

  async getOpenMailboxHealthAlertsForMailbox(mailboxId: string): Promise<MailboxHealthAlert[]> {
    return db.select().from(mailboxHealthAlerts)
      .where(and(
        eq(mailboxHealthAlerts.mailboxId, mailboxId),
        sql`${mailboxHealthAlerts.resolvedAt} IS NULL`,
      ))
      .orderBy(desc(mailboxHealthAlerts.lastFiredAt));
  }

  // ── Mailbox historical backfills (Task #508) ────────────────────────────────

  async createMailboxHistoricalBackfill(data: InsertMailboxHistoricalBackfill): Promise<MailboxHistoricalBackfill> {
    const [row] = await db.insert(mailboxHistoricalBackfills).values(data).returning();
    return row;
  }

  async updateMailboxHistoricalBackfill(id: string, data: Partial<InsertMailboxHistoricalBackfill>): Promise<MailboxHistoricalBackfill | undefined> {
    const [row] = await db
      .update(mailboxHistoricalBackfills)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(mailboxHistoricalBackfills.id, id))
      .returning();
    return row;
  }

  async getMailboxHistoricalBackfill(id: string): Promise<MailboxHistoricalBackfill | undefined> {
    const [row] = await db.select().from(mailboxHistoricalBackfills)
      .where(eq(mailboxHistoricalBackfills.id, id))
      .limit(1);
    return row;
  }

  async getLatestMailboxHistoricalBackfill(mailboxId: string): Promise<MailboxHistoricalBackfill | undefined> {
    const [row] = await db.select().from(mailboxHistoricalBackfills)
      .where(eq(mailboxHistoricalBackfills.mailboxId, mailboxId))
      .orderBy(desc(mailboxHistoricalBackfills.createdAt))
      .limit(1);
    return row;
  }

  async getMailboxHistoricalBackfillsForOrg(orgId: string): Promise<MailboxHistoricalBackfill[]> {
    return db.select().from(mailboxHistoricalBackfills)
      .where(eq(mailboxHistoricalBackfills.orgId, orgId))
      .orderBy(desc(mailboxHistoricalBackfills.createdAt));
  }

  // ── Webex user mappings (Task #258) ─────────────────────────────────────────

  async getWebexUserMappings(orgId: string): Promise<WebexUserMapping[]> {
    return db.select().from(webexUserMappings)
      .where(eq(webexUserMappings.orgId, orgId))
      .orderBy(asc(webexUserMappings.webexDisplayName));
  }

  async getWebexUserMappingByPersonId(orgId: string, webexPersonId: string): Promise<WebexUserMapping | undefined> {
    const [row] = await db.select().from(webexUserMappings)
      .where(and(
        eq(webexUserMappings.orgId, orgId),
        eq(webexUserMappings.webexPersonId, webexPersonId),
      ))
      .limit(1);
    return row;
  }

  async getWebexUserMappingByEmail(orgId: string, webexEmail: string): Promise<WebexUserMapping | undefined> {
    const [row] = await db.select().from(webexUserMappings)
      .where(and(
        eq(webexUserMappings.orgId, orgId),
        eq(webexUserMappings.webexEmail, webexEmail.toLowerCase()),
      ))
      .limit(1);
    return row;
  }

  async upsertWebexUserMapping(data: InsertWebexUserMapping): Promise<WebexUserMapping> {
    const normalizedEmail = data.webexEmail ? data.webexEmail.toLowerCase() : null;

    // Try existing match by personId first; fall back to email when personId is null.
    let existing: WebexUserMapping | undefined;
    if (data.webexPersonId) {
      existing = await this.getWebexUserMappingByPersonId(data.orgId, data.webexPersonId);
    }
    if (!existing && normalizedEmail) {
      existing = await this.getWebexUserMappingByEmail(data.orgId, normalizedEmail);
    }

    if (existing) {
      const [row] = await db.update(webexUserMappings)
        .set({
          webexPersonId: data.webexPersonId ?? existing.webexPersonId,
          webexEmail: normalizedEmail ?? existing.webexEmail,
          webexDisplayName: data.webexDisplayName ?? existing.webexDisplayName,
          userId: data.userId !== undefined ? data.userId : existing.userId,
          status: data.status ?? existing.status,
          matchSource: data.matchSource ?? existing.matchSource,
          notes: data.notes ?? existing.notes,
          updatedAt: new Date(),
        })
        .where(eq(webexUserMappings.id, existing.id))
        .returning();
      return row;
    }

    const [row] = await db.insert(webexUserMappings).values({
      ...data,
      webexEmail: normalizedEmail,
    }).returning();
    return row;
  }

  async updateWebexUserMapping(id: string, orgId: string, data: Partial<InsertWebexUserMapping>): Promise<WebexUserMapping | undefined> {
    const [row] = await db.update(webexUserMappings)
      .set({
        ...data,
        webexEmail: data.webexEmail ? data.webexEmail.toLowerCase() : data.webexEmail,
        updatedAt: new Date(),
      })
      .where(and(eq(webexUserMappings.id, id), eq(webexUserMappings.orgId, orgId)))
      .returning();
    return row;
  }

  async deleteWebexUserMapping(id: string, orgId: string): Promise<boolean> {
    const result = await db.delete(webexUserMappings)
      .where(and(eq(webexUserMappings.id, id), eq(webexUserMappings.orgId, orgId)));
    return (result.rowCount ?? 0) > 0;
  }

  // ── Per-user Webex OAuth tokens (Task #261) ────────────────────────────────

  async getWebexUserToken(userId: string): Promise<WebexUserToken | undefined> {
    const [row] = await db.select().from(webexUserTokens)
      .where(eq(webexUserTokens.userId, userId))
      .limit(1);
    return row;
  }

  async getWebexUserTokensForOrg(orgId: string): Promise<WebexUserToken[]> {
    return db.select().from(webexUserTokens)
      .where(eq(webexUserTokens.orgId, orgId));
  }

  async upsertWebexUserToken(data: InsertWebexUserToken): Promise<WebexUserToken> {
    const existing = await this.getWebexUserToken(data.userId);
    if (existing) {
      const [row] = await db.update(webexUserTokens)
        .set({
          ...data,
          webexEmail: data.webexEmail ? data.webexEmail.toLowerCase() : data.webexEmail,
          updatedAt: new Date(),
        })
        .where(eq(webexUserTokens.userId, data.userId))
        .returning();
      return row;
    }
    const [row] = await db.insert(webexUserTokens).values({
      ...data,
      webexEmail: data.webexEmail ? data.webexEmail.toLowerCase() : data.webexEmail,
    }).returning();
    return row;
  }

  async updateWebexUserToken(userId: string, updates: Partial<InsertWebexUserToken>): Promise<WebexUserToken | undefined> {
    const [row] = await db.update(webexUserTokens)
      .set({
        ...updates,
        webexEmail: updates.webexEmail ? updates.webexEmail.toLowerCase() : updates.webexEmail,
        updatedAt: new Date(),
      })
      .where(eq(webexUserTokens.userId, userId))
      .returning();
    return row;
  }

  async deleteWebexUserToken(userId: string): Promise<boolean> {
    const result = await db.delete(webexUserTokens)
      .where(eq(webexUserTokens.userId, userId));
    return (result.rowCount ?? 0) > 0;
  }

  async getWebexUserTokensNeedingReauthEmail(emailedBefore: Date): Promise<WebexUserToken[]> {
    return db.select().from(webexUserTokens)
      .where(
        and(
          eq(webexUserTokens.needsReauth, true),
          or(
            isNull(webexUserTokens.lastReauthEmailAt),
            lt(webexUserTokens.lastReauthEmailAt, emailedBefore),
          ),
        ),
      );
  }

  // ── Webex Call Quality Analytics (Task #315) ───────────────────────────────

  async getWebexCallAnalyticsByCallId(orgId: string, callId: string): Promise<WebexCallAnalytics | undefined> {
    const [row] = await db.select().from(webexCallAnalytics)
      .where(and(eq(webexCallAnalytics.orgId, orgId), eq(webexCallAnalytics.callId, callId)))
      .limit(1);
    return row;
  }

  async upsertWebexCallAnalytics(data: InsertWebexCallAnalytics): Promise<WebexCallAnalytics> {
    const existing = await this.getWebexCallAnalyticsByCallId(data.orgId, data.callId);
    if (existing) {
      const [row] = await db.update(webexCallAnalytics)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(webexCallAnalytics.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(webexCallAnalytics).values(data).returning();
    return row;
  }

  /**
   * Task #466: merge enrichment-only metrics (talk/hold/silence/ring + MOS/jitter/loss
   * + qualityGrade) into the analytics row WITHOUT clobbering inline-CDR fields like
   * direction / remoteNumber / startTime / contactId. If no row exists yet (sync ran
   * out of order), this is a no-op — the inline upsert always runs first in the sync
   * loop, so a missing row means the call truly hasn't been seen yet and we'll catch
   * it on the next sweep.
   */
  async mergeWebexCallEnrichment(orgId: string, callId: string, metrics: {
    talkTimeSeconds?: number;
    holdTimeSeconds?: number;
    silenceSeconds?: number;
    ringTimeSeconds?: number;
    mosScore?: string | null;
    jitterMs?: string | null;
    packetLossPct?: string | null;
    qualityGrade?: string | null;
  }): Promise<void> {
    const existing = await this.getWebexCallAnalyticsByCallId(orgId, callId);
    if (!existing) return;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (metrics.talkTimeSeconds != null) patch.talkTimeSeconds = metrics.talkTimeSeconds;
    if (metrics.holdTimeSeconds != null) patch.holdTimeSeconds = metrics.holdTimeSeconds;
    if (metrics.silenceSeconds != null) patch.silenceSeconds = metrics.silenceSeconds;
    if (metrics.ringTimeSeconds != null) patch.ringTimeSeconds = metrics.ringTimeSeconds;
    if (metrics.mosScore !== undefined) patch.mosScore = metrics.mosScore;
    if (metrics.jitterMs !== undefined) patch.jitterMs = metrics.jitterMs;
    if (metrics.packetLossPct !== undefined) patch.packetLossPct = metrics.packetLossPct;
    if (metrics.qualityGrade !== undefined) patch.qualityGrade = metrics.qualityGrade;
    await db.update(webexCallAnalytics).set(patch).where(eq(webexCallAnalytics.id, existing.id));
  }

  // ── Webex Full Coverage & Backfill (Task #466) ──────────────────────────────

  async getWebexSyncState(orgId: string, dataSource: string, userId?: string | null): Promise<WebexSyncState | undefined> {
    const conds = [eq(webexSyncState.orgId, orgId), eq(webexSyncState.dataSource, dataSource)];
    if (userId) conds.push(eq(webexSyncState.userId, userId));
    else conds.push(sql`${webexSyncState.userId} IS NULL`);
    const [row] = await db.select().from(webexSyncState).where(and(...conds)).limit(1);
    return row;
  }

  async getWebexSyncStatesForOrg(orgId: string): Promise<WebexSyncState[]> {
    return db.select().from(webexSyncState).where(eq(webexSyncState.orgId, orgId));
  }

  async upsertWebexSyncState(data: InsertWebexSyncState): Promise<WebexSyncState> {
    const existing = await this.getWebexSyncState(data.orgId, data.dataSource, data.userId ?? null);
    if (existing) {
      const [row] = await db.update(webexSyncState)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(webexSyncState.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(webexSyncState).values(data).returning();
    return row;
  }

  async enqueueWebexEnrichmentJob(data: InsertWebexCallEnrichmentJob): Promise<WebexCallEnrichmentJob> {
    const [row] = await db.insert(webexCallEnrichmentJobs).values(data)
      .onConflictDoNothing({ target: [webexCallEnrichmentJobs.orgId, webexCallEnrichmentJobs.callId] })
      .returning();
    if (row) return row;
    const [existing] = await db.select().from(webexCallEnrichmentJobs)
      .where(and(eq(webexCallEnrichmentJobs.orgId, data.orgId), eq(webexCallEnrichmentJobs.callId, data.callId)))
      .limit(1);
    return existing!;
  }

  async claimDueWebexEnrichmentJobs(limit: number): Promise<WebexCallEnrichmentJob[]> {
    // Atomic claim — flip pending|failed (with nextRetryAt due) → running so a
    // second worker can't double-process. Uses a CTE for postgres-native row locking.
    const result = await db.execute(sql`
      WITH due AS (
        SELECT id FROM webex_call_enrichment_jobs
        WHERE status IN ('pending','failed') AND next_retry_at <= NOW()
        ORDER BY next_retry_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE webex_call_enrichment_jobs j
      SET status = 'running', updated_at = NOW()
      FROM due
      WHERE j.id = due.id
      RETURNING j.*
    `);
    // pool.query() returns untyped rows; RETURNING j.* guarantees the shape
    // matches WebexCallEnrichmentJob (all columns from webex_call_enrichment_jobs).
    return (result.rows ?? []) as unknown as WebexCallEnrichmentJob[];
  }

  async completeWebexEnrichmentJob(id: string): Promise<void> {
    await db.update(webexCallEnrichmentJobs)
      .set({ status: "succeeded", completedAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(eq(webexCallEnrichmentJobs.id, id));
  }

  async failWebexEnrichmentJob(id: string, attempts: number, nextRetryAt: Date | null, lastError: string, terminal: boolean): Promise<void> {
    await db.update(webexCallEnrichmentJobs)
      .set({
        status: terminal ? "dead_letter" : "failed",
        attempts,
        nextRetryAt: nextRetryAt ?? new Date(Date.now() + 60_000),
        lastError: lastError.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(webexCallEnrichmentJobs.id, id));
  }

  async countWebexEnrichmentJobsByStatus(orgId: string): Promise<Record<string, number>> {
    const rows = await db.execute(sql`
      SELECT status, COUNT(*)::int AS n
      FROM webex_call_enrichment_jobs
      WHERE org_id = ${orgId}
      GROUP BY status
    `);
    const out: Record<string, number> = {};
    for (const r of (rows.rows ?? []) as Array<{ status: string; n: number }>) {
      out[r.status] = r.n;
    }
    return out;
  }

  async upsertWebexVoicemail(data: InsertWebexVoicemail): Promise<WebexVoicemail> {
    const [row] = await db.insert(webexVoicemails).values(data)
      .onConflictDoUpdate({
        target: [webexVoicemails.orgId, webexVoicemails.voicemailId],
        set: {
          callerNumber: data.callerNumber ?? null,
          callerName: data.callerName ?? null,
          receivedAt: data.receivedAt ?? null,
          durationSeconds: data.durationSeconds ?? 0,
          read: data.read ?? false,
          transcript: data.transcript ?? null,
          transcriptionStatus: data.transcriptionStatus ?? "pending",
          audioCached: data.audioCached ?? false,
          syncedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async upsertWebexInventoryItems(items: InsertWebexInventory[]): Promise<number> {
    if (items.length === 0) return 0;
    let written = 0;
    for (const item of items) {
      await db.insert(webexInventory).values(item)
        .onConflictDoUpdate({
          target: [webexInventory.orgId, webexInventory.kind, webexInventory.externalId],
          set: { name: item.name ?? null, payload: item.payload ?? null, lastSeenAt: new Date() },
        });
      written++;
    }
    return written;
  }

  async getWebexInventoryByKind(orgId: string, kind: string): Promise<WebexInventory[]> {
    return db.select().from(webexInventory)
      .where(and(eq(webexInventory.orgId, orgId), eq(webexInventory.kind, kind)));
  }

  // ── Webex Webhook Subscriptions / Events (Task #741) ────────────────────────

  async listWebexWebhookSubscriptions(orgId: string): Promise<WebexWebhookSubscription[]> {
    return db.select().from(webexWebhookSubscriptions)
      .where(eq(webexWebhookSubscriptions.orgId, orgId))
      .orderBy(asc(webexWebhookSubscriptions.resource), asc(webexWebhookSubscriptions.event));
  }

  async getWebexWebhookSubscription(id: string): Promise<WebexWebhookSubscription | undefined> {
    const [row] = await db.select().from(webexWebhookSubscriptions)
      .where(eq(webexWebhookSubscriptions.id, id))
      .limit(1);
    return row;
  }

  async findWebexWebhookSubscription(args: {
    orgId: string;
    userId: string | null;
    resource: string;
    event: string;
  }): Promise<WebexWebhookSubscription | undefined> {
    const conds = [
      eq(webexWebhookSubscriptions.orgId, args.orgId),
      eq(webexWebhookSubscriptions.resource, args.resource),
      eq(webexWebhookSubscriptions.event, args.event),
      args.userId === null
        ? isNull(webexWebhookSubscriptions.userId)
        : eq(webexWebhookSubscriptions.userId, args.userId),
    ];
    const [row] = await db.select().from(webexWebhookSubscriptions)
      .where(and(...conds))
      .limit(1);
    return row;
  }

  async upsertWebexWebhookSubscription(data: InsertWebexWebhookSubscription): Promise<WebexWebhookSubscription> {
    const existing = await this.findWebexWebhookSubscription({
      orgId: data.orgId,
      userId: data.userId ?? null,
      resource: data.resource,
      event: data.event ?? "all",
    });
    if (existing) {
      const [row] = await db.update(webexWebhookSubscriptions)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(webexWebhookSubscriptions.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(webexWebhookSubscriptions).values(data).returning();
    return row;
  }

  async updateWebexWebhookSubscription(id: string, updates: Partial<InsertWebexWebhookSubscription>): Promise<WebexWebhookSubscription | undefined> {
    const [row] = await db.update(webexWebhookSubscriptions)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(webexWebhookSubscriptions.id, id))
      .returning();
    return row;
  }

  async recordWebexWebhookHit(id: string, receivedAt: Date): Promise<void> {
    await db.update(webexWebhookSubscriptions)
      .set({
        lastEventAt: receivedAt,
        eventsReceived: sql`${webexWebhookSubscriptions.eventsReceived} + 1`,
        status: "active",
        lastError: null,
        lastErrorAt: null,
        updatedAt: new Date(),
      })
      .where(eq(webexWebhookSubscriptions.id, id));
  }

  async deleteWebexWebhookSubscription(id: string): Promise<void> {
    await db.delete(webexWebhookSubscriptions).where(eq(webexWebhookSubscriptions.id, id));
  }

  async insertWebexWebhookEvent(data: InsertWebexWebhookEvent): Promise<{ row: WebexWebhookEvent; inserted: boolean }> {
    const inserted = await db.insert(webexWebhookEvents)
      .values(data)
      .onConflictDoNothing({ target: webexWebhookEvents.eventId })
      .returning();
    if (inserted.length > 0) return { row: inserted[0], inserted: true };
    const [existing] = await db.select().from(webexWebhookEvents)
      .where(eq(webexWebhookEvents.eventId, data.eventId))
      .limit(1);
    return { row: existing, inserted: false };
  }

  async markWebexWebhookEventProcessed(id: string, error?: string | null): Promise<void> {
    await db.update(webexWebhookEvents)
      .set({ processedAt: new Date(), processError: error ?? null })
      .where(eq(webexWebhookEvents.id, id));
  }

  async getLatestWebexWebhookEventAt(orgId: string): Promise<Date | null> {
    // Task #741: only count successfully-processed, signature-valid events
    // for adaptive-poller backoff. We don't want a stream of bad-signature
    // or failed-dispatch notifications to suppress polling, since that
    // would silently drop call ingestion. processedAt IS NOT NULL +
    // process_error IS NULL means the dispatcher actually ran the
    // ingestion path (CDR upsert / voicemail upsert) successfully.
    const rows = await db.select({ at: sql<Date | null>`MAX(${webexWebhookEvents.receivedAt})` })
      .from(webexWebhookEvents)
      .where(and(
        eq(webexWebhookEvents.orgId, orgId),
        eq(webexWebhookEvents.signatureValid, true),
        sql`${webexWebhookEvents.processedAt} IS NOT NULL`,
        sql`${webexWebhookEvents.processError} IS NULL`,
      ));
    const v = rows[0]?.at;
    return v ? new Date(v as unknown as string) : null;
  }

  async getWebexWebhookHealth(orgId: string): Promise<{
    subscriptions: WebexWebhookSubscription[];
    lastEventAt: Date | null;
    eventsLast7d: number;
    eventsLast24h: number;
    eventsLast15m: number;
    failedLast24h: number;
  }> {
    const subscriptions = await this.listWebexWebhookSubscriptions(orgId);
    const now = new Date();
    const ago7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const ago15m = new Date(now.getTime() - 15 * 60 * 1000);

    const [counts] = await db.select({
      total7d: sql<number>`COUNT(*) FILTER (WHERE ${webexWebhookEvents.receivedAt} >= ${ago7d})`,
      total24h: sql<number>`COUNT(*) FILTER (WHERE ${webexWebhookEvents.receivedAt} >= ${ago24h})`,
      total15m: sql<number>`COUNT(*) FILTER (WHERE ${webexWebhookEvents.receivedAt} >= ${ago15m})`,
      failed24h: sql<number>`COUNT(*) FILTER (WHERE ${webexWebhookEvents.receivedAt} >= ${ago24h} AND ${webexWebhookEvents.processError} IS NOT NULL)`,
      lastAt: sql<Date | null>`MAX(${webexWebhookEvents.receivedAt})`,
    })
      .from(webexWebhookEvents)
      .where(eq(webexWebhookEvents.orgId, orgId));

    return {
      subscriptions,
      lastEventAt: counts?.lastAt ? new Date(counts.lastAt as unknown as string) : null,
      eventsLast7d: Number(counts?.total7d ?? 0),
      eventsLast24h: Number(counts?.total24h ?? 0),
      eventsLast15m: Number(counts?.total15m ?? 0),
      failedLast24h: Number(counts?.failed24h ?? 0),
    };
  }

  // ── API Response Cache (Task #231) ──────────────────────────────────────────

  async getCachedApiResponse(key: string): Promise<ApiResponseCache | undefined> {
    const rows = await db.select().from(apiResponseCache).where(eq(apiResponseCache.cacheKey, key));
    if (rows.length === 0) return undefined;
    const row = rows[0];
    const ageSeconds = (Date.now() - new Date(row.fetchedAt).getTime()) / 1000;
    if (ageSeconds > row.ttlSeconds) return undefined;
    return row;
  }

  async setCachedApiResponse(key: string, response: unknown, ttlSeconds: number, source: string): Promise<void> {
    await db.insert(apiResponseCache)
      .values({ cacheKey: key, response, ttlSeconds, source, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: apiResponseCache.cacheKey,
        set: { response, ttlSeconds, source, fetchedAt: new Date() },
      });
  }

  async getValidCachedApiResponses(source: string): Promise<ApiResponseCache[]> {
    const rows = await db.select().from(apiResponseCache)
      .where(eq(apiResponseCache.source, source));
    const now = Date.now();
    return rows.filter(r => {
      const ageSeconds = (now - new Date(r.fetchedAt).getTime()) / 1000;
      return ageSeconds <= r.ttlSeconds;
    });
  }

  async getAllCachedApiResponses(source: string): Promise<ApiResponseCache[]> {
    return db.select().from(apiResponseCache)
      .where(eq(apiResponseCache.source, source))
      .orderBy(desc(apiResponseCache.fetchedAt));
  }

  // ── Account Reviews ────────────────────────────────────────────────────────
  async upsertAccountReview(data: InsertAccountReview): Promise<AccountReview> {
    const [row] = await db.insert(accountReviews).values(data)
      .onConflictDoUpdate({
        target: [accountReviews.repUserId, accountReviews.companyId, accountReviews.weekOf],
        set: {
          body: data.body,
          sections: data.sections ?? null,
          sourceSnapshots: data.sourceSnapshots ?? null,
          libraryItemId: data.libraryItemId ?? null,
          generatedBy: data.generatedBy ?? "scheduled",
        },
      })
      .returning();
    return row;
  }

  async getAccountReviewById(id: string, organizationId: string): Promise<AccountReview | undefined> {
    const [row] = await db.select().from(accountReviews)
      .where(and(eq(accountReviews.id, id), eq(accountReviews.organizationId, organizationId)))
      .limit(1);
    return row;
  }

  async getAccountReviewByKey(repUserId: string, companyId: string, weekOf: string): Promise<AccountReview | undefined> {
    const [row] = await db.select().from(accountReviews)
      .where(and(
        eq(accountReviews.repUserId, repUserId),
        eq(accountReviews.companyId, companyId),
        eq(accountReviews.weekOf, weekOf),
      ))
      .limit(1);
    return row;
  }

  async getAccountReviewsByCompany(companyId: string, organizationId: string, limit = 8): Promise<AccountReview[]> {
    return db.select().from(accountReviews)
      .where(and(eq(accountReviews.companyId, companyId), eq(accountReviews.organizationId, organizationId)))
      .orderBy(desc(accountReviews.weekOf))
      .limit(limit);
  }

  async getAccountReviewsByRep(repUserId: string, organizationId: string, weekOf?: string, limit = 50): Promise<AccountReview[]> {
    const conds = [eq(accountReviews.repUserId, repUserId), eq(accountReviews.organizationId, organizationId)];
    if (weekOf) conds.push(eq(accountReviews.weekOf, weekOf));
    return db.select().from(accountReviews)
      .where(and(...conds))
      .orderBy(desc(accountReviews.weekOf), desc(accountReviews.createdAt))
      .limit(limit);
  }

  async rateAccountReview(id: string, organizationId: string, rating: number | null): Promise<AccountReview | undefined> {
    const [row] = await db.update(accountReviews)
      .set({ rating })
      .where(and(eq(accountReviews.id, id), eq(accountReviews.organizationId, organizationId)))
      .returning();
    return row;
  }

  async cleanExpiredApiCache(): Promise<number> {
    const allRows = await db.select().from(apiResponseCache);
    const now = Date.now();
    const expiredKeys = allRows
      .filter(r => (now - new Date(r.fetchedAt).getTime()) / 1000 > r.ttlSeconds)
      .map(r => r.cacheKey);
    if (expiredKeys.length === 0) return 0;
    for (const key of expiredKeys) {
      await db.delete(apiResponseCache).where(eq(apiResponseCache.cacheKey, key));
    }
    return expiredKeys.length;
  }

  // ── Proactive Available Freight Outreach Engine — Phase 2 (Task #304) ──────

  async getCompanyOutreachPolicy(orgId: string, companyId: string): Promise<CompanyOutreachPolicy | undefined> {
    const [row] = await db.select().from(companyOutreachPolicies)
      .where(and(eq(companyOutreachPolicies.orgId, orgId), eq(companyOutreachPolicies.companyId, companyId)));
    return row;
  }

  async upsertCompanyOutreachPolicy(data: InsertCompanyOutreachPolicy): Promise<CompanyOutreachPolicy> {
    const existing = await this.getCompanyOutreachPolicy(data.orgId, data.companyId);
    if (existing) {
      const [row] = await db.update(companyOutreachPolicies)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(companyOutreachPolicies.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(companyOutreachPolicies).values(data).returning();
    return row;
  }

  async listCompanyOutreachPolicies(orgId: string, opts: { enabledOnly?: boolean } = {}): Promise<CompanyOutreachPolicy[]> {
    const conds = [eq(companyOutreachPolicies.orgId, orgId)];
    if (opts.enabledOnly) conds.push(eq(companyOutreachPolicies.enabled, true));
    return db.select().from(companyOutreachPolicies).where(and(...conds));
  }

  async createFreightOpportunity(data: InsertFreightOpportunity): Promise<FreightOpportunity> {
    const [row] = await db.insert(freightOpportunities).values(data).returning();
    return row;
  }

  async getFreightOpportunity(orgId: string, id: string): Promise<FreightOpportunity | undefined> {
    const [row] = await db.select().from(freightOpportunities)
      .where(and(eq(freightOpportunities.orgId, orgId), eq(freightOpportunities.id, id)));
    return row;
  }

  async listFreightOpportunities(orgId: string, opts: {
    companyId?: string;
    status?: string | string[];
    limit?: number;
    offset?: number;
  } = {}): Promise<FreightOpportunity[]> {
    const conds = [eq(freightOpportunities.orgId, orgId)];
    if (opts.companyId) conds.push(eq(freightOpportunities.companyId, opts.companyId));
    if (opts.status) {
      const list = Array.isArray(opts.status) ? opts.status : [opts.status];
      if (list.length) conds.push(inArray(freightOpportunities.status, list));
    }
    const base = db.select().from(freightOpportunities)
      .where(and(...conds))
      .orderBy(desc(freightOpportunities.urgencyScore), desc(freightOpportunities.generatedAt));
    if (opts.limit != null && opts.offset != null) {
      return base.limit(opts.limit).offset(opts.offset);
    }
    if (opts.limit != null) return base.limit(opts.limit);
    if (opts.offset != null) return base.offset(opts.offset);
    return base;
  }

  async updateFreightOpportunity(
    orgId: string,
    id: string,
    fields: Partial<FreightOpportunity>,
    opts: { allowCoveredTransition?: boolean } = {},
  ): Promise<FreightOpportunity | undefined> {
    // Guard: marking a freight opportunity as `covered` MUST flow through the
    // canonical /api/freight-opportunities/:oppId/cover endpoint so the
    // load_fact emit, audit row, and SLA-clock clearing all happen atomically.
    // Any caller bypassing that path leaves load_fact / scorecards stale.
    if (fields.status === "covered" && !opts.allowCoveredTransition) {
      throw new Error(
        "[updateFreightOpportunity] status='covered' must go through the canonical /cover endpoint (load_fact emit + audit). " +
        "Pass { allowCoveredTransition: true } only from that endpoint.",
      );
    }
    const [row] = await db.update(freightOpportunities)
      .set(fields)
      .where(and(eq(freightOpportunities.orgId, orgId), eq(freightOpportunities.id, id)))
      .returning();
    return row;
  }

  async insertFreightOpportunityCarriers(rows: InsertFreightOpportunityCarrier[]): Promise<FreightOpportunityCarrier[]> {
    if (rows.length === 0) return [];
    return db.insert(freightOpportunityCarriers).values(rows).returning();
  }

  async listFreightOpportunityCarriers(opportunityId: string): Promise<FreightOpportunityCarrier[]> {
    return db.select().from(freightOpportunityCarriers)
      .where(eq(freightOpportunityCarriers.opportunityId, opportunityId))
      .orderBy(asc(freightOpportunityCarriers.rank));
  }

  async updateFreightOpportunityCarrier(id: string, fields: Partial<FreightOpportunityCarrier>): Promise<FreightOpportunityCarrier | undefined> {
    const [row] = await db.update(freightOpportunityCarriers)
      .set(fields)
      .where(eq(freightOpportunityCarriers.id, id))
      .returning();
    return row;
  }

  async createFreightOpportunityResponse(data: InsertFreightOpportunityResponse): Promise<FreightOpportunityResponse> {
    const [row] = await db.insert(freightOpportunityResponses).values(data).returning();
    return row;
  }

  async listFreightOpportunityResponses(opportunityCarrierId: string): Promise<FreightOpportunityResponse[]> {
    return db.select().from(freightOpportunityResponses)
      .where(eq(freightOpportunityResponses.opportunityCarrierId, opportunityCarrierId))
      .orderBy(desc(freightOpportunityResponses.createdAt));
  }

  async appendFreightOpportunityAudit(data: InsertFreightOpportunityAudit): Promise<FreightOpportunityAudit> {
    const [row] = await db.insert(freightOpportunityAudit).values(data).returning();
    return row;
  }

  async listFreightOpportunityAudit(opportunityId: string): Promise<FreightOpportunityAudit[]> {
    return db.select().from(freightOpportunityAudit)
      .where(eq(freightOpportunityAudit.opportunityId, opportunityId))
      .orderBy(asc(freightOpportunityAudit.createdAt));
  }

  async listFreightOutreachTemplates(orgId: string): Promise<FreightOutreachTemplate[]> {
    return db.select().from(freightOutreachTemplates)
      .where(eq(freightOutreachTemplates.orgId, orgId))
      .orderBy(asc(freightOutreachTemplates.kind));
  }

  async getFreightOutreachTemplate(orgId: string, kind: FreightOutreachTemplateKind): Promise<FreightOutreachTemplate | undefined> {
    const [row] = await db.select().from(freightOutreachTemplates)
      .where(and(eq(freightOutreachTemplates.orgId, orgId), eq(freightOutreachTemplates.kind, kind)));
    return row;
  }

  async upsertFreightOutreachTemplate(data: InsertFreightOutreachTemplate): Promise<FreightOutreachTemplate> {
    const existing = await this.getFreightOutreachTemplate(data.orgId, data.kind as FreightOutreachTemplateKind);
    if (existing) {
      const [row] = await db.update(freightOutreachTemplates)
        .set({ subject: data.subject, body: data.body, updatedAt: new Date(), updatedById: data.updatedById ?? null })
        .where(eq(freightOutreachTemplates.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(freightOutreachTemplates).values(data).returning();
    return row;
  }

  async listDueScheduledOpportunityCarriers(now: Date, limit = 100): Promise<FreightOpportunityCarrier[]> {
    return db.select().from(freightOpportunityCarriers)
      .where(and(
        isNotNull(freightOpportunityCarriers.scheduledFor),
        lte(freightOpportunityCarriers.scheduledFor, now),
        isNull(freightOpportunityCarriers.sentAt),
      ))
      .limit(limit);
  }

  async findOpportunityCarriersByThreadOrMessage(orgId: string, opts: { threadId?: string | null; internetMessageId?: string | null }): Promise<FreightOpportunityCarrier[]> {
    const conds: SQL[] = [];
    if (opts.threadId) conds.push(eq(freightOpportunityCarriers.threadId, opts.threadId));
    if (opts.internetMessageId) conds.push(eq(freightOpportunityCarriers.internetMessageId, opts.internetMessageId));
    if (conds.length === 0) return [];
    // Tenant-isolated via the opportunity row
    const rows = await db.select({ c: freightOpportunityCarriers })
      .from(freightOpportunityCarriers)
      .innerJoin(freightOpportunities, eq(freightOpportunities.id, freightOpportunityCarriers.opportunityId))
      .where(and(eq(freightOpportunities.orgId, orgId), or(...conds)!));
    return rows.map(r => r.c);
  }

  // ─── Available Freight Cockpit (Task #601) ─────────────────────────────────

  async listFreightOpportunitySavedViews(orgId: string, userId: string): Promise<FreightOpportunitySavedView[]> {
    return db
      .select()
      .from(freightOpportunitySavedViews)
      .where(and(
        eq(freightOpportunitySavedViews.orgId, orgId),
        or(
          eq(freightOpportunitySavedViews.userId, userId),
          eq(freightOpportunitySavedViews.isShared, true),
        )!,
      ))
      .orderBy(asc(freightOpportunitySavedViews.name));
  }

  async createFreightOpportunitySavedView(data: InsertFreightOpportunitySavedView): Promise<FreightOpportunitySavedView> {
    const [row] = await db
      .insert(freightOpportunitySavedViews)
      .values(data)
      .returning();
    return row;
  }

  async updateFreightOpportunitySavedView(
    id: string,
    userId: string,
    fields: Partial<Pick<FreightOpportunitySavedView, "name" | "filters" | "isShared">>,
    orgId?: string,
  ): Promise<FreightOpportunitySavedView | undefined> {
    const [row] = await db
      .update(freightOpportunitySavedViews)
      .set({
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        ...(fields.filters !== undefined ? { filters: fields.filters as never } : {}),
        ...(fields.isShared !== undefined ? { isShared: fields.isShared } : {}),
        updatedAt: new Date(),
      })
      .where(and(
        eq(freightOpportunitySavedViews.id, id),
        eq(freightOpportunitySavedViews.userId, userId),
        ...(orgId ? [eq(freightOpportunitySavedViews.orgId, orgId)] : []),
      ))
      .returning();
    return row;
  }

  async deleteFreightOpportunitySavedView(id: string, userId: string, orgId?: string): Promise<boolean> {
    const rows = await db
      .delete(freightOpportunitySavedViews)
      .where(and(
        eq(freightOpportunitySavedViews.id, id),
        eq(freightOpportunitySavedViews.userId, userId),
        ...(orgId ? [eq(freightOpportunitySavedViews.orgId, orgId)] : []),
      ))
      .returning({ id: freightOpportunitySavedViews.id });
    return rows.length > 0;
  }

  async getUserFreightCockpitPrefs(userId: string): Promise<UserFreightCockpitPrefs | undefined> {
    const [row] = await db
      .select()
      .from(userFreightCockpitPrefs)
      .where(eq(userFreightCockpitPrefs.userId, userId))
      .limit(1);
    return row;
  }

  async upsertUserFreightCockpitPrefs(data: InsertUserFreightCockpitPrefs): Promise<UserFreightCockpitPrefs> {
    const [row] = await db
      .insert(userFreightCockpitPrefs)
      .values(data)
      .onConflictDoUpdate({
        target: userFreightCockpitPrefs.userId,
        set: {
          orgId: data.orgId,
          activeViewId: data.activeViewId ?? null,
          layout: data.layout ?? "table",
          grouping: data.grouping ?? "none",
          sort: data.sort ?? "urgency",
          autopilotMutedUntil: data.autopilotMutedUntil ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  // Lane Inbox per-user prefs (Task #873) — backs the "Group by Lane" toggle.
  async getUserLaneInboxPrefs(userId: string): Promise<UserLaneInboxPrefs | undefined> {
    const [row] = await db
      .select()
      .from(userLaneInboxPrefs)
      .where(eq(userLaneInboxPrefs.userId, userId))
      .limit(1);
    return row;
  }

  async upsertUserLaneInboxPrefs(data: InsertUserLaneInboxPrefs): Promise<UserLaneInboxPrefs> {
    const [row] = await db
      .insert(userLaneInboxPrefs)
      .values(data)
      .onConflictDoUpdate({
        target: userLaneInboxPrefs.userId,
        set: {
          groupByLane: data.groupByLane ?? false,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async getRecentlyContactedCarrierIds(orgId: string, sinceDate: Date): Promise<string[]> {
    // Cross-lane lookup: any carrier that received outbound outreach since
    // sinceDate. We expand the carrier_ids array via SQL so the result is a
    // distinct set of carrier IDs.
    const result = await pool.query<{ carrier_id: string }>(
      `SELECT DISTINCT unnest(carrier_ids) AS carrier_id
         FROM carrier_outreach_logs
        WHERE org_id = $1
          AND sent_at IS NOT NULL
          AND sent_at >= $2`,
      [orgId, sinceDate],
    );
    return result.rows.map(r => r.carrier_id).filter(Boolean);
  }

  async countFreightOpportunitiesCoveredSince(orgId: string, since: Date): Promise<number> {
    // Counts distinct opportunities that the audit pipeline recorded a
    // status_changed → covered/partially_covered transition for since `since`.
    // Joins through freight_opportunities so we can org-scope without trusting
    // the audit row alone. Used by the cockpit "Covered today" KPI.
    const result = await pool.query<{ n: string }>(
      `SELECT COUNT(DISTINCT a.opportunity_id)::text AS n
         FROM freight_opportunity_audit a
         JOIN freight_opportunities o ON o.id = a.opportunity_id
        WHERE o.org_id = $1
          AND a.event_type = 'status_changed'
          AND a.created_at >= $2
          AND (
                a.payload->>'newStatus' IN ('covered','partially_covered')
             OR a.payload->>'status'    IN ('covered','partially_covered')
             OR a.payload->>'to'        IN ('covered','partially_covered')
          )`,
      [orgId, since],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  // ─── POD Intake (Task #589) ────────────────────────────────────────────────

  async upsertPodIntakeEmail(data: InsertPodIntakeEmail): Promise<PodIntakeEmail> {
    // Idempotent on (org_id, provider_message_id). Re-deliveries from Graph
    // hit ON CONFLICT and update mutable fields rather than dup.
    const inserted = await db
      .insert(podIntakeEmails)
      .values(data)
      .onConflictDoUpdate({
        target: [podIntakeEmails.orgId, podIntakeEmails.providerMessageId],
        set: {
          subject: data.subject ?? null,
          bodyPreview: data.bodyPreview ?? null,
          bodyText: data.bodyText ?? null,
          hasAttachments: data.hasAttachments ?? false,
          attachmentMeta: data.attachmentMeta as never,
          classification: data.classification ?? "pending",
          classifierMethod: data.classifierMethod ?? null,
          classifierConfidence: data.classifierConfidence ?? null,
          classifierReason: data.classifierReason ?? null,
          extractedOrderIds: data.extractedOrderIds as never,
          matchedOrderId: data.matchedOrderId ?? null,
          matchedLoadFactId: data.matchedLoadFactId ?? null,
          matchedCompanyId: data.matchedCompanyId ?? null,
          forwardStatus: data.forwardStatus ?? "pending",
          forwardedAt: data.forwardedAt ?? null,
          forwardedTo: data.forwardedTo as never,
          forwardError: data.forwardError ?? null,
          deliveryMethod: data.deliveryMethod ?? null,
          dispatcherUserId: data.dispatcherUserId ?? null,
          accountOwnerUserId: data.accountOwnerUserId ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return inserted[0];
  }

  async getPodIntakeEmail(orgId: string, id: string): Promise<PodIntakeEmail | undefined> {
    const [row] = await db
      .select()
      .from(podIntakeEmails)
      .where(and(eq(podIntakeEmails.orgId, orgId), eq(podIntakeEmails.id, id)))
      .limit(1);
    return row;
  }

  async listPodIntakeEmails(orgId: string, opts: {
    bucket: "forwarded" | "unmatched" | "not_pod" | "pending" | "delivered_in_app" | "all";
    delivery?: "email" | "in_app" | "all";
    limit?: number;
  }): Promise<PodIntakeEmail[]> {
    const limit = Math.min(opts.limit ?? 100, 500);
    const conds: SQL[] = [eq(podIntakeEmails.orgId, orgId)];
    if (opts.bucket === "not_pod") {
      conds.push(eq(podIntakeEmails.classification, "not_pod"));
    } else if (opts.bucket === "forwarded") {
      // "Forwarded" bucket spans both email-forwarded and in-app-only
      // matched PODs; the delivery filter narrows it further.
      conds.push(
        or(
          eq(podIntakeEmails.forwardStatus, "forwarded"),
          eq(podIntakeEmails.forwardStatus, "delivered_in_app"),
        )!,
      );
    } else if (opts.bucket === "delivered_in_app") {
      conds.push(eq(podIntakeEmails.forwardStatus, "delivered_in_app"));
    } else if (opts.bucket === "unmatched") {
      conds.push(eq(podIntakeEmails.forwardStatus, "unmatched"));
    } else if (opts.bucket === "pending") {
      conds.push(eq(podIntakeEmails.forwardStatus, "pending"));
    }
    if (opts.delivery === "email") {
      conds.push(eq(podIntakeEmails.deliveryMethod, "email"));
    } else if (opts.delivery === "in_app") {
      conds.push(eq(podIntakeEmails.deliveryMethod, "in_app"));
    }
    return db
      .select()
      .from(podIntakeEmails)
      .where(and(...conds))
      .orderBy(desc(podIntakeEmails.receivedAt))
      .limit(limit);
  }

  async listPodIntakeEmailsForUser(
    userId: string,
    orgId: string,
    opts?: { limit?: number },
  ): Promise<PodIntakeEmail[]> {
    const limit = Math.min(opts?.limit ?? 200, 500);
    return db
      .select()
      .from(podIntakeEmails)
      .where(
        and(
          eq(podIntakeEmails.orgId, orgId),
          or(
            eq(podIntakeEmails.dispatcherUserId, userId),
            eq(podIntakeEmails.accountOwnerUserId, userId),
          )!,
        ),
      )
      .orderBy(desc(podIntakeEmails.receivedAt))
      .limit(limit);
  }

  async listPodIntakeEmailsByOrderId(
    orgId: string,
    orderId: string,
    opts?: { limit?: number },
  ): Promise<PodIntakeEmail[]> {
    const limit = Math.min(opts?.limit ?? 50, 200);
    return db
      .select()
      .from(podIntakeEmails)
      .where(
        and(
          eq(podIntakeEmails.orgId, orgId),
          eq(podIntakeEmails.matchedOrderId, orderId),
        ),
      )
      .orderBy(desc(podIntakeEmails.receivedAt))
      .limit(limit);
  }

  async updatePodIntakeEmail(
    orgId: string,
    id: string,
    patch: Partial<InsertPodIntakeEmail>,
  ): Promise<PodIntakeEmail | undefined> {
    const [row] = await db
      .update(podIntakeEmails)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(podIntakeEmails.orgId, orgId), eq(podIntakeEmails.id, id)))
      .returning();
    return row;
  }

  async getPodIntakeSettings(orgId: string): Promise<PodIntakeSettings | undefined> {
    const [row] = await db
      .select()
      .from(podIntakeSettings)
      .where(eq(podIntakeSettings.orgId, orgId))
      .limit(1);
    return row;
  }

  async upsertPodIntakeSettings(data: InsertPodIntakeSettings): Promise<PodIntakeSettings> {
    const [row] = await db
      .insert(podIntakeSettings)
      .values(data)
      .onConflictDoUpdate({
        target: podIntakeSettings.orgId,
        set: {
          monitoredMailboxId: data.monitoredMailboxId ?? null,
          teamFallbackEmail: data.teamFallbackEmail ?? null,
          enabled: data.enabled ?? false,
          useAiFallback: data.useAiFallback ?? true,
          autoForwardEmail: data.autoForwardEmail ?? true,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  // ── Capacity Matches (Task #844) ─────────────────────────────────────────
  async insertTruckPostings(rows: InsertTruckPosting[]): Promise<TruckPosting[]> {
    if (rows.length === 0) return [];
    return db.insert(truckPostings).values(rows).returning();
  }

  async getTruckPosting(id: string): Promise<TruckPosting | undefined> {
    const [row] = await db.select().from(truckPostings).where(eq(truckPostings.id, id)).limit(1);
    return row;
  }

  async listTruckPostingsByOrg(
    orgId: string,
    opts: { status?: string; limit?: number } = {},
  ): Promise<TruckPosting[]> {
    const conds = [eq(truckPostings.orgId, orgId)];
    if (opts.status) conds.push(eq(truckPostings.status, opts.status));
    return db
      .select()
      .from(truckPostings)
      .where(and(...conds))
      .orderBy(desc(truckPostings.createdAt))
      .limit(opts.limit ?? 200);
  }

  async listActiveTruckPostingsByOrg(orgId: string): Promise<TruckPosting[]> {
    return db
      .select()
      .from(truckPostings)
      .where(and(eq(truckPostings.orgId, orgId), eq(truckPostings.status, "active")))
      .orderBy(desc(truckPostings.createdAt));
  }

  async expireTruckPostings(now: Date): Promise<number> {
    const today = now.toISOString().slice(0, 10);
    const result = await db
      .update(truckPostings)
      .set({ status: "expired", updatedAt: new Date() })
      .where(
        and(
          eq(truckPostings.status, "active"),
          or(
            and(isNotNull(truckPostings.expiresAt), lt(truckPostings.expiresAt, now)),
            and(
              isNotNull(truckPostings.availableThrough),
              lt(truckPostings.availableThrough, today),
            ),
            and(
              isNull(truckPostings.availableThrough),
              isNotNull(truckPostings.availableDate),
              lt(truckPostings.availableDate, today),
            ),
          ),
        ),
      )
      .returning({ id: truckPostings.id });
    return result.length;
  }

  async updateTruckPostingStatus(id: string, status: string): Promise<void> {
    await db
      .update(truckPostings)
      .set({ status, updatedAt: new Date() })
      .where(eq(truckPostings.id, id));
  }

  async upsertTruckLoadMatch(data: InsertTruckLoadMatch): Promise<TruckLoadMatch> {
    const [row] = await db
      .insert(truckLoadMatches)
      .values(data)
      .onConflictDoUpdate({
        target: [truckLoadMatches.truckPostingId, truckLoadMatches.freightOpportunityId],
        set: {
          fitScore: data.fitScore ?? 0,
          reasons: data.reasons ?? [],
          assignedRepId: data.assignedRepId ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async getTruckLoadMatch(id: string): Promise<TruckLoadMatch | undefined> {
    const [row] = await db.select().from(truckLoadMatches).where(eq(truckLoadMatches.id, id)).limit(1);
    return row;
  }

  async listTruckLoadMatchesByOrg(
    orgId: string,
    opts: {
      states?: TruckLoadMatchState[];
      assignedRepIds?: string[];
      minScore?: number;
      limit?: number;
    } = {},
  ): Promise<TruckLoadMatch[]> {
    const conds: SQL[] = [eq(truckLoadMatches.orgId, orgId)];
    if (opts.states && opts.states.length > 0) conds.push(inArray(truckLoadMatches.state, opts.states));
    if (opts.assignedRepIds && opts.assignedRepIds.length > 0) {
      conds.push(inArray(truckLoadMatches.assignedRepId, opts.assignedRepIds));
    }
    if (typeof opts.minScore === "number") conds.push(gte(truckLoadMatches.fitScore, opts.minScore));
    return db
      .select()
      .from(truckLoadMatches)
      .where(and(...conds))
      .orderBy(desc(truckLoadMatches.fitScore), desc(truckLoadMatches.createdAt))
      .limit(opts.limit ?? 500);
  }

  async listTruckLoadMatchesByPosting(postingId: string): Promise<TruckLoadMatch[]> {
    return db
      .select()
      .from(truckLoadMatches)
      .where(eq(truckLoadMatches.truckPostingId, postingId))
      .orderBy(desc(truckLoadMatches.fitScore));
  }

  async listTruckLoadMatchesByOpportunity(opportunityId: string): Promise<TruckLoadMatch[]> {
    return db
      .select()
      .from(truckLoadMatches)
      .where(eq(truckLoadMatches.freightOpportunityId, opportunityId))
      .orderBy(desc(truckLoadMatches.fitScore));
  }

  async updateTruckLoadMatchState(
    id: string,
    fields: { state: TruckLoadMatchState; actorUserId?: string | null; dismissedReason?: string | null },
  ): Promise<TruckLoadMatch | undefined> {
    const now = new Date();
    const updates: Record<string, unknown> = {
      state: fields.state,
      actorUserId: fields.actorUserId ?? null,
      updatedAt: now,
    };
    if (fields.state === "contacted") updates.contactedAt = now;
    if (fields.state === "booked") updates.bookedAt = now;
    if (fields.state === "dismissed") {
      updates.dismissedAt = now;
      updates.dismissedReason = fields.dismissedReason ?? null;
    }
    const [row] = await db
      .update(truckLoadMatches)
      .set(updates)
      .where(eq(truckLoadMatches.id, id))
      .returning();
    return row;
  }

  async markTruckLoadMatchNotified(id: string): Promise<void> {
    await db
      .update(truckLoadMatches)
      .set({ notifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(truckLoadMatches.id, id));
  }

  async countTruckLoadMatchesByRep(
    orgId: string,
    opts: { states?: TruckLoadMatchState[] } = {},
  ): Promise<Array<{ assignedRepId: string | null; count: number }>> {
    const conds: SQL[] = [eq(truckLoadMatches.orgId, orgId)];
    if (opts.states && opts.states.length > 0) conds.push(inArray(truckLoadMatches.state, opts.states));
    const rows = await db
      .select({
        assignedRepId: truckLoadMatches.assignedRepId,
        count: sql<number>`count(*)::int`,
      })
      .from(truckLoadMatches)
      .where(and(...conds))
      .groupBy(truckLoadMatches.assignedRepId);
    return rows.map(r => ({ assignedRepId: r.assignedRepId, count: Number(r.count) }));
  }

  async getTruckLoadMatchStats(orgId: string): Promise<{
    postingsActive: number;
    matchesActive: number;
    matchesStrong: number;
    bookedToday: number;
    contactedToday: number;
    parsedToday: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [pa] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(truckPostings)
      .where(and(eq(truckPostings.orgId, orgId), eq(truckPostings.status, "active")));
    const [ma] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(truckLoadMatches)
      .where(and(eq(truckLoadMatches.orgId, orgId), inArray(truckLoadMatches.state, ["new", "contacted"])));
    const [ms] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(truckLoadMatches)
      .where(and(
        eq(truckLoadMatches.orgId, orgId),
        inArray(truckLoadMatches.state, ["new", "contacted"]),
        gte(truckLoadMatches.fitScore, 75),
      ));
    const [bt] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(truckLoadMatches)
      .where(and(
        eq(truckLoadMatches.orgId, orgId),
        eq(truckLoadMatches.state, "booked"),
        gte(truckLoadMatches.bookedAt, today),
      ));
    const [ct] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(truckLoadMatches)
      .where(and(
        eq(truckLoadMatches.orgId, orgId),
        eq(truckLoadMatches.state, "contacted"),
        gte(truckLoadMatches.contactedAt, today),
      ));
    const [pt] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(truckPostings)
      .where(and(eq(truckPostings.orgId, orgId), gte(truckPostings.createdAt, today)));
    return {
      postingsActive: Number(pa?.c ?? 0),
      matchesActive: Number(ma?.c ?? 0),
      matchesStrong: Number(ms?.c ?? 0),
      bookedToday: Number(bt?.c ?? 0),
      contactedToday: Number(ct?.c ?? 0),
      parsedToday: Number(pt?.c ?? 0),
    };
  }
}

export const storage = new DatabaseStorage();
