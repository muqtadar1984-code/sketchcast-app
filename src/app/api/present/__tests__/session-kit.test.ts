/**
 * POST /api/present/session with `kitId` (a ready-made kit: a catalogue kit
 * copied into the library, book_id and chapter_ref null):
 *   - her own done book-less presentation → a session with book_id null,
 *     chapter_num null and subject = the kit's title prefix;
 *   - somebody else's kit, a kit of a book, a worksheet, an unknown or
 *     malformed id → 400, nothing inserted;
 *   - the book + chapter path is unchanged.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/present/__tests__/session-kit.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Rows = Record<string, unknown>[];
const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Rows>,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  log: [] as string[],
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeAdmin() {
  return {
    from: (table: string) => {
      const b: any = {};
      let single = false;
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const chain = (name: string) => (...args: unknown[]) => {
        mocks.log.push(`${table}.${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
        if (name === "eq") filters.push((r) => r[args[0] as string] === args[1]);
        return b;
      };
      for (const m of ["select", "eq", "limit", "order"]) b[m] = chain(m);
      b.insert = (row: Record<string, unknown>) => {
        mocks.inserts.push({ table, row });
        return { select: () => ({ single: async () => ({ data: { id: "sess-new" }, error: null }) }) };
      };
      b.maybeSingle = () => {
        single = true;
        return b;
      };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        const rows = (mocks.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(res, rej);
      };
      return b;
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock("@/utils/present/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    NOT_FOUND: () => NextResponse.json({ error: "Not found." }, { status: 404 }),
    caller: async () => ({ userId: "teacher-1", admin: fakeAdmin() }),
    ownedSession: async () => null,
    jsonBody: async (r: Request) => r.json(),
  };
});

import { POST } from "@/app/api/present/session/route";

const KIT = "8c73897d-d9e3-47c8-a699-03662d84da3e";
const OTHERS = "11111111-1111-4111-8111-111111111111";
const BOOKED = "22222222-2222-4222-8222-222222222222";
const WORKSHEET = "33333333-3333-4333-8333-333333333333";
const req = (body: unknown) => new Request("http://x/api/present/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  mocks.inserts = [];
  mocks.log = [];
  mocks.tables = {
    generations: [
      { id: KIT, title: "Plant and Animal Cells Compared · Plant and Animal Cells Compared", owner_id: "teacher-1", book_id: null, kind: "presentation", status: "done", withdrawn_at: null },
      { id: OTHERS, title: "Osmosis · Osmosis", owner_id: "teacher-2", book_id: null, kind: "presentation", status: "done", withdrawn_at: null },
      { id: BOOKED, title: "Specialised Cells · Presentation", owner_id: "teacher-1", book_id: "b1", kind: "presentation", status: "done", withdrawn_at: null },
      { id: WORKSHEET, title: "Plant and Animal Cells Compared · Worksheet", owner_id: "teacher-1", book_id: null, kind: "worksheet", status: "done", withdrawn_at: null },
    ],
    classes: [{ id: "c7b", teacher_id: "teacher-1" }],
    timetable_slots: [],
    profiles: [{ id: "teacher-1", school_id: "school-1" }],
  };
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/present/session {kitId}", () => {
  it("her own book-less presentation starts a lesson with no book, no chapter and the kit's name as the subject", async () => {
    const res = await POST(req({ kitId: KIT, classId: "c7b", subject: "Science", slotDay: 3, slotPeriod: 2 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "sess-new" });
    expect(mocks.inserts).toHaveLength(1);
    expect(mocks.inserts[0]).toMatchObject({
      table: "present_sessions",
      row: { teacher_id: "teacher-1", school_id: "school-1", class_id: "c7b", subject: "Plant and Animal Cells Compared", book_id: null, chapter_num: null, slot_day: 3, slot_period: 2 },
    });
  });
  it.each([
    ["somebody else's kit", OTHERS],
    ["a kit that belongs to a book", BOOKED],
    ["a worksheet, not a presentation", WORKSHEET],
    ["an unknown id", "44444444-4444-4444-8444-444444444444"],
    ["a malformed id", "not-a-uuid"],
  ])("%s → 400 and nothing inserted", async (_what, kitId) => {
    const res = await POST(req({ kitId, classId: null }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That is not your kit." });
    expect(mocks.inserts).toEqual([]);
  });
  it("the book + chapter path is unchanged, and a body with neither is still refused", async () => {
    const ok = await POST(req({ bookId: "b1", chapterNum: 2, classId: null, subject: "Science" }));
    expect(ok.status).toBe(200);
    expect(mocks.inserts[0].row).toMatchObject({ book_id: "b1", chapter_num: 2, subject: "Science" });
    const bad = await POST(req({ classId: "c7b" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "A book and chapter are required." });
  });
});
