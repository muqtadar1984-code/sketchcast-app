// SK retrieval — embed sk_book_blocks that have no vector yet (0160).
//
//   npx tsx tools/sk/embed-blocks.ts --product <uuid|slug> [--chapter N] [--batch 8] [--all] [--dry-run]
//   npx tsx tools/sk/embed-blocks.ts --input blocks.json --emit-sql out.sql [--chunk 15]
//
// Direct mode needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (point them at a
// BRANCH until the founder says production) and AWS credentials that may call
// bedrock:InvokeModel on amazon.titan-embed-text-v2:0 (BEDROCK_REGION, default
// us-east-1; locally the sketchcast-ops profile in ~/.aws). It is idempotent:
// only blocks whose `embedding` is null — or, with --all, whose
// `embedding_model` differs from the current model — are embedded, in batches
// of --batch concurrent calls, each batch written before the next starts, so
// a stopped run resumes where it left off.
//
// --emit-sql is for a database you can only reach through SQL (a Supabase
// branch with no service key): --input is a JSON array of
// {id, retrieval_text} rows (dump them with
//   select id, retrieval_text from sk_book_blocks where embedding is null
// ), the embeddings are computed here and written as UPDATE statements in
// files of --chunk rows (out.1.sql, out.2.sql, …) small enough for the SQL
// editor / MCP. Nothing is written to any database in that mode.
//
// Cost: Titan v2 is $0.00002 per 1K tokens — a 90-block chapter is ~4.5K
// tokens, under a cent. The run prints the token count it was billed for.

import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_EMBED_MODEL, TitanEmbedder } from "../../src/sk/embed";

type Args = { product: string | null; chapter: number | null; batch: number; all: boolean; dryRun: boolean; input: string | null; emitSql: string | null; chunk: number };

function parseArgs(argv: string[]): Args {
  const a: Args = { product: null, chapter: null, batch: 8, all: false, dryRun: false, input: null, emitSql: null, chunk: 15 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === "--product") a.product = argv[++i] ?? null;
    else if (x === "--chapter") a.chapter = Number(argv[++i]);
    else if (x === "--batch") a.batch = Math.max(1, Math.min(32, Number(argv[++i]) || 8));
    else if (x === "--all") a.all = true;
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--input") a.input = argv[++i] ?? null;
    else if (x === "--emit-sql") a.emitSql = argv[++i] ?? null;
    else if (x === "--chunk") a.chunk = Math.max(1, Number(argv[++i]) || 15);
    else throw new Error(`unexpected argument ${x}`);
  }
  if (!a.emitSql && !a.product) throw new Error("usage: --product <uuid|slug> [--chapter N] [--batch 8] [--all] [--dry-run]  |  --input blocks.json --emit-sql out.sql [--chunk 15]");
  if (a.emitSql && !a.input) throw new Error("--emit-sql needs --input blocks.json");
  return a;
}

type BlockRow = { id: string; retrieval_text: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const vectorLiteral = (v: number[]): string => "[" + v.map((x) => (Number.isInteger(x) ? String(x) : x.toPrecision(8))).join(",") + "]";

async function embedAll(embedder: TitanEmbedder, rows: BlockRow[], batch: number, onBatch: (done: { id: string; embedding: number[] }[]) => Promise<void>): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch).filter((r) => (r.retrieval_text ?? "").trim());
    const done = await Promise.all(slice.map(async (r) => ({ id: r.id, embedding: await embedder.embed(r.retrieval_text!) })));
    await onBatch(done);
    n += done.length;
    console.log(`  ${n}/${rows.length} embedded (${embedder.tokens} tokens so far)`);
  }
  return n;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const embedder = new TitanEmbedder();
  const model = embedder.model;

  if (args.emitSql) {
    const rows = JSON.parse(readFileSync(args.input!, "utf-8")) as BlockRow[];
    const todo = rows.filter((r) => UUID_RE.test(r.id) && (r.retrieval_text ?? "").trim());
    console.log(`${todo.length} of ${rows.length} rows to embed with ${model} → SQL chunks of ${args.chunk}`);
    const all: { id: string; embedding: number[] }[] = [];
    await embedAll(embedder, todo, args.batch, async (done) => {
      all.push(...done);
    });
    const base = args.emitSql.replace(/\.sql$/i, "");
    let files = 0;
    for (let i = 0; i < all.length; i += args.chunk) {
      files += 1;
      const stmts = all.slice(i, i + args.chunk).map((r) => `update public.sk_book_blocks set embedding = '${vectorLiteral(r.embedding)}'::vector, embedding_model = '${model}', embedded_at = now() where id = '${r.id}' and (embedding is null or embedding_model is distinct from '${model}');`);
      writeFileSync(`${base}.${files}.sql`, `-- embed-blocks: ${stmts.length} rows, ${model}\n${stmts.join("\n")}\n`, "utf-8");
    }
    console.log(`${all.length} embeddings in ${files} file(s) ${base}.N.sql; ${embedder.tokens} Titan tokens (~$${((embedder.tokens / 1000) * 0.00002).toFixed(6)})`);
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("direct mode needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (a BRANCH unless the founder said production)");
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  let productId = args.product!;
  if (!UUID_RE.test(productId)) {
    const { data, error } = await sb.from("sk_book_products").select("id").eq("slug", productId).maybeSingle();
    if (error || !data) throw new Error(`product "${productId}" not found: ${error?.message ?? "no row"}`);
    productId = (data as { id: string }).id;
  }
  let q = sb.from("sk_book_blocks").select("id, retrieval_text, embedding_model").eq("product_id", productId);
  if (args.chapter != null && Number.isFinite(args.chapter)) q = q.eq("chapter", args.chapter);
  const { data, error } = await q.order("chapter").order("section_sid").order("block_index");
  if (error) throw new Error(`reading blocks failed: ${error.message}`);
  const rows = (data ?? []) as (BlockRow & { embedding_model: string | null })[];
  // supabase-js cannot express "embedding is null" on a vector column
  // portably, so the selection is: no model recorded (never embedded), or a
  // different model with --all.
  const todo = rows.filter((r) => (r.retrieval_text ?? "").trim() && (r.embedding_model == null || (args.all && r.embedding_model !== model)));
  console.log(`${rows.length} blocks for product ${productId}${args.chapter != null ? ` chapter ${args.chapter}` : ""}; ${todo.length} to embed with ${model}${args.dryRun ? " (dry run)" : ""}`);
  if (args.dryRun || !todo.length) return;

  const n = await embedAll(embedder, todo, args.batch, async (done) => {
    for (const r of done) {
      const { error: e } = await sb.from("sk_book_blocks").update({ embedding: vectorLiteral(r.embedding), embedding_model: model, embedded_at: new Date().toISOString() }).eq("id", r.id);
      if (e) throw new Error(`update ${r.id} failed: ${e.message}`);
    }
  });
  console.log(`${n} blocks embedded; ${embedder.tokens} Titan tokens (~$${((embedder.tokens / 1000) * 0.00002).toFixed(6)}); model ${DEFAULT_EMBED_MODEL === model ? model : `${model} (SK_EMBED_MODEL)`}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
