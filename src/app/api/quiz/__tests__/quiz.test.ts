/**
 * In-app quiz integrity tests — the invariants a reviewer must see hold, all of
 * them written against defects a verifier confirmed on production data:
 *   * the student payload contains NO answer key of any kind, and match
 *     questions arrive with the pairing destroyed (unpaired, shuffled options)
 *   * the shuffle is deterministic per (generation, student) — same paper twice
 *   * and it is NOT COMPUTABLE by the student: a caller holding the generation
 *     id, their own id, the question id and the served options cannot reproduce
 *     the option order, because the seed is now an HMAC under a server-only key
 *     (section 6 replays the zero-probe attack that used to recover the pairs)
 *   * with no server-only key configured the paper is REFUSED, never served
 *     under a weaker order (section 7)
 *   * the SERVER scores: fill_blank / true_false / match / short / subjective,
 *     byte-for-byte the marks the browser used to award
 *   * short & subjective route the whole paper to the teacher (needsReview)
 *   * a student the generation is not assigned to is refused, whether the share
 *     is direct or by class enrolment
 *   * a student cannot submit as another student (the id never comes from input)
 *   * a retake OVERWRITES the one row and re-derives the score; it never
 *     inherits the old mark or the feedback written about the old answers
 *   * a double-submit inside the 0076 window is rejected and writes nothing
 *   * the per-student attempt CAP bounds the differencing oracle, and cannot be
 *     escaped by racing two submissions or by filing a file submission first
 * Run: npx vitest run
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadPaperWith,
  optionOrderKey,
  optionOrderSeed,
  scoreQuiz,
  seededShuffle,
  stripQuiz,
  submitQuizWith,
  MAX_INTERACTIVE_ATTEMPTS,
  RESUBMIT_COOLDOWN_MS,
  SHUFFLE_DOMAIN,
  type QuizStore,
  type RawQuiz,
} from "../logic";
import { FakeStore, type Row } from "./fake-store";

const GEN = "11111111-1111-4111-8111-111111111111";
const OTHER_GEN = "33333333-3333-4333-8333-333333333333";
const STU = "22222222-2222-4222-8222-222222222222";
const OTHER_STU = "44444444-4444-4444-8444-444444444444";
const CLASS = "55555555-5555-4555-8555-555555555555";
/** The server-only option-order key. A student never holds this — that is the
 * entire security argument of section 6, so it lives here and NOWHERE in any
 * value handed to an attacker helper. */
const KEY = "test-only-option-order-secret::c0ffee-9f3c-4b2a";
/** A fixed clock, so cooldown and cap arithmetic is stated rather than timed. */
const T0 = Date.parse("2026-08-19T10:00:00.000Z");

// ── fixtures (the store itself lives in ./fake-store, shared with the route
//    tests so both suites model ONE database) ──────────────────────────────

const QUIZ: RawQuiz = {
  title: "Photosynthesis",
  instructions: "Answer every question.",
  questions: [
    { id: "q1", type: "fill_blank", prompt: "Green pigment?", answer: "Chlorophyll", marks: 1 },
    { id: "q2", type: "true_false", prompt: "Plants eat soil.", answer: false, marks: 1 },
    {
      id: "q3",
      type: "match",
      prompt: "Match each part to its job.",
      pairs: [
        { left: "Leaf", right: "Captures light" },
        { left: "Root", right: "Absorbs water" },
        { left: "Stem", right: "Transports sap" },
      ],
      marks: 3,
    },
    { id: "q4", type: "short", prompt: "Name one product.", answer: "Oxygen", marks: 2 },
    { id: "q5", type: "subjective", prompt: "Explain the process.", answer_outline: "Light + CO2 + water → glucose", marks: 4 },
  ],
};

/** Objective-only paper: nothing a teacher must read. */
const AUTO_QUIZ: RawQuiz = {
  title: "Quick check",
  instructions: "",
  questions: [
    { id: "a1", type: "fill_blank", prompt: "Capital of France?", answer: "Paris", marks: 1 },
    { id: "a2", type: "true_false", prompt: "The sun is a star.", answer: true, marks: 1 },
  ],
};

const ART = (gen: string, path: string): Row => ({ generation_id: gen, kind: "questions_json", storage_path: path });

/** Assigned by a DIRECT share (parent portal / homeschool). */
function directStore(quiz: RawQuiz = QUIZ) {
  return new FakeStore(
    {
      generation_shares: [{ id: "share-1", generation_id: GEN, student_id: STU, class_id: null }],
      enrollments: [],
      artifacts: [ART(GEN, "artifacts/quiz.json")],
      submissions: [],
    },
    { "artifacts/quiz.json": JSON.stringify(quiz) },
  );
}

/** Assigned by a CLASS share the student is enrolled in. */
function classStore() {
  return new FakeStore(
    {
      generation_shares: [{ id: "share-2", generation_id: GEN, student_id: null, class_id: CLASS }],
      enrollments: [{ class_id: CLASS, student_id: STU }],
      artifacts: [ART(GEN, "artifacts/quiz.json")],
      submissions: [],
    },
    { "artifacts/quiz.json": JSON.stringify(QUIZ) },
  );
}

const store = (s: FakeStore) => s as unknown as QuizStore;

// ── 1. the student payload carries no answer key ────────────────────────────

describe("the student payload", () => {
  it("contains no answer, answer_outline or pairs anywhere", async () => {
    const db = directStore();
    const res = await loadPaperWith(store(db), STU, GEN, KEY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const wire = JSON.stringify(res.quiz);
    // Field names gone…
    expect(wire).not.toContain("answer");
    expect(wire).not.toContain("pairs");
    // …and so are the key's VALUES (a rename would not save us).
    expect(wire).not.toContain("Chlorophyll");
    expect(wire).not.toContain("Oxygen");
    expect(wire).not.toContain("Light + CO2 + water");
    for (const q of res.quiz.questions) {
      expect(Object.keys(q).sort()).not.toContain("answer");
      expect(Object.keys(q).sort()).not.toContain("answer_outline");
    }
  });

  it("keeps prompts, marks and question order intact", async () => {
    const db = directStore();
    const res = await loadPaperWith(store(db), STU, GEN, KEY);
    if (!res.ok) throw new Error("expected a paper");
    expect(res.quiz.title).toBe("Photosynthesis");
    expect(res.quiz.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3", "q4", "q5"]);
    expect(res.quiz.questions.map((q) => q.marks)).toEqual([1, 1, 3, 2, 4]);
  });

  it("is refused for a generation that is not assigned to the caller", async () => {
    const db = directStore();
    const res = await loadPaperWith(store(db), OTHER_STU, GEN, KEY);
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it("never spreads unknown fields out of the raw question", async () => {
    const sneaky = {
      title: "t",
      instructions: "",
      questions: [
        // A future key-bearing field must be dropped by CONSTRUCTION.
        { id: "z1", type: "fill_blank", prompt: "p", answer: "secret", solution: "also secret", marks: 1 },
      ],
    } as unknown as RawQuiz;
    const out = JSON.stringify(await stripQuiz(sneaky, KEY, "scope"));
    expect(out).not.toContain("secret");
    expect(out).not.toContain("solution");
  });

  it("carries EXACTLY the whitelisted fields — a new one cannot appear unnoticed", async () => {
    const db = directStore();
    const res = await loadPaperWith(store(db), STU, GEN, KEY);
    if (!res.ok) throw new Error("expected a paper");
    expect(Object.keys(res.quiz).sort()).toEqual(["instructions", "questions", "title"]);
    for (const q of res.quiz.questions) {
      // The match question is the only one allowed the two extra arrays, and
      // `options` is the ONLY field in the whole payload derived from the key.
      expect(Object.keys(q).sort()).toEqual(
        q.type === "match"
          ? ["id", "left", "marks", "options", "prompt", "type"]
          : ["id", "marks", "prompt", "type"],
      );
    }
  });
});

// ── 2. match options are unpaired ───────────────────────────────────────────

describe("match questions", () => {
  it("send the left prompts in order and the right options shuffled, with no pairing", async () => {
    const db = directStore();
    const res = await loadPaperWith(store(db), STU, GEN, KEY);
    if (!res.ok) throw new Error("expected a paper");
    const q = res.quiz.questions.find((x) => x.id === "q3");
    if (!q || q.type !== "match") throw new Error("expected the match question");

    expect(q.left).toEqual(["Leaf", "Root", "Stem"]);
    // Same multiset of options — the count must not leak either.
    expect([...q.options].sort()).toEqual(["Absorbs water", "Captures light", "Transports sap"]);
    // …but NOT in the order that would line them up with the prompts. Three
    // options means the identity permutation is 1-in-6, so this assertion is
    // only meaningful because everything here is DETERMINISTIC — change KEY and
    // re-check it rather than assuming it still holds.
    expect(q.options).not.toEqual(["Captures light", "Absorbs water", "Transports sap"]);
    expect(q).not.toHaveProperty("pairs");
  });

  it("shuffles deterministically per student, and varies between students", async () => {
    const db = directStore();
    const a = await loadPaperWith(store(db), STU, GEN, KEY);
    const b = await loadPaperWith(store(db), STU, GEN, KEY);
    if (!a.ok || !b.ok) throw new Error("expected papers");
    expect(a.quiz).toEqual(b.quiz); // a reload is the same paper

    // Scoped per student, not per generation. Asserted across a HANDFUL of
    // students rather than a pair, because this fixture's match question has
    // only three options: two students share an order one time in six by
    // arithmetic, and STU/OTHER_STU happen to be such a pair. That collision is
    // a property of a three-option question, not a leak — the order still
    // cannot be COMPUTED by either of them (section 6), which is the property
    // that matters. Section 6 uses six options where luck plays no part.
    const orders = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const paper = await stripQuiz(QUIZ, KEY, `${GEN}:${String(i)}-${STU}`);
      orders.add(JSON.stringify(paper.questions));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

// ── 3. server-side scoring, per question type ───────────────────────────────

describe("scoreQuiz", () => {
  it("marks fill_blank case- and whitespace-insensitively, and never for a blank", () => {
    expect(scoreQuiz([QUIZ.questions[0]], { q1: "  chlorophyll " }).auto).toBe(1);
    expect(scoreQuiz([QUIZ.questions[0]], { q1: "chloroform" }).auto).toBe(0);
    expect(scoreQuiz([QUIZ.questions[0]], { q1: "" }).auto).toBe(0);
    expect(scoreQuiz([QUIZ.questions[0]], {}).auto).toBe(0);
  });

  it("marks true_false only for a real boolean", () => {
    expect(scoreQuiz([QUIZ.questions[1]], { q2: false }).auto).toBe(1);
    expect(scoreQuiz([QUIZ.questions[1]], { q2: true }).auto).toBe(0);
    expect(scoreQuiz([QUIZ.questions[1]], { q2: "false" }).auto).toBe(0);
  });

  it("marks match ONE per correct pair, by pair index", () => {
    const q3 = QUIZ.questions[2];
    expect(scoreQuiz([q3], { q3: { 0: "Captures light", 1: "Absorbs water", 2: "Transports sap" } }).auto).toBe(3);
    expect(scoreQuiz([q3], { q3: { 0: "captures light", 1: "Transports sap" } }).auto).toBe(1);
    expect(scoreQuiz([q3], { q3: {} }).auto).toBe(0);
  });

  it("never auto-marks short or subjective, and flags the paper for review", () => {
    const short = scoreQuiz([QUIZ.questions[3]], { q4: "Oxygen" });
    expect(short).toEqual({ auto: 0, max: 2, needsReview: true });
    const subj = scoreQuiz([QUIZ.questions[4]], { q5: "a long essay" });
    expect(subj).toEqual({ auto: 0, max: 4, needsReview: true });
  });

  it("sums max over every question, reviewed ones included", () => {
    const all = scoreQuiz(QUIZ.questions, {
      q1: "Chlorophyll",
      q2: false,
      q3: { 0: "Captures light", 1: "Absorbs water", 2: "Transports sap" },
      q4: "Oxygen",
      q5: "words",
    });
    expect(all).toEqual({ auto: 5, max: 11, needsReview: true });
  });

  it("needs no review when the paper is objective only", () => {
    expect(scoreQuiz(AUTO_QUIZ.questions, { a1: "Paris", a2: true })).toEqual({ auto: 2, max: 2, needsReview: false });
  });
});

// ── 4. submitting ───────────────────────────────────────────────────────────

describe("submitQuizWith", () => {
  it("refuses a student the quiz is not assigned to, and writes nothing", async () => {
    const db = directStore();
    const res = await submitQuizWith(store(db), OTHER_STU, GEN, { q1: "Chlorophyll" });
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(db.writes).toHaveLength(0);
  });

  it("refuses a generation that was never shared at all", async () => {
    const db = directStore();
    const res = await submitQuizWith(store(db), STU, OTHER_GEN, { q1: "Chlorophyll" });
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(db.writes).toHaveLength(0);
  });

  it("accepts a student enrolled in the class the quiz was shared with", async () => {
    const db = classStore();
    const res = await submitQuizWith(store(db), STU, GEN, { q1: "Chlorophyll" });
    expect(res.ok).toBe(true);
  });

  it("refuses a student enrolled in a DIFFERENT class", async () => {
    const db = classStore();
    db.tables.enrollments = [{ class_id: "99999999-9999-4999-8999-999999999999", student_id: STU }];
    const res = await submitQuizWith(store(db), STU, GEN, { q1: "Chlorophyll" });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it("writes the row under the CALLER's id — a body cannot name another student", async () => {
    const db = directStore();
    // Everything an attacker controls is in `answers`; the student id is not.
    await submitQuizWith(store(db), STU, GEN, { q1: "Chlorophyll", student_id: OTHER_STU, teacher_score: 100 });
    const row = db.written()[0];
    expect(row.student_id).toBe(STU);
    expect(row.generation_id).toBe(GEN);
    // Unknown answer keys are dropped, so nothing an attacker sends survives.
    expect(row.answers).toEqual({ q1: "Chlorophyll" });
  });

  it("derives the score server-side and never trusts a client mark", async () => {
    const db = directStore();
    const res = await submitQuizWith(store(db), STU, GEN, {
      q1: "chlorophyll",
      q2: false,
      q3: { 0: "Captures light", 1: "Absorbs water", 2: "Transports sap" },
      auto: 999,
      max: 999,
    });
    expect(res).toMatchObject({ ok: true, auto: 5, max: 11, needsReview: true });
    const row = db.written()[0];
    expect(row.auto_score).toBe(5);
    expect(row.max_score).toBe(11);
    expect(row.mode).toBe("interactive");
    expect(row.teacher_score).toBeNull();
    expect(row.feedback).toBeNull();
    expect(row.graded_by).toBeNull();
    expect(row.graded_at).toBeNull();
    expect(row.attempt_count).toBe(1);
    // First submission for this (generation, student) → a plain INSERT, so a
    // concurrent one collides on the unique key instead of quietly overwriting.
    expect(db.writes[0].op).toBe("insert");
    // 64e5e4b: submissions has no class_id column — it must never be written.
    expect(row).not.toHaveProperty("class_id");
  });

  it("routes a paper with short/subjective questions to the teacher", async () => {
    const db = directStore();
    await submitQuizWith(store(db), STU, GEN, { q1: "Chlorophyll" });
    expect(db.written()[0].grade_status).toBe("pending");
  });

  it("marks an objective-only paper auto", async () => {
    const db = directStore(AUTO_QUIZ);
    const res = await submitQuizWith(store(db), STU, GEN, { a1: "Paris", a2: true });
    expect(res).toMatchObject({ ok: true, needsReview: false });
    expect(db.written()[0].grade_status).toBe("auto");
  });

  it("overwrites on a retake — one row, re-derived score, bumped attempt", async () => {
    const db = directStore(AUTO_QUIZ);
    const t0 = Date.parse("2026-08-19T10:00:00.000Z");
    const first = await submitQuizWith(store(db), STU, GEN, { a1: "Lyon", a2: false }, t0);
    expect(first).toMatchObject({ ok: true, auto: 0 });

    const later = t0 + RESUBMIT_COOLDOWN_MS + 1;
    const second = await submitQuizWith(store(db), STU, GEN, { a1: "Paris", a2: true }, later);
    expect(second).toMatchObject({ ok: true, auto: 2 });

    expect(db.subs()).toHaveLength(1);
    const row = db.subs()[0];
    expect(row.auto_score).toBe(2);
    expect(row.attempt_count).toBe(2);
    expect(row.grade_status).toBe("auto");
  });

  it("un-grades a retake so a teacher's old mark and feedback cannot survive new answers", async () => {
    const db = directStore(AUTO_QUIZ);
    db.tables.submissions = [
      {
        generation_id: GEN,
        student_id: STU,
        mode: "interactive",
        auto_score: 2,
        max_score: 2,
        teacher_score: 2,
        feedback: "Lovely work on question 2.",
        graded_by: OTHER_STU,
        graded_at: "2026-08-18T09:00:00.000Z",
        grade_status: "graded",
        submitted_at: "2026-08-18T08:00:00.000Z",
        attempt_count: 1,
      },
    ];
    await submitQuizWith(store(db), STU, GEN, { a1: "Lyon", a2: false }, Date.parse("2026-08-19T10:00:00.000Z"));
    const row = db.subs()[0];
    expect(row.teacher_score).toBeNull();
    // The words were written about answers that no longer exist.
    expect(row.feedback).toBeNull();
    expect(row.graded_by).toBeNull();
    expect(row.graded_at).toBeNull();
    expect(row.grade_status).toBe("auto");
    expect(row.auto_score).toBe(0);
    expect(row.attempt_count).toBe(2);
  });

  it("rejects a double-submit inside the window and writes nothing (0076)", async () => {
    const db = directStore(AUTO_QUIZ);
    const t0 = Date.parse("2026-08-19T10:00:00.000Z");
    await submitQuizWith(store(db), STU, GEN, { a1: "Paris", a2: true }, t0);
    const dupe = await submitQuizWith(store(db), STU, GEN, { a1: "Lyon", a2: false }, t0 + 900);
    expect(dupe).toMatchObject({ ok: false, status: 429 });
    expect(db.writes).toHaveLength(1);
    expect(db.subs()[0].auto_score).toBe(2); // the real attempt survives untouched
  });

  it("rejects a malformed body without touching the database", async () => {
    const db = directStore();
    expect(await submitQuizWith(store(db), STU, GEN, "not-an-object")).toMatchObject({ ok: false, status: 400 });
    expect(await submitQuizWith(store(db), STU, GEN, [1, 2, 3])).toMatchObject({ ok: false, status: 400 });
    expect(await submitQuizWith(store(db), STU, "not-a-uuid", {})).toMatchObject({ ok: false, status: 404 });
    expect(db.writes).toHaveLength(0);
  });

  it("reports a 404 when the generation has no interactive quiz", async () => {
    const db = directStore();
    db.tables.artifacts = [];
    expect(await submitQuizWith(store(db), STU, GEN, { q1: "x" })).toMatchObject({ ok: false, status: 404 });
    expect(await loadPaperWith(store(db), STU, GEN, KEY)).toMatchObject({ ok: false, status: 404 });
  });

  it("surfaces a write failure instead of reporting a score that was never saved", async () => {
    const db = directStore(AUTO_QUIZ);
    db.writeError = { message: "row-level security" };
    const res = await submitQuizWith(store(db), STU, GEN, { a1: "Paris" });
    expect(res).toMatchObject({ ok: false, status: 500, error: "row-level security" });
  });
});

// ── 5. the attempt cap: the only thing that BOUNDS the differencing oracle ──

describe("the attempt cap", () => {
  /** Spend `n` attempts, each outside the cooldown. Returns the last result. */
  async function spend(db: FakeStore, n: number) {
    let res = await submitQuizWith(store(db), STU, GEN, { a1: "Lyon" }, T0);
    for (let i = 1; i < n; i++)
      res = await submitQuizWith(store(db), STU, GEN, { a1: "Lyon" }, T0 + i * (RESUBMIT_COOLDOWN_MS + 1));
    return res;
  }

  it("reports how many tries are left, counting down to zero", async () => {
    const db = directStore(AUTO_QUIZ);
    const first = await submitQuizWith(store(db), STU, GEN, { a1: "Lyon" }, T0);
    expect(first).toMatchObject({ ok: true, attempt: 1, attemptsLeft: MAX_INTERACTIVE_ATTEMPTS - 1 });
    const last = await spend(directStore(AUTO_QUIZ), MAX_INTERACTIVE_ATTEMPTS);
    expect(last).toMatchObject({ ok: true, attempt: MAX_INTERACTIVE_ATTEMPTS, attemptsLeft: 0 });
  });

  it("refuses the attempt after the cap with 409 and writes nothing", async () => {
    const db = directStore(AUTO_QUIZ);
    await spend(db, MAX_INTERACTIVE_ATTEMPTS);
    const before = db.writes.length;
    const over = await submitQuizWith(
      store(db),
      STU,
      GEN,
      // The probe that would have differenced a1 — refused before the paper is
      // even loaded, so no score is computed and none is returned.
      { a1: "Paris" },
      T0 + 10 * (RESUBMIT_COOLDOWN_MS + 1),
    );
    expect(over).toMatchObject({ ok: false, status: 409 });
    if (over.ok) throw new Error("expected a refusal");
    expect(over.error).toContain(String(MAX_INTERACTIVE_ATTEMPTS));
    expect(db.writes).toHaveLength(before);
    // The banked answers are untouched — a refusal never costs a student work.
    expect(db.subs()[0].auto_score).toBe(0);
    expect(db.subs()[0].attempt_count).toBe(MAX_INTERACTIVE_ATTEMPTS);
  });

  it("counts only IN-APP attempts: a file submission first does not spend one", async () => {
    const db = directStore(AUTO_QUIZ);
    // What student-item.tsx files, with the columns 0091 pins.
    db.tables.submissions = [
      {
        generation_id: GEN,
        student_id: STU,
        mode: "file",
        file_path: `${STU}/${GEN}/answers.pdf`,
        grade_status: "pending",
        submitted_at: new Date(T0 - 1000).toISOString(),
        attempt_count: 0,
      },
    ];
    // No cooldown either — a file upload is not a double-tap on the quiz.
    const res = await submitQuizWith(store(db), STU, GEN, { a1: "Paris", a2: true }, T0);
    expect(res).toMatchObject({ ok: true, attempt: 1, attemptsLeft: MAX_INTERACTIVE_ATTEMPTS - 1 });
    expect(db.subs()).toHaveLength(1);
    expect(db.subs()[0].mode).toBe("interactive");
  });

  it("cannot be reset by racing: two concurrent FIRST submissions, one row, one attempt", async () => {
    // Both read prev = null, so both believe they are attempt 1 — the exact
    // interleaving the old read-then-upsert could not survive. The INSERT that
    // loses hits the unique key and is reported, not silently merged.
    const db = directStore(AUTO_QUIZ);
    db.beforeWrite = () => {
      db.beforeWrite = null; // fire once
      db.tables.submissions.push({
        id: "raced",
        generation_id: GEN,
        student_id: STU,
        mode: "interactive",
        auto_score: 0,
        submitted_at: new Date(T0).toISOString(),
        attempt_count: 1,
      });
    };
    const res = await submitQuizWith(store(db), STU, GEN, { a1: "Paris", a2: true }, T0);
    expect(res).toMatchObject({ ok: false, status: 429 });
    expect(db.subs()).toHaveLength(1);
    expect(db.subs()[0].attempt_count).toBe(1);
  });

  it("cannot be raced on a RETAKE either — the write is a compare-and-swap", async () => {
    const db = directStore(AUTO_QUIZ);
    await submitQuizWith(store(db), STU, GEN, { a1: "Lyon" }, T0);
    // A parallel request lands between our read and our write and takes
    // attempt 2, so the counter we compared against is stale.
    db.beforeWrite = () => {
      db.beforeWrite = null;
      db.subs()[0].attempt_count = 2;
    };
    const res = await submitQuizWith(store(db), STU, GEN, { a1: "Paris" }, T0 + RESUBMIT_COOLDOWN_MS + 1);
    expect(res).toMatchObject({ ok: false, status: 429 });
    // Nothing of ours landed: the row still carries the other request's state.
    expect(db.subs()[0].auto_score).toBe(0);
    expect(db.subs()[0].attempt_count).toBe(2);
    expect(db.writes.filter((w) => w.op === "update" && w.hit > 0)).toHaveLength(0);
  });

  it("guards the swap on attempt_count, not on a blind overwrite", async () => {
    const db = directStore(AUTO_QUIZ);
    await submitQuizWith(store(db), STU, GEN, { a1: "Lyon" }, T0);
    await submitQuizWith(store(db), STU, GEN, { a1: "Paris" }, T0 + RESUBMIT_COOLDOWN_MS + 1);
    const swap = db.writes[1];
    if (swap.op !== "update") throw new Error("a retake must be an UPDATE, not an INSERT");
    expect(swap.match).toContainEqual(["attempt_count", 1]);
    expect(swap.match).toContainEqual(["generation_id", GEN]);
    expect(swap.match).toContainEqual(["student_id", STU]);
  });

  it("re-writes generation_id and student_id to the values it filtered on, so 0091's identity trigger never fires", async () => {
    // 0091 adds a BEFORE UPDATE trigger that refuses ANY change to id,
    // generation_id or student_id — it binds the service role too, on purpose,
    // because nothing legitimately re-parents a submission. This route is the
    // only service-role writer, so the trigger is only safe if the row it sends
    // carries those columns UNCHANGED. It does, and this pins that.
    const db = directStore(AUTO_QUIZ);
    await submitQuizWith(store(db), STU, GEN, { a1: "Lyon" }, T0);
    await submitQuizWith(store(db), STU, GEN, { a1: "Paris" }, T0 + RESUBMIT_COOLDOWN_MS + 1);
    const swap = db.writes[1];
    if (swap.op !== "update") throw new Error("a retake must be an UPDATE");
    expect(swap.row.generation_id).toBe(GEN);
    expect(swap.row.student_id).toBe(STU);
    // …and it never writes the primary key at all.
    expect(swap.row).not.toHaveProperty("id");
  });
});

// ── 6. the match option order is NOT computable by the student ──────────────
//
// The defect this section exists for: the shuffled `options` bag IS the answer
// key expressed as a permutation. Until 2026-08-19 the seed was
// `${generationId}:${studentId}:${q.id}` — every component of which the student
// holds — and Fisher-Yates' swap sequence depends only on (seed, n) and never
// on the values, so a student replayed the shuffle over the bag they were
// handed, inverted it, and read left[i] against right[i] straight off. ZERO
// probes, so MAX_INTERACTIVE_ATTEMPTS was no defence at all: a cap bounds an
// ORACLE, and this was not an oracle, it was the key sitting in the payload.
//
// Everything below runs as the STUDENT. The attack helpers receive the
// generation id, the student id, the question id, the served options, the
// option count and the whole of logic.ts. They never receive KEY. That
// asymmetry is the proof.

/** A six-pair question: 720 possible orders, so nothing here turns on luck. */
const LEFT6 = ["Leaf", "Root", "Stem", "Tuber", "Flower", "Stoma"];
const RIGHTS6 = ["Captures light", "Absorbs water", "Transports sap", "Stores starch", "Makes seed", "Lets air in"];
const match6 = (rights: readonly string[]): RawQuiz => ({
  title: "Parts of a plant",
  instructions: "",
  questions: [
    {
      id: "m1",
      type: "match",
      prompt: "Match each part to its job.",
      pairs: LEFT6.map((left, i) => ({ left, right: rights[i] })),
      marks: 6,
    },
  ],
});

/** The one match question's options, as served. */
async function servedOptions(quiz: RawQuiz, key: string, scope: string): Promise<string[]> {
  const paper = await stripQuiz(quiz, key, scope);
  const q = paper.questions[0];
  if (q.type !== "match") throw new Error("expected the match question");
  return q.options;
}

/** The permutation seededShuffle applies for (seed, n): served[i] comes from
 * source[perm[i]]. Computed WITHOUT the values — precisely the property that
 * made a public seed fatal, and precisely what an attacker replays. */
function permutationFor(seed: string, n: number): number[] {
  return seededShuffle(
    Array.from({ length: n }, (_, i) => i),
    seed,
  );
}

/** THE ATTACK, in four lines: undo the permutation a candidate seed implies and
 * read the answer order back off the wire. */
function readKeyOffTheWire(served: readonly string[], seed: string): string[] {
  const perm = permutationFor(seed, served.length);
  const out = new Array<string>(served.length);
  perm.forEach((source, position) => {
    out[source] = served[position];
  });
  return out;
}

/** The exact formula the code used until 2026-08-19. */
const preFixSeed = (gen: string, stu: string, qid: string) => `${gen}:${stu}:${qid}`;

function permute<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  return xs.flatMap((x, i) => permute([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

/** Every seed a student can ASSEMBLE from material they hold: the generation
 * id, their own id, the question id, the option count and SHUFFLE_DOMAIN (a
 * public constant in this repo) — in every order, every prefix and five
 * separators. ~1600 formulas, and the one the code actually shipped is among
 * them, which the control test asserts rather than assumes. */
function publicSeeds(p: { gen: string; stu: string; qid: string; n: number }): string[] {
  const parts = [p.gen, p.stu, p.qid, String(p.n), SHUFFLE_DOMAIN];
  const seeds = new Set<string>();
  for (const order of permute(parts))
    for (let k = 1; k <= order.length; k++)
      for (const sep of [":", "|", "\n", "-", ""]) seeds.add(order.slice(0, k).join(sep));
  return [...seeds];
}

/** Which source position each served position came from. Values are distinct. */
const permOf = (source: readonly string[], served: readonly string[]) => served.map((v) => source.indexOf(v));

/** A separator no option can contain, so a join() comparison is a real one.
 * A space would NOT do: "Captures light" has one. */
const NUL = String.fromCharCode(0);

/* WHY TWO TESTS IN HERE CARRY THEIR OWN TIMEOUT (2026-09-05).
 *
 * The attack sweeps below serve a whole paper 200 and 300 times over, and
 * every service goes through `optionOrderSeed` → `crypto.subtle` — so each
 * round is an importKey plus a sign, ~1000 WebCrypto calls between the two
 * tests. Node runs those on the libuv threadpool (4 threads by default), which
 * is shared by every vitest worker in the run.
 *
 * Alone, the file finishes them in 61–644 ms across repeated runs. In the FULL
 * suite (92 files, all of them competing for the same four threads) both blew
 * through the 5000 ms default and reported "Test timed out in 5000ms".
 *
 * That is a slow test, not a failing one, and the difference matters: nothing
 * in either assertion depends on time, ordering or luck. Both are pure
 * functions of an HMAC — same key, same scope, same digest, same permutation,
 * every run on every machine. A timeout here can only ever mean "the box was
 * busy"; it can never mean "the shuffle leaked".
 *
 * So the headroom is added and the ASSERTIONS ARE UNTOUCHED — the sweeps still
 * run their full 200 and 300 rounds, and still demand `recovered === 0` and
 * >150 distinct orders. Per test rather than a global `testTimeout`, so the
 * other 1500 tests keep the default and a genuine hang still surfaces fast. */
const CRYPTO_SWEEP_TIMEOUT_MS = 30000;

describe("the match option order", () => {
  it("WAS recoverable with zero probes under the old public seed (the defect, reproduced)", () => {
    // Not hypothetical: this is the entire attack against the shipped code.
    const servedUnderOldSeed = seededShuffle(RIGHTS6, preFixSeed(GEN, STU, "m1"));
    expect(readKeyOffTheWire(servedUnderOldSeed, preFixSeed(GEN, STU, "m1"))).toEqual(RIGHTS6);
    // And that formula IS inside the sweep below, so a null result there is a
    // statement about the fix and not about a badly aimed attack.
    expect(publicSeeds({ gen: GEN, stu: STU, qid: "m1", n: 6 })).toContain(preFixSeed(GEN, STU, "m1"));
  });

  it("is NOT reproducible by a caller holding generationId + studentId + q.id + the options", async () => {
    let recovered = 0;
    for (let i = 0; i < 200; i++) {
      // A different student each round: 200 independent chances for the attack.
      const stu = `${String(i).padStart(8, "0")}-2222-4222-8222-222222222222`;
      const options = await servedOptions(match6(RIGHTS6), KEY, `${GEN}:${stu}`);
      // The attacker's entire holding — note the absence of KEY in this call.
      if (readKeyOffTheWire(options, preFixSeed(GEN, stu, "m1")).join(NUL) === RIGHTS6.join(NUL)) recovered++;
      // The bag still leaks nothing beyond its multiset: same values, same
      // count, so no arithmetic shortcut replaces the broken shuffle.
      expect([...options].sort()).toEqual([...RIGHTS6].sort());
    }
    expect(recovered).toBe(0);
  }, CRYPTO_SWEEP_TIMEOUT_MS);

  it("is not reproduced by ANY seed a student can assemble from public material", async () => {
    const options = await servedOptions(match6(RIGHTS6), KEY, `${GEN}:${STU}`);
    const seeds = publicSeeds({ gen: GEN, stu: STU, qid: "m1", n: options.length });
    expect(seeds.length).toBeGreaterThan(1000);

    const candidates = new Set(seeds.map((s) => readKeyOffTheWire(options, s).join(NUL)));
    // The attack does not fail by returning nothing — it fails by returning
    // hundreds of MUTUALLY CONTRADICTORY answer keys out of the 720 possible.
    // A student who runs it is exactly where they started: guessing.
    expect(candidates.size).toBeGreaterThan(400);
    // The formula that used to BE the answer is now one more wrong guess.
    expect(readKeyOffTheWire(options, preFixSeed(GEN, STU, "m1"))).not.toEqual(RIGHTS6);
  });

  it("is determined by the SERVER KEY — vary only the key and the order moves", async () => {
    // Public material held fixed. If the order still moves, the order is a
    // function of something the student does not hold. That is requirement (c).
    const orders = new Set<string>();
    for (let i = 0; i < 300; i++)
      orders.add((await servedOptions(match6(RIGHTS6), `server-only-secret-#${i}`, `${GEN}:${STU}`)).join(NUL));
    expect(orders.size).toBeGreaterThan(150);
  }, CRYPTO_SWEEP_TIMEOUT_MS);

  it("does not seed from the answer material, so no brute force can self-verify", async () => {
    // The rejected alternative was to digest the PAIRS: secret-looking, and
    // free of configuration, but the student holds the option multiset, so they
    // could try all n! orderings and keep the one that reproduces what they
    // were served — the digest would be its own oracle. This asserts the
    // permutation is INDEPENDENT of the right-hand values: same scope, same
    // question id, same count, different answers, identical permutation. No
    // candidate ordering can ever confirm itself.
    const alt = ["A", "B", "C", "D", "E", "F"];
    const one = await servedOptions(match6(RIGHTS6), KEY, `${GEN}:${STU}`);
    const two = await servedOptions(match6(alt), KEY, `${GEN}:${STU}`);
    expect(permOf(alt, two)).toEqual(permOf(RIGHTS6, one));
  });

  it("is stable for one student and different for another (requirements a and b)", async () => {
    const mine = await servedOptions(match6(RIGHTS6), KEY, `${GEN}:${STU}`);
    expect(await servedOptions(match6(RIGHTS6), KEY, `${GEN}:${STU}`)).toEqual(mine); // a reload
    expect(await servedOptions(match6(RIGHTS6), KEY, `${GEN}:${OTHER_STU}`)).not.toEqual(mine);
    // Different generation, same student: also a different order.
    expect(await servedOptions(match6(RIGHTS6), KEY, `${OTHER_GEN}:${STU}`)).not.toEqual(mine);
  });

  it("separates questions inside one paper", async () => {
    const a = await optionOrderSeed(KEY, `${GEN}:${STU}`, "m1", 6);
    expect(a).toHaveLength(64); // HMAC-SHA-256, hex
    expect(await optionOrderSeed(KEY, `${GEN}:${STU}`, "m2", 6)).not.toBe(a);
    expect(await optionOrderSeed(KEY, `${GEN}:${STU}`, "m1", 6)).toBe(a); // deterministic
  });
});

// ── 7. no key, no paper: the degradation is a refusal, never a weak order ───

describe("the option-order key", () => {
  it("prefers an explicit QUIZ_SHUFFLE_SECRET", () => {
    expect(optionOrderKey({ QUIZ_SHUFFLE_SECRET: "explicit", SUPABASE_SERVICE_ROLE_KEY: "svc" })).toBe("explicit");
  });

  it("falls back to the service-role key, domain-separated", () => {
    // No NEW env var is REQUIRED, because these routes already cannot run
    // without this one — so "key missing but paper served" is unreachable.
    expect(optionOrderKey({ SUPABASE_SERVICE_ROLE_KEY: "svc" })).toBe(`${SHUFFLE_DOMAIN}|svc`);
    // Domain-separated, so a later feature reaching for the same secret cannot
    // mint a colliding digest.
    expect(optionOrderKey({ SUPABASE_SERVICE_ROLE_KEY: "svc" })).not.toBe("svc");
  });

  it("treats blank and whitespace-only as unset", () => {
    expect(optionOrderKey({ QUIZ_SHUFFLE_SECRET: "   ", SUPABASE_SERVICE_ROLE_KEY: "svc" })).toBe(
      `${SHUFFLE_DOMAIN}|svc`,
    );
    expect(optionOrderKey({ QUIZ_SHUFFLE_SECRET: "", SUPABASE_SERVICE_ROLE_KEY: " " })).toBeNull();
    expect(optionOrderKey({})).toBeNull();
  });

  it("refuses to seed at all without a key — there is no fallback formula", async () => {
    await expect(optionOrderSeed("", `${GEN}:${STU}`, "m1", 6)).rejects.toThrow(/server-only key/);
  });

  it("REFUSES the paper when no key is configured, rather than weakening the order", async () => {
    const db = directStore();
    const res = await loadPaperWith(store(db), STU, GEN, null);
    // 500, not a paper under a guessable order. The message is the one the
    // route already shows for a missing service-role key: never a config leak.
    expect(res).toMatchObject({ ok: false, status: 500, error: "Quizzes are unavailable right now." });
    expect(res).not.toMatchObject({ ok: true });
  });
});

// ── 8. the headroom is headroom, not a loosened assertion ───────────────────

/* The two crypto sweeps above carry a 30 s timeout because the full suite
 * starves the libuv threadpool they run on, not because they were flaky — see
 * the note above `CRYPTO_SWEEP_TIMEOUT_MS`.
 *
 * The failure mode a timeout raise invites is the quiet one: someone hits it
 * again next year and "fixes" it by cutting the sweep to 20 rounds, or by
 * relaxing `recovered === 0`, and the suite stays green over a shuffle that
 * leaks. So the sweeps' SHAPE is pinned here — the round counts and both
 * thresholds — and so is the fact that the extra time was granted to exactly
 * these two tests rather than to the whole run. */
describe("the crypto sweeps' headroom", () => {
  const self = readFileSync(new URL(import.meta.url), "utf8");

  it("grants the extra time to the two sweeps and to nothing else", () => {
    expect(CRYPTO_SWEEP_TIMEOUT_MS).toBeGreaterThanOrEqual(20000);
    expect(self.match(/\}, CRYPTO_SWEEP_TIMEOUT_MS\);/g) ?? []).toHaveLength(2);
    // NOT a global relaxation: every other test in the repo keeps the 5 s
    // default, so a real hang still surfaces in seconds.
    expect(readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8")).not.toMatch(/testTimeout/);
  });

  it("leaves the sweeps at full strength — the rounds and both thresholds", () => {
    // 200 independent chances for the zero-probe attack, and it must recover
    // NOTHING. Not "few": none.
    expect(self).toMatch(/for \(let i = 0; i < 200; i\+\+\)/);
    expect(self).toMatch(/expect\(recovered\)\.toBe\(0\);/);
    // 300 different server keys, >150 distinct orders — the order moving with
    // a secret the student does not hold.
    expect(self).toMatch(/for \(let i = 0; i < 300; i\+\+\)/);
    expect(self).toMatch(/expect\(orders\.size\)\.toBeGreaterThan\(150\);/);
    // And no one has quietly excused either sweep instead of timing it.
    expect(self).not.toMatch(/it\.(skip|todo)\(/);
  });
});
