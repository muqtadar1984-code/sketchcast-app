// Timetable domain logic — pure and unit-tested. The DB owns the hard rule
// (unique cell per class); everything soft lives here: teacher-conflict
// detection, per-day load limits, and the period/day shape (school hours,
// breaks, caps) from schools.config.timetable.

export type Slot = {
  id?: string;
  class_id: string;
  day: number; // 1 = Monday
  period: number; // 1-based
  subject: string;
  teacher_id: string | null;
  room?: string | null;
  /** Pinned: the auto-generator must never move or overwrite this cell. */
  locked?: boolean;
  /** 'lesson' (default) or 'nonteaching' (assembly, duty, free period) —
   *  nonteaching cells are exempt from clash detection and day caps. */
  kind?: string;
};

export type BreakDef = {
  label: string;
  time?: string; // "10:45"
  minutes?: number; // duration
  afterPeriod: number; // rendered after this period row (0 = before P1)
};

export type TimetableShape = {
  days: number; // Mon..(Mon+days-1)
  periods: { label: string; time?: string }[];
  start?: string; // school start, "07:45"
  end?: string; // school end, "14:45"
  breaks?: BreakDef[];
  /** Max LESSON periods a teacher may be given per day (soft in the editor,
   *  hard in the generator and the substitution picker). */
  maxPerTeacherPerDay?: number;
};

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const DEFAULT_SHAPE: TimetableShape = {
  days: 5,
  start: "07:45",
  end: "14:45",
  periods: [
    { label: "P1", time: "07:45" },
    { label: "P2", time: "08:30" },
    { label: "P3", time: "09:15" },
    { label: "P4", time: "10:00" },
    { label: "P5", time: "11:00" }, // after snack break
    { label: "P6", time: "11:45" },
    { label: "P7", time: "13:15" }, // after lunch break
    { label: "P8", time: "14:00" },
  ],
  breaks: [
    { label: "Snack break", time: "10:45", minutes: 15, afterPeriod: 4 },
    { label: "Lunch break", time: "12:30", minutes: 45, afterPeriod: 6 },
  ],
  maxPerTeacherPerDay: 6,
};

const TIME_RE = /^\d{1,2}:\d{2}$/;

/** Parse schools.config.timetable, falling back field-by-field to the default. */
export function shapeFromConfig(cfg: unknown): TimetableShape {
  const t = (
    cfg as {
      timetable?: {
        days?: unknown;
        periods?: unknown;
        start?: unknown;
        end?: unknown;
        breaks?: unknown;
        maxPerTeacherPerDay?: unknown;
      };
    } | null
  )?.timetable;
  if (!t) return DEFAULT_SHAPE;
  const days =
    typeof t.days === "number" && t.days >= 1 && t.days <= 7 ? Math.floor(t.days) : DEFAULT_SHAPE.days;
  const periods = Array.isArray(t.periods)
    ? t.periods
        .filter((p): p is { label?: unknown; time?: unknown } => !!p && typeof p === "object")
        .slice(0, 12)
        .map((p, i) => ({
          label: typeof p.label === "string" && p.label ? p.label : `P${i + 1}`,
          time: typeof p.time === "string" ? p.time : undefined,
        }))
    : DEFAULT_SHAPE.periods;
  const start = typeof t.start === "string" && TIME_RE.test(t.start) ? t.start : DEFAULT_SHAPE.start;
  const end = typeof t.end === "string" && TIME_RE.test(t.end) ? t.end : DEFAULT_SHAPE.end;
  // An explicit empty array means "no breaks" — only a MISSING field falls back.
  const breaks = Array.isArray(t.breaks)
    ? t.breaks
        .filter((b): b is { label?: unknown; time?: unknown; minutes?: unknown; afterPeriod?: unknown } => !!b && typeof b === "object")
        .slice(0, 6)
        .map((b, i) => ({
          label: typeof b.label === "string" && b.label ? b.label.slice(0, 40) : `Break ${i + 1}`,
          time: typeof b.time === "string" && TIME_RE.test(b.time) ? b.time : undefined,
          minutes:
            typeof b.minutes === "number" && b.minutes >= 1 && b.minutes <= 240 ? Math.floor(b.minutes) : undefined,
          afterPeriod:
            typeof b.afterPeriod === "number" && b.afterPeriod >= 0 && b.afterPeriod <= 12
              ? Math.floor(b.afterPeriod)
              : 0,
        }))
    : DEFAULT_SHAPE.breaks;
  const maxPerTeacherPerDay =
    typeof t.maxPerTeacherPerDay === "number" && t.maxPerTeacherPerDay >= 1 && t.maxPerTeacherPerDay <= 12
      ? Math.floor(t.maxPerTeacherPerDay)
      : DEFAULT_SHAPE.maxPerTeacherPerDay;
  return {
    days,
    periods: periods.length ? periods : DEFAULT_SHAPE.periods,
    start,
    end,
    breaks,
    maxPerTeacherPerDay,
  };
}

export const cellKey = (classId: string, day: number, period: number) => `${classId}|${day}|${period}`;

/** Lesson cells carry teaching load; nonteaching cells (assembly, duty) don't. */
export const isLesson = (s: Slot) => (s.kind ?? "lesson") === "lesson";

/**
 * Teacher conflicts: cells whose teacher is booked in MORE than one class at
 * the same (day, period). Returns the cell keys of every colliding slot (all
 * sides of the collision, so the editor can highlight each one). Nonteaching
 * cells are exempt — a whole-school assembly is not twelve double-bookings.
 */
export function teacherConflicts(slots: Slot[]): Set<string> {
  const byTeacherTime = new Map<string, Slot[]>();
  for (const s of slots) {
    if (!s.teacher_id || !isLesson(s)) continue;
    const k = `${s.teacher_id}|${s.day}|${s.period}`;
    if (!byTeacherTime.has(k)) byTeacherTime.set(k, []);
    byTeacherTime.get(k)!.push(s);
  }
  const conflicted = new Set<string>();
  for (const group of byTeacherTime.values()) {
    const classes = new Set(group.map((s) => s.class_id));
    if (classes.size > 1) for (const s of group) conflicted.add(cellKey(s.class_id, s.day, s.period));
  }
  return conflicted;
}

/** "teacherId|day" → number of LESSON periods that teacher teaches that day. */
export function teacherDayLoads(slots: Slot[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of slots) {
    if (!s.teacher_id || !isLesson(s)) continue;
    const k = `${s.teacher_id}|${s.day}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export type DayOverload = { teacher_id: string; day: number; count: number };

/** Teachers over the per-day lesson cap, for the editor's warning strip. */
export function dayOverloads(slots: Slot[], maxPerDay: number): DayOverload[] {
  const out: DayOverload[] = [];
  for (const [k, count] of teacherDayLoads(slots)) {
    if (count > maxPerDay) {
      const [teacher_id, day] = k.split("|");
      out.push({ teacher_id, day: Number(day), count });
    }
  }
  return out.sort((a, b) => a.teacher_id.localeCompare(b.teacher_id) || a.day - b.day);
}
