// SK retrieval — re-run the R1 question set against sk_search_hybrid (0160)
// and score it with the R1 rubric (sketchcast-ai spike/sk_r1/questions.json).
//
//   npx tsx tools/sk/retrieval-bench.ts --questions questions.json --product <uuid|slug> --chapter 2 [--gate 0.32] [--k 5]
//       direct: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + AWS creds for Titan; prints the tables.
//   npx tsx tools/sk/retrieval-bench.ts --questions questions.json --product <uuid> --chapter 2 --emit-sql bench [--chunk 10]
//       no service key: embeds the questions here and writes bench.N.sql — each a single
//       SELECT returning one JSON row per question; run them (SQL editor / MCP), save each
//       result as bench.N.json, then
//   npx tsx tools/sk/retrieval-bench.ts --questions questions.json --score bench.1.json bench.2.json … [--gate 0.32]
//
// Rubric (R1 §3): recall@5 and MRR at block level (gold "u5#01" = unit_key#block_index)
// and unit level; off-chapter false positive = best_vec_score ≥ gate; in-chapter
// wrongly rejected = best_vec_score < gate; filter leak = any row whose product/chapter
// differ from the request (run with fake copies in the table to make it bite);
// injection = the call returned ordinary rows (no error).

import { readFileSync, writeFileSync } from "node:fs";
import { TitanEmbedder } from "../../src/sk/embed";

type Question = { id: string; group: string; text: string; gold_units: string[]; gold_blocks: string[] };
type Row = { id: string; product_id: string; chapter: number; unit_key: string | null; block_index: number; score: number; fts_score: number | null; vec_score: number | null; best_vec_score: number | null };
type Result = { id: string; rows: Row[]; error?: string };

type Args = { questions: string; product: string | null; chapter: number; gate: number; k: number; emitSql: string | null; chunk: number; score: string[] };
function parseArgs(argv: string[]): Args {
  const a: Args = { questions: "", product: null, chapter: 2, gate: 0.32, k: 5, emitSql: null, chunk: 10, score: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === "--questions") a.questions = argv[++i] ?? "";
    else if (x === "--product") a.product = argv[++i] ?? null;
    else if (x === "--chapter") a.chapter = Number(argv[++i]);
    else if (x === "--gate") a.gate = Number(argv[++i]);
    else if (x === "--k") a.k = Number(argv[++i]);
    else if (x === "--emit-sql") a.emitSql = argv[++i] ?? null;
    else if (x === "--chunk") a.chunk = Math.max(1, Number(argv[++i]) || 10);
    else if (x === "--score") {
      while (argv[i + 1] && !argv[i + 1]!.startsWith("--")) a.score.push(argv[++i]!);
    } else throw new Error(`unexpected argument ${x}`);
  }
  if (!a.questions) throw new Error("--questions <questions.json> is required");
  return a;
}

const vectorLiteral = (v: number[]): string => "[" + v.map((x) => x.toPrecision(8)).join(",") + "]";
const blockRef = (r: Row): string => `${r.unit_key ?? "?"}#${String(r.block_index).padStart(2, "0")}`;
const sqlStr = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

function score(questions: Question[], results: Map<string, Result>, gate: number, product: string | null, chapter: number): string {
  const groups = new Map<string, Question[]>();
  for (const q of questions) groups.set(q.group, [...(groups.get(q.group) ?? []), q]);
  const out: string[] = [];
  out.push(`| group | n | recall@5 block | MRR block | recall@5 unit | MRR unit | empty | best_vec min | best_vec max |`);
  out.push(`|---|---|---|---|---|---|---|---|---|`);
  let leaks = 0;
  let totalRows = 0;
  const perQ: string[] = [];
  for (const [g, qs] of groups) {
    let rb = 0, mb = 0, ru = 0, mu = 0, empty = 0, bmin = Infinity, bmax = -Infinity;
    for (const q of qs) {
      const r = results.get(q.id);
      const rows = r?.rows ?? [];
      totalRows += rows.length;
      for (const row of rows) if ((product && row.product_id !== product) || Number(row.chapter) !== chapter) leaks += 1;
      if (!rows.length) empty += 1;
      const best = rows[0]?.best_vec_score ?? null;
      if (best != null) {
        bmin = Math.min(bmin, best);
        bmax = Math.max(bmax, best);
      }
      const refs = rows.map(blockRef);
      const ib = refs.findIndex((x) => q.gold_blocks.includes(x));
      const iu = rows.findIndex((x) => x.unit_key != null && q.gold_units.includes(x.unit_key));
      if (q.gold_blocks.length) {
        if (ib >= 0) { rb += 1; mb += 1 / (ib + 1); }
        if (iu >= 0) { ru += 1; mu += 1 / (iu + 1); }
      }
      perQ.push(`${q.id} ${q.group} best_vec=${best == null ? "null" : best.toFixed(3)} ${best != null && best >= gate ? "PASS-GATE" : "GATED"} top=${refs.join(" ")}${q.gold_blocks.length ? ` gold_rank=${ib >= 0 ? ib + 1 : "-"}` : ""}${r?.error ? ` ERROR=${r.error}` : ""}`);
    }
    const scored = qs.filter((q) => q.gold_blocks.length).length;
    const f = (x: number, n: number) => (n ? (x / n).toFixed(2) : "—");
    out.push(`| ${g} | ${qs.length} | ${f(rb, scored)} | ${f(mb, scored)} | ${f(ru, scored)} | ${f(mu, scored)} | ${empty} | ${bmin === Infinity ? "—" : bmin.toFixed(3)} | ${bmax === -Infinity ? "—" : bmax.toFixed(3)} |`);
  }
  const off = questions.filter((q) => q.group === "off_chapter");
  const onq = questions.filter((q) => q.group === "in_chapter" || q.group === "alt_example");
  const fp = off.filter((q) => (results.get(q.id)?.rows[0]?.best_vec_score ?? -1) >= gate).length;
  const rej = onq.filter((q) => (results.get(q.id)?.rows[0]?.best_vec_score ?? -1) < gate).length;
  const inj = questions.filter((q) => q.group === "injection");
  const injOk = inj.filter((q) => !results.get(q.id)?.error && (results.get(q.id)?.rows.length ?? 0) > 0).length;
  out.push("");
  out.push(`gate ${gate}: off-chapter false positives ${fp}/${off.length}; in-chapter+alt wrongly rejected ${rej}/${onq.length}; injection strings answered with ordinary rows ${injOk}/${inj.length}; rows outside the requested product/chapter ${leaks}/${totalRows}`);
  out.push("");
  out.push(...perQ);
  return out.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const qfile = JSON.parse(readFileSync(args.questions, "utf-8")) as { questions: Question[] };
  const questions = qfile.questions;

  if (args.score.length) {
    const results = new Map<string, Result>();
    for (const f of args.score) {
      const raw = JSON.parse(readFileSync(f, "utf-8")) as unknown;
      // Accept the MCP/SQL-editor shapes: an array of {result} rows or the JSON array itself.
      const list = (Array.isArray(raw) ? raw : [raw]).flatMap((x) => (x && typeof x === "object" && "result" in (x as object) ? ((x as { result: unknown }).result as unknown[]) : [x]));
      for (const item of list as Result[]) if (item && item.id) results.set(item.id, { id: item.id, rows: item.rows ?? [], error: item.error });
    }
    console.log(score(questions, results, args.gate, args.product, args.chapter));
    return;
  }

  const embedder = new TitanEmbedder();
  const vectors = new Map<string, number[]>();
  for (const q of questions) vectors.set(q.id, await embedder.embed(q.text));
  console.error(`${questions.length} questions embedded (${embedder.tokens} Titan tokens)`);

  if (args.emitSql) {
    if (!args.product) throw new Error("--emit-sql needs --product <uuid>");
    let files = 0;
    for (let i = 0; i < questions.length; i += args.chunk) {
      files += 1;
      const vals = questions.slice(i, i + args.chunk).map((q) => `(${sqlStr(q.id)}, ${sqlStr(q.text)}, ${sqlStr(vectorLiteral(vectors.get(q.id)!))}::vector)`).join(",\n  ");
      const sql = `select jsonb_agg(jsonb_build_object('id', q.id, 'rows', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'product_id', h.product_id, 'chapter', h.chapter, 'unit_key', h.unit_key, 'block_index', h.block_index, 'score', h.score, 'fts_score', h.fts_score, 'vec_score', h.vec_score, 'best_vec_score', h.best_vec_score) order by h.score desc, h.id) from public.sk_search_hybrid(q.text, q.qv, '${args.product}'::uuid, ${args.chapter}, ${args.k}, 20, 60) h), '[]'::jsonb)) order by q.id) as result\nfrom (values\n  ${vals}\n) as q(id, text, qv);\n`;
      writeFileSync(`${args.emitSql}.${files}.sql`, sql, "utf-8");
    }
    console.log(`${files} SQL file(s) ${args.emitSql}.N.sql written; run each, save the JSON as ${args.emitSql}.N.json, then --score`);
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !args.product) throw new Error("direct mode needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and --product");
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  let productId = args.product;
  if (!/^[0-9a-f-]{36}$/i.test(productId)) {
    const { data } = await sb.from("sk_book_products").select("id").eq("slug", productId).maybeSingle();
    productId = (data as { id: string } | null)?.id ?? productId;
  }
  const results = new Map<string, Result>();
  for (const q of questions) {
    const { data, error } = await sb.rpc("sk_search_hybrid", { q: q.text, qv: vectors.get(q.id), p_product: productId, p_chapter: args.chapter, k: args.k, pool: 20, rrf_k: 60 });
    results.set(q.id, { id: q.id, rows: (data ?? []) as Row[], error: error?.message });
  }
  console.log(score(questions, results, args.gate, productId, args.chapter));
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
