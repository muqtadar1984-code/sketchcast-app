// SK retrieval (R1): the hybrid provider's gate, per-turn cache and row
// shaping; the FTS default; provider selection by env; the Titan embedder
// over a mocked InvokeModel; and the loop's use of a grounding result (book
// passages ride in the user turn, "none" is answered without a model call,
// an error degrades to unit-only grounding). No network anywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { TitanEmbedder, type Embedder } from "../embed";
import { openSession, runCommand, runTurn, type LoopDeps } from "../loop";
import { StaticItemBank } from "../items";
import {
  __resetRetrievalWarnings,
  DEFAULT_GATE,
  FtsRetrievalProvider,
  gateDecision,
  HybridRetrievalProvider,
  retrievalGate,
  retrievalMode,
  selectRetrievalProvider,
  toPassages,
  type RetrievalContext,
  type RetrievalDb,
  type RetrievalProvider,
  type RetrievalResult,
  type RetrievedPassage,
  type TurnRetrieval,
} from "../retrieval";
import { InMemorySessionStore } from "../store";
import { NOT_IN_BOOK_TEXT, questionWithPassages } from "../teacher";
import type { SseEvent } from "../types";
import { graph, U4_HITMAP_TARGETS, U4_SEGMENT } from "./fixtures";

const PRODUCT = "d7a8282a-1f23-4ae8-8008-40e3ae458c13";
const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "b1",
  product_id: PRODUCT,
  chapter: 2,
  section_sid: "s5",
  block_index: 2,
  unit_key: "u5",
  block_type: "key_idea",
  content: "Total magnification = eyepiece × objective.",
  score: 0.03,
  fts_score: 0.1,
  vec_score: 0.5,
  best_vec_score: 0.5,
  ...over,
});

/** A fake of the supabase-js slice the providers use: records RPC calls,
 * answers from a script, resolves one slug. */
class FakeDb implements RetrievalDb {
  rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  lookups = 0;
  constructor(
    private readonly answer: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
    private readonly slug = "cells-structure-function-organisation",
  ) {}
  rpc(fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ fn, args });
    return Promise.resolve(this.answer(fn, args));
  }
  from() {
    return {
      select: () => ({
        eq: (_col: string, value: unknown) => ({
          maybeSingle: () => {
            this.lookups += 1;
            return Promise.resolve(value === this.slug ? { data: { id: PRODUCT }, error: null } : { data: null, error: null });
          },
        }),
      }),
    };
  }
}

class FakeEmbedder implements Embedder {
  readonly model = "fake-embed";
  readonly dims = 3;
  calls: string[] = [];
  started = 0;
  constructor(private readonly fail?: string) {}
  embed(text: string): Promise<number[]> {
    this.started += 1;
    this.calls.push(text);
    if (this.fail) return Promise.reject(new Error(this.fail));
    return Promise.resolve([0.1, 0.2, 0.3]);
  }
}

const ctx: RetrievalContext = { product: "cells-structure-function-organisation", chapter: 2 };

beforeEach(() => __resetRetrievalWarnings());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("toPassages (row shaping)", () => {
  it("keeps score order, builds the SourceRef, drops rows outside the requested product/chapter", () => {
    const rows = [row({ id: "lo", score: 0.01 }), row({ id: "hi", score: 0.05, fts_score: null }), row({ id: "leak-chapter", chapter: 9, score: 0.9 }), row({ id: "leak-product", product_id: "00000000-0000-4000-8000-00000000fa4e", score: 0.9 })];
    const { passages, dropped } = toPassages(rows, PRODUCT, 2, "cells-structure-function-organisation");
    expect(dropped).toBe(2);
    expect(passages.map((p) => p.blockId)).toEqual(["hi", "lo"]);
    expect(passages[0]).toMatchObject({ sourceRef: "book:cells-structure-function-organisation/2/s5#2", unitKey: "u5", blockType: "key_idea", ftsScore: null, vecScore: 0.5 });
  });
  it("tolerates a non-array and numeric strings", () => {
    expect(toPassages(null, PRODUCT, 2, "p").passages).toEqual([]);
    expect(toPassages([row({ score: "0.04", vec_score: "0.7" })], PRODUCT, 2, "p").passages[0]).toMatchObject({ score: 0.04, vecScore: 0.7 });
  });
});

describe("gateDecision", () => {
  it("at or above the gate grounds, below gates, no vector score at all is ungated", () => {
    expect(gateDecision(0.32, 0.32)).toBe("grounded");
    expect(gateDecision(0.44, 0.32)).toBe("grounded");
    expect(gateDecision(0.3199, 0.32)).toBe("gate");
    expect(gateDecision(0.2, 0.32)).toBe("gate");
    expect(gateDecision(null, 0.32)).toBe("ungated");
  });
});

describe("HybridRetrievalProvider", () => {
  it("embeds at begin() (before the router), searches once, and result() is the same promise however often it is read", async () => {
    const db = new FakeDb(() => ({ data: [row()], error: null }));
    const emb = new FakeEmbedder();
    const p = new HybridRetrievalProvider(db, emb, { gate: 0.32, now: () => 0 });
    const turn = p.begin("  How do I work out total magnification?  ", ctx);
    expect(emb.started).toBe(1); // started synchronously, not on result()
    const [a, b] = await Promise.all([turn.result(), turn.result()]);
    expect(a).toBe(b);
    expect(emb.calls).toEqual(["How do I work out total magnification?"]);
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]).toEqual({ fn: "sk_search_hybrid", args: { q: "How do I work out total magnification?", qv: [0.1, 0.2, 0.3], p_product: PRODUCT, p_chapter: 2, k: 5, pool: 20, rrf_k: 60 } });
    expect(a.status).toBe("grounded");
    if (a.status === "grounded") {
      expect(a.passages).toHaveLength(1);
      expect(a.bestVecScore).toBe(0.5);
      expect(a.gate).toBe(0.32);
    }
  });
  it("resolves the graph's slug to the product id once per provider; a uuid is never looked up", async () => {
    const db = new FakeDb(() => ({ data: [row()], error: null }));
    const p = new HybridRetrievalProvider(db, new FakeEmbedder());
    await p.begin("q1", ctx).result();
    await p.begin("q2", ctx).result();
    expect(db.lookups).toBe(1);
    await p.begin("q3", { product: PRODUCT.toUpperCase(), chapter: 2 }).result();
    expect(db.lookups).toBe(1);
    expect(db.rpcCalls[2]!.args.p_product).toBe(PRODUCT);
    const r = await p.begin("q4", { product: "no-such-slug", chapter: 2 }).result();
    expect(r).toMatchObject({ status: "error", message: expect.stringContaining("no-such-slug") });
  });
  it("gates on the best VECTOR score of the call: below SK_RETRIEVAL_GATE → none/gate; rows with no vector score at all stand (ungated, logged once)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const offBook = new HybridRetrievalProvider(new FakeDb(() => ({ data: [row({ vec_score: 0.2, best_vec_score: 0.2 }), row({ id: "b2", vec_score: null, best_vec_score: 0.2 })], error: null })), new FakeEmbedder(), { gate: 0.32 });
    const r1 = await offBook.begin("What is photosynthesis?", ctx).result();
    expect(r1).toMatchObject({ status: "none", reason: "gate", bestVecScore: 0.2, gate: 0.32 });
    // the FTS-only top row carries the vector leg's top-1 too, so an fts-first ordering cannot hide a passing vector score
    const mixed = new HybridRetrievalProvider(new FakeDb(() => ({ data: [row({ id: "fts-only", vec_score: null, best_vec_score: 0.44, score: 0.02 }), row({ id: "vec", vec_score: 0.44, best_vec_score: 0.44, score: 0.016 })], error: null })), new FakeEmbedder(), { gate: 0.32 });
    const r2 = await mixed.begin("q", ctx).result();
    expect(r2.status).toBe("grounded");
    if (r2.status === "grounded") expect(r2.bestVecScore).toBe(0.44);
    const unembedded = new HybridRetrievalProvider(new FakeDb(() => ({ data: [row({ vec_score: null, best_vec_score: null })], error: null })), new FakeEmbedder(), { gate: 0.32 });
    expect((await unembedded.begin("q", ctx).result()).status).toBe("grounded");
    expect((await unembedded.begin("q again", ctx).result()).status).toBe("grounded");
    expect(err.mock.calls.filter((c) => String(c[0]).includes("has an embedding"))).toHaveLength(1);
  });
  it("empty rows → none/empty; an RPC error or a failed embedding → error (never a throw), the search is skipped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const empty = new HybridRetrievalProvider(new FakeDb(() => ({ data: [], error: null })), new FakeEmbedder());
    expect(await empty.begin("q", ctx).result()).toMatchObject({ status: "none", reason: "empty" });
    const broken = new HybridRetrievalProvider(new FakeDb(() => ({ data: null, error: { message: "function sk_search_hybrid does not exist" } })), new FakeEmbedder());
    expect(await broken.begin("q", ctx).result()).toMatchObject({ status: "error", message: expect.stringContaining("does not exist") });
    const db = new FakeDb(() => ({ data: [row()], error: null }));
    const denied = new HybridRetrievalProvider(db, new FakeEmbedder("AccessDeniedException: bedrock:InvokeModel"));
    expect(await denied.begin("q", ctx).result()).toMatchObject({ status: "error", message: expect.stringContaining("AccessDenied") });
    expect(db.rpcCalls).toHaveLength(0);
    expect(await denied.begin("   ", ctx).result()).toMatchObject({ status: "none", reason: "empty" });
  });
  it("trims the query to 600 characters and passes the abort signal to the embedder", async () => {
    const db = new FakeDb(() => ({ data: [row()], error: null }));
    const emb = new FakeEmbedder();
    const spy = vi.spyOn(emb, "embed");
    const p = new HybridRetrievalProvider(db, emb);
    const ac = new AbortController();
    await p.begin("x".repeat(700), { ...ctx, signal: ac.signal }).result();
    expect(spy).toHaveBeenCalledWith("x".repeat(600), ac.signal);
    expect(db.rpcCalls[0]!.args.q).toHaveLength(600);
  });
});

describe("FtsRetrievalProvider (default)", () => {
  it("calls sk_search_fts only, grounds on any rows, reports empty otherwise, and folds an RPC error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new FakeDb((fn) => (fn === "sk_search_fts" ? { data: [row({ fts_score: undefined, vec_score: undefined, best_vec_score: undefined })], error: null } : { data: null, error: { message: "wrong fn" } }));
    const p = new FtsRetrievalProvider(db, { now: () => 0 });
    const r = await p.begin("total magnification", ctx).result();
    expect(db.rpcCalls[0]).toEqual({ fn: "sk_search_fts", args: { q: "total magnification", p_product: PRODUCT, p_chapter: 2, k: 5 } });
    expect(r).toMatchObject({ status: "grounded", bestVecScore: null, gate: null });
    if (r.status === "grounded") expect(r.passages[0]).toMatchObject({ ftsScore: null, vecScore: null });
    expect(await new FtsRetrievalProvider(new FakeDb(() => ({ data: [], error: null }))).begin("q", ctx).result()).toMatchObject({ status: "none", reason: "empty" });
    expect(await new FtsRetrievalProvider(new FakeDb(() => ({ data: null, error: { message: "no 0160" } }))).begin("q", ctx).result()).toMatchObject({ status: "error", message: "no 0160" });
  });
});

describe("selection by env", () => {
  const db = new FakeDb(() => ({ data: [], error: null }));
  it("SK_RETRIEVAL unset → fts; hybrid with credentials → hybrid at SK_RETRIEVAL_GATE; hybrid without credentials → fts; off → none; junk → fts", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(selectRetrievalProvider({ db, embedderConfigured: () => true, env: {} })?.id).toBe("fts");
    const hybrid = selectRetrievalProvider({ db, embedder: new FakeEmbedder(), embedderConfigured: () => true, env: { SK_RETRIEVAL: "hybrid", SK_RETRIEVAL_GATE: "0.4" } });
    expect(hybrid?.id).toBe("hybrid");
    expect((hybrid as HybridRetrievalProvider).gate).toBe(0.4);
    expect(selectRetrievalProvider({ db, embedder: new FakeEmbedder(), embedderConfigured: () => false, env: { SK_RETRIEVAL: "hybrid" } })?.id).toBe("fts");
    expect(selectRetrievalProvider({ db, embedderConfigured: () => true, env: { SK_RETRIEVAL: "off" } })).toBeUndefined();
    expect(selectRetrievalProvider({ db, embedderConfigured: () => true, env: { SK_RETRIEVAL: "pinecone" } })?.id).toBe("fts");
    expect(retrievalMode({ SK_RETRIEVAL: " HYBRID " })).toBe("hybrid");
  });
  it("the gate defaults to 0.32 (Titan v2) and refuses values outside [0, 1]", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(DEFAULT_GATE).toBe(0.32);
    expect(retrievalGate({})).toBe(0.32);
    expect(retrievalGate({ SK_RETRIEVAL_GATE: "0.65" })).toBe(0.65);
    expect(retrievalGate({ SK_RETRIEVAL_GATE: "1.5" })).toBe(0.32);
    expect(retrievalGate({ SK_RETRIEVAL_GATE: "abc" })).toBe(0.32);
  });
});

describe("TitanEmbedder (InvokeModel mocked)", () => {
  it("sends inputText/dimensions/normalize, parses the 1024 floats, counts Titan's tokens, rejects the wrong width and empty text", async () => {
    const bodies: string[] = [];
    const good = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    const e = new TitanEmbedder({ invoke: async (body) => (bodies.push(body), JSON.stringify({ embedding: good, inputTextTokenCount: 12 })) });
    expect(e.model).toBe("amazon.titan-embed-text-v2:0");
    const v = await e.embed("  how many   micrometres in a millimetre?  ");
    expect(v).toHaveLength(1024);
    expect(JSON.parse(bodies[0]!)).toEqual({ inputText: "how many micrometres in a millimetre?", dimensions: 1024, normalize: true });
    expect(e.tokens).toBe(12);
    const short = new TitanEmbedder({ invoke: async () => JSON.stringify({ embedding: [1, 2, 3] }) });
    await expect(short.embed("q")).rejects.toThrow(/3 values, expected 1024/);
    await expect(e.embed("   ")).rejects.toThrow(/empty/);
  });
  it("SK_EMBED_MODEL overrides the model id", () => {
    vi.stubEnv("SK_EMBED_MODEL", "amazon.titan-embed-text-v2:1");
    expect(new TitanEmbedder({ invoke: async () => "{}" }).model).toBe("amazon.titan-embed-text-v2:1");
  });
});

describe("questionWithPassages", () => {
  it("numbers the passages with their unit and kind, caps them, and ends with the question", () => {
    const p: RetrievedPassage = { blockId: "b", sourceRef: "book:x/2/s5#2", unitKey: "u5", blockType: "worked_example", text: "A".repeat(900), score: 1, ftsScore: null, vecScore: null };
    const s = questionWithPassages("What is total magnification?", [p, { ...p, unitKey: null, blockType: "paragraph", text: "short" }]);
    expect(s.startsWith("BOOK PASSAGES")).toBe(true);
    expect(s).toContain("[1] (u5, worked example) " + "A".repeat(700) + "\n");
    expect(s).toContain("[2] (book, paragraph) short");
    expect(s.endsWith("STUDENT QUESTION: What is total magnification?")).toBe(true);
    expect(questionWithPassages("q", [])).toBe("q");
  });
});

// ── The loop with a scripted retrieval provider ─────────────────────────────
class ScriptedRetrieval implements RetrievalProvider {
  readonly id = "hybrid" as const;
  begins: { query: string; ctx: RetrievalContext }[] = [];
  results = 0;
  constructor(private readonly result: RetrievalResult) {}
  begin(query: string, ctx: RetrievalContext): TurnRetrieval {
    this.begins.push({ query, ctx });
    return { result: () => (this.results += 1, Promise.resolve(this.result)) };
  }
}
const passage: RetrievedPassage = { blockId: "b1", sourceRef: "book:test-product/2/s2#4", unitKey: "u2", blockType: "key_idea", text: "The eyepiece lens is the one you look through.", score: 0.03, ftsScore: 0.2, vecScore: 0.6 };
const grounded: RetrievalResult = { status: "grounded", passages: [passage], bestVecScore: 0.6, gate: 0.32, ms: 7 };
const gated: RetrievalResult = { status: "none", reason: "gate", bestVecScore: 0.21, gate: 0.32, ms: 5 };
const failed: RetrievalResult = { status: "error", message: "AccessDeniedException", ms: 3 };

function deps(extra: Partial<LoopDeps> = {}): LoopDeps {
  return { store: new InMemorySessionStore(), graph: graph(), items: new StaticItemBank(), loadSegment: async () => U4_SEGMENT, loadHitmapElementIds: async () => U4_HITMAP_TARGETS, ...extra };
}
const open = (d: LoopDeps) => openSession(d, { studentId: "stu", productId: "test-product", chapter: 2 });
const collect = async (gen: AsyncGenerator<SseEvent>) => {
  const out: SseEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};
const text = (evs: SseEvent[]) => evs.filter((e) => e.event === "text").map((e) => String(e.data)).join("");
const metaGrounding = (evs: SseEvent[]) => (evs.find((e) => e.event === "meta" && (e.data as { grounding?: unknown }).grounding)?.data as { grounding: Record<string, unknown> } | undefined)?.grounding;
const eid = (() => {
  let n = 0;
  return () => `0192f5c0-0000-7000-8000-${String(++n).padStart(12, "0")}`;
})();

describe("the loop with retrieval", () => {
  it("a grounded question: retrieval starts before the router, the passages ride in the user turn, the history keeps the plain question", async () => {
    const teacher = new StubProvider([{ text: ["It is the top lens."] }]);
    const retrieval = new ScriptedRetrieval(grounded);
    const d = deps({ teacherProvider: teacher, retrieval });
    const s = await open(d);
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "which lens is the eyepiece?", modality: "typed" } }));
    expect(retrieval.begins).toEqual([{ query: "which lens is the eyepiece?", ctx: { product: "test-product", chapter: 2, signal: undefined } }]);
    expect(retrieval.results).toBe(1);
    expect(text(evs)).toBe("It is the top lens.");
    expect(metaGrounding(evs)).toEqual({ status: "grounded", bestVecScore: 0.6, gate: 0.32, passages: ["book:test-product/2/s2#4"], ms: 7 });
    const call = teacher.calls[0]!;
    expect(call.system).toContain("BOOK PASSAGES");
    const last = call.messages.at(-1) as { role: string; text: string };
    expect(last.role).toBe("user");
    expect(last.text).toContain("[1] (u2, key idea) The eyepiece lens is the one you look through.");
    expect(last.text.endsWith("STUDENT QUESTION: which lens is the eyepiece?")).toBe(true);
    expect((await d.store.getSession(s.id))!.history).toEqual([
      { role: "user", text: "which lens is the eyepiece?" },
      { role: "assistant", text: "It is the top lens." },
    ]);
    const dn = evs.find((e) => e.event === "done")!.data as { latency: { retrievalMs: number }; view: { state: string } };
    expect(dn.latency.retrievalMs).toBeGreaterThanOrEqual(0);
    expect(dn.view.state).toBe("PRESENTING");
  });
  it("'none' (below the gate): SK says it cannot find that in the book — no model call, lesson resumes, history records it", async () => {
    const teacher = new StubProvider([{ text: ["Photosynthesis happens in chloroplasts."] }]);
    const retrieval = new ScriptedRetrieval(gated);
    const d = deps({ teacherProvider: teacher, retrieval });
    const s = await open(d);
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "what is photosynthesis?", modality: "typed" } }));
    expect(teacher.calls).toHaveLength(0);
    expect(text(evs)).toBe(NOT_IN_BOOK_TEXT);
    expect(metaGrounding(evs)).toMatchObject({ status: "none", reason: "gate", bestVecScore: 0.21, gate: 0.32 });
    expect((await d.store.getSession(s.id))!.history).toEqual([
      { role: "user", text: "what is photosynthesis?" },
      { role: "assistant", text: NOT_IN_BOOK_TEXT },
    ]);
    expect((evs.find((e) => e.event === "done")!.data as { view: { state: string } }).view.state).toBe("PRESENTING");
  });
  it("a retrieval error degrades to unit-only grounding: the teacher is still called with the plain question", async () => {
    const teacher = new StubProvider([{ text: ["Sure."] }]);
    const d = deps({ teacherProvider: teacher, retrieval: new ScriptedRetrieval(failed) });
    const s = await open(d);
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "why is the image bigger?", modality: "typed" } }));
    expect(text(evs)).toBe("Sure.");
    expect(metaGrounding(evs)).toEqual({ status: "error", message: "AccessDeniedException", ms: 3 });
    expect(teacher.calls[0]!.messages.at(-1)).toEqual({ role: "user", text: "why is the image bigger?" });
  });
  it("a command starts retrieval (it runs beside the router) but never awaits it; with no provider nothing changes", async () => {
    const retrieval = new ScriptedRetrieval(grounded);
    const d = deps({ retrieval });
    const s = await open(d);
    await runCommand(d, s, { name: "continue", args: {} });
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "slower please", modality: "typed" } }));
    expect(retrieval.begins).toHaveLength(1);
    expect(retrieval.results).toBe(0);
    expect(metaGrounding(evs)).toBeUndefined();
    const plain = deps({ teacherProvider: new StubProvider([{ text: ["Ok."] }]) });
    const s2 = await open(plain);
    const evs2 = await collect(runTurn(plain, s2, { eventId: eid(), utterance: { text: "which lens is the eyepiece?", modality: "typed" } }));
    expect(text(evs2)).toBe("Ok.");
    expect(metaGrounding(evs2)).toBeUndefined();
  });
});
