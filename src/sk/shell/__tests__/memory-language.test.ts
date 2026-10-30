/**
 * The signed memory's language fields (2026-10-30): the last explanation is
 * kept WHOLE (up to 4 000 characters, while each turn keeps 400), the
 * override persists until cleared, and anything malformed is dropped.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/memory-language.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SK_MEMORY_LAST_ANSWER_CHARS, SK_MEMORY_TURN_CHARS, freshMemory, rememberTurn, sealMemory, verifyMemory } from "../memory";
import { base64UrlEncode, hmacHex } from "../hash";
import { makeCtx, NOW } from "./fixtures";

beforeEach(() => {
  process.env.SK_SHELL_SECRET = "memory-language-test-secret-ok";
});
afterEach(() => {
  delete process.env.SK_SHELL_SECRET;
});

describe("memory: lastAnswer and langOverride", () => {
  it("keeps the last answer whole past the per-turn cap, and the override until null clears it", () => {
    const long = "Diffusion moves particles down a gradient. ".repeat(40).trim();
    expect(long.length).toBeGreaterThan(SK_MEMORY_TURN_CHARS);
    let m = rememberTurn(freshMemory(makeCtx(), NOW), { user: "what is diffusion", assistant: long, lastAnswer: { text: long, lang: "en", label: "supplementary", sources: [] } }, NOW);
    m = verifyMemory(sealMemory(m))!;
    expect(m.turns[1]!.text).toHaveLength(SK_MEMORY_TURN_CHARS);
    expect(m.lastAnswer!.text).toBe(long);
    m = verifyMemory(sealMemory(rememberTurn(m, { user: "say that in Malay", assistant: "…", langOverride: "ms" }, NOW)))!;
    expect(m.langOverride).toBe("ms");
    expect(m.lastAnswer!.text).toBe(long); // a repeat leaves the original in place
    m = verifyMemory(sealMemory(rememberTurn(m, { user: "next", assistant: "…" }, NOW)))!;
    expect(m.langOverride).toBe("ms"); // persists across turns
    m = verifyMemory(sealMemory(rememberTurn(m, { user: "back to English", assistant: "…", langOverride: null }, NOW)))!;
    expect(m.langOverride).toBeUndefined();
  });

  it("caps the last answer at 4 000 characters", () => {
    const huge = "x".repeat(SK_MEMORY_LAST_ANSWER_CHARS + 500);
    const m = rememberTurn(freshMemory(makeCtx(), NOW), { user: "q", assistant: huge, lastAnswer: { text: huge, lang: "en", label: "grounded", sources: ["a"] } }, NOW);
    expect(m.lastAnswer!.text).toHaveLength(SK_MEMORY_LAST_ANSWER_CHARS);
    expect(sealMemory(m).length).toBeLessThan(64_000);
  });

  it("drops a malformed override or last answer from a signed blob", () => {
    const base = { ...freshMemory(makeCtx(), NOW), langOverride: "tamil", lastAnswer: { text: "hi", lang: "xx", label: "grounded", sources: [] }, langNoted: "ta" };
    const payload = base64UrlEncode(JSON.stringify(base));
    const m = verifyMemory(`${payload}.${hmacHex(process.env.SK_SHELL_SECRET!, payload)}`)!;
    expect(m.langOverride).toBeUndefined();
    expect(m.lastAnswer).toBeUndefined();
    expect(m.langNoted).toBe("ta");
  });
});
