import { eq, inArray, ilike, or, and, desc, isNull, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  users,
  companies,
  contacts,
  rfps,
  awards,
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
} from "@shared/schema";

const { Pool } = pg;

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUsers(): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, data: Partial<InsertUser>): Promise<User | undefined>;
  deleteUser(id: string): Promise<boolean>;
  getTeamMemberIds(userId: string): Promise<string[]>;
  
  getCompanies(): Promise<Company[]>;
  getCompaniesByIds(ids: string[]): Promise<Company[]>;
  getCompany(id: string): Promise<Company | undefined>;
  createCompany(company: InsertCompany): Promise<Company>;
  updateCompany(id: string, company: InsertCompany): Promise<Company | undefined>;
  deleteCompany(id: string): Promise<boolean>;
  archiveCompany(id: string): Promise<Company | undefined>;
  unarchiveCompany(id: string): Promise<Company | undefined>;
  
  getContacts(): Promise<Contact[]>;
  getContactsByCompany(companyId: string): Promise<Contact[]>;
  getContact(id: string): Promise<Contact | undefined>;
  createContact(contact: InsertContact): Promise<Contact>;
  bulkCreateContacts(contacts: InsertContact[]): Promise<Contact[]>;
  updateContact(id: string, contact: InsertContact): Promise<Contact | undefined>;
  deleteContact(id: string): Promise<boolean>;
  
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
  getLatestFinancialUpload(): Promise<FinancialUpload | undefined>;
  createFinancialUpload(upload: InsertFinancialUpload): Promise<FinancialUpload>;
  deleteFinancialUpload(id: string): Promise<boolean>;
  deleteAllFinancialUploads(): Promise<void>;

  searchCompanies(query: string): Promise<Company[]>;
  searchUsers(query: string, roles: string[]): Promise<Omit<User, 'password'>[]>;

  getTasks(): Promise<Task[]>;
  getTasksByCompany(companyId: string): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
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
  closeSession(sessionId: string): Promise<OneOnOneSession | undefined>;
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
  getActionItemsByPairing(namId: string, amId: string): Promise<{ session: OneOnOneSession; topics: OneOnOneTopic[] }[]>;

  searchContacts(query: string): Promise<Contact[]>;
  searchRfps(query: string): Promise<Rfp[]>;

  getCompanyActivity(companyId: string): Promise<Array<{ type: string; title: string; subtitle?: string; date: string; link?: string }>>;
  getTeamPerformance(managerIds: string[]): Promise<Array<{ userId: string; openTasks: number; overdueTasks: number; completedTasks: number; companyCount: number; newContacts: number; callTouchpoints: number; textTouchpoints: number; emailTouchpoints: number; contactsTouched: number; baseAdvanced: number }>>;

  getNotifications(userId: string): Promise<import('../shared/schema').Notification[]>;
  createNotification(data: import('../shared/schema').InsertNotification): Promise<import('../shared/schema').Notification>;
  markNotificationRead(id: string): Promise<void>;
  markAllNotificationsRead(userId: string): Promise<void>;

  getTouchpoint(id: string): Promise<Touchpoint | undefined>;
  getTouchpoints(): Promise<Touchpoint[]>;
  getTouchpointsByContact(contactId: string): Promise<Touchpoint[]>;
  getTouchpointsByCompany(companyId: string): Promise<Touchpoint[]>;
  getTouchpointsByUser(userId: string, since: string): Promise<Touchpoint[]>;
  createTouchpoint(tp: InsertTouchpoint): Promise<Touchpoint>;
  deleteTouchpoint(id: string): Promise<boolean>;
  getColdContacts(assignedToUserId: string | null, daysSince: number, teamUserIds?: string[]): Promise<Array<{ contact: Contact; company: Company; daysSince: number; lastType: string | null }>>;

  getTouchpointCountByAm(amId: string, startDate: string, endDate: string): Promise<number>;

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
  getAmsMissingMonthlyGoals(namId?: string): Promise<Array<{ amId: string; amName: string }>>;
  getGoalComments(goalId: string): Promise<GoalComment[]>;
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
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(pool);

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async getUsers(): Promise<User[]> {
    return db.select().from(users);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUser(id: string, data: Partial<InsertUser>): Promise<User | undefined> {
    const [updated] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return updated;
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id)).returning();
    return result.length > 0;
  }

  async getTeamMemberIds(userId: string): Promise<string[]> {
    const ids = [userId];
    const queue = [userId];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const directReports = await db.select().from(users).where(eq(users.managerId, currentId));
      for (const report of directReports) {
        if (!ids.includes(report.id)) {
          ids.push(report.id);
          queue.push(report.id);
        }
      }
    }
    return ids;
  }

  async getCompanies(): Promise<Company[]> {
    return db.select().from(companies);
  }

  async getCompaniesByIds(ids: string[]): Promise<Company[]> {
    if (ids.length === 0) return [];
    return db.select().from(companies).where(inArray(companies.id, ids));
  }

  async getCompany(id: string): Promise<Company | undefined> {
    const [company] = await db.select().from(companies).where(eq(companies.id, id));
    return company;
  }

  async createCompany(company: InsertCompany): Promise<Company> {
    const [created] = await db.insert(companies).values(company).returning();
    return created;
  }

  async updateCompany(id: string, company: InsertCompany): Promise<Company | undefined> {
    const [updated] = await db
      .update(companies)
      .set(company)
      .where(eq(companies.id, id))
      .returning();
    return updated;
  }

  async deleteCompany(id: string): Promise<boolean> {
    const result = await db.delete(companies).where(eq(companies.id, id)).returning();
    return result.length > 0;
  }

  async archiveCompany(id: string): Promise<Company | undefined> {
    const [updated] = await db
      .update(companies)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(companies.id, id))
      .returning();
    return updated;
  }

  async unarchiveCompany(id: string): Promise<Company | undefined> {
    const [updated] = await db
      .update(companies)
      .set({ archivedAt: null })
      .where(eq(companies.id, id))
      .returning();
    return updated;
  }

  async getContacts(): Promise<Contact[]> {
    return db.select().from(contacts);
  }

  async getContactsByCompany(companyId: string): Promise<Contact[]> {
    return db.select().from(contacts).where(eq(contacts.companyId, companyId));
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

  async getLatestFinancialUpload(): Promise<FinancialUpload | undefined> {
    const all = await db.select().from(financialUploads);
    if (all.length === 0) return undefined;
    return all.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0];
  }

  async createFinancialUpload(upload: InsertFinancialUpload): Promise<FinancialUpload> {
    const [created] = await db.insert(financialUploads).values(upload).returning();
    return created;
  }

  async deleteFinancialUpload(id: string): Promise<boolean> {
    const result = await db.delete(financialUploads).where(eq(financialUploads.id, id)).returning();
    return result.length > 0;
  }

  async deleteAllFinancialUploads(): Promise<void> {
    await db.delete(financialUploads);
  }

  async searchCompanies(query: string): Promise<Company[]> {
    return db.select().from(companies).where(ilike(companies.name, `%${query}%`)).limit(10);
  }

  async searchUsers(query: string, roles: string[]): Promise<Omit<User, 'password'>[]> {
    return db.select({
      id: users.id,
      username: users.username,
      name: users.name,
      role: users.role,
      managerId: users.managerId,
    }).from(users).where(
      and(
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

  async closeSession(sessionId: string): Promise<OneOnOneSession | undefined> {
    const [session] = await db.select().from(oneOnOneSessions).where(eq(oneOnOneSessions.id, sessionId));
    if (!session) return undefined;

    const pendingTopics = await db.select().from(oneOnOneTopics).where(
      and(
        eq(oneOnOneTopics.sessionId, sessionId),
        eq(oneOnOneTopics.status, "pending")
      )
    );

    await db.update(oneOnOneSessions)
      .set({ status: "archived" })
      .where(eq(oneOnOneSessions.id, sessionId));

    const [newSession] = await db.insert(oneOnOneSessions).values({
      namId: session.namId,
      amId: session.amId,
      status: "active",
      startDate: new Date().toISOString(),
    }).returning();

    for (const topic of pendingTopics) {
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

  async searchContacts(query: string): Promise<Contact[]> {
    return db.select().from(contacts).where(
      or(ilike(contacts.name, `%${query}%`), ilike(contacts.title, `%${query}%`))
    ).limit(8);
  }

  async searchRfps(query: string): Promise<Rfp[]> {
    return db.select().from(rfps).where(ilike(rfps.title, `%${query}%`)).limit(6);
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

  async getTeamPerformance(teamMemberIds: string[]): Promise<Array<{ userId: string; openTasks: number; overdueTasks: number; completedTasks: number; companyCount: number; newContacts: number; callTouchpoints: number; textTouchpoints: number; emailTouchpoints: number; contactsTouched: number; baseAdvanced: number }>> {
    if (teamMemberIds.length === 0) return [];
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

    const [allTasks, allCompanies, allTouchpoints, allContacts] = await Promise.all([
      db.select().from(tasks).where(inArray(tasks.assignedTo, teamMemberIds)),
      db.select().from(companies).where(inArray(companies.assignedTo, teamMemberIds)),
      db.select().from(touchpoints).where(
        and(inArray(touchpoints.loggedById, teamMemberIds), gte(touchpoints.date, monthStart))
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
        newContacts: userContacts.filter(c => c.createdAt && c.createdAt >= monthStart).length,
        callTouchpoints: userTouchpoints.filter(t => t.type === "call").length,
        textTouchpoints: userTouchpoints.filter(t => t.type === "text").length,
        emailTouchpoints: userTouchpoints.filter(t => t.type === "email").length,
        contactsTouched: touchedContactIds.size,
        baseAdvanced: userContacts.filter(c => c.baseAdvancedAt && c.baseAdvancedAt >= monthStart).length,
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

  async getAmsMissingMonthlyGoals(namId?: string): Promise<Array<{ amId: string; amName: string }>> {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const allGoals = namId ? await this.getGoals({ namId }) : await this.getGoals({});
    const coveredAmIds = new Set(
      allGoals
        .filter(g => g.period === "monthly" && g.startDate >= firstDay && g.startDate <= lastDay)
        .map(g => g.amId)
    );
    const conditions: ReturnType<typeof eq>[] = [eq(users.role, "account_manager")];
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

  async createTouchpoint(tp: InsertTouchpoint): Promise<Touchpoint> {
    const [created] = await db.insert(touchpoints).values(tp).returning();
    return created;
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
      companiesResult = await db.select().from(companies).where(eq(companies.assignedTo, assignedToUserId));
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
}

export const storage = new DatabaseStorage();
