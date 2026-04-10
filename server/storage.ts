import { eq, inArray, ilike, or, and, asc, desc, isNull, isNotNull, gte, lte, sql, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { cacheGet, cacheSet, cacheInvalidatePrefix } from "./cache";
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
  type LaneCarrier,
  type InsertLaneCarrier,
  nbaCards,
  type NbaCard,
  type InsertNbaCard,
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
  carrierIntelSuggestions,
  type CarrierIntelSuggestion,
  type InsertCarrierIntelSuggestion,
} from "@shared/schema";

const { Pool } = pg;

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
  rep: { id: string; name: string; role: string; manager: string | null; director: string | null; createdAt: string | null };
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
  
  getContacts(): Promise<Contact[]>;
  getContactsByCompany(companyId: string): Promise<Contact[]>;
  getContactsByCompanyIds(companyIds: string[]): Promise<Contact[]>;
  getContact(id: string): Promise<Contact | undefined>;
  logContactBaseHistory(contactId: string, fromBase: string | null, toBase: string, changedById: string): Promise<void>;
  getContactBaseHistory(contactId: string): Promise<any[]>;
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
  getRfp(id: string): Promise<Rfp | undefined>;
  createRfp(rfp: InsertRfp): Promise<Rfp>;
  updateRfp(id: string, rfp: InsertRfp): Promise<Rfp | undefined>;
  deleteRfp(id: string): Promise<boolean>;

  getAwards(): Promise<Award[]>;
  getAward(id: string): Promise<Award | undefined>;
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

  getCompanyActivity(companyId: string): Promise<Array<{ type: string; title: string; subtitle?: string; date: string; link?: string }>>;
  getTeamPerformance(managerIds: string[], startDate?: string, endDate?: string): Promise<Array<{ userId: string; openTasks: number; overdueTasks: number; completedTasks: number; companyCount: number; newContacts: number; callTouchpoints: number; textTouchpoints: number; emailTouchpoints: number; contactsTouched: number; baseAdvanced: number; meaningfulTouchpoints: number }>>;

  getNotifications(userId: string): Promise<import('../shared/schema').Notification[]>;
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
  getTouchpointsByUser(userId: string, since: string): Promise<Touchpoint[]>;
  getTouchpointsByOrg(organizationId: string): Promise<Touchpoint[]>;
  createTouchpoint(tp: InsertTouchpoint): Promise<Touchpoint>;
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

  getPtoPassoffs(filter: { createdById?: string; coveringUserId?: string; all?: boolean }): Promise<PtoPassoff[]>;
  getPtoPassoff(id: string): Promise<PtoPassoff | undefined>;
  createPtoPassoff(data: InsertPtoPassoff & { createdAt: string }): Promise<PtoPassoff>;
  updatePtoPassoff(id: string, data: Partial<InsertPtoPassoff>): Promise<PtoPassoff | undefined>;
  deletePtoPassoff(id: string): Promise<boolean>;
  getPtoPassoffItems(passoffId: string): Promise<PtoPassoffItem[]>;
  createPtoPassoffItem(data: InsertPtoPassoffItem): Promise<PtoPassoffItem>;
  updatePtoPassoffItem(id: string, data: Partial<InsertPtoPassoffItem>): Promise<PtoPassoffItem | undefined>;
  deletePtoPassoffItem(id: string): Promise<boolean>;

  getInternalPosts(userId: string, role: string, orgUserIds: string[]): Promise<any[]>;
  createInternalPost(data: { content: string; authorId: string; recipientIds: string[]; parentId?: string | null; createdAt: string }): Promise<any>;
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
  }>>;
  // Market Signal NBA methods
  getNbaCardsByMarketSignal(signalId: string): Promise<NbaCard[]>;
  getNbaCardsByCompanyAndRuleType(companyId: string, ruleType: string): Promise<NbaCard[]>;
  getNbaCardsByUserId(userId: string, ruleType?: string): Promise<NbaCard[]>;
  getNbaCardByMarketSignalDedup(companyId: string, signalId: string, ruleType: string): Promise<NbaCard | undefined>;
  dismissNbaCardsByMarketSignal(signalId: string): Promise<number>;
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
  getFirstOrg(): Promise<{ id: string; name: string } | undefined>;
  getFirstOrgAdmin(orgId: string): Promise<{ id: string } | undefined>;
  getOrgByOutlookMailbox(mailbox: string): Promise<{ id: string } | undefined>;

  // Lane Carrier Outreach v1 — Feature Flags
  getFeatureFlag(orgId: string, flagKey: string): Promise<boolean>;
  setFeatureFlag(orgId: string, flagKey: string, enabled: boolean, updatedById?: string): Promise<void>;
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
  getUnactionedHotReplyCount(orgId: string, visibleUserIds: string[], canSeeUnassigned: boolean): Promise<number>;

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
  getEmailSignalsByThread(threadId: string, since?: Date): Promise<import('@shared/schema').EmailSignal[]>;
  markEmailMessageProcessed(id: string): Promise<void>;
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
  updateSuggestionStatus(id: string, status: 'accepted' | 'rejected' | 'auto_accepted', opts: { userId?: string; comment?: string }): Promise<import('@shared/schema').CarrierIntelSuggestion | undefined>;
  findDuplicateSuggestion(carrierId: string, suggestionType: string, emailSignalId: string): Promise<import('@shared/schema').CarrierIntelSuggestion | undefined>;
  getCarrierIntelSuggestionByDedup(carrierId: string, suggestionType: string, emailSignalId: string): Promise<import('@shared/schema').CarrierIntelSuggestion | undefined>;
  getCarrierIntelSuggestions(carrierId: string, status?: string): Promise<import('@shared/schema').CarrierIntelSuggestion[]>;

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
    const [created] = await db.insert(companies).values(company).returning();
    cacheInvalidatePrefix("companies:");
    return created;
  }

  async bulkCreateCompanies(companiesList: InsertCompany[]): Promise<Company[]> {
    if (companiesList.length === 0) return [];
    const created = await db.insert(companies).values(companiesList).returning();
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

  async getContacts(): Promise<Contact[]> {
    return db.select().from(contacts);
  }

  async getContactsByCompany(companyId: string): Promise<Contact[]> {
    return db.select().from(contacts).where(eq(contacts.companyId, companyId));
  }

  async getContactsByCompanyIds(companyIds: string[]): Promise<Contact[]> {
    if (companyIds.length === 0) return [];
    return db.select().from(contacts).where(inArray(contacts.companyId, companyIds));
  }

  async logContactBaseHistory(contactId: string, fromBase: string | null, toBase: string, changedById: string): Promise<void> {
    await db.insert(contactBaseHistory).values({ contactId, fromBase: fromBase ?? null, toBase, changedById });
  }

  async getContactBaseHistory(contactId: string): Promise<any[]> {
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
    const [created] = await db.insert(contacts).values(contact).returning();
    return created;
  }

  async bulkCreateContacts(contactList: InsertContact[]): Promise<Contact[]> {
    if (contactList.length === 0) return [];
    return db.insert(contacts).values(contactList).returning();
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

  async getRfp(id: string): Promise<Rfp | undefined> {
    const [rfp] = await db.select().from(rfps).where(eq(rfps.id, id));
    return rfp;
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

  async getAward(id: string): Promise<Award | undefined> {
    const [award] = await db.select().from(awards).where(eq(awards.id, id));
    return award;
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

    const topicsBySession = new Map<number, OneOnOneTopic[]>();
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
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysSince);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    let companiesResult: Company[];
    if (teamUserIds && teamUserIds.length > 0) {
      companiesResult = await db.select().from(companies).where(inArray(companies.assignedTo, teamUserIds));
    } else if (assignedToUserId) {
      companiesResult = await db.select().from(companies).where(eq(companies.assignedTo, assignedToUserId!));
    } else {
      companiesResult = await db.select().from(companies);
    }
    if (companiesResult.length === 0) return [];
    const companyIds = companiesResult.map(c => c.id);
    const companyMap = new Map(companiesResult.map(c => [c.id, c]));

    const allContacts = await db.select().from(contacts).where(inArray(contacts.companyId, companyIds));
    const allTouchpoints = await db.select().from(touchpoints).where(inArray(touchpoints.companyId, companyIds));

    const tpByContact = new Map<string, Touchpoint[]>();
    for (const tp of allTouchpoints) {
      if (!tp.contactId) continue;
      const arr = tpByContact.get(tp.contactId) ?? [];
      arr.push(tp);
      tpByContact.set(tp.contactId, arr);
    }

    const results: Array<{ contact: Contact; company: Company; daysSince: number; lastType: string | null }> = [];
    const today = new Date();

    for (const contact of allContacts) {
      const tps = tpByContact.get(contact.id) ?? [];
      if (tps.length === 0) {
        const comp = companyMap.get(contact.companyId);
        if (comp) results.push({ contact, company: comp, daysSince: 999, lastType: null });
      } else {
        const latest = tps.sort((a, b) => b.date.localeCompare(a.date))[0];
        if (latest.date < cutoffStr) {
          const diff = Math.floor((today.getTime() - new Date(latest.date).getTime()) / 86400000);
          const comp = companyMap.get(contact.companyId);
          if (comp) results.push({ contact, company: comp, daysSince: diff, lastType: latest.type });
        }
      }
    }

    return results.sort((a, b) => b.daysSince - a.daysSince).slice(0, 20);
  }

  async getMeaningfulOverdueContacts(assignedToUserId: string | null, daysSince: number, teamUserIds?: string[]): Promise<Array<{ contact: Contact; company: Company; daysSinceLastMeaningful: number }>> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysSince);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    let companiesResult: Company[];
    if (teamUserIds && teamUserIds.length > 0) {
      companiesResult = await db.select().from(companies).where(inArray(companies.assignedTo, teamUserIds));
    } else if (assignedToUserId) {
      companiesResult = await db.select().from(companies).where(eq(companies.assignedTo, assignedToUserId!));
    } else {
      companiesResult = await db.select().from(companies);
    }
    if (companiesResult.length === 0) return [];
    const companyIds = companiesResult.map(c => c.id);
    const companyMap = new Map(companiesResult.map(c => [c.id, c]));

    const allContacts = await db.select().from(contacts).where(inArray(contacts.companyId, companyIds));
    const meaningfulTps = await db.select().from(touchpoints).where(
      and(inArray(touchpoints.companyId, companyIds), eq(touchpoints.isMeaningful, true))
    );

    const lastMeaningfulByContact = new Map<string, string>();
    for (const tp of meaningfulTps) {
      if (!tp.contactId || !tp.date) continue;
      const existing = lastMeaningfulByContact.get(tp.contactId);
      if (!existing || tp.date > existing) lastMeaningfulByContact.set(tp.contactId, tp.date);
    }

    const results: Array<{ contact: Contact; company: Company; daysSinceLastMeaningful: number }> = [];
    const today = new Date();
    for (const contact of allContacts) {
      const lastMeaningful = lastMeaningfulByContact.get(contact.id);
      if (!lastMeaningful || lastMeaningful < cutoffStr) {
        const days = lastMeaningful
          ? Math.floor((today.getTime() - new Date(lastMeaningful).getTime()) / 86400000)
          : 999;
        const comp = companyMap.get(contact.companyId);
        if (comp) results.push({ contact, company: comp, daysSinceLastMeaningful: days });
      }
    }
    return results.sort((a, b) => b.daysSinceLastMeaningful - a.daysSinceLastMeaningful).slice(0, 20);
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

  async getInternalPosts(userId: string, role: string, orgUserIds: string[]): Promise<any[]> {
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

  async createInternalPost(data: { content: string; authorId: string; recipientIds: string[]; parentId?: string | null; createdAt: string }): Promise<any> {
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
    await db.update(nbaCards)
      .set({ status: "actioned", resolvedAt: now } as any)
      .where(
        and(
          eq(nbaCards.linkedLaneId, laneId),
          eq(nbaCards.ruleType, "recurring_lane_capacity"),
          sql`${nbaCards.status} IN ('visible', 'generated')`,
        )
      );
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
    await db.update(nbaCards)
      .set({ status: "expired" } as any)
      .where(
        and(
          eq(nbaCards.orgId, orgId),
          eq(nbaCards.status, "visible"),
          sql`${nbaCards.createdAt} < ${cutoffStr}`,
        )
      );
    // If a touchpoint was logged, auto-resolve stale_account cards for that company
    if (touchpointCompanyId) {
      await db.update(nbaCards)
        .set({ status: "actioned", resolutionAction: "auto_touchpoint", resolvedAt: new Date().toISOString() } as any)
        .where(
          and(
            eq(nbaCards.companyId, touchpointCompanyId),
            eq(nbaCards.ruleType, "stale_account"),
            eq(nbaCards.status, "visible"),
          )
        );
      await db.update(nbaCards)
        .set({ status: "actioned", resolutionAction: "auto_touchpoint", resolvedAt: new Date().toISOString() } as any)
        .where(
          and(
            eq(nbaCards.companyId, touchpointCompanyId),
            eq(nbaCards.ruleType, "single_thread_risk"),
            eq(nbaCards.status, "visible"),
          )
        );
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
    return Array.from(map.values()).map(e => ({
      ruleType: e.ruleType,
      firedCount: e.firedCount,
      shownCount: e.shownCount,
      actionedCount: e.actionedCount,
      dismissedCount: e.dismissedCount,
      avgHoursToAction: e.hoursToAction.length > 0
        ? e.hoursToAction.reduce((a, b) => a + b, 0) / e.hoursToAction.length
        : null,
      outcomeLinkCount: e.outcomeLinkCount,
    }));
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
    status: 'accepted' | 'rejected' | 'auto_accepted',
    opts: { userId?: string; comment?: string }
  ): Promise<CarrierIntelSuggestion | undefined> {
    const now = new Date();
    const updates: Partial<CarrierIntelSuggestion> = {
      status,
      updatedAt: now,
      comment: opts.comment ?? undefined,
    };
    if (status === 'accepted' || status === 'auto_accepted') {
      updates.acceptedAt = now;
      if (opts.userId) updates.acceptedByUserId = opts.userId;
    } else if (status === 'rejected') {
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
}

export const storage = new DatabaseStorage();
