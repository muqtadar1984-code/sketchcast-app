// Pure logic for the knowledge article (Library portal, Phase 2b): the
// article status machine, the shape validator the Save action runs, the word
// count, the section-by-section diff between two versions, and the "latest
// version per topic" reduction the list screens use. No I/O anywhere, so the
// route handler and the panels share one answer and the rules are unit-tested
// without a database (topic-catalogue plan §7.2).
//
// Human approval is NOT here on purpose: nothing in this module produces an
// 'approved' status. Approval is approve_topic_article() (0112), called by the
// route with the reviewer's id — plan §1.3.

import type {
  ArticleBody,
  ArticleFigureInput,
  ArticleObjective,
  ArticleSection,
  ArticleStatus,
  Claim,
  FigureSpec,
  FigureStatus,
  GlossaryEntry,
  Misconception,
  TopicArticle,
  WorkedExample,
} from "./types";

// ── Status ───────────────────────────────────────────────────────────────────

export const ARTICLE_STATUSES = ["draft", "in_review", "approved", "superseded", "rejected"] as const;

export function isArticleStatus(s: unknown): s is ArticleStatus {
  return typeof s === "string" && (ARTICLE_STATUSES as readonly string[]).includes(s);
}

export function articleStatusLabel(s: ArticleStatus | string): string {
  return String(s).replace(/_/g, " ");
}

/** A version a human may still change: the model's draft, or one already sent
 *  for review (a reviewer's small fix does not need a new version). Approved,
 *  superseded and rejected versions are history — read-only; "New version
 *  from this" copies them forward. */
export function canEditArticle(s: ArticleStatus | string): boolean {
  return s === "draft" || s === "in_review";
}

/** The versions approve_topic_article() accepts — the same two. Mirrored here
 *  so the panel can hide the button instead of showing a 409. */
export function canApproveArticle(s: ArticleStatus | string): boolean {
  return s === "draft" || s === "in_review";
}

/** Reject is the reviewer's other verdict on the same two states. */
export function canRejectArticle(s: ArticleStatus | string): boolean {
  return s === "draft" || s === "in_review";
}

/** Submit for review: draft → in_review, nothing else. */
export function canSubmitArticle(s: ArticleStatus | string): boolean {
  return s === "draft";
}

export const ARTICLE_STATUS_TONE: Record<ArticleStatus, string> = {
  draft: "bg-[#FFF1D6] text-[#9A6400]",
  in_review: "bg-[#EDE7FB] text-[#5B3FBF]",
  approved: "bg-[#E6F6F2] text-[#0F7A68]",
  superseded: "bg-[#EEF0EC] text-[#5B6470]",
  rejected: "bg-[#FFE9E3] text-[#B3401F]",
};

export const FIGURE_STATUS_TONE: Record<FigureStatus, string> = {
  draft: "bg-[#FFF1D6] text-[#9A6400]",
  rendered: "bg-[#E6F1FB] text-[#1F5B99]",
  approved: "bg-[#E6F6F2] text-[#0F7A68]",
  rejected: "bg-[#FFE9E3] text-[#B3401F]",
};

/** The topic statuses an article may be written for. A candidate has not been
 *  approved as a topic yet (plan §1.3: the article comes AFTER the topic); a
 *  retired one has left every queue. */
export function topicAcceptsArticle(topicStatus: string): boolean {
  return topicStatus !== "candidate" && topicStatus !== "retired";
}

// ── Word count ───────────────────────────────────────────────────────────────

/** Words in a piece of markdown: tokens carrying a letter or a digit, so
 *  bullets, rules and bare punctuation do not count. */
export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  let n = 0;
  for (const tok of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(tok)) n++;
  return n;
}

/** The article's word count — what a reader reads: headings and bodies,
 *  objectives, glossary, misconceptions and worked examples. Claims are the
 *  sections restated (question authoring reads them, not students), figure
 *  specs are instructions to a renderer; neither counts. */
export function wordCount(a: Pick<ArticleBody, "title" | "objectives" | "sections" | "glossary" | "misconceptions" | "worked_examples">): number {
  let n = countWords(a.title);
  for (const o of a.objectives) n += countWords(o.text);
  for (const s of a.sections) n += countWords(s.heading) + countWords(s.body_md);
  for (const g of a.glossary) n += countWords(g.term) + countWords(g.definition);
  for (const m of a.misconceptions) n += countWords(m.misconception) + countWords(m.correction);
  for (const w of a.worked_examples) n += countWords(w.problem) + countWords(w.solution_md);
  return n;
}

// ── Validation ───────────────────────────────────────────────────────────────
// The Save action's gate. Every list is bounded (a runaway body is refused, not
// stored), every id is unique within its list, and every cross-reference —
// a section's figure keys, its covered objectives, a claim's section — must
// resolve inside the same article. The output is a NORMALISED body (trimmed
// strings, sorted figures, `null` for blanks) so the route writes exactly what
// was validated.

export const ARTICLE_LIMITS = {
  title: 200,
  objectives: 30,
  sections: 40,
  heading: 200,
  body_md: 20000,
  glossary: 150,
  term: 120,
  definition: 1000,
  misconceptions: 40,
  worked_examples: 25,
  claims: 300,
  claim: 600,
  figures: 30,
  caption: 500,
  parts: 40,
  part: 80,
  depth_rationale: 2000,
  id: 64,
  /** figure_key: a snake_case identifier the renderer files the asset under */
  figure_key: 80,
} as const;

const FIGURE_KEY = /^[a-z][a-z0-9_]*$/;

export type ArticleValidation =
  | { ok: true; errors: []; wordCount: number; article: ArticleBody }
  | { ok: false; errors: string[]; wordCount: number; article: null };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s ? s : null;
};

/** Fails on a non-array and on anything past `max`; each entry goes through
 *  `one(entry, index)`, which pushes its own errors and returns the normalised
 *  item or null to skip it. */
function list<T>(v: unknown, name: string, max: number, errors: string[], one: (entry: unknown, i: number) => T | null): T[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push(`${name} must be a list.`);
    return [];
  }
  if (v.length > max) errors.push(`${name}: at most ${max} entries (got ${v.length}).`);
  const out: T[] = [];
  v.slice(0, max).forEach((entry, i) => {
    const item = one(entry, i);
    if (item !== null) out.push(item);
  });
  return out;
}

function uniqueIds(items: readonly { id: string }[], name: string, errors: string[]) {
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) errors.push(`${name}: duplicate id "${it.id}".`);
    seen.add(it.id);
  }
}

function idOf(entry: Rec, name: string, i: number, errors: string[]): string {
  const id = str(entry.id);
  if (!id) errors.push(`${name} #${i + 1}: id is required.`);
  else if (id.length > ARTICLE_LIMITS.id) errors.push(`${name} #${i + 1}: id is longer than ${ARTICLE_LIMITS.id} characters.`);
  return id;
}

function required(entry: Rec, key: string, max: number, name: string, i: number, errors: string[]): string {
  const s = str(entry[key]);
  if (!s) errors.push(`${name} #${i + 1}: ${key} is required.`);
  else if (s.length > max) errors.push(`${name} #${i + 1}: ${key} is longer than ${max} characters.`);
  return s.slice(0, max);
}

function stringList(v: unknown, max: number, each: number, name: string, i: number, key: string, errors: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push(`${name} #${i + 1}: ${key} must be a list.`);
    return [];
  }
  const out: string[] = [];
  for (const raw of v) {
    const s = str(raw);
    if (!s) continue;
    if (s.length > each) errors.push(`${name} #${i + 1}: an entry of ${key} is longer than ${each} characters.`);
    if (!out.includes(s)) out.push(s.slice(0, each));
  }
  if (out.length > max) errors.push(`${name} #${i + 1}: ${key} has more than ${max} entries.`);
  return out.slice(0, max);
}

export function validateFigureSpec(v: unknown, name: string, i: number, errors: string[]): FigureSpec {
  if (!isRec(v)) {
    errors.push(`${name} #${i + 1}: spec is required ({subject, parts}).`);
    return { subject: "", parts: [], style: null, notes: null };
  }
  const subject = required(v, "subject", ARTICLE_LIMITS.caption, name, i, errors);
  const parts = stringList(v.parts, ARTICLE_LIMITS.parts, ARTICLE_LIMITS.part, name, i, "spec.parts", errors);
  return { subject, parts, style: strOrNull(v.style), notes: strOrNull(v.notes) };
}

/**
 * Validate and normalise an article body from an untrusted request. `ok` is
 * false on ANY error; the list names every problem at once so the editor can
 * show them all rather than one per Save. `wordCount` is computed either way
 * (the editor shows it live).
 */
export function validateArticle(input: unknown): ArticleValidation {
  const errors: string[] = [];
  if (!isRec(input)) {
    return { ok: false, errors: ["article must be an object."], wordCount: 0, article: null };
  }

  const title = str(input.title);
  if (!title) errors.push("title is required.");
  else if (title.length > ARTICLE_LIMITS.title) errors.push(`title is longer than ${ARTICLE_LIMITS.title} characters.`);

  const objectives = list<ArticleObjective>(input.objectives, "objectives", ARTICLE_LIMITS.objectives, errors, (e, i) => {
    if (!isRec(e)) {
      errors.push(`objectives #${i + 1}: must be {id, text}.`);
      return null;
    }
    return { id: idOf(e, "objectives", i, errors), text: required(e, "text", ARTICLE_LIMITS.claim, "objectives", i, errors) };
  });
  uniqueIds(objectives, "objectives", errors);
  const objectiveIds = new Set(objectives.map((o) => o.id));

  const figures = list<ArticleFigureInput>(input.figures, "figures", ARTICLE_LIMITS.figures, errors, (e, i) => {
    if (!isRec(e)) {
      errors.push(`figures #${i + 1}: must be {figure_key, caption, spec}.`);
      return null;
    }
    const figure_key = str(e.figure_key);
    if (!figure_key) errors.push(`figures #${i + 1}: figure_key is required.`);
    else if (figure_key.length > ARTICLE_LIMITS.figure_key || !FIGURE_KEY.test(figure_key)) {
      errors.push(`figures #${i + 1}: figure_key "${figure_key}" must be snake_case (a-z, 0-9, _), up to ${ARTICLE_LIMITS.figure_key} characters.`);
    }
    const caption = strOrNull(e.caption);
    if (caption && caption.length > ARTICLE_LIMITS.caption) errors.push(`figures #${i + 1}: caption is longer than ${ARTICLE_LIMITS.caption} characters.`);
    const sort = typeof e.sort === "number" && Number.isFinite(e.sort) ? Math.trunc(e.sort) : i;
    return { figure_key, caption: caption ? caption.slice(0, ARTICLE_LIMITS.caption) : null, spec: validateFigureSpec(e.spec, "figures", i, errors), sort };
  });
  {
    const seen = new Set<string>();
    for (const f of figures) {
      if (seen.has(f.figure_key)) errors.push(`figures: duplicate figure_key "${f.figure_key}".`);
      seen.add(f.figure_key);
    }
  }
  figures.sort((a, b) => a.sort - b.sort || a.figure_key.localeCompare(b.figure_key));
  figures.forEach((f, i) => (f.sort = i));
  const figureKeys = new Set(figures.map((f) => f.figure_key));

  const sections = list<ArticleSection>(input.sections, "sections", ARTICLE_LIMITS.sections, errors, (e, i) => {
    if (!isRec(e)) {
      errors.push(`sections #${i + 1}: must be {id, heading, body_md, figure_keys, covers}.`);
      return null;
    }
    const id = idOf(e, "sections", i, errors);
    const heading = required(e, "heading", ARTICLE_LIMITS.heading, "sections", i, errors);
    const body = typeof e.body_md === "string" ? e.body_md.replace(/\r\n/g, "\n").trim() : "";
    if (body.length > ARTICLE_LIMITS.body_md) errors.push(`sections #${i + 1}: body_md is longer than ${ARTICLE_LIMITS.body_md} characters.`);
    const figure_keys = stringList(e.figure_keys, ARTICLE_LIMITS.figures, ARTICLE_LIMITS.figure_key, "sections", i, "figure_keys", errors);
    for (const k of figure_keys) if (!figureKeys.has(k)) errors.push(`sections #${i + 1}: figure "${k}" is not one of the article's figures.`);
    const covers = stringList(e.covers, ARTICLE_LIMITS.objectives, ARTICLE_LIMITS.id, "sections", i, "covers", errors);
    for (const c of covers) if (!objectiveIds.has(c)) errors.push(`sections #${i + 1}: covers names an unknown objective "${c}".`);
    return { id, heading, body_md: body.slice(0, ARTICLE_LIMITS.body_md), figure_keys, covers };
  });
  if (sections.length === 0) errors.push("sections: an article needs at least one section.");
  uniqueIds(sections, "sections", errors);
  const sectionIds = new Set(sections.map((s) => s.id));

  const glossary = list<GlossaryEntry>(input.glossary, "glossary", ARTICLE_LIMITS.glossary, errors, (e, i) => {
    if (!isRec(e)) {
      errors.push(`glossary #${i + 1}: must be {term, definition}.`);
      return null;
    }
    return {
      term: required(e, "term", ARTICLE_LIMITS.term, "glossary", i, errors),
      definition: required(e, "definition", ARTICLE_LIMITS.definition, "glossary", i, errors),
    };
  });
  {
    const seen = new Set<string>();
    for (const g of glossary) {
      const k = g.term.toLowerCase();
      if (seen.has(k)) errors.push(`glossary: "${g.term}" is defined twice.`);
      seen.add(k);
    }
  }

  const misconceptions = list<Misconception>(input.misconceptions, "misconceptions", ARTICLE_LIMITS.misconceptions, errors, (e, i) => {
    if (!isRec(e)) {
      errors.push(`misconceptions #${i + 1}: must be {id, misconception, correction}.`);
      return null;
    }
    return {
      id: idOf(e, "misconceptions", i, errors),
      misconception: required(e, "misconception", ARTICLE_LIMITS.definition, "misconceptions", i, errors),
      correction: required(e, "correction", ARTICLE_LIMITS.definition, "misconceptions", i, errors),
    };
  });
  uniqueIds(misconceptions, "misconceptions", errors);

  const worked_examples = list<WorkedExample>(input.worked_examples, "worked_examples", ARTICLE_LIMITS.worked_examples, errors, (e, i) => {
    if (!isRec(e)) {
      errors.push(`worked_examples #${i + 1}: must be {id, problem, solution_md}.`);
      return null;
    }
    return {
      id: idOf(e, "worked_examples", i, errors),
      problem: required(e, "problem", ARTICLE_LIMITS.body_md, "worked_examples", i, errors),
      solution_md: required(e, "solution_md", ARTICLE_LIMITS.body_md, "worked_examples", i, errors),
    };
  });
  uniqueIds(worked_examples, "worked_examples", errors);

  const claims = list<Claim>(input.claims, "claims", ARTICLE_LIMITS.claims, errors, (e, i) => {
    if (!isRec(e)) {
      errors.push(`claims #${i + 1}: must be {id, text, section_id}.`);
      return null;
    }
    const section_id = str(e.section_id);
    if (!section_id) errors.push(`claims #${i + 1}: section_id is required.`);
    else if (!sectionIds.has(section_id)) errors.push(`claims #${i + 1}: section "${section_id}" is not one of the article's sections.`);
    return { id: idOf(e, "claims", i, errors), text: required(e, "text", ARTICLE_LIMITS.claim, "claims", i, errors), section_id };
  });
  uniqueIds(claims, "claims", errors);

  const depth_rationale = strOrNull(input.depth_rationale);
  if (depth_rationale && depth_rationale.length > ARTICLE_LIMITS.depth_rationale) {
    errors.push(`depth_rationale is longer than ${ARTICLE_LIMITS.depth_rationale} characters.`);
  }

  const article: ArticleBody = {
    title: title.slice(0, ARTICLE_LIMITS.title),
    objectives,
    sections,
    glossary,
    misconceptions,
    worked_examples,
    claims,
    depth_rationale: depth_rationale ? depth_rationale.slice(0, ARTICLE_LIMITS.depth_rationale) : null,
    figures,
  };
  const words = wordCount(article);
  if (errors.length) return { ok: false, errors, wordCount: words, article: null };
  return { ok: true, errors: [], wordCount: words, article };
}

/** The editable body of a stored row (+ its figures), as the editor starts
 *  from it. Tolerates a row whose jsonb columns are not the expected shape
 *  (a hand-edited or older draft) by dropping what does not fit. */
export function articleBodyOf(
  row: Pick<TopicArticle, "title" | "objectives" | "sections" | "glossary" | "misconceptions" | "worked_examples" | "claims" | "depth_rationale">,
  figures: readonly Pick<ArticleFigureInput, "figure_key" | "caption" | "spec" | "sort">[],
): ArticleBody {
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    title: row.title ?? "",
    objectives: arr<ArticleObjective>(row.objectives).map((o) => ({ id: String(o?.id ?? ""), text: String(o?.text ?? "") })),
    sections: arr<ArticleSection>(row.sections).map((s) => ({
      id: String(s?.id ?? ""),
      heading: String(s?.heading ?? ""),
      body_md: String(s?.body_md ?? ""),
      figure_keys: arr<string>(s?.figure_keys).map(String),
      covers: arr<string>(s?.covers).map(String),
    })),
    glossary: arr<GlossaryEntry>(row.glossary).map((g) => ({ term: String(g?.term ?? ""), definition: String(g?.definition ?? "") })),
    misconceptions: arr<Misconception>(row.misconceptions).map((m) => ({
      id: String(m?.id ?? ""),
      misconception: String(m?.misconception ?? ""),
      correction: String(m?.correction ?? ""),
    })),
    worked_examples: arr<WorkedExample>(row.worked_examples).map((w) => ({
      id: String(w?.id ?? ""),
      problem: String(w?.problem ?? ""),
      solution_md: String(w?.solution_md ?? ""),
    })),
    claims: arr<Claim>(row.claims).map((c) => ({ id: String(c?.id ?? ""), text: String(c?.text ?? ""), section_id: String(c?.section_id ?? "") })),
    depth_rationale: row.depth_rationale ?? null,
    figures: [...figures]
      .map((f) => ({
        figure_key: f.figure_key,
        caption: f.caption ?? null,
        spec: {
          subject: String(f.spec?.subject ?? ""),
          parts: arr<string>(f.spec?.parts).map(String),
          style: f.spec?.style ?? null,
          notes: f.spec?.notes ?? null,
        },
        sort: f.sort ?? 0,
      }))
      .sort((a, b) => a.sort - b.sort || a.figure_key.localeCompare(b.figure_key)),
  };
}

/** A fresh id for a list entry the editor adds: `<prefix>_<n>`, the first n
 *  not already taken in `existing`. Pure, so the editor and the tests agree. */
export function nextId(prefix: string, existing: readonly { id: string }[]): string {
  const taken = new Set(existing.map((e) => e.id));
  for (let n = 1; ; n++) {
    const id = `${prefix}_${n}`;
    if (!taken.has(id)) return id;
  }
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export type SectionField = "heading" | "body_md" | "figure_keys" | "covers";

export type SectionDiffRow = {
  /** The section id both sides share, or the one side's id. */
  key: string;
  left: ArticleSection | null;
  right: ArticleSection | null;
  change: "same" | "changed" | "added" | "removed";
  /** Which fields differ (empty for same / added / removed). */
  fields: SectionField[];
};

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function changedFields(a: ArticleSection, b: ArticleSection): SectionField[] {
  const out: SectionField[] = [];
  if (a.heading.trim() !== b.heading.trim()) out.push("heading");
  if (a.body_md.trim() !== b.body_md.trim()) out.push("body_md");
  if (!sameList(a.figure_keys, b.figure_keys)) out.push("figure_keys");
  if (!sameList(a.covers, b.covers)) out.push("covers");
  return out;
}

/**
 * Section-by-section comparison of two versions (left = older, right = newer).
 * Sections are paired by id first; the sections left over on each side are
 * paired by ORDER (a regenerated draft may re-key every section — its third
 * section is still compared with the old third); what remains after that is
 * removed (left only) or added (right only). Rows come out in the left
 * version's order, with right-only rows placed by their own position.
 */
export function sectionDiff(left: readonly ArticleSection[], right: readonly ArticleSection[]): SectionDiffRow[] {
  const rightById = new Map<string, number>();
  right.forEach((s, i) => {
    if (s.id && !rightById.has(s.id)) rightById.set(s.id, i);
  });
  const pairs = new Map<number, number>(); // left index → right index
  const usedRight = new Set<number>();
  left.forEach((s, i) => {
    const j = s.id ? rightById.get(s.id) : undefined;
    if (j !== undefined && !usedRight.has(j)) {
      pairs.set(i, j);
      usedRight.add(j);
    }
  });
  const looseLeft = left.map((_, i) => i).filter((i) => !pairs.has(i));
  const looseRight = right.map((_, j) => j).filter((j) => !usedRight.has(j));
  for (let k = 0; k < Math.min(looseLeft.length, looseRight.length); k++) {
    pairs.set(looseLeft[k], looseRight[k]);
    usedRight.add(looseRight[k]);
  }

  const leftOfRight = new Map<number, number>(); // right index → left index
  for (const [li, rj] of pairs) leftOfRight.set(rj, li);

  type Positioned = SectionDiffRow & { pos: number; side: 0 | 1 };
  const rows: Positioned[] = [];
  left.forEach((l, i) => {
    const j = pairs.get(i);
    if (j === undefined) {
      rows.push({ key: l.id || `left_${i}`, left: l, right: null, change: "removed", fields: [], pos: i, side: 0 });
      return;
    }
    const r = right[j];
    const fields = changedFields(l, r);
    rows.push({ key: l.id || r.id || `pair_${i}`, left: l, right: r, change: fields.length ? "changed" : "same", fields, pos: i, side: 0 });
  });
  right.forEach((r, j) => {
    if (usedRight.has(j)) return;
    // Place an added section after the nearest paired section BEFORE it in the
    // right version, so the reading order of the newer text is kept.
    let pos = -1;
    for (let k = j - 1; k >= 0; k--) {
      const li = leftOfRight.get(k);
      if (li !== undefined) {
        pos = li;
        break;
      }
    }
    rows.push({ key: r.id || `right_${j}`, left: null, right: r, change: "added", fields: [], pos: pos + 0.5, side: 1 });
  });
  rows.sort((a, b) => a.pos - b.pos || a.side - b.side);
  return rows.map(({ pos: _pos, side: _side, ...row }) => row);
}

/** How many rows of a diff are not "same" — the panel's one-line summary. */
export function diffSummary(rows: readonly SectionDiffRow[]): { changed: number; added: number; removed: number; same: number } {
  const out = { changed: 0, added: 0, removed: 0, same: 0 };
  for (const r of rows) out[r.change]++;
  return out;
}

// ── Latest version per topic ─────────────────────────────────────────────────

/** The highest version per topic from a flat list of rows (any order). The
 *  list screens show its status as the topic's "article" chip: one grouped
 *  query for the page's topic ids, reduced here. */
export function latestArticles<T extends { topic_id: string; version: number }>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    const cur = out.get(r.topic_id);
    if (!cur || r.version > cur.version) out.set(r.topic_id, r);
  }
  return out;
}

/** Version rows for one topic, newest first. */
export function sortVersions<T extends { version: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.version - a.version);
}

/** Counts per status over a list of rows — the overview's queue numbers. */
export function articleCounts(rows: readonly { status: string }[]): Record<ArticleStatus, number> {
  const out: Record<ArticleStatus, number> = { draft: 0, in_review: 0, approved: 0, superseded: 0, rejected: 0 };
  for (const r of rows) if (isArticleStatus(r.status)) out[r.status]++;
  return out;
}
