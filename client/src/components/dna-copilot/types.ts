/**
 * Shared types for the DNA Copilot panel and its child components.
 * Extracted from `crm-chatbot.tsx` so the panel shell, message list,
 * message renderer, and action cards can share a single source of truth.
 */
import type { AnswerMeta } from "./answer-card";

export type CopilotMode = "docked" | "side" | "workspace";
export const MODE_STORAGE_KEY = "dna-copilot-mode";

export interface Conversation {
  id: number;
  title: string;
  createdAt: string;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  action?: {
    tool: string;
    args: Record<string, string>;
    confirmed?: boolean;
    failed?: boolean;
  };
  meta?: AnswerMeta;
  confidence?: number;
  route?: string;
  mode?: "quick" | "analytical";
  modeLabel?: string;
  isError?: boolean;
  feedback?: "up" | "down" | null;
}

export interface NudgesResponse {
  alerts: string[];
  suggestions: string[];
}

export type ReportType = "bug" | "improvement" | "feature";
