import { describe, it, expect } from "vitest";
import { teacherConflicts, cellKey, DEFAULT_SHAPE, type Slot } from "../timetable";
import {
  generateTimetable,
  curriculumForGrade,
  gradeNumber,
  DEFAULT_CORE_SUBJECTS,
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

const DAYS = DEFAULT_SHAPE.days;

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
  it("honours per-grade membership overrides", () => {
    expect(curriculumForGrade("5", { "5": { Mathematics: 1 } })).toEqual({ Mathematics: 1 });
  });
});

describe("generateTimetable (core-daily model)", () => {
  it("grades 1-12, two sections: every core runs EVERY day in every class, zero clashes", () => {
    const classes: GenClass[] = [];
    for (let g = 1; g <= 12; g++)
      for (const sec of ["A", "B"])
        classes.push({ id: `c${g}${sec}`, grade: String(g), name: `${g} ${sec}`, teacher_id: `t-Mathematics-${g % 3}` });
    const result = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: staff(4) });

    expect(teacherConflicts(result.slots).size).toBe(0);
    const keys = result.slots.map((s) => cellKey(s.class_id, s.day, s.period));
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.unplaced).toEqual([]);
    for (const c of classes) {
      for (const core of DEFAULT_CORE_SUBJECTS) {
        for (let d = 1; d <= DAYS; d++) {
          expect(
            result.slots.some((s) => s.class_id === c.id && s.day === d && s.subject === core),
            `${c.id} ${core} day ${d}`,
          ).toBe(true);
        }
      }
    }
  });

  it("the class teacher holds Period 1 EVERY day, teaching their own subject", () => {
    const classes: GenClass[] = [
      { id: "c1", grade: "5", name: "5 A", teacher_id: "t-Science-0" },
      { id: "c2", grade: "5", name: "5 B", teacher_id: "t-English-0" },
    ];
    const result = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: staff(2) });
    for (let d = 1; d <= DAYS; d++) {
      const c1P1 = result.slots.find((s) => s.class_id === "c1" && s.day === d && s.period === 1);
      expect(c1P1?.teacher_id).toBe("t-Science-0");
      expect(c1P1?.subject).toBe("Science");
      const c2P1 = result.slots.find((s) => s.class_id === "c2" && s.day === d && s.period === 1);
      expect(c2P1?.teacher_id).toBe("t-English-0");
      expect(c2P1?.subject).toBe("English");
    }
  });

  it("fillers pack the rest of the week with variety — no quotas, no early-week bunching", () => {
    const classes: GenClass[] = [{ id: "c1", grade: "4", name: "4 A", teacher_id: "t-Mathematics-0" }];
    const result = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: staff(1) });
    // One class, a full staff: every cell fills.
    expect(result.slots.length).toBe(DAYS * DEFAULT_SHAPE.periods.length);
    // Fillers actually vary: at least 5 distinct non-core subjects used.
    const fillerSubjects = new Set(result.slots.filter((s) => !DEFAULT_CORE_SUBJECTS.includes(s.subject)).map((s) => s.subject));
    expect(fillerSubjects.size).toBeGreaterThanOrEqual(5);
    // Friday is as full as Monday — the old quota model left week-ends blank.
    const onDay = (d: number) => result.slots.filter((s) => s.day === d).length;
    expect(onDay(DAYS)).toBe(onDay(1));
  });

  it("a core with NO mapped teacher is reported as missed on every school day", () => {
    const teachers = staff(1);
    delete teachers.Science;
    const result = generateTimetable({
      shape: DEFAULT_SHAPE,
      classes: [{ id: "c1", grade: "2", name: "2 A", teacher_id: null }],
      subjectTeachers: teachers,
    });
    expect(result.unplaced).toEqual([{ classId: "c1", subject: "Science", count: DAYS }]);
  });

  it("secondary classes skip primary-only fillers (no Music in Form 4)", () => {
    const classes: GenClass[] = [{ id: "c1", grade: "Form 4", name: "4 Bakti", teacher_id: null }];
    const result = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: staff(1) });
    expect(result.slots.some((s) => s.subject === "Music")).toBe(false);
  });

  it("honours maxPerTeacherPerDay; over-tight caps surface as missed cores", () => {
    const classes: GenClass[] = Array.from({ length: 5 }, (_, i) => ({
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
    // 5 classes need each core daily but its single teacher may give only 4 → 1 missed per core per day.
    expect(result.unplaced.length).toBeGreaterThan(0);
    expect(teacherConflicts(result.slots).size).toBe(0);
  });

  it("pins are never overwritten, and a hand-typed 'Maths' pin counts as that day's core Maths", () => {
    const pinned: Slot[] = [
      { class_id: "c1", day: 1, period: 3, subject: "Maths", teacher_id: "pinned-t" },
      { class_id: "c1", day: 2, period: 5, subject: "Art", teacher_id: "pinned-art" },
    ];
    const result = generateTimetable({
      shape: DEFAULT_SHAPE,
      classes: [{ id: "c1", grade: "5", name: "5 A", teacher_id: null }],
      subjectTeachers: staff(2),
      pinned,
    });
    for (const p of pinned) {
      expect(result.slots.find((s) => s.class_id === p.class_id && s.day === p.day && s.period === p.period)).toBeUndefined();
    }
    // The pinned "Maths" IS Monday's Mathematics — no second one generated.
    expect(result.slots.filter((s) => s.day === 1 && s.subject === "Mathematics")).toHaveLength(0);
    // Other days still get their daily Mathematics.
    expect(result.slots.filter((s) => s.day === 2 && s.subject === "Mathematics")).toHaveLength(1);
    expect(teacherConflicts([...pinned, ...result.slots]).size).toBe(0);
  });

  it("pinned lessons count toward the day cap; nonteaching pins don't", () => {
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
    // The only Maths teacher is at the cap on Monday → c1 misses Monday's Maths.
    expect(result.slots.filter((s) => s.class_id === "c1" && s.teacher_id === "t-Mathematics-0" && s.day === 1)).toHaveLength(0);
    expect(result.unplaced).toContainEqual({ classId: "c1", subject: "Mathematics", count: 1 });
  });

  it("custom coreSubjects override the default set", () => {
    const classes: GenClass[] = [{ id: "c1", grade: "5", name: "5 A", teacher_id: null }];
    const result = generateTimetable({
      shape: DEFAULT_SHAPE,
      classes,
      subjectTeachers: staff(1),
      coreSubjects: ["Mathematics", "History"],
    });
    for (let d = 1; d <= DAYS; d++) {
      expect(result.slots.some((s) => s.day === d && s.subject === "History")).toBe(true);
    }
    // English is a filler now — it may repeat or skip days, but it is not guaranteed daily.
    expect(result.unplaced).toEqual([]);
  });

  it("alias-keyed mappings ('BM', 'Maths') land in ONE canonical ledger — cores daily, no runaway filler", () => {
    const result = generateTimetable({
      shape: DEFAULT_SHAPE,
      classes: [{ id: "c1", grade: "5", name: "5 A", teacher_id: null }],
      subjectTeachers: { BM: ["t-bm"], English: ["t-en"], Maths: ["t-m"], Science: ["t-s"], Art: ["t-a"] },
    });
    // Output uses canonical names, never the alias.
    expect(result.slots.some((s) => s.subject === "BM" || s.subject === "Maths")).toBe(false);
    for (let d = 1; d <= DAYS; d++) {
      expect(result.slots.filter((s) => s.day === d && s.subject === "Bahasa Melayu")).toHaveLength(1);
      expect(result.slots.filter((s) => s.day === d && s.subject === "Mathematics")).toHaveLength(1);
    }
    expect(result.unplaced).toEqual([]);
    // Art is the only filler — it fills remaining cells but never becomes a phantom core.
    expect(result.slots.filter((s) => s.subject === "Art").length).toBeGreaterThan(0);
  });

  it("coreSubjects:['Maths'] canonicalizes onto the 'Mathematics' mapping — no phantom gap", () => {
    const result = generateTimetable({
      shape: DEFAULT_SHAPE,
      classes: [{ id: "c1", grade: "5", name: "5 A", teacher_id: null }],
      subjectTeachers: staff(1),
      coreSubjects: ["Maths"],
    });
    for (let d = 1; d <= DAYS; d++) {
      expect(result.slots.filter((s) => s.day === d && s.subject === "Mathematics")).toHaveLength(1);
    }
    expect(result.unplaced).toEqual([]);
  });

  it("a Malay-named pin ('Matematik') counts as that day's core Maths", () => {
    const pinned: Slot[] = [{ class_id: "c1", day: 1, period: 3, subject: "Matematik", teacher_id: "pinned-t" }];
    const result = generateTimetable({
      shape: DEFAULT_SHAPE,
      classes: [{ id: "c1", grade: "5", name: "5 A", teacher_id: null }],
      subjectTeachers: staff(1),
      pinned,
    });
    expect(result.slots.filter((s) => s.day === 1 && s.subject === "Mathematics")).toHaveLength(0);
    expect(result.slots.filter((s) => s.day === 2 && s.subject === "Mathematics")).toHaveLength(1);
  });

  it("two classes sharing a class teacher SPLIT the P1 anchors, and misses are reported", () => {
    const classes: GenClass[] = [
      { id: "cA", grade: "5", name: "5 A", teacher_id: "t-Science-0" },
      { id: "cB", grade: "5", name: "5 B", teacher_id: "t-Science-0" },
    ];
    const result = generateTimetable({ shape: DEFAULT_SHAPE, classes, subjectTeachers: staff(2) });
    const anchoredDays = (cid: string) =>
      result.slots.filter((s) => s.class_id === cid && s.period === 1 && s.teacher_id === "t-Science-0").length;
    // The teacher can only be in one room at P1 — days split instead of one class winning all week.
    expect(anchoredDays("cA") + anchoredDays("cB")).toBe(DAYS);
    expect(anchoredDays("cA")).toBeGreaterThan(0);
    expect(anchoredDays("cB")).toBeGreaterThan(0);
    // And the shortfall is reported, not silent.
    const missTotal = result.anchorMisses.reduce((a, m) => a + m.count, 0);
    expect(missTotal).toBe(DAYS); // each day exactly one of the two classes misses
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
