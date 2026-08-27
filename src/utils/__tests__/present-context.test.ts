import { describe, it, expect } from "vitest";
import {
  periodWindows,
  periodAt,
  slotFor,
  resolveContext,
  advancesPointer,
  type LastTaught,
} from "@/utils/present/context";
import { DEFAULT_SHAPE, type Slot, type TimetableShape } from "@/utils/timetable";

const TEACHER = "t1";
const CLASS = "c-amanah";

const shape: TimetableShape = {
  ...DEFAULT_SHAPE,
  days: 5,
  periodMinutes: 45,
  periods: [
    { label: "P1", time: "07:45" },
    { label: "P2", time: "08:30" },
    { label: "P3", time: "10:40" }, // a break sits before this one
    { label: "P4", time: "11:25" },
  ],
};

const slot = (over: Partial<Slot> = {}): Slot => ({
  class_id: CLASS,
  day: 2,
  period: 3,
  subject: "Science",
  teacher_id: TEACHER,
  ...over,
});

const at = (h: number, m: number) => h * 60 + m;

const resolve = (over: Partial<Parameters<typeof resolveContext>[0]> = {}) =>
  resolveContext({
    teacherId: TEACHER,
    shape,
    slots: [slot()],
    lastTaught: [],
    day: 2,
    minutes: at(10, 50),
    ...over,
  });

describe("period windows", () => {
  it("ends a period where the next one starts, so a break belongs to the period before", () => {
    // A teacher opening the board during the interval is preparing for the NEXT
    // period; a bar that went blank through every break would be blank exactly
    // when she is setting up.
    const w = periodWindows(shape);
    expect(w[1]).toMatchObject({ period: 2, startMin: at(8, 30), endMin: at(10, 40) });
  });

  it("bounds the last period by the period length, having no successor to borrow from", () => {
    const w = periodWindows(shape);
    expect(w[3]).toMatchObject({ period: 4, startMin: at(11, 25), endMin: at(12, 10) });
  });

  it("ignores periods with no time and keeps the rest in clock order", () => {
    const w = periodWindows({
      ...shape,
      periods: [{ label: "P1", time: "09:00" }, { label: "P2" }, { label: "P3", time: "08:00" }],
    });
    expect(w.map((p) => p.label)).toEqual(["P3", "P1"]);
  });
});

describe("which period the clock points at", () => {
  const w = periodWindows(shape);

  it("is 'in' while a period is running", () => {
    expect(periodAt(w, at(10, 50))).toMatchObject({ period: 3, state: "in" });
  });

  it("is 'next' in the run-up to the first period of the day", () => {
    expect(periodAt(w, at(7, 30))).toMatchObject({ period: 1, state: "next" });
  });

  it("counts the last minute of a period as still in it, and the first of the next as next", () => {
    expect(periodAt(w, at(11, 24))).toMatchObject({ period: 3, state: "in" });
    expect(periodAt(w, at(11, 25))).toMatchObject({ period: 4, state: "in" });
  });

  it("RETURNS NULL AFTER THE LAST PERIOD rather than the last period of the day", () => {
    // Pre-filling a period that has already finished would have her confirm a
    // context that is simply wrong.
    expect(periodAt(w, at(15, 0))).toBeNull();
  });
});

describe("finding her lesson", () => {
  it("matches teacher, day and period", () => {
    expect(slotFor([slot()], TEACHER, 2, 3)?.class_id).toBe(CLASS);
    expect(slotFor([slot()], "someone-else", 2, 3)).toBeNull();
    expect(slotFor([slot()], TEACHER, 3, 3)).toBeNull();
  });

  it("REFUSES a non-teaching cell", () => {
    // Assembly and duty periods are in the grid but they are not lessons, and a
    // bar that filled itself in during assembly would be confidently wrong.
    expect(slotFor([slot({ kind: "nonteaching" })], TEACHER, 2, 3)).toBeNull();
  });
});

describe("resolving the bar", () => {
  it("names the class and subject from her timetable", () => {
    const c = resolve();
    expect(c.confidence).toBe("slot");
    expect(c.classId).toBe(CLASS);
    expect(c.subject).toBe("Science");
    expect(c.period?.period).toBe(3);
    expect(c.timeLabel).toBe("10:40 – 11:25");
  });

  it("says 'period' when a period is running but she teaches nothing in it", () => {
    // Free period. Honest emptiness beats a confident guess.
    const c = resolve({ slots: [] });
    expect(c.confidence).toBe("period");
    expect(c.classId).toBeNull();
    expect(c.period?.period).toBe(3);
  });

  it("says 'none' on a day outside the school week", () => {
    // A Saturday is not a short Monday.
    expect(resolve({ day: 6 }).confidence).toBe("none");
    expect(resolve({ day: 0 }).confidence).toBe("none");
  });

  it("says 'none' after the school day has finished", () => {
    expect(resolve({ minutes: at(16, 30) }).confidence).toBe("none");
  });

  it("says 'none' for a teacher with no timetable at all", () => {
    // The permanent state of every independent teacher, and the first thing
    // anyone trying this will be in.
    const c = resolve({ slots: [], shape: { ...shape, periods: [] } });
    expect(c.confidence).toBe("none");
    expect(c.suggestion).toBeNull();
  });

  it("suggests RESUMING the part she last taught this class in this subject", () => {
    const lastTaught: LastTaught[] = [
      { class_id: CLASS, subject: "Science", book_id: "bk1", chapter_num: 4, part: 2 },
    ];
    const c = resolve({ lastTaught });
    expect(c.suggestion).toEqual({ bookId: "bk1", chapterNum: 4, part: 2, hint: "resume" });
  });

  it("does not borrow a pointer from the same class in a DIFFERENT subject", () => {
    // A class is at chapter 4 in Science and chapter 9 in Mathematics.
    const lastTaught: LastTaught[] = [
      { class_id: CLASS, subject: "Mathematics", book_id: "bk-maths", chapter_num: 9, part: 1 },
    ];
    expect(resolve({ lastTaught }).suggestion).toEqual({
      bookId: null,
      chapterNum: null,
      part: null,
      hint: "first",
    });
  });

  it("asks her to pick on the first lesson with a class", () => {
    expect(resolve().suggestion?.hint).toBe("first");
  });

  it("fills the bar during the break before a period, for the period ahead", () => {
    const c = resolve({ minutes: at(10, 20) }); // inside P2's window, which runs to 10:40
    expect(c.period?.period).toBe(2);
    expect(c.confidence).toBe("period"); // she teaches P3, not P2
  });
});

describe("what may advance the class's pointer", () => {
  const session = { book_id: "bk1", chapter_num: 4, part: 2 };

  it("advances on the slot's OWN video or worksheet", () => {
    expect(advancesPointer(session, { kind: "video", bookId: "bk1", chapterNum: 4, part: 2 })).toBe(true);
    expect(advancesPointer(session, { kind: "worksheet", bookId: "bk1", chapterNum: 4, part: 2 })).toBe(true);
  });

  it("REFUSES a revision worksheet from another chapter", () => {
    // The rule the whole schema is shaped around. Revising chapters 1-5 during a
    // Chapter 4 lesson must not claim chapter 5 is taught, or her next lesson
    // opens on the wrong chapter with nothing to explain why.
    expect(advancesPointer(session, { kind: "worksheet", bookId: "bk1", chapterNum: 1, part: null })).toBe(false);
    expect(advancesPointer(session, { kind: "worksheet", bookId: "bk1", chapterNum: null, part: null })).toBe(false);
  });

  it("refuses another part of the same chapter", () => {
    expect(advancesPointer(session, { kind: "video", bookId: "bk1", chapterNum: 4, part: 3 })).toBe(false);
  });

  it("refuses another book entirely", () => {
    expect(advancesPointer(session, { kind: "video", bookId: "bk2", chapterNum: 4, part: 2 })).toBe(false);
  });

  it("never advances on a blank board", () => {
    expect(advancesPointer(session, { kind: "blank" })).toBe(false);
  });

  it("advances nothing when the session had no book to begin with", () => {
    expect(
      advancesPointer({ book_id: null, chapter_num: null, part: null }, { kind: "video", bookId: "bk1" }),
    ).toBe(false);
  });
});
