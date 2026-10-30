/**
 * SK S7 slice K1 — backfill the knowledge blocks (migration 0174) from the
 * approved articles and the users' uploaded books. DRY RUN BY DEFAULT: it
 * reads everything and prints what it WOULD write; nothing is written
 * without --apply. Run it only after 0174 is applied.
 *
 *   node --env-file=.env.local scripts/sk-knowledge-backfill.ts articles              # dry run
 *   node --env-file=.env.local scripts/sk-knowledge-backfill.ts user-books            # dry run
 *   node --env-file=.env.local scripts/sk-knowledge-backfill.ts all --apply           # write both
 *   node --env-file=.env.local scripts/sk-knowledge-backfill.ts user-books --apply --max-batches 5
 *                                                                                      # resumable: re-run to continue
 *
 * Options:
 *   articles | user-books | all   what to import (required)
 *   --apply              write (default: dry run)
 *   --book <uuid>        user books: only this book (repeatable)
 *   --batch <n>          articles per transaction (default 25) / chapters per transaction (default 50)
 *   --max-chars <n>      user books: characters per transaction (default 1500000)
 *   --max-batches <n>    user books: stop after n transactions (the next run resumes)
 *   --since <iso>        articles: only rows updated since
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the service
 * role: the blocks table has no client grants). Production writes are a
 * founder decision — off-peak (20:00–05:00 UTC) is kinder to the database.
 * Runs on Node ≥ 22.6 type stripping; a tiny resolve hook below maps the
 * app's extensionless imports to their .ts files.
 *
 * Exit codes: 0 done; 1 crashed; 2 bad arguments / missing env.
 */
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ArticleImportResult } from "../src/sk/knowledge/articles";
import type { UserBookImportResult } from "../src/sk/knowledge/user-books";
import type { KnowledgeDb } from "../src/sk/knowledge/store";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Resolve "@/x" to src/x and an extensionless relative import to its .ts file.
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

/** A dry run CANNOT write: every write path of the client throws. */
export function readOnly(db: KnowledgeDb): KnowledgeDb {
  const WRITES = new Set(["insert", "update", "upsert", "delete"]);
  return {
    rpc: (fn: string, args?: Record<string, unknown>) => {
      if (fn !== "sk_knowledge_versions") throw new Error(`dry run: refused rpc ${fn}`);
      return db.rpc(fn, args);
    },
    from: (table: string) =>
      new Proxy(db.from(table), {
        get(target, p) {
          if (WRITES.has(String(p))) throw new Error(`dry run: refused ${String(p)} on ${table}`);
          const v = Reflect.get(target, p);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }),
  };
}

type Args = { what: "articles" | "user-books" | "all"; apply: boolean; books: string[]; batch?: number; maxChars?: number; maxBatches?: number; since?: string };

function parse(argv: string[]): Args {
  const a: Args = { what: "all", apply: false, books: [] };
  let what: string | null = null;
  const num = (v: string | undefined, flag: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a positive integer`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--apply") a.apply = true;
    else if (x === "--book") a.books.push(argv[++i] ?? "");
    else if (x === "--batch") a.batch = num(argv[++i], x);
    else if (x === "--max-chars") a.maxChars = num(argv[++i], x);
    else if (x === "--max-batches") a.maxBatches = num(argv[++i], x);
    else if (x === "--since") a.since = argv[++i];
    else if (!what && ["articles", "user-books", "all"].includes(x)) what = x;
    else throw new Error(`unexpected argument ${x}`);
  }
  if (!what) throw new Error("say what to import: articles | user-books | all");
  a.what = what as Args["what"];
  return a;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parse(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (e.g. --env-file=.env.local)");
    return 2;
  }
  register("data:text/javascript," + encodeURIComponent(HOOK), { parentURL: import.meta.url, data: { src: pathToFileURL(resolve(ROOT, "src") + "/").href } });

  const { createClient } = await import("@supabase/supabase-js");
  const dryRun = !args.apply;
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) as unknown as KnowledgeDb;
  const db = dryRun ? readOnly(client) : client;
  const log = (line: string) => console.log(`  ${line}`);
  console.log(`SK knowledge backfill — ${dryRun ? "DRY RUN (nothing is written; add --apply to write)" : "APPLY"}`);

  const modPath = (m: string) => pathToFileURL(resolve(ROOT, "src/sk/knowledge", `${m}.ts`)).href;
  if (args.what === "articles" || args.what === "all") {
    const { importArticles } = await import(modPath("articles"));
    const r = (await importArticles(db, { dryRun, batch: args.batch, since: args.since, log })) as ArticleImportResult;
    if (r.migrationMissing) console.log("  note: 0174 is not applied — counts assume nothing is imported yet");
    console.log(`articles: ${r.current} current, ${r.upToDate} up to date, ${r.imported} ${dryRun ? "to import" : "imported"}; ${r.blocks} blocks, ${r.chars} chars`, r.byKind, r.pruned ? `pruned ${JSON.stringify(r.pruned)}` : "");
  }
  if (args.what === "user-books" || args.what === "all") {
    const { importUserBooks } = await import(modPath("user-books"));
    const r = (await importUserBooks(db, { dryRun, bookIds: args.books.length ? args.books : undefined, batch: args.batch, maxChars: args.maxChars, maxBatches: args.maxBatches, log })) as UserBookImportResult;
    if (r.migrationMissing) console.log("  note: 0174 is not applied — counts assume nothing is imported yet");
    console.log(
      `user books: ${r.books} books (${r.eligibleBooks} eligible, ${r.skippedRemoved} removed, ${r.skippedJunk} junk-gated unconfirmed); ` +
        `${r.chapters} chapters: ${r.chaptersUpToDate} up to date, ${r.chaptersImported} ${dryRun ? "to import" : "imported"}, ${r.chaptersRemaining} left for the next run; ` +
        `${r.blocks} blocks, ${r.chars} chars in ${r.batches} transaction(s); ${r.cleared} excluded book(s) cleared; detected languages ${JSON.stringify(r.detectedLanguages)}`,
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error("backfill failed:", (e as Error).stack ?? e);
    process.exit(1);
  },
);
