/**
 * "Play chapter 1 from the book" (founder 2026-10-30): the paraphrase corpus
 * for the play-a-chapter rule. Every phrasing below is taken by the RULE (no
 * model) and becomes a `navigate` decision carrying the start_lesson words —
 * the Board for a teacher, the Tutor for a student — with the chapter as a
 * 1-based number and the book in her own casing. Then the negatives: real
 * questions about a chapter, and commands that are about something else,
 * must NOT become a lesson start.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/lesson-rules.test.ts
 */
import { describe, expect, it } from "vitest";
import { routeByRules } from "../rules";
import { playChapterOf } from "../lesson-rules";
import { chapterNumberOf } from "../chapter-words";
import { NOW, makeCtx } from "./fixtures";

const teacher = makeCtx({ role: "teacher" });
const student = makeCtx({ role: "student", hat: null });

type Want = { chapter: number; book?: string; part?: number; class?: string };
const CORPUS: Array<[string, Want]> = [
  // the founder's phrase and its frames
  ["Play chapter 1 from the book", { chapter: 1, book: "the book" }],
  ["play chapter 1", { chapter: 1 }],
  ["Hi SK, can you play chapter 1 from the book?", { chapter: 1, book: "the book" }],
  ["PLAY CHAPTER 1!", { chapter: 1 }],
  ["play the first chapter", { chapter: 1 }],
  ["start chapter one", { chapter: 1 }],
  ["let's do chapter 2 of biology", { chapter: 2, book: "biology" }],
  ["Let's do chapter 2 of Biology, please", { chapter: 2, book: "Biology" }],
  ["teach chapter 3 of Cells and Organisation", { chapter: 3, book: "Cells and Organisation" }],
  ["open chapter 4", { chapter: 4 }],
  ["show me chapter 5 from Physics Form 4", { chapter: 5, book: "Physics Form 4" }],
  ["run chapter 2 part 3", { chapter: 2, part: 3 }],
  ["start chapter 1 for 7B", { chapter: 1, class: "7B" }],
  ["play chapter 2 of Biology on the board", { chapter: 2, book: "Biology" }],
  ["begin the third chapter", { chapter: 3 }],
  ["start chapter 12", { chapter: 12 }],
  ["teach me chapter two", { chapter: 2 }],
  ["could you start with chapter 1 now", { chapter: 1 }],
  ["play the 2nd chapter of the book", { chapter: 2, book: "the book" }],
  ["play chapter ١", { chapter: 1 }],
  // Malay
  ["mainkan bab 1 dari buku Sains", { chapter: 1, book: "buku Sains" }],
  ["tolong mulakan bab pertama", { chapter: 1 }],
  ["ajar bab kedua", { chapter: 2 }],
  ["buka bab 3 buku Biologi", { chapter: 3, book: "buku Biologi" }],
  // Arabic
  ["شغّل الفصل الأول من كتاب الأحياء", { chapter: 1, book: "كتاب الأحياء" }],
  ["ابدأ الفصل 2", { chapter: 2 }],
  ["من فضلك افتح الفصل الثالث", { chapter: 3 }],
  // French, Spanish, Portuguese
  ["lance le chapitre 1 du livre de biologie", { chapter: 1, book: "livre de biologie" }],
  ["commence le premier chapitre", { chapter: 1 }],
  ["empieza el capítulo 2", { chapter: 2 }],
  ["reproduce el primer capítulo de Biología", { chapter: 1, book: "Biología" }],
  ["começa o capítulo 3", { chapter: 3 }],
  // Hindi, Marathi, Telugu (verb last)
  ["अध्याय 1 चलाओ", { chapter: 1 }],
  ["पहला अध्याय शुरू करो", { chapter: 1 }],
  ["धडा 2 सुरू करा", { chapter: 2 }],
  ["అధ్యాయం 1 ప్రారంభించు", { chapter: 1 }],
];

const NOT_A_LESSON = [
  "what is in chapter 1?",
  "What's chapter 2 about?",
  "how many chapters does Biology have?",
  "is chapter 1 ready?",
  "explain chapter 1",
  "summarise chapter 3",
  "start chapter 1 worksheet",
  "show me chapter 1 questions",
  "can you tell me about chapter 1?",
  "chapter 1",
  "who finished chapter 2?",
  "apa isi bab 1?",
  "ما هو الفصل الأول؟",
  "play the video",
  "open the board",
  "start the lesson",
];

describe("the play-a-chapter corpus — a teacher's Board lesson, no model", () => {
  it.each(CORPUS)("%s", (text, want) => {
    const d = routeByRules(text, teacher, NOW);
    expect(d.intent).toBe("navigate");
    if (d.intent !== "navigate") return;
    expect(d.target).toBe("board");
    expect(d.filters.autostart).toBe(true);
    expect(d.lesson).toEqual(want);
  });
  it("the corpus has 15+ phrasings in several languages", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(15);
  });
});

describe("negatives: questions and other commands stay what they were", () => {
  it.each(NOT_A_LESSON)("%s", (text) => {
    expect(playChapterOf(text)).toBeNull();
    const d = routeByRules(text, teacher, NOW);
    expect(d.intent === "navigate" && !!d.lesson).toBe(false);
  });
  it("'start the lesson' is still the start-a-lesson rule (navigate board + autostart, no chapter)", () => {
    const d = routeByRules("start the lesson", teacher, NOW);
    expect(d).toMatchObject({ intent: "navigate", target: "board", filters: { autostart: true } });
    expect(d.intent === "navigate" && d.lesson).toBeFalsy();
  });
});

describe("who the rule is for", () => {
  it("a student is not taken by the rule (SK Tutor retired 2026-10-31; the Board is teacher-only)", () => {
    const d = routeByRules("play chapter 2", student, NOW) as { intent: string; target?: string; lesson?: unknown };
    expect(d.lesson).toBeUndefined();
    expect(d.target).not.toBe("tutor");
  });
  it("a teacher with a Board session open still gets the chapter (not a Board move)", () => {
    const ctx = makeCtx({ role: "teacher", path: "/present" });
    ctx.board = { sessionId: "s1" };
    expect(routeByRules("play chapter 2 of Biology", ctx, NOW)).toMatchObject({ intent: "navigate", target: "board", lesson: { chapter: 2, book: "Biology" } });
  });
  it("hats off (no hat) counts as a teacher", () => {
    expect(routeByRules("play chapter 1", makeCtx({ role: "teacher", hat: null }), NOW)).toMatchObject({ intent: "navigate", lesson: { chapter: 1 } });
  });
  it("a parent, or a principal / coordinator hat, is not taken by the rule", () => {
    for (const ctx of [makeCtx({ role: "parent", hat: "parent" }), makeCtx({ role: "parent", hat: null }), makeCtx({ role: "school_admin", hat: "principal" }), makeCtx({ role: "teacher", hat: "coordinator", scope: [{ grade: "7", subject: null }] })]) {
      const d = routeByRules("play chapter 1", ctx, NOW);
      expect(d.intent === "navigate" && !!d.lesson).toBe(false);
    }
  });
});

describe("chapter numbers as said", () => {
  it.each([
    ["1", 1], ["١", 1], ["१", 1], ["1st", 1], ["one", 1], ["first", 1], ["pertama", 1], ["kedua", 2], ["الأول", 1], ["الثالث", 3],
    ["premier", 1], ["première", 1], ["primer", 1], ["segundo", 2], ["terceiro", 3], ["पहला", 1], ["दूसरा", 2], ["మొదటి", 1], ["twelve", 12], ["dua belas", 12],
  ] as Array<[string, number]>)("%s → %d", (w, n) => {
    expect(chapterNumberOf(w)).toBe(n);
  });
  it("nothing else is a chapter number", () => {
    for (const w of ["", "cells", "0", "999", "a"]) expect(chapterNumberOf(w)).toBeNull();
  });
});
