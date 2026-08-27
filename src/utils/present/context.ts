// What the context bar knows before she taps anything.
//
// The brief's promise is that the bar "already knows it's her Period 3 class —
// grade, subject, book, chapter, part all pre-filled from the timetable — so
// it's one tap to confirm". Only half of that comes from the timetable. The
// timetable knows the CLASS and the SUBJECT; nothing in the schema links a class
// to a book, so the book, chapter and part come from a remembered pointer
// instead (present_last_taught, migration 0097), which means the first lesson
// with any class is always a manual pick and the picker has to be good.
//
// PURE. Takes rows and a clock, returns a decision. No Supabase, no React, no
// `new Date()` of its own — a resolver that read the clock itself could not be
// tested at 07:44 and 07:46, which is exactly where its behaviour changes.

import { isLesson, timeToMinutes, type Slot, type TimetableShape } from "@/utils/timetable";

/** When a period runs, in minutes since midnight. */
export type PeriodWindow = { period: number; label: string; startMin: number; endMin: number };

/**
 * The day's periods as windows.
 *
 * A period's END is the next period's START where one follows, so a break simply
 * belongs to the period before it. That is deliberately generous: a teacher who
 * opens the board during the interval before Period 5 is preparing for Period 5,
 * and the alternative — showing nothing during every break — would leave the bar
 * blank at exactly the moment she is most likely to be setting up.
 *
 * The last period of the day is bounded by `periodMinutes` instead, because
 * there is no next period to borrow an end from.
 */
export function periodWindows(shape: TimetableShape): PeriodWindow[] {
  const len = shape.periodMinutes ?? 45;
  const rows = shape.periods
    .map((p, i) => ({ period: i + 1, label: p.label, startMin: timeToMinutes(p.time) }))
    .filter((p): p is { period: number; label: string; startMin: number } => p.startMin !== null)
    .sort((a, b) => a.startMin - b.startMin);

  return rows.map((p, i) => ({
    ...p,
    endMin: i + 1 < rows.length ? rows[i + 1].startMin : p.startMin + len,
  }));
}

export type PeriodHit = { period: number; label: string; window: PeriodWindow; state: "in" | "next" };

/**
 * Which period the clock is pointing at.
 *
 * "in" while one is running, "next" during the run-up to one. After the last
 * period ends the answer is null rather than the last period of the day: the
 * lesson is over, and pre-filling a period that has finished would have her
 * confirm a context that is simply wrong.
 */
export function periodAt(windows: PeriodWindow[], minutes: number): PeriodHit | null {
  for (const w of windows) {
    if (minutes >= w.startMin && minutes < w.endMin) {
      return { period: w.period, label: w.label, window: w, state: "in" };
    }
  }
  const upcoming = windows.filter((w) => w.startMin > minutes).sort((a, b) => a.startMin - b.startMin)[0];
  return upcoming
    ? { period: upcoming.period, label: upcoming.label, window: upcoming, state: "next" }
    : null;
}

/** Her lesson in a given cell, if she has one. Non-teaching cells (assembly,
 *  duty, a free period) are not lessons and must not fill the bar. */
export function slotFor(
  slots: Slot[],
  teacherId: string,
  day: number,
  period: number,
): Slot | null {
  return (
    slots.find((s) => s.teacher_id === teacherId && s.day === day && s.period === period && isLesson(s)) ??
    null
  );
}

/** Where a class had got to, per subject. */
export type LastTaught = {
  class_id: string;
  subject: string;
  book_id: string | null;
  chapter_num: number | null;
  part: number | null;
};

export type ContextSuggestion = {
  bookId: string | null;
  chapterNum: number | null;
  part: number | null;
  /**
   * "resume" — carry on with the part she last taught this class.
   *
   * Deliberately NOT "advance". Nothing in the record says whether she finished:
   * resuming a part she had already completed costs her one tap to skip forward,
   * while advancing past one she had not means the class silently misses the
   * material. When present_items starts carrying how far the video actually ran,
   * this can become a real judgement instead of the safe one.
   */
  hint: "resume" | "first";
};

export type PresentContext = {
  day: number;
  minutes: number;
  period: PeriodHit | null;
  slot: Slot | null;
  classId: string | null;
  subject: string | null;
  /** "10:40 – 11:20", ready to render. */
  timeLabel: string | null;
  suggestion: ContextSuggestion | null;
  /**
   * How much of this the bar actually knows, so the UI can say so rather than
   * presenting a guess with the same confidence as a fact:
   *   "slot"    — her timetable named this class and subject
   *   "period"  — a period is running but she teaches nothing in it
   *   "none"    — no timetable, outside school hours, or a non-teaching day
   */
  confidence: "slot" | "period" | "none";
};

export type ResolveInput = {
  teacherId: string;
  shape: TimetableShape;
  slots: Slot[];
  lastTaught: LastTaught[];
  /** 1 = Monday, matching timetable_slots.day and utils/timetable's DAY_NAMES. */
  day: number;
  /** Minutes since midnight. Injected, never read from a clock in here. */
  minutes: number;
};

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${pad(Math.floor((m % 1440) / 60))}:${pad(m % 60)}`;

/**
 * Everything the context bar can work out on its own.
 *
 * Never throws and never returns a half-answer that reads like a whole one: a
 * teacher with no timetable at all gets `confidence: "none"` and a bar that asks
 * her to pick, which is the honest state and is also the state every independent
 * teacher is permanently in.
 */
export function resolveContext(input: ResolveInput): PresentContext {
  const { teacherId, shape, slots, lastTaught, day, minutes } = input;
  const base = { day, minutes, period: null, slot: null, classId: null, subject: null, timeLabel: null };

  // A day outside the school week has no periods at all — a Saturday is not a
  // short Monday.
  if (day < 1 || day > shape.days) {
    return { ...base, suggestion: null, confidence: "none" };
  }

  const hit = periodAt(periodWindows(shape), minutes);
  if (!hit) return { ...base, suggestion: null, confidence: "none" };

  const timeLabel = `${hhmm(hit.window.startMin)} – ${hhmm(hit.window.endMin)}`;
  const slot = slotFor(slots, teacherId, day, hit.period);
  if (!slot) {
    return { ...base, period: hit, timeLabel, suggestion: null, confidence: "period" };
  }

  const last = lastTaught.find((l) => l.class_id === slot.class_id && l.subject === slot.subject);
  const suggestion: ContextSuggestion = last?.book_id
    ? { bookId: last.book_id, chapterNum: last.chapter_num, part: last.part, hint: "resume" }
    : { bookId: null, chapterNum: null, part: null, hint: "first" };

  return {
    day,
    minutes,
    period: hit,
    slot,
    classId: slot.class_id,
    subject: slot.subject,
    timeLabel,
    suggestion,
    confidence: "slot",
  };
}

/**
 * Should this session move the class's pointer?
 *
 * THE RULE THE WHOLE SCHEMA IS SHAPED AROUND. She can pull a cumulative revision
 * worksheet spanning chapters 1-5 onto the board during a lesson whose slot says
 * Chapter 4 Part 2. Advancing the pointer to chapter 5 because that is what was
 * on screen would open her next lesson on the wrong chapter, with nothing to
 * explain why. Only teaching the slot's OWN part counts as having taught it.
 */
export function advancesPointer(
  session: { book_id: string | null; chapter_num: number | null; part: number | null },
  shown: { kind: "video" | "worksheet" | "blank"; bookId?: string | null; chapterNum?: number | null; part?: number | null },
): boolean {
  if (shown.kind === "blank") return false;
  if (!session.book_id || session.chapter_num === null) return false;
  return (
    shown.bookId === session.book_id &&
    shown.chapterNum === session.chapter_num &&
    (shown.part ?? null) === (session.part ?? null)
  );
}
