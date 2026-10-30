// `kit.documents` — SK lists and reads ANY document of a kit, any time
// (founder 2026-10-30: "i want SK to be able to go through any document at
// any time"): "walk me through this deck", "go through the worksheet",
// "what's in the quiz for chapter 2", "read me the answer key".
//
// WHICH KIT, in order:
//   1. `kit`              a generation id of hers (any piece of the kit);
//   2. `book` / `chapter` a book she can see (RLS) and its chapter (the
//                         Library's "Chapter N"). A SketchCast book reads the
//                         chapter's catalogue SOURCE pieces after her grant
//                         (has_book_grant as HER) — chapters she has not
//                         opened yet; an uploaded book reads her own kit of
//                         that chapter. No book named: the bar's book, else
//                         the open lesson's;
//   3. the Board's open unit (board.generationId);
//   4. the bar's ready-made kit (selection.generationId).
// The text itself comes from src/sk/kit-docs.ts (no .docx is parsed; a
// Word-only document offers the kit's article passages instead).
//
// Teachers (and the school roles that teach); never students — a student's
// lesson content runs through her own metered tutor turn — and the answer
// key, lesson plan and question bank are refused to a student even if a
// student context ever reached this handler.

import { createAdminClient } from "@/utils/supabase/admin";
import type { SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "@/sk/shell/types";
import { DOC_NAMES, docsOf, kitOfGeneration, productChapterKits, readDoc, type DocEntry, type DocsAdmin, type KitDocs, type ReadOut } from "@/sk/kit-docs";
import { searchForUser } from "./knowledge";

let adminOverride: (() => DocsAdmin | null) | null = null;
/** Tests: the fake service-role client (null = none configured). */
export function __setDocsAdminForTests(fn: (() => DocsAdmin | null) | null): void {
  adminOverride = fn;
}
function docsAdmin(): DocsAdmin | null {
  if (adminOverride) return adminOverride();
  try {
    return createAdminClient() as unknown as DocsAdmin;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fold = (v: string) =>
  v
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const str = (v: unknown, max = 120) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const intArg = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
};

/** Spoken document names → the documents tool's names. */
const DOC_WORDS: Array<[RegExp, string]> = [
  [/^(?:answer ?keys?|answers?|marking scheme|skema jawapan|jawapan)$/u, "answer_key"],
  [/^(?:decks?|slides?|slide deck|power ?points?|pptx|presentation|slaid)$/u, "deck"],
  [/^(?:scripts?|narration|transcript|video script)$/u, "script"],
  [/^(?:worksheets?|lembaran kerja)$/u, "worksheet"],
  [/^(?:quiz|quizzes|online quiz|kuiz)$/u, "quiz"],
  [/^(?:lesson ?plans?|rancangan pengajaran)$/u, "lesson_plan"],
  [/^(?:activit(?:y|ies))$/u, "activity"],
  [/^(?:case ?stud(?:y|ies))$/u, "case_study"],
  [/^(?:question ?banks?)$/u, "question_bank"],
  [/^(?:exam|exam papers?|test papers?)$/u, "exam_paper"],
];
export function docName(v: unknown): string | null {
  const f = fold(typeof v === "string" ? v : "").replace(/^the /, "");
  if (!f) return null;
  const direct = f.replace(/ /g, "_");
  if ((DOC_NAMES as readonly string[]).includes(direct)) return direct;
  for (const [re, name] of DOC_WORDS) if (re.test(f)) return name;
  return null;
}

const LABEL: Record<string, string> = {
  deck: "slide deck",
  script: "lesson script",
  worksheet: "worksheet",
  quiz: "quiz",
  question_bank: "question bank",
  exam_paper: "exam paper",
  answer_key: "answer key",
  lesson_plan: "lesson plan",
  activity: "activity",
  case_study: "case study",
};
const label = (e: Pick<DocEntry, "doc" | "of">) => (e.doc === "answer_key" && e.of ? `answer key (${LABEL[e.of] ?? e.of})` : LABEL[String(e.doc)] ?? String(e.doc));

type Target = { kind: "one"; kit: KitDocs } | { kind: "many"; book: string; chapter: number; kits: { lesson: string; label: string | null; docs: KitDocs }[] } | { kind: "refused"; result: SkCapabilityResult };

const refused = (summary: string, error: string): Target => ({ kind: "refused", result: { ok: false, summary, error, facts: [] } });

type BookRow = { id: string; title: string | null; sk_product_id?: string | null };

/** Books she can see (RLS), matched by title. */
async function bookByTitle(deps: SkCapabilityDeps, title: string): Promise<BookRow | "ask" | null> {
  const { data } = await deps.session.from("books").select("id, title, sk_product_id").is("removed_at", null);
  const books = (Array.isArray(data) ? data : []) as BookRow[];
  const q = fold(title);
  const exact = books.filter((b) => fold(b.title ?? "") === q);
  const pool = exact.length ? exact : books.filter((b) => {
    const t = fold(b.title ?? "");
    return t.length >= 3 && (t.includes(q) || q.includes(t));
  });
  if (pool.length > 1) return "ask";
  return pool[0] ?? null;
}

async function bookById(deps: SkCapabilityDeps, id: string): Promise<BookRow | null> {
  if (!UUID.test(id)) return null;
  const { data } = await deps.session.from("books").select("id, title, sk_product_id").eq("id", id).maybeSingle();
  return (data as BookRow | null) ?? null;
}

async function chapterTarget(ctx: SkContext, deps: SkCapabilityDeps, admin: DocsAdmin, book: BookRow, chapter: number): Promise<Target> {
  if (book.sk_product_id) {
    const r = await productChapterKits(admin, deps.session, book.id, chapter);
    if (!r.ok) {
      if (r.reason === "no_grant" || r.reason === "no_book") return refused("You don't have access to that book.", "no_grant");
      return refused(`Chapter ${chapter} of ${book.title ?? "that book"} has no lesson kit yet.`, "no_kit");
    }
    return { kind: "many", book: r.book, chapter: r.chapter, kits: r.kits };
  }
  // an uploaded book: her own kit of that chapter (chapter_ref is the 0-based num)
  const { data } = await admin
    .from("generations")
    .select("id")
    .eq("owner_id", ctx.user.id)
    .eq("book_id", book.id)
    .eq("chapter_ref", String(chapter - 1))
    .eq("kind", "presentation")
    .eq("status", "done")
    .is("withdrawn_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const id = ((data ?? []) as { id: string }[])[0]?.id;
  const kit = id ? await kitOfGeneration(admin, ctx.user.id, id) : null;
  return kit ? { kind: "one", kit } : refused(`Chapter ${chapter} of ${book.title ?? "that book"} has no lesson kit yet.`, "no_kit");
}

async function resolveTarget(ctx: SkContext, deps: SkCapabilityDeps, admin: DocsAdmin, args: Record<string, unknown>): Promise<Target> {
  const kitArg = str(args.kit, 60);
  if (kitArg) {
    const kit = UUID.test(kitArg) ? await kitOfGeneration(admin, ctx.user.id, kitArg) : null;
    return kit ? { kind: "one", kit } : refused("I can't open that kit.", "not_owner");
  }
  const openId = ctx.board?.sessionId && ctx.board.generationId ? ctx.board.generationId : ctx.selection?.generationId ?? null;
  const open = openId ? await kitOfGeneration(admin, ctx.user.id, openId) : null;

  const bookArg = str(args.book);
  const chapterArg = intArg(args.chapter);
  const selChapter = ctx.selection?.chapterRef !== undefined && /^\d{1,4}$/.test(String(ctx.selection.chapterRef)) ? Number(ctx.selection.chapterRef) + 1 : null;
  if (bookArg || chapterArg !== null || (!open && ctx.selection?.bookId && selChapter !== null)) {
    let book: BookRow | null = null;
    if (bookArg) {
      const hit = await bookByTitle(deps, bookArg);
      if (hit === "ask") return refused(`More than one of your books fits "${bookArg}". Which one?`, "ask_book");
      if (!hit) return refused(`You have no book called "${bookArg}" that I can read.`, "no_book");
      book = hit;
    } else if (ctx.selection?.bookId) book = await bookById(deps, ctx.selection.bookId);
    else if (open?.bookId) book = await bookById(deps, open.bookId);
    const chapter = chapterArg ?? selChapter;
    if (!book) return refused("Which book? Name it, or open it on the Board.", "ask_book");
    if (chapter === null || chapter < 1) return refused(`Which chapter of ${book.title ?? "the book"}?`, "ask_chapter");
    return chapterTarget(ctx, deps, admin, book, chapter);
  }
  if (open) return { kind: "one", kit: open };
  return refused("Which kit? Open it on the Board, or name the book and chapter.", "ask_kit");
}

// ── results ─────────────────────────────────────────────────────────────────

const MAX_ROWS = 40;

function listResult(t: Exclude<Target, { kind: "refused" }>, student: boolean): SkCapabilityResult {
  const groups = t.kind === "one" ? [{ lesson: null as string | null, label: t.kit.title, docs: t.kit }] : t.kits.map((k) => ({ lesson: k.lesson, label: k.label ?? k.docs.title, docs: k.docs }));
  const facts: NonNullable<SkCapabilityResult["facts"]> = [];
  for (const g of groups) {
    for (const e of docsOf(g.docs.pieces, { student })) {
      facts.push({ kit: g.label, doc: String(e.doc), name: label(e), readable: e.how !== "docx_only", teacher_only: e.teacherOnly, ...(e.of ? { of: e.of } : {}) });
    }
  }
  const where = t.kind === "one" ? `"${t.kit.title}"` : `${t.book} chapter ${t.chapter}`;
  const names = [...new Set(facts.map((f) => `${f.name}${f.readable ? "" : " (Word file only)"}`))].join(", ");
  return { ok: true, summary: facts.length ? `Documents of ${where}: ${names}. Ask for one by name to go through it.` : `I found no documents for ${where}.`, facts: facts.slice(0, MAX_ROWS) };
}

function readResult(r: Extract<ReadOut, { ok: true }>, where: string, slide: number | null): SkCapabilityResult {
  const facts: NonNullable<SkCapabilityResult["facts"]> = [];
  if (r.slides) {
    const list = slide ? r.slides.filter((x) => x.n === slide) : r.slides;
    for (const x of list) facts.push({ slide: x.n, title: x.title, text: x.text, notes: x.notes });
    if (slide && !list.length) return { ok: false, summary: `The deck has ${r.slides.length} slides.`, error: "no_such_slide", facts: [] };
    const span = facts.length > MAX_ROWS ? ` (slides 1–${MAX_ROWS} of ${r.slides.length}; ask for a slide by number)` : "";
    return { ok: true, summary: `${slide ? `Slide ${slide}` : `${r.slides.length} slides`} of the deck of ${where}, with the speaker notes${span}. Go through them in order, in your own words, from this text only.`, facts: facts.slice(0, MAX_ROWS) };
  }
  if (r.script) {
    const list = slide ? r.script.filter((x) => x.n === slide) : r.script;
    if (slide && !list.length) return { ok: false, summary: `The lesson has ${r.script.length} slides.`, error: "no_such_slide", facts: [] };
    for (const x of list) facts.push({ slide: x.n, ...(x.part > 1 ? { part: x.part } : {}), heading: x.heading, points: x.points.join(" | "), narration: x.narration });
    const what = r.doc === "deck" ? "slides (from the lesson script: the deck has one slide per script segment; its rendered text is not ready yet)" : "script segments";
    return { ok: true, summary: `${slide ? `Slide ${slide}` : `${r.script.length} ${what}`} of ${where}. Go through them in order, from this text only.`, facts: facts.slice(0, MAX_ROWS) };
  }
  const qs = r.questions ?? [];
  for (const q of qs) facts.push({ q: q.n, type: q.type, prompt: q.prompt, ...(q.options.length ? { options: q.options.join(" | ") } : {}), ...(q.answer !== undefined ? { answer: q.answer } : {}) });
  const key = r.from === "answer_key";
  return {
    ok: true,
    summary: `${qs.length} questions of the ${key ? "answer key" : LABEL[r.doc] ?? r.doc} of ${where}${key ? " (for the teacher; say an answer aloud only when she asks for it)" : " (no answers)"}. Quote them exactly.`,
    facts: facts.slice(0, MAX_ROWS),
  };
}

/** A Word-only document: say so, and offer the kit's article passages instead. */
async function docxFallback(ctx: SkContext, deps: SkCapabilityDeps, kit: KitDocs, doc: string): Promise<SkCapabilityResult> {
  const name = LABEL[doc] ?? doc;
  const base = `The ${name} of "${kit.title}" is a Word file only; I can't read its text here (it is in the rail to download).`;
  if (!kit.articleId) return { ok: false, summary: base, error: "docx_only", facts: [] };
  try {
    const r = await searchForUser(ctx, deps, { query: kit.title || name, restrict: [{ kind: "article", id: kit.articleId, language: null, title: "" }], limit: 4 });
    if (r.status !== "ok" || !r.passages.length) return { ok: false, summary: base, error: "docx_only", facts: [] };
    return {
      ok: true,
      summary: `${base} The kit's article covers the same lesson: its passages are below.`,
      facts: r.passages.map((p) => ({ source_title: p.source_title, section: p.section, passage: p.text })),
    };
  } catch {
    return { ok: false, summary: base, error: "docx_only", facts: [] };
  }
}

const NOT_READ: Record<Exclude<ReadOut, { ok: true }>["reason"], (name: string, where: string) => string> = {
  teacher_only: (name) => `The ${name} is for teachers only.`,
  not_in_kit: (name, where) => `${where} has no ${name}.`,
  docx_only: (name) => `The ${name} is a Word file only; I can't read its text here.`,
  unreadable: (name) => `I couldn't read the ${name} right now.`,
};

export const kitDocuments: SkCapability = {
  meta: {
    name: "kit.documents",
    description:
      "List or read the documents of a lesson kit: the slide deck (each slide's text and speaker notes), the lesson script, the worksheet, the quiz, the question bank, the answer key (teacher only), the lesson plan. Works on the kit open on the Board, the kit picked in the bar, or any chapter of a book she has (book + chapter), including SketchCast book chapters she has not opened. Use for 'walk me through this deck', 'go through the worksheet', 'what's in the quiz for chapter 2', 'read slide 3's notes'. action=list to see what the kit has; action=read with doc to read one.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read"], description: "list (default when no doc is named) or read." },
        doc: { type: "string", description: "The document to read: deck | script | worksheet | quiz | question_bank | exam_paper | answer_key | lesson_plan | activity | case_study." },
        of: { type: "string", description: "answer_key only: which document it answers (worksheet | quiz). Default: the first one the kit has." },
        slide: { type: "integer", minimum: 1, description: "deck/script only: one slide (1-based, as she says it)." },
        book: { type: "string", description: "A book title, for a chapter that is not the open kit." },
        chapter: { type: "integer", minimum: 1, description: "The chapter number as the book shows it (Chapter 2 = 2)." },
        kit: { type: "string", description: "A kit's generation id, when known (from an earlier result)." },
      },
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["teacher", "school_admin", "coordinator"],
    flags: ["sk"],
  },
  async handler(ctx, args, deps) {
    const student = ctx.user.role === "student";
    const a = args ?? {};
    const doc = docName(a.doc);
    if (a.doc !== undefined && a.doc !== null && a.doc !== "" && !doc) return { ok: false, summary: `I don't know a document called "${str(a.doc, 40)}". Ask me to list the kit's documents.`, error: "bad_doc", facts: [] };
    if (student && doc && ["answer_key", "lesson_plan", "question_bank"].includes(doc)) return { ok: false, summary: NOT_READ.teacher_only(LABEL[doc] ?? doc, ""), error: "teacher_only", facts: [] };
    const admin = docsAdmin();
    if (!admin) return { ok: false, summary: "I can't open the kit's documents right now.", error: "no_admin", facts: [] };
    try {
      const t = await resolveTarget(ctx, deps, admin, a);
      if (t.kind === "refused") return t.result;
      const action = a.action === "list" || !doc ? "list" : "read";
      if (action === "list") return listResult(t, student);
      const slide = intArg(a.slide);
      const of = docName(a.of);
      const candidates = t.kind === "one" ? [{ docs: t.kit, where: `"${t.kit.title}"` }] : t.kits.map((k) => ({ docs: k.docs, where: `"${k.label ?? k.docs.title}" (${t.book} chapter ${t.chapter})` }));
      let last: Exclude<ReadOut, { ok: true }> | null = null;
      for (const c of candidates) {
        const r = await readDoc(admin, c.docs, doc!, { student, of });
        if (r.ok) return readResult(r, c.where, slide !== null && slide >= 1 ? slide : null);
        if (r.reason === "docx_only") return docxFallback(ctx, deps, c.docs, doc!);
        last = r;
      }
      const where = t.kind === "one" ? `"${t.kit.title}"` : `${t.book} chapter ${t.chapter}`;
      const reason = last?.reason ?? "not_in_kit";
      return { ok: false, summary: NOT_READ[reason](LABEL[doc!] ?? doc!, where), error: reason, facts: [] };
    } catch (e) {
      return { ok: false, summary: "I couldn't open the kit's documents right now.", error: e instanceof Error ? e.message : String(e), facts: [] };
    }
  },
};

// ── the Board's open unit, before (or without) its lesson map ───────────────

export type UnitSlide = { n: number; title: string; text: string; notes: string };

/** The open unit's deck as text — the deck's own text map, else the lesson
 *  script's slides — for board.explain / board.load_deck when the lesson map
 *  is not ready (2026-10-31). Hers only (kitOfGeneration's owner filter). */
export async function openUnitSlides(ctx: SkContext): Promise<{ title: string; from: "deck_text_map" | "lesson_script"; slides: UnitSlide[] } | null> {
  const gid = ctx.board?.sessionId ? ctx.board.generationId : undefined;
  if (!gid || !UUID.test(gid)) return null;
  const admin = docsAdmin();
  if (!admin) return null;
  try {
    const kit = await kitOfGeneration(admin, ctx.user.id, gid);
    if (!kit) return null;
    const r = await readDoc(admin, kit, "deck", { student: ctx.user.role === "student" });
    if (!r.ok) return null;
    if (r.slides?.length) return { title: r.title ?? kit.title, from: "deck_text_map", slides: r.slides };
    if (r.script?.length) return { title: r.title ?? kit.title, from: "lesson_script", slides: r.script.map((x) => ({ n: x.n, title: x.heading, text: x.points.join(" | "), notes: x.narration })) };
    return null;
  } catch {
    return null;
  }
}
