/**
 * The Board's adopt-on-pick (POST /api/present/adopt, utils/present/adopt.ts):
 *   - a SketchCast chapter → adopt_product_kit for every piece of its ONE
 *     master kit, as HER (the grant is re-checked), the presentation's copy is
 *     the kit; no grant → 404; no kit yet → 409 no_kit;
 *   - a catalogue kit → adopt_catalogue_piece for every piece of a CURRENT
 *     kit; an unlimited tier unlocks it first (free), a capped tier's locked
 *     kit is refused (403 locked) and never unlocked here;
 *   - the route answers {kitId, title}, which the session route accepts.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/present/__tests__/adopt.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "@/sk/knowledge/__tests__/fake-db";
import { adoptCatalogueKit, adoptProductChapter, type AdoptDeps } from "@/utils/present/adopt";

const SYSTEM = "0c0c0c0c-0000-4000-8000-00000000000c";
const ME = "7e7e7e7e-0000-4000-8000-000000000007";
const BOOK = "b0000000-0000-4000-8000-000000000001";
const PRODUCT = "161828e0-32aa-40df-bbf3-16eb32c82504";
const KIT = "c0000000-0000-4000-8000-0000000000aa";

const master = (id: string, kind: string, chapter_ref: string, over: Record<string, unknown> = {}) => ({
  id,
  kind,
  title: `Cells · ${kind}`,
  chapter_ref,
  status: "done",
  owner_id: SYSTEM,
  book_id: BOOK,
  params: {},
  created_at: "2026-10-30T10:00:00Z",
  ...over,
});

function world(opts: { grant?: boolean; allowance?: { eligible: boolean; cap: number | null }; unlocked?: boolean } = {}) {
  const db = fakeDb({
    books: [{ id: BOOK, owner_id: SYSTEM, sk_product_id: PRODUCT, title: "Cells", chapters: [{ num: 0, title: "Cells" }], removed_at: null }],
    generations: [
      master("m-pres", "presentation", "0"),
      master("m-ws", "worksheet", "0"),
      master("m-plan", "lesson_plan", "0"),
      master("m-ch2-ws", "worksheet", "1"), // chapter 2 has documents but no lesson: no kit yet
      { id: "copy-of-m-pres", title: "Cells — Chapter 1: Cells · Cells" },
      { id: "copy-of-cat-pres", title: "Osmosis · Osmosis" },
    ],
    topic_kits: [{ id: KIT, topic_id: "t-osm", presentation_generation_id: "cat-pres", doc_generation_ids: { worksheet: "cat-ws", case_study: "" } }],
    catalogue_unlocks: opts.unlocked ? [{ id: "u1", user_id: ME, topic_id: "t-osm" }] : [],
  });
  const calls: { fn: string; args?: Record<string, unknown> }[] = [];
  const deps: AdoptDeps = {
    admin: {
      from: db.from,
      rpc: async (fn: string) => (fn === "catalogue_current_kits" ? { data: [{ topic_id: "t-osm", topic_kit_id: KIT, language: "en" }], error: null } : { data: null, error: { message: "nope" } }),
    },
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (fn === "has_book_grant") return { data: opts.grant ?? true, error: null };
      if (fn === "adopt_product_kit" || fn === "adopt_catalogue_piece") return { data: `copy-of-${String(args?.p_source)}`, error: null };
      if (fn === "my_catalogue_allowance") return { data: opts.allowance ?? { eligible: true, cap: null }, error: null };
      if (fn === "unlock_catalogue_kit") return { data: { status: "unlocked" }, error: null };
      return { data: null, error: { message: `unexpected ${fn}` } };
    },
  };
  return { deps, calls };
}

describe("adoptProductChapter", () => {
  it("adopts every piece of the chapter's ONE kit as her, lesson first; the lesson's copy is the kit", async () => {
    const w = world();
    const out = await adoptProductChapter(w.deps, BOOK, 0);
    expect(out).toEqual({ ok: true, kitId: "copy-of-m-pres", title: "Cells — Chapter 1: Cells" });
    expect(w.calls.map((c) => [c.fn, c.args?.p_source ?? c.args?.p_product])).toEqual([
      ["has_book_grant", PRODUCT],
      ["adopt_product_kit", "m-pres"],
      ["adopt_product_kit", "m-plan"],
      ["adopt_product_kit", "m-ws"],
    ]);
  });

  it("no grant → as if there were no book (404), nothing adopted", async () => {
    const w = world({ grant: false });
    expect(await adoptProductChapter(w.deps, BOOK, 0)).toEqual({ ok: false, status: 404, reason: "not_found" });
    expect(w.calls.some((c) => c.fn === "adopt_product_kit")).toBe(false);
  });

  it("a chapter whose kit is not made yet → 409 no_kit", async () => {
    expect(await adoptProductChapter(world().deps, BOOK, 1)).toEqual({ ok: false, status: 409, reason: "no_kit" });
  });

  it("an uploaded book, an unknown or malformed id → 404", async () => {
    const w = world();
    expect((await adoptProductChapter(w.deps, "b0000000-0000-4000-8000-0000000000ff", 0)).ok).toBe(false);
    expect((await adoptProductChapter(w.deps, "not-a-uuid", 0)).ok).toBe(false);
    expect((await adoptProductChapter(w.deps, BOOK, -1)).ok).toBe(false);
  });
});

describe("adoptCatalogueKit", () => {
  it("an unlocked kit: every built piece adopted, the presentation's copy is the kit", async () => {
    const w = world({ allowance: { eligible: true, cap: 5 }, unlocked: true });
    const out = await adoptCatalogueKit(w.deps, ME, KIT);
    expect(out).toEqual({ ok: true, kitId: "copy-of-cat-pres", title: "Osmosis" });
    expect(w.calls.filter((c) => c.fn === "adopt_catalogue_piece").map((c) => c.args?.p_source)).toEqual(["cat-pres", "cat-ws"]);
    expect(w.calls.some((c) => c.fn === "unlock_catalogue_kit")).toBe(false);
  });

  it("an unlimited tier unlocks a locked kit first (free), then adopts", async () => {
    const w = world({ allowance: { eligible: true, cap: null } });
    expect((await adoptCatalogueKit(w.deps, ME, KIT)).ok).toBe(true);
    expect(w.calls.map((c) => c.fn)).toEqual(["my_catalogue_allowance", "unlock_catalogue_kit", "adopt_catalogue_piece", "adopt_catalogue_piece"]);
  });

  it("a capped tier's locked kit is refused and NEVER unlocked here (that spends her weekly allowance)", async () => {
    const w = world({ allowance: { eligible: true, cap: 1 } });
    expect(await adoptCatalogueKit(w.deps, ME, KIT)).toEqual({ ok: false, status: 403, reason: "locked" });
    expect(w.calls.some((c) => c.fn === "unlock_catalogue_kit" || c.fn === "adopt_catalogue_piece")).toBe(false);
  });

  it("an ineligible account, a kit that is not current → refused", async () => {
    expect(await adoptCatalogueKit(world({ allowance: { eligible: false, cap: null } }).deps, ME, KIT)).toEqual({ ok: false, status: 403, reason: "ineligible" });
    expect((await adoptCatalogueKit(world().deps, ME, "c0000000-0000-4000-8000-0000000000bb")).ok).toBe(false);
  });
});

// ── the route ───────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ deps: null as AdoptDeps | null, callerOk: true }));

vi.mock("@/utils/present/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    NOT_FOUND: () => NextResponse.json({ error: "Not found." }, { status: 404 }),
    caller: async () => (mocks.callerOk ? { userId: ME, admin: mocks.deps!.admin } : null),
    jsonBody: async (r: Request) => r.json(),
  };
});
vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({ rpc: (fn: string, args?: Record<string, unknown>) => mocks.deps!.rpc(fn, args) }),
}));

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/present/adopt/route");
  return POST(new Request("http://x/api/present/adopt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
};

describe("POST /api/present/adopt", () => {
  beforeEach(() => {
    mocks.deps = world().deps;
    mocks.callerOk = true;
  });

  it("a SketchCast chapter → 200 {kitId, title} of her own copy", async () => {
    const r = await post({ bookId: BOOK, chapterNum: 0 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ kitId: "copy-of-m-pres", title: "Cells — Chapter 1: Cells" });
  });

  it("a catalogue kit → 200; a chapter with no kit → 409 no_kit; nothing named → 400", async () => {
    expect((await post({ catalogueKit: KIT })).status).toBe(200);
    const none = await post({ bookId: BOOK, chapterNum: 1 });
    expect(none.status).toBe(409);
    expect((await none.json()).reason).toBe("no_kit");
    expect((await post({})).status).toBe(400);
  });

  it("not on the Board's plan, or no grant → 404", async () => {
    mocks.deps = world({ grant: false }).deps;
    expect((await post({ bookId: BOOK, chapterNum: 0 })).status).toBe(404);
    mocks.callerOk = false;
    expect((await post({ catalogueKit: KIT })).status).toBe(404);
  });
});
