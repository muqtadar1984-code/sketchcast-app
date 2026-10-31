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
  /**
   * The book on the Classroom Board (/present?book=<system book id>) for a
   * reader the Board admits; null otherwise. SK Tutor is retired (founder
   * 2026-10-31: books are taught on the Board), so there is no "Open in SK".
   */
  boardHref: string | null;
  forChildren: string[];
  withdrawn: boolean;
  /**
   * 0175: the book's chapters, each with its catalogue kits (product-book.ts)
   * — the card lists them like an uploaded book, with the Board and Assign.
   * null = the plain tile: no system book yet (0175 not applied, or the
   * release not re-imported), a student reader, or a child's book a parent
   * sees.
   */
  chapters: ProductChapter[] | null;
  /** Who "Assign chapter" can reach (set by server.ts when chapters are listed); null = no Assign. */
  assign?: AssignTargets | null;
};

export type AssignTargets = { classes: { id: string; name: string; grade: string | null }[]; childTargets: { id: string; name: string }[] | null };

export type TileDeps = {
  /** Mints a short-lived link to a books-bucket object (src/utils/books/files.ts s3Link). */
  sign: (key: string, seconds: number) => Promise<string | null>;
  /** The book's system book id (books.id) when the reader may open the
   *  Classroom Board, else null; omitted → no Board link. */
  boardBook?: (b: MyBook) => string | null;
  /** The book's chapters (signed by the server after the decision); omitted → null. */
  chapters?: (b: MyBook) => Promise<ProductChapter[] | null>;
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
      // (nor a Board link); a withdrawn book has no kits any more.
      const boardBook = !b.withdrawn && !b.forChildren.length ? (deps.boardBook?.(b) ?? null) : null;
      let chapters: ProductChapter[] | null = null;
      if (deps.chapters && !b.forChildren.length) {
        try {
          chapters = await deps.chapters(b);
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
        boardHref: boardBook ? `/present?book=${encodeURIComponent(boardBook)}` : null,
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
