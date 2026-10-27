// SK B4.1 — the loop on a packager-shaped graph (no check/practice assets):
// checks and practice come from the item bank at the moment they open; the
// stand-in graph (ids in the graph) is untouched; a unit the bank cannot
// check skips with "records no mastery"; a replayed event reuses the same ids.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RawQuestion } from "@/app/api/quiz/logic";
import { parseGraph } from "../graph";
import { POC_ITEMS, StaticItemBank, type BankItem, type ItemBank } from "../items";
import { openSession, resolveBankItems, runCommand, runTurn, submitAnswer, unitsToResolve, type LoopDeps } from "../loop";
import { InMemorySessionStore, withEvent } from "../store";
import type { SseEvent } from "../types";
import { BANK_SCRAMBLED as SCRAMBLED, graph, U4_HITMAP_TARGETS, U4_SEGMENT } from "./fixtures";

/** The B3 packager's shape: explain/main per unit, `checks` as draft indexes, no item assets. */
const REAL_GRAPH = {
  graph_id: "real-ch02-v1",
  product: "real-book",
  chapter: 2,
  version: 1,
  units: [
    { unit_key: "s1", title: "Why we need a microscope", order: 0, prereqs: [], assets: [{ asset_id: "s1-explain-main", kind: "explain", style: "main", segment: "s1/explain-main/segment.json", origin: "prepared" }], checks: { item_indexes: [0, 10] }, figures: [] },
    { unit_key: "s2", title: "Parts of a light microscope", order: 1, prereqs: ["s1"], assets: [{ asset_id: "s2-explain-main", kind: "explain", style: "main", segment: "s2/explain-main/segment.json", origin: "prepared" }], figures: [{ ref: "fig:1", asset_key: "light_microscope" }] },
    { unit_key: "s3", title: "Focusing", order: 2, prereqs: ["s2"], assets: [{ asset_id: "s3-explain-main", kind: "explain", style: "main", segment: "s3/explain-main/segment.json", origin: "prepared" }], figures: [] },
  ],
};

/** A bank whose per-unit lists are configured and whose calls are counted;
 * `shuffle` reverses the list on every other call to prove order is the selector's. */
class FakeBank implements ItemBank {
  calls: string[] = [];
  private n = 0;
  constructor(
    private readonly byUnit: Record<string, BankItem[]>,
    private readonly shuffle = true,
  ) {}
  async get(itemId: string): Promise<RawQuestion | null> {
    for (const items of Object.values(this.byUnit)) {
      const q = items.find((i) => i.id === itemId);
      if (q) return q;
    }
    return null;
  }
  async listForUnit(productId: string, chapter: number, unitKey: string): Promise<BankItem[]> {
    this.calls.push(`${productId}/${chapter}/${unitKey}`);
    const items = this.byUnit[unitKey] ?? [];
    return this.shuffle && this.n++ % 2 ? [...items].reverse() : [...items];
  }
}

const S2_ONE: BankItem[] = [
  { id: "s2-only", type: "mcq", prompt: "s2", options: ["x", "y"], answer: "x", marks: 1, status: "approved", difficulty: 1, teachingObjectiveId: "to-s2" },
  { id: "s2-short", type: "short", prompt: "s2 short", answer: "x", marks: 2, status: "approved", teachingObjectiveId: "to-s2" },
];

function deps(bank: ItemBank, raw: unknown = REAL_GRAPH, base = "/sk-s1/ch02/"): LoopDeps {
  return { store: new InMemorySessionStore(), graph: parseGraph(raw, base), items: bank, loadSegment: async () => U4_SEGMENT, loadHitmapElementIds: async () => U4_HITMAP_TARGETS };
}
const open = (d: LoopDeps) => openSession(d, { studentId: "stu", productId: d.graph.product_id, chapter: d.graph.chapter });
const eid = (() => {
  let n = 0;
  return () => `0192f5c1-0000-7000-8000-${String(++n).padStart(12, "0")}`;
})();
const collect = async (gen: AsyncGenerator<SseEvent>) => {
  const out: SseEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};
const done = (evs: SseEvent[]) => evs.find((e) => e.event === "done")!.data as { view: { state: string; cursor: { unitKey: string; assetId: string }; openCheck: { item: { id: string } | null } | null }; decision?: { reasons: string[] } };

describe("the stand-in graph is unchanged", () => {
  it("items in the graph: the bank is never asked, the same ids open as in B4", async () => {
    const spy = new (class extends StaticItemBank {
      calls = 0;
      override async listForUnit(p: string, c: number, u: string) {
        this.calls++;
        return super.listForUnit(p, c, u);
      }
    })();
    const d = deps(spy, JSON.parse(readFileSync(new URL("../../../public/sk-s1/graph-ch2.json", import.meta.url), "utf-8")), "/sk-s1/");
    const s = await open(d);
    const r = await runCommand(d, s, { name: "skip", args: { scope: "unit", withCheck: true } });
    expect(r.view.cursor).toMatchObject({ unitKey: "u4", assetId: "u4-check" });
    expect(s.machine.openCheck?.itemIds).toEqual(["ch2-u4-c1", "ch2-u4-c2"]);
    expect(r.decision?.reasons.join(" ")).not.toMatch(/bank/);
    const c = await runCommand(d, s, { name: "practise", args: { n: 0 } });
    expect(c.view.openCheck?.total).toBe(3);
    const p = await runCommand(d, s, { name: "practise", args: { n: 5 } });
    expect(s.machine.openCheck?.itemIds).toEqual(["ch2-u4-p1", "ch2-u4-p2"]);
    expect(p.view.asset).toMatchObject({ assetId: "u4-practice", kind: "practice" });
    expect(spy.calls).toBe(0);
    // The static bank lists the stand-in unit (all five, approved, mapped) and nothing for any other product.
    expect((await spy.listForUnit("sk-poc-biology", 2, "u4")).map((q) => q.id)).toEqual(POC_ITEMS.map((q) => q.id));
    expect((await spy.listForUnit("sk-poc-biology", 2, "u4"))[0]).toMatchObject({ status: "approved", teachingObjectiveId: "to-ch2-u4-total-magnification" });
    expect(await spy.listForUnit("cells-structure-function-organisation", 2, "s5")).toEqual([]);
  });
  it("the three-unit fixture: u4 keeps its graph ids; u2 (check in the graph, no practice) asks the bank only for practice", async () => {
    const bank = new FakeBank({ u2: [{ id: "u2-bank-p", type: "mcq", prompt: "p", options: ["a", "b"], answer: "a", marks: 1, status: "draft", teachingObjectiveId: "to-u2" }] });
    const d: LoopDeps = { store: new InMemorySessionStore(), graph: graph(), items: bank, loadSegment: async () => U4_SEGMENT, loadHitmapElementIds: async () => U4_HITMAP_TARGETS };
    const s = await openSession(d, { studentId: "stu", productId: "test-product", chapter: 2 });
    const r = await runCommand(d, s, { name: "skip", args: { scope: "unit", withCheck: true } });
    expect(s.machine.openCheck?.itemIds).toEqual(["ch2-u4-c1", "ch2-u4-c2"]); // the graph's, although the bank was consulted for u2's practice
    expect(r.view.cursor.assetId).toBe("u2-check");
    expect(bank.calls).toEqual(["test-product/2/u2"]);
    await runCommand(d, s, { name: "practise", args: {} });
    expect(s.machine.openCheck?.itemIds).toEqual(["u2-bank-p"]);
  });
});

describe("a unit with no graph items takes its items from the bank", () => {
  it("resolves only the units the request can open a check on", () => {
    const d = deps(new FakeBank({}));
    const m = { state: "PAUSED" as const, cursor: { graphVersion: 1, unitKey: "s2", assetId: "s2-explain-main", segmentId: "s2-explain-main", t: 0 }, bookmarks: [], openCheck: null, rate: 1 };
    expect(unitsToResolve(d, m, { name: "next" })).toEqual(["s2"]);
    expect(unitsToResolve(d, m, { name: "skip", withCheck: true, unitKey: "s3" })).toEqual(["s2", "s3"]);
    expect(unitsToResolve(d, m, { name: "check_me", unitKey: "nope" })).toEqual(["s2"]);
    expect(unitsToResolve(d, m, { name: "goto", unitKey: "s3" })).toEqual([]);
    expect(unitsToResolve(d, m, { name: "return" })).toEqual([]);
    expect(unitsToResolve(d, m, { name: "explain_again", unitKey: "s1" })).toEqual([]);
  });
  it("skip opens the 2-item check in the documented order under a bank asset id; check_me asks 3; practise the rest", async () => {
    const bank = new FakeBank({ s1: SCRAMBLED });
    const d = deps(bank);
    const s = await open(d);
    const resolved = await resolveBankItems(d, s.machine, { name: "skip", withCheck: true });
    expect(resolved.s1).toMatchObject({ check: ["q-a1", "q-a3", "q-ax"], practice: ["q-un", "q-d2"] });
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "skip", modality: "typed" } }));
    const v = done(evs).view;
    expect(v.state).toBe("AWAITING");
    expect(s.machine.openCheck).toMatchObject({ unitKey: "s1", purpose: "skip", itemIds: ["q-a1", "q-a3"], index: 0 });
    expect(v.openCheck?.item?.id).toBe("q-a1");
    expect(v.cursor).toMatchObject({ unitKey: "s1", assetId: "bank:s1:check" });
    expect(done(evs).decision?.reasons[0]).toMatch(/items from the bank: the graph carries none/);
    const view = (await runCommand(d, s, { name: "practise", args: { n: 0 } })).view;
    expect(s.machine.openCheck?.itemIds).toEqual(["q-a1", "q-a3", "q-ax"]);
    expect(view.asset).toEqual({ assetId: "bank:s1:check", kind: "check", style: undefined, segment: undefined, clip: undefined, hitmap: undefined });
    await runCommand(d, s, { name: "practise", args: { n: 5 } });
    expect(s.machine.openCheck).toMatchObject({ purpose: "practise", itemIds: ["q-un", "q-d2"] });
    expect(s.machine.cursor.assetId).toBe("bank:s1:practice");
  });
  it("a passed bank check records mastery and moves on; the attempts carry the bank's ids", async () => {
    const bank = new FakeBank({ s1: SCRAMBLED, s2: S2_ONE });
    const d = deps(bank);
    const s = await open(d);
    await runCommand(d, s, { name: "skip", args: { scope: "unit", withCheck: true } });
    const a1 = await submitAnswer(d, s, { eventId: eid(), itemId: "q-a1", attemptNo: 1, response: "400", modality: "typed" });
    expect(a1).toMatchObject({ kind: "graded", outcome: "correct", independent: true });
    const a2 = await submitAnswer(d, s, { eventId: eid(), itemId: "q-a3", attemptNo: 1, response: "true", modality: "typed" });
    expect(a2).toMatchObject({ kind: "graded", outcome: "correct", check: { passed: true, independent: true, purpose: "skip" } });
    if (a2.kind === "graded") {
      expect(a2.view.mastery.s1).toMatchObject({ status: "mastered", independent: true, evidence: { correct: 2, total: 2 } });
      expect(a2.view.cursor).toMatchObject({ unitKey: "s2", assetId: "s2-explain-main" });
      expect(a2.view.state).toBe("PRESENTING");
    }
    expect((await d.store.listAttempts(s.id)).map((a) => a.itemId)).toEqual(["q-a1", "q-a3"]);
  });
  it("a unit whose bank has fewer than 2 checkable items skips with 'records no mastery' and never opens an empty check", async () => {
    const bank = new FakeBank({ s1: SCRAMBLED, s2: S2_ONE });
    const d = deps(bank);
    const s = await open(d);
    await runCommand(d, s, { name: "goto", args: { unitKey: "s2" } });
    const r = await runCommand(d, s, { name: "skip", args: { scope: "unit", withCheck: true } });
    expect(r.decision?.kind).toBe("present");
    expect(r.decision?.reasons[0]).toBe("unit s2 has no check items; skipping records NO mastery (unit marked skipped)");
    expect(r.view.cursor).toMatchObject({ unitKey: "s3", assetId: "s3-explain-main" });
    expect(r.view.openCheck).toBeNull();
    expect(r.view.skipped).toEqual(["s2"]); // founder 2026-10-27: skipped is recorded, never mastered
    expect(r.view.mastery.s2).toBeUndefined();
    await runCommand(d, s, { name: "goto", args: { unitKey: "s2" } });
    const c = await runCommand(d, s, { name: "practise", args: { n: 0 } });
    expect(c.speech).toBe("There are no check questions for Parts of a light microscope yet — keep going, or say practise to try what there is.");
    expect(c.view.openCheck).toBeNull();
    // What is gradeable still practises (assisted evidence only).
    await runCommand(d, s, { name: "practise", args: {} });
    expect(s.machine.openCheck).toMatchObject({ purpose: "practise", itemIds: ["s2-only"] });
    // A unit the bank knows nothing about: no check, no practice → the ladder.
    await runCommand(d, s, { name: "goto", args: { unitKey: "s3" } });
    const l = await runCommand(d, s, { name: "practise", args: {} });
    expect(l.decision?.kind).toBe("generate");
    expect(bank.calls.filter((k) => k.endsWith("/s3"))).toHaveLength(1);
  });
  it("a replayed command or answer event reuses the same item ids and asks the bank nothing", async () => {
    const bank = new FakeBank({ s1: SCRAMBLED });
    const d = deps(bank);
    const s = await open(d);
    const e = eid();
    const run = () => withEvent(d.store, s.id, e, "command.skip", () => runCommand(d, s, { name: "skip", args: { scope: "unit", withCheck: true } }));
    const first = await run();
    const again = await run();
    expect(again.replayed).toBe(true);
    expect(again.result.view.openCheck).toEqual(first.result.view.openCheck);
    expect(s.machine.openCheck?.itemIds).toEqual(["q-a1", "q-a3"]);
    expect(bank.calls).toEqual(["real-book/2/s1"]); // once
    // A second session on a bank that hands the list back reversed picks the same ids.
    const s2 = await openSession(d, { studentId: "other", productId: "real-book", chapter: 2 });
    await runCommand(d, s2, { name: "skip", args: { scope: "unit", withCheck: true } });
    expect(s2.machine.openCheck?.itemIds).toEqual(["q-a1", "q-a3"]);
    // The answer: graded once, the repeat replays.
    const ae = eid();
    const g1 = await submitAnswer(d, s, { eventId: ae, itemId: "q-a1", attemptNo: 1, response: "7", modality: "typed" });
    const g2 = await submitAnswer(d, s, { eventId: ae, itemId: "q-a1", attemptNo: 1, response: "400", modality: "typed" });
    expect(g1).toMatchObject({ kind: "graded", outcome: "incorrect", replayed: false });
    expect(g2).toMatchObject({ kind: "graded", outcome: "incorrect", replayed: true });
    expect(s.machine.openCheck).toMatchObject({ itemIds: ["q-a1", "q-a3"], index: 0, attemptNo: 2 });
  });
});
