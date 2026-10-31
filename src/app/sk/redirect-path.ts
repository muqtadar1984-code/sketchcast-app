// The retired SK Tutor's old addresses (/sk, /sk/<product>, /sk/<product>/<chapter>)
// — founder 2026-10-31: "remove sk tutor, we dont need a separate tutor.
// existing books can be taught on the board itself". A bookmark still lands
// somewhere useful: an adult the Classroom Board admits goes to the Board (on
// that SketchCast book, and that chapter, when both resolve), everyone else —
// students included, and anyone signed out — to /dashboard. PURE: the facts
// in, a path out; redirect.ts reads the facts.

import { boardHref } from "@/utils/my-books/product-book";

export type SkRedirectFacts = {
  signedIn: boolean;
  role: string | null;
  /** presentEntitled(...).ok — the Board's own gate. */
  board: boolean;
  /** The product's system book (books.id) the user may read, when one resolved. */
  bookId?: string | null;
  /** The Board's chapter key (books.chapters[].num, 0-based) when the old
   *  /sk chapter (the RELEASE chapter, 1-based) is one of that book's. */
  chapterNum?: number | null;
};

export function skRedirectPath(f: SkRedirectFacts): string {
  if (!f.signedIn || f.role === "student" || !f.board) return "/dashboard";
  if (!f.bookId) return "/present";
  if (typeof f.chapterNum === "number") return boardHref(f.bookId, f.chapterNum);
  return `/present?book=${encodeURIComponent(f.bookId)}`;
}

/** /sk's chapter ref ("5", the 1-based release chapter) → the Board's 0-based num, or null. */
export function boardChapterOf(ref: string | null | undefined, chapters: Array<{ num: number }> | null | undefined): number | null {
  if (!ref || !/^\d{1,3}$/.test(ref)) return null;
  const num = Number(ref) - 1;
  return num >= 0 && (chapters ?? []).some((c) => c.num === num) ? num : null;
}
