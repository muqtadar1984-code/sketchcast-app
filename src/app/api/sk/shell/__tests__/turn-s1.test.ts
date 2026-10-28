/**
 * /api/sk/shell/turn, S1 slice B: Board moves and confirm cards.
 *   - a Board phrasing with an open Board → meta → tool → board → done
 *     (grounded, no model, nothing executed server-side);
 *   - the model choosing board.slide → text → board → done grounded;
 *   - a Board move with NO Board (model path) → text + the way to the Board;
 *   - a confirm-tier result → the route issues ONE sk_action_tokens row and
 *     emits a confirm event with the token; with no secret → declined; in
 *     neither case is anything written beyond the token row.
 * The confirm entry is a test double appended to the real registry (slice D's
 * `assign` is not in this worktree).
 * Slice C (teaching content): explain/compare with a READY manifest run ONE
 * teaching call (no tools, the narration as a TEACHING block) → meta → tool →
 * board → text → done grounded [move, "manifest"]; grounding strips a name not
 * in the narration; a not-ready manifest makes NO model call; compare carries
 * both narrations; Board rows are audited against the PRESENT session; practise
 * is stamped with the q_ids mapped to the current segment.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn-s1.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";
import type { SkCapability } from "@/sk/shell/types";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  script: [] as unknown[],
  /** Slice C: one script per provider CONSTRUCTION (the teaching call builds
   *  its own provider); when empty every provider plays `script`. */
  queue: [] as unknown[][],
  constructed: [] as string[],
  systems: [] as string[],
  opts: [] as GenerateOpts[],
  /** What readManifest answers (slice C). */
  manifest: { status: "missing" } as unknown,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (mocks.cookies[n] ? { value: mocks.cookies[n] } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { StubProvider } = await import("@/utils/assistant/providers/stub");
  return {
    AnthropicProvider: class extends StubProvider {
      constructor(model: string) {
        super((mocks.queue.length ? mocks.queue.shift()! : mocks.script) as StubTurn[]);
        mocks.constructed.push(model);
      }
      async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
        mocks.systems.push(opts.system);
        mocks.opts.push(opts);
        yield* super.stream(opts);
      }
    },
  };
});
// The real registry plus a confirm-tier double standing in for slice D's assign.
vi.mock("@/sk/capabilities", async () => {
  const real = await vi.importActual<typeof import("@/sk/capabilities")>("@/sk/capabilities");
  const testAssign: SkCapability = {
    meta: {
      name: "test.assign",
      description: "TEST: assign a worksheet (confirm tier).",
      parameters: { type: "object", properties: { classId: { type: "string" }, due: { type: "string" } }, required: ["classId"], additionalProperties: false },
      tier: "confirm",
      kind: "act",
      roles: ["teacher"],
    },
    async handler(_ctx, args) {
      return {
        ok: true,
        summary: "Ready to assign Specialised Cells to 7B, due Friday.",
        facts: [{ class: "7B", due: "Friday" }],
        confirm: { action: "assign", title: "Assign Specialised Cells to 7B", params: { classId: String(args.classId), className: "7B", generationId: "g-ws", due: "2026-10-30T17:00:00+08:00" } },
      };
    },
  };
  return { ...real, REGISTRY: [...real.REGISTRY, testAssign] };
});

// Slice C: the manifest store answers what the test says; nothing else of it changes.
vi.mock("@/sk/manifest/store", async () => {
  const real = await vi.importActual<typeof import("@/sk/manifest/store")>("@/sk/manifest/store");
  return { ...real, readManifest: async () => mocks.manifest };
});

import { POST } from "@/app/api/sk/shell/turn/route";
import { SK_CANNOT_CONFIRM } from "@/sk/shell/types";
import { BOARD_NOT_OPEN, BOARD_NO_MAP } from "@/sk/capabilities/board";
import { LESSON_NOT_STARTED } from "@/sk/shell/lines";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeManifest, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_PARENT_PORTAL", "FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "BOOK_CODE_SECRET", "FEATURE_ROLE_HATS", "FEATURE_DIARY", "FEATURE_SCHOOL_ANALYTICS", "FEATURE_CATALOGUE_TAB", "SK_SHELL_MODEL", "SK_AUDIT", "PRESENT_ALLOWED_EMAILS"];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };

const tables = () => ({
  profiles: [{ role: "teacher", school_id: SCHOOL_ID }],
  schools: [{ config: {} }],
  coordinator_scope: [],
  parent_links: [],
  classes: [{ id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }],
  enrollments: [],
  books: [],
});
let session: ReturnType<typeof fakeSession>;
let admin: ReturnType<typeof fakeAdmin>;

const BOARD = {
  sessionId: "sess-1",
  manifestId: "man-1",
  generationId: "gen-1",
  k: 1,
  segmentId: "s2",
  t: 40,
  paused: false,
  segments: [
    { k: 0, id: "s1", heading: "Introduction" },
    { k: 1, id: "s2", heading: "Red blood cells", points: ["Carry oxygen"] },
    { k: 2, id: "s3", heading: "Nerve cells", points: ["Carry signals"] },
  ],
  concepts: [{ id: "c1", name: "red blood cell", segmentIds: ["s2"] }],
};

const req = (body: unknown) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const turn = (text: string, extra: Record<string, unknown> = {}) => ({
  turnId: `t-${Math.random().toString(36).slice(2)}`,
  text,
  modality: "text",
  collector: { path: "/present", locale: "en", board: BOARD },
  ...extra,
});
const offBoard = (text: string) => turn(text, { collector: { path: "/dashboard", locale: "en" } });

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "route-test-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  process.env.SK_AUDIT = "db";
  mocks.cookies = { sc_hat: "teacher" };
  mocks.script = [];
  mocks.queue = [];
  mocks.constructed = [];
  mocks.systems = [];
  mocks.opts = [];
  mocks.manifest = { status: "missing" };
  admin = fakeAdmin("school");
  mocks.createAdminClient.mockReturnValue(admin);
  session = fakeSession(tables(), { user: USER });
  mocks.createClient.mockResolvedValue(session);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

const auditRows = () => admin.inserts.filter((i) => i.table === "sk_actions").map((i) => i.row as Record<string, unknown>);
const tokenRows = () => admin.inserts.filter((i) => i.table === "sk_action_tokens").map((i) => i.row as Record<string, unknown>);

describe("Board moves by rules (deterministic)", () => {
  it("'pause' with an open Board → meta(teach) → tool → board → done grounded, no model", async () => {
    const ev = await readEvents(await POST(req(turn("pause"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "board", "done"]);
    expect(ev[0]).toMatchObject({ type: "meta", intent: "teach" });
    expect((ev[0] as { capabilities: string[] }).capabilities).toEqual(expect.arrayContaining(["board.pause", "board.slide", "board.explain"]));
    expect(ev[1]).toMatchObject({ type: "tool", name: "board.pause", ok: true });
    expect(ev[2]).toEqual({ type: "board", move: "pause", args: {}, say: "Paused." });
    expect(ev[3]).toMatchObject({ type: "done", label: "grounded", sources: ["board.pause"] });
    expect(typeof ev[3].memory).toBe("string");
    expect(mocks.constructed).toEqual([]);
    // Audited as a Board move; no token, nothing else written.
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({ action: "board.pause", kind: "board", tier: "immediate", ok: true, session_id: expect.any(String) });
    expect(tokenRows()).toEqual([]);
    expect(session.log.filter((l) => /insert|update|rpc/.test(l))).toEqual([]);
  });
  it("'slide 3' resolves against the client's segments and carries heading + points", async () => {
    const ev = await readEvents(await POST(req(turn("slide 3"))));
    expect(ev.find((e) => e.type === "board")).toEqual({ type: "board", move: "slide", args: { k: 2, heading: "Nerve cells", points: ["Carry signals"] }, say: "Slide 3: Nerve cells." });
  });
  it("'explain red blood cells' → a slide move via the concept table", async () => {
    const ev = await readEvents(await POST(req(turn("explain red blood cells"))));
    const b = ev.find((e) => e.type === "board") as { move: string; args: Record<string, unknown>; say: string };
    expect(b.move).toBe("slide");
    expect(b.args).toMatchObject({ k: 1, heading: "Red blood cells", concept: "red blood cells" });
    expect(b.say).toBe("Let's look at Red blood cells.");
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "grounded", sources: ["board.explain"] });
  });
  it("a slide the lesson does not have → text + declined, no board event", async () => {
    const ev = await readEvents(await POST(req(turn("slide 9"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect(ev[2]).toEqual({ type: "text", text: "This lesson has 3 slides." });
    expect(ev[3]).toMatchObject({ label: "declined" });
  });
  it("the same phrase off the Board goes to the model (ask), and 'open the board' navigates", async () => {
    mocks.script = [{ text: ["Nothing is playing right now."] }];
    const ev = await readEvents(await POST(req(offBoard("pause"))));
    expect(ev[0]).toMatchObject({ intent: "ask" });
    expect(ev.find((e) => e.type === "board")).toBeUndefined();
    const nav = await readEvents(await POST(req(offBoard("open the board"))));
    expect(nav.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/present", label: "Classroom board" });
  });
  it("the system prompt on the Board carries the Board rule and the lesson map", async () => {
    mocks.script = [{ text: ["Sure."] }];
    await readEvents(await POST(req(turn("what should I teach next?"))));
    expect(mocks.systems[0]).toContain("board=open k=1 playing slides=3");
    expect(mocks.systems[0]).toContain("LESSON MAP");
    expect(mocks.systems[0]).toContain("slide 2 (k=1): Red blood cells");
    expect(mocks.systems[0]).toContain("- board.slide (immediate/board)");
  });
});

describe("Board moves chosen by the model", () => {
  it("model calls board.slide → text → board → done grounded", async () => {
    mocks.script = [{ toolCalls: [{ id: "c1", name: "board__slide", args: { k: 2 } }] }, { text: ["Here are the nerve cells."] }];
    const ev = await readEvents(await POST(req(turn("let's move on to the nerve cells"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "board", "done"]);
    expect(ev[1]).toMatchObject({ type: "tool", name: "board.slide", ok: true });
    expect(ev[2]).toEqual({ type: "text", text: "Here are the nerve cells." });
    expect(ev[3]).toMatchObject({ type: "board", move: "slide", args: { k: 2 } });
    expect(ev[4]).toMatchObject({ label: "grounded", sources: ["board.slide"] });
  });
  it("a silent model still yields SK's own line for the move", async () => {
    mocks.script = [{ toolCalls: [{ id: "c1", name: "board__pause", args: {} }] }, { text: [] }];
    const ev = await readEvents(await POST(req(turn("hold it a second"))));
    expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: "Paused." });
    expect(ev.find((e) => e.type === "board")).toMatchObject({ move: "pause" });
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "grounded" });
  });
  it("a Board move with no Board open: the tool refuses, SK says so, and the way to the Board is offered", async () => {
    mocks.script = [{ toolCalls: [{ id: "c1", name: "board__intro", args: {} }] }, { text: [`${BOARD_NOT_OPEN}`] }];
    // ("start the video" itself is now a rules-decided start-the-lesson; this
    // is the model choosing the move from a looser phrase.)
    const ev = await readEvents(await POST(req(offBoard("could you get the film going"))));
    expect(ev[1]).toMatchObject({ type: "tool", name: "board.intro", ok: false });
    expect(ev.find((e) => e.type === "board")).toBeUndefined();
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "declined" });
  });
});

describe("confirm cards (§2.5, §8.2): the token is issued here, nothing is executed", () => {
  const callAssign = () => {
    mocks.script = [{ toolCalls: [{ id: "c1", name: "test__assign", args: { classId: "c7b", due: "Friday" } }] }, { text: ["Ready to assign Specialised Cells to 7B, due Friday."] }];
  };
  it("emits meta → tool → text → confirm → done grounded, with a token bound to the user and one sk_action_tokens row", async () => {
    callAssign();
    const ev = await readEvents(await POST(req(turn("assign the worksheet to 7B for Friday"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "confirm", "done"]);
    const c = ev[3] as { token: string; action: string; title: string; params: Record<string, unknown>; expiresAt: string };
    expect(c.action).toBe("assign");
    expect(c.title).toBe("Assign Specialised Cells to 7B");
    expect(c.params).toEqual({ classId: "c7b", className: "7B", generationId: "g-ws", due: "2026-10-30T17:00:00+08:00" });
    expect(c.token).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
    expect(Date.parse(c.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(ev[4]).toMatchObject({ label: "grounded", sources: ["test.assign"] });
    // Exactly one token row, for this user, with the resolved params; no other write.
    const rows = tokenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: TEACHER_ID, action: "assign", params: c.params });
    // The token's id is the one the DB reply gave (fakeAdmin's), not anything the client or model supplied.
    expect(c.token.startsWith("33333333-3333-4333-8333-")).toBe(true);
    expect(session.log.filter((l) => /insert|update|rpc\./.test(l))).toEqual([]);
    expect(auditRows().map((r) => r.action)).toEqual(["test.assign"]);
  });
  it("with no SK_SHELL_SECRET / BOOK_CODE_SECRET → declined with the fixed line, no token row, no confirm event", async () => {
    delete process.env.SK_SHELL_SECRET;
    callAssign();
    const ev = await readEvents(await POST(req(turn("assign the worksheet to 7B for Friday"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect(ev[2]).toEqual({ type: "text", text: SK_CANNOT_CONFIRM });
    expect(ev[3]).toMatchObject({ label: "declined" });
    expect(tokenRows()).toEqual([]);
  });
  it("with no admin client (no service role) → declined too", async () => {
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error("no key");
    });
    callAssign();
    const ev = await readEvents(await POST(req(turn("assign the worksheet to 7B for Friday"))));
    expect(ev.find((e) => e.type === "confirm")).toBeUndefined();
    expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: SK_CANNOT_CONFIRM });
  });
});

// ── S1 slice C: the teaching content behind explain / compare ────────────────

const NARRATION = {
  s1: "Today we look at cells. The cell is the unit of life.",
  s2: "Red blood cells carry oxygen using haemoglobin. They have no nucleus, which leaves room for 270 million haemoglobin molecules.",
  s3: "Nerve cells carry electrical signals along a long axon to the muscles.",
};
const MANIFEST = fakeManifest(
  [
    { id: "s1", heading: "Introduction", narration: NARRATION.s1 },
    { id: "s2", heading: "Red blood cells", points: ["Carry oxygen"], narration: NARRATION.s2 },
    { id: "s3", heading: "Nerve cells", points: ["Carry signals"], narration: NARRATION.s3 },
  ],
  [
    { id: "c1", name: "red blood cell", segmentIds: ["s2"] },
    { id: "c2", name: "nerve cell", segmentIds: ["s3"] },
  ],
  [
    { q_id: "ws:q1", source: "worksheet", segment_ids: ["s1"] },
    { q_id: "quiz:q2", source: "quiz", segment_ids: ["s2"] },
    { q_id: "ws:q3", source: "worksheet", segment_ids: ["s2"] },
    { q_id: "ws:q4", source: "worksheet", segment_ids: ["s2", "s3"] },
  ],
);
const READY = { status: "ready", manifest: MANIFEST, builtAt: "2026-10-28T00:00:00Z" };
/** The user turn of a captured stream (the teaching question). */
const lastText = (o: GenerateOpts): string => {
  const m = o.messages.at(-1);
  return m && "text" in m ? m.text : "";
};

describe("explain / compare with content (slice C)", () => {
  it("explain by rules with a ready manifest → meta → tool → board → text → done grounded [board.explain, manifest], ONE model call with no tools", async () => {
    mocks.manifest = READY;
    mocks.script = [{ text: ["Red blood cells carry oxygen using haemoglobin. ", "Having no nucleus leaves room for 270 million haemoglobin molecules."] }];
    const ev = await readEvents(await POST(req(turn("explain red blood cells"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "board", "text", "done"]);
    expect(ev[1]).toMatchObject({ type: "tool", name: "board.explain", ok: true });
    expect(ev[2]).toMatchObject({ type: "board", move: "slide", args: { k: 1, heading: "Red blood cells", concept: "red blood cells" } });
    expect(ev[3]).toEqual({ type: "text", text: "Red blood cells carry oxygen using haemoglobin. Having no nucleus leaves room for 270 million haemoglobin molecules." });
    expect(ev[4]).toMatchObject({ type: "done", label: "grounded", sources: ["board.explain", "manifest"], usage: { inputTokens: 100, outputTokens: 50 } });
    expect((ev[4] as { trimmed?: boolean }).trimmed).toBeUndefined();
    // Exactly one provider, one stream, no tools, the narration as DATA in the system prompt.
    expect(mocks.constructed).toHaveLength(1);
    expect(mocks.opts).toHaveLength(1);
    expect(mocks.opts[0].tools).toBeUndefined();
    expect(mocks.opts[0].maxTokens).toBe(220);
    expect(mocks.systems[0]).toContain("You are SK");
    expect(mocks.systems[0]).toContain('<teaching data_only="true">');
    expect(mocks.systems[0]).toContain("--- slide 2: Red blood cells ---");
    expect(mocks.systems[0]).toContain(`narration: ${NARRATION.s2}`);
    expect(mocks.systems[0]).not.toContain(NARRATION.s3);
    expect(lastText(mocks.opts[0])).toBe('Explain "Red blood cells" to the class in 2–4 short sentences, in English, using only the narration in TEACHING. No headings, no lists.');
    // The Board move is audited against the PRESENT session, not the Shell's.
    const row = auditRows().find((r) => r.action === "board.explain");
    expect(row).toMatchObject({ kind: "board", ok: true, session_id: "sess-1" });
    expect((ev[0] as { sessionId: string }).sessionId).not.toBe("sess-1");
  });

  it("grounding strips a sentence whose name is not in the narration and marks the turn trimmed", async () => {
    mocks.manifest = READY;
    mocks.script = [{ text: ["Red blood cells carry oxygen using haemoglobin. ", "Dr Perutz worked this out in Cambridge."] }];
    const ev = await readEvents(await POST(req(turn("explain red blood cells"))));
    expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: "Red blood cells carry oxygen using haemoglobin." });
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "grounded", sources: ["board.explain", "manifest"], trimmed: true });
  });

  it("nothing of the model's text survives grounding → SK's own line, still grounded", async () => {
    mocks.manifest = READY;
    mocks.script = [{ text: ["Perutz solved it in Cambridge in 1959."] }];
    const ev = await readEvents(await POST(req(turn("explain red blood cells"))));
    expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: "Let's look at Red blood cells." });
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "grounded" });
  });

  it.each(["building", "stale", "missing", "failed"])("manifest %s → the say line + the no-map line, NO model call", async (status) => {
    mocks.manifest = { status };
    const ev = await readEvents(await POST(req(turn("explain red blood cells"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "board", "text", "done"]);
    expect(ev[3]).toEqual({ type: "text", text: `Let's look at Red blood cells. ${BOARD_NO_MAP}` });
    expect(ev[4]).toMatchObject({ label: "grounded", sources: ["board.explain"] });
    expect(mocks.constructed).toEqual([]);
  });

  it("compare carries BOTH segments' narration as [A] and [B] and asks for the differences", async () => {
    mocks.manifest = READY;
    mocks.script = [{ text: ["Red blood cells carry oxygen; nerve cells carry electrical signals along an axon."] }];
    const ev = await readEvents(await POST(req(turn("compare red blood cells and nerve cells"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "board", "text", "done"]);
    expect(ev[1]).toMatchObject({ name: "board.compare", ok: true });
    expect(ev[2]).toMatchObject({ type: "board", move: "slide", args: { k: 1, next: 2 } });
    expect(ev[3]).toEqual({ type: "text", text: "Red blood cells carry oxygen; nerve cells carry electrical signals along an axon." });
    expect(ev[4]).toMatchObject({ label: "grounded", sources: ["board.compare", "manifest"] });
    expect(mocks.constructed).toHaveLength(1);
    expect(mocks.systems[0]).toContain("--- [A] slide 2: Red blood cells");
    expect(mocks.systems[0]).toContain("--- [B] slide 3: Nerve cells");
    expect(mocks.systems[0]).toContain(`narration: ${NARRATION.s2}`);
    expect(mocks.systems[0]).toContain(`narration: ${NARRATION.s3}`);
    expect(lastText(mocks.opts[0])).toContain('Compare "Red blood cells" with "Nerve cells"');
    expect(lastText(mocks.opts[0])).toContain("the differences, drawn only from the two narrations");
  });

  it("the MODEL choosing board.explain gets the narration-grounded text in place of its own (two providers: the turn's, then the teaching call's)", async () => {
    mocks.manifest = READY;
    mocks.queue = [
      [{ toolCalls: [{ id: "c1", name: "board__explain", args: { concept: "red blood cells" } }] }, { text: ["Here is what the heading says."] }],
      [{ text: ["Red blood cells carry oxygen using haemoglobin."] }],
    ];
    const ev = await readEvents(await POST(req(turn("I think they are lost on the red blood cells"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "board", "done"]);
    expect(ev[1]).toMatchObject({ name: "board.explain", ok: true });
    expect(ev[2]).toEqual({ type: "text", text: "Red blood cells carry oxygen using haemoglobin." });
    expect(ev[3]).toMatchObject({ type: "board", move: "slide", args: { k: 1 } });
    expect(ev[4]).toMatchObject({ label: "grounded", sources: ["board.explain", "manifest"], usage: { inputTokens: 300, outputTokens: 150 } });
    expect(mocks.constructed).toHaveLength(2);
    expect(mocks.opts.at(-1)?.tools).toBeUndefined();
    expect(mocks.systems.at(-1)).toContain(`narration: ${NARRATION.s2}`);
    expect(auditRows().find((r) => r.action === "board.explain")).toMatchObject({ session_id: "sess-1" });
  });

  it("without a generation on the Board state the slide move stands alone (slice B shape), no model", async () => {
    mocks.manifest = READY;
    const { generationId: _g, ...noGen } = BOARD;
    void _g;
    const ev = await readEvents(await POST(req(turn("explain red blood cells", { collector: { path: "/present", locale: "en", board: noGen } }))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "board", "done"]);
    expect(ev[3]).toMatchObject({ label: "grounded", sources: ["board.explain"] });
    expect(mocks.constructed).toEqual([]);
  });
});

describe("practise is stamped with the q_ids mapped to the current segment (slice C)", () => {
  it("ready manifest → the move and the audit row carry the first n worksheet-first items of the current segment", async () => {
    mocks.manifest = READY;
    const ev = await readEvents(await POST(req(turn("give them two questions"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "board", "done"]);
    expect(ev[2]).toEqual({ type: "board", move: "practise", args: { n: 2, k: 1, segmentId: "s2", items: ["ws:q3", "ws:q4"] }, say: "2 questions for the class." });
    const row = auditRows().find((r) => r.action === "board.practise");
    expect(row).toMatchObject({ session_id: "sess-1", params: { n: 2, items: ["ws:q3", "ws:q4"] } });
    expect(mocks.constructed).toEqual([]);
  });
  it("manifest not ready → the slice B move exactly, nothing stamped", async () => {
    mocks.manifest = { status: "building" };
    const ev = await readEvents(await POST(req(turn("give them two questions"))));
    expect(ev[2]).toEqual({ type: "board", move: "practise", args: { n: 2, k: 1, segmentId: "s2" }, say: "2 questions for the class." });
  });
});

// ── Starting a lesson with no Board session (§2.7; live gap 2026-10-28) ──────
//
// On /present with nothing open, "start the video" used to refuse ("no
// board"), navigate to the page she was already on and let the model narrate
// the confusion. Now: the bar's pick → the timetable → a fixed line, and a
// deep link with autostart=1 does the starting on the page. No model on any
// of these paths.

const idleBoard = (text: string, extra: Record<string, unknown> = {}) => turn(text, { collector: { path: "/present", locale: "en", ...extra } });
const SHAPE = { timetable: { days: 5, periodMinutes: 45, periods: [{ label: "P1", time: "07:45" }, { label: "P2", time: "08:30" }, { label: "P3", time: "09:15" }] } };
const CLOCK = { day: 3, minutes: 510, iso: "2026-10-28T08:30:00+08:00" };
const BOOK = { id: "b1", title: "Cambridge Biology", owner_id: TEACHER_ID, school_id: SCHOOL_ID, subject: "Science", status: "ready", chapters: [{ num: 2, title: "Specialised Cells" }] };

describe("'start the video' / 'start the lesson' with no Board session", () => {
  it("on /present with nothing picked and no timetable → the fixed line, no navigate, no model", async () => {
    const ev = await readEvents(await POST(req(idleBoard("start the video"))));
    expect(ev[0]).toMatchObject({ type: "meta", intent: "navigate" });
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect(ev[1]).toMatchObject({ type: "tool", name: "timetable.now_next", ok: true });
    expect(ev[2]).toEqual({ type: "text", text: LESSON_NOT_STARTED.en });
    expect(ev[3]).toMatchObject({ type: "done", label: "declined", sources: [] });
    expect(ev.find((e) => e.type === "navigate")).toBeUndefined();
    expect(ev.find((e) => e.type === "board")).toBeUndefined();
    expect(mocks.constructed).toEqual([]);
  });
  it("…in the user's locale", async () => {
    const ev = await readEvents(await POST(req(idleBoard("start the lesson", { locale: "ms" }))));
    expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: LESSON_NOT_STARTED.ms });
  });
  it("another Board phrasing on the idle Board ('pause') → the fixed line too; never a navigate to the page she is on", async () => {
    const ev = await readEvents(await POST(req(idleBoard("pause"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect(ev[0]).toMatchObject({ intent: "teach" });
    expect(ev[1]).toMatchObject({ type: "tool", name: "board.pause", ok: false });
    expect(ev[2]).toEqual({ type: "text", text: LESSON_NOT_STARTED.en });
    expect(ev[3]).toMatchObject({ label: "declined" });
    expect(mocks.constructed).toEqual([]);
  });
  it("with the bar's pick in the collector (hers) → navigate to the same page with the pick + autostart=1", async () => {
    session = fakeSession({ ...tables(), books: [BOOK] }, { user: USER });
    mocks.createClient.mockResolvedValue(session);
    const ev = await readEvents(await POST(req(idleBoard("start the video", { selection: { classId: "c7b", bookId: "b1", chapterRef: "2" } }))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "navigate", "done"]);
    expect(ev[1]).toMatchObject({ type: "tool", name: "navigate", ok: true });
    expect(ev[2]).toEqual({ type: "text", text: "Opening Classroom board." });
    expect(ev[3]).toEqual({ type: "navigate", path: "/present?class=c7b&book=b1&chapter=2&autostart=1", label: "Classroom board" });
    expect(ev[4]).toMatchObject({ label: "navigation", sources: ["navigate"] });
    expect(mocks.constructed).toEqual([]);
  });
  it("a picked book the session cannot see is NOT started from: falls through to the fixed line", async () => {
    const ev = await readEvents(await POST(req(idleBoard("start the video", { selection: { bookId: "b-not-mine", chapterRef: "2" } }))));
    expect(ev.find((e) => e.type === "navigate")).toBeUndefined();
    expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: LESSON_NOT_STARTED.en });
  });
  it("a picked ready-made kit (her own presentation) → ?kit=…&autostart=1", async () => {
    session = fakeSession({ ...tables(), generations: [{ id: "g-kit", owner_id: TEACHER_ID }] }, { user: USER });
    mocks.createClient.mockResolvedValue(session);
    const ev = await readEvents(await POST(req(idleBoard("start the lesson", { selection: { classId: "c7b", generationId: "g-kit" } }))));
    expect(ev.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/present?class=c7b&kit=g-kit&autostart=1", label: "Classroom board" });
  });
  it("with timetable context (in a lesson, class with a last-taught book/chapter) → navigate with those + autostart, saying which lesson", async () => {
    session = fakeSession(
      {
        ...tables(),
        schools: [{ config: SHAPE }],
        timetable_slots: [{ class_id: "c7b", day: 3, period: 2, subject: "Science", teacher_id: TEACHER_ID, room: null, kind: "lesson" }],
        present_last_taught: [{ teacher_id: TEACHER_ID, class_id: "c7b", subject: "Science", book_id: "b1", chapter_num: 2, part: 1 }],
        books: [BOOK],
      },
      { user: USER },
    );
    mocks.createClient.mockResolvedValue(session);
    const ev = await readEvents(await POST(req(idleBoard("start the video", { clock: CLOCK }))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "tool", "text", "navigate", "done"]);
    expect(ev[1]).toMatchObject({ type: "tool", name: "timetable.now_next", ok: true });
    expect(ev[2]).toMatchObject({ type: "tool", name: "navigate", ok: true });
    expect(ev[3]).toEqual({ type: "text", text: "Starting 7B · Science · Specialised Cells." });
    expect(ev[4]).toEqual({ type: "navigate", path: "/present?class=c7b&book=b1&chapter=2&autostart=1", label: "Classroom board" });
    expect(ev[5]).toMatchObject({ label: "navigation", sources: ["timetable.now_next", "navigate"] });
    expect(mocks.constructed).toEqual([]);
    expect(session.log.filter((l) => /insert|update|rpc\./.test(l))).toEqual([]);
  });
  it("off the Board: 'open the board for 7B on Specialised Cells' → class + the book's kit → deep link with autostart", async () => {
    session = fakeSession(
      {
        ...tables(),
        books: [BOOK],
        generations: [{ id: "g1", title: "Specialised Cells · Presentation", status: "done", kind: "presentation", chapter_ref: "2", book_id: "b1", created_at: "2026-10-20T00:00:00Z" }],
      },
      { user: USER },
    );
    mocks.createClient.mockResolvedValue(session);
    const ev = await readEvents(await POST(req(offBoard("open the board for 7B on Specialised Cells"))));
    expect(ev.filter((e) => e.type === "tool").map((e) => e.name)).toEqual(["context.resolve", "library.find", "navigate"]);
    expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: "Opening Classroom board." });
    expect(ev.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/present?class=c7b&book=b1&chapter=2&autostart=1", label: "Classroom board" });
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "navigation", sources: ["context.resolve", "library.find", "navigate"] });
    expect(mocks.constructed).toEqual([]);
  });
  it("off the Board: 'open the board with Plant and Animal Cells' → the ready-made kit (book_id null) → ?kit=…&autostart=1", async () => {
    session = fakeSession(
      {
        ...tables(),
        generations: [
          { id: "g-ws", title: "Plant and Animal Cells Compared · Worksheet", status: "done", kind: "worksheet", chapter_ref: null, book_id: null, created_at: "2026-10-21T00:00:00Z" },
          { id: "g2", title: "Plant and Animal Cells Compared · Plant and Animal Cells Compared", status: "done", kind: "presentation", chapter_ref: null, book_id: null, created_at: "2026-10-20T00:00:00Z" },
        ],
      },
      { user: USER },
    );
    mocks.createClient.mockResolvedValue(session);
    const ev = await readEvents(await POST(req(offBoard("open the board with Plant and Animal Cells"))));
    expect(ev.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/present?kit=g2&autostart=1", label: "Classroom board" });
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "navigation", sources: ["library.find", "navigate"] });
  });
  it("off the Board with nothing to go on: the way to the Board (plain), and a kit it could not find is said", async () => {
    const plain = await readEvents(await POST(req(offBoard("start the lesson"))));
    expect(plain.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/present", label: "Classroom board" });
    expect(plain.find((e) => e.type === "text")).toEqual({ type: "text", text: "Opening Classroom board." });
    const missing = await readEvents(await POST(req(offBoard("open the board with Volcanoes"))));
    expect(missing.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/present", label: "Classroom board" });
    expect(missing.find((e) => e.type === "text")).toEqual({ type: "text", text: `I couldn't find kit "Volcanoes" — Opening Classroom board.` });
    expect(mocks.constructed).toEqual([]);
  });
  it("a bare 'open the board' is unchanged: /present, no autostart", async () => {
    const ev = await readEvents(await POST(req(offBoard("open the board"))));
    expect(ev.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/present", label: "Classroom board" });
  });
});
