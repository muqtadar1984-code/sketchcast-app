// SK teacher knowledge tool v1 — timetable.now_next (Final Plan 2026-10-28 §4
// row 4). The Present page's context bar as a tool: the school's period shape
// (schools.config.timetable), the teacher's own slots, where each class last
// got to (present_last_taught), and the PURE resolver in utils/present/context.
//
// Clock: the collector's local clock when the turn carries one (the browser's
// day/minutes, as the Present page uses), else the server's `now` read in
// Asia/Kuala_Lumpur — fixed UTC+8, the same doctrine as utils/notices.ts until
// a school outside Malaysia signs up.
//
// User-session client only; slots and last-taught rows are pinned to
// `teacher_id = me`.

import type { SkCapability, SkCapabilityResult, SkContext, SkSessionDb } from "../shell/types";
import { shapeFromConfig, type Slot, type TimetableShape } from "@/utils/timetable";
import { periodWindows, resolveContext, type LastTaught } from "@/utils/present/context";

export const REMAINING_ROWS_CAP = 8;
const KL_OFFSET_MIN = 8 * 60;

const rows = <T>(res: { data: unknown; error: { message?: string } | null } | null | undefined, what: string): T[] => {
  if (!res) return [];
  if (res.error) throw new Error(`${what}: ${res.error.message ?? "query failed"}`);
  return (res.data ?? []) as T[];
};

const fail = (e: unknown): SkCapabilityResult => ({
  ok: false,
  summary: "I could not read the timetable right now.",
  error: e instanceof Error ? e.message : String(e),
});

/** 1 = Monday … 7 = Sunday, and minutes since midnight, for an instant in a
 *  fixed-offset zone. Exported for the tests. */
export function clockAt(now: Date, offsetMinutes = KL_OFFSET_MIN): { day: number; minutes: number } {
  const shifted = new Date(now.getTime() + offsetMinutes * 60000);
  const day = ((shifted.getUTCDay() + 6) % 7) + 1;
  return { day, minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${pad(Math.floor((m % 1440) / 60))}:${pad(m % 60)}`;

type ClassRow = { id: string; name: string | null; grade?: string | null };
type BookRow = { id: string; title: string | null };

export type NowNextInput = {
  teacherId: string;
  shape: TimetableShape;
  slots: Slot[];
  lastTaught: LastTaught[];
  classNames: Record<string, string>;
  bookTitles: Record<string, string>;
  day: number;
  minutes: number;
};

export type NowNextFact = {
  row: "now" | "remaining";
  state: "in" | "next" | "none";
  confidence: "slot" | "period" | "none";
  className: string | null;
  classId: string | null;
  subject: string | null;
  period: number | null;
  periodLabel: string | null;
  startsAt: string | null;
  endsAt: string | null;
  room: string | null;
  lastTaughtBook: string | null;
  lastTaughtBookId: string | null;
  lastTaughtChapter: number | null;
  lastTaughtPart: number | null;
};

/** The resolver applied, plus today's remaining lessons. Pure; exported for the tests. */
export function nowNext(input: NowNextInput): { facts: NowNextFact[]; summary: string } {
  const { teacherId, shape, slots, lastTaught, classNames, bookTitles, day, minutes } = input;
  const ctx = resolveContext({ teacherId, shape, slots, lastTaught, day, minutes });
  const windows = periodWindows(shape);
  const className = (id: string | null) => (id ? classNames[id] ?? "Class" : null);
  const last = ctx.slot ? lastTaught.find((l) => l.class_id === ctx.slot!.class_id && l.subject === ctx.slot!.subject) ?? null : null;

  const state: NowNextFact["state"] = ctx.period ? ctx.period.state : "none";
  const head: NowNextFact = {
    row: "now",
    state,
    confidence: ctx.confidence,
    className: className(ctx.classId),
    classId: ctx.classId,
    subject: ctx.subject,
    period: ctx.period?.period ?? null,
    periodLabel: ctx.period?.label ?? null,
    startsAt: ctx.period ? hhmm(ctx.period.window.startMin) : null,
    endsAt: ctx.period ? hhmm(ctx.period.window.endMin) : null,
    room: ctx.slot?.room ?? null,
    lastTaughtBook: last?.book_id ? bookTitles[last.book_id] ?? "a book" : null,
    lastTaughtBookId: last?.book_id ?? null,
    lastTaughtChapter: last?.chapter_num ?? null,
    lastTaughtPart: last?.part ?? null,
  };

  // Today's remaining lessons: the teacher's lesson cells for this day in
  // periods after the one the clock points at (the current one included when
  // it is still to come).
  const fromPeriod = ctx.period ? (ctx.period.state === "in" ? ctx.period.period + 1 : ctx.period.period) : null;
  const remaining: NowNextFact[] = [];
  if (fromPeriod !== null && day >= 1 && day <= shape.days) {
    const todays = slots
      .filter((s) => s.teacher_id === teacherId && s.day === day && (s.kind ?? "lesson") === "lesson" && s.period >= fromPeriod)
      .sort((a, b) => a.period - b.period);
    for (const s of todays.slice(0, REMAINING_ROWS_CAP)) {
      const w = windows.find((x) => x.period === s.period);
      const lt = lastTaught.find((l) => l.class_id === s.class_id && l.subject === s.subject) ?? null;
      remaining.push({
        row: "remaining",
        state: "next",
        confidence: "slot",
        className: className(s.class_id),
        classId: s.class_id,
        subject: s.subject,
        period: s.period,
        periodLabel: w?.label ?? `P${s.period}`,
        startsAt: w ? hhmm(w.startMin) : null,
        endsAt: w ? hhmm(w.endMin) : null,
        room: s.room ?? null,
        lastTaughtBook: lt?.book_id ? bookTitles[lt.book_id] ?? "a book" : null,
        lastTaughtBookId: lt?.book_id ?? null,
        lastTaughtChapter: lt?.chapter_num ?? null,
        lastTaughtPart: lt?.part ?? null,
      });
    }
  }

  let summary: string;
  if (ctx.confidence === "slot" && ctx.period) {
    const where = ctx.period.state === "in" ? "Now" : "Next";
    const lastBit = last?.book_id ? ` Last time: ${head.lastTaughtBook}${last.chapter_num != null ? `, chapter ${last.chapter_num}` : ""}${last.part != null ? ` part ${last.part}` : ""}.` : "";
    summary = `${where}: ${head.subject} with ${head.className}, ${ctx.period.label} (${head.startsAt}–${head.endsAt}).${lastBit}`;
  } else if (ctx.confidence === "period" && ctx.period) {
    summary = `${ctx.period.state === "in" ? "It is" : "Next is"} ${ctx.period.label} (${head.startsAt}–${head.endsAt}); you have no lesson in it.`;
  } else {
    summary = day < 1 || day > shape.days ? "No school periods today." : minutes < (windows[0]?.startMin ?? 0) ? "School has not started yet." : "The school day is over.";
  }
  if (remaining.length) {
    summary += ` ${remaining.length} more today: ${remaining
      .slice(0, 4)
      .map((r) => `${r.periodLabel} ${r.subject} ${r.className}`)
      .join(", ")}${remaining.length > 4 ? ", …" : ""}.`;
  } else if (ctx.confidence !== "none") {
    summary += " Nothing more after that today.";
  }
  return { facts: [head, ...remaining], summary };
}

async function loadShape(ctx: SkContext, db: SkSessionDb): Promise<TimetableShape> {
  if (!ctx.user.schoolId) return shapeFromConfig(null);
  const res = await db.from("schools").select("config").eq("id", ctx.user.schoolId).maybeSingle();
  if (res?.error) throw new Error(`schools: ${res.error.message ?? "query failed"}`);
  return shapeFromConfig((res?.data as { config?: unknown } | null)?.config ?? null);
}

export const timetableNowNext: SkCapability = {
  meta: {
    name: "timetable.now_next",
    description:
      "Which lesson the teacher is in or has next (class, subject, period, times, where that class last got to), and the rest of today's lessons.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    tier: "immediate",
    kind: "read",
    roles: ["teacher", "school_admin", "coordinator"],
  },
  async handler(ctx, _args, deps) {
    const me = ctx.user.id;
    const db = deps.session;
    try {
      const shape = await loadShape(ctx, db);
      const slots = rows<Slot>(
        await db.from("timetable_slots").select("class_id, day, period, subject, teacher_id, room, kind").eq("teacher_id", me),
        "timetable_slots",
      );
      if (!slots.length) return { ok: true, summary: "You have no timetable.", facts: [], entities: [] };
      const lastTaught = rows<LastTaught>(
        await db.from("present_last_taught").select("class_id, subject, book_id, chapter_num, part").eq("teacher_id", me),
        "present_last_taught",
      );
      const classIds = [...new Set([...slots.map((s) => s.class_id), ...lastTaught.map((l) => l.class_id)])];
      const classNames: Record<string, string> = {};
      if (classIds.length) {
        for (const c of rows<ClassRow>(await db.from("classes").select("id, name").in("id", classIds), "classes")) classNames[c.id] = c.name || "Class";
      }
      const bookIds = [...new Set(lastTaught.map((l) => l.book_id).filter((b): b is string => !!b))];
      const bookTitles: Record<string, string> = {};
      if (bookIds.length) {
        for (const b of rows<BookRow>(await db.from("books").select("id, title").in("id", bookIds), "books")) bookTitles[b.id] = b.title || "a book";
      }
      const clock = deps.clock && Number.isFinite(deps.clock.day) && Number.isFinite(deps.clock.minutes) ? { day: deps.clock.day, minutes: deps.clock.minutes } : clockAt(deps.now);
      const { facts, summary } = nowNext({ teacherId: me, shape, slots, lastTaught, classNames, bookTitles, day: clock.day, minutes: clock.minutes });
      const head = facts[0];
      return {
        ok: true,
        summary: summary.slice(0, 400),
        facts: facts.map((f) => ({ ...f })),
        entities: head.classId ? [{ kind: "class", id: head.classId, label: head.className ?? "Class", via: "timetable.now_next" }] : [],
      };
    } catch (e) {
      return fail(e);
    }
  },
};
