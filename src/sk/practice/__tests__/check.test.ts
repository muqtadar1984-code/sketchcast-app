/**
 * Worksheet practice (student Board phase 2): the server's answer check and
 * the help ladder's pure parts — the quiz grader reused, practice's kinder
 * numeric/short readings, the rung order, the leak check that keeps a hint
 * from giving the answer away, and the paper's own help.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/practice/__tests__/check.test.ts
 */
import { describe, expect, it } from "vitest";
import type { RawQuestion } from "@/app/api/quiz/logic";
import { checkAnswer, conceptOf, keyText, keyWordsPresent, numericClose, revealKey, shapeAnswer } from "../check";
import { generateHelp, helpCost, helpPrompt, leaksKey, paperHelp, questionHash, rungFor } from "../help";
import { PAPER } from "./practice-db";

const Q = (id: string) => PAPER.questions.find((q) => q.id === id) as unknown as RawQuestion;

describe("checkAnswer — the quiz's grader, a little kinder for practice", () => {
  it("fill_blank: case/space-insensitive, and numbers as numbers", () => {
    expect(checkAnswer(Q("q1"), "  chlorophyll ")).toBe("correct");
    expect(checkAnswer(Q("q1"), "chloroplast")).toBe("incorrect");
    const num = { id: "n", type: "fill_blank", prompt: "Area?", answer: "9π cm²", marks: 1 } as RawQuestion;
    expect(checkAnswer(num, "9pi")).toBe("correct");
    expect(checkAnswer(num, "9")).toBe("incorrect");
  });

  it("numeric: a correctly ROUNDED value is right; a wrong rounding or a bare integer is not", () => {
    expect(numericClose("3.142857", "3.14")).toBe(true);
    expect(numericClose("3.142857", "3.143")).toBe(true);
    expect(numericClose("3.142857", "3.15")).toBe(false);
    expect(numericClose("56.52", "57")).toBe(false); // no decimals given: not a rounding
    expect(numericClose("44", "44.0")).toBe(true); // exact
    expect(numericClose("2.5 cm", "2.5 m")).toBe(false); // units differ
    expect(checkAnswer(Q("q5"), "3.14")).toBe("correct");
    expect(checkAnswer(Q("q5"), "3.1")).toBe("correct");
    expect(checkAnswer(Q("q5"), "3.2")).toBe("incorrect");
  });

  it("short: exact, numeric, or every content word of a short key", () => {
    const s = { id: "s", type: "short", prompt: "Control centre?", answer: "Nucleus", marks: 1 } as RawQuestion;
    expect(checkAnswer(s, "the nucleus")).toBe("correct");
    expect(checkAnswer(s, "nuclear")).toBe("incorrect");
    expect(keyWordsPresent("cell membrane", "it is the membrane of the cell")).toBe(true);
    expect(keyWordsPresent("a very long key with many content words here", "long key")).toBe(false);
  });

  it("mcq / true_false / match", () => {
    expect(checkAnswer(Q("q3"), "mitochondrion")).toBe("correct");
    expect(checkAnswer(Q("q3"), "Nucleus")).toBe("incorrect");
    expect(checkAnswer(Q("q2"), false)).toBe("correct");
    expect(checkAnswer(Q("q2"), true)).toBe("incorrect");
    expect(checkAnswer(Q("q4"), ["controls the cell", "lets substances in and out"])).toBe("correct");
    expect(checkAnswer(Q("q4"), ["lets substances in and out", "controls the cell"])).toBe("incorrect");
  });

  it("subjective is never auto-marked: review", () => {
    expect(checkAnswer(Q("q6"), "because light")).toBe("review");
  });

  it("shapeAnswer refuses what the question cannot take", () => {
    expect(shapeAnswer(Q("q2"), "false")).toBeNull();
    expect(shapeAnswer(Q("q2"), false)).toBe(false);
    expect(shapeAnswer(Q("q1"), "   ")).toBeNull();
    expect(shapeAnswer(Q("q1"), 42)).toBeNull();
    expect(shapeAnswer(Q("q4"), ["only one"])).toBeNull();
    expect(shapeAnswer(Q("q1"), "x".repeat(900))).toHaveLength(500);
  });

  it("revealKey / keyText / conceptOf", () => {
    expect(revealKey(Q("q2"))).toEqual({ type: "bool", value: false });
    expect(revealKey(Q("q4"))?.type).toBe("pairs");
    expect(revealKey(Q("q6"))).toEqual({ type: "text", value: "Light energy drives photosynthesis, making glucose." });
    expect(keyText(Q("q1"))).toBe("Chlorophyll");
    expect(conceptOf(Q("q3"))).toBe("cell organelles");
    expect(conceptOf(Q("q1"))).toBeNull();
  });
});

describe("the help ladder", () => {
  it("hint → worked step → answer, and it stays on the answer", () => {
    expect([1, 2, 3, 4, 9].map(rungFor)).toEqual(["hint", "step", "answer", "answer", "answer"]);
  });

  it("leaksKey catches the key, its inflections and 'the answer is'", () => {
    expect(leaksKey(Q("q1"), "Think about the pigment that makes leaves green.")).toBe(false);
    expect(leaksKey(Q("q1"), "It starts with chloro… chlorophyll!")).toBe(true);
    // KNOWN LIMIT: a form that does not CONTAIN the key ("mitochondria" for "Mitochondrion") is not
    // caught — the prompt forbids it; the check is the backstop for the literal key.
    expect(leaksKey(Q("q3"), "The mitochondria do this job.")).toBe(false);
    expect(leaksKey(Q("q3"), "Mitochondrion is where respiration happens.")).toBe(true);
    expect(leaksKey(Q("q2"), "The answer is false.")).toBe(true);
    expect(leaksKey(Q("q2"), "Think about what plant cells have that animal cells lack.")).toBe(false);
    expect(leaksKey(Q("q4"), "Nucleus → controls the cell")).toBe(true);
    const digit = { id: "d", type: "fill_blank", prompt: "2 + 2 = ?", answer: "4", marks: 1 } as RawQuestion;
    expect(leaksKey(digit, "Count two, then two more: you get 4.")).toBe(true);
    expect(leaksKey(digit, "Count two, then two more.")).toBe(false);
  });

  it("paperHelp: the paper's own hint, unless it gives the answer away", () => {
    expect(paperHelp(Q("q3"), "hint")).toBe("Think about respiration.");
    expect(paperHelp(Q("q3"), "step")).toBeNull();
    const leaky = { ...Q("q1"), hint: "It is chlorophyll." } as unknown as RawQuestion;
    expect(paperHelp(leaky, "hint")).toBeNull();
    const explained = { ...Q("q1"), explanation: "Chlorophyll absorbs light." } as unknown as RawQuestion;
    expect(paperHelp(explained, "answer")).toBe("Chlorophyll absorbs light.");
  });

  it("the prompt grounds on the key but forbids it before rung 3", () => {
    const h = helpPrompt(Q("q3"), "hint");
    expect(h.user).toContain("Correct answer (for your eyes only): Mitochondrion");
    expect(h.system).toMatch(/Do NOT state/);
    expect(helpPrompt(Q("q3"), "answer").system).toMatch(/WHY it is correct/);
  });

  it("generateHelp drops a leaking reply and survives a failing call", async () => {
    const usage = { input_tokens: 400, output_tokens: 80 };
    const ok = await generateHelp(async () => ({ text: "Which part of the cell does respiration?", usage }), Q("q3"), "hint");
    expect(ok?.text).toBe("Which part of the cell does respiration?");
    expect(ok?.cost).toBeCloseTo(helpCost(usage), 9);
    expect(await generateHelp(async () => ({ text: "It is the Mitochondrion.", usage }), Q("q3"), "hint")).toBeNull();
    expect(await generateHelp(async () => { throw new Error("throttled"); }, Q("q3"), "hint")).toBeNull();
    // The answer rung may name the key — it is revealed anyway.
    expect(await generateHelp(async () => ({ text: "Mitochondria release energy in respiration.", usage }), Q("q3"), "answer")).not.toBeNull();
  });

  it("a hint costs about a hundredth of a cent (Haiku 5.5 prices)", () => {
    expect(helpCost({ input_tokens: 400, output_tokens: 120 })).toBeCloseTo(0.0001, 6);
  });

  it("questionHash changes with the key, not with an unrelated field", () => {
    const a = questionHash(Q("q1"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(questionHash({ ...Q("q1"), marks: 5 } as RawQuestion)).toBe(a);
    expect(questionHash({ ...Q("q1"), answer: "Chloroplast" } as RawQuestion)).not.toBe(a);
  });
});
