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
