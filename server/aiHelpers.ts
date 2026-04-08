/**
 * AI Helpers — thin wrapper around OpenAI for text generation.
 * Used by lane carrier outreach routes and other server modules.
 */

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Send a prompt to GPT-4o-mini and return the text response.
 * Throws if the API call fails.
 */
export async function callAI(prompt: string, maxTokens = 400): Promise<string> {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.5,
  });
  return resp.choices[0]?.message?.content?.trim() ?? "";
}
