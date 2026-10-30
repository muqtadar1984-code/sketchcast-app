"use client";

import { useState } from "react";
import Link from "next/link";
import type { Dictionary } from "@/i18n/dictionaries";
import { childLabel, type MyBookTile } from "@/utils/my-books/tiles";
import { fmt } from "@/i18n/format";

// SK S7 K3 — the Library's "My books": SketchCast books the reader bought or
// was given (page.tsx builds the tiles server-side, after the access check —
// src/utils/my-books). A client component only for the cover fallback: a
// cover that is missing, or that S3 refuses, shows the title's first letter
// instead of a broken image. Nothing renders when there are no tiles.

export type MyBooksMessages = Dictionary["library"]["myBooks"];

function Cover({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div
        data-testid="my-book-cover-fallback"
        aria-hidden="true"
        className="flex h-full w-full items-center justify-center bg-[#E2F4F1] font-display text-3xl text-[#0C8175]"
      >
        {Array.from(title.trim())[0]?.toUpperCase() ?? "📖"}
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned S3 link, not an optimisable asset
  return <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" onError={() => setFailed(true)} />;
}

export default function MyBooksStrip({ tiles, t, unavailable }: { tiles: MyBookTile[]; t: MyBooksMessages; unavailable?: boolean }) {
  if (!tiles.length) return null;
  return (
    <section className="mb-8" aria-labelledby="my-books-title" data-testid="my-books" data-tour="my-books">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
        <h2 id="my-books-title" className="text-xl font-semibold text-[#14181F]">
          {t.title}
        </h2>
        <p className="text-sm text-[#5B6470]">{t.subtitle}</p>
      </div>
      {unavailable && (
        <p role="status" className="mb-3 rounded-lg bg-[#FFF9EE] px-4 py-2.5 text-sm text-[#9A6400]">
          {t.unavailable}
        </p>
      )}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((b) => (
          <li key={b.productId} className="flex gap-3 rounded-xl border border-[#E4E7E2] bg-white p-3">
            <div className="h-28 w-20 shrink-0 overflow-hidden rounded-md border border-[#E4E7E2]">
              <Cover url={b.coverUrl} title={b.title} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <h3 className="line-clamp-2 font-medium text-[#14181F]" title={b.title}>
                {b.title}
              </h3>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#5B6470]">
                <span className="chip bg-[#E2F4F1] text-[#0C8175]">{b.language}</span>
                {b.chapterCount != null && <span>{b.chapterCount === 1 ? t.chapterOne : fmt(t.chapters, { n: b.chapterCount })}</span>}
              </div>
              {b.forChildren.length > 0 && (
                <p className="mt-1 text-xs text-[#5B6470]">
                  {childLabel(b.forChildren, t)}
                </p>
              )}
              {b.withdrawn && <p className="mt-1 text-xs text-[#9A6400]">{t.withdrawn}</p>}
              <div className="mt-auto flex flex-wrap gap-2 pt-2">
                {b.skHref && (
                  <Link href={b.skHref} className="inline-flex min-h-10 items-center rounded-lg bg-[#1FB8A6] px-3 text-sm font-medium text-white hover:bg-[#0C8175]">
                    {t.openInSk}
                  </Link>
                )}
                {b.pdfHref && (
                  // A plain anchor: the route answers with a redirect to the file (or back here).
                  <a
                    href={b.pdfHref}
                    className="inline-flex min-h-10 items-center rounded-lg border border-[#D2D6D1] px-3 text-sm font-medium text-[#14181F] hover:bg-[#F5F6F3]"
                  >
                    {t.download}
                  </a>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
