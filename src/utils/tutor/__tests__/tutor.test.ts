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
