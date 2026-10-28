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
  constructed: [] as string[],
  systems: [] as string[],
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
        super(mocks.script as StubTurn[]);
        mocks.constructed.push(model);
      }
      async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
        mocks.systems.push(opts.system);
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

import { POST } from "@/app/api/sk/shell/turn/route";
import { SK_CANNOT_CONFIRM } from "@/sk/shell/types";
import { BOARD_NOT_OPEN } from "@/sk/capabilities/board";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

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
  mocks.constructed = [];
  mocks.systems = [];
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
    const ev = await readEvents(await POST(req(offBoard("start the video"))));
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
