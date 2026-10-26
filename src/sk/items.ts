// SK B4 — the item bank seam and the POC items for U4.
//
// ⚠ STAND-IN. B1 maps `topic_questions` to teaching objectives and the graph's
// practice/check assets will carry those ids; until then the five items below
// are the bank. They live in SERVER code on purpose: the graph manifest in
// public/ carries only item ids, never prompts with keys, so the answer key
// never reaches the browser (quiz integrity rule 1). The student receives
// `stripItem()` output, built field by field like the quiz's stripQuiz.

import type { RawQuestion } from "@/app/api/quiz/logic";

export interface ItemBank {
  get(itemId: string): Promise<RawQuestion | null>;
}

export type StudentItem =
  | { id: string; type: "fill_blank" | "short" | "true_false" | "subjective"; prompt: string; marks: number }
  | { id: string; type: "mcq"; prompt: string; marks: number; options: string[] }
  | { id: string; type: "match"; prompt: string; marks: number; left: string[]; options: string[] };

/** Every marking-scheme field removed. For `match` the right-hand options are
 * sorted (a stable, key-free order) — the real HMAC-keyed shuffle from the quiz
 * joins when items come from the database. */
export function stripItem(q: RawQuestion): StudentItem {
  switch (q.type) {
    case "mcq":
      return { id: q.id, type: "mcq", prompt: q.prompt, marks: q.marks, options: [...q.options] };
    case "match":
      return { id: q.id, type: "match", prompt: q.prompt, marks: q.marks, left: q.pairs.map((p) => p.left), options: q.pairs.map((p) => p.right).sort((a, b) => a.localeCompare(b)) };
    case "fill_blank":
    case "short":
    case "true_false":
    case "subjective":
      return { id: q.id, type: q.type, prompt: q.prompt, marks: q.marks };
  }
}

/** Chapter 2, U4 "Total magnification" — written from the approved ch02 draft
 * §s5 (the same source as the U4 segment's narration). */
export const POC_ITEMS: readonly RawQuestion[] = [
  {
    id: "ch2-u4-c1",
    type: "mcq",
    prompt: "How do you work out the total magnification of a light microscope?",
    options: ["Add the eyepiece and objective magnifications", "Multiply the eyepiece and objective magnifications", "Divide the objective by the eyepiece", "Use only the objective lens magnification"],
    answer: "Multiply the eyepiece and objective magnifications",
    marks: 1,
  },
  {
    id: "ch2-u4-c2",
    type: "fill_blank",
    prompt: "A ×10 eyepiece with a ×40 objective gives a total magnification of ×____.",
    answer: "400",
    accept: ["×400", "x400", "400x", "400 times"],
    marks: 1,
  },
  {
    id: "ch2-u4-c3",
    type: "true_false",
    prompt: "A ×10 eyepiece with a ×4 objective gives a total magnification of ×14.",
    answer: false,
    marks: 1,
  },
  {
    id: "ch2-u4-p1",
    type: "fill_blank",
    prompt: "Eyepiece ×10, objective ×4. Total magnification = ×____",
    answer: "40",
    accept: ["×40", "x40", "40x"],
    marks: 1,
  },
  {
    id: "ch2-u4-p2",
    type: "mcq",
    prompt: "Which lens is nearest your eye when you look into a microscope?",
    options: ["The objective lens", "The eyepiece lens", "The stage", "The mirror"],
    answer: "The eyepiece lens",
    marks: 1,
  },
];

export class StaticItemBank implements ItemBank {
  private readonly byId: Map<string, RawQuestion>;
  constructor(items: readonly RawQuestion[] = POC_ITEMS) {
    this.byId = new Map(items.map((q) => [q.id, q]));
  }
  async get(itemId: string): Promise<RawQuestion | null> {
    return this.byId.get(itemId) ?? null;
  }
}

/** Hints are assistance (the attempt stops counting as independent). ⚠ STAND-IN
 * until items carry a hint field from the bank. */
const HINTS: Record<string, string> = {
  "ch2-u4-c1": "Think about what happens to the image at each lens in turn.",
  "ch2-u4-c2": "Multiply: eyepiece times objective.",
  "ch2-u4-c3": "Is 10 × 4 equal to 14?",
  "ch2-u4-p1": "Ten times four.",
  "ch2-u4-p2": "Which lens would you look into?",
};

export function hintFor(item: RawQuestion): string {
  return HINTS[item.id] ?? "Look back at the board — the answer is in the part we just covered.";
}
