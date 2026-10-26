// SK S1 adversarial suite — the segment is data; every way a model or a file
// could smuggle something onto the board must be refused WHOLE (contracts §2,
// plan §14). Each case mutates the real U4 fixture and expects SegmentError.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIMITS, SegmentError, validateSegment, type Segment } from "../engine";

const FIXTURE = JSON.parse(readFileSync(new URL("../../../../../public/sk-s1/u4/segment.json", import.meta.url), "utf-8")) as Segment;
const clone = (): Segment => JSON.parse(JSON.stringify(FIXTURE));
const refuses = (mutate: (s: Segment) => void) => {
  const s = clone();
  mutate(s);
  expect(() => validateSegment(s)).toThrow(SegmentError);
};
const write = (s: Segment) => s.actions.find((a) => a.op === "write")! as Extract<Segment["actions"][number], { op: "write" }>;
const label = (s: Segment) => s.actions.find((a) => a.op === "label")! as Extract<Segment["actions"][number], { op: "label" }>;

describe("the real fixture passes", () => {
  it("validates the generated U4 segment unchanged", () => {
    expect(validateSegment(clone())).toBeTruthy();
  });
});

describe("text injection is inert or refused", () => {
  it("script tags in a label are allowed as TEXT (textContent) but bidi/control characters are refused", () => {
    const s = clone();
    label(s).text = "<script>alert(1)</script>"; // harmless: rendered via textContent, never innerHTML
    expect(() => validateSegment(s)).not.toThrow();
    refuses((s) => (label(s).text = "eyepiece‮snel")); // RTL override disguises the word
    refuses((s) => (label(s).text = "x\u0000y"));
    refuses((s) => (write(s).text = "a".repeat(LIMITS.text + 1)));
  });
});

describe("resource and attribute injection", () => {
  it("refuses a remote or javascript: asset source", () => {
    refuses((s) => (s.assets.light_microscope!.src = "https://evil.example/x.png"));
    refuses((s) => (s.assets.light_microscope!.src = "javascript:alert(1)"));
    refuses((s) => (s.assets.light_microscope!.src = "../../../etc/passwd"));
  });
  it("refuses ids that are not tokens (attribute / selector escape)", () => {
    refuses((s) => (write(s).id = 'w1" onload="alert(1)'));
    refuses((s) => (write(s).id = "w1]; { }"));
    refuses((s) => ((s.actions[0] as { as: string }).as = "mic<svg>"));
  });
  it("refuses unknown ops, styles and sides", () => {
    refuses((s) => ((s.actions[1] as { op: string }).op = "script"));
    refuses((s) => ((write(s) as { style: string }).style = "url(javascript:1)"));
    refuses((s) => ((label(s) as { side: string }).side = "up"));
  });
  it("refuses a place that points outside the bundled assets", () => {
    refuses((s) => ((s.actions[0] as { ref: string }).ref = "asset:../other"));
    refuses((s) => ((s.actions[0] as { ref: string }).ref = "https://x/y.png"));
  });
});

describe("numeric abuse", () => {
  it("refuses NaN, Infinity and huge coordinates/sizes", () => {
    refuses((s) => (write(s).at.x = Number.NaN));
    refuses((s) => (write(s).at.y = Number.POSITIVE_INFINITY));
    refuses((s) => (write(s).at.x = 1e9));
    refuses((s) => (write(s).size = 1e6));
    refuses((s) => (write(s).t = -1));
    refuses((s) => (s.assets.light_microscope!.trace.push([1e12, 0])));
  });
});

describe("resource exhaustion", () => {
  it("refuses more actions, words or trace points than the limits", () => {
    refuses((s) => {
      const w = write(s);
      for (let i = 0; i < LIMITS.actions; i++) s.actions.push({ ...w, id: `x${i}` });
    });
    refuses((s) => {
      const t = s.assets.light_microscope!.trace;
      while (t.length <= LIMITS.trace) t.push([1, 1]);
    });
    refuses((s) => {
      while (s.marks.words.length <= LIMITS.words) s.marks.words.push({ i: 0, t0: 0, t1: 1, text: "x" });
    });
  });
  it("refuses duplicate ids (a second element could shadow the first)", () => {
    refuses((s) => (write(s).id = label(s).id));
  });
});
