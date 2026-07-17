// The timetable auto-generator (Plan 3 Phase 2) — a deterministic greedy +
// repair solver, pure TypeScript, no randomness (same inputs → same grid, so
// "regenerate" is reproducible and the whole thing is unit-testable).
//
// School timetabling at this scale (≤ ~50 classes × 40 cells) doesn't need a
// CP solver: the binding constraint is just "a teacher can't be in two rooms
// at once", plus per-grade subject quotas. Strategy:
//
//   1. ANCHOR — each class's own class teacher is placed FIRST in their own
//      class (their subject, earliest free period), classes ordered by grade
//      then name, so the first section of every grade seeds the grid.
//   2. FILL — walk time slots (day, period); for each slot walk the classes
//      (rotated per-slot so no class always goes last) and place the most-
//      needed subject whose least-loaded teacher is free.
//   3. REPAIR — one more sweep placing whatever's still owed wherever a
//      teacher is free.
//
// Anything still unplaced is REPORTED, never silently dropped — typically it
// means a subject has no (or too few) mapped teachers, which is a staffing
// fact the principal needs to see, not a bug to hide.
//
// Sections are just classes sharing a grade — the curriculum is per grade, so
// "5 Amanah" and "5 Bestari" each get the full grade-5 quota with different
// teachers per period. Existing slots can be passed as PINS: their cells and
// teacher-times are respected and never overwritten ("fill gaps" mode).

import { cellKey, type Slot, type TimetableShape } from "./timetable";

export type GenClass = { id: string; grade: string | null; teacher_id: string | null; name: string };

export type GenInput = {
  shape: TimetableShape;
  classes: GenClass[];
  /** subject -> teacher ids allowed to teach it. */
  subjectTeachers: Record<string, string[]>;
  /** Per-grade override: gradeKey -> subject -> periods/week. Falls back to the band defaults. */
  curriculum?: Record<string, Record<string, number>>;
  /** Existing slots to keep untouched (fill mode). Empty = clean slate. */
  pinned?: Slot[];
};

export type GenResult = {
  /** Newly generated slots (pins not included). Guaranteed conflict-free. */
  slots: Slot[];
  unplaced: { classId: string; subject: string; count: number }[];
  teacherLoad: Record<string, number>;
};

// Default weekly quotas (periods/week). Trimmed automatically if a school's
// shape has fewer cells; override per grade via schools.config.timetable.curriculum.
export const PRIMARY_CURRICULUM: Record<string, number> = {
  "Bahasa Melayu": 5,
  English: 5,
  Mathematics: 5,
  Science: 3,
  History: 2,
  Geography: 1,
  PE: 2,
  Art: 1,
  Music: 1,
  "Moral Education": 2,
  ICT: 1,
};
export const SECONDARY_CURRICULUM: Record<string, number> = {
  "Bahasa Melayu": 4,
  English: 4,
  Mathematics: 5,
  Science: 5,
  History: 3,
  Geography: 2,
  PE: 2,
  Art: 1,
  "Moral Education": 1,
  ICT: 1,
};

/**
 * "5", "Grade 5", "5 Bestari" → 5. Malaysian secondary naming is special-cased:
 * "Form 1"–"Form 5" (and "Tingkatan N") are grades 7–11 — a bare digit-grab
 * would silently drop a Form 4 class into the primary curriculum band.
 */
export function gradeNumber(grade: string | null): number | null {
  const g = (grade ?? "").toLowerCase();
  const form = /(?:form|tingkatan)\s*(\d{1,2})/.exec(g);
  if (form) {
    const n = Number(form[1]) + 6;
    return n >= 7 && n <= 13 ? n : null;
  }
  const m = /\d{1,2}/.exec(g);
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 1 && n <= 13 ? n : null;
}

// Hand-typed grid subjects drift ("Maths", "BM", "Sejarah") — pins must still
// count against the right quota or fill mode double-schedules the subject.
const SUBJECT_SYNONYMS: Record<string, string> = {
  maths: "Mathematics",
  math: "Mathematics",
  bm: "Bahasa Melayu",
  bahasa: "Bahasa Melayu",
  malay: "Bahasa Melayu",
  "english language": "English",
  sci: "Science",
  "physical education": "PE",
  pj: "PE",
  sports: "PE",
  computing: "ICT",
  "computing / ict": "ICT",
  computer: "ICT",
  moral: "Moral Education",
  sejarah: "History",
  geografi: "Geography",
  arts: "Art",
};

/** Map a free-text grid subject onto a curriculum key (case/alias tolerant). */
export function canonicalSubject(raw: string, curriculumKeys: string[]): string {
  const n = raw.trim().toLowerCase();
  const viaSynonym = SUBJECT_SYNONYMS[n];
  if (viaSynonym && curriculumKeys.includes(viaSynonym)) return viaSynonym;
  const exact = curriculumKeys.find((k) => k.toLowerCase() === n);
  return exact ?? raw.trim();
}

export function curriculumForGrade(
  grade: string | null,
  overrides?: Record<string, Record<string, number>>,
): Record<string, number> {
  const n = gradeNumber(grade);
  const exact = overrides?.[grade ?? ""] ?? (n != null ? overrides?.[String(n)] : undefined);
  if (exact) return { ...exact };
  return { ...(n != null && n >= 7 ? SECONDARY_CURRICULUM : PRIMARY_CURRICULUM) };
}

/** Scale a quota map down so it fits the number of cells (drop from the largest). */
function fitToCells(required: Record<string, number>, cells: number): Record<string, number> {
  const out = { ...required };
  let total = Object.values(out).reduce((s, n) => s + n, 0);
  while (total > cells) {
    const biggest = Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (!biggest || biggest[1] <= 0) break;
    out[biggest[0]]--;
    total--;
  }
  for (const k of Object.keys(out)) if (out[k] <= 0) delete out[k];
  return out;
}

export function generateTimetable(input: GenInput): GenResult {
  const { shape, classes, subjectTeachers } = input;
  const days = shape.days;
  const periods = shape.periods.length;
  const cells = days * periods;

  // Deterministic class order: grade number, then name — "the first class in
  // each grade" leads its grade everywhere (anchoring included).
  const ordered = [...classes].sort((a, b) => {
    const ga = gradeNumber(a.grade) ?? 99;
    const gb = gradeNumber(b.grade) ?? 99;
    return ga - gb || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });

  // Occupancy from pins.
  const teacherBusy = new Set<string>(); // "teacher|day|period"
  const cellTaken = new Set<string>(); // cellKey(class, day, period)
  const teacherLoad: Record<string, number> = {};
  const subjectsOnDay = new Set<string>(); // "class|day|subject" (soft spread rule)
  const occupy = (s: Slot) => {
    cellTaken.add(cellKey(s.class_id, s.day, s.period));
    if (s.teacher_id) {
      teacherBusy.add(`${s.teacher_id}|${s.day}|${s.period}`);
      teacherLoad[s.teacher_id] = (teacherLoad[s.teacher_id] ?? 0) + 1;
    }
    subjectsOnDay.add(`${s.class_id}|${s.day}|${s.subject}`);
  };
  for (const p of input.pinned ?? []) occupy(p);

  // Per-class remaining quotas (pins count toward them — matched tolerantly,
  // so a hand-typed "Maths" pin decrements the "Mathematics" quota).
  const remaining = new Map<string, Record<string, number>>();
  for (const c of ordered) {
    const req = fitToCells(curriculumForGrade(c.grade, input.curriculum), cells);
    const keys = Object.keys(req);
    for (const p of input.pinned ?? []) {
      if (p.class_id !== c.id) continue;
      const subject = canonicalSubject(p.subject, keys);
      if (req[subject] != null) {
        req[subject]--;
        if (req[subject] <= 0) delete req[subject];
      }
    }
    remaining.set(c.id, req);
  }

  const out: Slot[] = [];
  const teacherFree = (t: string, d: number, p: number) => !teacherBusy.has(`${t}|${d}|${p}`);

  const place = (c: GenClass, subject: string, teacher: string, d: number, p: number) => {
    const slot: Slot = { class_id: c.id, day: d, period: p, subject, teacher_id: teacher };
    out.push(slot);
    occupy(slot);
    const req = remaining.get(c.id)!;
    req[subject]--;
    if (req[subject] <= 0) delete req[subject];
  };

  /** Least-loaded mapped teacher free at (d,p); the class's own teacher wins ties. */
  const pickTeacher = (c: GenClass, subject: string, d: number, p: number): string | null => {
    const pool = subjectTeachers[subject] ?? [];
    let best: string | null = null;
    let bestLoad = Infinity;
    for (const t of pool) {
      if (!teacherFree(t, d, p)) continue;
      const load = (teacherLoad[t] ?? 0) - (t === c.teacher_id ? 0.5 : 0);
      if (load < bestLoad || (load === bestLoad && best !== null && t < best)) {
        best = t;
        bestLoad = load;
      }
    }
    return best;
  };

  // ── 1. ANCHOR: the class teacher opens their own class's week ───────────────
  for (const c of ordered) {
    if (!c.teacher_id) continue;
    const req = remaining.get(c.id)!;
    // The class teacher's subject = the first mapped subject they can teach
    // that this class still needs.
    const subject = Object.keys(req)
      .sort()
      .find((s) => (subjectTeachers[s] ?? []).includes(c.teacher_id!));
    if (!subject) continue;
    outer: for (let d = 1; d <= days; d++) {
      for (let p = 1; p <= periods; p++) {
        if (cellTaken.has(cellKey(c.id, d, p))) continue;
        if (!teacherFree(c.teacher_id, d, p)) continue;
        place(c, subject, c.teacher_id, d, p);
        break outer;
      }
    }
  }

  // ── 2. FILL: time-slot-major, classes rotated per slot ──────────────────────
  for (let d = 1; d <= days; d++) {
    for (let p = 1; p <= periods; p++) {
      const rot = (d * periods + p) % Math.max(ordered.length, 1);
      const roundOrder = [...ordered.slice(rot), ...ordered.slice(0, rot)];
      for (const c of roundOrder) {
        if (cellTaken.has(cellKey(c.id, d, p))) continue;
        const req = remaining.get(c.id)!;
        // Most-needed first; prefer subjects this class hasn't had today.
        const candidates = Object.entries(req)
          .filter(([, n]) => n > 0)
          .sort(
            (a, b) =>
              Number(subjectsOnDay.has(`${c.id}|${d}|${a[0]}`)) - Number(subjectsOnDay.has(`${c.id}|${d}|${b[0]}`)) ||
              b[1] - a[1] ||
              a[0].localeCompare(b[0]),
          );
        for (const [subject] of candidates) {
          const t = pickTeacher(c, subject, d, p);
          if (t) {
            place(c, subject, t, d, p);
            break;
          }
        }
      }
    }
  }

  // ── 3. REPAIR: one more sweep for anything still owed ───────────────────────
  for (const c of ordered) {
    const req = remaining.get(c.id)!;
    for (const subject of Object.keys(req).sort()) {
      let owed = req[subject];
      for (let d = 1; d <= days && owed > 0; d++) {
        for (let p = 1; p <= periods && owed > 0; p++) {
          if (cellTaken.has(cellKey(c.id, d, p))) continue;
          const t = pickTeacher(c, subject, d, p);
          if (t) {
            place(c, subject, t, d, p);
            owed = req[subject] ?? 0;
          }
        }
      }
    }
  }

  const unplaced: GenResult["unplaced"] = [];
  for (const c of ordered) {
    const req = remaining.get(c.id)!;
    for (const [subject, count] of Object.entries(req)) {
      if (count > 0) unplaced.push({ classId: c.id, subject, count });
    }
  }
  return { slots: out, unplaced, teacherLoad };
}
