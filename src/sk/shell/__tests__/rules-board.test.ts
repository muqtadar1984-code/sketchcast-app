/**
 * SK Shell rules router, S1 Board phrasings (English, Malay, Arabic): each
 * phrase → a deterministic Board move with its args, only while the collector
 * reports an open Board session; without one the S0 rules apply unchanged.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/rules-board.test.ts
 */
import { describe, expect, it } from "vitest";
import { numberOf, routeByRules } from "../rules";
import { NOW, makeCtx } from "./fixtures";
import { buildContext } from "../context";
import type { SkBoardState, SkContext } from "../types";
import { ALL_FLAGS, SCHOOL_ID, TEACHER_ID } from "./fixtures";

const BOARD: SkBoardState = { sessionId: "sess", manifestId: "m", k: 2, segments: [{ k: 0, heading: "A" }, { k: 1, heading: "B" }, { k: 2, heading: "C" }, { k: 3, heading: "D" }] };

function onBoard(board: SkBoardState | undefined = BOARD): SkContext {
  return buildContext({
    user: { id: TEACHER_ID, email: "t@school.example" },
    role: "teacher",
    schoolId: SCHOOL_ID,
    hat: "teacher",
    coordinatorScope: [],
    plan: "school",
    staff: false,
    flags: ALL_FLAGS,
    collector: { path: "/present", board },
    now: NOW,
  });
}
const ctx = onBoard();
const clock = { day: 3, minutes: 510, iso: "2026-10-28T16:30:00+08:00" };
const teach = (text: string, c: SkContext = ctx) => {
  const d = routeByRules(text, c, NOW, clock);
  if (d.intent !== "teach") throw new Error(`${text} → ${d.intent}`);
  return d;
};

describe("Board phrasings → moves (deterministic, no model)", () => {
  // phrasing → [move, args]
  const table: Array<[string, string, Record<string, unknown>]> = [
    // intro
    ["start the video", "intro", {}],
    ["play the intro", "intro", {}],
    ["Play the introduction, please", "intro", {}],
    ["mulakan video", "intro", {}],
    ["mainkan video dari awal", "intro", {}],
    ["ابدأ الفيديو", "intro", {}],
    ["شغل المقدمة", "intro", {}],
    // pause
    ["pause", "pause", {}],
    ["stop there", "pause", {}],
    ["hold on", "pause", {}],
    ["berhenti", "pause", {}],
    ["berhenti di sini", "pause", {}],
    ["توقف", "pause", {}],
    ["أوقف الفيديو", "pause", {}],
    // resume
    ["continue", "resume", {}],
    ["resume the video", "resume", {}],
    ["carry on", "resume", {}],
    ["sambung", "resume", {}],
    ["teruskan", "resume", {}],
    ["تابع", "resume", {}],
    ["استمر", "resume", {}],
    // slide / segment (spoken 1-based → k 0-based)
    ["next slide", "slide", { k: 3 }],
    ["previous slide", "slide", { k: 1 }],
    ["slide 4", "slide", { k: 3 }],
    ["show me slide two", "slide", { k: 1 }],
    ["go to slide 1", "slide", { k: 0 }],
    ["slaid 4", "slide", { k: 3 }],
    ["buka slaid tiga", "slide", { k: 2 }],
    ["slaid seterusnya", "slide", { k: 3 }],
    ["الشريحة 4", "slide", { k: 3 }],
    ["اعرض الشريحة 2", "slide", { k: 1 }],
    ["الشريحة التالية", "slide", { k: 3 }],
    ["go to segment 3", "segment", { k: 2 }],
    ["play part 2", "segment", { k: 1 }],
    ["bahagian 3", "segment", { k: 2 }],
    ["الجزء 3", "segment", { k: 2 }],
    // explain / compare
    ["explain diffusion", "explain", { concept: "diffusion" }],
    ["Explain the red blood cell", "explain", { concept: "red blood cell" }],
    ["explain diffusion using slide 4", "explain", { concept: "diffusion", k: 3 }],
    ["terangkan osmosis", "explain", { concept: "osmosis" }],
    ["jelaskan tentang mitosis", "explain", { concept: "mitosis" }],
    ["اشرح الانتشار", "explain", { concept: "الانتشار" }],
    ["compare red blood cells and nerve cells", "compare", { a: "red blood cells", b: "nerve cells" }],
    ["explain the difference between red blood cells and nerve cells", "compare", { a: "red blood cells", b: "nerve cells" }],
    ["what's the difference between mitosis and meiosis?", "compare", { a: "mitosis", b: "meiosis" }],
    ["bandingkan sel darah merah dengan sel saraf", "compare", { a: "sel darah merah", b: "sel saraf" }],
    ["قارن بين الخلايا الحمراء والخلايا العصبية", "compare", { a: "الخلايا الحمراء", b: "الخلايا العصبية" }],
    // freeze / blank / back
    ["freeze", "freeze", {}],
    ["freeze it there", "freeze", {}],
    ["bekukan", "freeze", {}],
    ["ثبت الصورة", "freeze", {}],
    ["blank page", "blank", {}],
    ["give me a blank page", "blank", {}],
    ["halaman kosong", "blank", {}],
    ["صفحة فارغة", "blank", {}],
    ["go back", "back", {}],
    ["back", "back", {}],
    ["previous page", "back", {}],
    ["kembali", "back", {}],
    ["ارجع", "back", {}],
    // practise
    ["give them three questions", "practise", { n: 3 }],
    ["give the class 5 practice questions", "practise", { n: 5 }],
    ["two questions please", "practise", { n: 2 }],
    ["some practice questions", "practise", { n: 3 }],
    ["beri mereka tiga soalan", "practise", { n: 3 }],
    ["3 soalan", "practise", { n: 3 }],
    ["أعطهم ثلاثة أسئلة", "practise", { n: 3 }],
    ["4 أسئلة", "practise", { n: 4 }],
    ["give them 20 questions", "practise", { n: 10 }],
    // walkthrough
    ["walk through the worksheet", "walkthrough", {}],
    ["let's go through the questions", "walkthrough", {}],
    ["teliti lembaran kerja", "walkthrough", {}],
    ["استعرض ورقة العمل", "walkthrough", {}],
    // recap
    ["end the lesson", "recap", {}],
    ["recap", "recap", {}],
    ["wrap up", "recap", {}],
    ["tamatkan pelajaran", "recap", {}],
    ["أنهِ الدرس", "recap", {}],
    ["انه الدرس", "recap", {}],
  ];
  it.each(table)("%s → %s", (text, move, args) => {
    const d = teach(text);
    expect(d.move).toBe(move);
    expect(d.args).toEqual(args);
  });
  it("has at least twenty phrasings in the table", () => {
    expect(table.length).toBeGreaterThanOrEqual(20);
  });
});

describe("only with an open Board", () => {
  it("the same phrases are 'ask' off the Board, and 'open the board' still navigates", () => {
    const off = makeCtx();
    expect(routeByRules("pause", off, NOW, clock).intent).toBe("ask");
    expect(routeByRules("slide 4", off, NOW, clock).intent).toBe("ask");
    expect(routeByRules("give them three questions", off, NOW, clock).intent).toBe("ask");
    expect(routeByRules("open the board", off, NOW, clock)).toMatchObject({ intent: "navigate", target: "board", filters: {} });
  });
  it("on the Board page with NO session: 'start the video' starts a lesson (navigate + autostart), the other Board phrasings are decided here so the route can answer with its fixed line", () => {
    const idle: SkContext = buildContext({
      user: { id: TEACHER_ID, email: "t@school.example" },
      role: "teacher",
      schoolId: SCHOOL_ID,
      hat: "teacher",
      coordinatorScope: [],
      plan: "school",
      staff: false,
      flags: ALL_FLAGS,
      collector: { path: "/present" },
      now: NOW,
    });
    expect(idle.place.page).toBe("board");
    expect(idle.board).toBeUndefined();
    expect(routeByRules("start the video", idle, NOW, clock)).toEqual({ intent: "navigate", target: "board", filters: { autostart: true } });
    expect(routeByRules("start the lesson", idle, NOW, clock)).toMatchObject({ intent: "navigate", target: "board", filters: { autostart: true } });
    expect(routeByRules("pause", idle, NOW, clock)).toEqual({ intent: "teach", move: "pause", args: {} });
    expect(routeByRules("slide 4", idle, NOW, clock)).toEqual({ intent: "teach", move: "slide", args: { k: 3 } });
    expect(routeByRules("explain diffusion", idle, NOW, clock)).toMatchObject({ intent: "teach", move: "explain" });
    // Questions and navigation on the idle Board are unchanged.
    expect(routeByRules("what is diffusion?", idle, NOW, clock).intent).toBe("ask");
    expect(routeByRules("open my analytics", idle, NOW, clock)).toMatchObject({ intent: "navigate", target: "analytics" });
  });
  it("with a session open, 'start the lesson' is the intro move, not a navigate", () => {
    expect(teach("start the lesson").move).toBe("intro");
    expect(teach("start the video").move).toBe("intro");
  });
  it("with the Board open, navigation and questions still route as before", () => {
    expect(routeByRules("open my analytics", ctx, NOW, clock)).toMatchObject({ intent: "navigate", target: "analytics" });
    expect(routeByRules("go to the library", ctx, NOW, clock)).toMatchObject({ intent: "navigate", target: "library" });
    expect(routeByRules("how many finished the quiz?", ctx, NOW, clock).intent).toBe("ask");
    expect(routeByRules("what is diffusion?", ctx, NOW, clock).intent).toBe("ask");
    expect(routeByRules("ok", ctx, NOW, clock).intent).toBe("chat");
    expect(routeByRules("yes", ctx, NOW, clock).intent).toBe("chat");
  });
  it("next/previous slide without a known position starts at the first slide", () => {
    const c = onBoard({ sessionId: "s", manifestId: "m" });
    expect(teach("next slide", c).args).toEqual({ k: 0 });
    expect(teach("previous slide", c).args).toEqual({ k: 0 });
  });
});

describe("numberOf", () => {
  it("digits and number words in three languages", () => {
    expect(numberOf("7")).toBe(7);
    expect(numberOf("three")).toBe(3);
    expect(numberOf("lima")).toBe(5);
    expect(numberOf("ثلاثة")).toBe(3);
    expect(numberOf("عشر")).toBe(10);
    expect(numberOf("many")).toBeNull();
    expect(numberOf(undefined)).toBeNull();
  });
});
