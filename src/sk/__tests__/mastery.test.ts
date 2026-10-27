// SK B5 — mastery rule v1 (sk-b5.1) over 20 scripted runs (plan §15, B5 row:
// "independent/assisted correct in 20 scripted runs"). Table-driven: each run
// is a script of attempts; the rule must give the stated status, independent
// flag and evidence. Deterministic — no clock, no randomness.
import { describe, expect, it } from "vitest";
import { MASTERY_RULE_VERSION, assessRun, groupRuns, masteryFromAttempts, masteryMapFromAttempts, type AttemptRecord, type CheckPurpose, type Grader, type MasteryStateV1 } from "../mastery";
import type { GradeOutcome } from "../types";

const OBJ = "obj-u5";
const OTHER = "obj-u2";

/** [itemId, attemptNo, outcome, hintsUsed?, grader?] */
type Step = [string, number, GradeOutcome, number?, Grader?];

let clock = 0;
function run(key: string, purpose: CheckPurpose, size: number, steps: Step[], objective: string | null = OBJ): AttemptRecord[] {
  return steps.map(([itemId, attemptNo, outcome, hintsUsed = 0, grader = "deterministic"], i) => ({
    id: `${key}-${i + 1}`,
    itemId,
    teachingObjectiveId: objective,
    attemptNo,
    outcome,
    hintsUsed,
    grader,
    independent: outcome === "correct" && attemptNo === 1 && hintsUsed === 0 && grader === "deterministic",
    checkKey: key,
    purpose,
    checkSize: size,
    at: ++clock,
  }));
}
/** Attempts outside any check (practice from the lesson, no check opened). */
function loose(steps: Step[], objective: string | null = OBJ): AttemptRecord[] {
  return run("loose", "practise", steps.length, steps, objective).map((a) => ({ ...a, checkKey: null, purpose: null, checkSize: null }));
}

type Expected = { status: MasteryStateV1["status"]; independent: boolean; correct?: number; total?: number; attempts?: number; practice?: number; runs?: string[] } | null;

const SCRIPTS: { name: string; attempts: AttemptRecord[]; expect: Expected; opts?: Parameters<typeof masteryFromAttempts>[2] }[] = [
  { name: "1 independent pass: 2 of 2 at attempt 1, no hints", attempts: run("c1", "unit", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]]), expect: { status: "mastered", independent: true, correct: 2, total: 2, attempts: 2 } },
  { name: "2 assisted pass ≠ independent pass: a hint on item 1, then both right", attempts: run("c2", "unit", 2, [["i1", 1, "incorrect"], ["i1", 2, "correct", 1], ["i2", 1, "correct"]]), expect: { status: "provisional", independent: false, correct: 2, total: 2, attempts: 3 } },
  { name: "3 a second attempt is never independent even without a recorded hint", attempts: run("c3", "skip", 2, [["i1", 1, "incorrect"], ["i1", 2, "correct"], ["i2", 1, "correct"]]), expect: { status: "provisional", independent: false, correct: 2, total: 2, attempts: 3 } },
  { name: "4 failed check: item 1 wrong three times, item 2 right → needs work", attempts: run("c4", "unit", 2, [["i1", 1, "incorrect"], ["i1", 2, "incorrect", 1], ["i1", 3, "incorrect", 2], ["i2", 1, "correct"]]), expect: { status: "needs_work", independent: false, correct: 1, total: 2, attempts: 4 } },
  { name: "5 open check: only the first item answered → in progress", attempts: run("c5", "unit", 2, [["i1", 1, "correct"]]), expect: { status: "in_progress", independent: false, correct: 1, total: 1, attempts: 1 } },
  { name: "6 open check: first item wrong once, a hint still possible → in progress", attempts: run("c6", "unit", 2, [["i1", 1, "incorrect"]]), expect: { status: "in_progress", independent: false, correct: 0, total: 0, attempts: 1 } },
  { name: "7 unmapped items (no teaching_objective_id) give NO evidence", attempts: run("c7", "unit", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]], null), expect: null },
  { name: "8 an LLM-graded short answer in a check never counts (the check is excluded whole)", attempts: run("c8", "unit", 2, [["i1", 1, "correct", 0, "llm"], ["i2", 1, "correct"]]), expect: { status: "unknown", independent: false, correct: 0, total: 0, attempts: 0, runs: ["excluded"] } },
  { name: "9 a teacher-reviewed item in a check is excluded the same way", attempts: run("c9", "skip", 2, [["i1", 1, "needs_review", 0, "teacher"], ["i2", 1, "correct"]]), expect: { status: "unknown", independent: false, attempts: 0, runs: ["excluded"] } },
  { name: "10 practice only: right answers are practice evidence, never mastery", attempts: run("p10", "practise", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]]), expect: { status: "in_progress", independent: false, correct: 0, total: 0, attempts: 0, practice: 2 } },
  { name: "11 attempts outside any check are practice evidence only", attempts: loose([["i1", 1, "correct"], ["i2", 1, "incorrect"]]), expect: { status: "in_progress", independent: false, correct: 0, total: 0, attempts: 0, practice: 1 } },
  { name: "12 pass, then a later failed check → needs work (the latest completed check decides)", attempts: [...run("c12a", "unit", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]]), ...run("c12b", "unit", 2, [["i1", 1, "incorrect"], ["i1", 2, "incorrect", 1], ["i1", 3, "incorrect", 2], ["i2", 1, "incorrect"], ["i2", 2, "incorrect", 1], ["i2", 3, "incorrect", 2]])], expect: { status: "needs_work", independent: false, correct: 2, total: 4, attempts: 8, runs: ["passed", "failed"] } },
  { name: "13 fail, then a later independent pass → mastered, independent", attempts: [...run("c13a", "skip", 2, [["i1", 1, "incorrect"], ["i1", 2, "incorrect", 1], ["i1", 3, "incorrect", 2], ["i2", 1, "correct"]]), ...run("c13b", "unit", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]])], expect: { status: "mastered", independent: true, correct: 3, total: 4, attempts: 6, runs: ["failed", "passed"] } },
  { name: "14 a pass stands while a later check is still open (nothing decided yet by it)", attempts: [...run("c14a", "unit", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]]), ...run("c14b", "unit", 2, [["i1", 1, "incorrect"]])], expect: { status: "mastered", independent: true, correct: 2, total: 2, attempts: 3, runs: ["passed", "open"] } },
  { name: "15 unit check with a pass mark: 2 of 3 passes, but the failed item makes it assisted", attempts: run("c15", "unit", 3, [["i1", 1, "correct"], ["i2", 1, "incorrect"], ["i2", 2, "incorrect", 1], ["i2", 3, "incorrect", 2], ["i3", 1, "correct"]]), expect: { status: "provisional", independent: false, correct: 2, total: 3, attempts: 5 }, opts: { passMarkFor: (p, n) => (p === "unit" ? Math.ceil((2 * n) / 3) : n) } },
  { name: "16 unit check with a pass mark: 1 of 3 fails", attempts: run("c16", "unit", 3, [["i1", 1, "correct"], ["i2", 1, "incorrect"], ["i2", 2, "incorrect", 1], ["i2", 3, "incorrect", 2], ["i3", 1, "incorrect"], ["i3", 2, "incorrect", 1], ["i3", 3, "incorrect", 2]]), expect: { status: "needs_work", independent: false, correct: 1, total: 3, attempts: 7 }, opts: { passMarkFor: (p, n) => (p === "unit" ? Math.ceil((2 * n) / 3) : n) } },
  { name: "17 the order the rows arrive in does not matter (sorted by time)", attempts: [...run("c17", "unit", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]])].reverse(), expect: { status: "mastered", independent: true, correct: 2, total: 2, attempts: 2 } },
  { name: "18 an objective the caller says may not count (plan §14: unvalidated map) gives no evidence", attempts: run("c18", "unit", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]]), expect: null, opts: { countsAsEvidence: () => false } },
  { name: "19 another objective's attempts are not this objective's evidence", attempts: [...run("c19a", "unit", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]], OTHER), ...run("c19b", "unit", 2, [["i3", 1, "correct"]])], expect: { status: "in_progress", independent: false, correct: 1, total: 1, attempts: 1 } },
  { name: "20 practice after a pass keeps the pass and grows the practice evidence", attempts: [...run("c20a", "unit", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]]), ...run("p20", "practise", 3, [["i1", 1, "correct"], ["i3", 1, "incorrect"], ["i3", 2, "correct", 1]])], expect: { status: "mastered", independent: true, correct: 2, total: 2, attempts: 2, practice: 2, runs: ["passed", "practice"] } },
  { name: "21 a partial mark at the last attempt finishes the item as not correct", attempts: run("c21", "unit", 2, [["i1", 1, "partial"], ["i1", 2, "partial", 1], ["i1", 3, "partial", 2], ["i2", 1, "correct"]]), expect: { status: "needs_work", independent: false, correct: 1, total: 2, attempts: 4 } },
];

describe("mastery rule sk-b5.1 — 20 scripted runs", () => {
  for (const s of SCRIPTS) {
    it(s.name, () => {
      const got = masteryFromAttempts(OBJ, s.attempts, s.opts);
      if (s.expect === null) {
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      const g = got!;
      expect(g.rule_version).toBe(MASTERY_RULE_VERSION);
      expect(g.status).toBe(s.expect.status);
      expect(g.independent).toBe(s.expect.independent);
      if (s.expect.correct !== undefined) expect(g.evidence.correct).toBe(s.expect.correct);
      if (s.expect.total !== undefined) expect(g.evidence.total).toBe(s.expect.total);
      if (s.expect.attempts !== undefined) expect(g.evidence.attempt_ids).toHaveLength(s.expect.attempts);
      if (s.expect.practice !== undefined) expect(g.evidence.practice.correct).toBe(s.expect.practice);
      if (s.expect.runs) expect(g.evidence.runs.map((r) => r.status)).toEqual(s.expect.runs);
      // Invariants: independent only on mastered; every listed attempt id is one of the inputs; excluded runs contribute no ids.
      if (g.independent) expect(g.status).toBe("mastered");
      if (g.status === "provisional") expect(g.independent).toBe(false);
      const ids = new Set(s.attempts.map((a) => a.id));
      for (const id of [...g.evidence.attempt_ids, ...g.evidence.practice.attempt_ids]) expect(ids.has(id)).toBe(true);
      for (const r of g.evidence.runs) if (r.status === "excluded") expect(g.evidence.attempt_ids.some((id) => id.startsWith(r.checkKey + "-"))).toBe(false);
    });
  }
  it("MASTERY_RULE_VERSION is sk-b5.1 and the same script always gives the same answer", () => {
    expect(MASTERY_RULE_VERSION).toBe("sk-b5.1");
    const a = masteryFromAttempts(OBJ, SCRIPTS[1]!.attempts);
    const b = masteryFromAttempts(OBJ, SCRIPTS[1]!.attempts.map((x) => ({ ...x })));
    expect(a).toEqual(b);
  });
});

describe("runs", () => {
  it("groups by check key in start order, sizes from the rows, pass mark defaults to every item", () => {
    const attempts = [...run("b", "unit", 2, [["i1", 1, "correct"]]), ...run("a", "skip", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]]), ...loose([["i9", 1, "correct"]])];
    const { runs, loose: l } = groupRuns(attempts);
    expect(runs.map((r) => [r.checkKey, r.purpose, r.size, r.passMark])).toEqual([["b", "unit", 2, 2], ["a", "skip", 2, 2]]);
    expect(l.map((a) => a.itemId)).toEqual(["i9"]);
    expect(assessRun(runs[0]!).status).toBe("open");
    expect(assessRun(runs[1]!)).toMatchObject({ status: "passed", independent: true, correctItems: 2, finishedItems: 2 });
  });
  it("masteryMapFromAttempts gives one state per objective and skips unmapped items", () => {
    const attempts = [...run("x", "unit", 2, [["i1", 1, "correct"], ["i2", 1, "correct"]]), ...run("y", "unit", 2, [["i3", 1, "incorrect"]], OTHER), ...run("z", "unit", 1, [["i4", 1, "correct"]], null)];
    const map = masteryMapFromAttempts(attempts);
    expect(Object.keys(map).sort()).toEqual([OTHER, OBJ].sort());
    expect(map[OBJ]!.status).toBe("mastered");
    expect(map[OTHER]!.status).toBe("in_progress");
  });
});
