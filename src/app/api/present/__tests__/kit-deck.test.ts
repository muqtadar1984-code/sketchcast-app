/**
 * GET /api/present/kit — the slide deck on the Board's rail (Board UX
 * 2026-10-28). In both the `?book=&chapter=` and the `?kit=` paths the kit's
 * `deck` generation arrives as a document that does NOT project and carries a
 * signed download of its .pptx (artifact kind deck_pptx), named Deck.pptx;
 * every other document still downloads its docx.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/present/__tests__/kit-deck.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  rows: [] as Row[],
  filters: [] as string[],
  signed: [] as { path: string; ttl: number; download?: string }[],
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
function query(rows: Row[]) {
  const b: any = {};
  const keep: Array<(r: Row) => boolean> = [];
  b.select = () => b;
  b.eq = (col: string, v: unknown) => {
    mocks.filters.push(`eq:${col}`);
    keep.push((r) => r[col] === v);
    return b;
  };
  b.is = (col: string, v: unknown) => {
    mocks.filters.push(`is:${col}`);
    keep.push((r) => (r[col] ?? null) === v);
    return b;
  };
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows.filter((r) => keep.every((f) => f(r))), error: null }).then(res, rej);
  return b;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "teacher-1" } } }) },
    from: () => query(mocks.rows),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async (path: string, ttl: number, opts?: { download?: string }) => {
          mocks.signed.push({ path, ttl, download: opts?.download });
          return { data: { signedUrl: `https://signed/${path}${opts?.download ? `?download=${opts.download}` : ""}` } };
        },
      }),
    },
  }),
}));
vi.mock("@/utils/present/entitlement", () => ({ presentEntitled: async () => ({ ok: true }) }));

import { GET } from "@/app/api/present/kit/route";

const KIT = "8c73897d-d9e3-47c8-a699-03662d84da3e";
const base = { owner_id: "teacher-1", status: "done", withdrawn_at: null };

type Doc = { id: string; kind: string; projects: boolean; note?: string; download: string | null; questions: string | null };
type Reply = { units: { video: { id: string; urls: string[] } | null; docs: Doc[] }[]; picker: unknown[] };

beforeEach(() => {
  mocks.filters = [];
  mocks.signed = [];
});

describe("the book + chapter path", () => {
  beforeEach(() => {
    mocks.rows = [
      { ...base, id: "pres", book_id: "b1", kind: "presentation", title: "Cells", chapter_ref: "3", params: { part: 2 }, artifacts: [{ kind: "video_mp4", storage_path: "u/pres/lesson.mp4" }] },
      { ...base, id: "ws", book_id: "b1", kind: "worksheet", title: "Cells · Worksheet", chapter_ref: "3", params: { part: 2 }, artifacts: [{ kind: "docx", storage_path: "u/ws/ws.docx" }, { kind: "questions_json", storage_path: "u/ws/q.json" }] },
      { ...base, id: "deck", book_id: "b1", kind: "deck", title: "Cells · Deck", chapter_ref: "3", params: { part: 2 }, artifacts: [{ kind: "deck_pptx", storage_path: "u/deck/deck.pptx" }] },
    ];
  });

  it("lists the deck after what projects, as a signed .pptx download named Deck.pptx", async () => {
    const res = await GET(new Request("http://x/api/present/kit?book=b1&chapter=3"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Reply;
    expect(body.units).toHaveLength(1);
    const docs = body.units[0].docs;
    expect(docs.map((d) => d.kind)).toEqual(["worksheet", "deck"]);
    const deck = docs[1];
    expect(deck).toMatchObject({ id: "deck", kind: "deck", projects: false, note: "deck", questions: null });
    expect(deck.download).toBe("https://signed/u/deck/deck.pptx?download=Deck.pptx");
    // The worksheet still downloads its docx and carries its questions.
    expect(docs[0].download).toBe("https://signed/u/ws/ws.docx?download=Worksheet.docx");
    expect(docs[0].questions).toBe("https://signed/u/ws/q.json");
    // Signed for the classroom day (8 h), like everything on the rail.
    expect(mocks.signed.find((x) => x.path === "u/deck/deck.pptx")?.ttl).toBe(8 * 60 * 60);
  });
});

describe("the ready-made kit path (?kit=)", () => {
  beforeEach(() => {
    const P = "Plant and Animal Cells Compared";
    mocks.rows = [
      { ...base, id: KIT, book_id: null, kind: "presentation", title: `${P} · ${P}`, chapter_ref: null, params: {}, artifacts: [{ kind: "video_mp4", storage_path: "u/k/lesson.mp4" }] },
      { ...base, id: "k-ws", book_id: null, kind: "worksheet", title: `${P} · Worksheet`, chapter_ref: null, params: {}, artifacts: [{ kind: "docx", storage_path: "u/k/ws.docx" }, { kind: "questions_json", storage_path: "u/k/q.json" }] },
      { ...base, id: "k-deck", book_id: null, kind: "deck", title: `${P} · Slides`, chapter_ref: null, params: {}, artifacts: [{ kind: "deck_pptx", storage_path: "u/k/deck.pptx" }] },
      // Another kit's deck is not this kit's.
      { ...base, id: "o-deck", book_id: null, kind: "deck", title: "Osmosis · Slides", chapter_ref: null, params: {}, artifacts: [{ kind: "deck_pptx", storage_path: "u/o/deck.pptx" }] },
    ];
  });

  it("the kit's own deck is on the rail as a download; another kit's is not", async () => {
    const res = await GET(new Request(`http://x/api/present/kit?kit=${KIT}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Reply;
    expect(body.picker).toEqual([]);
    const docs = body.units[0].docs;
    expect(docs.map((d) => d.id)).toEqual(["k-ws", "k-deck"]);
    expect(docs[1]).toMatchObject({ kind: "deck", projects: false, note: "deck", download: "https://signed/u/k/deck.pptx?download=Deck.pptx" });
    expect(mocks.filters).toContain("is:book_id");
  });
});
