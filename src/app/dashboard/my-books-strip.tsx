import Link from "next/link";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { childLabel, type MyBookTile } from "@/utils/my-books/tiles";
import { fmt } from "@/i18n/format";
import type { LibraryMessages } from "./labels";
import MyBookCover from "./my-book-cover";
import ProductBookCard from "./product-book-card";

// SK S7 K3 — the Library's "My books": SketchCast books the reader bought or
// was given (page.tsx builds the tiles server-side, after the access check —
// src/utils/my-books). Nothing renders when there are no tiles.
//
// 0175 — SketchCast books as Library books: a tile that carries its chapters
// (the product's system book exists) renders as a full book card with every
// chapter and its kit (product-book-card.tsx); a tile without them (0175 not
// applied, the release not re-imported yet, or a child's book a parent sees)
// keeps the compact tile. A SERVER component now: the card's chips and its
// Assign modal speak the Library's own words, resolved here (React-cached, so
// it costs the page nothing it has not already paid) rather than passed down
// through page.tsx.

export type MyBooksMessages = Dictionary["library"]["myBooks"];

export default async function MyBooksStrip({ tiles, t, unavailable }: { tiles: MyBookTile[]; t: MyBooksMessages; unavailable?: boolean }) {
  if (!tiles.length) return null;
  let lib: LibraryMessages | null = null;
  let shown = tiles;
  if (tiles.some((b) => b.chapters)) {
    const dict = await getDictionary(await resolveLocale());
    lib = { ...dict.library, common: dict.common, utils: dict.utils };
    // a child with no name on file still needs a label in the Assign modal
    const named = (c: { id: string; name: string }) => (c.name ? c : { ...c, name: dict.school.fallback.child });
    shown = tiles.map((b) => (b.assign?.childTargets ? { ...b, assign: { ...b.assign, childTargets: b.assign.childTargets.map(named) } } : b));
  }
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
        {shown.map((b) =>
          b.chapters && lib ? (
            <ProductBookCard key={b.productId} tile={b} t={lib} />
          ) : (
            <li key={b.productId} className="flex gap-3 rounded-xl border border-[#E4E7E2] bg-white p-3">
              <div className="h-28 w-20 shrink-0 overflow-hidden rounded-md border border-[#E4E7E2]">
                <MyBookCover url={b.coverUrl} title={b.title} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <h3 className="line-clamp-2 font-medium text-[#14181F]" title={b.title}>
                  {b.title}
                </h3>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#5B6470]">
                  <span className="chip bg-[#E2F4F1] text-[#0C8175]">{b.language}</span>
                  {b.chapterCount != null && <span>{b.chapterCount === 1 ? t.chapterOne : fmt(t.chapters, { n: b.chapterCount })}</span>}
                </div>
                {b.forChildren.length > 0 && <p className="mt-1 text-xs text-[#5B6470]">{childLabel(b.forChildren, t)}</p>}
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
          ),
        )}
      </ul>
    </section>
  );
}
