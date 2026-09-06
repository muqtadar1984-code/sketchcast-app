// Which uploads are the SAME book — the Harvest shelf shows unique books by
// default (founder, 2026-09-06): the platform holds many copies of the same
// textbook uploaded by different teachers, and a topic name harvested from one
// copy is the same name from every copy.
//
// Identity: books.content_hash (0070 — the fingerprint the school shelf's
// dedup already uses) when both rows carry one; otherwise a title-and-pages
// key (normalised title, page count) for books indexed before hashing existed
// or whose upload never produced a hash. Pure: no I/O, tested in
// src/utils/__tests__/catalogue-books.test.ts.

export type DedupBook = {
  id: string;
  title: string | null;
  pages: number | null;
  status: string;
  created_at: string;
  content_hash?: string | null;
};

/** The identity key two uploads share when they are the same book. */
export function bookIdentity(b: DedupBook): string {
  if (b.content_hash) return `hash:${b.content_hash}`;
  const title = (b.title ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `title:${title}|${b.pages ?? "?"}`;
}

export type BookGroup<T extends DedupBook> = {
  /** The copy the shelf shows. */
  representative: T;
  /** Every copy, representative included, oldest upload first. */
  copies: T[];
};

/**
 * Group uploads into unique books. The representative is the copy most useful
 * to harvest from: a `ready` (indexed) copy over any other status, then the
 * one with the most harvested candidates, then the OLDEST upload — the first
 * teacher to bring the book to the platform, so the shelf is stable as more
 * copies arrive. `candidates(id)` may be omitted (treated as 0).
 */
export function groupBooks<T extends DedupBook>(books: T[], candidates?: (id: string) => number): BookGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const b of books) {
    const k = bookIdentity(b);
    const arr = byKey.get(k);
    if (arr) arr.push(b);
    else byKey.set(k, [b]);
  }
  const count = candidates ?? (() => 0);
  const groups: BookGroup<T>[] = [];
  for (const copies of byKey.values()) {
    const sorted = [...copies].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const representative = [...sorted].sort((a, b) => {
      const ra = a.status === "ready" ? 0 : 1;
      const rb = b.status === "ready" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const ca = count(a.id);
      const cb = count(b.id);
      if (ca !== cb) return cb - ca;
      return a.created_at.localeCompare(b.created_at);
    })[0];
    groups.push({ representative, copies: sorted });
  }
  // Newest representative first, matching the shelf's existing order.
  groups.sort((a, b) => b.representative.created_at.localeCompare(a.representative.created_at));
  return groups;
}
