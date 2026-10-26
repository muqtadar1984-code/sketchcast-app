// SK B5 — the real item bank: `topic_questions` rows mapped to the loop's
// `RawQuestion` shape (the quiz's authoritative item type, so `gradeItem` gives
// the mark a quiz paper would). An item is served only through its teaching
// objective (`topic_questions.teaching_objective_id`, migration 0156): the
// bank lists a unit's items by product + chapter + unit_key → objective → items,
// and `get()` returns any approved or draft item by id.
//
// Keys stay on the server: this module is imported by server code only and the
// student receives `stripItem()` output (./items), unchanged.
//
// Row shapes (worker contract, src/utils/catalogue/questions.ts):
//   mcq / assertion_reason  options [{key,text}]            answer {key}
//   true_false              —                               answer {value: boolean}
//   fill_blank              —                               answer {text, accept?[]}
//   numerical               —                               answer {value: number, unit?, tolerance?}
//   match                   options {pairs:[{left,right}]} answer {pairs:[{left,right}]}
//   short_answer / long_answer / diagram_label              answer {text} → `short` (needs_review)

import type { RawQuestion } from "@/app/api/quiz/logic";
import { UUID_RE } from "./ids";
import type { ItemBank } from "./items";
import type { SkDb } from "./store-supabase";

/** Which statuses the bank serves (plan B1b: approved + the book's draft items until review). */
export const SK_ITEM_STATUSES: readonly string[] = ["approved", "draft"];

export const ITEM_COLUMNS = "id, item_type, answer_mode, marks, stem, options, answer, status, teaching_objective_id, created_at";

export type TopicQuestionRow = {
  id: string;
  item_type: string;
  answer_mode?: string;
  marks: number;
  stem: string;
  options: unknown;
  answer: unknown;
  status: string;
  teaching_objective_id: string | null;
  created_at?: string;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Map a row to the loop's item shape, or null when the row cannot be graded
 * as that type (the caller skips it; nothing is guessed). */
export function toRawQuestion(row: TopicQuestionRow): RawQuestion | null {
  const id = str(row.id);
  const prompt = str(row.stem);
  if (!id || !prompt) return null;
  const marks = Number.isFinite(row.marks) && row.marks >= 1 ? Math.floor(row.marks) : 1;
  const answer = isObj(row.answer) ? row.answer : {};
  switch (row.item_type) {
    case "mcq":
    case "assertion_reason": {
      if (!Array.isArray(row.options) || row.options.length < 2) return null;
      const options: string[] = [];
      let keyed: string | undefined;
      for (const o of row.options) {
        const text = isObj(o) ? str(o.text) : str(o);
        if (!text) return null;
        options.push(text);
        if (isObj(o) && str(o.key) && str(o.key) === str(answer.key)) keyed = text;
      }
      const answerText = keyed ?? (str(answer.text) && options.includes(str(answer.text)!) ? str(answer.text)! : undefined);
      if (!answerText) return null;
      return { id, type: "mcq", prompt, options, answer: answerText, marks };
    }
    case "true_false": {
      const v = answer.value;
      const bool = typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null;
      if (bool === null) return null;
      return { id, type: "true_false", prompt, answer: bool, marks };
    }
    case "fill_blank": {
      const text = str(answer.text);
      if (!text) return null;
      const accept = Array.isArray(answer.accept) ? answer.accept.map(str).filter((s): s is string => !!s) : [];
      return { id, type: "fill_blank", prompt, answer: text, ...(accept.length ? { accept } : {}), marks };
    }
    case "numerical": {
      const v = typeof answer.value === "number" ? answer.value : typeof answer.value === "string" ? Number(answer.value) : NaN;
      if (!Number.isFinite(v)) return null;
      const unit = str(answer.unit);
      // The quiz grader reads both sides as numbers (./numeric), so "400", "400x" and "400 µm" all meet "400".
      const accept = unit ? [`${v} ${unit}`, `${v}${unit}`] : [];
      return { id, type: "fill_blank", prompt, answer: String(v), ...(accept.length ? { accept } : {}), marks };
    }
    case "match": {
      const src = Array.isArray(answer.pairs) ? answer.pairs : isObj(row.options) && Array.isArray(row.options.pairs) ? row.options.pairs : null;
      if (!src || src.length < 2) return null;
      const pairs: { left: string; right: string }[] = [];
      for (const p of src) {
        const left = isObj(p) ? str(p.left) : null;
        const right = isObj(p) ? str(p.right) : null;
        if (!left || !right) return null;
        pairs.push({ left, right });
      }
      return { id, type: "match", prompt, pairs, marks };
    }
    case "short_answer":
    case "long_answer":
    case "diagram_label": {
      const text = str(answer.text);
      return { id, type: "short", prompt, ...(text ? { answer: text } : {}), marks };
    }
    default:
      return null;
  }
}

export class SupabaseItemBank implements ItemBank {
  private readonly statuses: readonly string[];
  constructor(
    private readonly db: SkDb,
    opts: { statuses?: readonly string[] } = {},
  ) {
    this.statuses = opts.statuses ?? SK_ITEM_STATUSES;
  }

  /** One item by id — approved or draft, any objective. Null for an unknown,
   * rejected or ungradeable item (and for an id that is not a uuid: the
   * stand-in items never reach this bank). */
  async get(itemId: string): Promise<RawQuestion | null> {
    if (!UUID_RE.test(itemId)) return null;
    const { data, error } = await this.db.from("topic_questions").select(ITEM_COLUMNS).eq("id", itemId).maybeSingle();
    if (error) throw new Error(`[sk items] get: ${error.message}`);
    if (!data || !this.statuses.includes(String(data.status))) return null;
    return toRawQuestion(data as TopicQuestionRow);
  }

  /** The item's teaching objective (null = unmapped). */
  async objectiveFor(itemId: string): Promise<string | null> {
    if (!UUID_RE.test(itemId)) return null;
    const { data, error } = await this.db.from("topic_questions").select("teaching_objective_id").eq("id", itemId).maybeSingle();
    if (error) throw new Error(`[sk items] objective: ${error.message}`);
    const v = data?.teaching_objective_id;
    return typeof v === "string" ? v : null;
  }

  /** The teaching objective of a unit (product by slug or id). */
  async objectiveForUnit(product: string, chapter: number, unitKey: string): Promise<{ id: string; status: string } | null> {
    let productId = product;
    if (!UUID_RE.test(product)) {
      const { data, error } = await this.db.from("sk_book_products").select("id").eq("slug", product).maybeSingle();
      if (error) throw new Error(`[sk items] product: ${error.message}`);
      if (!data) return null;
      productId = String(data.id);
    }
    const { data, error } = await this.db.from("teaching_objectives").select("id, status").eq("product_id", productId).eq("chapter", chapter).eq("unit_key", unitKey).maybeSingle();
    if (error) throw new Error(`[sk items] objective for unit: ${error.message}`);
    return data ? { id: String(data.id), status: String(data.status) } : null;
  }

  /** Every gradeable item of a unit, oldest first (the packager's check /
   * practice assets pick from these ids). */
  async listForUnit(product: string, chapter: number, unitKey: string): Promise<RawQuestion[]> {
    const objective = await this.objectiveForUnit(product, chapter, unitKey);
    if (!objective) return [];
    return this.listForObjective(objective.id);
  }

  async listForObjective(teachingObjectiveId: string): Promise<RawQuestion[]> {
    const { data, error } = await this.db.from("topic_questions").select(ITEM_COLUMNS).eq("teaching_objective_id", teachingObjectiveId).order("created_at", { ascending: true });
    if (error) throw new Error(`[sk items] list: ${error.message}`);
    const out: RawQuestion[] = [];
    for (const row of data ?? []) {
      if (!this.statuses.includes(String(row.status))) continue;
      const q = toRawQuestion(row as TopicQuestionRow);
      if (q) out.push(q);
    }
    return out;
  }
}
