// SK B2 — a packager Chapter 2 unit (B3 output) passes both gates unchanged;
// every manifest gesture targets something its hit map can resolve; and the
// hardened segment gate refuses the new ways a manifest could misbehave.
// S3 slice E: the six packaged units under public/ (and the dev harness's
// canned asides) were retired with the clip path; the gates are kept, so the
// s2 unit and the U4 fixture now come inline from src/sk/__tests__.
import { describe, expect, it } from "vitest";
import { CH02_S2_HITMAP, CH02_S2_SEGMENT, U4_SEGMENT } from "../../__tests__/segment-fixtures";
import { checkpointFor, hitTargets, SegmentError, validateHitMap, validateSegment, type HitMap, type Segment } from "../engine";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const unit = () => ({ seg: clone<Segment>(CH02_S2_SEGMENT), hm: clone<HitMap>(CH02_S2_HITMAP) });

describe("a packager Chapter 2 unit", () => {
  it("manifest and hit map validate; clip, audio and hit map are local paths", () => {
    const { seg, hm } = unit();
    const v = validateSegment(seg);
    expect(v.clip?.uri).toBe("clip.mp4");
    expect(v.audio.uri).toBe("audio.mp3");
    expect(v.hitmap).toBe("hitmap.json");
    expect(v.voice_gender).toBe("female");
    expect(v.actions).toEqual([]); // the clip carries the board
    const h = validateHitMap(hm);
    expect(Math.abs(h.duration_ms - (seg.clip?.duration_ms ?? 0))).toBeLessThan(50);
  });
  it("every gesture target resolves in the hit map, every checkpoint is a timeline start", () => {
    const { seg, hm } = unit();
    const h = validateHitMap(hm);
    const targets = hitTargets(h);
    for (const g of seg.gestures) expect(targets, `gesture ${g.kind}→${g.target}`).toContain(g.target);
    const starts = new Set([0, ...h.timeline.map((t) => t.start_ms)]);
    for (const c of seg.checkpoints) expect(starts.has(c), `checkpoint ${c}`).toBe(true);
    expect(checkpointFor(seg.checkpoints, 25_000)).toBeLessThanOrEqual(25_000);
  });
});

describe("the hardened segment gate", () => {
  const refuses = (mutate: (s: Segment) => void, from: Segment = CH02_S2_SEGMENT) => {
    const s = clone(from);
    mutate(s);
    expect(() => validateSegment(s)).toThrow(SegmentError);
  };
  it("refuses a clip, audio or hit map that is not a local path", () => {
    refuses((s) => (s.clip!.uri = "https://evil.example/clip.mp4"));
    refuses((s) => (s.clip!.uri = "../../u4/optionS.mp4"));
    refuses((s) => (s.audio.uri = "javascript:alert(1)"));
    refuses((s) => (s.hitmap = "//cdn.example/h.json"));
    refuses((s) => (s.hitmap = "hitmap.js"));
  });
  it("refuses gesture kinds outside the allow-list, bad voice genders and bad checkpoints", () => {
    refuses((s) => ((s.gestures[0] as { kind: string }).kind = "dance"));
    refuses((s) => ((s as { voice_gender: string }).voice_gender = "robot"));
    refuses((s) => s.checkpoints.push(Number.NaN));
    refuses((s) => s.checkpoints.push(-5));
    refuses((s) => {
      while (s.checkpoints.length <= 1000) s.checkpoints.push(1);
    });
  });
  it("still accepts the S1 U4 fixture (Option E + scripted aside)", () => {
    expect(() => validateSegment(clone(U4_SEGMENT))).not.toThrow();
  });
});
