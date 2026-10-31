/**
 * POST /api/present/learn/answer — the worksheet-practice route (student Board
 * phase 2). Auth and ownership, in the order the route checks them, and that
 * the answer key never reaches the wire before the ladder's third rung:
 *   401 signed out (nothing else runs) · 403 not a learner · 400 bad body ·
 *   404 not HER kit / not a projected worksheet of it (a test paper, a piece
 *   of another kit) · 200 checked and recorded with the student id from the
 *   SESSION, never the body · no key in a wrong answer's reply.
 * Supabase, the learner loaders and the model are mocked; no network.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/present/learn/__tests__/answer-route.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { learnerKits, type LearnerGen } from "@/utils/present/learner";
import { practiceDb, KIT, WS, STU, STU2, PAPER } from "@/sk/practice/__tests__/practice-db";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  learnerGate: vi.fn(),
  loadLearnerKits: vi.fn(),
  meterStudentTurn: vi.fn(),
  claudeConfigured: vi.fn(() => false),
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/utils/present/learner-server", () => ({ learnerGate: mocks.learnerGate, loadLearnerKits: mocks.loadLearnerKits }));
vi.mock("@/sk/student-cap", () => ({ meterStudentTurn: mocks.meterStudentTurn }));
vi.mock("@/utils/claude-backend", () => ({
  claudeConfigured: mocks.claudeConfigured,
  claudeClient: () => {
    throw new Error("no model in tests");
  },
  claudeModel: (id: string) => id,
}));

import { POST } from "../answer/route";

const EXAM = "77777777-7777-4777-8777-777777777777";
const OTHER_WS = "88888888-8888-4888-8888-888888888888";
const SESSION = "99999999-9999-4999-8999-999999999999";

const A = (kind: string) => ({ kind, storage_path: `t/${kind}` });
const gen = (o: Partial<LearnerGen> & { id: string; kind: string }): LearnerGen => ({ title: "Cells · x", chapter_ref: null, book_id: null, params: null, artifacts: [], status: "done", withdrawn_at: null, created_at: "2026-10-20T00:00:00Z", ...o });
// Her kit: the lesson video (= the kit id), its worksheet, and a test paper that was also shared.
const herKits = () =>
  learnerKits(
    [
      gen({ id: KIT, kind: "presentation", title: "Cells · Cells", artifacts: [A("video_mp4")] }),
      gen({ id: WS, kind: "worksheet", title: "Cells · Worksheet", artifacts: [A("docx"), A("questions_json")] }),
      gen({ id: EXAM, kind: "exam_paper", title: "Cells · Test", artifacts: [A("docx"), A("questions_json")] }),
    ],
    [KIT, WS, EXAM].map((id) => ({ generation_id: id, due_at: null })),
  );

function admin() {
  const db = practiceDb();
  db.seed("artifacts", [{ generation_id: WS, kind: "questions_json", storage_path: "ws/questions.json" }]);
  const files: Record<string, string> = { "ws/questions.json": JSON.stringify(PAPER) };
  return Object.assign(db, {
    storage: { from: () => ({ download: async (p: string) => (files[p] ? { data: { text: async () => files[p] }, error: null } : { data: null, error: { message: "missing" } }) }) },
  });
}

const signedIn = (id: string | null) => ({ auth: { getUser: async () => ({ data: { user: id ? { id } : null } }) } });
const post = (body: unknown, raw?: string) => POST(new Request("http://localhost/api/present/learn/answer", { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }));
const body = (o: Record<string, unknown> = {}) => ({ sessionId: SESSION, kitId: KIT, generationId: WS, questionId: "q1", kind: "answer", answer: "chloroplast", ms: 3000, ...o });

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

describe("POST /api/present/learn/answer", () => {
  it("401 signed out — and nothing else runs", async () => {
    mocks.createClient.mockResolvedValue(signedIn(null));
    const r = await post(body());
    expect(r.status).toBe(401);
    expect(mocks.learnerGate).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("403 for anyone who is not a learner (a teacher, a student without SK)", async () => {
    mocks.learnerGate.mockResolvedValue({ ok: false, role: "teacher", schoolId: null });
    expect((await post(body())).status).toBe(403);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("400 on a malformed body", async () => {
    expect((await post(null, "{nope")).status).toBe(400);
    expect((await post(body({ sessionId: "not-a-uuid" }))).status).toBe(400);
    expect((await post(body({ questionId: "x".repeat(81) }))).status).toBe(400);
    expect((await post(body({ kind: "reveal" }))).status).toBe(400);
  });

  it("404 when the kit is not hers, or the worksheet is not a projected worksheet of it", async () => {
    expect((await post(body({ kitId: OTHER_WS }))).status).toBe(404);
    expect((await post(body({ generationId: OTHER_WS }))).status).toBe(404);
    // A test paper shared with the kit is never practised (its key would be revealed).
    expect((await post(body({ generationId: EXAM }))).status).toBe(404);
    mocks.loadLearnerKits.mockResolvedValue([]);
    expect((await post(body())).status).toBe(404);
    expect(db.rows("sk_practice_attempts")).toEqual([]);
  });

  it("200: checked on the server, recorded under the SESSION's student id — never the body's", async () => {
    const r = await post(body({ studentId: STU2, answer: "chloroplast" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ outcome: "incorrect", correct: false, rung: "hint", answer: null });
    // No model configured: the generic line, and the key is nowhere in the reply.
    expect(j.help).toEqual({ rung: "hint", text: null, source: "generic" });
    expect(JSON.stringify(j)).not.toMatch(/chlorophyll/i);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const rows = db.rows("sk_practice_attempts");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ student_id: STU, generation_id: WS, question_id: "q1", session_id: SESSION, time_ms: 3000 });
    expect(db.rows("sk_practice_sessions")[0]).toMatchObject({ id: SESSION, student_id: STU, kit_id: KIT });
  });

  it("a piece id as kitId resolves to the kit (deep links name any piece)", async () => {
    const r = await post(body({ kitId: WS, answer: "Chlorophyll" }));
    expect(r.status).toBe(200);
    expect(db.rows("sk_practice_sessions")[0].kit_id).toBe(KIT);
  });

  it("the key arrives only at the third rung", async () => {
    const r1 = await (await post(body({ answer: "a" }))).json();
    const r2 = await (await post(body({ answer: "b" }))).json();
    const r3 = await (await post(body({ answer: "c" }))).json();
    expect([r1.answer, r2.answer]).toEqual([null, null]);
    expect(r2.gap).toBe("wrong_twice");
    expect(r3.answer).toEqual({ type: "text", value: "Chlorophyll" });
  });

  it("another student cannot write into her practice session", async () => {
    await post(body());
    mocks.createClient.mockResolvedValue(signedIn(STU2));
    const r = await post(body({ answer: "Chlorophyll" }));
    expect(r.status).toBe(403);
    expect(db.rows("sk_practice_attempts")).toHaveLength(1);
  });

  it("500 with a readable message when the admin client is unavailable", async () => {
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
    });
    const r = await post(body());
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toMatch(/SERVICE_ROLE/);
  });
});
