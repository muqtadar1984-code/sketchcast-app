// SK teacher knowledge tools v1 — library.find and catalogue.availability
// (Final Plan 2026-10-28 §4 row 1, §6 S0).
//
// Both run on the USER-SESSION client only (§2.3): RLS decides which books,
// kits, unlock rows and grants exist, and on top of that every own-row read is
// pinned to ctx.user.id so a school_admin wearing the teacher hat still gets
// THEIR library, not the school's. Nothing here throws: a failed query is
// `{ ok: false, error }`; nothing matching is `{ ok: true, facts: [] }`.
//
// The availability vocabulary and its decision order live in
// src/utils/availability.ts (pure, tested); this file only gathers rows.

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "../shell/types";
import { passagesResult, searchForUser } from "./knowledge";
import {
  decideAvailability,
  textMatches,
  type CatalogueMatch,
  type LibraryMatch,
  type SkBookMatch,
  type UnlockAllowance,
} from "@/utils/availability";

export const LIBRARY_FIND_CAP = 12;
export const AVAILABILITY_CAP = 12;

type BookRow = {
  id: string;
  title: string | null;
  author?: string | null;
  subject: string | null;
  grade: string | null;
  status: string | null;
  chapters: Array<{ num?: number; title?: string | null }> | null;
};
type KitRow = {
  id: string;
  title: string | null;
  status: string | null;
  kind: string | null;
  chapter_ref: string | null;
  book_id: string | null;
  created_at: string | null;
};

const rows = <T>(res: { data: unknown; error: { message?: string } | null } | null | undefined, what: string): T[] => {
  if (!res) return [];
  if (res.error) throw new Error(`${what}: ${res.error.message ?? "query failed"}`);
  return (res.data ?? []) as T[];
};

const fail = (e: unknown): SkCapabilityResult => ({
  ok: false,
  summary: "I could not read that right now.",
  error: e instanceof Error ? e.message : String(e),
});

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === "string" ? (args[key] as string).trim() : "");

// ── The library search (shared by both tools) ────────────────────────────────

export type LibraryHit = {
  kind: "book" | "kit";
  id: string;
  title: string;
  where: "my_library" | "school_shelf";
  status: string | null;
  subject: string | null;
  grade: string | null;
  bookId: string | null;
  kitKind: string | null;
  chapterRef: string | null;
};

/** Own books, the school shelf, own kits — matched on title / subject /
 *  chapter titles (kits also match their source book's title and the chapter
 *  they were made from). Own things first, newest first, capped. */
export async function searchLibrary(ctx: SkContext, deps: SkCapabilityDeps, query: string, cap = LIBRARY_FIND_CAP): Promise<LibraryHit[]> {
  const me = ctx.user.id;
  const db = deps.session;
  const bookCols = "id, title, author, subject, grade, status, chapters";

  const ownBooks = rows<BookRow>(await db.from("books").select(bookCols).eq("owner_id", me).order("created_at", { ascending: false }), "books");
  const shelfBooks = ctx.user.schoolId
    ? rows<BookRow>(
        await db.from("books").select(bookCols).eq("school_id", ctx.user.schoolId).neq("owner_id", me).order("created_at", { ascending: false }),
        "school shelf",
      )
    : [];
  const kits = rows<KitRow>(
    await db
      .from("generations")
      .select("id, title, status, kind, chapter_ref, book_id, created_at")
      .eq("owner_id", me)
      .is("withdrawn_at", null)
      .order("created_at", { ascending: false }),
    "generations",
  );

  const bookById = new Map<string, BookRow>();
  for (const b of [...ownBooks, ...shelfBooks]) bookById.set(b.id, b);
  const chapterTitles = (b: BookRow) => (b.chapters ?? []).map((c) => c?.title ?? null);
  const chapterTitleOf = (b: BookRow | undefined, ref: string | null): string | null => {
    if (!b || ref == null) return null;
    const n = Number(ref);
    if (Number.isNaN(n)) return null;
    return (b.chapters ?? []).find((c) => c?.num === n)?.title ?? null;
  };

  const hits: LibraryHit[] = [];
  const bookHit = (b: BookRow, where: LibraryHit["where"]) => {
    if (!textMatches(query, [b.title, b.subject, b.author, ...chapterTitles(b)])) return;
    hits.push({ kind: "book", id: b.id, title: b.title ?? "Untitled book", where, status: b.status, subject: b.subject, grade: b.grade, bookId: b.id, kitKind: null, chapterRef: null });
  };
  for (const k of kits) {
    const src = k.book_id ? bookById.get(k.book_id) : undefined;
    const chapter = chapterTitleOf(src, k.chapter_ref);
    if (!textMatches(query, [k.title, src?.title, src?.subject, chapter])) continue;
    hits.push({
      kind: "kit",
      id: k.id,
      title: k.title || (chapter ? `${k.kind ?? "kit"}: ${chapter}` : `${k.kind ?? "kit"}`),
      where: "my_library",
      status: k.status,
      subject: src?.subject ?? null,
      grade: src?.grade ?? null,
      bookId: k.book_id,
      kitKind: k.kind,
      chapterRef: k.chapter_ref,
    });
  }
  for (const b of ownBooks) bookHit(b, "my_library");
  for (const b of shelfBooks) bookHit(b, "school_shelf");
  return hits.slice(0, cap);
}

const hitEntity = (h: LibraryHit, via: string): ResolvedEntity => ({
  kind: h.kind === "book" ? "book" : "generation",
  id: h.id,
  label: h.title,
  via,
});

// ── library.find ─────────────────────────────────────────────────────────────

export const libraryFind: SkCapability = {
  meta: {
    name: "library.find",
    description:
      "Search the teacher's own books and kits and the school's book shelf by title, subject or chapter. Returns what exists, where it is (my_library | school_shelf) and its status. When no title matches, it searches the text of her books, articles and uploads instead and returns passages with their source.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Topic, title, subject or chapter words." } },
      required: ["query"],
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["teacher", "school_admin", "coordinator"],
  },
  async handler(ctx, args, deps) {
    const query = str(args, "query");
    if (!query) return { ok: false, summary: "I need a word or two to search for.", error: "query required" };
    try {
      const hits = await searchLibrary(ctx, deps, query);
      // S7 K2: nothing by title, subject or chapter → the TEXT of the books,
      // articles and uploads she may read (knowledge.search's own path).
      if (!hits.length) {
        const k = await searchForUser(ctx, deps, { query }).catch(() => null);
        if (k?.status === "ok" && k.passages.length) {
          const r = passagesResult(ctx, query, k.passages);
          return { ...r, summary: `No title matches '${query}', but the text of your sources does. ${r.summary}`.slice(0, 400) };
        }
      }
      const own = hits.filter((h) => h.where === "my_library");
      const shelf = hits.filter((h) => h.where === "school_shelf");
      const summary = hits.length
        ? `${hits.length} match${hits.length === 1 ? "" : "es"} for '${query}': ${own.length} in your library (${own.filter((h) => h.kind === "kit").length} kits, ${own.filter((h) => h.kind === "book").length} books), ${shelf.length} on the school shelf. First: ${hits
            .slice(0, 3)
            .map((h) => `${h.title} (${h.kind}, ${h.where === "my_library" ? "yours" : "shelf"})`)
            .join("; ")}.`
        : `Nothing in your library or on the school shelf matches '${query}'.`;
      return {
        ok: true,
        summary: summary.slice(0, 400),
        facts: hits.map((h) => ({ kind: h.kind, id: h.id, title: h.title, where: h.where, status: h.status, subject: h.subject, grade: h.grade })),
        entities: hits.slice(0, 5).map((h) => hitEntity(h, "library.find")),
      };
    } catch (e) {
      return fail(e);
    }
  },
};

// ── catalogue.availability ───────────────────────────────────────────────────

type PublicRow = { slug: string; title: string; subject: string | null; language: string };
type UnlockRow = { topic_id: string; unlocked_at: string | null };
type ProductRow = { id: string; slug: string; title: string; subject: string | null };
type GrantRow = { product_id: string; activated_at: string; expires_at: string | null; revoked_at: string | null };

/** A grant that covers the book now: not revoked, started, not expired
 *  (expires_at null = permanent, as in sk/access.ts). */
export const grantIsLive = (g: GrantRow, now: Date): boolean => {
  const t = now.getTime();
  const at = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);
  return !g.revoked_at && at(g.activated_at) <= t && (g.expires_at == null || at(g.expires_at) > t);
};

export const catalogueAvailability: SkCapability = {
  meta: {
    name: "catalogue.availability",
    description:
      "Is there a lesson on this topic, and where: in the teacher's library, on the school shelf, in the ready-made catalogue (unlocked or locked, with the unlock allowance), or as an SK printed book (activated or not). Best source first.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string", description: "The topic or title to look for." } },
      required: ["topic"],
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["teacher", "school_admin", "coordinator"],
  },
  async handler(ctx, args, deps) {
    const topic = str(args, "topic");
    if (!topic) return { ok: false, summary: "I need a topic to look for.", error: "topic required" };
    const me = ctx.user.id;
    const db = deps.session;
    try {
      const hits = await searchLibrary(ctx, deps, topic, AVAILABILITY_CAP);
      const library: LibraryMatch[] = hits.map((h) => ({ kind: h.kind, id: h.id, title: h.title, where: h.where, subject: h.subject }));

      // The catalogue as the signed-in user sees it. public_catalogue() withholds
      // topic ids and topics/topic_kits grant nothing to authenticated, so the
      // own unlock rows (topic ids) cannot be joined to a slug here: no unlock
      // rows ⇒ every kit is locked; otherwise unlocked is unknown (null).
      const pub = rows<PublicRow>(await db.rpc("public_catalogue"), "public_catalogue");
      const matched = pub.filter((p) => textMatches(topic, [p.title, p.subject])).slice(0, AVAILABILITY_CAP);
      let catalogue: CatalogueMatch[] = [];
      let allowance: UnlockAllowance | null = null;
      if (matched.length) {
        const unlocks = rows<UnlockRow>(await db.from("catalogue_unlocks").select("topic_id, unlocked_at").eq("user_id", me), "catalogue_unlocks");
        const unlocked: boolean | null = unlocks.length === 0 ? false : null;
        catalogue = matched.map((p) => ({ slug: p.slug, title: p.title, subject: p.subject, language: p.language, unlocked }));
        const a = await db.rpc("my_catalogue_allowance");
        if (!a?.error && a?.data && typeof a.data === "object") {
          const d = a.data as Partial<UnlockAllowance>;
          allowance = {
            eligible: d.eligible === true,
            reason: typeof d.reason === "string" ? d.reason : null,
            tier: typeof d.tier === "string" ? d.tier : "",
            cap: typeof d.cap === "number" ? d.cap : null,
            used: typeof d.used === "number" ? d.used : 0,
            resets_at: typeof d.resets_at === "string" ? d.resets_at : null,
          };
        }
      }

      // SK printed books (approved products are readable; grants are own rows).
      const products = rows<ProductRow>(await db.from("sk_book_products").select("id, slug, title, subject").eq("status", "approved"), "sk_book_products");
      const bookMatches = products.filter((p) => textMatches(topic, [p.title, p.subject, p.slug])).slice(0, AVAILABILITY_CAP);
      let skBooks: SkBookMatch[] = [];
      if (bookMatches.length) {
        const grants = rows<GrantRow>(
          await db.from("book_access_grants").select("product_id, activated_at, expires_at, revoked_at").eq("user_id", me),
          "book_access_grants",
        );
        const live = new Set(grants.filter((g) => grantIsLive(g, deps.now)).map((g) => g.product_id));
        skBooks = bookMatches.map((p) => ({ id: p.id, slug: p.slug, title: p.title, subject: p.subject, activated: live.has(p.id) }));
      }

      const decision = decideAvailability({ topic, library, catalogue, skBooks, allowance });
      const entities: ResolvedEntity[] = [];
      for (const r of decision.rows.slice(0, 5)) {
        if (!r.id) continue;
        if (r.kind === "book") entities.push({ kind: "book", id: r.id, label: r.title ?? r.id, via: "catalogue.availability" });
        else if (r.kind === "kit") entities.push({ kind: "generation", id: r.id, label: r.title ?? r.id, via: "catalogue.availability" });
        else if (r.kind === "catalogue_kit" || r.kind === "catalogue_topic") entities.push({ kind: "topic", id: r.id, label: r.title ?? r.id, via: "catalogue.availability" });
      }
      return {
        ok: true,
        summary: decision.summary.slice(0, 400),
        facts: decision.rows.slice(0, AVAILABILITY_CAP).map((r) => ({ ...r })),
        entities,
      };
    } catch (e) {
      return fail(e);
    }
  },
};
