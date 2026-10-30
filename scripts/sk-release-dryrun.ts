/**
 * SK S7 slice K1 — a READ-ONLY dry run of importRelease for one pub_releases
 * row: fetch bundle.json from the books bucket, verify the bundle hash, the
 * schema, the edition key and every chapter's content_sha256, and report the
 * blocks it would write (per kind and language), the product it would upsert,
 * and whether any answer / worked solution / mark point / review blind answer
 * would become a block. It writes NOTHING: it only issues SELECTs and one S3
 * GET.
 *
 *   node --env-file=.env.local scripts/sk-release-dryrun.ts <release_id> [--bundle <local bundle.json>]
 *
 * S3: the default AWS credential chain (BOOKS_S3_BUCKET, else
 * sketchcast-books-172042957848; BOOKS_S3_REGION, default us-east-1). Locally
 * that is YOUR profile, not the app's Vercel role — a GET that works here does
 * not prove the app role may read books/*\/editions/*.
 * Exit codes: 0 report printed (read its verdict); 1 crashed; 2 bad arguments / env.
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = `
let SRC;
export function initialize(data) { SRC = data.src; }
export async function resolve(spec, ctx, next) {
  if (spec.startsWith("@/")) spec = new URL(spec.slice(2), SRC).href;
  const local = spec.startsWith(".") || spec.startsWith("file:");
  if (local && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      try { return await next(spec + ext, ctx); } catch {}
    }
  }
  return next(spec, ctx);
}`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const id = Number(argv[0]);
  const local = argv[1] === "--bundle" ? argv[2] : null;
  if (!Number.isInteger(id) || id < 1) {
    console.error("usage: node --env-file=.env.local scripts/sk-release-dryrun.ts <release_id> [--bundle <file>]");
    return 2;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    return 2;
  }
  register("data:text/javascript," + encodeURIComponent(HOOK), { parentURL: import.meta.url, data: { src: pathToFileURL(resolve(ROOT, "src") + "/").href } });
  const rel = await import(pathToFileURL(resolve(ROOT, "src/sk/knowledge/release.ts")).href);
  const { createClient } = await import("@supabase/supabase-js");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const db: any = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: row, error } = await db.from("pub_releases").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`pub_releases read failed: ${error.message}`);
  if (!row) {
    console.error(`no pub_releases row ${id}`);
    return 2;
  }
  console.log(`release ${row.id}: ${row.work_uid} ${row.language} ${row.release_kind} ${row.edition_key} (${row.chapter_count} chapter(s)); live=${row.superseded_by == null && row.withdrawn_at == null}`);
  if (row.release_kind !== "final") console.log(`  VERDICT: would be SKIPPED — ${rel.DRAFT_SKIP_REASON}`);

  let bytes: Uint8Array;
  if (local) bytes = new Uint8Array(readFileSync(local));
  else {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const bucket = process.env.BOOKS_S3_BUCKET || "sketchcast-books-172042957848";
    try {
      const out = await new S3Client({ region: process.env.BOOKS_S3_REGION || "us-east-1" }).send(new GetObjectCommand({ Bucket: bucket, Key: row.bundle_key }));
      bytes = await out.Body!.transformToByteArray();
    } catch (e: any) {
      console.log(`  S3 GET s3://${bucket}/${row.bundle_key} REFUSED: ${e.name} (${e.$metadata?.httpStatusCode}) ${e.message}`);
      return 0;
    }
  }
  console.log(`  bundle: ${bytes.length} bytes`);
  const { bundle, problems } = rel.verifyBundle(row, bytes);
  console.log(`  verify: ${problems.length ? "REFUSED — " + problems.join("; ") : "ok (bundle sha256, schema, edition key, every chapter content_sha256)"}`);
  if (!bundle) return 0;

  const blocks = rel.releaseBlocks(row, bundle);
  const per: Record<string, number> = {};
  for (const b of blocks) per[`${b.kind}/${b.language}`] = (per[`${b.kind}/${b.language}`] ?? 0) + 1;
  const chars = blocks.reduce((n: number, b: any) => n + b.text.length, 0);
  console.log(`  blocks: ${blocks.length} (${JSON.stringify(per)}), ${chars} chars, longest ${Math.max(0, ...blocks.map((b: any) => b.text.length))}`);
  for (const ch of bundle.chapters) {
    const mine = blocks.filter((b: any) => b.chapter === ch.chapter);
    console.log(`    ch${ch.chapter} ${ch.title}: ${mine.filter((b: any) => b.kind === "section").length} section block(s), ${mine.filter((b: any) => b.kind === "exercise_stem").length} exercise stem(s)`);
  }

  const secrets: string[] = [];
  for (const ch of bundle.chapters as any[]) {
    for (const x of ch.exercises ?? []) for (const v of [x.answer, x.worked_solution, ...(x.marking_scheme ?? []).map((m: any) => m?.point)]) if (typeof v === "string" && v.length >= 20) secrets.push(v);
    for (const a of ch.review?.blind_answers ?? []) if (typeof a?.answer === "string" && a.answer.length >= 20) secrets.push(a.answer);
  }
  const all = blocks.map((b: any) => b.text).join("\n");
  const leaked = secrets.filter((s) => all.includes(s));
  console.log(`  answer check: ${secrets.length} distinctive answer / worked-solution / mark-point / blind-answer strings; ${leaked.length} found in blocks${leaked.length ? " — " + JSON.stringify(leaked.slice(0, 3)) : ""}`);

  // the product it would upsert (one per work_uid + language)
  const lang = row.language;
  let product: any = null;
  const byWork = await db.from("sk_book_products").select("id, slug, status").eq("work_uid", row.work_uid).eq("language", lang).maybeSingle();
  if (!byWork.error) product = byWork.data;
  else console.log(`  (sk_book_products link columns not there yet — 0174 not applied: ${byWork.error.message})`);
  if (!product) {
    const bySlug = await db.from("sk_book_products").select("id, slug, status").eq("slug", row.slug).maybeSingle();
    if (bySlug.data) product = { ...bySlug.data, adopt: true };
  }
  const link = { work_uid: row.work_uid, language: lang, release_id: row.id, edition_key: row.edition_key, release_kind: row.release_kind, cover_key: row.cover_key ?? bundle.work?.cover?.path ?? null, title: row.title, status: "approved" };
  if (row.release_kind !== "final") console.log("  product: none (drafts never create or change a product)");
  else if (product) console.log(`  product: UPDATE ${product.id} (slug ${product.slug}, status ${product.status} → approved${product.adopt ? "; adopts the existing slug row, work_uid was null" : ""}) set ${JSON.stringify(link)}`);
  else console.log(`  product: INSERT slug ${row.slug} (or ${row.slug}-${lang} if taken), languages {${lang}}, ${JSON.stringify(link)}`);
  console.log("  nothing was written.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error("dry run failed:", (e as Error).stack ?? e);
    process.exit(1);
  },
);
