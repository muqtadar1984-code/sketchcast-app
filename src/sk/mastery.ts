// SK B5 — the mastery rule, version 1 (`sk-b5.1`). Pure and deterministic:
// the same attempts always give the same state, so `mastery_state` can be
// recomputed from `item_attempts` at any time (contracts §5.6: "recomputed
// from item_attempts by rule_version, never edited directly").
//
// The rule (plan §3 "skip what I know", §10 "grading rules", §14 "wrong
// mastery figures"):
//
//   * Only attempts on an item that is MAPPED to a teaching objective count
//     (`teachingObjectiveId` set). Unmapped items give NO evidence at all —
//     not even "in progress".
//   * Only DETERMINISTIC grades count towards mastery. A check that contains
//     an LLM- or teacher-graded attempt is excluded whole (plan §10: "unit and
//     chapter checks use deterministic items or teacher review"; LLM partial
//     credit is practice evidence only).
//   * A CHECK (skip / prereq / unit) is a run of `size` items opened together.
//     It is `open` until every item is finished (answered correctly, or wrong
//     at the last allowed attempt), `passed` when the correct items reach the
//     pass mark (default: every item — the 2-item checks need 2 of 2), else
//     `failed`.
//   * The objective is `mastered` after a passed check, `needs_work` after a
//     failed one (the LATEST completed check decides, so a later fail undoes
//     an earlier pass and vice versa), `in_progress` while a check is open or
//     only practice has happened and nothing has been decided yet.
//   * `independent` is true ONLY when a passed check's every counted attempt
//     was independent (attempt 1, no hint). One hint anywhere in the run makes
//     the pass ASSISTED: the status is then `provisional`, not `mastered`
//     (founder, 2026-10-27) — it unlocks the next unit but keeps the
//     prerequisite warning, and dashboards show the two apart (plan §10).
//   * PRACTISE runs and attempts outside any check never change the status
//     beyond `in_progress`; they are recorded in `evidence.practice`.
//   * `evidence.attempt_ids` lists every attempt the status rests on, so a
//     mastery value traces to its items (POC scorecard "mastery traceability").

import { MAX_ATTEMPTS } from "./grade";
import type { GradeOutcome, MasteryState, MasteryStatus } from "./types";

export const MASTERY_RULE_VERSION = "sk-b5.1";

export type CheckPurpose = "skip" | "prereq" | "unit" | "practise";
export type Grader = "deterministic" | "llm" | "teacher";

/** One graded attempt as the rule sees it (an `item_attempts` row). */
export type AttemptRecord = {
  /** The attempt's event id — what the evidence lists. */
  id: string;
  itemId: string;
  teachingObjectiveId: string | null;
  attemptNo: number;
  outcome: GradeOutcome;
  independent: boolean;
  hintsUsed: number;
  grader: Grader;
  /** The check this attempt belongs to; null = outside any check. */
  checkKey: string | null;
  purpose: CheckPurpose | null;
  checkSize: number | null;
  /** ms since the epoch; the fold is in time order. */
  at: number;
};

export type CheckRun = { checkKey: string; purpose: CheckPurpose; size: number; passMark: number; attempts: AttemptRecord[] };

export type RunStatus = "open" | "passed" | "failed" | "practice" | "excluded";

export type RunAssessment = {
  checkKey: string;
  purpose: CheckPurpose;
  size: number;
  passMark: number;
  status: RunStatus;
  correctItems: number;
  finishedItems: number;
  /** Every counted attempt was attempt 1 with no hint (only meaningful when passed). */
  independent: boolean;
  attemptIds: string[];
  reason?: string;
};

export type MasteryEvidence = {
  /** Items answered correctly / items asked, over the counted checks. */
  correct: number;
  total: number;
  /** Every attempt the status rests on (the counted checks), in time order. */
  attempt_ids: string[];
  runs: Array<Pick<RunAssessment, "checkKey" | "purpose" | "status" | "correctItems" | "size" | "independent"> & { reason?: string }>;
  /** Practice evidence: never mastery (plan §10). Includes LLM-graded practice. */
  practice: { correct: number; total: number; attempt_ids: string[] };
};

export type MasteryStateV1 = MasteryState & { evidence: MasteryEvidence; rule_version: typeof MASTERY_RULE_VERSION };

export type MasteryOptions = {
  /** The pass mark for a check of `size` items with this purpose; default = every item. */
  passMarkFor?: (purpose: CheckPurpose, size: number) => number;
  /** Plan §14: only a VALIDATED item → objective map counts. Default: every
   * mapped objective counts (the item bank only serves mapped items; the
   * validated gate is applied here when the caller knows the objective's status). */
  countsAsEvidence?: (teachingObjectiveId: string) => boolean;
};

const byTime = (a: AttemptRecord, b: AttemptRecord) => a.at - b.at || a.attemptNo - b.attemptNo || a.id.localeCompare(b.id);

/** Group the attempts of one objective into check runs (by `checkKey`, in the
 * order the checks started). Attempts outside any check are returned loose. */
export function groupRuns(attempts: readonly AttemptRecord[], opts: MasteryOptions = {}): { runs: CheckRun[]; loose: AttemptRecord[] } {
  const sorted = [...attempts].sort(byTime);
  const runs = new Map<string, CheckRun>();
  const loose: AttemptRecord[] = [];
  for (const a of sorted) {
    if (!a.checkKey || !a.purpose) {
      loose.push(a);
      continue;
    }
    let run = runs.get(a.checkKey);
    if (!run) {
      run = { checkKey: a.checkKey, purpose: a.purpose, size: 0, passMark: 0, attempts: [] };
      runs.set(a.checkKey, run);
    }
    run.attempts.push(a);
  }
  const out = [...runs.values()];
  for (const run of out) {
    const declared = Math.max(0, ...run.attempts.map((a) => a.checkSize ?? 0));
    const seen = new Set(run.attempts.map((a) => a.itemId)).size;
    run.size = Math.max(declared, seen, 1);
    const mark = opts.passMarkFor?.(run.purpose, run.size) ?? run.size;
    run.passMark = Math.min(run.size, Math.max(1, Math.floor(mark)));
  }
  return { runs: out, loose };
}

/** An item is finished when it was answered correctly or the last allowed
 * attempt was wrong (the loop stops offering hints at MAX_ATTEMPTS). */
function itemOutcome(attempts: AttemptRecord[]): { correct: boolean; finished: boolean } {
  const ordered = [...attempts].sort((a, b) => a.attemptNo - b.attemptNo);
  const correct = ordered.some((a) => a.outcome === "correct");
  const last = ordered[ordered.length - 1]!;
  return { correct, finished: correct || last.attemptNo >= MAX_ATTEMPTS };
}

export function assessRun(run: CheckRun): RunAssessment {
  const attemptIds = run.attempts.map((a) => a.id);
  const base = { checkKey: run.checkKey, purpose: run.purpose, size: run.size, passMark: run.passMark, attemptIds };
  const nonDeterministic = run.attempts.find((a) => a.grader !== "deterministic");
  const items = new Map<string, AttemptRecord[]>();
  for (const a of run.attempts) items.set(a.itemId, [...(items.get(a.itemId) ?? []), a]);
  let correctItems = 0;
  let finishedItems = 0;
  for (const list of items.values()) {
    const o = itemOutcome(list);
    if (o.correct) correctItems++;
    if (o.finished) finishedItems++;
  }
  if (nonDeterministic) {
    return { ...base, status: "excluded", correctItems: 0, finishedItems, independent: false, reason: `${nonDeterministic.grader}-graded attempt ${nonDeterministic.id} in a check: no mastery evidence` };
  }
  if (run.purpose === "practise") return { ...base, status: "practice", correctItems, finishedItems, independent: false };
  if (finishedItems < run.size) return { ...base, status: "open", correctItems, finishedItems, independent: false };
  const passed = correctItems >= run.passMark;
  return { ...base, status: passed ? "passed" : "failed", correctItems, finishedItems, independent: passed && run.attempts.every((a) => a.independent) };
}

/** The mastery state of ONE objective from its attempts, or null when there is
 * no evidence at all (unmapped items, or an objective that may not count). */
export function masteryFromAttempts(teachingObjectiveId: string, attempts: readonly AttemptRecord[], opts: MasteryOptions = {}): MasteryStateV1 | null {
  const mine = attempts.filter((a) => a.teachingObjectiveId === teachingObjectiveId);
  if (mine.length === 0) return null;
  if (opts.countsAsEvidence && !opts.countsAsEvidence(teachingObjectiveId)) return null;

  const { runs, loose } = groupRuns(mine, opts);
  const assessed = runs.map(assessRun);

  const evidence: MasteryEvidence = { correct: 0, total: 0, attempt_ids: [], runs: [], practice: { correct: 0, total: 0, attempt_ids: [] } };
  let decided: RunAssessment | null = null;
  let open = false;
  for (const r of assessed) {
    evidence.runs.push({ checkKey: r.checkKey, purpose: r.purpose, status: r.status, correctItems: r.correctItems, size: r.size, independent: r.independent, ...(r.reason ? { reason: r.reason } : {}) });
    if (r.status === "practice") {
      evidence.practice.correct += r.correctItems;
      evidence.practice.total += r.size;
      evidence.practice.attempt_ids.push(...r.attemptIds);
    } else if (r.status === "excluded") {
      // listed in runs, counted nowhere
    } else {
      evidence.correct += r.correctItems;
      evidence.total += r.status === "open" ? r.finishedItems : r.size;
      evidence.attempt_ids.push(...r.attemptIds);
      if (r.status === "open") open = true;
      else decided = r;
    }
  }
  // Loose attempts (outside any check): practice evidence only.
  if (loose.length) {
    const items = new Map<string, AttemptRecord[]>();
    for (const a of loose) items.set(a.itemId, [...(items.get(a.itemId) ?? []), a]);
    for (const list of items.values()) if (itemOutcome(list).correct) evidence.practice.correct++;
    evidence.practice.total += items.size;
    evidence.practice.attempt_ids.push(...loose.map((a) => a.id));
  }

  let status: MasteryStatus;
  let independent = false;
  if (decided) {
    // An assisted pass (a hint, or a later attempt) is PROVISIONAL (founder,
    // 2026-10-27): it unlocks what follows but is shown apart from mastery.
    independent = decided.status === "passed" && decided.independent;
    status = decided.status === "passed" ? (independent ? "mastered" : "provisional") : "needs_work";
  } else if (open || evidence.practice.attempt_ids.length > 0) {
    status = "in_progress";
  } else {
    status = "unknown";
  }
  return { status, independent, evidence, rule_version: MASTERY_RULE_VERSION };
}

/** Every objective touched by these attempts → its state (null entries omitted). */
export function masteryMapFromAttempts(attempts: readonly AttemptRecord[], opts: MasteryOptions = {}): Record<string, MasteryStateV1> {
  const out: Record<string, MasteryStateV1> = {};
  for (const id of new Set(attempts.map((a) => a.teachingObjectiveId).filter((v): v is string => !!v))) {
    const s = masteryFromAttempts(id, attempts, opts);
    if (s) out[id] = s;
  }
  return out;
}
