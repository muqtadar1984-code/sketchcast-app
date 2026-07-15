import { describe, it, expect } from "vitest";
import { teacherConflicts, shapeFromConfig, cellKey, DEFAULT_SHAPE, type Slot } from "../timetable";

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
});
