import { db } from "../storage";
import { agentActivity, type InsertAgentActivity } from "@shared/schema";

/**
 * Append a row to agent_activity. Fire-and-forget — never let logging
 * failures break the agent loop.
 */
export async function logActivity(entry: InsertAgentActivity): Promise<void> {
  try {
    await db.insert(agentActivity).values(entry);
  } catch (err) {
    console.error("[agent.activity] log failed:", err);
  }
}
