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

// The EFFECTIVE voice (founder, 2026-09-03): the app now sends `auto`, so the
// comparison must read what a kit RENDERED with, and predict what `auto` will
// render as for this account. Getting this wrong in the "match" direction hands
// a paying school a colleague's free-voice lesson and calls it a saving.
describe("kitSignature — effective voice", () => {
  it("`auto` and an absent voice are the same non-choice", () => {
    expect(kitSignature({ ...base, params: { tts_voice: "auto" } })).toBe(kitSignature({ ...base, params: {} }));
    expect(kitSignature({ ...base, params: { tts_voice: "AUTO" } })).toBe(kitSignature({ ...base, params: {} }));
  });

  it("what a finished kit rendered with wins over what was asked", () => {
    const rendered = kitSignature({ ...base, params: { tts_voice: "auto", tts_voice_used: "g-en-f" } });
    expect(rendered).toBe(kitSignature({ ...base, params: { tts_voice: "g-en-f" } }));
    expect(rendered).not.toBe(kitSignature({ ...base, params: { tts_voice: "auto" } }));
    // A downgraded render (asked premium, got free) compares as what it IS.
    expect(kitSignature({ ...base, params: { tts_voice: "el-rachel", tts_voice_used: "edge-aria" } })).toBe(
      kitSignature({ ...base, params: { tts_voice: "edge-aria" } }),
    );
  });

  it("tolerates the list shape of the rendered voice", () => {
    expect(kitSignature({ ...base, params: { tts_voice_used: ["edge-aria", "edge-guy"] } })).toBe(
      kitSignature({ ...base, params: { tts_voice: "edge-aria" } }),
    );
  });

  it("a predicted default lets an `auto` request match a kit that rendered with that voice", () => {
    const wanted = kitSignature({ ...base, params: { tts_voice: "auto" }, defaultVoice: "g-en-f" });
    expect(wanted).toBe(kitSignature({ ...base, params: { tts_voice_used: "g-en-f" } }));
    // …and NOT a colleague's free-voice kit — the case that would matter most
    // for a paying school after the provider flip.
    expect(wanted).not.toBe(kitSignature({ ...base, params: { tts_voice_used: "edge-aria" } }));
    // Two untouched requests on the same plan still match each other.
    expect(wanted).toBe(kitSignature({ ...base, params: {}, defaultVoice: "g-en-f" }));
  });

  it("models the real call: the click predicts its plan's default, a finished kit resolves to the FREE default", () => {
    // GenerateKitButton passes expectedVoiceFor() for what THIS click will
    // render as, and defaultVoiceFor() for a colleague's finished kit that
    // carries no voice record (it predates the premium era and rendered free).
    const wantedPaid = kitSignature({ ...base, params: { tts_voice: "auto" }, defaultVoice: "g-en-f" });
    const wantedFree = kitSignature({ ...base, params: { tts_voice: "auto" }, defaultVoice: "edge-aria" });
    const oldRow = kitSignature({ ...base, params: {}, defaultVoice: "edge-aria" });
    const premiumRow = kitSignature({ ...base, params: { tts_voice_used: "g-en-f" }, defaultVoice: "edge-aria" });
    expect(wantedFree).toBe(oldRow);            // a free plan adopts the old free kit
    expect(wantedPaid).not.toBe(oldRow);        // a paid plan after the flip does NOT
    expect(wantedPaid).toBe(premiumRow);        // …but adopts a colleague's premium render
    expect(wantedFree).not.toBe(premiumRow);
  });

  it("the prediction never touches documents", () => {
    const doc = { ...base, kind: "worksheet" };
    expect(kitSignature({ ...doc, params: {}, defaultVoice: "g-en-f" })).toBe(kitSignature({ ...doc, params: {} }));
  });
});
