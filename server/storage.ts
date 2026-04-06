import { eq, inArray, ilike, or, and, asc, desc, isNull, isNotNull, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
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

export interface IStorage {
  getDefaultOrganization(): Promise<Organization | undefined>;
  getOrganizationById(id: string): Promise<Organization | undefined>;
  createOrganization(data: { name: string; slug: string }): Promise<Organization>;

  /** Auth-only lookup by PK — trusted IDs only (session, FK chains). No org filter. */
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
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
  createCrmOpportunity(data: import('../shared/schema').InsertCrmOpportunity): Promise<import('../shared/schema').CrmOpportunity>;
  updateCrmOpportunity(id: number, data: Partial<import('../shared/schema').InsertCrmOpportunity>): Promise<import('../shared/schema').CrmOpportunity | undefined>;
  deleteCrmOpportunity(id: number): Promise<boolean>;

  // Launchpad CRM — Ownership Requests
  getCrmOwnershipRequests(organizationId: string): Promise<import('../shared/schema').CrmOwnershipRequest[]>;
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

  // Easter eggs
  checkAndClaimEasterEgg(type: string, month: string, winnerId: string): Promise<boolean>;
  countMeaningfulThisMonth(userId: string, monthStart: string): Promise<number>;
  countOpportunityLogsThisMonth(userId: string, monthStart: string): Promise<number>;
  countRelationshipsMovedThisMonth(userId: string, monthStart: string): Promise<number>;
  getUncelebratedEggs(winnerId: string): Promise<{ id: number; type: string; month: string; won_at: string }[]>;
  markEggCelebrated(id: number): Promise<void>;
  adminAwardEasterEgg(type: string, month: string, winnerId: string): Promise<number | null>;

  // Lane carriers (procurement rolodex)
  getLaneCarrier(id: string): Promise<import('../shared/schema').LaneCarrier | undefined>;
  getLaneCarriersByTask(taskId: string): Promise<import('../shared/schema').LaneCarrier[]>;
  getLaneCarriersByAward(awardId: string): Promise<import('../shared/schema').LaneCarrier[]>;
  createLaneCarrier(data: import('../shared/schema').InsertLaneCarrier): Promise<import('../shared/schema').LaneCarrier>;
  updateLaneCarrier(id: string, data: Partial<import('../shared/schema').InsertLaneCarrier>): Promise<import('../shared/schema').LaneCarrier | undefined>;
  deleteLaneCarrier(id: string): Promise<boolean>;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(pool);
export { db };

export class DatabaseStorage implements IStorage {
  readonly pool = pool;

  async getDefaultOrganization(): Promise<Organization | undefined> {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "valuetruck"));
    return org;
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

  async getCompanies(organizationId: string): Promise<Company[]> {
    return db.select().from(companies).where(eq(companies.organizationId, organizationId));
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
    return created;
  }

  async bulkCreateCompanies(companiesList: InsertCompany[]): Promise<Company[]> {
    if (companiesList.length === 0) return [];
    return db.insert(companies).values(companiesList).returning();
  }

  async updateCompany(id: string, organizationId: string, company: Partial<InsertCompany>): Promise<Company | undefined> {
    const [updated] = await db
      .update(companies)
      .set(company)
      .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)))
      .returning();
    return updated;
  }

  async deleteCompany(id: string, organizationId: string): Promise<boolean> {
    const result = await db.delete(companies).where(and(eq(companies.id, id), eq(companies.organizationId, organizationId))).returning();
    return result.length > 0;
  }

  async archiveCompany(id: string, organizationId: string): Promise<Company | undefined> {
    const [updated] = await db
      .update(companies)
      .set({ archivedAt: new Date().toISOString() })
      .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)))
      .returning();
    return updated;
  }

  async unarchiveCompany(id: string, organizationId: string): Promise<Company | undefined> {
    const [updated] = await db
      .update(companies)
      .set({ archivedAt: null })
      .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)))
      .returning();
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
    const orgUserIds = (await this.getUsers(organizationId)).map(u => u.id);
    if (orgUserIds.length === 0) return [];
    return db.select().from(financialUploads)
      .where(inArray(financialUploads.uploadedBy, orgUserIds))
      .orderBy(asc(financialUploads.uploadedAt));
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

    return created;
  }

  async deleteFinancialUpload(id: string): Promise<boolean> {
    const result = await db.delete(financialUploads).where(eq(financialUploads.id, id)).returning();
    return result.length > 0;
  }

  async deleteAllFinancialUploads(): Promise<void> {
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
    const results = await db.select().from(tasks).where(
      sql`attached_lane_data @> ${JSON.stringify([{ type: "carrier_procurement", awardId, lane }])}::jsonb`
    ).orderBy(
      sql`CASE WHEN status = 'open' THEN 0 ELSE 1 END`,
      desc(tasks.createdAt)
    );
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
      startDate: closedAt,
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

    const results: { session: OneOnOneSession; topics: OneOnOneTopic[] }[] = [];
    for (const session of sessions) {
      const actionTopics = await db.select().from(oneOnOneTopics).where(
        and(
          eq(oneOnOneTopics.sessionId, session.id),
          eq(oneOnOneTopics.tag, "action_item")
        )
      ).orderBy(desc(oneOnOneTopics.createdAt));
      if (actionTopics.length > 0) {
        results.push({ session, topics: actionTopics });
      }
    }
    return results;
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
    const [row] = await db.insert(prospects).values({ ...data, createdAt: now, updatedAt: now }).returning();
    return row;
  }

  async updateProspect(id: number, data: Partial<import('../shared/schema').InsertProspect>): Promise<import('../shared/schema').Prospect | undefined> {
    const { prospects } = await import('../shared/schema');
    // If the stage is changing, stamp stageChangedAt so analytics can compute
    // time-in-stage as (now - stageChangedAt) instead of using updatedAt.
    let stageChangedAt: Date | undefined;
    if (data.stage !== undefined) {
      const [existing] = await db.select({ stage: prospects.stage }).from(prospects).where(eq(prospects.id, id));
      if (existing && existing.stage !== data.stage) {
        stageChangedAt = new Date();
      }
    }
    const [row] = await db.update(prospects)
      .set({ ...data, updatedAt: new Date(), ...(stageChangedAt ? { stageChangedAt } : {}) })
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

  async checkAndClaimEasterEgg(type: string, month: string, winnerId: string): Promise<boolean> {
    try {
      const result = await pool.query(
        `INSERT INTO easter_egg_winners (type, month, winner_id, won_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT ON CONSTRAINT easter_egg_winners_unique DO NOTHING
         RETURNING id`,
        [type, month, winnerId]
      );
      return (result.rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async getUncelebratedEggs(winnerId: string): Promise<{ id: number; type: string; month: string; won_at: string }[]> {
    try {
      const result = await pool.query(
        `SELECT id, type, month, won_at FROM easter_egg_winners
         WHERE winner_id = $1 AND celebrated_at IS NULL
         ORDER BY won_at ASC`,
        [winnerId]
      );
      return result.rows;
    } catch {
      return [];
    }
  }

  async markEggCelebrated(id: number): Promise<void> {
    try {
      await pool.query(`UPDATE easter_egg_winners SET celebrated_at = now() WHERE id = $1`, [id]);
    } catch {}
  }

  async adminAwardEasterEgg(type: string, month: string, winnerId: string): Promise<number | null> {
    try {
      const result = await pool.query(
        `INSERT INTO easter_egg_winners (type, month, winner_id, won_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT ON CONSTRAINT easter_egg_winners_unique DO UPDATE
           SET winner_id = $3, won_at = now(), celebrated_at = NULL
         RETURNING id`,
        [type, month, winnerId]
      );
      return result.rows[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  async countMeaningfulThisMonth(userId: string, monthStart: string): Promise<number> {
    try {
      const result = await pool.query(
        `SELECT COUNT(*) as cnt FROM touchpoints
         WHERE logged_by_id = $1 AND date >= $2 AND is_meaningful = true`,
        [userId, monthStart]
      );
      return parseInt(result.rows[0]?.cnt ?? "0", 10);
    } catch {
      return 0;
    }
  }

  async countOpportunityLogsThisMonth(userId: string, monthStart: string): Promise<number> {
    try {
      const result = await pool.query(
        `SELECT COUNT(*) as cnt FROM opportunity_logs
         WHERE rep_id = $1 AND logged_at >= $2`,
        [userId, monthStart]
      );
      return parseInt(result.rows[0]?.cnt ?? "0", 10);
    } catch {
      return 0;
    }
  }

  async countRelationshipsMovedThisMonth(userId: string, monthStart: string): Promise<number> {
    try {
      const result = await pool.query(
        `SELECT COUNT(DISTINCT contact_id) as cnt FROM contact_base_history
         WHERE changed_by_id = $1 AND changed_at >= $2`,
        [userId, monthStart]
      );
      return parseInt(result.rows[0]?.cnt ?? "0", 10);
    } catch {
      return 0;
    }
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
}

export const storage = new DatabaseStorage();
