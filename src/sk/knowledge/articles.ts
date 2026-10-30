// SK S7 K1 — free ready-made articles → knowledge blocks.
//
// The current version of every approved topic_articles row per (topic,
// language) becomes blocks: one per section (body_md), glossary entry,
// misconception and worked example. source_id = topic_articles.id, version =
// the article version. An article whose version is already imported is
// skipped (idempotent); blocks of superseded or unapproved versions are
// removed by sk_knowledge_prune() at the end. Each batch of articles is one
// transaction (sk_knowledge_replace). Service-role client only. No
// "server-only" import: scripts/sk-knowledge-backfill.ts loads it under Node.

import { importedVersions, replaceBlocks, uniqueAnchors, type BlockScope, type KnowledgeBlock, type KnowledgeDb } from "./store";
import { chunkText, normLanguage, plain } from "./text";

export type ArticleRow = {
  id: string;
  topic_id: string;
  version: number;
  language: string;
  title: string | null;
  sections?: unknown;
  glossary?: unknown;
  misconceptions?: unknown;
  worked_examples?: unknown;
};

const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [];
const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** One article version's blocks (pure). */
export function articleBlocks(a: ArticleRow): KnowledgeBlock[] {
  const language = normLanguage(a.language) ?? "en";
  const title = plain(a.title ?? "");
  const base = { source_kind: "article" as const, source_id: String(a.id), version: String(a.version), release_id: null, chapter: null, language };
  const out: KnowledgeBlock[] = [];
  const push = (anchor: string, t: string, text: string, kind: KnowledgeBlock["kind"]) =>
    chunkText(text).forEach((chunk, k) => out.push({ ...base, anchor: k ? `${anchor}~${k + 1}` : anchor, title: t.slice(0, 500), text: chunk, kind }));

  arr(a.sections).forEach((sec, i) => {
    const heading = plain(s(sec.heading) || s(sec.title));
    push(s(sec.id).trim() || `s${i + 1}`, heading || title, plain(sec.body_md), "section");
  });
  arr(a.glossary).forEach((g, i) => {
    const term = plain(g.term);
    const def = plain(g.definition);
    if (term || def) push(`g${i + 1}`, term || title, term ? `${term}: ${def}` : def, "glossary");
  });
  arr(a.misconceptions).forEach((m, i) => {
    const wrong = plain(m.misconception);
    const right = plain(m.correction);
    if (wrong || right) push(s(m.id).trim() || `m${i + 1}`, title, `Common mistake: ${wrong} Correct idea: ${right}`, "misconception");
  });
  arr(a.worked_examples).forEach((w, i) => {
    const text = `${plain(w.problem)} ${plain(w.solution_md)}`.trim();
    if (text) push(s(w.id).trim() || `w${i + 1}`, title, text, "worked_example");
  });
  return uniqueAnchors(out.filter((b) => b.text.length > 0));
}

/** The current approved version per (topic, language): its row id. */
export function currentArticleIds(rows: Pick<ArticleRow, "id" | "topic_id" | "language" | "version">[]): Set<string> {
  const best = new Map<string, { id: string; version: number }>();
  for (const r of rows) {
    const k = `${r.topic_id}|${r.language}`;
    const b = best.get(k);
    if (!b || Number(r.version) > b.version) best.set(k, { id: String(r.id), version: Number(r.version) });
  }
  return new Set([...best.values()].map((b) => b.id));
}

export type ArticleImportResult = {
  dryRun: boolean;
  current: number;
  imported: number;
  upToDate: number;
  blocks: number;
  chars: number;
  byKind: Record<string, number>;
  pruned: { articles: number; user_books: number } | null;
  migrationMissing: boolean;
};

const PAGE = 1000;

export async function importArticles(
  db: KnowledgeDb,
  opts: { since?: string; dryRun?: boolean; batch?: number; log?: (line: string) => void } = {},
): Promise<ArticleImportResult> {
  const batch = Math.max(1, opts.batch ?? 25);
  const log = opts.log ?? (() => {});

  // 1. which rows are current (metadata only)
  const meta: Pick<ArticleRow, "id" | "topic_id" | "language" | "version">[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("topic_articles")
      .select("id, topic_id, language, version")
      .eq("status", "approved")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`topic_articles read failed: ${error.message}`);
    meta.push(...((data ?? []) as typeof meta));
    if (!data || data.length < PAGE) break;
  }
  const current = currentArticleIds(meta);

  // 2. what is already imported; `since` narrows to recently changed rows
  const { rows: imported, missing } = await importedVersions(db, "article");
  const have = new Set(imported.map((r) => `${r.source_id}|${r.version}`));
  let todo = meta.filter((m) => current.has(String(m.id)) && !have.has(`${m.id}|${m.version}`)).map((m) => String(m.id));
  if (opts.since) {
    const { data, error } = await db.from("topic_articles").select("id").eq("status", "approved").gte("updated_at", opts.since);
    if (error) throw new Error(`topic_articles read failed: ${error.message}`);
    const changed = new Set(((data ?? []) as { id: string }[]).map((r) => String(r.id)));
    todo = todo.filter((id) => changed.has(id));
  }

  const out: ArticleImportResult = {
    dryRun: !!opts.dryRun,
    current: current.size,
    imported: 0,
    upToDate: current.size - todo.length,
    blocks: 0,
    chars: 0,
    byKind: {},
    pruned: null,
    migrationMissing: missing,
  };

  // 3. content in batches; each batch is one transaction
  for (let i = 0; i < todo.length; i += batch) {
    const ids = todo.slice(i, i + batch);
    const { data, error } = await db
      .from("topic_articles")
      .select("id, topic_id, version, language, title, sections, glossary, misconceptions, worked_examples")
      .in("id", ids);
    if (error) throw new Error(`topic_articles read failed: ${error.message}`);
    const rows = (data ?? []) as ArticleRow[];
    const blocks = rows.flatMap(articleBlocks);
    const scopes: BlockScope[] = rows.map((r) => ({ source_kind: "article", source_id: String(r.id) }));
    if (!opts.dryRun) await replaceBlocks(db, scopes, blocks);
    out.imported += rows.length;
    out.blocks += blocks.length;
    for (const b of blocks) {
      out.chars += b.text.length;
      out.byKind[b.kind] = (out.byKind[b.kind] ?? 0) + 1;
    }
    log(`articles ${Math.min(i + batch, todo.length)}/${todo.length}: +${blocks.length} blocks`);
  }

  // 4. superseded / unapproved versions out
  if (!opts.dryRun) {
    const { data, error } = (await db.rpc("sk_knowledge_prune")) ?? {};
    if (error) throw new Error(`sk_knowledge_prune failed: ${error.message}`);
    out.pruned = { articles: Number(data?.articles ?? 0), user_books: Number(data?.user_books ?? 0) };
  }
  return out;
}
