// Pure logic for the question bank and the worksheet composer (Library portal,
// Phase 3 — plan §1.7, spec decisions 8 and 9): the item vocabulary (0112
// CHECK constraints), the inline-edit validator, the maturity ladder, objective
// coverage, near-duplicate detection, the blueprint validator and the
// composer's bucket arithmetic. No I/O anywhere, so the routes and the panels
// share one answer and the rules are unit-tested without a database.
//
// Two of these are MIRRORS of worker code and must stay byte-for-byte in
// meaning with it:
//   • validateQuestionEdit ↔ catalogue/questions.py validate_item — an inline
//     edit in the portal must not be able to save an item the worker would
//     have refused to write, PER TYPE (an MCQ whose keyed answer is not an
//     option or whose key is not A–D, a distractor with no why_wrong,
//     duplicate options, a fill-blank stem with no blank, a match with two
//     pairs, a numerical answer that is not a number, a diagram label the
//     figure does not carry). Where the worker repairs a model's output the
//     portal refuses a human's edit — a narrower acceptance, never a wider one.
//   • composePlan / canCompose ↔ catalogue/composer.py's bucket arithmetic —
//     the portal greys a preset the bank cannot satisfy for exactly the
//     buckets the worker would raise Unsatisfiable on. Largest remainder, ties
//     broken by position (objective before subjective; difficulty 1 → 5).
//
// Human approval is NOT here: items are approved by a guarded UPDATE in the
// questions route (approve role), and approval of the KIT is the RPCs of 0115.
// Types live in this module (not types.ts) because A1 owns types.ts in the
// Phase 3 build; catalogue types the rest of the portal shares are imported.

import { canonicalKey } from "./key";
import type { BankMaturity } from "./types";

// ── Vocabulary (0112 topic_questions CHECK constraints) ──────────────────────

export const ITEM_TYPES = ["mcq", "true_false", "fill_blank", "match", "assertion_reason", "short_answer", "long_answer", "numerical", "diagram_label"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** The item types whose answer is marked without judgement (decision 8's
 *  objective half); the rest are subjective. answer_mode is DERIVED from the
 *  type, never stored independently, so an edit cannot disagree with itself. */
export const OBJECTIVE_ITEM_TYPES: ReadonlySet<ItemType> = new Set<ItemType>(["mcq", "true_false", "fill_blank", "match", "assertion_reason"]);

export const ANSWER_MODES = ["objective", "subjective"] as const;
export type AnswerMode = (typeof ANSWER_MODES)[number];

export const COGNITIVE_LEVELS = ["recall", "understand", "apply", "analyse", "evaluate", "create"] as const;
export type CognitiveLevel = (typeof COGNITIVE_LEVELS)[number];

export const QUESTION_STATUSES = ["draft", "approved", "rejected", "retired"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const DIFFICULTIES = ["1", "2", "3", "4", "5"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export function isItemType(v: unknown): v is ItemType {
  return typeof v === "string" && (ITEM_TYPES as readonly string[]).includes(v);
}
export function isCognitiveLevel(v: unknown): v is CognitiveLevel {
  return typeof v === "string" && (COGNITIVE_LEVELS as readonly string[]).includes(v);
}
export function isQuestionStatus(v: unknown): v is QuestionStatus {
  return typeof v === "string" && (QUESTION_STATUSES as readonly string[]).includes(v);
}
export function answerModeOf(t: ItemType): AnswerMode {
  return OBJECTIVE_ITEM_TYPES.has(t) ? "objective" : "subjective";
}

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  mcq: "MCQ",
  true_false: "true / false",
  fill_blank: "fill the blank",
  match: "match",
  assertion_reason: "assertion–reason",
  short_answer: "short answer",
  long_answer: "long answer",
  numerical: "numerical",
  diagram_label: "diagram label",
};

// ── Row shapes ───────────────────────────────────────────────────────────────

export type QuestionOption = { key: string; text: string };

/** Per distractor key: why that option is wrong, and — when the wrong answer
 *  is a known misconception — the article misconception it embodies. */
export type DistractorRationale = Record<string, { why_wrong: string; misconception_ref?: string | null }>;

export type MarkingPoint = { point: string; marks: number };

export type TopicQuestion = {
  id: string;
  topic_id: string;
  article_id: string;
  objective_ref: string | null;
  claim_ref: string | null;
  language: string;
  source_question_id: string | null;
  item_type: ItemType;
  answer_mode: AnswerMode;
  difficulty: number;
  cognitive_level: CognitiveLevel;
  marks: number;
  est_seconds: number | null;
  stem: string;
  options: unknown;
  distractor_rationale: DistractorRationale | null;
  answer: Record<string, unknown>;
  marking_scheme: MarkingPoint[] | null;
  explanation: string | null;
  tags: string[];
  content_hash: string;
  status: QuestionStatus;
  reviewer_id: string | null;
  reviewed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/** What an inline edit may change, normalised. item_type is carried (the
 *  route forces the stored one) because the rules depend on it; answer_mode is
 *  derived from it. Everything else about the row — ids, hash, status, review
 *  fields — is the route's business. */
export type QuestionEdit = {
  item_type: ItemType;
  answer_mode: AnswerMode;
  objective_ref: string;
  claim_ref: string | null;
  difficulty: number;
  cognitive_level: CognitiveLevel;
  marks: number;
  est_seconds: number | null;
  stem: string;
  options: QuestionOption[] | Record<string, unknown> | null;
  distractor_rationale: DistractorRationale | null;
  answer: Record<string, unknown>;
  marking_scheme: MarkingPoint[];
  explanation: string | null;
  tags: string[];
};

// ── Status predicates ────────────────────────────────────────────────────────
// Mirrored by the route's guarded UPDATEs (…in("status", […])…select("id")),
// so the panel hides a button instead of showing a 409.

/** A draft, or an approved item (a reviewer's small fix): editing an approved
 *  item sends it back to draft. Rejected and retired items are history. */
export function canEditQuestion(s: QuestionStatus | string): boolean {
  return s === "draft" || s === "approved";
}
/** Approve only from draft — a rejected item is regenerated, not resurrected. */
export function canApproveQuestion(s: QuestionStatus | string): boolean {
  return s === "draft";
}
/** Reject a draft, or pull an approval. */
export function canRejectQuestion(s: QuestionStatus | string): boolean {
  return s === "draft" || s === "approved";
}
/** Anything not already retired. */
export function canRetireQuestion(s: QuestionStatus | string): boolean {
  return s === "draft" || s === "approved" || s === "rejected";
}

export const QUESTION_STATUS_TONE: Record<QuestionStatus, string> = {
  draft: "bg-[#FFF1D6] text-[#9A6400]",
  approved: "bg-[#E6F6F2] text-[#0F7A68]",
  rejected: "bg-[#FFE9E3] text-[#B3401F]",
  retired: "bg-[#EEF0EC] text-[#5B6470]",
};

/** The worker's default draft count per generate (decision 8: 15 objective +
 *  15 subjective). The panel shows it as the placeholder of the target box. */
export const DEFAULT_TARGET = 30;
export const TARGET_MIN = 1;
export const TARGET_MAX = 100;

// ── Validation ───────────────────────────────────────────────────────────────

export const QUESTION_LIMITS = {
  stem: 2000,
  option: 500,
  why_wrong: 500,
  explanation: 2000,
  point: 500,
  points: 20,
  marks: 50,
  est_seconds: 3600,
  ref: 64,
  /** a short / long answer's text (the worker's TEXT_MAX) */
  answer_text: 2000,
  /** a fill_blank answer and each accepted alternative (worker: text[:300]) */
  blank_text: 300,
  accept: 20,
  /** a match pair's two sides (worker: left[:300], right[:500]) */
  pair_left: 300,
  pair_right: 500,
  /** a diagram label (worker: text[:120]) */
  label: 120,
  /** a numerical answer's unit (worker: unit[:40]) */
  unit: 40,
  tags: 20,
  tag: 40,
} as const;

/** The option keys of an MCQ and of an assertion–reason item — exactly these
 *  four, each once (worker MCQ_KEYS; validate_item refuses any other count or
 *  key). bank_worksheet prints the raw key, so a stray "E" would reach paper
 *  as "E)" and the answer line as "?". */
export const MCQ_KEYS = ["A", "B", "C", "D"] as const;

/** A fill_blank stem must SHOW its blank: two or more underscores, an
 *  ellipsis character or three dots (the worker's _BLANK_RE). A stem edited
 *  to lose it would print a statement with nothing to fill. */
export const BLANK_RE = /_{2,}|…|\.{3,}/;

/** A match item's pair count (worker MIN_PAIRS / MAX_PAIRS). */
export const MATCH_PAIRS = { min: 3, max: 8 } as const;

/** A diagram_label item's label count (worker MIN_LABELS / MAX_LABELS). */
export const DIAGRAM_LABELS = { min: 2, max: 8 } as const;

/** The start of an HTML tag, comment or close tag — the article validator's
 *  rule (article.ts RAW_HTML): a stem is prose rendered as text, raw HTML in it
 *  is refused rather than stored. `a < b` is fine. */
const RAW_HTML = /<[a-zA-Z/!]/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s ? s : null;
};
const int = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  return null;
};
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** The article facts an item refers to: the objective it serves, the claim it
 *  draws on, the misconception a distractor embodies — only the ids matter —
 *  and, for diagram_label items, the RENDERED figures with their labels
 *  (article_figures where status = 'rendered', labels[].label; the worker's
 *  labelled_figures). `figures` is optional: without it a diagram_label edit
 *  is checked for shape only (a figure key and 2–8 labels); with it the key
 *  must name one of the figures and every label must be one of its labels,
 *  as the worker requires. */
export type ArticleRefs = {
  objectives: readonly { id: string }[];
  claims: readonly { id: string }[];
  misconceptions: readonly { id: string }[];
  figures?: readonly { figure_key: string; caption?: string | null; labels: readonly string[] }[];
};

export type QuestionValidation = { ok: true; errors: []; item: QuestionEdit } | { ok: false; errors: string[]; item: null };

/** An MCQ / assertion–reason option list: exactly four `{key, text}` rows
 *  keyed A–D (keys trimmed and upper-cased, each once), texts non-empty and
 *  unique after trim + case-fold ("duplicate options"), returned in key
 *  order — the worker's stored shape. The worker REPAIRS model output here
 *  (it re-keys four unkeyed options A–D by position); a human edit is refused
 *  instead, and everything this accepts the worker accepts. */
function mcqOptions(v: unknown, errors: string[]): QuestionOption[] {
  if (!Array.isArray(v)) {
    errors.push(`options must be a list of exactly ${MCQ_KEYS.length} {key, text} rows keyed ${MCQ_KEYS[0]}–${MCQ_KEYS[MCQ_KEYS.length - 1]}.`);
    return [];
  }
  if (v.length !== MCQ_KEYS.length) errors.push(`exactly ${MCQ_KEYS.length} options keyed ${MCQ_KEYS[0]}–${MCQ_KEYS[MCQ_KEYS.length - 1]} are required (got ${v.length}).`);
  const out: QuestionOption[] = [];
  const keys = new Set<string>();
  const texts = new Set<string>();
  v.forEach((raw, i) => {
    if (!isRec(raw)) {
      errors.push(`options #${i + 1}: must be {key, text}.`);
      return;
    }
    const key = str(raw.key).toUpperCase();
    const text = str(raw.text);
    if (!key) errors.push(`options #${i + 1}: key is required.`);
    else if (!(MCQ_KEYS as readonly string[]).includes(key)) errors.push(`options #${i + 1}: key "${key}" is not one of ${MCQ_KEYS.join(", ")}.`);
    else if (keys.has(key)) errors.push(`options: duplicate key "${key}".`);
    keys.add(key);
    if (!text) errors.push(`options ${key || `#${i + 1}`}: text is required.`);
    else if (text.length > QUESTION_LIMITS.option) errors.push(`options ${key}: text is longer than ${QUESTION_LIMITS.option} characters.`);
    const fold = text.toLowerCase();
    if (text && texts.has(fold)) errors.push(`options: duplicate option text "${text}".`);
    texts.add(fold);
    out.push({ key, text: text.slice(0, QUESTION_LIMITS.option) });
  });
  const rank = (k: string) => (MCQ_KEYS as readonly string[]).indexOf(k);
  return out.sort((a, b) => rank(a.key) - rank(b.key));
}

/** A match item's pairs, from where the worker reads them (`pairs`, then
 *  `options.pairs`, then `answer.pairs`): 3–8 `{left, right}` rows, both
 *  sides non-empty and unique after case-fold. null when no list is given. */
function matchPairs(input: Rec, rawAnswer: Rec | null, errors: string[]): { left: string; right: string }[] | null {
  const src = Array.isArray(input.pairs)
    ? input.pairs
    : isRec(input.options) && Array.isArray(input.options.pairs)
      ? input.options.pairs
      : rawAnswer && Array.isArray(rawAnswer.pairs)
        ? rawAnswer.pairs
        : null;
  if (!src) {
    errors.push("a match item needs options.pairs — a list of {left, right}.");
    return null;
  }
  const pairs: { left: string; right: string }[] = [];
  src.forEach((raw: unknown, i: number) => {
    if (!isRec(raw)) {
      errors.push(`pairs #${i + 1}: must be {left, right}.`);
      return;
    }
    const left = str(raw.left);
    const right = str(raw.right);
    if (!left || !right) {
      errors.push(`pairs #${i + 1}: both left and right are required.`);
      return;
    }
    if (left.length > QUESTION_LIMITS.pair_left) errors.push(`pairs #${i + 1}: left is longer than ${QUESTION_LIMITS.pair_left} characters.`);
    if (right.length > QUESTION_LIMITS.pair_right) errors.push(`pairs #${i + 1}: right is longer than ${QUESTION_LIMITS.pair_right} characters.`);
    pairs.push({ left: left.slice(0, QUESTION_LIMITS.pair_left), right: right.slice(0, QUESTION_LIMITS.pair_right) });
  });
  if (pairs.length < MATCH_PAIRS.min || pairs.length > MATCH_PAIRS.max) errors.push(`a match item has ${MATCH_PAIRS.min} to ${MATCH_PAIRS.max} pairs (got ${pairs.length}).`);
  const lefts = new Set(pairs.map((p) => p.left.toLowerCase()));
  const rights = new Set(pairs.map((p) => p.right.toLowerCase()));
  if (lefts.size !== pairs.length || rights.size !== pairs.length) errors.push("match pairs: duplicate left or right texts.");
  return pairs;
}

/** A diagram_label item's labels, from `labels` or `answer.labels`: strings
 *  or `{label}` rows, trimmed, deduplicated after case-fold. */
function diagramLabels(input: Rec, rawAnswer: Rec | null): string[] {
  const src = Array.isArray(input.labels) ? input.labels : rawAnswer && Array.isArray(rawAnswer.labels) ? rawAnswer.labels : [];
  const out: string[] = [];
  for (const raw of src as unknown[]) {
    const text = isRec(raw) ? str(raw.label) : str(raw);
    if (text && !out.some((o) => o.toLowerCase() === text.toLowerCase())) out.push(text.slice(0, QUESTION_LIMITS.label));
  }
  return out;
}

/** `{point, marks}` rows: every point named, every marks positive; a
 *  non-empty scheme must add up to the item's marks (a 3-mark item whose
 *  scheme awards 4 is a marking error the answer key would print). */
function markingScheme(v: unknown, marks: number, errors: string[]): MarkingPoint[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push("marking_scheme must be a list of {point, marks}.");
    return [];
  }
  if (v.length > QUESTION_LIMITS.points) errors.push(`marking_scheme: at most ${QUESTION_LIMITS.points} points (got ${v.length}).`);
  const out: MarkingPoint[] = [];
  v.slice(0, QUESTION_LIMITS.points).forEach((raw, i) => {
    if (!isRec(raw)) {
      errors.push(`marking_scheme #${i + 1}: must be {point, marks}.`);
      return;
    }
    const point = str(raw.point);
    const m = num(raw.marks);
    if (!point) errors.push(`marking_scheme #${i + 1}: point is required.`);
    else if (point.length > QUESTION_LIMITS.point) errors.push(`marking_scheme #${i + 1}: point is longer than ${QUESTION_LIMITS.point} characters.`);
    if (m === null || m <= 0) errors.push(`marking_scheme #${i + 1}: marks must be a positive number.`);
    out.push({ point: point.slice(0, QUESTION_LIMITS.point), marks: m ?? 0 });
  });
  if (out.length) {
    const total = out.reduce((n, p) => n + p.marks, 0);
    if (Math.abs(total - marks) > 0.001) errors.push(`marking_scheme adds up to ${total}, but the item is worth ${marks} marks.`);
  }
  return out;
}

/**
 * Validate and normalise an inline edit from an untrusted request against the
 * article the item was written from. `ok` is false on ANY error; the list
 * names every problem at once so the row editor can show them all. The rules
 * are the worker validator's (catalogue/questions.py validate_item, decision
 * 8) PER TYPE, so nothing the portal saves is an item the worker would have
 * refused — where the worker repairs a model's output (re-keys options,
 * accepts an answer by its text, drops an unknown label with a note) a human
 * edit is refused with the reason instead; what this accepts, the worker
 * accepts:
 *   • item_type known; answer_mode derived from it
 *   • stem required, bounded, no raw HTML
 *   • objective_ref names an article objective; claim_ref (optional) a claim
 *   • difficulty 1..5, cognitive_level known, marks 1..50, est_seconds 10..3600
 *   • mcq: exactly 4 options keyed A–D, unique texts; answer {key} among
 *     them; distractor_rationale has why_wrong for EVERY non-answer key, and a
 *     misconception_ref (optional) names an article misconception
 *   • assertion_reason: the mcq option / answer rules; why_wrong OPTIONAL per
 *     distractor (the four statements are standard) but bounded and with a
 *     resolving misconception_ref when given
 *   • true_false: answer {value: boolean}
 *   • fill_blank: the stem shows its blank (BLANK_RE); answer {text, accept?[]}
 *   • match: 3–8 {left, right} pairs, unique sides; stored as options {pairs}
 *     and answer {pairs} (the worker's shape)
 *   • numerical: answer {value: finite number, unit?, tolerance?}
 *   • diagram_label: a figure key and 2–8 labels — one of the article's
 *     rendered figures and its labels when `article.figures` is given; stored
 *     as options {figure_key, caption} and answer {labels: [{n, label}]}; a
 *     missing marking scheme is derived as one mark per label (the worker's
 *     rule: a derivation, not a repair) and marks follow it
 *   • short_answer / long_answer: answer {text}
 *   • marking_scheme rows {point, marks>0}; required for a subjective item;
 *     a non-empty scheme adds up to marks
 *   • explanation bounded, no raw HTML; tags bounded
 */
export function validateQuestionEdit(input: unknown, article: ArticleRefs): QuestionValidation {
  const errors: string[] = [];
  if (!isRec(input)) return { ok: false, errors: ["item must be an object."], item: null };

  const item_type = input.item_type;
  if (!isItemType(item_type)) return { ok: false, errors: [`item_type must be one of ${ITEM_TYPES.join(", ")}.`], item: null };
  const answer_mode = answerModeOf(item_type);

  const stem = str(input.stem);
  if (!stem) errors.push("stem is required.");
  else if (stem.length > QUESTION_LIMITS.stem) errors.push(`stem is longer than ${QUESTION_LIMITS.stem} characters.`);
  if (RAW_HTML.test(stem)) errors.push("stem may not contain HTML tags.");

  const objectiveIds = new Set(article.objectives.map((o) => o.id));
  const objective_ref = str(input.objective_ref);
  if (!objective_ref) errors.push("objective_ref is required — every item serves one of the article's objectives.");
  else if (!objectiveIds.has(objective_ref)) errors.push(`objective_ref "${objective_ref}" is not one of the article's objectives.`);

  const claim_ref = strOrNull(input.claim_ref);
  if (claim_ref && !article.claims.some((c) => c.id === claim_ref)) errors.push(`claim_ref "${claim_ref}" is not one of the article's claims.`);

  const difficulty = int(input.difficulty);
  if (difficulty === null || difficulty < 1 || difficulty > 5) errors.push("difficulty must be a whole number from 1 to 5.");

  const cognitive_level = input.cognitive_level;
  if (!isCognitiveLevel(cognitive_level)) errors.push(`cognitive_level must be one of ${COGNITIVE_LEVELS.join(", ")}.`);

  const marks = int(input.marks);
  if (marks === null || marks < 1 || marks > QUESTION_LIMITS.marks) errors.push(`marks must be a whole number from 1 to ${QUESTION_LIMITS.marks}.`);

  let est_seconds: number | null = null;
  if (input.est_seconds !== undefined && input.est_seconds !== null && input.est_seconds !== "") {
    est_seconds = int(input.est_seconds);
    if (est_seconds === null || est_seconds < 10 || est_seconds > QUESTION_LIMITS.est_seconds) {
      errors.push(`est_seconds must be a whole number from 10 to ${QUESTION_LIMITS.est_seconds}.`);
      est_seconds = null;
    }
  }

  // ── answer, options, distractors — per type (the worker's validate_item) ──
  let options: QuestionEdit["options"] = null;
  let distractor_rationale: DistractorRationale | null = null;
  let answer: Record<string, unknown> = {};
  const rawAnswer = isRec(input.answer) ? input.answer : null;
  /** diagram_label with no scheme given: one mark per label, marks follow. */
  let derivedScheme: MarkingPoint[] | null = null;

  if (item_type === "mcq" || item_type === "assertion_reason") {
    const opts = mcqOptions(input.options ?? [], errors);
    options = opts;
    const key = str(rawAnswer?.key).toUpperCase();
    if (!key) errors.push(`answer.key is required for ${item_type === "mcq" ? "an MCQ" : "an assertion–reason item"}.`);
    else if (!opts.some((o) => o.key === key)) errors.push(`answer.key "${key}" is not one of the options.`);
    answer = { key };
    // Every MCQ distractor explains itself (decision 8): the rationale is what
    // the answer key prints and what the misconception tooltip reads. The
    // four assertion–reason statements are standard, so there a why_wrong is
    // optional — but bounded and with a resolving misconception when given.
    const rationale: DistractorRationale = {};
    const given = isRec(input.distractor_rationale) ? input.distractor_rationale : {};
    const misconceptionIds = new Set(article.misconceptions.map((m) => m.id));
    for (const o of opts) {
      if (o.key === key) continue;
      const entry = given[o.key] ?? given[o.key.toLowerCase()];
      const why = isRec(entry) ? str(entry.why_wrong) : "";
      if (!why) {
        if (item_type === "mcq") errors.push(`distractor ${o.key} has no why_wrong.`);
        continue;
      }
      if (why.length > QUESTION_LIMITS.why_wrong) errors.push(`distractor ${o.key}: why_wrong is longer than ${QUESTION_LIMITS.why_wrong} characters.`);
      const ref = isRec(entry) ? strOrNull(entry.misconception_ref) : null;
      if (ref && !misconceptionIds.has(ref)) errors.push(`distractor ${o.key}: misconception_ref "${ref}" is not one of the article's misconceptions.`);
      rationale[o.key] = ref ? { why_wrong: why.slice(0, QUESTION_LIMITS.why_wrong), misconception_ref: ref } : { why_wrong: why.slice(0, QUESTION_LIMITS.why_wrong) };
    }
    distractor_rationale = item_type === "mcq" || Object.keys(rationale).length ? rationale : null;
  } else if (item_type === "true_false") {
    const v = rawAnswer?.value;
    const value = typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null;
    if (value === null) errors.push("answer.value must be true or false.");
    answer = { value: value ?? false };
  } else if (item_type === "fill_blank") {
    if (stem && !BLANK_RE.test(stem)) errors.push("a fill-the-blank stem must show the blank: two or more underscores (____), an ellipsis (…) or three dots.");
    const text = str(rawAnswer?.text);
    if (!text) errors.push("answer.text is required — the word(s) that fill the blank.");
    else if (text.length > QUESTION_LIMITS.blank_text) errors.push(`answer.text is longer than ${QUESTION_LIMITS.blank_text} characters.`);
    const accept: string[] = [];
    if (rawAnswer && rawAnswer.accept !== undefined && rawAnswer.accept !== null) {
      if (!Array.isArray(rawAnswer.accept)) errors.push("answer.accept must be a list of accepted alternatives.");
      else {
        for (const a of rawAnswer.accept) {
          const s = str(a);
          if (!s) continue;
          if (s.length > QUESTION_LIMITS.blank_text) errors.push(`answer.accept: an alternative is longer than ${QUESTION_LIMITS.blank_text} characters.`);
          if (!accept.includes(s)) accept.push(s.slice(0, QUESTION_LIMITS.blank_text));
        }
        if (accept.length > QUESTION_LIMITS.accept) errors.push(`answer.accept: at most ${QUESTION_LIMITS.accept} alternatives.`);
      }
    }
    answer = accept.length ? { text: text.slice(0, QUESTION_LIMITS.blank_text), accept: accept.slice(0, QUESTION_LIMITS.accept) } : { text: text.slice(0, QUESTION_LIMITS.blank_text) };
  } else if (item_type === "match") {
    const pairs = matchPairs(input, rawAnswer, errors);
    if (pairs) {
      options = { pairs };
      answer = { pairs };
    }
  } else if (item_type === "numerical") {
    const value = num(rawAnswer?.value);
    if (value === null) errors.push("answer.value must be a number.");
    const unitSrc = rawAnswer?.unit ?? input.unit;
    const unit = str(unitSrc);
    if (unitSrc !== undefined && unitSrc !== null && typeof unitSrc !== "string") errors.push("answer.unit must be text.");
    else if (unit.length > QUESTION_LIMITS.unit) errors.push(`answer.unit is longer than ${QUESTION_LIMITS.unit} characters.`);
    const tolSrc = rawAnswer?.tolerance ?? input.tolerance;
    let tolerance: number | null = null;
    if (tolSrc !== undefined && tolSrc !== null && tolSrc !== "") {
      const t = num(tolSrc);
      if (t === null) errors.push("answer.tolerance must be a number.");
      else tolerance = Math.abs(t);
    }
    answer = { value: value ?? 0, unit: unit.slice(0, QUESTION_LIMITS.unit), tolerance };
  } else if (item_type === "diagram_label") {
    const rawKey = str(input.figure_key) || (isRec(input.options) ? str(input.options.figure_key) : "");
    const figureKey = canonicalKey(rawKey);
    if (!figureKey) errors.push("a diagram-label item names its figure (options.figure_key).");
    const labels = diagramLabels(input, rawAnswer);
    if (labels.length < DIAGRAM_LABELS.min || labels.length > DIAGRAM_LABELS.max) {
      errors.push(`a diagram-label item has ${DIAGRAM_LABELS.min} to ${DIAGRAM_LABELS.max} labels (got ${labels.length}).`);
    }
    let caption = isRec(input.options) ? str(input.options.caption) : "";
    if (article.figures && figureKey) {
      // The worker's rule: the figure is one of the article's RENDERED,
      // labelled figures and every label is one of its labels (the worker
      // drops an unknown label with a note; a human edit is refused).
      const fig = article.figures.find((f) => canonicalKey(f.figure_key) === figureKey);
      if (!fig) errors.push(`figure "${rawKey}" is not a rendered, labelled figure of this article.`);
      else {
        caption = fig.caption ?? caption;
        const known = new Map(fig.labels.map((lb) => [canonicalKey(lb), lb]));
        for (const lb of labels) if (!known.has(canonicalKey(lb))) errors.push(`label "${lb}" is not one of the labels on figure "${fig.figure_key}".`);
      }
    }
    options = { figure_key: figureKey, caption };
    answer = { labels: labels.map((label, i) => ({ n: i + 1, label })) };
    // One mark per label IS the type's marking scheme when none is given.
    const givenScheme = input.marking_scheme;
    if (givenScheme === undefined || givenScheme === null || (Array.isArray(givenScheme) && givenScheme.length === 0)) {
      derivedScheme = labels.map((label) => ({ point: label, marks: 1 }));
    }
  } else {
    // short_answer, long_answer
    const text = str(rawAnswer?.text);
    if (!text) errors.push(`answer.text is required for a ${item_type === "long_answer" ? "long" : "short"} answer.`);
    else if (text.length > QUESTION_LIMITS.answer_text) errors.push(`answer.text is longer than ${QUESTION_LIMITS.answer_text} characters.`);
    answer = { text: text.slice(0, QUESTION_LIMITS.answer_text) };
  }

  let marking_scheme: MarkingPoint[];
  let finalMarks = marks;
  if (derivedScheme) {
    marking_scheme = derivedScheme;
    finalMarks = derivedScheme.length;
  } else {
    marking_scheme = markingScheme(input.marking_scheme, marks ?? 0, errors);
    if (answer_mode === "subjective" && marking_scheme.length === 0) errors.push("a subjective item needs a marking scheme (at least one {point, marks}).");
  }

  const explanation = strOrNull(input.explanation);
  if (explanation && explanation.length > QUESTION_LIMITS.explanation) errors.push(`explanation is longer than ${QUESTION_LIMITS.explanation} characters.`);
  if (explanation && RAW_HTML.test(explanation)) errors.push("explanation may not contain HTML tags.");

  const tags: string[] = [];
  if (input.tags !== undefined && input.tags !== null) {
    if (!Array.isArray(input.tags)) errors.push("tags must be a list.");
    else {
      for (const t of input.tags) {
        const s = str(t);
        if (!s) continue;
        if (s.length > QUESTION_LIMITS.tag) errors.push(`tag "${s.slice(0, 20)}…" is longer than ${QUESTION_LIMITS.tag} characters.`);
        if (!tags.includes(s)) tags.push(s.slice(0, QUESTION_LIMITS.tag));
      }
      if (tags.length > QUESTION_LIMITS.tags) errors.push(`tags: at most ${QUESTION_LIMITS.tags}.`);
    }
  }

  if (errors.length) return { ok: false, errors, item: null };
  return {
    ok: true,
    errors: [],
    item: {
      item_type,
      answer_mode,
      objective_ref,
      claim_ref,
      difficulty: difficulty!,
      cognitive_level: cognitive_level as CognitiveLevel,
      marks: finalMarks!,
      est_seconds,
      stem: stem.slice(0, QUESTION_LIMITS.stem),
      options,
      distractor_rationale,
      answer,
      marking_scheme,
      explanation: explanation ? explanation.slice(0, QUESTION_LIMITS.explanation) : null,
      tags: tags.slice(0, QUESTION_LIMITS.tags),
    },
  };
}

/** What the route hashes for content_hash — the worker's rule (decision 8):
 *  `sha1(item_type + "|" + canonical_key(stem))`. The sha1 itself is Node's
 *  crypto (server only); this is the string it digests, so the two sides agree
 *  on the key and a re-typed stem with the same words is the same item. */
export function questionContentKey(itemType: ItemType | string, stem: string): string {
  return `${itemType}|${canonicalKey(stem)}`;
}

/** The editable fields of a stored row, as the row editor starts from them. */
export function questionEditOf(q: TopicQuestion): QuestionEdit {
  const opts = q.options;
  return {
    item_type: q.item_type,
    answer_mode: q.answer_mode,
    objective_ref: q.objective_ref ?? "",
    claim_ref: q.claim_ref ?? null,
    difficulty: q.difficulty,
    cognitive_level: q.cognitive_level,
    marks: q.marks,
    est_seconds: q.est_seconds ?? null,
    stem: q.stem ?? "",
    options: Array.isArray(opts)
      ? (opts as unknown[])
          .filter(isRec)
          .map((o) => ({ key: str(o.key), text: str(o.text) }))
          // a row with neither key nor text is jsonb noise, not an option
          .filter((o) => o.key || o.text)
      : isRec(opts)
        ? opts
        : null,
    distractor_rationale: isRec(q.distractor_rationale) ? (q.distractor_rationale as DistractorRationale) : null,
    answer: isRec(q.answer) ? q.answer : {},
    marking_scheme: Array.isArray(q.marking_scheme)
      ? (q.marking_scheme as unknown[]).filter(isRec).map((p) => ({ point: String(p.point ?? ""), marks: num(p.marks) ?? 0 }))
      : [],
    explanation: q.explanation ?? null,
    tags: Array.isArray(q.tags) ? q.tags.map(String) : [],
  };
}

/** One line for the table's Answer column. */
export function answerSummary(q: Pick<TopicQuestion, "item_type" | "answer">): string {
  const a = isRec(q.answer) ? q.answer : {};
  if (q.item_type === "mcq") return typeof a.key === "string" ? a.key : "—";
  if (q.item_type === "true_false") return a.value === true ? "true" : a.value === false ? "false" : "—";
  if (typeof a.text === "string" && a.text.trim()) return a.text.trim();
  const keys = Object.keys(a);
  return keys.length ? JSON.stringify(a) : "—";
}

// ── Maturity ladder (plan §1.7; 0112 topic_bank_maturity) ────────────────────
// The database trigger keeps topics.bank_maturity current from the approved
// English items; this is the same ladder so the page can say how many more
// approvals reach the next rung without another query.

export const MATURITY_LADDER: readonly { rung: BankMaturity; min: number }[] = [
  { rung: "none", min: 0 },
  { rung: "basic", min: 10 },
  { rung: "good", min: 20 },
  { rung: "strong", min: 30 },
  { rung: "assessment", min: 50 },
  { rung: "exam_ready", min: 100 },
];

export function maturityFor(approvedCount: number): BankMaturity {
  let out: BankMaturity = "none";
  for (const step of MATURITY_LADDER) if (approvedCount >= step.min) out = step.rung;
  return out;
}

/** Position on the ladder (none = 0 … exam_ready = 5); an unknown value is 0. */
export function maturityRank(m: BankMaturity | string | null | undefined): number {
  const i = MATURITY_LADDER.findIndex((s) => s.rung === m);
  return i < 0 ? 0 : i;
}

/** Where the bank stands and what reaches the next rung. `next` is null and
 *  `needed` 0 at the top. */
export function nextRung(approvedCount: number): { current: BankMaturity; next: BankMaturity | null; needed: number } {
  const n = Math.max(0, Math.floor(approvedCount));
  const current = maturityFor(n);
  const idx = MATURITY_LADDER.findIndex((s) => s.rung === current);
  const step = MATURITY_LADDER[idx + 1];
  return step ? { current, next: step.rung, needed: step.min - n } : { current, next: null, needed: 0 };
}

/** The blueprint's cheap pre-check: is the bank at least `need`? */
export function meetsMaturity(have: BankMaturity | string | null | undefined, need: BankMaturity | string): boolean {
  return maturityRank(have) >= maturityRank(need);
}

// ── Objective coverage ───────────────────────────────────────────────────────

export type ObjectiveCoverageRow = {
  /** the objective id, or null for the row of items whose objective_ref names
   *  no objective of this article (present only when there are any) */
  id: string | null;
  text: string;
  approved: number;
  draft: number;
  /** live items: approved + draft (rejected and retired are not in the bank) */
  total: number;
};

/** One row per article objective, in the article's order: how many approved
 *  and draft items serve it. Items pointing at no known objective are counted
 *  in a trailing "No objective" row so they are not silently invisible. */
export function objectiveCoverage(
  items: readonly Pick<TopicQuestion, "objective_ref" | "status">[],
  objectives: readonly { id: string; text: string }[],
): ObjectiveCoverageRow[] {
  const rows = new Map<string, ObjectiveCoverageRow>(objectives.map((o) => [o.id, { id: o.id, text: o.text, approved: 0, draft: 0, total: 0 }]));
  const orphan: ObjectiveCoverageRow = { id: null, text: "No objective", approved: 0, draft: 0, total: 0 };
  for (const it of items) {
    if (it.status !== "approved" && it.status !== "draft") continue;
    const row = (it.objective_ref && rows.get(it.objective_ref)) || orphan;
    if (it.status === "approved") row.approved++;
    else row.draft++;
    row.total++;
  }
  const out = [...rows.values()];
  if (orphan.total) out.push(orphan);
  return out;
}

/** The objectives with fewer than `min` live items — what the worker's
 *  coverage top-up names (decision 8: "objectives with < 2 items"). */
export function thinObjectives(rows: readonly ObjectiveCoverageRow[], min = 2): ObjectiveCoverageRow[] {
  return rows.filter((r) => r.id !== null && r.total < min);
}

// ── Near-duplicates ──────────────────────────────────────────────────────────

/** The first 8 whitespace-separated words of a stem, canonicalKey'd: two stems
 *  that open the same way are probably the same question re-worded. */
export function duplicateKey(stem: string): string {
  return canonicalKey((stem ?? "").trim().split(/\s+/).slice(0, 8).join(" "));
}

export type DuplicateGroup = { key: string; ids: string[] };

/** Groups of two or more non-retired items sharing a duplicateKey, in order of
 *  first appearance. Retired items are out of the bank and do not warn. */
export function duplicateGroups(items: readonly Pick<TopicQuestion, "id" | "stem" | "status">[]): DuplicateGroup[] {
  const groups = new Map<string, string[]>();
  for (const it of items) {
    if (it.status === "retired") continue;
    const key = duplicateKey(it.stem);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), it.id]);
  }
  return [...groups].filter(([, ids]) => ids.length >= 2).map(([key, ids]) => ({ key, ids }));
}

// ── Regenerate rejected ──────────────────────────────────────────────────────

export const HINTS_MAX = 4000;

/** The hints a "Regenerate rejected" job carries: the rejected items' review
 *  notes and stems first (what to avoid or fix), then the member's own hints,
 *  the whole thing capped at HINTS_MAX so the job row never refuses it. */
export function rejectedHints(rejected: readonly Pick<TopicQuestion, "stem" | "notes">[], extra: string | null | undefined, cap = HINTS_MAX): string {
  const lines: string[] = [];
  if (rejected.length) {
    lines.push("Previously rejected items — avoid these or fix what the notes say:");
    for (const r of rejected) {
      const note = (r.notes ?? "").trim();
      const stem = (r.stem ?? "").trim().replace(/\s+/g, " ");
      lines.push(`- ${note ? `${note}: ` : ""}${stem}`);
    }
  }
  const own = (extra ?? "").trim();
  if (own) lines.push(lines.length ? `\n${own}` : own);
  return lines.join("\n").slice(0, cap).trim();
}

// ── Blueprints (0112 question_set_blueprints) ────────────────────────────────

export const BLUEPRINT_PRESETS = ["remedial", "standard", "challenge", "custom"] as const;
export type BlueprintPreset = (typeof BLUEPRINT_PRESETS)[number];
export const BLUEPRINT_SCOPES = ["worksheet", "paper", "mock_exam"] as const;
export type BlueprintScope = (typeof BLUEPRINT_SCOPES)[number];
export const MIN_MATURITIES = ["basic", "good", "strong", "assessment", "exam_ready"] as const;
export type MinMaturity = (typeof MIN_MATURITIES)[number];
export const BLUEPRINT_STATUSES = ["active", "retired"] as const;
export type BlueprintStatus = (typeof BLUEPRINT_STATUSES)[number];

export type BlueprintSpec = {
  preset: BlueprintPreset;
  /** share of the items that are objective, 0..1 */
  objective_ratio: number;
  /** weights per difficulty "1".."5" summing to 1 (absent keys weigh 0) */
  difficulty_mix: Partial<Record<Difficulty, number>>;
  count: number;
  total_marks: number;
};

export type Blueprint = {
  id: string;
  name: string;
  scope: BlueprintScope;
  curriculum_id: string | null;
  spec: BlueprintSpec;
  min_maturity: MinMaturity;
  status: BlueprintStatus;
  created_by: string | null;
  created_at: string;
};

export type QuestionSet = {
  id: string;
  blueprint_id: string;
  topic_ids: string[];
  language: string;
  question_ids: string[];
  seed: number;
  rendered_generation_id: string | null;
  requested_by: string | null;
  created_at: string;
};

export const BLUEPRINT_LIMITS = { name: 120, count_max: 60, total_marks_max: 200, mix_tolerance: 0.01 } as const;

export type BlueprintSpecValidation = { ok: true; errors: []; spec: BlueprintSpec } | { ok: false; errors: string[]; spec: null };

/** The spec column's gate: preset known, objective_ratio 0..1, difficulty_mix
 *  keys "1".."5" with non-negative weights adding up to 1 (±0.01) and at least
 *  one of them positive, count 1..60, total_marks 1..200. Weights are kept as
 *  given (not re-normalised): a mix that says 0.5/0.4/0.1 is stored as such. */
export function validateBlueprintSpec(input: unknown): BlueprintSpecValidation {
  const errors: string[] = [];
  if (!isRec(input)) return { ok: false, errors: ["spec must be an object."], spec: null };
  const preset = input.preset;
  if (!(BLUEPRINT_PRESETS as readonly string[]).includes(preset as string)) errors.push(`preset must be one of ${BLUEPRINT_PRESETS.join(", ")}.`);
  const ratio = num(input.objective_ratio);
  if (ratio === null || ratio < 0 || ratio > 1) errors.push("objective_ratio must be a number from 0 to 1.");
  const mix: Partial<Record<Difficulty, number>> = {};
  if (!isRec(input.difficulty_mix)) errors.push('difficulty_mix must be an object of weights keyed "1".."5".');
  else {
    let sum = 0;
    for (const [k, v] of Object.entries(input.difficulty_mix)) {
      if (!(DIFFICULTIES as readonly string[]).includes(k)) {
        errors.push(`difficulty_mix: unknown difficulty "${k}" (use "1".."5").`);
        continue;
      }
      const w = num(v);
      if (w === null || w < 0) {
        errors.push(`difficulty_mix["${k}"] must be a non-negative number.`);
        continue;
      }
      if (w > 0) mix[k as Difficulty] = w;
      sum += w;
    }
    if (Object.keys(mix).length === 0) errors.push("difficulty_mix needs at least one positive weight.");
    else if (Math.abs(sum - 1) > BLUEPRINT_LIMITS.mix_tolerance) errors.push(`difficulty_mix adds up to ${Math.round(sum * 1000) / 1000}; it must add up to 1.`);
  }
  const count = int(input.count);
  if (count === null || count < 1 || count > BLUEPRINT_LIMITS.count_max) errors.push(`count must be a whole number from 1 to ${BLUEPRINT_LIMITS.count_max}.`);
  const total_marks = int(input.total_marks);
  if (total_marks === null || total_marks < 1 || total_marks > BLUEPRINT_LIMITS.total_marks_max) {
    errors.push(`total_marks must be a whole number from 1 to ${BLUEPRINT_LIMITS.total_marks_max}.`);
  }
  if (errors.length) return { ok: false, errors, spec: null };
  return { ok: true, errors: [], spec: { preset: preset as BlueprintPreset, objective_ratio: ratio!, difficulty_mix: mix, count: count!, total_marks: total_marks! } };
}

export type BlueprintInput = { name: string; scope: BlueprintScope; min_maturity: MinMaturity; spec: BlueprintSpec };
export type BlueprintValidation = { ok: true; errors: []; blueprint: BlueprintInput } | { ok: false; errors: string[]; blueprint: null };

/** The create / update body: name, scope, min_maturity and the spec above. */
export function validateBlueprint(input: unknown): BlueprintValidation {
  if (!isRec(input)) return { ok: false, errors: ["blueprint must be an object."], blueprint: null };
  const errors: string[] = [];
  const name = str(input.name);
  if (!name) errors.push("name is required.");
  else if (name.length > BLUEPRINT_LIMITS.name) errors.push(`name is longer than ${BLUEPRINT_LIMITS.name} characters.`);
  const scope = input.scope;
  if (!(BLUEPRINT_SCOPES as readonly string[]).includes(scope as string)) errors.push(`scope must be one of ${BLUEPRINT_SCOPES.join(", ")}.`);
  const min_maturity = input.min_maturity;
  if (!(MIN_MATURITIES as readonly string[]).includes(min_maturity as string)) errors.push(`min_maturity must be one of ${MIN_MATURITIES.join(", ")}.`);
  const spec = validateBlueprintSpec(input.spec);
  if (!spec.ok) errors.push(...spec.errors);
  if (errors.length || !spec.ok) return { ok: false, errors, blueprint: null };
  return { ok: true, errors: [], blueprint: { name: name.slice(0, BLUEPRINT_LIMITS.name), scope: scope as BlueprintScope, min_maturity: min_maturity as MinMaturity, spec: spec.spec } };
}

// ── Composer arithmetic (mirror of catalogue/composer.py) ────────────────────

/**
 * Split `total` whole items across weighted buckets by the largest-remainder
 * method: each bucket gets floor(total × weight / Σweights); the leftover
 * items go one each to the buckets with the largest fractional parts, ties
 * broken by POSITION in `buckets` (earlier wins). Deterministic, so the
 * portal's pre-check and the worker agree on every bucket. Zero weights get
 * zero; a total of 0 or no positive weight gives all zeros.
 */
export function largestRemainder(total: number, buckets: readonly { key: string; weight: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  const sum = buckets.reduce((n, b) => n + Math.max(0, b.weight), 0);
  const n = Math.max(0, Math.floor(total));
  if (sum <= 0 || n === 0) {
    for (const b of buckets) out[b.key] = 0;
    return out;
  }
  const shares = buckets.map((b, i) => {
    const exact = (n * Math.max(0, b.weight)) / sum;
    const floor = Math.floor(exact + 1e-9);
    return { key: b.key, i, floor, frac: exact - floor };
  });
  let left = n - shares.reduce((s, x) => s + x.floor, 0);
  const order = [...shares].sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const s of shares) out[s.key] = s.floor;
  for (const s of order) {
    if (left <= 0) break;
    // a bucket with zero weight never receives a leftover
    if (buckets[s.i].weight <= 0) continue;
    out[s.key]++;
    left--;
  }
  return out;
}

export type ModeCounts = Record<AnswerMode, Partial<Record<Difficulty, number>>>;
export type ComposePlan = Record<AnswerMode, Partial<Record<Difficulty, number>>>;

/** The buckets a blueprint fills: objective / subjective by objective_ratio
 *  (largest remainder over the two modes, objective first), then each mode's
 *  count by difficulty_mix (largest remainder over "1".."5" in order). Only
 *  non-zero buckets are listed. */
export function composePlan(spec: BlueprintSpec): ComposePlan {
  const ratio = Math.min(1, Math.max(0, spec.objective_ratio));
  const modes = largestRemainder(spec.count, [
    { key: "objective", weight: ratio },
    { key: "subjective", weight: 1 - ratio },
  ]);
  const weights = DIFFICULTIES.map((d) => ({ key: d, weight: spec.difficulty_mix[d] ?? 0 }));
  const plan: ComposePlan = { objective: {}, subjective: {} };
  for (const mode of ANSWER_MODES) {
    const per = largestRemainder(modes[mode] ?? 0, weights);
    for (const d of DIFFICULTIES) if (per[d] > 0) plan[mode][d] = per[d];
  }
  return plan;
}

/** Approved items per (answer_mode, difficulty) — what canCompose is checked
 *  against. Only approved items are composable. */
export function modeCounts(items: readonly Pick<TopicQuestion, "answer_mode" | "difficulty" | "status">[]): ModeCounts {
  const out: ModeCounts = { objective: {}, subjective: {} };
  for (const it of items) {
    if (it.status !== "approved") continue;
    const d = String(it.difficulty) as Difficulty;
    if (!(DIFFICULTIES as readonly string[]).includes(d)) continue;
    const mode = it.answer_mode === "objective" ? "objective" : "subjective";
    out[mode][d] = (out[mode][d] ?? 0) + 1;
  }
  return out;
}

export type ComposeCheck = { ok: boolean; reasons: string[]; plan: ComposePlan };

/**
 * Can the bank satisfy this blueprint? The same arithmetic the worker's
 * composer runs before it fills a single bucket, so a preset the portal
 * offers is one the worker will not raise Unsatisfiable on:
 *   • maturity (when given): the topic's rung is at least the blueprint's
 *   • every bucket of composePlan has at least as many approved items
 * `reasons` lists every short bucket ("objective difficulty 3: need 5, have
 * 2") — never padded, never rounded up.
 */
export function canCompose(spec: BlueprintSpec, counts: ModeCounts, maturity?: { have: BankMaturity | string | null | undefined; need: MinMaturity | string }): ComposeCheck {
  const reasons: string[] = [];
  if (maturity && !meetsMaturity(maturity.have, maturity.need)) {
    reasons.push(`bank maturity is ${String(maturity.have ?? "none").replace(/_/g, " ")}; this blueprint needs ${String(maturity.need).replace(/_/g, " ")}`);
  }
  const plan = composePlan(spec);
  for (const mode of ANSWER_MODES) {
    for (const d of DIFFICULTIES) {
      const need = plan[mode][d] ?? 0;
      if (!need) continue;
      const have = counts[mode]?.[d] ?? 0;
      if (have < need) reasons.push(`${mode} difficulty ${d}: need ${need}, have ${have}`);
    }
  }
  return { ok: reasons.length === 0, reasons, plan };
}

// ── Filters (the questions page's searchParams) ──────────────────────────────

export type QuestionFilters = { type: ItemType | ""; difficulty: number; status: QuestionStatus | "" };

/** Unknown values fall back rather than throwing — a hand-edited URL must not
 *  500 an internal tool (the status.ts stance). difficulty 0 = any. */
export function parseQuestionFilters(sp: Record<string, string | undefined>): QuestionFilters {
  const d = Number.parseInt(sp.difficulty ?? "0", 10);
  return {
    type: isItemType(sp.type) ? sp.type : "",
    difficulty: Number.isInteger(d) && d >= 1 && d <= 5 ? d : 0,
    status: isQuestionStatus(sp.status) ? sp.status : "",
  };
}

export function withQuestionFilter(f: QuestionFilters, patch: Partial<QuestionFilters>): string {
  const next = { ...f, ...patch };
  const p = new URLSearchParams();
  if (next.type) p.set("type", next.type);
  if (next.difficulty) p.set("difficulty", String(next.difficulty));
  if (next.status) p.set("status", next.status);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function applyQuestionFilters<T extends Pick<TopicQuestion, "item_type" | "difficulty" | "status">>(items: readonly T[], f: QuestionFilters): T[] {
  return items.filter((q) => (!f.type || q.item_type === f.type) && (!f.difficulty || q.difficulty === f.difficulty) && (!f.status || q.status === f.status));
}

// The curriculum header a composed worksheet carries (decision 10) is the kit
// route's helper, kit.ts curriculumHeaderLines — one format for every
// catalogue document — imported by the compose route directly.

// ── Small helpers ────────────────────────────────────────────────────────────

/** "mm:ss" for a duration in seconds (est_seconds, clip bounds). */
export function mmss(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The set's seed: a whole number the member typed, or one from the clock so
 *  two composes a second apart draw different items. */
export function seedOf(v: unknown, now = Date.now()): number | null {
  if (v === undefined || v === null || v === "") return now % 2147483647;
  const n = int(v);
  return n === null || n < 0 || n > 2147483647 ? null : n;
}
