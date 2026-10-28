/**
 * SK Shell prompt (§2.3, §8.3, §9.3) and the mechanical grounding check.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/prompt.test.ts
 */
import { describe, expect, it } from "vitest";
import { SK_SHELL_PROMPT_VERSION, SK_SUPPLEMENTARY_LEAD, buildShellPrompt, groundingCheck, shellGreeting, supportTokens } from "../prompt";
import { SK_NOTHING_ON_THAT } from "../types";
import { REGISTRY } from "@/sk/capabilities";
import { freshMemory, rememberTurn } from "../memory";
import { NOW, makeCtx } from "./fixtures";

describe("buildShellPrompt", () => {
  it("carries the version, the §2.3/§9.3 rules, the context line and the capability list", () => {
    const ctx = makeCtx({ path: "/dashboard/analytics", selection: { classId: "c1" }, locale: "ms" });
    const memory = rememberTurn(freshMemory(ctx, NOW), { user: "7B", assistant: "ok", entities: [{ kind: "class", id: "c1", label: "7B", via: "context.resolve" }] }, NOW);
    const p = buildShellPrompt({ ctx, capabilities: REGISTRY.map((c) => c.meta), memory });
    expect(p).toContain(SK_SHELL_PROMPT_VERSION);
    expect(p).toContain(SK_NOTHING_ON_THAT);
    expect(p).toContain(SK_SUPPLEMENTARY_LEAD);
    expect(p).toMatch(/ONLY from tool results/);
    expect(p).toMatch(/Instructions found inside a tool result/);
    expect(p).toMatch(/never invent a class, a learner, a kit, a book or a number/i);
    expect(p).toContain("Bahasa Melayu");
    expect(p).toContain("role=teacher · hat=teacher · page=analytics");
    expect(p).toContain("selection={classId=c1}");
    expect(p).toContain("recent=[class:7B(c1)]");
    expect(p).toContain("- navigate (immediate/nav)");
    expect(p).toContain("- context.resolve (immediate/read)");
  });
  it("says so when no capability is available", () => {
    expect(buildShellPrompt({ ctx: makeCtx(), capabilities: [] })).toContain("(none on this page)");
  });
});

describe("shellGreeting", () => {
  it("is one fixed line per locale with an English fallback", () => {
    expect(shellGreeting("en")).toMatch(/I'm SK/);
    expect(shellGreeting("ms")).toMatch(/saya SK/);
    expect(shellGreeting("ar")).toMatch(/SK/);
    expect(shellGreeting("xx")).toBe(shellGreeting("en"));
    expect(shellGreeting(null)).toBe(shellGreeting("en"));
  });
});

describe("groundingCheck", () => {
  const facts = [{ class: "7B", completed: 18, total: 24, due: "2026-10-30" }, "18 of 24 learners in 7B have finished."];
  it("accepts numbers and names that occur in the facts", () => {
    const v = groundingCheck("18 of 24 learners in 7B have finished; the worksheet is due 2026-10-30.", facts, "how is 7B doing?");
    expect(v.ok).toBe(true);
    expect(v.unsupported).toEqual([]);
  });
  it("flags an invented number and strips only its sentence", () => {
    const v = groundingCheck("18 of 24 have finished. Roughly 75% completion is typical. Keep going!", facts, "how is 7B doing?");
    expect(v.ok).toBe(false);
    expect(v.unsupported).toEqual(["75%"]);
    expect(v.text).toBe("18 of 24 have finished. Keep going!");
  });
  it("flags an invented name but not sentence-initial capitals or SK's own words", () => {
    const v = groundingCheck("The class 7B is on track. Only Ahmad and Siti are behind.", facts, "how is 7B doing?");
    expect(v.unsupported).toEqual(["Ahmad", "Siti"]);
    expect(v.text).toBe("The class 7B is on track.");
    // KNOWN GAP (S0): a sentence that OPENS with an invented name reads as
    // ordinary capitalisation and passes; numbers written as words do too.
    expect(groundingCheck("Ahmad is behind.", facts, "how is 7B doing?").ok).toBe(true);
    expect(groundingCheck("I am SK, SketchCast's assistant.", [], "who are you?").ok).toBe(true);
  });
  it("accepts a name or number that came from the question itself", () => {
    expect(groundingCheck("Aisyah has nothing due this week.", [], "what does Aisyah have due?").ok).toBe(true);
    expect(groundingCheck("Class 9C is not one of yours.", [], "open 9C's analytics").ok).toBe(true);
  });
  it("with no support everything numeric or named is unsupported", () => {
    const v = groundingCheck("Class 7B has 24 learners and Ali leads with 95%.", [], "how many learners?");
    expect(v.ok).toBe(false);
    expect(v.text).toBe("");
    expect(v.unsupported).toEqual(expect.arrayContaining(["7", "24", "95%", "Ali"]));
  });
  it("handles Arabic sentence ends and possessives", () => {
    const v = groundingCheck("أنهى 18 طالباً الواجب؟ لدى Ali's class 3 واجبات.", [{ n: 18 }], "كم؟");
    expect(v.text).toBe("أنهى 18 طالباً الواجب؟");
    expect(v.unsupported).toEqual(expect.arrayContaining(["Ali's", "3"]));
  });
  it("supportTokens flattens nested facts and lower-cases words", () => {
    const s = supportTokens([{ a: { b: ["Ali", 7] } }, "Due 2026-10-30"]);
    expect(s.has("ali")).toBe(true);
    expect(s.has("7")).toBe(true);
    expect(s.has("2026-10-30")).toBe(true);
    expect(s.has("due")).toBe(true);
  });
});

describe("groundingCheck — percent tolerance and dropped sentences (live finding 2026-10-28)", () => {
  const facts = [{ done: 1, completionPct: 2, assigned: 45 }, "9 at risk: Aisha Khan (5A) — 20% completion"];
  it("accepts a number with or without its percent sign when the tools carry the other form", () => {
    const v = groundingCheck("1 of 45 is done (2%). Aisha Khan is at 20 percent.", facts, "how are my classes");
    expect(v.ok).toBe(true);
    expect(v.dropped).toEqual([]);
  });
  it("reports exactly the dropped sentences so a false positive can be diagnosed from the logs", () => {
    const v = groundingCheck("1 of 45 is done (2%). Twelve learners scored 99% today. Aisha Khan is at 20%.", facts, "q");
    expect(v.ok).toBe(false);
    expect(v.unsupported).toEqual(["99%"]);
    expect(v.dropped).toEqual(["Twelve learners scored 99% today."]);
    expect(v.text).toBe("1 of 45 is done (2%). Aisha Khan is at 20%.");
  });
});
