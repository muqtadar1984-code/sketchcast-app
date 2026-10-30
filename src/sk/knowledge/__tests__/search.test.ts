// SK S7 K1 — sk_search_knowledge's call shape from TS (a fake RPC): the app
// passes ONLY allowed sources, the function never decides access.
// Run: node node_modules/vitest/vitest.mjs run src/sk/knowledge/__tests__/search.test.ts
import { describe, expect, it, vi } from "vitest";
import { searchKnowledge } from "../search";

describe("searchKnowledge", () => {
  it("calls sk_search_knowledge with p_query, p_lang, p_sources, p_chapter, p_limit and maps the rows", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ id: "7", source_kind: "sketchcast_book", source_id: "mle", version: "12", chapter: 1, anchor: "s1", title: "Why letters?", text: "A <b>letter</b> can stand…", rank: "0.4" }],
      error: null,
    }));
    const r = await searchKnowledge({ rpc }, {
      query: "  what is a variable  ",
      lang: "en",
      sources: [{ kind: "sketchcast_book", id: "mle", version: "12" }, { kind: "article" }, { kind: "user_book", id: "b1" }],
      chapter: 1,
      limit: 5,
    });
    expect(rpc).toHaveBeenCalledWith("sk_search_knowledge", {
      p_query: "what is a variable",
      p_lang: "en",
      p_sources: [{ kind: "sketchcast_book", id: "mle", version: "12" }, { kind: "article" }, { kind: "user_book", id: "b1" }],
      p_chapter: 1,
      p_limit: 5,
    });
    expect(r).toEqual({ status: "ok", hits: [{ id: 7, source_kind: "sketchcast_book", source_id: "mle", version: "12", chapter: 1, anchor: "s1", title: "Why letters?", text: "A <b>letter</b> can stand…", rank: 0.4 }] });
  });

  it("never sends a book or upload source without an id; no sources or no query → no call", async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    await searchKnowledge({ rpc }, { query: "x", lang: "ar", sources: [{ kind: "user_book" }, { kind: "sketchcast_book" }, { kind: "article" }] });
    expect(rpc).toHaveBeenCalledWith("sk_search_knowledge", { p_query: "x", p_lang: "ar", p_sources: [{ kind: "article" }], p_chapter: null, p_limit: 8 });
    rpc.mockClear();
    expect(await searchKnowledge({ rpc }, { query: "x", lang: "en", sources: [{ kind: "user_book" }] })).toEqual({ status: "ok", hits: [] });
    expect(await searchKnowledge({ rpc }, { query: "  ", lang: "en", sources: [{ kind: "article" }] })).toEqual({ status: "ok", hits: [] });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("caps the limit at 50 and reports an RPC error", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "function sk_search_knowledge does not exist" } }));
    const r = await searchKnowledge({ rpc }, { query: "x", lang: "en", sources: [{ kind: "article" }], limit: 500 });
    expect((rpc.mock.calls[0] as unknown[])[1]).toMatchObject({ p_limit: 50 });
    expect(r).toEqual({ status: "error", message: "function sk_search_knowledge does not exist" });
  });
});
