import OpenAI from "openai";

let _client: OpenAI | null = null;

export function getAgentOpenAI(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });
  }
  return _client;
}

export const AGENT_MODELS = {
  reasoning: "gpt-4o",
  fast: "gpt-4o-mini",
  embedding: "text-embedding-3-small",
} as const;
