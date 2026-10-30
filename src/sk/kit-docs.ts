// A kit's DOCUMENTS as text SK can read — any of them, any time (founder
// 2026-10-30: "i want SK to be able to go through any document at any time").
//
// A kit is several generations ("pieces"): the lesson (presentation: video +
// script), the deck (its own generation since 0103: .pptx, rendered pages and
// their text map), and the documents (worksheet, quiz, lesson plan, activity,
// case study, question bank). Where the pieces are found:
//   her copy of a catalogue kit   her generations with the same
//                                 params.catalogue_ref.topic_kit_id (the adopt
//                                 functions stamp it on every piece);
//   her book kit                  her generations of the same book, chapter
//                                 and part;
//   her own ready-made kit        her book-less generations with the same
//                                 title prefix (utils/present/kit.ts kitPrefix);
//   a SketchCast book chapter     the catalogue SOURCE pieces of the chapter's
//   she has not opened            kits (sk_product_kits → topic_kits), read with
//                                 the service role ONLY after has_book_grant
//                                 answered yes AS HER (0175's rule, as
//                                 utils/present/adopt.ts asks it).
//
// What reads as text, and from where (no .docx is parsed: the app has no docx
// text helper, and none is added — a document that exists only as .docx is
// listed as "docx only", and the capability offers the kit's article instead):
//   deck        the deck's text map (deck_pages_json / pages.json: per slide
//               title, text and speaker notes); before the deck is rendered,
//               the LESSON's own slides from its script (the video's slides:
//               heading and points per script segment). Not the .pptx's pages:
//               the deck does not have one page per segment (docs/SK-M1-REPORT.md
//               §6), so they are labelled as the lesson's slides, not the deck's
//   script      script_json (+ script_partN.json): per segment heading, points, narration
//   worksheet / quiz / question_bank / exam_paper
//               questions_json: prompts and options — NEVER the answers
//   answer_key  the same questions WITH their answers — teachers only
//
// TEACHER-ONLY: the answer key, the lesson plan and the question bank (the
// Library's and assignablePieces' rule). A student is refused them here even
// though the capability is not given to students at all.
//
// Admin client only, and only after the caller proved the pieces are hers (or
// the grant): nothing here decides access on its own except the owner filter.

import { kitPrefix } from "@/utils/present/kit";
import { mapPathOf, slideFiles, type ArtifactRow } from "@/utils/present/deck-pages";
import { parseDeckMap } from "@/app/present/deck-text";
import { piecesOf, type TopicKitRow } from "@/app/dashboard/kits/logic";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type DocsAdmin = {
  from: (table: string) => any;
  storage: { from: (bucket: string) => { download: (path: string) => Promise<{ data: { text: () => Promise<string> } | null; error: unknown }> } };
};
export type DocsSession = { rpc: (fn: string, args?: Record<string, unknown>) => any; from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

const BUCKET = "artifacts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Piece = {
  id: string;
  kind: string;
  title: string | null;
  owner_id: string;
  params: Record<string, unknown>;
  created_at: string;
  artifacts: ArtifactRow[];
};

export type DocName = "deck" | "script" | "worksheet" | "quiz" | "question_bank" | "exam_paper" | "answer_key" | "lesson_plan" | "activity" | "case_study";
export const DOC_NAMES: readonly DocName[] = ["deck", "script", "worksheet", "quiz", "question_bank", "exam_paper", "answer_key", "lesson_plan", "activity", "case_study"];
export const TEACHER_ONLY: ReadonlySet<string> = new Set(["answer_key", "lesson_plan", "question_bank"]);
const QUESTION_KINDS = new Set(["worksheet", "quiz", "question_bank", "exam_paper"]);

export type DocEntry = {
  doc: DocName | string;
  generationId: string;
  title: string | null;
  /** "slides" | "script" | "questions" | "answers" read as text; "docx_only" does not. */
  how: "slides" | "script" | "questions" | "answers" | "docx_only";
  teacherOnly: boolean;
  /** answer_key: which question document it answers. */
  of?: string;
  /** The kit (lesson) it belongs to, when several kits are listed together. */
  lesson?: string | null;
};

export type KitDocs = {
  title: string;
  pieces: Piece[];
  articleId: string | null;
  source: "mine" | "book_source";
  /** The book it belongs to: her book kit's own, or the SketchCast book a copy came through (params.product_ref). */
  bookId?: string | null;
};

const has = (p: Piece, kind: string) => p.artifacts.some((a) => a.kind === kind);

/** The documents of a set of pieces, for this role (students never see a teacher-only one). */
export function docsOf(pieces: Piece[], opts: { student: boolean; lesson?: string | null } = { student: false }): DocEntry[] {
  const out: DocEntry[] = [];
  const add = (e: Omit<DocEntry, "teacherOnly">) => {
    const teacherOnly = TEACHER_ONLY.has(String(e.doc));
    if (teacherOnly && opts.student) return;
    out.push({ ...e, teacherOnly, ...(opts.lesson !== undefined ? { lesson: opts.lesson } : {}) });
  };
  for (const p of pieces) {
    if (p.kind === "presentation") {
      if (has(p, "script_json")) add({ doc: "script", generationId: p.id, title: p.title, how: "script" });
      continue;
    }
    if (p.kind === "deck") {
      add({ doc: "deck", generationId: p.id, title: p.title, how: "slides" });
      continue;
    }
    if (QUESTION_KINDS.has(p.kind) && has(p, "questions_json")) {
      add({ doc: p.kind, generationId: p.id, title: p.title, how: "questions" });
      add({ doc: "answer_key", generationId: p.id, title: p.title, how: "answers", of: p.kind });
      continue;
    }
    if (has(p, "docx") || has(p, "answer_key_docx")) add({ doc: p.kind, generationId: p.id, title: p.title, how: "docx_only" });
  }
  // A deck-less kit (or one whose deck piece is not there) still has slides: the script's.
  if (!out.some((e) => e.doc === "deck")) {
    const lesson = pieces.find((p) => p.kind === "presentation" && has(p, "script_json"));
    if (lesson) add({ doc: "deck", generationId: lesson.id, title: lesson.title, how: "script" });
  }
  return out;
}

/** The newest piece per kind (a re-made worksheet replaces the old one), lesson first. */
function newestPerKind(pieces: Piece[]): Piece[] {
  const by = new Map<string, Piece>();
  for (const p of pieces.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) if (!by.has(p.kind)) by.set(p.kind, p);
  const rank = (k: string) => (k === "presentation" ? 0 : k === "deck" ? 1 : 2);
  return [...by.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind));
}

const GEN_COLS = "id, kind, title, owner_id, book_id, chapter_ref, params, status, withdrawn_at, removed_at, created_at";
type GenRow = { id: string; kind: string; title: string | null; owner_id: string; book_id: string | null; chapter_ref: string | null; params: Record<string, unknown> | null; status: string; withdrawn_at: string | null; created_at: string; removed_at?: string | null };

async function withArtifacts(admin: DocsAdmin, gens: GenRow[]): Promise<Piece[]> {
  const live = gens.filter((g) => g.status === "done" && !g.withdrawn_at && !g.removed_at);
  if (!live.length) return [];
  const { data } = await admin.from("artifacts").select("generation_id, kind, storage_path").in("generation_id", live.map((g) => g.id));
  const rows = (Array.isArray(data) ? data : []) as (ArtifactRow & { generation_id: string })[];
  return live.map((g) => ({
    id: String(g.id),
    kind: String(g.kind),
    title: g.title ?? null,
    owner_id: String(g.owner_id),
    params: (g.params ?? {}) as Record<string, unknown>,
    created_at: String(g.created_at ?? ""),
    artifacts: rows.filter((r) => r.generation_id === g.id).map((r) => ({ kind: String(r.kind), storage_path: String(r.storage_path) })),
  }));
}

const catalogueKitOf = (params: Record<string, unknown> | null): string | null => {
  const id = (params?.catalogue_ref as { topic_kit_id?: unknown } | undefined)?.topic_kit_id;
  return typeof id === "string" && UUID.test(id) ? id : null;
};
const partOfParams = (params: Record<string, unknown> | null): number | null => (typeof params?.part === "number" ? params.part : null);

/** The kit a generation of HERS belongs to — every sibling piece she holds. Null when it is not hers. */
export async function kitOfGeneration(admin: DocsAdmin, userId: string, generationId: string): Promise<KitDocs | null> {
  if (!UUID.test(generationId)) return null;
  const { data: g } = await admin.from("generations").select(GEN_COLS).eq("id", generationId).eq("owner_id", userId).maybeSingle();
  const gen = g as GenRow | null;
  if (!gen || gen.owner_id !== userId) return null;
  const params = (gen.params ?? {}) as Record<string, unknown>;
  const topicKit = catalogueKitOf(params);
  let rows: GenRow[];
  if (topicKit) {
    const { data } = await admin.from("generations").select(GEN_COLS).eq("owner_id", userId).eq("params->catalogue_ref->>topic_kit_id", topicKit).is("withdrawn_at", null);
    rows = (data ?? []) as GenRow[];
  } else if (gen.book_id && gen.chapter_ref !== null && gen.chapter_ref !== undefined) {
    const { data } = await admin.from("generations").select(GEN_COLS).eq("owner_id", userId).eq("book_id", gen.book_id).eq("chapter_ref", String(gen.chapter_ref)).is("withdrawn_at", null);
    const part = partOfParams(params);
    rows = ((data ?? []) as GenRow[]).filter((r) => partOfParams(r.params) === part && r.params?.revision !== true);
  } else {
    const prefix = kitPrefix(gen.title);
    const { data } = await admin.from("generations").select(GEN_COLS).eq("owner_id", userId).is("book_id", null).is("withdrawn_at", null).order("created_at", { ascending: false }).limit(200);
    rows = prefix ? ((data ?? []) as GenRow[]).filter((r) => kitPrefix(r.title) === prefix && !catalogueKitOf(r.params)) : [gen];
  }
  if (!rows.some((r) => r.id === gen.id)) rows.push(gen);
  const pieces = newestPerKind(await withArtifacts(admin, rows));
  const ref = params.catalogue_ref as { article_id?: unknown } | undefined;
  const articleId = typeof params.article_id === "string" ? params.article_id : typeof ref?.article_id === "string" ? ref.article_id : null;
  const productBook = (params.product_ref as { book_id?: unknown } | undefined)?.book_id;
  const bookId = gen.book_id ?? (typeof productBook === "string" && UUID.test(productBook) ? productBook : null);
  return { title: kitPrefix(gen.title) || gen.title || "", pieces, articleId, source: "mine", bookId };
}

export type BookChapterKits = { ok: true; book: string; chapter: number; kits: { lesson: string; label: string | null; docs: KitDocs }[] } | { ok: false; reason: "no_book" | "no_grant" | "no_kit" };

/**
 * A SketchCast book's chapter (the RELEASE chapter, 1-based — the Library's
 * "Chapter N") read from the catalogue SOURCE pieces, after her grant: what
 * she can go through before she ever opens it on the Board. `session` asks
 * has_book_grant as HER; `admin` reads only after it said yes.
 */
export async function productChapterKits(admin: DocsAdmin, session: DocsSession, bookId: string, chapter: number): Promise<BookChapterKits> {
  if (!UUID.test(bookId) || !Number.isInteger(chapter) || chapter < 1) return { ok: false, reason: "no_book" };
  const { data: b } = await admin.from("books").select("id, title, sk_product_id, removed_at").eq("id", bookId).maybeSingle();
  const book = b as { id: string; title: string | null; sk_product_id: string | null; removed_at: string | null } | null;
  if (!book || !book.sk_product_id || book.removed_at) return { ok: false, reason: "no_book" };
  const { data: granted, error } = await session.rpc("has_book_grant", { p_product: book.sk_product_id });
  if (error || granted !== true) return { ok: false, reason: "no_grant" };
  const { data: map } = await admin.from("sk_product_kits").select("generation_id, label, sort").eq("product_id", book.sk_product_id).eq("chapter_ref", String(chapter));
  const lessons = ((map ?? []) as { generation_id: string; label: string | null; sort: number | null }[]).sort((x, y) => Number(x.sort ?? 0) - Number(y.sort ?? 0));
  if (!lessons.length) return { ok: false, reason: "no_kit" };
  const { data: kits } = await admin
    .from("topic_kits")
    .select("id, presentation_generation_id, doc_generation_ids, status, article_id")
    .in("presentation_generation_id", lessons.map((l) => l.generation_id))
    .eq("status", "approved");
  const kitRows = (kits ?? []) as (TopicKitRow & { article_id?: string | null })[];
  const out: { lesson: string; label: string | null; docs: KitDocs }[] = [];
  for (const l of lessons) {
    const kit = kitRows.find((k) => k.presentation_generation_id === l.generation_id);
    if (!kit || out.some((o) => o.lesson === l.generation_id)) continue;
    const ids = piecesOf(kit).map((p) => p.generationId);
    const { data: gens } = await admin.from("generations").select(GEN_COLS).in("id", ids);
    const pieces = newestPerKind(await withArtifacts(admin, (gens ?? []) as GenRow[]));
    const lessonRow = pieces.find((p) => p.id === l.generation_id);
    out.push({ lesson: l.generation_id, label: l.label, docs: { title: l.label || kitPrefix(lessonRow?.title) || "", pieces, articleId: kit.article_id ?? null, source: "book_source" } });
  }
  if (!out.length) return { ok: false, reason: "no_kit" };
  return { ok: true, book: book.title ?? "", chapter, kits: out };
}

// ── reading one document ────────────────────────────────────────────────────

async function downloadJson(admin: DocsAdmin, path: string): Promise<unknown> {
  try {
    const dl = await admin.storage.from(BUCKET).download(path);
    if (dl.error || !dl.data) return null;
    return JSON.parse(await dl.data.text());
  } catch {
    return null;
  }
}

export type SlideText = { n: number; title: string; text: string; notes: string };
export type ScriptSlide = { n: number; part: number; heading: string; points: string[]; narration: string };
export type QuestionText = { n: number; id: string; type: string; prompt: string; options: string[]; answer?: string };

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const pointText = (p: unknown): string => (typeof p === "string" ? p : p && typeof p === "object" && "text" in p ? s((p as { text: unknown }).text) : "");

const SCRIPT_RE = /\/script(?:_part(\d+))?\.json$/;

/** The lesson's own slides from its script (one per script segment — the
 *  video's slides, NOT the .pptx's pages), in part order. */
export async function scriptSlides(admin: DocsAdmin, lesson: Piece): Promise<ScriptSlide[]> {
  const rows = lesson.artifacts
    .filter((a) => a.kind === "script_json" && SCRIPT_RE.test(a.storage_path))
    .map((a) => ({ a, part: Number(SCRIPT_RE.exec(a.storage_path)?.[1] ?? 1) }))
    .sort((x, y) => x.part - y.part);
  const files = await Promise.all(rows.map((r) => downloadJson(admin, r.a.storage_path)));
  const out: ScriptSlide[] = [];
  files.forEach((f, i) => {
    const segs = (f as { script?: { segments?: unknown } } | null)?.script?.segments;
    if (!Array.isArray(segs)) return;
    for (const seg of segs as Record<string, unknown>[]) {
      out.push({ n: out.length + 1, part: rows[i].part, heading: s(seg.slide_heading), points: Array.isArray(seg.slide_points) ? (seg.slide_points as unknown[]).map(pointText).filter(Boolean) : [], narration: s(seg.text) });
    }
  });
  return out;
}

/** The deck's own text map, slide by slide; null when it is not there (not rendered yet). */
export async function deckSlides(admin: DocsAdmin, deck: Piece): Promise<SlideText[] | null> {
  const where = mapPathOf(deck.artifacts, slideFiles(deck.artifacts), { id: deck.id, owner_id: deck.owner_id });
  const map = parseDeckMap(await downloadJson(admin, where.path));
  if (!map || !map.slides.length) return null;
  return map.slides.map((x) => ({ n: x.n, title: x.title.trim(), text: x.text.trim(), notes: x.notes.trim() }));
}

/** A questions.json as text. Answers only when `withAnswers` (the teacher's answer key). */
export async function questionsOf(admin: DocsAdmin, piece: Piece, withAnswers: boolean): Promise<QuestionText[] | null> {
  const row = piece.artifacts.find((a) => a.kind === "questions_json");
  if (!row) return null;
  const raw = await downloadJson(admin, row.storage_path);
  const qs = raw && typeof raw === "object" && Array.isArray((raw as { questions?: unknown }).questions) ? ((raw as { questions: Record<string, unknown>[] }).questions) : null;
  if (!qs) return null;
  return qs
    .filter((q) => q && typeof q === "object" && s(q.prompt).trim())
    .map((q, i) => {
      const pairs = Array.isArray(q.pairs) ? (q.pairs as Record<string, unknown>[]) : [];
      // a matching item without its key: the two columns, the right one sorted (its order IS the answer)
      const options = Array.isArray(q.options)
        ? (q.options as unknown[]).map(s)
        : pairs.length
          ? [...pairs.map((p) => s(p.left ?? p.a)), ...pairs.map((p) => s(p.right ?? p.b)).sort((a, b) => a.localeCompare(b))]
          : [];
      const out: QuestionText = { n: i + 1, id: s(q.id) || `q${i + 1}`, type: s(q.type) || "question", prompt: s(q.prompt).trim(), options };
      if (withAnswers) {
        const a = pairs.length
          ? pairs.map((p) => `${s(p.left ?? p.a)} → ${s(p.right ?? p.b)}`).join("; ")
          : typeof q.answer === "boolean"
            ? String(q.answer)
            : Array.isArray(q.answer)
              ? (q.answer as unknown[]).map(s).join(", ")
              : s(q.answer) || s(q.answer_outline);
        out.answer = a;
      }
      return out;
    });
}

export type ReadOut =
  | { ok: true; doc: string; title: string | null; from: "deck_text_map" | "lesson_script" | "questions" | "answer_key"; slides?: SlideText[]; script?: ScriptSlide[]; questions?: QuestionText[] }
  | { ok: false; reason: "teacher_only" | "not_in_kit" | "docx_only" | "unreadable"; doc: string };

/** Read one document of a kit. `student` refuses every teacher-only document. */
export async function readDoc(admin: DocsAdmin, kit: KitDocs, doc: string, opts: { student: boolean; of?: string | null }): Promise<ReadOut> {
  if (opts.student && TEACHER_ONLY.has(doc)) return { ok: false, reason: "teacher_only", doc };
  const entries = docsOf(kit.pieces, { student: opts.student });
  const lesson = kit.pieces.find((p) => p.kind === "presentation");
  if (doc === "deck") {
    const deck = kit.pieces.find((p) => p.kind === "deck");
    const slides = deck ? await deckSlides(admin, deck) : null;
    if (slides) return { ok: true, doc, title: deck!.title, from: "deck_text_map", slides };
    // not rendered yet (or no deck piece): the lesson's own slides, labelled as such
    if (lesson) {
      const script = await scriptSlides(admin, lesson);
      if (script.length) return { ok: true, doc, title: deck?.title ?? lesson.title, from: "lesson_script", script };
    }
    return { ok: false, reason: deck ? "unreadable" : "not_in_kit", doc };
  }
  if (doc === "script") {
    if (!lesson) return { ok: false, reason: "not_in_kit", doc };
    const script = await scriptSlides(admin, lesson);
    return script.length ? { ok: true, doc, title: lesson.title, from: "lesson_script", script } : { ok: false, reason: "unreadable", doc };
  }
  if (doc === "answer_key") {
    const of = opts.of && QUESTION_KINDS.has(opts.of) ? opts.of : null;
    const key = entries.find((e) => e.doc === "answer_key" && (!of || e.of === of)) ?? null;
    const piece = key ? kit.pieces.find((p) => p.id === key.generationId) : undefined;
    if (!piece) return { ok: false, reason: "not_in_kit", doc };
    const questions = await questionsOf(admin, piece, true);
    return questions ? { ok: true, doc, title: piece.title, from: "answer_key", questions } : { ok: false, reason: "unreadable", doc };
  }
  const entry = entries.find((e) => e.doc === doc);
  if (!entry) return { ok: false, reason: "not_in_kit", doc };
  if (entry.how === "docx_only") return { ok: false, reason: "docx_only", doc };
  const piece = kit.pieces.find((p) => p.id === entry.generationId)!;
  const questions = await questionsOf(admin, piece, false);
  return questions ? { ok: true, doc, title: piece.title, from: "questions", questions } : { ok: false, reason: "unreadable", doc };
}
