import { describe, expect, it } from "vitest";
import { kitSignature, kitsInterchangeable } from "../kit-match";

// This decides whether a teacher is handed a colleague's kit instead of making
// their own. Being wrong in the "these match" direction is the expensive
// mistake: it gives someone a lesson in the wrong language or the wrong
// teaching style and calls it a saving. Being wrong the other way only costs
// one more worker run.

const base = { kind: "presentation", chapterRef: "2", params: {}, grade: "Form 1" };

describe("kitSignature", () => {
  it("treats an unset choice and the explicitly-chosen default as the same", () => {
    // The whole feature depends on this: ~76% of live generations leave
    // narration unset, and the default comes from the BOOK's grade, so two
    // teachers who both leave it alone must land on one signature.
    const implicit = kitSignature({ ...base, params: {} });
    const explicit = kitSignature({ ...base, params: { narration_style: "socratic" } });
    expect(implicit).toBe(explicit); // Form 1 ⇒ grade 7 ⇒ socratic
  });

  it("accepts both spellings of narration style seen in the live data", () => {
    expect(kitSignature({ ...base, params: { narration_style: "storytelling" } })).toBe(
      kitSignature({ ...base, params: { narrationStyle: "Storytelling" } }),
    );
  });

  it("separates a different teaching style", () => {
    expect(kitSignature({ ...base, params: { narration_style: "storytelling" } })).not.toBe(
      kitSignature({ ...base, params: { narration_style: "socratic" } }),
    );
  });

  it("separates a different language — the mistake that would matter most", () => {
    expect(kitSignature({ ...base, params: { language: "ms" } })).not.toBe(
      kitSignature({ ...base, params: { language: "en" } }),
    );
  });

  it("separates parts of the same chapter", () => {
    expect(kitSignature({ ...base, params: { part: 1 } })).not.toBe(kitSignature({ ...base, params: { part: 2 } }));
  });

  it("separates chapters and kinds", () => {
    expect(kitSignature({ ...base, chapterRef: "2" })).not.toBe(kitSignature({ ...base, chapterRef: "3" }));
    expect(kitSignature({ ...base, kind: "presentation" })).not.toBe(kitSignature({ ...base, kind: "worksheet" }));
  });

  it("ignores voice on a document, which has no audio", () => {
    const doc = { ...base, kind: "worksheet" };
    expect(kitSignature({ ...doc, params: { tts_voice: "edge-aria" } })).toBe(
      kitSignature({ ...doc, params: { tts_voice: "edge-yasmin" } }),
    );
  });

  it("respects voice on the lesson, which does", () => {
    expect(kitSignature({ ...base, params: { tts_voice: "edge-aria" } })).not.toBe(
      kitSignature({ ...base, params: { tts_voice: "edge-yasmin" } }),
    );
  });

  it("separates difficulty on an assessment", () => {
    const w = { ...base, kind: "exam_paper" };
    expect(kitSignature({ ...w, params: { difficulty: "easy" } })).not.toBe(
      kitSignature({ ...w, params: { difficulty: "hard" } }),
    );
  });

  it("does not let the book's grade leak into an explicit choice", () => {
    // Same explicit style, different books: still the same kit request.
    expect(kitSignature({ ...base, grade: "Form 1", params: { narration_style: "socratic" } })).toBe(
      kitSignature({ ...base, grade: "Standard 3", params: { narration_style: "socratic" } }),
    );
  });

  it("DOES separate two unset kits whose books imply different styles", () => {
    // Standard 3 ⇒ storytelling, Form 1 ⇒ socratic. Neither teacher chose, but
    // the worker would produce different lessons, so they must not match.
    expect(kitSignature({ ...base, grade: "Standard 3", params: {} })).not.toBe(
      kitSignature({ ...base, grade: "Form 1", params: {} }),
    );
  });
});

describe("kitsInterchangeable", () => {
  it("matches the realistic case: two teachers, same book and chapter, no fiddling", () => {
    const sara = { kind: "presentation", chapterRef: "3", params: { part: 1 }, grade: "Form 1" };
    const raj = { kind: "presentation", chapterRef: "3", params: { part: 1 }, grade: "Form 1" };
    expect(kitsInterchangeable(sara, raj)).toBe(true);
  });

  it("refuses when one of them wanted Malay", () => {
    const sara = { kind: "presentation", chapterRef: "3", params: { part: 1 }, grade: "Form 1" };
    const raj = { kind: "presentation", chapterRef: "3", params: { part: 1, language: "ms" }, grade: "Form 1" };
    expect(kitsInterchangeable(sara, raj)).toBe(false);
  });
});
