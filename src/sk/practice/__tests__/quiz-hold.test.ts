/**
 * Phase 4 fix — the graded-quiz HOLDBACK: rung 3 must not reveal the key while
 * the same paper is her graded quiz, not handed in and not past due. The pure
 * rule, the loader over the fake schema, and the ladder end to end (the
 * worked step + `locked: "quiz"`, never the key or the explanation).
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/practice/__tests__/quiz-hold.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import type { RawQuiz } from "@/app/api/quiz/logic";
import { keyHeld, loadQuizKeyState, type QuizKeyState } from "../quiz-hold";
import { practise, type PracticeDeps, type PracticeInput, type PracticeReply } from "../service";
import type { HelpModelCall } from "../help";
import { CLASS, KIT, PAPER, planDb, SESSION, STU, STU2, WS } from "./practice-db";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const PAST = "2026-10-30T10:00:00Z";
const FUTURE = "2026-11-03T10:00:00Z";

describe("keyHeld — the rule", () => {
  it("holds the key while it is her quiz, not handed in, not past due", () => {
    expect(keyHeld({ dues: [null], submittedAt: null }, NOW)).toEqual({ held: true, reason: "open" });
    expect(keyHeld({ dues: [FUTURE], submittedAt: null }, NOW)).toEqual({ held: true, reason: "open" });
  });
  it("unlocks after she hands it in (any submission)", () => {
    expect(keyHeld({ dues: [FUTURE], submittedAt: "2026-10-31T09:00:00Z" }, NOW)).toEqual({ held: false, reason: "handed_in" });
  });
  it("unlocks once EVERY share's due date has passed (the latest counts)", () => {
    expect(keyHeld({ dues: [PAST], submittedAt: null }, NOW)).toEqual({ held: false, reason: "past_due" });
    expect(keyHeld({ dues: [PAST, FUTURE], submittedAt: null }, NOW).held).toBe(true);
    expect(keyHeld({ dues: [PAST, null], submittedAt: null }, NOW).held).toBe(true);
  });
  it("a paper not assigned to her is not her quiz", () => {
    expect(keyHeld({ dues: [], submittedAt: null }, NOW)).toEqual({ held: false, reason: "not_assigned" });
  });
  it("fails CLOSED: an unreadable state holds the key", () => {
    expect(keyHeld(null, NOW)).toEqual({ held: true, reason: "unknown" });
  });
});

describe("loadQuizKeyState — her shares and her submission", () => {
  it("reads a class share she is enrolled in, a direct share, and her submission", async () => {
    const db = planDb();
    db.seed("generation_shares", [{ generation_id: WS, class_id: null, student_id: STU, due_at: FUTURE }]);
    const s = (await loadQuizKeyState(db, STU, WS)) as QuizKeyState;
    expect(s.dues.sort()).toEqual([FUTURE, null].sort());
    expect(s.submittedAt).toBeNull();
    db.seed("submissions", [{ generation_id: WS, student_id: STU, submitted_at: "2026-10-31T09:00:00Z" }]);
    expect((await loadQuizKeyState(db, STU, WS))?.submittedAt).toBe("2026-10-31T09:00:00Z");
  });
  it("another class's share does not count as hers", async () => {
    const db = planDb();
    const s = await loadQuizKeyState(db, STU2, WS); // STU2 is in no class
    expect(s?.dues).toEqual([]);
  });
  it("a read error answers null (→ held)", async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: { message: "boom" } }), maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
    expect(await loadQuizKeyState(db as never, STU, WS)).toBeNull();
  });
});

function setup(state: QuizKeyState | null) {
  const db = planDb();
  const call = vi.fn<HelpModelCall>(async (req) => ({ text: req.system.includes("WHY") ? "Because chlorophyll absorbs light." : "Think about what makes leaves green.", usage: { input_tokens: 300, output_tokens: 30 } }));
  const quizKey = vi.fn(async () => state);
  const deps: PracticeDeps = { db, loadPaper: async (id) => (id === WS ? (PAPER as unknown as RawQuiz) : null), call, meter: async () => true, quizKey, now: () => NOW };
  return { db, deps, call, quizKey };
}
const input = (o: Partial<PracticeInput> = {}): PracticeInput => ({ studentId: STU, sessionId: SESSION, kitId: KIT, generationId: WS, questionId: "q1", kind: "answer", answer: "chloroplast", ms: 2000, ...o });
const reply = (r: { body: unknown }) => r.body as PracticeReply;

describe("the ladder with the holdback (end to end on the fake schema)", () => {
  it("open quiz: rung 3 serves the WORKED STEP + locked, never the key or the explanation", async () => {
    const { deps, quizKey } = setup({ dues: [FUTURE], submittedAt: null });
    await practise(deps, input({ answer: "xylem" }));
    await practise(deps, input({ answer: "phloem" }));
    const r3 = reply(await practise(deps, input({ answer: "stomata" })));
    expect(r3).toMatchObject({ outcome: "incorrect", rung: "answer", answer: null, locked: "quiz" });
    expect(r3.help?.rung).toBe("step");
    expect(JSON.stringify(r3)).not.toMatch(/chlorophyll/i);
    expect(quizKey).toHaveBeenCalledWith(STU, WS);
    // A help tap at the top of the ladder is held too.
    const r4 = reply(await practise(deps, input({ kind: "help", answer: undefined })));
    expect(r4).toMatchObject({ rung: "answer", answer: null, locked: "quiz" });
    expect(JSON.stringify(r4)).not.toMatch(/chlorophyll/i);
  });

  it("the state is only asked for at rung 3", async () => {
    const { deps, quizKey } = setup({ dues: [null], submittedAt: null });
    await practise(deps, input({ answer: "xylem" }));
    await practise(deps, input({ answer: "phloem" }));
    expect(quizKey).not.toHaveBeenCalled();
  });

  it("handed in: rung 3 reveals the key as before", async () => {
    const { deps } = setup({ dues: [FUTURE], submittedAt: "2026-10-31T08:00:00Z" });
    await practise(deps, input({ answer: "xylem" }));
    await practise(deps, input({ answer: "phloem" }));
    const r3 = reply(await practise(deps, input({ answer: "stomata" })));
    expect(r3).toMatchObject({ rung: "answer", locked: null, answer: { type: "text", value: "Chlorophyll" } });
  });

  it("past due: rung 3 reveals the key", async () => {
    const { deps } = setup({ dues: [PAST], submittedAt: null });
    await practise(deps, input({ answer: "a" }));
    await practise(deps, input({ answer: "b" }));
    expect(reply(await practise(deps, input({ answer: "c" }))).answer).toEqual({ type: "text", value: "Chlorophyll" });
  });

  it("an unreadable quiz state holds the key (fail closed)", async () => {
    const { deps } = setup(null);
    await practise(deps, input({ answer: "a" }));
    await practise(deps, input({ answer: "b" }));
    const r3 = reply(await practise(deps, input({ answer: "c" })));
    expect(r3).toMatchObject({ answer: null, locked: "quiz" });
  });

  it("the attempt row still records the ladder position (rung answer)", async () => {
    const { db, deps } = setup({ dues: [null], submittedAt: null });
    for (const a of ["a", "b", "c"]) await practise(deps, input({ answer: a }));
    expect(db.rows("sk_practice_attempts").map((r) => r.rung)).toEqual(["hint", "step", "answer"]);
  });

  it("the class share in planDb makes the real loader hold the key", async () => {
    const { deps, db } = setup(null);
    deps.quizKey = (s, g) => loadQuizKeyState(db, s, g);
    expect(CLASS).toBeTruthy();
    for (const a of ["a", "b"]) await practise(deps, input({ answer: a }));
    expect(reply(await practise(deps, input({ answer: "c" })))).toMatchObject({ answer: null, locked: "quiz" });
  });
});
