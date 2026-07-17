import { describe, it, expect } from "vitest";
import { teacherConflicts, DEFAULT_SHAPE, cellKey, type Slot } from "../timetable";
import {
  generateTimetable,
  curriculumForGrade,
  gradeNumber,
  PRIMARY_CURRICULUM,
  SECONDARY_CURRICULUM,
  type GenClass,
} from "../timetable-solver";

const SUBJECTS = Object.keys({ ...PRIMARY_CURRICULUM, ...SECONDARY_CURRICULUM });

/** N teachers per subject, ids like "t-Mathematics-0". */
function staff(perSubject: number): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const s of SUBJECTS) map[s] = Array.from({ length: perSubject }, (_, i) => `t-${s}-${i}`);
  return map;
}

describe("gradeNumber / curriculumForGrade", () => {
  it("parses grades and picks the band", () => {
    expect(gradeNumber("5")).toBe(5);
    expect(gradeNumber("Grade 11")).toBe(11);
    expect(gradeNumber("Kindergarten")).toBeNull();
    expect(curriculumForGrade("3")).toEqual(PRIMARY_CURRICULUM);
    expect(curriculumForGrade("10")).toEqual(SECONDARY_CURRICULUM);
    expect(curriculumForGrade(null)).toEqual(PRIMARY_CURRICULUM);
  });
  it("Malaysian 'Form N' / 'Tingkatan N' means grade N+6 — secondary band", () => {
    expect(gradeNumber("Form 1")).toBe(7);
    expect(gradeNumber("Form 5")).toBe(11);
    expect(gradeNumber("Tingkatan 3")).toBe(9);
    expect(curriculumForGrade("Form 4")).toEqual(SECONDARY_CURRICULUM);
  });
  it("honours per-grade overrides", () => {
    expect(curriculumForGrade("5", { "5": { Mathematics: 10 } })).toEqual({ Mathematics: 10 });
  });
});

describe("generateTimetable", () => {
  it("grades 1-12 with two sections each: full quotas, zero teacher clashes", () => {
    const classes: GenClass[] = [];
    for (let g = 1; g <= 12; g++)
      for (const sec of ["A", "B"])
        classes.push({ id: `c${g}${sec}`, grade: String(g), name: `${g} ${sec}`, teacher_id: `t-Mathematics-${g % 3}` });
    const result = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: staff(3) });

    // No teacher in two classes at once — the hard invariant.
    expect(teacherConflicts(result.slots).size).toBe(0);
    // No class cell double-filled.
    const keys = result.slots.map((s) => cellKey(s.class_id, s.day, s.period));
    expect(new Set(keys).size).toBe(keys.length);
    // Every class got its full quota (3 teachers/subject is plenty for 24 classes... per grade-pair).
    expect(result.unplaced).toEqual([]);
    for (const c of classes) {
      const mine = result.slots.filter((s) => s.class_id === c.id);
      const quota = Object.values(curriculumForGrade(c.grade)).reduce((a, b) => a + b, 0);
      expect(mine.length).toBe(quota);
    }
  });

  it("anchors each class teacher into their own class at the earliest slot", () => {
    const classes: GenClass[] = [
      { id: "c1", grade: "5", name: "5 A", teacher_id: "t-Science-0" },
      { id: "c2", grade: "5", name: "5 B", teacher_id: "t-English-0" },
    ];
    const result = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: staff(1) });
    const c1MonP1 = result.slots.find((s) => s.class_id === "c1" && s.day === 1 && s.period === 1);
    expect(c1MonP1?.teacher_id).toBe("t-Science-0");
    expect(c1MonP1?.subject).toBe("Science");
    // Second section's teacher also anchors their own class (different subject,
    // so Mon P1 is free for them too).
    const c2MonP1 = result.slots.find((s) => s.class_id === "c2" && s.day === 1 && s.period === 1);
    expect(c2MonP1?.teacher_id).toBe("t-English-0");
  });

  it("reports unplaced lessons when a subject has ONE teacher shared by many sections", () => {
    // 8 sections of grade 7 need Science 5×8 = 40 periods; one teacher has 40
    // cells total but must also be free when each class is free — feasible in
    // principle, but with everything else competing some spill is expected;
    // the invariant is: whatever IS placed never clashes, and the shortfall is
    // REPORTED, not hidden.
    const classes: GenClass[] = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      grade: "7",
      name: `7 S${i}`,
      teacher_id: null,
    }));
    const teachers = staff(2);
    teachers.Science = ["only-science-teacher"];
    const result = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: teachers });
    expect(teacherConflicts(result.slots).size).toBe(0);
    const sciencePlaced = result.slots.filter((s) => s.subject === "Science").length;
    const scienceUnplaced = result.unplaced.filter((u) => u.subject === "Science").reduce((a, u) => a + u.count, 0);
    expect(sciencePlaced + scienceUnplaced).toBe(8 * SECONDARY_CURRICULUM.Science);
    expect(sciencePlaced).toBeLessThanOrEqual(DEFAULT_SHAPE.days * DEFAULT_SHAPE.periods.length); // one human's week
  });

  it("subjects with NO mapped teacher are fully reported unplaced", () => {
    const teachers = staff(1);
    delete teachers.PE;
    const result = generateTimetable({
      shape: DEFAULT_SHAPE,
      classes: [{ id: "c1", grade: "2", name: "2 A", teacher_id: null }],
      subjectTeachers: teachers,
    });
    expect(result.unplaced).toEqual([{ classId: "c1", subject: "PE", count: PRIMARY_CURRICULUM.PE }]);
  });

  it("hand-typed pin subjects ('Maths') count against the canonical quota — no double-scheduling", () => {
    const pinned: Slot[] = Array.from({ length: 5 }, (_, i) => ({
      class_id: "c1",
      day: 1 + i,
      period: 1,
      subject: "Maths", // free-text drift for Mathematics
      teacher_id: "pinned-maths",
    }));
    const result = generateTimetable({
      shape: DEFAULT_SHAPE,
      classes: [{ id: "c1", grade: "5", name: "5 A", teacher_id: null }],
      subjectTeachers: staff(2),
      pinned,
    });
    // Quota for Mathematics is 5, fully satisfied by the pins.
    expect(result.slots.filter((s) => s.subject === "Mathematics")).toHaveLength(0);
  });

  it("fill mode respects pins: never overwrites a cell or double-books the pinned teacher", () => {
    const pinned: Slot[] = [
      { class_id: "c1", day: 1, period: 1, subject: "Art", teacher_id: "pinned-art" },
      { class_id: "c2", day: 1, period: 1, subject: "Music", teacher_id: "pinned-music" },
    ];
    const classes: GenClass[] = [
      { id: "c1", grade: "5", name: "5 A", teacher_id: null },
      { id: "c2", grade: "5", name: "5 B", teacher_id: null },
    ];
    const result = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: staff(2), pinned });
    // No generated slot lands on a pinned cell.
    for (const p of pinned) {
      expect(result.slots.find((s) => s.class_id === p.class_id && s.day === p.day && s.period === p.period)).toBeUndefined();
    }
    // Pins count toward quotas: c1 owes one less Art.
    const c1Art = result.slots.filter((s) => s.class_id === "c1" && s.subject === "Art").length;
    expect(c1Art).toBe(PRIMARY_CURRICULUM.Art - 1);
    // And the combined grid (pins + generated) is clash-free.
    expect(teacherConflicts([...pinned, ...result.slots]).size).toBe(0);
  });

  it("honours maxPerTeacherPerDay: no teacher-day exceeds the cap", () => {
    // One teacher per subject makes the cap bind hard.
    const classes: GenClass[] = Array.from({ length: 4 }, (_, i) => ({
      id: `c${i}`,
      grade: "5",
      name: `5 S${i}`,
      teacher_id: null,
    }));
    const result = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: staff(1), maxPerTeacherPerDay: 4 });
    const perDay = new Map<string, number>();
    for (const s of result.slots) {
      const k = `${s.teacher_id}|${s.day}`;
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    for (const count of perDay.values()) expect(count).toBeLessThanOrEqual(4);
    expect(teacherConflicts(result.slots).size).toBe(0);
  });

  it("pinned lessons count toward the day cap; nonteaching pins don't", () => {
    // 4 pinned Monday lessons + cap 4 → the solver may give this teacher
    // nothing more on Monday.
    const pinned: Slot[] = Array.from({ length: 4 }, (_, i) => ({
      class_id: "c-other",
      day: 1,
      period: i + 1,
      subject: "Mathematics",
      teacher_id: "t-Mathematics-0",
    }));
    pinned.push({
      class_id: "c-other",
      day: 1,
      period: 5,
      subject: "Assembly",
      teacher_id: "t-Mathematics-0",
      kind: "nonteaching",
    });
    const result = generateTimetable({
      shape: DEFAULT_SHAPE,
      classes: [{ id: "c1", grade: "5", name: "5 A", teacher_id: null }],
      subjectTeachers: staff(1),
      pinned,
      maxPerTeacherPerDay: 4,
    });
    const mondayMaths = result.slots.filter((s) => s.teacher_id === "t-Mathematics-0" && s.day === 1);
    expect(mondayMaths).toHaveLength(0);
  });

  it("is deterministic: same input, identical output", () => {
    const classes: GenClass[] = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      grade: String((i % 3) + 4),
      name: `Class ${i}`,
      teacher_id: `t-English-0`,
    }));
    const a = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: staff(2) });
    const b = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: staff(2) });
    expect(a).toEqual(b);
  });
});
