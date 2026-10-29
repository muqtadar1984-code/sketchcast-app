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

import type { SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext, SkSessionDb } from "../shell/types";
import { shapeFromConfig, type Slot, type TimetableShape } from "@/utils/timetable";
import { periodAt, periodWindows, resolveContext, type LastTaught } from "@/utils/present/context";
// S5 slice A: the principal / coordinator modes (leader-scope.ts).
import { lineFor } from "../shell/lines";
import { S_NO_SCOPE, S_OUT_OF_SCOPE, S_READ_FAILED, S_TT_CLOSED, S_TT_IN, S_TT_NEXT, S_TT_NONE } from "../shell/school-lines";
import { classInScope, gradeOutsideScope, leaderScope, sameGrade, sameSubject, scopeLabel, stripEmails, whereLabel, type LeaderScope } from "./leader-scope";

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
type BookRow = { id: string; title: string | null; chapters?: Array<{ num?: number; title?: string | null }> | null };

export type NowNextInput = {
  teacherId: string;
  shape: TimetableShape;
  slots: Slot[];
  lastTaught: LastTaught[];
  classNames: Record<string, string>;
  bookTitles: Record<string, string>;
  /** "bookId:chapterNum" → the chapter's title (books.chapters[].title). */
  chapterTitles?: Record<string, string>;
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
  lastTaughtChapterTitle: string | null;
  lastTaughtPart: number | null;
};

/** The resolver applied, plus today's remaining lessons. Pure; exported for the tests. */
export function nowNext(input: NowNextInput): { facts: NowNextFact[]; summary: string } {
  const { teacherId, shape, slots, lastTaught, classNames, bookTitles, chapterTitles = {}, day, minutes } = input;
  const ctx = resolveContext({ teacherId, shape, slots, lastTaught, day, minutes });
  const windows = periodWindows(shape);
  const className = (id: string | null) => (id ? classNames[id] ?? "Class" : null);
  const chapterTitle = (l: LastTaught | null) => (l?.book_id && l.chapter_num != null ? chapterTitles[`${l.book_id}:${l.chapter_num}`] ?? null : null);
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
    lastTaughtChapterTitle: chapterTitle(last),
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
        lastTaughtChapterTitle: chapterTitle(lt),
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
      "Which lesson the teacher is in or has next (class, subject, period, times, where that class last got to), and the rest of today's lessons. With the principal hat: every class's lesson in the current or next period across the school; with the coordinator hat: the scope grades' classes only.",
    parameters: {
      type: "object",
      properties: { grade: { type: "string", description: 'Leaders only: only this grade, e.g. "5" or "Form 2".' } },
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["teacher", "school_admin", "coordinator"],
  },
  async handler(ctx, args, deps) {
    const me = ctx.user.id;
    const db = deps.session;
    // S5: the principal / coordinator hats see the school's (scope's) lessons
    // in the current or next period.
    const ls = leaderScope(ctx);
    if (ls.mode !== "own") return leaderNowNext(ctx, ls, typeof args.grade === "string" && args.grade.trim() ? args.grade.trim().slice(0, 20) : undefined, deps);
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
      const chapterTitles: Record<string, string> = {};
      if (bookIds.length) {
        for (const b of rows<BookRow>(await db.from("books").select("id, title, chapters").in("id", bookIds), "books")) {
          bookTitles[b.id] = b.title || "a book";
          for (const c of Array.isArray(b.chapters) ? b.chapters : []) {
            if (typeof c?.num === "number" && typeof c.title === "string" && c.title.trim()) chapterTitles[`${b.id}:${c.num}`] = c.title.trim();
          }
        }
      }
      const clock = deps.clock && Number.isFinite(deps.clock.day) && Number.isFinite(deps.clock.minutes) ? { day: deps.clock.day, minutes: deps.clock.minutes } : clockAt(deps.now);
      const { facts, summary } = nowNext({ teacherId: me, shape, slots, lastTaught, classNames, bookTitles, chapterTitles, day: clock.day, minutes: clock.minutes });
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

// ── S5 slice A: the leader modes ─────────────────────────────────────────────

export const LEADER_LESSONS_CAP = 30;

type LeaderClassRow = { id: string; name: string | null; grade: string | null; school_id: string | null };
type ProfileRow = { id: string; full_name: string | null; username: string | null };

/** timetable.now_next with the principal hat (every class of the school) or
 *  the coordinator hat (classes of the scope grades; a scope row with a
 *  subject keeps only that subject's lessons). The period comes from the
 *  school's own shape and the same clock the teacher view uses. Slots are
 *  school-wide under RLS (tt_member_read), so the scope cut here is what keeps
 *  a coordinator inside their grades. */
export async function leaderNowNext(ctx: SkContext, ls: LeaderScope, grade: string | undefined, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const locale = ctx.user.locale;
  const db = deps.session;
  if (ls.mode === "scope" && !(ls.rows ?? []).length) return { ok: true, summary: lineFor(S_NO_SCOPE, locale), facts: [], entities: [] };
  if (gradeOutsideScope(ls, grade)) {
    return { ok: true, summary: lineFor(S_OUT_OF_SCOPE, locale, { grade: whereLabel(ls, locale, grade), scope: scopeLabel(ls.rows ?? [], locale) }), facts: [], entities: [] };
  }
  if (!ls.schoolId) return { ok: true, summary: lineFor(S_TT_CLOSED, locale), facts: [], entities: [] };
  try {
    const shape = await loadShape(ctx, db);
    const clock = deps.clock && Number.isFinite(deps.clock.day) && Number.isFinite(deps.clock.minutes) ? { day: deps.clock.day, minutes: deps.clock.minutes } : clockAt(deps.now);
    const hit = clock.day >= 1 && clock.day <= shape.days ? periodAt(periodWindows(shape), clock.minutes) : null;
    if (!hit) return { ok: true, summary: lineFor(S_TT_CLOSED, locale), facts: [], entities: [] };
    const where = whereLabel(ls, locale, grade);
    const slots = rows<Slot>(
      await db.from("timetable_slots").select("class_id, day, period, subject, teacher_id, room, kind").eq("school_id", ls.schoolId).eq("day", clock.day).eq("period", hit.period),
      "timetable_slots",
    ).filter((s) => (s.kind ?? "lesson") === "lesson");
    const classIds = [...new Set(slots.map((s) => s.class_id))];
    const classes = classIds.length ? rows<LeaderClassRow>(await db.from("classes").select("id, name, grade, school_id").in("id", classIds), "classes") : [];
    const scopeRows = ls.rows ?? [];
    const classById = new Map(classes.filter((c) => c.school_id === ls.schoolId && (ls.mode === "school" || classInScope(c.grade, scopeRows)) && (!grade || sameGrade(c.grade, grade))).map((c) => [c.id, c] as const));
    // A slot whose class row RLS did not return has no grade to check: dropped.
    const kept = slots
      .filter((s) => {
        const c = classById.get(s.class_id);
        if (!c) return false;
        if (ls.mode === "school") return true;
        return scopeRows.some((r) => sameGrade(c.grade, r.grade) && (r.subject === null || sameSubject(s.subject, r.subject)));
      })
      .sort((a, b) => (classById.get(a.class_id)?.name ?? "").localeCompare(classById.get(b.class_id)?.name ?? ""));
    const period = hit.label;
    const start = hhmm(hit.window.startMin);
    const end = hhmm(hit.window.endMin);
    if (!kept.length) return { ok: true, summary: lineFor(S_TT_NONE, locale, { where, period }), facts: [], entities: [] };
    const teacherIds = [...new Set(kept.map((s) => s.teacher_id).filter((t): t is string => !!t))];
    const teacherName = new Map<string, string>();
    if (teacherIds.length) {
      for (const p of rows<ProfileRow>(await db.from("profiles").select("id, full_name, username").in("id", teacherIds), "profiles")) teacherName.set(p.id, p.full_name || p.username || "Teacher");
    }
    const shown = kept.slice(0, LEADER_LESSONS_CAP);
    const facts = shown.map((s) => {
      const c = classById.get(s.class_id)!;
      return {
        row: hit.state === "in" ? "now" : "next",
        className: c.name || "Class",
        classId: c.id,
        grade: c.grade,
        subject: s.subject,
        teacher: s.teacher_id ? teacherName.get(s.teacher_id) ?? "Teacher" : null,
        room: s.room ?? null,
        period: hit.period,
        periodLabel: period,
        startsAt: start,
        endsAt: end,
      };
    });
    const items = `${facts
      .slice(0, 8)
      .map((f) => `${f.className} ${f.subject}${f.teacher ? ` (${f.teacher})` : ""}`)
      .join(", ")}${facts.length > 8 ? ", …" : ""}`;
    const summary = lineFor(hit.state === "in" ? S_TT_IN : S_TT_NEXT, locale, { where, period, start, end, n: kept.length, items });
    return stripEmails({
      ok: true,
      summary: summary.slice(0, 900),
      facts,
      entities: shown.slice(0, 15).map((s) => ({ kind: "class" as const, id: s.class_id, label: classById.get(s.class_id)?.name || "Class", via: "timetable.now_next" })),
    });
  } catch (e) {
    return { ok: false, summary: lineFor(S_READ_FAILED, locale), error: e instanceof Error ? e.message : String(e) };
  }
}
