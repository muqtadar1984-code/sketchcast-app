// The timetable auto-generator — a deterministic greedy solver, pure
// TypeScript, no randomness (same inputs → same grid, so "regenerate" is
// reproducible and the whole thing is unit-testable).
//
// SCHEDULING MODEL (v3, 2026-07-17 — replaces the weekly-quota model):
//
//   1. CLASS TEACHER FIRST — Period 1 of EVERY day belongs to the class
//      teacher, teaching their own subject. Registration, faces, routine.
//   2. CORE SUBJECTS DAILY — every core subject (default: Bahasa Melayu,
//      English, Mathematics, Science; override via
//      schools.config.timetable.coreSubjects) runs exactly ONCE per day in
//      every class. No weekly quotas — the day is the unit.
//   3. FILLERS — every remaining cell takes a non-core subject (History,
//      Geography, PE, Art, Music, Moral Education, ICT, anything else
//      mapped) whose teacher is free, balanced so a class sees variety
//      across the week rather than five straight Art periods. A cell only
//      stays blank when no filler teacher is available.
//
// Hard rules throughout: a teacher is never in two rooms at once, never over
// the per-day lesson cap, and pinned/locked cells are never overwritten. A
// core that CAN'T run on some day (no mapped teacher free) is REPORTED,
// never silently dropped — that's a staffing fact the principal needs.
//
// The curriculum catalogs below now define subject MEMBERSHIP per grade band
// (secondary has no Music, etc.), not quantities. A subject mapped in the
// dialog but absent from both catalogs (an ad-hoc subject) is allowed in
// every grade.

import { cellKey, isLesson, type Slot, type TimetableShape } from "./timetable";

export type GenClass = { id: string; grade: string | null; teacher_id: string | null; name: string };

export type GenInput = {
  shape: TimetableShape;
  classes: GenClass[];
  /** subject -> teacher ids allowed to teach it. */
  subjectTeachers: Record<string, string[]>;
  /** Per-grade membership override: gradeKey -> subject -> anything truthy. */
  curriculum?: Record<string, Record<string, number>>;
  /** Existing slots to keep untouched (fill mode). Empty = clean slate. */
  pinned?: Slot[];
  /** Hard ceiling on LESSON periods per teacher per day (unset = unlimited). */
  maxPerTeacherPerDay?: number;
  /** Subjects that must run once EVERY day in every class. */
  coreSubjects?: string[];
};

export type GenResult = {
  /** Newly generated slots (pins not included). Guaranteed conflict-free. */
  slots: Slot[];
  /** Core lessons that could not run: count = school days missed. */
  unplaced: { classId: string; subject: string; count: number }[];
  /** Days a class's P1 could not be held by its class teacher (busy/capped/
   *  unmapped) — e.g. one teacher class-teaching two sections. */
  anchorMisses: { classId: string; count: number }[];
  teacherLoad: Record<string, number>;
};

export const DEFAULT_CORE_SUBJECTS = ["Bahasa Melayu", "English", "Mathematics", "Science"];

// Subject membership per grade band (which subjects a grade takes at all).
export const PRIMARY_CURRICULUM: Record<string, number> = {
  "Bahasa Melayu": 1,
  English: 1,
  Mathematics: 1,
  Science: 1,
  History: 1,
  Geography: 1,
  PE: 1,
  Art: 1,
  Music: 1,
  "Moral Education": 1,
  ICT: 1,
};
export const SECONDARY_CURRICULUM: Record<string, number> = {
  "Bahasa Melayu": 1,
  English: 1,
  Mathematics: 1,
  Science: 1,
  History: 1,
  Geography: 1,
  PE: 1,
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
// count as the right subject or fill mode schedules a second daily Maths.
const SUBJECT_SYNONYMS: Record<string, string> = {
  maths: "Mathematics",
  math: "Mathematics",
  matematik: "Mathematics",
  bm: "Bahasa Melayu",
  bahasa: "Bahasa Melayu",
  "bahasa malaysia": "Bahasa Melayu",
  malay: "Bahasa Melayu",
  "english language": "English",
  "bahasa inggeris": "English",
  inggeris: "English",
  bi: "English",
  sci: "Science",
  sains: "Science",
  "physical education": "PE",
  "pendidikan jasmani": "PE",
  pj: "PE",
  sports: "PE",
  computing: "ICT",
  "computing / ict": "ICT",
  computer: "ICT",
  moral: "Moral Education",
  "pendidikan moral": "Moral Education",
  sejarah: "History",
  geografi: "Geography",
  arts: "Art",
  seni: "Art",
  muzik: "Music",
};

/** Map a free-text grid subject onto a known key (case/alias tolerant). */
export function canonicalSubject(raw: string, keys: string[]): string {
  const n = raw.trim().toLowerCase();
  const viaSynonym = SUBJECT_SYNONYMS[n];
  if (viaSynonym && keys.includes(viaSynonym)) return viaSynonym;
  const exact = keys.find((k) => k.toLowerCase() === n);
  return exact ?? raw.trim();
}

/** The subject catalog for a grade (membership; values are irrelevant). */
export function curriculumForGrade(
  grade: string | null,
  overrides?: Record<string, Record<string, number>>,
): Record<string, number> {
  const n = gradeNumber(grade);
  const exact = overrides?.[grade ?? ""] ?? (n != null ? overrides?.[String(n)] : undefined);
  if (exact) return { ...exact };
  return { ...(n != null && n >= 7 ? SECONDARY_CURRICULUM : PRIMARY_CURRICULUM) };
}

export function generateTimetable(input: GenInput): GenResult {
  const { shape, classes } = input;
  const days = shape.days;
  const periods = shape.periods.length;
  const cap = input.maxPerTeacherPerDay ?? Infinity;
  const knownEverywhere = new Set([...Object.keys(PRIMARY_CURRICULUM), ...Object.keys(SECONDARY_CURRICULUM)]);

  // ONE canonical key space for everything. Mapping keys, core names, pins
  // and curriculum overrides all funnel through canonicalSubject against the
  // catalog, so "BM", "Maths", "Matematik" and "Mathematics" are the same
  // ledger entry — a split here means double-daily cores and runaway fillers.
  const catalogKeys = [...knownEverywhere];
  const canon = (s: string) => canonicalSubject(s, catalogKeys);
  const subjectTeachers: Record<string, string[]> = {};
  for (const [raw, pool] of Object.entries(input.subjectTeachers)) {
    const key = canon(raw);
    if (!subjectTeachers[key]) subjectTeachers[key] = [];
    for (const t of pool) if (!subjectTeachers[key].includes(t)) subjectTeachers[key].push(t);
  }
  const mappedSubjects = Object.keys(subjectTeachers);

  // Deterministic class order: grade number, then name.
  const ordered = [...classes].sort((a, b) => {
    const ga = gradeNumber(a.grade) ?? 99;
    const gb = gradeNumber(b.grade) ?? 99;
    return ga - gb || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });

  // Per class: which subjects it takes (grade membership ∩ mapping; ad-hoc
  // mapped subjects unknown to both catalogs are allowed everywhere), split
  // into cores (must run daily — kept even when unmapped so the gap is
  // REPORTED) and fillers.
  const coreList = [
    ...new Set((input.coreSubjects ?? DEFAULT_CORE_SUBJECTS).map((s) => canon(s.trim())).filter(Boolean)),
  ];
  const coreSet = new Set(coreList);
  const classCores = new Map<string, string[]>();
  const classFillers = new Map<string, string[]>();
  for (const c of ordered) {
    const member = new Set(Object.keys(curriculumForGrade(c.grade, input.curriculum)).map(canon));
    const takes = (s: string) => member.has(s) || !knownEverywhere.has(s);
    classCores.set(c.id, coreList.filter(takes).sort());
    classFillers.set(
      c.id,
      mappedSubjects.filter((s) => !coreSet.has(s) && takes(s)).sort(),
    );
  }

  // Occupancy. A nonteaching pin (assembly, duty) still makes its teacher
  // BUSY that period, but carries no teaching load and never counts toward
  // the per-day lesson cap.
  const teacherBusy = new Set<string>(); // "teacher|day|period"
  const cellTaken = new Set<string>(); // cellKey(class, day, period)
  const teacherLoad: Record<string, number> = {};
  const teacherDayLoad: Record<string, number> = {}; // "teacher|day" -> lessons
  const subjectsOnDay = new Set<string>(); // "class|day|subject"
  const corePlaced = new Set<string>(); // "class|day|coreSubject"
  const fillerCount = new Map<string, number>(); // "class|subject" -> weekly uses
  const allKeys = [...new Set([...mappedSubjects, ...coreList, ...catalogKeys])];

  const occupy = (s: Slot) => {
    cellTaken.add(cellKey(s.class_id, s.day, s.period));
    if (s.teacher_id) {
      teacherBusy.add(`${s.teacher_id}|${s.day}|${s.period}`);
      if (isLesson(s)) {
        teacherLoad[s.teacher_id] = (teacherLoad[s.teacher_id] ?? 0) + 1;
        const dk = `${s.teacher_id}|${s.day}`;
        teacherDayLoad[dk] = (teacherDayLoad[dk] ?? 0) + 1;
      }
    }
    if (isLesson(s)) {
      const subject = canonicalSubject(s.subject, allKeys);
      subjectsOnDay.add(`${s.class_id}|${s.day}|${subject}`);
      if (coreSet.has(subject)) corePlaced.add(`${s.class_id}|${s.day}|${subject}`);
      else fillerCount.set(`${s.class_id}|${subject}`, (fillerCount.get(`${s.class_id}|${subject}`) ?? 0) + 1);
    }
  };
  for (const p of input.pinned ?? []) occupy(p);

  const out: Slot[] = [];
  const teacherFree = (t: string, d: number, p: number) =>
    !teacherBusy.has(`${t}|${d}|${p}`) && (teacherDayLoad[`${t}|${d}`] ?? 0) < cap;

  const place = (c: GenClass, subject: string, teacher: string, d: number, p: number) => {
    const slot: Slot = { class_id: c.id, day: d, period: p, subject, teacher_id: teacher };
    out.push(slot);
    occupy(slot);
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

  // ── 1. ANCHOR: Period 1, every day, is the class teacher's ──────────────────
  // Rotated per day so two classes SHARING a class teacher alternate who gets
  // them at P1 instead of one class winning all week. A day where a class's
  // P1 was free but its class teacher couldn't take it is REPORTED.
  const anchorMissed = new Map<string, number>(); // classId -> days
  for (let d = 1; d <= days; d++) {
    const rot = d % Math.max(ordered.length, 1);
    const dayOrder = [...ordered.slice(rot), ...ordered.slice(0, rot)];
    for (const c of dayOrder) {
      const ct = c.teacher_id;
      if (!ct || cellTaken.has(cellKey(c.id, d, 1))) continue; // no class teacher / P1 pinned by a human
      const teaches = (s: string) => (subjectTeachers[s] ?? []).includes(ct);
      const subject =
        classCores.get(c.id)!.find((s) => teaches(s) && !corePlaced.has(`${c.id}|${d}|${s}`)) ??
        classFillers.get(c.id)!.find(teaches);
      if (!subject || !teacherFree(ct, d, 1)) {
        anchorMissed.set(c.id, (anchorMissed.get(c.id) ?? 0) + 1);
        continue; // P1 falls to the core pass
      }
      place(c, subject, ct, d, 1);
    }
  }

  // ── 2. CORES: each core once per day in every class ─────────────────────────
  for (let d = 1; d <= days; d++) {
    for (let p = 1; p <= periods; p++) {
      const rot = (d * periods + p) % Math.max(ordered.length, 1);
      const roundOrder = [...ordered.slice(rot), ...ordered.slice(0, rot)];
      for (const c of roundOrder) {
        if (cellTaken.has(cellKey(c.id, d, p))) continue;
        const owed = classCores.get(c.id)!.filter((s) => !corePlaced.has(`${c.id}|${d}|${s}`));
        for (const subject of owed) {
          const t = pickTeacher(c, subject, d, p);
          if (t) {
            place(c, subject, t, d, p);
            break;
          }
        }
      }
    }
  }

  // ── 3. FILLERS: every remaining cell, variety-balanced ──────────────────────
  for (let d = 1; d <= days; d++) {
    for (let p = 1; p <= periods; p++) {
      const rot = (d * periods + p + 3) % Math.max(ordered.length, 1);
      const roundOrder = [...ordered.slice(rot), ...ordered.slice(0, rot)];
      for (const c of roundOrder) {
        if (cellTaken.has(cellKey(c.id, d, p))) continue;
        // Least-used-this-week first; prefer subjects the class hasn't had
        // today; stable name order breaks ties.
        const candidates = [...classFillers.get(c.id)!].sort(
          (a, b) =>
            (fillerCount.get(`${c.id}|${a}`) ?? 0) - (fillerCount.get(`${c.id}|${b}`) ?? 0) ||
            Number(subjectsOnDay.has(`${c.id}|${d}|${a}`)) - Number(subjectsOnDay.has(`${c.id}|${d}|${b}`)) ||
            a.localeCompare(b),
        );
        for (const subject of candidates) {
          const t = pickTeacher(c, subject, d, p);
          if (t) {
            place(c, subject, t, d, p);
            break;
          }
        }
      }
    }
  }

  // Report every core-day a class missed — a staffing fact, never hidden.
  const missed = new Map<string, number>(); // "classId|subject"
  for (const c of ordered) {
    for (const subject of classCores.get(c.id)!) {
      for (let d = 1; d <= days; d++) {
        if (!corePlaced.has(`${c.id}|${d}|${subject}`)) {
          const k = `${c.id}|${subject}`;
          missed.set(k, (missed.get(k) ?? 0) + 1);
        }
      }
    }
  }
  const unplaced: GenResult["unplaced"] = [...missed.entries()].map(([k, count]) => {
    const [classId, subject] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    return { classId, subject, count };
  });
  const anchorMisses = [...anchorMissed.entries()].map(([classId, count]) => ({ classId, count }));
  return { slots: out, unplaced, anchorMisses, teacherLoad };
}
