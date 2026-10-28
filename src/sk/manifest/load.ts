// Kit Manifest — loading ONE presentation's inputs from the database and the
// artifacts bucket (S1 slice A; Final Plan §5.1–5.2). Everything the pure
// derivation in ./derive.ts needs, nothing more. Admin client only: the route
// runs its own gate + owner check before this is reached.
//
// What is read, and from where:
//   generations        the presentation row (owner, book/chapter or article, params)
//   artifacts          every row of the presentation; the newest DONE worksheet
//                      of the same owner on the same chapter (book kits) or
//                      article (catalogue kits) — those rows are PINNED too, so
//                      the manifest's items go stale with their worksheet
//   storage/artifacts  script.json (+ script_partN.json) and worksheet_questions.json
//   chapter_grounding  concepts for (book_id, chapter_num) on the book path
//   topic_articles     objectives on the catalogue path (article_id in params)
//
// Null-safe by construction: a presentation with no script_json yields
// scripts=[] (→ completeness.script "missing"); no worksheet → items=[]; no
// concept source → concepts=null. Only a hard refusal throws (not found, not a
// presentation, not done, withdrawn) — the service turns that into a `failed` row.

import type { ArtifactRow, ConceptSrc, ItemSrc, KitInput, ScriptFile } from "./derive";
import { partOf, videoPathFor } from "./derive";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The slice of a service-role Supabase client this module uses (a fake in tests). */
export type ManifestAdmin = {
  from: (table: string) => any;
  storage: { from: (bucket: string) => { download: (path: string) => Promise<{ data: { text: () => Promise<string> } | null; error: unknown }> } };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export const ARTIFACTS_BUCKET = "artifacts";

export class ManifestLoadError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "not_presentation" | "not_done" | "withdrawn" | "read_failed",
  ) {
    super(message);
    this.name = "ManifestLoadError";
  }
}

export type GenerationRow = {
  id: string;
  owner_id: string;
  book_id: string | null;
  chapter_ref: string | null;
  kind: string;
  status: string;
  withdrawn_at: string | null;
  params: Record<string, unknown> | null;
};

export type LoadedKit = {
  input: KitInput;
  /** The rows the manifest pins (presentation + worksheet). Same list as input.artifacts. */
  artifactRows: ArtifactRow[];
  generation: GenerationRow;
  /** The worksheet generation whose questions became the items, if any. */
  worksheetGenerationId: string | null;
};

const SCRIPT_RE = /\/script(?:_part(\d+))?\.json$/;

/** Part number encoded in a script_json storage path (script.json → 1). */
export function scriptPartFromPath(path: string): number | null {
  const m = SCRIPT_RE.exec(path);
  if (!m) return null;
  return m[1] ? Number(m[1]) : 1;
}

/** The answer of a questions.json item as one string (pairs for matching items). */
export function answerText(q: Record<string, unknown>): string {
  if (Array.isArray(q.pairs))
    return (q.pairs as Record<string, unknown>[]).map((p) => `${String(p.left ?? p.a ?? "")} → ${String(p.right ?? p.b ?? "")}`).join("; ");
  const a = q.answer;
  return typeof a === "string" ? a : JSON.stringify(a ?? "");
}

/** chapter_grounding.concepts is the worker's analysis object; the list sits at
 * analysis.concepts.concepts (M1 rows), but older rows carried it one level up or
 * as a bare array. First array wins; anything else is "no concepts". */
export function conceptsFromGrounding(raw: unknown): ConceptSrc[] | null {
  const candidates: unknown[] = [];
  const a = raw as Record<string, unknown> | unknown[] | null;
  if (Array.isArray(a)) candidates.push(a);
  else if (a && typeof a === "object") {
    const b = (a as Record<string, unknown>).concepts;
    if (Array.isArray(b)) candidates.push(b);
    else if (b && typeof b === "object") candidates.push((b as Record<string, unknown>).concepts);
  }
  const list = candidates.find((c): c is Record<string, unknown>[] => Array.isArray(c) && c.length > 0);
  if (!list) return null;
  const out = list
    .filter((c) => c && typeof c === "object" && (c.concept_id || c.id) && (c.name || c.text))
    .map((c) => ({
      concept_id: String(c.concept_id ?? c.id),
      name: String(c.name ?? c.text),
      definition: String(c.definition ?? c.text ?? c.name ?? ""),
    }));
  return out.length ? out : null;
}

/** topic_articles.objectives [{id, text}] as concepts (the catalogue path, M1 "article_objectives"). */
export function conceptsFromObjectives(raw: unknown): ConceptSrc[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = (raw as Record<string, unknown>[])
    .filter((o) => o && typeof o === "object" && o.id && o.text)
    .map((o) => ({ concept_id: String(o.id), name: String(o.text), definition: String(o.text) }));
  return out.length ? out : null;
}

async function downloadJson<T>(admin: ManifestAdmin, path: string): Promise<T | null> {
  const dl = await admin.storage.from(ARTIFACTS_BUCKET).download(path);
  if (dl.error || !dl.data) return null;
  try {
    return JSON.parse(await dl.data.text()) as T;
  } catch {
    return null;
  }
}

async function rowsOf(admin: ManifestAdmin, generationIds: string[]): Promise<ArtifactRow[]> {
  if (!generationIds.length) return [];
  const { data, error } = await admin.from("artifacts").select("id, generation_id, kind, storage_path, created_at").in("generation_id", generationIds);
  if (error) throw new ManifestLoadError(`artifacts read failed: ${(error as { message?: string }).message ?? "unknown"}`, "read_failed");
  return ((data ?? []) as ArtifactRow[]).map((r) => ({ id: String(r.id), generation_id: String(r.generation_id), kind: String(r.kind), storage_path: String(r.storage_path), created_at: String(r.created_at) }));
}

/** The newest DONE worksheet of the same owner on the same chapter (book kit)
 * or article (catalogue kit). One worksheet: a second version of the same
 * questions would only duplicate items (S1 choice, see docs/sk-manifest.md). */
async function newestWorksheet(admin: ManifestAdmin, gen: GenerationRow, articleId: string | null): Promise<string | null> {
  let q = admin.from("generations").select("id").eq("owner_id", gen.owner_id).eq("kind", "worksheet").eq("status", "done").is("withdrawn_at", null);
  if (gen.book_id && gen.chapter_ref !== null && gen.chapter_ref !== undefined) q = q.eq("book_id", gen.book_id).eq("chapter_ref", String(gen.chapter_ref));
  else if (articleId) q = q.eq("params->>article_id", articleId);
  else return null;
  const { data } = await q.order("created_at", { ascending: false }).limit(1);
  const row = ((data ?? []) as { id: string }[])[0];
  return row ? String(row.id) : null;
}

export async function loadKitInput(admin: ManifestAdmin, generationId: string): Promise<LoadedKit> {
  const { data: gen, error } = await admin
    .from("generations")
    .select("id, owner_id, book_id, chapter_ref, kind, status, withdrawn_at, params")
    .eq("id", generationId)
    .maybeSingle();
  if (error) throw new ManifestLoadError(`generation read failed: ${(error as { message?: string }).message ?? "unknown"}`, "read_failed");
  if (!gen) throw new ManifestLoadError("generation not found", "not_found");
  const g = gen as GenerationRow;
  if (g.kind !== "presentation") throw new ManifestLoadError(`generation is a ${g.kind}, not a presentation`, "not_presentation");
  if (g.withdrawn_at) throw new ManifestLoadError("generation is withdrawn", "withdrawn");
  if (g.status !== "done") throw new ManifestLoadError(`generation status is ${g.status}, not done`, "not_done");
  const params = (g.params ?? {}) as Record<string, unknown>;
  const articleId = typeof params.article_id === "string" && params.article_id ? params.article_id : null;

  // Presentation rows + the worksheet's rows: both are pinned.
  const worksheetId = await newestWorksheet(admin, g, articleId);
  const artifacts = await rowsOf(admin, worksheetId ? [g.id, worksheetId] : [g.id]);

  // Scripts, one file per part, sorted by part.
  const scriptRows = artifacts
    .filter((a) => a.generation_id === g.id && a.kind === "script_json" && scriptPartFromPath(a.storage_path) !== null)
    .sort((a, b) => (scriptPartFromPath(a.storage_path) as number) - (scriptPartFromPath(b.storage_path) as number));
  const scripts: ScriptFile[] = [];
  for (const row of scriptRows) {
    const sf = await downloadJson<ScriptFile>(admin, row.storage_path);
    if (!sf || !sf.script || !Array.isArray(sf.script.segments) || !sf.video || !Array.isArray(sf.video.segments)) continue;
    if (typeof sf.part !== "number") sf.part = scriptPartFromPath(row.storage_path);
    scripts.push(sf);
  }

  // Items from the worksheet's questions file.
  const items: ItemSrc[] = [];
  if (worksheetId) {
    const qRow = artifacts.find((a) => a.generation_id === worksheetId && a.kind === "questions_json");
    const qj = qRow ? await downloadJson<{ questions?: Record<string, unknown>[] }>(admin, qRow.storage_path) : null;
    for (const q of (qj && Array.isArray(qj.questions) ? qj.questions : []) as Record<string, unknown>[]) {
      if (!q || typeof q !== "object" || q.id === undefined) continue;
      items.push({
        q_id: `ws:${worksheetId.slice(0, 8)}:${String(q.id)}`,
        source: "worksheet",
        generation_id: worksheetId,
        type: String(q.type ?? "unknown"),
        prompt: String(q.prompt ?? ""),
        answer: answerText(q),
        bank_item_id: typeof q.bank_item_id === "string" ? q.bank_item_id : undefined,
        objective_ref: typeof q.objective_ref === "string" ? q.objective_ref : undefined,
      });
    }
  }

  // Concepts: chapter_grounding on the book path, article objectives on the catalogue path.
  let concepts: ConceptSrc[] | null = null;
  let conceptSource: KitInput["concept_source"] = "none";
  let articleSourceId: string | null = null;
  const chapterNum = g.book_id && g.chapter_ref !== null ? parseInt(String(g.chapter_ref), 10) : NaN;
  if (g.book_id && !Number.isNaN(chapterNum)) {
    const { data: cg } = await admin.from("chapter_grounding").select("concepts").eq("book_id", g.book_id).eq("chapter_num", chapterNum).maybeSingle();
    concepts = conceptsFromGrounding(cg ? (cg as { concepts: unknown }).concepts : null);
    if (concepts) conceptSource = "chapter_grounding";
  }
  if (!concepts && articleId) {
    const { data: art } = await admin.from("topic_articles").select("id, source_article_id, objectives").eq("id", articleId).maybeSingle();
    if (art) {
      const a = art as { source_article_id: string | null; objectives: unknown };
      articleSourceId = a.source_article_id ? String(a.source_article_id) : null;
      concepts = conceptsFromObjectives(a.objectives);
      if (concepts) conceptSource = "article_objectives";
    }
  }

  const hasVideo: Record<number, boolean> = {};
  for (const s of scripts) {
    const p = partOf(s);
    hasVideo[p] = videoPathFor(p, artifacts, g.id) !== null;
  }
  const fv = params.format_version;
  const input: KitInput = {
    generation_id: g.id,
    book_id: g.book_id ?? null,
    chapter_ref: g.chapter_ref === undefined || g.chapter_ref === null ? null : String(g.chapter_ref),
    article_id: articleId,
    article_source_id: articleSourceId,
    format_version: fv === undefined || fv === null || fv === "" ? null : Number(fv),
    language: typeof params.language === "string" && params.language ? params.language : scripts[0]?.language ?? null,
    scripts,
    artifacts,
    concepts,
    concept_source: conceptSource,
    items,
    has_video: hasVideo,
  };
  return { input, artifactRows: artifacts, generation: g, worksheetGenerationId: worksheetId };
}
