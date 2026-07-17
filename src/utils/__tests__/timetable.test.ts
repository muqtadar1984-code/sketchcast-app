import { describe, it, expect } from "vitest";
import {
  teacherConflicts,
  shapeFromConfig,
  cellKey,
  dayOverloads,
  teacherDayLoads,
  DEFAULT_SHAPE,
  type Slot,
} from "../timetable";

const slot = (cls: string, day: number, period: number, teacher: string | null): Slot => ({
  class_id: cls,
  day,
  period,
  subject: "Maths",
  teacher_id: teacher,
});

describe("teacherConflicts", () => {
  it("flags BOTH cells when a teacher is in two classes at the same time", () => {
    const conflicts = teacherConflicts([
      slot("c1", 1, 1, "t1"),
      slot("c2", 1, 1, "t1"), // clash with the row above
      slot("c1", 1, 2, "t1"), // same teacher, different period — fine
      slot("c2", 2, 1, "t2"),
    ]);
    expect(conflicts).toEqual(new Set([cellKey("c1", 1, 1), cellKey("c2", 1, 1)]));
  });
  it("ignores unassigned cells and same-class duplicates", () => {
    expect(teacherConflicts([slot("c1", 1, 1, null), slot("c2", 1, 1, null)]).size).toBe(0);
    // Two rows of the same class/time (impossible via the DB unique index, but
    // must not count as a teacher clash).
    expect(teacherConflicts([slot("c1", 1, 1, "t1"), slot("c1", 1, 1, "t1")]).size).toBe(0);
  });
  it("a three-way clash flags all three cells", () => {
    const conflicts = teacherConflicts([slot("c1", 3, 4, "t9"), slot("c2", 3, 4, "t9"), slot("c3", 3, 4, "t9")]);
    expect(conflicts.size).toBe(3);
  });
  it("the seeder's Latin-square rotation is conflict-free", () => {
    const classes = ["c0", "c1", "c2", "c3", "c4"];
    const teachers = ["t0", "t1", "t2", "t3", "t4"];
    const slots: Slot[] = [];
    for (let c = 0; c < 5; c++)
      for (let day = 1; day <= 5; day++)
        for (let period = 1; period <= 6; period++)
          slots.push(slot(classes[c], day, period, teachers[(c + period + day) % 5]));
    expect(teacherConflicts(slots).size).toBe(0);
  });
});

describe("shapeFromConfig", () => {
  it("falls back to Mon-Fri × 8 on missing/garbage config", () => {
    expect(shapeFromConfig(null)).toEqual(DEFAULT_SHAPE);
    expect(shapeFromConfig({})).toEqual(DEFAULT_SHAPE);
    expect(shapeFromConfig({ timetable: { days: 99, periods: "nope" } }).days).toBe(5);
    expect(shapeFromConfig({ timetable: { periods: [] } }).periods).toEqual(DEFAULT_SHAPE.periods);
  });
  it("honours a valid per-school shape and fills period labels", () => {
    const s = shapeFromConfig({ timetable: { days: 6, periods: [{ time: "08:00" }, { label: "Late" }] } });
    expect(s.days).toBe(6);
    expect(s.periods).toEqual([
      { label: "P1", time: "08:00" },
      { label: "Late", time: undefined },
    ]);
  });
  it("defaults school hours, breaks and the day cap when unset", () => {
    const s = shapeFromConfig({ timetable: { days: 5 } });
    expect(s.start).toBe("07:45");
    expect(s.end).toBe("14:45");
    expect(s.breaks).toEqual(DEFAULT_SHAPE.breaks);
    expect(s.maxPerTeacherPerDay).toBe(6);
  });
  it("honours configured hours/breaks/cap; empty breaks means NO breaks", () => {
    const s = shapeFromConfig({
      timetable: {
        start: "08:00",
        end: "13:30",
        breaks: [{ label: "Recess", time: "10:00", minutes: 20, afterPeriod: 3 }],
        maxPerTeacherPerDay: 5,
      },
    });
    expect(s.start).toBe("08:00");
    expect(s.end).toBe("13:30");
    expect(s.breaks).toEqual([{ label: "Recess", time: "10:00", minutes: 20, afterPeriod: 3 }]);
    expect(s.maxPerTeacherPerDay).toBe(5);
    expect(shapeFromConfig({ timetable: { breaks: [] } }).breaks).toEqual([]);
  });
  it("rejects garbage hour/break/cap values field-by-field", () => {
    const s = shapeFromConfig({
      timetable: { start: "late", end: 9, breaks: "none", maxPerTeacherPerDay: 99 },
    });
    expect(s.start).toBe("07:45");
    expect(s.end).toBe("14:45");
    expect(s.breaks).toEqual(DEFAULT_SHAPE.breaks);
    expect(s.maxPerTeacherPerDay).toBe(6);
  });
});

describe("nonteaching cells", () => {
  it("are exempt from clash detection — assembly across all classes is fine", () => {
    const assembly: Slot[] = ["c1", "c2", "c3"].map((c) => ({
      ...slot(c, 1, 1, "duty-teacher"),
      subject: "Assembly",
      kind: "nonteaching",
    }));
    expect(teacherConflicts(assembly).size).toBe(0);
    // But the same rows as lessons WOULD clash.
    expect(teacherConflicts(assembly.map((s) => ({ ...s, kind: "lesson" }))).size).toBe(3);
  });
});

describe("day loads / overloads", () => {
  it("counts lesson periods per teacher-day, ignoring nonteaching cells", () => {
    const slots: Slot[] = [
      slot("c1", 1, 1, "t1"),
      slot("c1", 1, 2, "t1"),
      { ...slot("c1", 1, 3, "t1"), kind: "nonteaching" },
      slot("c2", 2, 1, "t1"),
    ];
    const loads = teacherDayLoads(slots);
    expect(loads.get("t1|1")).toBe(2);
    expect(loads.get("t1|2")).toBe(1);
  });
  it("flags only teachers OVER the cap", () => {
    const slots: Slot[] = Array.from({ length: 7 }, (_, i) => slot(`c${i}`, 1, i + 1, "busy-t"));
    slots.push(slot("c9", 2, 1, "light-t"));
    expect(dayOverloads(slots, 6)).toEqual([{ teacher_id: "busy-t", day: 1, count: 7 }]);
    expect(dayOverloads(slots, 7)).toEqual([]);
  });
});
