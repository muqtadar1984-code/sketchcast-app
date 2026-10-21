/**
 * The Fix Agent's pure rules (utils/fixes/fix-cases.ts, migration 0151):
 * founder-facing labels, which case takes a decision, the decision's columns,
 * the page's order and 30-day window, the defensive readers over the worker's
 * JSON, and the evidence table's highlight.
 *
 * Run: npx vitest run src/utils/__tests__/fix-cases.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  DECISION_NOTE_MAX,
  FIX_STATUSES,
  actionLabel,
  actionsOf,
  checkRuleOf,
  classificationLabel,
  cleanNote,
  decisionPatch,
  findingsOf,
  highlightSegments,
  historyOf,
  isDecidable,
  isDecision,
  outcomeInReview,
  sortCases,
  statusLabel,
  usd,
  verdictsOf,
  visibleCases,
  waiversOf,
  type FixCase,
} from "../fixes/fix-cases";

const NOW = Date.parse("2026-10-21T10:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const row = (id: string, status: string, updated: string, extra: Partial<FixCase> = {}): FixCase => ({ id, status, updated_at: updated, created_at: updated, ...extra });

describe("labels", () => {
  it("says every status in the founder's words", () => {
    expect(FIX_STATUSES.map(statusLabel)).toEqual([
      "Diagnosing",
      "Diagnosing",
      "Waiting for you",
      "Approved — waiting for the lane",
      "Retrying",
      "In review — done",
      "Rejected",
      "Needs your attention",
    ]);
    expect(statusLabel("something_new")).toBe("something_new");
    expect(statusLabel(null)).toBe("Unknown");
  });

  it("names the actions and the classifications", () => {
    expect(["rerun", "rerun_with_note", "rerun_with_waiver", "check_rule"].map(actionLabel)).toEqual([
      "Re-run",
      "Re-run with an instruction",
      "Re-run with a waiver",
      "Fix the check (needs a PR)",
    ]);
    expect(actionLabel("toString")).toBe("toString");
    expect(actionLabel(undefined)).toBe("Unknown action");
    expect(classificationLabel("check_false_positive")).toMatch(/False alarm/);
    expect(classificationLabel("translation_error")).toMatch(/translation was wrong/);
    expect(classificationLabel("infrastructure")).toMatch(/Infrastructure/);
    expect(classificationLabel(undefined)).toBe(classificationLabel("unknown"));
    expect(classificationLabel("novel")).toBe("novel");
  });
});

describe("the decision", () => {
  it("is open only on a proposal", () => {
    expect(isDecidable({ status: "proposed" })).toBe(true);
    for (const s of FIX_STATUSES.filter((s) => s !== "proposed")) expect(isDecidable({ status: s }), s).toBe(false);
    expect(isDecidable(null)).toBe(false);
    expect(isDecision("approve")).toBe(true);
    expect(isDecision("reject")).toBe(true);
    expect(isDecision("on")).toBe(false);
  });

  it("writes status, who, when, the trimmed note and updated_at — nothing else", () => {
    expect(decisionPatch("approve", "u1", undefined, "2026-10-21T10:00:00Z")).toEqual({
      status: "approved",
      decided_by: "u1",
      decided_at: "2026-10-21T10:00:00Z",
      decision_note: null,
      updated_at: "2026-10-21T10:00:00Z",
    });
    const r = decisionPatch("reject", "u2", "  not this way  ", "t");
    expect(r.status).toBe("rejected");
    expect(r.decision_note).toBe("not this way");
  });

  it("caps the note and drops a blank or non-string one", () => {
    expect(cleanNote("x".repeat(DECISION_NOTE_MAX + 50))).toHaveLength(DECISION_NOTE_MAX);
    expect(cleanNote("   ")).toBeNull();
    expect(cleanNote(42)).toBeNull();
  });
});

describe("order and window", () => {
  it("puts open cases first in lifecycle order, newest first within a status, then closed newest first", () => {
    const rows = [
      row("r-old", "resolved", daysAgo(5), { resolved_at: daysAgo(5) }),
      row("p-old", "proposed", daysAgo(3)),
      row("nf", "needs_founder", daysAgo(1)),
      row("x", "rejected", daysAgo(1)),
      row("ap", "applied", daysAgo(2)),
      row("p-new", "proposed", daysAgo(1)),
      row("d", "diagnosing", daysAgo(4)),
      row("a", "approved", daysAgo(4)),
      row("n", "new", daysAgo(0)),
    ];
    expect(sortCases(rows).map((r) => r.id)).toEqual(["n", "d", "p-new", "p-old", "a", "ap", "nf", "x", "r-old"]);
  });

  it("shows every open case and the closed ones from the last 30 days", () => {
    const rows = [
      row("open-old", "needs_founder", daysAgo(90)),
      row("closed-recent", "rejected", daysAgo(29)),
      row("closed-old", "resolved", daysAgo(60), { resolved_at: daysAgo(31) }),
    ];
    expect(visibleCases(rows, NOW).map((r) => r.id)).toEqual(["open-old", "closed-recent"]);
  });
});

describe("defensive readers", () => {
  it("survive a missing, null or wrong-shaped field", () => {
    for (const bad of [undefined, null, "x", 3, [], { findings: "no" }]) {
      expect(findingsOf(bad)).toEqual([]);
      expect(verdictsOf(bad)).toEqual([]);
      expect(actionsOf(bad)).toEqual([]);
      expect(waiversOf(bad)).toEqual([]);
      expect(checkRuleOf(bad)).toBeNull();
      expect(historyOf(bad)).toEqual([]);
    }
  });

  it("read the worker's shapes, stringifying number lists", () => {
    expect(findingsOf({ findings: [{ where: "slide 3", what: "numbers", extra: [12], missing: ["3.5"], source: "a", target: "b" }, "junk"] })).toEqual([
      { where: "slide 3", what: "numbers", extra: ["12"], missing: ["3.5"], source: "a", target: "b" },
    ]);
    expect(verdictsOf({ verdicts: [{ where: "w", verdict: "faithful", why: "same" }] })).toEqual([{ where: "w", verdict: "faithful", why: "same" }]);
    expect(actionsOf({ actions: ["rerun", 5, null] })).toEqual(["rerun", "5"]);
    expect(waiversOf({ waivers: [{ where: "q1", extra: ["2"] }] })[0]).toMatchObject({ where: "q1", extra: ["2"], missing: [] });
    expect(checkRuleOf({ check_rule: { file: "f.py" } })).toBeNull();
    expect(checkRuleOf({ check_rule: { change: "allow ordinals" } })).toEqual({ file: undefined, change: "allow ordinals", test: undefined });
    expect(historyOf([{ round: 1, decided_by: "u1", outcome: { kit_status: "failed" } }])[0]).toMatchObject({ round: 1, decided_by: "u1", outcome: { kit_status: "failed" } });
  });

  it("formats a cost from a number or a numeric string", () => {
    expect(usd(0.5)).toBe("$0.50");
    expect(usd("1.2345")).toBe("$1.23");
    expect(usd(0.001)).toBe("<$0.01");
    expect(usd(0)).toBe("$0.00");
    expect(usd("abc")).toBeNull();
    expect(usd(undefined)).toBeNull();
  });

  it("knows when the retried kit is worth a link", () => {
    expect(outcomeInReview({ kit_status: "in_review" })).toBe(true);
    expect(outcomeInReview({ translation_status: "approved" })).toBe(true);
    expect(outcomeInReview({}, "resolved")).toBe(true);
    expect(outcomeInReview({ kit_status: "failed" }, "applied")).toBe(false);
    expect(outcomeInReview(null)).toBe(false);
  });
});

describe("highlightSegments", () => {
  const hits = (text: string, tokens: string[]) => highlightSegments(text, tokens).filter((s) => s.hit).map((s) => s.text);

  it("marks every case-insensitive occurrence and keeps the text whole", () => {
    const segs = highlightSegments("Area is 12 cm, then 12 CM again", ["cm"]);
    expect(segs.map((s) => s.text).join("")).toBe("Area is 12 cm, then 12 CM again");
    expect(hits("Area is 12 cm, then 12 CM again", ["cm"])).toEqual(["cm", "CM"]);
  });

  it("does not light a digit token up inside a longer number", () => {
    expect(hits("x = 12 and 2", ["2"])).toEqual(["2"]);
    expect(hits("3.5 and 13.55", ["3.5"])).toEqual(["3.5"]);
  });

  it("prefers the longest token at a position", () => {
    expect(hits("value 3.5", ["3", "3.5"])).toEqual(["3.5"]);
  });

  it("returns plain text for no tokens and nothing for no text", () => {
    expect(highlightSegments("abc", [])).toEqual([{ text: "abc", hit: false }]);
    expect(highlightSegments("", ["a"])).toEqual([]);
  });
});
