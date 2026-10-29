// Lesson prep — `lesson.prepare` (confirm, CLICK-ONLY: it spends credits) and
// `lesson.status` (read), S2 slice B (Final Plan 2026-10-28 §2.5, §4, §9.2).
//
// "prepare Specialised Cells for Friday", "make a kit for chapter 3 of
// Biology", "sediakan kit untuk bab 3", "جهّز درس الخلايا" → lesson.prepare
// resolves ONE chapter of ONE book on her shelf (her own books, then the
// school shelf — asks when more than one matches, never guesses). If she
// already has a kit for that chapter there is NO card: "You already have that
// kit — want me to open it?" with a `kit` entity to open. Otherwise a card
// with the EXACT credits the kit will be charged — computed from the SAME
// rows the Library's chapter kit inserts (kit.ts kitRows) through the SAME
// rule the ledger trigger uses (kit.ts kitCredits) — and what she has left
// (my_fair_use, read like the Library's meter, utils/fair-use.ts). "for
// Friday" is kept in the card title only: nothing is scheduled.
//
// The insert happens only in /api/sk/act → act-prepare.ts, AS THE TEACHER
// through the user-session client (so the trial pin, fair use, duplicate
// guard, lesson-tools and can_use_book triggers/policies all decide, exactly
// as for a Library click), each row carrying sk_action_id (0169). `planKit`
// is shared by both sides so the card and the insert can never disagree.
//
// "how's the kit going" → lesson.status: the teacher's recent SK-started kits
// (sk_action_id set, newest first). 0169 may not be applied yet: a missing
// column degrades to her newest generations.

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "@/sk/shell/types";
import { kitCredits, kitRows, type GenerationRow } from "@/app/dashboard/kit";
import { defaultNarrationForGrade } from "@/utils/narration";
import { isGated, type GateHealth } from "@/utils/junk-gate";
import { creditsLeftOf, type FairUsePayload } from "@/utils/fair-use";
import { textMatches } from "@/utils/availability";
import { cleanQuery, normalizeName } from "./resolve";
import { lineFor } from "@/sk/shell/lines";
import { PREP_CARD_TITLE, PREP_CARD_TITLE_FOR, PREP_EXISTS, PREP_GATE_WARNING } from "@/sk/shell/act-lines";

type Row = Record<string, unknown>;
const rows = <T = Row>(res: unknown, what: string): T[] => {
  const r = res as { data?: unknown; error?: { message?: string } | null } | null;
  if (!r) return [];
  if (r.error) throw new Error(`${what}: ${r.error.message ?? "query failed"}`);
  return (Array.isArray(r.data) ? r.data : []) as T[];
};
const argStr = (args: Record<string, unknown>, key: string, max = 120): string => (typeof args[key] === "string" ? (args[key] as string).trim().slice(0, max) : "");

export type ShelfChapter = { num?: number; title?: string | null; parts?: unknown[] | null };
export type ShelfBook = {
  id: string;
  title: string | null;
  subject: string | null;
  grade: string | null;
  language: string | null;
  status: string | null;
  owner_id: string | null;
  school_id: string | null;
  chapters: ShelfChapter[] | null;
  health?: GateHealth;
};
const BOOK_COLS = "id, title, subject, grade, language, status, owner_id, school_id, chapters, health";

/** Her own books, then the school shelf (another teacher's book in her
 *  school) — library.find's scope, re-checked in code (RLS may show more). */
export async function shelfBooks(ctx: SkContext, deps: SkCapabilityDeps): Promise<Array<ShelfBook & { where: "my_library" | "school_shelf" }>> {
  const me = ctx.user.id;
  const school = ctx.user.schoolId;
  const own = rows<ShelfBook>(await deps.session.from("books").select(BOOK_COLS).eq("owner_id", me).order("created_at", { ascending: false }), "books").filter((b) => b.owner_id === me);
  const shelf = school
    ? rows<ShelfBook>(await deps.session.from("books").select(BOOK_COLS).eq("school_id", school).neq("owner_id", me).order("created_at", { ascending: false }), "school shelf").filter(
        (b) => b.school_id === school && b.owner_id !== me,
      )
    : [];
  const seen = new Set<string>();
  const out: Array<ShelfBook & { where: "my_library" | "school_shelf" }> = [];
  for (const [list, where] of [[own, "my_library"], [shelf, "school_shelf"]] as const) {
    for (const b of list) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push({ ...b, where });
    }
  }
  return out;
}

/** The chapter's part count as the ledger trigger reads it (parts array length). */
export const chapterParts = (ch: ShelfChapter | undefined): number => (Array.isArray(ch?.parts) ? ch!.parts!.length : 0);
export const chapterTitleOf = (ch: ShelfChapter | undefined, num: number): string => (ch?.title && ch.title.trim()) || `Chapter ${num + 1}`;

type ExistingGen = { id: string; kind: string; status: string | null; chapter_ref: string | null; book_id: string | null; owner_id: string; params: Record<string, unknown> | null; withdrawn_at?: string | null };

export type KitPlan =
  | { kind: "no_book" }
  | { kind: "no_chapter" }
  | { kind: "not_ready"; book: ShelfBook }
  | { kind: "exists"; book: ShelfBook; chapterTitle: string; presentationId: string; status: string | null }
  | { kind: "ok"; book: ShelfBook; chapterTitle: string; rows: GenerationRow[]; credits: number; gated: boolean };

/**
 * What a chapter kit for (book, chapter num) would insert RIGHT NOW, as the
 * Library's chapter row builds it (chapter-generate.tsx kit mode): kitRows
 * with the book's language and the grade's narration default, the lesson
 * first, minus any legacy chapter-level document that already exists. A
 * presentation of hers for that chapter that is not an error (any part) =
 * she already has the kit.
 */
export async function planKit(ctx: SkContext, deps: SkCapabilityDeps, bookId: string, num: number): Promise<KitPlan> {
  const me = ctx.user.id;
  const book = (await shelfBooks(ctx, deps)).find((b) => b.id === bookId);
  if (!book) return { kind: "no_book" };
  const ch = (book.chapters ?? []).find((c) => c?.num === num);
  if (!ch) return { kind: "no_chapter" };
  if (book.status && book.status !== "ready") return { kind: "not_ready", book };
  const chapterTitle = chapterTitleOf(ch, num);
  const ref = String(num);
  const existing = rows<ExistingGen>(
    await deps.session.from("generations").select("id, kind, status, chapter_ref, book_id, owner_id, params, withdrawn_at").eq("owner_id", me).eq("book_id", bookId).eq("chapter_ref", ref),
    "generations",
  ).filter((g) => g.owner_id === me && g.book_id === bookId && g.chapter_ref === ref && !g.withdrawn_at);
  const pres = existing.filter((g) => g.kind === "presentation" && g.status !== "error");
  if (pres.length) {
    const best = pres.find((g) => g.status === "done") ?? pres[0];
    return { kind: "exists", book, chapterTitle, presentationId: best.id, status: best.status };
  }
  const isPartRow = (g: ExistingGen) => /^[0-9]{1,9}$/.test(String(g.params?.part ?? ""));
  const legacyDocs = new Set(existing.filter((g) => g.kind !== "presentation" && g.status !== "error" && !isPartRow(g)).map((g) => g.kind));
  const kit = kitRows({
    bookId,
    schoolId: ctx.user.schoolId,
    userId: me,
    chapterNum: num,
    language: book.language ?? null,
    narrationStyle: defaultNarrationForGrade(book.grade),
  }).filter((r) => r.kind === "presentation" || !legacyDocs.has(r.kind));
  return { kind: "ok", book, chapterTitle, rows: kit, credits: kitCredits(kit, chapterParts(ch)), gated: isGated(book.health) };
}

/** my_fair_use() → credits she can spend now; null = unmetered or unknown. */
export async function creditsLeft(deps: SkCapabilityDeps): Promise<number | null> {
  try {
    const r = (await deps.session.rpc("my_fair_use")) as { data?: unknown; error?: unknown } | null;
    if (!r || r.error || !r.data || typeof r.data !== "object") return null;
    return creditsLeftOf(r.data as FairUsePayload);
  } catch {
    return null;
  }
}

type Candidate = { book: ShelfBook & { where: "my_library" | "school_shelf" }; ch: ShelfChapter; num: number };

/** "chapter 3" / "bab 3" / "الفصل 3" → 3 (the number she SAYS, 1-based). */
export function spokenChapterNumber(text: string): number | null {
  const m = text.match(/(?:chapter|ch\.?|bab|unit|الفصل|فصل)\s*([0-9]{1,3})/iu) ?? text.match(/^\s*([0-9]{1,3})\s*$/);
  return m ? Number(m[1]) : null;
}

const which = (names: string[]) => `Which one: ${names.slice(0, -1).join("; ")} or ${names[names.length - 1]}?`;
const candLabel = (c: Candidate) => `${chapterTitleOf(c.ch, c.num)} (${c.book.title ?? "Untitled book"}, chapter ${c.num + 1})`;

export async function resolveLessonPrepare(ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const locale = ctx.user.locale;
  const bookId = argStr(args, "bookId");
  const bookQuery = cleanQuery(args.bookQuery);
  const chapterQuery = cleanQuery(args.chapterQuery);
  const rawNumber = args.chapterNumber;
  const said = typeof rawNumber === "number" ? rawNumber : typeof rawNumber === "string" ? spokenChapterNumber(rawNumber) : chapterQuery ? spokenChapterNumber(chapterQuery) : null;
  const chapterRef = argStr(args, "chapterRef");
  const forWhen = argStr(args, "forWhen", 40);
  if (!bookId && !bookQuery && !chapterQuery && said === null) return { ok: false, summary: "Which chapter should I prepare — and from which book?", error: "chapter required", facts: [] };

  try {
    const books = await shelfBooks(ctx, deps);
    let pool = books;
    if (bookId) pool = books.filter((b) => b.id === bookId);
    else if (bookQuery) pool = books.filter((b) => textMatches(bookQuery, [b.title, b.subject]));
    if (!pool.length) return { ok: false, summary: bookId ? "That book isn't on your shelf." : `I can't find a book called "${bookQuery}" on your shelf.`, error: "book_not_found", facts: [] };

    // Chapters: an exact 0-based ref (from a previous turn) wins, then the
    // number she said (1-based), then the title words.
    let cands: Candidate[] = [];
    for (const b of pool) {
      for (const ch of b.chapters ?? []) {
        if (typeof ch?.num !== "number") continue;
        if (/^[0-9]{1,4}$/.test(chapterRef)) {
          if (String(ch.num) === chapterRef) cands.push({ book: b, ch, num: ch.num });
        } else if (said !== null && (!chapterQuery || spokenChapterNumber(chapterQuery) !== null)) {
          if (ch.num === said - 1) cands.push({ book: b, ch, num: ch.num });
        } else if (chapterQuery) {
          if (textMatches(chapterQuery, [ch.title])) cands.push({ book: b, ch, num: ch.num });
        }
      }
    }
    if (!chapterRef && said === null && !chapterQuery) {
      // A book and no chapter: ask which chapter (one book), or which book.
      if (pool.length === 1) {
        const b = pool[0];
        const names = (b.chapters ?? []).slice(0, 8).map((c) => `${(c.num ?? 0) + 1}. ${c.title ?? ""}`.trim());
        return { ok: true, summary: `Which chapter of ${b.title ?? "that book"}? ${names.join("; ")}`.slice(0, 600), facts: (b.chapters ?? []).slice(0, 20).map((c) => ({ kind: "chapter", book_id: b.id, chapter_ref: String(c.num ?? ""), title: c.title ?? null })), entities: [{ kind: "book", id: b.id, label: b.title ?? "Book", via: "lesson.prepare" }] };
      }
      return { ok: true, summary: which(pool.slice(0, 6).map((b) => b.title ?? "Untitled book")), facts: pool.slice(0, 6).map((b) => ({ kind: "book", id: b.id, title: b.title, where: b.where })), entities: pool.slice(0, 6).map<ResolvedEntity>((b) => ({ kind: "book", id: b.id, label: b.title ?? "Book", via: "lesson.prepare" })) };
    }
    if (!cands.length) return { ok: false, summary: "I can't find that chapter on your shelf.", error: "chapter_not_found", facts: [] };
    if (cands.length > 1 && chapterQuery) {
      const exact = cands.filter((c) => normalizeName(c.ch.title ?? "") === normalizeName(chapterQuery));
      if (exact.length) cands = exact;
    }
    if (cands.length > 1) {
      const own = cands.filter((c) => c.book.where === "my_library");
      if (own.length === 1) cands = own;
    }
    if (cands.length > 1) {
      const opts = cands.slice(0, 6);
      return {
        ok: true,
        summary: which(opts.map(candLabel)),
        facts: opts.map((c) => ({ kind: "chapter", book_id: c.book.id, chapter_ref: String(c.num), title: chapterTitleOf(c.ch, c.num), book: c.book.title ?? null, where: c.book.where })),
        entities: opts.map<ResolvedEntity>((c) => ({ kind: "chapter", id: `${c.book.id}:${c.num}`, label: candLabel(c), via: "lesson.prepare", ids: [c.book.id] })),
      };
    }

    const pick = cands[0];
    const plan = await planKit(ctx, deps, pick.book.id, pick.num);
    if (plan.kind === "no_book" || plan.kind === "no_chapter") return { ok: false, summary: "I can't find that chapter on your shelf.", error: "chapter_not_found", facts: [] };
    if (plan.kind === "not_ready") return { ok: false, summary: `${plan.book.title ?? "That book"} isn't ready yet — it is still being read.`, error: "book_not_ready", facts: [] };
    const bookTitle = pick.book.title ?? "Book";
    if (plan.kind === "exists") {
      // Already hers: NO card. Offer to open it.
      return {
        ok: true,
        summary: lineFor(PREP_EXISTS, locale),
        facts: [{ kind: "kit", generation_id: plan.presentationId, book_id: pick.book.id, chapter_ref: String(pick.num), chapter: plan.chapterTitle, book: bookTitle, status: plan.status }],
        entities: [{ kind: "kit", id: plan.presentationId, label: `${plan.chapterTitle} (${bookTitle})`, via: "lesson.prepare", ids: [pick.book.id, String(pick.num)] }],
      };
    }

    const left = await creditsLeft(deps);
    const title = forWhen ? lineFor(PREP_CARD_TITLE_FOR, locale, { chapter: plan.chapterTitle, when: forWhen }) : lineFor(PREP_CARD_TITLE, locale, { chapter: plan.chapterTitle });
    const params: Record<string, string | number | boolean | null> = {
      book_id: pick.book.id,
      chapter_ref: String(pick.num),
      chapter_title: plan.chapterTitle,
      book_title: bookTitle,
      credits: plan.credits,
      ...(left !== null ? { credits_left: left } : {}),
      ...(plan.gated ? { warning: lineFor(PREP_GATE_WARNING, locale) } : {}),
      click_only: true,
    };
    return {
      ok: true,
      summary: `${title} — ${plan.credits} credits${left !== null ? ` (${left} left)` : ""}. It spends credits, so it needs a click on the card — a spoken yes won't do.`,
      facts: [{ kind: "lesson.prepare", book: bookTitle, chapter: plan.chapterTitle, chapter_number: pick.num + 1, credits: plan.credits, credits_left: left, for: forWhen || null }],
      entities: [
        { kind: "book", id: pick.book.id, label: bookTitle, via: "lesson.prepare" },
        { kind: "chapter", id: `${pick.book.id}:${pick.num}`, label: plan.chapterTitle, via: "lesson.prepare", ids: [pick.book.id] },
      ],
      confirm: { action: "lesson.prepare", title, params },
    };
  } catch (e) {
    return { ok: false, summary: "I could not read your shelf right now.", error: e instanceof Error ? e.message : String(e), facts: [] };
  }
}

export const lessonPrepareAction: SkCapability = {
  meta: {
    name: "lesson.prepare",
    description:
      "Prepare (generate) a full lesson kit for ONE chapter of a book on the teacher's shelf: the video lesson, slide deck and five documents. Spends credits, so it returns a card that must be CLICKED — a spoken yes never confirms it. Use for 'prepare Specialised Cells for Friday', 'make a kit for chapter 3 of Biology', 'sediakan kit untuk bab 3', 'جهّز حزمة للفصل 3'. chapterQuery = the chapter's title words; chapterNumber = the number she said (1-based, as printed); bookQuery = the book's title or subject when she names it; bookId/chapterRef (0-based) when already resolved this conversation. forWhen = the day she said ('Friday') — recorded in the title only, nothing is scheduled. If she already has that kit, it says so and offers to open it (no card). If more than one chapter or book matches, the result asks which — pass the answer back, never guess.",
    parameters: {
      type: "object",
      properties: {
        chapterQuery: { type: "string", description: "The chapter's title words, e.g. 'Specialised Cells'." },
        chapterNumber: { type: "number", description: "The chapter number she said (1-based)." },
        bookQuery: { type: "string", description: "The book's title or subject, e.g. 'Biology'." },
        bookId: { type: "string", description: "A book id already resolved this conversation." },
        chapterRef: { type: "string", description: "A chapter_ref (0-based) already resolved this conversation." },
        forWhen: { type: "string", description: "The day she said it is for, e.g. 'Friday' (title only)." },
      },
      additionalProperties: false,
    },
    tier: "confirm",
    kind: "act",
    roles: ["teacher"],
    hats: ["teacher"],
  },
  handler: resolveLessonPrepare,
};

// ── lesson.status ────────────────────────────────────────────────────────────

type StatusGen = { id: string; kind: string; status: string | null; title: string | null; chapter_ref: string | null; book_id: string | null; owner_id: string; params: Record<string, unknown> | null; created_at: string; sk_action_id?: string | null };
const STATUS_COLS = "id, kind, status, title, chapter_ref, book_id, owner_id, params, created_at";

/** Is this PostgREST error "column sk_action_id does not exist" (0169 not applied)? */
export const missingActionColumn = (e: unknown): boolean => {
  const x = (e ?? {}) as { code?: string; message?: string };
  return x.code === "42703" || x.code === "PGRST204" || /sk_action_id/.test(x.message ?? "");
};

export type KitStatus = {
  presentationId: string | null;
  bookId: string | null;
  chapterRef: string | null;
  title: string;
  total: number;
  done: number;
  failed: number;
  /** Rows still queued or processing. */
  inProgress: number;
  lesson: string | null;
  startedAt: string;
  viaSk: boolean;
};

/** The ONE kit-state rule (lesson.status, the Shell's job tray and the
 *  greeting's kit notices all read it): the lesson failing fails the kit;
 *  anything still queued/processing is "making" (nothing ready yet) or
 *  "partial" (n of m pieces ready); otherwise "ready" when something came out,
 *  else "failed". generations.status is queued | processing | done | error. */
export type KitState = "making" | "partial" | "ready" | "failed";
export function kitState(k: Pick<KitStatus, "done" | "inProgress" | "lesson">): KitState {
  if (k.lesson === "error") return "failed";
  if (k.inProgress > 0) return k.done > 0 ? "partial" : "making";
  return k.done > 0 ? "ready" : "failed";
}
export const kitFinished = (s: KitState): boolean => s === "ready" || s === "failed";

export type RecentKitsOptions = {
  /** Only kits started at or after this instant (ISO). */
  since?: string;
  /** SK-started kits ONLY: when 0169's column is missing, nothing (no fallback). */
  skOnly?: boolean;
};

/** Her recent kits, newest first: SK-started ones (sk_action_id) when 0169 is
 *  applied, else her newest generations. A kit = one (action | book, chapter, part). */
export async function recentKits(ctx: SkContext, deps: SkCapabilityDeps, limit = 3, opts: RecentKitsOptions = {}): Promise<KitStatus[]> {
  const me = ctx.user.id;
  const since = opts.since && Number.isFinite(Date.parse(opts.since)) ? opts.since : null;
  let viaSk = true;
  let q = deps.session.from("generations").select(`${STATUS_COLS}, sk_action_id`).eq("owner_id", me).not("sk_action_id", "is", null);
  if (since) q = q.gte("created_at", since);
  let res = (await q.order("created_at", { ascending: false }).limit(60)) as { data?: unknown; error?: unknown };
  let gens: StatusGen[];
  if (res?.error && missingActionColumn(res.error)) {
    if (opts.skOnly) return [];
    viaSk = false;
    let f = deps.session.from("generations").select(STATUS_COLS).eq("owner_id", me);
    if (since) f = f.gte("created_at", since);
    res = (await f.order("created_at", { ascending: false }).limit(60)) as { data?: unknown; error?: unknown };
  }
  gens = rows<StatusGen>(res, "generations").filter((g) => g.owner_id === me && (!viaSk || !!g.sk_action_id) && (!since || Date.parse(g.created_at) >= Date.parse(since)));
  gens = gens.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const groups = new Map<string, StatusGen[]>();
  for (const g of gens) {
    const key = viaSk && g.sk_action_id ? `a:${g.sk_action_id}` : `u:${g.book_id}|${g.chapter_ref}|${String(g.params?.part ?? "")}`;
    groups.set(key, [...(groups.get(key) ?? []), g]);
  }
  const bookIds = [...new Set(gens.map((g) => g.book_id).filter((b): b is string => !!b))];
  const books = bookIds.length ? rows<{ id: string; title: string | null; chapters: ShelfChapter[] | null }>(await deps.session.from("books").select("id, title, chapters").in("id", bookIds), "books") : [];
  const bookById = new Map(books.map((b) => [b.id, b]));
  const out: KitStatus[] = [];
  for (const list of groups.values()) {
    const pres = list.find((g) => g.kind === "presentation") ?? null;
    const head = pres ?? list[0];
    const n = head.chapter_ref != null && head.chapter_ref !== "" ? Number(head.chapter_ref) : NaN;
    const b = head.book_id ? bookById.get(head.book_id) : undefined;
    const ch = b && !Number.isNaN(n) ? (b.chapters ?? []).find((c) => c?.num === n) : undefined;
    out.push({
      presentationId: pres?.id ?? null,
      bookId: head.book_id,
      chapterRef: head.chapter_ref,
      title: head.title || (ch ? chapterTitleOf(ch, n) : Number.isNaN(n) ? head.kind : `Chapter ${n + 1}`),
      total: list.length,
      done: list.filter((g) => g.status === "done").length,
      failed: list.filter((g) => g.status === "error").length,
      inProgress: list.filter((g) => g.status === "queued" || g.status === "processing").length,
      lesson: pres?.status ?? null,
      startedAt: list.reduce((m, g) => (g.created_at < m ? g.created_at : m), head.created_at),
      viaSk,
    });
    if (out.length >= limit) break;
  }
  return out;
}

const statusWord = (s: string | null): string => (s === "done" ? "ready" : s === "error" ? "failed" : s === "processing" ? "being made" : s === "queued" ? "waiting to start" : s ?? "unknown");

export const lessonStatus: SkCapability = {
  meta: {
    name: "lesson.status",
    description:
      "How the teacher's recently started kits are going (the ones SK started, newest first): for each, the lesson's status and how many of its pieces are ready or failed. Use for 'how's the kit going', 'is my kit ready', 'macam mana kit saya', 'هل الحزمة جاهزة'. kitQuery narrows to a chapter title.",
    parameters: {
      type: "object",
      properties: { kitQuery: { type: "string", description: "Only kits whose chapter title matches." } },
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["teacher"],
    hats: ["teacher"],
  },
  async handler(ctx, args, deps) {
    try {
      const q = argStr(args, "kitQuery", 80);
      const kits = (await recentKits(ctx, deps, q ? 10 : 3)).filter((k) => !q || textMatches(q, [k.title])).slice(0, 3);
      if (!kits.length) return { ok: true, summary: "You have no kits being made right now.", facts: [{ kind: "lesson.status", kits: 0 }], entities: [] };
      const line = kits
        .map((k) => `${k.title}: the lesson is ${statusWord(k.lesson)}; ${k.done} of ${k.total} pieces ready${k.failed ? `, ${k.failed} failed` : ""}`)
        .join(". ");
      return {
        ok: true,
        summary: `${line}.`.slice(0, 600),
        facts: kits.map((k) => ({ kind: "kit", title: k.title, state: kitState(k), lesson: k.lesson, ready: k.done, total: k.total, failed: k.failed, started_at: k.startedAt, generation_id: k.presentationId, book_id: k.bookId, chapter_ref: k.chapterRef, started_by_sk: k.viaSk })),
        entities: kits.filter((k) => k.presentationId).map<ResolvedEntity>((k) => ({ kind: "kit", id: k.presentationId as string, label: k.title, via: "lesson.status", ids: [k.bookId ?? "", k.chapterRef ?? ""] })),
      };
    } catch (e) {
      return { ok: false, summary: "I could not read your kits right now.", error: e instanceof Error ? e.message : String(e), facts: [] };
    }
  },
};
