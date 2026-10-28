// "Start the lesson" when no Board session is open (Final Plan §2.7: "open the
// Board and start with the video" from nothing). Decides WHERE the lesson
// comes from, in order, and hands the turn route one plan:
//
//   1. what the user named — a resolved book + chapter or a ready-made kit;
//   2. what the Board's bar has picked (the collector's selection), once the
//      ids are shown to be the teacher's own through the user-session client;
//   3. the timetable — the lesson she is in or has next, with the class's
//      last-taught book and chapter;
//   4. nothing: a fixed line (no model) on the Board, or the way to the Board
//      from anywhere else.
//
// The plan is a `navigate board` with filters + autostart=1: the Board page
// re-mounts its pick from the query (deep-link.ts) and starts the session
// itself — the server never starts a lesson. Pure apart from the injected
// `run` (the capability runner) and `db` (the user-session client), so the
// route test drives it with fakes.

import type { SkCapabilityResult, SkContext, SkSessionDb, ResolvedEntity } from "./types";
import type { NavFilters } from "@/sk/capabilities/navigate";
import type { LibraryHit } from "@/sk/capabilities/library";
import { normalizeName } from "@/sk/capabilities/resolve";
import { kitPrefix } from "@/utils/present/kit";
import { LESSON_NOT_STARTED, STARTING_LESSON, lineFor } from "./lines";

export type StartLessonPlan =
  | {
      kind: "navigate";
      filters: NavFilters;
      /** What SK says with the navigate; null → the navigate's own line. */
      say: string | null;
      sources: string[];
      entities: ResolvedEntity[];
    }
  | { kind: "none"; sources: string[] };

export type StartLessonDeps = {
  ctx: SkContext;
  db: SkSessionDb;
  run: (name: string, args: Record<string, unknown>) => Promise<SkCapabilityResult>;
};

/** The Board filters a library hit stands for: a book-less presentation is a
 *  ready-made kit (kit=); a kit of a book is that book's chapter. Null for a
 *  hit the Board cannot open (a worksheet alone, a book). */
export function kitFilters(h: LibraryHit): NavFilters | null {
  if (h.kind !== "kit") return null;
  if (!h.bookId && h.kitKind === "presentation") return { generationId: h.id };
  if (h.bookId && h.chapterRef !== null && h.chapterRef !== undefined && /^\d{1,3}$/.test(String(h.chapterRef))) return { bookId: h.bookId, chapterRef: String(h.chapterRef) };
  return null;
}

/** Among the hits for a kit query: an exact title (prefix) match first, then
 *  the newest ready-made presentation, then the newest book kit. */
export function pickKitHit(hits: LibraryHit[], query: string): LibraryHit | null {
  const usable = hits.filter((h) => kitFilters(h) !== null);
  if (!usable.length) return null;
  const q = normalizeName(query);
  const exact = usable.find((h) => normalizeName(kitPrefix(h.title)) === q || normalizeName(h.title) === q);
  if (exact) return exact;
  return usable.find((h) => !h.bookId && h.kitKind === "presentation") ?? usable[0];
}

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

async function exists(db: SkSessionDb, table: string, id: string, me: string | null): Promise<boolean> {
  try {
    let q = db.from(table).select("id").eq("id", id);
    if (me) q = q.eq("owner_id", me);
    const r = (await q.limit(1)) as { data?: unknown } | null;
    return Array.isArray(r?.data) && r.data.some((row) => (row as { id?: unknown })?.id === id);
  } catch {
    return false;
  }
}

/** The bar's pick, only when the ids are hers (RLS for the book; the owner
 *  column for a kit), with the class she picked riding along. */
async function fromSelection(d: StartLessonDeps): Promise<NavFilters | null> {
  const sel = d.ctx.selection;
  const out: NavFilters = {};
  if (sel.classId && ID_RE.test(sel.classId)) out.classId = sel.classId;
  if (sel.generationId && ID_RE.test(sel.generationId)) {
    if (await exists(d.db, "generations", sel.generationId, d.ctx.user.id)) return { ...out, generationId: sel.generationId };
    return null;
  }
  if (sel.bookId && sel.chapterRef && ID_RE.test(sel.bookId) && /^\d{1,3}$/.test(sel.chapterRef)) {
    if (await exists(d.db, "books", sel.bookId, null)) return { ...out, bookId: sel.bookId, chapterRef: sel.chapterRef };
  }
  return null;
}

type NowFact = { classId?: unknown; className?: unknown; subject?: unknown; lastTaughtBookId?: unknown; lastTaughtBook?: unknown; lastTaughtChapter?: unknown; lastTaughtChapterTitle?: unknown };

/** The lesson the timetable names, when its class has a last-taught book and chapter. */
async function fromTimetable(d: StartLessonDeps): Promise<{ filters: NavFilters; lesson: string; result: SkCapabilityResult } | null> {
  const r = await d.run("timetable.now_next", {});
  if (!r.ok) return null;
  const f = (r.facts?.[0] ?? null) as NowFact | null;
  if (!f || typeof f.classId !== "string" || typeof f.lastTaughtBookId !== "string") return null;
  if (typeof f.lastTaughtChapter !== "number" || !Number.isInteger(f.lastTaughtChapter) || f.lastTaughtChapter < 0) return null;
  const bits = [f.className, f.subject, typeof f.lastTaughtChapterTitle === "string" && f.lastTaughtChapterTitle ? f.lastTaughtChapterTitle : f.lastTaughtBook].filter((x): x is string => typeof x === "string" && !!x.trim());
  return {
    filters: { classId: f.classId, bookId: f.lastTaughtBookId, chapterRef: String(f.lastTaughtChapter) },
    lesson: bits.join(" · "),
    result: r,
  };
}

/** True when the filters name a lesson the Board can start on its own. */
export const namesLesson = (f: NavFilters): boolean => !!f.generationId || (!!f.bookId && !!f.chapterRef);

/**
 * Decide where the lesson comes from. `named` are the filters the user's own
 * words resolved to (class, book + chapter, kit) — used as they are when they
 * name a lesson, else merged with what the selection or timetable supplies.
 */
export async function planStartLesson(d: StartLessonDeps, named: NavFilters = {}): Promise<StartLessonPlan> {
  const sources: string[] = [];
  if (namesLesson(named)) return { kind: "navigate", filters: { ...named, autostart: true }, say: null, sources, entities: [] };

  const picked = await fromSelection(d);
  if (picked) {
    return { kind: "navigate", filters: { ...picked, ...(named.classId ? { classId: named.classId } : {}), autostart: true }, say: null, sources, entities: [] };
  }

  const tt = await fromTimetable(d);
  sources.push("timetable.now_next");
  if (tt) {
    return {
      kind: "navigate",
      filters: { ...tt.filters, ...(named.classId ? { classId: named.classId } : {}), autostart: true },
      say: lineFor(STARTING_LESSON, d.ctx.user.locale, { lesson: tt.lesson }),
      sources,
      entities: tt.result.entities ?? [],
    };
  }
  return { kind: "none", sources };
}

/** The fixed line for a Board with nothing to start, in the user's locale. */
export const lessonNotStarted = (locale: string | null | undefined): string => lineFor(LESSON_NOT_STARTED, locale);
