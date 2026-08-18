/**
 * The two quiz Route Handlers — the layer quiz.test.ts deliberately does not
 * reach. Everything below was covered ONLY by `next build` compiling, which
 * proves the types line up and nothing about behaviour:
 *
 *   * the signed-out branch on both routes (401, and NOTHING else runs — no
 *     admin client, no database, no answer key touched);
 *   * the admin-client failure branch (500 with a message a student can read,
 *     never a stack or a config error);
 *   * Next 16's `params: Promise<{ generationId: string }>` — the dynamic
 *     segment now ARRIVES AS A PROMISE, and a handler that forgets to await it
 *     compiles happily and then treats "[object Promise]" as a generation id;
 *   * the status and body each failure mode actually puts on the wire, since
 *     the client renders `json.error` verbatim to a child.
 *
 * Run: npx vitest run src/app/api/quiz/__tests__/routes.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { GET } from "@/app/api/quiz/[generationId]/route";
import { POST } from "@/app/api/quiz/submit/route";
import { MAX_INTERACTIVE_ATTEMPTS, RESUBMIT_COOLDOWN_MS } from "@/app/api/quiz/logic";
import { FakeStore, type Row } from "./fake-store";

const GEN = "11111111-1111-4111-8111-111111111111";
const STU = "22222222-2222-4222-8222-222222222222";
const OTHER_STU = "44444444-4444-4444-8444-444444444444";

const QUIZ = {
  title: "Photosynthesis",
  instructions: "Answer every question.",
  questions: [
    { id: "q1", type: "fill_blank", prompt: "Green pigment?", answer: "Chlorophyll", marks: 1 },
    { id: "q2", type: "true_false", prompt: "Plants eat soil.", answer: false, marks: 1 },
  ],
};

function assignedStore(): FakeStore {
  return new FakeStore(
    {
      generation_shares: [{ id: "share-1", generation_id: GEN, student_id: STU, class_id: null }],
      enrollments: [],
      artifacts: [{ generation_id: GEN, kind: "questions_json", storage_path: "artifacts/quiz.json" }],
      submissions: [],
    },
    { "artifacts/quiz.json": JSON.stringify(QUIZ) },
  );
}

/** The session half. `user: null` is the signed-out branch. */
function signedIn(id: string | null) {
  return { auth: { getUser: async () => ({ data: { user: id ? { id } : null } }) } };
}

/** The dynamic segment as Next 16 hands it over: a PROMISE, not a string. */
const ctx = (generationId: string) => ({ params: Promise.resolve({ generationId }) });

const get = (id: string) => GET(new Request(`http://localhost/api/quiz/${id}`), ctx(id));

const post = (body: unknown, raw?: string) =>
  POST(
    new Request("http://localhost/api/quiz/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
  );

/** The GET route reads the option-order key off `process.env` and refuses the
 * paper without one, so every test that expects a paper must supply it. Vitest
 * does not load .env into process.env, so it would otherwise be absent here —
 * which is itself worth knowing: the refusal is real, and the last test in this
 * file is the one that asserts it. */
const SERVICE_KEY = "test-only-service-role-key";
let savedService: string | undefined;
let savedShuffle: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue(signedIn(STU));
  savedService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  savedShuffle = process.env.QUIZ_SHUFFLE_SECRET;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  delete process.env.QUIZ_SHUFFLE_SECRET;
});

afterEach(() => {
  if (savedService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = savedService;
  if (savedShuffle === undefined) delete process.env.QUIZ_SHUFFLE_SECRET;
  else process.env.QUIZ_SHUFFLE_SECRET = savedShuffle;
});

// ── GET /api/quiz/{generationId} ────────────────────────────────────────────

describe("GET /api/quiz/[generationId]", () => {
  it("401s a signed-out caller and never builds an admin client", async () => {
    mocks.createClient.mockResolvedValue(signedIn(null));
    const res = await get(GEN);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Not signed in." });
    // The service-role client is what could read questions.json. It must not
    // even be constructed for an anonymous request.
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("500s with a readable line when the admin client cannot be built", async () => {
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
    });
    const res = await get(GEN);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Quizzes are unavailable right now.");
    // Never the underlying cause: that names our env vars to the internet.
    expect(body.error).not.toMatch(/SERVICE_ROLE|missing/i);
  });

  it("AWAITS the params promise — the id reaches the logic as a string", async () => {
    // If `params` were used unawaited the id would stringify to "[object
    // Promise]", fail the UUID test, and this would be a 404 instead.
    mocks.createAdminClient.mockReturnValue(assignedStore());
    const res = await get(GEN);
    expect(res.status).toBe(200);
    const quiz = (await res.json()) as { title: string; questions: unknown[] };
    expect(quiz.title).toBe("Photosynthesis");
    expect(quiz.questions).toHaveLength(2);
  });

  it("serves the paper with the key stripped and no caching", async () => {
    mocks.createAdminClient.mockReturnValue(assignedStore());
    const res = await get(GEN);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // Per-student payload behind a session check: a shared cache entry would
    // hand one student another student's copy.
    const wire = JSON.stringify(await res.json());
    expect(wire).not.toContain("Chlorophyll");
    expect(wire).not.toContain("answer");
  });

  it("403s a student the generation is not assigned to", async () => {
    mocks.createClient.mockResolvedValue(signedIn(OTHER_STU));
    mocks.createAdminClient.mockReturnValue(assignedStore());
    const res = await get(GEN);
    expect(res.status).toBe(403);
  });

  it("404s a non-UUID segment without hitting the database", async () => {
    const db = assignedStore();
    mocks.createAdminClient.mockReturnValue(db);
    const res = await get("submit");
    expect(res.status).toBe(404);
    expect(db.writes).toHaveLength(0);
  });

  it("500s rather than serve a paper when NO option-order secret is configured", async () => {
    // The seed behind the match option order is the only thing standing between
    // a student and the pairing (logic.ts rule 3). With no server-only secret
    // there is no correct order to serve, so the route refuses. A fallback to
    // any seed built from public material would BE the vulnerability, so there
    // is deliberately no such branch — this is the whole degradation story.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.QUIZ_SHUFFLE_SECRET;
    mocks.createAdminClient.mockReturnValue(assignedStore());
    const res = await get(GEN);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Quizzes are unavailable right now.");
    // Never names the env var it wanted.
    expect(body.error).not.toMatch(/SECRET|SERVICE_ROLE|shuffle/i);
  });

  it("serves the paper on an explicit QUIZ_SHUFFLE_SECRET alone", async () => {
    // The optional override: set it and the service-role key stops being the
    // material behind the order, so it can be rotated independently.
    process.env.QUIZ_SHUFFLE_SECRET = "an-explicit-rotatable-secret";
    mocks.createAdminClient.mockReturnValue(assignedStore());
    expect((await get(GEN)).status).toBe(200);
  });
});

// ── POST /api/quiz/submit ───────────────────────────────────────────────────

describe("POST /api/quiz/submit", () => {
  it("401s a signed-out caller and writes nothing", async () => {
    mocks.createClient.mockResolvedValue(signedIn(null));
    const res = await post({ generationId: GEN, answers: { q1: "Chlorophyll" } });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Not signed in." });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("400s a body that is not JSON, before any auth-scoped work", async () => {
    const res = await post(null, "{not json");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON." });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("500s with a readable line when the admin client cannot be built", async () => {
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
    });
    const res = await post({ generationId: GEN, answers: {} });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Quizzes are unavailable right now." });
  });

  it("grades server-side and returns the mark with the tries left", async () => {
    const db = assignedStore();
    mocks.createAdminClient.mockReturnValue(db);
    const res = await post({ generationId: GEN, answers: { q1: "chlorophyll", q2: false } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      auto: 2,
      max: 2,
      needsReview: false,
      attempt: 1,
      attemptsLeft: MAX_INTERACTIVE_ATTEMPTS - 1,
    });
  });

  it("takes the student id from the SESSION even when the body names another", async () => {
    const db = assignedStore();
    mocks.createAdminClient.mockReturnValue(db);
    await post({ generationId: GEN, studentId: OTHER_STU, answers: { q1: "Chlorophyll" } });
    const row = db.written()[0] as Row;
    expect(row.student_id).toBe(STU);
  });

  it("coerces a missing generationId to '' and 404s it", async () => {
    const db = assignedStore();
    mocks.createAdminClient.mockReturnValue(db);
    const res = await post({ answers: {} });
    expect(res.status).toBe(404);
    expect(db.writes).toHaveLength(0);
  });

  it("400s answers that are not an object", async () => {
    mocks.createAdminClient.mockReturnValue(assignedStore());
    const res = await post({ generationId: GEN, answers: [1, 2, 3] });
    expect(res.status).toBe(400);
  });

  it("409s past the attempt cap, with the cap named in the message", async () => {
    const db = assignedStore();
    db.tables.submissions = [
      {
        generation_id: GEN,
        student_id: STU,
        mode: "interactive",
        submitted_at: new Date(Date.now() - RESUBMIT_COOLDOWN_MS - 1000).toISOString(),
        attempt_count: MAX_INTERACTIVE_ATTEMPTS,
      },
    ];
    mocks.createAdminClient.mockReturnValue(db);
    const res = await post({ generationId: GEN, answers: { q1: "Chlorophyll" } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(String(MAX_INTERACTIVE_ATTEMPTS));
    expect(body.error).toMatch(/teacher/i);
    expect(db.writes).toHaveLength(0);
  });
});
