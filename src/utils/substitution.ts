// Substitution picking — pure logic behind /api/timetable/absence.
//
// Everyone is assumed present until an absence row exists. When one is marked,
// every LESSON the absent teacher owns on that weekday needs cover, and the
// picker chooses deterministically, best cover first:
//
//   1. a teacher who teaches that SUBJECT (declared in onboarding or anywhere
//      on the current grid),
//   2. the CLASS TEACHER of that class (knows the room, knows the kids),
//   3. the lightest same-day load (actual lessons + covers already assigned),
//   4. stable name/id order — same inputs, same plan.
//
// Hard rules a candidate must pass: not absent that date, free that period
// (their own grid + covers already given today), and under the per-day lesson
// cap. If nobody passes, the assignment is returned with substitute NULL —
// "no cover found" is a staffing fact the principal must see, never a
// silently dropped row.

import { isLesson, type Slot } from "./timetable";

export type SubAssignment = {
  class_id: string;
  day: number;
  period: number;
  subject: string;
  original_teacher_id: string;
  substitute_teacher_id: string | null;
};

/** "2026-07-17" → ISO weekday 1..7 (Mon..Sun). Null on malformed/impossible dates. */
export function isoWeekday(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC silently rolls impossible dates (Feb 31 → Mar 3) — reject those.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const wd = dt.getUTCDay();
  return wd === 0 ? 7 : wd;
}

export type PickInput = {
  /** The whole school's weekly grid. */
  slots: Slot[];
  /** Weekday (1..7) of the absence date. */
  day: number;
  /** The teacher being covered. */
  targetTeacherId: string;
  /** EVERY teacher absent on that date (including the target). */
  absentTeacherIds: Set<string>;
  /** Candidate pool: the school's non-student staff. */
  staff: { id: string; name: string }[];
  /** teacher id → subjects they teach (declared + taught), case-insensitive. */
  subjectsByTeacher: Map<string, Set<string>>;
  /** class id → its class teacher. */
  classTeacherByClass: Map<string, string>;
  /** Covers already assigned to OTHER absences on the same date. */
  existingSubs: { period: number; substitute_teacher_id: string | null }[];
  maxPerTeacherPerDay: number;
  /** Cover exactly these lessons instead of deriving them from the grid —
   *  used to re-cover orphaned assignments whose substitute went absent. */
  coverLessons?: Slot[];
};

export function pickSubstitutes(input: PickInput): SubAssignment[] {
  const { slots, day, targetTeacherId, absentTeacherIds, staff, maxPerTeacherPerDay } = input;

  // Normalize the subject index once (grid subjects are hand-typed).
  const teaches = new Map<string, Set<string>>();
  for (const [tid, subjects] of input.subjectsByTeacher) {
    teaches.set(tid, new Set([...subjects].map((s) => s.trim().toLowerCase())));
  }

  // Who is busy when, and how loaded is each teacher's day already.
  const busy = new Set<string>(); // "teacher|period"
  const dayLoad = new Map<string, number>();
  for (const s of slots) {
    if (!s.teacher_id || s.day !== day) continue;
    busy.add(`${s.teacher_id}|${s.period}`);
    if (isLesson(s)) dayLoad.set(s.teacher_id, (dayLoad.get(s.teacher_id) ?? 0) + 1);
  }
  for (const sub of input.existingSubs) {
    if (!sub.substitute_teacher_id) continue;
    busy.add(`${sub.substitute_teacher_id}|${sub.period}`);
    dayLoad.set(sub.substitute_teacher_id, (dayLoad.get(sub.substitute_teacher_id) ?? 0) + 1);
  }

  // The absent teacher's own lessons no longer occupy them — but they also
  // aren't a candidate, so their busy entries simply never matter. What DOES
  // matter: lessons that need cover, in period order.
  const toCover = (
    input.coverLessons ?? slots.filter((s) => s.day === day && s.teacher_id === targetTeacherId && isLesson(s))
  )
    .slice()
    .sort((a, b) => a.period - b.period || a.class_id.localeCompare(b.class_id));

  const pool = staff
    .filter((t) => !absentTeacherIds.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const out: SubAssignment[] = [];
  for (const lesson of toCover) {
    const subjectKey = lesson.subject.trim().toLowerCase();
    const classTeacher = input.classTeacherByClass.get(lesson.class_id);
    let best: string | null = null;
    let bestRank: [number, number, number] | null = null;
    for (const t of pool) {
      if (busy.has(`${t.id}|${lesson.period}`)) continue;
      if ((dayLoad.get(t.id) ?? 0) >= maxPerTeacherPerDay) continue;
      const rank: [number, number, number] = [
        teaches.get(t.id)?.has(subjectKey) ? 0 : 1,
        t.id === classTeacher ? 0 : 1,
        dayLoad.get(t.id) ?? 0,
      ];
      if (
        !bestRank ||
        rank[0] < bestRank[0] ||
        (rank[0] === bestRank[0] && rank[1] < bestRank[1]) ||
        (rank[0] === bestRank[0] && rank[1] === bestRank[1] && rank[2] < bestRank[2])
      ) {
        best = t.id;
        bestRank = rank;
      }
    }
    if (best) {
      busy.add(`${best}|${lesson.period}`);
      dayLoad.set(best, (dayLoad.get(best) ?? 0) + 1);
    }
    out.push({
      class_id: lesson.class_id,
      day,
      period: lesson.period,
      subject: lesson.subject,
      original_teacher_id: targetTeacherId,
      substitute_teacher_id: best,
    });
  }
  return out;
}
