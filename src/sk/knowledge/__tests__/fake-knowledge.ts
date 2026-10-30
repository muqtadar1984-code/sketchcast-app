// SK S7 K2 — a stand-in for the service-role client the knowledge layer reads
// through: K1's fake tables (sk_book_products, entitlements,
// book_access_grants, topic_articles, generations) plus sk_search_knowledge
// with 0174's semantics — it searches EXACTLY the sources it is handed (kind,
// id or the article wildcard, version) and never decides access. Every call's
// p_sources is recorded so a test can assert what the app passed.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { fakeDb, type FakeDb } from "./fake-db";

export type FakeBlock = {
  source_kind: "sketchcast_book" | "article" | "user_book";
  source_id: string;
  version: string;
  chapter: number | null;
  anchor: string;
  title: string;
  text: string;
  /** Only to prove a stray column never reaches a fact. */
  answer?: string;
};

export type FakeKnowledge = FakeDb & { searches: Array<{ p_query: string; p_lang: string; p_sources: any[]; p_chapter: number | null; p_limit: number }> };

const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3);

export function fakeKnowledge(tables: Record<string, Record<string, any>[]>, blocks: FakeBlock[]): FakeKnowledge {
  const db = fakeDb(tables) as FakeKnowledge;
  db.searches = [];
  const base = db.rpc;
  db.rpc = async (fn: string, args: any = {}) => {
    if (fn !== "sk_search_knowledge") return base(fn, args);
    db.searches.push(structuredClone(args));
    const src = (Array.isArray(args.p_sources) ? args.p_sources : []).filter((s: any) => ["sketchcast_book", "article", "user_book"].includes(s?.kind) && (s.id || s.kind === "article"));
    const q = words(args.p_query ?? "");
    const rows = blocks
      .map((b, i) => ({ ...b, id: i + 1 }))
      .filter((b) => src.some((s: any) => s.kind === b.source_kind && (!s.id || s.id === b.source_id) && (!s.version || s.version === b.version)))
      .filter((b) => args.p_chapter == null || b.chapter === args.p_chapter)
      .map((b) => {
        const hay = new Set(words(`${b.title} ${b.text}`));
        const rank = q.filter((w) => hay.has(w)).length;
        return { ...b, rank, text: q.reduce((t, w) => t.replace(new RegExp(`(${w})`, "ig"), "<b>$1</b>"), b.text) };
      })
      .filter((b) => b.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.id - b.id)
      .slice(0, args.p_limit ?? 8);
    return { data: rows, error: null };
  };
  return db;
}

/** The p_sources of the last search, as "kind:id@version" strings. */
export function lastSources(db: FakeKnowledge): string[] {
  const s = db.searches.at(-1)?.p_sources ?? [];
  return s.map((x: any) => `${x.kind}:${x.id ?? "*"}${x.version ? `@${x.version}` : ""}`).sort();
}
