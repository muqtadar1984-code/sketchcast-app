/**
 * Phase 4 — the mastery rule sk-learn.1: an episode's credit (first try
 * weighs most, hints / steps / the answer reduce it), recency weighting, the
 * bands, concepts from tags → paper → kit, the class roll-up, and the reader
 * over the fake schema (RLS-shaped: it only returns the asked students).
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/practice/__tests__/mastery.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  bandOf,
  classConcepts,
  computeMastery,
  CREDIT,
  episodeCredit,
  HALF_LIFE_DAYS,
  recencyWeight,
  type PracticeAttemptRow,
} from "../mastery";
import { readPracticeMastery } from "../mastery-read";
import { KIT, planDb, SESSION, SESSION2, STU, STU2, WS } from "./practice-db";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

type R = Pick<PracticeAttemptRow, "kind" | "outcome" | "rung" | "attempt_no" | "question_type">;
const row = (attempt_no: number, outcome: string, rung = "none", kind = outcome === "help" ? "help" : "answer", question_type = "fill_blank"): R => ({ attempt_no, outcome, rung, kind, question_type });

describe("episodeCredit — first try weighs most, help reduces", () => {
  it("right first time, no help = 1", () => expect(episodeCredit([row(1, "correct")])).toBe(CREDIT.first));
  it("right after a hint (one wrong) = 0.7", () => expect(episodeCredit([row(1, "incorrect", "hint"), row(2, "correct")])).toBe(0.7));
  it("right after a help tap (hint) = 0.7", () => expect(episodeCredit([row(1, "help", "hint"), row(2, "correct")])).toBe(0.7));
  it("right after the worked step = 0.4", () => expect(episodeCredit([row(1, "incorrect", "hint"), row(2, "incorrect", "step"), row(3, "correct")])).toBe(0.4));
  it("right only after the answer rung = 0.1", () =>
    expect(episodeCredit([row(1, "incorrect", "hint"), row(2, "incorrect", "step"), row(3, "incorrect", "answer"), row(4, "correct")])).toBe(0.1));
  it("never right after answering = 0", () => expect(episodeCredit([row(1, "incorrect", "hint")])).toBe(0));
  it("help taps only, no answer, no reveal = not evidence", () => expect(episodeCredit([row(1, "help", "hint"), row(2, "help", "step")])).toBeNull());
  it("help taps up to the answer rung = 0 (she was shown it)", () => expect(episodeCredit([row(1, "help", "hint"), row(2, "help", "step"), row(3, "help", "answer")])).toBe(0));
  it("a written answer for the teacher is never evidence", () => {
    expect(episodeCredit([row(1, "review", "none", "answer", "subjective")])).toBeNull();
    expect(episodeCredit([row(1, "help", "hint", "help", "subjective")])).toBeNull();
  });
  it("row order does not matter", () => expect(episodeCredit([row(2, "correct"), row(1, "incorrect", "hint")])).toBe(0.7));
});

describe("recency and bands", () => {
  it("a weight halves every HALF_LIFE_DAYS", () => {
    expect(recencyWeight(NOW, NOW)).toBe(1);
    expect(recencyWeight(NOW - HALF_LIFE_DAYS * DAY, NOW)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(NOW - 2 * HALF_LIFE_DAYS * DAY, NOW)).toBeCloseTo(0.25, 10);
  });
  it("new below 2 episodes; secure at ≥ 3 episodes and ≥ 80; else learning", () => {
    expect(bandOf(100, 1)).toBe("new");
    expect(bandOf(100, 2)).toBe("learning");
    expect(bandOf(80, 3)).toBe("secure");
    expect(bandOf(79, 10)).toBe("learning");
  });
});

const A = (o: Partial<PracticeAttemptRow>): PracticeAttemptRow => ({
  session_id: "s1",
  student_id: "stu",
  generation_id: "ws",
  question_id: "q1",
  question_type: "fill_blank",
  concept: null,
  kind: "answer",
  outcome: "correct",
  rung: "none",
  attempt_no: 1,
  created_at: at(0),
  ...o,
});

describe("computeMastery — concepts, scores, recency", () => {
  const sessionKit = new Map([
    ["s1", "kit"],
    ["s0", "kit"],
  ]);
  const tags = new Map([
    ["ws:q1", { key: "c1", name: "Organelles" }],
    ["ws:q2", { key: "c1", name: "Organelles" }],
    ["ws:q3", { key: "c1", name: "Organelles" }],
    ["ws:q4", { key: "c2", name: "Membranes" }],
  ]);
  const base = { sessionKit, tags, kitName: () => "Cells", now: NOW };

  it("scores a concept as the recency-weighted mean of its episodes", () => {
    const rows = computeMastery({
      ...base,
      attempts: [
        A({ question_id: "q1" }), // 1.0
        A({ question_id: "q2", outcome: "incorrect", rung: "hint", attempt_no: 1 }),
        A({ question_id: "q2", outcome: "correct", attempt_no: 2 }), // 0.7
        A({ question_id: "q3" }), // 1.0
      ],
    });
    const c1 = rows.find((r) => r.key === "c1")!;
    expect(c1).toMatchObject({ studentId: "stu", kitId: "kit", name: "Organelles", score: 90, band: "secure", evidence: 3, firstTry: 2, rule: "sk-learn.1" });
  });

  it("recent practice outweighs old practice", () => {
    const rows = computeMastery({
      ...base,
      attempts: [
        A({ session_id: "s0", question_id: "q1", outcome: "incorrect", rung: "hint", created_at: at(28) }), // 0, weight 0.25
        A({ session_id: "s1", question_id: "q1", created_at: at(0) }), // 1, weight 1
      ],
    });
    expect(rows[0].score).toBe(80); // (0·0.25 + 1·1) / 1.25
  });

  it("untagged questions fall back to the paper's concept, then the kit", () => {
    const rows = computeMastery({
      ...base,
      tags: new Map(),
      attempts: [A({ question_id: "q8", concept: "Cell Walls" }), A({ question_id: "q9" })],
    });
    expect(rows.map((r) => [r.key, r.name]).sort()).toEqual([
      ["kit", "Cells"],
      ["p:cell-walls", "Cell Walls"],
    ]);
  });

  it("an attempt whose session is unknown (not readable) is skipped", () => {
    expect(computeMastery({ ...base, attempts: [A({ session_id: "nope" })] })).toEqual([]);
  });

  it("weakest first; the class roll-up averages and counts bands", () => {
    const rows = computeMastery({
      ...base,
      attempts: [
        A({ question_id: "q4", outcome: "incorrect", rung: "hint" }),
        A({ student_id: "stu2", session_id: "s1", question_id: "q1" }),
        A({ question_id: "q1" }),
      ],
    });
    expect(rows[0].key).toBe("c2");
    const cls = classConcepts(rows);
    expect(cls[0]).toMatchObject({ key: "c2", students: 1, avg: 0, new: 1 });
  });
});

describe("readPracticeMastery — the reader over the 0178/0179 fake", () => {
  it("joins sessions → kits, tags, kit titles; returns only the asked students", async () => {
    const db = planDb();
    db.seed("sk_practice_sessions", [
      { id: SESSION, student_id: STU, kit_id: KIT },
      { id: SESSION2, student_id: STU2, kit_id: KIT },
    ]);
    db.seed("sk_practice_attempts", [
      { session_id: SESSION, student_id: STU, generation_id: WS, question_id: "q1", question_type: "fill_blank", concept: null, kind: "answer", outcome: "correct", rung: "none", attempt_no: 1, created_at: at(1) },
      { session_id: SESSION2, student_id: STU2, generation_id: WS, question_id: "q1", question_type: "fill_blank", concept: null, kind: "answer", outcome: "incorrect", rung: "hint", attempt_no: 1, created_at: at(1) },
    ]);
    db.seed("sk_practice_concepts", [{ generation_id: WS, question_id: "q1", question_hash: "h".repeat(64), concept_key: "c1", concept_name: "Pigments", method: "manifest", created_at: at(2) }]);
    const r = await readPracticeMastery(db, [STU], { now: NOW });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ studentId: STU, kitId: KIT, key: "c1", name: "Pigments", score: 100, band: "new" });
    expect(r.kits.get(KIT)).toBe("Cells");
    expect((await readPracticeMastery(db, [STU], { kitId: "00000000-0000-4000-8000-000000000000", now: NOW })).rows).toEqual([]);
    expect((await readPracticeMastery(db, [], { now: NOW })).rows).toEqual([]);
  });
});
