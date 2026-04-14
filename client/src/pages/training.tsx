import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/hooks/use-auth";
import { useTour } from "@/hooks/use-tour";
import {
  LayoutGrid, Network, Users, BarChart3, History, Zap, BookOpen,
  MessagesSquare, ListTodo, TrendingUp, Target, Plane, Trophy,
  ClipboardList, Search, ChevronRight, CheckCircle2, Circle,
  PhoneCall, DollarSign, MapPin, Building2, UserCircle, GitBranch,
  FileSpreadsheet, Award, Route, Flame, Lightbulb, Megaphone,
  UserCog, ArrowRightLeft, GraduationCap, ChevronDown, ChevronUp,
  ExternalLink, Star, Info, Bot, Calculator, HeartPulse, Truck,
  FileBarChart2, BadgeCheck, Gauge, BellRing, Shield, PlayCircle,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// TRAINING MODULE DATA
// To add a new feature: append a new object to the MODULES array below.
// Required fields: id, category, title, icon, description, capabilities
// Optional: roles (restrict by role), path (link to feature), tips, isNew
// ─────────────────────────────────────────────────────────────────────────────

type TrainingModule = {
  id: string;
  category: string;
  title: string;
  icon: React.ElementType;
  description: string;
  capabilities: string[];
  roles?: string[];
  path?: string;
  tips?: string[];
  isNew?: boolean;
};

const MODULES: TrainingModule[] = [
  // ── Getting Started ────────────────────────────────────────────────────────
  {
    id: "overview",
    category: "Getting Started",
    title: "Platform Overview",
    icon: GraduationCap,
    description:
      "Freight DNA is Value Truck's internal CRM built specifically for transportation brokerage sales. It centralizes account management, contact org charts, RFP tracking, lane analysis, team performance, and daily collaboration tools in one place.",
    capabilities: [
      "Replace scattered spreadsheets with a single source of truth",
      "Build and visualize org charts for every customer account",
      "Track every touchpoint, task, and follow-up across your book of business",
      "Analyze freight lanes, RFP data, and financial performance",
      "Collaborate with your team through shared feeds, 1:1 topics, and goals",
    ],
    tips: [
      "Bookmark the platform URL — you'll use it every day",
      "Your role controls which sections you can see; ask an admin to adjust if needed",
      "Dark mode is available via the toggle at the bottom of the sidebar",
    ],
  },
  {
    id: "navigation",
    category: "Getting Started",
    title: "Navigation & Sidebar",
    icon: LayoutGrid,
    description:
      "The left sidebar is your main navigation hub. It adapts based on your role — admins and directors see additional team management sections. The sidebar collapses on mobile for a clean mobile experience.",
    capabilities: [
      "Access all major sections from the left sidebar",
      "Active page is highlighted so you always know where you are",
      "External links (Playbook, Buckets) open in a new tab",
      "Your name, role, and logout button appear at the bottom",
    ],
    tips: [
      "The sidebar label changes from 'Admin' to 'Team' depending on your role",
      "If a menu item is missing, your role may not have access — contact an admin",
    ],
    path: "/",
  },
  {
    id: "search",
    category: "Getting Started",
    title: "Global Search",
    icon: Search,
    description:
      "The global search bar (top of the dashboard) lets you instantly find any company account or user by name. Results are debounced and update as you type — no Enter key required.",
    capabilities: [
      "Search across all company accounts in real time",
      "Find any user/rep on the team",
      "Click a result to jump directly to that company or rep profile",
    ],
    tips: [
      "Search is case-insensitive and matches partial names",
      "Results are limited to 10 per category — type more characters to narrow down",
    ],
    path: "/",
  },
  {
    id: "dashboard",
    category: "Getting Started",
    title: "Your Dashboard",
    icon: LayoutGrid,
    description:
      "The dashboard is your daily home base. It shows your KPI summary, tasks, cold contacts needing attention, team callouts, 1:1 discussion topics, goal alerts, and PTO coverage assignments — all in one view.",
    capabilities: [
      "KPI tiles: total accounts, contacts, regions, freight spend",
      "My Tasks portlet: your open tasks with due date badges",
      "Contacts Needing Attention: contacts untouched for 30+ days",
      "Callouts & Trends Feed: company-wide posts and replies",
      "1:1 Topics portlet: pending discussion items with your manager or reports",
      "PTO Coverage portlet: accounts you're covering when a teammate is out",
      "Goal alert: notifies NAMs when monthly goals are unset",
    ],
    tips: [
      "The dashboard is role-aware — admins and NAMs see additional portlets",
      "Click any contact in 'Needs Attention' to open their full detail sheet",
    ],
    path: "/",
  },

  // ── Account Management ─────────────────────────────────────────────────────
  {
    id: "customers",
    category: "Account Management",
    title: "Customer List",
    icon: Building2,
    description:
      "The Customers page lists all company accounts in the system. You can filter, search, and navigate to any account. Admins and directors see all accounts; AMs see accounts assigned to them and their team.",
    capabilities: [
      "Browse all active company accounts",
      "Search by company name inline",
      "See each account's assigned rep and industry",
      "Click any account to open its full detail profile",
      "Archived accounts are hidden by default",
    ],
    tips: [
      "Use the search bar at the top to filter quickly rather than scrolling",
      "Archived accounts can be viewed by admins in User Management",
    ],
    path: "/customers",
  },
  {
    id: "company-detail",
    category: "Account Management",
    title: "Company Profile",
    icon: Network,
    description:
      "The company detail page is the central hub for a single account. It shows all contacts, the org chart, RFPs, awards, lanes, financial performance, touchpoints, tasks, callouts, and the activity timeline — all in tabbed sections.",
    capabilities: [
      "View and edit company details (name, industry, website, notes)",
      "See total loads, spot loads, and margin from financial data",
      "Access all contacts and their reporting structure",
      "View historical touchpoints and log new ones",
      "See and manage open tasks for this account",
      "View RFPs and awards associated with the company",
      "Customer portal credentials (URL, username, password) stored securely",
      "Full activity timeline: contacts added, touchpoints, tasks, RFPs",
    ],
    tips: [
      "Pin the most important contacts by giving them 'Key Contact' status",
      "The financial tiles only show if load data has been uploaded in Financials",
    ],
    path: "/customers",
  },
  {
    id: "contacts",
    category: "Account Management",
    title: "Contact Management",
    icon: UserCircle,
    description:
      "Each company account holds its own contact list. You can add, edit, and track every person at the customer — their title, email, phone, relationship level, lanes, regions, freight spend, and more.",
    capabilities: [
      "Add contacts with full transportation-specific detail fields",
      "Track relationship level (1st, 2nd, 3rd base)",
      "Store lanes, regions covered, freight spend, and spot bidding process",
      "Assign a next steps field for follow-up planning",
      "Set reporting structure (who this contact reports to)",
      "Log and view all touchpoints for each contact",
      "See last-touch recency badge (green/amber/red) at a glance",
    ],
    tips: [
      "Always fill in 'Next Steps' — it's your future self's to-do note",
      "Freight spend data helps prioritize which contacts to focus on",
    ],
    path: "/customers",
  },
  {
    id: "orgchart",
    category: "Account Management",
    title: "Org Chart",
    icon: GitBranch,
    description:
      "The Org Chart tab on a company profile visualizes the reporting hierarchy among all contacts at that account. Each node shows recency of touchpoints via a color-coded dot, letting you spot neglected relationships instantly.",
    capabilities: [
      "Visual tree of all contacts and who they report to",
      "Color-coded recency dot per contact (green = touched recently, red = overdue)",
      "Click any contact node to open their full detail sheet",
      "Quickly identify gaps in coverage or relationships you haven't touched",
    ],
    tips: [
      "Set 'Reports To' on each contact when creating them to build the hierarchy",
      "Red dots on the org chart = contacts needing immediate attention",
    ],
    path: "/customers",
  },
  {
    id: "touchpoints",
    category: "Account Management",
    title: "Touchpoints",
    icon: PhoneCall,
    description:
      "Touchpoints log every interaction you have with a contact — calls, emails, texts, or site visits. They power the recency badges on contact cards and the org chart, and feed the 'Contacts Needing Attention' dashboard portlet.",
    capabilities: [
      "Log calls, emails, texts, and site visits with date and optional note",
      "Attach files to touchpoints (PDFs, images, docs)",
      "View full touchpoint history per contact in their detail sheet",
      "Dashboard shows contacts untouched for 30+ days",
      "Contact cards show last-touch recency badge and weekly count",
      "Org chart nodes show color-coded recency dot",
    ],
    tips: [
      "Log every interaction — even a short voicemail. Consistency builds your history",
      "Weekly touchpoint counts help managers see activity at a glance",
    ],
    path: "/customers",
  },

  // ── RFP & Awards ──────────────────────────────────────────────────────────
  {
    id: "rfp",
    category: "RFP & Awards",
    title: "RFP Management",
    icon: FileSpreadsheet,
    description:
      "The RFP module lets you track active Requests for Proposal for any account. Upload an Excel file to auto-extract high-volume lanes, analyze lane patterns, and identify facility coverage gaps. Status tracking moves RFPs through the pipeline.",
    capabilities: [
      "Create RFPs linked to a company with status tracking (Active, Awarded, Lost, Pending)",
      "Upload Excel lane data to auto-extract top lanes by volume",
      "Lane Pattern Analysis: top corridors, shipping/receiving hubs, state-to-state volume",
      "Facility Coverage Gap Analysis: identifies uncovered facilities vs existing contacts",
      "Assign rep ownership to each high-volume lane",
      "View all RFPs across all accounts in one list",
    ],
    tips: [
      "Upload the raw lane file as-is — the system handles the parsing",
      "Use the Gap Analysis tab to find facilities not yet covered by a contact",
    ],
    path: "/rfp-awards",
  },
  {
    id: "awards",
    category: "RFP & Awards",
    title: "Awards",
    icon: Award,
    description:
      "Awards track business you've won from an RFP or ongoing relationship. Link awards to a company and RFP, record the lane count, volume, and effective dates. Awards give leadership visibility into won revenue.",
    capabilities: [
      "Create awards tied to a company or a specific RFP",
      "Record lane count, effective dates, and notes",
      "View all awards across the team in one list",
      "Filter by status, company, or date range",
    ],
    tips: [
      "Always link an award to its parent RFP if one exists — it keeps history clean",
    ],
    path: "/rfp-awards",
  },
  {
    id: "research-tasks",
    category: "RFP & Awards",
    title: "Lane Research",
    icon: Route,
    description:
      "Lane Research Tasks are created from high-volume RFP lanes that need a rep assigned to own and develop that corridor. Managers assign ownership; reps can see their lane assignments and update progress.",
    capabilities: [
      "View all lanes extracted from RFP uploads requiring ownership",
      "Assign a rep to each lane",
      "Track research status per lane",
      "Filter by account, rep, or status",
    ],
    tips: [
      "Lanes auto-populate from RFP uploads — no manual entry needed",
      "Assigning ownership early ensures no high-value lane is missed",
    ],
    path: "/research-tasks",
  },

  // ── Analytics & Intelligence ───────────────────────────────────────────────
  {
    id: "top-opportunities",
    category: "Analytics & Intelligence",
    title: "Top Opportunities",
    icon: Zap,
    description:
      "Top Opportunities is an intelligent engine that cross-references your historical delivery data with RFP lane origins. It surfaces accounts where your freight network already overlaps with a prospect's shipping needs — making your pitch data-driven.",
    capabilities: [
      "Cross-references delivery destination frequency with RFP lane origins",
      "Surfaces top accounts where your network aligns with their freight needs",
      "Proximity matching: delivery zones within 75 miles of customer pickup origins",
      "Lane Matching portlet: overlaps historical data with specific customer RFP lanes",
      "Shows backhaul and delivery opportunity scores",
    ],
    tips: [
      "Upload historical freight data in Financials first — Opportunities engine uses it",
      "Higher weekly load frequency = stronger network alignment with that account",
    ],
    path: "/top-opportunities",
  },
  {
    id: "historical-data",
    category: "Analytics & Intelligence",
    title: "Historical Data",
    icon: History,
    description:
      "The Historical Data module visualizes your freight network's delivery patterns. See a live heatmap of delivery destinations, identify hot zones, analyze top corridors, and discover which lanes you service most frequently.",
    capabilities: [
      "Interactive delivery density heatmap (Leaflet-powered)",
      "Top delivery destinations by total loads and weekly frequency",
      "Hot Zone identification: destinations with unusually high frequency",
      "Historical lane corridor analysis: your most common origin-destination pairs",
      "Per-account historical analysis when linked to a company profile",
    ],
    tips: [
      "Hot zones are destinations that appear in the top 10% of your delivery frequency",
      "Use the heatmap to quickly identify where your carrier network is strongest",
    ],
    path: "/historical-data",
    roles: ["admin", "director", "national_account_manager", "sales"],
  },
  {
    id: "financials",
    category: "Analytics & Intelligence",
    title: "Financial Data (Numbers)",
    icon: DollarSign,
    description:
      "The Financials page gives visibility into load-level revenue, freight cost, and margin data. Admins upload monthly Excel data (or sync from OneDrive); reps see their own team's numbers filtered by role. Company profiles show per-account load and margin tiles.",
    capabilities: [
      "Upload Excel load data (or sync from OneDrive automatically)",
      "Filter by rep, customer, status, or date range",
      "KPI tiles: total revenue, freight cost, load count, avg rate",
      "Searchable load-level table with origin/destination, rate, and charges",
      "Per-account summary on company profiles (total loads, spot loads, margin)",
      "Automatic monthly OneDrive sync with failure alerting",
    ],
    tips: [
      "Financials are role-filtered — NAMs see only their team's data",
      "The account summary tiles on company profiles pull from the latest upload",
    ],
    path: "/financials",
    roles: ["admin", "director", "national_account_manager", "sales"],
  },
  {
    id: "team-performance",
    category: "Analytics & Intelligence",
    title: "Team Performance",
    icon: TrendingUp,
    description:
      "Team Performance gives leaders a consolidated view of rep-level activity: task completion, contact touchpoints, company counts, load volume, and margin. Directors and NAMs see their direct reports; admins see everyone.",
    capabilities: [
      "Per-rep cards showing open tasks, overdue tasks, and completed tasks",
      "Touchpoint breakdowns: calls, emails, texts, site visits",
      "Company count and new contacts added",
      "Load volume and margin pulled from financial uploads",
      "Click a rep card to go directly to their profile",
    ],
    tips: [
      "Financial metrics only appear when load data has been uploaded",
      "Use this page during 1:1s to review your rep's activity objectively",
    ],
    path: "/team-performance",
    roles: ["admin", "director", "national_account_manager", "sales"],
  },

  // ── Team & Collaboration ───────────────────────────────────────────────────
  {
    id: "feed",
    category: "Team & Collaboration",
    title: "Callouts & Trends Feed",
    icon: Megaphone,
    description:
      "The Callouts Feed is a shared communication board where any team member can post trends, wins, ideas, and callouts. Posts can be linked to a specific account and tagged by category. Threaded replies keep conversations organized.",
    capabilities: [
      "Post trends, callouts, wins, and ideas with a category tag",
      "Optionally link a post to a company account",
      "Reply to posts in threaded view",
      "Attach files to posts (PDFs, images, docs)",
      "Dashboard portlet shows recent posts across all users",
      "Company profile portlet shows posts linked to that account",
      "Authors and admins can delete posts and replies",
    ],
    tips: [
      "Tag your posts accurately (Trend, Callout, Idea) — it helps others filter context",
      "Linking posts to an account makes them visible on that company's profile",
    ],
    path: "/",
  },
  {
    id: "one-on-one",
    category: "Team & Collaboration",
    title: "1:1 Meetings",
    icon: MessagesSquare,
    description:
      "The 1:1 module gives NAM-AM pairs a running list of discussion topics for their check-ins. Both sides can add items with tags (Action Item, Question, FYI, Follow-up). Topics carry forward when a session is closed.",
    capabilities: [
      "Add discussion topics at any time before or after a meeting",
      "Tag each topic: Action Item, Question, FYI, Follow-up",
      "Mark topics as 'Discussed' during the meeting",
      "Close a session: archives discussed items, carries forward pending ones",
      "AMs see their single pairing; NAMs see tabs for each direct report",
      "Admins see all active pairings",
      "Attach files to discussion topics",
    ],
    tips: [
      "Add topics throughout the week, not just right before the meeting",
      "Action Items marked pending carry forward automatically when you close a session",
    ],
    path: "/one-on-one",
  },
  {
    id: "goals",
    category: "Team & Collaboration",
    title: "Goals",
    icon: Target,
    description:
      "The Goals system lets NAMs set monthly targets for their AMs across four metrics: New Contacts added, Touchpoints logged, Load Count, and Margin earned. Progress auto-tracks where possible. Inline comments let managers and reps discuss progress.",
    capabilities: [
      "NAMs set monthly goals per AM for: New Contacts, Touchpoints, Load Count, Margin",
      "Contacts Added and Touchpoints are auto-tracked from activity",
      "Load Count and Margin are manually updated from financial data",
      "Progress bars show % toward each target",
      "Inline comments per goal for coaching notes",
      "Dashboard alert notifies NAMs when monthly goals haven't been set",
    ],
    tips: [
      "Set goals at the start of each month — the system reminds you if you forget",
      "Use the comments field to document coaching context alongside numbers",
    ],
    path: "/goals",
  },
  {
    id: "tasks",
    category: "Team & Collaboration",
    title: "Tasks",
    icon: ListTodo,
    description:
      "Tasks are action items that can be assigned to any rep, optionally linked to a company account or contact. Status cycles through Open → In Progress → Completed. Due dates show color-coded urgency badges.",
    capabilities: [
      "Create tasks with title, notes, due date, assigned rep, and optional account link",
      "Status cycling: Open → In Progress → Completed (click to advance)",
      "Due date badges: red = overdue, amber = today, yellow = soon",
      "My Tasks portlet on the dashboard shows your open items",
      "Company profile shows tasks linked to that account",
      "Attach files to tasks",
      "Admins and managers can assign tasks to any rep",
    ],
    tips: [
      "Link tasks to a company so they appear on the account's profile — easier to track",
      "Click the status icon on any task to cycle it forward without opening an edit dialog",
    ],
    path: "/tasks",
  },
  {
    id: "pto-passoff",
    category: "Team & Collaboration",
    title: "PTO Passoff",
    icon: Plane,
    description:
      "PTO Passoff lets reps plan their time off and document coverage for every account. Before leaving, you create a passoff with date range, covering rep, and a per-account checklist. The covering rep sees a dashboard portlet with everything they need.",
    capabilities: [
      "Create a passoff with date range, covering rep, and emergency contact",
      "Add per-account cards with priority level, spot freight handler, key contact, open items, active RFPs, and process notes",
      "Record avg weekly spot loads and total loads per account for context",
      "Covering rep acknowledges each account they're ready to handle",
      "Dashboard portlet shows accounts you're covering, sorted by priority",
      "Directors and admins see all active passoffs",
      "Readiness checklist: email forwarding, spot board update, coverage confirmed",
    ],
    tips: [
      "Create your passoff at least a week before your PTO — it gives your cover time to prepare",
      "High-priority accounts should have detailed open items and process notes filled in",
    ],
    path: "/pto-passoff",
    isNew: true,
  },

  // ── Administration ─────────────────────────────────────────────────────────
  {
    id: "user-management",
    category: "Administration",
    title: "User Management",
    icon: UserCog,
    description:
      "Admins and directors manage all users from this page. Create new accounts, set roles, assign managers, reset passwords, and control who is on which team. NAMs can manage their own direct reports.",
    capabilities: [
      "Create new user accounts with role and manager assignment",
      "Roles: Admin, Director, National Account Manager, Account Manager, Sales",
      "Edit user details including name, email, role, and manager",
      "View all users organized by role",
      "Admins can deactivate or archive users",
    ],
    tips: [
      "Always set a manager for AMs — it controls which NAM they 1:1 with and who sees their data",
      "Role changes take effect immediately on next login",
    ],
    path: "/admin/users",
    roles: ["admin", "director", "national_account_manager"],
  },
  {
    id: "account-transfer",
    category: "Administration",
    title: "Account Transfer",
    icon: ArrowRightLeft,
    description:
      "Account Transfer allows admins and NAMs to reassign company accounts from one rep to another. This is used when territory changes, rep transitions, or team restructuring occurs.",
    capabilities: [
      "Reassign any account to a different account manager",
      "Bulk transfer multiple accounts at once",
      "Transfer history is preserved in account activity",
      "Admins can transfer any account; NAMs can transfer within their team",
    ],
    tips: [
      "Use account transfer when a rep leaves — reassign their book before offboarding",
    ],
    path: "/admin/users",
    roles: ["admin", "director", "national_account_manager"],
  },
  // ── Team & Collaboration ────────────────────────────────────────────────────
  {
    id: "bulk-goals",
    category: "Team & Collaboration",
    title: "Bulk Goals",
    icon: Target,
    description:
      "Bulk Goals lets NAMs and admins create the same goal for multiple account managers at once. Instead of setting goals one by one, choose a metric, target, period, and pick which AMs to apply it to — the system skips any AM who already has that goal.",
    capabilities: [
      "Set the same goal for every AM on your team in one action",
      "Supports all goal types: Contacts Added, Load Count, Margin, Touchpoints, Custom",
      "Duplicate prevention: existing goals are silently skipped, not overwritten",
      "Returns a count of goals created vs. skipped so you know what happened",
      "Combined with individual goals for fine-tuned target customization",
    ],
    tips: [
      "Run bulk goals at the start of each quarter to baseline your team — then edit individuals as needed",
      "If a goal was skipped, it means that AM already has one for that metric and period — edit it from their goal card",
    ],
    path: "/goals",
    roles: ["admin", "director", "national_account_manager"],
  },
  {
    id: "trend-badges",
    category: "Team & Collaboration",
    title: "Trend Badges",
    icon: TrendingUp,
    description:
      "Trend badges appear on the Team Performance dashboard next to each rep's KPIs. They compare the current period's results to the previous one, showing whether each metric is up, down, or flat — with a dynamic label indicating exactly what's being compared.",
    capabilities: [
      "Green up-arrow: metric improved compared to prior period",
      "Red down-arrow: metric declined compared to prior period",
      "Gray dash: no change between periods",
      "Label shows context: 'vs. last mo.' for monthly, 'vs. prior period' for custom ranges",
      "Works across all rep metrics: touchpoints, contacts, tasks, and goal completion",
    ],
    tips: [
      "Use trend badges during 1:1s to have data-driven conversations about momentum",
      "A down-trend in touchpoints combined with a down-trend in contacts is an early warning sign",
    ],
    path: "/team-performance",
    roles: ["admin", "director", "national_account_manager"],
  },
  {
    id: "sales-account-association",
    category: "Team & Collaboration",
    title: "Sales Account Association",
    icon: DollarSign,
    description:
      "Account Association links a company's financial record (from uploaded spreadsheets) to the correct salesperson in the system. When financial data is uploaded, the system auto-matches accounts to users by Rep ID — and admins can override that link manually on any company profile.",
    capabilities: [
      "Financial uploads auto-assign accounts to reps by their Rep ID code",
      "Manual override available on any company detail page (admin/director/NAM)",
      "Salesperson link controls which rep's financial data appears on their report card",
      "Rep IDs are set per user in the admin user management page",
      "Supports the OneDrive sync workflow — uploads and associations happen automatically",
    ],
    tips: [
      "Always set a Rep ID for new users before uploading financial data for them",
      "If a company shows no financial data, check that the salesperson link is set and the Rep ID matches",
    ],
    path: "/admin/users",
    roles: ["admin", "director", "national_account_manager"],
  },
  {
    id: "career-conversations",
    category: "Team & Collaboration",
    title: "Career Conversations",
    icon: UserCircle,
    description:
      "Career Conversations is a structured framework for NAMs and AMs to discuss long-term career goals, development milestones, and promotion readiness. NAMs document key talking points and career objectives for each direct report, keeping those notes persistent across sessions.",
    capabilities: [
      "NAMs write and save career development notes for each AM",
      "Notes persist across 1:1 sessions for continuity",
      "Integrated with the 1:1 module — accessible from the AM detail view",
      "Admins and directors can view career notes across the team",
      "Supports candid conversations about promotion criteria and growth paths",
    ],
    tips: [
      "Update career notes after every significant career conversation — not just scheduled 1:1s",
      "Use the promotion readiness criteria in Admin to set clear expectations before the conversation",
      "Career notes are private between NAM and admin/director — AMs do not see their own notes",
    ],
    path: "/goals",
    roles: ["admin", "director", "national_account_manager"],
  },

  // ── New Features ────────────────────────────────────────────────────────────

  {
    id: "global-log-touch",
    category: "Getting Started",
    title: "Global Log Touch",
    icon: Zap,
    description:
      "The Global Log Touch button (⚡ in the top header) lets you log a touchpoint for any contact without navigating to their company profile first. A quick search-and-select dialog finds the contact and records the interaction in seconds — ideal for logging calls on the go.",
    capabilities: [
      "Log a touchpoint from anywhere in the app — no navigation required",
      "Search contacts by name and select the right one instantly",
      "Choose interaction type: Call, Email, Text, or Site Visit",
      "Optionally add a note and flag the conversation as Meaningful",
      "Appears in the contact's full touchpoint history immediately",
    ],
    tips: [
      "Use this right after hanging up a call — it takes under 30 seconds",
      "Flag meaningful conversations while the details are fresh in your mind",
    ],
    path: "/",
    isNew: true,
  },
  {
    id: "touchpoint-streak",
    category: "Getting Started",
    title: "Touchpoint Streak",
    icon: Flame,
    description:
      "The Touchpoint Streak tracks how many consecutive days you've logged at least your daily touchpoint goal. The streak counter appears as a KPI tile on your dashboard and keeps building as long as you hit your daily target. It resets if you miss a day.",
    capabilities: [
      "Dashboard KPI tile shows your current streak in days (🔥 icon)",
      "Displays today's touchpoint count vs. your daily goal",
      "Streak resets if you miss a day — motivation to stay consistent",
      "Daily briefing banner also shows streak progress",
    ],
    tips: [
      "Log at least one touch before end of day, every day — consistency is the whole game",
      "The streak goal is set by your admin — ask if it doesn't match your expectations",
    ],
    path: "/",
    isNew: true,
  },
  {
    id: "dna-guru",
    category: "Getting Started",
    title: "DNA Guru (AI Assistant)",
    icon: Bot,
    description:
      "DNA Guru is an AI-powered assistant built into the platform. It understands your account data, contacts, RFPs, and financial context — so you can ask real questions about your book of business and get intelligent, data-grounded answers without leaving the app.",
    capabilities: [
      "Ask natural language questions about any account or contact",
      "Get a pre-call brief summary for any company before a call",
      "Analyze RFP lane data, identify gaps, and suggest talking points",
      "Review goal progress and touchpoint trends",
      "Floating chat button available on every page",
    ],
    tips: [
      "Be specific — 'What's the health score for Acuity Brands?' gets better answers than 'tell me about my accounts'",
      "Use it before a big meeting to quickly pull together all the context you need",
    ],
    path: "/",
    isNew: true,
  },

  // ── New Account Management features ────────────────────────────────────────
  {
    id: "health-score",
    category: "Account Management",
    title: "Relationship Health Score",
    icon: HeartPulse,
    description:
      "Every company profile has a Relationship Health Score — a 0–100 rating that measures how strong your engagement is with that account. It factors in touchpoint recency, frequency, contact depth, RFP activity, and financial data. The score appears as a badge next to the company name.",
    capabilities: [
      "Score from 0–100 with grades: Excellent, Good, Fair, At Risk",
      "Color-coded badge on the company detail header (green → red)",
      "Five scoring factors: Recency (30pts), Frequency (25pts), Contact Depth (20pts), RFP/Award Activity (15pts), Financial Data (10pts)",
      "Clicking the badge opens the full Pre-Call Planner with factor breakdown",
      "Updates dynamically as you log touches and add contacts",
    ],
    tips: [
      "An 'At Risk' score means no recent touchpoints or very thin contact coverage — prioritize these accounts",
      "Contact Depth score improves by adding contacts across different levels of the org chart",
    ],
    path: "/customers",
    isNew: true,
  },
  {
    id: "pre-call-planner",
    category: "Account Management",
    title: "Pre-Call Planner",
    icon: Shield,
    description:
      "The Pre-Call Planner is a one-stop brief that consolidates everything you need before reaching out to an account. Access it by clicking the health score badge on any company profile. It shows financials, key contacts with last-touch dates, recent activity, open tasks, active RFPs, account intelligence, and the full health score breakdown.",
    capabilities: [
      "Financial snapshot: loads, revenue, margin, spot loads",
      "Key contacts with last touch date and recency badge",
      "Last 5 touchpoints logged against this account",
      "Open tasks linked to the account",
      "Active RFPs and awarded business",
      "Account intelligence: portal creds, quirks, spot process, dispatch email, tender style",
      "Shipping mode badges and last meaningful conversation highlight",
      "Print button to take a physical copy into a meeting",
    ],
    tips: [
      "Open the Pre-Call Planner 5 minutes before every call — it replaces scrambling through your notes",
      "The 'Last Meaningful Conversation' card shows in green when one exists — use it to reference in the call",
    ],
    path: "/customers",
    isNew: true,
  },
  {
    id: "meaningful-touchpoints",
    category: "Account Management",
    title: "Meaningful Touchpoints",
    icon: BadgeCheck,
    description:
      "When logging a touchpoint, you can toggle it as 'Meaningful' — indicating it was a substantive conversation (freight needs, rates, real opportunity, or strategy — not just a check-in). Meaningful touches require a note and show as a green badge on contact cards in the org chart.",
    capabilities: [
      "Toggle on any touchpoint log dialog (quick log or full log)",
      "Requires a note if marked meaningful — forces you to capture the substance",
      "Green 'Last Meaningful' date badge shows on contact cards in the org chart",
      "Dashboard alert: contacts with no meaningful touch in 30+ days",
      "Pre-Call Planner shows the last meaningful conversation in a highlighted card",
      "1:1 report cards show 'X meaningful / Y total' breakdown per rep",
      "Meaningful touchpoints can be tracked as a goal metric for AMs",
    ],
    tips: [
      "Not every call needs to be meaningful — use the toggle selectively for conversations that moved the relationship forward",
      "The 30-day meaningful alert on the dashboard is your early warning system for drifting accounts",
    ],
    path: "/customers",
    isNew: true,
  },
  {
    id: "shipping-modes",
    category: "Account Management",
    title: "Shipping Modes",
    icon: Truck,
    description:
      "Company profiles include shipping mode checkboxes (LTL, FTL, Drayage, IMDL) that describe which freight types this customer ships. Modes display as blue outline badges near the company's industry on the detail page header and can be filtered on the customer list.",
    capabilities: [
      "Set LTL, FTL, Drayage, and IMDL flags per company",
      "Badges display in the company profile header for instant context",
      "Customer list has filter chips to show only companies with a specific mode",
      "Pre-Call Planner displays mode badges in the brief header",
      "DNA Guru includes shipping modes in account analysis context",
    ],
    tips: [
      "Update shipping modes when you learn what a customer actually ships — it helps the whole team",
      "Use the FTL filter on the customer list to quickly find accounts relevant to a specific RFP type",
    ],
    path: "/customers",
    isNew: true,
  },
  {
    id: "wallet-share",
    category: "Account Management",
    title: "Wallet Share Calculator",
    icon: Calculator,
    description:
      "The Wallet Share Calculator is a panel on the company detail page that projects how much incremental margin you could capture by winning more of an account's freight. If an RFP exists, it uses RFP total volume plus your financial data; otherwise it uses the estimated freight spend field.",
    capabilities: [
      "Slider from 1–25% to model different capture scenarios",
      "Live incremental margin calculation as you move the slider",
      "If an RFP is linked, uses actual RFP volume for accuracy",
      "Falls back to estimated freight spend if no RFP is on file",
      "'Copy as Talking Point' button generates a ready-to-use call prep sentence",
      "Dashboard 'Top Wallet Share Opportunities' leaderboard shows top 5 accounts by untapped potential margin",
    ],
    tips: [
      "Use the talking point copy button before a rate call — it gives you a crisp, data-backed sentence",
      "Check the Wallet Share leaderboard on the dashboard to prioritize which accounts have the most upside",
    ],
    path: "/customers",
    isNew: true,
  },
  {
    id: "account-intelligence",
    category: "Account Management",
    title: "Account Intelligence",
    icon: Lightbulb,
    description:
      "Account Intelligence is a dedicated section inside every company profile that stores critical operational context — portal credentials, financial aliases, tendering process, spot process, dispatch email, account quirks, and detailed process notes. Everything a rep needs to work the account confidently.",
    capabilities: [
      "Portal URL, username, and password stored securely per account",
      "Financial alias field for accounts known by a different name in the TMS",
      "Tender style and spot process fields for operational context",
      "Dispatch email stored for quick reference",
      "Account quirks: free-form field for anything unusual about the account",
      "Detailed process notes section for step-by-step how-to context",
      "All intelligence surfaces in the Pre-Call Planner for quick access",
    ],
    tips: [
      "Fill in Account Intelligence before your first call — then update it after you learn something new",
      "Quirks and process notes are gold for covering reps during PTO — always keep them current",
    ],
    path: "/customers",
    isNew: true,
  },
  {
    id: "customer-scorecard",
    category: "Account Management",
    title: "Customer Scorecard",
    icon: FileBarChart2,
    description:
      "Company profiles support uploading and downloading scorecard documents — PDFs, spreadsheets, or any file that represents a formal account review or business review. Access is role-restricted so only authorized users can view and manage scorecards.",
    capabilities: [
      "Upload scorecard documents directly on a company profile",
      "Download scorecards from the profile at any time",
      "Role-based access: admins and NAMs can manage; AMs can view",
      "Stored as file attachments tied to the company record",
    ],
    tips: [
      "Upload the most recent QBR or account review deck as the scorecard — it gives everyone a baseline",
    ],
    path: "/customers",
    isNew: true,
  },

  // ── New RFP features ────────────────────────────────────────────────────────
  {
    id: "awarded-lanes",
    category: "RFP & Awards",
    title: "Awarded Lane Highlighting",
    icon: Award,
    description:
      "In the RFP Intelligence Lane Patterns → Corridors tab, any lane that also appears in an awarded or partially-awarded RFP is highlighted with a green '✓ We Ship This' badge and a green border. This lets you instantly see where you already have a foothold versus where you're competing blind.",
    capabilities: [
      "Green '✓ We Ship This' badge on corridors already in an awarded RFP",
      "Visual green border around awarded corridor cards",
      "Green summary bar: 'We ship X of Y corridors'",
      "Amber alert listing top-3 unawarded high-volume lanes needing attention",
      "Works across all RFPs linked to the same company",
    ],
    tips: [
      "Use the amber alert to identify which high-volume lanes you should be pitching next",
      "If a corridor shows 'We Ship This' but the account still uses another broker, that's your best upsell lane",
    ],
    path: "/rfp-awards",
    isNew: true,
  },

  // ── New Analytics features ──────────────────────────────────────────────────
  {
    id: "report-cards",
    category: "Analytics & Intelligence",
    title: "Rep Report Cards",
    icon: FileBarChart2,
    description:
      "Report Cards give each rep a comprehensive performance snapshot for a selected month — covering load volume, margin, touchpoints (including meaningful), contacts added, goal progress, and RFP win rate. NAMs and admins can view report cards for any rep; reps see their own.",
    capabilities: [
      "Select any month to see that period's performance",
      "Load count, revenue, freight cost, and margin with vs-prior-month delta",
      "Touchpoint breakdown: calls, emails, texts, site visits — plus meaningful/total ratio",
      "Contacts added and goal completion per metric",
      "RFP win rate for the period",
      "Email report directly from the page (weekly and monthly auto-emails also available)",
      "NAMs and admins can view any rep's card from the Report Cards list",
    ],
    tips: [
      "Review your own report card before a 1:1 — it prevents any surprises",
      "The meaningful touchpoint ratio is a quality-over-quantity indicator — aim for depth, not just volume",
    ],
    path: "/reports",
    roles: ["admin", "director", "national_account_manager", "sales_director"],
    isNew: true,
  },
  {
    id: "my-report-card",
    category: "Analytics & Intelligence",
    title: "My Report Card",
    icon: Gauge,
    description:
      "AMs, Sales, Logistics Managers, and Logistics Coordinators can view their own personal report card from the sidebar. It shows the same comprehensive data as the admin view — load volume, margin, touchpoints, goals, and win rate — for any selected month.",
    capabilities: [
      "View your own performance for any past month",
      "Load, margin, touchpoint, and goal data in one view",
      "Meaningful vs. total touchpoint breakdown",
      "Goal progress per metric with % completion",
      "Can be emailed to you directly from the page",
    ],
    tips: [
      "Check this monthly, not just when a manager asks — own your numbers",
      "Use it to build talking points for your own 1:1 review",
    ],
    path: "/report/me",
    roles: ["account_manager", "sales", "logistics_manager", "logistics_coordinator"],
    isNew: true,
  },
  {
    id: "dashboard-alerts",
    category: "Analytics & Intelligence",
    title: "Dashboard Alerts",
    icon: BellRing,
    description:
      "The dashboard surfaces contextual alert cards based on what needs your attention right now — RFP deadlines approaching, goals not set for the month, pending 1:1 topics, contacts overdue for a meaningful conversation, and PTO coverage assignments.",
    capabilities: [
      "RFP deadline alert: RFPs due within 7 days show prominently",
      "Missing goals alert: NAMs notified when monthly goals haven't been set for AMs",
      "Meaningful overdue alert: contacts with no meaningful touch in 30+ days",
      "Pending 1:1 topics: unresolved discussion items from active sessions",
      "PTO coverage portlet: accounts you're covering with priority sort",
      "Daily briefing: due tasks + today's touchpoints + streak progress",
    ],
    tips: [
      "Work through alert cards every morning as your daily startup routine",
      "The meaningful overdue alert is your relationship health warning system — don't ignore it",
    ],
    path: "/",
    isNew: true,
  },
];

// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = [
  { name: "Getting Started",            icon: GraduationCap },
  { name: "Account Management",         icon: Building2 },
  { name: "RFP & Awards",               icon: Trophy },
  { name: "Analytics & Intelligence",   icon: BarChart3 },
  { name: "Team & Collaboration",       icon: MessagesSquare },
  { name: "Administration",             icon: UserCog },
];

const ROLE_COLORS: Record<string, string> = {
  admin:                    "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  director:                 "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  national_account_manager: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  account_manager:          "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  sales:                    "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  director: "Director",
  national_account_manager: "NAM",
  account_manager: "Account Manager",
  sales: "Sales",
};

const COMPLETED_KEY = "training_completed_v1";

function getCompleted(): Set<string> {
  try {
    const raw = localStorage.getItem(COMPLETED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveCompleted(set: Set<string>) {
  localStorage.setItem(COMPLETED_KEY, JSON.stringify([...set]));
}

export default function TrainingPage() {
  const { user } = useAuth();
  const { startTour } = useTour();
  const [activeCategory, setActiveCategory] = useState("Getting Started");
  const [expandedId, setExpandedId] = useState<string | null>("overview");
  const [search, setSearch] = useState("");
  const [completed, setCompleted] = useState<Set<string>>(getCompleted);

  const toggleCompleted = (id: string) => {
    setCompleted(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCompleted(next);
      return next;
    });
  };

  const visibleModules = useMemo(() => {
    return MODULES.filter(m => {
      if (m.roles && user?.role && !m.roles.includes(user.role)) return false;
      return true;
    });
  }, [user?.role]);

  const searchResults = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase();
    return visibleModules.filter(m =>
      m.title.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q) ||
      m.capabilities.some(c => c.toLowerCase().includes(q)) ||
      m.category.toLowerCase().includes(q)
    );
  }, [search, visibleModules]);

  const categoryModules = useMemo(() => {
    return visibleModules.filter(m => m.category === activeCategory);
  }, [activeCategory, visibleModules]);

  const displayModules = searchResults ?? categoryModules;

  const progressByCategory = useMemo(() => {
    return Object.fromEntries(
      CATEGORIES.map(c => {
        const mods = visibleModules.filter(m => m.category === c.name);
        const done = mods.filter(m => completed.has(m.id)).length;
        return [c.name, { done, total: mods.length }];
      })
    );
  }, [visibleModules, completed]);

  const totalDone = visibleModules.filter(m => completed.has(m.id)).length;
  const totalModules = visibleModules.length;

  return (
    <div className="flex h-full">
      {/* Left nav */}
      <aside className="hidden md:flex flex-col w-56 shrink-0 border-r bg-muted/20 p-4 gap-1 overflow-y-auto">
        <div className="mb-4">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Overall Progress</p>
          <Progress value={totalModules > 0 ? (totalDone / totalModules) * 100 : 0} className="h-2 mb-1" />
          <p className="text-xs text-muted-foreground">{totalDone} / {totalModules} sections read</p>
        </div>
        {CATEGORIES.map(cat => {
          const p = progressByCategory[cat.name] ?? { done: 0, total: 0 };
          const isActive = activeCategory === cat.name && !searchResults;
          return (
            <button
              key={cat.name}
              onClick={() => { setActiveCategory(cat.name); setSearch(""); }}
              className={`flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm text-left transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`nav-category-${cat.name.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <cat.icon className="h-4 w-4 shrink-0" />
              <span className="truncate flex-1">{cat.name}</span>
              {p.done > 0 && (
                <span className={`text-xs shrink-0 ${isActive ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                  {p.done}/{p.total}
                </span>
              )}
            </button>
          );
        })}
      </aside>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-4">

          {/* Header */}
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 text-white">
              <GraduationCap className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <h1 className="text-xl font-bold">Training Center</h1>
              <p className="text-sm text-muted-foreground">
                A guided walkthrough of every feature in Freight DNA. Mark sections as read to track your progress.
              </p>
            </div>
            <Button
              onClick={() => startTour()}
              className="shrink-0 gap-2 bg-amber-500 hover:bg-amber-600 text-white shadow-sm"
              data-testid="button-start-tour"
            >
              <PlayCircle className="h-4 w-4" />
              Start Live Tour
            </Button>
          </div>

          {/* Tour CTA card */}
          <div className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-950/20 p-4 flex items-start gap-3">
            <span className="text-2xl shrink-0">🎯</span>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">New to Freight DNA? Start with the Live Tour.</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                A 5-minute interactive walkthrough that highlights the actual features in the platform as you go — no reading required. Perfect for visual learners.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => startTour()}
              className="shrink-0 gap-1.5 border-amber-400 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30"
              data-testid="button-start-tour-cta"
            >
              <PlayCircle className="h-3.5 w-3.5" />
              Launch
            </Button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search any feature, topic, or keyword…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
              data-testid="input-training-search"
            />
          </div>

          {/* Mobile category tabs */}
          <div className="flex md:hidden gap-2 overflow-x-auto pb-1">
            {CATEGORIES.map(cat => (
              <button
                key={cat.name}
                onClick={() => { setActiveCategory(cat.name); setSearch(""); }}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  activeCategory === cat.name && !searchResults
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>

          {/* Section header */}
          {searchResults ? (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for <span className="font-medium text-foreground">"{search}"</span>
              </p>
              <button onClick={() => setSearch("")} className="text-xs text-primary hover:underline">Clear</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {(() => { const C = CATEGORIES.find(c => c.name === activeCategory); return C ? <C.icon className="h-4 w-4 text-muted-foreground" /> : null; })()}
              <h2 className="font-semibold">{activeCategory}</h2>
              <Badge variant="secondary" className="font-normal text-xs">{categoryModules.length} sections</Badge>
              {progressByCategory[activeCategory]?.done > 0 && (
                <Badge className="font-normal text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  {progressByCategory[activeCategory].done} read
                </Badge>
              )}
            </div>
          )}

          {/* Module cards */}
          {displayModules.length === 0 ? (
            <div className="rounded-xl border bg-muted/30 p-8 text-center">
              <Search className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No modules found for "{search}"</p>
            </div>
          ) : (
            <div className="space-y-3">
              {displayModules.map(mod => {
                const isExpanded = expandedId === mod.id;
                const isDone = completed.has(mod.id);
                const Icon = mod.icon;
                return (
                  <div
                    key={mod.id}
                    className={`rounded-xl border transition-all ${
                      isDone
                        ? "border-green-200 dark:border-green-800 bg-green-50/30 dark:bg-green-950/10"
                        : "border-border bg-card"
                    }`}
                    data-testid={`card-module-${mod.id}`}
                  >
                    {/* Card header — always visible */}
                    <button
                      className="w-full flex items-center gap-3 p-4 text-left"
                      onClick={() => setExpandedId(isExpanded ? null : mod.id)}
                      data-testid={`button-expand-${mod.id}`}
                    >
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                        isDone
                          ? "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400"
                          : "bg-muted text-muted-foreground"
                      }`}>
                        {isDone ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{mod.title}</span>
                          {mod.isNew && (
                            <Badge className="text-xs font-normal bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-none">New</Badge>
                          )}
                          {searchResults && (
                            <Badge variant="secondary" className="text-xs font-normal">{mod.category}</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 pr-4">{mod.description}</p>
                      </div>
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                    </button>

                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="px-4 pb-4 space-y-4 border-t border-border/50 pt-4">
                        <p className="text-sm text-muted-foreground leading-relaxed">{mod.description}</p>

                        {/* Role relevance */}
                        {mod.roles && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-muted-foreground font-medium">Relevant for:</span>
                            {mod.roles.map(r => (
                              <span key={r} className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_COLORS[r] ?? ""}`}>
                                {ROLE_LABELS[r] ?? r}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Capabilities */}
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">What you can do</p>
                          <ul className="space-y-1.5">
                            {mod.capabilities.map((cap, i) => (
                              <li key={i} className="flex items-start gap-2 text-sm">
                                <ChevronRight className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                                <span>{cap}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* Pro tips */}
                        {mod.tips && mod.tips.length > 0 && (
                          <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 p-3 space-y-1.5">
                            <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                              <Star className="h-3.5 w-3.5" />
                              Pro Tips
                            </p>
                            {mod.tips.map((tip, i) => (
                              <p key={i} className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">• {tip}</p>
                            ))}
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-2 flex-wrap pt-1">
                          {mod.path && (
                            <Link href={mod.path}>
                              <button
                                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                                data-testid={`button-goto-${mod.id}`}
                              >
                                <ExternalLink className="h-3 w-3" />
                                Go to {mod.title}
                              </button>
                            </Link>
                          )}
                          <button
                            onClick={() => toggleCompleted(mod.id)}
                            className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-colors ${
                              isDone
                                ? "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800 hover:bg-green-200 dark:hover:bg-green-900/50"
                                : "bg-background border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                            }`}
                            data-testid={`button-mark-complete-${mod.id}`}
                          >
                            {isDone ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                            {isDone ? "Marked as read" : "Mark as read"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Completion banner */}
          {!searchResults && totalDone === totalModules && totalModules > 0 && (
            <div className="rounded-xl border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/20 p-5 text-center">
              <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2" />
              <p className="font-semibold text-green-800 dark:text-green-300">You've completed the training!</p>
              <p className="text-sm text-green-700 dark:text-green-400 mt-1">
                You're all caught up. New features will appear here as they're added — check back anytime.
              </p>
            </div>
          )}

          {/* Footer note */}
          <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 p-3">
            <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground">
              This training center updates automatically as new features are added to the platform. Your progress is saved locally in your browser.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
