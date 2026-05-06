import cron from "node-cron";
import { aggregateSuggestionFeedback } from "./services/suggestionFeedbackLearningService";

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [suggestion-feedback-learning-scheduler] ${message}`);
}

/**
 * Task #552: Nightly recompute of the suggestion feedback rollup table.
 * Runs at 02:30 America/Chicago (just after the conversation auto-archive
 * sweep at 02:00, so any threads we just archived are still attributable
 * to the right account during the lookback window).
 */
export function initSuggestionFeedbackLearningScheduler(): void {
  const cronExpression = "30 2 * * *";
  cron.schedule(cronExpression, () => {
    aggregateSuggestionFeedback().catch(err =>
      logMessage(`Aggregation error: ${err instanceof Error ? err.message : String(err)}`)
    );
  }, { timezone: "America/Chicago" });
  logMessage(`Suggestion feedback learning scheduler initialized (cron: ${cronExpression})`);
}
