// SketchCast books as Library books (migration 0175) — a bought book's
// CHAPTERS, the way an uploaded book lists them: every chapter of the
// product's system book with its final title, and that chapter's ONE kit of
// master artifacts (or none yet: "Lesson kit coming soon").
//
// The master kits belong to the catalogue system account; no session may read
// or sign them (0175 adds no generations policy, the storage policy is the
// owner's prefix). So — the catalogue's pattern, /api/catalogue/file — the
// SERVER reads them with the service role and signs the files, and only for
// books decideMyBooks() already granted the reader. Nothing here decides
// access; the callers run it after the decision.
//
// A teacher who ASSIGNS a chapter (or puts it on the Board) gets their own
// copies through adopt_product_kit() — the master ids the card carries are
// what it adopts; the database checks the grant again.
//
// Pure apart from the injected db/sign: rows in, chapters out.

import { STUDENT_KINDS, DOC_KINDS } from "@/app/dashboard/kit";
import { docDownloadName } from "@/utils/download-name";
import { sortVideoArtifacts } from "@/utils/catalogue/kit";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ProductBookDb = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ProductSystemBook = {
  id: string;
  owner_id: string;
  sk_product_id: string;
  title: string;
  chapters: { num: number; title?: string | null }[] | null;
};

export type MasterArtifact = { kind: string; storage_path: string };
export type MasterKitRow = {
  id: string;
  kind: string;
  title: string | null;
  chapter_ref: string | null;
  status: string;
  owner_id: string;
  book_id: string;
  params: Record<string, unknown> | null;
  created_at: string;
  removed_at?: string | null;
  withdrawn_at?: string | null;
  artifacts: MasterArtifact[] | null;
};

/** A piece's files, labelled by what the chip says ("Watch", "Deck", "Download", "Answer key"). */
export type ChapterFile = { label: "watch" | "deck" | "download" | "answerKey"; part: number | null; url: string };
export type ChapterPiece = { generationId: string; kind: string; files: ChapterFile[] };
export type ProductChapter = {
  /** books.chapters num (0-based) */
  num: number;
  /** the release chapter (num + 1): /sk/<slug>/<chapter> and sk_product_kits.chapter_ref */
  chapter: number;
  title: string;
  /** the chapter's kit, lesson first; [] = no kit yet */
  pieces: ChapterPiece[];
  /** master ids a student may receive (STUDENT_KINDS, done) — adopted on Assign */
  assignSources: string[];
  /** every master id of the kit — adopted on the Board */
  boardSources: string[];
  skHref: string | null;
};

const ORDER: readonly string[] = ["presentation", ...DOC_KINDS];
const rank = (k: string) => (ORDER.indexOf(k) === -1 ? ORDER.length : ORDER.indexOf(k));
const hasPart = (g: MasterKitRow) => g.params != null && g.params.part != null && String(g.params.part) !== "";

/**
 * The chapter's ONE kit: the newest done, live, whole-chapter generation of
 * each kind, owned by the book's own (system) owner. A row owned by anyone
 * else that happens to point at the product book is never a master.
 */
export function chapterKit(book: Pick<ProductSystemBook, "id" | "owner_id">, masters: MasterKitRow[], num: number): MasterKitRow[] {
  const byKind = new Map<string, MasterKitRow>();
  const live = masters
    .filter((g) => g.book_id === book.id && g.owner_id === book.owner_id && g.chapter_ref === String(num))
    .filter((g) => g.status === "done" && !g.removed_at && !g.withdrawn_at && !hasPart(g))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  for (const g of live) if (!byKind.has(g.kind)) byKind.set(g.kind, g);
  // a kit without its lesson is not a kit yet
  if (!byKind.has("presentation")) return [];
  return [...byKind.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
}

export type ChapterDeps = {
  /** Signs one artifacts-bucket path (service role); null when it cannot. */
  sign: (path: string, download?: string) => Promise<string | null>;
  /** "Open in SK" for a chapter, or null when the reader may not. */
  skHref: (chapter: number) => string | null;
};

async function filesOf(g: MasterKitRow, deps: ChapterDeps): Promise<ChapterFile[]> {
  const arts = g.artifacts ?? [];
  const out: ChapterFile[] = [];
  const many = async (kind: string, label: ChapterFile["label"]) => {
    const list = sortVideoArtifacts(arts.filter((a) => a.kind === kind));
    const urls = await Promise.all(list.map((a) => deps.sign(a.storage_path, docDownloadName(g.kind, kind))));
    urls.forEach((url, i) => url && out.push({ label, part: list.length > 1 ? i + 1 : null, url }));
  };
  const one = async (kind: string, label: ChapterFile["label"]) => {
    const a = arts.find((x) => x.kind === kind);
    if (!a) return;
    const url = await deps.sign(a.storage_path, docDownloadName(g.kind, kind));
    if (url) out.push({ label, part: null, url });
  };
  await many("video_mp4", "watch");
  await many("deck_pptx", "deck");
  await one("docx", "download");
  await one("answer_key_docx", "answerKey");
  return out;
}

/** Every chapter of the book, in order, each with its kit's signed files (or none yet). */
export async function productChapters(book: ProductSystemBook, masters: MasterKitRow[], deps: ChapterDeps): Promise<ProductChapter[]> {
  const chapters = (Array.isArray(book.chapters) ? book.chapters : [])
    .filter((c) => Number.isInteger(Number(c?.num)))
    .map((c) => ({ num: Number(c.num), title: (c.title ?? "").trim() }))
    .sort((a, b) => a.num - b.num);
  return Promise.all(
    chapters.map(async (c) => {
      const kit = chapterKit(book, masters, c.num);
      const pieces = await Promise.all(kit.map(async (g) => ({ generationId: g.id, kind: g.kind, files: await filesOf(g, deps) })));
      return {
        num: c.num,
        chapter: c.num + 1,
        title: c.title,
        pieces,
        assignSources: kit.filter((g) => (STUDENT_KINDS as readonly string[]).includes(g.kind)).map((g) => g.id),
        boardSources: kit.map((g) => g.id),
        skHref: deps.skHref(c.num + 1),
      };
    }),
  );
}

type DbErr = { code?: string; message?: string } | null | undefined;
const missing0175 = (e: DbErr) => !!e && (["42703", "PGRST204"].includes(e.code ?? "") || /sk_product_id/i.test(e.message ?? ""));

/**
 * The system books of these products and their master kits (service role).
 * 0175 not applied → an empty map, quietly (the strip keeps its plain tiles).
 */
export async function loadProductBooks(
  db: ProductBookDb,
  productIds: string[],
): Promise<Map<string, { book: ProductSystemBook; masters: MasterKitRow[] }>> {
  const out = new Map<string, { book: ProductSystemBook; masters: MasterKitRow[] }>();
  if (!productIds.length) return out;
  const { data: books, error } = await db
    .from("books")
    .select("id, owner_id, sk_product_id, title, chapters")
    .in("sk_product_id", productIds)
    .is("removed_at", null);
  if (error) {
    if (missing0175(error)) return out;
    throw new Error(`books: ${error.message ?? error.code}`);
  }
  const list = (books ?? []) as ProductSystemBook[];
  if (!list.length) return out;
  const { data: gens, error: gErr } = await db
    .from("generations")
    .select("id, kind, title, chapter_ref, status, owner_id, book_id, params, created_at, removed_at, withdrawn_at, artifacts(kind, storage_path)")
    .in("book_id", list.map((b) => b.id))
    .eq("status", "done");
  if (gErr) throw new Error(`generations: ${gErr.message ?? gErr.code}`);
  const masters = (gens ?? []) as MasterKitRow[];
  for (const b of list) out.set(String(b.sk_product_id), { book: b, masters: masters.filter((g) => g.book_id === b.id && g.owner_id === b.owner_id) });
  return out;
}
