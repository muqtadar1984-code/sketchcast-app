// SK S7 K1 — the call shape of sk_search_knowledge (migration 0174). K2's
// knowledge.search builds on this: it computes the sources a user MAY use
// (sourcesFor) and passes only those; the database function never decides
// access. Service-role client only.

import type { KnowledgeDb, SourceKind } from "./store";

/** A source the caller is allowed to search. `id` may be omitted for kind
 *  'article' only (every article); `version` pins one release / version. */
export type KnowledgeSource = { kind: SourceKind; id?: string; version?: string };

export type KnowledgeHit = {
  id: number;
  source_kind: SourceKind;
  source_id: string;
  version: string;
  chapter: number | null;
  anchor: string;
  title: string;
  /** a ts_headline snippet, at most 600 characters, matches in <b>…</b> */
  text: string;
  rank: number;
};

export type SearchResult = { status: "ok"; hits: KnowledgeHit[] } | { status: "error"; message: string };

export const MAX_SEARCH_LIMIT = 50;

export async function searchKnowledge(
  db: Pick<KnowledgeDb, "rpc">,
  args: { query: string; lang: string; sources: KnowledgeSource[]; chapter?: number | null; limit?: number },
): Promise<SearchResult> {
  const query = (args.query ?? "").trim().slice(0, 500);
  // never send a source list with a non-article wildcard: the function drops them, but say so here too
  const sources = (args.sources ?? []).filter((s) => !!s && (s.kind === "article" || !!s.id));
  if (!query || !sources.length) return { status: "ok", hits: [] };
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 8)), MAX_SEARCH_LIMIT);
  const { data, error } =
    (await db.rpc("sk_search_knowledge", {
      p_query: query,
      p_lang: args.lang || "en",
      p_sources: sources.map((s) => ({ kind: s.kind, ...(s.id ? { id: s.id } : {}), ...(s.version ? { version: s.version } : {}) })),
      p_chapter: args.chapter ?? null,
      p_limit: limit,
    })) ?? {};
  if (error) return { status: "error", message: error.message ?? "sk_search_knowledge failed" };
  const rows = (Array.isArray(data) ? data : []) as KnowledgeHit[];
  return { status: "ok", hits: rows.map((r) => ({ ...r, id: Number(r.id), rank: Number(r.rank), chapter: r.chapter ?? null })) };
}
