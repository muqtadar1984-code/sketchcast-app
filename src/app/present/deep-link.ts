// The Board's deep link: `/present?class=…&book=…&chapter=…&autostart=1` or
// `/present?kit=…&autostart=1` (Final Plan §2.7: "open the Board and start
// with the video" from nothing). PURE — the query string and the page's own
// lists in, a pick out — so SK's `navigate board` filters and the page agree
// on one contract and it is tested without a DOM.
//
// EVERY ID IS CHECKED AGAINST WHAT THE PAGE LOADED. The lists come from
// page.tsx through the teacher's own session (RLS) plus her own classes, so an
// id that is not in them is not hers to start a lesson on — or is stale — and
// is dropped silently rather than refused: the bar simply stays where it was.
// `chapter` is the chapter's `num` as the page keys it (books.chapters[].num,
// the 0-based chapter_ref the database carries), the same value the bar's
// picker holds and SK's selection reports as `chapterRef`.

export type DeepLinkLists = {
  classes: Array<{ id: string }>;
  books: Array<{ id: string; chapters: Array<{ num: number }> }>;
  /** Ready-made kits (book-less presentations), by presentation id. */
  kits?: Array<{ id: string }>;
  /** The student Board (learner mode): her assigned kits, each with every
   *  assigned piece — `?learn=<any piece>` opens the kit holding it. */
  learnerKits?: Array<{ id: string; members: string[] }>;
};

export type PresentDeepLink = {
  classId?: string;
  bookId?: string;
  chapterNum?: number;
  kitId?: string;
  autostart: boolean;
};

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

function param(q: URLSearchParams, key: string): string | null {
  const v = (q.get(key) ?? "").trim();
  return v && ID_RE.test(v) ? v : null;
}

export function parsePresentDeepLink(search: string, lists: DeepLinkLists): PresentDeepLink {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: PresentDeepLink = { autostart: q.get("autostart") === "1" };

  const classId = param(q, "class");
  if (classId && lists.classes.some((c) => c.id === classId)) out.classId = classId;

  // `?learn=<generation>` (My lessons' "Learn with SK", 2026-10-31): the
  // assigned kit holding that piece, on the student Board. Only her own kits.
  const learn = param(q, "learn");
  if (learn && lists.learnerKits?.length) {
    const k = lists.learnerKits.find((x) => x.id === learn) ?? lists.learnerKits.find((x) => x.members.includes(learn));
    if (k) {
      out.kitId = k.id;
      return out;
    }
  }

  const kitId = param(q, "kit");
  const bookId = param(q, "book");
  if (kitId && (lists.kits ?? []).some((k) => k.id === kitId)) {
    // A kit is a whole lesson on its own; a book beside it is ignored.
    out.kitId = kitId;
    return out;
  }
  if (bookId) {
    const book = lists.books.find((b) => b.id === bookId);
    if (book) {
      out.bookId = bookId;
      const raw = (q.get("chapter") ?? "").trim();
      const n = /^\d{1,3}$/.test(raw) ? Number(raw) : null;
      if (n !== null && book.chapters.some((c) => c.num === n)) out.chapterNum = n;
    }
  }
  return out;
}

/** Can this link start a lesson by itself? (Both halves of a book pick, or a kit.) */
export function deepLinkStartable(d: PresentDeepLink): boolean {
  return !!d.kitId || (!!d.bookId && typeof d.chapterNum === "number");
}
