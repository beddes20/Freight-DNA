/**
 * Per-page and per-role suggested-prompt packs for the DNA Copilot.
 * Mirrors `server/agent/router.ts` so server-side defaults stay in sync.
 */
import type { ChatEntityType } from "@/hooks/use-chat-page-context";

const ROLE_PROMPTS: Record<string, string[]> = {
  admin: [
    "Which reps are behind on their goals this week?",
    "Show me the team's touchpoint leaderboard",
    "What's the org-wide rate positioning vs market?",
    "Who hasn't logged a touchpoint today?",
  ],
  director: [
    "Which reps are behind on their goals this week?",
    "Show me the team's touchpoint leaderboard",
    "Who hasn't logged a touchpoint today?",
    "Which accounts haven't been touched in 30+ days?",
  ],
  sales_director: [
    "Which reps on my team are behind?",
    "Touchpoint tally for my team this week",
    "Which accounts need attention?",
    "RFPs due this week",
  ],
  national_account_manager: [
    "What's on my plate today?",
    "Which of my accounts haven't been touched in 30+ days?",
    "RFPs due this week",
    "Recent touchpoints I logged",
  ],
  account_manager: [
    "What's on my plate today?",
    "Which contacts haven't been touched in 30+ days?",
    "Show me my open tasks",
    "What accounts should I prioritize today?",
  ],
  sales: [
    "What's on my plate today?",
    "Show my open tasks",
    "Recent touchpoints I logged",
    "What accounts should I prioritize?",
  ],
  logistics_manager: [
    "Show today's check-ins",
    "Lanes I'm working on",
    "Recent activity on my book",
    "Open tasks for me",
  ],
  logistics_coordinator: [
    "What's pending in Coordinators Corner?",
    "Show today's check-ins",
    "Lanes I'm working on",
  ],
};

const PAGE_PROMPTS: Record<ChatEntityType, string[]> = {
  company:  ["Summarize this account", "Recommend next actions", "Show recent activity", "Who are the key contacts here?"],
  carrier:  ["Summarize this carrier", "What lanes do they run for us?", "What are we paying them this month?", "Recent loads"],
  lane:     ["How tight is this lane right now?", "Who's running this corridor?", "Market rate vs. what we're paying", "Recent awards on this lane"],
  rfp:      ["Summarize this RFP", "Which lanes look most competitive?", "Suggest a bid strategy", "Recent awards on similar lanes"],
  task:     ["What's on my plate today?", "Show overdue tasks", "Create a new task"],
  contact:  ["Summarize this contact", "Suggest a follow-up message", "Recent touchpoints with them"],
  prospect: ["Summarize this prospect", "Suggest an opening message", "Recent activity"],
};

export function getSuggestedPrompts(role: string | undefined, entityType: ChatEntityType | null): string[] {
  if (entityType && PAGE_PROMPTS[entityType]) return PAGE_PROMPTS[entityType];
  if (role && ROLE_PROMPTS[role]) return ROLE_PROMPTS[role];
  return ROLE_PROMPTS.account_manager;
}
