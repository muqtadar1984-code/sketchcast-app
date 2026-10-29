import type { BookAction } from "@/utils/books-routing";

// The stages a member can run from the app (R1). The SAME keys as the
// runner's registry (worker publishing/runner/stages.py) — the runner refuses
// anything else; S2 moves both onto one table. Pure: shared by the Run form
// (client) and the run routes (server).

export type StageParam = { key: string; label: string; min: number; max: number; default: number };

export type RunnableStage = {
  key: string;
  title: string;
  summary: string;
  /** what pressing Run needs: run_report = reads the book only (reviewer and up); run = changes unapproved text */
  action: BookAction;
  params: StageParam[];
  /** the estimate before any app run of this stage exists: measured on past runs, per chapter (0 = free) */
  measuredPerChapterUsd: number;
  measuredFrom: string;
};

const CHAPTERS: StageParam[] = [
  { key: "first", label: "From chapter", min: 1, max: 99, default: 1 },
  { key: "last", label: "To chapter", min: 1, max: 99, default: 10 },
];

export const RUNNABLE_STAGES: RunnableStage[] = [
  {
    key: "check_files",
    title: "Check the book's files",
    summary:
      "Pulls the book's source files from storage, checks every one against its recorded hash, and confirms each Gate-D-approved chapter still matches its approval. No model calls.",
    action: "run_report",
    params: [],
    measuredPerChapterUsd: 0,
    measuredFrom: "free — no model calls",
  },
  {
    key: "coverage",
    title: "Coverage re-check",
    summary:
      "Both validators (Gemini 3.5 Flash and Claude Opus 5.5) map every section and question to the curriculum objectives again, and the run produces a fresh coverage table. Reads the book; changes nothing in it.",
    action: "run_report",
    params: CHAPTERS,
    measuredPerChapterUsd: 0.33,
    measuredFrom: "the Biology coverage runs of Revisions 3, 4 and 4.1 ($3.23–3.30 for 10 chapters)",
  },
  {
    key: "academic_audit",
    title: "Academic audit",
    summary:
      "Both validators (Gemini 3.5 Flash and Claude Opus 5.5, never the author model) review each chapter for accuracy, level, curriculum fit and repetition, and record P0/P1/P2 findings. Reads the book; changes nothing in it.",
    action: "run_report",
    params: CHAPTERS,
    measuredPerChapterUsd: 0.58,
    measuredFrom: "the Biology audits of Revisions 2 and 4 ($5.70–5.88 for 10 chapters)",
  },
  {
    key: "readiness",
    title: "Readiness re-check",
    summary:
      "Takes a fresh snapshot of the catalogue and re-audits the book: how ready it is to draft, and which topics still need an article, a kit, a publication or a fix. Free; records the audit in the shared publishing database.",
    action: "run_report",
    params: [],
    measuredPerChapterUsd: 0,
    measuredFrom: "free — no model calls",
  },
  {
    key: "gate_r",
    title: "Gate R (pin the sources)",
    summary:
      "Takes a fresh catalogue snapshot and runs Gate R. Only when every topic the book needs is ready does it pin the exact article, kit and video versions the chapters will be written from, open the English edition and set the book to drafting; a book that is not 100% ready changes nothing and lists its gaps. Free.",
    action: "run",
    params: [],
    measuredPerChapterUsd: 0,
    measuredFrom: "free — no model calls",
  },
  {
    key: "draft_trial",
    title: "Draft one chapter (trial)",
    summary:
      "Writes one chapter on the server at its 6–8 page target, checks and reviews it, and lays it out — exactly as drafting does on the PC — but into this run's folder only: the book's own chapters are not changed and nothing is recorded in the shared publishing database. No new pictures (the chapter uses the catalogue's figures and the book's existing art). Needs Gate R; a book without it stops before any model call, at $0.",
    action: "run",
    params: [{ key: "chapter", label: "Chapter", min: 1, max: 99, default: 1 }],
    measuredPerChapterUsd: 3,
    measuredFrom: "the book cost plan's one-pass target ($25–30 for 10 chapters); this run measures it",
  },
  {
    key: "render_proof",
    title: "Font proof",
    summary:
      "Renders one chapter on the server three times: as designed, in Source Serif 4 and in Literata, so you can pick the open heading font that replaces Sitka (Windows-only) for new books. Reads the book; changes nothing. No model calls.",
    action: "run_report",
    params: [{ key: "chapter", label: "Chapter", min: 1, max: 99, default: 1 }],
    measuredPerChapterUsd: 0,
    measuredFrom: "free — no model calls",
  },
];

// ── the whole pipeline ──────────────────────────────────────────────────────
// Every stage of making a book, in order, and whether the app can run it yet.
// `run` names the RUNNABLE_STAGES that carry it out; `book` names the book's
// own stage keys (pub_stages, from the importer) that recorded it before the app.

export type PipelineStage = {
  key: string;
  layer: "plan" | "produce" | "polish";
  title: string;
  does: string;
  run: string[];
  /** not runnable from the app yet: which release brings it */
  comes?: "S3" | "S4" | "R2" | "R3";
  book: string[];
};

export const PIPELINE: PipelineStage[] = [
  { key: "scope", layer: "plan", title: "Scope and blueprint", does: "Curricula, objectives, chapters and the 13 blueprint checks; Gate B.", run: [], comes: "R2", book: ["scope"] },
  { key: "articles", layer: "plan", title: "Catalogue articles and readiness", does: "The articles the chapters are built from; a book drafts only once every topic it needs is ready (then Gate R pins the sources). Readiness re-checks and Gate R run from the app now (the Gaps tab lists what is outstanding); ordering articles comes with planning.", run: ["readiness", "gate_r"], comes: "R2", book: [] },
  { key: "drafting", layer: "produce", title: "Draft, pictures, render, Gate D packet", does: "Each chapter written at its page target with its pictures, laid out, and packed for review. A trial chapter draft and rendering run on the server now; drafting into the book itself follows.", run: ["draft_trial", "render_proof"], comes: "S3", book: ["drafting", "expansion", "theme_gate_d"] },
  { key: "uniqueness", layer: "produce", title: "Uniqueness", does: "No question, Think box or picture repeats an earlier chapter.", run: [], comes: "S3", book: ["uniqueness"] },
  { key: "gate_d", layer: "produce", title: "Gate D approval", does: "A person approves each chapter; the approval is the text's hash.", run: [], comes: "S4", book: [] },
  { key: "audit", layer: "produce", title: "Academic audit", does: "Two independent validators review every chapter.", run: ["academic_audit"], book: ["revision_2", "revision_4"] },
  { key: "corrections", layer: "produce", title: "Adjudicate, correct, verify", does: "Findings ruled on, corrections applied unit by unit and verified; approved chapters change only by controlled revision.", run: [], comes: "S4", book: ["revision_2", "revision_4"] },
  { key: "coverage", layer: "produce", title: "Coverage", does: "Every objective: taught and assessed, taught only, assessed only, or not covered.", run: ["coverage"], book: ["revision_3", "revision_4_1"] },
  { key: "checks", layer: "produce", title: "Book checks", does: "The source files are whole and every approval still matches its text.", run: ["check_files"], book: [] },
  { key: "compile", layer: "produce", title: "Compile the book", does: "Front matter, chapters, coverage, glossary, index and credits into one book; Gate E.", run: [], comes: "S4", book: ["first_draft", "revision_4_1"] },
  { key: "kdp", layer: "produce", title: "KDP paperback", does: "Print interior, cover and the listing sheet.", run: [], comes: "S4", book: ["kdp"] },
  { key: "sk_export", layer: "produce", title: "SK export", does: "The approved chapters exported for the SK tutor.", run: [], comes: "S4", book: ["sk_export"] },
  { key: "editor", layer: "polish", title: "Editor", does: "Edit the compiled book by hand, with AI help; re-approval.", run: [], comes: "R3", book: [] },
];

export function runnableStage(key: string): RunnableStage | null {
  return RUNNABLE_STAGES.find((s) => s.key === key) ?? null;
}

/** The parameters with defaults filled, or an error message. Unknown keys are refused, as the runner does. */
export function checkParams(stage: RunnableStage, raw: Record<string, unknown>): { params: Record<string, number> } | { error: string } {
  const extra = Object.keys(raw).filter((k) => !stage.params.some((p) => p.key === k));
  if (extra.length) return { error: `Unknown parameters: ${extra.join(", ")}` };
  const params: Record<string, number> = {};
  for (const p of stage.params) {
    const v = raw[p.key] === undefined || raw[p.key] === "" ? p.default : Number(raw[p.key]);
    if (!Number.isInteger(v) || v < p.min || v > p.max) return { error: `${p.label} must be a whole number from ${p.min} to ${p.max}.` };
    params[p.key] = v;
  }
  if ("first" in params && params.first > params.last) return { error: "From chapter must not be after To chapter." };
  return { params };
}

/** Chapters a run covers (empty for a whole-book stage that takes no range). */
export function runChapters(params: Record<string, number>): number[] {
  if (!("first" in params)) return [];
  return Array.from({ length: params.last - params.first + 1 }, (_, i) => params.first + i);
}
