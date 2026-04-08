/**
 * AI Helpers — thin wrapper around OpenAI for text generation.
 * Used by lane carrier outreach routes and other server modules.
 */

import OpenAI from "openai";

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

/**
 * Send a prompt to GPT-4o-mini and return the text response.
 * Throws if the API call fails or no API key is configured.
 */
export async function callAI(prompt: string, maxTokens = 400): Promise<string> {
  const openai = getOpenAI();
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.5,
  });
  return resp.choices[0]?.message?.content?.trim() ?? "";
}
