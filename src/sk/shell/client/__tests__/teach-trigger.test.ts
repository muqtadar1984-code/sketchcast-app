/**
 * SK starts teaching by itself (student Board phase 3, 2026-10-31): phase 2's
 * `sk:learner-gap` detail → a teaching request, one lesson per stuck moment;
 * `sk:learner-done` → the Extra offer, once per lesson.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/teach-trigger.test.ts
 */
import { describe, expect, it } from "vitest";
import { GAP_REPEAT_MS, SK_LEARNER_DONE_EVENT, SK_LEARNER_GAP_EVENT, createDoneGate, createGapGate, extraRequest, gapRequest } from "../teach-trigger";

const DETAIL = {
  generationId: "55555555-5555-4555-8555-555555555555",
  questionId: "q3",
  questionText: "Simplify 6/8.",
  concept: "Equivalent fractions",
  attempts: 2,
  lastAnswer: "6/4",
  reason: "wrong_twice",
};

describe("the events phase 2 and the coach dispatch", () => {
  it("are named exactly", () => {
    expect(SK_LEARNER_GAP_EVENT).toBe("sk:learner-gap");
    expect(SK_LEARNER_DONE_EVENT).toBe("sk:learner-done");
  });

  it("a gap detail becomes a gap teaching request (whatever trigger it claims)", () => {
    expect(gapRequest(DETAIL)).toEqual({ trigger: "gap", ...DETAIL });
    expect(gapRequest({ ...DETAIL, trigger: "extra" })?.trigger).toBe("gap");
    expect(gapRequest({ reason: "asked_help", questionText: "Name the process." })).toEqual({ trigger: "gap", reason: "asked_help", questionText: "Name the process." });
    expect(gapRequest(null)).toBeNull();
    expect(gapRequest({ attempts: 2 })).toBeNull();
  });

  it("the Extra step after the kit", () => {
    expect(extraRequest({ generationId: DETAIL.generationId })).toEqual({ trigger: "extra", generationId: DETAIL.generationId });
    expect(extraRequest(undefined)).toEqual({ trigger: "extra" });
  });
});

describe("one stuck moment, one lesson", () => {
  it("the same question again within the window is not taught twice", () => {
    const g = createGapGate();
    const req = gapRequest(DETAIL)!;
    expect(g.take(req, 0)).toBe(true);
    expect(g.take(req, 10_000)).toBe(false);
    expect(g.take({ ...req, questionId: "q4" }, 10_000)).toBe(true);
    expect(g.take(req, GAP_REPEAT_MS + 1)).toBe(true);
  });

  it("the Extra offer is made once per lesson", () => {
    const d = createDoneGate();
    expect(d.take({ generationId: "a" })).toBe(true);
    expect(d.take({ generationId: "a" })).toBe(false);
    expect(d.take({ generationId: "b" })).toBe(true);
  });
});
