// SK S3 slice C — reads what the remediation ladder needs from the bank:
// topic_questions (options with keys, answer, distractor_rationale,
// explanation, article_id, objective_ref) and the article's misconceptions
// and objectives (topic_articles). Server only (the service-role client):
// the answer key is in here and never leaves the server before the reveal.
//
// The rationale is read as the library editor reads it
// (src/app/library/topics/[id]/questions/questions-panel.tsx): per option key,
// { why_wrong, misconception_ref? } — keys compared case-insensitively.

import type { RawQuestion } from "@/app/api/quiz/logic";
import type { DistractorRationale, QuestionOption } from "@/utils/catalogue/questions";
import { UUID_RE } from "./ids";
import { toRawQuestion, SK_ITEM_STATUSES, type TopicQuestionRow } from "./items-supabase";
import { objectiveKey } from "./objective-key";
import type { ArticleMisconception, RemediationFacts } from "./remediation";
import type { SkDb } from "./store-supabase";

export const REMEDIATION_COLUMNS = "id, item_type, answer_mode, marks, stem, options, answer, status, difficulty, teaching_objective_id, distractor_rationale, explanation, article_id, objective_ref";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** distractor_rationale as stored → {KEY: {why_wrong, misconception_ref?}}; junk dropped. */
export function parseRationale(v: unknown): DistractorRationale {
  const out: DistractorRationale = {};
  if (!isObj(v)) return out;
  for (const [k, e] of Object.entries(v)) {
    if (!isObj(e)) continue;
    const why = str(e.why_wrong);
    if (!why) continue;
    const ref = str(e.misconception_ref);
    out[k.trim().toUpperCase()] = ref ? { why_wrong: why, misconception_ref: ref } : { why_wrong: why };
  }
  return out;
}

/** topic_articles.misconceptions → [{id, misconception, correction}]; incomplete entries dropped. */
export function parseMisconceptions(v: unknown): ArticleMisconception[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((m) => {
    if (!isObj(m)) return [];
    const id = str(m.id);
    const misconception = str(m.misconception);
    const correction = str(m.correction);
    return id && misconception && correction ? [{ id, misconception, correction }] : [];
  });
}

/** A note the bank keeps on the RIGHT option (any text field but why_wrong). */
function rightRationale(v: unknown, answerKey: string | null): string | null {
  if (!isObj(v) || !answerKey) return null;
  const entry = Object.entries(v).find(([k]) => k.trim().toUpperCase() === answerKey.trim().toUpperCase())?.[1];
  if (!isObj(entry)) return null;
  for (const f of ["why_right", "rationale", "why", "explanation", "note"]) {
    const t = str(entry[f]);
    if (t) return t;
  }
  return null;
}

function objectiveText(objectives: unknown, ref: string | null): string | null {
  if (!ref || !Array.isArray(objectives)) return null;
  const o = objectives.find((x) => isObj(x) && str(x.id) === ref) as Obj | undefined;
  return o ? str(o.text) : null;
}

function options(row: Obj): QuestionOption[] {
  if (!Array.isArray(row.options)) return [];
  return row.options.flatMap((o) => (isObj(o) && str(o.key) && str(o.text) ? [{ key: str(o.key)!, text: str(o.text)! }] : []));
}

/** The answer as text (what must not leak, and what the reveal shows). */
function answerOf(q: RawQuestion, row: Obj, opts: QuestionOption[]): { key: string | null; texts: string[]; display: string } {
  switch (q.type) {
    case "mcq": {
      const a = isObj(row.answer) ? str(row.answer.key) : null;
      const byKey = a ? opts.find((o) => o.key.toUpperCase() === a.toUpperCase()) : undefined;
      const key = byKey?.key ?? opts.find((o) => o.text === q.answer)?.key ?? null;
      return { key, texts: q.answer ? [q.answer] : [], display: key && q.answer ? `${key}. ${q.answer}` : (q.answer ?? "") };
    }
    case "true_false":
      return { key: null, texts: q.answer === undefined ? [] : [String(q.answer)], display: q.answer === undefined ? "" : String(q.answer) };
    case "fill_blank":
      return { key: null, texts: [q.answer ?? "", ...(q.accept ?? [])].filter(Boolean), display: q.answer ?? "" };
    case "match":
      return { key: null, texts: q.pairs.map((p) => p.right), display: q.pairs.map((p) => `${p.left} → ${p.right}`).join("; ") };
    case "short":
      return { key: null, texts: q.answer ? [q.answer] : [], display: q.answer ?? "" };
    case "subjective":
      return { key: null, texts: [], display: q.answer_outline ?? "" };
  }
}

/** Build the ladder's facts from a topic_questions row and its article row. */
export function factsFrom(row: Obj, article: Obj | null): RemediationFacts | null {
  const q = toRawQuestion(row as unknown as TopicQuestionRow);
  if (!q) return null;
  const opts = q.type === "mcq" ? options(row) : [];
  const a = answerOf(q, row, opts);
  const ref = str(row.objective_ref);
  return {
    itemId: q.id,
    type: q.type,
    options: opts,
    answerKey: a.key,
    answerTexts: a.texts,
    answerDisplay: a.display,
    rationale: parseRationale(row.distractor_rationale),
    rightRationale: rightRationale(row.distractor_rationale, a.key),
    explanation: str(row.explanation),
    misconceptions: article ? parseMisconceptions(article.misconceptions) : [],
    objectiveText: article ? objectiveText(article.objectives, ref) : null,
    objectiveKey: objectiveKey(str(row.article_id), ref),
  };
}

export interface RemediationBank {
  /** The ladder's facts for one item (approved or draft), or null. */
  facts(itemId: string): Promise<RemediationFacts | null>;
  /** Bank id → objective key for these items (the check question's search). */
  objectiveKeys(itemIds: readonly string[]): Promise<Record<string, string | null>>;
}

export class SupabaseRemediationBank implements RemediationBank {
  constructor(private readonly db: SkDb) {}

  async facts(itemId: string): Promise<RemediationFacts | null> {
    if (!UUID_RE.test(itemId)) return null;
    const { data: row, error } = await this.db.from("topic_questions").select(REMEDIATION_COLUMNS).eq("id", itemId).maybeSingle();
    if (error) throw new Error(`[sk remediation] item: ${error.message}`);
    if (!row || !SK_ITEM_STATUSES.includes(String(row.status))) return null;
    let article: Obj | null = null;
    const articleId = str(row.article_id);
    if (articleId && UUID_RE.test(articleId)) {
      const { data, error: aErr } = await this.db.from("topic_articles").select("id, misconceptions, objectives").eq("id", articleId).maybeSingle();
      if (aErr) throw new Error(`[sk remediation] article: ${aErr.message}`);
      article = data ?? null;
    }
    return factsFrom(row, article);
  }

  async objectiveKeys(itemIds: readonly string[]): Promise<Record<string, string | null>> {
    const ids = [...new Set(itemIds.filter((i) => UUID_RE.test(i)))];
    if (!ids.length) return {};
    const { data, error } = await this.db.from("topic_questions").select("id, article_id, objective_ref").in("id", ids);
    if (error) throw new Error(`[sk remediation] keys: ${error.message}`);
    const out: Record<string, string | null> = {};
    for (const r of data ?? []) out[String(r.id)] = objectiveKey(str(r.article_id), str(r.objective_ref));
    return out;
  }
}
