/**
 * The Board's adopt-on-pick (POST /api/present/adopt, utils/present/adopt.ts):
 *   - a SketchCast chapter → adopt_product_kit for every piece of ONE of its
 *     CATALOGUE kits (sk_product_kits; the chosen one, else the first in topic
 *     order), as HER (the grant is re-checked, no unlock or allowance), the
 *     lesson's copy is the kit; no grant → 404; no mapped kit → 409 no_kit; a
 *     kit that is not the chapter's → 404;
 *   - a catalogue kit → adopt_catalogue_piece for every piece of a CURRENT
 *     kit; an unlimited tier unlocks it first (free), a capped tier's locked
 *     kit is refused (403 locked) and never unlocked here;
 *   - the route answers {kitId, title}, which the session route accepts.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/present/__tests__/adopt.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "@/sk/knowledge/__tests__/fake-db";
import { adoptCatalogueKit, adoptProductChapter, type AdoptDeps } from "@/utils/present/adopt";

const SYSTEM = "0c0c0c0c-0000-4000-8000-00000000000c"; // the catalogue system account that owns the product book
const ME = "7e7e7e7e-0000-4000-8000-000000000007";
const BOOK = "b0000000-0000-4000-8000-000000000001";
const PRODUCT = "161828e0-32aa-40df-bbf3-16eb32c82504";
const KIT = "c0000000-0000-4000-8000-0000000000aa";
const CELLS_LESSON = "d0000001-0000-4000-8000-000000000000";
const DIFF_LESSON = "d0000002-0000-4000-8000-000000000000";
const MATTER_LESSON = "d0000003-0000-4000-8000-000000000000";

function world(opts: { grant?: boolean; allowance?: { eligible: boolean; cap: number | null }; unlocked?: boolean } = {}) {
  const db = fakeDb({
    books: [{ id: BOOK, owner_id: SYSTEM, sk_product_id: PRODUCT, title: "Cells", chapters: [{ num: 0, title: "Cells" }, { num: 1, title: "Microscopes" }, { num: 5, title: "Diffusion" }], removed_at: null }],
    // release chapter 1 → the cells kit; chapter 6 → two kits (topic order by sort); chapter 2 → none yet
    sk_product_kits: [
      { product_id: PRODUCT, chapter_ref: "1", sort: 0, generation_id: CELLS_LESSON, label: "Cells" },
      { product_id: PRODUCT, chapter_ref: "6", sort: 1, generation_id: DIFF_LESSON, label: "Diffusion in Living Cells" },
      { product_id: PRODUCT, chapter_ref: "6", sort: 0, generation_id: MATTER_LESSON, label: "States of Matter" },
    ],
    generations: [
      { id: `copy-of-${CELLS_LESSON}`, title: "Cells · Cells and Their Parts" },
      { id: `copy-of-${DIFF_LESSON}`, title: "Diffusion · Diffusion in Living Cells" },
      { id: `copy-of-${MATTER_LESSON}`, title: "States of Matter · Particles" },
      { id: "copy-of-cat-pres", title: "Osmosis · Osmosis" },
    ],
    topic_kits: [
      { id: KIT, topic_id: "t-osm", presentation_generation_id: "cat-pres", doc_generation_ids: { worksheet: "cat-ws", case_study: "" }, status: "approved" },
      { id: "k-cells", topic_id: "t-cells", presentation_generation_id: CELLS_LESSON, doc_generation_ids: { worksheet: "cells-ws", lesson_plan: "cells-plan", activity: "" }, status: "approved" },
      { id: "k-cells-old", topic_id: "t-cells", presentation_generation_id: CELLS_LESSON, doc_generation_ids: {}, status: "rejected" },
      { id: "k-diff", topic_id: "t-diff", presentation_generation_id: DIFF_LESSON, doc_generation_ids: { deck: "diff-deck" }, status: "approved" },
      { id: "k-matter", topic_id: "t-matter", presentation_generation_id: MATTER_LESSON, doc_generation_ids: {}, status: "approved" },
    ],
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
  it("adopts every piece of the chapter's catalogue kit as her, lesson first; the lesson's copy is the kit; no unlock, no allowance", async () => {
    const w = world();
    const out = await adoptProductChapter(w.deps, BOOK, 0);
    expect(out).toEqual({ ok: true, kitId: `copy-of-${CELLS_LESSON}`, title: "Cells" });
    expect(w.calls.map((c) => [c.fn, c.args?.p_source ?? c.args?.p_product])).toEqual([
      ["has_book_grant", PRODUCT],
      ["adopt_product_kit", CELLS_LESSON],
      ["adopt_product_kit", "cells-plan"],
      ["adopt_product_kit", "cells-ws"],
    ]);
    expect(w.calls.some((c) => c.fn === "my_catalogue_allowance" || c.fn === "unlock_catalogue_kit" || c.fn === "adopt_catalogue_piece")).toBe(false);
  });

  it("a chapter with several kits: the one she chose, else the first in topic order; a kit not of this chapter → 404", async () => {
    const chosen = world();
    expect(await adoptProductChapter(chosen.deps, BOOK, 5, DIFF_LESSON)).toMatchObject({ ok: true, kitId: `copy-of-${DIFF_LESSON}` });
    expect(chosen.calls.filter((c) => c.fn === "adopt_product_kit").map((c) => c.args?.p_source)).toEqual([DIFF_LESSON, "diff-deck"]);
    expect(await adoptProductChapter(world().deps, BOOK, 5)).toMatchObject({ ok: true, kitId: `copy-of-${MATTER_LESSON}` });
    expect(await adoptProductChapter(world().deps, BOOK, 5, CELLS_LESSON)).toEqual({ ok: false, status: 404, reason: "not_found" });
    expect(await adoptProductChapter(world().deps, BOOK, 5, "not-a-uuid")).toEqual({ ok: false, status: 404, reason: "not_found" });
  });

  it("no grant → as if there were no book (404), nothing adopted", async () => {
    const w = world({ grant: false });
    expect(await adoptProductChapter(w.deps, BOOK, 0)).toEqual({ ok: false, status: 404, reason: "not_found" });
    expect(w.calls.some((c) => c.fn === "adopt_product_kit")).toBe(false);
  });

  it("a chapter with no mapped kit → 409 no_kit", async () => {
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

  it("a SketchCast chapter → 200 {kitId, title} of her own copy; `kit` picks among a chapter's kits", async () => {
    const r = await post({ bookId: BOOK, chapterNum: 0 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ kitId: `copy-of-${CELLS_LESSON}`, title: "Cells" });
    const picked = await post({ bookId: BOOK, chapterNum: 5, kit: DIFF_LESSON });
    expect(await picked.json()).toEqual({ kitId: `copy-of-${DIFF_LESSON}`, title: "Diffusion" });
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
