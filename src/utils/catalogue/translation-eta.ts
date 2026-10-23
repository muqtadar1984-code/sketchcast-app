// How long a translation has been going and roughly how long it has left
// (founder, 2026-10-18: "can we add a timer or time left for kits under
// translation?"). Pure: the server measures the past translations
// (translation-timing-server.ts), the client ticks the clock
// (app/library/translation-clock.tsx), this module decides.
//
// A translation's life, as the worker runs it:
//   queued     a kit_translate job waits for the lane — the worker takes ONE
//              translation at a time (0141/0142), so the wait is what is left
//              of the running one plus one typical run per job ahead;
//   translating the translate job is claimed: glossary, article, script, the
//              pre-check, then the kit row and its pieces' jobs;
//   building   the pieces render (video, deck, documents, bank, lesson plan);
//              the kit moves to in review when the last one is done.
// The estimate is the elapsed time against a TYPICAL run: the median of the
// recent translations that reached review, measured from the kit row to the
// last piece done — a median, because a retried piece (hours later) is one
// sample, not the rule. Measured 2026-10-18 on the Arabic runs: maths kits
// 11–15 min, science ~33 min, two retried runs at 111 and 417 min — so the
// typical figure is per subject once a subject has enough runs.

/** No history yet: the measured maths run, rounded up. */
export const DEFAULT_TRANSLATION_MINUTES = 15;
/** Fewer runs than this and the median is not trusted (the default or the
 *  all-subject figure stands in). */
export const MIN_SAMPLES = 3;
/** The newest runs that count. */
export const MAX_SAMPLES = 12;
/** A run longer than this was a retry or a stuck worker, not a translation. */
export const MAX_SAMPLE_MINUTES = 24 * 60;

export type TranslationSample = { subject: string | null; minutes: number };

export type TranslationTiming = {
  /** the typical run, every subject together */
  typicalMin: number;
  /** per subject (topics.subject, trimmed), only those with MIN_SAMPLES runs */
  bySubject: Record<string, number>;
  /** how many runs the all-subject figure stands on */
  samples: number;
};

export type LaneState = {
  /** when the running translation started (its translate job's claim, else
   *  its kit row), or null when the lane is idle */
  runningSince: string | null;
  /** the queued kit_translate jobs, oldest first */
  queued: { id: string; created_at: string }[];
};

export type ClockPhase = "queued" | "translating" | "building";

/** What a page hands its clocks: the typical runs, the lane, and the server's
 *  time when it read them (the clocks' first render, so hydration matches). */
export type TranslationClockData = { timing: TranslationTiming; lane: LaneState; nowMs: number };

/** The middle run of `values`; the mean of the two middle runs when even. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const subjectKey = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/** The typical run from the samples, newest first. Samples outside
 *  (0, MAX_SAMPLE_MINUTES] are dropped; at most MAX_SAMPLES count, overall
 *  and per subject. */
export function typicalTranslation(samplesNewestFirst: readonly TranslationSample[]): TranslationTiming {
  const ok = samplesNewestFirst.filter((s) => Number.isFinite(s.minutes) && s.minutes > 0 && s.minutes <= MAX_SAMPLE_MINUTES);
  const recent = ok.slice(0, MAX_SAMPLES);
  const all = recent.length >= MIN_SAMPLES ? median(recent.map((s) => s.minutes)) : null;
  const typicalMin = Math.max(1, Math.round(all ?? DEFAULT_TRANSLATION_MINUTES));
  const groups = new Map<string, number[]>();
  for (const s of ok) {
    const k = subjectKey(s.subject);
    if (!k) continue;
    const list = groups.get(k) ?? [];
    if (list.length < MAX_SAMPLES) list.push(s.minutes);
    groups.set(k, list);
  }
  const bySubject: Record<string, number> = {};
  for (const [k, list] of groups) if (list.length >= MIN_SAMPLES) bySubject[k] = Math.max(1, Math.round(median(list)!));
  return { typicalMin, bySubject, samples: recent.length };
}

/** The typical run for a topic's subject, else every subject together. */
export function typicalFor(timing: TranslationTiming, subject: string | null | undefined): number {
  return timing.bySubject[subjectKey(subject)] ?? timing.typicalMin;
}

const minutesBetween = (from: string | null | undefined, nowMs: number): number => {
  const t = from ? Date.parse(from) : NaN;
  return Number.isFinite(t) ? Math.max(0, (nowMs - t) / 60000) : 0;
};

/** The queued job's place: how many queued jobs are ahead of it (0 = next). */
export function queuePosition(lane: LaneState, jobId: string): number {
  const i = lane.queued.findIndex((q) => q.id === jobId);
  return i < 0 ? lane.queued.length : i;
}

export type Clock = {
  phase: ClockPhase;
  /** minutes since the phase's start: waiting since queued, running since claimed */
  elapsedMin: number;
  /** minutes until it is expected in review; null once past the typical run */
  leftMin: number | null;
  /** queued only: minutes until the lane reaches it */
  startsInMin: number | null;
  /** running longer than the typical run */
  overdue: boolean;
  typicalMin: number;
};

/**
 * The clock of one translation at `nowMs`.
 *  - queued: starts in (what is left of the running one) + ahead × typical;
 *    left = that + one typical run. The running one counts as finishing now
 *    once it is past its typical run (it is "any minute" by then).
 *  - translating / building: left = typical − elapsed since the run started,
 *    or null and overdue once that is spent.
 */
export function translationClock(args: { phase: ClockPhase; since: string | null; typicalMin: number; nowMs: number; ahead?: number; runningSince?: string | null }): Clock {
  const typical = Math.max(1, args.typicalMin);
  const elapsedMin = minutesBetween(args.since, args.nowMs);
  if (args.phase === "queued") {
    const running = args.runningSince ? Math.max(0, typical - minutesBetween(args.runningSince, args.nowMs)) : 0;
    const startsInMin = running + Math.max(0, args.ahead ?? 0) * typical;
    return { phase: "queued", elapsedMin, leftMin: startsInMin + typical, startsInMin, overdue: false, typicalMin: typical };
  }
  const left = typical - elapsedMin;
  return { phase: args.phase, elapsedMin, leftMin: left > 0 ? left : null, startsInMin: null, overdue: left <= 0, typicalMin: typical };
}

/** "<1 min", "12 min", "1 h 05 min" — whole minutes, rounded up for time
 *  left (never promise sooner than the estimate), down for elapsed. */
export function fmtMinutes(min: number, round: "up" | "down" = "down"): string {
  const m = Math.max(0, round === "up" ? Math.ceil(min) : Math.floor(min));
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

const PHASE_WORD: Record<ClockPhase, string> = { queued: "Queued", translating: "Translating", building: "Building" };

/** One short line for a row, a tiny one for a matrix cell, and the hover text. */
export function clockText(c: Clock): { short: string; tiny: string; long: string } {
  const basis = `A typical translation takes about ${fmtMinutes(c.typicalMin)} (the median of recent runs). The estimate assumes the worker's lane is running.`;
  if (c.phase === "queued") {
    const starts = c.startsInMin! < 1 ? "next" : `starts in ~${fmtMinutes(c.startsInMin!, "up")}`;
    return {
      short: `${starts} · ~${fmtMinutes(c.leftMin!, "up")} to review`,
      tiny: c.startsInMin! < 1 ? "next up" : `in ~${fmtMinutes(c.startsInMin!, "up")}`,
      long: `Queued for ${fmtMinutes(c.elapsedMin)} — the worker takes one translation at a time. ${starts === "next" ? "It is next" : `It ${starts}`}, and should reach review in about ${fmtMinutes(c.leftMin!, "up")}. ${basis}`,
    };
  }
  const what = c.phase === "translating" ? "translating the words" : "building the video and documents";
  if (c.overdue) {
    return {
      short: `${fmtMinutes(c.elapsedMin)} · longer than usual`,
      tiny: `${fmtMinutes(c.elapsedMin)} so far`,
      long: `${PHASE_WORD[c.phase]} for ${fmtMinutes(c.elapsedMin)} (${what}) — past the typical ${fmtMinutes(c.typicalMin)}. A retried piece or a busy image service stretches a run; the job line below says where it is. ${basis}`,
    };
  }
  return {
    short: `${fmtMinutes(c.elapsedMin)} · ~${fmtMinutes(c.leftMin!, "up")} left`,
    tiny: `~${fmtMinutes(c.leftMin!, "up")} left`,
    long: `${PHASE_WORD[c.phase]} for ${fmtMinutes(c.elapsedMin)} (${what}); about ${fmtMinutes(c.leftMin!, "up")} left before it reaches review. ${basis}`,
  };
}

// ── the progress bar (Totals → Translating, founder 2026-10-23: "a status
// bar for translating column (with percent complete and minutes left)") ──
//
// One bar per translation run, in two parts:
//   staging   the translate job is running — its own progress (the worker
//             reports 3 … 100 through glossary, article, scripts, checks)
//             fills the first STAGING_SHARE of the bar;
//   building  the job is done and the kit renders — no progress figure of its
//             own, so the share of the typical run already spent stands in,
//             never below STAGING_SHARE (staging is over) and never full.
// Minutes left are the clock's (translationClock above) — the same estimate
// the matrix cells show, not a second model. The typical run is measured from
// the kit row, which the worker writes when the job starts staging, so
// "elapsed / typical" in the building phase is the share of the WHOLE run.

/** The part of the bar the staging fills, in percent. */
export const STAGING_SHARE = 40;
/** A running translation never reads done: 100 % is "in review". */
export const MAX_RUNNING_PCT = 99;

export type ProgressInput = {
  phase: ClockPhase;
  since: string | null;
  typicalMin: number;
  nowMs: number;
  /** staging: the translate job's own progress, 0–100 (null = not reported yet) */
  jobProgress?: number | null;
};

export type TranslationProgress = {
  phase: "translating" | "building";
  /** 0 … MAX_RUNNING_PCT, whole */
  pct: number;
  /** the clock's minutes left; null once past the typical run */
  leftMin: number | null;
  /** past the typical run: "finishing…" instead of minutes */
  finishing: boolean;
  /** "62% · ~6 min left", "99% · finishing…" */
  text: string;
};

const clampPct = (v: number): number => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);

/** The bar of one running translation at `nowMs`; null for a queued one (it
 *  has not started — its wait is the clock's "in ~20 min"). */
export function translationProgress(a: ProgressInput): TranslationProgress | null {
  if (a.phase === "queued") return null;
  const clock = translationClock({ phase: a.phase, since: a.since, typicalMin: a.typicalMin, nowMs: a.nowMs });
  const raw =
    a.phase === "translating"
      ? (STAGING_SHARE * clampPct(a.jobProgress ?? 0)) / 100
      : Math.max(STAGING_SHARE, (100 * clock.elapsedMin) / clock.typicalMin);
  const pct = Math.round(Math.min(MAX_RUNNING_PCT, clampPct(raw)));
  const finishing = clock.overdue;
  const leftMin = finishing ? null : clock.leftMin;
  return { phase: a.phase, pct, leftMin, finishing, text: finishing ? `${pct}% · finishing…` : `${pct}% · ~${fmtMinutes(leftMin ?? 0, "up")} left` };
}

/** One language's runs: the one furthest along leads the bar (ties: the one
 *  with the least time left); `others` = the rest still running. Queued runs
 *  are not runs yet and are left out. Null when nothing is running. */
export function leadProgress(
  runs: readonly Omit<ProgressInput, "nowMs">[],
  nowMs: number,
): { lead: Omit<ProgressInput, "nowMs">; progress: TranslationProgress; others: number } | null {
  let best: { lead: Omit<ProgressInput, "nowMs">; progress: TranslationProgress } | null = null;
  let running = 0;
  for (const run of runs) {
    const p = translationProgress({ ...run, nowMs });
    if (!p) continue;
    running++;
    const left = (x: TranslationProgress) => x.leftMin ?? 0;
    if (!best || p.pct > best.progress.pct || (p.pct === best.progress.pct && left(p) < left(best.progress))) best = { lead: run, progress: p };
  }
  return best ? { ...best, others: running - 1 } : null;
}
