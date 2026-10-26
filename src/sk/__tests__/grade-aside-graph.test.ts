// SK B4 — grading on the quiz scorers, the live-aside gate, the graph parser
// (both the stand-in and the B3 packager's shape), and the item strip.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SegmentError } from "../board/engine";
import { asideTargets, validateAside } from "../aside";
import { coerceResponse, gradeItem } from "../grade";
import { GraphError, parseGraph, resolveUnitKey, startCursor } from "../graph";
import { POC_ITEMS, StaticItemBank, stripItem } from "../items";
import { U4_HITMAP_TARGETS, U4_SEGMENT } from "./fixtures";

const item = (id: string) => POC_ITEMS.find((q) => q.id === id)!;

describe("gradeItem reuses the quiz scorers", () => {
  it("mcq: text or option letter; true_false: boolean or word; fill_blank: accept list and numbers", () => {
    expect(gradeItem(item("ch2-u4-c1"), "Multiply the eyepiece and objective magnifications", { attemptNo: 1, hintsUsed: 0 })).toMatchObject({ outcome: "correct", score: 1, max: 1, independent: true, grader: "deterministic" });
    expect(gradeItem(item("ch2-u4-c1"), "b", { attemptNo: 1, hintsUsed: 0 }).outcome).toBe("correct");
    expect(gradeItem(item("ch2-u4-c1"), "a", { attemptNo: 1, hintsUsed: 0 }).outcome).toBe("incorrect");
    expect(gradeItem(item("ch2-u4-c3"), "false", { attemptNo: 1, hintsUsed: 0 }).outcome).toBe("correct");
    expect(gradeItem(item("ch2-u4-c3"), true, { attemptNo: 1, hintsUsed: 0 }).outcome).toBe("incorrect");
    expect(gradeItem(item("ch2-u4-c2"), "x400", { attemptNo: 1, hintsUsed: 0 }).outcome).toBe("correct");
    expect(gradeItem(item("ch2-u4-c2"), "400.0", { attemptNo: 1, hintsUsed: 0 }).outcome).toBe("correct"); // numeric reading
    expect(gradeItem(item("ch2-u4-c2"), "", { attemptNo: 1, hintsUsed: 0 }).outcome).toBe("incorrect");
  });
  it("independence needs attempt 1 and no hint; hints stop at the attempt cap", () => {
    expect(gradeItem(item("ch2-u4-c2"), "400", { attemptNo: 2, hintsUsed: 1 })).toMatchObject({ outcome: "correct", independent: false });
    expect(gradeItem(item("ch2-u4-c2"), "40", { attemptNo: 1, hintsUsed: 0 })).toMatchObject({ outcome: "incorrect", hintAvailable: true });
    expect(gradeItem(item("ch2-u4-c2"), "40", { attemptNo: 3, hintsUsed: 2 }).hintAvailable).toBe(false);
  });
  it("match scores one per pair (partial), short answers need review", () => {
    const match = { id: "m", type: "match" as const, prompt: "p", marks: 2, pairs: [{ left: "eyepiece", right: "×10" }, { left: "objective", right: "×40" }] };
    expect(gradeItem(match, { 0: "×10", 1: "×4" }, { attemptNo: 1, hintsUsed: 0 })).toMatchObject({ outcome: "partial", score: 1, max: 2 });
    expect(gradeItem(match, ["×10", "×40"], { attemptNo: 1, hintsUsed: 0 }).outcome).toBe("correct");
    expect(coerceResponse(match, ["a"])).toEqual({ 0: "a" });
    expect(gradeItem({ id: "s", type: "short", prompt: "p", marks: 2 }, "because", { attemptNo: 1, hintsUsed: 0 })).toMatchObject({ outcome: "needs_review", grader: "teacher", independent: false, max: 2 });
  });
  it("stripItem never carries a key", () => {
    for (const q of POC_ITEMS) {
      const s = JSON.stringify(stripItem(q));
      expect(s).not.toMatch(/answer|accept|pairs/);
    }
    expect(stripItem(item("ch2-u4-c1"))).toEqual({ id: "ch2-u4-c1", type: "mcq", prompt: item("ch2-u4-c1").prompt, marks: 1, options: (item("ch2-u4-c1") as { options: string[] }).options });
  });
  it("the static bank answers known ids only", async () => {
    const bank = new StaticItemBank();
    expect((await bank.get("ch2-u4-p1"))?.type).toBe("fill_blank");
    expect(await bank.get("nope")).toBeNull();
  });
});

describe("validateAside — the gate for a model's live drawing", () => {
  const ok = { tal: "0.2-aside", duration_ms: 4000, actions: [{ op: "highlight", id: "g1", target: "mic.eyepiece lens", style: "circle", t: 200, dur: 600 }, { op: "label", id: "g2", target: "mic.eyepiece lens", text: "×10", side: "right", t: 1200, dur: 600 }], gestures: [{ t: 200, kind: "point", target: "mic.eyepiece lens" }] };
  it("passes a program that targets the placed asset's regions or hit-map elements", () => {
    const p = validateAside(ok, U4_SEGMENT, U4_HITMAP_TARGETS);
    expect(p.actions).toHaveLength(2);
    expect(p.duration_ms).toBe(4000);
    expect(validateAside({ actions: [{ op: "highlight", id: "g1", target: "l1", style: "circle", t: 0, dur: 500 }] }, U4_SEGMENT, U4_HITMAP_TARGETS).duration_ms).toBe(500);
    expect(asideTargets(U4_SEGMENT, ["l1", "mic"]).elements).toEqual(["l1"]); // "mic" is placed, not an element
  });
  const refuses = (mutate: (p: typeof ok) => unknown, re: RegExp) => {
    const p = JSON.parse(JSON.stringify(ok)) as typeof ok;
    mutate(p);
    expect(() => validateAside(p, U4_SEGMENT, U4_HITMAP_TARGETS)).toThrow(re);
  };
  it("refuses ops outside label/highlight/write, unresolved targets, reused ids, bad text and over-long programs", () => {
    refuses((p) => ((p.actions[0] as { op: string }).op = "place"), /not allowed in a live aside/);
    refuses((p) => ((p.actions[0] as { op: string }).op = "reveal"), /not allowed/);
    refuses((p) => (p.actions[0]!.target = "mic.nonexistent"), /does not resolve/);
    refuses((p) => (p.actions[0]!.target = "evil"), /does not resolve/);
    refuses((p) => (p.actions[0]!.id = "l1"), /duplicate id/); // the base segment already drew l1
    refuses((p) => (p.actions[1]!.id = "g1"), /duplicate id/);
    refuses((p) => ((p.actions[1] as { text: string }).text = "x‮y"), /bad text/);
    refuses((p) => (p.duration_ms = 60_000), /too long/);
    refuses((p) => (p.actions[0]!.t = 25_000), /too long/);
    refuses((p) => (p.actions = new Array(13).fill(0).map((_, i) => ({ ...ok.actions[0]!, id: `g${i}` }))), /too many actions/);
    expect(() => validateAside("not an object", U4_SEGMENT, U4_HITMAP_TARGETS)).toThrow(/not an object/);
    refuses((p) => ((p as { tal: string }).tal = "0.1"), /unsupported tal/);
    refuses((p) => ((p.gestures[0] as { kind: string }).kind = "dance"), /bad gesture kind/);
    expect(() => validateAside(ok, U4_SEGMENT, [])).not.toThrow(); // placed-asset regions need no hit map
    expect(() => validateAside({ actions: [{ op: "highlight", id: "g1", target: "l1", style: "circle", t: 0, dur: 500 }] }, U4_SEGMENT, [])).toThrow(SegmentError);
  });
});

describe("parseGraph", () => {
  it("parses the stand-in manifest and the B3 packager's Chapter 2 graph", () => {
    const standin = parseGraph(JSON.parse(readFileSync(new URL("../../../public/sk-s1/graph-ch2.json", import.meta.url), "utf-8")));
    expect(standin.units.map((u) => u.unit_key)).toEqual(["u4"]);
    expect(startCursor(standin)).toEqual({ graphVersion: 0, unitKey: "u4", assetId: "u4-explain-main", segmentId: "u4-explain-main-s1", t: 0 });
    const b3 = parseGraph(JSON.parse(readFileSync(new URL("../../../public/sk-s1/ch02/graph.json", import.meta.url), "utf-8")), "/sk-s1/ch02/");
    expect(b3.product_id).toBe("cells-structure-function-organisation");
    expect(b3.units.map((u) => u.unit_key)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(b3.units[1]!.assets[0]!.segment).toBe("/sk-s1/ch02/s2/explain-main/segment.json");
    expect(b3.units[1]!.assets[0]!.segment_id).toBe("s2-explain-main");
    expect(b3.units[1]!.figures).toEqual(["light_microscope"]);
    expect(b3.units[1]!.prereqs).toEqual(["s1"]);
    expect(b3.units[0]!.teaching_objective_id).toMatch(/^to:/); // no objective yet → keyed on the graph position
    expect(resolveUnitKey(b3, "magnification")).toBe("s5");
    expect(resolveUnitKey(b3, "3")).toBe("s3");
  });
  it("refuses a bad graph before any planner reads it", () => {
    expect(() => parseGraph({ graph_id: "g", product_id: "p", chapter: 1, version: 1, units: [] })).toThrow(GraphError);
    expect(() => parseGraph({ graph_id: "g", product_id: "p", chapter: 1, version: 1, units: [{ unit_key: "u1", title: "t", prereqs: ["u9"], assets: [] }] })).toThrow(/unknown prereq/);
    expect(() => parseGraph({ graph_id: "g", product_id: "p", chapter: 1, version: 1, units: [{ unit_key: "u1", title: "t", assets: [{ asset_id: "a", kind: "check" }] }] })).toThrow(/needs item_ids/);
    expect(() => parseGraph({ graph_id: "g", product_id: "p", chapter: 1, version: 1, units: [{ unit_key: "u1", title: "t", assets: [] }, { unit_key: "u1", title: "t", assets: [] }] })).toThrow(/duplicate/);
  });
});
