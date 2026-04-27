import { createContext, useContext } from "react";

export type TourStep = {
  id: string;
  title: string;
  emoji: string;
  description: string;
  bullets: string[];
  tip?: string;
  route?: string;
  target?: string;
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to Freight DNA!",
    emoji: "👋",
    description: "This tour walks you through the platform's core features in about 5 minutes. Each step highlights the exact part of the screen we're talking about.",
    bullets: [
      "Click Next to move through each feature",
      "Highlighted elements have a gold pulsing ring",
      "You can end the tour at any time with the X button",
    ],
    route: "/",
  },
  {
    id: "kpi-tiles",
    title: "Dashboard KPIs",
    emoji: "📊",
    description: "The stat tiles at the top of your dashboard show your book of business at a glance — accounts, contacts, freight spend, and monthly activity.",
    bullets: [
      "Stats are role-scoped — you see your book, managers see their team",
      "Click any tile to drill into that metric",
      "Numbers update automatically as you add accounts and log activity",
    ],
    tip: "Directors and admins see team-wide KPIs above their personal stats.",
    route: "/",
    target: "tour-kpi-tiles",
  },
  {
    id: "tasks",
    title: "My Tasks",
    emoji: "✅",
    description: "Your open tasks live here — follow-ups, research, 1:1 action items, and anything else on your plate. Due date badges color-code urgency for you.",
    bullets: [
      "Green = due today · Yellow = this week · Red = overdue",
      "Action items from 1:1 meetings auto-appear here",
      "Click the + button to add a task right from the dashboard",
    ],
    tip: "The full Tasks page in the sidebar shows everything in one view with filters.",
    route: "/",
    target: "tour-tasks-portlet",
  },
  {
    id: "contacts-attention",
    title: "Contacts Needing Attention",
    emoji: "🧊",
    description: "Any contact you haven't touched in 30+ days surfaces here as a warning. It keeps your relationships warm and prevents accounts from going cold without you knowing.",
    bullets: [
      "Click a contact name to open their full detail sheet",
      "Use the + button to quickly create a follow-up task",
      "Once you log a touchpoint, they drop off this list automatically",
    ],
    tip: "This section only appears when you have cold contacts — stay on top of your book and it stays hidden.",
    route: "/",
    target: "tour-contacts-attention",
  },
  {
    id: "log-touch",
    title: "Log a Touchpoint",
    emoji: "📞",
    description: "The phone icon in the top header is your fastest way to log any customer interaction — a call, email, text, or site visit. It takes less than 10 seconds.",
    bullets: [
      "Pick the account and contact from a searchable dropdown",
      "Choose the type: Call, Email, Text, or Site Visit",
      "Mark it 'meaningful' if it was a real business conversation",
    ],
    tip: "You can also log touchpoints from inside a contact's detail sheet or from the Contacts Needing Attention list.",
    route: "/",
    target: "tour-log-touch",
  },
  {
    id: "global-search",
    title: "Global Search",
    emoji: "🔍",
    description: "The search bar in the header instantly finds any company or team member by name. Results appear as you type — no Enter key needed.",
    bullets: [
      "Type any part of a company name to find it",
      "Search also finds teammates by name",
      "Click any result to jump directly to that profile",
    ],
    route: "/",
    target: "tour-global-search",
  },
  {
    id: "companies",
    title: "Your Book of Business",
    emoji: "🏢",
    description: "The Accounts page is your full book of business. Every company you manage is here — filterable by region, shipping mode, health score, and rep assignment.",
    bullets: [
      "Filter and sort to find exactly what you need",
      "Add new accounts with the blue + button",
      "Click any row to open the company's full profile",
    ],
    tip: "You only see accounts assigned to you — managers see their entire team's book.",
    route: "/customers",
    target: "tour-companies-table",
  },
  {
    id: "company-detail",
    title: "Company Profile — 5 Tabs",
    emoji: "🗂️",
    description: "Each company has five tabs: Overview (health + spend), Activity (touchpoint log), Intelligence (account notes), People (contacts + org chart), and RFP (bids and awards).",
    bullets: [
      "Overview shows health score, freight spend, and relationship status",
      "Activity is a full log of every interaction with this account",
      "Intelligence stores account quirks, portal logins, and tender process notes",
    ],
    tip: "The Intelligence tab is gold for pre-call prep — treat it like a living playbook for each account.",
    route: "/customers",
  },
  {
    id: "org-chart",
    title: "Org Charts & Relationships",
    emoji: "🌐",
    description: "The People tab lets you build a visual org chart for every account. Map out who reports to whom, set relationship levels, and track how deep into the organization you're penetrating.",
    bullets: [
      "Add contacts with the + button — set title, phone, email, and relationship level",
      "Relationship levels: 1st (entry), 2nd (influencer), 3rd (decision-maker), Home Run (executive)",
      "Drag contacts into a hierarchy to show reporting structure",
    ],
    tip: "Home Run contacts are the executive decision-makers. Getting there is the long game.",
    route: "/customers",
  },
  {
    id: "dna-guru",
    title: "DNA Guru — AI Assistant",
    emoji: "🤖",
    description: "DNA Guru is your built-in AI sales coach. Ask it anything about your accounts, get talking points for calls, run lane gap analysis, or have it log a touchpoint on your behalf.",
    bullets: [
      "\"What should I discuss on my call with Bayshore Brand tomorrow?\"",
      "\"Show me my contacts that haven't been touched in 30 days\"",
      "\"Log a call with John Smith at Acme — discussed Q3 rates\"",
    ],
    tip: "DNA Guru can actually execute actions (log touchpoints, create tasks) if you confirm the card it proposes.",
    route: "/",
    target: "tour-dna-guru",
  },
  {
    id: "ai-hub",
    title: "AI Hub — Every AI Surface, One Click Away",
    emoji: "✨",
    description:
      "The AI sidebar entry opens the AI Hub — a tabbed page that consolidates every AI experience in Freight DNA. No more hunting across the sidebar to find Today's Priorities, ValueIQ, Email Intelligence, Contact Suggestions, the AI Center, AI Engagement, or Copilot Analytics. They're all here.",
    bullets: [
      "Tabs you can see are gated by your role — reps see the surfaces relevant to selling, admins see Engagement and Copilot Analytics too",
      "The badge on the AI sidebar row shows your unread Today's Priorities count so you know when new signals are waiting",
      "Old URLs still work and land you on the right tab — bookmarks won't break",
    ],
    tip: "Start your day on the Today's Priorities tab. Then jump to ValueIQ for the briefing on your top accounts.",
    route: "/ai-hub",
    target: "tour-ai-hub",
  },
  {
    id: "rfp-awards",
    title: "RFP & Awards",
    emoji: "📋",
    description: "Manage every RFP your accounts send out — upload lane data from Excel, set deadlines, and track which lanes you've been awarded. Your pricing and bid intelligence hub.",
    bullets: [
      "Upload RFP Excel files — AI maps the columns for you automatically",
      "Track active RFPs, awarded lanes, and bid history",
      "RFP deadlines appear as alerts on your dashboard when they're near",
    ],
    route: "/rfp-awards",
  },
  {
    id: "lane-research",
    title: "Lane & Carrier Research",
    emoji: "🛣️",
    description: "Search freight lane patterns across all uploaded financial data. Find top lanes, identify coverage gaps, and see which carriers are running your customers' routes.",
    bullets: [
      "Search by origin/destination state or city pair",
      "See load count, margin, and carrier mix per lane corridor",
      "AI ranks gaps by priority (High / Medium / Low) based on volume and awards",
    ],
    route: "/rfp-lane-search",
  },
  {
    id: "top-opportunities",
    title: "Top Opportunities",
    emoji: "🏆",
    description: "The platform automatically surfaces your biggest revenue opportunities — accounts with low wallet share, cold contacts, lanes going to competitors, and under-penetrated regions.",
    bullets: [
      "Sorted by estimated revenue impact",
      "Each card shows the specific gap or insight driving the opportunity",
      "Click to jump directly to the relevant account or contact",
    ],
    route: "/top-opportunities",
  },
  {
    id: "one-on-one",
    title: "1:1 Meetings",
    emoji: "🤝",
    description: "The 1:1 module helps managers and their reps run structured meetings. Add topics before the call, take notes during it, and track action items that auto-sync to Tasks.",
    bullets: [
      "Topics tagged 'Action Item' automatically appear in My Tasks",
      "Morale score lets reps share how they're feeling each session",
      "Session notes are saved and searchable after every meeting",
    ],
    route: "/one-on-one",
  },
  {
    id: "goals",
    title: "Goals & Accountability",
    emoji: "🎯",
    description: "Managers set monthly goals for their reps — contacts added, touchpoints made, relationships advanced. Progress is tracked automatically from CRM activity.",
    bullets: [
      "Goals are set at the start of each month by the NAM",
      "Progress bars update automatically as you log activity",
      "Milestones and notes let you track qualitative progress too",
    ],
    route: "/goals",
  },
  {
    id: "done",
    title: "You're All Set!",
    emoji: "🎓",
    description: "You've seen everything Freight DNA has to offer. The Training Center has detailed written guides for every feature — reference it any time you want to go deeper on something.",
    bullets: [
      "Mark modules complete in Training to track your learning progress",
      "Use the search bar in Training to find any feature by keyword",
      "New features are added to Training automatically when they ship",
    ],
    tip: "Bookmark this platform — you'll be using it every single day.",
    route: "/training",
  },
];

type TourContextType = {
  isTourActive: boolean;
  currentStepIndex: number;
  steps: TourStep[];
  startTour: (startIndex?: number) => void;
  endTour: () => void;
  nextStep: () => void;
  prevStep: () => void;
};

export const TourContext = createContext<TourContextType>({
  isTourActive: false,
  currentStepIndex: 0,
  steps: TOUR_STEPS,
  startTour: () => {},
  endTour: () => {},
  nextStep: () => {},
  prevStep: () => {},
});

export function useTour() {
  return useContext(TourContext);
}
