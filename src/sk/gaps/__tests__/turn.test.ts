// The gap tracker's per-turn collector: one row per signal, repeats folded
// into that row's items, `phrase` only when nothing else fired.
import { describe, expect, it } from "vitest";
import { GAP_ITEMS_MAX, TurnGaps, type TurnGapBase } from "../turn";

const base: TurnGapBase = {
  turnId: "t-1",
  userId: "u-1",
  role: "student",
  locale: "ms",
  page: "/dashboard",
  modality: "voice",
  question: "activate SKBE1-ABCD-EFGH-JKLM",
  reply: "I can't do that from here.",
  route: "model",
  tools: ["book.activate"],
};

describe("TurnGaps", () => {
  it("nothing noted and a plain reply → no rows", () => {
    expect(new TurnGaps().rows({ ...base, reply: "Opening the Library." })).toEqual([]);
  });

  it("nothing noted but the reply says it cannot → one `phrase` row", () => {
    const rows = new TurnGaps().rows(base);
    expect(rows).toEqual([{ ...base, signal: "phrase", wanted: null, context: { items: [{ lang: "en", match: "i can't" }] } }]);
  });

  it("a noted signal suppresses the phrase net, and keeps the question as asked", () => {
    const g = new TurnGaps();
    g.note("refusal", { kind: "action_claim" });
    const rows = g.rows(base);
    expect(rows.map((r) => r.signal)).toEqual(["refusal"]);
    expect(rows[0]!.question).toBe("activate SKBE1-ABCD-EFGH-JKLM");
  });

  it("repeats of a signal fold into ONE row (0177's unique turn+signal); `wanted` is the first", () => {
    const g = new TurnGaps();
    g.note("tool_failed", { tool: "a", error: "x" });
    g.note("tool_failed", { tool: "b", error: "y" });
    g.note("self", { wanted: "first" }, "first");
    g.note("self", { wanted: "second" }, "second");
    const rows = g.rows(base);
    expect(rows.map((r) => r.signal)).toEqual(["tool_failed", "self"]);
    expect(rows[0]!.context).toEqual({ items: [{ tool: "a", error: "x" }, { tool: "b", error: "y" }] });
    expect(rows[1]!.wanted).toBe("first");
    expect(g.signals).toEqual(["tool_failed", "self"]);
  });

  it("items are capped and their strings and lists cut", () => {
    const g = new TurnGaps();
    for (let i = 0; i < GAP_ITEMS_MAX + 5; i++) g.note("grounding", { where: "model", dropped: Array.from({ length: 50 }, () => "x".repeat(500)), skip: undefined });
    const items = (g.rows(base)[0]!.context as { items: Array<{ dropped: string[] }> }).items;
    expect(items).toHaveLength(GAP_ITEMS_MAX);
    expect(items[0]!.dropped).toHaveLength(20);
    expect(items[0]!.dropped[0]).toHaveLength(300);
    expect(items[0]).not.toHaveProperty("skip");
  });
});
