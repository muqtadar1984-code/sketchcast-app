import { describe, expect, it } from "vitest";
import { answerKey, layoutCard, questionCards, wrap, type CardWords } from "../text-card";
import { deserialise, newRoll, addPage, serialise } from "@/board/model";

const words: CardWords = {
  questionOf: "Question {n} of {total}",
  marks: "{n} marks",
  answer: "Answer: {a}",
  answerTrue: "True",
  answerFalse: "False",
};
/** 10 px per character — enough to test wrapping without a canvas. */
const measure = (s: string) => Array.from(s).length * 10;

const quiz = {
  title: "Inheritance",
  instructions: "",
  questions: [
    { id: "q1", type: "mcq", prompt: "Which carries genes?", options: ["Ribosome", "Chromosome"], answer: "Chromosome", marks: 1 },
    { id: "q2", type: "true_false", prompt: "Twins share DNA.", answer: true, marks: 1 },
    { id: "q3", type: "fill_blank", prompt: "XX is a ____.", answer: "girl", marks: 2 },
    { id: "q4", type: "match", prompt: "Match.", pairs: [{ left: "Gene", right: "Unit" }, { left: "Allele", right: "Form" }], marks: 2 },
    { id: "q5", type: "subjective", prompt: "Explain.", answer_outline: "Because…", marks: 4 },
    { id: "bad", type: "short", marks: 1 },
  ],
};

describe("questionCards", () => {
  const { cards, answers } = questionCards(quiz, "gen-ws", words);

  it("one card per usable question; malformed items are skipped", () => {
    expect(cards.map((c) => c.questionId)).toEqual(["q1", "q2", "q3", "q4", "q5"]);
    expect(cards.every((c) => c.total === 5 && c.source === "question" && c.generationId === "gen-ws")).toBe(true);
    expect(cards[0]).toMatchObject({ heading: "Which carries genes?", options: ["Ribosome", "Chromosome"], marks: 1, index: 0 });
  });

  it("NO ANSWER enters a card — the key is a separate map", () => {
    expect(JSON.stringify(cards)).not.toMatch(/"answer"|girl|Because…/);
    expect(answers.get(answerKey("gen-ws", "q1"))).toBe("Chromosome");
    expect(answers.get(answerKey("gen-ws", "q2"))).toBe("True");
    expect(answers.get(answerKey("gen-ws", "q3"))).toBe("girl");
    expect(answers.get(answerKey("gen-ws", "q4"))).toBe("Gene → Unit · Allele → Form");
    expect(answers.get(answerKey("gen-ws", "q5"))).toBe("Because…");
  });

  it("match: left items in order, right items in an order that is not the key's", () => {
    expect(cards[3].body).toEqual(["1. Gene", "2. Allele"]);
    expect(cards[3].options).toEqual(["Form", "Unit"]);
  });

  it("garbage in → nothing out", () => {
    expect(questionCards(null, "g", words).cards).toEqual([]);
    expect(questionCards({ questions: "x" }, "g", words).cards).toEqual([]);
  });
});

describe("layout", () => {
  it("wraps by width and breaks an over-long word", () => {
    expect(wrap("aaa bbb ccc", 75, "", measure)).toEqual(["aaa bbb", "ccc"]);
    expect(wrap("abcdefghij", 40, "", measure)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("a question shows its place, marks, prompt and lettered options; the answer only when given", () => {
    const { cards } = questionCards(quiz, "g", words);
    const hidden = layoutCard(cards[0], words, null, measure).map((l) => l.text);
    expect(hidden).toEqual(["Question 1 of 5 · 1 marks", "Which carries genes?", "A. Ribosome", "B. Chromosome"]);
    const shown = layoutCard(cards[0], words, "Chromosome", measure).map((l) => l.text);
    expect(shown.at(-1)).toBe("Answer: Chromosome");
  });

  it("a caption is its heading and points, with no question numbering", () => {
    const lines = layoutCard({ source: "caption", heading: "Genes", body: ["DNA", "codes"], index: 3 }, words, null, measure);
    expect(lines.map((l) => l.text)).toEqual(["Genes", "DNA", "codes"]);
  });
});

describe("card pages persist through the roll's own serialiser", () => {
  it("round-trips, and a malformed card is refused rather than half-loaded", () => {
    const roll = newRoll("s");
    const { cards } = questionCards(quiz, "g", words);
    addPage(roll, { kind: "card", card: cards[0] });
    const back = deserialise(serialise(roll));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.roll.pages[1].background).toEqual({ kind: "card", card: cards[0] });

    const bad = JSON.parse(serialise(roll));
    bad.pages[1].background.card.body = [1, 2];
    expect(deserialise(JSON.stringify(bad)).ok).toBe(false);
  });
});
