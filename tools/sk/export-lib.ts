// SK B1 — the pure half of tools/sk/export-chapter.ts.
//
// Everything here is deterministic and free of I/O so it can be unit-tested
// (src/__tests__/sk-export-chapter.test.ts). The CLI reads a chNN-draft.json,
// calls buildExport() with the lookups it fetched, then either applies the plan
// with supabase-js or renders it as one SQL transaction.
//
// Rules this encodes (SK plan Revision 3, §3 and §10; docs/SK-B1-REPORT.md):
//   * one teaching UNIT per manuscript plan section, unit_key u1…uN in plan order;
//   * one INTERNAL teaching objective per unit, drafted by rewriting the plan
//     section's purpose into "Students can …" form — no model call;
//   * the objective → curriculum link is a SEPARATE proposed row per cited
//     node code that EXISTS in curriculum_nodes (missing codes are reported,
//     never invented);
//   * an exercise belongs to the unit whose plan section cites the most of its
//     source refs (an `item:` ref counts more than a claim/gloss/misc ref);
//   * an exercise that was seeded from an existing bank item (`source_item_id`)
//     STAMPS that item's teaching_objective_id rather than inserting a copy —
//     link, never duplicate.

import { createHash } from "node:crypto";

// ── manuscript shapes (the subset the exporter reads) ───────────────────────

export type DraftBlock = {
  type: string;
  source_refs?: string[] | null;
  [key: string]: unknown;
};

export type DraftSection = {
  sid: string;
  heading?: string | null;
  blocks: DraftBlock[];
};

export type PlanSection = {
  sid: string;
  heading?: string | null;
  purpose: string;
  node_codes?: string[] | null;
  source_refs?: string[] | null;
};

export type DraftExercise = {
  xid: string;
  tier?: string | null; // guided | independent | challenge
  item_type: string; // mcq | true_false | fill_blank | match | numeric | short_answer | …
  stem: string;
  options?: string[] | null;
  pairs?: { left: string; right: string }[] | null;
  answer: unknown;
  worked_solution?: string | null;
  marking_scheme?: { point: string; marks: number }[] | null;
  marks?: number | null;
  node_code?: string | null;
  source_item_id?: string | null; // "item:<uuid>"
  source_refs?: string[] | null;
};

export type ChapterDraft = {
  chapter: { number: number; title: string; node_codes?: string[] | null };
  work?: { slug?: string; title?: string; curriculum?: string; grade_band?: string } | null;
  plan: { chapter_title?: string | null; sections: PlanSection[] };
  sections: DraftSection[];
  exercises: DraftExercise[];
};

// ── output rows ─────────────────────────────────────────────────────────────

export type ProductRow = {
  slug: string;
  title: string;
  subject: string | null;
  curriculum_code: string | null; // resolved to curriculum_id by the sink
  languages: string[];
  manuscript_version: string | null;
};

export type UnitRow = {
  unit_key: string;
  section_sid: string;
  title: string;
  sort_order: number;
  node_codes: string[];
};

export type ObjectiveRow = { unit_key: string; text: string };

export type MapRow = {
  unit_key: string;
  code: string;
  curriculum_node_id: string;
  relation: "supports";
  map_confidence: number;
};

export type BlockRow = {
  section_sid: string;
  block_index: number;
  block_type: string;
  body: Record<string, unknown>;
  source_refs: string[];
  unit_key: string;
};

export type TopicQuestionRow = {
  item_type: string;
  answer_mode: "objective" | "subjective";
  difficulty: number;
  cognitive_level: string;
  marks: number;
  stem: string;
  options: unknown | null;
  answer: unknown;
  marking_scheme: unknown | null;
  explanation: string | null;
  tags: string[];
  content_hash: string;
  notes: string;
};

export type ExerciseWrite = {
  xid: string;
  item_type: string;
  unit_key: string | null;
  /** the bank item this exercise was seeded from, if any (uuid without the "item:" prefix) */
  source_item_id: string | null;
  /** "stamp" = set teaching_objective_id on the existing bank item; "insert" = add a book copy */
  action: "stamp" | "insert";
  row: TopicQuestionRow;
};

export type ExportPlan = {
  chapter: number;
  product: ProductRow;
  units: UnitRow[];
  objectives: ObjectiveRow[];
  maps: MapRow[];
  missingCodes: { unit_key: string; code: string }[];
  blocks: BlockRow[];
  exercises: ExerciseWrite[];
  shortfall: UnitShortfall[];
};

export type Lookups = {
  /** curriculum_nodes.code → id, for the product's curriculum */
  nodesByCode: Map<string, string>;
  /** ids of topic_questions rows that exist in the target database */
  existingQuestionIds: Set<string>;
};

export const PRODUCT_SLUG = "cells-structure-function-organisation";
export const MIN_AUTO_MARKABLE_PER_UNIT = 3;

/** item types a deterministic grader can mark (plan §10 grading rules) */
export const AUTO_MARKABLE = new Set(["mcq", "true_false", "fill_blank", "match", "numeric", "numerical"]);

// ── units ───────────────────────────────────────────────────────────────────

/** The first clause of a sentence: up to the first comma, semicolon, colon or full stop. */
export function firstClause(text: string): string {
  const m = /^[^,;:.]+/.exec(text.trim());
  return (m ? m[0] : text).trim();
}

const LEADING_VERB = /^(teach(?:\s+(?:learners|students|pupils))?\s+(?:how\s+to\s+|the\s+|that\s+)?|show\s+that\s+|explain\s+(?:how\s+to\s+|that\s+)?|introduce\s+(?:the\s+)?)/i;

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Unit title: the plan heading, else the manuscript section heading, else the purpose's first clause. */
export function unitTitle(plan: PlanSection, section?: DraftSection | null): string {
  const heading = (plan.heading ?? section?.heading ?? "").trim();
  if (heading) return heading;
  return capitalise(firstClause(plan.purpose).replace(LEADING_VERB, ""));
}

/** One unit per plan section, in plan order: u1…uN. */
export function deriveUnits(draft: ChapterDraft): UnitRow[] {
  const bySid = new Map(draft.sections.map((s) => [s.sid, s]));
  return draft.plan.sections.map((p, i) => ({
    unit_key: `u${i + 1}`,
    section_sid: p.sid,
    title: unitTitle(p, bySid.get(p.sid)),
    sort_order: i + 1,
    node_codes: [...new Set((p.node_codes ?? []).map((c) => c.trim()).filter(Boolean))],
  }));
}

// ── teaching objective (rewrite rule, no LLM) ───────────────────────────────

/**
 * Clauses written for the AUTHOR, not the student, that a plan purpose may
 * carry at its end: "…, and confront the myth that …", "…; includes the one
 * optional extension box … if used". They are cut before the rewrite.
 */
const AUTHOR_CLAUSE = /\s*[,;]\s*(?:and\s+)?(?:confront|confronts|address|addresses|challenge|challenges|include|includes|including)\b.*$/i;

/**
 * Deterministic rewrite of a plan section's purpose into a draft teaching
 * objective in "Students can …" form:
 *   "Teach how to X"          → "Students can X"
 *   "Teach the X" / "Teach X" → "Students can describe X"
 *   "Show that X" / "Teach that X" / "Explain that X" → "Students can explain that X"
 *   anything else             → "Students can " + lower-cased purpose
 * The result is a DRAFT (teaching_objectives.status = 'draft') for the human
 * reviewer to edit and validate; the rule only guarantees the form.
 */
export function objectiveFromPurpose(purpose: string): string {
  let p = purpose.trim().replace(/\s+/g, " ").replace(AUTHOR_CLAUSE, "").replace(/[.\s]+$/, "");
  let lead: string;
  if (/^(teach|show|explain)\s+(learners\s+|students\s+|pupils\s+)?how\s+to\s+/i.test(p)) {
    p = p.replace(/^(teach|show|explain)\s+(learners\s+|students\s+|pupils\s+)?how\s+to\s+/i, "");
    lead = "";
  } else if (/^(teach|show|explain|demonstrate)\s+(learners\s+|students\s+|pupils\s+)?that\s+/i.test(p)) {
    p = p.replace(/^(teach|show|explain|demonstrate)\s+(learners\s+|students\s+|pupils\s+)?that\s+/i, "");
    lead = "explain that ";
  } else if (/^teach\s+/i.test(p)) {
    p = p.replace(/^teach\s+(learners\s+|students\s+|pupils\s+)?/i, "");
    lead = "describe ";
  } else {
    p = p[0].toLowerCase() + p.slice(1);
    lead = "";
  }
  return `Students can ${lead}${p}.`;
}

export function deriveObjectives(draft: ChapterDraft, units: UnitRow[]): ObjectiveRow[] {
  const byUnit = new Map(units.map((u) => [u.section_sid, u.unit_key]));
  return draft.plan.sections.map((p) => ({
    unit_key: byUnit.get(p.sid) as string,
    text: objectiveFromPurpose(p.purpose),
  }));
}

// ── node-code resolution ────────────────────────────────────────────────────

export function resolveNodeCodes(
  codes: string[],
  nodesByCode: Map<string, string>,
): { resolved: { code: string; id: string }[]; missing: string[] } {
  const resolved: { code: string; id: string }[] = [];
  const missing: string[] = [];
  for (const code of [...new Set(codes)]) {
    const id = nodesByCode.get(code);
    if (id) resolved.push({ code, id });
    else missing.push(code);
  }
  return { resolved, missing };
}

export function deriveMaps(units: UnitRow[], nodesByCode: Map<string, string>): { maps: MapRow[]; missing: { unit_key: string; code: string }[] } {
  const maps: MapRow[] = [];
  const missing: { unit_key: string; code: string }[] = [];
  for (const u of units) {
    const r = resolveNodeCodes(u.node_codes, nodesByCode);
    for (const { code, id } of r.resolved) {
      maps.push({ unit_key: u.unit_key, code, curriculum_node_id: id, relation: "supports", map_confidence: 0.5 });
    }
    for (const code of r.missing) missing.push({ unit_key: u.unit_key, code });
  }
  return { maps, missing };
}

// ── blocks ──────────────────────────────────────────────────────────────────

export function blocksForSection(section: DraftSection, unitKey: string): BlockRow[] {
  return section.blocks.map((b, i) => {
    const { type, source_refs, ...rest } = b;
    return {
      section_sid: section.sid,
      block_index: i,
      block_type: type,
      body: rest as Record<string, unknown>,
      source_refs: (source_refs ?? []).filter((r): r is string => typeof r === "string"),
      unit_key: unitKey,
    };
  });
}

export function deriveBlocks(draft: ChapterDraft, units: UnitRow[]): BlockRow[] {
  const unitBySid = new Map(units.map((u) => [u.section_sid, u.unit_key]));
  const out: BlockRow[] = [];
  for (const s of draft.sections) {
    const unitKey = unitBySid.get(s.sid);
    if (!unitKey) continue; // a manuscript section the plan does not know is not a unit
    out.push(...blocksForSection(s, unitKey));
  }
  return out;
}

// ── exercises → units ───────────────────────────────────────────────────────

const ITEM_REF_WEIGHT = 3;

/**
 * The unit whose plan section shares the most source refs with the exercise.
 * `item:` refs weigh 3 (the plan names the bank items each section draws on);
 * claim/gloss/misc refs weigh 1. Ties go to the earlier section. No refs in
 * common → null (the exercise is imported without an objective).
 */
export function assignExerciseToUnit(ex: DraftExercise, plan: PlanSection[], units: UnitRow[]): string | null {
  const refs = new Set((ex.source_refs ?? []).concat(ex.source_item_id ? [ex.source_item_id] : []));
  if (refs.size === 0) return null;
  const unitBySid = new Map(units.map((u) => [u.section_sid, u.unit_key]));
  let best: { sid: string; score: number } | null = null;
  for (const p of plan) {
    let score = 0;
    for (const r of p.source_refs ?? []) {
      if (refs.has(r)) score += r.startsWith("item:") ? ITEM_REF_WEIGHT : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { sid: p.sid, score };
  }
  return best ? (unitBySid.get(best.sid) ?? null) : null;
}

export type UnitShortfall = { unit_key: string; auto_markable: number; needed: number; xids: string[] };

export function autoMarkableShortfall(units: UnitRow[], writes: { xid: string; item_type: string; unit_key: string | null }[], min = MIN_AUTO_MARKABLE_PER_UNIT): UnitShortfall[] {
  return units.map((u) => {
    const xids = writes.filter((w) => w.unit_key === u.unit_key && AUTO_MARKABLE.has(w.item_type)).map((w) => w.xid);
    return { unit_key: u.unit_key, auto_markable: xids.length, needed: Math.max(0, min - xids.length), xids };
  });
}

// ── exercises → topic_questions rows ────────────────────────────────────────

const TIER_DIFFICULTY: Record<string, number> = { guided: 2, independent: 3, challenge: 4 };
const TIER_LEVEL: Record<string, string> = { guided: "understand", independent: "apply", challenge: "analyse" };
const OBJECTIVE_TYPES = new Set(["mcq", "true_false", "fill_blank", "match", "assertion_reason"]);
const DB_ITEM_TYPES = new Set(["mcq", "true_false", "fill_blank", "match", "assertion_reason", "short_answer", "long_answer", "numerical", "diagram_label"]);

export function dbItemType(t: string): string {
  const mapped = t === "numeric" ? "numerical" : t;
  if (!DB_ITEM_TYPES.has(mapped)) throw new Error(`exercise item_type "${t}" has no topic_questions equivalent`);
  return mapped;
}

export function contentHash(itemType: string, stem: string, answer: unknown): string {
  return createHash("sha1").update(`${itemType}\n${stem.trim()}\n${JSON.stringify(answer)}`).digest("hex");
}

function mcqOptions(options: string[]): { key: string; text: string }[] {
  return options.map((text, i) => ({ key: String.fromCharCode(65 + i), text }));
}

export function toTopicQuestion(ex: DraftExercise, ctx: { slug: string; chapter: number }): TopicQuestionRow {
  const item_type = dbItemType(ex.item_type);
  const tier = (ex.tier ?? "independent").toLowerCase();
  let options: unknown | null = null;
  let answer: unknown;
  switch (item_type) {
    case "mcq":
    case "assertion_reason":
      options = mcqOptions(ex.options ?? []);
      answer = { key: String(ex.answer).trim().toUpperCase() };
      break;
    case "match":
      options = { pairs: ex.pairs ?? [] };
      answer = { pairs: ex.pairs ?? [] };
      break;
    case "true_false":
      answer = { value: /^(true|t|yes)$/i.test(String(ex.answer).trim()) };
      break;
    default:
      answer = { text: typeof ex.answer === "string" ? ex.answer : JSON.stringify(ex.answer) };
  }
  return {
    item_type,
    answer_mode: OBJECTIVE_TYPES.has(item_type) ? "objective" : "subjective",
    difficulty: TIER_DIFFICULTY[tier] ?? 3,
    cognitive_level: TIER_LEVEL[tier] ?? "apply",
    marks: ex.marks ?? (ex.marking_scheme ?? []).reduce((n, m) => n + (m.marks ?? 0), 0) ?? 1,
    stem: ex.stem,
    options,
    answer,
    marking_scheme: ex.marking_scheme ?? null,
    explanation: ex.worked_solution ?? null,
    tags: ["sk-book", `book:${ctx.slug}`, `ch:${ctx.chapter}`, `xid:${ex.xid}`, `tier:${tier}`],
    content_hash: contentHash(item_type, ex.stem, answer),
    notes: JSON.stringify({ source: `book:${ctx.slug}/${ctx.chapter}/${ex.xid}`, source_item_id: ex.source_item_id ?? null, source_refs: ex.source_refs ?? [] }),
  };
}

export function sourceItemUuid(ex: DraftExercise): string | null {
  const m = /^item:([0-9a-f-]{36})$/i.exec(ex.source_item_id ?? "");
  return m ? m[1].toLowerCase() : null;
}

export function deriveExerciseWrites(draft: ChapterDraft, units: UnitRow[], existingQuestionIds: Set<string>): ExerciseWrite[] {
  const ctx = { slug: draft.work?.slug ?? PRODUCT_SLUG, chapter: draft.chapter.number };
  return draft.exercises.map((ex) => {
    const source_item_id = sourceItemUuid(ex);
    const action: ExerciseWrite["action"] = source_item_id && existingQuestionIds.has(source_item_id) ? "stamp" : "insert";
    return {
      xid: ex.xid,
      item_type: dbItemType(ex.item_type),
      unit_key: assignExerciseToUnit(ex, draft.plan.sections, units),
      source_item_id,
      action,
      row: toTopicQuestion(ex, ctx),
    };
  });
}

// ── the whole plan ──────────────────────────────────────────────────────────

export function deriveProduct(draft: ChapterDraft): ProductRow {
  return {
    slug: draft.work?.slug ?? PRODUCT_SLUG,
    title: draft.work?.title ?? "Cells – Structure, Function and Organisation",
    subject: draft.work?.title?.split(":")[0]?.trim() ?? null,
    curriculum_code: draft.work?.curriculum ?? null,
    languages: ["en"],
    manuscript_version: null,
  };
}

export function buildExport(draft: ChapterDraft, lookups: Lookups, manuscriptVersion?: string | null): ExportPlan {
  const units = deriveUnits(draft);
  const objectives = deriveObjectives(draft, units);
  const { maps, missing } = deriveMaps(units, lookups.nodesByCode);
  const blocks = deriveBlocks(draft, units);
  const exercises = deriveExerciseWrites(draft, units, lookups.existingQuestionIds);
  const product = deriveProduct(draft);
  product.manuscript_version = manuscriptVersion ?? null;
  return {
    chapter: draft.chapter.number,
    product,
    units,
    objectives,
    maps,
    missingCodes: missing,
    blocks,
    exercises,
    shortfall: autoMarkableShortfall(units, exercises),
  };
}
