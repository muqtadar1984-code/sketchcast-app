// Worksheet practice — CONCEPT TAGS (SK student Board plan 2026-10-31, phase 4).
// Which idea of the kit's lesson map does each worksheet question test? Once
// per question, cached (0179 sk_practice_concepts), never on a read path.
//
// WHERE A TAG COMES FROM, cheapest first:
//   1. the paper names it (`concept` / `skill` / `topic` on the question) —
//      matched to a lesson-map concept by name when one fits, else kept as a
//      paper concept ("p:<slug>");
//   2. the LESSON MAP already mapped it: sk_manifests.items carries every
//      worksheet question with its concept_ids (S1 derivation, ws:<8>:<qid>);
//   3. Haiku 5.5, ONE call for every still-untagged question of the worksheet,
//      given the lesson map's concepts and told to choose among them only; a
//      reply naming anything else is dropped for that question;
//   4. the KIT itself (key "kit", the kit's title) — never cached, so a lesson
//      map that appears later still gets its chance.
//
// COST: (1)–(2) are free; (3) is ~1.5k input + ~200 output tokens ≈ $0.0003
// per worksheet, ONCE (every later student reads the cache). Tags are made
// lazily at practice time — the answer route runs tagWorksheet() after the
// reply (next/server `after`) on a session's first answer on a worksheet and
// again when the worksheet is finished — and by the weekly plan sweep. The
// mastery READ paths (student, teacher, parent) only read the cache.

import type { RawQuestion, RawQuiz } from "@/app/api/quiz/logic";
import type { KitManifest } from "@/sk/manifest/derive";
import type { DbRow, SkDb } from "@/sk/store-supabase";
import type { HelpModelCall, HelpUsage } from "./help";
import { questionHash } from "./help";
import { conceptSlug } from "./mastery";

export const CONCEPT_MODEL = "claude-haiku-5-5";
/** Haiku 5.5, USD per token (as help.ts / manifest/service.ts). */
const PRICE_IN = 0.1 / 1e6;
const PRICE_OUT = 0.5 / 1e6;
export const CONCEPT_MAX_TOKENS = 600;
/** At most this many questions in the one model call (a worksheet is ~10–30). */
export const CONCEPT_MAX_QUESTIONS = 60;
/** The kit-level fallback's key. */
export const KIT_CONCEPT = "kit";

export type ConceptOption = { key: string; name: string; definition?: string };
export type ConceptMethod = "paper" | "manifest" | "model" | "fallback";
export type ConceptTag = { questionId: string; key: string; name: string; method: ConceptMethod };

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const normName = (s: unknown) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** A paper concept's key slug (shared with the mastery rule's paper fallback). */
export const slugOf = conceptSlug;

/** The lesson map's concepts as choices (ids + names), or []. */
export function conceptOptions(m: KitManifest | null | undefined): ConceptOption[] {
  if (!m || !Array.isArray(m.concepts)) return [];
  return m.concepts
    .filter((c) => c && typeof c.concept_id === "string" && c.concept_id && typeof c.name === "string" && c.name.trim())
    .map((c) => ({ key: clip(c.concept_id, 120), name: clip(c.name, 200), definition: typeof c.definition === "string" ? clip(c.definition, 200) : undefined }));
}

/** The concept the paper itself names on a question, or null. */
export function paperConcept(q: RawQuestion): string | null {
  const r = q as unknown as Record<string, unknown>;
  for (const k of ["concept", "skill", "topic", "objective"]) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return clip(v, 200);
  }
  return null;
}

/** A question's tag from the paper (matched to the map by name when one fits). */
export function paperTag(q: RawQuestion, options: ConceptOption[]): ConceptTag | null {
  const named = paperConcept(q);
  if (!named) return null;
  const n = normName(named);
  const hit = options.find((o) => normName(o.name) === n || normName(o.key) === n);
  return hit ? { questionId: String(q.id), key: hit.key, name: hit.name, method: "paper" } : { questionId: String(q.id), key: `p:${slugOf(named)}`, name: named, method: "paper" };
}

/** A worksheet item's q_id without its `ws:<8 of the worksheet id>:` prefix (manifest/load.ts). */
const qTail = (q: string): string => /^ws:[^:]+:(.+)$/.exec(q)?.[1] ?? q;

/** The lesson map's own tag for a worksheet question, or null. */
export function manifestTag(m: KitManifest | null | undefined, worksheetId: string, questionId: string, options: ConceptOption[]): ConceptTag | null {
  if (!m || !Array.isArray(m.items)) return null;
  const item = m.items.find((i) => i && i.source === "worksheet" && i.generation_id === worksheetId && qTail(String(i.q_id)) === questionId);
  const id = item?.concept_ids?.[0];
  if (!id) return null;
  const opt = options.find((o) => o.key === id);
  return opt ? { questionId, key: opt.key, name: opt.name, method: "manifest" } : null;
}

/** The ONE model call's prompt: every untagged question, the map's concepts, JSON out. */
export function conceptPrompt(questions: RawQuestion[], options: ConceptOption[]): { system: string; user: string } {
  const system = [
    "You tag school worksheet questions with the ONE lesson concept each question tests.",
    "Choose ONLY from the concept ids listed. If none fits a question, use null for it.",
    'Reply with JSON only, no prose: {"<question id>": "<concept id>" | null, ...} — one entry per question.',
  ].join(" ");
  const user = [
    "Concepts:",
    ...options.map((o) => `- ${o.key}: ${o.name}${o.definition ? ` — ${o.definition}` : ""}`),
    "",
    "Questions:",
    ...questions.map((q) => `- ${String(q.id)}: ${clip(String(q.prompt ?? ""), 300)}`),
  ].join("\n");
  return { system, user };
}

/** The model's JSON → question id → a listed concept id (anything else dropped). */
export function parseConceptReply(text: string, questionIds: string[], options: ConceptOption[]): Map<string, string> {
  const out = new Map<string, string>();
  const m = /\{[\s\S]*\}/.exec(String(text ?? ""));
  if (!m) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return out;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  const keys = new Set(options.map((o) => o.key));
  const want = new Set(questionIds);
  for (const [qid, v] of Object.entries(obj as Record<string, unknown>)) {
    if (want.has(qid) && typeof v === "string" && keys.has(v)) out.set(qid, v);
  }
  return out;
}

export const conceptCost = (u: HelpUsage): number => Math.round((u.input_tokens * PRICE_IN + u.output_tokens * PRICE_OUT) * 1e6) / 1e6;

export type TagDeps = {
  db: SkDb;
  /** The kit's lesson map (sk_manifests via readManifest), or null. Called at most once. */
  loadManifest: () => Promise<KitManifest | null>;
  /** The model; null = not configured (untagged questions fall back to the kit). */
  call: HelpModelCall | null;
  /** The kit's name for the fallback concept. */
  kitTitle: string;
  log?: (msg: string) => void;
};

/** The cached tags of a worksheet: question id → its newest row for this hash. */
async function cachedTags(db: SkDb, worksheetId: string): Promise<DbRow[]> {
  const { data, error } = await db
    .from("sk_practice_concepts")
    .select("question_id, question_hash, concept_key, concept_name, method, created_at")
    .eq("generation_id", worksheetId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`sk_practice_concepts read failed: ${error.message ?? error.code ?? "?"}`);
  return (data ?? []) as DbRow[];
}

/**
 * Every question of the worksheet → its concept tag, filling the cache for
 * the ones not tagged yet (paper → lesson map → ONE model call → kit). Never
 * throws: a failed read or write leaves the question on the kit fallback.
 */
export async function tagWorksheet(deps: TagDeps, worksheetId: string, paper: RawQuiz): Promise<Map<string, ConceptTag>> {
  const out = new Map<string, ConceptTag>();
  const questions = (paper?.questions ?? []).filter((q) => q && q.id !== undefined && q.id !== null && String(q.id).length <= 80);
  const fallback = (qid: string): ConceptTag => ({ questionId: qid, key: KIT_CONCEPT, name: clip(deps.kitTitle || "This lesson", 200) || "This lesson", method: "fallback" });

  let cached: DbRow[] = [];
  try {
    cached = await cachedTags(deps.db, worksheetId);
  } catch (e) {
    deps.log?.(`sk-practice.concepts ${(e as Error).message}`);
  }
  const hashOf = new Map(questions.map((q) => [String(q.id), questionHash(q)] as const));
  const todo: RawQuestion[] = [];
  for (const q of questions) {
    const qid = String(q.id);
    const row = cached.find((r) => String(r.question_id) === qid && String(r.question_hash) === hashOf.get(qid));
    if (row) out.set(qid, { questionId: qid, key: String(row.concept_key), name: String(row.concept_name), method: row.method as ConceptMethod });
    else todo.push(q);
  }
  if (!todo.length) return out;

  let manifest: KitManifest | null = null;
  try {
    manifest = await deps.loadManifest();
  } catch {
    manifest = null;
  }
  const options = conceptOptions(manifest);
  const fresh: ConceptTag[] = [];
  const pending: RawQuestion[] = [];
  for (const q of todo) {
    const qid = String(q.id);
    const t = paperTag(q, options) ?? manifestTag(manifest, worksheetId, qid, options);
    if (t) fresh.push(t);
    else pending.push(q);
  }

  let modelCost = 0;
  if (pending.length && options.length && deps.call) {
    const batch = pending.slice(0, CONCEPT_MAX_QUESTIONS);
    try {
      const p = conceptPrompt(batch, options);
      const res = await deps.call({ model: CONCEPT_MODEL, system: p.system, user: p.user, maxTokens: CONCEPT_MAX_TOKENS });
      modelCost = conceptCost(res.usage);
      const picked = parseConceptReply(res.text, batch.map((q) => String(q.id)), options);
      for (const [qid, key] of picked) {
        const opt = options.find((o) => o.key === key)!;
        fresh.push({ questionId: qid, key: opt.key, name: opt.name, method: "model" });
      }
    } catch (e) {
      deps.log?.(`sk-practice.concepts model call failed: ${(e as Error).message}`);
    }
  }

  const modelRows = fresh.filter((t) => t.method === "model").length;
  for (const t of fresh) {
    out.set(t.questionId, t);
    const ins = await deps.db.from("sk_practice_concepts").insert({
      generation_id: worksheetId,
      question_id: t.questionId,
      question_hash: hashOf.get(t.questionId)!,
      concept_key: t.key,
      concept_name: t.name,
      method: t.method,
      model: t.method === "model" ? CONCEPT_MODEL : null,
      // the one call's cost, spread over the questions it tagged
      cost_usd: t.method === "model" && modelRows ? Math.round((modelCost / modelRows) * 1e6) / 1e6 : 0,
    });
    if (ins.error && ins.error.code !== "23505") deps.log?.(`sk-practice.concepts cache write failed: ${ins.error.message ?? ins.error.code ?? "?"}`);
  }
  for (const q of questions) if (!out.has(String(q.id))) out.set(String(q.id), fallback(String(q.id)));
  return out;
}

