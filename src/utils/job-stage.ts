// Multi-part generation stage (jobs.stage, 0053) — pure display logic.
//
// The worker generates part-major (script → render → upload per part) and
// writes {"phase": "analysis"|"video", "part": k, "total": n, "part_pct": p}
// at each checkpoint; it clears the stage when every part is done. Single-part
// jobs (and pre-0053 rows) have no stage — callers fall back to the overall
// percentage. jobs.progress stays the source of truth; stage is narration.

import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";

export type JobStage = {
  phase?: string;
  part?: number;
  total?: number;
  part_pct?: number;
} | null;

// These two lines land in EVERY progress chip on the Library — the busiest
// screen in the product — so they are words, not decoration, and they have to
// arrive in the reader's language. Both functions take the messages as their
// LAST argument: a client component already holds the library dictionary
// (t.utils.job) and passes it down. The type-only Dictionary import is erased
// at build time, so the server-only module never reaches the browser bundle.
export type JobMessages = Dictionary["utils"]["job"];

// The English default keeps a caller with no dictionary (the unit tests, a
// future non-UI consumer) honest rather than blank. Every REAL call site on the
// dashboard passes t.utils.job.
const EN: JobMessages = {
  readingPart: "reading part {n}/{total}",
  partProgress: "part {n}/{total} · {pct}%",
  percent: "{pct}%",
  minutesLeft: "~{n} min left",
};

/** "part 2/4 · 35%" · "reading part 1/4" · fallback "45%". */
export function jobStageLabel(progress: number, stage?: JobStage, t: JobMessages = EN): string {
  if (stage && typeof stage === "object" && (stage.total ?? 0) > 1 && (stage.part ?? 0) >= 1) {
    const n = stage.part!;
    const total = stage.total!;
    if (stage.phase === "analysis") return fmt(t.readingPart, { n, total });
    return fmt(t.partProgress, { n, total, pct: Math.max(0, Math.min(100, stage.part_pct ?? 0)) });
  }
  return fmt(t.percent, { pct: progress });
}

// A rough "~5 min left" for a job that's processing. We don't store a per-job
// start time, so this uses TYPICAL per-kind durations scaled by progress — a
// directional estimate, not a promise. Video lessons scale by their part count
// (the slow bit is the render); documents are quick. Returns "" when there's
// nothing useful to say (near-done, or not enough signal).
const KIND_MINUTES: Record<string, number> = {
  lesson_plan: 1.5,
  activity: 1.5,
  worksheet: 1.5,
  exam_paper: 1.5,
  case_study: 1.5,
  exam: 2.5,
  index_book: 2,
};
const MINUTES_PER_VIDEO_PART = 6;

export function etaLabel(
  kind: string | null | undefined,
  progress: number,
  stage?: JobStage,
  t: JobMessages = EN,
): string {
  const p = Math.max(0, Math.min(100, progress || 0));
  if (p >= 98) return "";
  const k = kind || "presentation";
  let total: number;
  if (k === "presentation") {
    const parts = stage && (stage.total ?? 0) > 1 ? stage.total! : 1;
    total = MINUTES_PER_VIDEO_PART * parts;
  } else {
    total = KIND_MINUTES[k] ?? 3;
  }
  const remaining = total * (1 - Math.max(p, 1) / 100);
  return fmt(t.minutesLeft, { n: Math.max(1, Math.ceil(remaining)) });
}
