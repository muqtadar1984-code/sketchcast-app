/**
 * Phase 4 — concept tags for worksheet questions: paper → lesson map → ONE
 * Haiku call per worksheet → the kit, CACHED per question × hash (0179), so
 * the second student (and the second call) costs nothing; a reply naming a
 * concept outside the map is dropped; the kit fallback is never cached.
 * The model is always a mock.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/practice/__tests__/concepts.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import type { RawQuestion, RawQuiz } from "@/app/api/quiz/logic";
import type { KitManifest } from "@/sk/manifest/derive";
import { conceptOptions, conceptPrompt, KIT_CONCEPT, manifestTag, paperTag, parseConceptReply, tagWorksheet } from "../concepts";
import type { HelpModelCall } from "../help";
import { questionHash } from "../help";
import { PAPER, planDb, WS } from "./practice-db";

const MANIFEST = {
  concepts: [
    { concept_id: "c-pig", name: "Pigments", definition: "Coloured molecules that absorb light", segment_ids: [] },
    { concept_id: "c-org", name: "Cell organelles", definition: "Parts of a cell with jobs", segment_ids: [] },
    { concept_id: "c-mem", name: "Membranes", definition: "", segment_ids: [] },
  ],
  items: [{ q_id: `ws:${WS.slice(0, 8)}:q2`, source: "worksheet", generation_id: WS, type: "true_false", prompt_hash: "x", concept_ids: ["c-org"], segment_ids: [], method: "model", confidence: 0.8, availability: "available" }],
} as unknown as KitManifest;
const OPTIONS = conceptOptions(MANIFEST);
const q = (id: string) => PAPER.questions.find((x) => x.id === id) as unknown as RawQuestion;

describe("the pure steps", () => {
  it("the lesson map's concepts become choices", () => {
    expect(OPTIONS.map((o) => o.key)).toEqual(["c-pig", "c-org", "c-mem"]);
    expect(conceptOptions(null)).toEqual([]);
  });
  it("a paper-named concept is matched to the map by name, else kept as a paper concept", () => {
    expect(paperTag(q("q3"), OPTIONS)).toEqual({ questionId: "q3", key: "c-org", name: "Cell organelles", method: "paper" });
    expect(paperTag({ ...q("q3"), concept: "Osmosis!" } as unknown as RawQuestion, OPTIONS)).toEqual({ questionId: "q3", key: "p:osmosis", name: "Osmosis!", method: "paper" });
    expect(paperTag(q("q1"), OPTIONS)).toBeNull();
  });
  it("the lesson map's own item mapping is used (ws:<8>:<qid>)", () => {
    expect(manifestTag(MANIFEST, WS, "q2", OPTIONS)).toEqual({ questionId: "q2", key: "c-org", name: "Cell organelles", method: "manifest" });
    expect(manifestTag(MANIFEST, WS, "q1", OPTIONS)).toBeNull();
    expect(manifestTag(MANIFEST, "00000000-0000-4000-8000-000000000000", "q2", OPTIONS)).toBeNull();
  });
  it("the prompt lists only the map's ids; the reply keeps only listed ids for asked questions", () => {
    const p = conceptPrompt([q("q1")], OPTIONS);
    expect(p.user).toContain("c-pig: Pigments");
    expect(p.user).toContain("q1:");
    expect(parseConceptReply('Sure! {"q1": "c-pig", "q5": "c-invented", "q9": "c-mem", "q6": null}', ["q1", "q5", "q6"], OPTIONS)).toEqual(new Map([["q1", "c-pig"]]));
    expect(parseConceptReply("no json", ["q1"], OPTIONS).size).toBe(0);
  });
});

function deps(call: HelpModelCall | null, manifest: KitManifest | null = MANIFEST) {
  const db = planDb();
  const loadManifest = vi.fn(async () => manifest);
  return { db, loadManifest, d: { db, loadManifest, call, kitTitle: "Cells" } };
}

describe("tagWorksheet — cached, one model call per worksheet", () => {
  it("paper → map → ONE model call for the rest → kit; cached rows; a second run makes no call", async () => {
    const call = vi.fn<HelpModelCall>(async () => ({ text: JSON.stringify({ q1: "c-pig", q4: "c-org", q5: "c-made-up" }), usage: { input_tokens: 1500, output_tokens: 200 } }));
    const { db, d, loadManifest } = deps(call);
    const tags = await tagWorksheet(d, WS, PAPER as unknown as RawQuiz);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].model).toBe("claude-haiku-5-5");
    expect(Object.fromEntries([...tags].map(([k, t]) => [k, `${t.key}/${t.method}`]))).toEqual({
      q1: "c-pig/model",
      q2: "c-org/manifest",
      q3: "c-org/paper",
      q4: "c-org/model",
      q5: `${KIT_CONCEPT}/fallback`,
      q6: `${KIT_CONCEPT}/fallback`,
    });
    const rows = db.rows("sk_practice_concepts");
    expect(rows.map((r) => r.question_id).sort()).toEqual(["q1", "q2", "q3", "q4"]); // the fallback is never cached
    expect(rows.find((r) => r.question_id === "q1")).toMatchObject({ method: "model", model: "claude-haiku-5-5", question_hash: questionHash(q("q1")) });
    const cost = rows.filter((r) => r.method === "model").reduce((s, r) => s + Number(r.cost_usd), 0);
    expect(cost).toBeCloseTo(0.00025, 6); // 1500 × $0.1/M + 200 × $0.5/M, spread over the two model rows

    call.mockClear();
    loadManifest.mockClear();
    const again = await tagWorksheet(d, WS, PAPER as unknown as RawQuiz);
    expect(again.get("q1")).toMatchObject({ key: "c-pig", method: "model" });
    // q5/q6 are still untagged → the map is consulted and the model asked again for those two only
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].user).toContain("- q5:");
    expect(call.mock.calls[0][0].user).not.toContain("- q1:");
  });

  it("everything cached → no manifest read, no model call", async () => {
    const call = vi.fn<HelpModelCall>(async () => ({ text: "{}", usage: { input_tokens: 1, output_tokens: 1 } }));
    const { db, d, loadManifest } = deps(call);
    const one = { title: "x", instructions: "", questions: [q("q3")] } as unknown as RawQuiz;
    await tagWorksheet(d, WS, one);
    expect(db.rows("sk_practice_concepts")).toHaveLength(1);
    loadManifest.mockClear();
    await tagWorksheet(d, WS, one);
    expect(loadManifest).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("a changed question (new hash) is re-tagged", async () => {
    const { db, d } = deps(null);
    const one = (prompt: string) => ({ title: "x", instructions: "", questions: [{ ...q("q3"), prompt }] }) as unknown as RawQuiz;
    await tagWorksheet(d, WS, one("Which organelle releases energy?"));
    await tagWorksheet(d, WS, one("Which organelle makes proteins?"));
    expect(db.rows("sk_practice_concepts")).toHaveLength(2);
  });

  it("no lesson map and no model → the kit concept, nothing cached, no call", async () => {
    const { db, d } = deps(null, null);
    const tags = await tagWorksheet(d, WS, PAPER as unknown as RawQuiz);
    expect(tags.get("q1")).toEqual({ questionId: "q1", key: KIT_CONCEPT, name: "Cells", method: "fallback" });
    expect(tags.get("q3")?.method).toBe("paper"); // the paper still names its own
    expect(db.rows("sk_practice_concepts").map((r) => r.question_id)).toEqual(["q3"]);
  });

  it("a failing model call leaves the questions on the kit (and logs)", async () => {
    const call = vi.fn<HelpModelCall>(async () => {
      throw new Error("throttled");
    });
    const log = vi.fn();
    const { d } = deps(call);
    const tags = await tagWorksheet({ ...d, log }, WS, PAPER as unknown as RawQuiz);
    expect(tags.get("q1")?.method).toBe("fallback");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("throttled"));
  });
});
