import { eq, inArray, ilike, or, and, desc } from "drizzle-orm";
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
  feedPosts,
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
  type FeedPost,
  type InsertFeedPost,
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
  getCompany(id: string): Promise<Company | undefined>;
  createCompany(company: InsertCompany): Promise<Company>;
  updateCompany(id: string, company: InsertCompany): Promise<Company | undefined>;
  deleteCompany(id: string): Promise<boolean>;
  
  getContacts(): Promise<Contact[]>;
  getContactsByCompany(companyId: string): Promise<Contact[]>;
  getContact(id: string): Promise<Contact | undefined>;
  createContact(contact: InsertContact): Promise<Contact>;
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

  searchCompanies(query: string): Promise<Company[]>;
  searchUsers(query: string, roles: string[]): Promise<Omit<User, 'password'>[]>;

  getTasks(): Promise<Task[]>;
  getTasksByCompany(companyId: string): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  createTask(task: InsertTask): Promise<Task>;
  updateTask(id: string, data: Partial<InsertTask>): Promise<Task | undefined>;
  deleteTask(id: string): Promise<boolean>;

  getFeedPosts(visibleAuthorIds?: string[]): Promise<FeedPost[]>;
  createFeedPost(post: InsertFeedPost): Promise<FeedPost>;
  getFeedPost(id: string): Promise<FeedPost | undefined>;
  deleteFeedPost(id: string): Promise<boolean>;

  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
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

  async getFeedPosts(visibleAuthorIds?: string[]): Promise<FeedPost[]> {
    if (visibleAuthorIds) {
      return db.select().from(feedPosts)
        .where(inArray(feedPosts.authorId, visibleAuthorIds))
        .orderBy(desc(feedPosts.createdAt))
        .limit(30);
    }
    return db.select().from(feedPosts).orderBy(desc(feedPosts.createdAt)).limit(30);
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
}

export const storage = new DatabaseStorage();
