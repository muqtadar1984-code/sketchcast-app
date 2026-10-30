// `start_lesson` — start a book chapter's lesson from SK (founder 2026-10-30:
// "play chapter 1 from the book" called context.resolve + library.find and
// could only ask a question back; nothing could START a chapter).
//
// One immediate-tier tool, two roles:
//   teacher → the Classroom Board deep link with autostart
//             (/present?book=&chapter=&autostart=1, deep-link.ts). An uploaded
//             book's chapter needs a finished presentation of HER OWN (the
//             rail's rule, /api/present/kit); none yet → a fixed line and the
//             Library row instead. A SketchCast product book's chapter goes to
//             the Board as it is: the Board adopts its catalogue kit on arrival
//             (present-client.tsx "ADOPT ON ARRIVAL") and then starts it.
//   student → the SK Tutor chapter (/sk/<product>/<chapter>) of a SketchCast
//             book she holds a live grant for.
//
// Resolution, in order:
//   book    — the user's books through RLS (own, the school shelf, product
//             books), each re-checked in code: own / same school / a product
//             with a LIVE book grant (the has_book_grant rule, read from her
//             own book_access_grants rows as catalogue.availability does).
//             A title is matched fuzzily; "the book" / no book = the only
//             book, else the one on screen, else the one in this
//             conversation, else (for "the book") the most recently used;
//             otherwise SK asks which, naming up to three.
//   chapter — a number in digits or words (chapter-words.ts; 1-based as
//             spoken, the database's chapters[].num is 0-based), or title words.
//   kit     — a ready-made kit by title (the start-lesson rule's own path).
//
// Nothing is started here: the result is a `navigate` the route emits, and
// the Board / Tutor page makes every access decision again itself.

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "@/sk/shell/types";
import { resolveNavigate, type NavFilters, type NavTarget } from "./navigate";
import { grantIsLive, searchLibrary } from "./library";
import { classNameMatches } from "./resolve";
import { teacherClasses } from "./shared";
import { chapterNumberOf } from "@/sk/shell/chapter-words";
import { kitFilters, pickKitHit } from "@/sk/shell/start-lesson";
import { STARTING_LESSON } from "@/sk/shell/lines";
import {
  LESSON_GENERATING,
  LESSON_NOT_GENERATED,
  LESSON_NO_BOOKS,
  LESSON_NO_BOOK_MATCH,
  LESSON_NO_CHAPTER,
  LESSON_NO_CHAPTERS,
  LESSON_NO_PRODUCT_BOOKS,
  LESSON_PART_ON_RAIL,
  LESSON_STARTING,
  LESSON_TUTOR_OPENING,
  LESSON_WHICH_BOOK,
  LESSON_WHICH_CHAPTER,
  lineFor,
  orList,
} from "@/sk/shell/lesson-lines";

export const START_LESSON = "start_lesson";

export type StartLessonArgs = { book?: string; chapter?: number | string; part?: number; kit?: string; class?: string };

export type LessonBook = {
  id: string;
  title: string;
  subject: string | null;
  /** 0-based nums, as the database and the Board key them. */
  chapters: Array<{ num: number; title: string | null }>;
  productId: string | null;
  ownerId: string | null;
  schoolId: string | null;
  createdAt: string | null;
};

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => {
  const d = (r as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? (d as Row[]) : [];
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function chaptersOf(v: unknown): LessonBook["chapters"] {
  if (!Array.isArray(v)) return [];
  const out: LessonBook["chapters"] = [];
  for (const c of v as Array<Record<string, unknown>>) {
    const num = typeof c?.num === "number" ? c.num : typeof c?.num === "string" && /^\d{1,3}$/.test(c.num) ? Number(c.num) : null;
    if (num === null || !Number.isInteger(num) || num < 0 || out.some((x) => x.num === num)) continue;
    out.push({ num, title: str(c?.title) });
  }
  return out.sort((a, b) => a.num - b.num);
}

// ── fuzzy matching ───────────────────────────────────────────────────────────

/** Lower-case, accents off, punctuation to spaces. */
export function plainWords(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words that never pick a book by themselves ("the biology book" = "biology"). */
const BOOK_NOISE = new Set([
  "the", "a", "an", "my", "our", "book", "books", "textbook", "text", "of", "from", "in",
  "buku", "teks", "kitab", "dari", "daripada", "dalam",
  "كتاب", "الكتاب", "كتابي", "من", "في",
  "le", "la", "les", "livre", "manuel", "de", "du", "des",
  "el", "libro", "del", "los",
  "o", "livro", "do", "da",
  "किताब", "पुस्तक", "का", "की", "के", "पुस्तकाचा",
  "పుస్తకం",
]);
/** Words that point at "the book on hand" rather than name one. */
const DEICTIC = new Set(["this", "that", "it", "same", "current", "ini", "itu", "saya", "tersebut", "هذا", "هذه", "ذلك", "نفس", "ce", "cet", "cette", "même", "este", "esta", "ese", "esa", "mismo", "esse", "essa", "mesmo", "यह", "वह", "ही", "हे", "ఈ", "ఆ"]);

const significant = (s: string): string[] => plainWords(s).split(" ").filter((w) => w && !BOOK_NOISE.has(w));

/** True when the words name no book of their own ("the book", "this book", "buku ini", "الكتاب"). */
export function isDeicticBook(q: string | null | undefined): boolean {
  if (!q || !q.trim()) return true;
  return significant(q).every((w) => DEICTIC.has(w));
}

const tokenHit = (q: string, t: string) => t === q || (q.length >= 4 && t.startsWith(q)) || (t.length >= 4 && q.startsWith(t));

/** How well words name a title (0 = not at all, 100 = the title itself). */
export function titleScore(query: string, title: string, subject?: string | null): number {
  const qn = significant(query).join(" ");
  const tn = plainWords(title);
  if (!qn || !tn) return 0;
  if (qn === tn || qn === significant(title).join(" ")) return 100;
  if (qn.length >= 3 && (tn.startsWith(qn) || tn.includes(` ${qn}`) || tn.includes(qn))) return 80;
  const qt = qn.split(" ");
  const tt = tn.split(" ");
  const hits = qt.filter((q) => tt.some((t) => tokenHit(q, t))).length;
  let score = hits === qt.length ? 60 + Math.round((10 * hits) / Math.max(tt.length, 1)) : Math.round((40 * hits) / qt.length);
  if (subject && plainWords(subject) && (plainWords(subject) === qn || qt.some((q) => tokenHit(q, plainWords(subject))))) score = Math.max(score, 55);
  return score;
}

const MATCH_MIN = 30;

/** The books the words name best: one winner, several tied, or none. */
export function matchBooks(query: string, books: LessonBook[]): LessonBook[] {
  const scored = books.map((b) => ({ b, s: titleScore(query, b.title, b.subject) })).filter((x) => x.s >= MATCH_MIN);
  if (!scored.length) return [];
  const best = Math.max(...scored.map((x) => x.s));
  return scored.filter((x) => x.s === best).map((x) => x.b);
}

const CHAPTER_NOUN_RE = /^(?:the\s+)?(?:chapter|chap\.?|ch\.?|bab|الفصل|فصل|chapitre|cap[ií]tulo|अध्याय|धडा|प्रकरण|అధ్యాయం|పాఠం)\s*/iu;

/** A chapter as said ("1", "one", "Chapter 1", "the first", "Cell structure") → its 0-based num in this book. */
export function resolveChapter(book: LessonBook, chapter: unknown): { num: number } | { error: "missing" | "no_chapter" } {
  if (chapter === undefined || chapter === null || (typeof chapter === "string" && !chapter.trim())) return { error: "missing" };
  const raw = typeof chapter === "number" ? chapter : String(chapter).trim().replace(CHAPTER_NOUN_RE, "");
  const n = chapterNumberOf(raw);
  if (n !== null) return book.chapters.some((c) => c.num === n - 1) ? { num: n - 1 } : { error: "no_chapter" };
  const words = String(raw);
  const scored = book.chapters.map((c) => ({ c, s: c.title ? titleScore(words, c.title) : 0 })).filter((x) => x.s >= 40);
  if (!scored.length) return { error: "no_chapter" };
  scored.sort((a, b) => b.s - a.s || a.c.num - b.c.num);
  return { num: scored[0].c.num };
}

// ── reads (the user-session client; RLS first, then the code's own belt) ────

/** The books this user may start a lesson from. */
export async function lessonBooks(ctx: SkContext, deps: SkCapabilityDeps): Promise<LessonBook[]> {
  const me = ctx.user.id;
  const student = ctx.user.role === "student";
  const cols = "id, title, subject, chapters, owner_id, school_id, created_at";
  let res = await deps.session.from("books").select(`${cols}, sk_product_id`).is("removed_at", null).order("created_at", { ascending: false });
  // Before 0175 there is no sk_product_id column (loadBoardBooks does the same).
  if ((res as { error?: unknown } | null)?.error) res = await deps.session.from("books").select(cols).is("removed_at", null).order("created_at", { ascending: false });
  const all: LessonBook[] = rowsOf(res)
    .filter((r) => typeof r.id === "string" && typeof r.title === "string")
    .map((r) => ({
      id: r.id as string,
      title: (r.title as string).trim(),
      subject: str(r.subject),
      chapters: chaptersOf(r.chapters),
      productId: str(r.sk_product_id),
      ownerId: str(r.owner_id),
      schoolId: str(r.school_id),
      createdAt: str(r.created_at),
    }));
  const products = [...new Set(all.map((b) => b.productId).filter((x): x is string => !!x))];
  let live = new Set<string>();
  if (products.length) {
    const grants = rowsOf(await deps.session.from("book_access_grants").select("user_id, product_id, activated_at, expires_at, revoked_at").eq("user_id", me));
    live = new Set(
      grants
        .filter((g) => g.user_id === me && typeof g.product_id === "string" && typeof g.activated_at === "string")
        .filter((g) => grantIsLive({ product_id: g.product_id as string, activated_at: g.activated_at as string, expires_at: str(g.expires_at), revoked_at: str(g.revoked_at) }, deps.now))
        .map((g) => g.product_id as string),
    );
  }
  return all.filter((b) => {
    if (b.productId) return live.has(b.productId);
    if (student) return false; // students learn from SketchCast books in the Tutor
    return b.ownerId === me || (!!ctx.user.schoolId && b.schoolId === ctx.user.schoolId);
  });
}

/** Book ids in the order she last used them: on screen, in this conversation,
 *  last taught on the Board, her newest kit. `deep` adds the last two. */
async function recentBookIds(ctx: SkContext, deps: SkCapabilityDeps, deep: boolean, books: LessonBook[]): Promise<string[]> {
  const ids: string[] = [];
  if (ctx.selection.bookId) ids.push(ctx.selection.bookId);
  // A student inside a SketchCast book (/sk/<product>, or its open kit): that book.
  const slug = ctx.tutor?.product ?? ctx.selection.productSlug ?? /^\/sk\/([a-z0-9][a-z0-9_-]{0,119})/i.exec(ctx.place.path)?.[1];
  if (slug && books.some((b) => b.productId)) {
    try {
      const p = rowsOf(await deps.session.from("sk_book_products").select("id, slug").eq("slug", slug)).find((r) => r.slug === slug);
      const hit = p ? books.find((b) => b.productId === p.id) : undefined;
      if (hit) ids.push(hit.id);
    } catch {
      /* best-effort */
    }
  }
  for (const e of ctx.recent.entities) if (e.kind === "book") ids.push(e.id);
  if (deep && ctx.user.role !== "student") {
    try {
      const taught = rowsOf(await deps.session.from("present_last_taught").select("book_id, updated_at, teacher_id").eq("teacher_id", ctx.user.id).order("updated_at", { ascending: false }).limit(10));
      for (const r of taught) if (r.teacher_id === ctx.user.id && typeof r.book_id === "string") ids.push(r.book_id);
    } catch {
      /* best-effort */
    }
    try {
      const kits = rowsOf(await deps.session.from("generations").select("book_id, owner_id, created_at").eq("owner_id", ctx.user.id).not("book_id", "is", null).order("created_at", { ascending: false }).limit(10));
      for (const r of kits) if (r.owner_id === ctx.user.id && typeof r.book_id === "string") ids.push(r.book_id);
    } catch {
      /* best-effort */
    }
  }
  return [...new Set(ids)];
}

const IN_PROGRESS = new Set(["pending", "queued", "processing", "running", "generating"]);

/** Her own presentation of this chapter (and part): done, in progress, or none. */
async function chapterKitState(ctx: SkContext, deps: SkCapabilityDeps, bookId: string, num: number, part: number | null): Promise<"done" | "generating" | "none"> {
  const rows = rowsOf(
    await deps.session
      .from("generations")
      .select("id, kind, status, chapter_ref, params, owner_id, book_id")
      .eq("book_id", bookId)
      .eq("owner_id", ctx.user.id)
      .eq("kind", "presentation")
      .eq("chapter_ref", String(num))
      .is("withdrawn_at", null),
  ).filter((g) => g.owner_id === ctx.user.id && g.book_id === bookId && g.kind === "presentation" && String(g.chapter_ref) === String(num));
  const inPart = part === null ? rows : rows.filter((g) => (g.params as { part?: unknown } | null)?.part === part);
  if (inPart.some((g) => g.status === "done")) return "done";
  if (inPart.some((g) => typeof g.status === "string" && IN_PROGRESS.has(g.status))) return "generating";
  return "none";
}

// ── the handler ──────────────────────────────────────────────────────────────

const bookEntity = (b: LessonBook): ResolvedEntity => ({ kind: "book", id: b.id, label: b.title, via: START_LESSON });

function go(ctx: SkContext, target: NavTarget, filters: NavFilters, summary: string, facts: SkCapabilityResult["facts"], entities: ResolvedEntity[]): SkCapabilityResult {
  const nav = resolveNavigate(ctx, { target, ...filters });
  if (!nav.ok || !nav.navigate) return { ...nav, facts: facts ?? [], entities };
  return { ok: true, summary, navigate: nav.navigate, facts, entities };
}

const lastChapter = (b: LessonBook) => (b.chapters.length ? b.chapters[b.chapters.length - 1].num + 1 : 0);

export async function startLesson(ctx: SkContext, rawArgs: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const loc = ctx.user.locale;
  const student = ctx.user.role === "student";
  const bookQ = typeof rawArgs.book === "string" ? rawArgs.book.trim().slice(0, 120) : "";
  const kitQ = typeof rawArgs.kit === "string" ? rawArgs.kit.trim().slice(0, 80) : "";
  const chapterArg = typeof rawArgs.chapter === "number" || typeof rawArgs.chapter === "string" ? rawArgs.chapter : undefined;
  const partN = typeof rawArgs.part === "number" ? rawArgs.part : typeof rawArgs.part === "string" ? chapterNumberOf(rawArgs.part) : null;
  const part = typeof partN === "number" && Number.isInteger(partN) && partN >= 1 && partN <= 50 ? partN : null;
  const hasChapter = chapterArg !== undefined && String(chapterArg).trim() !== "";

  // The class she named, among her own classes (teachers only).
  const filters: NavFilters = {};
  const classQ = typeof rawArgs.class === "string" ? rawArgs.class.trim().slice(0, 40) : "";
  if (classQ && !student) {
    const cls = rowsOf(await teacherClasses(deps, ctx.user.id).catch(() => null)).filter(
      (c) => c.teacher_id === ctx.user.id && typeof c.id === "string" && typeof c.name === "string" && classNameMatches(c.name as string, classQ),
    );
    if (cls.length === 1) filters.classId = cls[0].id as string;
  }

  // A ready-made kit by title, with no book or chapter named (teachers).
  if (kitQ && !bookQ && !hasChapter && !student) {
    const hit = pickKitHit(await searchLibrary(ctx, deps, kitQ, 40), kitQ);
    const f = hit ? kitFilters(hit) : null;
    if (!hit || !f) return { ok: false, summary: `No kit of yours matches "${kitQ}".`, error: "no_kit", facts: [] };
    const entity: ResolvedEntity = { kind: hit.bookId ? "chapter" : "generation", id: hit.id, label: hit.title, via: START_LESSON };
    return go(ctx, "board", { ...filters, ...f, autostart: true }, lineFor(STARTING_LESSON, loc, { lesson: hit.title }), [{ kit: hit.title }], [entity]);
  }

  const books = await lessonBooks(ctx, deps);
  if (!books.length) return { ok: true, summary: lineFor(student ? LESSON_NO_PRODUCT_BOOKS : LESSON_NO_BOOKS, loc), facts: [] };

  // ── the book ──
  let book: LessonBook | null = null;
  let candidates: LessonBook[] = [];
  const deictic = isDeicticBook(bookQ);
  if (!deictic) {
    candidates = matchBooks(bookQ, books);
    if (candidates.length === 1) book = candidates[0];
    else if (!candidates.length) {
      const titles = orList(books.slice(0, 3).map((b) => b.title), loc);
      return { ok: true, summary: lineFor(LESSON_NO_BOOK_MATCH, loc, { query: bookQ, titles }), facts: books.slice(0, 3).map((b) => ({ book: b.title, chapters: b.chapters.length })) };
    }
  } else if (books.length === 1) {
    book = books[0];
  } else {
    candidates = books;
  }
  if (!book) {
    // Several: the one on screen or in this conversation, and — when she
    // said "the book" — the one she used last. Otherwise ask, naming three.
    const recent = await recentBookIds(ctx, deps, deictic && !!bookQ, candidates);
    book = recent.map((id) => candidates.find((b) => b.id === id)).find((b): b is LessonBook => !!b) ?? null;
    if (!book) {
      const order = (b: LessonBook) => {
        const i = recent.indexOf(b.id);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      const ask = [...candidates].sort((a, b) => order(a) - order(b) || (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, 3);
      return {
        ok: true,
        summary: lineFor(LESSON_WHICH_BOOK, loc, { titles: orList(ask.map((b) => b.title), loc) }),
        facts: ask.map((b) => ({ book: b.title, chapters: b.chapters.length })),
        entities: [],
      };
    }
  }

  // ── the chapter ──
  const entities = [bookEntity(book)];
  if (!book.chapters.length) return { ok: true, summary: lineFor(LESSON_NO_CHAPTERS, loc, { book: book.title }), facts: [{ book: book.title, chapters: 0 }], entities };
  const ch = resolveChapter(book, chapterArg);
  if ("error" in ch) {
    const line = ch.error === "missing" ? LESSON_WHICH_CHAPTER : LESSON_NO_CHAPTER;
    return {
      ok: true,
      summary: lineFor(line, loc, { book: book.title, max: lastChapter(book) }),
      facts: book.chapters.slice(0, 20).map((c) => ({ book: book.title, chapter: c.num + 1, title: c.title })),
      entities,
    };
  }
  const n = ch.num + 1;
  const chapterTitle = book.chapters.find((c) => c.num === ch.num)?.title ?? null;
  const facts = [{ book: book.title, chapter: n, chapter_title: chapterTitle, part }];

  // ── student: the SK Tutor chapter ──
  if (student) {
    const prod = rowsOf(await deps.session.from("sk_book_products").select("id, slug").eq("id", book.productId));
    const slug = prod.find((p) => p.id === book.productId && typeof p.slug === "string")?.slug as string | undefined;
    if (!slug) return { ok: false, summary: lineFor(LESSON_NO_PRODUCT_BOOKS, loc), error: "no_product", facts: [] };
    return go(ctx, "tutor", { product: slug, chapter: String(n) }, lineFor(LESSON_TUTOR_OPENING, loc, { n, book: book.title }), facts, entities);
  }

  // ── teacher: the Board, or the Library row when there is nothing to play ──
  const say = lineFor(LESSON_STARTING, loc, { n, book: book.title }) + (part ? ` ${lineFor(LESSON_PART_ON_RAIL, loc, { part })}` : "");
  const board: NavFilters = { ...filters, bookId: book.id, chapterRef: String(ch.num), autostart: true };
  // A SketchCast book's chapter: the Board adopts its catalogue kit on arrival.
  if (book.productId) return go(ctx, "board", board, say, facts, entities);
  const state = await chapterKitState(ctx, deps, book.id, ch.num, part);
  if (state === "done") return go(ctx, "board", board, say, facts, entities);
  const label = part ? `${n}.${part}` : n;
  const line = state === "generating" ? LESSON_GENERATING : LESSON_NOT_GENERATED;
  return go(ctx, "library", { bookId: book.id }, lineFor(line, loc, { n: label, book: book.title }), [{ ...facts[0], generated: false, generating: state === "generating" }], entities);
}

export const startLessonCapability: SkCapability = {
  meta: {
    name: START_LESSON,
    description:
      "Start (play, teach, open) a lesson: a chapter of one of the user's books, or a ready-made kit by title. For a teacher it opens the Classroom Board on that chapter and starts it (a SketchCast book chapter is adopted on the Board); a chapter with no generated kit yet opens its Library row instead. For a student it opens that chapter of her SketchCast book in SK Tutor. Use for 'play chapter 1 from the book', 'start chapter two of Biology', 'teach the first chapter', 'mainkan bab 1', 'شغّل الفصل الأول'. Pass the user's own words: book = a title or title words (leave it out, or pass 'the book', when none was named — the tool picks the only or most recent book and otherwise asks which), chapter = its number (1-based, as said) or title words, part = a part number if said, kit = a ready-made kit's title, class = a class name if said ('7B'). Do NOT call context.resolve or library.find first and do NOT ask which book yourself: this tool resolves the book and returns the question when it is ambiguous — repeat its line.",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "The book's title or title words as the user said them; omit or 'the book' when none was named." },
        chapter: { type: "string", description: "The chapter: a number as said ('1', 'one', 'first') or its title words." },
        part: { type: "number", description: "A part of the chapter (1-based), only when said." },
        kit: { type: "string", description: "A ready-made kit's title (teachers), when no book chapter was named." },
        class: { type: "string", description: "The class to teach, as said ('7B'), teachers only." },
      },
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "nav",
    roles: ["teacher", "school_admin", "coordinator", "student"],
    hats: ["teacher"],
  },
  handler: startLesson,
};
