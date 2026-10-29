/**
 * S2 acceptance, the routes: "lesson prep lands in the job tray and the next
 * greeting".
 * - GET /api/sk/shell/tray: the Shell gate (404 off, 401 signed out), her
 *   SK-started kits only (another teacher's and Library-started rows never),
 *   at most 3 newest first, each with its state and Library link.
 * - POST /api/sk/shell/context: the greeting LEADS with "Your kit for … is
 *   ready — want me to open it?" once; the next warm start (same conversation,
 *   or a new tab with only the signed note) does not repeat it.
 * - POST /api/sk/shell/turn: "yes" right after that greeting opens the kit's
 *   Library location (no model); "no" declines; the offer lasts one turn.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/tray.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (mocks.cookies[n] ? { value: mocks.cookies[n] } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", () => ({
  AnthropicProvider: class {
    constructor() {
      throw new Error("no model call is expected on these paths");
    }
  },
}));

import { GET as TRAY } from "@/app/api/sk/shell/tray/route";
import { GET as CONTEXT_GET, POST as CONTEXT } from "@/app/api/sk/shell/context/route";
import { POST as TURN } from "@/app/api/sk/shell/turn/route";
import { SK_CHAT_NOTHING_PENDING } from "@/sk/shell/rules";
import { OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_SK", "SK_ROLES", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "FEATURE_DIARY", "FEATURE_SCHOOL_ANALYTICS", "FEATURE_CATALOGUE_TAB", "SK_AUDIT"];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
const BOOK = "b0000000-0000-4000-8000-000000000031";

// The routes stamp `now` from the real clock; the kits are dated from it.
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const DOCS = ["worksheet", "quiz", "answer_key", "notes", "exam_paper", "deck"];
function kit(action: string, chapter: number, hours: number, lesson: string, over: Record<string, unknown> = {}) {
  return ["presentation", ...DOCS].map((kind) => ({
    id: kind === "presentation" ? `${action}-p` : `${action}-${kind}`,
    kind,
    status: lesson,
    title: null,
    chapter_ref: String(chapter),
    book_id: BOOK,
    owner_id: TEACHER_ID,
    params: {},
    created_at: ago(hours),
    sk_action_id: action,
    ...over,
  }));
}
const BOOKS = [{ id: BOOK, title: "Biology", chapters: [0, 1, 2, 3, 4].map((num) => ({ num, title: ["Cell Structure", "Cell Division", "Specialised Cells", "Transport", "Enzymes"][num] })) }];

function signIn(generations: Record<string, unknown>[], user: typeof USER | null = USER) {
  const session = fakeSession(
    { profiles: [{ role: "teacher", school_id: SCHOOL_ID }], schools: [{ config: {} }], coordinator_scope: [], parent_links: [], classes: [], enrollments: [], books: BOOKS, generations },
    { user },
  );
  mocks.createClient.mockResolvedValue(session);
  return session;
}
const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const warm = async (body: Record<string, unknown> = {}) => (await (await CONTEXT(post("http://x/api/sk/shell/context", { path: "/dashboard", ...body }))).json()) as { greeting: string; memory: string; announced: string; sessionId: string };
const turn = (text: string, memory: string) => post("http://x/api/sk/shell/turn", { turnId: `t-${Math.random().toString(36).slice(2)}`, text, modality: "text", collector: { path: "/dashboard", locale: "en" }, memory });

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "tray-route-test-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  process.env.FEATURE_DIARY = "true";
  process.env.FEATURE_SCHOOL_ANALYTICS = "true";
  process.env.FEATURE_CATALOGUE_TAB = "true";
  mocks.cookies = { sc_hat: "teacher" };
  mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

describe("GET /api/sk/shell/tray", () => {
  it("the Shell gate: 404 with FEATURE_SK off, 401 signed out", async () => {
    signIn([]);
    delete process.env.FEATURE_SK;
    expect((await TRAY(new Request("http://x/api/sk/shell/tray"))).status).toBe(404);
    process.env.FEATURE_SK = "true";
    signIn([], null);
    expect((await TRAY(new Request("http://x/api/sk/shell/tray"))).status).toBe(401);
  });
  it("her SK-started kits only, at most 3 newest first, with state and Library link", async () => {
    signIn([
      ...kit("a1", 0, 30, "done"),
      ...kit("a2", 1, 20, "error"),
      ...kit("a3", 2, 2, "processing"),
      ...kit("a4", 3, 1, "queued"),
      ...kit("x1", 4, 0.5, "done", { owner_id: OTHER_TEACHER_ID }),
      ...kit("lib", 4, 0.2, "done", { sk_action_id: null }),
    ]);
    const res = await TRAY(new Request("http://x/api/sk/shell/tray?path=/dashboard"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kits: Array<Record<string, unknown>> };
    expect(body.kits).toEqual([
      { id: "a4-p", title: "Transport", state: "making", ready: 0, total: 7, href: `/dashboard?book=${BOOK}` },
      { id: "a3-p", title: "Specialised Cells", state: "making", ready: 0, total: 7, href: `/dashboard?book=${BOOK}` },
      { id: "a2-p", title: "Cell Division", state: "failed", ready: 0, total: 7, href: `/dashboard?book=${BOOK}` },
    ]);
  });
  it("empty when she has none (the panel hides the tray)", async () => {
    signIn([]);
    expect(await (await TRAY(new Request("http://x/api/sk/shell/tray"))).json()).toEqual({ kits: [] });
  });
});

describe("the next greeting", () => {
  const READY = "Your kit for Specialised Cells is ready — want me to open it?";
  it("leads with the ready line ONCE — not again in the same conversation, nor in a new tab with the note", async () => {
    signIn(kit("a3", 2, 1, "done"));
    const first = await warm();
    expect(first.greeting.split("\n")).toEqual([READY, "Hi — I'm SK. Ask me about your classes, or tell me where to go."]);
    const again = await warm({ memory: first.memory, announced: first.announced });
    expect(again.greeting).not.toContain(READY);
    expect(again.sessionId).toBe(first.sessionId); // the same conversation carried on
    const newTab = await warm({ announced: again.announced });
    expect(newTab.greeting).not.toContain(READY);
    // GET (no body) still answers; it knows nothing announced.
    expect(((await (await CONTEXT_GET(new Request("http://x/api/sk/shell/context"))).json()) as { greeting: string }).greeting).toContain(READY);
  });
  it("the failed line", async () => {
    signIn(kit("a3", 2, 1, "error"));
    expect((await warm()).greeting.split("\n")[0]).toBe("The kit for Specialised Cells didn't finish — ask me to try again, or check the Library.");
  });
  it("a kit still being made: the plain greeting", async () => {
    signIn(kit("a3", 2, 1, "processing"));
    expect((await warm()).greeting).toBe("Hi — I'm SK. Ask me about your classes, or tell me where to go.");
  });
  it("“yes” right after it opens the kit's Library location, deterministically", async () => {
    signIn(kit("a3", 2, 1, "done"));
    const { memory } = await warm();
    const ev = await readEvents(await TURN(turn("yes", memory)));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "navigate", "done"]);
    expect(ev[1]).toMatchObject({ name: "navigate", ok: true });
    expect(ev[3]).toMatchObject({ type: "navigate", path: `/dashboard?book=${BOOK}`, label: "Library" });
    expect(ev[4]).toMatchObject({ label: "navigation", sources: ["navigate"] });
    // The offer lasted one turn: a second "yes" is a plain acknowledgement.
    const next = await readEvents(await TURN(turn("yes", ev[4].memory as string)));
    expect(next.find((e) => e.type === "text")).toMatchObject({ text: SK_CHAT_NOTHING_PENDING });
  });
  it("“open it” opens it too; “no” declines with SK's line", async () => {
    signIn(kit("a3", 2, 1, "done"));
    const { memory } = await warm();
    expect((await readEvents(await TURN(turn("open it", memory)))).find((e) => e.type === "navigate")).toMatchObject({ path: `/dashboard?book=${BOOK}` });
    const no = await readEvents(await TURN(turn("no", memory)));
    expect(no.find((e) => e.type === "text")).toMatchObject({ text: "All right — it's in your Library whenever you need it." });
    expect(no.some((e) => e.type === "navigate")).toBe(false);
  });
});
