// The Classroom Board's pickers (founder 2026-10-30: "my books or readymade
// kits are not showing up here on the board").
//
// BOOKS: the book picker lists whatever `books` the teacher may read — her
// own, her school's shelf, and since 0175 every SketchCast book she holds a
// grant for (books_sk_product_read). A SketchCast book is marked `product`:
// picking one of its chapters ADOPTS that chapter's kit (adopt_product_kit)
// and plays the copy as a ready-made kit, because the session and kit routes
// only ever play a kit she owns.
//
// READY-MADE KITS: every catalogue kit she can open, not only the ones
// already copied into her library. Hers first (newest first, one per title —
// kitGroups), then the catalogue's current kits she has not copied yet. "Can
// open" is the catalogue's own rule (src/app/api/catalogue/logic.ts and
// adopt_catalogue_piece): a topic she has UNLOCKED; or, on an unlimited tier
// (my_catalogue_allowance cap null — school, staff), any current kit, since
// unlocking costs her nothing there. A capped tier's locked kit is NOT offered:
// unlocking spends her weekly allowance, which the Kits tab asks about and the
// Board never does silently. Picking an offered kit adopts it (free: a copy,
// no job, no credit), then plays it.
//
// Pure: rows in, options out.

import { kitGroups, kitPrefix, type KitGroupRow } from "./kit";

/** Picking this id means "adopt catalogue kit <topic_kit_id> first". */
export const CATALOGUE_PICK = "catalogue:";

export type BoardBookRow = { id: string; title: string; grade?: string | null; subject?: string | null; chapters?: unknown; sk_product_id?: string | null };
export type BoardBook = { id: string; title: string; grade: string | null; subject: string | null; chapters: { num: number; title?: string }[]; product?: true };

export function boardBooks(rows: BoardBookRow[]): BoardBook[] {
  return rows.map((b) => ({
    id: b.id,
    title: b.title,
    grade: b.grade ?? null,
    subject: b.subject ?? null,
    chapters: Array.isArray(b.chapters) ? (b.chapters as { num: number; title?: string }[]) : [],
    ...(b.sk_product_id ? { product: true as const } : {}),
  }));
}

export type OwnKitRow = KitGroupRow & { params?: Record<string, unknown> | null };
export type CatalogueOffer = { topicKitId: string; topicId: string; presentationId: string; title: string | null };
export type BoardKit = { id: string; title: string; adopt?: { catalogueKit: string } };

const refOf = (r: OwnKitRow) => {
  const ref = r.params?.catalogue_ref as { topic_id?: unknown; topic_kit_id?: unknown; source_generation_id?: unknown } | undefined;
  return ref && typeof ref === "object" ? ref : null;
};

export function boardKits(input: { own: OwnKitRow[]; offers: CatalogueOffer[]; unlocked: ReadonlySet<string>; unlimited: boolean }): BoardKit[] {
  const mine: BoardKit[] = kitGroups(input.own);
  // a topic she already copied (any version of its kit) is hers, not an offer
  const haveTopics = new Set<string>();
  const haveSources = new Set<string>();
  for (const r of input.own) {
    const ref = refOf(r);
    if (typeof ref?.topic_id === "string") haveTopics.add(ref.topic_id);
    if (typeof ref?.source_generation_id === "string") haveSources.add(ref.source_generation_id);
  }
  const taken = new Set(mine.map((k) => k.title));
  const offers: BoardKit[] = [];
  for (const o of input.offers) {
    if (haveTopics.has(o.topicId) || haveSources.has(o.presentationId)) continue;
    if (!input.unlocked.has(o.topicId) && !input.unlimited) continue;
    const title = kitPrefix(o.title);
    if (!title || taken.has(title)) continue;
    taken.add(title);
    offers.push({ id: `${CATALOGUE_PICK}${o.topicKitId}`, title, adopt: { catalogueKit: o.topicKitId } });
  }
  offers.sort((a, b) => a.title.localeCompare(b.title));
  return [...mine, ...offers];
}
