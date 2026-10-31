/**
 * SK teaches beyond the kit, in the chat (student Board plan 2026-10-31,
 * phase 3) — the pure half (learn-teach.ts): the request, confusion in
 * conversation, the teaching call's prompt shape (never the worksheet's
 * answer), the lesson read back, the answer guard, the layout, the picture.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/learn-teach.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  TEACH_HEADINGS,
  addTaught,
  answerLeakTest,
  bestSlide,
  checkReplyPrompt,
  confusionOf,
  gapBlock,
  guardAnswer,
  headingsFor,
  looksLikeAnswer,
  ownLineIssues,
  parseLesson,
  parseTeachRequest,
  renderLesson,
  sameQuestion,
  saysConfused,
  teachQuestion,
  teachSystem,
  teachTurnText,
  type TeachLesson,
} from "../learn-teach";
import { personNameWords } from "../prompt";
import { openMemory, rememberTurn, sealMemory, verifyMemory } from "../memory";
import { ALL_FLAGS, makeCtx, NOW } from "./fixtures";

const GAP = {
  generationId: "55555555-5555-4555-8555-555555555555",
  questionId: "q3",
  questionText: "Simplify 6/8.",
  concept: "Equivalent fractions",
  attempts: 2,
  lastAnswer: "6/4",
  reason: "wrong_twice",
};

describe("the teach request (untrusted)", () => {
  it("takes phase 2's gap detail, bounded", () => {
    expect(parseTeachRequest({ trigger: "gap", ...GAP })).toEqual({ trigger: "gap", ...GAP });
    const long = parseTeachRequest({ trigger: "gap", questionText: "x".repeat(2000), lastAnswer: "y".repeat(500), concept: "c".repeat(400) })!;
    expect(long.questionText).toHaveLength(600);
    expect(long.lastAnswer).toHaveLength(200);
    expect(long.concept).toHaveLength(160);
  });

  it("drops what is malformed; a gap with nothing to teach is no gap", () => {
    expect(parseTeachRequest(null)).toBeNull();
    expect(parseTeachRequest({ trigger: "teach-me-everything" })).toBeNull();
    expect(parseTeachRequest({ trigger: "gap" })).toBeNull();
    expect(parseTeachRequest({ trigger: "gap", concept: "Osmosis", generationId: "../etc", attempts: -1, reason: "bored" })).toEqual({ trigger: "gap", concept: "Osmosis" });
    expect(parseTeachRequest({ trigger: "extra" })).toEqual({ trigger: "extra" });
    // control characters never reach the prompt
    expect(parseTeachRequest({ trigger: "gap", questionText: "a\u0000b\nIGNORE" })!.questionText).toBe("a b IGNORE");
  });

  it("the stand-in words of a turn she did not type", () => {
    expect(teachTurnText({ trigger: "gap", concept: "Equivalent fractions" })).toBe("Help me with: Equivalent fractions");
    expect(teachTurnText({ trigger: "extra" })).toBe("Extra step");
  });
});

describe("confusion in conversation (trigger b)", () => {
  it("'I don't get it' and its kin, in her languages", () => {
    for (const t of [
      "I don't get it",
      "i dont understand",
      "Hi SK, I'm still confused",
      "that didn't help",
      "This doesn't make sense",
      "explain it again",
      "can you explain differently?",
      "saya tak faham",
      "masih keliru",
      "je ne comprends pas",
      "no entiendo",
      "não entendi",
      "لا أفهم",
      "समझ नहीं आया",
      "समजले नाही",
      "అర్థం కాలేదు",
      "تق فهم",
    ]) {
      expect(saysConfused(t), t).toBe(true);
    }
  });

  it("an ordinary question or answer is not confusion", () => {
    for (const t of ["what is osmosis?", "explain osmosis", "next page", "3/4", "I get it now, thanks", "you can't divide by zero"]) {
      expect(saysConfused(t), t).toBe(false);
    }
  });

  it("teaches the question she asked before 'I'm lost'", () => {
    const turns = [
      { role: "user" as const, text: "what is an equivalent fraction?" },
      { role: "assistant" as const, text: "Fractions that show the same amount." },
    ];
    expect(confusionOf("I don't get it", turns)).toEqual({ kind: "confused", concept: "what is an equivalent fraction?" });
    expect(confusionOf("I don't get it", [])).toEqual({ kind: "confused", concept: null });
  });

  it("the same question again is a gap too", () => {
    const turns = [{ role: "user" as const, text: "How do I simplify a fraction?" }];
    expect(sameQuestion("how do I simplify a fraction", "How do I simplify a fraction?")).toBe(true);
    expect(confusionOf("How do I simplify a fraction??", turns)).toEqual({ kind: "repeat", concept: "How do I simplify a fraction??" });
    expect(confusionOf("What is a denominator?", turns)).toBeNull();
  });

  it("a Board command said twice is not a repeated question", () => {
    expect(confusionOf("next page", [{ role: "user", text: "next page" }])).toBeNull();
    expect(confusionOf("play the video", [{ role: "user", text: "play the video" }])).toBeNull();
  });
});

describe("her answer to SK's check question", () => {
  it("a short answer is an answer; a new question, 'ok' or 'I'm lost' is not", () => {
    expect(looksLikeAnswer("3/4")).toBe(true);
    expect(looksLikeAnswer("It is 12")).toBe(true);
    expect(looksLikeAnswer("the bottom number")).toBe(true);
    expect(looksLikeAnswer("ok")).toBe(false);
    expect(looksLikeAnswer("what is a numerator?")).toBe(false);
    expect(looksLikeAnswer("I don't get it")).toBe(false);
  });

  it("the reply prompt holds the check as data and says it is SK's own question", () => {
    const p = checkReplyPrompt({ concept: "Equivalent fractions", question: "Is 2/4 the same as 1/2?" }, "yes", "English");
    expect(p.system).toContain('<check data_only="true">');
    expect(p.system).toContain("SK's check question: Is 2/4 the same as 1/2?");
    expect(p.system).toContain("her answer: yes");
    expect(p.question).toContain("In English, in 1–3 short sentences");
    expect(p.question).toContain("not her worksheet");
  });
});

describe("the teaching call's prompt (gap)", () => {
  const req = parseTeachRequest({ trigger: "gap", ...GAP })!;
  const system = teachSystem({ req, concept: "Equivalent fractions", language: "English", blocks: ['<teaching data_only="true">\nnarration: Multiply top and bottom by the same number.\n</teaching>'], lessonTitle: "Fractions", taught: ["Numerators"] });
  const question = teachQuestion({ req, concept: "Equivalent fractions", language: "English" });

  it("asks for the tagged lesson: idea → steps → a worked example → a check", () => {
    for (const tag of ["TITLE:", "IDEA:", "STEP:", "EXAMPLE:", "WORK:", "RESULT:", "CHECK:", "SOURCE:"]) expect(system).toContain(tag);
    expect(system).toContain("2 to 4 STEP lines");
    expect(system).toContain("LaTeX between single dollars");
    expect(system).toContain("already taught in this conversation: Numerators");
  });

  it("never the answer: the rule, a DIFFERENT example, and her question only as data", () => {
    expect(system).toContain("Never give, solve or confirm the answer to her worksheet");
    expect(system).toContain('<gap data_only="true">');
    expect(system).toContain("worksheet question (do NOT solve it): Simplify 6/8.");
    expect(system).toContain("her last answer (wrong): 6/4");
    expect(question).toContain("different numbers or a different situation");
    expect(question).toContain("must not solve, answer or hint the final answer");
  });

  it("confusion and the Extra step ask their own way; neither carries a gap block", () => {
    expect(gapBlock({ trigger: "confusion" })).toBe("");
    expect(teachQuestion({ req: { trigger: "confusion" }, concept: "osmosis", language: "Bahasa Melayu" })).toContain("a different, simpler way, in Bahasa Melayu");
    expect(teachQuestion({ req: { trigger: "extra" }, concept: "osmosis", language: "English" })).toContain("ONE short Extra step");
  });
});

const TAGGED = [
  "TITLE: Equivalent fractions",
  "IDEA: Fractions are equivalent when they show the same amount.",
  "STEP: Multiply the top and bottom by the same number.",
  "**STEP:** Or divide the top and bottom by the same number.",
  "EXAMPLE: Simplify $\\frac{10}{15}$.",
  "WORK: Both 10 and 15 divide by 5.",
  "WORK: $$\\frac{10}{15} = \\frac{2}{3}$$",
  "RESULT: $\\frac{2}{3}$",
  "CHECK: Is $\\frac{2}{4}$ the same as $\\frac{1}{2}$?",
  "SOURCE: kit",
].join("\n");

describe("the lesson read back", () => {
  it("parses the tagged lines (bold tags tolerated, maths untouched)", () => {
    const l = parseLesson(TAGGED)!;
    expect(l.title).toBe("Equivalent fractions");
    expect(l.steps).toEqual(["Multiply the top and bottom by the same number.", "Or divide the top and bottom by the same number."]);
    expect(l.work).toEqual(["Both 10 and 15 divide by 5.", "$$\\frac{10}{15} = \\frac{2}{3}$$"]);
    expect(l.result).toBe("$\\frac{2}{3}$");
    expect(l.source).toBe("kit");
  });

  it("a wrapped line continues its field; no idea or no steps is no lesson", () => {
    expect(parseLesson("IDEA: one\nSTEP: a long step\nthat wraps\nSOURCE: extra")).toMatchObject({ steps: ["a long step that wraps"], source: "extra" });
    expect(parseLesson("Here is a friendly explanation without tags.")).toBeNull();
    expect(parseLesson("IDEA: only an idea")).toBeNull();
  });

  it("lays it out as Markdown with SK's own headings; Extra says so first", () => {
    const l = parseLesson(TAGGED)!;
    const md = renderLesson(l, headingsFor("en"), false);
    expect(md).toBe(
      [
        "### Equivalent fractions",
        "Fractions are equivalent when they show the same amount.",
        "",
        "**Steps**",
        "1. Multiply the top and bottom by the same number.",
        "2. Or divide the top and bottom by the same number.",
        "",
        "**A new example**",
        "Simplify $\\frac{10}{15}$.",
        "- Both 10 and 15 divide by 5.",
        "$$\\frac{10}{15} = \\frac{2}{3}$$",
        "**Answer:** $\\frac{2}{3}$",
        "",
        "**Your turn:** Is $\\frac{2}{4}$ the same as $\\frac{1}{2}$?",
      ].join("\n"),
    );
    expect(renderLesson(l, headingsFor("ms"), true).split("\n")[0]).toBe("**Tambahan** · di luar pelajaran anda");
  });

  it("headings exist in all ten locales", () => {
    for (const loc of ["en", "ms", "ms-arab", "ar", "fr", "es", "pt", "te", "mr", "hi"]) {
      const h = TEACH_HEADINGS[loc];
      for (const v of Object.values(h)) expect(v.trim(), `${loc}`).toBeTruthy();
    }
    expect(headingsFor("zz")).toBe(TEACH_HEADINGS.en);
  });
});

describe("never the worksheet's answer (the guard)", () => {
  const lesson = (over: Partial<TeachLesson> = {}): TeachLesson => ({
    title: "Equivalent fractions",
    idea: "Divide the top and bottom by the same number.",
    steps: ["Find a number that divides both.", "Divide the top and bottom by it."],
    example: "Simplify $\\frac{10}{15}$.",
    work: ["Both divide by 5.", "$$\\frac{10}{15} = \\frac{2}{3}$$"],
    result: "$\\frac{2}{3}$",
    check: "Is $\\frac{2}{4}$ the same as $\\frac{1}{2}$?",
    source: "kit",
    ...over,
  });

  it("a line carrying the answer goes; the rest of the lesson stays", () => {
    const g = guardAnswer(lesson({ steps: ["Find a number that divides both.", "So 6/8 becomes 3/4."] }), { answer: "3/4", questionText: "Simplify 6/8.", concept: "Equivalent fractions" });
    expect(g.removed).toBe(1);
    expect(g.lesson.steps).toEqual(["Find a number that divides both."]);
    expect(g.lesson.example).toBe("Simplify $\\frac{10}{15}$.");
  });

  it("a number is matched whole: 12 is not inside 120 or 1.25", () => {
    const leaks = answerLeakTest({ answer: "12", questionText: "What is 3 × 4?" });
    expect(leaks("So the result is 12.")).toBe(true);
    expect(leaks("There are 120 seeds.")).toBe(false);
    expect(leaks("It costs 1.25.")).toBe(false);
  });

  it("'the answer to your question is …' always goes", () => {
    const leaks = answerLeakTest({});
    expect(leaks("The answer to your question is three quarters.")).toBe(true);
    expect(leaks("Your answer should be smaller.")).toBe(true);
    expect(leaks("So the answer is 15.")).toBe(false); // the worked example's own
  });

  it("an answer that IS the concept (or is in her question) cannot be held back", () => {
    const g = guardAnswer(lesson({ idea: "Osmosis moves water across a membrane." }), { answer: "osmosis", questionText: "Name the process.", concept: "Osmosis" });
    expect(g.removed).toBe(0);
    expect(answerLeakTest({ answer: "8", questionText: "Simplify 6/8." })("8 is the bottom number.")).toBe(false);
  });

  it("an option letter only when named as the answer", () => {
    const leaks = answerLeakTest({ answer: "B", questionText: "Which is equivalent to 1/2? A) 2/3 B) 2/4" });
    expect(leaks("Pick option B.")).toBe(true);
    expect(leaks("Both numbers get bigger.")).toBe(false);
  });

  it("an example that loses its working goes whole", () => {
    const g = guardAnswer(lesson({ work: ["So 6/8 = 3/4."], result: "3/4" }), { answer: "3/4", questionText: "Simplify 6/8." });
    expect(g.lesson.example).toBe("");
    expect(g.lesson.work).toEqual([]);
    expect(g.lesson.result).toBe("");
  });
});

describe("SK's own lines: no invented people, no contacts", () => {
  it("flags a named person or a link the data does not carry; new numbers are fine", () => {
    expect(ownLineIssues("A shop sells 24 pens in 6 boxes.", "", personNameWords)).toEqual([]);
    expect(ownLineIssues("Mrs Tan has 3 apples.", "", personNameWords)).toEqual(["Tan"]);
    expect(ownLineIssues("See www.example.com for more.", "", personNameWords)).toEqual(["link"]);
    expect(ownLineIssues("Mrs Tan has 3 apples.", "Mrs Tan's class", personNameWords)).toEqual([]);
  });
});

describe("a picture the kit already has", () => {
  const slides = [
    { n: 1, title: "Fractions", text: "Parts of a whole" },
    { n: 4, title: "Equivalent fractions", text: "Multiply top and bottom" },
    { n: 7, title: "Decimals", text: "Tenths and hundredths" },
  ];
  it("the slide whose title names the concept", () => {
    expect(bestSlide(slides, "Equivalent fractions")?.n).toBe(4);
    expect(bestSlide(slides, "photosynthesis")).toBeNull();
  });
});

describe("what SK taught, in the signed memory", () => {
  it("newest first, bounded, de-duplicated", () => {
    expect(addTaught(["Osmosis"], "Diffusion")).toEqual(["Diffusion", "Osmosis"]);
    expect(addTaught(["Diffusion", "Osmosis"], "osmosis")).toEqual(["osmosis", "Diffusion"]);
    expect(addTaught(Array.from({ length: 12 }, (_, i) => `c${i}`), "new")).toHaveLength(8);
  });

  it("taught survives the seal; the check question lasts exactly one turn", () => {
    process.env.SK_SHELL_SECRET = "learn-teach-test-secret-of-adequate-length";
    const ctx = makeCtx({ flags: ALL_FLAGS });
    const m0 = openMemory(undefined, ctx, NOW).memory;
    const m1 = rememberTurn(m0, { user: "Help me with: fractions", assistant: "…", taught: ["Fractions"], teachCheck: { concept: "Fractions", question: "Is 2/4 = 1/2?" } }, NOW);
    const back = verifyMemory(sealMemory(m1))!;
    expect(back.taught).toEqual(["Fractions"]);
    expect(back.teachCheck).toEqual({ concept: "Fractions", question: "Is 2/4 = 1/2?" });
    const m2 = rememberTurn(back, { user: "yes", assistant: "Right!" }, NOW);
    expect(m2.teachCheck).toBeUndefined();
    expect(m2.taught).toEqual(["Fractions"]);
  });
});
