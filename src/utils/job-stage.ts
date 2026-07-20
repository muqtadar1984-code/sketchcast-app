// Multi-part generation stage (jobs.stage, 0053) — pure display logic.
//
// The worker generates part-major (script → render → upload per part) and
// writes {"phase": "analysis"|"video", "part": k, "total": n, "part_pct": p}
// at each checkpoint; it clears the stage when every part is done. Single-part
// jobs (and pre-0053 rows) have no stage — callers fall back to the overall
// percentage. jobs.progress stays the source of truth; stage is narration.

export type JobStage = {
  phase?: string;
  part?: number;
  total?: number;
  part_pct?: number;
} | null;

/** "part 2/4 · 35%" · "reading part 1/4" · fallback "45%". */
export function jobStageLabel(progress: number, stage?: JobStage): string {
  if (stage && typeof stage === "object" && (stage.total ?? 0) > 1 && (stage.part ?? 0) >= 1) {
    if (stage.phase === "analysis") return `reading part ${stage.part}/${stage.total}`;
    return `part ${stage.part}/${stage.total} · ${Math.max(0, Math.min(100, stage.part_pct ?? 0))}%`;
  }
  return `${progress}%`;
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

export function etaLabel(kind: string | null | undefined, progress: number, stage?: JobStage): string {
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
  return `~${Math.max(1, Math.ceil(remaining))} min left`;
}
