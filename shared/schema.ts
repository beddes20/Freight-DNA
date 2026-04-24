import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, serial, decimal, jsonb, boolean, timestamp, date, uniqueIndex, index, customType } from "drizzle-orm/pg-core";
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
  handoffNotes: text("handoff_notes"),
  onboardingMilestones: jsonb("onboarding_milestones"),
});

export const sharedRepSchema = z.object({
  userId: z.string(),
  territoryNote: z.string().optional(),
});
export type SharedRep = z.infer<typeof sharedRepSchema>;

export const ONBOARDING_MILESTONE_IDS = [
  "kickoff_call",
  "system_access",
  "first_load",
  "rate_process_review",
  "primary_contact",
  "routing_guide",
  "thirty_day_checkin",
] as const;
export type OnboardingMilestoneId = typeof ONBOARDING_MILESTONE_IDS[number];
export type OnboardingMilestones = Partial<Record<OnboardingMilestoneId, boolean>>;
export const onboardingMilestoneToggleSchema = z.object({
  milestoneId: z.enum(ONBOARDING_MILESTONE_IDS),
  completed: z.boolean(),
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
  mobile: text("mobile"),
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
  valueiqLandingDisabled: boolean("valueiq_landing_disabled").notNull().default(false),
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
  playLabel: text("play_label"),
  createdAt: text("created_at").notNull(),
  externalId: text("external_id"),
}, (t) => ({
  externalIdUq: uniqueIndex("touchpoints_external_id_uq").on(t.externalId),
}));

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
  // App-level default. Avoids a SQL DEFAULT clause containing apostrophes
  // (e.g. `'utc'`) that drizzle-kit was mis-tokenizing into a truncated
  // ALTER TABLE statement during prod migrations.
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});
export const insertChatConversationSchema = createInsertSchema(chatConversations).omit({ id: true });
export type InsertChatConversation = z.infer<typeof insertChatConversationSchema>;
export type ChatConversation = typeof chatConversations.$inferSelect;

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  // App-level default — see chatConversations.createdAt note above.
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
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
  /** Null for company-linked opportunities (not tied to a prospect pipeline record) */
  prospectId: integer("prospect_id").references(() => prospects.id, { onDelete: "cascade" }),
  /** Company profile link — used when opportunity is created from a company detail page */
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "cascade" }),
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
  playLabel: text("play_label"),
  outcomeLinkedAt: text("outcome_linked_at"),
  outcomeTypeLinked: text("outcome_type_linked"),
  // ── Task #372: at-stake $ impact + universal account/contact/lane linkage ──
  atStakeAmount: decimal("at_stake_amount", { precision: 14, scale: 2 }),
  atStakeBasis: text("at_stake_basis"),
  primaryContactId: varchar("primary_contact_id").references(() => contacts.id, { onDelete: "set null" }),
  primaryLaneId: varchar("primary_lane_id").references(() => recurringLanes.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
  // Task #374 — first time the card was rendered for the rep
  firstViewedAt: text("first_viewed_at"),
});
export const insertNbaCardSchema = createInsertSchema(nbaCards).omit({ id: true });
export type InsertNbaCard = z.infer<typeof insertNbaCardSchema>;
export type NbaCard = typeof nbaCards.$inferSelect;

// ── NBA Lifecycle Events (Task #374) ─────────────────────────────────────────
// Append-only audit log for every NBA card transition: fired → viewed →
// acted/dismissed/snoozed → resolved → outcome_classified.
export const nbaCardEvents = pgTable("nba_card_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cardId: varchar("card_id").notNull().references(() => nbaCards.id, { onDelete: "cascade" }),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(), // fired | viewed | acted | dismissed | snoozed | resolved | outcome_classified
  reason: text("reason"),
  actorUserId: varchar("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  cardIdx: index("nba_card_events_card_idx").on(t.cardId),
  orgTypeIdx: index("nba_card_events_org_type_idx").on(t.orgId, t.eventType),
}));
export const insertNbaCardEventSchema = createInsertSchema(nbaCardEvents).omit({ id: true, createdAt: true });
export type InsertNbaCardEvent = z.infer<typeof insertNbaCardEventSchema>;
export type NbaCardEvent = typeof nbaCardEvents.$inferSelect;

// ── NBA Outcome Classification (Task #374) ───────────────────────────────────
// One row per resolved card after the attribution window closes. Captures
// whether the NBA actually "worked" and the estimated $ impact.
export const nbaCardOutcomes = pgTable("nba_card_outcomes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cardId: varchar("card_id").notNull().references(() => nbaCards.id, { onDelete: "cascade" }),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ruleType: text("rule_type").notNull(),
  // worked | no_response | partial | unknown
  outcome: text("outcome").notNull(),
  // Free-text human-readable explanation: "Meaningful touch logged within 7d"
  basis: text("basis"),
  // Estimated $ impact (uses atStakeAmount from the card unless overridden by classifier)
  dollarImpact: decimal("dollar_impact", { precision: 14, scale: 2 }),
  // The resolved-action that triggered the window: actioned | dismissed | snoozed | expired
  fromAction: text("from_action"),
  attributionWindowDays: integer("attribution_window_days"),
  classifiedAt: timestamp("classified_at").defaultNow().notNull(),
  signals: jsonb("signals").$type<Record<string, unknown>>(),
}, (t) => ({
  cardUnique: uniqueIndex("nba_card_outcomes_card_unique").on(t.cardId),
  orgUserIdx: index("nba_card_outcomes_org_user_idx").on(t.orgId, t.userId),
  ruleIdx: index("nba_card_outcomes_rule_idx").on(t.orgId, t.ruleType),
}));
export const insertNbaCardOutcomeSchema = createInsertSchema(nbaCardOutcomes).omit({ id: true, classifiedAt: true });
export type InsertNbaCardOutcome = z.infer<typeof insertNbaCardOutcomeSchema>;
export type NbaCardOutcome = typeof nbaCardOutcomes.$inferSelect;

// ─── Missed Inbound Calls (Task #317) ────────────────────────────────────────
/**
 * One row per unanswered inbound Webex CDR (org-wide). Captured by the call
 * sync regardless of whether the calling number matches a known CRM contact —
 * unknown callers are still surfaced so coordinators can decide whether to
 * call back. Deduped on (orgId, cdrId).
 */
export const missedInboundCalls = pgTable("missed_inbound_calls", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  cdrId: text("cdr_id").notNull(),
  callingNumber: text("calling_number").notNull(),
  calledNumber: text("called_number"),
  ringDurationSeconds: integer("ring_duration_seconds").notNull().default(0),
  voicemailLeft: boolean("voicemail_left").notNull().default(false),
  startTime: text("start_time").notNull(),
  /** Resolved CRM contact (null when caller unknown). */
  contactId: varchar("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  /** Resolved CRM company via the matched contact. */
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "set null" }),
  /** Internal user the call rang (resolved via webex user mapping). */
  attributedUserId: varchar("attributed_user_id").references(() => users.id, { onDelete: "set null" }),
  webexPersonId: text("webex_person_id"),
  webexUserEmail: text("webex_user_email"),
  /** True when startTime is outside 8a–6p local (org-wide heuristic). */
  afterHours: boolean("after_hours").notNull().default(false),
  /** NBA card created by the callback action (null until clicked). */
  nbaCardId: varchar("nba_card_id"),
  callbackCreatedAt: text("callback_created_at"),
  createdAt: text("created_at").notNull(),
}, (t) => ({
  cdrUnique: uniqueIndex("missed_inbound_calls_org_cdr_unique").on(t.orgId, t.cdrId),
  orgStartIdx: index("missed_inbound_calls_org_start_idx").on(t.orgId, t.startTime),
}));

export const insertMissedInboundCallSchema = createInsertSchema(missedInboundCalls).omit({ id: true });
export type InsertMissedInboundCall = z.infer<typeof insertMissedInboundCallSchema>;
export type MissedInboundCall = typeof missedInboundCalls.$inferSelect;

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
  // Task #477 — links a lane back to the customer quote that triggered its
  // auto-creation when the quote was marked won. Used for idempotency
  // (one lane per quote) and to surface the source quote on the LWQ card.
  sourceQuoteId: varchar("source_quote_id"),
  dropTrailerShipper: boolean("drop_trailer_shipper").default(false).notNull(),
  dropTrailerReceiver: boolean("drop_trailer_receiver").default(false).notNull(),
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

// ─── Sidebar Tooltip Overrides (Task #385) ──────────────────────────────────
// Admins can override the default tooltip copy for sidebar items.
// itemKey matches the catalog key in client/src/lib/sidebar-tooltip-catalog.ts
export const sidebarTooltips = pgTable("sidebar_tooltips", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  itemKey: text("item_key").notNull(),
  description: text("description").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedById: varchar("updated_by_id").references(() => users.id),
}, (table) => [
  uniqueIndex("sidebar_tooltips_org_key").on(table.orgId, table.itemKey),
]);
export const insertSidebarTooltipSchema = createInsertSchema(sidebarTooltips).omit({ id: true, updatedAt: true });
export type InsertSidebarTooltip = z.infer<typeof insertSidebarTooltipSchema>;
export type SidebarTooltip = typeof sidebarTooltips.$inferSelect;
export const upsertSidebarTooltipSchema = z.object({
  itemKey: z.string().min(1).max(120),
  description: z.string().max(500),
});
export type UpsertSidebarTooltip = z.infer<typeof upsertSidebarTooltipSchema>;

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
  // Task #435: provider-supplied send time (e.g. Graph sentDateTime).
  // Used as the canonical timeline timestamp so messages recovered hours
  // after the fact (via self-heal sweep) still display in the correct
  // chronological position rather than at ingestion time.
  providerSentAt: timestamp("provider_sent_at"),
  // Task #517 — records which ingestion path produced this row so we can
  // prove the historical 30-day backfill is actually firing through the
  // same code path and producing spot quotes. Values: 'delta' (live
  // webhook/delta sync), 'backfill' (mailbox 30-day historical run),
  // 'self_heal' (reply-capture sweep), or null for legacy rows written
  // before this column existed.
  ingestedVia: text("ingested_via"),
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

// ─── Email Conversation Threads (Task #202) ──────────────────────────────────
// Per-thread ownership, ball-in-court state, and reply priority layer.
// Linked to email_messages.threadId (unique per org).

export const emailConversationThreads = pgTable("email_conversation_threads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull(),
  linkedAccountId: varchar("linked_account_id").references(() => companies.id, { onDelete: "set null" }),
  linkedCarrierId: varchar("linked_carrier_id").references(() => carriers.id, { onDelete: "set null" }),
  ownerUserId: varchar("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  waitingState: text("waiting_state").notNull().default("waiting_on_us"),
  responsePriority: text("response_priority").notNull().default("normal"),
  lastMessageId: varchar("last_message_id").references(() => emailMessages.id, { onDelete: "set null" }),
  lastIncomingAt: timestamp("last_incoming_at"),
  lastOutgoingAt: timestamp("last_outgoing_at"),
  waitingSinceAt: timestamp("waiting_since_at"),
  overdueAt: timestamp("overdue_at"),
  archivedAt: timestamp("archived_at"),
  // ─── Snooze (Task #533) ───────────────────────────────────────────────────
  // When a user snoozes a thread we set waitingState='snoozed', record the
  // wake time in snoozedUntil, and remember the previous waitingState in
  // snoozedFromState so the wake job can restore it. A scheduler runs every
  // few minutes to flip expired snoozes back to their prior state.
  snoozedUntil: timestamp("snoozed_until"),
  snoozedFromState: text("snoozed_from_state"),
  snoozedByUserId: varchar("snoozed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertEmailConversationThreadSchema = createInsertSchema(emailConversationThreads).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEmailConversationThread = z.infer<typeof insertEmailConversationThreadSchema>;
export type EmailConversationThread = typeof emailConversationThreads.$inferSelect;

// ─── Conversation Saved Views (Task #533) ────────────────────────────────────
// Per-user saved combinations of (bucket + filters) so reps can recall a
// frequently-used inbox slice (e.g. "My overdue quote requests") with one
// click. Filters is a free-form JSON blob — the client owns the shape and
// the server simply persists/returns it.
export const conversationSavedViews = pgTable("conversation_saved_views", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  bucket: text("bucket").notNull(),
  filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertConversationSavedViewSchema = createInsertSchema(conversationSavedViews).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertConversationSavedView = z.infer<typeof insertConversationSavedViewSchema>;
export type ConversationSavedView = typeof conversationSavedViews.$inferSelect;

// ─── Per-user read state for conversation threads (Task #532) ────────────────
// Tracks the most recent moment a user "viewed" a thread so we can show
// unread vs read styling consistently across sessions and devices. We key on
// the Outlook conversation_id (text) instead of the thread record id so that
// orphan threads (no email_conversation_threads row yet) are still trackable.
export const emailConversationReadStates = pgTable("email_conversation_read_states", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull(),
  lastReadAt: timestamp("last_read_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  uniqUserThread: uniqueIndex("email_conv_read_user_thread_uniq").on(table.userId, table.threadId),
}));

export const insertEmailConversationReadStateSchema = createInsertSchema(emailConversationReadStates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEmailConversationReadState = z.infer<typeof insertEmailConversationReadStateSchema>;
export type EmailConversationReadState = typeof emailConversationReadStates.$inferSelect;

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
  ownerName: text("owner_name"),
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
  dropTrailerShipper: boolean("drop_trailer_shipper").default(false).notNull(),
  dropTrailerReceiver: boolean("drop_trailer_receiver").default(false).notNull(),
  isManual: boolean("is_manual").default(false).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("lane_summary_cache_owner_resolved_score").on(table.ownerUserId, table.resolvedAt, table.laneScore),
  index("lane_summary_cache_org_resolved_score").on(table.orgId, table.resolvedAt, table.laneScore),
]);

export const insertLaneSummaryCacheSchema = createInsertSchema(laneSummaryCache).omit({ updatedAt: true });
export type InsertLaneSummaryCache = z.infer<typeof insertLaneSummaryCacheSchema>;
export type LaneSummaryCache = typeof laneSummaryCache.$inferSelect;

// ─── Geographic Lane Patterns (Task #203) ─────────────────────────────────────
// Named regions and corridors that individual lanes roll up into.
// e.g. "Upper Midwest Outbound", "Texas → Midwest"

export const geographicLanePatterns = pgTable("geographic_lane_patterns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  originRegion: text("origin_region").notNull(),
  destinationRegion: text("destination_region").notNull(),
  namedCorridor: text("named_corridor"),
  description: text("description"),
  isBaseline: boolean("is_baseline").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertGeographicLanePatternSchema = createInsertSchema(geographicLanePatterns).omit({
  id: true,
  createdAt: true,
});
export type InsertGeographicLanePattern = z.infer<typeof insertGeographicLanePatternSchema>;
export type GeographicLanePattern = typeof geographicLanePatterns.$inferSelect;

// ─── Account Contact Lane Pattern Responsibilities (Task #203) ────────────────
// Inferred and confirmed contact–pattern mappings per org and account.

export const responsibilityStatuses = ["suggested", "confirmed", "dismissed"] as const;
export type ResponsibilityStatus = typeof responsibilityStatuses[number];

export const responsibilityTypes = ["spot", "mini_bid", "rfp", "ops", "other"] as const;
export type ResponsibilityType = typeof responsibilityTypes[number];

export const sourceTypes = ["email", "transaction", "rfp", "mixed"] as const;
export type SourceType = typeof sourceTypes[number];

export const accountContactLanePatternResponsibilities = pgTable(
  "account_contact_lane_pattern_responsibilities",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    accountId: varchar("account_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contactId: varchar("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    lanePatternId: varchar("lane_pattern_id").notNull().references(() => geographicLanePatterns.id, { onDelete: "cascade" }),
    isResponsibleForPattern: boolean("is_responsible_for_pattern").notNull().default(true),
    responsibilityType: text("responsibility_type"),
    confidenceScore: integer("confidence_score").notNull().default(0),
    evidenceCount: integer("evidence_count").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    primarySourceType: text("primary_source_type").notNull().default("email"),
    status: text("status").notNull().default("suggested"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    lastReviewedAt: timestamp("last_reviewed_at"),
    lastReviewedByUserId: varchar("last_reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    evidenceEventKeys: text("evidence_event_keys").array().default([]),
    sourceTypes: text("source_types").array().default([]),
  },
  (table) => [
    index("aclpr_account_contact_pattern_idx").on(table.accountId, table.contactId, table.lanePatternId),
    index("aclpr_account_status_idx").on(table.accountId, table.status),
    index("aclpr_contact_status_idx").on(table.contactId, table.status),
  ],
);

export const insertAccountContactLanePatternResponsibilitySchema = createInsertSchema(
  accountContactLanePatternResponsibilities,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAccountContactLanePatternResponsibility = z.infer<typeof insertAccountContactLanePatternResponsibilitySchema>;
export type AccountContactLanePatternResponsibility = typeof accountContactLanePatternResponsibilities.$inferSelect;

// ─── Contact Geography Suggestions (Task #225) ────────────────────────────────
// AI-inferred geography ownership assignments per contact.
// Follows account_contact_suggestions pattern with confidence, evidence, and approval.

export const contactGeographySuggestionStatuses = ["pending", "accepted", "rejected", "dismissed"] as const;
export type ContactGeographySuggestionStatus = typeof contactGeographySuggestionStatuses[number];

export const contactGeographySuggestions = pgTable(
  "contact_geography_suggestions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    accountId: varchar("account_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contactId: varchar("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    suggestedRegion: text("suggested_region"),
    suggestedLane: text("suggested_lane"),
    confidenceScore: integer("confidence_score").notNull().default(50),
    status: text("status").notNull().default("pending"),
    sourceEvidence: jsonb("source_evidence").default({}),
    suggestionSource: text("suggestion_source").notNull().default("email_inference"),
    actedByUserId: varchar("acted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("cgs_account_contact_idx").on(table.accountId, table.contactId),
    index("cgs_contact_status_idx").on(table.contactId, table.status),
    index("cgs_account_status_idx").on(table.accountId, table.status),
  ],
);

export const insertContactGeographySuggestionSchema = createInsertSchema(contactGeographySuggestions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertContactGeographySuggestion = z.infer<typeof insertContactGeographySuggestionSchema>;
export type ContactGeographySuggestion = typeof contactGeographySuggestions.$inferSelect;

export const pinnedCompanies = pgTable("pinned_companies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  pinnedAt: timestamp("pinned_at").defaultNow().notNull(),
},
(table) => [
  uniqueIndex("pinned_companies_user_company_idx").on(table.userId, table.companyId),
]);

export const insertPinnedCompanySchema = createInsertSchema(pinnedCompanies).omit({ id: true, pinnedAt: true });
export type InsertPinnedCompany = z.infer<typeof insertPinnedCompanySchema>;
export type PinnedCompany = typeof pinnedCompanies.$inferSelect;

// ── TRAC Rate Intelligence Cache ─────────────────────────────────────────────
// Caches FreightWaves TRAC API responses for user lane rate cards (refreshed daily).

export const intelTrackedLanes = pgTable("intel_tracked_lanes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  laneId: varchar("lane_id").references(() => recurringLanes.id, { onDelete: "set null" }),
  origin: text("origin").notNull(),           // KMA code e.g. "SLC"
  originLabel: text("origin_label"),          // Display name e.g. "Salt Lake City, UT"
  destination: text("destination").notNull(), // KMA code e.g. "LAX"
  destinationLabel: text("destination_label"),
  equipmentType: text("equipment_type").notNull().default("VAN"),
  source: text("source").notNull().default("lwq"), // "lwq" | "manual"
  active: boolean("active").notNull().default(true),
  displayOrder: integer("display_order").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
},
(table) => [
  uniqueIndex("intel_tracked_lanes_user_lane_idx").on(table.userId, table.origin, table.destination, table.equipmentType),
]);

export const insertIntelTrackedLaneSchema = createInsertSchema(intelTrackedLanes).omit({ id: true, createdAt: true });
export type InsertIntelTrackedLane = z.infer<typeof insertIntelTrackedLaneSchema>;
export type IntelTrackedLane = typeof intelTrackedLanes.$inferSelect;

export const intelLaneRates = pgTable("intel_lane_rates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trackedLaneId: varchar("tracked_lane_id").notNull().references(() => intelTrackedLanes.id, { onDelete: "cascade" }),
  refreshedAt: timestamp("refreshed_at").defaultNow().notNull(),
  spotRpm: decimal("spot_rpm", { precision: 8, scale: 4 }),
  spotRpmHigh: decimal("spot_rpm_high", { precision: 8, scale: 4 }),
  spotRpmLow: decimal("spot_rpm_low", { precision: 8, scale: 4 }),
  spotRate: decimal("spot_rate", { precision: 10, scale: 2 }),
  spotRateHigh: decimal("spot_rate_high", { precision: 10, scale: 2 }),
  spotRateLow: decimal("spot_rate_low", { precision: 10, scale: 2 }),
  contractRpm: decimal("contract_rpm", { precision: 8, scale: 4 }),
  contractRate: decimal("contract_rate", { precision: 10, scale: 2 }),
  contractFscRpm: decimal("contract_fsc_rpm", { precision: 8, scale: 4 }),
  confidenceScore: decimal("confidence_score", { precision: 5, scale: 2 }),
  loadCount: integer("load_count"),
  miles: integer("miles"),
  avgRpm30d: decimal("avg_rpm_30d", { precision: 8, scale: 4 }),
  avgRpm90d: decimal("avg_rpm_90d", { precision: 8, scale: 4 }),
  forecastJson: jsonb("forecast_json"),       // TracForecastDay[]
  rateAlert: text("rate_alert"),              // "spike" | "drop" | "reprice" | null
  alertReason: text("alert_reason"),
  driverText: text("driver_text"),
});

export const insertIntelLaneRateSchema = createInsertSchema(intelLaneRates).omit({ id: true, refreshedAt: true });
export type InsertIntelLaneRate = z.infer<typeof insertIntelLaneRateSchema>;
export type IntelLaneRate = typeof intelLaneRates.$inferSelect;

// ─── Proven Tactics (Tactical Learning Engine) ──────────────────────────────
// Captures response patterns linked to email signals and outcomes.
// Learns which approaches work for specific signal types (objection, pricing, etc.)

export const provenTactics = pgTable(
  "proven_tactics",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    signalType: text("signal_type").notNull(),
    signalSubtype: text("signal_subtype"),
    tacticLabel: text("tactic_label").notNull(),
    tacticSummary: text("tactic_summary").notNull(),
    exampleResponse: text("example_response"),
    sourceMessageId: varchar("source_message_id").references(() => emailMessages.id, { onDelete: "set null" }),
    sourceSignalId: varchar("source_signal_id").references(() => emailSignals.id, { onDelete: "set null" }),
    linkedAccountId: varchar("linked_account_id").references(() => companies.id, { onDelete: "set null" }),
    accountName: text("account_name"),
    repUserId: varchar("rep_user_id").references(() => users.id, { onDelete: "set null" }),
    repName: text("rep_name"),
    outcome: text("outcome").notNull().default("pending"),
    outcomeConfidence: integer("outcome_confidence").default(0),
    timesUsed: integer("times_used").notNull().default(1),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    successRate: integer("success_rate").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => [
    index("pt_org_signal_idx").on(table.orgId, table.signalType),
    index("pt_outcome_idx").on(table.outcome),
    index("pt_signal_outcome_idx").on(table.signalType, table.outcome),
  ],
);

export const insertProvenTacticSchema = createInsertSchema(provenTactics).omit({ id: true, createdAt: true });
export type InsertProvenTactic = z.infer<typeof insertProvenTacticSchema>;
export type ProvenTactic = typeof provenTactics.$inferSelect;

// ─── Draft Feedback (AI Training Loop) ──────────────────────────────────────
// Captures user ratings and notes on AI-generated email drafts.
// Used to learn what works and shape future draft quality.

export const draftFeedback = pgTable(
  "draft_feedback",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    userName: text("user_name"),
    rating: text("rating").notNull(),
    notes: text("notes"),
    draftText: text("draft_text").notNull(),
    editedText: text("edited_text"),
    playType: text("play_type").notNull(),
    playLabel: text("play_label"),
    threadId: text("thread_id"),
    accountId: varchar("account_id").references(() => companies.id, { onDelete: "set null" }),
    accountName: text("account_name"),
    contactId: varchar("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    contactName: text("contact_name"),
    voiceProfileUsed: boolean("voice_profile_used").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("df_org_idx").on(table.orgId),
    index("df_user_idx").on(table.userId),
    index("df_rating_idx").on(table.orgId, table.rating),
  ],
);

export const insertDraftFeedbackSchema = createInsertSchema(draftFeedback).omit({ id: true, createdAt: true });
export type InsertDraftFeedback = z.infer<typeof insertDraftFeedbackSchema>;
export type DraftFeedback = typeof draftFeedback.$inferSelect;

export const sentEmailCorrections = pgTable(
  "sent_email_corrections",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    correctedByUserId: varchar("corrected_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    correctedByName: text("corrected_by_name"),
    emailMessageId: varchar("email_message_id"),
    outreachLogId: varchar("outreach_log_id"),
    originalText: text("original_text").notNull(),
    correctedText: text("corrected_text").notNull(),
    correctionNotes: text("correction_notes"),
    threadId: text("thread_id"),
    accountId: varchar("account_id").references(() => companies.id, { onDelete: "set null" }),
    carrierId: varchar("carrier_id"),
    subject: text("subject"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("sec_org_idx").on(table.orgId),
    index("sec_email_msg_idx").on(table.emailMessageId),
    index("sec_outreach_idx").on(table.outreachLogId),
  ],
);

export const insertSentEmailCorrectionSchema = createInsertSchema(sentEmailCorrections).omit({ id: true, createdAt: true });
export type InsertSentEmailCorrection = z.infer<typeof insertSentEmailCorrectionSchema>;
export type SentEmailCorrection = typeof sentEmailCorrections.$inferSelect;

export const meetingPrepBriefs = pgTable(
  "meeting_prep_briefs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    generatedByUserId: varchar("generated_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    briefContent: jsonb("brief_content").notNull(),
    recentActivity: jsonb("recent_activity"),
    laneHighlights: jsonb("lane_highlights"),
    talkingPoints: jsonb("talking_points"),
    riskAlerts: jsonb("risk_alerts"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("mpb_org_company_idx").on(table.orgId, table.companyId),
    index("mpb_user_idx").on(table.generatedByUserId),
  ],
);

export const insertMeetingPrepBriefSchema = createInsertSchema(meetingPrepBriefs).omit({ id: true, createdAt: true });
export type InsertMeetingPrepBrief = z.infer<typeof insertMeetingPrepBriefSchema>;
export type MeetingPrepBrief = typeof meetingPrepBriefs.$inferSelect;

export const contactSentimentTracking = pgTable(
  "contact_sentiment_tracking",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    contactId: varchar("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sentimentScore: integer("sentiment_score").notNull(),
    sentimentTrend: text("sentiment_trend").notNull().default("stable"),
    avgResponseTimeHours: decimal("avg_response_time_hours"),
    responseTimeChange: decimal("response_time_change"),
    signals: jsonb("signals"),
    analysisDate: timestamp("analysis_date").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("cst_org_contact_idx").on(table.orgId, table.contactId),
    index("cst_company_idx").on(table.companyId),
    index("cst_trend_idx").on(table.orgId, table.sentimentTrend),
  ],
);

export const insertContactSentimentSchema = createInsertSchema(contactSentimentTracking).omit({ id: true, createdAt: true });
export type InsertContactSentiment = z.infer<typeof insertContactSentimentSchema>;
export type ContactSentiment = typeof contactSentimentTracking.$inferSelect;

export const followUpRecommendations = pgTable(
  "follow_up_recommendations",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    contactId: varchar("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    recommendedDay: text("recommended_day"),
    recommendedTimeOfDay: text("recommended_time_of_day"),
    optimalCadenceDays: integer("optimal_cadence_days"),
    maxSilenceDays: integer("max_silence_days"),
    nextFollowUpDate: text("next_follow_up_date"),
    reasoning: text("reasoning"),
    confidenceScore: integer("confidence_score"),
    dataPoints: integer("data_points").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("fur_org_contact_idx").on(table.orgId, table.contactId),
    index("fur_next_date_idx").on(table.orgId, table.nextFollowUpDate),
  ],
);

export const insertFollowUpRecommendationSchema = createInsertSchema(followUpRecommendations).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFollowUpRecommendation = z.infer<typeof insertFollowUpRecommendationSchema>;
export type FollowUpRecommendation = typeof followUpRecommendations.$inferSelect;

export const relationshipCoachingInsights = pgTable(
  "relationship_coaching_insights",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contactId: varchar("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    insightType: text("insight_type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    priority: text("priority").notNull().default("moderate"),
    suggestedAction: text("suggested_action"),
    status: text("status").notNull().default("active"),
    dataContext: jsonb("data_context"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("rci_org_company_idx").on(table.orgId, table.companyId),
    index("rci_status_idx").on(table.orgId, table.status),
  ],
);

export const insertRelationshipCoachingSchema = createInsertSchema(relationshipCoachingInsights).omit({ id: true, createdAt: true });
export type InsertRelationshipCoaching = z.infer<typeof insertRelationshipCoachingSchema>;
export type RelationshipCoaching = typeof relationshipCoachingInsights.$inferSelect;

export const orgChartGaps = pgTable(
  "org_chart_gaps",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    gapType: text("gap_type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    suggestedContactName: text("suggested_contact_name"),
    suggestedContactTitle: text("suggested_contact_title"),
    suggestedContactEmail: text("suggested_contact_email"),
    evidenceSources: jsonb("evidence_sources"),
    priority: text("priority").notNull().default("moderate"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("ocg_org_company_idx").on(table.orgId, table.companyId),
    index("ocg_status_idx").on(table.orgId, table.status),
  ],
);

export const insertOrgChartGapSchema = createInsertSchema(orgChartGaps).omit({ id: true, createdAt: true });
export type InsertOrgChartGap = z.infer<typeof insertOrgChartGapSchema>;
export type OrgChartGap = typeof orgChartGaps.$inferSelect;

export const warmIntroSuggestions = pgTable(
  "warm_intro_suggestions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetContactId: varchar("target_contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    targetContactName: text("target_contact_name"),
    bridgeContactId: varchar("bridge_contact_id").references(() => contacts.id, { onDelete: "set null" }),
    bridgeContactName: text("bridge_contact_name"),
    connectionStrength: text("connection_strength").notNull().default("moderate"),
    reasoning: text("reasoning"),
    suggestedApproach: text("suggested_approach"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("wis_org_company_idx").on(table.orgId, table.companyId),
    index("wis_status_idx").on(table.orgId, table.status),
  ],
);

export const insertWarmIntroSchema = createInsertSchema(warmIntroSuggestions).omit({ id: true, createdAt: true });
export type InsertWarmIntro = z.infer<typeof insertWarmIntroSchema>;
export type WarmIntro = typeof warmIntroSuggestions.$inferSelect;

export const accountLookAlikes = pgTable(
  "account_look_alikes",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sourceCompanyId: varchar("source_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetCompanyId: varchar("target_company_id").references(() => companies.id, { onDelete: "set null" }),
    targetCompanyName: text("target_company_name"),
    similarityScore: integer("similarity_score").notNull(),
    matchFactors: jsonb("match_factors"),
    expansionOpportunity: text("expansion_opportunity"),
    status: text("status").notNull().default("identified"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("ala_org_source_idx").on(table.orgId, table.sourceCompanyId),
    index("ala_score_idx").on(table.orgId, table.similarityScore),
  ],
);

export const insertAccountLookAlikeSchema = createInsertSchema(accountLookAlikes).omit({ id: true, createdAt: true });
export type InsertAccountLookAlike = z.infer<typeof insertAccountLookAlikeSchema>;
export type AccountLookAlike = typeof accountLookAlikes.$inferSelect;

export const crossSellOpportunities = pgTable(
  "cross_sell_opportunities",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    opportunityType: text("opportunity_type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    lane: text("lane"),
    estimatedValue: decimal("estimated_value"),
    confidenceScore: integer("confidence_score"),
    peerEvidence: jsonb("peer_evidence"),
    suggestedApproach: text("suggested_approach"),
    status: text("status").notNull().default("identified"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("cso_org_company_idx").on(table.orgId, table.companyId),
    index("cso_status_idx").on(table.orgId, table.status),
  ],
);

export const insertCrossSellSchema = createInsertSchema(crossSellOpportunities).omit({ id: true, createdAt: true });
export type InsertCrossSell = z.infer<typeof insertCrossSellSchema>;
export type CrossSell = typeof crossSellOpportunities.$inferSelect;

export const walletSharePlays = pgTable(
  "wallet_share_plays",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    playTitle: text("play_title").notNull(),
    playDescription: text("play_description").notNull(),
    targetLanes: jsonb("target_lanes"),
    targetContacts: jsonb("target_contacts"),
    pricingStrategy: text("pricing_strategy"),
    estimatedRevenue: decimal("estimated_revenue"),
    timelineWeeks: integer("timeline_weeks"),
    steps: jsonb("steps"),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("wsp_org_company_idx").on(table.orgId, table.companyId),
    index("wsp_status_idx").on(table.orgId, table.status),
  ],
);

export const insertWalletSharePlaySchema = createInsertSchema(walletSharePlays).omit({ id: true, createdAt: true });
export type InsertWalletSharePlay = z.infer<typeof insertWalletSharePlaySchema>;
export type WalletSharePlay = typeof walletSharePlays.$inferSelect;

export const winLossPatterns = pgTable(
  "win_loss_patterns",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    patternType: text("pattern_type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    outcome: text("outcome").notNull(),
    frequency: integer("frequency").notNull().default(1),
    factors: jsonb("factors"),
    recommendations: jsonb("recommendations"),
    affectedAccounts: jsonb("affected_accounts"),
    confidenceScore: integer("confidence_score"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("wlp_org_type_idx").on(table.orgId, table.patternType),
    index("wlp_outcome_idx").on(table.orgId, table.outcome),
  ],
);

export const insertWinLossPatternSchema = createInsertSchema(winLossPatterns).omit({ id: true, createdAt: true });
export type InsertWinLossPattern = z.infer<typeof insertWinLossPatternSchema>;
export type WinLossPattern = typeof winLossPatterns.$inferSelect;

export const competitiveSignals = pgTable(
  "competitive_signals",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    signalType: text("signal_type").notNull(),
    competitorName: text("competitor_name"),
    description: text("description").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    severity: text("severity").notNull().default("moderate"),
    suggestedResponse: text("suggested_response"),
    status: text("status").notNull().default("active"),
    detectedAt: timestamp("detected_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("cs_org_company_idx").on(table.orgId, table.companyId),
    index("cs_severity_idx").on(table.orgId, table.severity),
    index("cs_status_idx").on(table.orgId, table.status),
  ],
);

export const insertCompetitiveSignalSchema = createInsertSchema(competitiveSignals).omit({ id: true, createdAt: true });
export type InsertCompetitiveSignal = z.infer<typeof insertCompetitiveSignalSchema>;
export type CompetitiveSignal = typeof competitiveSignals.$inferSelect;

export const monitoredMailboxes = pgTable(
  "monitored_mailboxes",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    subscriptionId: text("subscription_id"),
    sentItemsSubscriptionId: text("sent_items_subscription_id"),
    subscriptionExpiresAt: timestamp("subscription_expires_at"),
    lastSyncAt: timestamp("last_sync_at"),
    deltaSyncToken: text("delta_sync_token"),
    sentDeltaSyncToken: text("sent_delta_sync_token"),
    syncStatus: text("sync_status").notNull().default("pending"),
    syncError: text("sync_error"),
    // Task #435: SentItems coverage health surfacing.
    // lastSentItemsNotificationAt — last time the SentItems webhook actually
    //   delivered a change notification we accepted for this mailbox.
    // lastOutboundCapturedAt — last time we persisted an outbound message
    //   from this mailbox via ANY path (webhook, delta, self-heal).
    lastSentItemsNotificationAt: timestamp("last_sent_items_notification_at"),
    lastOutboundCapturedAt: timestamp("last_outbound_captured_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("monitored_mailboxes_org_email_idx").on(table.orgId, table.email),
    index("monitored_mailboxes_org_enabled_idx").on(table.orgId, table.enabled),
  ],
);

export const insertMonitoredMailboxSchema = createInsertSchema(monitoredMailboxes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMonitoredMailbox = z.infer<typeof insertMonitoredMailboxSchema>;
export type MonitoredMailbox = typeof monitoredMailboxes.$inferSelect;

// ── Mailbox Sync Failures (Task #438) ───────────────────────────────────────
// Per-message failure tracking for delta-sync ingestion. Lets the admin UI
// show *which* message failed, why, and how many attempts have been made,
// and powers an automatic retry/self-heal loop with backoff.
export const mailboxSyncFailures = pgTable(
  "mailbox_sync_failures",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    mailboxId: varchar("mailbox_id").notNull().references(() => monitoredMailboxes.id, { onDelete: "cascade" }),
    folder: text("folder").notNull(), // "inbox" | "sentitems"
    providerMessageId: text("provider_message_id").notNull(),
    errorCategory: text("error_category").notNull(), // graph_fetch | parse | db_constraint | oversize | unknown
    errorMessage: text("error_message").notNull(),
    attemptCount: integer("attempt_count").notNull().default(1),
    status: text("status").notNull().default("pending"), // pending | resolved | dismissed | give_up
    firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
    lastAttemptAt: timestamp("last_attempt_at").defaultNow().notNull(),
    nextAttemptAt: timestamp("next_attempt_at"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("mailbox_sync_failures_unique_idx").on(table.mailboxId, table.folder, table.providerMessageId),
    index("mailbox_sync_failures_mailbox_status_idx").on(table.mailboxId, table.status),
    index("mailbox_sync_failures_due_idx").on(table.status, table.nextAttemptAt),
  ],
);

export const insertMailboxSyncFailureSchema = createInsertSchema(mailboxSyncFailures).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMailboxSyncFailure = z.infer<typeof insertMailboxSyncFailureSchema>;
export type MailboxSyncFailure = typeof mailboxSyncFailures.$inferSelect;

// ── Mailbox Historical Backfills (Task #508) ────────────────────────────────
// Tracks the per-mailbox 30-day historical backfill that runs once when a
// monitored mailbox is first added (and on demand from the admin UI). The
// backfill paginates /users/{id}/messages with `receivedDateTime >= now-30d`
// and streams each message through the existing delta-sync ingestion path,
// so dedup is owned by the email_messages unique index on
// (org_id, provider_message_id) — re-running is always safe.
export const mailboxHistoricalBackfills = pgTable(
  "mailbox_historical_backfills",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    mailboxId: varchar("mailbox_id").notNull().references(() => monitoredMailboxes.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"), // pending | running | completed | failed
    windowStart: timestamp("window_start").notNull(),
    windowEnd: timestamp("window_end").notNull(),
    messagesFetched: integer("messages_fetched").notNull().default(0),
    messagesIngested: integer("messages_ingested").notNull().default(0),
    messagesDuplicate: integer("messages_duplicate").notNull().default(0),
    errorsCount: integer("errors_count").notNull().default(0),
    lastError: text("last_error"),
    triggeredBy: text("triggered_by").notNull().default("auto"), // auto | admin | admin_bulk
    triggeredByUserId: varchar("triggered_by_user_id").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("mailbox_historical_backfills_mailbox_idx").on(table.mailboxId, table.createdAt),
    index("mailbox_historical_backfills_org_status_idx").on(table.orgId, table.status),
  ],
);

export const insertMailboxHistoricalBackfillSchema = createInsertSchema(mailboxHistoricalBackfills).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMailboxHistoricalBackfill = z.infer<typeof insertMailboxHistoricalBackfillSchema>;
export type MailboxHistoricalBackfill = typeof mailboxHistoricalBackfills.$inferSelect;

// ── POD Intake (Task #589 — getpaid@valuetruckaz.com AR mailbox) ────────────
// One row per inbound message at the AR distro mailbox. Inbound flow:
//   1. Graph webhook fires for the configured mailbox.
//   2. classifyPod() decides pod_keyword | pod_ai | not_pod.
//   3. extractOrderIds() searches subject + body + attachment filenames for
//      VT###### style ids (and bare 6-9 digit fallbacks).
//   4. matchOrderIdToLoad() looks up load_fact + customer + dispatcher.
//   5. resolveRecipients() builds the dispatcher email + account-owner
//      email + team fallback.
//   6. Outlook sendMail with original attachment(s) → status="forwarded"
//      (matched), "unmatched" (no load + team-notified), or "not_pod".
// Manual link / re-forward actions update the same row.
export const podIntakeEmails = pgTable(
  "pod_intake_emails",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    mailboxId: varchar("mailbox_id").references(() => monitoredMailboxes.id, { onDelete: "set null" }),
    providerMessageId: text("provider_message_id").notNull(),
    internetMessageId: text("internet_message_id"),
    receivedAt: timestamp("received_at").notNull(),
    fromEmail: text("from_email"),
    fromName: text("from_name"),
    subject: text("subject"),
    bodyPreview: text("body_preview"),
    bodyText: text("body_text"),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    attachmentMeta: jsonb("attachment_meta").$type<Array<{
      id: string;
      name: string;
      contentType: string;
      sizeBytes: number;
      isPodCandidate: boolean;
    }>>().default([]),
    classification: text("classification").notNull().default("pending"),
    // pending | pod_keyword | pod_ai | not_pod | error
    classifierMethod: text("classifier_method"),
    // keyword | ai | manual | none
    classifierConfidence: decimal("classifier_confidence", { precision: 4, scale: 3 }),
    classifierReason: text("classifier_reason"),
    extractedOrderIds: text("extracted_order_ids").array().default([]),
    matchedOrderId: text("matched_order_id"),
    matchedLoadFactId: varchar("matched_load_fact_id"),
    matchedCompanyId: varchar("matched_company_id"),
    forwardStatus: text("forward_status").notNull().default("pending"),
    // pending | forwarded | unmatched | not_pod | failed
    forwardedAt: timestamp("forwarded_at"),
    forwardedTo: jsonb("forwarded_to").$type<{
      dispatcher?: { email: string; name?: string } | null;
      accountOwner?: { email: string; name?: string } | null;
      teamFallback?: { email: string } | null;
    }>(),
    forwardError: text("forward_error"),
    manualLinkedByUserId: varchar("manual_linked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    manualLinkedAt: timestamp("manual_linked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("pod_intake_emails_org_msg_idx").on(table.orgId, table.providerMessageId),
    index("pod_intake_emails_org_status_idx").on(table.orgId, table.forwardStatus, table.receivedAt),
    index("pod_intake_emails_org_classification_idx").on(table.orgId, table.classification, table.receivedAt),
    index("pod_intake_emails_matched_load_idx").on(table.matchedLoadFactId),
  ],
);

export const insertPodIntakeEmailSchema = createInsertSchema(podIntakeEmails).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPodIntakeEmail = z.infer<typeof insertPodIntakeEmailSchema>;
export type PodIntakeEmail = typeof podIntakeEmails.$inferSelect;

// Per-org POD intake config. One row per organization.
//   monitoredMailboxId — which monitored_mailboxes row IS the AR distro
//     mailbox (e.g., getpaid@valuetruckaz.com). Webhook handler routes
//     messages from this mailbox to the POD pipeline instead of the
//     normal carrier-reply path.
//   teamFallbackEmail — copied on every forwarded POD AND notified when
//     a POD arrives but no load can be matched.
//   useAiFallback — when true, run GPT-4o-mini if keyword classifier
//     returns not_pod (lets us tune cost vs recall per-org).
export const podIntakeSettings = pgTable(
  "pod_intake_settings",
  {
    orgId: varchar("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
    monitoredMailboxId: varchar("monitored_mailbox_id").references(() => monitoredMailboxes.id, { onDelete: "set null" }),
    teamFallbackEmail: text("team_fallback_email"),
    enabled: boolean("enabled").notNull().default(false),
    useAiFallback: boolean("use_ai_fallback").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);

export const insertPodIntakeSettingsSchema = createInsertSchema(podIntakeSettings).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertPodIntakeSettings = z.infer<typeof insertPodIntakeSettingsSchema>;
export type PodIntakeSettings = typeof podIntakeSettings.$inferSelect;

// ─── Conversation Thread Capture Audits (Task #435) ──────────────────────────
// Records every reply-capture self-heal pass (scheduled or on-demand) for a
// conversation thread, including the resolved root-cause label and the Graph
// message IDs newly persisted. Surfaced to the rep / manager via the
// "Reply capture audit" affordance on the thread side panel.
export const conversationThreadCaptureAudits = pgTable(
  "conversation_thread_capture_audits",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    // Outlook conversationId (matches email_messages.thread_id /
    // email_conversation_threads.thread_id). Not FK'd because thread rows
    // can be archived/deleted independently of audit history.
    threadId: text("thread_id").notNull(),
    // Owner mailbox at the time of the run (may be null if no monitored
    // mailbox was resolvable — useful as evidence that owner has no mailbox
    // enabled).
    mailboxId: varchar("mailbox_id").references(() => monitoredMailboxes.id, { onDelete: "set null" }),
    triggeredBy: text("triggered_by").notNull(), // 'scheduled' | 'manual' | 'webhook_repair'
    triggeredByUserId: varchar("triggered_by_user_id").references(() => users.id, { onDelete: "set null" }),
    messagesFoundUpstream: integer("messages_found_upstream").notNull().default(0),
    messagesPersisted: integer("messages_persisted").notNull().default(0),
    // Resolved root-cause label for the previous gap (when something was
    // recovered) OR the no-op reason. Examples:
    //   nothing_missing | webhook_never_fired | webhook_dropped |
    //   delta_stale | mailbox_disabled | mailbox_missing |
    //   subscription_expired | sentitems_subscription_missing | error
    rootCauseLabel: text("root_cause_label").notNull().default("nothing_missing"),
    // Free-form details: { persistedProviderMessageIds, error, sub state snapshot, ... }
    details: jsonb("details").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("conversation_thread_capture_audits_org_thread_idx").on(table.orgId, table.threadId, table.createdAt),
  ],
);

export const insertConversationThreadCaptureAuditSchema = createInsertSchema(conversationThreadCaptureAudits).omit({
  id: true,
  createdAt: true,
});
export type InsertConversationThreadCaptureAudit = z.infer<typeof insertConversationThreadCaptureAuditSchema>;
export type ConversationThreadCaptureAudit = typeof conversationThreadCaptureAudits.$inferSelect;

export const webexUserMappings = pgTable(
  "webex_user_mappings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    webexPersonId: text("webex_person_id"),
    webexEmail: text("webex_email"),
    webexDisplayName: text("webex_display_name"),
    userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").notNull().default("needs_review"),
    matchSource: text("match_source"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("webex_mappings_org_person_idx").on(table.orgId, table.webexPersonId),
    index("webex_mappings_org_email_idx").on(table.orgId, table.webexEmail),
    index("webex_mappings_user_idx").on(table.userId),
  ],
);

export const insertWebexUserMappingSchema = createInsertSchema(webexUserMappings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWebexUserMapping = z.infer<typeof insertWebexUserMappingSchema>;
export type WebexUserMapping = typeof webexUserMappings.$inferSelect;

// Per-user Webex OAuth tokens (Task #261)
// Stores a rep's own Webex OAuth refresh token so their personal call history,
// presence, and dial actions run against their own Webex account rather than
// the shared org-level token.
export const webexUserTokens = pgTable(
  "webex_user_tokens",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    webexPersonId: text("webex_person_id"),
    webexEmail: text("webex_email"),
    webexDisplayName: text("webex_display_name"),
    refreshToken: text("refresh_token").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    needsReauth: boolean("needs_reauth").notNull().default(false),
    reauthReason: text("reauth_reason"),
    lastReauthEmailAt: timestamp("last_reauth_email_at"),
    lastRefreshAt: timestamp("last_refresh_at"),
    lastRefreshError: text("last_refresh_error"),
    scopes: text("scopes"),
    scopeVersion: integer("scope_version").notNull().default(0),
    connectedAt: timestamp("connected_at").defaultNow().notNull(),
    disconnectedAt: timestamp("disconnected_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("webex_user_tokens_user_idx").on(table.userId),
    index("webex_user_tokens_org_idx").on(table.orgId),
    index("webex_user_tokens_person_idx").on(table.webexPersonId),
    index("webex_user_tokens_needs_reauth_idx").on(table.needsReauth),
  ],
);

export const insertWebexUserTokenSchema = createInsertSchema(webexUserTokens).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  connectedAt: true,
});
export type InsertWebexUserToken = z.infer<typeof insertWebexUserTokenSchema>;
export type WebexUserToken = typeof webexUserTokens.$inferSelect;

export const apiResponseCache = pgTable(
  "api_response_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    response: jsonb("response").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    ttlSeconds: integer("ttl_seconds").notNull(),
    source: text("source").notNull().default("sonar"),
    // Legacy columns added inline by server/runMigrations.ts. Declared here so
    // drizzle-kit doesn't try to drop them on every db:push (which slows
    // pushes to a crawl and was causing post-merge reconciliation to time
    // out, blocking task "Apply" from completing).
    responseData: jsonb("response_data"),
    cachedAt: timestamp("cached_at").defaultNow(),
  },
  (table) => [
    index("arc_source_idx").on(table.source),
    index("arc_fetched_idx").on(table.fetchedAt),
  ],
);

export type ApiResponseCache = typeof apiResponseCache.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// DNA Logistics Bot — agent foundation (Task #282 Phase 1)
// ─────────────────────────────────────────────────────────────────────────────

// pgvector column type (1536 dims = text-embedding-3-small).
// Stored/read as a JS number[]; serialized to pgvector literal on write.
export const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    if (Array.isArray(value)) return value as number[];
    if (typeof value === "string") {
      const inner = value.replace(/^\[|\]$/g, "");
      if (!inner) return [];
      return inner.split(",").map(Number);
    }
    return [];
  },
});

// Per-(rep, capability) permission overrides; absence = inherit role default.
// `effect` = "allow" | "deny" | "auto". `auto` = standing-approval (skip HITL).
export const agentCapabilities = pgTable(
  "agent_capabilities",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    effect: text("effect").notNull(),
    note: text("note"),
    updatedBy: varchar("updated_by"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agent_capabilities_user_cap_idx").on(table.userId, table.capability),
    index("agent_capabilities_org_idx").on(table.organizationId),
  ],
);
export const insertAgentCapabilitySchema = createInsertSchema(agentCapabilities).omit({ id: true, updatedAt: true });
export type InsertAgentCapability = z.infer<typeof insertAgentCapabilitySchema>;
export type AgentCapability = typeof agentCapabilities.$inferSelect;

// Standing facts about a rep (preferences, style, working hours, etc.).
// Hand-curated or extracted by the agent. Always loaded into context envelope.
export const agentFacts = pgTable(
  "agent_facts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    fact: text("fact").notNull(),
    source: text("source").notNull().default("rep"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("agent_facts_user_idx").on(table.userId),
    index("agent_facts_pinned_idx").on(table.userId, table.pinned),
  ],
);
export const insertAgentFactSchema = createInsertSchema(agentFacts).omit({ id: true, createdAt: true });
export type InsertAgentFact = z.infer<typeof insertAgentFactSchema>;
export type AgentFact = typeof agentFacts.$inferSelect;

// Long-tail memories — embedded conversational snippets, decisions, etc.
// Retrieved top-k by cosine similarity per turn.
export const agentMemories = pgTable(
  "agent_memories",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("episodic"),
    content: text("content").notNull(),
    embedding: vector1536("embedding"),
    relatedCompanyId: varchar("related_company_id"),
    relatedContactId: varchar("related_contact_id"),
    importance: integer("importance").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastAccessedAt: timestamp("last_accessed_at"),
  },
  (table) => [
    index("agent_memories_user_idx").on(table.userId),
    index("agent_memories_user_company_idx").on(table.userId, table.relatedCompanyId),
    index("agent_memories_created_idx").on(table.userId, table.createdAt),
  ],
);
export const insertAgentMemorySchema = createInsertSchema(agentMemories).omit({ id: true, createdAt: true, embedding: true });
export type InsertAgentMemory = z.infer<typeof insertAgentMemorySchema>;
export type AgentMemory = typeof agentMemories.$inferSelect;

// Append-only audit trail of every agent action (read or write, allowed or denied).
export const agentActivity = pgTable(
  "agent_activity",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    channel: text("channel").notNull().default("in_app"),
    conversationRef: text("conversation_ref"),
    direction: text("direction").notNull(),
    tool: text("tool"),
    capability: text("capability"),
    summary: text("summary"),
    inputJson: jsonb("input_json"),
    outputJson: jsonb("output_json"),
    relatedCompanyId: varchar("related_company_id"),
    relatedContactId: varchar("related_contact_id"),
    model: text("model"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    latencyMs: integer("latency_ms"),
    outcome: text("outcome").notNull().default("ok"),
    errorMessage: text("error_message"),
    // Task #360 — analytics enrichment
    confidence: decimal("confidence", { precision: 4, scale: 3 }),
    sourceIds: text("source_ids").array(),
    route: text("route"),
    actionOutcome: text("action_outcome"),
    feedbackRating: text("feedback_rating"),
    messageId: integer("message_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("agent_activity_user_idx").on(table.userId, table.createdAt),
    index("agent_activity_org_idx").on(table.organizationId, table.createdAt),
    index("agent_activity_tool_idx").on(table.tool),
    index("agent_activity_company_idx").on(table.relatedCompanyId),
    index("agent_activity_outcome_idx").on(table.organizationId, table.outcome, table.createdAt),
    index("agent_activity_message_idx").on(table.messageId),
  ],
);

// ─── Task #360: Per-turn feedback (thumbs up/down + optional comment) ─────
export const copilotFeedback = pgTable(
  "copilot_feedback",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    conversationRef: text("conversation_ref"),
    messageId: integer("message_id"),
    rating: text("rating").notNull(),
    comment: text("comment"),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
  },
  (t) => [
    index("copilot_feedback_org_idx").on(t.organizationId, t.capturedAt),
    index("copilot_feedback_user_idx").on(t.userId, t.capturedAt),
    index("copilot_feedback_msg_idx").on(t.messageId),
  ],
);
export const insertCopilotFeedbackSchema = createInsertSchema(copilotFeedback).omit({ id: true, capturedAt: true });
export type InsertCopilotFeedback = z.infer<typeof insertCopilotFeedbackSchema>;
export type CopilotFeedback = typeof copilotFeedback.$inferSelect;

// ─── Task #360: Action audit (every confirmed action card execution) ─────
export const copilotActions = pgTable(
  "copilot_actions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    confirmedByUserId: varchar("confirmed_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    conversationRef: text("conversation_ref"),
    messageId: integer("message_id"),
    tool: text("tool").notNull(),
    args: jsonb("args"),
    result: text("result").notNull().default("success"),
    errorMessage: text("error_message"),
    relatedCompanyId: varchar("related_company_id"),
    relatedContactId: varchar("related_contact_id"),
    completedAt: timestamp("completed_at").defaultNow().notNull(),
  },
  (t) => [
    index("copilot_actions_org_idx").on(t.organizationId, t.completedAt),
    index("copilot_actions_user_idx").on(t.confirmedByUserId, t.completedAt),
    index("copilot_actions_company_idx").on(t.relatedCompanyId, t.completedAt),
    index("copilot_actions_tool_idx").on(t.tool),
    // Phase 5: idempotency contract — at most one audit row per (org, turn, tool).
    // `messageId` is the assistant turn id; we treat it as the turnId for dedupe.
    // PARTIAL unique index (only when message_id is set) — must match the
    // migration in server/runMigrations.ts AND the onConflictDoNothing target
    // in server/routes/agentAnalytics.ts so conflict inference is deterministic
    // across environments.
    uniqueIndex("copilot_actions_turn_tool_unique")
      .on(t.organizationId, t.messageId, t.tool)
      .where(sql`message_id IS NOT NULL`),
  ],
);
export const insertCopilotActionSchema = createInsertSchema(copilotActions).omit({ id: true, completedAt: true });
export type InsertCopilotAction = z.infer<typeof insertCopilotActionSchema>;
export type CopilotAction = typeof copilotActions.$inferSelect;
export const insertAgentActivitySchema = createInsertSchema(agentActivity).omit({ id: true, createdAt: true });
export type InsertAgentActivity = z.infer<typeof insertAgentActivitySchema>;
export type AgentActivity = typeof agentActivity.$inferSelect;

// Org-level AI Agent module settings. One row per organization.
// Mass foundational toggles (kill switch, default access policy, default model).
export const agentOrgSettings = pgTable(
  "agent_org_settings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    moduleEnabled: boolean("module_enabled").notNull().default(true),
    defaultAccessForNewUsers: text("default_access_for_new_users").notNull().default("allow"),
    defaultModel: text("default_model").notNull().default("gpt-4o-mini"),
    autoApprovePersonalMemory: boolean("auto_approve_personal_memory").notNull().default(true),
    allowExternalOutreach: boolean("allow_external_outreach").notNull().default(false),
    valueiqLandingEnabled: boolean("valueiq_landing_enabled").notNull().default(true),
    valueiqTodaySeedEnabled: boolean("valueiq_today_seed_enabled").notNull().default(true),
    valueiqTodayTimezone: text("valueiq_today_timezone").notNull().default("America/Chicago"),
    notes: text("notes"),
    updatedBy: varchar("updated_by"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agent_org_settings_org_idx").on(table.organizationId),
  ],
);
export const insertAgentOrgSettingsSchema = createInsertSchema(agentOrgSettings).omit({ id: true, updatedAt: true });
export type InsertAgentOrgSettings = z.infer<typeof insertAgentOrgSettingsSchema>;
export type AgentOrgSettings = typeof agentOrgSettings.$inferSelect;

// ─── Agents (admin-managed) ──────────────────────────────────────────────
// Phase-1: a single seeded "DNA" agent per organization. Tables are keyed by
// agent_id from day one so the upcoming multi-agent registry can populate
// additional rows without schema churn.
export const agents = pgTable(
  "agents",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    ownerId: varchar("owner_id"),
    model: text("model"),
    accessScope: text("access_scope").notNull().default("everyone"),
    allowedRoles: text("allowed_roles").array(),
    isDefault: boolean("is_default").notNull().default(false),
    status: text("status").notNull().default("published"),
    createdBy: varchar("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agents_org_slug_idx").on(table.organizationId, table.slug),
    index("agents_org_default_idx").on(table.organizationId, table.isDefault),
  ],
);
export const insertAgentSchema = createInsertSchema(agents).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agents.$inferSelect;

// Versioned persona body per (agent, channel slot). Latest row with isActive=true
// is the live one. Channel slot is `base` for the global default, or one of
// `in_app | email | sms_voice | teams` for per-channel overlays.
export const agentPersonas = pgTable(
  "agent_personas",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    agentId: varchar("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    body: text("body").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdBy: varchar("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("agent_personas_active_idx").on(table.agentId, table.channel, table.isActive),
    index("agent_personas_history_idx").on(table.agentId, table.channel, table.createdAt),
  ],
);
export const insertAgentPersonaSchema = createInsertSchema(agentPersonas).omit({ id: true, createdAt: true });
export type InsertAgentPersona = z.infer<typeof insertAgentPersonaSchema>;
export type AgentPersona = typeof agentPersonas.$inferSelect;

// Reusable, named response approaches DNA can apply when situations match.
export const agentPlays = pgTable(
  "agent_plays",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    agentId: varchar("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    whenToUse: text("when_to_use").notNull(),
    body: text("body").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: varchar("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("agent_plays_agent_idx").on(table.agentId, table.enabled),
  ],
);
export const insertAgentPlaySchema = createInsertSchema(agentPlays).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAgentPlay = z.infer<typeof insertAgentPlaySchema>;
export type AgentPlay = typeof agentPlays.$inferSelect;

// Consent tracking for first-contact gating with external parties (drivers, dispatchers).
export const externalContactConsent = pgTable(
  "external_contact_consent",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    contactKind: text("contact_kind").notNull(),
    identifier: text("identifier").notNull(),
    displayName: text("display_name"),
    relatedCompanyId: varchar("related_company_id"),
    consent: text("consent").notNull().default("unknown"),
    firstContactBy: varchar("first_contact_by"),
    firstContactAt: timestamp("first_contact_at"),
    lastContactAt: timestamp("last_contact_at"),
    notes: text("notes"),
  },
  (table) => [
    uniqueIndex("ext_consent_identifier_idx").on(table.organizationId, table.contactKind, table.identifier),
  ],
);
export const insertExternalContactConsentSchema = createInsertSchema(externalContactConsent).omit({ id: true });
export type InsertExternalContactConsent = z.infer<typeof insertExternalContactConsentSchema>;
export type ExternalContactConsent = typeof externalContactConsent.$inferSelect;

// ─── ValueIQ Workspace & Multi-Agent Registry (Task #291) ────────────────
// Per-agent tool allowlist (capability strings from server/agent/tools.ts).
export const agentTools = pgTable(
  "agent_tools",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    agentId: varchar("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agent_tools_agent_cap_idx").on(table.agentId, table.capability),
  ],
);
export const insertAgentToolSchema = createInsertSchema(agentTools).omit({ id: true, createdAt: true });
export type InsertAgentTool = z.infer<typeof insertAgentToolSchema>;
export type AgentTool = typeof agentTools.$inferSelect;

export const agentChannelAccess = pgTable(
  "agent_channel_access",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    agentId: varchar("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    enabled: boolean("enabled").notNull().default(true),
  },
  (table) => [
    uniqueIndex("agent_channel_access_agent_chan_idx").on(table.agentId, table.channel),
  ],
);
export type AgentChannelAccess = typeof agentChannelAccess.$inferSelect;

export const agentUserAccess = pgTable(
  "agent_user_access",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    agentId: varchar("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
  },
  (table) => [
    uniqueIndex("agent_user_access_agent_user_idx").on(table.agentId, table.userId),
    index("agent_user_access_user_idx").on(table.userId),
  ],
);
export type AgentUserAccess = typeof agentUserAccess.$inferSelect;

// ValueIQ thread projects — folders that pin reusable context across threads.
export const threadProjects = pgTable(
  "thread_projects",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    pinnedContext: text("pinned_context"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("thread_projects_user_idx").on(table.userId, table.createdAt)],
);
export const insertThreadProjectSchema = createInsertSchema(threadProjects).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertThreadProject = z.infer<typeof insertThreadProjectSchema>;
export type ThreadProject = typeof threadProjects.$inferSelect;

// A ValueIQ thread = a single conversation row, optionally inside a project.
export const threads = pgTable(
  "threads",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: varchar("project_id"),
    title: text("title").notNull().default("New thread"),
    defaultAgentId: varchar("default_agent_id"),
    surface: text("surface").notNull().default("valueiq"),
    seedKind: text("seed_kind"),
    pinned: boolean("pinned").notNull().default(false),
    archivedAt: timestamp("archived_at"),
    lastMessageAt: timestamp("last_message_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("threads_user_idx").on(table.userId, table.archivedAt, table.lastMessageAt),
    index("threads_project_idx").on(table.projectId),
    index("threads_org_idx").on(table.organizationId, table.createdAt),
  ],
);
export const insertThreadSchema = createInsertSchema(threads).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertThread = z.infer<typeof insertThreadSchema>;
export type Thread = typeof threads.$inferSelect;

export const threadMessages = pgTable(
  "thread_messages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    threadId: varchar("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    agentId: varchar("agent_id"),
    agentName: text("agent_name"),
    content: text("content").notNull(),
    attachments: jsonb("attachments"),
    rating: integer("rating"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("thread_messages_thread_idx").on(table.threadId, table.createdAt),
  ],
);
export const insertThreadMessageSchema = createInsertSchema(threadMessages).omit({ id: true, createdAt: true });
export type InsertThreadMessage = z.infer<typeof insertThreadMessageSchema>;
export type ThreadMessage = typeof threadMessages.$inferSelect;

export const threadAttachments = pgTable(
  "thread_attachments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    threadId: varchar("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    messageId: varchar("message_id"),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type"),
    byteSize: integer("byte_size").notNull().default(0),
    parsedText: text("parsed_text"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("thread_attachments_thread_idx").on(table.threadId),
    index("thread_attachments_message_idx").on(table.messageId),
  ],
);
export type ThreadAttachment = typeof threadAttachments.$inferSelect;

// Personal Library — a rep's private memory store. kind is one of:
// memory | file | thread | fact. `embedding` is populated when content is
// substantive enough to retrieve over.
export const libraryItems = pgTable(
  "library_items",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    sourceId: varchar("source_id"),
    title: text("title").notNull(),
    body: text("body"),
    embedding: vector1536("embedding"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("library_items_user_idx").on(table.userId, table.createdAt),
    index("library_items_kind_idx").on(table.userId, table.kind),
  ],
);
export type LibraryItem = typeof libraryItems.$inferSelect;

// Org corpus — chunked, embedded representation of the org's CRM data so the
// agent can ground responses without a full table dump.
export const orgCorpusChunks = pgTable(
  "org_corpus_chunks",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    chunkIndex: integer("chunk_index").notNull().default(0),
    text: text("text").notNull(),
    embedding: vector1536("embedding"),
    metadata: jsonb("metadata"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("org_corpus_kind_src_chunk_idx").on(table.organizationId, table.sourceKind, table.sourceId, table.chunkIndex),
    index("org_corpus_org_kind_idx").on(table.organizationId, table.sourceKind),
  ],
);
export type OrgCorpusChunk = typeof orgCorpusChunks.$inferSelect;

// ─── Playbook Module (Task #300) ────────────────────────────────────────────
// First-class plays managers can author, version, publish, and roll up to
// outcome analytics. Independent of agent_plays (which feed DNA's persona).

export const plays = pgTable(
  "plays",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    audience: text("audience").notNull().default("customer"),     // customer | carrier
    channel: text("channel").notNull().default("email"),          // email | call | in_person
    triggerType: text("trigger_type").notNull().default("manual"),// manual | quote_no_response | award_no_carrier | sentiment_drop | signal_match
    triggerConfig: jsonb("trigger_config").$type<Record<string, unknown>>().default({}),
    signalType: text("signal_type"),                              // optional link to proven_tactics signal_type
    recommendedSteps: text("recommended_steps").array().notNull().default(sql`ARRAY[]::text[]`),
    templateBody: text("template_body").notNull().default(""),
    successMetric: text("success_metric").notNull().default(""),
    outcomeWindowHours: integer("outcome_window_hours").notNull().default(96),
    status: text("status").notNull().default("draft"),            // draft | published | archived
    currentVersion: integer("current_version").notNull().default(1),
    sourceLegacyId: varchar("source_legacy_id"),                  // agent_plays.id when migrated
    createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("plays_org_status_idx").on(table.orgId, table.status),
    index("plays_org_trigger_idx").on(table.orgId, table.triggerType),
  ],
);
export const insertPlaySchema = createInsertSchema(plays).omit({
  id: true, createdAt: true, updatedAt: true, currentVersion: true,
});
export type InsertPlay = z.infer<typeof insertPlaySchema>;
export type Play = typeof plays.$inferSelect;

export const playVersions = pgTable(
  "play_versions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    playId: varchar("play_id").notNull().references(() => plays.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    publishedAt: timestamp("published_at"),
    createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("play_versions_play_version_idx").on(table.playId, table.version),
  ],
);
export type PlayVersion = typeof playVersions.$inferSelect;

export const playRuns = pgTable(
  "play_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    playId: varchar("play_id").notNull().references(() => plays.id, { onDelete: "cascade" }),
    playVersion: integer("play_version").notNull(),
    repUserId: varchar("rep_user_id").references(() => users.id, { onDelete: "set null" }),
    accountId: varchar("account_id").references(() => companies.id, { onDelete: "set null" }),
    accountName: text("account_name"),
    laneId: varchar("lane_id"),
    contactId: varchar("contact_id"),
    referenceType: text("reference_type"),                        // lane | award | contact | thread | other
    referenceId: text("reference_id"),
    status: text("status").notNull().default("suggested"),        // suggested | open | completed | cancelled
    triggerSnapshot: jsonb("trigger_snapshot").$type<Record<string, unknown>>(),
    suggestedAt: timestamp("suggested_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    sentAt: timestamp("sent_at"),                                 // when the play's email was actually sent (Task #302)
    threadId: text("thread_id"),                                  // Graph conversationId for inbound matching
    providerMessageId: text("provider_message_id"),               // Graph message id of the outbound send
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("play_runs_org_status_idx").on(table.orgId, table.status),
    index("play_runs_rep_status_idx").on(table.repUserId, table.status),
    index("play_runs_play_idx").on(table.playId),
    index("play_runs_thread_idx").on(table.threadId),
  ],
);
export const insertPlayRunSchema = createInsertSchema(playRuns).omit({ id: true, suggestedAt: true });
export type InsertPlayRun = z.infer<typeof insertPlayRunSchema>;
export type PlayRun = typeof playRuns.$inferSelect;

export const playOutcomes = pgTable(
  "play_outcomes",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    playRunId: varchar("play_run_id").notNull().references(() => playRuns.id, { onDelete: "cascade" }),
    outcome: text("outcome").notNull(),                           // success | fail | no_response
    notes: text("notes"),
    timeToOutcomeHours: integer("time_to_outcome_hours"),
    recordedBy: varchar("recorded_by").references(() => users.id, { onDelete: "set null" }),
    recordedAt: timestamp("recorded_at").defaultNow().notNull(),
    // Task #302 — Email Play Outcome-Tagging
    status: text("status").notNull().default("recorded"),         // pending | classified | overridden | expired | recorded | bounced
    classifierLabel: text("classifier_label"),                    // won | lost | partial | no_response | bounced
    classifierConfidence: integer("classifier_confidence"),       // 0..100
    sourceSignalIds: text("source_signal_ids").array().notNull().default(sql`ARRAY[]::text[]`),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(), // {reasoning, quotedText, fromEmail, subject}
    windowExpiresAt: timestamp("window_expires_at"),
    overrideLabel: text("override_label"),                        // rep override final label
    overrideUserId: varchar("override_user_id").references(() => users.id, { onDelete: "set null" }),
    overrideReason: text("override_reason"),
    overrideAt: timestamp("override_at"),
  },
  (table) => [
    uniqueIndex("play_outcomes_run_idx").on(table.playRunId),
    index("play_outcomes_status_window_idx").on(table.status, table.windowExpiresAt),
  ],
);
export type PlayOutcome = typeof playOutcomes.$inferSelect;

// Auto Weekly Account Reviews. One row per (rep, company, weekOf). Body is the
// rendered markdown one-pager; sections holds the structured inputs the
// composer used so we can re-render or audit.
export const accountReviews = pgTable(
  "account_reviews",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    repUserId: varchar("rep_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    weekOf: text("week_of").notNull(),
    body: text("body").notNull(),
    sections: jsonb("sections"),
    sourceSnapshots: jsonb("source_snapshots"),
    libraryItemId: varchar("library_item_id"),
    followUpThreadId: varchar("follow_up_thread_id"),
    generatedBy: text("generated_by").notNull().default("scheduled"),
    rating: integer("rating"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("account_reviews_rep_company_week_idx").on(table.repUserId, table.companyId, table.weekOf),
    index("account_reviews_company_idx").on(table.companyId, table.weekOf),
    index("account_reviews_rep_idx").on(table.repUserId, table.weekOf),
    index("account_reviews_org_idx").on(table.organizationId, table.weekOf),
  ],
);
export const insertAccountReviewSchema = createInsertSchema(accountReviews).omit({ id: true, createdAt: true });
export type InsertAccountReview = z.infer<typeof insertAccountReviewSchema>;
export type AccountReview = typeof accountReviews.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Proactive Available Freight Outreach Engine ("PAFOE") — Phase 2
// See docs/proactive-freight-outreach/phase1-audit.md §4 for the design.
// ─────────────────────────────────────────────────────────────────────────────

export const FREIGHT_OPPORTUNITY_MODES = ["exact_load", "lane_building", "both"] as const;
export type FreightOpportunityMode = typeof FREIGHT_OPPORTUNITY_MODES[number];

export const FREIGHT_OPPORTUNITY_STATUSES = [
  "new",
  "ready_to_send",
  "sent",
  "awaiting_carrier_reply",
  "awaiting_customer_confirm",
  "partially_covered",
  "covered",
  "expired",
  "cancelled",
] as const;
export type FreightOpportunityStatus = typeof FREIGHT_OPPORTUNITY_STATUSES[number];

export const FREIGHT_OPPORTUNITY_CONFIDENCE = ["low", "normal"] as const;
export type FreightOpportunityConfidence = typeof FREIGHT_OPPORTUNITY_CONFIDENCE[number];

export const FREIGHT_OPPORTUNITY_BUCKETS = [
  "proven",
  "strong_fit_underused",
  "exploratory",
  "rep_added",
] as const;
export type FreightOpportunityBucket = typeof FREIGHT_OPPORTUNITY_BUCKETS[number];

export const FREIGHT_OPPORTUNITY_EXCLUDED_REASONS = [
  "recent_contact",
  "daily_cap",
  "not_approved",
  "do_not_use",
  "opted_out",
  "rep_override",
  "customer_carrier_blocked",
] as const;
export type FreightOpportunityExcludedReason = typeof FREIGHT_OPPORTUNITY_EXCLUDED_REASONS[number];

export const FREIGHT_OPPORTUNITY_RESPONSE_OUTCOMES = [
  // Phase 4 canonical outcomes (task #306). Positive interest is bucketed by
  // urgency horizon so ranking signals can decay appropriately.
  "interested_now",
  "interested_few_days",
  "interested_next_week",
  "interested_future",
  "declined",
  "not_qualified",
  "no_response",
  "booked",
  "do_not_contact_lane",
  // Legacy values retained for back-compat with rows written before #306.
  "accepted",
  "quoted",
  "passed_busy",
  "passed_rate",
  "passed_lane_fit",
  "passed_other",
  "auto_no_reply",
] as const;
export type FreightOpportunityResponseOutcome = typeof FREIGHT_OPPORTUNITY_RESPONSE_OUTCOMES[number];

export const FREIGHT_OPPORTUNITY_AUDIT_EVENTS = [
  "generated",
  "policy_blocked",
  "approved",
  "carrier_excluded",
  "carrier_included_override",
  "carrier_reordered",
  "outreach_queued",
  "outreach_sent",
  "outreach_blocked",
  "wave_scheduled",
  "template_edited",
  "response_recorded",
  "signal_fed_back",
  "status_changed",
  "expired",
  "cancelled",
  "sla_nudged",
  "sla_escalated",
] as const;
export type FreightOpportunityAuditEvent = typeof FREIGHT_OPPORTUNITY_AUDIT_EVENTS[number];

/**
 * company_outreach_policies — per-shipper opt-in + guardrail configuration.
 * Sibling table to companies (kept off the wide companies row).
 */
export const companyOutreachPolicies = pgTable("company_outreach_policies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }).unique(),
  enabled: boolean("enabled").notNull().default(false),
  mode: text("mode").notNull().default("exact_load"),
  approvalRequired: boolean("approval_required").notNull().default(true),
  maxCarriersPerOpportunity: integer("max_carriers_per_opportunity").notNull().default(25),
  leadTimeMinDays: integer("lead_time_min_days").notNull().default(2),
  leadTimeMaxDays: integer("lead_time_max_days").notNull().default(7),
  approvedCarrierOnly: boolean("approved_carrier_only").notNull().default(false),
  approvedCarrierIds: text("approved_carrier_ids").array().notNull().default(sql`'{}'::text[]`),
  doNotAutomate: boolean("do_not_automate").notNull().default(false),
  specialNotes: text("special_notes"),
  // Task #601 — auto-pilot scheduler controls (Available Freight Cockpit)
  autoSendEnabled: boolean("auto_send_enabled").notNull().default(false),
  autoSendHourCt: integer("auto_send_hour_ct").notNull().default(8),
  autoSendTopN: integer("auto_send_top_n").notNull().default(3),
  autoSendMaxPerDay: integer("auto_send_max_per_day").notNull().default(10),
  autoSendLastRunAt: timestamp("auto_send_last_run_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedById: varchar("updated_by_id").references(() => users.id, { onDelete: "set null" }),
}, (t) => ({
  orgEnabledIdx: index("company_outreach_policies_org_enabled_idx").on(t.orgId, t.enabled),
  autoSendIdx: index("company_outreach_policies_auto_send_idx").on(t.orgId, t.autoSendEnabled),
}));
export const insertCompanyOutreachPolicySchema = createInsertSchema(companyOutreachPolicies)
  .omit({ id: true, updatedAt: true })
  .extend({
    mode: z.enum(FREIGHT_OPPORTUNITY_MODES),
  });
export type InsertCompanyOutreachPolicy = z.infer<typeof insertCompanyOutreachPolicySchema>;
export type CompanyOutreachPolicy = typeof companyOutreachPolicies.$inferSelect;

/**
 * freight_opportunities — one open load OR small grouped lane-building sweep.
 */
export const freightOpportunities = pgTable("freight_opportunities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  recurringLaneId: varchar("recurring_lane_id").references(() => recurringLanes.id, { onDelete: "set null" }),
  geographicLanePatternId: varchar("geographic_lane_pattern_id").references(() => geographicLanePatterns.id, { onDelete: "set null" }),
  origin: text("origin").notNull(),
  originState: text("origin_state"),
  destination: text("destination").notNull(),
  destinationState: text("destination_state"),
  equipmentType: text("equipment_type"),
  pickupWindowStart: text("pickup_window_start").notNull(),
  pickupWindowEnd: text("pickup_window_end").notNull(),
  loadCount: integer("load_count").notNull().default(1),
  sourceRef: jsonb("source_ref"),
  urgencyScore: integer("urgency_score").notNull().default(50),
  confidenceFlag: text("confidence_flag").notNull().default("normal"),
  status: text("status").notNull().default("new"),
  policySnapshot: jsonb("policy_snapshot"),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  createdById: varchar("created_by_id").references(() => users.id, { onDelete: "set null" }),
  notes: text("notes"),
  // Task #307 follow-on — daily-upload owned freight ("Available Freight" tab)
  ownerUserId: varchar("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  delegatedToUserId: varchar("delegated_to_user_id").references(() => users.id, { onDelete: "set null" }),
  senderMailbox: text("sender_mailbox"),
  templateOverrideSubject: text("template_override_subject"),
  templateOverrideBody: text("template_override_body"),
  cadenceConfig: jsonb("cadence_config"),
  approvedAt: timestamp("approved_at"),
  approvedById: varchar("approved_by_id").references(() => users.id, { onDelete: "set null" }),
  sourceFileName: text("source_file_name"),
  // Task #364 — Approval SLA tracking. `awaitingApprovalSince` starts when the
  // row enters ready_to_send with no approval (and is cleared on approve).
  // The two `slaNotified*` columns are dedup stamps so the 15-min cron does
  // not spam managers — they reset whenever the awaiting clock restarts.
  awaitingApprovalSince: timestamp("awaiting_approval_since"),
  slaNotifiedL1At: timestamp("sla_notified_l1_at"),
  slaNotifiedL2At: timestamp("sla_notified_l2_at"),
  // Task #601 — cockpit snooze. When set, the cockpit hides this opp until the
  // wake time passes. Audit log records who snoozed and why; status is left
  // untouched so SLA / coverage continue to work after un-snooze.
  snoozedUntil: timestamp("snoozed_until"),
}, (t) => ({
  orgStatusUrgencyIdx: index("freight_opps_org_status_urgency_idx").on(t.orgId, t.status, t.urgencyScore),
  companyPickupIdx: index("freight_opps_company_pickup_idx").on(t.companyId, t.pickupWindowStart),
  recurringLaneIdx: index("freight_opps_recurring_lane_idx").on(t.recurringLaneId),
  ownerIdx: index("freight_opps_owner_idx").on(t.ownerUserId),
  delegatedIdx: index("freight_opps_delegated_idx").on(t.delegatedToUserId),
  awaitingIdx: index("freight_opps_awaiting_idx").on(t.awaitingApprovalSince),
}));
export const insertFreightOpportunitySchema = createInsertSchema(freightOpportunities)
  .omit({ id: true, generatedAt: true })
  .extend({
    mode: z.enum(["exact_load", "lane_building"]),
    status: z.enum(FREIGHT_OPPORTUNITY_STATUSES).optional(),
    confidenceFlag: z.enum(FREIGHT_OPPORTUNITY_CONFIDENCE).optional(),
  });
export type InsertFreightOpportunity = z.infer<typeof insertFreightOpportunitySchema>;
export type FreightOpportunity = typeof freightOpportunities.$inferSelect;

/**
 * freight_opportunity_carriers — frozen ranked shortlist for an opportunity.
 */
export const freightOpportunityCarriers = pgTable("freight_opportunity_carriers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  opportunityId: varchar("opportunity_id").notNull().references(() => freightOpportunities.id, { onDelete: "cascade" }),
  carrierId: varchar("carrier_id").notNull().references(() => carriers.id, { onDelete: "cascade" }),
  rank: integer("rank"),
  bucket: text("bucket"),
  fitScore: integer("fit_score").notNull().default(0),
  historyMatch: text("history_match").notNull().default("none"),
  explanation: text("explanation"),
  explanationStructured: jsonb("explanation_structured"),
  responsivenessSnapshot: jsonb("responsiveness_snapshot"),
  excludedReason: text("excluded_reason"),
  outreachLogId: varchar("outreach_log_id").references(() => carrierOutreachLogs.id, { onDelete: "set null" }),
  lastResponseId: varchar("last_response_id"),
  // Phase 4 — phased-wave + thread-tracking fields. All optional so existing
  // rows (Phase 2/3) remain valid.
  wave: integer("wave"),
  scheduledFor: timestamp("scheduled_for"),
  sentAt: timestamp("sent_at"),
  threadId: text("thread_id"),
  internetMessageId: text("internet_message_id"),
  lastSendError: text("last_send_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  oppRankIdx: index("freight_opp_carriers_opp_rank_idx").on(t.opportunityId, t.rank),
  carrierCreatedIdx: index("freight_opp_carriers_carrier_created_idx").on(t.carrierId, t.createdAt),
  scheduledIdx: index("freight_opp_carriers_scheduled_idx").on(t.scheduledFor, t.sentAt),
  threadIdx: index("freight_opp_carriers_thread_idx").on(t.threadId),
}));
export const insertFreightOpportunityCarrierSchema = createInsertSchema(freightOpportunityCarriers)
  .omit({ id: true, createdAt: true });
export type InsertFreightOpportunityCarrier = z.infer<typeof insertFreightOpportunityCarrierSchema>;
export type FreightOpportunityCarrier = typeof freightOpportunityCarriers.$inferSelect;

/**
 * freight_opportunity_responses — outcome-of-outreach (separate from carrier-truth signals).
 */
export const freightOpportunityResponses = pgTable("freight_opportunity_responses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  opportunityCarrierId: varchar("opportunity_carrier_id").notNull().references(() => freightOpportunityCarriers.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(),
  quotedRate: decimal("quoted_rate", { precision: 12, scale: 2 }),
  replySource: text("reply_source").notNull().default("manual_log"),
  emailMessageId: varchar("email_message_id").references(() => emailMessages.id, { onDelete: "set null" }),
  notes: text("notes"),
  recordedById: varchar("recorded_by_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertFreightOpportunityResponseSchema = createInsertSchema(freightOpportunityResponses)
  .omit({ id: true, createdAt: true })
  .extend({
    outcome: z.enum(FREIGHT_OPPORTUNITY_RESPONSE_OUTCOMES),
    replySource: z.enum(["email", "manual_log", "phone_followup"]).optional(),
  });
export type InsertFreightOpportunityResponse = z.infer<typeof insertFreightOpportunityResponseSchema>;
export type FreightOpportunityResponse = typeof freightOpportunityResponses.$inferSelect;

/**
 * freight_opportunity_audit — append-only event log per opportunity.
 */
export const freightOpportunityAudit = pgTable("freight_opportunity_audit", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  opportunityId: varchar("opportunity_id").notNull().references(() => freightOpportunities.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  actorUserId: varchar("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  oppCreatedIdx: index("freight_opp_audit_opp_created_idx").on(t.opportunityId, t.createdAt),
}));
export const insertFreightOpportunityAuditSchema = createInsertSchema(freightOpportunityAudit)
  .omit({ id: true, createdAt: true })
  .extend({
    eventType: z.enum(FREIGHT_OPPORTUNITY_AUDIT_EVENTS),
  });
export type InsertFreightOpportunityAudit = z.infer<typeof insertFreightOpportunityAuditSchema>;
export type FreightOpportunityAudit = typeof freightOpportunityAudit.$inferSelect;

/**
 * freight_outreach_templates — admin-editable email templates per org for the
 * Phase 4 outreach engine. Two `kind`s are supported (one row each per org):
 *   - exact_load     — used when an opportunity has a specific shipment.
 *   - lane_building  — used for future-freight / capacity-development sweeps.
 *
 * Templates support `{{variable}}` substitution. Available variables:
 *   {{carrier_name}}, {{rep_name}}, {{rep_email}}, {{customer_name}},
 *   {{lane_display}}, {{origin}}, {{destination}}, {{equipment}},
 *   {{pickup_window}}, {{load_count}}, {{has_history}}, {{history_phrase}}
 *
 * Unknown variables render as the empty string so admins cannot break sends
 * with a typo.
 */
export const FREIGHT_OUTREACH_TEMPLATE_KINDS = ["exact_load", "lane_building"] as const;
export type FreightOutreachTemplateKind = typeof FREIGHT_OUTREACH_TEMPLATE_KINDS[number];

export const freightOutreachTemplates = pgTable("freight_outreach_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedById: varchar("updated_by_id").references(() => users.id, { onDelete: "set null" }),
}, (t) => ({
  orgKindUq: index("freight_outreach_templates_org_kind_uq").on(t.orgId, t.kind),
}));
export const insertFreightOutreachTemplateSchema = createInsertSchema(freightOutreachTemplates)
  .omit({ id: true, updatedAt: true })
  .extend({ kind: z.enum(FREIGHT_OUTREACH_TEMPLATE_KINDS) });
export type InsertFreightOutreachTemplate = z.infer<typeof insertFreightOutreachTemplateSchema>;
export type FreightOutreachTemplate = typeof freightOutreachTemplates.$inferSelect;

// ─── Available Freight Cockpit (Task #601) ──────────────────────────────────
// Per-user saved views (filter snapshots) and per-user UI prefs for the
// triage cockpit. Both keyed on userId so each rep has an independent
// workspace; org_id is denormalized for fast org-bound delete-cascades.

export const FREIGHT_COCKPIT_LAYOUTS = ["table", "calendar"] as const;
export type FreightCockpitLayout = typeof FREIGHT_COCKPIT_LAYOUTS[number];

export const FREIGHT_COCKPIT_GROUPINGS = ["none", "customer", "pickup_day", "lane"] as const;
export type FreightCockpitGrouping = typeof FREIGHT_COCKPIT_GROUPINGS[number];

export const FREIGHT_COCKPIT_SORTS = [
  "urgency",
  "pickup_soonest",
  "freshness",
  "customer",
  "lane",
  "suggested_buy",
  "coverage_pct",
  "confidence",
] as const;
export type FreightCockpitSort = typeof FREIGHT_COCKPIT_SORTS[number];

export const freightOpportunitySavedViews = pgTable("freight_opportunity_saved_views", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Filters JSONB shape (any combination):
  //   { customerIds?: string[], statuses?: string[], modes?: string[],
  //     leadTimeBucket?: "<2"|"2-4"|"5-7"|"any",
  //     ownerScope?: "mine"|"team"|"all",
  //     equipmentTypes?: string[], confidenceFlag?: "low"|"normal"|"any",
  //     minUrgency?: number, search?: string,
  //     sort?: FreightCockpitSort, grouping?: FreightCockpitGrouping }
  filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
  isShared: boolean("is_shared").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  orgUserIdx: index("freight_saved_views_org_user_idx").on(t.orgId, t.userId),
}));
export const insertFreightOpportunitySavedViewSchema = createInsertSchema(freightOpportunitySavedViews)
  .omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFreightOpportunitySavedView = z.infer<typeof insertFreightOpportunitySavedViewSchema>;
export type FreightOpportunitySavedView = typeof freightOpportunitySavedViews.$inferSelect;

export const userFreightCockpitPrefs = pgTable("user_freight_cockpit_prefs", {
  userId: varchar("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  activeViewId: varchar("active_view_id").references(() => freightOpportunitySavedViews.id, { onDelete: "set null" }),
  layout: text("layout").notNull().default("table"),
  grouping: text("grouping").notNull().default("none"),
  sort: text("sort").notNull().default("urgency"),
  autopilotMutedUntil: timestamp("autopilot_muted_until"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  orgIdx: index("user_freight_cockpit_prefs_org_idx").on(t.orgId),
}));
export const insertUserFreightCockpitPrefsSchema = createInsertSchema(userFreightCockpitPrefs)
  .omit({ updatedAt: true })
  .extend({
    layout: z.enum(FREIGHT_COCKPIT_LAYOUTS).optional(),
    grouping: z.enum(FREIGHT_COCKPIT_GROUPINGS).optional(),
    sort: z.enum(FREIGHT_COCKPIT_SORTS).optional(),
  });
export type InsertUserFreightCockpitPrefs = z.infer<typeof insertUserFreightCockpitPrefsSchema>;
export type UserFreightCockpitPrefs = typeof userFreightCockpitPrefs.$inferSelect;

// ─── Manager Coaching Mode (Task #301) ──────────────────────────────────────
// Manager-authored coaching notes tied to a specific Coaching Card item
// (account at risk / play-not-run / flagged call / response-time outlier /
// promotion-readiness). Surfaced to the rep in their next ValueIQ Today
// thread once `deliveredAt` is set by the seeder.

// ─── Legacy tables kept in DB but historically not declared here ─────────
// These two tables are still actively read/written by server code (see
// server/lmCheckinScheduler.ts, server/routes.ts, server/routes/dashboard.ts,
// server/routes/financials.ts). They were never added to this schema file,
// which caused drizzle-kit to interpret newly-added tables as potential
// renames of these "orphan" tables and emit an interactive *select* prompt
// during db:push. That prompt cannot be answered headlessly during the
// post-merge reconciliation step, which made task-merge "apply" appear to
// succeed and then revert. Declaring them here matches the live schema 1:1
// so drizzle-kit no longer considers them rename candidates.
export const opportunityDismissals = pgTable(
  "opportunity_dismissals",
  {
    id: serial("id").primaryKey(),
    companyId: varchar("company_id").notNull(),
    orgId: varchar("org_id").notNull(),
    dismissedBy: varchar("dismissed_by").notNull(),
    dismissedAt: text("dismissed_at").notNull(),
  },
  (table) => [
    uniqueIndex("opportunity_dismissals_company_id_org_id_key").on(
      table.companyId,
      table.orgId,
    ),
  ],
);
export type OpportunityDismissal = typeof opportunityDismissals.$inferSelect;

export const namLmCheckins = pgTable(
  "nam_lm_checkins",
  {
    id: serial("id").primaryKey(),
    reviewerId: varchar("reviewer_id").notNull(),
    lmId: varchar("lm_id").notNull(),
    organizationId: varchar("organization_id").notNull(),
    checkDate: date("check_date").notNull().default(sql`CURRENT_DATE`),
    checkType: varchar("check_type").notNull(),
    checkCallsDone: boolean("check_calls_done"),
    boardClean: boolean("board_clean"),
    checkoutDone: boolean("checkout_done"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_nam_lm_checkins_lm").on(table.lmId, table.checkDate),
    index("idx_nam_lm_checkins_reviewer").on(table.reviewerId, table.checkDate),
    uniqueIndex("nam_lm_checkins_unique").on(
      table.reviewerId,
      table.lmId,
      table.checkDate,
      table.checkType,
    ),
  ],
);
export type NamLmCheckin = typeof namLmCheckins.$inferSelect;

export const coachingNotes = pgTable(
  "coaching_notes",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    managerId: varchar("manager_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    repId: varchar("rep_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    subjectKind: text("subject_kind").notNull(), // account_risk | play_not_run | flagged_call | response_outlier | promotion_ready | general
    subjectId: text("subject_id"),                // companyId | playId | touchpointId | null
    subjectLabel: text("subject_label"),          // human-friendly label captured at write time
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deliveredAt: timestamp("delivered_at"),       // set when surfaced in the rep's Today thread
  },
  (table) => [
    index("coaching_notes_rep_idx").on(table.repId, table.createdAt),
    index("coaching_notes_manager_idx").on(table.managerId, table.createdAt),
  ],
);
export const insertCoachingNoteSchema = createInsertSchema(coachingNotes).omit({
  id: true, createdAt: true, deliveredAt: true,
});
export type InsertCoachingNote = z.infer<typeof insertCoachingNoteSchema>;
export type CoachingNote = typeof coachingNotes.$inferSelect;
// ─── Agentic Brokerage Program (Task #314) ───────────────────────────────
// Workflow agents: outcome-owning bots that monitor signals, plan actions, and
// execute through the adapter+HITL layer. Distinct from the chat agents in
// `agents` (which power ValueIQ/DNA conversational turns).
export const workflowAgents = pgTable(
  "workflow_agents",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),                  // pricing | order_schedule | coverage | risk | execution | billing
    name: text("name").notNull(),
    description: text("description"),
    loop: text("loop").notNull(),                  // rfq_to_quote | win_to_load | coverage | risk | execution | billing
    autonomy: text("autonomy").notNull().default("off"), // off | suggest | draft | auto_hitl | auto
    enabled: boolean("enabled").notNull().default(false),
    scope: jsonb("scope").$type<{ customers?: string[]; lanes?: string[]; equipment?: string[]; pods?: string[] }>(),
    guardrails: jsonb("guardrails").$type<{
      marginFloorUsd?: number; maxDollarPerAction?: number; maxRiskScore?: number;
      allowedHoursStart?: string; allowedHoursEnd?: string;
      dailySendCapEmail?: number; dailySendCapSms?: number;
      blockedCustomerIds?: string[]; blockedCarrierIds?: string[];
    }>(),
    triggers: jsonb("triggers").$type<{ schedule?: string; events?: string[] }>(),
    targetMetric: text("target_metric"),
    personaOverlay: text("persona_overlay"),
    model: text("model").notNull().default("gpt-4o"),
    killSwitch: boolean("kill_switch").notNull().default(false),
    createdBy: varchar("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workflow_agents_org_slug_idx").on(table.organizationId, table.slug),
    index("workflow_agents_org_enabled_idx").on(table.organizationId, table.enabled),
  ],
);
export const insertWorkflowAgentSchema = createInsertSchema(workflowAgents).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWorkflowAgent = z.infer<typeof insertWorkflowAgentSchema>;
export type WorkflowAgent = typeof workflowAgents.$inferSelect;

// Pods: small human+agent teams owning a book of business end-to-end.
export const pods = pgTable(
  "pods",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    podType: text("pod_type").notNull().default("vertical"), // vertical | cross_border | trailer_pool | large_shipper | other
    description: text("description"),
    managerId: varchar("manager_id"),
    scope: jsonb("scope").$type<{ customers?: string[]; verticals?: string[]; lanes?: string[] }>(),
    kpis: jsonb("kpis").$type<{ pAndL?: number; otdPct?: number; marginPct?: number; trailerRoic?: number }>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("pods_org_idx").on(table.organizationId),
  ],
);
export const insertPodSchema = createInsertSchema(pods).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPod = z.infer<typeof insertPodSchema>;
export type Pod = typeof pods.$inferSelect;

export const podMembers = pgTable(
  "pod_members",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    podId: varchar("pod_id").notNull().references(() => pods.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("rep"), // manager | rep | lc | analyst
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("pod_members_pod_user_idx").on(table.podId, table.userId),
    index("pod_members_user_idx").on(table.userId),
  ],
);
export type PodMember = typeof podMembers.$inferSelect;

export const podAgents = pgTable(
  "pod_agents",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    podId: varchar("pod_id").notNull().references(() => pods.id, { onDelete: "cascade" }),
    workflowAgentId: varchar("workflow_agent_id").notNull().references(() => workflowAgents.id, { onDelete: "cascade" }),
    autonomyOverride: text("autonomy_override"), // null = inherit from agent
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("pod_agents_pod_agent_idx").on(table.podId, table.workflowAgentId),
  ],
);
export type PodAgent = typeof podAgents.$inferSelect;

// HITL inbox — actions staged by workflow agents above their autonomy threshold.
export const hitlActions = pgTable(
  "hitl_actions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    workflowAgentId: varchar("workflow_agent_id").notNull().references(() => workflowAgents.id, { onDelete: "cascade" }),
    podId: varchar("pod_id").references(() => pods.id, { onDelete: "set null" }),
    suggestionId: varchar("suggestion_id"),
    actionKind: text("action_kind").notNull(), // send_email | send_sms | accept_tender | post_truck | start_detention_claim | send_invoice | book_carrier | other
    title: text("title").notNull(),
    summary: text("summary"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    reasoning: text("reasoning"),
    adapterMode: text("adapter_mode").notNull().default("dry_run"), // dry_run | live
    routedToUserId: varchar("routed_to_user_id"),
    relatedCompanyId: varchar("related_company_id"),
    relatedLaneKey: text("related_lane_key"),
    status: text("status").notNull().default("pending"), // pending | approved | rejected | edited | expired
    decidedByUserId: varchar("decided_by_user_id"),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("hitl_actions_org_status_idx").on(table.organizationId, table.status),
    index("hitl_actions_routed_idx").on(table.routedToUserId, table.status),
    index("hitl_actions_pod_idx").on(table.podId, table.status),
    index("hitl_actions_agent_idx").on(table.workflowAgentId),
  ],
);
export const insertHitlActionSchema = createInsertSchema(hitlActions).omit({ id: true, createdAt: true });
export type InsertHitlAction = z.infer<typeof insertHitlActionSchema>;
export type HitlAction = typeof hitlActions.$inferSelect;

// Every suggestion the agent makes — feeds the learning loop.
export const agentSuggestions = pgTable(
  "agent_suggestions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    workflowAgentId: varchar("workflow_agent_id").notNull().references(() => workflowAgents.id, { onDelete: "cascade" }),
    podId: varchar("pod_id"),
    loopStep: text("loop_step").notNull(), // sense | plan | draft | act | learn
    inputContext: jsonb("input_context"),
    suggestion: jsonb("suggestion").$type<Record<string, unknown>>().notNull(),
    reasoning: text("reasoning"),
    confidence: integer("confidence"),
    relatedCompanyId: varchar("related_company_id"),
    relatedLaneKey: text("related_lane_key"),
    adapterMode: text("adapter_mode").notNull().default("dry_run"),
    promptVersion: text("prompt_version"),
    model: text("model"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("agent_suggestions_agent_idx").on(table.workflowAgentId, table.createdAt),
    index("agent_suggestions_org_idx").on(table.organizationId, table.createdAt),
  ],
);
export const insertAgentSuggestionSchema = createInsertSchema(agentSuggestions).omit({ id: true, createdAt: true });
export type InsertAgentSuggestion = z.infer<typeof insertAgentSuggestionSchema>;
export type AgentSuggestion = typeof agentSuggestions.$inferSelect;

// Outcome of a suggestion (won/lost/covered/on_time/paid/disputed/etc.) — joined back into proven_tactics scoring.
export const agentOutcomes = pgTable(
  "agent_outcomes",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    workflowAgentId: varchar("workflow_agent_id").notNull().references(() => workflowAgents.id, { onDelete: "cascade" }),
    suggestionId: varchar("suggestion_id").references(() => agentSuggestions.id, { onDelete: "set null" }),
    hitlActionId: varchar("hitl_action_id").references(() => hitlActions.id, { onDelete: "set null" }),
    overrideKind: text("override_kind").notNull().default("none"), // none | edited | rejected | replaced
    realizedOutcome: text("realized_outcome"), // won | lost | covered | on_time | late | paid | disputed | unpaid | n/a
    metricValue: decimal("metric_value", { precision: 14, scale: 4 }),
    notes: text("notes"),
    recordedBy: varchar("recorded_by"),
    recordedAt: timestamp("recorded_at").defaultNow().notNull(),
  },
  (table) => [
    index("agent_outcomes_agent_idx").on(table.workflowAgentId, table.recordedAt),
  ],
);
export const insertAgentOutcomeSchema = createInsertSchema(agentOutcomes).omit({ id: true, recordedAt: true });
export type InsertAgentOutcome = z.infer<typeof insertAgentOutcomeSchema>;
export type AgentOutcome = typeof agentOutcomes.$inferSelect;

// Adapter readiness state per organization — drives the live-flip checklist
// in the Rollout view.
export const adapterStatus = pgTable(
  "adapter_status",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    adapterKey: text("adapter_key").notNull(), // dat | truckstop | sonar | highway | carrier411 | valuetms | edi | graph_mail | twilio | payment_portal | customer_portal
    mode: text("mode").notNull().default("dry_run"), // dry_run | live
    credentialsConfigured: boolean("credentials_configured").notNull().default(false),
    lastCheckedAt: timestamp("last_checked_at"),
    notes: text("notes"),
    updatedBy: varchar("updated_by"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("adapter_status_org_key_idx").on(table.organizationId, table.adapterKey),
  ],
);
export type AdapterStatus = typeof adapterStatus.$inferSelect;

// ─── Carrier Intelligence — load_fact substrate (Task #368) ─────────────────
//
// Single trusted freight load substrate. Every TMS row from the unified
// PowerBI/OneDrive extract becomes one row here, keyed by (org_id, order_id).
// `move_status` is the canonical state — Available vs Realized bucketing is
// derived from it inside the carrierIntelligence service, never from legacy
// `financial_uploads.rows` or `freight_opportunities.status`.
//
// This table is intentionally wide: it keeps the raw-row JSON alongside the
// normalized columns so downstream code can read either path while the
// org migrates. The unique (org_id, order_id) constraint enforces "one
// row per TMS load" idempotency.
export const loadFact = pgTable("load_fact", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: text("order_id").notNull(),
  companyId: varchar("company_id").references(() => companies.id, { onDelete: "set null" }),
  customerName: text("customer_name"),
  carrierName: text("carrier_name"),
  carrierPayeeCode: text("carrier_payee_code"),
  // Geography — wide enough to cover Available, Active and Realized lookups.
  originCity: text("origin_city"),
  originState: text("origin_state"),
  originZip: text("origin_zip"),
  destinationCity: text("destination_city"),
  destinationState: text("destination_state"),
  destinationZip: text("destination_zip"),
  // Ownership — required so dashboards can roll up by AM/dispatcher.
  accountManager: text("account_manager"),
  dispatcher: text("dispatcher"),
  equipmentType: text("equipment_type"),
  // Schedule — date strings preserved as-is from the TMS extract for parity.
  pickupDate: text("pickup_date"),
  deliveryDate: text("delivery_date"),
  pickupApptStart: text("pickup_appt_start"),
  pickupApptEnd: text("pickup_appt_end"),
  deliveryApptStart: text("delivery_appt_start"),
  deliveryApptEnd: text("delivery_appt_end"),
  arrivedAtPickup: text("arrived_at_pickup"),
  arrivedAtDelivery: text("arrived_at_delivery"),
  totalStops: integer("total_stops"),
  totalMiles: decimal("total_miles", { precision: 10, scale: 2 }),
  month: text("month"), // YYYY-MM
  // State — `move_status` is the canonical TMS state; `bucket` is the
  // service-derived Available/Realized/Cancelled/Unknown classification.
  moveStatus: text("move_status"),
  bucket: text("bucket").notNull().default("available"),
  revenue: decimal("revenue", { precision: 14, scale: 2 }),
  cost: decimal("cost", { precision: 14, scale: 2 }),
  margin: decimal("margin", { precision: 14, scale: 2 }),
  marginPct: decimal("margin_pct", { precision: 7, scale: 4 }),
  loadCount: integer("load_count").notNull().default(1),
  rawRow: jsonb("raw_row"),
  sourceFileName: text("source_file_name"),
  sourceKind: text("source_kind").notNull().default("powerbi"),
  // Lifecycle — `lastSeenAt` updated every time an import sees this order; if
  // an Available row is absent from a fresh extract it gets `expiredAt` set
  // and rolled into the `cancelled` bucket so dashboards do not double-count
  // dropped freight.
  importedAt: timestamp("imported_at").defaultNow().notNull(),
  lastChangedAt: timestamp("last_changed_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  expiredAt: timestamp("expired_at"),
}, (t) => ({
  orgOrderUq: uniqueIndex("load_fact_org_order_uq").on(t.orgId, t.orderId),
  orgBucketIdx: index("load_fact_org_bucket_idx").on(t.orgId, t.bucket),
  orgCarrierIdx: index("load_fact_org_carrier_idx").on(t.orgId, t.carrierName),
  orgMonthIdx: index("load_fact_org_month_idx").on(t.orgId, t.month),
  orgCompanyIdx: index("load_fact_org_company_idx").on(t.orgId, t.companyId),
  orgPickupIdx: index("load_fact_org_pickup_idx").on(t.orgId, t.pickupDate),
  orgAcctMgrIdx: index("load_fact_org_account_manager_idx").on(t.orgId, t.accountManager),
  orgDispatcherIdx: index("load_fact_org_dispatcher_idx").on(t.orgId, t.dispatcher),
  orgLastSeenIdx: index("load_fact_org_last_seen_idx").on(t.orgId, t.lastSeenAt),
}));
export const insertLoadFactSchema = createInsertSchema(loadFact)
  .omit({ id: true, importedAt: true, lastChangedAt: true, lastSeenAt: true, expiredAt: true });
export type InsertLoadFact = z.infer<typeof insertLoadFactSchema>;
export type LoadFact = typeof loadFact.$inferSelect;

// Import audit — one row per importer/backfill run. Captures the file hash
// + replay token so the same source can be re-applied deterministically and
// the post-cutover surfaces can prove which run produced which numbers.
export const loadFactImportAudit = pgTable("load_fact_import_audit", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull(),
  fileName: text("file_name"),
  fileHash: text("file_hash"),
  replayToken: text("replay_token"),
  totalRows: integer("total_rows").notNull().default(0),
  inserted: integer("inserted").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  unchanged: integer("unchanged").notNull().default(0),
  transitioned: integer("transitioned").notNull().default(0),
  expired: integer("expired").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  bucketAvailable: integer("bucket_available").notNull().default(0),
  bucketRealized: integer("bucket_realized").notNull().default(0),
  bucketCancelled: integer("bucket_cancelled").notNull().default(0),
  bucketUnknown: integer("bucket_unknown").notNull().default(0),
  warnings: jsonb("warnings"),
  actorUserId: varchar("actor_user_id"),
  triggeredBy: text("triggered_by").notNull().default("manual"),
  kind: text("kind").notNull().default("powerbi"),
  error: text("error"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgCreatedIdx: index("load_fact_import_audit_org_created_idx").on(t.orgId, t.createdAt),
  orgReplayIdx: index("load_fact_import_audit_org_replay_idx").on(t.orgId, t.replayToken),
}));
export const insertLoadFactImportAuditSchema = createInsertSchema(loadFactImportAudit)
  .omit({ id: true, createdAt: true });
export type InsertLoadFactImportAudit = z.infer<typeof insertLoadFactImportAuditSchema>;
export type LoadFactImportAudit = typeof loadFactImportAudit.$inferSelect;

// Append-only field-change history for each load_fact row. Lets the parity
// harness and audit views reconstruct what changed across imports without
// blowing up the main table with snapshot rows.
export const loadFactHistory = pgTable("load_fact_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  loadFactId: varchar("load_fact_id").notNull().references(() => loadFact.id, { onDelete: "cascade" }),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
  fieldName: text("field_name").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  importBatchId: varchar("import_batch_id"),
}, (t) => ({
  loadChangedIdx: index("load_fact_history_load_changed_idx").on(t.loadFactId, t.changedAt),
  orgChangedIdx: index("load_fact_history_org_changed_idx").on(t.orgId, t.changedAt),
}));
export const insertLoadFactHistorySchema = createInsertSchema(loadFactHistory)
  .omit({ id: true, changedAt: true });
export type InsertLoadFactHistory = z.infer<typeof insertLoadFactHistorySchema>;
export type LoadFactHistory = typeof loadFactHistory.$inferSelect;

// ─── Webex Call Quality Analytics (Task #315) ────────────────────────────
// Per-call quality, talk-time, and activity metrics pulled from the Webex
// detailed call history API (analytics scope). One row per Webex CDR id so
// the rest of the app can aggregate scorecards without re-hitting Webex.
export const webexCallAnalytics = pgTable(
  "webex_call_analytics",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
    webexPersonId: text("webex_person_id"),
    webexUserEmail: text("webex_user_email"),
    direction: text("direction"),
    remoteNumber: text("remote_number"),
    startTime: timestamp("start_time"),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    answered: boolean("answered").notNull().default(false),
    talkTimeSeconds: integer("talk_time_seconds").notNull().default(0),
    holdTimeSeconds: integer("hold_time_seconds").notNull().default(0),
    silenceSeconds: integer("silence_seconds").notNull().default(0),
    ringTimeSeconds: integer("ring_time_seconds").notNull().default(0),
    mosScore: decimal("mos_score", { precision: 4, scale: 2 }),
    jitterMs: decimal("jitter_ms", { precision: 8, scale: 2 }),
    packetLossPct: decimal("packet_loss_pct", { precision: 6, scale: 3 }),
    qualityGrade: text("quality_grade"),
    afterHours: boolean("after_hours").notNull().default(false),
    companyId: varchar("company_id"),
    contactId: varchar("contact_id"),
    touchpointId: varchar("touchpoint_id"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("webex_analytics_org_call_idx").on(table.orgId, table.callId),
    index("webex_analytics_user_time_idx").on(table.userId, table.startTime),
    index("webex_analytics_org_time_idx").on(table.orgId, table.startTime),
  ],
);

export const insertWebexCallAnalyticsSchema = createInsertSchema(webexCallAnalytics).omit({
  id: true,
  syncedAt: true,
  updatedAt: true,
});
export type InsertWebexCallAnalytics = z.infer<typeof insertWebexCallAnalyticsSchema>;
export type WebexCallAnalytics = typeof webexCallAnalytics.$inferSelect;

// ─── Webex Full Coverage & Backfill (Task #466) ─────────────────────────────
//
// `webex_sync_state` tracks last-success / last-error / cursor / backfill
// progress per (org, optional user, dataSource). Lets the admin Webex
// Health panel surface "what's stale and why" without hitting Webex live,
// and lets backfills resume after restarts.
export const webexSyncState = pgTable(
  "webex_sync_state",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }),
    dataSource: text("data_source").notNull(),
    lastSuccessAt: timestamp("last_success_at"),
    lastAttemptAt: timestamp("last_attempt_at"),
    lastErrorAt: timestamp("last_error_at"),
    lastError: text("last_error"),
    cursor: text("cursor"),
    backfillStartedAt: timestamp("backfill_started_at"),
    backfillCompletedAt: timestamp("backfill_completed_at"),
    backfillTotalDays: integer("backfill_total_days").notNull().default(0),
    backfillCompletedDays: integer("backfill_completed_days").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("webex_sync_state_user_unique_idx")
      .on(table.orgId, table.dataSource, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("webex_sync_state_org_unique_idx")
      .on(table.orgId, table.dataSource)
      .where(sql`${table.userId} IS NULL`),
    index("webex_sync_state_org_idx").on(table.orgId),
  ],
);
export const insertWebexSyncStateSchema = createInsertSchema(webexSyncState).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWebexSyncState = z.infer<typeof insertWebexSyncStateSchema>;
export type WebexSyncState = typeof webexSyncState.$inferSelect;

// Tracked per-call enrichment job queue. Replaces the prior fire-and-forget
// fetchCallDetail chain so that 429s and transient 5xx are retried with
// exponential backoff instead of silently dropping analytics.
export const webexCallEnrichmentJobs = pgTable(
  "webex_call_enrichment_jobs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at").defaultNow().notNull(),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("webex_enrichment_org_call_idx").on(table.orgId, table.callId),
    index("webex_enrichment_status_next_idx").on(table.status, table.nextRetryAt),
  ],
);
export const insertWebexCallEnrichmentJobSchema = createInsertSchema(webexCallEnrichmentJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWebexCallEnrichmentJob = z.infer<typeof insertWebexCallEnrichmentJobSchema>;
export type WebexCallEnrichmentJob = typeof webexCallEnrichmentJobs.$inferSelect;

// Voicemail metadata + transcript cache. Audio bytes are not persisted; the
// `audioCached` flag indicates whether audio was successfully fetched at
// transcription time.
export const webexVoicemails = pgTable(
  "webex_voicemails",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
    voicemailId: text("voicemail_id").notNull(),
    callId: text("call_id"),
    callerNumber: text("caller_number"),
    callerName: text("caller_name"),
    receivedAt: timestamp("received_at"),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    read: boolean("read").notNull().default(false),
    transcript: text("transcript"),
    transcriptionStatus: text("transcription_status").notNull().default("pending"),
    audioCached: boolean("audio_cached").notNull().default(false),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("webex_voicemail_org_id_idx").on(table.orgId, table.voicemailId),
    index("webex_voicemail_user_idx").on(table.userId),
  ],
);
export const insertWebexVoicemailSchema = createInsertSchema(webexVoicemails).omit({
  id: true,
  syncedAt: true,
});
export type InsertWebexVoicemail = z.infer<typeof insertWebexVoicemailSchema>;
export type WebexVoicemail = typeof webexVoicemails.$inferSelect;

// Org-level inventory snapshots. Use a generic "kind" column so devices,
// workspaces, locations, call queues, hunt groups all share one table —
// each row is a JSONB blob keyed by (orgId, kind, externalId).
export const webexInventory = pgTable(
  "webex_inventory",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name"),
    payload: jsonb("payload"),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("webex_inventory_org_kind_id_idx").on(table.orgId, table.kind, table.externalId),
    index("webex_inventory_kind_idx").on(table.kind),
  ],
);
export const insertWebexInventorySchema = createInsertSchema(webexInventory).omit({
  id: true,
  lastSeenAt: true,
});
export type InsertWebexInventory = z.infer<typeof insertWebexInventorySchema>;
export type WebexInventory = typeof webexInventory.$inferSelect;


// ─── Carrier Intelligence: Scoring & Pricing (Task #369) ────────────────────
//
// Analytical layer rebuilt from `load_fact` + Sonar TRAC. Idempotent — every
// recompute truncates and rewrites per-org rows so we never accumulate drift.

/**
 * Per-(org, carrier) realized scorecard. Rebuilt nightly (and after every
 * load_fact import) from realized loads only — never blends Available math.
 * `equipmentType` is nullable: a row with NULL is the all-equipment rollup;
 * non-null rows are per-equipment splits. Storing both lets surfaces show
 * either dimension without re-aggregating in SQL.
 */
export const carrierScorecardFact = pgTable("carrier_scorecard_fact", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  carrierName: text("carrier_name").notNull(),
  /** Equipment split. 'ALL' is the cross-equipment rollup so unique indexes stay simple. */
  equipmentType: text("equipment_type").notNull().default("ALL"),
  windowDays: integer("window_days").notNull().default(180),
  loads: integer("loads").notNull().default(0),
  loads30d: integer("loads_30d").notNull().default(0),
  loads90d: integer("loads_90d").notNull().default(0),
  revenue: decimal("revenue", { precision: 14, scale: 2 }).notNull().default("0"),
  cost: decimal("cost", { precision: 14, scale: 2 }).notNull().default("0"),
  margin: decimal("margin", { precision: 14, scale: 2 }).notNull().default("0"),
  marginPct: decimal("margin_pct", { precision: 7, scale: 4 }).notNull().default("0"),
  avgRpm: decimal("avg_rpm", { precision: 8, scale: 4 }),
  /** Total miles across realized loads in the window (for revenue/mile sanity checks). */
  totalMiles: decimal("total_miles", { precision: 14, scale: 2 }).notNull().default("0"),
  /** Revenue per realized load. */
  revenuePerLoad: decimal("revenue_per_load", { precision: 12, scale: 2 }),
  /** On-time % derived from arrived_at_delivery <= delivery_appt_end. */
  onTimePct: decimal("on_time_pct", { precision: 5, scale: 2 }),
  /** Active load count (currently in-flight; bucket ≠ realized/cancelled). Tracked separately so it never blends into margin. */
  activeLoads: integer("active_loads").notNull().default(0),
  /** Available opportunity count this carrier could plausibly take (lanes they've run). */
  availableLoads: integer("available_loads").notNull().default(0),
  /** Carrier "do not use" signal mirrored from carriers.status for fast lookup. */
  doNotUse: boolean("do_not_use").notNull().default(false),
  /** 0–100 composite score from realized history (volume × margin × recency). */
  performanceScore: integer("performance_score").notNull().default(0),
  /** Tier derived from performanceScore: A / B / C / new. */
  tier: text("tier").notNull().default("new"),
  /** Days since the carrier last ran a realized load for this org. */
  daysSinceLastLoad: integer("days_since_last_load"),
  lastLoadDate: text("last_load_date"),
  /** When this scorecard row was rebuilt. */
  computedAt: timestamp("computed_at").defaultNow().notNull(),
}, (t) => ({
  orgCarrierEqUq: uniqueIndex("carrier_scorecard_org_carrier_eq_uq").on(t.orgId, t.carrierName, t.equipmentType),
  orgScoreIdx: index("carrier_scorecard_org_score_idx").on(t.orgId, t.performanceScore),
}));
export const insertCarrierScorecardFactSchema = createInsertSchema(carrierScorecardFact)
  .omit({ id: true, computedAt: true });
export type InsertCarrierScorecardFact = z.infer<typeof insertCarrierScorecardFactSchema>;
export type CarrierScorecardFact = typeof carrierScorecardFact.$inferSelect;

/**
 * Per-(origin_state, destination_state, equipment_type) lane buy/sell rate
 * rollups built from realized loads. Powers the "history" leg of the pricing
 * blend so we don't have to hit Sonar for every quote.
 *
 * Rolling at state granularity keeps cardinality low (50 × 50 × ~6 equipment
 * types = ~15k rows max per org) while still giving meaningful comps.
 */
export const laneRateHistory = pgTable("lane_rate_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  originState: text("origin_state").notNull(),
  destinationState: text("destination_state").notNull(),
  equipmentType: text("equipment_type").notNull().default("ALL"),
  /** Customer dimension for (lane, customer) variant. '__ANY__' = lane-level rollup. */
  customerName: text("customer_name").notNull().default("__ANY__"),
  windowDays: integer("window_days").notNull().default(180),
  loads: integer("loads").notNull().default(0),
  loads30d: integer("loads_30d").notNull().default(0),
  loads60d: integer("loads_60d").notNull().default(0),
  loads90d: integer("loads_90d").notNull().default(0),
  avgRevenuePerMile: decimal("avg_revenue_per_mile", { precision: 8, scale: 4 }),
  avgCostPerMile: decimal("avg_cost_per_mile", { precision: 8, scale: 4 }),
  avgMarginPct: decimal("avg_margin_pct", { precision: 7, scale: 4 }),
  medianCostPerMile: decimal("median_cost_per_mile", { precision: 8, scale: 4 }),
  minCostPerMile: decimal("min_cost_per_mile", { precision: 8, scale: 4 }),
  maxCostPerMile: decimal("max_cost_per_mile", { precision: 8, scale: 4 }),
  p25CostPerMile: decimal("p25_cost_per_mile", { precision: 8, scale: 4 }),
  p75CostPerMile: decimal("p75_cost_per_mile", { precision: 8, scale: 4 }),
  /** 30/60/90-day trend buckets — average cost per mile in each window. */
  avgCost30d: decimal("avg_cost_30d", { precision: 8, scale: 4 }),
  avgCost60d: decimal("avg_cost_60d", { precision: 8, scale: 4 }),
  avgCost90d: decimal("avg_cost_90d", { precision: 8, scale: 4 }),
  uniqueCarriers: integer("unique_carriers").notNull().default(0),
  computedAt: timestamp("computed_at").defaultNow().notNull(),
}, (t) => ({
  laneUq: uniqueIndex("lane_rate_history_lane_uq").on(t.orgId, t.originState, t.destinationState, t.equipmentType, t.customerName),
  orgLoadsIdx: index("lane_rate_history_org_loads_idx").on(t.orgId, t.loads),
}));
export const insertLaneRateHistorySchema = createInsertSchema(laneRateHistory)
  .omit({ id: true, computedAt: true });
export type InsertLaneRateHistory = z.infer<typeof insertLaneRateHistorySchema>;
export type LaneRateHistory = typeof laneRateHistory.$inferSelect;

/**
 * Per-(carrier, lane) fit snapshot — generalized from carrierRankingService
 * so any caller (recommendation engine, lane plan UI, NBA) can ask
 * "how good a fit is carrier X for lane Y" without re-running a 1900-line
 * pipeline. Computed on-demand and cached; refreshed when the underlying
 * scorecard or lane history changes.
 */
export const carrierLaneFit = pgTable("carrier_lane_fit", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  carrierName: text("carrier_name").notNull(),
  originState: text("origin_state").notNull(),
  destinationState: text("destination_state").notNull(),
  equipmentType: text("equipment_type").notNull().default("ALL"),
  /** 0–100 composite fit score. */
  fitScore: integer("fit_score").notNull().default(0),
  /** Sub-scores stored for debugging + UI breakdown. */
  exactLaneRuns: integer("exact_lane_runs").notNull().default(0),
  nearbyRuns: integer("nearby_runs").notNull().default(0),
  equipmentMatch: boolean("equipment_match").notNull().default(false),
  regionMatch: boolean("region_match").notNull().default(false),
  /** "exact" | "nearby" | "region" | "none" — best evidence tier found. */
  evidenceTier: text("evidence_tier").notNull().default("none"),
  /** Human-readable reason string for surfaces. */
  reason: text("reason"),
  computedAt: timestamp("computed_at").defaultNow().notNull(),
}, (t) => ({
  fitUq: uniqueIndex("carrier_lane_fit_uq").on(t.orgId, t.carrierName, t.originState, t.destinationState, t.equipmentType),
  orgFitIdx: index("carrier_lane_fit_org_fit_idx").on(t.orgId, t.fitScore),
}));
export const insertCarrierLaneFitSchema = createInsertSchema(carrierLaneFit)
  .omit({ id: true, computedAt: true });
export type InsertCarrierLaneFit = z.infer<typeof insertCarrierLaneFitSchema>;
export type CarrierLaneFit = typeof carrierLaneFit.$inferSelect;

/**
 * Recommendation snapshot per Available load. One row per (loadFactId, carrier
 * candidate). Rebuilt whenever the recommendation engine runs for a load —
 * keyed by load_fact_id so deletions cascade with the source load.
 */
export const carrierRecommendation = pgTable("carrier_recommendation", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  loadFactId: varchar("load_fact_id").notNull().references(() => loadFact.id, { onDelete: "cascade" }),
  rank: integer("rank").notNull(),
  carrierName: text("carrier_name").notNull(),
  /** 0–100 combined ranking score (fit × performance × pricing-fit). */
  totalScore: integer("total_score").notNull().default(0),
  fitScore: integer("fit_score").notNull().default(0),
  performanceScore: integer("performance_score").notNull().default(0),
  /** Suggested target buy rate $/mi from blended pricing engine. */
  targetBuyRpm: decimal("target_buy_rpm", { precision: 8, scale: 4 }),
  /** Confidence band on the buy rate: high | medium | low. */
  pricingConfidence: text("pricing_confidence").notNull().default("low"),
  /** Last date this carrier ran a load for this org (any lane). */
  lastUsedDate: text("last_used_date"),
  /** Carrier's average historical cost-per-mile across realized loads (any lane). */
  avgHistoricalBuyRpm: decimal("avg_historical_buy_rpm", { precision: 8, scale: 4 }),
  /** Expected margin band (low/high %) based on historical performance + suggested buy. */
  expectedMarginLowPct: decimal("expected_margin_low_pct", { precision: 5, scale: 2 }),
  expectedMarginHighPct: decimal("expected_margin_high_pct", { precision: 5, scale: 2 }),
  /** Coverage urgency: red | yellow | green. Driven by pickup proximity + lane scarcity. */
  coverageUrgency: text("coverage_urgency").notNull().default("green"),
  reason: text("reason"),
  /** Snapshot of the inputs used so the recommendation is reproducible. Includes
   *  the sparse-signal fallback trace (nearby-lane → state-pair → trailer benchmark). */
  rationale: jsonb("rationale"),
  computedAt: timestamp("computed_at").defaultNow().notNull(),
}, (t) => ({
  loadRankUq: uniqueIndex("carrier_recommendation_load_rank_uq").on(t.loadFactId, t.rank),
  orgLoadIdx: index("carrier_recommendation_org_load_idx").on(t.orgId, t.loadFactId),
}));
export const insertCarrierRecommendationSchema = createInsertSchema(carrierRecommendation)
  .omit({ id: true, computedAt: true });
export type InsertCarrierRecommendation = z.infer<typeof insertCarrierRecommendationSchema>;
export type CarrierRecommendation = typeof carrierRecommendation.$inferSelect;

// =====================================================================
// Account-level collaborators (manual visibility sharing)
// =====================================================================
// A row here grants `userId` read+act access to all freight/lanes/etc.
// for `companyId`. Sharing is added by the account owner, that owner's
// manager, or org admins. Mutation auth on individual records still
// runs through the existing owner/delegated checks; collaborators get
// the same surface as the owner aside from reassignment/deletion.
export const companyCollaborators = pgTable("company_collaborators", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  addedByUserId: varchar("added_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uq: uniqueIndex("company_collaborators_company_user_uq").on(t.companyId, t.userId),
  userIdx: index("company_collaborators_user_idx").on(t.userId),
  orgIdx: index("company_collaborators_org_idx").on(t.organizationId),
}));
export const insertCompanyCollaboratorSchema = createInsertSchema(companyCollaborators).omit({
  id: true,
  createdAt: true,
});
export type InsertCompanyCollaborator = z.infer<typeof insertCompanyCollaboratorSchema>;
export type CompanyCollaborator = typeof companyCollaborators.$inferSelect;

// =====================================================================
// Customer Quotes — internal visibility into quote requests/outcomes.
// =====================================================================
export const QUOTE_OUTCOME_STATUSES = [
  "pending",
  "won",
  "lost_price",
  "lost_service",
  "lost_timing",
  "lost_incumbent",
  "no_response",
  "expired",
  "won_low_margin",
] as const;
export type QuoteOutcomeStatus = typeof QUOTE_OUTCOME_STATUSES[number];

export const QUOTE_SOURCES = ["email", "tms", "crm", "manual", "import"] as const;

// Task #597 — `partyType` distinguishes shipper customers (default) from
// carrier rows that leak in via email/TMS ingestion (e.g. carriers cold-emailing
// for rate quotes get auto-created as a quote_customers row even though they
// aren't actual customers). The dashboard hides carrier rows by default and
// reps can flip the classification per-row from the drawer; manual flips set
// `partyTypeManual=true` so background classifiers never overwrite the rep's call.
export const QUOTE_PARTY_TYPES = ["customer", "carrier", "unknown"] as const;
export type QuotePartyType = typeof QUOTE_PARTY_TYPES[number];

export const quoteCustomers = pgTable("quote_customers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  segment: text("segment"),
  notes: text("notes"),
  partyType: text("party_type").notNull().default("unknown"),
  partyTypeManual: boolean("party_type_manual").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertQuoteCustomerSchema = createInsertSchema(quoteCustomers).omit({ id: true, createdAt: true });
export type InsertQuoteCustomer = z.infer<typeof insertQuoteCustomerSchema>;
export type QuoteCustomer = typeof quoteCustomers.$inferSelect;

export const quoteReps = pgTable("quote_reps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  email: text("email"),
});
export const insertQuoteRepSchema = createInsertSchema(quoteReps).omit({ id: true });
export type InsertQuoteRep = z.infer<typeof insertQuoteRepSchema>;
export type QuoteRep = typeof quoteReps.$inferSelect;

export const quoteCarriers = pgTable("quote_carriers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mcNumber: text("mc_number"),
});
export const insertQuoteCarrierSchema = createInsertSchema(quoteCarriers).omit({ id: true });
export type InsertQuoteCarrier = z.infer<typeof insertQuoteCarrierSchema>;
export type QuoteCarrier = typeof quoteCarriers.$inferSelect;

export const quoteLaneGroups = pgTable("quote_lane_groups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  originRegion: text("origin_region"),
  destRegion: text("dest_region"),
});
export const insertQuoteLaneGroupSchema = createInsertSchema(quoteLaneGroups).omit({ id: true });
export type InsertQuoteLaneGroup = z.infer<typeof insertQuoteLaneGroupSchema>;
export type QuoteLaneGroup = typeof quoteLaneGroups.$inferSelect;

export const quoteOutcomeReasons = pgTable("quote_outcome_reasons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  label: text("label").notNull(),
  category: text("category").notNull(), // won | lost | no_response | expired
});
export const insertQuoteOutcomeReasonSchema = createInsertSchema(quoteOutcomeReasons).omit({ id: true });
export type InsertQuoteOutcomeReason = z.infer<typeof insertQuoteOutcomeReasonSchema>;
export type QuoteOutcomeReason = typeof quoteOutcomeReasons.$inferSelect;

export const quoteOpportunities = pgTable("quote_opportunities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  customerId: varchar("customer_id").notNull().references(() => quoteCustomers.id, { onDelete: "cascade" }),
  repId: varchar("rep_id").references(() => quoteReps.id, { onDelete: "set null" }),
  laneGroupId: varchar("lane_group_id").references(() => quoteLaneGroups.id, { onDelete: "set null" }),
  carrierId: varchar("carrier_id").references(() => quoteCarriers.id, { onDelete: "set null" }),
  outcomeReasonId: varchar("outcome_reason_id").references(() => quoteOutcomeReasons.id, { onDelete: "set null" }),
  requestDate: timestamp("request_date").notNull(),
  originCity: text("origin_city").notNull(),
  originState: text("origin_state").notNull(),
  destCity: text("dest_city").notNull(),
  destState: text("dest_state").notNull(),
  equipment: text("equipment").notNull(),
  quotedAmount: decimal("quoted_amount", { precision: 12, scale: 2 }),
  validThrough: timestamp("valid_through"),
  outcomeStatus: text("outcome_status").notNull().default("pending"),
  carrierPaid: decimal("carrier_paid", { precision: 12, scale: 2 }),
  responseTimeHours: decimal("response_time_hours", { precision: 8, scale: 2 }),
  source: text("source").notNull().default("email"),
  sourceReference: text("source_reference"),
  notes: text("notes"),
  score: decimal("score", { precision: 6, scale: 2 }),
  sonarBenchmark: decimal("sonar_benchmark", { precision: 12, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgIdx: index("quote_opportunities_org_idx").on(t.organizationId),
  customerIdx: index("quote_opportunities_customer_idx").on(t.customerId),
  reqDateIdx: index("quote_opportunities_request_date_idx").on(t.requestDate),
}));
export const insertQuoteOpportunitySchema = createInsertSchema(quoteOpportunities).omit({ id: true, createdAt: true });
export type InsertQuoteOpportunity = z.infer<typeof insertQuoteOpportunitySchema>;
export type QuoteOpportunity = typeof quoteOpportunities.$inferSelect;

// Spot Quote Search — Quote Builder card payload (Task #516).
// Derived from the canonical quote-opportunity insert schema so the
// client form and the server route share a single contract.
export const spotQuoteCreateSchema = insertQuoteOpportunitySchema
  .pick({ customerId: true, equipment: true, notes: true })
  .extend({
    customerId: z.string().min(1, "Pick a customer"),
    equipment: z.string().min(1).max(40),
    pickupCity: z.string().min(1).max(80),
    pickupState: z.string().min(1).max(8),
    deliveryCity: z.string().min(1).max(80),
    deliveryState: z.string().min(1).max(8),
    quotedAmount: z.number({ invalid_type_error: "Enter a number" }).finite().min(1, "Required").max(1_000_000),
    estimatedCost: z.number({ invalid_type_error: "Enter a number" }).finite().min(0).max(1_000_000).optional(),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional().or(z.literal("")),
    notes: z.string().max(2000).optional(),
  });
export type SpotQuoteCreateInput = z.infer<typeof spotQuoteCreateSchema>;

export const quoteEvents = pgTable("quote_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  quoteId: varchar("quote_id").notNull().references(() => quoteOpportunities.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  occurredAt: timestamp("occurred_at").notNull(),
  actor: text("actor"),
  payload: jsonb("payload"),
}, (t) => ({
  quoteIdx: index("quote_events_quote_idx").on(t.quoteId),
}));
export const insertQuoteEventSchema = createInsertSchema(quoteEvents).omit({ id: true });
export type InsertQuoteEvent = z.infer<typeof insertQuoteEventSchema>;
export type QuoteEvent = typeof quoteEvents.$inferSelect;

export const quoteSavedViews = pgTable("quote_saved_views", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  filters: jsonb("filters").notNull().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertQuoteSavedViewSchema = createInsertSchema(quoteSavedViews).omit({ id: true, createdAt: true });
export type InsertQuoteSavedView = z.infer<typeof insertQuoteSavedViewSchema>;
export type QuoteSavedView = typeof quoteSavedViews.$inferSelect;

export const quotePatternAlerts = pgTable("quote_pattern_alerts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  customerId: varchar("customer_id").notNull().references(() => quoteCustomers.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"), // active | resolved
  summary: text("summary").notNull(),
  axes: jsonb("axes").notNull().default({}),
  detectedAt: timestamp("detected_at").defaultNow().notNull(),
  lastShiftedAt: timestamp("last_shifted_at").defaultNow().notNull(),
  normalizedSince: timestamp("normalized_since"),
  resolvedAt: timestamp("resolved_at"),
}, (t) => ({
  orgIdx: index("quote_pattern_alerts_org_idx").on(t.organizationId),
  custIdx: index("quote_pattern_alerts_customer_idx").on(t.customerId),
  statusIdx: index("quote_pattern_alerts_status_idx").on(t.status),
}));
export const insertQuotePatternAlertSchema = createInsertSchema(quotePatternAlerts).omit({ id: true, detectedAt: true });
export type InsertQuotePatternAlert = z.infer<typeof insertQuotePatternAlertSchema>;
export type QuotePatternAlert = typeof quotePatternAlerts.$inferSelect;

// Per-org pricing settings — currently a per-equipment $/mile floor used
// by the Pricing Recommendation card to flag tiers that drop below the
// rate the org will accept. JSONB shape: { [equipment: string]: number }
// where value is the minimum acceptable RPM. Empty object = no floors.
export const quotePricingSettings = pgTable("quote_pricing_settings", {
  organizationId: varchar("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  marginFloorsRpm: jsonb("margin_floors_rpm").notNull().$type<Record<string, number>>().default({}),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedById: varchar("updated_by_id").references(() => users.id, { onDelete: "set null" }),
});
export const insertQuotePricingSettingsSchema = createInsertSchema(quotePricingSettings).omit({ updatedAt: true });
export type InsertQuotePricingSettings = z.infer<typeof insertQuotePricingSettingsSchema>;
export type QuotePricingSettings = typeof quotePricingSettings.$inferSelect;

// ─── Conversation Thread Smart Pane (Task #534) ──────────────────────────────
// Three sibling tables that power the right-hand detail pane on the
// Conversations page:
//   1. conversation_thread_summaries — short AI summary cached per thread,
//      invalidated when new messages arrive (via contentHash).
//   2. conversation_thread_suggestions — current suggested next action plus
//      the rep's dismiss / "wrong suggestion" feedback so we can learn.
//   3. conversation_thread_events — append-only audit log of every meaningful
//      action on a thread (assignments, state changes, AI drafts, captures…).

export const conversationThreadSummaries = pgTable(
  "conversation_thread_summaries",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    // Outlook conversationId — matches email_messages.thread_id /
    // email_conversation_threads.thread_id. Not FK'd because thread rows
    // can be archived/deleted independently of cached summaries.
    threadId: text("thread_id").notNull(),
    // Plain-text 2–3 line summary surfaced at the top of the detail pane.
    summary: text("summary").notNull(),
    // Hash over the ordered list of (messageId, providerSentAt) so a new
    // message on the thread invalidates the cache automatically. The
    // service rebuilds the summary on the next read when the live hash
    // doesn't match.
    contentHash: text("content_hash").notNull(),
    // Bookkeeping so the UI can show "based on N messages" when useful and
    // so the regenerate button can show the staleness reason.
    messageCount: integer("message_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at"),
    model: text("model"),
    generatedAt: timestamp("generated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("conversation_thread_summaries_org_thread_uq").on(table.orgId, table.threadId),
  ],
);
export const insertConversationThreadSummarySchema = createInsertSchema(conversationThreadSummaries).omit({
  id: true,
  generatedAt: true,
});
export type InsertConversationThreadSummary = z.infer<typeof insertConversationThreadSummarySchema>;
export type ConversationThreadSummary = typeof conversationThreadSummaries.$inferSelect;

export const conversationThreadSuggestions = pgTable(
  "conversation_thread_suggestions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    // The suggested action's machine name — drives the one-click handler
    // on the frontend. Examples:
    //   draft_reply | quote_request_reply | mark_resolved |
    //   await_response | none
    actionType: text("action_type").notNull(),
    // Human label rendered on the primary button ("Send quote", etc.).
    actionLabel: text("action_label").notNull(),
    // 1-line plain-English reason ("They're asking for a rate on PHX→DAL").
    actionReason: text("action_reason").notNull(),
    // Free-form params consumed by the handler (e.g. targetMessageId,
    // suggested play type for the draft modal).
    actionParams: jsonb("action_params").default({}),
    contentHash: text("content_hash").notNull(),
    generatedAt: timestamp("generated_at").defaultNow().notNull(),
    // Dismissal / feedback so we can analyse suggestion accuracy later
    // without invalidating the cached suggestion. When dismissedAt is set
    // the UI hides the card until the next message arrives (new hash).
    dismissedAt: timestamp("dismissed_at"),
    dismissedByUserId: varchar("dismissed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    feedbackKind: text("feedback_kind"), // 'wrong' | 'good' | null
    feedbackNotes: text("feedback_notes"),
    feedbackAt: timestamp("feedback_at"),
    feedbackByUserId: varchar("feedback_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("conversation_thread_suggestions_org_thread_uq").on(table.orgId, table.threadId),
  ],
);
export const insertConversationThreadSuggestionSchema = createInsertSchema(conversationThreadSuggestions).omit({
  id: true,
  generatedAt: true,
});
export type InsertConversationThreadSuggestion = z.infer<typeof insertConversationThreadSuggestionSchema>;
export type ConversationThreadSuggestion = typeof conversationThreadSuggestions.$inferSelect;

export const conversationThreadEvents = pgTable(
  "conversation_thread_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    // The user who performed the action. Null when the actor is the
    // platform itself (scheduled capture-audit recovery, automated AI
    // draft if we ever fire one autonomously, etc.). The frontend renders
    // "System" when null.
    actorUserId: varchar("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name"), // Cached so the timeline survives user deletes.
    // Discriminator. Stable values used by the UI to choose icons:
    //   assigned | reassigned | unassigned |
    //   resolved | reopened | archived | unarchived |
    //   priority_changed |
    //   ai_drafted | ai_corrected | human_sent |
    //   capture_audit_recovery
    eventType: text("event_type").notNull(),
    // Short prose surfaced verbatim ("Reassigned to Casey Lin", etc.).
    description: text("description").notNull(),
    // Free-form payload. Receivers should treat unknown keys as opaque.
    details: jsonb("details").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("conversation_thread_events_org_thread_idx").on(table.orgId, table.threadId, table.createdAt),
  ],
);
export const insertConversationThreadEventSchema = createInsertSchema(conversationThreadEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertConversationThreadEvent = z.infer<typeof insertConversationThreadEventSchema>;
export type ConversationThreadEvent = typeof conversationThreadEvents.$inferSelect;

// ─── Suggestion Feedback Learning (Task #552) ────────────────────────────────
// Rolling per-(org, account, action_type) summary of how reps rated the
// thread suggestions we produced. Refreshed nightly from
// conversation_thread_suggestions and incrementally updated whenever a rep
// dismisses or rates a suggestion. The suggestion service consults this
// table at suggest-time to avoid re-recommending actions a rep already told
// us were wrong for the same account in the recent past.
//
// We use the sentinel value '__org__' for accountId when the underlying
// thread isn't linked to a company, so the unique index can stay simple
// (PostgreSQL treats NULLs as distinct, which would let stats fragment).
export const conversationSuggestionFeedbackStats = pgTable(
  "conversation_suggestion_feedback_stats",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    // Linked company id from email_conversation_threads.linked_account_id,
    // or '__org__' when the thread has no account link. Not an FK because
    // of the sentinel value.
    accountId: varchar("account_id").notNull(),
    // Suggestion machine action (draft_reply, quote_request_reply, etc.).
    actionType: text("action_type").notNull(),
    // Counts over the rolling lookback window (default 14 days).
    wrongCount: integer("wrong_count").notNull().default(0),
    goodCount: integer("good_count").notNull().default(0),
    dismissedCount: integer("dismissed_count").notNull().default(0),
    // Up to ~5 recent actionReason strings from "wrong" feedback. Fed into
    // the AI refinement prompt as "avoid suggestions like these for this
    // account" so future reasoning steers clear of the same framing.
    recentWrongReasons: jsonb("recent_wrong_reasons").$type<string[]>().default([]),
    lastWrongAt: timestamp("last_wrong_at"),
    lastFeedbackAt: timestamp("last_feedback_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("conv_sug_fb_stats_org_acct_action_uq").on(table.orgId, table.accountId, table.actionType),
  ],
);
export const insertConversationSuggestionFeedbackStatsSchema = createInsertSchema(conversationSuggestionFeedbackStats).omit({
  id: true,
  updatedAt: true,
});
export type InsertConversationSuggestionFeedbackStats = z.infer<typeof insertConversationSuggestionFeedbackStatsSchema>;
export type ConversationSuggestionFeedbackStats = typeof conversationSuggestionFeedbackStats.$inferSelect;

// ── Email Response Time SLA settings (Task #602) ──────────────────────────────
// Per-org configurable response-time SLA targets shown on the Response Time
// tab. Defaults: 1h / 4h / 24h business hours. Stored as an array of
// { label, ms, businessHours } so admins can rename / add buckets without a
// schema change. One row per organization.
export const emailResponseTimeSlaSettings = pgTable(
  "email_response_time_sla_settings",
  {
    organizationId: varchar("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
    targets: jsonb("targets").$type<Array<{ label: string; ms: number; businessHours: boolean }>>().notNull().default([]),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
);
export const insertEmailResponseTimeSlaSettingsSchema = createInsertSchema(emailResponseTimeSlaSettings).omit({
  updatedAt: true,
});
export type InsertEmailResponseTimeSlaSettings = z.infer<typeof insertEmailResponseTimeSlaSettingsSchema>;
export type EmailResponseTimeSlaSettings = typeof emailResponseTimeSlaSettings.$inferSelect;

// ── Email Reply Latency Regression settings (Task #611) ───────────────────────
// Per-org configurable knobs for the weekly regression detector that compares
// each rep's most recent full ISO-week p90 reply latency against the trailing
// baseline and fires an in-app coaching nudge when it gets noticeably worse.
//
// Defaults: 4-week trailing baseline, p90 must regress by ≥ 25%, and the rep
// must have at least 10 replies in the most recent week (avoids screaming at
// reps with three lucky-or-unlucky responses). Disabled-by-default flag lets
// orgs trial the feature in a single mailbox before turning it on globally.
export const emailReplyLatencyRegressionSettings = pgTable(
  "email_reply_latency_regression_settings",
  {
    organizationId: varchar("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    lookbackWeeks: integer("lookback_weeks").notNull().default(4),
    p90RegressionPct: integer("p90_regression_pct").notNull().default(25),
    minReplies: integer("min_replies").notNull().default(10),
    businessHours: boolean("business_hours").notNull().default(true),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
);
export const insertEmailReplyLatencyRegressionSettingsSchema = createInsertSchema(emailReplyLatencyRegressionSettings).omit({
  updatedAt: true,
});
export type InsertEmailReplyLatencyRegressionSettings = z.infer<typeof insertEmailReplyLatencyRegressionSettingsSchema>;
export type EmailReplyLatencyRegressionSettings = typeof emailReplyLatencyRegressionSettings.$inferSelect;

// ── Quote Sender Mappings (Customer Quotes #3) ────────────────────────────────
// Sender-domain learning. When a rep manually moves a quote out of the
// "Unknown — needs review" bucket into a real customer, we record the
// sender's domain (or, for free-mail senders, the full sender email) so
// the next inbound email from that sender auto-classifies. Mappings are
// org-scoped. EXACTLY ONE of (sender_email, sender_domain) is set per row:
//   - business-domain sender  → sender_domain = "acme-logistics.com"
//   - free-mail sender        → sender_email  = "joe@gmail.com"
// The DB enforces the one-of constraint via a CHECK and the uniqueness via
// two partial unique indexes (one per nullable column). Lookups at ingest
// prefer sender_email matches over sender_domain matches.
export const QUOTE_SENDER_MAPPING_SOURCES = ["manual", "auto"] as const;
export type QuoteSenderMappingSource = typeof QUOTE_SENDER_MAPPING_SOURCES[number];

export const quoteSenderMappings = pgTable(
  "quote_sender_mappings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    senderDomain: text("sender_domain"),
    senderEmail: text("sender_email"),
    customerId: varchar("customer_id").notNull().references(() => quoteCustomers.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("manual"),
    sampleCount: integer("sample_count").notNull().default(1),
    lastUsedAt: timestamp("last_used_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index("quote_sender_mappings_org_idx").on(t.organizationId),
    customerIdx: index("quote_sender_mappings_customer_idx").on(t.customerId),
  }),
);
export const insertQuoteSenderMappingSchema = createInsertSchema(quoteSenderMappings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertQuoteSenderMapping = z.infer<typeof insertQuoteSenderMappingSchema>;
export type QuoteSenderMapping = typeof quoteSenderMappings.$inferSelect;
