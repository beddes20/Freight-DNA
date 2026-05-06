import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

export interface AiTouchpointInsights {
  hasFollowUp: boolean;
  followUpTitle: string | null;
  followUpDueDays: number | null;
  competitors: string[];
  keyIntel: string | null;
  suggestMeaningful: boolean;
}

const EMPTY: AiTouchpointInsights = {
  hasFollowUp: false,
  followUpTitle: null,
  followUpDueDays: null,
  competitors: [],
  keyIntel: null,
  suggestMeaningful: false,
};

export async function analyzeTouchpointNote(
  notes: string,
  contactName?: string | null,
  companyName?: string | null,
): Promise<AiTouchpointInsights> {
  if (!notes || notes.trim().length < 15) return EMPTY;

  const context = [
    contactName ? `Contact: ${contactName}` : null,
    companyName ? `Company: ${companyName}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const prompt = `You are a CRM assistant for a freight brokerage sales team. Analyze this touchpoint note and extract structured information.

${context ? `Context: ${context}` : ""}
Note: "${notes}"

Respond with valid JSON only (no markdown, no explanation):
{
  "hasFollowUp": boolean,
  "followUpTitle": "short task title if there is a follow-up commitment, else null",
  "followUpDueDays": number of days from today until due (7 for 'next week', 1 for 'tomorrow', 30 for 'next month', 14 for 'in two weeks', null if no follow-up),
  "competitors": ["list of competitor broker names mentioned, e.g. CH Robinson, Echo Global, Coyote"],
  "keyIntel": "one-sentence summary of strategically useful info (bid timelines, freight needs, process info, rates, decision maker info), or null if nothing significant",
  "suggestMeaningful": boolean (true if the conversation involved real freight needs, rates, opportunities, or strategy — not just a check-in)
}`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.1,
    });

    const raw = resp.choices[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(raw);

    return {
      hasFollowUp: !!parsed.hasFollowUp,
      followUpTitle: typeof parsed.followUpTitle === "string" ? parsed.followUpTitle : null,
      followUpDueDays: typeof parsed.followUpDueDays === "number" ? parsed.followUpDueDays : null,
      competitors: Array.isArray(parsed.competitors) ? parsed.competitors.filter((c: any) => typeof c === "string") : [],
      keyIntel: typeof parsed.keyIntel === "string" ? parsed.keyIntel : null,
      suggestMeaningful: !!parsed.suggestMeaningful,
    };
  } catch (err) {
    // Log full stack so transient OpenAI / JSON-parse failures are visible
    // instead of silently degrading to EMPTY. Callers still get EMPTY.
    console.error(
      "[analyzeTouchpointNote] failed",
      contactName ? `contact=${contactName}` : "",
      companyName ? `company=${companyName}` : "",
      "—",
      err instanceof Error ? err.stack : err,
    );
    return EMPTY;
  }
}
