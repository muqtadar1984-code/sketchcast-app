import { describe, expect, it } from "vitest";
import { docTypeKey, gateReasons, isGated, isStructureGate, stampConfirmation } from "@/utils/junk-gate";

describe("isGated", () => {
  it("treats absent health as not gated — every book indexed before the gate existed", () => {
    expect(isGated(null)).toBe(false);
    expect(isGated(undefined)).toBe(false);
  });

  it("treats an absent gate key as not gated — older health payloads carry no gate", () => {
    expect(isGated({ facts: { doc_type: "administrative" }, problems: ["Looks like a form."] })).toBe(false);
  });

  it('gate "none" is not gated', () => {
    expect(isGated({ gate: "none" })).toBe(false);
  });

  it('only an explicit "confirm" gates — unknown values fail open, never blocking', () => {
    expect(isGated({ gate: "confirm" })).toBe(true);
    expect(isGated({ gate: "block" })).toBe(false);
    expect(isGated({ gate: "" })).toBe(false);
  });
});

describe("gateReasons", () => {
  it("returns the worker's problems[] sentences as-is", () => {
    const problems = ["No chapter structure detected.", "Mostly tables and signature lines."];
    expect(gateReasons({ gate: "confirm", problems })).toEqual(problems);
  });

  it("degrades to empty for absent health or problems", () => {
    expect(gateReasons(null)).toEqual([]);
    expect(gateReasons({ gate: "confirm" })).toEqual([]);
  });

  it("drops blank entries — a padded problems list must not render empty bullets", () => {
    expect(gateReasons({ gate: "confirm", problems: ["Real reason.", "", "  "] })).toEqual(["Real reason."]);
  });
});

describe("docTypeKey", () => {
  it("maps the worker's doc_type vocabulary to dictionary keys", () => {
    expect(docTypeKey({ facts: { doc_type: "administrative" } })).toBe("administrative");
    expect(docTypeKey({ facts: { doc_type: "form_or_roster" } })).toBe("form_or_roster");
    expect(docTypeKey({ facts: { doc_type: "other" } })).toBe("other");
  });

  it('"textbook" is its own key — a gated real book must not render as "Unrecognized document"', () => {
    expect(docTypeKey({ facts: { doc_type: "textbook" } })).toBe("textbook");
  });

  it('falls back to "other" for unknown or missing doc_type', () => {
    expect(docTypeKey({ facts: { doc_type: "novel" } })).toBe("other");
    expect(docTypeKey({ facts: {} })).toBe("other");
    expect(docTypeKey(null)).toBe("other");
  });
});

describe("isStructureGate", () => {
  const suspect = { chapter_quality: { suspect: true } };

  it("follows the worker's stamped chapter-quality verdict, not the doc label", () => {
    // The Sara shape: a genuine textbook whose chapter MAP is suspect.
    expect(isStructureGate({ gate: "confirm", facts: { doc_type: "textbook", ...suspect } })).toBe(true);
    // A 2-page textbook gated by the VOLUME rule with a sound map keeps the
    // junk-material copy — chapter-problem copy would contradict the quoted
    // "only 2 pages" reason.
    expect(
      isStructureGate({ gate: "confirm", facts: { doc_type: "textbook", chapter_quality: { suspect: false } } }),
    ).toBe(false);
  });

  it("gives accurate framing when the classifier was down or the doc is teaching material", () => {
    // doc_type "unknown" (classifier outage, fail-open) with a junk map must
    // NOT collapse to "Doesn't look like a textbook" — Sara's trust problem
    // reproduced whenever the classifier is down.
    expect(isStructureGate({ gate: "confirm", facts: { doc_type: "unknown", ...suspect } })).toBe(true);
    expect(isStructureGate({ gate: "confirm", facts: { doc_type: "workbook", ...suspect } })).toBe(true);
    expect(isStructureGate({ gate: "confirm", facts: { doc_type: "exam_material", ...suspect } })).toBe(true);
  });

  it("junk-MATERIAL categories keep their own framing even with a suspect map", () => {
    expect(isStructureGate({ gate: "confirm", facts: { doc_type: "administrative", ...suspect } })).toBe(false);
    expect(isStructureGate({ gate: "confirm", facts: { doc_type: "form_or_roster", ...suspect } })).toBe(false);
  });

  it("degrades safely on older health payloads without the stamp", () => {
    expect(isStructureGate({ gate: "confirm", facts: { doc_type: "textbook" } })).toBe(false);
    expect(isStructureGate(null)).toBe(false);
    expect(isStructureGate(undefined)).toBe(false);
  });
});

describe("stampConfirmation", () => {
  it("merges the junk_gate marker without clobbering existing params keys", () => {
    const stamped = stampConfirmation({ language: "ms", part: 2 });
    expect(stamped.language).toBe("ms");
    expect(stamped.part).toBe(2);
    expect(typeof (stamped.junk_gate as { confirmed_at: string }).confirmed_at).toBe("string");
  });

  it("stamps an ISO timestamp the console can read back", () => {
    const { junk_gate } = stampConfirmation(null) as { junk_gate: { confirmed_at: string } };
    expect(new Date(junk_gate.confirmed_at).toISOString()).toBe(junk_gate.confirmed_at);
  });

  it("turns null/absent params into just the marker", () => {
    expect(Object.keys(stampConfirmation(null))).toEqual(["junk_gate"]);
    expect(Object.keys(stampConfirmation(undefined))).toEqual(["junk_gate"]);
  });

  it("does not mutate the params it is given", () => {
    const params = { language: "en" };
    stampConfirmation(params);
    expect(params).toEqual({ language: "en" });
  });
});
