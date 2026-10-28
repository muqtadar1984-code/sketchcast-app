/**
 * POST /api/present/recap, S1 slice C: the draft is pre-filled with what SK did.
 *   - the route reads sk_actions (kind "board") for THIS present session with
 *     the admin client, oldest first, and the fallback sentence names what SK
 *     explained (no model configured → no model call, no reservation);
 *   - a missing table (0163 unapplied) or a read error changes nothing: the
 *     slice B draft, no failure;
 *   - the draft is saved to present_sessions.recap_draft as before.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/present/__tests__/recap-sk.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_EN } from "@/utils/present/recap";

type Rows = Record<string, unknown>[];
const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Rows | Error>,
  log: [] as string[],
  updates: [] as { table: string; patch: Record<string, unknown> }[],
  session: null as Record<string, unknown> | null,
  claude: false,
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeAdmin() {
  return {
    from: (table: string) => {
      const b: any = {};
      let single = false;
      const chain = (name: string) => (...args: unknown[]) => {
        mocks.log.push(`${table}.${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
        return b;
      };
      for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = chain(m);
      b.update = (patch: Record<string, unknown>) => {
        mocks.updates.push({ table, patch });
        return b;
      };
      b.maybeSingle = () => {
        single = true;
        return b;
      };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        const rows = mocks.tables[table];
        if (rows instanceof Error) return Promise.resolve({ data: null, error: { message: rows.message } }).then(res, rej);
        const data = rows ?? [];
        return Promise.resolve({ data: single ? (data[0] ?? null) : data, error: null }).then(res, rej);
      };
      return b;
    },
    rpc: async (fn: string) => {
      mocks.log.push(`rpc.${fn}`);
      return { data: true, error: null };
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock("@/utils/present/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    NOT_FOUND: () => NextResponse.json({ error: "Not found." }, { status: 404 }),
    caller: async () => ({ userId: "teacher-1", admin: fakeAdmin() }),
    ownedSession: async () => mocks.session,
    jsonBody: async (r: Request) => r.json(),
  };
});
vi.mock("@/utils/tutor/service", () => ({ anthropic: () => ({}), claudeConfigured: () => mocks.claude, claudeModel: (m: string) => m }));
vi.mock("@/i18n/resolve", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/i18n/dictionaries", () => ({ getDictionary: async () => ({ present: { fallback: FALLBACK_EN } }) }));

import { POST } from "@/app/api/present/recap/route";

const SESSION = { id: "sess-1", teacher_id: "teacher-1", book_id: "book-1", class_id: "c7b", chapter_num: 3, ended_at: "2026-10-28T09:00:00Z", page_count: 3, recap_body: null, recap_published_at: null };
const req = (body: unknown) => new Request("http://x/api/present/recap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const at = (m: number) => `2026-10-28T08:${String(m).padStart(2, "0")}:00Z`;

beforeEach(() => {
  mocks.log = [];
  mocks.updates = [];
  mocks.claude = false;
  mocks.session = { ...SESSION };
  mocks.tables = {
    present_items: [{ kind: "video", detail: { chapterNum: 3, part: 1 } }],
    books: [{ chapters: [{ title: "Ch1" }, { title: "Ch2" }, { title: "Ch3" }, { title: "Cells" }] }],
    chapter_grounding: [{ chapter_num: 3, chapter_title: null, concepts: ["cell membrane", "nucleus"], script_text: "Cells are the units of life.", source_text: null }],
    sk_actions: [
      { action: "board.intro", params: {}, ok: true, at: at(0), result: null },
      { action: "board.explain", params: { concept: "red blood cells" }, ok: true, at: at(5), result: { summary: "Showing slide 2: Red blood cells." } },
      { action: "board.practise", params: { n: 2, items: ["ws:q3", "ws:q4"] }, ok: true, at: at(9), result: { summary: "2 practice questions on the roll." } },
    ],
  };
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/present/recap pre-filled with SK's moves (slice C)", () => {
  it("reads this session's board rows with the admin client and names what SK explained in the draft", async () => {
    const res = await POST(req({ sessionId: "sess-1" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft: string; source: string; note: string | null };
    expect(body.source).toBe("fallback");
    expect(body.note).toBe("not-configured");
    expect(body.draft).toBe("Worked through Cells. Focused on red blood cells, cell membrane, nucleus.");
    // The read: sk_actions, THIS session, kind board, oldest first, bounded.
    const reads = mocks.log.filter((l) => l.startsWith("sk_actions."));
    expect(reads).toEqual(['sk_actions.select("action, params, ok, at, result")', 'sk_actions.eq("session_id","sess-1")', 'sk_actions.eq("kind","board")', 'sk_actions.order("at",{"ascending":true})', "sk_actions.limit(200)"]);
    // No model, so no reservation; the draft is saved as before.
    expect(mocks.log.filter((l) => l.startsWith("rpc."))).toEqual([]);
    expect(mocks.updates).toEqual([{ table: "present_sessions", patch: { recap_draft: body.draft } }]);
  });

  it("no board rows → the slice B draft exactly", async () => {
    mocks.tables.sk_actions = [];
    const body = (await (await POST(req({ sessionId: "sess-1" }))).json()) as { draft: string };
    expect(body.draft).toBe("Worked through Cells. Focused on cell membrane, nucleus.");
  });

  it("the sk_actions table missing (0163 unapplied) or erroring changes nothing and fails nothing", async () => {
    mocks.tables.sk_actions = new Error('relation "public.sk_actions" does not exist');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(req({ sessionId: "sess-1" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { draft: string }).draft).toBe("Worked through Cells. Focused on cell membrane, nucleus.");
    expect(warn).toHaveBeenCalledWith("[present/recap] sk_actions read failed", expect.stringContaining("sk_actions"));
    warn.mockRestore();
  });

  it("a lesson with no chapter shown still gets a draft from what SK explained", async () => {
    mocks.tables.present_items = [];
    const body = (await (await POST(req({ sessionId: "sess-1" }))).json()) as { draft: string; note: string | null };
    expect(body.draft).toBe("Focused on red blood cells.");
    expect(body.note).toBe("not-configured");
  });

  it("an open lesson is still refused before anything is read", async () => {
    mocks.session = { ...SESSION, ended_at: null };
    const res = await POST(req({ sessionId: "sess-1" }));
    expect(res.status).toBe(409);
    expect(mocks.log.filter((l) => l.startsWith("sk_actions."))).toEqual([]);
  });
});

describe("a ready-made kit lesson (book_id null, chapter_num null) drafts a note and never fails", () => {
  const KIT_SESSION = { ...SESSION, book_id: null, chapter_num: null, subject: "Plant and Animal Cells Compared" };
  it("names the kit from the shown generations' title prefix; reads no book and no chapter grounding", async () => {
    mocks.session = { ...KIT_SESSION };
    mocks.tables.present_items = [
      { kind: "video", detail: { bookId: null, kitId: "g-pres", chapterNum: null, part: null }, generation_id: "g-pres" },
      { kind: "worksheet", detail: { bookId: null, kitId: "g-pres", chapterNum: null, part: null }, generation_id: "g-ws" },
    ];
    mocks.tables.generations = [
      { id: "g-pres", title: "Plant and Animal Cells Compared · Plant and Animal Cells Compared" },
      { id: "g-ws", title: "Plant and Animal Cells Compared · Worksheet" },
    ];
    mocks.tables.sk_actions = [];
    const res = await POST(req({ sessionId: "sess-1" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft: string; source: string; note: string | null };
    expect(body.draft).toBe("Focused on Plant and Animal Cells Compared.");
    expect(body.source).toBe("fallback");
    expect(mocks.log.some((l) => l.startsWith("books."))).toBe(false);
    expect(mocks.log.some((l) => l.startsWith("chapter_grounding."))).toBe(false);
    expect(mocks.log).toContain('generations.in("id",["g-pres","g-ws"])');
    expect(mocks.updates).toEqual([{ table: "present_sessions", patch: { recap_draft: body.draft } }]);
  });
  it("with nothing shown yet, the session's subject (the kit's name) stands in", async () => {
    mocks.session = { ...KIT_SESSION };
    mocks.tables.present_items = [];
    mocks.tables.sk_actions = [];
    const body = (await (await POST(req({ sessionId: "sess-1" }))).json()) as { draft: string };
    expect(body.draft).toBe("Focused on Plant and Animal Cells Compared.");
  });
  it("the generations read failing is the subject, never a 500", async () => {
    mocks.session = { ...KIT_SESSION };
    mocks.tables.present_items = [{ kind: "video", detail: {}, generation_id: "g-pres" }];
    mocks.tables.generations = new Error("boom");
    mocks.tables.sk_actions = [];
    const res = await POST(req({ sessionId: "sess-1" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { draft: string }).draft).toBe("Focused on Plant and Animal Cells Compared.");
  });
});
