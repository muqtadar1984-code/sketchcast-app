/**
 * SketchCast books as Library books — FOUNDER ONLY. Two steps, each a DRY RUN
 * unless --apply is given (docs/sk-product-books.md has the run order):
 *
 *   node --env-file=.env.local scripts/sk-product-kits.ts <product-slug> [--apply] [--worker-ready] [--any-hour]
 *     KITS: per chapter of the product's system book (0175), what it would
 *     queue — ONE full kit (the Library's "Generate full kit" rows, kitRows),
 *     whole chapter, params.single_part, owned by CATALOGUE_OWNER_ID — and the
 *     estimated cost per kit and in total. With --apply it queues through the
 *     app's own path (a generations insert; the on_generation_created trigger
 *     makes the jobs) ONE KIT AT A TIME, waiting for each to finish before the
 *     next, and stops at the first failed lesson.
 *       Refuses to start (and pauses between kits) while ANY jobs row is queued
 *       or processing — production rule: never starve the worker.
 *       Refuses outside 20:00–05:00 UTC unless --any-hour.
 *       Refuses a PDF-less product book until --worker-ready (the worker change
 *       in the doc is deployed).
 *
 *   node --env-file=.env.local scripts/sk-product-kits.ts <product-slug> --map [--apply]
 *     MAP: once the kits are done, REPLACE the product's sk_product_kits rows
 *     with exactly one row per chapter (its newest done master lesson, label =
 *     the final chapter title). Prints the before and the after. --apply
 *     refuses while any chapter has no done kit. Writes the new rows first,
 *     then deletes the old ones, so /sk never sees an empty map.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CATALOGUE_OWNER_ID.
 * Exit codes: 0 done (or dry run printed); 1 crashed / a kit failed; 2 bad arguments, env or a refusal.
 */
import { register } from "node:module";
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

const POLL_MS = 30_000;
const KIT_TIMEOUT_MS = 4 * 3600_000;
const BUSY_WAIT_MAX_MS = 2 * 3600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const slug = argv.find((a) => !a.startsWith("--"));
  const has = (f: string) => argv.includes(f);
  const apply = has("--apply");
  if (!slug) {
    console.error("usage: node --env-file=.env.local scripts/sk-product-kits.ts <product-slug> [--map] [--apply] [--worker-ready] [--any-hour]");
    return 2;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const owner = (process.env.CATALOGUE_OWNER_ID ?? "").trim().toLowerCase();
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    return 2;
  }
  if (!UUID.test(owner)) {
    console.error("CATALOGUE_OWNER_ID must be set to the catalogue system account's uuid");
    return 2;
  }
  register("data:text/javascript," + encodeURIComponent(HOOK), { parentURL: import.meta.url, data: { src: pathToFileURL(resolve(ROOT, "src") + "/").href } });
  const plan = await import(pathToFileURL(resolve(ROOT, "src/sk/product-kits-plan.ts")).href);
  const { createClient } = await import("@supabase/supabase-js");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const db: any = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: product, error: pErr } = await db.from("sk_book_products").select("id, slug, title, status, release_id").eq("slug", slug).maybeSingle();
  if (pErr) throw new Error(`sk_book_products read failed: ${pErr.message}`);
  if (!product) {
    console.error(`no product with slug ${slug}`);
    return 2;
  }
  const { data: book, error: bErr } = await db.from("books").select("id, title, owner_id, sk_product_id, sk_release_id, storage_path, chapters").eq("sk_product_id", product.id).maybeSingle();
  if (bErr) {
    console.error(`books read failed (${bErr.code ?? "?"}): ${bErr.message} — is migration 0175 applied?`);
    return 2;
  }
  if (!book) {
    console.error(`product ${slug} has no system book yet: apply 0175, then re-import its release (Import now / scripts in the doc)`);
    return 2;
  }
  console.log(`product ${product.slug} (${product.id}) status=${product.status} release=${product.release_id}`);
  console.log(`book    ${book.id} "${book.title}" release=${book.sk_release_id} owner=${book.owner_id} pdf=${book.storage_path ? "yes" : "none"}`);

  const loadMasters = async () => {
    const { data, error } = await db
      .from("generations")
      .select("id, kind, chapter_ref, status, params, created_at, removed_at, withdrawn_at")
      .eq("book_id", book.id)
      .eq("owner_id", book.owner_id);
    if (error) throw new Error(`generations read failed: ${error.message}`);
    return data ?? [];
  };

  // ── MAP ──────────────────────────────────────────────────────────────────
  if (has("--map")) {
    const { data: current, error: mErr } = await db.from("sk_product_kits").select("product_id, chapter_ref, sort, generation_id, label").eq("product_id", product.id);
    if (mErr) throw new Error(`sk_product_kits read failed: ${mErr.message}`);
    const m = plan.planProductKitMap({ book, masters: await loadMasters(), current: current ?? [] });
    const line = (r: any) => `  ch ${String(r.chapter_ref).padStart(2)} #${r.sort}  ${r.generation_id}  ${r.label ?? ""}`;
    console.log(`\nBEFORE (${m.before.length} row(s)):`);
    m.before.forEach((r: any) => console.log(line(r)));
    console.log(`AFTER (${m.after.length} row(s)):`);
    m.after.forEach((r: any) => console.log(line(r)));
    if (m.missing.length) console.log(`MISSING a done kit: ${m.missing.map((x: any) => `ch ${x.chapter} ${x.title}`).join("; ")}`);
    if (!apply) {
      console.log("\nDRY RUN — nothing written. Re-run with --apply to replace the map.");
      return 0;
    }
    if (m.missing.length) {
      console.error("refused: every chapter needs a done kit before the map is replaced");
      return 2;
    }
    const { error: upErr } = await db.from("sk_product_kits").upsert(m.after, { onConflict: "product_id,chapter_ref,generation_id" });
    if (upErr) throw new Error(`sk_product_kits upsert failed: ${upErr.message}`);
    for (const r of plan.staleMapRows(m)) {
      const { error } = await db.from("sk_product_kits").delete().eq("product_id", r.product_id).eq("chapter_ref", r.chapter_ref).eq("generation_id", r.generation_id);
      if (error) throw new Error(`sk_product_kits delete failed: ${error.message}`);
    }
    console.log(`\nmap replaced: ${m.after.length} row(s) written, ${plan.staleMapRows(m).length} old row(s) removed`);
    return 0;
  }

  // ── KITS ─────────────────────────────────────────────────────────────────
  const p = plan.planProductKits({ book, ownerId: owner, masters: await loadMasters(), workerReady: has("--worker-ready") });
  console.log("");
  for (const c of p.chapters) {
    const what = c.rows.length ? `QUEUE 1 full kit (${c.rows.map((r: any) => r.kind).join(", ")})` : c.state === "done" ? `done (${c.presentationId})` : c.state;
    console.log(`  ch ${String(c.chapter).padStart(2)}  ${c.title.slice(0, 60).padEnd(60)}  ${what}`);
  }
  console.log(`\ncost estimate: $${p.cost.perKit.low}–$${p.cost.perKit.high} per kit (≈$${p.cost.perKit.point}); ${p.cost.kits} kit(s) ≈ $${p.cost.point} (range $${p.cost.low}–$${p.cost.high})`);
  if (p.blockers.length) console.log(`blockers for --apply:\n  - ${p.blockers.join("\n  - ")}`);
  if (!apply) {
    console.log("\nDRY RUN — nothing queued. Re-run with --apply (off-peak, empty queue) to queue sequentially.");
    return 0;
  }
  if (p.blockers.length) {
    console.error("refused: see blockers above");
    return 2;
  }
  if (!plan.offPeak(new Date()) && !has("--any-hour")) {
    console.error("refused: outside the 20:00–05:00 UTC window (users' hours); pass --any-hour to override");
    return 2;
  }

  const busy = async () => {
    const { data, error } = await db.from("jobs").select("id, status").in("status", ["queued", "processing"]).limit(50);
    if (error) throw new Error(`jobs read failed: ${error.message}`);
    return plan.busyJobs(data ?? []);
  };
  const first = await busy();
  if (first > 0) {
    console.error(`refused: ${first} job(s) queued or processing — never starve production; try again when the queue is empty`);
    return 2;
  }

  for (const [i, c] of p.toQueue.entries()) {
    // between kits: wait for anyone else's work to clear before queuing ours
    const waitStart = Date.now();
    for (let n = await busy(); n > 0; n = await busy()) {
      if (Date.now() - waitStart > BUSY_WAIT_MAX_MS) {
        console.error(`stopping: the queue has been busy for 2 h (${n} job(s)); ${p.toQueue.length - i} kit(s) not queued`);
        return 2;
      }
      console.log(`  queue busy (${n} job(s)); waiting…`);
      await sleep(60_000);
    }
    const { data: ins, error } = await db.from("generations").insert(c.rows).select("id, kind");
    if (error) throw new Error(`ch ${c.chapter}: generations insert failed: ${error.message}`);
    const ids = (ins ?? []).map((r: any) => r.id);
    console.log(`[${i + 1}/${p.toQueue.length}] ch ${c.chapter} queued: ${ids.length} row(s) — waiting for the kit…`);
    const started = Date.now();
    for (;;) {
      await sleep(POLL_MS);
      const { data: rows, error: rErr } = await db.from("generations").select("id, kind, status").in("id", ids);
      if (rErr) throw new Error(`generations poll failed: ${rErr.message}`);
      const outcome = plan.kitOutcome(rows ?? []);
      if (outcome === "done") {
        const errs = (rows ?? []).filter((r: any) => r.status === "error").map((r: any) => r.kind);
        console.log(`  ch ${c.chapter} done${errs.length ? ` (failed pieces: ${errs.join(", ")})` : ""} in ${Math.round((Date.now() - started) / 60000)} min`);
        break;
      }
      if (outcome === "failed") {
        console.error(`  ch ${c.chapter}: the lesson FAILED — stopping the batch (${p.toQueue.length - i - 1} kit(s) not queued)`);
        return 1;
      }
      if (Date.now() - started > KIT_TIMEOUT_MS) {
        console.error(`  ch ${c.chapter}: still running after 4 h — stopping the batch; check the worker`);
        return 1;
      }
    }
  }
  console.log("\nall kits done. Next: --map (dry run), then --map --apply.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
