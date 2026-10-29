/**
 * /api/present/deck-pages — the kit's .pptx on the Board, one slide per page.
 * GET reports ready (signed slides + the text map, found by its row OR by its
 * path when 0166's row is missing), building (a deck_pages job is live) or
 * missing; POST queues the worker's render once, and never for a deck that is
 * not hers.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/present/__tests__/deck-pages.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  user: { id: "teacher-1" } as { id: string } | null,
  entitled: true,
  gens: [] as Row[],
  jobs: [] as Row[],
  inserted: [] as Row[],
  files: new Map<string, string>(),
  signed: [] as { path: string; ttl: number }[],
  downloads: [] as string[],
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
function query(rows: () => Row[]) {
  const b: any = {};
  const keep: Array<(r: Row) => boolean> = [];
  const val = (r: Row, col: string) => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    return m ? ((r[m[1]] as Row | undefined)?.[m[2]] ?? null) : r[col];
  };
  b.select = () => b;
  b.eq = (col: string, v: unknown) => (keep.push((r) => val(r, col) === v), b);
  b.is = (col: string, v: unknown) => (keep.push((r) => (r[col] ?? null) === v), b);
  b.in = (col: string, vs: unknown[]) => (keep.push((r) => vs.includes(r[col])), b);
  b.limit = () => b;
  const result = () => rows().filter((r) => keep.every((f) => f(r)));
  b.maybeSingle = async () => ({ data: result()[0] ?? null, error: null });
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: result(), error: null }).then(res, rej);
  b.insert = async (row: Row) => {
    mocks.inserted.push(row);
    mocks.jobs.push({ ...row, id: `job-${mocks.inserted.length}` });
    return { error: null };
  };
  return b;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user } }) },
    // The member session: generations only (RLS + the route's owner filter).
    from: (t: string) => query(() => (t === "generations" ? mocks.gens : [])),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => query(() => (t === "jobs" ? mocks.jobs : [])),
    storage: {
      from: () => ({
        createSignedUrl: async (path: string, ttl: number) => {
          mocks.signed.push({ path, ttl });
          return { data: { signedUrl: `https://signed/${path}` } };
        },
        download: async (path: string) => {
          mocks.downloads.push(path);
          const text = mocks.files.get(path);
          return text === undefined ? { data: null, error: { message: "Object not found" } } : { data: { text: async () => text }, error: null };
        },
      }),
    },
  }),
}));
vi.mock("@/utils/present/entitlement", () => ({ presentEntitled: async () => ({ ok: mocks.entitled }) }));

import { GET, POST } from "@/app/api/present/deck-pages/route";

const DECK = "d85029cf-d557-4bb8-a522-771fad9887dd";
const OTHER = "0b6f4c1e-2a3d-4e5f-8a9b-1c2d3e4f5a6b";
const PRES = "fac15e8f-42e1-4c54-96e1-969bfac92fb2";
const dir = `teacher-1/${DECK}/deck_pages`;
const pptx = { kind: "deck_pptx", storage_path: `teacher-1/${PRES}/deck.pptx` };
const base = { status: "done", withdrawn_at: null };
const slidesRows = [
  // Out of order, as rows arrive.
  { kind: "slide_png", storage_path: `${dir}/slide_02.png` },
  { kind: "slide_png", storage_path: `${dir}/slide_01.png` },
  { kind: "slide_png", storage_path: `${dir}/slide_10.png` },
];
const MAP = JSON.stringify({
  v: 1,
  renderer: "libreoffice",
  slides: [
    { n: 1, png: "slide_01.png", w: 1920, h: 1080, title: "Cells", notes: "", text: "Cells", words: [], blocks: [] },
    { n: 2, png: "slide_02.png", w: 1920, h: 1080, title: "Organelles", notes: "", text: "", words: [], blocks: [] },
  ],
});

const get = (id: string) => GET(new Request(`http://x/api/present/deck-pages?generationId=${id}`));
const post = (body: unknown) => POST(new Request("http://x/api/present/deck-pages", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  mocks.user = { id: "teacher-1" };
  mocks.entitled = true;
  mocks.jobs = [];
  mocks.inserted = [];
  mocks.files = new Map();
  mocks.signed = [];
  mocks.downloads = [];
  mocks.gens = [
    { ...base, id: DECK, kind: "deck", owner_id: "teacher-1", artifacts: [pptx] },
    // Someone else's deck: the member session would not even return it, but the
    // fake does, so the route's own owner filter is what is under test.
    { ...base, id: OTHER, kind: "deck", owner_id: "teacher-2", artifacts: [{ kind: "deck_pptx", storage_path: `teacher-2/${OTHER}/deck.pptx` }] },
  ];
});

describe("GET", () => {
  it("missing: her own deck, nothing rendered, nothing queued", async () => {
    const r = await get(DECK);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "missing" });
  });

  it("building: a deck_pages job for THIS deck is queued or processing", async () => {
    mocks.jobs = [{ id: "j0", type: "deck_pages", status: "processing", params: { generation_id: DECK } }];
    expect(await (await get(DECK)).json()).toEqual({ status: "building" });
    // A finished job, or a live one for another deck, is not this one building.
    mocks.jobs = [
      { id: "j1", type: "deck_pages", status: "done", params: { generation_id: DECK } },
      { id: "j2", type: "deck_pages", status: "queued", params: { generation_id: OTHER } },
      { id: "j3", type: "deck", status: "queued", params: { generation_id: DECK } },
    ];
    expect(await (await get(DECK)).json()).toEqual({ status: "missing" });
  });

  it("ready, map by its ROW: slides in order, signed 8 h, size and title from the map", async () => {
    mocks.gens[0].artifacts = [pptx, ...slidesRows, { kind: "deck_pages_json", storage_path: `${dir}/pages.json` }];
    mocks.files.set(`${dir}/pages.json`, MAP);
    const body = await (await get(DECK)).json();
    expect(body).toEqual({
      status: "ready",
      slides: [
        { n: 1, path: `${dir}/slide_01.png`, url: `https://signed/${dir}/slide_01.png`, w: 1920, h: 1080, title: "Cells" },
        { n: 2, path: `${dir}/slide_02.png`, url: `https://signed/${dir}/slide_02.png`, w: 1920, h: 1080, title: "Organelles" },
        // Not in the map: the Board's own 16:9 and no title.
        { n: 10, path: `${dir}/slide_10.png`, url: `https://signed/${dir}/slide_10.png`, w: 1600, h: 900, title: "" },
      ],
      mapUrl: `https://signed/${dir}/pages.json`,
      map: `${dir}/pages.json`,
    });
    expect(mocks.signed.every((s) => s.ttl === 8 * 60 * 60)).toBe(true);
  });

  it("ready, map BY PATH when 0166's row is missing; a map that is not there costs the titles, not the pages", async () => {
    mocks.gens[0].artifacts = [pptx, ...slidesRows];
    mocks.files.set(`${dir}/pages.json`, MAP);
    const body = await (await get(DECK)).json();
    expect(mocks.downloads).toEqual([`${dir}/pages.json`]);
    expect(body.map).toBe(`${dir}/pages.json`);
    expect(body.mapUrl).toBe(`https://signed/${dir}/pages.json`);
    expect(body.slides[1].title).toBe("Organelles");

    mocks.files.clear();
    const bare = await (await get(DECK)).json();
    expect(bare.status).toBe("ready");
    expect(bare.slides).toHaveLength(3);
    expect(bare.mapUrl).toBeNull();
    expect(bare.map).toBeNull();
  });

  it("a presentation that carries its own deck*.pptx is a deck source too", async () => {
    mocks.gens.push({ ...base, id: PRES, kind: "presentation", owner_id: "teacher-1", artifacts: [{ kind: "video_mp4", storage_path: "x/lesson.mp4" }, pptx] });
    expect(await (await get(PRES)).json()).toEqual({ status: "missing" });
    // …but a presentation without one is not.
    mocks.gens[mocks.gens.length - 1].artifacts = [{ kind: "video_mp4", storage_path: "x/lesson.mp4" }];
    expect((await get(PRES)).status).toBe(404);
  });

  it("404: someone else's deck, an unknown id, a bad id, signed out, not entitled", async () => {
    expect((await get(OTHER)).status).toBe(404);
    expect((await get("9c7a2a52-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
    mocks.user = null;
    expect((await get(DECK)).status).toBe(404);
    mocks.user = { id: "teacher-1" };
    mocks.entitled = false;
    expect((await get(DECK)).status).toBe(404);
  });
});

describe("POST", () => {
  it("queues ONE deck_pages observer job for her deck, then answers building", async () => {
    const r = await post({ generationId: DECK });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "building" });
    expect(mocks.inserted).toEqual([{ type: "deck_pages", status: "queued", generation_id: null, params: { generation_id: DECK } }]);
    // Idempotent: a second press finds the live job and queues nothing.
    expect(await (await post({ generationId: DECK })).json()).toEqual({ status: "building" });
    expect(mocks.inserted).toHaveLength(1);
    // …and GET now says building.
    expect(await (await get(DECK)).json()).toEqual({ status: "building" });
  });

  it("a finished job does not block a new one; an already-rendered deck queues nothing", async () => {
    mocks.jobs = [{ id: "old", type: "deck_pages", status: "error", params: { generation_id: DECK } }];
    await post({ generationId: DECK });
    expect(mocks.inserted).toHaveLength(1);

    mocks.inserted = [];
    mocks.jobs = [];
    mocks.gens[0].artifacts = [pptx, ...slidesRows];
    const body = await (await post({ generationId: DECK })).json();
    expect(body.status).toBe("ready");
    expect(mocks.inserted).toEqual([]);
  });

  it("NEVER a job for someone else's deck, an unknown one, or a bad body", async () => {
    expect((await post({ generationId: OTHER })).status).toBe(404);
    expect((await post({ generationId: "9c7a2a52-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await post({})).status).toBe(400);
    expect((await post([DECK])).status).toBe(400);
    expect((await POST(new Request("http://x/api/present/deck-pages", { method: "POST", body: "{" }))).status).toBe(400);
    mocks.entitled = false;
    expect((await post({ generationId: DECK })).status).toBe(404);
    expect(mocks.inserted).toEqual([]);
  });
});
