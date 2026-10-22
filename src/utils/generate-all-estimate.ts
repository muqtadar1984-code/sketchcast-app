// "About X h to finish" for the Generate all dialog (surge plan §3.2 item 2).
//
// The wait a teacher sees is queue depth ÷ throughput — on 2026-10-22 it was
// ~200 jobs ahead at a flat ~1.7 jobs/min, whatever the providers did. So the
// estimate is exactly that division, per kind, with throughput MEASURED over
// the last 7 days rather than a constant.
//
// Throughput is measured only while that kind had a BACKLOG. Averaged over the
// whole week the queue is idle most of the time and a kind "runs" at a few jobs
// an hour, which says nothing about how fast a queue of 250 drains. So the week
// is cut into 10-minute buckets, and a bucket counts for a kind only when some
// job of that kind sat queued through all of it; the jobs that finished in
// those buckets are the drain rate.
//
// Kinds drain side by side (the video lane is separate from the doc lanes), so
// the run is done when its SLOWEST kind is: the estimate is the max over kinds.
// It is a range — the mean drain rate gives the slow end, the 75th-percentile
// bucket the fast end — and the dialog labels it an estimate.

export const ESTIMATE_KINDS = [
  "presentation",
  "deck",
  "lesson_plan",
  "activity",
  "worksheet",
  "exam_paper",
  "case_study",
] as const;
export type EstimateKind = (typeof ESTIMATE_KINDS)[number];

export const BUCKET_MIN = 10;
export const WINDOW_DAYS = 7;
/** Fewer backlogged buckets than this and the measurement is noise: use the
 *  fallback rate instead. */
export const MIN_BUCKETS = 6;

/** Jobs/min per kind under backlog, measured on prod 2026-10-22 over 7 days
 *  (docs ~0.25, deck ~0.14, video ~0.06–0.1). Used only when a kind has too
 *  little backlog in the window to measure. */
export const FALLBACK_RATES: Record<EstimateKind, KindRate> = {
  presentation: { mean: 0.06, p75: 0.1, buckets: 0 },
  deck: { mean: 0.14, p75: 0.3, buckets: 0 },
  lesson_plan: { mean: 0.25, p75: 0.3, buckets: 0 },
  activity: { mean: 0.25, p75: 0.3, buckets: 0 },
  worksheet: { mean: 0.25, p75: 0.3, buckets: 0 },
  exam_paper: { mean: 0.25, p75: 0.3, buckets: 0 },
  case_study: { mean: 0.25, p75: 0.3, buckets: 0 },
};

/** Minutes one job of the kind takes once claimed (work p50, 2026-10-22) — the
 *  floor under any estimate: even an empty queue is not instant. */
const WORK_MIN: Record<EstimateKind, number> = {
  presentation: 13,
  deck: 6,
  lesson_plan: 6,
  activity: 5,
  worksheet: 4,
  exam_paper: 5,
  case_study: 5,
};

export type JobSample = {
  type: string;
  status: string;
  created_at: string;
  claimed_at: string | null;
  updated_at: string;
};

/** Drain rate in jobs/min: the mean over backlogged buckets and the 75th
 *  percentile bucket. */
export type KindRate = { mean: number; p75: number; buckets: number };

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Measured drain rate per kind over the window ending at `now`; a kind with
 *  fewer than MIN_BUCKETS backlogged buckets gets its fallback. */
export function backloggedRates(jobs: ReadonlyArray<JobSample>, now: Date): Record<EstimateKind, KindRate> {
  const B = BUCKET_MIN * 60_000;
  const end = now.getTime() - B; // the last whole bucket starts here
  const start = end - WINDOW_DAYS * 24 * 60 * 60_000;
  const n = Math.floor((end - start) / B) + 1;
  const out = {} as Record<EstimateKind, KindRate>;
  for (const kind of ESTIMATE_KINDS) {
    // Difference array: +1 over the buckets a job sat queued through.
    const backlog = new Int32Array(n + 1);
    const done = new Int32Array(n);
    for (const j of jobs) {
      if (j.type !== kind) continue;
      const created = Date.parse(j.created_at);
      // A job leaves the queue when claimed; one never claimed but finished
      // (or still queued) leaves at its last update.
      const left = Date.parse(j.claimed_at ?? j.updated_at);
      // Bucket i spans [start + i·B, start + (i+1)·B): queued THROUGH it means
      // created before it opens and still unclaimed when it closes.
      const iMin = Math.max(0, Math.floor((created - start) / B) + 1);
      const iMax = Math.min(n - 1, Math.ceil((left - start) / B) - 2);
      if (iMax >= iMin) {
        backlog[iMin]++;
        backlog[iMax + 1]--;
      }
      if (j.status === "done") {
        const f = Math.floor((Date.parse(j.updated_at) - start) / B);
        if (f >= 0 && f < n) done[f]++;
      }
    }
    const perMin: number[] = [];
    let run = 0;
    for (let i = 0; i < n; i++) {
      run += backlog[i];
      if (run > 0) perMin.push(done[i] / BUCKET_MIN);
    }
    if (perMin.length < MIN_BUCKETS) {
      out[kind] = FALLBACK_RATES[kind];
      continue;
    }
    perMin.sort((a, b) => a - b);
    const mean = perMin.reduce((s, x) => s + x, 0) / perMin.length;
    // A kind that drained nothing while backlogged (all its jobs failed or are
    // still running) would divide by zero: keep the fallback's floor.
    out[kind] = {
      mean: Math.max(mean, FALLBACK_RATES[kind].mean / 4),
      p75: Math.max(percentile(perMin, 0.75), mean, FALLBACK_RATES[kind].mean / 4),
      buckets: perMin.length,
    };
  }
  return out;
}

/** Finish-time range in minutes for a run that adds `mine` jobs per kind behind
 *  `ahead` already queued. Null when the run queues nothing. */
export function etaRange(
  ahead: Partial<Record<EstimateKind, number>>,
  mine: Partial<Record<EstimateKind, number>>,
  rates: Record<EstimateKind, KindRate>,
): { lowMin: number; highMin: number } | null {
  let low = 0;
  let high = 0;
  for (const kind of ESTIMATE_KINDS) {
    const m = mine[kind] ?? 0;
    if (m <= 0) continue;
    const total = (ahead[kind] ?? 0) + m;
    const r = rates[kind];
    low = Math.max(low, total / r.p75, WORK_MIN[kind]);
    high = Math.max(high, total / r.mean, WORK_MIN[kind]);
  }
  if (high === 0) return null;
  return { lowMin: Math.round(low), highMin: Math.round(Math.max(high, low)) };
}

/** The range in display units: whole minutes under 90, else hours rounded to
 *  the half (low down, high up). The two ends never print equal. */
export function etaDisplay(r: { lowMin: number; highMin: number }): { unit: "min" | "h"; low: number; high: number } {
  if (r.highMin < 90) {
    const low = Math.max(1, Math.floor(r.lowMin / 5) * 5 || r.lowMin);
    const high = Math.max(low + 5, Math.ceil(r.highMin / 5) * 5);
    return { unit: "min", low, high };
  }
  const low = Math.max(0.5, Math.floor((r.lowMin / 60) * 2) / 2);
  const high = Math.max(low + 0.5, Math.ceil((r.highMin / 60) * 2) / 2);
  return { unit: "h", low, high };
}

/** Soft daily ceiling for unmetered accounts (founder decision D4: warn, never
 *  block). */
export const DAILY_SOFT_LIMIT = 100;
