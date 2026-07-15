// Timetable domain logic — pure and unit-tested. The DB owns the hard rule
// (unique cell per class); everything soft lives here: teacher-conflict
// detection and the period/day shape from schools.config.timetable.

export type Slot = {
  id?: string;
  class_id: string;
  day: number; // 1 = Monday
  period: number; // 1-based
  subject: string;
  teacher_id: string | null;
  room?: string | null;
};

export type TimetableShape = {
  days: number; // Mon..(Mon+days-1)
  periods: { label: string; time?: string }[];
};

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const DEFAULT_SHAPE: TimetableShape = {
  days: 5,
  periods: [
    { label: "P1", time: "07:30" },
    { label: "P2", time: "08:10" },
    { label: "P3", time: "08:50" },
    { label: "P4", time: "09:50" }, // after recess
    { label: "P5", time: "10:30" },
    { label: "P6", time: "11:10" },
    { label: "P7", time: "11:50" },
    { label: "P8", time: "12:30" },
  ],
};

/** Parse schools.config.timetable, falling back field-by-field to the default. */
export function shapeFromConfig(cfg: unknown): TimetableShape {
  const t = (cfg as { timetable?: { days?: unknown; periods?: unknown } } | null)?.timetable;
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
  return { days, periods: periods.length ? periods : DEFAULT_SHAPE.periods };
}

export const cellKey = (classId: string, day: number, period: number) => `${classId}|${day}|${period}`;

/**
 * Teacher conflicts: cells whose teacher is booked in MORE than one class at
 * the same (day, period). Returns the cell keys of every colliding slot (all
 * sides of the collision, so the editor can highlight each one).
 */
export function teacherConflicts(slots: Slot[]): Set<string> {
  const byTeacherTime = new Map<string, Slot[]>();
  for (const s of slots) {
    if (!s.teacher_id) continue;
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
