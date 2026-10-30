"use client";

import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { fmt } from "@/i18n/format";
import AssignModal from "./assign-modal";
import MyBookCover from "./my-book-cover";
import { WatchLink } from "./lesson-player";
import { kindLabel, type LibraryMessages } from "./labels";
import { childLabel, type MyBookTile } from "@/utils/my-books/tiles";
import type { ChapterFile, ChapterKit, ProductChapter } from "@/utils/my-books/product-book";

// SketchCast books as Library books (0175) — a bought book rendered like an
// uploaded book's card: cover, title, language, "N chapters", and every
// chapter with its final title and its kits' files (or "Lesson kit coming
// soon"). The kits are the catalogue's own (sk_product_kits); a chapter with
// several lists each under its topic's name, and a kit an earlier chapter
// already uses says "Shared with Chapter N". READ-ONLY for buyers: no
// Generate, regenerate, delete or edit.
//
// The book goes to the CLASSROOM BOARD, like an uploaded book (founder
// 2026-10-30: "the book doesnt go to SK, it goes to the whitebaord"): per
// chapter, Teach on the board (/present?book=&chapter=, the Board adopts the
// chapter's kit on arrival) and Assign chapter (adopt_product_kit copies the
// student pieces into the teacher's own library, then the Library's own
// Assign modal runs on those copies). Per book: Download PDF. The lesson's
// Watch plays its stored MP4 in the in-app player (founder 2026-10-30: "the
// quality matters in the app so lets use stored mp4 wherever possible"); a
// lesson with no stored video plays its YouTube fallback there, captions off.
// Everything was decided and signed on the server (src/utils/my-books); this
// only lays it out.

function FileLink({ f, t }: { f: ChapterFile; t: LibraryMessages }) {
  const watchLabel = f.part ? fmt(t.watchPart, { n: f.part }) : t.watch;
  const text =
    f.label === "watch"
      ? `▶ ${watchLabel}`
      : f.label === "deck"
        ? `⬇ ${f.part ? fmt(t.deckPart, { n: f.part }) : t.deck}`
        : f.label === "answerKey"
          ? `⬇ ${t.bookless.answerKey}`
          : `⬇ ${t.download}`;
  const cls = "font-medium text-[#0C8175] hover:underline";
  if (f.label === "watch")
    return (
      <span data-youtube={f.youtube ? "true" : undefined} className="contents">
        <WatchLink src={f.url} title={watchLabel} closeLabel={t.common.close} className={cls}>
          {text}
        </WatchLink>
      </span>
    );
  return (
    <a href={f.url} className={cls}>
      {text}
    </a>
  );
}

function KitPieces({ kit, t }: { kit: ChapterKit; t: LibraryMessages }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-2">
      {kit.pieces.map((p) => (
        <li key={p.generationId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[#E4E7E2] px-2.5 py-1.5 text-sm">
          <span className="text-[#1F2A37]">{kindLabel(t, p.kind)}</span>
          {p.files.map((f, i) => (
            <FileLink key={`${f.label}${i}`} f={f} t={t} />
          ))}
        </li>
      ))}
    </ul>
  );
}

function ChapterRow({ c, tile, t }: { c: ProductChapter; tile: MyBookTile; t: LibraryMessages }) {
  const m = t.myBooks;
  const assign = tile.assign;
  const prepare = async (): Promise<string[]> => {
    const supabase = createClient();
    // independent copies: adopted side by side (each is idempotent)
    const ids = await Promise.all(
      c.assignSources.map(async (source) => {
        const { data, error } = await supabase.rpc("adopt_product_kit", { p_source: source });
        if (error || typeof data !== "string") throw new Error(m.assignFailed);
        return data;
      }),
    );
    return [...new Set(ids)];
  };
  const several = c.kits.length > 1;
  return (
    <li className="py-3" data-chapter={c.chapter}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-[#5B6470]">{fmt(m.chapterN, { n: c.chapter })}</p>
          <p className="font-medium text-[#14181F]">{c.title || fmt(m.chapterN, { n: c.chapter })}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {c.boardHref && (
            <Link href={c.boardHref} className="text-xs font-medium text-[#0C8175] hover:underline whitespace-nowrap" data-board-link>
              {m.teachOnBoard}
            </Link>
          )}
          {assign && c.assignSources.length > 0 && (
            <AssignModal label={m.assignChapter} generationIds={[]} classes={assign.classes} childTargets={assign.childTargets} prepare={prepare} t={t} />
          )}
        </div>
      </div>
      {c.kits.length === 0 ? (
        <p className="mt-1.5 text-sm text-[#98A0A9]">{m.kitComingSoon}</p>
      ) : (
        <ul className={several ? "mt-2 space-y-2" : "mt-0.5"}>
          {c.kits.map((k) => (
            <li key={k.lessonId} data-kit={k.topicKitId}>
              {(several || k.sharedWith !== null) && (
                <p className="text-xs text-[#5B6470]">
                  {several && k.label && <span className="font-medium text-[#1F2A37]">{k.label}</span>}
                  {several && k.label && k.sharedWith !== null && " · "}
                  {k.sharedWith !== null && fmt(m.sharedWith, { n: k.sharedWith })}
                </p>
              )}
              <KitPieces kit={k} t={t} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function ProductBookCard({ tile, t }: { tile: MyBookTile; t: LibraryMessages }) {
  const m = t.myBooks;
  const chapters = tile.chapters ?? [];
  const count = chapters.length || tile.chapterCount || 0;
  return (
    <li className="rounded-xl border border-[#E4E7E2] bg-white p-4 sm:col-span-2 lg:col-span-3" data-product-book={tile.productId}>
      <div className="flex gap-3">
        <div className="h-28 w-20 shrink-0 overflow-hidden rounded-md border border-[#E4E7E2]">
          <MyBookCover url={tile.coverUrl} title={tile.title} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="font-display text-lg font-medium leading-snug text-[#14181F]" title={tile.title}>
            {tile.title}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#5B6470]">
            <span className="chip bg-[#E2F4F1] text-[#0C8175]">{tile.language}</span>
            {count > 0 && <span>{count === 1 ? m.chapterOne : fmt(m.chapters, { n: count })}</span>}
            <span className="chip bg-[#F5F6F3] text-[#5B6470]">{m.bySketchCast}</span>
          </div>
          {tile.forChildren.length > 0 && <p className="mt-1 text-xs text-[#5B6470]">{childLabel(tile.forChildren, m)}</p>}
          {tile.withdrawn && <p className="mt-1 text-xs text-[#9A6400]">{m.withdrawn}</p>}
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            {tile.pdfHref && (
              // A plain anchor: the route answers with a redirect to the file (or back here).
              <a href={tile.pdfHref} className="inline-flex min-h-10 items-center rounded-lg border border-[#D2D6D1] px-3 text-sm font-medium text-[#14181F] hover:bg-[#F5F6F3]">
                {m.download}
              </a>
            )}
          </div>
        </div>
      </div>
      {chapters.length > 0 && (
        <details className="group mt-3 border-t border-[#E6E8E4] pt-2">
          <summary className="cursor-pointer select-none py-1 text-sm font-medium text-[#0C8175]">
            <span className="rtl-flip me-1.5 inline-block transition-transform group-open:rotate-90">▶</span>
            {fmt(m.showChapters, { n: chapters.length })}
          </summary>
          <ol className="divide-y divide-[#E6E8E4]">
            {chapters.map((c) => (
              <ChapterRow key={c.num} c={c} tile={tile} t={t} />
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}
