/**
 * Worksheet practice end to end on the server (student Board phase 2), over
 * the schema-aware fake of the 0178 tables: the attempt rows, the ladder
 * (hint → worked step → answer), the key withheld until rung 3, the help
 * cache (the second student does not pay), the fair-use meter, session
 * ownership, finished questions, the double-submit guard and the
 * "wrong twice" hand-off flag. The model is always a mock.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/practice/__tests__/service.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import type { RawQuiz } from "@/app/api/quiz/logic";
import { practise, type PracticeDeps, type PracticeInput, type PracticeReply } from "../service";
import type { HelpModelCall } from "../help";
import { KIT, PAPER, practiceDb, SESSION, SESSION2, STU, STU2, WS } from "./practice-db";

function setup(o: { call?: HelpModelCall | null; meter?: boolean } = {}) {
  const db = practiceDb();
  const call = o.call === undefined ? vi.fn<HelpModelCall>(async (req) => ({ text: req.system.includes("WHY") ? "Because it is where respiration releases energy." : "Look again at the key idea in the question.", usage: { input_tokens: 380, output_tokens: 40 } })) : o.call;
  const meter = vi.fn(async () => o.meter ?? true);
  const deps: PracticeDeps = { db, loadPaper: async (id) => (id === WS ? (PAPER as unknown as RawQuiz) : null), call, meter, now: () => Date.parse("2026-10-31T10:00:00Z") };
  return { db, deps, call, meter };
}

const input = (o: Partial<PracticeInput>): PracticeInput => ({ studentId: STU, sessionId: SESSION, kitId: KIT, generationId: WS, questionId: "q1", kind: "answer", answer: "chloroplast", ms: 5000, ...o });
const reply = (r: { body: unknown }) => r.body as PracticeReply;
const KEY = "Chlorophyll";

describe("practise — one answer, checked and recorded", () => {
  it("a right first answer: correct, recorded, no help, no key", async () => {
    const { db, deps, call } = setup();
    const r = await practise(deps, input({ answer: "chlorophyll" }));
    expect(r.status).toBe(200);
    expect(reply(r)).toMatchObject({ outcome: "correct", correct: true, attemptNo: 1, rung: "none", help: null, answer: null, done: true, gap: null });
    const rows = db.rows("sk_practice_attempts");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ student_id: STU, generation_id: WS, question_id: "q1", question_type: "fill_blank", kind: "answer", answer: "chlorophyll", outcome: "correct", correct: true, attempt_no: 1, rung: "none", hints_used: 0, time_ms: 5000, concept: null });
    expect(db.rows("sk_practice_sessions")).toEqual([expect.objectContaining({ id: SESSION, student_id: STU, kit_id: KIT })]);
    expect(call).not.toHaveBeenCalled();
  });

  it("the ladder: hint, then worked step, then the answer — and the key ONLY at rung 3", async () => {
    const { db, deps } = setup();
    const r1 = reply(await practise(deps, input({ answer: "chloroplast" })));
    expect(r1).toMatchObject({ outcome: "incorrect", rung: "hint", wrong: 1, answer: null, gap: null, done: false });
    expect(r1.help?.rung).toBe("hint");
    expect(JSON.stringify(r1)).not.toMatch(new RegExp(KEY, "i"));

    const r2 = reply(await practise(deps, input({ answer: "xylem" })));
    expect(r2).toMatchObject({ outcome: "incorrect", rung: "step", wrong: 2, answer: null, gap: "wrong_twice" });
    expect(JSON.stringify(r2)).not.toMatch(new RegExp(KEY, "i"));

    const r3 = reply(await practise(deps, input({ answer: "stomata" })));
    expect(r3).toMatchObject({ outcome: "incorrect", rung: "answer", wrong: 3, gap: null, answer: { type: "text", value: KEY } });

    const r4 = reply(await practise(deps, input({ answer: "Chlorophyll" })));
    expect(r4).toMatchObject({ outcome: "correct", rung: "none", done: true });

    expect(db.rows("sk_practice_attempts").map((x) => [x.attempt_no, x.outcome, x.rung, x.hints_used])).toEqual([
      [1, "incorrect", "hint", 0],
      [2, "incorrect", "step", 1],
      [3, "incorrect", "answer", 2],
      [4, "correct", "none", 3],
    ]);
  });

  it("asking for help climbs the ladder without an answer and records a help row", async () => {
    const { db, deps } = setup();
    const r = reply(await practise(deps, input({ questionId: "q3", kind: "help", answer: undefined })));
    expect(r).toMatchObject({ outcome: "help", rung: "hint", wrong: 0, answer: null, gap: null, concept: "cell organelles" });
    // The paper's own hint, no model call.
    expect(r.help).toEqual({ rung: "hint", text: "Think about respiration.", source: "paper" });
    expect(db.rows("sk_practice_attempts")[0]).toMatchObject({ kind: "help", answer: null, outcome: "help", correct: false, concept: "cell organelles" });
  });

  it("model help is generated once and CACHED: the second student does not pay", async () => {
    const { db, deps, call, meter } = setup();
    const a = reply(await practise(deps, input({ answer: "chloroplast" })));
    expect(a.help).toMatchObject({ rung: "hint", source: "model" });
    expect(call).toHaveBeenCalledTimes(1);
    expect(meter).toHaveBeenCalledTimes(1);
    expect(db.rows("sk_practice_help")).toEqual([expect.objectContaining({ generation_id: WS, question_id: "q1", rung: "hint", model: "claude-haiku-5-5" })]);
    expect(Number(db.rows("sk_practice_help")[0].cost_usd)).toBeGreaterThan(0);

    const b = reply(await practise(deps, input({ studentId: STU2, sessionId: SESSION2, answer: "xylem" })));
    expect(b.help).toEqual({ rung: "hint", text: a.help!.text, source: "cache" });
    expect(call).toHaveBeenCalledTimes(1);
    expect(meter).toHaveBeenCalledTimes(1);
  });

  it("a model reply that leaks the key is never shown or cached", async () => {
    const { db, deps } = setup({ call: async () => ({ text: "The answer is chlorophyll.", usage: { input_tokens: 1, output_tokens: 1 } }) });
    const r = reply(await practise(deps, input({ answer: "chloroplast" })));
    expect(r.help).toEqual({ rung: "hint", text: null, source: "generic" });
    expect(JSON.stringify(r)).not.toMatch(/chlorophyll/i);
    expect(db.rows("sk_practice_help")).toEqual([]);
  });

  it("over the fair-use cap, or with no model configured: the generic line, no call", async () => {
    const capped = setup({ meter: false });
    expect(reply(await practise(capped.deps, input({}))).help).toEqual({ rung: "hint", text: null, source: "generic" });
    expect(capped.call).not.toHaveBeenCalled();
    const none = setup({ call: null });
    expect(reply(await practise(none.deps, input({}))).help).toEqual({ rung: "hint", text: null, source: "generic" });
  });

  it("subjective: sent for review, finished, never auto-marked", async () => {
    const { db, deps } = setup();
    const r = reply(await practise(deps, input({ questionId: "q6", answer: "Plants need light to make food." })));
    expect(r).toMatchObject({ outcome: "review", correct: false, done: true, rung: "none", answer: null });
    expect(db.rows("sk_practice_attempts")[0]).toMatchObject({ outcome: "review", question_type: "subjective" });
  });

  it("match and true/false answers are shaped and checked", async () => {
    const { deps } = setup();
    expect(reply(await practise(deps, input({ questionId: "q4", answer: ["controls the cell", "lets substances in and out"] }))).correct).toBe(true);
    expect((await practise(deps, input({ questionId: "q2", answer: "false" }))).status).toBe(400);
    expect(reply(await practise(deps, input({ questionId: "q2", answer: false }))).correct).toBe(true);
  });
});

describe("practise — refusals write nothing", () => {
  it("an unknown question or worksheet: 404", async () => {
    const { db, deps } = setup();
    expect((await practise(deps, input({ questionId: "q99" }))).status).toBe(404);
    expect((await practise(deps, input({ generationId: KIT }))).status).toBe(404);
    expect(db.rows("sk_practice_attempts")).toEqual([]);
  });

  it("no usable answer: 400", async () => {
    const { db, deps } = setup();
    expect((await practise(deps, input({ answer: "   " }))).status).toBe(400);
    expect(db.rows("sk_practice_attempts")).toEqual([]);
  });

  it("another student's practice session: 403, and her record is untouched", async () => {
    const { db, deps } = setup();
    await practise(deps, input({ answer: "chloroplast" }));
    const r = await practise(deps, input({ studentId: STU2, answer: "chlorophyll" }));
    expect(r.status).toBe(403);
    expect(db.rows("sk_practice_attempts")).toHaveLength(1);
    expect(db.rows("sk_practice_attempts")[0].student_id).toBe(STU);
  });

  it("the session of another kit: 409", async () => {
    const { db, deps } = setup();
    await practise(deps, input({}));
    expect((await practise(deps, input({ kitId: WS }))).status).toBe(409);
    expect(db.rows("sk_practice_attempts")).toHaveLength(1);
  });

  it("a finished question: 409 done", async () => {
    const { deps } = setup();
    await practise(deps, input({ answer: "chlorophyll" }));
    const r = await practise(deps, input({ answer: "chlorophyll" }));
    expect(r).toEqual({ status: 409, body: expect.objectContaining({ done: true }) });
    expect((await practise(deps, input({ kind: "help", answer: undefined }))).status).toBe(409);
  });

  it("a double tap racing for the same attempt number: 429, one row", async () => {
    const { db, deps } = setup();
    // The second request reads the same (empty) history before the first lands.
    const [a, b] = await Promise.all([practise(deps, input({ answer: "chloroplast" })), practise(deps, input({ answer: "xylem" }))]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    expect(db.rows("sk_practice_attempts")).toHaveLength(1);
  });

  it("time on the question is clamped; junk is null", async () => {
    const { db, deps } = setup();
    await practise(deps, input({ ms: 99_999_999 }));
    await practise(deps, input({ questionId: "q2", answer: true, ms: "soon" }));
    expect(db.rows("sk_practice_attempts").map((r) => r.time_ms)).toEqual([3_600_000, null]);
  });
});
