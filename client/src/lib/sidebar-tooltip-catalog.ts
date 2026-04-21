// Catalog of every sidebar item tooltip that admins can override.
// `key` matches the value the sidebar uses to look up an override; we use the
// rendered title as the key so it stays stable even if URLs/icons change.
//
// When you add a new sidebar item in `client/src/components/app-sidebar.tsx`,
// also add an entry here so admins can edit its tooltip copy.

export type SidebarTooltipDefault = {
  key: string;
  title: string;
  group: string;
  defaultDescription: string;
};

export const SIDEBAR_TOOLTIP_DEFAULTS: SidebarTooltipDefault[] = [
  // Navigation
  { key: "Dashboard", title: "Dashboard", group: "Navigation", defaultDescription: "Your home view with daily priorities and updates." },
  { key: "Launchpad", title: "Launchpad", group: "Navigation", defaultDescription: "Find and qualify new prospects to pursue." },
  { key: "Customers", title: "Customers", group: "Navigation", defaultDescription: "Browse customer accounts and account history." },
  { key: "Top Opportunities", title: "Top Opportunities", group: "Navigation", defaultDescription: "High-value opportunities ranked by potential impact." },
  { key: "1:1's", title: "1:1's", group: "Navigation", defaultDescription: "Manager check-ins and one-on-one notes." },
  { key: "Tasks", title: "Tasks", group: "Navigation", defaultDescription: "Your personal to-do list and reminders." },
  { key: "Team Performance", title: "Team Performance", group: "Navigation", defaultDescription: "Team metrics, leaderboards, and performance trends." },
  { key: "Goals", title: "Goals", group: "Navigation", defaultDescription: "Track personal and team sales goals." },
  { key: "My Scorecard", title: "My Scorecard", group: "Navigation", defaultDescription: "Your individual performance scorecard." },

  // Pipeline
  { key: "RFP & Awards", title: "RFP & Awards", group: "Pipeline", defaultDescription: "Active RFPs and awarded business tracking." },
  { key: "RFP Calendar", title: "RFP Calendar", group: "Pipeline", defaultDescription: "Upcoming RFP deadlines and key dates." },
  { key: "Rep Scorecard", title: "Rep Scorecard", group: "Pipeline", defaultDescription: "Compare reps and review performance metrics." },
  { key: "Coaching", title: "Coaching", group: "Pipeline", defaultDescription: "Coaching notes and rep development plans." },
  { key: "LM Check-In Log", title: "LM Check-In Log", group: "Pipeline", defaultDescription: "History of logistics manager check-ins." },

  // Lane Tools
  { key: "Lane Intelligence", title: "Lane Intelligence", group: "Lane Tools", defaultDescription: "Research lanes and gather pricing intelligence." },
  { key: "My Procurement", title: "My Procurement", group: "Lane Tools", defaultDescription: "Lanes you're actively procuring carriers for." },
  { key: "Lane Work Queue", title: "Lane Work Queue", group: "Lane Tools", defaultDescription: "Lanes awaiting your reply or next action." },
  { key: "Available Freight", title: "Available Freight", group: "Lane Tools", defaultDescription: "Freight loads currently available to cover." },
  { key: "Carrier Hub", title: "Carrier Hub", group: "Lane Tools", defaultDescription: "Manage carriers and review their submitted intel." },
  { key: "Conversations", title: "Conversations", group: "Lane Tools", defaultDescription: "Inbound carrier and customer messages." },
  { key: "Contact Suggestions", title: "Contact Suggestions", group: "Lane Tools", defaultDescription: "Suggested new contacts to add to accounts." },
  { key: "Email Intelligence", title: "Email Intelligence", group: "Lane Tools", defaultDescription: "AI insights pulled from your inbound emails." },
  { key: "Proven Tactics", title: "Proven Tactics", group: "Lane Tools", defaultDescription: "Reusable plays that have closed deals." },
  { key: "Playbook", title: "Playbook", group: "Lane Tools", defaultDescription: "Step-by-step guides for common sales situations." },
  { key: "ValueIQ", title: "ValueIQ", group: "Lane Tools", defaultDescription: "Daily AI briefing on your top accounts." },

  // Admin / Team
  { key: "User Management", title: "User Management / My Team", group: "Admin / Team", defaultDescription: "Manage team members and their access." },
  { key: "Carrier Catalog", title: "Carrier Catalog", group: "Admin / Team", defaultDescription: "Master list of carriers and their details." },
  { key: "Monitored Mailboxes", title: "Monitored Mailboxes", group: "Admin / Team", defaultDescription: "Mailboxes the system watches for activity." },
  { key: "Freight Import Health", title: "Freight Import Health", group: "Admin / Team", defaultDescription: "Status of recent freight feed imports." },
  { key: "Coordinators Corner", title: "Coordinators Corner", group: "Admin / Team", defaultDescription: "Tools and resources for coordinators." },
  { key: "PTO Passoff", title: "PTO Passoff", group: "Admin / Team", defaultDescription: "Hand off accounts during time off." },
  { key: "Touchpoint History", title: "Touchpoint History", group: "Admin / Team", defaultDescription: "Past calls, emails, and customer touches." },
  { key: "Feedback Inbox", title: "Feedback Inbox", group: "Admin / Team", defaultDescription: "User-submitted bugs and feature requests." },
  { key: "Sidebar Tooltips", title: "Sidebar Tooltips", group: "Admin / Team", defaultDescription: "Edit the tooltip copy shown for each sidebar item." },

  // Footer
  { key: "Help & Resources", title: "Help & Resources", group: "Footer", defaultDescription: "Resources, training, and keyboard shortcuts." },
  { key: "My Profile", title: "My Profile", group: "Footer", defaultDescription: "Edit your profile and email signature." },
  { key: "Sign Out", title: "Sign Out", group: "Footer", defaultDescription: "Sign out of your account." },
];

export const SIDEBAR_TOOLTIP_DEFAULT_MAP: Record<string, string> =
  Object.fromEntries(SIDEBAR_TOOLTIP_DEFAULTS.map(d => [d.key, d.defaultDescription]));
