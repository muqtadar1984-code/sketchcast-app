// SK S7 K3 — the "My books" strip's tiles, built from the access decision.
//
// The ONLY place the strip signs anything, and it signs only the covers of
// books decideMyBooks() returned — the access check always comes first. A
// cover link lives 1 hour (the Library's other covers do too). The PDF is
// never signed here: the tile links to /api/my-books/pdf, which checks
// access again and only then mints a 10-minute link.

import type { MyBook } from "./decide";
import type { ProductChapter } from "./product-book";
import { languageLabel } from "@/utils/narration";
import { fmt } from "@/i18n/format";

export const COVER_LINK_SECONDS = 3600;
/** The PDF route's link (/api/my-books/pdf): 10 minutes. */
export const PDF_LINK_SECONDS = 600;

export type MyBookTile = {
  productId: string;
  title: string;
  language: string;
  chapterCount: number | null;
  coverUrl: string | null;
  pdfHref: string | null;
  skHref: string | null;
  forChildren: string[];
  withdrawn: boolean;
  /**
   * 0175: the book's chapters, each with its ONE kit (product-book.ts) — the
   * card lists them like an uploaded book. null = no system book yet (0175
   * not applied, or the release not re-imported): the plain tile.
   */
  chapters: ProductChapter[] | null;
  /** Who "Assign chapter" can reach (set by server.ts when chapters are listed); null = no Assign. */
  assign?: AssignTargets | null;
};

export type AssignTargets = { classes: { id: string; name: string; grade: string | null }[]; childTargets: { id: string; name: string }[] | null };

export type TileDeps = {
  /** Mints a short-lived link to a books-bucket object (src/utils/books/files.ts s3Link). */
  sign: (key: string, seconds: number) => Promise<string | null>;
  /** The reader passes the SK gate (flags + allow-list): "Open in SK" shows. */
  skOpen: boolean;
  /** The book's chapters (signed by the server after the decision); omitted → null. */
  chapters?: (b: MyBook, skOpen: boolean) => Promise<ProductChapter[] | null>;
};

export async function myBookTiles(books: MyBook[], deps: TileDeps): Promise<MyBookTile[]> {
  return Promise.all(
    books.map(async (b) => {
      let coverUrl: string | null = null;
      if (b.coverKey) {
        try {
          coverUrl = await deps.sign(b.coverKey, COVER_LINK_SECONDS);
        } catch (e) {
          console.error("[sk-library] cover link failed:", (e as Error).message);
        }
      }
      // a child's book is the child's: the parent sees the tile, not the kits
      let chapters: ProductChapter[] | null = null;
      if (deps.chapters && !b.forChildren.length) {
        try {
          chapters = await deps.chapters(b, deps.skOpen && !b.withdrawn);
        } catch (e) {
          console.error("[sk-library] chapters failed:", (e as Error).message);
        }
      }
      return {
        productId: b.productId,
        title: b.title,
        language: languageLabel(b.language) ?? b.language.toUpperCase(),
        chapterCount: b.chapterCount,
        coverUrl,
        pdfHref: b.pdfKey ? `/api/my-books/pdf?product=${encodeURIComponent(b.productId)}` : null,
        // A withdrawn book has no SK content any more (the importer removed
        // it); a child's book is the child's to open in SK, not the parent's.
        skHref: deps.skOpen && !b.withdrawn && !b.forChildren.length ? `/sk/${encodeURIComponent(b.slug)}` : null,
        forChildren: b.forChildren,
        withdrawn: b.withdrawn,
        chapters,
      };
    }),
  );
}

/** "for Aisyah", "for Aisyah, Omar"; "for your child" when no child has a name on file. */
export function childLabel(names: string[], t: { forChild: string; forYourChild: string }): string {
  const named = names.map((n) => n.trim()).filter(Boolean);
  return named.length ? fmt(t.forChild, { name: named.join(", ") }) : t.forYourChild;
}
