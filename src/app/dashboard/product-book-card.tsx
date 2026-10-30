"use client";

import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { fmt } from "@/i18n/format";
import AssignModal from "./assign-modal";
import MyBookCover from "./my-book-cover";
import { kindLabel, type LibraryMessages } from "./labels";
import { childLabel, type MyBookTile } from "@/utils/my-books/tiles";
import type { ChapterFile, ProductChapter } from "@/utils/my-books/product-book";

// SketchCast books as Library books (0175) — a bought book rendered like an
// uploaded book's card: cover, title, language, "N chapters", and every
// chapter with its final title and its ONE kit's files (or "Lesson kit coming
// soon"). READ-ONLY for buyers: no Generate, regenerate, delete or edit — the
// kit is SketchCast's. Per chapter: Assign chapter (adopt_product_kit copies
// the student pieces into the teacher's own library, then the Library's own
// Assign modal runs on those copies) and Open in SK. Per book: Open in SK and
// Download PDF. Everything was decided and signed on the server
// (src/utils/my-books); this only lays it out.

function FileLink({ f, t }: { f: ChapterFile; t: LibraryMessages }) {
  const text =
    f.label === "watch"
      ? `▶ ${f.part ? fmt(t.watchPart, { n: f.part }) : t.watch}`
      : f.label === "deck"
        ? `⬇ ${f.part ? fmt(t.deckPart, { n: f.part }) : t.deck}`
        : f.label === "answerKey"
          ? `⬇ ${t.bookless.answerKey}`
          : `⬇ ${t.download}`;
  return (
    <a href={f.url} target={f.label === "watch" ? "_blank" : undefined} rel="noreferrer" className="font-medium text-[#0C8175] hover:underline">
      {text}
    </a>
  );
}

function ChapterRow({ c, tile, t }: { c: ProductChapter; tile: MyBookTile; t: LibraryMessages }) {
  const m = t.myBooks;
  const assign = tile.assign;
  const prepare = async (): Promise<string[]> => {
    const supabase = createClient();
    const ids: string[] = [];
    for (const source of c.assignSources) {
      const { data, error } = await supabase.rpc("adopt_product_kit", { p_source: source });
      if (error || typeof data !== "string") throw new Error(m.assignFailed);
      ids.push(data);
    }
    return ids;
  };
  return (
    <li className="py-3" data-chapter={c.chapter}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-[#5B6470]">{fmt(m.chapterN, { n: c.chapter })}</p>
          <p className="font-medium text-[#14181F]">{c.title || fmt(m.chapterN, { n: c.chapter })}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {assign && c.assignSources.length > 0 && (
            <AssignModal label={m.assignChapter} generationIds={[]} classes={assign.classes} childTargets={assign.childTargets} prepare={prepare} t={t} />
          )}
          {c.skHref && (
            <Link href={c.skHref} className="text-xs font-medium text-[#0C8175] hover:underline whitespace-nowrap">
              {m.openInSk}
            </Link>
          )}
        </div>
      </div>
      {c.pieces.length === 0 ? (
        <p className="mt-1.5 text-sm text-[#98A0A9]">{m.kitComingSoon}</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {c.pieces.map((p) => (
            <li key={p.generationId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[#E4E7E2] px-2.5 py-1.5 text-sm">
              <span className="text-[#1F2A37]">{kindLabel(t, p.kind)}</span>
              {p.files.map((f, i) => (
                <FileLink key={`${f.label}${i}`} f={f} t={t} />
              ))}
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
            {tile.skHref && (
              <Link href={tile.skHref} className="inline-flex min-h-10 items-center rounded-lg bg-[#1FB8A6] px-3 text-sm font-medium text-white hover:bg-[#0C8175]">
                {m.openInSk}
              </Link>
            )}
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
