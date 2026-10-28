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
