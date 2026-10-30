// SK S7 K3 — the Library's "My books": which SketchCast books a reader may
// see and download. Pure — rows in, tiles out; the loader (./load.ts) reads
// the rows and the routes sign links only for what this returns.
//
// The rules (design "SK S7 - Knowledge Layer Design 2026-10-30"):
//   * FINALS ONLY (founder 2026-10-30: "only completed books, no drafts"). A
//     product is listed only when it points at a final release (release_kind
//     'final', release_id set, status approved) and its book + language has a
//     LIVE final in pub_releases (not superseded, not withdrawn). The file a
//     tile serves is that live final — so a newer final reaches existing
//     readers the moment it is released, before the importer has run (design
//     decision 5: "replaces the text for existing buyers automatically").
//     A draft release is never a tile and never a file, whatever the product
//     row says.
//   * ACCESS is skAccess(): school licence → subscription → grant (purchase,
//     code, edition code, staff, promo). Not gated by any SK flag: this is
//     the Library, and a bought book shows even while SK itself is restricted.
//   * PARENTS also see books granted to their VERIFIED children (the same
//     reach the book_access_grants RLS gives them), labelled "for <child>".
//     Only the child's grants count — a child's school licence is the
//     school's, not the family's.
//   * WITHDRAWN: a book with no live final disappears for new readers (the
//     book app: "SK shows it to no new reader"). A reader who already HELD a
//     grant when it was withdrawn keeps the book and its PDF (the design's
//     default: the grant is on the product, book access is permanent since
//     0159). Licences and subscriptions are not purchases, so they do not
//     carry a withdrawn book.

import { skAccess, type Grant, type Subscription } from "@/sk/access";

export type MyBookProduct = {
  id: string;
  slug: string;
  title: string | null;
  status: string | null;
  work_uid: string | null;
  language: string | null;
  release_id: number | null;
  release_kind: string | null;
  cover_key: string | null;
};

export type MyBookRelease = {
  id: number;
  work_uid: string;
  language: string;
  release_kind: string;
  title: string | null;
  chapter_count: number | null;
  digital_pdf_key: string | null;
  cover_key: string | null;
  superseded_by: number | null;
  withdrawn_at: string | null;
};

export type MyBookGrant = Grant & { user_id: string };

export type MyBooksInput = {
  now: Date;
  userId: string;
  products: MyBookProduct[];
  releases: MyBookRelease[];
  schoolLicence: boolean;
  subscriptions: Subscription[];
  /** The reader's own grants AND their verified children's (user_id tells them apart). */
  grants: MyBookGrant[];
  /** Verified children only, with the name the label shows. */
  children: { id: string; name: string }[];
};

export type MyBook = {
  productId: string;
  slug: string;
  title: string;
  language: string;
  chapterCount: number | null;
  releaseId: number;
  coverKey: string | null;
  pdfKey: string | null;
  /** Names of the children the book is for, when the reader holds no access of their own. */
  forChildren: string[];
  /** No longer sold: kept only because the reader held it before the withdrawal. */
  withdrawn: boolean;
};

const lang = (l: string | null | undefined) => (l ?? "").trim().toLowerCase();
const isLive = (r: MyBookRelease) => r.superseded_by == null && r.withdrawn_at == null;
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);

/** The book + language's finals, newest first. Drafts are never in this list. */
function finalsFor(p: MyBookProduct, releases: MyBookRelease[]): MyBookRelease[] {
  return releases
    .filter((r) => r.release_kind === "final" && r.work_uid === p.work_uid && lang(r.language) === lang(p.language))
    .sort((a, b) => Number(b.id) - Number(a.id));
}

/** A grant that was live at `at` (and is not revoked or expired now). */
function heldAt(g: MyBookGrant, productId: string, at: number, now: number): boolean {
  return g.product_id === productId && !g.revoked_at && ms(g.activated_at) <= at && (g.expires_at == null || ms(g.expires_at) > now);
}

export function decideMyBooks(input: MyBooksInput): MyBook[] {
  const now = input.now.getTime();
  const own = input.grants.filter((g) => g.user_id === input.userId);
  const out: MyBook[] = [];

  for (const p of input.products) {
    if (!p.work_uid || !p.language) continue; // not a release-backed product
    if (p.release_kind === "draft") continue; // never, even if a row ever said so
    const finals = finalsFor(p, input.releases);
    const live = finals.find(isLive) ?? null;
    const productLive = !!live && p.status === "approved" && p.release_kind === "final" && p.release_id != null;

    const tile = (r: MyBookRelease, forChildren: string[], withdrawn: boolean): MyBook => ({
      productId: p.id,
      slug: p.slug,
      title: (p.title || r.title || p.slug).trim(),
      language: lang(p.language),
      chapterCount: r.chapter_count ?? null,
      releaseId: Number(r.id),
      coverKey: r.cover_key ?? p.cover_key ?? null,
      pdfKey: r.digital_pdf_key ?? null,
      forChildren,
      withdrawn,
    });

    if (productLive && live) {
      const self = skAccess({ productId: p.id, now: input.now, schoolLicence: input.schoolLicence, subscriptions: input.subscriptions, grants: own });
      if (self.book_access) {
        out.push(tile(live, [], false));
        continue;
      }
      const kids = input.children.filter(
        (c) => skAccess({ productId: p.id, now: input.now, subscriptions: [], grants: input.grants.filter((g) => g.user_id === c.id) }).book_access,
      );
      if (kids.length) out.push(tile(live, kids.map((c) => c.name), false));
      continue;
    }

    // No live final (withdrawn, or the product was retired by the importer):
    // existing grant holders only, on the newest final there was.
    const last = finals[0];
    if (!last) continue;
    const cutoff = last.withdrawn_at ? ms(last.withdrawn_at) : now;
    if (own.some((g) => heldAt(g, p.id, cutoff, now))) {
      out.push(tile(last, [], true));
      continue;
    }
    const kids = input.children.filter((c) => input.grants.some((g) => g.user_id === c.id && heldAt(g, p.id, cutoff, now)));
    if (kids.length) out.push(tile(last, kids.map((c) => c.name), true));
  }

  return out.sort((a, b) => a.title.localeCompare(b.title) || a.language.localeCompare(b.language));
}
