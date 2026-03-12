import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, decimal, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const companies = pgTable("companies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  industry: text("industry"),
  website: text("website"),
  notes: text("notes"),
  assignedTo: varchar("assigned_to"),
  portalUrl: text("portal_url"),
  portalUsername: text("portal_username"),
  portalPassword: text("portal_password"),
});

export const insertCompanySchema = createInsertSchema(companies).omit({
  id: true,
});

export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companies.$inferSelect;

export const contacts = pgTable("contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title"),
  relationshipBase: text("relationship_base"),
  email: text("email"),
  phone: text("phone"),
  reportsToId: varchar("reports_to_id"),
  lanes: text("lanes").array(),
  regions: text("regions").array(),
  freightSpend: decimal("freight_spend", { precision: 12, scale: 2 }),
  spotBiddingProcess: text("spot_bidding_process"),
  interests: text("interests"),
  notes: text("notes"),
});

export const insertContactSchema = createInsertSchema(contacts).omit({
  id: true,
});

export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contacts.$inferSelect;

export const rfps = pgTable("rfps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status").notNull().default("pending"),
  value: decimal("value", { precision: 12, scale: 2 }),
  dueDate: text("due_date"),
  notes: text("notes"),
  fileName: text("file_name"),
  fileData: jsonb("file_data"),
  laneCount: integer("lane_count"),
  totalVolume: text("total_volume"),
  originStates: text("origin_states").array(),
  destinationStates: text("destination_states").array(),
});

export const insertRfpSchema = createInsertSchema(rfps).omit({
  id: true,
});

export type InsertRfp = z.infer<typeof insertRfpSchema>;
export type Rfp = typeof rfps.$inferSelect;

export const awards = pgTable("awards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  value: decimal("value", { precision: 12, scale: 2 }),
  awardDate: text("award_date"),
  lanes: text("lanes").array(),
  notes: text("notes"),
  fileName: text("file_name"),
  fileData: text("file_data"),
});

export const insertAwardSchema = createInsertSchema(awards).omit({
  id: true,
});

export type InsertAward = z.infer<typeof insertAwardSchema>;
export type Award = typeof awards.$inferSelect;

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull().default(""),
  role: text("role").notNull().default("account_manager"),
  managerId: varchar("manager_id"),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const financialUploads = pgTable("financial_uploads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileName: text("file_name").notNull(),
  uploadedAt: text("uploaded_at").notNull(),
  uploadedBy: varchar("uploaded_by").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  rows: jsonb("rows").notNull().default([]),
});

export const insertFinancialUploadSchema = createInsertSchema(financialUploads).omit({
  id: true,
});

export type InsertFinancialUpload = z.infer<typeof insertFinancialUploadSchema>;
export type FinancialUpload = typeof financialUploads.$inferSelect;

export const tasks = pgTable("tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  notes: text("notes"),
  status: text("status").notNull().default("open"),
  dueDate: text("due_date"),
  assignedTo: varchar("assigned_to").notNull(),
  assignedBy: varchar("assigned_by").notNull(),
  companyId: varchar("company_id"),
  contactId: varchar("contact_id"),
  createdAt: text("created_at").notNull(),
});

export const insertTaskSchema = createInsertSchema(tasks).omit({
  id: true,
});

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type AppSetting = typeof appSettings.$inferSelect;
