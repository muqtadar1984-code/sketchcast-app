// SK B4 — the deterministic route planner: prerequisites warn, skips count
// only through a check, validated assets first, the ladder with its reasons.
import { describe, expect, it } from "vitest";
import { applyCheckToMastery, ladder, plan, type PlannerContext } from "../planner";
import type { Cursor, MasteryMap } from "../types";
import { graph } from "./fixtures";

const g = graph();
const at = (unitKey: string, assetId: string, t = 0): Cursor => ({ graphVersion: 3, unitKey, assetId, segmentId: assetId, t });
const ctx = (cursor: Cursor, mastery: MasteryMap = {}, extra: Partial<PlannerContext> = {}): PlannerContext => ({ graph: g, cursor, mastery, bookmarks: [], ...extra });
const mastered = (...keys: string[]): MasteryMap => Object.fromEntries(keys.map((k) => [k, { status: "mastered", independent: true, evidence: { correct: 2, total: 2 } }]));

describe("next", () => {
  it("runs the unit's check before moving on when the unit is not mastered", () => {
    const d = plan(ctx(at("u2", "u2-main")), { name: "next" });
    expect(d.kind).toBe("check");
    if (d.kind === "check") {
      expect(d.unitKey).toBe("u2");
      expect(d.purpose).toBe("unit");
      expect(d.itemIds).toHaveLength(3);
    }
  });
  it("moves to the next unit in order once mastered, and warns when a prerequisite is unmet", () => {
    const d = plan(ctx(at("u2", "u2-main"), mastered("u2")), { name: "next" });
    expect(d.kind).toBe("present");
    if (d.kind === "present") {
      expect(d.unitKey).toBe("u4");
      expect(d.warning).toBeUndefined();
      expect(d.bookmark).toBe(false);
    }
    const d2 = plan(ctx(at("u4", "u4-main"), mastered("u4")), { name: "next" });
    if (d2.kind === "present") {
      expect(d2.unitKey).toBe("u5");
      expect(d2.warning).toBeUndefined();
    }
    // u4 reached without u2: warn, don't block; offer u2's 2-item check.
    const d3 = plan(ctx(at("u2", "u2-check"), { u2: { status: "needs_work", independent: false, evidence: { correct: 1, total: 3 } } }, { lastCheckFailed: true }), { name: "next" });
    expect(d3.kind).toBe("present");
    if (d3.kind === "present") {
      expect(d3.unitKey).toBe("u4");
      expect(d3.warning).toBe("Total magnification uses Parts of a microscope's idea; quick check first?");
      expect(d3.suggestedCheck).toEqual({ unitKey: "u2", itemIds: ["ch2-u4-c1", "ch2-u4-c2"], purpose: "prereq" });
      expect(d3.reasons.join(" ")).toMatch(/warn, not block/);
    }
  });
  it("says so at the end of the chapter", () => {
    const d = plan(ctx(at("u5", "u5-main"), mastered("u5")), { name: "next" });
    expect(d).toEqual({ kind: "none", reasons: ["end of chapter: no next unit"] });
  });
});

describe("skip", () => {
  it("skipping with the check opens a 2-item check whose pass records independent evidence", () => {
    const d = plan(ctx(at("u4", "u4-main")), { name: "skip", withCheck: true });
    expect(d.kind).toBe("check");
    if (d.kind === "check") {
      expect(d.itemIds).toEqual(["ch2-u4-c1", "ch2-u4-c2"]);
      expect(d.purpose).toBe("skip");
      expect(d.bookmark).toBe(true);
      expect(d.reasons[0]).toMatch(/2-item check/);
    }
  });
  it("skipping without the check moves on and records nothing", () => {
    const d = plan(ctx(at("u4", "u4-main")), { name: "skip", withCheck: false });
    expect(d.kind).toBe("present");
    if (d.kind === "present") {
      expect(d.unitKey).toBe("u5");
      expect(d.reasons[0]).toMatch(/records no mastery/);
    }
  });
});

describe("goto / practise / check_me / return", () => {
  it("goto presents the unit's main explanation with a bookmark", () => {
    const d = plan(ctx(at("u2", "u2-main")), { name: "goto", unitKey: "u5" });
    expect(d.kind).toBe("present");
    if (d.kind === "present") {
      expect(d.asset.asset_id).toBe("u5-main");
      expect(d.bookmark).toBe(true);
      expect(d.warning).toMatch(/Actual size uses Total magnification's idea/);
    }
    expect(plan(ctx(at("u2", "u2-main")), { name: "goto", unitKey: "nope" }).kind).toBe("none");
    expect(plan(ctx(at("u2", "u2-main"), {}, { accessibleUnitKeys: ["u2"] }), { name: "goto", unitKey: "u5" }).kind).toBe("none");
  });
  it("practise takes n practice items (assisted evidence), check_me the unit's check", () => {
    const p = plan(ctx(at("u4", "u4-main")), { name: "practise", n: 1 });
    expect(p.kind).toBe("check");
    if (p.kind === "check") {
      expect(p.itemIds).toEqual(["ch2-u4-p1"]);
      expect(p.purpose).toBe("practise");
    }
    const c = plan(ctx(at("u4", "u4-main")), { name: "check_me" });
    if (c.kind === "check") expect(c.purpose).toBe("unit");
    // u5 has no practice items → the ladder (rung 3: no figures, no demo)
    const l = plan(ctx(at("u5", "u5-main")), { name: "practise" });
    expect(l.kind).toBe("generate");
    if (l.kind === "generate") expect(l.rung).toBe(3);
  });
  it("return pops the last bookmark, or says there is none", () => {
    const bm = { ...at("u2", "u2-main", 4321), boardSnapshotId: "snap-1" };
    const d = plan(ctx(at("u5", "u5-main"), {}, { bookmarks: [bm] }), { name: "return" });
    expect(d.kind).toBe("return");
    if (d.kind === "return") {
      expect(d.cursor).toEqual(at("u2", "u2-main", 4321));
      expect(d.reasons[0]).toMatch(/snap-1/);
    }
    expect(plan(ctx(at("u5", "u5-main")), { name: "return" })).toEqual({ kind: "none", reasons: ["no bookmark to return to"] });
  });
});

describe("explain_again and the ladder", () => {
  it("prefers the validated visual alternative after a failed check", () => {
    const d = plan(ctx(at("u4", "u4-main"), {}, { lastCheckFailed: true }), { name: "explain_again" });
    expect(d.kind).toBe("present");
    if (d.kind === "present") expect(d.asset.asset_id).toBe("u4-visual");
  });
  it("honours a requested style when a validated asset has it", () => {
    const d = plan(ctx(at("u4", "u4-main")), { name: "explain_again", style: "visual" });
    if (d.kind === "present") expect(d.asset.asset_id).toBe("u4-visual");
  });
  it("climbs the ladder when no validated asset fits, with reasons", () => {
    // u4: no "simpler" asset → rung 1, the unit's own approved demo
    const d1 = plan(ctx(at("u4", "u4-main")), { name: "explain_again", style: "simpler" });
    expect(d1.kind).toBe("generate");
    if (d1.kind === "generate") {
      expect(d1.rung).toBe(1);
      expect(d1.basis).toEqual({ assetId: "u4-demo" });
      expect(d1.reasons.some((r) => r.startsWith("rung 1: approved demonstration u4-demo"))).toBe(true);
    }
    // u2: no demo, but a validated figure → rung 2
    const d2 = plan(ctx(at("u2", "u2-main")), { name: "explain_again", style: "visual" });
    if (d2.kind === "generate") {
      expect(d2.rung).toBe(2);
      expect(d2.basis).toEqual({ figures: ["light_microscope"] });
    }
    // u2 again, but the request needs unverified content → stops at rung 3
    const d3 = plan(ctx(at("u2", "u2-main"), {}, { needsUnverifiedContent: true }), { name: "explain_again", style: "visual" });
    if (d3.kind === "generate") {
      expect(d3.rung).toBe(3);
      expect(d3.reasons).toContain("rung 2 refused: the request needs unverified scientific or mathematical content");
    }
    // u5: nothing at all → rung 3 with the unavailable reasons listed
    const l = ladder(ctx(at("u5", "u5-main")), g.units[2]!);
    expect(l.rung).toBe(3);
    expect(l.reasons).toEqual(["rung 1 unavailable: no approved demonstration for this objective", "rung 2 unavailable: the unit has no validated figures to draw from", "rung 3: grounded spoken explanation, no new diagram"]);
  });
});

describe("mastery from checks", () => {
  it("a passed skip/unit check marks mastered (independent) or provisional (assisted); a failed one needs work", () => {
    const m1 = applyCheckToMastery({}, "u4", "skip", [true, true], true);
    expect(m1.u4).toEqual({ status: "mastered", independent: true, evidence: { correct: 2, total: 2 } });
    const m2 = applyCheckToMastery({}, "u4", "unit", [true, false, true], true);
    expect(m2.u4!.status).toBe("needs_work");
    expect(m2.u4!.independent).toBe(false);
    const m3 = applyCheckToMastery({}, "u4", "unit", [true, true], false);
    expect(m3.u4).toMatchObject({ status: "provisional", independent: false }); // assisted pass is provisional (founder, 2026-10-27)
  });
  it("practice never changes mastery status beyond in_progress", () => {
    const m = applyCheckToMastery({}, "u4", "practise", [true, true], true);
    expect(m.u4!.status).toBe("in_progress");
    const m2 = applyCheckToMastery(m, "u4", "practise", [false], true);
    expect(m2.u4).toEqual({ status: "in_progress", independent: false, evidence: { correct: 2, total: 3 } });
  });
});
