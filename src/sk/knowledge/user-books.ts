// SK S7 K1 — user uploads → knowledge blocks.
//
// chapter_grounding.source_text (written by the worker) is split into
// paragraph blocks of at most 1200 characters (text.ts splitParagraphs).
// version = books.content_hash, or the chapter's updated_at when the book has
// no hash. Language = books.language, else a cheap script guess per chapter
// (Arabic script → 'ar', else 'en') written into the BLOCK, never into books.
//
// Skipped (and any blocks they already have removed):
//   * removed books (books.removed_at);
//   * junk-gated books (health.gate === "confirm", src/utils/junk-gate.ts)
//     unless the teacher CONFIRMED one — the confirmation is recorded on a
//     generation's params.junk_gate (stampConfirmation), so a gated book with
//     such a generation counts as confirmed.
//
// 22.8M characters is large, so it is batched and resumable: a chapter whose
// version is already imported (and imported after its grounding last changed)
// is skipped; each batch (≤ `batch` chapters, ≤ `maxChars` characters) is ONE
// transaction (sk_knowledge_replace); `maxBatches` stops a run early and the
// next run carries on. Service-role client only; no "server-only" import.

import { isGated, type GateHealth } from "../../utils/junk-gate";
import { importedVersions, replaceBlocks, type BlockScope, type KnowledgeBlock, type KnowledgeDb } from "./store";
import { detectLanguage, normLanguage, plain, splitParagraphs } from "./text";

export type UserBookRow = { id: string; language: string | null; content_hash: string | null; removed_at: string | null; health: GateHealth };
export type GroundingMeta = { book_id: string; chapter_num: number; chapter_title: string | null; updated_at: string | null };

/** One chapter's paragraph blocks (pure). */
export function chapterBlocks(
  book: Pick<UserBookRow, "id" | "language" | "content_hash">,
  ch: GroundingMeta,
  sourceText: string,
): KnowledgeBlock[] {
  const language = normLanguage(book.language) ?? detectLanguage(sourceText);
  const version = chapterVersion(book, ch);
  const title = plain(ch.chapter_title ?? "").slice(0, 500);
  return splitParagraphs(sourceText).map((text, i) => ({
    source_kind: "user_book" as const,
    source_id: String(book.id),
    version,
    release_id: null,
    chapter: Number(ch.chapter_num),
    anchor: `p${i + 1}`,
    language,
    title,
    text,
    kind: "paragraph" as const,
  }));
}

export function chapterVersion(book: Pick<UserBookRow, "content_hash">, ch: Pick<GroundingMeta, "updated_at">): string {
  return (book.content_hash ?? "").trim() || (ch.updated_at ?? "").trim() || "unversioned";
}

/** Removed, or junk-gated without a confirmation → not knowledge. */
export function bookExcluded(book: UserBookRow, confirmed: Set<string>): "removed" | "junk_gated" | null {
  if (book.removed_at) return "removed";
  if (isGated(book.health) && !confirmed.has(String(book.id))) return "junk_gated";
  return null;
}

export type UserBookImportResult = {
  dryRun: boolean;
  books: number;
  eligibleBooks: number;
  skippedRemoved: number;
  skippedJunk: number;
  chapters: number;
  chaptersImported: number;
  chaptersUpToDate: number;
  chaptersRemaining: number;
  blocks: number;
  chars: number;
  batches: number;
  cleared: number;
  detectedLanguages: Record<string, number>;
  migrationMissing: boolean;
};

const PAGE = 1000;

async function allRows<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message?: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(`${what} read failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function importUserBooks(
  db: KnowledgeDb,
  opts: { bookIds?: string[]; batch?: number; maxChars?: number; maxBatches?: number; dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<UserBookImportResult> {
  const batch = Math.max(1, opts.batch ?? 50);
  const maxChars = Math.max(10_000, opts.maxChars ?? 1_500_000);
  const log = opts.log ?? (() => {});
  const only = opts.bookIds?.length ? opts.bookIds.map(String) : null;

  // 1. the books and who is in
  const books = await allRows<UserBookRow>((f, t) => {
    let q = db.from("books").select("id, language, content_hash, removed_at, health");
    if (only) q = q.in("id", only);
    return q.order("id", { ascending: true }).range(f, t);
  }, "books");
  const gatedIds = books.filter((b) => !b.removed_at && isGated(b.health)).map((b) => String(b.id));
  const confirmed = new Set<string>();
  for (const ids of chunks(gatedIds, 100)) {
    const { data, error } = await db.from("generations").select("book_id").in("book_id", ids).not("params->junk_gate", "is", null);
    if (error) throw new Error(`generations read failed: ${error.message}`);
    for (const r of (data ?? []) as { book_id: string }[]) confirmed.add(String(r.book_id));
  }
  const reason = new Map(books.map((b) => [String(b.id), bookExcluded(b, confirmed)]));
  const bookById = new Map(books.map((b) => [String(b.id), b]));

  // 2. chapters (no text yet) and what is imported
  const meta = await allRows<GroundingMeta>((f, t) => {
    let q = db.from("chapter_grounding").select("book_id, chapter_num, chapter_title, updated_at");
    if (only) q = q.in("book_id", only);
    return q.order("book_id", { ascending: true }).order("chapter_num", { ascending: true }).range(f, t);
  }, "chapter_grounding");
  const { rows: imported, missing } = await importedVersions(db, "user_book");
  const have = new Map(imported.map((r) => [`${r.source_id}|${r.chapter}`, r]));

  const out: UserBookImportResult = {
    dryRun: !!opts.dryRun,
    books: books.length,
    eligibleBooks: [...reason.values()].filter((r) => r === null).length,
    skippedRemoved: [...reason.values()].filter((r) => r === "removed").length,
    skippedJunk: [...reason.values()].filter((r) => r === "junk_gated").length,
    chapters: 0,
    chaptersImported: 0,
    chaptersUpToDate: 0,
    chaptersRemaining: 0,
    blocks: 0,
    chars: 0,
    batches: 0,
    cleared: 0,
    detectedLanguages: {},
    migrationMissing: missing,
  };

  // 3. excluded books that already have blocks: cleared in the first write
  const clearScopes: BlockScope[] = [];
  for (const id of new Set(imported.map((r) => r.source_id))) {
    if (reason.get(id) !== null && (!only || only.includes(id))) clearScopes.push({ source_kind: "user_book", source_id: id });
  }

  const todo: GroundingMeta[] = [];
  for (const ch of meta) {
    const book = bookById.get(String(ch.book_id));
    if (!book || reason.get(String(ch.book_id)) !== null) continue;
    out.chapters++;
    const prev = have.get(`${ch.book_id}|${ch.chapter_num}`);
    const fresh = prev && prev.version === chapterVersion(book, ch) && (!ch.updated_at || Date.parse(prev.imported_at) >= Date.parse(ch.updated_at));
    if (fresh) out.chaptersUpToDate++;
    else todo.push(ch);
  }

  // 4. batches: one transaction each
  let scopes: BlockScope[] = [...clearScopes];
  let blocks: KnowledgeBlock[] = [];
  let chars = 0;
  let inBatch = 0;
  const flush = async () => {
    if (!scopes.length) return;
    if (!opts.dryRun) await replaceBlocks(db, scopes, blocks);
    out.batches++;
    out.cleared += scopes.filter((s) => s.chapter === undefined).length;
    log(`user books batch ${out.batches}: ${inBatch} chapter(s), +${blocks.length} blocks, ${chars} chars`);
    scopes = [];
    blocks = [];
    chars = 0;
    inBatch = 0;
  };

  const byBook = new Map<string, GroundingMeta[]>();
  for (const ch of todo) byBook.set(String(ch.book_id), [...(byBook.get(String(ch.book_id)) ?? []), ch]);
  let stopped = false;
  for (const [bookId, chs] of byBook) {
    if (stopped) {
      out.chaptersRemaining += chs.length;
      continue;
    }
    const book = bookById.get(bookId)!;
    for (const part of chunks(chs, batch)) {
      if (stopped) {
        out.chaptersRemaining += part.length;
        continue;
      }
      const { data, error } = await db
        .from("chapter_grounding")
        .select("chapter_num, source_text")
        .eq("book_id", bookId)
        .in("chapter_num", part.map((c) => c.chapter_num));
      if (error) throw new Error(`chapter_grounding read failed: ${error.message}`);
      const text = new Map(((data ?? []) as { chapter_num: number; source_text: string | null }[]).map((r) => [Number(r.chapter_num), r.source_text ?? ""]));
      for (const ch of part) {
        if (stopped) {
          out.chaptersRemaining++;
          continue;
        }
        const src = text.get(Number(ch.chapter_num)) ?? "";
        const bs = chapterBlocks(book, ch, src);
        const len = bs.reduce((n, b) => n + b.text.length, 0);
        if (inBatch && (inBatch >= batch || chars + len > maxChars)) {
          await flush();
          if (opts.maxBatches && out.batches >= opts.maxBatches) {
            stopped = true;
            out.chaptersRemaining++;
            continue;
          }
        }
        if (!normLanguage(book.language) && bs.length) out.detectedLanguages[bs[0].language] = (out.detectedLanguages[bs[0].language] ?? 0) + 1;
        scopes.push({ source_kind: "user_book", source_id: bookId, chapter: Number(ch.chapter_num) });
        blocks.push(...bs);
        chars += len;
        inBatch++;
        out.chaptersImported++;
        out.blocks += bs.length;
        out.chars += len;
      }
    }
  }
  if (!stopped) await flush();
  return out;
}
