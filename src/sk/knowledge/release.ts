// SK S7 K1 — the book-release importer (BOOK-RELEASES-CONTRACT-2026-10-30).
//
// The book app writes a release: a pub_releases row (its migration 0172) and a
// bundle `sketchcast.book-release/1` at books/<slug>/editions/<edition_key>/
// bundle.json in the books bucket. SK only READS both, with the service role,
// and never writes pub_* (the contract).
//
// importRelease(admin, s3, row)
//   1. a superseded or withdrawn row → nothing of it is imported; that book +
//      language is reconciled instead (its live release, or unavailable);
//   2. already imported and still the product's release → skipped (idempotent);
//   3. a draft while the product's FINAL is live → skipped (finals win; SK may
//      hide drafts once a final exists — the contract);
//   4. fetch bundle.json, check the bundle hash against the row, the schema,
//      and EVERY chapter's content_sha256 by the contract's rule
//      (canonical-json.ts) — any mismatch refuses the whole release;
//   5. replace that work + language's blocks with this release's: section
//      text and exercise STEMS. `answer`, `worked_solution`, `marking_scheme`
//      and the options never become blocks (they are the answer key);
//   6. upsert the product (one per work_uid + language) and log the import.
// pollReleases(admin)
//   reads the LIVE rows (superseded_by is null and withdrawn_at is null),
//   picks one per book + language (the newest final, else the newest draft),
//   imports what changed and marks products whose releases all went away
//   unavailable. pub_releases missing (0172 not applied) → waiting_for_book_app.

import { chapterContentSha256, parseRawJson, sha256Hex, type RawJson } from "./canonical-json";
import { isMissingRelation, replaceBlocks, uniqueAnchors, type KnowledgeBlock, type KnowledgeDb } from "./store";
import { chunkText, flattenSection, normLanguage, plain } from "./text";

export const BUNDLE_SCHEMA = "sketchcast.book-release/1";

export type ReleaseRow = {
  id: number;
  work_uid: string;
  slug: string;
  release_kind: "final" | "draft";
  edition_key: string;
  language: string;
  revision_key?: string | null;
  title: string;
  subject?: string | null;
  chapters?: { chapter: number; title?: string; content_sha256: string }[] | null;
  bundle_key: string;
  bundle_sha256: string;
  cover_key?: string | null;
  released_at?: string | null;
  superseded_by: number | null;
  withdrawn_at: string | null;
};

/** Reads one object from the books bucket. */
export type BundleReader = { getBytes(key: string): Promise<Uint8Array> };

type BundleSection = { sid?: string; title?: string | null; heading?: string | null; blocks?: unknown[] };
type BundleExercise = { xid?: string; stem?: unknown };
type BundleChapter = { chapter: number; title?: string; content_sha256?: string; sections?: BundleSection[]; exercises?: BundleExercise[] };
export type ReleaseBundle = {
  schema: string;
  release: { id: number; release_kind?: string; edition_key?: string };
  work: { uid: string; slug?: string; title?: string; language?: string; cover?: { store?: string; path?: string } | null };
  chapters: BundleChapter[];
};

export type ImportResult =
  | { status: "ok"; release_id: number; blocks: number; product_id: string }
  | { status: "skipped"; release_id: number; reason: string; reconciled?: ReconcileResult }
  | { status: "error"; release_id: number; error: string };

export type ReconcileResult =
  | { status: "imported"; result: ImportResult }
  | { status: "unavailable"; product_id: string | null }
  | { status: "waiting_for_book_app" };

const live = (r: Pick<ReleaseRow, "superseded_by" | "withdrawn_at">) => r.superseded_by == null && r.withdrawn_at == null;

// ── pure: bundle checks and blocks ─────────────────────────────────────────

/** Every reason this bundle may not be imported for this row ([] = fine). */
export function verifyBundle(row: ReleaseRow, bytes: Uint8Array): { bundle: ReleaseBundle | null; problems: string[] } {
  const problems: string[] = [];
  const got = sha256Hex(bytes);
  if (row.bundle_sha256 && got !== row.bundle_sha256.toLowerCase()) problems.push(`bundle sha256 ${got.slice(0, 12)}… does not match the release row`);
  let text: string;
  let bundle: ReleaseBundle;
  let raw: RawJson;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    bundle = JSON.parse(text) as ReleaseBundle;
    raw = parseRawJson(text);
  } catch (e) {
    return { bundle: null, problems: [...problems, `bundle is not valid UTF-8 JSON: ${(e as Error).message}`] };
  }
  if (bundle?.schema !== BUNDLE_SCHEMA) problems.push(`schema is ${JSON.stringify(bundle?.schema)}, not ${BUNDLE_SCHEMA}`);
  if (Number(bundle?.release?.id) !== Number(row.id)) problems.push(`bundle release.id ${bundle?.release?.id} is not row ${row.id}`);
  if (bundle?.work?.uid !== row.work_uid) problems.push(`bundle work.uid ${bundle?.work?.uid} is not ${row.work_uid}`);
  if (bundle?.work?.language && bundle.work.language !== row.language) problems.push(`bundle language ${bundle.work.language} is not ${row.language}`);
  const chapters = Array.isArray(bundle?.chapters) ? bundle.chapters : [];
  const rawChapters = (raw as { chapters?: RawJson[] })?.chapters;
  if (!chapters.length || !Array.isArray(rawChapters) || rawChapters.length !== chapters.length) problems.push("bundle has no chapters");
  const declared = new Map((row.chapters ?? []).map((c) => [Number(c.chapter), String(c.content_sha256 ?? "").toLowerCase()]));
  chapters.forEach((c, i) => {
    const rc = (rawChapters?.[i] ?? {}) as { [k: string]: RawJson };
    const computed = chapterContentSha256(rc);
    const stated = String(c.content_sha256 ?? "").toLowerCase();
    if (!stated) problems.push(`chapter ${c.chapter}: no content_sha256`);
    else if (computed !== stated) problems.push(`chapter ${c.chapter}: content_sha256 does not match its sections and exercises`);
    const onRow = declared.get(Number(c.chapter));
    if (declared.size && onRow !== stated) problems.push(`chapter ${c.chapter}: hash differs from the release row`);
  });
  return { bundle, problems };
}

/** The release's blocks: one per section (cut at the 8000 cap) and one per exercise STEM. */
export function releaseBlocks(row: ReleaseRow, bundle: ReleaseBundle): KnowledgeBlock[] {
  const language = normLanguage(row.language) ?? "en";
  const base = { source_kind: "sketchcast_book" as const, source_id: row.work_uid, version: String(row.id), release_id: Number(row.id), language };
  const out: KnowledgeBlock[] = [];
  for (const ch of bundle.chapters ?? []) {
    const chapter = Number(ch.chapter);
    const chapterTitle = plain(ch.title ?? "");
    (ch.sections ?? []).forEach((s, i) => {
      const sid = (s.sid ?? "").trim() || `s${i + 1}`;
      const title = plain(s.title ?? s.heading ?? "") || chapterTitle;
      chunkText(flattenSection(s)).forEach((text, k) => {
        out.push({ ...base, chapter, anchor: k ? `${sid}~${k + 1}` : sid, title, text, kind: "section" });
      });
    });
    (ch.exercises ?? []).forEach((x, i) => {
      // the STEM only — never answer / worked_solution / marking_scheme / options
      const stem = plain(typeof x.stem === "string" ? x.stem : "");
      if (!stem) return;
      const xid = (typeof x.xid === "string" && x.xid.trim()) || `x${i + 1}`;
      chunkText(stem).forEach((text, k) => {
        out.push({ ...base, chapter, anchor: k ? `${xid}~${k + 1}` : xid, title: chapterTitle, text, kind: "exercise_stem" });
      });
    });
  }
  return uniqueAnchors(out);
}

// ── database ──────────────────────────────────────────────────────────────

type ProductRow = { id: string; slug: string; status: string; work_uid: string | null; language: string | null; release_id: number | null; release_kind: string | null };
const PRODUCT_COLS = "id, slug, status, work_uid, language, release_id, release_kind";

async function productFor(db: KnowledgeDb, workUid: string, language: string): Promise<ProductRow | null> {
  const { data, error } = await db.from("sk_book_products").select(PRODUCT_COLS).eq("work_uid", workUid).eq("language", language).maybeSingle();
  if (error) throw new Error(`sk_book_products read failed: ${error.message}`);
  return (data as ProductRow | null) ?? null;
}

async function freeSlug(db: KnowledgeDb, slug: string, language: string, releaseId: number): Promise<string> {
  for (const s of [slug, `${slug}-${language}`, `${slug}-${language}-${releaseId}`]) {
    const { data } = await db.from("sk_book_products").select("id").eq("slug", s).maybeSingle();
    if (!data) return s;
  }
  return `${slug}-${language}-${releaseId}-${Date.now()}`;
}

/** One product per (work_uid, language); Biology-style rows (same slug, no work_uid yet) are adopted. */
async function upsertProduct(db: KnowledgeDb, row: ReleaseRow, bundle: ReleaseBundle): Promise<string> {
  const language = normLanguage(row.language) ?? "en";
  let existing = await productFor(db, row.work_uid, language);
  if (!existing) {
    const { data } = await db.from("sk_book_products").select(PRODUCT_COLS).eq("slug", row.slug).is("work_uid", null).maybeSingle();
    existing = (data as ProductRow | null) ?? null;
  }
  const link = {
    work_uid: row.work_uid,
    language,
    release_id: Number(row.id),
    edition_key: row.edition_key,
    release_kind: row.release_kind,
    cover_key: row.cover_key ?? bundle.work?.cover?.path ?? null,
    title: row.title,
  };
  if (existing) {
    // a final makes the product approved; a draft leaves an approved product as it is
    const status = row.release_kind === "final" ? "approved" : existing.status === "retired" ? "draft" : existing.status;
    const { error } = await db.from("sk_book_products").update({ ...link, status }).eq("id", existing.id);
    if (error) throw new Error(`sk_book_products update failed: ${error.message}`);
    return existing.id;
  }
  const { data, error } = await db
    .from("sk_book_products")
    .insert({
      ...link,
      slug: await freeSlug(db, row.slug, language, Number(row.id)),
      languages: [language],
      status: row.release_kind === "final" ? "approved" : "draft",
      manuscript_version: row.revision_key ?? null,
      subject: row.subject ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`sk_book_products insert failed: ${error.message}`);
  return (data as { id: string }).id;
}

async function logImport(db: KnowledgeDb, row: ReleaseRow, status: "ok" | "error" | "skipped", blocks: number, error: string | null): Promise<void> {
  const { error: e } = await db
    .from("sk_release_imports")
    .upsert({ release_id: Number(row.id), work_uid: row.work_uid, imported_at: new Date().toISOString(), blocks, status, error: error ? error.slice(0, 2000) : null }, { onConflict: "release_id" });
  if (e) console.error("[sk knowledge] import log failed:", e.message);
}

async function importedOk(db: KnowledgeDb, releaseId: number): Promise<boolean> {
  const { data } = await db.from("sk_release_imports").select("status").eq("release_id", releaseId).maybeSingle();
  return (data as { status?: string } | null)?.status === "ok";
}

async function liveReleases(db: KnowledgeDb, filter?: { work_uid: string; language: string }): Promise<{ rows: ReleaseRow[]; missing: boolean }> {
  let q = db.from("pub_releases").select("*").is("superseded_by", null).is("withdrawn_at", null);
  if (filter) q = q.eq("work_uid", filter.work_uid).eq("language", filter.language);
  const { data, error } = await q.order("id", { ascending: true });
  if (error) {
    if (isMissingRelation(error)) return { rows: [], missing: true };
    throw new Error(`pub_releases read failed: ${error.message}`);
  }
  return { rows: ((data ?? []) as ReleaseRow[]).filter(live), missing: false };
}

/** The release a book + language should show: the newest live final, else the newest live draft. */
export function pickRelease(rows: ReleaseRow[]): ReleaseRow | null {
  const liveRows = rows.filter(live);
  const newest = (kind: string) => liveRows.filter((r) => r.release_kind === kind).sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
  return newest("final") ?? newest("draft");
}

/** No live release left: the product's blocks go and it is marked unavailable. */
async function markUnavailable(db: KnowledgeDb, workUid: string, language: string): Promise<string | null> {
  await replaceBlocks(db, [{ source_kind: "sketchcast_book", source_id: workUid, language }], []);
  const product = await productFor(db, workUid, language);
  if (!product) return null;
  const { error } = await db
    .from("sk_book_products")
    .update({ status: "retired", release_id: null, release_kind: null, edition_key: null })
    .eq("id", product.id);
  if (error) throw new Error(`sk_book_products update failed: ${error.message}`);
  return product.id;
}

/** Point a book + language at its live release, or mark it unavailable. */
export async function reconcileWork(db: KnowledgeDb, s3: BundleReader, workUid: string, language: string): Promise<ReconcileResult> {
  const { rows, missing } = await liveReleases(db, { work_uid: workUid, language });
  if (missing) return { status: "waiting_for_book_app" };
  const pick = pickRelease(rows);
  if (pick) return { status: "imported", result: await importRelease(db, s3, pick) };
  return { status: "unavailable", product_id: await markUnavailable(db, workUid, normLanguage(language) ?? language) };
}

export type ImportOptions = { dryRun?: boolean };

export async function importRelease(db: KnowledgeDb, s3: BundleReader, row: ReleaseRow, opts: ImportOptions = {}): Promise<ImportResult> {
  const releaseId = Number(row.id);
  try {
    const language = normLanguage(row.language);
    if (!language) throw new Error(`release language ${JSON.stringify(row.language)} is not a language code`);

    if (!live(row)) {
      const reason = row.withdrawn_at != null ? "withdrawn" : `superseded by ${row.superseded_by}`;
      if (opts.dryRun) return { status: "skipped", release_id: releaseId, reason };
      await logImport(db, row, "skipped", 0, reason);
      return { status: "skipped", release_id: releaseId, reason, reconciled: await reconcileWork(db, s3, row.work_uid, language) };
    }

    const product = await productFor(db, row.work_uid, language);
    if (product?.release_id === releaseId && (await importedOk(db, releaseId))) {
      return { status: "skipped", release_id: releaseId, reason: "already imported" };
    }
    if (row.release_kind === "draft" && product?.release_kind === "final" && product.release_id != null) {
      const { data } = await db.from("pub_releases").select("id, superseded_by, withdrawn_at").eq("id", product.release_id).maybeSingle();
      if (data && live(data as ReleaseRow)) {
        const reason = `final release ${product.release_id} is live for this book`;
        if (!opts.dryRun) await logImport(db, row, "skipped", 0, reason);
        return { status: "skipped", release_id: releaseId, reason };
      }
    }

    const bytes = await s3.getBytes(row.bundle_key);
    const { bundle, problems } = verifyBundle(row, bytes);
    if (!bundle || problems.length) throw new Error(`refused: ${problems.join("; ")}`);

    const blocks = releaseBlocks(row, bundle);
    if (opts.dryRun) return { status: "ok", release_id: releaseId, blocks: blocks.length, product_id: product?.id ?? "(new)" };
    await replaceBlocks(db, [{ source_kind: "sketchcast_book", source_id: row.work_uid, language }], blocks);
    const productId = await upsertProduct(db, row, bundle);
    await logImport(db, row, "ok", blocks.length, null);
    return { status: "ok", release_id: releaseId, blocks: blocks.length, product_id: productId };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    if (!opts.dryRun) await logImport(db, row, "error", 0, message);
    return { status: "error", release_id: releaseId, error: message };
  }
}

export type PollResult =
  | { status: "waiting_for_book_app" }
  | { status: "ok"; live: number; imported: number[]; unchanged: number[]; skipped: number[]; unavailable: string[]; errors: { release_id: number; error: string }[] };

/** Import every live release that changed; mark books with no live release unavailable. */
export async function pollReleases(db: KnowledgeDb, deps: { s3?: BundleReader } = {}): Promise<PollResult> {
  const { rows, missing } = await liveReleases(db);
  if (missing) return { status: "waiting_for_book_app" };

  const { data: prodData, error: prodErr } = await db.from("sk_book_products").select(PRODUCT_COLS).not("work_uid", "is", null);
  if (prodErr) throw new Error(`sk_book_products read failed: ${prodErr.message}`);
  const products = (prodData ?? []) as ProductRow[];
  const { data: okData } = await db.from("sk_release_imports").select("release_id").eq("status", "ok");
  const ok = new Set(((okData ?? []) as { release_id: number }[]).map((r) => Number(r.release_id)));

  const key = (w: string, l: string) => `${w}\u0000${normLanguage(l) ?? l}`;
  const byBook = new Map<string, ReleaseRow[]>();
  for (const r of rows) byBook.set(key(r.work_uid, r.language), [...(byBook.get(key(r.work_uid, r.language)) ?? []), r]);
  const productByBook = new Map(products.map((p) => [key(p.work_uid ?? "", p.language ?? ""), p]));

  const out: Extract<PollResult, { status: "ok" }> = { status: "ok", live: rows.length, imported: [], unchanged: [], skipped: [], unavailable: [], errors: [] };
  let s3 = deps.s3 ?? null;
  for (const [k, list] of byBook) {
    const pick = pickRelease(list);
    if (!pick) continue;
    const p = productByBook.get(k);
    if (p && Number(p.release_id) === Number(pick.id) && ok.has(Number(pick.id))) {
      out.unchanged.push(Number(pick.id));
      continue;
    }
    s3 ??= (await import("./s3")).booksBundleReader;
    const r = await importRelease(db, s3, pick);
    if (r.status === "ok") out.imported.push(r.release_id);
    else if (r.status === "skipped") out.skipped.push(r.release_id);
    else out.errors.push({ release_id: r.release_id, error: r.error });
  }
  for (const p of products) {
    if (!p.work_uid || !p.language || byBook.has(key(p.work_uid, p.language))) continue;
    if (p.status === "retired" && p.release_id == null) continue;
    await markUnavailable(db, p.work_uid, p.language);
    out.unavailable.push(p.id);
  }
  return out;
}
