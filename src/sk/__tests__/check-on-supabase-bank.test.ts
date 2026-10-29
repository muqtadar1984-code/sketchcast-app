/**
 * Live fix 2026-10-27 (founder's first Check): on the Supabase store the
 * stand-in chapter's string item ids resolved to nothing — no question shown,
 * answer unmarkable — and a session resumed mid-check sat on a blank board.
 *   1. CompositeItemBank: uuid ids go to the primary, string ids and unknown
 *      units fall through to the stand-in items.
 *   2. sessionView.board: a segment-less asset (check/practice) keeps the
 *      unit's main teaching segment on the board.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/check-on-supabase-bank.test.ts
 */
import { describe, expect, it } from "vitest";
import { UUID_RE } from "../ids";
import { CompositeItemBank, POC_ITEMS, StaticItemBank, type BankItem, type ItemBank } from "../items";
import { boardFor, openSession, runCommand, sessionView, type LoopDeps } from "../loop";
import { InMemorySessionStore } from "../store";
import { standinGraph, U4_HITMAP_TARGETS, U4_SEGMENT } from "./fixtures";

const standin = standinGraph();

/** A bank that, like SupabaseItemBank in production, knows only uuid ids. */
class UuidOnlyBank implements ItemBank {
  calls: string[] = [];
  async get(id: string) {
    this.calls.push(`get:${id}`);
    if (!UUID_RE.test(id)) throw new Error("primary asked for a non-uuid id");
    return null;
  }
  async listForUnit(p: string, c: number, u: string): Promise<BankItem[]> {
    this.calls.push(`list:${p}/${c}/${u}`);
    return [];
  }
}

const deps = (items: ItemBank): LoopDeps => ({ store: new InMemorySessionStore(), graph: standin, items, loadSegment: async () => U4_SEGMENT, loadHitmapElementIds: async () => U4_HITMAP_TARGETS });

describe("CompositeItemBank", () => {
  it("routes string ids to the fallback and never asks the primary for them", async () => {
    const primary = new UuidOnlyBank();
    const bank = new CompositeItemBank(primary, new StaticItemBank(), (id) => UUID_RE.test(id));
    expect((await bank.get("ch2-u4-c1"))?.id).toBe("ch2-u4-c1");
    expect(await bank.get("01999999-0000-7000-8000-000000000001")).toBeNull();
    expect(primary.calls).toEqual(["get:01999999-0000-7000-8000-000000000001"]);
  });
  it("lists a unit from the primary first, then the fallback", async () => {
    const primary = new UuidOnlyBank();
    const bank = new CompositeItemBank(primary, new StaticItemBank(), (id) => UUID_RE.test(id));
    const items = await bank.listForUnit("sk-poc-biology", 2, "u4");
    expect(items.map((i) => i.id)).toEqual(POC_ITEMS.map((q) => q.id));
    expect(primary.calls).toEqual(["list:sk-poc-biology/2/u4"]);
  });
  it("the stand-in Check shows its first question on a uuid-only primary", async () => {
    const d = deps(new CompositeItemBank(new UuidOnlyBank(), new StaticItemBank(), (id) => UUID_RE.test(id)));
    const s = await openSession(d, { studentId: "stu", productId: standin.product_id, chapter: 2 });
    const r = await runCommand(d, s, { name: "practise", args: { n: 0 } });
    expect(r.view.state).toBe("AWAITING");
    expect(r.view.openCheck?.total).toBe(3);
    expect(r.view.openCheck?.item?.id).toBe("ch2-u4-c1");
    expect(r.view.openCheck?.item?.prompt).toBeTruthy();
  });
  it("the same Check on the bare uuid-only bank is what the founder saw: no item", async () => {
    const d = deps(new UuidOnlyBank());
    const s = await openSession(d, { studentId: "stu", productId: standin.product_id, chapter: 2 });
    await expect(runCommand(d, s, { name: "practise", args: { n: 0 } })).rejects.toThrow(/non-uuid/);
  });
});

describe("sessionView.board", () => {
  it("is null while a segment is playing", async () => {
    const d = deps(new StaticItemBank());
    const s = await openSession(d, { studentId: "stu", productId: standin.product_id, chapter: 2 });
    const v = await sessionView(d, s);
    expect(v.asset?.segment).toBeTruthy();
    expect(v.board).toBeNull();
  });
  it("names the unit's main teaching segment during a check", async () => {
    const d = deps(new StaticItemBank());
    const s = await openSession(d, { studentId: "stu", productId: standin.product_id, chapter: 2 });
    const r = await runCommand(d, s, { name: "practise", args: { n: 0 } });
    expect(r.view.asset?.assetId).toBe("u4-check");
    expect(r.view.asset?.segment).toBeUndefined();
    expect(r.view.board).toEqual({ assetId: "u4-explain-main", segment: "/lessons/u4/segment.json", clip: "/lessons/u4/optionS.mp4", hitmap: "/lessons/u4/optionS.hitmap.json" });
  });
  it("boardFor prefers the main explain, else any asset with a segment", () => {
    const unit = standin.units[0]!;
    expect(boardFor(unit, unit.assets.find((a) => a.asset_id === "u4-check"))?.assetId).toBe("u4-explain-main");
    expect(boardFor(unit, unit.assets.find((a) => a.asset_id === "u4-explain-main"))).toBeNull();
    expect(boardFor(null, undefined)).toBeNull();
  });
});
