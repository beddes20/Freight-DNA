import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, serial, decimal, jsonb, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const organizations = pgTable("organizations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  billingStatus: text("billing_status").default("pending"),
  planName: text("plan_name"),
  currentPeriodEnd: timestamp("current_period_end"),
});

export const insertOrganizationSchema = createInsertSchema(organizations).omit({ id: true, createdAt: true });
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizations.$inferSelect;

export const companies = pgTable("companies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  industry: text("industry"),
  website: text("website"),
  notes: text("notes"),
  assignedTo: varchar("assigned_to"),
  portalUrl: text("portal_url"),
  portalUsername: text("portal_username"),
  portalPassword: text("portal_password"),
  archivedAt: text("archived_at"),
  financialAlias: text("financial_alias"),
  tenderStyle: text("tender_style"),
  accountQuirks: text("account_quirks"),
  processNotes: text("process_notes"),
  spotProcess: text("spot_process"),
  dlEmail: varchar("dl_email"),
  salesPersonId: varchar("sales_person_id"),
  shippingModes: text("shipping_modes").array(),
  estimatedFreightSpend: decimal("estimated_freight_spend", { precision: 14, scale: 2 }),
  accountSummary: text("account_summary"),
  sharedReps: jsonb("shared_reps").default([]),
  operatingHours: text("operating_hours"),
});

export const sharedRepSchema = z.object({
  userId: z.string(),
  territoryNote: z.string().optional(),
});
export type SharedRep = z.infer<typeof sharedRepSchema>;

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
  nextSteps: text("next_steps"),
  interests: text("interests"),
  notes: text("notes"),
  createdAt: text("created_at"),
  createdBy: varchar("created_by"),
  baseAdvancedAt: text("base_advanced_at"),
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
  closeReason: text("close_reason"),
  closeNotes: text("close_notes"),
  rfpType: text("rfp_type"),
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

export const marketShareEntries = pgTable("market_share_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  entryType: text("entry_type").notNull().default("monthly"), // 'monthly' | 'rfp_cycle'
  periodLabel: text("period_label").notNull(),
  periodStart: text("period_start"),
  periodEnd: text("period_end"),
  totalMarketLoads: integer("total_market_loads"),
  vtLoads: integer("vt_loads").default(0),
  spotLoads: integer("spot_loads").default(0),
  rfpId: varchar("rfp_id"),
  notes: text("notes"),
  createdAt: text("created_at"),
  createdBy: varchar("created_by"),
});

export const insertMarketShareEntrySchema = createInsertSchema(marketShareEntries).omit({
  id: true,
});

export type InsertMarketShareEntry = z.infer<typeof insertMarketShareEntrySchema>;
export type MarketShareEntry = typeof marketShareEntries.$inferSelect;

export const userRoles = ["admin", "director", "national_account_manager", "account_manager", "sales", "sales_director", "logistics_manager", "logistics_coordinator"] as const;
export type UserRole = typeof userRoles[number];

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull().default(""),
  role: text("role").notNull().default("account_manager"),
  managerId: varchar("manager_id"),
  lastLoginAt: text("last_login_at"),
  financialRepId: text("financial_rep_id"),
  createdAt: text("created_at"),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
}).extend({
  role: z.enum(userRoles).default("account_manager"),
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
  summaryRows: jsonb("summary_rows").notNull().default([]),
  bestDealDaysSpot: jsonb("best_deal_days_spot").notNull().default([]),
  bestDealDaysAll: jsonb("best_deal_days_all").notNull().default([]),
  trendAnalysis: jsonb("trend_analysis").notNull().default([]),
  averagesData: jsonb("averages_data").notNull().default([]),
  dailyAcquisition: jsonb("daily_acquisition").notNull().default([]),
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
  assignedTo: varchar("assigned_to").notNull().references(() => users.id),
  assignedBy: varchar("assigned_by").notNull().references(() => users.id),
  companyId: varchar("company_id").references(() => companies.id),
  contactId: varchar("contact_id").references(() => contacts.id),
  createdAt: text("created_at").notNull(),
  attachedLaneData: jsonb("attached_lane_data"),
  forwardedFrom: varchar("forwarded_from"),
});

export const insertTaskSchema = createInsertSchema(tasks).omit({
  id: true,
});

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;

export const callouts = pgTable("callouts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  body: text("body"),
  tag: text("tag"),
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "set null" }),
  authorId: varchar("author_id").notNull().references(() => users.id),
  parentId: varchar("parent_id"),
  createdAt: text("created_at").notNull(),
});

export const insertCalloutSchema = createInsertSchema(callouts).omit({
  id: true,
});

export type InsertCallout = z.infer<typeof insertCalloutSchema>;
export type Callout = typeof callouts.$inferSelect;

export const feedPosts = pgTable("feed_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  content: text("content").notNull(),
  category: text("category").notNull().default("idea"),
  authorId: varchar("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  parentId: varchar("parent_id"),
  pinned: boolean("pinned").default(false),
  pinnedAt: text("pinned_at"),
});

export const insertFeedPostSchema = createInsertSchema(feedPosts).omit({
  id: true,
});

export type InsertFeedPost = z.infer<typeof insertFeedPostSchema>;
export type FeedPost = typeof feedPosts.$inferSelect;

export const calloutReactions = pgTable("callout_reactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  calloutId: varchar("callout_id").notNull().references(() => callouts.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  emoji: text("emoji").notNull(),
  createdAt: text("created_at").notNull(),
});

export const insertCalloutReactionSchema = createInsertSchema(calloutReactions).omit({
  id: true,
});

export type InsertCalloutReaction = z.infer<typeof insertCalloutReactionSchema>;
export type CalloutReaction = typeof calloutReactions.$inferSelect;

export const oneOnOneSessions = pgTable("one_on_one_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  namId: varchar("nam_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  amId: varchar("am_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"),
  startDate: text("start_date").notNull(),
  notes: text("notes").default(""),
  meetingDate: text("meeting_date"),
  meetingLink: text("meeting_link"),
  moraleScore: integer("morale_score"),
  sessionSummary: text("session_summary"),
  closedAt: text("closed_at"),
});

export const insertOneOnOneSessionSchema = createInsertSchema(oneOnOneSessions).omit({
  id: true,
});

export type InsertOneOnOneSession = z.infer<typeof insertOneOnOneSessionSchema>;
export type OneOnOneSession = typeof oneOnOneSessions.$inferSelect;

export const oneOnOneTopics = pgTable("one_on_one_topics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => oneOnOneSessions.id, { onDelete: "cascade" }),
  addedById: varchar("added_by_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  tag: text("tag"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
});

export const insertOneOnOneTopicSchema = createInsertSchema(oneOnOneTopics).omit({
  id: true,
});

export type InsertOneOnOneTopic = z.infer<typeof insertOneOnOneTopicSchema>;
export type OneOnOneTopic = typeof oneOnOneTopics.$inferSelect;

export const oneOnOneTopicReplies = pgTable("one_on_one_topic_replies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  topicId: varchar("topic_id").notNull().references(() => oneOnOneTopics.id, { onDelete: "cascade" }),
  authorId: varchar("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
});

export const insertOneOnOneTopicReplySchema = createInsertSchema(oneOnOneTopicReplies).omit({ id: true });
export type InsertOneOnOneTopicReply = z.infer<typeof insertOneOnOneTopicReplySchema>;
export type OneOnOneTopicReply = typeof oneOnOneTopicReplies.$inferSelect;

export const feedPostReactions = pgTable("feed_post_reactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  feedPostId: varchar("feed_post_id").notNull().references(() => feedPosts.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  emoji: text("emoji").notNull(),
  createdAt: text("created_at").notNull(),
});

export const insertFeedPostReactionSchema = createInsertSchema(feedPostReactions).omit({
  id: true,
});

export type InsertFeedPostReaction = z.infer<typeof insertFeedPostReactionSchema>;
export type FeedPostReaction = typeof feedPostReactions.$inferSelect;

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at"),
  updatedById: varchar("updated_by_id").references(() => users.id),
});

export type AppSetting = typeof appSettings.$inferSelect;

export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 50 }).notNull(),
  title: text("title").notNull(),
  body: text("body"),
  link: text("link"),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  relatedId: varchar("related_id"),
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
});

export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notifications.$inferSelect;

export const goals = pgTable("goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  namId: varchar("nam_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  amId: varchar("am_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  metric: text("metric").notNull(),
  period: text("period").notNull(),
  target: decimal("target", { precision: 14, scale: 2 }).notNull(),
  currentValue: decimal("current_value", { precision: 14, scale: 2 }).notNull().default("0"),
  title: text("title"),
  customLabel: text("custom_label"),
  notes: text("notes"),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  createdAt: text("created_at").notNull(),
  createdById: varchar("created_by_id").notNull().references(() => users.id),
  status: text("status").notNull().default("active"),
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "set null" }),
});

export const insertGoalSchema = createInsertSchema(goals).omit({ id: true });
export type InsertGoal = z.infer<typeof insertGoalSchema>;
export type Goal = typeof goals.$inferSelect;

export const goalComments = pgTable("goal_comments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: varchar("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
  authorId: varchar("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
});

export const insertGoalCommentSchema = createInsertSchema(goalComments).omit({ id: true });
export type InsertGoalComment = z.infer<typeof insertGoalCommentSchema>;
export type GoalComment = typeof goalComments.$inferSelect;

export const touchpoints = pgTable("touchpoints", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  date: text("date").notNull(),
  notes: text("notes"),
  sentiment: text("sentiment"),
  isMeaningful: boolean("is_meaningful").default(false),
  loggedById: varchar("logged_by_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
});

export const insertTouchpointSchema = createInsertSchema(touchpoints).omit({ id: true });
export type InsertTouchpoint = z.infer<typeof insertTouchpointSchema>;
export type Touchpoint = typeof touchpoints.$inferSelect;

export const attachments = pgTable("attachments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  entityType: text("entity_type").notNull(),
  entityId: varchar("entity_id").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  fileData: text("file_data").notNull(),
  createdAt: text("created_at").notNull(),
});

export const insertAttachmentSchema = createInsertSchema(attachments).omit({ id: true });
export type InsertAttachment = z.infer<typeof insertAttachmentSchema>;
export type Attachment = typeof attachments.$inferSelect;

export const personalAlerts = pgTable("personal_alerts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  notes: text("notes"),
  scheduledDate: text("scheduled_date").notNull(),
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "set null" }),
  fired: boolean("fired").notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const insertPersonalAlertSchema = createInsertSchema(personalAlerts).omit({ id: true });
export type InsertPersonalAlert = z.infer<typeof insertPersonalAlertSchema>;
export type PersonalAlert = typeof personalAlerts.$inferSelect;

export const ptoPassoffs = pgTable("pto_passoffs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  createdById: varchar("created_by_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  coveringUserId: varchar("covering_user_id").references(() => users.id),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  emergencyContact: text("emergency_contact"),
  generalNotes: text("general_notes"),
  status: text("status").notNull().default("draft"),
  createdAt: text("created_at").notNull(),
});
export const insertPtoPassoffSchema = createInsertSchema(ptoPassoffs).omit({ id: true, createdAt: true });
export type InsertPtoPassoff = z.infer<typeof insertPtoPassoffSchema>;
export type PtoPassoff = typeof ptoPassoffs.$inferSelect;

export const ptoPassoffItems = pgTable("pto_passoff_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  passoffId: varchar("passoff_id").notNull().references(() => ptoPassoffs.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "cascade" }),
  priority: text("priority").notNull().default("medium"),
  spotFreightHandler: text("spot_freight_handler"),
  keyCustomerContact: text("key_customer_contact"),
  openItems: text("open_items"),
  processNotes: text("process_notes"),
  activeDeals: text("active_deals"),
  acknowledged: boolean("acknowledged").notNull().default(false),
  emailForwardingSet: boolean("email_forwarding_set").notNull().default(false),
  spotBoardUpdated: boolean("spot_board_updated").notNull().default(false),
  avgWeeklySpotLoads: decimal("avg_weekly_spot_loads"),
  avgWeeklyTotalLoads: decimal("avg_weekly_total_loads"),
  coveringNotes: text("covering_notes"),
  overrideCoveringUserId: varchar("override_covering_user_id").references(() => users.id),
});
export const insertPtoPassoffItemSchema = createInsertSchema(ptoPassoffItems).omit({ id: true });
export type InsertPtoPassoffItem = z.infer<typeof insertPtoPassoffItemSchema>;
export type PtoPassoffItem = typeof ptoPassoffItems.$inferSelect;

export const vendorRouted = pgTable("vendor_routed", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  rowKey: text("row_key").notNull(),
  active: boolean("active").notNull().default(true),
}, (table) => [
  uniqueIndex("vendor_routed_company_row_key").on(table.companyId, table.rowKey),
]);

export const insertVendorRoutedSchema = createInsertSchema(vendorRouted).omit({ id: true });
export type InsertVendorRouted = z.infer<typeof insertVendorRoutedSchema>;
export type VendorRouted = typeof vendorRouted.$inferSelect;

export const taskComments = pgTable("task_comments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  authorId: varchar("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
  parentId: varchar("parent_id"),
});
export const insertTaskCommentSchema = createInsertSchema(taskComments).omit({ id: true });
export type InsertTaskComment = z.infer<typeof insertTaskCommentSchema>;
export type TaskComment = typeof taskComments.$inferSelect;

export const chatConversations = pgTable("chat_conversations", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("New Chat"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertChatConversationSchema = createInsertSchema(chatConversations).omit({ id: true });
export type InsertChatConversation = z.infer<typeof insertChatConversationSchema>;
export type ChatConversation = typeof chatConversations.$inferSelect;

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});
export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({ id: true });
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;

export const appSuggestions = pgTable("app_suggestions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  submittedById: varchar("submitted_by_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  status: text("status").notNull().default("new"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  adminResponse: text("admin_response"),
  respondedAt: timestamp("responded_at"),
});
export const insertAppSuggestionSchema = createInsertSchema(appSuggestions).omit({ id: true, createdAt: true });
export type InsertAppSuggestion = z.infer<typeof insertAppSuggestionSchema>;
export type AppSuggestion = typeof appSuggestions.$inferSelect;

export const developmentGoals = pgTable("development_goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  namId: varchar("nam_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  amId: varchar("am_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
  updatedById: varchar("updated_by_id").notNull().references(() => users.id),
});

export const insertDevelopmentGoalSchema = createInsertSchema(developmentGoals).omit({ id: true });
export type InsertDevelopmentGoal = z.infer<typeof insertDevelopmentGoalSchema>;
export type DevelopmentGoal = typeof developmentGoals.$inferSelect;

export const reportCardSnapshots = pgTable("report_card_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  periodType: text("period_type").notNull(),
  periodLabel: text("period_label").notNull(),
  snapshotDate: text("snapshot_date").notNull(),
  payload: jsonb("payload").notNull(),
  savedById: varchar("saved_by_id").notNull().references(() => users.id),
});

export const insertReportCardSnapshotSchema = createInsertSchema(reportCardSnapshots).omit({ id: true });
export type InsertReportCardSnapshot = z.infer<typeof insertReportCardSnapshotSchema>;
export type ReportCardSnapshot = typeof reportCardSnapshots.$inferSelect;

export const promotionCriteria = pgTable("promotion_criteria", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromRole: text("from_role").notNull(),
  toRole: text("to_role").notNull(),
  minLoadCount: integer("min_load_count"),
  minMarginPct: decimal("min_margin_pct", { precision: 8, scale: 2 }),
  minTouchpoints: integer("min_touchpoints"),
  minTenureMonths: integer("min_tenure_months"),
  notes: text("notes"),
  updatedAt: text("updated_at"),
  updatedById: varchar("updated_by_id").references(() => users.id),
});

export const insertPromotionCriteriaSchema = createInsertSchema(promotionCriteria).omit({ id: true });
export type InsertPromotionCriteria = z.infer<typeof insertPromotionCriteriaSchema>;
export type PromotionCriteria = typeof promotionCriteria.$inferSelect;

export const promotionNominations = pgTable("promotion_nominations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  nomineeId: varchar("nominee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  nominatedById: varchar("nominated_by_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  notes: text("notes"),
  nominatedAt: text("nominated_at").notNull(),
  status: text("status").notNull().default("active"),
});

export const insertPromotionNominationSchema = createInsertSchema(promotionNominations).omit({ id: true });
export type InsertPromotionNomination = z.infer<typeof insertPromotionNominationSchema>;
export type PromotionNomination = typeof promotionNominations.$inferSelect;

export const internalPosts = pgTable("internal_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  content: text("content").notNull(),
  authorId: varchar("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  recipientIds: text("recipient_ids").array().notNull().default(sql`'{}'::text[]`),
  parentId: varchar("parent_id"),
  createdAt: text("created_at").notNull(),
});
export const insertInternalPostSchema = createInsertSchema(internalPosts).omit({ id: true });
export type InsertInternalPost = z.infer<typeof insertInternalPostSchema>;
export type InternalPost = typeof internalPosts.$inferSelect;

export const demoRequests = pgTable("demo_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  interest: text("interest").notNull(),
  preferredDate: text("preferred_date").notNull(),
  preferredTime: text("preferred_time").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertDemoRequestSchema = createInsertSchema(demoRequests).omit({ id: true, createdAt: true });
export type InsertDemoRequest = z.infer<typeof insertDemoRequestSchema>;
export type DemoRequest = typeof demoRequests.$inferSelect;

export const lmDailyChecks = pgTable("lm_daily_checks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id),
  lmUserId: varchar("lm_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  checkedByUserId: varchar("checked_by_user_id").notNull().references(() => users.id),
  date: text("date").notNull(),
  callsBeforeSevenThirty: boolean("calls_before_seven_thirty"),
  checkoutCompleted: boolean("checkout_completed"),
}, (table) => [
  uniqueIndex("lm_daily_checks_lm_date").on(table.lmUserId, table.date),
]);

export const insertLmDailyCheckSchema = createInsertSchema(lmDailyChecks).omit({ id: true });
export type InsertLmDailyCheck = z.infer<typeof insertLmDailyCheckSchema>;
export type LmDailyCheck = typeof lmDailyChecks.$inferSelect;

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: varchar("token", { length: 128 }).notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const opportunityLogs = pgTable("opportunity_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id),
  repId: varchar("rep_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "set null" }),
  type: text("type").notNull(), // "opportunity" | "win"
  category: text("category").notNull().default("other"),
  title: text("title").notNull(),
  description: text("description"),
  estimatedLoads: integer("estimated_loads"),
  estimatedValue: decimal("estimated_value"),
  loggedAt: text("logged_at").notNull(),
  createdAt: text("created_at").notNull(),
});
export const insertOpportunityLogSchema = createInsertSchema(opportunityLogs).omit({ id: true, createdAt: true });
export type InsertOpportunityLog = z.infer<typeof insertOpportunityLogSchema>;
export type OpportunityLog = typeof opportunityLogs.$inferSelect;

export const contactLaneAttributions = pgTable("contact_lane_attributions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  originCity: text("origin_city"),
  originState: text("origin_state"),
  destinationCity: text("destination_city"),
  destinationState: text("destination_state"),
  source: text("source").notNull().default("manual"), // 'manual' | 'rfp' | 'award' | 'ai'
  notes: text("notes"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: text("created_at"),
});
export const insertContactLaneAttributionSchema = createInsertSchema(contactLaneAttributions).omit({ id: true, createdAt: true });
export type InsertContactLaneAttribution = z.infer<typeof insertContactLaneAttributionSchema>;
export type ContactLaneAttribution = typeof contactLaneAttributions.$inferSelect;

export const toolLinks = pgTable("tool_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  url: text("url").notNull(),
  description: text("description"),
  iconName: text("icon_name").default("Link"),
  color: text("color").default("from-blue-500 to-blue-600"),
  sortOrder: integer("sort_order").default(0),
  createdById: varchar("created_by_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
});
export const insertToolLinkSchema = createInsertSchema(toolLinks).omit({ id: true });
export type InsertToolLink = z.infer<typeof insertToolLinkSchema>;
export type ToolLink = typeof toolLinks.$inferSelect;

// ── Sales Prospect Pipeline ───────────────────────────────────────────────────

export const prospectStages = [
  "new_lead",
  "intro_scheduled",
  "intro_completed",
  "follow_up",
  "opportunity_sent",
  "first_load_won",
  "lost",
  "disqualified",
] as const;
export type ProspectStage = typeof prospectStages[number];

export const PROSPECT_STAGE_LABELS: Record<ProspectStage, string> = {
  new_lead: "New Lead",
  intro_scheduled: "Intro Scheduled",
  intro_completed: "Intro Completed",
  follow_up: "Active Follow-Up",
  opportunity_sent: "Opportunity Sent",
  first_load_won: "First Load Won",
  lost: "Lost",
  disqualified: "Disqualified",
};

export const PROSPECT_LEAD_SOURCES = [
  "cold_call",
  "zoominfo",
  "linkedin",
  "referral",
  "conference",
  "website_inbound",
  "email_campaign",
  "other",
] as const;

export const PROSPECT_LEAD_SOURCE_LABELS: Record<typeof PROSPECT_LEAD_SOURCES[number], string> = {
  cold_call: "Cold Call",
  zoominfo: "ZoomInfo",
  linkedin: "LinkedIn",
  referral: "Referral",
  conference: "Conference",
  website_inbound: "Website Inbound",
  email_campaign: "Email Campaign",
  other: "Other",
};

export const PROSPECT_LOST_REASONS = [
  "price",
  "timing",
  "incumbent",
  "no_volume",
  "ghosted",
  "wrong_fit",
  "other",
] as const;

export const PROSPECT_LOST_REASON_LABELS: Record<typeof PROSPECT_LOST_REASONS[number], string> = {
  price: "Price / Rates",
  timing: "Bad Timing",
  incumbent: "Incumbent Too Entrenched",
  no_volume: "No Real Volume",
  ghosted: "Ghosted / Unresponsive",
  wrong_fit: "Wrong Fit",
  other: "Other",
};

export const PROSPECT_PRIORITIES = ["hot", "warm", "cold"] as const;
export const PROSPECT_CONTACT_ROLES = [
  "champion",
  "decision_maker",
  "gatekeeper",
  "influencer",
  "other",
] as const;

export const prospects = pgTable("prospects", {
  id: serial("id").primaryKey(),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  industry: text("industry"),
  website: text("website"),
  estimatedSpend: text("estimated_spend"),
  shippingModes: text("shipping_modes").array(),
  stage: text("stage").notNull().default("new_lead"),
  ownerId: varchar("owner_id").notNull().references(() => users.id),
  assignedNamId: varchar("assigned_nam_id").references(() => users.id),
  primaryContactName: text("primary_contact_name"),
  primaryContactTitle: text("primary_contact_title"),
  primaryContactEmail: text("primary_contact_email"),
  primaryContactPhone: text("primary_contact_phone"),
  primaryContactLinkedin: text("primary_contact_linkedin"),
  notes: text("notes"),
  nextSteps: text("next_steps"),
  followUpDate: text("follow_up_date"),
  opportunityType: text("opportunity_type"),
  opportunityNotes: text("opportunity_notes"),
  convertedToCompanyId: varchar("converted_to_company_id"),
  convertedAt: timestamp("converted_at"),
  // Phase 2 qualifying fields
  lostReason: text("lost_reason"),
  leadSource: text("lead_source"),
  priority: text("priority"),
  expectedCloseDate: text("expected_close_date"),
  dealProbability: integer("deal_probability"),
  estLoadsPerWeek: text("est_loads_per_week"),
  topLanes: text("top_lanes"),
  commodity: text("commodity"),
  currentCarrier: text("current_carrier"),
  painPoints: text("pain_points"),
  intelBrief: text("intel_brief"),
  stageChangedAt: timestamp("stage_changed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertProspectSchema = createInsertSchema(prospects).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProspect = typeof insertProspectSchema._type;
export type Prospect = typeof prospects.$inferSelect;

export const prospectActivities = pgTable("prospect_activities", {
  id: serial("id").primaryKey(),
  prospectId: integer("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  notes: text("notes").notNull(),
  createdById: varchar("created_by_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertProspectActivitySchema = createInsertSchema(prospectActivities).omit({ id: true, createdAt: true });
export type InsertProspectActivity = typeof insertProspectActivitySchema._type;
export type ProspectActivity = typeof prospectActivities.$inferSelect;

export const prospectContacts = pgTable("prospect_contacts", {
  id: serial("id").primaryKey(),
  prospectId: integer("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title"),
  email: text("email"),
  phone: text("phone"),
  linkedin: text("linkedin"),
  role: text("role").default("other"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertProspectContactSchema = createInsertSchema(prospectContacts).omit({ id: true, createdAt: true });
export type InsertProspectContact = typeof insertProspectContactSchema._type;
export type ProspectContact = typeof prospectContacts.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

// Carrier Procurement Rolodex
export const laneCarriers = pgTable("lane_carriers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  awardId: varchar("award_id").notNull().references(() => awards.id, { onDelete: "cascade" }),
  lane: text("lane").notNull(),
  carrierName: text("carrier_name").notNull(),
  mcNumber: text("mc_number"),
  contactName: text("contact_name"),
  phone: text("phone"),
  email: text("email"),
  rate: text("rate"),
  capacityPerWeek: integer("capacity_per_week"),
  notes: text("notes"),
  status: text("status").notNull().default("contacted"),
  createdAt: text("created_at").notNull(),
});

export const insertLaneCarrierSchema = createInsertSchema(laneCarriers).omit({ id: true });
export type InsertLaneCarrier = z.infer<typeof insertLaneCarrierSchema>;
export type LaneCarrier = typeof laneCarriers.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

// Contact relationship base change history
export const contactBaseHistory = pgTable("contact_base_history", {
  id: serial("id").primaryKey(),
  contactId: varchar("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  fromBase: text("from_base"),
  toBase: text("to_base").notNull(),
  changedById: varchar("changed_by_id").notNull().references(() => users.id),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
});
export type ContactBaseHistory = typeof contactBaseHistory.$inferSelect;

