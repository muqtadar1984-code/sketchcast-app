/**
 * SketchCast books as Library books — FOUNDER ONLY. Writes a product's chapter
 * → kit MAP (sk_product_kits) from its release bundle's topics and the
 * catalogue kits that ALREADY EXIST for them. Nothing is generated or queued
 * (founder 2026-10-30: "we already have those generated as part of the
 * catalogue"). A DRY RUN unless --apply. docs/sk-product-books.md has the run
 * order.
 *
 *   node --env-file=.env.local scripts/sk-product-kits.ts <product-slug> [--map] [--apply] [--allow-missing] [--bundle <local bundle.json>]
 *
 *   Reads the product's live release (pub_releases row = sk_book_products.release_id),
 *   its bundle (books bucket, default AWS credential chain — or --bundle),
 *   and for every chapter's topics: topics by slug → catalogue_current_kits()
 *   in the release's language → topic_kits → the kit's presentation (done,
 *   live) → its YouTube ids (topic_publications). The planning is
 *   src/sk/product-kits-plan.ts (unit-tested).
 *   Prints the map BEFORE (the product's rows now) and the AFTER it would
 *   write, every topic that did not resolve (and why), and per chapter the
 *   bundle's videos beside the resolved kits' YouTube ids.
 *   --apply writes the AFTER rows first (upsert), then deletes the product's
 *   other rows, so /sk never sees an empty map; then re-reads and prints the
 *   live map. Refuses while a topic is unresolved unless --allow-missing.
 *   `--map` is accepted (the old spelling); the generation path and
 *   --worker-ready are gone.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; S3: BOOKS_S3_BUCKET
 * (default sketchcast-books-172042957848), BOOKS_S3_REGION (default us-east-1).
 * Exit codes: 0 done (or dry run printed); 1 crashed; 2 bad arguments, env or a refusal.
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
  const has = (f: string) => argv.includes(f);
  const bundleAt = argv.indexOf("--bundle");
  const localBundle = bundleAt >= 0 ? argv[bundleAt + 1] : null;
  const slug = argv.find((a, i) => !a.startsWith("--") && !(bundleAt >= 0 && i === bundleAt + 1));
  const apply = has("--apply");
  if (has("--worker-ready") || has("--any-hour")) {
    console.error("--worker-ready / --any-hour are gone: nothing is generated any more, the map points at existing catalogue kits");
    return 2;
  }
  if (!slug || (bundleAt >= 0 && !localBundle)) {
    console.error("usage: node --env-file=.env.local scripts/sk-product-kits.ts <product-slug> [--map] [--apply] [--allow-missing] [--bundle <file>]");
    return 2;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    return 2;
  }
  register("data:text/javascript," + encodeURIComponent(HOOK), { parentURL: import.meta.url, data: { src: pathToFileURL(resolve(ROOT, "src") + "/").href } });
  const plan = await import(pathToFileURL(resolve(ROOT, "src/sk/product-kits-plan.ts")).href);
  const rel = await import(pathToFileURL(resolve(ROOT, "src/sk/knowledge/release.ts")).href);
  const { createClient } = await import("@supabase/supabase-js");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const db: any = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: product, error: pErr } = await db.from("sk_book_products").select("id, slug, title, status, release_id").eq("slug", slug).maybeSingle();
  if (pErr) throw new Error(`sk_book_products read failed: ${pErr.message}`);
  if (!product) {
    console.error(`no product with slug ${slug}`);
    return 2;
  }
  if (!product.release_id) {
    console.error(`product ${slug} has no live release: import its final first`);
    return 2;
  }
  const { data: row, error: rErr } = await db.from("pub_releases").select("*").eq("id", product.release_id).maybeSingle();
  if (rErr) throw new Error(`pub_releases read failed: ${rErr.message}`);
  if (!row) {
    console.error(`pub_releases row ${product.release_id} not found`);
    return 2;
  }
  const language = String(row.language ?? "en").toLowerCase();
  console.log(`product ${product.slug} (${product.id}) status=${product.status}`);
  console.log(`release ${row.id} ${row.release_kind} ${row.edition_key} language=${language}`);

  let bytes: Uint8Array;
  if (localBundle) bytes = new Uint8Array(readFileSync(localBundle));
  else {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const bucket = process.env.BOOKS_S3_BUCKET || "sketchcast-books-172042957848";
    try {
      const out = await new S3Client({ region: process.env.BOOKS_S3_REGION || "us-east-1" }).send(new GetObjectCommand({ Bucket: bucket, Key: row.bundle_key }));
      bytes = await out.Body!.transformToByteArray();
    } catch (e: any) {
      console.error(`S3 GET s3://${bucket}/${row.bundle_key} refused: ${e.name} ${e.message} — pass --bundle <file> instead`);
      return 2;
    }
  }
  const { bundle, problems } = rel.verifyBundle(row, bytes);
  if (!bundle) {
    console.error(`bundle unreadable: ${problems.join("; ")}`);
    return 2;
  }
  if (problems.length) console.log(`  (bundle check: ${problems.join("; ")})`);

  const chapters = plan.bundleChapterTopics(bundle);
  const slugs = [...new Set(chapters.flatMap((c: any) => c.topics.map((t: any) => t.slug)))];
  console.log(`bundle: ${chapters.length} chapter(s), ${slugs.length} distinct topic(s)`);

  const { data: topics, error: tErr } = slugs.length ? await db.from("topics").select("id, slug, title").in("slug", slugs) : { data: [], error: null };
  if (tErr) throw new Error(`topics read failed: ${tErr.message}`);
  const { data: current, error: cErr } = await db.rpc("catalogue_current_kits");
  if (cErr) throw new Error(`catalogue_current_kits failed: ${cErr.message}`);
  const topicIds = new Set((topics ?? []).map((t: any) => t.id));
  const kitIds = (current ?? []).filter((c: any) => topicIds.has(c.topic_id)).map((c: any) => c.topic_kit_id);
  const { data: kits, error: kErr } = kitIds.length ? await db.from("topic_kits").select("id, topic_id, presentation_generation_id").in("id", kitIds) : { data: [], error: null };
  if (kErr) throw new Error(`topic_kits read failed: ${kErr.message}`);
  const presIds = (kits ?? []).map((k: any) => k.presentation_generation_id).filter(Boolean);
  const { data: lessons, error: gErr } = presIds.length
    ? await db.from("generations").select("id, kind, status, removed_at, withdrawn_at").in("id", presIds)
    : { data: [], error: null };
  if (gErr) throw new Error(`generations read failed: ${gErr.message}`);
  const { data: pubs } = kitIds.length ? await db.from("topic_publications").select("*").in("topic_kit_id", kitIds) : { data: [] };
  const readMap = async () => {
    const { data, error } = await db.from("sk_product_kits").select("product_id, chapter_ref, sort, generation_id, label").eq("product_id", product.id);
    if (error) throw new Error(`sk_product_kits read failed: ${error.message}`);
    return data ?? [];
  };

  const m = plan.planCatalogueMap({
    productId: product.id,
    language,
    chapters,
    topics: topics ?? [],
    current: current ?? [],
    kits: kits ?? [],
    lessons: lessons ?? [],
    publications: pubs ?? [],
    currentMap: await readMap(),
  });
  const line = (r: any) => `  ch ${String(r.chapter_ref).padStart(2)} #${r.sort}  ${r.generation_id}  ${r.label ?? ""}`;
  console.log(`\nBEFORE (${m.before.length} row(s)):`);
  m.before.forEach((r: any) => console.log(line(r)));
  console.log(`AFTER (${m.after.length} row(s)):`);
  m.after.forEach((r: any) =>
    console.log(`${line(r)}  [${r.slug}${r.sharedWith ? `, shared with Chapter ${r.sharedWith}` : ""}; YouTube ${r.youtube.length ? r.youtube.join(",") : "NONE — would play from storage"}]`),
  );
  if (m.unresolved.length) {
    console.log("UNRESOLVED (left out of the map):");
    m.unresolved.forEach((u: any) => console.log(`  ch ${String(u.chapter).padStart(2)}  ${u.slug}: ${u.reason}`));
  }
  console.log("VIDEOS (bundle → the resolved kits' YouTube ids):");
  for (const v of m.videos) {
    const missing = v.bundle.filter((id: string) => !v.kits.includes(id));
    console.log(`  ch ${String(v.chapter).padStart(2)}  bundle [${v.bundle.join(", ")}]  kits [${v.kits.join(", ")}]${missing.length ? `  ⚠ not in the kits: ${missing.join(", ")}` : ""}`);
  }

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to replace the map.");
    return 0;
  }
  if (m.unresolved.length && !has("--allow-missing")) {
    console.error("refused: some topics did not resolve to a current catalogue kit (above); fix them or pass --allow-missing");
    return 2;
  }
  if (!m.after.length) {
    console.error("refused: the AFTER map is empty");
    return 2;
  }
  const rows = plan.mapRows(m);
  const { error: upErr } = await db.from("sk_product_kits").upsert(rows, { onConflict: "product_id,chapter_ref,generation_id" });
  if (upErr) throw new Error(`sk_product_kits upsert failed: ${upErr.message}`);
  const stale = plan.staleMapRows(m);
  for (const r of stale) {
    const { error } = await db.from("sk_product_kits").delete().eq("product_id", r.product_id).eq("chapter_ref", r.chapter_ref).eq("generation_id", r.generation_id);
    if (error) throw new Error(`sk_product_kits delete failed: ${error.message}`);
  }
  const live = (await readMap()).sort((a: any, b: any) => Number(a.chapter_ref) - Number(b.chapter_ref) || a.sort - b.sort);
  console.log(`\nmap replaced: ${rows.length} row(s) written, ${stale.length} old row(s) removed. NOW (${live.length} row(s)):`);
  live.forEach((r: any) => console.log(line(r)));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
