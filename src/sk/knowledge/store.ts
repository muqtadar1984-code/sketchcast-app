// SK S7 K1 — the knowledge layer's database seam (migration 0174). Every
// write goes through sk_knowledge_replace (delete the scopes, insert the
// blocks, one transaction); every "what is already imported" question through
// sk_knowledge_versions. Callers pass the SERVICE-ROLE client: the tables have
// no client grants at all. No "server-only" import, so the backfill script can
// load it under plain Node.

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The slice of a Supabase client the importers use (structural, for fakes). */
export type KnowledgeDb = { from: (table: string) => any; rpc: (fn: string, args?: Record<string, unknown>) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type SourceKind = "sketchcast_book" | "article" | "user_book";
export type BlockKind = "section" | "exercise_stem" | "paragraph" | "glossary" | "misconception" | "worked_example";

export type KnowledgeBlock = {
  source_kind: SourceKind;
  source_id: string;
  version: string;
  release_id?: number | null;
  chapter: number | null;
  anchor: string;
  language: string;
  title: string;
  text: string;
  kind: BlockKind;
};

/** Delete everything in a scope (language / chapter narrow it when given). */
export type BlockScope = { source_kind: SourceKind; source_id: string; language?: string; chapter?: number };

export type DbError = { code?: string; message?: string } | null | undefined;

/** A relation that does not exist yet (Postgres 42P01, or PostgREST's schema-cache miss). */
export function isMissingRelation(e: DbError): boolean {
  if (!e) return false;
  return e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST202" || /does not exist|schema cache/i.test(e.message ?? "");
}

export async function replaceBlocks(db: KnowledgeDb, scopes: BlockScope[], blocks: KnowledgeBlock[]): Promise<{ deleted: number; inserted: number }> {
  const { data, error } = (await db.rpc("sk_knowledge_replace", { p_scopes: scopes, p_blocks: blocks })) ?? {};
  if (error) throw new Error(`sk_knowledge_replace failed: ${error.message ?? error.code ?? "error"}`);
  const d = (data ?? {}) as { deleted?: number; inserted?: number };
  return { deleted: Number(d.deleted ?? 0), inserted: Number(d.inserted ?? 0) };
}

export type ImportedVersion = { source_id: string; language: string; chapter: number | null; version: string; blocks: number; imported_at: string };

/** What is imported for one source kind. `missing` = 0174 is not applied (dry runs may continue). */
export async function importedVersions(db: KnowledgeDb, kind: SourceKind): Promise<{ rows: ImportedVersion[]; missing: boolean }> {
  const { data, error } = (await db.rpc("sk_knowledge_versions", { p_source_kind: kind })) ?? {};
  if (error) {
    if (isMissingRelation(error)) return { rows: [], missing: true };
    throw new Error(`sk_knowledge_versions failed: ${error.message ?? error.code ?? "error"}`);
  }
  const rows = (Array.isArray(data) ? data : []) as ImportedVersion[];
  return { rows: rows.map((r) => ({ ...r, chapter: r.chapter ?? null, blocks: Number(r.blocks ?? 0) })), missing: false };
}

/** Give repeated anchors within one source a #2, #3 … suffix. */
export function uniqueAnchors(blocks: KnowledgeBlock[]): KnowledgeBlock[] {
  const seen = new Map<string, number>();
  return blocks.map((b) => {
    const key = `${b.source_id}|${b.chapter}|${b.kind}|${b.anchor}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? b : { ...b, anchor: `${b.anchor}#${n}` };
  });
}
