/**
 * SK S3 slice D — the student's tutor phrasings in the rules router: at least
 * six per move across English, Malay and Arabic, each decided with NO model
 * (routeByRules is pure). Plus: a teacher never routes to a tutor.* entry, a
 * student never routes to a Board move or a teacher action, and a chapter is a
 * navigate to her own book.
 */
import { describe, expect, it } from "vitest";
import { routeByRules, type RulesDecision } from "../rules";
import type { SkContext } from "../types";
import { makeCtx, NOW } from "./fixtures";

const SEGMENTS = [
  { k: 0, key: "p1:s001", heading: "Why cells specialise" },
  { k: 1, key: "p1:s002", heading: "Red blood cells" },
  { k: 2, key: "p1:s003", heading: "Tissues and organs" },
];

function student(path = "/sk/cells-structure-function-organisation/5"): SkContext {
  const ctx = makeCtx({ role: "student", hat: null, path });
  ctx.tutor = { product: "cells-structure-function-organisation", chapter: "5", kit: "4885bc51-0e65-4252-bb41-88df6bcc28bc", k: 1, key: "p1:s002", segments: SEGMENTS };
  return ctx;
}

const route = (text: string, ctx = student()): RulesDecision => routeByRules(text, ctx, NOW);
const tutor = (capability: string, args: Record<string, unknown> = {}) => ({ intent: "tutor", capability, args });

const CASES: Array<[string, string, Record<string, unknown>, string[]]> = [
  // [move, capability, args, phrasings (EN, MS, AR)]
  ["play", "tutor.play", { action: "play" }, ["play", "continue", "carry on", "keep going", "play the video", "mainkan video", "sambung", "teruskan", "شغل الفيديو", "تابع", "استمر", "أكمل الدرس"]],
  ["pause", "tutor.play", { action: "pause" }, ["pause", "stop", "hold on", "pause the video please", "berhenti", "jeda", "tunggu sekejap", "توقف", "أوقف الفيديو", "انتظر"]],
  ["restart", "tutor.play", { action: "restart" }, ["start again", "start over", "play from the beginning", "restart", "mula semula", "main dari awal", "ابدأ من البداية", "أعد التشغيل", "من البداية"]],
  ["section 3", "tutor.section", { k: 2 }, ["section 3", "go to section 3", "play part 3", "bahagian 3", "pergi ke bahagian tiga", "الجزء 3", "انتقل إلى الجزء ثلاثة"]],
  ["next", "tutor.section", { step: "next" }, ["next", "next section", "go to the next part", "bahagian seterusnya", "seterusnya", "الجزء التالي", "التالي"]],
  ["previous", "tutor.section", { step: "previous" }, ["previous section", "go back", "the last part", "bahagian sebelumnya", "kembali", "الجزء السابق", "ارجع"]],
  ["by words", "tutor.section", { k: 1 }, ["go to the red blood cells part", "take me to red blood cells", "jump to red blood cells", "pergi ke bahagian red blood cells", "انتقل إلى جزء red blood cells", "show me the red blood cells section"]],
  ["slide", "tutor.slide", {}, ["show the slide", "show me the slide", "the slide", "slide", "tunjukkan slaid", "slaid", "اعرض الشريحة", "أرني الشريحة"]],
  ["practise", "tutor.practise", {}, ["quiz me", "test me", "practise", "give me some questions", "practice questions", "uji saya", "latihan", "beri saya soalan latihan", "اختبرني", "أعطني أسئلة", "أريد أن أتدرب"]],
  ["where", "tutor.where", {}, ["where am i", "what's next?", "what should i do next", "where was i", "apa seterusnya", "di mana saya", "apa yang perlu saya buat seterusnya", "أين أنا", "ما التالي", "ماذا بعد؟"]],
  ["progress", "tutor.progress", {}, ["how am i doing", "my progress", "what have i mastered", "how did i do?", "bagaimana prestasi saya", "kemajuan saya", "macam mana kemajuan saya", "كيف أدائي", "تقدمي", "ماذا أتقنت"]],
  ["explain", "tutor.explain", {}, ["explain this", "explain", "i don't understand", "what does this mean", "terangkan ini", "saya tak faham", "jelaskan", "اشرح هذا", "لم أفهم", "ما معنى هذا"]],
];

describe("tutor phrasings — ≥ 6 per move, EN/MS/AR, no model", () => {
  for (const [move, capability, args, phrasings] of CASES) {
    it(`${move}: ${phrasings.length} phrasings`, () => {
      expect(phrasings.length).toBeGreaterThanOrEqual(6);
      const langs = { en: phrasings.some((p) => /^[\x20-\x7e]+$/.test(p)), ar: phrasings.some((p) => /[؀-ۿ]/.test(p)) };
      expect(langs).toEqual({ en: true, ar: true });
      for (const p of phrasings) expect(route(p), p).toEqual(tutor(capability, args));
    });
  }

  it("explain + a section's words → that section; a free question stays her question", () => {
    expect(route("explain red blood cells")).toEqual(tutor("tutor.explain", { k: 1 }));
    expect(route("terangkan tissues and organs")).toEqual(tutor("tutor.explain", { k: 2 }));
    expect(route("explain how the heart pumps blood")).toEqual(tutor("tutor.explain", { question: "explain how the heart pumps blood" }));
  });

  it("practise / slide with a number address that section", () => {
    expect(route("practise section 2")).toEqual(tutor("tutor.practise", { k: 1 }));
    expect(route("show the slide 3")).toEqual(tutor("tutor.slide", { k: 2 }));
    expect(route("slaid 2")).toEqual(tutor("tutor.slide", { k: 1 }));
  });

  it("a free question is NOT a rules decision (the route sends it to tutor.explain)", () => {
    expect(route("why do red blood cells have no nucleus?").intent).toBe("ask");
    expect(route("kenapa sel darah merah tiada nukleus?").intent).toBe("ask");
  });
});

describe("navigate for a student: her own pages", () => {
  it("a chapter of her book, by number (EN/MS/AR)", () => {
    for (const p of ["open chapter 6", "chapter 6", "buka bab 6", "bab 6", "افتح الفصل 6"]) {
      expect(route(p), p).toEqual({ intent: "navigate", target: "tutor", filters: { product: "cells-structure-function-organisation", chapter: "6" } });
    }
  });
  it("her chapter list", () => {
    for (const p of ["my chapters", "show all chapters", "senarai bab", "قائمة الفصول"]) {
      expect(route(p), p).toEqual({ intent: "navigate", target: "tutor", filters: { product: "cells-structure-function-organisation" } });
    }
  });
  it("on /sk/<book> with no kit open the book comes from the path", () => {
    const ctx = makeCtx({ role: "student", hat: null, path: "/sk/cells-structure-function-organisation" });
    expect(route("open chapter 2", ctx)).toEqual({ intent: "navigate", target: "tutor", filters: { product: "cells-structure-function-organisation", chapter: "2" } });
  });
  it("a portal page still navigates, with no class or learner lookup", () => {
    expect(route("open my timetable")).toEqual({ intent: "navigate", target: "timetable", filters: {} });
    const r = route("open the diary for 7B");
    expect(r).toMatchObject({ intent: "navigate", target: "diary" });
    expect(r).not.toHaveProperty("classQuery");
    expect(route("go to the library")).toMatchObject({ intent: "navigate", target: "library" });
  });
  it("a student never gets a Board move, a lesson start or a teacher action", () => {
    expect(route("start the lesson for 7B").intent).not.toBe("navigate");
    expect(route("post a notice to 7B: bring your books").intent).not.toBe("act");
    expect(route("load the slides").intent).not.toBe("teach");
  });
});

describe("a teacher never routes to tutor.*", () => {
  it("the same words decide teacher things (or go to the model), never a tutor entry", () => {
    const teacher = makeCtx({ role: "teacher", hat: "teacher" });
    for (const [, , , phrasings] of CASES) for (const p of phrasings) expect(route(p, teacher).intent, p).not.toBe("tutor");
  });
});
