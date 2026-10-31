/**
 * Phase 4 routes (SK student Board plan 2026-10-31):
 *   POST /api/present/learn/answer — the graded-quiz HOLDBACK through the real
 *        route (her class share, no hand-in → no key at rung 3; a submission
 *        → the key), and the after-work scheduled with next/server `after`
 *        (concept tags on her first answer);
 *   GET  /api/present/learn/mastery — her own mastery, learners only;
 *   POST /api/learn/plan — the decision runs AS THE SIGNED-IN USER through
 *        sk_learn_plan_decide; a refusal is a 403, a bad body a 400.
 * Supabase, the learner loaders and the model are mocked; no network.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/present/learn/__tests__/learn-plan-routes.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { learnerKits, type LearnerGen } from "@/utils/present/learner";
import { CLASS, KIT, PAPER, planDb, STU, WS } from "@/sk/practice/__tests__/practice-db";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  learnerGate: vi.fn(),
  loadLearnerKits: vi.fn(),
  meterStudentTurn: vi.fn(),
  after: vi.fn(),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: mocks.after }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/utils/present/learner-server", () => ({ learnerGate: mocks.learnerGate, loadLearnerKits: mocks.loadLearnerKits }));
vi.mock("@/sk/student-cap", () => ({ meterStudentTurn: mocks.meterStudentTurn }));
vi.mock("@/utils/claude-backend", () => ({
  claudeConfigured: () => false,
  claudeClient: () => {
    throw new Error("no model in tests");
  },
  claudeModel: (id: string) => id,
}));

import { POST as answerPOST } from "../answer/route";
import { GET as masteryGET } from "../mastery/route";
import { POST as planPOST } from "@/app/api/learn/plan/route";

const SESSION = "99999999-9999-4999-8999-999999999999";
const PLAN = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const A = (kind: string) => ({ kind, storage_path: `t/${kind}` });
const gen = (o: Partial<LearnerGen> & { id: string; kind: string }): LearnerGen => ({ title: "Cells · x", chapter_ref: null, book_id: null, params: null, artifacts: [], status: "done", withdrawn_at: null, created_at: "2026-10-20T00:00:00Z", ...o });
const herKits = () =>
  learnerKits(
    [gen({ id: KIT, kind: "presentation", title: "Cells · Cells", artifacts: [A("video_mp4")] }), gen({ id: WS, kind: "worksheet", title: "Cells · Worksheet", artifacts: [A("docx"), A("questions_json")] })],
    [KIT, WS].map((id) => ({ generation_id: id, due_at: null })),
  );

function admin() {
  const db = planDb(); // her class CLASS has the worksheet shared, no due date, nothing handed in
  db.seed("artifacts", [{ generation_id: WS, kind: "questions_json", storage_path: "ws/questions.json" }]);
  const files: Record<string, string> = { "ws/questions.json": JSON.stringify(PAPER) };
  return Object.assign(db, {
    storage: { from: () => ({ download: async (p: string) => (files[p] ? { data: { text: async () => files[p] }, error: null } : { data: null, error: { message: "missing" } }) }) },
  });
}
const signedIn = (id: string | null, extra: Record<string, unknown> = {}) => ({ auth: { getUser: async () => ({ data: { user: id ? { id } : null } }) }, ...extra });
const answer = (o: Record<string, unknown> = {}) =>
  answerPOST(new Request("http://localhost/api/present/learn/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: SESSION, kitId: KIT, generationId: WS, questionId: "q1", kind: "answer", answer: "x", ms: 1000, ...o }) }));

let db: ReturnType<typeof admin>;
beforeEach(() => {
  vi.clearAllMocks();
  db = admin();
  mocks.createClient.mockResolvedValue(signedIn(STU));
  mocks.createAdminClient.mockReturnValue(db);
  mocks.learnerGate.mockResolvedValue({ ok: true, role: "student", schoolId: null });
  mocks.loadLearnerKits.mockResolvedValue(herKits());
  mocks.meterStudentTurn.mockResolvedValue({ ok: true, count: 1, metered: true });
});

describe("POST /api/present/learn/answer — the graded-quiz holdback", () => {
  it("her open quiz (class share, not handed in): rung 3 has NO key, locked: quiz", async () => {
    expect(CLASS).toBeTruthy();
    await answer({ answer: "a" });
    await answer({ answer: "b" });
    const r3 = await (await answer({ answer: "c" })).json();
    expect(r3).toMatchObject({ rung: "answer", answer: null, locked: "quiz" });
    expect(JSON.stringify(r3)).not.toMatch(/chlorophyll/i);
  });

  it("handed in: rung 3 reveals the key", async () => {
    db.seed("submissions", [{ generation_id: WS, student_id: STU, submitted_at: "2026-10-31T08:00:00Z" }]);
    await answer({ answer: "a" });
    await answer({ answer: "b" });
    expect((await (await answer({ answer: "c" })).json()).answer).toEqual({ type: "text", value: "Chlorophyll" });
  });

  it("schedules the after-work, which tags the worksheet on her first answer", async () => {
    await answer({ answer: "a" });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await (mocks.after.mock.calls[0][0] as () => Promise<void>)();
    // q3 names its own concept on the paper: cached; untagged ones stay on the kit (never cached)
    expect(db.rows("sk_practice_concepts").map((r) => [r.question_id, r.method])).toEqual([["q3", "paper"]]);
  });

  it("a refused answer schedules nothing", async () => {
    mocks.loadLearnerKits.mockResolvedValue([]);
    expect((await answer()).status).toBe(404);
    expect(mocks.after).not.toHaveBeenCalled();
  });
});

describe("GET /api/present/learn/mastery — her own, learners only", () => {
  const get = (q: string) => masteryGET(new Request(`http://localhost/api/present/learn/mastery${q}`));
  it("401 / 403 / 400", async () => {
    mocks.createClient.mockResolvedValue(signedIn(null));
    expect((await get(`?kitId=${KIT}`)).status).toBe(401);
    mocks.createClient.mockResolvedValue(signedIn(STU, { from: db.from.bind(db) }));
    mocks.learnerGate.mockResolvedValue({ ok: false, role: "teacher", schoolId: null });
    expect((await get(`?kitId=${KIT}`)).status).toBe(403);
    mocks.learnerGate.mockResolvedValue({ ok: true, role: "student", schoolId: null });
    expect((await get("?kitId=nope")).status).toBe(400);
  });
  it("reads through HER session and answers her concepts", async () => {
    db.seed("sk_practice_sessions", [{ id: SESSION, student_id: STU, kit_id: KIT }]);
    db.seed("sk_practice_attempts", [{ session_id: SESSION, student_id: STU, generation_id: WS, question_id: "q3", question_type: "mcq", concept: "cell organelles", kind: "answer", outcome: "correct", rung: "none", attempt_no: 1, created_at: new Date().toISOString() }]);
    mocks.createClient.mockResolvedValue(signedIn(STU, { from: db.from.bind(db) }));
    const r = await get(`?kitId=${KIT}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ concepts: [{ key: "p:cell-organelles", name: "cell organelles", score: 100, band: "new", evidence: 1 }] });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });
});

describe("POST /api/learn/plan — the approver's decision", () => {
  const post = (body: unknown) => planPOST(new Request("http://localhost/api/learn/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  it("401 signed out; 400 on a bad body (no call made)", async () => {
    const rpc = vi.fn();
    mocks.createClient.mockResolvedValue(signedIn(null, { rpc }));
    expect((await post({ planId: PLAN, decision: "approve" })).status).toBe(401);
    mocks.createClient.mockResolvedValue(signedIn("t", { rpc }));
    expect((await post({ planId: "x", decision: "approve" })).status).toBe(400);
    expect((await post({ planId: PLAN, decision: "edit" })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("approve runs the function as the user; done → 200 with what it created", async () => {
    const rpc = vi.fn(async () => ({ data: { outcome: "done", status: "approved", applied: { shares: ["sh1"], already: [], skipped: [], focus: 1, whole_class: false } }, error: null }));
    mocks.createClient.mockResolvedValue(signedIn("t", { rpc }));
    const r = await post({ planId: PLAN, decision: "approve", wholeClass: false });
    expect(r.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("sk_learn_plan_decide", { p_plan: PLAN, p_decision: "approve", p_items: null, p_whole_class: false, p_note: null });
    expect(await r.json()).toMatchObject({ outcome: "done", status: "approved", applied: { shares: ["sh1"] } });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });
  it("not the approver → 403; no such plan → 404", async () => {
    mocks.createClient.mockResolvedValue(signedIn("p", { rpc: async () => ({ data: { outcome: "refused", reason: "not_approver" }, error: null }) }));
    const r = await post({ planId: PLAN, decision: "approve" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ outcome: "refused", reason: "not_approver" });
    mocks.createClient.mockResolvedValue(signedIn("p", { rpc: async () => ({ data: { outcome: "not_found" }, error: null }) }));
    expect((await post({ planId: PLAN, decision: "decline" })).status).toBe(404);
  });
});
