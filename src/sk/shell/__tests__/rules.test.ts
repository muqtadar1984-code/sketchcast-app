/**
 * SK Shell rules router (S0): the navigate phrasing table (no model call),
 * questions → ask, bare acknowledgements → chat.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/rules.test.ts
 */
import { describe, expect, it } from "vitest";
import { SK_CHAT_NOTHING_PENDING, SK_CHAT_THANKS, classQueryOf, routeByRules, startLessonOf } from "../rules";
import { NOW, makeCtx } from "./fixtures";

const ctx = makeCtx({ selection: { classId: "sel-class", learnerId: "sel-learner" } });
const clock = { day: 3, minutes: 510, iso: "2026-10-28T16:30:00+08:00" };
const nav = (text: string) => {
  const d = routeByRules(text, ctx, NOW, clock);
  if (d.intent !== "navigate") throw new Error(`${text} → ${d.intent}`);
  return d;
};

describe("navigate phrasings (deterministic, no model)", () => {
  // phrasing → [target, filters, classQuery?]
  const table: Array<[string, string, Record<string, string>, string?]> = [
    ["show me 7B's analytics", "analytics", {}, "7b"],
    ["open the board", "board", {}],
    ["take me to my timetable", "timetable", {}],
    ["go to 7B's diary for today", "diary", { day: "2026-10-28" }, "7b"],
    ["open class 5 Amanah's analytics", "analytics", {}, "5 amanah"],
    ["show the diary for tomorrow", "diary", { day: "2026-10-29" }],
    ["open the calendar for next month", "calendar", { month: "2026-11" }],
    ["open the calendar", "calendar", {}],
    ["show me kits on fractions", "kits", { topic: "fractions" }],
    ["take me to the library", "library", {}],
    ["go to my children", "children", {}],
    ["open the school diary", "school_diary", {}],
    ["open school admin", "school_admin", {}],
    ["show me the school books", "school_books", {}],
    ["bring up the teachers page", "school_teachers", {}],
    ["open access", "school_access", {}],
    ["show me the school overview", "school", {}],
    ["open the tutor", "tutor", {}],
    ["open this class's analytics", "analytics", { classId: "sel-class" }],
    ["analytics", "analytics", {}],
    ["papan", "board", {}],
    ["buka papan", "board", {}],
    ["buka jadual", "timetable", {}],
    ["افتح اللوحة", "board", {}],
    ["اذهب إلى التقويم", "calendar", {}],
    ["let's see the board", "board", {}],
    ["switch to present mode", "board", {}],
    ["open the diary for 2026-11-02", "diary", { day: "2026-11-02" }],
    ["show me the progress record for Ali Hassan", "reports", {}],
    ["open the report", "reports", { learnerId: "sel-learner" }],
  ];
  it.each(table)("%s → %s", (text, target, filters, classQuery) => {
    const d = nav(text);
    expect(d.target).toBe(target);
    expect(d.filters).toEqual(filters);
    if (classQuery) expect(d.classQuery).toBe(classQuery);
    else expect(d.classQuery).toBeUndefined();
  });
  it("carries the learner name for a report", () => {
    expect(nav("show me the progress record for Ali Hassan").learnerQuery).toBe("Ali Hassan");
    expect(nav("open Aisyah's report").learnerQuery).toBeUndefined(); // falls to the selection
  });
  it("never reads a time as a class", () => {
    expect(classQueryOf("open the diary at 10am")).toBeUndefined();
    expect(classQueryOf("show 7b")).toBe("7b");
    expect(classQueryOf("year 7 b analytics")).toBe("7 b");
  });
});

describe("not navigation", () => {
  it.each([
    "what's on the board?",
    "which class has the most overdue work?",
    "how many learners in 7B finished the worksheet?",
    "berapa ramai pelajar siap?",
    "كم طالبا أنهى الواجب؟",
    "explain diffusion to me",
    "remind the parents of non-completers",
    "is the timetable up to date?",
  ])("%s → ask (model)", (text) => {
    expect(routeByRules(text, ctx, NOW, clock).intent).toBe("ask");
  });
  it.each(["yes", "Yes.", "ok", "okay!", "no", "sure", "ya", "baik", "نعم", "لا"])("%s → chat, nothing pending", (text) => {
    expect(routeByRules(text, ctx, NOW, clock)).toEqual({ intent: "chat", reply: SK_CHAT_NOTHING_PENDING });
  });
  it("thanks → a fixed reply", () => {
    expect(routeByRules("thanks!", ctx, NOW, clock)).toEqual({ intent: "chat", reply: SK_CHAT_THANKS });
    expect(routeByRules("terima kasih", ctx, NOW, clock)).toEqual({ intent: "chat", reply: SK_CHAT_THANKS });
  });
});

describe("day and month use the user's local clock", () => {
  it("today follows the collector's iso day, not the server's", () => {
    expect(nav("open the diary for today").filters.day).toBe("2026-10-28");
    // 07:00 on the 29th in Kuala Lumpur is still the 28th in UTC — the teacher's day wins.
    const d = routeByRules("open the diary for today", ctx, new Date("2026-10-28T23:00:00Z"), { day: 4, minutes: 420, iso: "2026-10-29T07:00:00+08:00" });
    expect(d.intent === "navigate" && d.filters.day).toBe("2026-10-29");
    const noClock = routeByRules("open the diary for yesterday", ctx, new Date("2026-10-28T23:00:00Z"));
    expect(noClock.intent === "navigate" && noClock.filters.day).toBe("2026-10-27");
  });
  it("month names and relative months", () => {
    expect(nav("open the calendar for december").filters.month).toBe("2026-12");
    expect(nav("open the calendar for last month").filters.month).toBe("2026-09");
    expect(nav("open the calendar for this month").filters.month).toBe("2026-10");
  });
});

describe("starting a lesson with no Board session (§2.7) → navigate board + autostart", () => {
  const start = (text: string, c = ctx) => {
    const d = routeByRules(text, c, NOW, clock);
    if (d.intent !== "navigate") throw new Error(`${text} → ${d.intent}`);
    return d;
  };
  // phrasing → [classQuery?, kitQuery?]
  const table: Array<[string, string | undefined, string | undefined]> = [
    ["start the lesson", undefined, undefined],
    ["Start the lesson for 7B on Specialised Cells", "7b", "Specialised Cells"],
    ["start the lesson for class 7B", "7b", undefined],
    ["start today's lesson with Plant and Animal Cells", undefined, "Plant and Animal Cells"],
    ["open the board for 7B on Specialised Cells", "7b", "Specialised Cells"],
    ["open the board with Plant and Animal Cells", undefined, "Plant and Animal Cells"],
    ["open the board for 7B", "7b", undefined],
    ["begin the class", undefined, undefined],
    ["start the video", undefined, undefined],
    ["play the intro", undefined, undefined],
    ["mulakan pelajaran", undefined, undefined],
    ["mulakan pelajaran untuk 7B tentang Sel Khusus", "7b", "Sel Khusus"],
    ["buka papan dengan Osmosis", undefined, "Osmosis"],
    ["ابدأ الدرس", undefined, undefined],
    ["ابدأ الدرس عن الانتشار", undefined, "الانتشار"],
  ];
  it.each(table)("%s", (text, classQuery, kitQuery) => {
    const d = start(text);
    expect(d.target).toBe("board");
    expect(d.filters).toEqual({ autostart: true });
    expect(d.classQuery).toBe(classQuery);
    expect(d.kitQuery).toBe(kitQuery);
  });
  it("a bare 'open the board' is a plain navigate — going there is not starting a lesson", () => {
    expect(nav("open the board")).toMatchObject({ target: "board", filters: {} });
    expect(nav("open the board").kitQuery).toBeUndefined();
    expect(nav("buka papan").filters).toEqual({});
  });
  it("startLessonOf keeps the kit's casing from the spoken text and strips a dangling preposition", () => {
    expect(startLessonOf("start the lesson on cells for 7b", "Start the lesson on Cells for 7B")).toEqual({ classQuery: "7b", kitQuery: "Cells" });
    expect(startLessonOf("open the board", "open the board")).toBeNull();
    expect(startLessonOf("pause", "pause")).toBeNull();
    expect(startLessonOf("what's on the board", "what's on the board?")).toBeNull();
  });
  it("other Board phrasings off the Board are still for the model", () => {
    expect(routeByRules("pause", ctx, NOW, clock).intent).toBe("ask");
    expect(routeByRules("slide 4", ctx, NOW, clock).intent).toBe("ask");
  });
});
