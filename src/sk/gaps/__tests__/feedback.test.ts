// The 👎 body (signal E): validation and cuts, and the client's question /
// earlier pairs from the transcript.
import { describe, expect, it } from "vitest";
import { GAP_NOTE_MAX, GAP_QUESTION_MAX, GAP_REPLY_MAX, feedbackContext, parseGapFeedback } from "../feedback";

describe("parseGapFeedback", () => {
  it("accepts the minimum and cuts what is long", () => {
    const r = parseGapFeedback({ turnId: " t1 ", question: "q".repeat(5000), reply: "a".repeat(5000) });
    expect(r).toEqual({ turnId: "t1", question: "q".repeat(GAP_QUESTION_MAX), reply: "a".repeat(GAP_REPLY_MAX), note: null, previous: [], page: null });
  });
  it("keeps the note, the page and at most two earlier pairs (the latest)", () => {
    const r = parseGapFeedback({
      turnId: "t1",
      question: "email 7B",
      reply: "I can't.",
      note: " send the worksheet ",
      page: "/dashboard",
      previous: [{ q: "1", a: "a1" }, { q: "2", a: "a2" }, { q: "3", a: "a3" }, "junk"],
    });
    expect(r).toMatchObject({ note: "send the worksheet", page: "/dashboard", previous: [{ q: "3", a: "a3" }] });
    const r2 = parseGapFeedback({ turnId: "t1", question: "q", previous: [{ q: "1", a: "a1" }, { q: "2", a: "a2" }] });
    expect(r2).toMatchObject({ previous: [{ q: "1", a: "a1" }, { q: "2", a: "a2" }] });
  });
  it("refuses a missing turnId or question, a bad note, an over-long note", () => {
    expect(parseGapFeedback(null)).toEqual({ error: "Invalid body." });
    expect(parseGapFeedback([])).toEqual({ error: "Invalid body." });
    expect(parseGapFeedback({ question: "q" })).toEqual({ error: "turnId is required." });
    expect(parseGapFeedback({ turnId: "x".repeat(81), question: "q" })).toEqual({ error: "turnId is required." });
    expect(parseGapFeedback({ turnId: "t", question: "  " })).toEqual({ error: "question is required." });
    expect(parseGapFeedback({ turnId: "t", question: "q", note: 4 })).toEqual({ error: "Invalid note." });
    expect("error" in parseGapFeedback({ turnId: "t", question: "q", note: "n".repeat(GAP_NOTE_MAX + 1) })).toBe(true);
  });
});

describe("feedbackContext", () => {
  const entries = [
    { id: "g", who: "sk" as const, text: "Hi, I'm SK." },
    { id: "u1", who: "user" as const, text: "q1" },
    { id: "s1", who: "sk" as const, text: "a1" },
    { id: "u2", who: "user" as const, text: "q2" },
    { id: "s2", who: "sk" as const, text: "a2" },
    { id: "u3", who: "user" as const, text: "q3" },
    { id: "s3", who: "sk" as const, text: "a3" },
    { id: "u4", who: "user" as const, text: "q4" },
    { id: "s4", who: "sk" as const, text: "a4" },
  ];
  it("the reply's question and the two exchanges before it", () => {
    expect(feedbackContext(entries, "s4")).toEqual({ question: "q4", reply: "a4", previous: [{ q: "q2", a: "a2" }, { q: "q3", a: "a3" }] });
    expect(feedbackContext(entries, "s1")).toEqual({ question: "q1", reply: "a1", previous: [] });
  });
  it("a reply with no question of its own (the greeting) or an unknown id → null", () => {
    expect(feedbackContext(entries, "g")).toBeNull();
    expect(feedbackContext(entries, "nope")).toBeNull();
    expect(feedbackContext(entries, "u2")).toBeNull();
  });
});
