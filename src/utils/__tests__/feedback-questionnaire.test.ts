import { describe, expect, it } from "vitest";
import {
  EMPTY_ANSWERS,
  MOST_USED_OPTIONS,
  RATING_KEYS,
  answersComplete,
  buildSubmitBody,
  type QuestionnaireAnswers,
} from "../feedback-questionnaire";

// The rules the modal's Send button enforces (and the body it posts). The
// server re-validates; this suite pins the CLIENT gate so a UI refactor can't
// quietly start allowing half-filled submissions or renaming a payload field
// the /api/feedback contract (0083) depends on.

const complete: QuestionnaireAnswers = {
  ease: 4,
  usefulness: 5,
  quality: 3,
  mostUsed: "worksheet",
  blocker: "",
  wish: "",
  contactOk: false,
};

describe("answersComplete", () => {
  it("rejects the empty form", () => {
    expect(answersComplete(EMPTY_ANSWERS)).toBe(false);
  });

  it("accepts three ratings + a most-used pick, textareas empty", () => {
    expect(answersComplete(complete)).toBe(true);
  });

  it.each(RATING_KEYS)("requires %s", (key) => {
    expect(answersComplete({ ...complete, [key]: 0 })).toBe(false);
  });

  it("requires the most-used pick", () => {
    expect(answersComplete({ ...complete, mostUsed: "" })).toBe(false);
  });

  it.each([0, 6, -1, 2.5, NaN])("rejects the out-of-range rating %p", (bad) => {
    expect(answersComplete({ ...complete, ease: bad })).toBe(false);
  });

  it.each([1, 2, 3, 4, 5])("accepts every star value (%i)", (n) => {
    expect(answersComplete({ ...complete, ease: n, usefulness: n, quality: n })).toBe(true);
  });

  it.each(MOST_USED_OPTIONS)("accepts the %s option", (opt) => {
    expect(answersComplete({ ...complete, mostUsed: opt })).toBe(true);
  });
});

describe("buildSubmitBody", () => {
  it("returns null while incomplete — the disabled-button rule holds even if the button fires", () => {
    expect(buildSubmitBody("req-1", EMPTY_ANSWERS)).toBeNull();
    expect(buildSubmitBody("req-1", { ...complete, quality: 0 })).toBeNull();
  });

  it("builds the exact /api/feedback submit payload", () => {
    expect(
      buildSubmitBody("req-1", { ...complete, blocker: "slow uploads", wish: "an mcq mode", contactOk: true }),
    ).toEqual({
      action: "submit",
      request_id: "req-1",
      ease: 4,
      usefulness: 5,
      quality: 3,
      most_used: "worksheet",
      blocker: "slow uploads",
      wish: "an mcq mode",
      contact_ok: true,
    });
  });

  it("trims free text and turns whitespace-only answers into null, never \"\"", () => {
    const body = buildSubmitBody("req-1", { ...complete, blocker: "  spaces  ", wish: "   " });
    expect(body?.blocker).toBe("spaces");
    expect(body?.wish).toBeNull();
  });

  it("carries the DB's most_used vocabulary exactly (incl. 'none' for Haven't-used-yet)", () => {
    // These strings are the 0083 check-constraint values — a rename here is a
    // 500 in production, not a type error.
    expect(MOST_USED_OPTIONS).toEqual([
      "presentation",
      "worksheet",
      "exam_paper",
      "lesson_plan",
      "activity",
      "case_study",
      "none",
    ]);
  });
});
