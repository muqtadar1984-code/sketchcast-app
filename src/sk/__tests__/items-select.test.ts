// SK B4.1 — the deterministic pick of a unit's check and practice items from
// the bank: the documented order, the objective gate for checks, the minimum,
// and the planner reading the graph's own ids first.
import { describe, expect, it } from "vitest";
import type { BankItem } from "../items";
import { DEFAULT_UNIT_CHECK_ITEMS, MIN_CHECK_ITEMS, orderBankItems, selectUnitItems } from "../items-select";
import { checkFor, plan, practiceFor, type PlannerContext } from "../planner";
import type { Cursor } from "../types";
import { BANK_SCRAMBLED as SCRAMBLED, graph } from "./fixtures";

const mcq = (id: string, meta: Partial<BankItem> = {}): BankItem => ({ id, type: "mcq", prompt: id, options: ["a", "b"], answer: "a", marks: 1, teachingObjectiveId: "to-1", ...meta } as BankItem);

describe("orderBankItems", () => {
  it("approved before draft, then ascending difficulty (unknown last), then id — whatever order the bank used", () => {
    const want = ["q-a1", "q-un", "q-sh", "q-a3", "q-ax", "q-d2"];
    expect(orderBankItems(SCRAMBLED).map((q) => q.id)).toEqual(want);
    expect(orderBankItems([...SCRAMBLED].reverse()).map((q) => q.id)).toEqual(want);
    expect(orderBankItems([mcq("b", { status: undefined }), mcq("a", { status: "draft" })]).map((q) => q.id)).toEqual(["a", "b"]); // unknown status after draft
  });
});

describe("selectUnitItems", () => {
  it("the unit check takes the first mapped deterministic items (default 3), practice the remaining gradeable ones, unmapped and short items never in a check", () => {
    expect(DEFAULT_UNIT_CHECK_ITEMS).toBe(3);
    const s = selectUnitItems(SCRAMBLED);
    expect(s.check).toEqual(["q-a1", "q-a3", "q-ax"]);
    expect(s.check.slice(0, 2)).toEqual(["q-a1", "q-a3"]); // the skip check
    expect(s.practice).toEqual(["q-un", "q-d2"]); // the unmapped item practises; the short answer never appears
    expect(s.reasons[0]).toBe("bank: 6 item(s), 5 deterministic, 4 mapped to an objective");
  });
  it("honours a graph-given size and never asks fewer than the minimum", () => {
    expect(selectUnitItems(SCRAMBLED, { unitCheckSize: 4 }).check).toEqual(["q-a1", "q-a3", "q-ax", "q-d2"]);
    expect(selectUnitItems(SCRAMBLED, { unitCheckSize: 1 }).check).toEqual(["q-a1", "q-a3"]);
    expect(MIN_CHECK_ITEMS).toBe(2);
  });
  it("fewer than 2 checkable items: no check at all (never an empty or one-item check); what is gradeable still practises", () => {
    const one = selectUnitItems([mcq("only"), mcq("unmapped", { teachingObjectiveId: null }), { id: "s", type: "short", prompt: "s", marks: 1, teachingObjectiveId: "to-1" }]);
    expect(one.check).toEqual([]);
    expect(one.practice).toEqual(["only", "unmapped"]);
    expect(one.reasons).toContain("fewer than 2 checkable items: no check for this unit");
    expect(selectUnitItems([])).toEqual({ check: [], practice: [], reasons: ["bank: 0 item(s), 0 deterministic, 0 mapped to an objective", "fewer than 2 checkable items: no check for this unit"] });
  });
  it("is deterministic: the same items in any order give the same ids", () => {
    const a = selectUnitItems(SCRAMBLED);
    const b = selectUnitItems([...SCRAMBLED].sort(() => -1));
    expect(b.check).toEqual(a.check);
    expect(b.practice).toEqual(a.practice);
  });
});

describe("the planner: graph ids first, the bank only when the graph carries none", () => {
  const g = graph();
  const at = (unitKey: string, assetId: string): Cursor => ({ graphVersion: 3, unitKey, assetId, segmentId: assetId, t: 0 });
  const bank = { u4: { check: ["bank-1", "bank-2", "bank-3"], practice: ["bank-4"], reasons: [] }, u5: { check: ["b5-1", "b5-2"], practice: ["b5-3"], reasons: [] }, u2: { check: [], practice: ["b2-p"], reasons: [] } };
  const ctx = (cursor: Cursor): PlannerContext => ({ graph: g, cursor, mastery: {}, bookmarks: [], bankItems: bank });

  it("a unit whose graph asset carries ids keeps them, bank or no bank", () => {
    const u4 = g.units.find((u) => u.unit_key === "u4")!;
    expect(checkFor(ctx(at("u4", "u4-main")), u4)).toMatchObject({ source: "graph", itemIds: ["ch2-u4-c1", "ch2-u4-c2", "ch2-u4-c3"], asset: { asset_id: "u4-check" } });
    expect(practiceFor(ctx(at("u4", "u4-main")), u4)).toMatchObject({ source: "graph", itemIds: ["ch2-u4-p1", "ch2-u4-p2"] });
    const d = plan(ctx(at("u4", "u4-main")), { name: "check_me" });
    expect(d.kind === "check" && d.itemIds).toEqual(["ch2-u4-c1", "ch2-u4-c2", "ch2-u4-c3"]);
  });
  it("a unit with no graph items runs its check under a bank asset id, with the reason on record", () => {
    const d = plan(ctx(at("u5", "u5-main")), { name: "skip", withCheck: true });
    expect(d.kind).toBe("check");
    if (d.kind === "check") {
      expect(d.itemIds).toEqual(["b5-1", "b5-2"]);
      expect(d.cursor).toMatchObject({ unitKey: "u5", assetId: "bank:u5:check", segmentId: "bank:u5:check" });
      expect(d.reasons[0]).toMatch(/items from the bank: the graph carries none/);
    }
    const p = plan(ctx(at("u5", "u5-main")), { name: "practise", n: 2 });
    expect(p.kind === "check" && p.itemIds).toEqual(["b5-3"]);
    expect(p.kind === "check" && p.cursor.assetId).toBe("bank:u5:practice");
    // "next" from u5's own bank check does not reopen it
    const n = plan({ ...ctx(at("u5", "bank:u5:check")), mastery: { u5: { status: "mastered", independent: true, evidence: { correct: 2, total: 2 } } } }, { name: "next" });
    expect(n.kind).toBe("none"); // end of chapter
  });
  it("an empty bank check means no check: skip moves on and records no mastery; check_me refuses", () => {
    const u2 = g.units.find((u) => u.unit_key === "u2")!;
    const noGraphCheck = { ...u2, assets: u2.assets.filter((a) => a.kind !== "check") };
    const g2 = { ...g, units: g.units.map((u) => (u.unit_key === "u2" ? noGraphCheck : u)) };
    const c: PlannerContext = { graph: g2, cursor: at("u2", "u2-main"), mastery: {}, bookmarks: [], bankItems: bank };
    const d = plan(c, { name: "skip", withCheck: true });
    expect(d.kind).toBe("present");
    if (d.kind === "present") {
      expect(d.unitKey).toBe("u4");
      expect(d.reasons[0]).toBe("unit u2 has no check items; skipping records NO mastery");
    }
    expect(plan(c, { name: "check_me" })).toEqual({ kind: "none", reasons: ["unit u2 has no check items"] });
    expect(plan({ ...c, bankItems: undefined }, { name: "check_me" }).kind).toBe("none");
    const p = plan(c, { name: "practise" });
    expect(p.kind === "check" && p.itemIds).toEqual(["b2-p"]);
  });
});
