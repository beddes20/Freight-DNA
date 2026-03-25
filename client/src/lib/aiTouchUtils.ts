interface AiInsights {
  hasFollowUp: boolean;
  followUpTitle: string | null;
  followUpDueDays: number | null;
  competitors: string[];
  keyIntel: string | null;
  suggestMeaningful: boolean;
}

interface AutoTask { title: string; dueDate?: string }

export function buildAiToasts(
  aiInsights: AiInsights | null | undefined,
  autoTask: AutoTask | null | undefined,
  toast: (opts: { title: string; description?: string }) => void,
) {
  if (!aiInsights) return;

  if (autoTask) {
    toast({
      title: "Follow-up task created",
      description: autoTask.title + (autoTask.dueDate ? ` · Due ${autoTask.dueDate}` : ""),
    });
  }

  if (aiInsights.competitors.length > 0) {
    toast({
      title: "Competitor mentioned",
      description: aiInsights.competitors.join(", "),
    });
  }

  if (aiInsights.keyIntel) {
    toast({
      title: "Key intel flagged",
      description: aiInsights.keyIntel,
    });
  }
}
