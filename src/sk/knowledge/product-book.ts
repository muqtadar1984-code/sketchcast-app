// SketchCast books as Library books (migration 0175) — the product's ONE
// system-owned `books` row, written by the release importer (release.ts)
// whenever a FINAL release is imported.
//
//   books               owner = the catalogue system account (CATALOGUE_OWNER_ID,
//                       the same id src/utils/flags.ts catalogueOwnerId() reads),
//                       sk_product_id = the product, sk_release_id = the final,
//                       chapters in the UPLOADED-BOOK shape: [{num, title}]
//                       with num 0-BASED (the worker's chapter_num, rendered +1
//                       everywhere — books.chapters / generations.chapter_ref).
//                       Release chapter N is book chapter num N-1.
//   chapter_grounding   one row per chapter: source_text = the chapter's section
//                       text and its exercise STEMS — the same text the
//                       knowledge blocks carry (flattenSection / stems). Never
//                       an answer, worked solution, marking scheme or option.
//
// A newer final updates the same row in place (keyed on sk_product_id). The
// book row is not removed when a product loses its live final: readers who
// held a grant keep the book (decideMyBooks keeps a withdrawn book for them).
//
// Tolerates 0175 not being applied: a missing column (42703 / PGRST204) is
// "skipped, migration 0175 not applied" with a log line, never an error.
// No "server-only": the founder's scripts load this under plain Node.

import type { KnowledgeDb } from "./store";
import { flattenSection, normLanguage, plain } from "./text";

/** The bundle slice this module reads (release.ts ReleaseBundle is a superset). */
export type BookBundleChapter = {
  chapter: number;
  title?: string;
  sections?: { sid?: string; title?: string | null; heading?: string | null; blocks?: unknown[] }[];
  exercises?: { xid?: string; stem?: unknown }[];
};

export type ProductBookRow = {
  id: number;
  title: string;
  language: string;
  subject?: string | null;
  grade_band?: string | null;
};

export type ProductBookResult =
  | { status: "created" | "updated" | "unchanged"; book_id: string; chapters: number }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

export const MIGRATION_0175_SKIP = "migration 0175 not applied";
export const NO_OWNER_SKIP = "CATALOGUE_OWNER_ID is not set";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** CATALOGUE_OWNER_ID, read exactly as src/utils/flags.ts catalogueOwnerId() does. */
export function bookOwnerFromEnv(): string | null {
  const s = (process.env.CATALOGUE_OWNER_ID ?? "").trim().toLowerCase();
  return UUID.test(s) ? s : null;
}

type DbErr = { code?: string; message?: string } | null | undefined;

/** A column (or table) 0175 adds that is not there yet. */
export function isMissing0175(e: DbErr): boolean {
  if (!e) return false;
  return ["42703", "42P01", "PGRST204", "PGRST205"].includes(e.code ?? "") || /sk_product_id|sk_release_id|does not exist|schema cache/i.test(e.message ?? "");
}

/** Release chapter N → the book's 0-based num. */
export const bookNum = (releaseChapter: number): number => Number(releaseChapter) - 1;
/** The book's 0-based num → release chapter N (sk_product_kits.chapter_ref). */
export const releaseChapter = (num: number): number => Number(num) + 1;

/** books.chapters for the release, in the uploaded-book shape. */
export function productBookChapters(chapters: BookBundleChapter[]): { num: number; title: string }[] {
  return chapters
    .filter((c) => Number.isInteger(Number(c.chapter)) && Number(c.chapter) >= 1)
    .sort((a, b) => Number(a.chapter) - Number(b.chapter))
    .map((c) => ({ num: bookNum(Number(c.chapter)), title: plain(c.title ?? "") || `Chapter ${c.chapter}` }));
}

/**
 * One chapter's source text: every section ("## heading" then its text, the
 * knowledge blocks' own flattenSection) and then the exercise STEMS, numbered.
 * The answer key never reaches it — stems only, as releaseBlocks().
 */
export function chapterSourceText(c: BookBundleChapter): string {
  const parts: string[] = [];
  for (const s of c.sections ?? []) {
    const heading = plain(s.title ?? s.heading ?? "");
    const body = flattenSection(s);
    if (!body && !heading) continue;
    parts.push(heading ? `## ${heading}\n\n${body}`.trim() : body);
  }
  const stems = (c.exercises ?? []).map((x) => plain(typeof x.stem === "string" ? x.stem : "")).filter(Boolean);
  if (stems.length) parts.push(`## Exercises\n\n${stems.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  return parts.join("\n\n").trim();
}

/** product id → the release its book carries (null = no book yet). `missing` = 0175 not applied. */
export async function productBookReleases(db: KnowledgeDb, productIds: string[]): Promise<{ missing: boolean; releases: Map<string, number | null> }> {
  const releases = new Map<string, number | null>();
  if (!productIds.length) return { missing: false, releases };
  const { data, error } = await db.from("books").select("id, sk_product_id, sk_release_id").in("sk_product_id", productIds);
  if (error) {
    if (isMissing0175(error)) return { missing: true, releases };
    throw new Error(`books read failed: ${error.message ?? error.code ?? "error"}`);
  }
  for (const r of (data ?? []) as { sk_product_id: string; sk_release_id: number | null }[]) {
    releases.set(String(r.sk_product_id), r.sk_release_id == null ? null : Number(r.sk_release_id));
  }
  return { missing: false, releases };
}

/**
 * Upsert the product's system book and its chapter_grounding rows. Never
 * throws: a failure is returned (the import itself already succeeded).
 */
export async function upsertProductBook(
  db: KnowledgeDb,
  input: { productId: string; row: ProductBookRow; chapters: BookBundleChapter[]; ownerId: string | null; dryRun?: boolean },
): Promise<ProductBookResult> {
  try {
    if (!input.ownerId) {
      console.warn(`[sk knowledge] product book skipped for ${input.productId}: ${NO_OWNER_SKIP}`);
      return { status: "skipped", reason: NO_OWNER_SKIP };
    }
    const chapters = productBookChapters(input.chapters);
    const language = normLanguage(input.row.language) ?? "en";
    const releaseId = Number(input.row.id);

    const { data: existingRow, error: readErr } = await db.from("books").select("id, sk_release_id, chapters").eq("sk_product_id", input.productId).maybeSingle();
    if (readErr) {
      if (isMissing0175(readErr)) {
        console.warn(`[sk knowledge] product book skipped for ${input.productId}: ${MIGRATION_0175_SKIP}`);
        return { status: "skipped", reason: MIGRATION_0175_SKIP };
      }
      throw new Error(`books read failed: ${readErr.message ?? readErr.code}`);
    }
    const existing = (existingRow as { id: string; sk_release_id: number | null } | null) ?? null;
    if (input.dryRun) {
      return { status: existing ? (Number(existing.sk_release_id) === releaseId ? "unchanged" : "updated") : "created", book_id: existing?.id ?? "(new)", chapters: chapters.length };
    }

    const fields = {
      title: (input.row.title ?? "").trim() || "SketchCast book",
      language,
      subject: input.row.subject ?? null,
      grade: input.row.grade_band ?? null,
      chapters,
      sk_release_id: releaseId,
      status: "ready",
    };
    let bookId: string;
    let status: "created" | "updated" | "unchanged";
    if (existing) {
      const { error } = await db.from("books").update(fields).eq("id", existing.id);
      if (error) throw new Error(`books update failed: ${error.message ?? error.code}`);
      bookId = existing.id;
      status = Number(existing.sk_release_id) === releaseId ? "unchanged" : "updated";
    } else {
      // owner = the system account; school_id null; no storage_path (no PDF):
      // 0175's WHEN clause keeps on_book_created from queuing indexing.
      const { data, error } = await db
        .from("books")
        .insert({ ...fields, owner_id: input.ownerId, sk_product_id: input.productId, school_id: null })
        .select("id")
        .single();
      if (error) {
        if (isMissing0175(error)) return { status: "skipped", reason: MIGRATION_0175_SKIP };
        throw new Error(`books insert failed: ${error.message ?? error.code}`);
      }
      bookId = String((data as { id: string }).id);
      status = "created";
    }

    // chapter_grounding: one row per chapter; a changed text drops the cached
    // concept analysis (it described the old text); chapters the release no
    // longer has are removed.
    const { data: groundRows, error: gErr } = await db.from("chapter_grounding").select("chapter_num, source_text").eq("book_id", bookId);
    if (gErr) throw new Error(`chapter_grounding read failed: ${gErr.message ?? gErr.code}`);
    const before = new Map(((groundRows ?? []) as { chapter_num: number; source_text: string | null }[]).map((r) => [Number(r.chapter_num), r.source_text]));
    const now = new Date().toISOString();
    const byNum = new Map(input.chapters.map((c) => [bookNum(Number(c.chapter)), c]));
    const rows = chapters.map((c) => {
      const text = chapterSourceText(byNum.get(c.num)!);
      const changed = before.has(c.num) && before.get(c.num) !== text;
      return { book_id: bookId, chapter_num: c.num, chapter_title: c.title, source_text: text || null, updated_at: now, ...(changed ? { concepts: null } : {}) };
    });
    // two batches so every row in a batch has the same columns
    for (const batch of [rows.filter((r) => "concepts" in r), rows.filter((r) => !("concepts" in r))]) {
      if (!batch.length) continue;
      const { error } = await db.from("chapter_grounding").upsert(batch, { onConflict: "book_id,chapter_num" });
      if (error) throw new Error(`chapter_grounding upsert failed: ${error.message ?? error.code}`);
    }
    const stale = [...before.keys()].filter((n) => !chapters.some((c) => c.num === n));
    if (stale.length) {
      const { error } = await db.from("chapter_grounding").delete().eq("book_id", bookId).in("chapter_num", stale);
      if (error) throw new Error(`chapter_grounding delete failed: ${error.message ?? error.code}`);
    }
    return { status, book_id: bookId, chapters: chapters.length };
  } catch (e) {
    const error = (e as Error).message ?? String(e);
    console.error(`[sk knowledge] product book failed for ${input.productId}:`, error);
    return { status: "error", error };
  }
}
