// Workflow OS — centralized guardrail / suppression copy + icons.
//
// Every surface that surfaces "this carrier was throttled / blocked /
// deduped" badges reads its label, long-form explanation, and icon from
// this map. See docs/workflow-os-spec.md section F and ADR-004.

import {
  ShieldAlert,
  UserX,
  Clock,
  Repeat,
  type LucideIcon,
} from "lucide-react";

export type GuardrailReason =
  | "recent_contact"
  | "daily_cap"
  | "not_approved"
  | "do_not_contact_lane"
  | "customer_carrier_blocked"
  | "throttled_too_soon"
  | "throttled_daily_cap"
  | "dedup_skipped";

export interface GuardrailCopy {
  shortLabel: string;
  longExplanation: string;
  icon: LucideIcon;
  // Iconography rule (ADR-004): "compliance" → ShieldAlert,
  // "dnc" → UserX, "throttle" → Clock, "dedup" → Repeat.
  category: "compliance" | "dnc" | "throttle" | "dedup";
}

export const guardrailCopy: Record<GuardrailReason, GuardrailCopy> = {
  recent_contact: {
    shortLabel: "Recently contacted",
    longExplanation:
      "Skipped because this carrier was already contacted on this lane recently.",
    icon: Clock,
    category: "throttle",
  },
  daily_cap: {
    shortLabel: "Daily cap reached",
    longExplanation:
      "Skipped because the daily outreach cap for this carrier has been reached.",
    icon: Clock,
    category: "throttle",
  },
  not_approved: {
    shortLabel: "Not approved",
    longExplanation:
      "Suppressed because this carrier has not been approved for outreach on this customer.",
    icon: ShieldAlert,
    category: "compliance",
  },
  do_not_contact_lane: {
    shortLabel: "Do-not-contact (lane)",
    longExplanation:
      "Suppressed because this carrier is on the do-not-contact list for this lane.",
    icon: UserX,
    category: "dnc",
  },
  customer_carrier_blocked: {
    shortLabel: "Customer-carrier blocked",
    longExplanation:
      "Suppressed because the customer has explicitly blocked this carrier.",
    icon: ShieldAlert,
    category: "compliance",
  },
  throttled_too_soon: {
    shortLabel: "Throttled (too soon)",
    longExplanation:
      "Skipped because the minimum interval between outreaches has not yet elapsed.",
    icon: Clock,
    category: "throttle",
  },
  throttled_daily_cap: {
    shortLabel: "Throttled (daily cap)",
    longExplanation:
      "Skipped because today's outreach cap for this carrier or lane has been reached.",
    icon: Clock,
    category: "throttle",
  },
  dedup_skipped: {
    shortLabel: "Skipped (dedup)",
    longExplanation:
      "Skipped because an equivalent outreach was already sent in this batch.",
    icon: Repeat,
    category: "dedup",
  },
};

export function getGuardrailCopy(reason: GuardrailReason): GuardrailCopy {
  return guardrailCopy[reason];
}

export function isGuardrailReason(s: unknown): s is GuardrailReason {
  return typeof s === "string" && s in guardrailCopy;
}
