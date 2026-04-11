import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, serial, decimal, jsonb, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
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
  lastSeenAt: timestamp("last_seen_at"),
  sourceType: text("source_type"),
  roleType: text("role_type"),
  status: text("status").default("active"),
  isPrimary: boolean("is_primary").default(false),
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
  password: text("password"),
  name: text("name").notNull().default(""),
  role: text("role").notNull().default("account_manager"),
  managerId: varchar("manager_id"),
  lastLoginAt: text("last_login_at"),
  financialRepId: text("financial_rep_id"),
  createdAt: text("created_at"),
  emailSignature: text("email_signature"),
  clerkUserId: text("clerk_user_id").unique(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
}).extend({
  role: z.enum(userRoles).default("account_manager"),
  password: z.string().optional(),
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
  description: text("description"),
  status: text("status").notNull().default("open"),
  dueDate: text("due_date"),
  assignedTo: varchar("assigned_to").notNull().references(() => users.id),
  assignedBy: varchar("assigned_by").notNull().references(() => users.id),
  companyId: varchar("company_id").references(() => companies.id),
  contactId: varchar("contact_id").references(() => contacts.id),
  orgId: varchar("org_id").references(() => organizations.id),
  companyName: text("company_name"),
  contactName: text("contact_name"),
  opportunityId: integer("opportunity_id").references(() => crmOpportunities.id, { onDelete: "set null" }),
  laneContext: jsonb("lane_context"),
  lever: text("lever"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
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

export const accountStatuses = [
  "prospecting",
  "intro_scheduled",
  "active_customer",
  "dormant",
  "lost",
] as const;
export type AccountStatus = typeof accountStatuses[number];

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  prospecting: "Prospecting",
  intro_scheduled: "Intro Scheduled",
  active_customer: "Active Customer",
  dormant: "Dormant",
  lost: "Lost",
};

export const ACCOUNT_STATUS_COLORS: Record<AccountStatus, string> = {
  prospecting: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  intro_scheduled: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  active_customer: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  dormant: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  lost: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

export const CRM_OPP_RECORD_TYPES = [
  "single_multi_lane",
  "private_hauling",
  "rfp",
  "trucking_opportunity",
] as const;
export type CrmOppRecordType = typeof CRM_OPP_RECORD_TYPES[number];

export const CRM_OPP_RECORD_TYPE_LABELS: Record<CrmOppRecordType, string> = {
  single_multi_lane: "Single/Multi Lane",
  private_hauling: "Private Hauling",
  rfp: "RFP",
  trucking_opportunity: "Trucking Opportunity",
};

export const CRM_OPP_RECORD_TYPE_DESCRIPTIONS: Record<CrmOppRecordType, string> = {
  single_multi_lane: "Standard spot or contract lanes — single or multi-lane freight program",
  private_hauling: "Converting private fleet operations to outsourced trucking",
  rfp: "Responding to a formal Request for Proposal (bid event)",
  trucking_opportunity: "Full truckload opportunity — contract, spot, or dedicated",
};

export const CRM_OPP_STAGES = [
  "qualification",
  "discovery",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
] as const;
export type CrmOppStage = typeof CRM_OPP_STAGES[number];

export const CRM_OPP_STAGE_LABELS: Record<CrmOppStage, string> = {
  qualification: "Qualification",
  discovery: "Discovery",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Closed Won",
  closed_lost: "Closed Lost",
};

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
  estimatedAnnualRevenue: text("estimated_annual_revenue"),
  employeeCount: text("employee_count"),
  intelBrief: text("intel_brief"),
  stageChangedAt: timestamp("stage_changed_at"),
  // TMS / Portal fields (Launchpad)
  tmsWebsite: text("tms_website"),
  tmsEmail: text("tms_email"),
  schedulingWebsite: text("scheduling_website"),
  schedulingEmail: text("scheduling_email"),
  tmsUsername: text("tms_username"),
  tmsPassword: text("tms_password"),
  phone: text("phone"),
  billingAddress: text("billing_address"),
  accountStatus: text("account_status").default("prospecting"),
  accountStatusChangedAt: timestamp("account_status_changed_at"),
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

// Launchpad CRM — Opportunities
export const crmOpportunities = pgTable("crm_opportunities", {
  id: serial("id").primaryKey(),
  prospectId: integer("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  recordType: text("record_type").notNull().default("single_multi_lane"),
  stage: text("stage").notNull().default("qualification"),
  amount: text("amount"),
  closeDate: text("close_date"),
  probability: integer("probability"),
  notes: text("notes"),
  lostReason: text("lost_reason"),
  /** Task #190 — closed_won / closed_lost / null (open) */
  outcome: text("outcome"),
  createdById: varchar("created_by_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const insertCrmOpportunitySchema = createInsertSchema(crmOpportunities).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCrmOpportunity = z.infer<typeof insertCrmOpportunitySchema>;
export type CrmOpportunity = typeof crmOpportunities.$inferSelect;

// Launchpad CRM — Account Ownership Requests
export const crmOwnershipRequests = pgTable("crm_ownership_requests", {
  id: serial("id").primaryKey(),
  prospectId: integer("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  requesterId: varchar("requester_id").notNull().references(() => users.id),
  currentOwnerId: varchar("current_owner_id").notNull().references(() => users.id),
  status: text("status").notNull().default("pending"),
  reason: text("reason"),
  adminNote: text("admin_note"),
  reviewedById: varchar("reviewed_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  reviewedAt: timestamp("reviewed_at"),
});
export const insertCrmOwnershipRequestSchema = createInsertSchema(crmOwnershipRequests).omit({ id: true, createdAt: true });
export type InsertCrmOwnershipRequest = z.infer<typeof insertCrmOwnershipRequestSchema>;
export type CrmOwnershipRequest = typeof crmOwnershipRequests.$inferSelect;

// Launchpad CRM — Account Field Change History
export const crmAccountHistory = pgTable("crm_account_history", {
  id: serial("id").primaryKey(),
  prospectId: integer("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedById: varchar("changed_by_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type CrmAccountHistory = typeof crmAccountHistory.$inferSelect;

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
  // contacted | emailed | replied | committed | declined
  outreachLog: jsonb("outreach_log").default([]),
  // [{sentAt, subject, bodyPreview, email, status}]
  createdAt: text("created_at").notNull(),
});

export const insertLaneCarrierSchema = createInsertSchema(laneCarriers).omit({ id: true });
export type InsertLaneCarrier = z.infer<typeof insertLaneCarrierSchema>;
export type LaneCarrier = typeof laneCarriers.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────

// Account Growth Score — cached nightly + on-demand per company
export const accountGrowthScores = pgTable("account_growth_scores", {
  id: serial("id").primaryKey(),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id),
  score: integer("score").notNull(),
  band: text("band").notNull(), // at_risk | stable | growth_ready | high_expansion
  previousScore: integer("previous_score"),       // score from the prior calculation (null on first calc)
  previousBand: text("previous_band"),            // band from the prior calculation (null on first calc)
  drivers: jsonb("drivers").notNull().default([]),
  calculatedAt: text("calculated_at").notNull(),
});
export const insertAccountGrowthScoreSchema = createInsertSchema(accountGrowthScores).omit({ id: true });
export type InsertAccountGrowthScore = z.infer<typeof insertAccountGrowthScoreSchema>;
export type AccountGrowthScore = typeof accountGrowthScores.$inferSelect;

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

// ─────────────────────────────────────────────────────────────────────────────

// Weekly AM Coaching Commitments
export const weeklyCommitments = pgTable("weekly_commitments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "set null" }),
  contactId: varchar("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  companyName: text("company_name"),
  contactName: text("contact_name"),
  commitmentText: text("commitment_text").notNull(),
  lever: text("lever").notNull().default("Recovery"),
  source: text("source").notNull().default("dashboard"),
  weekStart: text("week_start").notNull(),
  dueDate: text("due_date").notNull(),
  status: text("status").notNull().default("pending"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});
export const insertWeeklyCommitmentSchema = createInsertSchema(weeklyCommitments).omit({ id: true });
export type InsertWeeklyCommitment = z.infer<typeof insertWeeklyCommitmentSchema>;
export type WeeklyCommitment = typeof weeklyCommitments.$inferSelect;

// ─── NBA Phase 1 Persistent Cards ────────────────────────────────────────────
/**
 * Supported ruleType values:
 *   load_decline | single_thread_risk | stale_account | overdue_next_action |
 *   spot_to_contract | rfp_coverage_gap | stalled_award_lanes |
 *   recurring_lane_capacity | market_surge_customer_outreach
 *
 * market_surge_customer_outreach: generated by MarketNbaService when an active
 * MarketSignal exposes an account. Uses marketSignalId for dedup and lifecycle.
 */
export const nbaCards = pgTable("nba_cards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "set null" }),
  contactId: varchar("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  companyName: text("company_name"),
  ruleType: text("rule_type").notNull(),
  outcomeType: text("outcome_type").notNull().default("protect"),
  confidence: text("confidence").notNull().default("medium"),
  signalCount: integer("signal_count").notNull().default(1),
  signalSummary: jsonb("signal_summary").notNull().default([]),
  whyThisNow: text("why_this_now").notNull(),
  suggestedAction: text("suggested_action").notNull(),
  expectedOutcome: text("expected_outcome").notNull(),
  growthLever: text("growth_lever"),
  relationshipMove: text("relationship_move"),
  accountTier: text("account_tier"),
  urgencyScore: integer("urgency_score").notNull().default(0),
  status: text("status").notNull().default("generated"),
  resolutionAction: text("resolution_action"),
  dismissReason: text("dismiss_reason"),
  snoozeUntil: text("snooze_until"),
  alternateActionNote: text("alternate_action_note"),
  linkedCommitmentId: varchar("linked_commitment_id"),
  linkedTouchpointId: varchar("linked_touchpoint_id"),
  linkedTaskId: varchar("linked_task_id"),
  linkedLaneId: varchar("linked_lane_id"),
  marketSignalId: varchar("market_signal_id"),
  outcomeLinkedAt: text("outcome_linked_at"),
  outcomeTypeLinked: text("outcome_type_linked"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});
export const insertNbaCardSchema = createInsertSchema(nbaCards).omit({ id: true });
export type InsertNbaCard = z.infer<typeof insertNbaCardSchema>;
export type NbaCard = typeof nbaCards.$inferSelect;

// ─── Forced Focus ─────────────────────────────────────────────────────────────
export const forcedFocus = pgTable("forced_focus", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  assignedToUserId: varchar("assigned_to_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  assignedByUserId: varchar("assigned_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "set null" }),
  companyName: text("company_name"),
  contactId: varchar("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  contactName: text("contact_name"),
  relatedOpportunityId: varchar("related_opportunity_id"),
  relatedTaskId: varchar("related_task_id"),
  lever: text("lever"),
  actionText: text("action_text").notNull(),
  contextReason: text("context_reason"),
  dueDate: text("due_date"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});

export const insertForcedFocusSchema = createInsertSchema(forcedFocus).omit({ id: true });
export type InsertForcedFocus = z.infer<typeof insertForcedFocusSchema>;
export type ForcedFocus = typeof forcedFocus.$inferSelect;

// ─── Lane Carrier Outreach v1 ─────────────────────────────────────────────────

/**
 * Carrier catalog — source of truth after one-time Excel seed.
 * orgId scoped so each org maintains its own carrier rolodex.
 */
export const carriers = pgTable("carriers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  mcDot: text("mc_dot"),
  dotNumber: text("dot_number"),
  payeeCode: text("payee_code"),
  phone: text("phone"),
  city: text("city"),
  state: text("state"),
  regions: text("regions").array().default(sql`'{}'::text[]`),
  statesServed: text("states_served").array().default(sql`'{}'::text[]`),
  metroAreas: text("metro_areas").array().default(sql`'{}'::text[]`),
  equipmentTypes: text("equipment_types").array().default(sql`'{}'::text[]`),
  equipmentNotes: text("equipment_notes"),
  tags: text("tags").array().default(sql`'{}'::text[]`),
  primaryEmail: text("primary_email"),
  backupEmail: text("backup_email"),
  lastEmailValidatedAt: text("last_email_validated_at"),
  notes: text("notes"),
  /** Carrier status: active | inactive | flagged | do_not_use */
  status: text("status").default("active").notNull(),
  /** Phase 2 sourcing fields */
  sourceChannel: text("source_channel"),
  // 'engine' | 'import_paste' | 'import_csv' | 'excel_seed' | 'dat' | 'manual' | null
  importBatchId: varchar("import_batch_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const insertCarrierSchema = createInsertSchema(carriers).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCarrier = z.infer<typeof insertCarrierSchema>;
export type Carrier = typeof carriers.$inferSelect;

/**
 * carrier_contacts — multiple dispatcher/contact records per carrier.
 * Roles: dispatcher | after_hours | sales | billing | general
 */
export const carrierContacts = pgTable("carrier_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  carrierId: varchar("carrier_id").notNull().references(() => carriers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role").default("dispatcher").notNull(),
  // dispatcher | after_hours | sales | billing | general
  email: text("email"),
  phone: text("phone"),
  extension: text("extension"),
  preferredMethod: text("preferred_method"),
  // email | phone | text
  notes: text("notes"),
  isPrimary: boolean("is_primary").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const insertCarrierContactSchema = createInsertSchema(carrierContacts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCarrierContact = z.infer<typeof insertCarrierContactSchema>;
export type CarrierContact = typeof carrierContacts.$inferSelect;

/**
 * carrier_claimed_lanes — what the carrier SAYS they run (user-maintained, NOT derived).
 * Distinct from proven history which comes from financial upload data.
 * laneType: prefer | avoid
 */
export const carrierClaimedLanes = pgTable("carrier_claimed_lanes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  carrierId: varchar("carrier_id").notNull().references(() => carriers.id, { onDelete: "cascade" }),
  originState: text("origin_state"),
  originCity: text("origin_city"),
  destState: text("dest_state"),
  destCity: text("dest_city"),
  equipment: text("equipment"),
  laneType: text("lane_type").default("prefer").notNull(),
  // prefer | avoid
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertCarrierClaimedLaneSchema = createInsertSchema(carrierClaimedLanes).omit({ id: true, createdAt: true });
export type InsertCarrierClaimedLane = z.infer<typeof insertCarrierClaimedLaneSchema>;
export type CarrierClaimedLane = typeof carrierClaimedLanes.$inferSelect;

/**
 * Carrier import batches — tracks every bulk import event for sourcing analytics.
 * Each import from the CarrierOutreachPanel creates one batch record.
 */
export const carrierImportBatches = pgTable("carrier_import_batches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  laneId: varchar("lane_id").references(() => recurringLanes.id, { onDelete: "set null" }),
  source: text("source").notNull(),
  // 'dat' | 'loadsmart' | 'csv_paste' | 'manual' | 'other'
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  carrierCount: integer("carrier_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  matchedCount: integer("matched_count").notNull().default(0),
  rawInput: text("raw_input"),
  // stores the original pasted text for audit purposes
});
export const insertCarrierImportBatchSchema = createInsertSchema(carrierImportBatches).omit({ id: true, createdAt: true });
export type InsertCarrierImportBatch = z.infer<typeof insertCarrierImportBatchSchema>;
export type CarrierImportBatch = typeof carrierImportBatches.$inferSelect;

/**
 * Recurring lanes identified by the capacity engine.
 * One record per unique origin+destination+equipment+account combination per org.
 */
export const recurringLanes = pgTable("recurring_lanes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "set null" }),
  companyName: text("company_name"),
  origin: text("origin").notNull(),
  originState: text("origin_state"),
  destination: text("destination").notNull(),
  destinationState: text("destination_state"),
  equipmentType: text("equipment_type"),
  avgLoadsPerWeek: decimal("avg_loads_per_week", { precision: 6, scale: 2 }),
  weeksActive: integer("weeks_active").default(0),
  lookbackWeeks: integer("lookback_weeks").default(4),
  hasPreferredCarrierProgram: boolean("has_preferred_carrier_program").default(false),
  ownerUserId: varchar("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  overseerUserId: varchar("overseer_user_id").references(() => users.id, { onDelete: "set null" }),
  assignedAt: text("assigned_at"),
  assignedByUserId: varchar("assigned_by_user_id").references(() => users.id, { onDelete: "set null" }),
  laneScore: integer("lane_score"),
  laneScoreFactors: jsonb("lane_score_factors"),
  eligibilityConfidence: text("eligibility_confidence").notNull().default("medium"), // "high" | "medium" | "borderline"
  lastScoredAt: text("last_scored_at"),
  isEligible: boolean("is_eligible").default(false).notNull(),
  snoozedUntil: text("snoozed_until"),
  carriersContactedCount: integer("carriers_contacted_count").default(0),
  resolvedAt: text("resolved_at"),
  isManual: boolean("is_manual").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const insertRecurringLaneSchema = createInsertSchema(recurringLanes).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertRecurringLane = z.infer<typeof insertRecurringLaneSchema>;
export type RecurringLane = typeof recurringLanes.$inferSelect;

/**
 * Carrier bench per lane — tracks interest status and reply context for each
 * carrier that has been evaluated or contacted for a recurring lane.
 */
export const laneCarrierInterest = pgTable("lane_carrier_interest", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  laneId: varchar("lane_id").notNull().references(() => recurringLanes.id, { onDelete: "cascade" }),
  carrierId: varchar("carrier_id").references(() => carriers.id, { onDelete: "set null" }),
  carrierName: text("carrier_name").notNull(),
  interestStatus: text("interest_status").notNull().default("needs_follow_up"),
  // available_now | available_next_week | future_interest | not_fit | needs_follow_up
  replySnippet: text("reply_snippet"),
  lastReplySnippet: text("last_reply_snippet"),
  classifiedAt: text("classified_at"),
  notes: text("notes"),
  fitScore: integer("fit_score"),
  fitReason: text("fit_reason"),
  outreachSentAt: text("outreach_sent_at"),
  sourceType: text("source_type").notNull().default("suggested"),
  // historical | suggested | manually_added
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("lane_carrier_interest_lane_carrier").on(table.laneId, table.carrierId),
  // Partial unique index: prevents duplicate name-only bench entries under concurrent requests.
  // PostgreSQL allows multiple NULLs in a standard unique index, so this explicit partial
  // index covers (laneId, carrierName) WHERE carrier_id IS NULL.
  uniqueIndex("lane_carrier_interest_name_null_carrier").on(table.laneId, table.carrierName).where(sql`carrier_id IS NULL`),
]);
export const insertLaneCarrierInterestSchema = createInsertSchema(laneCarrierInterest).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLaneCarrierInterest = z.infer<typeof insertLaneCarrierInterestSchema>;
export type LaneCarrierInterest = typeof laneCarrierInterest.$inferSelect;

/**
 * Lane Coverage Profiles — tracks stable coverage status per lane (origin+dest+equipment).
 * Computed from financial upload history; can be manually overridden by users.
 */
export const laneCoverageProfiles = pgTable("lane_coverage_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  laneId: varchar("lane_id").references(() => recurringLanes.id, { onDelete: "cascade" }),
  laneKey: text("lane_key").notNull(), // normalized: "origin||destination||equipment"
  coverageStatus: text("coverage_status").notNull().default("unstable"), // "stable" | "watch" | "unstable"
  sampleSize: integer("sample_size").notNull().default(0),
  qualifiedCarrierCount: integer("qualified_carrier_count").notNull().default(0),
  topCarrierCoverageShare: decimal("top_carrier_coverage_share", { precision: 5, scale: 4 }), // 0–1
  computedAt: text("computed_at"),
  manualOverrideStatus: text("manual_override_status"), // null | "stable" | "watch" | "unstable"
  manualOverrideReason: text("manual_override_reason"),
  manuallyConfirmedByUserId: varchar("manually_confirmed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  manuallyConfirmedAt: text("manually_confirmed_at"),
  broadenSearchActive: boolean("broaden_search_active").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("lane_coverage_profiles_org_key").on(table.orgId, table.laneKey),
]);
export const insertLaneCoverageProfileSchema = createInsertSchema(laneCoverageProfiles).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLaneCoverageProfile = z.infer<typeof insertLaneCoverageProfileSchema>;
export type LaneCoverageProfile = typeof laneCoverageProfiles.$inferSelect;

/**
 * Per-carrier evidence for lane coverage profiles.
 * Stores historical usage counts, coverage share, and recency for each incumbent.
 */
export const laneCoverageProfileCarriers = pgTable("lane_coverage_profile_carriers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  profileId: varchar("profile_id").notNull().references(() => laneCoverageProfiles.id, { onDelete: "cascade" }),
  carrierId: varchar("carrier_id").references(() => carriers.id, { onDelete: "set null" }),
  carrierName: text("carrier_name").notNull(),
  incumbentRank: integer("incumbent_rank").notNull().default(1), // 1 = top incumbent
  successfulLoadCount: integer("successful_load_count").notNull().default(0),
  recentLoadCount: integer("recent_load_count").notNull().default(0), // last 3 uploads
  coverageShare: decimal("coverage_share", { precision: 5, scale: 4 }), // 0–1 share of matching loads
  lastUsedAt: text("last_used_at"),
  lastSuccessAt: text("last_success_at"),
  isCurrentPrimary: boolean("is_current_primary").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("lane_coverage_profile_carriers_profile_carrier").on(table.profileId, table.carrierName),
]);
export const insertLaneCoverageProfileCarrierSchema = createInsertSchema(laneCoverageProfileCarriers).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLaneCoverageProfileCarrier = z.infer<typeof insertLaneCoverageProfileCarrierSchema>;
export type LaneCoverageProfileCarrier = typeof laneCoverageProfileCarriers.$inferSelect;

/**
 * Outreach activity log — every time a user contacts carriers for a lane.
 */
export const carrierOutreachLogs = pgTable("carrier_outreach_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id),
  laneId: varchar("lane_id").references(() => recurringLanes.id, { onDelete: "set null" }),
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "set null" }),
  carrierIds: text("carrier_ids").array().notNull().default(sql`'{}'::text[]`),
  carrierNames: text("carrier_names").array().notNull().default(sql`'{}'::text[]`),
  actorUserId: varchar("actor_user_id").notNull().references(() => users.id),
  ownerUserId: varchar("owner_user_id").references(() => users.id),
  overseerUserId: varchar("overseer_user_id").references(() => users.id),
  outreachMode: text("outreach_mode").notNull().default("lane_building"),
  // lane_building | immediate_plus_lane
  emailDrafts: jsonb("email_drafts").default([]),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  // Send-tracking fields (Phase 1)
  sentAt: timestamp("sent_at"),
  deliveryStatus: varchar("delivery_status").default("draft"),
  // draft | sending | sent | failed | partial
  failureReason: text("failure_reason"),
  recipients: jsonb("recipients"),
  // [{carrierId, carrierName, email, status: 'sent'|'failed', error?: string}]
  procurementTaskId: varchar("procurement_task_id"),
  // FK-less reference to tasks.id — set for procurement workflow sends
  procurementLane: text("procurement_lane"),
  // lane label string (e.g. "Chicago, IL → Dallas, TX") for procurement-task context
  // Reply-tracking fields (Task #182)
  threadId: text("thread_id"),
  // Graph internetMessageId stored at send time for reply matching
  replyReceivedAt: timestamp("reply_received_at"),
  replySnippet: text("reply_snippet"),

  // Two-way email tracking fields (Task #183)
  direction: varchar("direction").default("outbound"),
  // outbound | inbound
  providerMessageId: text("provider_message_id"),
  // Microsoft Graph message ID (internet message ID or Graph message GUID)
  conversationId: text("conversation_id"),
  // Microsoft Graph conversationId — links replies to original outbound thread
  fromEmail: text("from_email"),
  toEmail: text("to_email"),
  subject: text("subject"),
  bodyPreview: text("body_preview"),
  // First ~255 chars of the email body (inbound snippet or outbound subject line preview)
  rawPayloadRef: text("raw_payload_ref"),
  // Optional storage key for the full raw webhook payload (for audit)
  receivedAt: timestamp("received_at"),
  // Timestamp when inbound email was received (from Graph message receivedDateTime)
  processStatus: varchar("process_status"),
  // pending | processed | duplicate | error — inbound processing state
  matchedCarrierId: varchar("matched_carrier_id").references(() => carriers.id, { onDelete: "set null" }),
  matchedLaneId: varchar("matched_lane_id").references(() => recurringLanes.id, { onDelete: "set null" }),
  matchConfidence: varchar("match_confidence"),
  // exact | alternate_contact | ambiguous | unmatched
}, (table) => ({
  // Index for HF dedup guard: efficient lookup of recent successful outreach per lane
  // Filters: WHERE lane_id = ? AND delivery_status IN ('sent','delivered','opened') AND sent_at > ?
  laneDeliveryStatusIdx: index("carrier_outreach_logs_lane_delivery_idx").on(
    table.laneId,
    table.deliveryStatus,
    table.sentAt,
  ),
  // Index for outreach history queries: WHERE lane_id = ? ORDER BY sent_at DESC
  // Note: carrierIds is a text[] array column so a scalar (laneId, carrierId) B-tree index is not
  // applicable here. These two indexes together cover all per-lane lookup patterns.
  // The lane_carrier_interest table has a unique scalar (laneId, carrierId) index that covers
  // per-carrier history when a resolved carrierId is available.
  laneSentAtIdx: index("carrier_outreach_logs_lane_sent_at_idx").on(
    table.laneId,
    table.sentAt,
  ),
}));
export const insertCarrierOutreachLogSchema = createInsertSchema(carrierOutreachLogs).omit({ id: true, timestamp: true });
export type InsertCarrierOutreachLog = z.infer<typeof insertCarrierOutreachLogSchema>;
export type CarrierOutreachLog = typeof carrierOutreachLogs.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Market Signal Intelligence Layer (Task #185)
// ─────────────────────────────────────────────────────────────────────────────

export const marketSignalTypes = [
  "demand_surge",
  "capacity_shortage",
  "demand_capacity_imbalance",
  "quote_activity_spike",
  "carrier_capacity_declaration",
] as const;
export type MarketSignalType = typeof marketSignalTypes[number];

export const marketScopeTypes = [
  "region",
  "corridor",
  "equipment_region",
  "national",
] as const;
export type MarketScopeType = typeof marketScopeTypes[number];

export const marketSignalStatuses = [
  "active",
  "cooling",
  "resolved",
  "suppressed",
] as const;
export type MarketSignalStatus = typeof marketSignalStatuses[number];

export const marketSignalSeverities = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type MarketSignalSeverity = typeof marketSignalSeverities[number];

export const marketEventTypes = [
  "demand_request",
  "carrier_capacity_declaration",
  "quote_submission",
  "load_posted",
  "load_covered",
] as const;
export type MarketEventType = typeof marketEventTypes[number];

/**
 * market_events — raw inbound operational events that feed signal evaluation.
 * One row per event (demand request, carrier declaration, quote, etc.).
 */
export const marketEvents = pgTable("market_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventType: text("event_type").notNull(),
  // demand_request | carrier_capacity_declaration | quote_submission | load_posted | load_covered
  scopeType: text("scope_type").notNull(),
  // region | corridor | equipment_region | national
  scopeKey: text("scope_key").notNull(),
  // normalized scope identifier, e.g. "TX" or "chicago-il|dallas-tx" or "dry van|TX"
  equipmentType: text("equipment_type"),
  // normalized via normalizeEquipmentType
  originRegion: text("origin_region"),
  destinationRegion: text("destination_region"),
  accountId: varchar("account_id"),
  // customer/shipper account id (for distinct-account counting)
  carrierId: varchar("carrier_id"),
  // carrier id for capacity events
  eventValue: decimal("event_value", { precision: 14, scale: 4 }),
  // numeric value (load count, rate, etc.) if applicable
  metadata: jsonb("metadata"),
  // arbitrary extra fields (rate, miles, lane, etc.)
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
});
export const insertMarketEventSchema = createInsertSchema(marketEvents).omit({ id: true, recordedAt: true });
export type InsertMarketEvent = z.infer<typeof insertMarketEventSchema>;
export type MarketEvent = typeof marketEvents.$inferSelect;

/**
 * market_signals — durable, deduplicated, lifecycle-managed conditions.
 * Evaluation collapses raw events into one signal per scope/type/equipment.
 */
export const marketSignals = pgTable("market_signals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  signalType: text("signal_type").notNull(),
  // demand_surge | capacity_shortage | demand_capacity_imbalance | etc.
  scopeType: text("scope_type").notNull(),
  scopeKey: text("scope_key").notNull(),
  equipmentType: text("equipment_type"),
  status: text("status").notNull().default("active"),
  // active | cooling | resolved | suppressed
  severity: text("severity").notNull().default("medium"),
  // low | medium | high | critical
  confidence: decimal("confidence", { precision: 5, scale: 4 }).notNull().default("0"),
  // 0.0 – 1.0 confidence score

  // Evidence payload — stored counts and percent change for deterministic explanation
  evidencePayload: jsonb("evidence_payload").notNull().default({}),
  // { recentCount, baselineCount, percentChange, distinctAccounts, distinctCarriers, ... }
  explanation: text("explanation").notNull().default(""),
  // Deterministic plain-English summary generated from evidencePayload

  firstDetectedAt: timestamp("first_detected_at").defaultNow().notNull(),
  lastEvaluatedAt: timestamp("last_evaluated_at").defaultNow().notNull(),
  coolingStartedAt: timestamp("cooling_started_at"),
  resolvedAt: timestamp("resolved_at"),
});
export const insertMarketSignalSchema = createInsertSchema(marketSignals).omit({ id: true, firstDetectedAt: true });
export type InsertMarketSignal = z.infer<typeof insertMarketSignalSchema>;
export type MarketSignal = typeof marketSignals.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Carrier-Side Market Signal NBAs (Task #187)
// ─────────────────────────────────────────────────────────────────────────────

export const carrierMarketNbaStatuses = ["pending", "in_progress", "completed", "dismissed"] as const;
export type CarrierMarketNbaStatus = typeof carrierMarketNbaStatuses[number];

/**
 * carrier_market_nbas — one row per (carrier, market_signal, recommendation_type).
 * Generated by syncCarrierMarketNbas after each MarketSignalEngine evaluation.
 * Dedup key: (carrier_id, market_signal_id, recommendation_type).
 * Status lifecycle: pending → in_progress → completed | dismissed.
 */
export const carrierMarketNbas = pgTable("carrier_market_nbas", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  carrierId: varchar("carrier_id").notNull(),
  marketSignalId: varchar("market_signal_id").notNull(),
  recommendationType: text("recommendation_type").notNull(),
  status: text("status").notNull().default("pending"),
  urgencyScore: integer("urgency_score").notNull().default(0),
  explanation: jsonb("explanation").notNull().default({}),
  suppressionReason: text("suppression_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
  lastActionAt: timestamp("last_action_at"),
});

export const insertCarrierMarketNbaSchema = createInsertSchema(carrierMarketNbas).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  firstSeenAt: true,
});
export type InsertCarrierMarketNba = z.infer<typeof insertCarrierMarketNbaSchema>;
export type CarrierMarketNba = typeof carrierMarketNbas.$inferSelect;

/**
 * Feature flags — org-level key/value toggle for feature gating.
 * lane_carrier_outreach_v1: true/false
 */
export const featureFlags = pgTable("feature_flags", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  flagKey: text("flag_key").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedById: varchar("updated_by_id").references(() => users.id),
}, (table) => [
  uniqueIndex("feature_flags_org_key").on(table.orgId, table.flagKey),
]);
export const insertFeatureFlagSchema = createInsertSchema(featureFlags).omit({ id: true, updatedAt: true });
export type InsertFeatureFlag = z.infer<typeof insertFeatureFlagSchema>;
export type FeatureFlag = typeof featureFlags.$inferSelect;

// ─── Email Intelligence Layer (Task #190) ────────────────────────────────────

export type CustomerIntentType =
  | "pricing_request"
  | "objection"
  | "service_complaint"
  | "urgency_signal"
  | "stalled_thread"
  | "meaningful_touchpoint"
  | "new_opportunity"
  | "positive_feedback"
  | "closed_won_indicator"
  | "closed_lost_indicator";

export type CarrierIntentType =
  | "lane_offer"
  | "lane_decline"
  | "capacity_available"
  | "capacity_unavailable"
  | "new_lane_preference"
  | "price_pushback"
  | "service_issue"
  | "soft_commitment"
  | "hard_commitment"
  | "paperwork_compliance";

export type EmailIntentType = CustomerIntentType | CarrierIntentType;

export type EmailActorType = "customer" | "carrier" | "internal";

export const emailMessages = pgTable("email_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  /**
   * Provider-specific message ID (e.g. Graph internetMessageId / SMTP Message-ID).
   * Used as an idempotency key so replayed webhooks don't insert duplicate rows.
   * Unique per org.
   */
  providerMessageId: text("provider_message_id"),
  threadId: text("thread_id"),
  direction: text("direction").notNull(),
  fromEmail: text("from_email"),
  toEmail: text("to_email"),
  ccEmail: text("cc_email"),
  subject: text("subject"),
  body: text("body"),
  linkedAccountId: varchar("linked_account_id").references(() => companies.id, { onDelete: "set null" }),
  linkedCarrierId: varchar("linked_carrier_id").references(() => carriers.id, { onDelete: "set null" }),
  linkedLaneId: varchar("linked_lane_id").references(() => recurringLanes.id, { onDelete: "set null" }),
  linkedLoadId: varchar("linked_load_id"),
  linkedTaskId: varchar("linked_task_id").references(() => tasks.id, { onDelete: "set null" }),
  linkedNbaId: varchar("linked_nba_id").references(() => nbaCards.id, { onDelete: "set null" }),
  linkedOutreachLogId: varchar("linked_outreach_log_id").references(() => carrierOutreachLogs.id, { onDelete: "set null" }),
  processedForSignalsAt: timestamp("processed_for_signals_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertEmailMessageSchema = createInsertSchema(emailMessages).omit({ id: true, createdAt: true });
export type InsertEmailMessage = z.infer<typeof insertEmailMessageSchema>;
export type EmailMessage = typeof emailMessages.$inferSelect;

export const emailSignals = pgTable("email_signals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  messageId: varchar("message_id").notNull().references(() => emailMessages.id, { onDelete: "cascade" }),
  intentType: text("intent_type").notNull(),
  intentSubtype: text("intent_subtype"),
  actorType: text("actor_type").notNull(),
  entityType: text("entity_type"),
  entityId: varchar("entity_id"),
  confidence: integer("confidence").notNull().default(50),
  extractedData: jsonb("extracted_data").default({}),
  linkedAccountId: varchar("linked_account_id").references(() => companies.id, { onDelete: "set null" }),
  linkedCarrierId: varchar("linked_carrier_id").references(() => carriers.id, { onDelete: "set null" }),
  linkedLaneId: varchar("linked_lane_id").references(() => recurringLanes.id, { onDelete: "set null" }),
  linkedOpportunityId: varchar("linked_opportunity_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertEmailSignalSchema = createInsertSchema(emailSignals).omit({ id: true, createdAt: true });
export type InsertEmailSignal = z.infer<typeof insertEmailSignalSchema>;
export type EmailSignal = typeof emailSignals.$inferSelect;

// ─── Carrier Email Suggestions (Task #191) ───────────────────────────────────
// Staged enrichment suggestions from carrier email signals — carrier profile
// fields are NEVER overwritten directly; all changes go through this table.

export const carrierEmailSuggestions = pgTable("carrier_email_suggestions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  carrierId: varchar("carrier_id").notNull().references(() => carriers.id, { onDelete: "cascade" }),
  emailMessageId: varchar("email_message_id").notNull().references(() => emailMessages.id, { onDelete: "cascade" }),
  threadId: text("thread_id"),
  suggestionType: text("suggestion_type").notNull(),
  payload: jsonb("payload").default({}),
  confidence: integer("confidence").notNull().default(50),
  payloadHash: text("payload_hash"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertCarrierEmailSuggestionSchema = createInsertSchema(carrierEmailSuggestions).omit({ id: true, createdAt: true });
export type InsertCarrierEmailSuggestion = z.infer<typeof insertCarrierEmailSuggestionSchema>;
export type CarrierEmailSuggestion = typeof carrierEmailSuggestions.$inferSelect;

// ─── Email Outcome Links (Task #191) ─────────────────────────────────────────
// Join table linking email signals to outcome events (won/lost/neutral) for
// win/loss analysis. Populated automatically for closed_won/lost signals.

export const emailOutcomeLinks = pgTable("email_outcome_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  emailSignalId: varchar("email_signal_id").notNull().references(() => emailSignals.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: varchar("entity_id").notNull(),
  outcomeType: text("outcome_type").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertEmailOutcomeLinkSchema = createInsertSchema(emailOutcomeLinks).omit({ id: true, createdAt: true });
export type InsertEmailOutcomeLink = z.infer<typeof insertEmailOutcomeLinkSchema>;
export type EmailOutcomeLink = typeof emailOutcomeLinks.$inferSelect;

// ─── Carrier Intel Suggestions (Task #193) ───────────────────────────────────

export const carrierIntelSuggestionStatuses = ["pending", "accepted", "rejected", "auto_accepted"] as const;
export type CarrierIntelSuggestionStatus = typeof carrierIntelSuggestionStatuses[number];

export const carrierIntelSuggestionTypes = [
  "lane_preference",
  "capacity_available",
  "capacity_unavailable",
  "equipment_capability",
  "region_preference",
  "price_sensitivity",
  "service_risk",
] as const;
export type CarrierIntelSuggestionType = typeof carrierIntelSuggestionTypes[number];

export const carrierIntelSuggestionSourceTypes = ["email_signal", "market_signal"] as const;
export type CarrierIntelSuggestionSourceType = typeof carrierIntelSuggestionSourceTypes[number];

/**
 * carrier_intel_suggestions — staged AI-derived enrichment suggestions for a carrier.
 * Ops reviews and accepts or rejects each suggestion; accepted suggestions build
 * the carrier's intelligence profile over time.
 */
export const carrierIntelSuggestions = pgTable("carrier_intel_suggestions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  carrierId: varchar("carrier_id").notNull(),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  sourceType: text("source_type").notNull(),
  emailSignalId: varchar("email_signal_id").references(() => emailSignals.id, { onDelete: "set null" }),
  marketSignalId: varchar("market_signal_id"),
  suggestionType: text("suggestion_type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  confidenceScore: integer("confidence_score").notNull().default(50),
  status: text("status").notNull().default("pending"),
  comment: text("comment"),
  acceptedByUserId: varchar("accepted_by_user_id"),
  rejectedByUserId: varchar("rejected_by_user_id"),
  acceptedAt: timestamp("accepted_at"),
  rejectedAt: timestamp("rejected_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCarrierIntelSuggestionSchema = createInsertSchema(carrierIntelSuggestions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  acceptedAt: true,
  rejectedAt: true,
});
export type InsertCarrierIntelSuggestion = z.infer<typeof insertCarrierIntelSuggestionSchema>;
export type CarrierIntelSuggestion = typeof carrierIntelSuggestions.$inferSelect;

// ─── Account Contact Suggestions (Task #201) ─────────────────────────────────
// Staged contact capture suggestions from account-linked email threads.
// Reps can accept, ignore, snooze, or permanently suppress each suggestion.

export const accountContactSuggestionStatuses = [
  "pending",
  "accepted",
  "ignored",
  "snoozed",
  "never_suggest",
] as const;
export type AccountContactSuggestionStatus = typeof accountContactSuggestionStatuses[number];

export const accountContactSuggestions = pgTable(
  "account_contact_suggestions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    accountId: varchar("account_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    emailAddress: text("email_address").notNull(),
    suggestedName: text("suggested_name"),
    suggestedTitle: text("suggested_title"),
    suggestedPhone: text("suggested_phone"),
    suggestionSource: text("suggestion_source").notNull().default("email_thread"),
    confidenceScore: integer("confidence_score").notNull().default(50),
    status: text("status").notNull().default("pending"),
    threadCount: integer("thread_count").notNull().default(1),
    emailMessageId: varchar("email_message_id"),
    threadId: text("thread_id"),
    snoozedUntil: timestamp("snoozed_until"),
    actedByUserId: varchar("acted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("account_contact_suggestions_account_email_idx").on(table.accountId, table.emailAddress),
  ],
);

export const insertAccountContactSuggestionSchema = createInsertSchema(accountContactSuggestions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAccountContactSuggestion = z.infer<typeof insertAccountContactSuggestionSchema>;
export type AccountContactSuggestion = typeof accountContactSuggestions.$inferSelect;

/**
 * Pre-computed lane summary cache — written by the nightly scheduler after lane scoring.
 * List endpoints (LWQ, My Procurement) read from this table instead of running per-request
 * joins + enrichment against recurring_lanes + companies.
 *
 * KEY COLUMNS rendered by list views:
 *   laneScore, priority, origin, originState, destination, destinationState,
 *   equipmentType, avgLoadsPerWeek, companyId, companyName, ownerUserId,
 *   carriersContactedCount, resolvedAt, updatedAt
 *
 * NOT included (fetched lazily via GET /api/recurring-lanes/:id/detail):
 *   replySummary, carrier bench arrays, nested history objects
 */
export const laneSummaryCache = pgTable("lane_summary_cache", {
  laneId: varchar("lane_id").primaryKey().references(() => recurringLanes.id, { onDelete: "cascade" }),
  laneScore: integer("lane_score"),
  priority: integer("priority").default(0),
  origin: text("origin").notNull(),
  originState: text("origin_state"),
  destination: text("destination").notNull(),
  destinationState: text("destination_state"),
  equipmentType: text("equipment_type"),
  avgLoadsPerWeek: decimal("avg_loads_per_week", { precision: 6, scale: 2 }),
  companyId: varchar("company_id"),
  companyName: text("company_name"),
  ownerUserId: varchar("owner_user_id"),
  carriersContactedCount: integer("carriers_contacted_count").default(0),
  contactableCount: integer("contactable_count").default(0),
  totalBenchCount: integer("total_bench_count").default(0),
  historicalCount: integer("historical_count").default(0),
  missingContactCount: integer("missing_contact_count").default(0),
  orgId: varchar("org_id"),
  isEligible: boolean("is_eligible").default(true),
  hasPreferredCarrierProgram: boolean("has_preferred_carrier_program").default(false),
  snoozedUntil: text("snoozed_until"),
  resolvedAt: text("resolved_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("lane_summary_cache_owner_resolved_score").on(table.ownerUserId, table.resolvedAt, table.laneScore),
  index("lane_summary_cache_org_resolved_score").on(table.orgId, table.resolvedAt, table.laneScore),
]);

export const insertLaneSummaryCacheSchema = createInsertSchema(laneSummaryCache).omit({ updatedAt: true });
export type InsertLaneSummaryCache = z.infer<typeof insertLaneSummaryCacheSchema>;
export type LaneSummaryCache = typeof laneSummaryCache.$inferSelect;
