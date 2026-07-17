import { describe, it, expect } from "vitest";
import { isoWeekday, pickSubstitutes, type PickInput } from "../substitution";
import type { Slot } from "../timetable";

const lesson = (cls: string, day: number, period: number, teacher: string, subject = "Mathematics"): Slot => ({
  class_id: cls,
  day,
  period,
  subject,
  teacher_id: teacher,
});

const base = (over: Partial<PickInput>): PickInput => ({
  slots: [],
  day: 1,
  targetTeacherId: "absent-t",
  absentTeacherIds: new Set(["absent-t"]),
  staff: [
    { id: "absent-t", name: "Absent" },
    { id: "maths-t", name: "Maths Sub" },
    { id: "other-t", name: "Other Sub" },
  ],
  subjectsByTeacher: new Map([["maths-t", new Set(["Mathematics"])]]),
  classTeacherByClass: new Map(),
  existingSubs: [],
  maxPerTeacherPerDay: 6,
  ...over,
});

describe("isoWeekday", () => {
  it("maps dates to ISO weekdays (Mon=1..Sun=7)", () => {
    expect(isoWeekday("2026-07-13")).toBe(1); // a Monday
    expect(isoWeekday("2026-07-17")).toBe(5); // a Friday
    expect(isoWeekday("2026-07-19")).toBe(7); // a Sunday
  });
  it("rejects malformed and impossible dates", () => {
    expect(isoWeekday("17-07-2026")).toBeNull();
    expect(isoWeekday("2026-02-31")).toBeNull();
    expect(isoWeekday("nonsense")).toBeNull();
  });
});

describe("pickSubstitutes", () => {
  it("prefers a subject teacher over anyone else", () => {
    const input = base({ slots: [lesson("c1", 1, 2, "absent-t")] });
    const out = pickSubstitutes(input);
    expect(out).toHaveLength(1);
    expect(out[0].substitute_teacher_id).toBe("maths-t");
    expect(out[0]).toMatchObject({ class_id: "c1", period: 2, subject: "Mathematics" });
  });

  it("subject match is case/whitespace tolerant", () => {
    const input = base({
      slots: [lesson("c1", 1, 2, "absent-t", "  mathematics ")],
      subjectsByTeacher: new Map([["maths-t", new Set(["MATHEMATICS"])]]),
    });
    expect(pickSubstitutes(input)[0].substitute_teacher_id).toBe("maths-t");
  });

  it("falls back to the class teacher, then lightest day load", () => {
    const input = base({
      slots: [
        lesson("c1", 1, 2, "absent-t", "History"), // nobody declares History
        lesson("c9", 1, 1, "other-t"), // other-t already has 1 lesson today
      ],
      classTeacherByClass: new Map([["c1", "other-t"]]),
    });
    // Class teacher beats the lighter-loaded maths-t.
    expect(pickSubstitutes(input)[0].substitute_teacher_id).toBe("other-t");
    // Without the class-teacher edge, lightest load wins.
    const noCt = base({
      slots: [
        lesson("c1", 1, 2, "absent-t", "History"),
        lesson("c9", 1, 1, "other-t"),
      ],
    });
    expect(pickSubstitutes(noCt)[0].substitute_teacher_id).toBe("maths-t");
  });

  it("never books a busy teacher, an absent teacher, or anyone at the day cap", () => {
    const input = base({
      slots: [
        lesson("c1", 1, 2, "absent-t"),
        lesson("c9", 1, 2, "maths-t"), // busy that period
        ...Array.from({ length: 6 }, (_, i) => lesson(`x${i}`, 1, i + 3, "other-t")), // at cap 6
      ],
    });
    expect(pickSubstitutes(input)[0].substitute_teacher_id).toBeNull(); // no cover found
  });

  it("two absences the same day never get the same cover at one period", () => {
    const input = base({
      slots: [lesson("c1", 1, 2, "absent-t")],
      existingSubs: [{ period: 2, substitute_teacher_id: "maths-t" }], // covering someone else P2
    });
    expect(pickSubstitutes(input)[0].substitute_teacher_id).toBe("other-t");
  });

  it("covers each of the absent teacher's lessons once, skipping nonteaching cells", () => {
    const input = base({
      slots: [
        lesson("c1", 1, 1, "absent-t"),
        lesson("c2", 1, 3, "absent-t"),
        { ...lesson("c3", 1, 5, "absent-t"), kind: "nonteaching", subject: "Assembly" },
        lesson("c4", 2, 1, "absent-t"), // different day — not today's problem
      ],
    });
    const out = pickSubstitutes(input);
    expect(out.map((a) => a.period)).toEqual([1, 3]);
    expect(out.every((a) => a.substitute_teacher_id !== null)).toBe(true);
  });

  it("within one absence, the same sub can cover different periods but never two classes at once", () => {
    const input = base({
      slots: [lesson("c1", 1, 1, "absent-t"), lesson("c2", 1, 2, "absent-t")],
      staff: [
        { id: "absent-t", name: "Absent" },
        { id: "maths-t", name: "Maths Sub" },
      ],
    });
    const out = pickSubstitutes(input);
    expect(out[0].substitute_teacher_id).toBe("maths-t");
    expect(out[1].substitute_teacher_id).toBe("maths-t");
  });

  it("coverLessons override re-covers an orphaned assignment instead of deriving from the grid", () => {
    // The absent teacher has NO grid lessons today — but they were covering
    // someone else's P4, and that orphaned cell is passed explicitly.
    const input = base({
      slots: [lesson("c9", 1, 4, "someone-else")],
      coverLessons: [lesson("c9", 1, 4, "other-absent-t")],
      absentTeacherIds: new Set(["absent-t", "other-absent-t"]),
    });
    const out = pickSubstitutes(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ class_id: "c9", period: 4 });
    expect(out[0].substitute_teacher_id).toBe("maths-t");
    // And absent teachers are never candidates even via the override path.
    expect(out[0].substitute_teacher_id).not.toBe("other-absent-t");
  });

  it("is deterministic", () => {
    const input = base({ slots: [lesson("c1", 1, 1, "absent-t"), lesson("c2", 1, 4, "absent-t")] });
    expect(pickSubstitutes(input)).toEqual(pickSubstitutes(base({ slots: input.slots })));
  });
});
