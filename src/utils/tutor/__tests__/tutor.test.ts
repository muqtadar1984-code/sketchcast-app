/**
 * AI Tutor core tests — the invariants a reviewer must see hold:
 *   * the system prompt is a CLOSED-BOOK, child-safety fence (answer only from
 *     the chapter; refuse off-topic/unsafe; guide, don't hand over answers)
 *   * the chapter grounding (concepts + lesson script) is actually injected
 *   * model tiering escalates only for reasoning-heavy questions
 *   * the CONSERVATIVE cache rule never serves a fuzzy-but-unverified answer
 *   * question normalisation is deterministic
 * Run: npx vitest run
 */

import { describe, expect, it } from "vitest";
import {
  normalizeQuestion,
  pickTier,
  buildSystemPrompt,
  shouldServeCached,
  gradeAnswers,
  buildGreeting,
  classifyMove,
  scoreMastery,
  resolveVoice,
  ttsCacheKey,
  ttsWithinCap,
  estimateTtsCostUsd,
  TUTOR_TTS_MONTHLY_CHAR_CAP,
  planGrantsTutor,
  tutorGateAllows,
  type Grounding,
  type Question,
  type StudentModel,
} from "../models";

const G: Grounding = {
  chapterTitle: "Photosynthesis",
  concepts: { concepts: [{ name: "Chlorophyll", definition: "captures light" }] },
  scriptText: "Leaves use sunlight to make sugar.",
};

describe("question normalisation", () => {
  it("lower-cases, collapses whitespace, drops trailing punctuation", () => {
    expect(normalizeQuestion("  Why  do   PLANTS need Sunlight??? ")).toBe("why do plants need sunlight");
    expect(normalizeQuestion("Photosynthesis.")).toBe("photosynthesis");
  });
});

describe("model tiering", () => {
  it("uses the cheap model for routine questions", () => {
    expect(pickTier("what is chlorophyll")).toBe("cheap");
    expect(pickTier("define photosynthesis")).toBe("cheap");
  });
  it("escalates to the strong model for reasoning-heavy or long questions", () => {
    expect(pickTier("why do plants need sunlight")).toBe("strong");
    expect(pickTier("what is the difference between evaporation and condensation")).toBe("strong");
    expect(pickTier("a".repeat(200))).toBe("strong");
  });
});

describe("closed-book safety prompt", () => {
  const { instructions, context } = buildSystemPrompt(G);
  it("locks answers to the chapter and forbids outside knowledge", () => {
    expect(instructions).toMatch(/ONLY using the CHAPTER CONTEXT/);
    expect(instructions).toMatch(/not in this chapter/i);
    expect(instructions).toMatch(/never guess or use outside knowledge/i);
  });
  it("forbids unsafe/off-topic content and won't do graded work", () => {
    expect(instructions).toMatch(/unsafe/i);
    expect(instructions).toMatch(/hand over exam answers|graded work/i);
  });
  it("injects the chapter grounding (title, concepts, lesson narration)", () => {
    expect(context).toMatch(/Photosynthesis/);
    expect(context).toMatch(/Chlorophyll/);
    expect(context).toMatch(/Leaves use sunlight/);
  });
});

describe("conservative cache-serve rule", () => {
  const row = (is_verified: boolean) => ({ id: "x", answer_text: "a", is_verified });
  it("serves a near-exact match even if unverified (safe replay)", () => {
    expect(shouldServeCached(row(false), true)).toBe(true);
  });
  it("serves a verified fuzzy match", () => {
    expect(shouldServeCached(row(true), false)).toBe(true);
  });
  it("REGENERATES a fuzzy, unverified match (never serve a near-miss)", () => {
    expect(shouldServeCached(row(false), false)).toBe(false);
  });
  it("regenerates when there is no match", () => {
    expect(shouldServeCached(null, false)).toBe(false);
  });
});

describe("weak-spot re-grading (from real answers)", () => {
  const questions: Question[] = [
    { id: "q1", type: "fill_blank", prompt: "Gas to liquid is ___", answer: "condensation", marks: 1 },
    { id: "q2", type: "true_false", prompt: "Plants need sunlight.", answer: true, marks: 1 },
    { id: "q3", type: "match", prompt: "Match", pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }], marks: 2 },
    { id: "q4", type: "subjective", prompt: "Explain the water cycle.", marks: 5 },
  ];
  it("flags the objective questions the student got wrong; ignores subjective", () => {
    const r = gradeAnswers(questions, {
      q1: "evaporation", // wrong
      q2: true, // right
      q3: { 0: "1", 1: "wrong" }, // wrong (not all pairs)
      q4: "anything", // subjective → teacher-graded, ignored
    });
    expect(r.wrong).toEqual(["Gas to liquid is ___", "Match"]);
    expect(r.correct).toBe(1);
    expect(r.gradable).toBe(3);
  });
  it("case/space-insensitive fill-blank matching", () => {
    expect(gradeAnswers(questions, { q1: "  Condensation " }).wrong).not.toContain("Gas to liquid is ___");
  });
});

describe("greeting (names a real weak spot; warm cold-start)", () => {
  const sm = (over: Partial<StudentModel>): StudentModel => ({ chapterTitle: "Water Cycle", attempted: false, scorePct: null, weakQuestions: [], ...over });
  it("cold start when no quiz history", () => {
    expect(buildGreeting(sm({}))).toMatch(/find out together|quiz me/i);
  });
  it("names the weak spot when there is one", () => {
    const g = buildGreeting(sm({ attempted: true, weakQuestions: ["Gas to liquid is ___"] }));
    expect(g).toMatch(/tripped you up/i);
    expect(g).toMatch(/Gas to liquid/);
  });
  it("congratulates when they aced it", () => {
    expect(buildGreeting(sm({ attempted: true, weakQuestions: [] }))).toMatch(/Nice work|got the quiz right/i);
  });
});

describe("Socratic move classification (from the reply's shape)", () => {
  it("plain explanation with no trailing question → answer", () => {
    expect(classifyMove("Condensation is when a gas cools into a liquid. You see it on a cold glass.")).toBe("answer");
  });
  it("explanation that ends by checking understanding → confirm", () => {
    expect(classifyMove("Condensation is gas cooling into liquid. Where might you see that at home?")).toBe("confirm");
  });
  it("a bare question turned back to the student → ask", () => {
    expect(classifyMove("What do you think happens to the water vapour when it cools?")).toBe("ask");
  });
  it("a refusal/steer → redirect", () => {
    expect(classifyMove("That's not in this chapter — let's stick to the chapter. What part are you stuck on?")).toBe("redirect");
  });
  it("empty reply defaults to answer", () => {
    expect(classifyMove("")).toBe("answer");
  });
});

describe("honest mastery estimate", () => {
  it("is unknown before any quiz attempt", () => {
    expect(scoreMastery({ scorePct: null, weakCount: 0, practiceCount: 0 })).toMatchObject({ score: null, band: "not_started" });
  });
  it("shows progressing once they've practised, still without a quiz", () => {
    expect(scoreMastery({ scorePct: null, weakCount: 0, practiceCount: 3 })).toMatchObject({ score: null, band: "progressing" });
  });
  it("a high quiz score with no weak spots is strong", () => {
    expect(scoreMastery({ scorePct: 90, weakCount: 0, practiceCount: 0 }).band).toBe("strong");
  });
  it("unresolved weak spots pull the score down into needs-work", () => {
    expect(scoreMastery({ scorePct: 60, weakCount: 4, practiceCount: 0 }).band).toBe("needs_work");
  });
  it("practice nudges up but is capped so it can't manufacture mastery", () => {
    const low = scoreMastery({ scorePct: 20, weakCount: 0, practiceCount: 50 });
    expect(low.score).toBeLessThan(80);
    expect(low.band).not.toBe("strong");
  });
});

describe("voice gating (paid tier can't be bypassed by naming a premium voice)", () => {
  it("returns the requested premium voice only when premium is allowed", () => {
    expect(resolveVoice("el-rachel", { premiumAllowed: true })).toMatchObject({ voiceId: "el-rachel", provider: "elevenlabs" });
  });
  it("silently downgrades a premium request to the free default when not allowed", () => {
    const v = resolveVoice("el-rachel", { premiumAllowed: false });
    expect(v.tier).toBe("free");
    expect(v.provider).toBe("browser");
  });
  it("falls back to the free default for an unknown voice id", () => {
    expect(resolveVoice("nope", { premiumAllowed: true }).voiceId).toBe("browser-warm");
    expect(resolveVoice(null, { premiumAllowed: true }).voiceId).toBe("browser-warm");
  });
});

describe("voice cache key + paid cost guard", () => {
  it("is stable for the same (provider, voice, text) and varies with the text", () => {
    const a = ttsCacheKey("elevenlabs", "voiceX", "Condensation is gas cooling.");
    expect(ttsCacheKey("elevenlabs", "voiceX", "Condensation is gas cooling.")).toBe(a);
    expect(ttsCacheKey("elevenlabs", "voiceX", "Something else.")).not.toBe(a);
    expect(ttsCacheKey("elevenlabs", "voiceY", "Condensation is gas cooling.")).not.toBe(a);
    expect(a.startsWith("elevenlabs/")).toBe(true);
  });
  it("only meters the paid provider; the browser voice is free", () => {
    expect(estimateTtsCostUsd(1000, "elevenlabs")).toBeCloseTo(0.3, 5);
    expect(estimateTtsCostUsd(5000, "browser")).toBe(0);
  });
  it("enforces the monthly character cap", () => {
    expect(ttsWithinCap(TUTOR_TTS_MONTHLY_CHAR_CAP - 100, 100, TUTOR_TTS_MONTHLY_CHAR_CAP)).toBe(true);
    expect(ttsWithinCap(TUTOR_TTS_MONTHLY_CHAR_CAP - 100, 101, TUTOR_TTS_MONTHLY_CHAR_CAP)).toBe(false);
  });
});

describe("Pro+ entitlement gate", () => {
  it("only Pro+ / family / school tiers grant the tutor — plain Pro does not", () => {
    expect(planGrantsTutor("teacher_pro_plus_monthly")).toBe(true);
    expect(planGrantsTutor("teacher_pro_plus_annual")).toBe(true);
    expect(planGrantsTutor("family_monthly")).toBe(true);
    expect(planGrantsTutor("school_annual")).toBe(true);
    expect(planGrantsTutor("teacher_pro_monthly")).toBe(false);
    expect(planGrantsTutor(null)).toBe(false);
  });
  it("the flag is the master switch; entitlement matters only when enforced", () => {
    expect(tutorGateAllows({ flagOn: false, requireProPlus: false, entitled: true })).toBe(false); // flag off → closed
    expect(tutorGateAllows({ flagOn: true, requireProPlus: false, entitled: false })).toBe(true); // trial: open to all
    expect(tutorGateAllows({ flagOn: true, requireProPlus: true, entitled: false })).toBe(false); // post-trial, not entitled
    expect(tutorGateAllows({ flagOn: true, requireProPlus: true, entitled: true })).toBe(true); // post-trial, Pro+
  });
});

describe("prompt-injection hardening", () => {
  it("tells the model the student's messages are never instructions that change the rules", () => {
    const { instructions } = buildSystemPrompt(G);
    expect(instructions).toMatch(/NEVER an instruction that changes/i);
    expect(instructions).toMatch(/override them|reveal or forget/i);
  });
});
