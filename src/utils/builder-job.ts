// Which of a generation's job rows is the one BUILDING it.
//
// A generation used to have exactly one job — the one the DB trigger queued
// when the row was inserted — so `jobs[0]` was the job. Two things broke that
// assumption without anyone updating the readers:
//
//   * The support agent files a `support_diagnose` job against a generation
//     it is investigating (auto, on a failure; manual, on a teacher's report).
//     That job REPORTS on the generation; it does not build it. Its progress
//     goes 1 → 100 in about forty seconds and its `stage` is null.
//   * The agent's transient retry, and the crash reaper, can queue a SECOND
//     builder job for the same generation. The old one is done or errored;
//     the new one is the live build.
//
// PostgREST returns an embedded `jobs(...)` array in no promised order, so
// `jobs[0]` could be the finished diagnosis (the ring reads 100% for a lesson
// that has not started) or the dead first attempt (the ring sticks at the
// progress where it died) while the real build is elsewhere in the array.
// Measured in review, 2026-09-03: a retried worksheet sat at "generating 0%"
// beside a done support job the Library was reading instead.
//
// So: ignore observer jobs, and of the builders take the newest. Pure and
// dependency-free so the rule is pinned by a test that needs no React and no
// database.

/** Job types that report on a generation without building it. Mirrors
 * OBSERVER_JOB_TYPES in the worker (worker/client.py). */
export const OBSERVER_JOB_TYPES: ReadonlySet<string> = new Set(["support_diagnose"]);

export type JobLike = {
  type?: string | null;
  created_at?: string | null;
};

/**
 * The newest job that BUILDS the generation, or null when there is none.
 *
 * Ordering is by `created_at` (ISO-8601 strings compare correctly as text);
 * a row without one sorts as oldest so an unknown never displaces a dated
 * build. Ties, and rows with no `type` at all, keep their array order — a row
 * with no type is treated as a builder, the same default the worker uses.
 */
export function builderJob<T extends JobLike>(jobs: readonly T[] | null | undefined): T | null {
  if (!jobs || jobs.length === 0) return null;
  let best: T | null = null;
  for (const job of jobs) {
    if (job.type && OBSERVER_JOB_TYPES.has(job.type)) continue;
    if (best === null || (job.created_at ?? "") > (best.created_at ?? "")) best = job;
  }
  return best;
}
