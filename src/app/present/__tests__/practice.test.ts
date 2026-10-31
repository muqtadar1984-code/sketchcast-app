/**
 * Worksheet practice on the student Board — the client's pure half (phase 2):
 * the `sk:learner-gap` hand-off payload (the contract the phase-3 teaching
 * builder listens for), folding the server's replies into per-question state,
 * the end-of-worksheet score line, and the question type the answer box needs.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/practice.test.ts
 */
import { describe, expect, it } from "vitest";
import { answerText, applyReply, dispatchGap, emptyQuestion, endLine, gapDetail, keyLine, LEARNER_GAP_EVENT, practiceKey, practiceSummary, rungReached, type PracticeReply } from "../practice";
import { learnerQuestionCards } from "../text-card";

const R = (o: Partial<PracticeReply>): PracticeReply => ({ outcome: "incorrect", correct: false, attemptNo: 1, wrong: 1, rung: "hint", help: { rung: "hint", text: "Think.", source: "model" }, answer: null, done: false, gap: null, concept: null, ...o });

describe("sk:learner-gap — the hand-off to SK's teaching", () => {
  it("the payload is exactly the agreed contract", () => {
    const d = gapDetail({ generationId: "g", questionId: "q2", questionText: "Animal cells have a cell wall.", concept: "cells", attempts: 2, lastAnswer: "true", reason: "wrong_twice" });
    expect(d).toEqual({ generationId: "g", questionId: "q2", questionText: "Animal cells have a cell wall.", concept: "cells", attempts: 2, lastAnswer: "true", reason: "wrong_twice" });
    expect(Object.keys(d).sort()).toEqual(["attempts", "concept", "generationId", "lastAnswer", "questionId", "questionText", "reason"]);
  });

  it("missing concept / last answer are null, never undefined", () => {
    const d = gapDetail({ generationId: "g", questionId: "q1", questionText: "?", attempts: 0, reason: "asked_help" });
    expect(d.concept).toBeNull();
    expect(d.lastAnswer).toBeNull();
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it("dispatchGap fires a CustomEvent named sk:learner-gap with the detail", () => {
    const target = new EventTarget();
    const got: unknown[] = [];
    target.addEventListener(LEARNER_GAP_EVENT, (e) => got.push((e as CustomEvent).detail));
    const d = gapDetail({ generationId: "g", questionId: "q1", questionText: "?", attempts: 1, lastAnswer: "x", reason: "asked_help" });
    dispatchGap(d, target);
    expect(LEARNER_GAP_EVENT).toBe("sk:learner-gap");
    expect(got).toEqual([d]);
    expect(() => dispatchGap(d, null)).not.toThrow();
  });
});

describe("per-question state", () => {
  it("folds wrong → wrong → answer → right", () => {
    let q = emptyQuestion();
    q = applyReply(q, R({}), "chloroplast");
    expect(q).toMatchObject({ attempts: 1, wrong: 1, lastAnswer: "chloroplast", done: false });
    expect(rungReached(q)).toBe("hint");
    q = applyReply(q, R({ wrong: 2, rung: "step", help: { rung: "step", text: "Step.", source: "cache" }, gap: "wrong_twice" }), "xylem");
    q = applyReply(q, R({ wrong: 3, rung: "answer", help: { rung: "answer", text: null, source: "generic" }, answer: { type: "text", value: "Chlorophyll" } }), "stomata");
    expect(rungReached(q)).toBe("answer");
    expect(q.help.map((h) => h.rung)).toEqual(["hint", "step", "answer"]);
    q = applyReply(q, R({ outcome: "correct", correct: true, rung: "none", help: null, done: true, wrong: 3 }), "Chlorophyll");
    expect(q).toMatchObject({ attempts: 4, correct: true, done: true });
  });

  it("a help tap is not an answer: attempts and lastAnswer unchanged", () => {
    const q = applyReply({ ...emptyQuestion(), attempts: 1, lastAnswer: "x" }, R({ outcome: "help", wrong: 1 }), undefined);
    expect(q).toMatchObject({ attempts: 1, lastAnswer: "x" });
  });

  it("answerText reads every answer shape", () => {
    expect(answerText(true)).toBe("true");
    expect(answerText(" a ")).toBe("a");
    expect(answerText(["x", "y"])).toBe("x | y");
    expect(answerText(undefined)).toBeNull();
  });
});

describe("the score at the end", () => {
  const qs = ["q1", "q2", "q3", "q4"].map((id, i) => ({ key: practiceKey("g", id), qtype: i === 3 ? "subjective" : "mcq" }));
  it("'7/10 · 2 hints': right answers over marked questions, written answers left out", () => {
    const st = new Map([
      [practiceKey("g", "q1"), { ...emptyQuestion(), correct: true, done: true }],
      [practiceKey("g", "q2"), { ...emptyQuestion(), correct: true, done: true, help: [{ rung: "hint" as const, text: "h", source: "model" as const }] }],
      [practiceKey("g", "q3"), { ...emptyQuestion(), answer: { type: "text" as const, value: "k" }, help: [{ rung: "hint" as const, text: null, source: "generic" as const }, { rung: "step" as const, text: null, source: "generic" as const }, { rung: "answer" as const, text: null, source: "generic" as const }] }],
      [practiceKey("g", "q4"), { ...emptyQuestion(), review: true, done: true }],
    ]);
    expect(practiceSummary(qs, st)).toEqual({ correct: 2, total: 3, hints: 4, finished: true });
  });

  it("not finished while a question is still open", () => {
    expect(practiceSummary(qs, new Map()).finished).toBe(false);
  });

  it("SK's line: well done at 70 % or better, keep going below", () => {
    const w = { wellDone: "W", keepGoing: "K" };
    expect(endLine({ correct: 7, total: 10 }, w)).toBe("W");
    expect(endLine({ correct: 6, total: 10 }, w)).toBe("K");
    expect(endLine({ correct: 0, total: 0 }, w)).toBe("K");
  });

  it("keyLine reads a revealed key", () => {
    const w = { answerTrue: "True", answerFalse: "False" };
    expect(keyLine({ type: "bool", value: false }, w)).toBe("False");
    expect(keyLine({ type: "pairs", value: [{ left: "a", right: "b" }] }, w)).toBe("a → b");
    expect(keyLine({ type: "text", value: "x" }, w)).toBe("x");
  });
});

describe("learnerQuestionCards carries the question TYPE (the answer box), never a key", () => {
  it("qtype per card; unknown types get none", () => {
    const { cards, answers } = learnerQuestionCards(
      {
        questions: [
          { id: "q1", type: "fill_blank", prompt: "A?", marks: 1 },
          { id: "q2", type: "true_false", prompt: "B?", marks: 1 },
          { id: "q3", type: "mcq", prompt: "C?", marks: 1, options: ["x", "y"] },
          { id: "q4", type: "match", prompt: "D?", marks: 2, left: ["l1", "l2"], options: ["r2", "r1"] },
          { id: "q5", type: "essay", prompt: "E?", marks: 1 },
        ],
      },
      "g",
    );
    expect(cards.map((c) => c.qtype)).toEqual(["fill_blank", "true_false", "mcq", "match", undefined]);
    expect(answers.size).toBe(0);
  });
});
