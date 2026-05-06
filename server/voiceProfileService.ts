import { eq, and, desc } from "drizzle-orm";
import { emailMessages } from "@shared/schema";
import { storage, db } from "./storage";

export interface VoiceProfile {
  userId: string;
  avgSentenceLength: number;
  greetingPatterns: string[];
  signOffPatterns: string[];
  toneDescriptors: string[];
  commonPhrases: string[];
  sampleCount: number;
  cachedAt: string;
}

const VOICE_PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const profileCache = new Map<string, { profile: VoiceProfile; fetchedAt: number }>();

function cacheKey(userId: string): string {
  return `voice_profile:${userId}`;
}

export async function getVoiceProfile(userId: string, userEmail: string, orgId: string): Promise<VoiceProfile | null> {
  const memCached = profileCache.get(userId);
  if (memCached && Date.now() - memCached.fetchedAt < VOICE_PROFILE_TTL_MS) {
    return memCached.profile;
  }

  const stored = await storage.getSetting(cacheKey(userId));
  if (stored) {
    try {
      const profile: VoiceProfile = JSON.parse(stored);
      const cachedTime = new Date(profile.cachedAt).getTime();
      if (Date.now() - cachedTime < VOICE_PROFILE_TTL_MS) {
        profileCache.set(userId, { profile, fetchedAt: Date.now() });
        return profile;
      }
    } catch {}
  }

  return buildAndCacheProfile(userId, userEmail, orgId);
}

export async function refreshVoiceProfile(userId: string, userEmail: string, orgId: string): Promise<VoiceProfile | null> {
  profileCache.delete(userId);
  return buildAndCacheProfile(userId, userEmail, orgId);
}

async function buildAndCacheProfile(userId: string, userEmail: string, orgId: string): Promise<VoiceProfile | null> {
  const outboundEmails = await db.select({
    body: emailMessages.body,
    subject: emailMessages.subject,
  })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.orgId, orgId),
        eq(emailMessages.direction, "outbound"),
        eq(emailMessages.fromEmail, userEmail),
      )
    )
    .orderBy(desc(emailMessages.createdAt))
    .limit(50);

  if (outboundEmails.length < 3) {
    return null;
  }

  const profile = analyzeEmails(userId, outboundEmails);

  await storage.setSetting(cacheKey(userId), JSON.stringify(profile));
  profileCache.set(userId, { profile, fetchedAt: Date.now() });

  return profile;
}

function analyzeEmails(userId: string, emails: { body: string | null; subject: string | null }[]): VoiceProfile {
  const greetings = new Map<string, number>();
  const signOffs = new Map<string, number>();
  const phrases = new Map<string, number>();
  let totalSentences = 0;
  let totalSentenceLength = 0;

  const toneSignals = {
    casual: 0,
    formal: 0,
    friendly: 0,
    direct: 0,
    enthusiastic: 0,
  };

  for (const email of emails) {
    const body = (email.body || "").trim();
    if (!body) continue;

    const cleanBody = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const lines = cleanBody.split(/\n/).map(l => l.trim()).filter(Boolean);

    if (lines.length > 0) {
      const firstLine = lines[0].toLowerCase();
      const greetingMatch = firstLine.match(/^(hey|hi|hello|good morning|good afternoon|good evening|howdy|hope this finds you|hope you're doing|hope all is)[^.!?\n]*/i);
      if (greetingMatch) {
        const g = greetingMatch[0].trim();
        greetings.set(g, (greetings.get(g) || 0) + 1);
      }
    }

    const signBreaks = [/\n--\s*\n/, /\n_{3,}/, /\nSent from\b/i, /\nGet Outlook\b/i];
    let bodyForSignOff = cleanBody;
    for (const pat of signBreaks) {
      const idx = bodyForSignOff.search(pat);
      if (idx > 0) bodyForSignOff = bodyForSignOff.slice(0, idx);
    }
    const signOffLines = bodyForSignOff.split(/\n/).map(l => l.trim()).filter(Boolean);
    if (signOffLines.length > 1) {
      const lastLine = signOffLines[signOffLines.length - 1];
      const signOffMatch = lastLine.match(/^(thanks|thank you|best|regards|cheers|talk soon|looking forward|let me know|take care|sincerely|respectfully|warm regards)[^.!?\n]*/i);
      if (signOffMatch) {
        const s = signOffMatch[0].trim();
        signOffs.set(s, (signOffs.get(s) || 0) + 1);
      }
    }

    const sentences = cleanBody.split(/[.!?]+/).filter(s => s.trim().length > 5);
    for (const sent of sentences) {
      const words = sent.trim().split(/\s+/);
      totalSentences++;
      totalSentenceLength += words.length;
    }

    if (/\bhey\b|!\s|\bgotta\b|\bwanna\b|\bgunna\b|\bcool\b|\bawesome\b/i.test(cleanBody)) toneSignals.casual++;
    if (/\bplease\b.*\bkind\b|\bregards\b|\bsincerely\b|\bper our\b|\bpursuant\b/i.test(cleanBody)) toneSignals.formal++;
    if (/\bhope\b|\bexcited\b|\blooking forward\b|\bgood to\b|\bgreat to\b/i.test(cleanBody)) toneSignals.friendly++;
    if (/\blet me know\b|\bcan you\b|\bneed\b|\basap\b|\bimmediately\b/i.test(cleanBody)) toneSignals.direct++;
    if (/!\s|!$|\bexcited\b|\bamazing\b|\bfantastic\b|\blove\b/i.test(cleanBody)) toneSignals.enthusiastic++;

    const phrasePatterns = [
      /checking (?:in|to see)/gi,
      /wanted to (?:follow up|reach out|touch base|check in)/gi,
      /let me know (?:if|what|how)/gi,
      /looking forward to/gi,
      /happy to (?:discuss|help|chat|talk)/gi,
      /does that (?:work|fit|make sense)/gi,
      /i'd be glad to/gi,
      /would love to/gi,
      /just (?:wanted|checking|following)/gi,
      /appreciate your/gi,
    ];
    for (const pat of phrasePatterns) {
      const matches = cleanBody.match(pat);
      if (matches) {
        for (const m of matches) {
          const p = m.toLowerCase().trim();
          phrases.set(p, (phrases.get(p) || 0) + 1);
        }
      }
    }
  }

  const topGreetings = [...greetings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
  const topSignOffs = [...signOffs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
  const topPhrases = [...phrases.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p);

  const toneDescriptors: string[] = [];
  const sorted = Object.entries(toneSignals).sort((a, b) => b[1] - a[1]);
  for (const [tone, count] of sorted) {
    if (count > 0 && toneDescriptors.length < 3) toneDescriptors.push(tone);
  }

  return {
    userId,
    avgSentenceLength: totalSentences > 0 ? Math.round(totalSentenceLength / totalSentences) : 12,
    greetingPatterns: topGreetings.length > 0 ? topGreetings : ["Hey"],
    signOffPatterns: topSignOffs.length > 0 ? topSignOffs : ["Thanks"],
    toneDescriptors: toneDescriptors.length > 0 ? toneDescriptors : ["direct", "friendly"],
    commonPhrases: topPhrases,
    sampleCount: emails.length,
    cachedAt: new Date().toISOString(),
  };
}
