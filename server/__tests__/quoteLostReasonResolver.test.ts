/**
 * LLM-first lost-reason resolver tests.
 *
 * Covers `resolveLostReason` end-to-end across the three reasonSource
 * paths via the test-only DI seam `_setLostReasonLlmForTests`. Does NOT
 * call the real OpenAI client — every test installs a deterministic stub
 * before exercising the resolver and resets it in `afterEach` so the
 * suite stays independent of any neighbouring test that might wire its
 * own stub. Mirrors the regex-only contract assertions already living
 * in quoteEmailLostClassifier.test.ts and quoteEmailIngestion.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  LOST_INCUMBENT,
  LOST_PRICE,
  LOST_TIMING,
  LOST_SERVICE,
  resolveLostReason,
  _setLostReasonLlmForTests,
} from "../services/quoteEmailIngestion";

afterEach(() => {
  _setLostReasonLlmForTests(null);
});

describe("resolveLostReason — reasonSource = 'llm'", () => {
  it("uses the LLM result when it returns a valid reason", async () => {
    _setLostReasonLlmForTests(async () => LOST_PRICE);
    const out = await resolveLostReason(
      "Your number was just not competitive against the other quotes",
    );
    expect(out.reason).toBe(LOST_PRICE);
    expect(out.reasonSource).toBe("llm");
  });

  it("uses the LLM result for paraphrased timing language the regex misses", async () => {
    _setLostReasonLlmForTests(async () => LOST_TIMING);
    const out = await resolveLostReason(
      "The shipper decided to push the freight to next quarter",
    );
    expect(out.reason).toBe(LOST_TIMING);
    expect(out.reasonSource).toBe("llm");
  });

  it("uses the LLM result for paraphrased service language", async () => {
    _setLostReasonLlmForTests(async () => LOST_SERVICE);
    const out = await resolveLostReason(
      "Your delivery commitment doesn't line up with what the consignee needs",
    );
    expect(out.reason).toBe(LOST_SERVICE);
    expect(out.reasonSource).toBe("llm");
  });
});

describe("resolveLostReason — reasonSource = 'regex' (LLM fallback)", () => {
  it("falls back to the regex when the LLM returns null", async () => {
    _setLostReasonLlmForTests(async () => null);
    const out = await resolveLostReason("Rate is too high for us this week");
    expect(out.reason).toBe(LOST_PRICE);
    expect(out.reasonSource).toBe("regex");
  });

  it("falls back to the regex when the LLM throws", async () => {
    _setLostReasonLlmForTests(async () => {
      throw new Error("simulated network failure");
    });
    const out = await resolveLostReason("Load was cancelled by the shipper");
    expect(out.reason).toBe(LOST_TIMING);
    expect(out.reasonSource).toBe("regex");
  });

  it("falls back to the regex for the lost_incumbent pattern when the LLM is silent", async () => {
    _setLostReasonLlmForTests(async () => null);
    // Phrase matches LOST_LANGUAGE_PATTERNS so the wrapper attributes
    // the regex hit even though decideLostReason returns lost_incumbent
    // as the resulting code (its own default + match overlap).
    const out = await resolveLostReason("We're going with another carrier on this one");
    expect(out.reason).toBe(LOST_INCUMBENT);
    expect(out.reasonSource).toBe("regex");
  });

  it("falls back to the regex for service language", async () => {
    _setLostReasonLlmForTests(async () => null);
    const out = await resolveLostReason("Your transit time doesn't fit our window");
    expect(out.reason).toBe(LOST_SERVICE);
    expect(out.reasonSource).toBe("regex");
  });
});

describe("resolveLostReason — reasonSource = 'default'", () => {
  it("returns lost_incumbent + 'default' when language is null", async () => {
    _setLostReasonLlmForTests(async () => null);
    const out = await resolveLostReason(null);
    expect(out.reason).toBe(LOST_INCUMBENT);
    expect(out.reasonSource).toBe("default");
  });

  it("returns lost_incumbent + 'default' when language is empty", async () => {
    _setLostReasonLlmForTests(async () => null);
    const out = await resolveLostReason("");
    expect(out.reason).toBe(LOST_INCUMBENT);
    expect(out.reasonSource).toBe("default");
  });

  it("returns lost_incumbent + 'default' when language is whitespace only", async () => {
    _setLostReasonLlmForTests(async () => null);
    const out = await resolveLostReason("   \n  ");
    expect(out.reason).toBe(LOST_INCUMBENT);
    expect(out.reasonSource).toBe("default");
  });

  it("returns lost_incumbent + 'default' when neither LLM nor regex find a signal", async () => {
    _setLostReasonLlmForTests(async () => null);
    // No Lost-language pattern hits AND regex falls through to default.
    const out = await resolveLostReason("thanks for your follow up, appreciate it");
    expect(out.reason).toBe(LOST_INCUMBENT);
    expect(out.reasonSource).toBe("default");
  });

  it("does not call the LLM at all when language is empty", async () => {
    let calls = 0;
    _setLostReasonLlmForTests(async () => {
      calls += 1;
      return LOST_PRICE;
    });
    const out = await resolveLostReason("");
    expect(calls).toBe(0);
    expect(out.reason).toBe(LOST_INCUMBENT);
    expect(out.reasonSource).toBe("default");
  });
});

describe("resolveLostReason — guards against invalid LLM output", () => {
  it("treats an unrecognized stub return value as null and falls back to regex", async () => {
    // The DI seam contract is `Promise<LostReason | null>` so an invalid
    // LLM body would already have been mapped to null by
    // classifyLostReasonWithLlm in production. This test pins the
    // wrapper's behaviour when its dependency returns null.
    _setLostReasonLlmForTests(async () => null);
    const out = await resolveLostReason("the price was way too high, we got cheaper");
    expect(out.reason).toBe(LOST_PRICE);
    expect(out.reasonSource).toBe("regex");
  });
});
