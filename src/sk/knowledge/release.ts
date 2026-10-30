// SK S7 K1 — the book-release importer (BOOK-RELEASES-CONTRACT-2026-10-30).
//
// The book app writes a release: a pub_releases row (its migration 0172) and a
// bundle `sketchcast.book-release/1` at books/<slug>/editions/<edition_key>/
// bundle.json in the books bucket. SK only READS both, with the service role,
// and never writes pub_* (the contract).
//
// FINALS ONLY (founder 2026-10-30: "for books, use only completed books. no
// drafts."). A draft release is never imported: no product, no blocks; it is
// logged as skipped. A product only ever points at a final release; if draft
// blocks were ever imported they are removed. release_kind stays on the
// product (always 'final' when set).
//
// importRelease(admin, s3, row)
//   1. a draft → skipped and logged; any blocks of a draft the product pointed
//      at are removed (the book falls back to its live final, or unavailable);
//   2. a superseded or withdrawn final → nothing of it is imported; that book +
//      language is reconciled instead (its live final, or unavailable);
//   3. already imported and still the product's release → skipped (idempotent);
//   4. fetch bundle.json, check the bundle hash against the row, the schema,
//      and EVERY chapter's content_sha256 by the contract's rule
//      (canonical-json.ts), and every chapter's approval ({kind: 'gate_d' |
//      'book', id}; gate_d_approval_id required only for 'gate_d') — any
//      mismatch refuses the whole release;
//   5. replace that work + language's blocks with this release's: section
//      text and exercise STEMS. `answer`, `worked_solution`, `marking_scheme`
//      and the options never become blocks (they are the answer key);
//   6. upsert the product (one per work_uid + language, status approved) and
//      log the import.
// pollReleases(admin)
//   reads the LIVE rows (superseded_by is null and withdrawn_at is null),
//   picks the newest live FINAL per book + language, imports what changed,
//   logs each live draft once as skipped, and marks products with no live
//   final unavailable. pub_releases missing → waiting_for_book_app; SK's 0174
//   not applied → waiting_for_0174.

import { chapterContentSha256, parseRawJson, sha256Hex, type RawJson } from "./canonical-json";
import { isMissingRelation, replaceBlocks, uniqueAnchors, type KnowledgeBlock, type KnowledgeDb } from "./store";
import { chunkText, flattenSection, normLanguage, plain } from "./text";

export const BUNDLE_SCHEMA = "sketchcast.book-release/1";

export type ReleaseRow = {
  // the production columns of pub_releases (book app migration 0172, applied 2026-10-30)
  id: number;
  work_uid: string;
  slug: string;
  release_kind: "final" | "draft";
  edition_key: string;
  language: string;
  revision_key: string;
  gate_e_approval_id?: number | null;
  title: string;
  subtitle?: string | null;
  subject?: string | null;
  curriculum_code?: string | null;
  grade_band?: string | null;
  age_band?: string | null;
  chapters: ReleaseRowChapter[];
  chapter_count?: number;
  bundle_key: string;
  bundle_sha256: string;
  digital_pdf_key?: string | null; // null for a draft
  digital_pdf_sha256?: string | null;
  print_pdf_key?: string | null;
  print_pdf_sha256?: string | null;
  cover_key?: string | null; // null for a draft
  cover_sha256?: string | null;
  released_by?: string;
  released_at?: string;
  run_id?: number | null;
  superseded_by: number | null;
  withdrawn_at: string | null;
  withdrawn_reason?: string | null;
  withdrawn_by?: string | null;
};

/**
 * One entry of pub_releases.chapters. Contract change 2026-10-30: a chapter is
 * approved either at Gate D (`approval_kind 'gate_d'`, gate_d_approval_id set)
 * or by a BOOK-level approval (`'book'`, e.g. Biology r4.1 for ch 2–10), in
 * which case gate_d_approval_id is null. `approval_id` is the approval either way.
 */
export type ApprovalKind = "gate_d" | "book";
export type ReleaseRowChapter = {
  chapter: number;
  title?: string;
  content_sha256: string;
  approval_id?: number | null;
  approval_kind?: ApprovalKind | null;
  gate_d_approval_id?: number | null;
  pdf_key?: string | null;
};
export const APPROVAL_KINDS: readonly ApprovalKind[] = ["gate_d", "book"];

/** Reads one object from the books bucket. */
export type BundleReader = { getBytes(key: string): Promise<Uint8Array> };

type BundleSection = { sid?: string; title?: string | null; heading?: string | null; blocks?: unknown[] };
type BundleExercise = { xid?: string; stem?: unknown };
export type BundleApproval = { kind?: string; id?: number | string | null; by?: string; on?: string };
type BundleChapter = { chapter: number; title?: string; content_sha256?: string; approval?: BundleApproval | null; sections?: BundleSection[]; exercises?: BundleExercise[] };
export type ReleaseBundle = {
  schema: string;
  release: { id?: number | null; release_kind?: string; edition_key?: string };
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
  // The real bundle (first release, 2026-10-30) is written BEFORE its row exists,
  // so it carries no release.id: the edition key (unique per work) ties it to the
  // row instead. An id, when present, must still match.
  if (bundle?.release?.id != null && Number(bundle.release.id) !== Number(row.id)) problems.push(`bundle release.id ${bundle.release.id} is not row ${row.id}`);
  if (bundle?.release?.edition_key !== row.edition_key) problems.push(`bundle edition_key ${JSON.stringify(bundle?.release?.edition_key)} is not ${row.edition_key}`);
  if (bundle?.release?.release_kind && bundle.release.release_kind !== row.release_kind) problems.push(`bundle release_kind ${bundle.release.release_kind} is not ${row.release_kind}`);
  if (bundle?.work?.uid !== row.work_uid) problems.push(`bundle work.uid ${bundle?.work?.uid} is not ${row.work_uid}`);
  if (bundle?.work?.language && bundle.work.language !== row.language) problems.push(`bundle language ${bundle.work.language} is not ${row.language}`);
  const chapters = Array.isArray(bundle?.chapters) ? bundle.chapters : [];
  const rawChapters = (raw as { chapters?: RawJson[] })?.chapters;
  if (!chapters.length || !Array.isArray(rawChapters) || rawChapters.length !== chapters.length) problems.push("bundle has no chapters");
  const declared = new Map((row.chapters ?? []).map((c) => [Number(c.chapter), String(c.content_sha256 ?? "").toLowerCase()]));
  const rowChapters = new Map((row.chapters ?? []).map((c) => [Number(c.chapter), c]));
  chapters.forEach((c, i) => {
    const rc = (rawChapters?.[i] ?? {}) as { [k: string]: RawJson };
    const computed = chapterContentSha256(rc);
    const stated = String(c.content_sha256 ?? "").toLowerCase();
    if (!stated) problems.push(`chapter ${c.chapter}: no content_sha256`);
    else if (computed !== stated) problems.push(`chapter ${c.chapter}: content_sha256 does not match its sections and exercises`);
    const onRow = declared.get(Number(c.chapter));
    if (declared.size && onRow !== stated) problems.push(`chapter ${c.chapter}: hash differs from the release row`);
    problems.push(...approvalProblems(c, rowChapters.get(Number(c.chapter))));
  });
  return { bundle, problems };
}

/**
 * A chapter's approval, by the contract (2026-10-30): `approval` is
 * {kind: 'gate_d'|'book', id, by, on}; the id is required either way. A
 * 'gate_d' chapter's row entry must carry its gate_d_approval_id; a 'book'
 * chapter's need not (it is null there). When the row states approval_kind /
 * approval_id / gate_d_approval_id they must agree with the bundle.
 */
export function approvalProblems(c: BundleChapter, onRow?: ReleaseRowChapter): string[] {
  const out: string[] = [];
  const a = c.approval;
  const kind = a?.kind;
  if (!a || typeof a !== "object") return [`chapter ${c.chapter}: no approval`];
  if (!APPROVAL_KINDS.includes(kind as ApprovalKind)) out.push(`chapter ${c.chapter}: approval kind ${JSON.stringify(kind ?? null)} is not gate_d or book`);
  const id = a.id == null || a.id === "" ? null : Number(a.id);
  if (id == null || !Number.isFinite(id)) out.push(`chapter ${c.chapter}: approval has no id`);
  if (!onRow) return out;
  if (onRow.approval_kind != null && onRow.approval_kind !== kind) out.push(`chapter ${c.chapter}: approval kind ${kind} differs from the release row (${onRow.approval_kind})`);
  if (onRow.approval_id != null && id != null && Number(onRow.approval_id) !== id) out.push(`chapter ${c.chapter}: approval id ${id} differs from the release row (${onRow.approval_id})`);
  if (kind === "gate_d") {
    if (onRow.gate_d_approval_id == null) out.push(`chapter ${c.chapter}: a gate_d approval needs gate_d_approval_id on the release row`);
    else if (id != null && Number(onRow.gate_d_approval_id) !== id) out.push(`chapter ${c.chapter}: gate_d_approval_id ${onRow.gate_d_approval_id} is not the approval id ${id}`);
  }
  return out;
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
    // only finals reach here: the product is approved
    const { error } = await db.from("sk_book_products").update({ ...link, status: "approved" }).eq("id", existing.id);
    if (error) throw new Error(`sk_book_products update failed: ${error.message}`);
    return existing.id;
  }
  const { data, error } = await db
    .from("sk_book_products")
    .insert({
      ...link,
      slug: await freeSlug(db, row.slug, language, Number(row.id)),
      languages: [language],
      status: "approved",
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

/** Why a draft is never imported (logged on its sk_release_imports row). */
export const DRAFT_SKIP_REASON = "draft releases are not used (founder 2026-10-30)";

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

/** The release a book + language should show: the newest live FINAL. Drafts never. */
export function pickRelease(rows: ReleaseRow[]): ReleaseRow | null {
  return rows.filter((r) => live(r) && r.release_kind === "final").sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
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

    if (row.release_kind !== "final") {
      if (opts.dryRun) return { status: "skipped", release_id: releaseId, reason: DRAFT_SKIP_REASON };
      await logImport(db, row, "skipped", 0, DRAFT_SKIP_REASON);
      // a product must never point at a draft: if one ever did, its blocks go
      const product = await productFor(db, row.work_uid, language);
      if (product && product.release_kind !== "final" && product.release_id != null) {
        return { status: "skipped", release_id: releaseId, reason: DRAFT_SKIP_REASON, reconciled: await reconcileWork(db, s3, row.work_uid, language) };
      }
      return { status: "skipped", release_id: releaseId, reason: DRAFT_SKIP_REASON };
    }

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
  | { status: "waiting_for_0174"; live: number }
  | { status: "ok"; live: number; imported: number[]; unchanged: number[]; skipped: number[]; unavailable: string[]; errors: { release_id: number; error: string }[]; dryRun?: true; migration0174?: false };

/** Import every live FINAL that changed; skip drafts; mark books with no live final unavailable. */
export async function pollReleases(db: KnowledgeDb, deps: { s3?: BundleReader; dryRun?: boolean } = {}): Promise<PollResult> {
  const { rows, missing } = await liveReleases(db);
  if (missing) return { status: "waiting_for_book_app" };

  const { data: prodData, error: prodErr } = await db.from("sk_book_products").select(PRODUCT_COLS).not("work_uid", "is", null);
  const dryRun = !!deps.dryRun;
  let migrationMissing = false;
  if (prodErr) {
    // 0172 is live but SK's 0174 (the link columns, the blocks) is not applied yet
    if (!(prodErr.code === "42703" || isMissingRelation(prodErr))) throw new Error(`sk_book_products read failed: ${prodErr.message}`);
    if (!dryRun) return { status: "waiting_for_0174", live: rows.length };
    migrationMissing = true; // a dry run still reports what it WOULD do
  }
  const products = (prodData ?? []) as ProductRow[];
  const { data: logData } = await db.from("sk_release_imports").select("release_id, status");
  const logged = new Map(((logData ?? []) as { release_id: number; status: string }[]).map((r) => [Number(r.release_id), r.status]));
  const ok = new Set([...logged].filter(([, s]) => s === "ok").map(([id]) => id));

  const key = (w: string, l: string) => `${w}\u0000${normLanguage(l) ?? l}`;
  const byBook = new Map<string, ReleaseRow[]>();
  for (const r of rows) byBook.set(key(r.work_uid, r.language), [...(byBook.get(key(r.work_uid, r.language)) ?? []), r]);
  const productByBook = new Map(products.map((p) => [key(p.work_uid ?? "", p.language ?? ""), p]));

  const out: Extract<PollResult, { status: "ok" }> = { status: "ok", live: rows.length, imported: [], unchanged: [], skipped: [], unavailable: [], errors: [] };
  if (dryRun) Object.assign(out, { dryRun: true, ...(migrationMissing ? { migration0174: false } : {}) });
  let s3 = deps.s3 ?? null;
  // drafts are never used (founder 2026-10-30): each live draft is logged once as skipped
  for (const r of rows) {
    if (r.release_kind === "final" || logged.has(Number(r.id))) continue;
    if (!dryRun) await logImport(db, r, "skipped", 0, DRAFT_SKIP_REASON);
    out.skipped.push(Number(r.id));
  }
  const finals = new Map<string, ReleaseRow>();
  for (const [k, list] of byBook) {
    const pick = pickRelease(list);
    if (pick) finals.set(k, pick);
  }
  for (const [k, pick] of finals) {
    const p = productByBook.get(k);
    if (p && Number(p.release_id) === Number(pick.id) && ok.has(Number(pick.id))) {
      out.unchanged.push(Number(pick.id));
      continue;
    }
    s3 ??= (await import("./s3")).booksBundleReader;
    const r = await importRelease(db, s3, pick, { dryRun });
    if (r.status === "ok") out.imported.push(r.release_id);
    else if (r.status === "skipped") out.skipped.push(r.release_id);
    else out.errors.push({ release_id: r.release_id, error: r.error });
  }
  for (const p of products) {
    // no live FINAL for this book + language (none, withdrawn, or only drafts) → unavailable
    if (!p.work_uid || !p.language || finals.has(key(p.work_uid, p.language))) continue;
    if (p.status === "retired" && p.release_id == null) continue;
    if (!dryRun) await markUnavailable(db, p.work_uid, p.language);
    out.unavailable.push(p.id);
  }
  return out;
}
