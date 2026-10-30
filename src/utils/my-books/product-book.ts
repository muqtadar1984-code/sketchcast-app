// SketchCast books as Library books (migration 0175) — a bought book's
// CHAPTERS, the way an uploaded book lists them: every chapter of the
// product's system book with its final title, and that chapter's KITS.
//
// Founder 2026-10-30: the kits are NOT generated for the book — they are the
// existing CATALOGUE kits of the chapter's topics, mapped in sk_product_kits
// (scripts/sk-product-kits.ts): one row per (release chapter, kit lesson), in
// the chapter's topic order, labelled with the topic's title. A chapter may
// carry several kits (Biology ch 6, 8, 10); a kit may serve several chapters
// (Biology's "cells" in ch 1, 3 and 7 — the later ones say "shared with
// Chapter 1"). A chapter with no row reads "Lesson kit coming soon".
//
// The book goes to the CLASSROOM BOARD, not to SK (founder: "the book doesnt
// go to SK, it goes to the whitebaord just like a users uploaded text
// book"): each chapter carries its Board deep link (/present?book=&chapter=,
// the uploaded-book contract of src/app/present/deep-link.ts) for readers the
// Board admits, and Assign.
//
// THE VIDEO PLAYS FROM OUR STORED MP4 (founder 2026-10-30: "the quality
// matters in the app so lets use stored mp4 wherever possible"): the lesson's
// Watch chips are its signed MP4s, in part order. Only a lesson with no stored
// video falls back to the kit's YouTube watch links (kit-youtube.ts); the card
// plays either in the in-app player (lesson-player.tsx, captions off on
// YouTube).
//
// The kits belong to the catalogue system account; no session may read or
// sign them (no generations policy; storage is the owner's prefix). So — the
// catalogue's pattern, /api/catalogue/file — the SERVER reads them with the
// service role and signs the documents, only for books decideMyBooks()
// already granted the reader. Nothing here decides access.
//
// A teacher who ASSIGNS a chapter or puts it on the Board gets their own
// copies through adopt_product_kit() (0175) — the piece ids the card carries
// are what it adopts; the database checks the grant again.
//
// Pure apart from the injected db/sign: rows in, chapters out.

import { docDownloadName } from "@/utils/download-name";
import { sortVideoArtifacts } from "@/utils/catalogue/kit";
import { assignablePieces, piecesOf, type TopicKitRow } from "@/app/dashboard/kits/logic";
import { loadKitYoutubeIds, videoSource, youtubeWatchUrl } from "@/utils/catalogue/kit-youtube";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ProductBookDb = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ProductSystemBook = {
  id: string;
  sk_product_id: string;
  title: string;
  chapters: { num: number; title?: string | null }[] | null;
};

/** A row of sk_product_kits (0170): chapter_ref is the RELEASE chapter (1-based). */
export type ProductKitMapRow = { product_id: string; chapter_ref: string; sort: number; generation_id: string; label: string | null };
/** topic_kits(id, presentation_generation_id, doc_generation_ids) of a mapped kit. */
export type MappedKitRow = TopicKitRow & { topic_id?: string | null };
export type PieceArtifact = { kind: string; storage_path: string };
export type PieceRow = {
  id: string;
  kind: string;
  status: string;
  removed_at?: string | null;
  withdrawn_at?: string | null;
  artifacts: PieceArtifact[] | null;
};

/** A piece's files, labelled by what the chip says ("Watch", "Deck", "Download", "Answer key"). `youtube` = a YouTube watch link. */
export type ChapterFile = { label: "watch" | "deck" | "download" | "answerKey"; part: number | null; url: string; youtube?: true };
export type ChapterPiece = { generationId: string; kind: string; files: ChapterFile[] };
export type ChapterKit = {
  /** the kit's lesson (sk_product_kits.generation_id): its identity on the Board */
  lessonId: string;
  topicKitId: string;
  /** the map's label (the topic title; a shared kit's row carries the chapter's own title) */
  label: string | null;
  /** an earlier release chapter that maps the same kit, or null */
  sharedWith: number | null;
  /** lesson first; [] when the kit could not be read */
  pieces: ChapterPiece[];
};
export type ProductChapter = {
  /** books.chapters num (0-based) — the Board's chapter key */
  num: number;
  /** the release chapter (num + 1): the Library's "Chapter N", sk_product_kits.chapter_ref */
  chapter: number;
  title: string;
  /** the chapter's kits in topic order; [] = "Lesson kit coming soon" */
  kits: ChapterKit[];
  /** piece ids a student may receive, across the chapter's kits — adopted on Assign */
  assignSources: string[];
  /** /present?book=&chapter= for a reader the Board admits, else null */
  boardHref: string | null;
};

export type ProductBookData = {
  book: ProductSystemBook;
  map: ProductKitMapRow[];
  kits: MappedKitRow[];
  pieces: PieceRow[];
  /** topic_kit_id → watchable YouTube ids, in part order */
  youtube: Map<string, string[]>;
};

export type ChapterDeps = {
  /** Signs one artifacts-bucket path (service role); null when it cannot. */
  sign: (path: string, download?: string) => Promise<string | null>;
  /** The reader may open the Classroom Board. */
  boardOn: boolean;
};

const live = (g: PieceRow | undefined): g is PieceRow => !!g && g.status === "done" && !g.removed_at && !g.withdrawn_at;

/** The Board deep link for a product chapter (0-based num, as deep-link.ts reads it). */
export const boardHref = (bookId: string, num: number): string => `/present?book=${encodeURIComponent(bookId)}&chapter=${num}`;

async function filesOf(kind: string, g: PieceRow, youtube: string[], deps: ChapterDeps): Promise<ChapterFile[]> {
  const arts = g.artifacts ?? [];
  const out: ChapterFile[] = [];
  const many = async (artKind: string, label: ChapterFile["label"]) => {
    const list = sortVideoArtifacts(arts.filter((a) => a.kind === artKind));
    const urls = await Promise.all(list.map((a) => deps.sign(a.storage_path, docDownloadName(g.kind, artKind))));
    urls.forEach((url, i) => url && out.push({ label, part: list.length > 1 ? i + 1 : null, url }));
  };
  const one = async (artKind: string, label: ChapterFile["label"]) => {
    const a = arts.find((x) => x.kind === artKind);
    if (!a) return;
    const url = await deps.sign(a.storage_path, docDownloadName(g.kind, artKind));
    if (url) out.push({ label, part: null, url });
  };
  if (kind === "presentation") {
    const stored = arts.filter((a) => a.kind === "video_mp4").length;
    const source = videoSource(youtube, stored);
    if (source === "storage") await many("video_mp4", "watch");
    else if (source === "youtube") youtube.forEach((id, i) => out.push({ label: "watch", part: youtube.length > 1 ? i + 1 : null, url: youtubeWatchUrl(id), youtube: true }));
  }
  await many("deck_pptx", "deck");
  await one("docx", "download");
  await one("answer_key_docx", "answerKey");
  return out;
}

/** Every chapter of the book, in order, each with its kits' files (or none yet). */
export async function productChapters(data: ProductBookData, deps: ChapterDeps): Promise<ProductChapter[]> {
  const { book } = data;
  const kitByLesson = new Map<string, MappedKitRow>();
  for (const k of data.kits) if (k.presentation_generation_id && !kitByLesson.has(k.presentation_generation_id)) kitByLesson.set(k.presentation_generation_id, k);
  const pieceById = new Map(data.pieces.map((p) => [p.id, p]));
  const mine = data.map.filter((r) => r.product_id === book.sk_product_id && /^\d{1,4}$/.test(String(r.chapter_ref)));
  const firstChapter = new Map<string, number>();
  for (const r of mine) {
    const ch = Number(r.chapter_ref);
    if (!firstChapter.has(r.generation_id) || ch < firstChapter.get(r.generation_id)!) firstChapter.set(r.generation_id, ch);
  }
  const chapters = (Array.isArray(book.chapters) ? book.chapters : [])
    .filter((c) => Number.isInteger(Number(c?.num)))
    .map((c) => ({ num: Number(c.num), title: (c.title ?? "").trim() }))
    .sort((a, b) => a.num - b.num);

  return Promise.all(
    chapters.map(async (c) => {
      const chapter = c.num + 1;
      const rows = mine.filter((r) => Number(r.chapter_ref) === chapter).sort((a, b) => a.sort - b.sort);
      const kits: ChapterKit[] = [];
      for (const r of rows) {
        const kit = kitByLesson.get(r.generation_id);
        // an unreadable kit, or one whose lesson is gone, is not offered
        if (!kit || !live(pieceById.get(r.generation_id)) || kits.some((k) => k.lessonId === r.generation_id)) continue;
        const youtube = data.youtube.get(kit.id) ?? [];
        const pieces = await Promise.all(
          piecesOf(kit)
            .filter((p) => live(pieceById.get(p.generationId)))
            .map(async (p) => ({ generationId: p.generationId, kind: p.kind, files: await filesOf(p.kind, pieceById.get(p.generationId)!, youtube, deps) })),
        );
        const first = firstChapter.get(r.generation_id) ?? chapter;
        kits.push({ lessonId: r.generation_id, topicKitId: kit.id, label: r.label, sharedWith: first < chapter ? first : null, pieces });
      }
      const assignSources = [...new Set(kits.flatMap((k) => assignablePieces(k.pieces.map((p) => ({ kind: p.kind, generationId: p.generationId }))).map((p) => p.generationId)))];
      return {
        num: c.num,
        chapter,
        title: c.title,
        kits,
        assignSources,
        boardHref: deps.boardOn && kits.length ? boardHref(book.id, c.num) : null,
      };
    }),
  );
}

type DbErr = { code?: string; message?: string } | null | undefined;
const missing0175 = (e: DbErr) => !!e && (["42703", "PGRST204"].includes(e.code ?? "") || /sk_product_id/i.test(e.message ?? ""));

/**
 * The system books of these products, their chapter → kit map, the mapped
 * catalogue kits, every piece with its artifacts, and each kit's YouTube ids
 * (service role). 0175 not applied → an empty map, quietly (the strip keeps
 * its plain tiles).
 */
export async function loadProductBooks(db: ProductBookDb, productIds: string[]): Promise<Map<string, ProductBookData>> {
  const out = new Map<string, ProductBookData>();
  if (!productIds.length) return out;
  const { data: books, error } = await db.from("books").select("id, sk_product_id, title, chapters").in("sk_product_id", productIds).is("removed_at", null);
  if (error) {
    if (missing0175(error)) return out;
    throw new Error(`books: ${error.message ?? error.code}`);
  }
  const list = (books ?? []) as ProductSystemBook[];
  if (!list.length) return out;

  const { data: mapRows, error: mErr } = await db
    .from("sk_product_kits")
    .select("product_id, chapter_ref, sort, generation_id, label")
    .in("product_id", list.map((b) => b.sk_product_id));
  if (mErr) throw new Error(`sk_product_kits: ${mErr.message ?? mErr.code}`);
  const map = (mapRows ?? []) as ProductKitMapRow[];
  const lessons = [...new Set(map.map((r) => r.generation_id))];

  let kits: MappedKitRow[] = [];
  let pieces: PieceRow[] = [];
  let youtube = new Map<string, string[]>();
  if (lessons.length) {
    const { data: kitRows, error: kErr } = await db
      .from("topic_kits")
      .select("id, topic_id, presentation_generation_id, doc_generation_ids, status, reviewed_at, updated_at")
      .in("presentation_generation_id", lessons)
      .eq("status", "approved");
    if (kErr) throw new Error(`topic_kits: ${kErr.message ?? kErr.code}`);
    // newest approval first, so kitByLesson keeps the newest kit of a lesson
    kits = ((kitRows ?? []) as (MappedKitRow & { reviewed_at?: string | null; updated_at?: string | null })[]).sort((a, b) =>
      String(b.reviewed_at ?? b.updated_at ?? "").localeCompare(String(a.reviewed_at ?? a.updated_at ?? "")),
    );
    const ids = [...new Set(kits.flatMap((k) => piecesOf(k).map((p) => p.generationId)))];
    if (ids.length) {
      const { data: gens, error: gErr } = await db
        .from("generations")
        .select("id, kind, status, removed_at, withdrawn_at, artifacts(kind, storage_path)")
        .in("id", ids);
      if (gErr) throw new Error(`generations: ${gErr.message ?? gErr.code}`);
      pieces = (gens ?? []) as PieceRow[];
    }
    youtube = await loadKitYoutubeIds(db, kits.map((k) => k.id));
  }
  for (const b of list) out.set(String(b.sk_product_id), { book: b, map: map.filter((r) => r.product_id === b.sk_product_id), kits, pieces, youtube });
  return out;
}
