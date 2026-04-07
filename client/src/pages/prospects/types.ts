import type { Prospect, ProspectStage } from "@shared/schema";
import { PhoneCall, Mail, MessageSquare, Users, NotebookPen } from "lucide-react";

export const ACTIVE_STAGES: ProspectStage[] = [
  "new_lead", "intro_scheduled", "intro_completed",
  "follow_up", "opportunity_sent", "first_load_won",
];
export const CLOSED_STAGES: ProspectStage[] = ["lost", "disqualified"];

export const STAGE_BORDER: Record<string, string> = {
  new_lead:         "border-t-slate-400",
  intro_scheduled:  "border-t-blue-400",
  intro_completed:  "border-t-indigo-400",
  follow_up:        "border-t-amber-400",
  opportunity_sent: "border-t-orange-400",
  first_load_won:   "border-t-emerald-500",
};

export const CONTACT_ROLE_LABELS: Record<string, string> = {
  champion: "Champion",
  decision_maker: "Decision Maker",
  gatekeeper: "Gatekeeper",
  influencer: "Influencer",
  other: "Other",
};

export const CONTACT_ROLE_COLORS: Record<string, string> = {
  champion:      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  decision_maker:"bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  gatekeeper:    "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  influencer:    "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  other:         "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

export const ACTIVITY_ICONS: Record<string, any> = {
  call: PhoneCall, email: Mail, text: MessageSquare, meeting: Users, note: NotebookPen,
};

export const ACCOUNT_STATUS_DOT: Record<string, string> = {
  prospecting: "bg-slate-400",
  intro_scheduled: "bg-blue-400",
  active_customer: "bg-emerald-500",
  dormant: "bg-amber-400",
  lost: "bg-red-400",
};

export type EnrichedProspect = Prospect & { ownerName?: string | null; assignedNamName?: string | null };
export type ActivityWithName = { id: number; type: string; notes: string; createdByName: string; createdAt: string };
export type LaunchpadTab = "pipeline" | "accounts" | "analytics";
