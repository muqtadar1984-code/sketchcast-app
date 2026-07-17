import { describe, it, expect } from "vitest";
import {
  teacherConflicts,
  shapeFromConfig,
  cellKey,
  dayOverloads,
  teacherDayLoads,
  timeToMinutes,
  minutesToTime,
  layoutTimes,
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
  it("rejects out-of-range clock values everywhere (start/end/periods/breaks)", () => {
    const s = shapeFromConfig({
      timetable: {
        start: "24:00",
        end: "12:99",
        periods: [{ label: "P1", time: "09:1" }, { label: "P2", time: "10:00" }],
        breaks: [{ label: "Recess", time: "25:30", minutes: 15, afterPeriod: 1 }],
      },
    });
    expect(s.start).toBe("07:45"); // 24:00 is not a clock time
    expect(s.end).toBe("14:45");
    expect(s.periods).toEqual([
      { label: "P1", time: undefined }, // half-typed time dropped, label kept
      { label: "P2", time: "10:00" },
    ]);
    expect(s.breaks?.[0].time).toBeUndefined();
  });
});

describe("layoutTimes (derived day timeline)", () => {
  it("reproduces the default shape exactly: 07:45 start, 45-min periods, snack + lunch", () => {
    const { periodTimes, breakTimes, end } = layoutTimes(465, 45, 8, DEFAULT_SHAPE.breaks!);
    expect(periodTimes).toEqual(DEFAULT_SHAPE.periods.map((p) => p.time));
    expect(breakTimes).toEqual(["10:45", "12:30"]);
    expect(end).toBe("14:45");
  });
  it("re-flows when the period length changes to 30 minutes", () => {
    const { periodTimes, end } = layoutTimes(465, 30, 4, []);
    expect(periodTimes).toEqual(["07:45", "08:15", "08:45", "09:15"]);
    expect(end).toBe("09:45");
  });
  it("a break before P1 delays the whole day; one after a removed period clamps to the last", () => {
    const opening = layoutTimes(480, 40, 2, [{ label: "Assembly", minutes: 20, afterPeriod: 0 }]);
    expect(opening.breakTimes).toEqual(["08:00"]);
    expect(opening.periodTimes).toEqual(["08:20", "09:00"]);
    const clamped = layoutTimes(480, 40, 2, [{ label: "Late break", minutes: 10, afterPeriod: 9 }]);
    expect(clamped.breakTimes).toEqual(["09:20"]); // after P2, the last period
    expect(clamped.end).toBe("09:30");
  });
});

describe("clock helpers", () => {
  it("round-trips hh:mm through minutes", () => {
    expect(timeToMinutes("07:45")).toBe(465);
    expect(minutesToTime(465)).toBe("07:45");
    expect(minutesToTime(timeToMinutes("23:59")! + 2)).toBe("00:01"); // wraps
    expect(minutesToTime(timeToMinutes("00:30")! - 60)).toBe("23:30"); // negative shift wraps back
  });
  it("rejects non-times", () => {
    expect(timeToMinutes("late")).toBeNull();
    expect(timeToMinutes("25:00")).toBeNull();
    expect(timeToMinutes("07:75")).toBeNull();
    expect(timeToMinutes("")).toBeNull();
    expect(timeToMinutes(undefined)).toBeNull();
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
