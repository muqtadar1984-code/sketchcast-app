// SK B2 — the six prepared Chapter 2 units (B3 packager output) pass both
// gates unchanged; every manifest gesture targets something its hit map can
// resolve; the harness's canned live asides pass B4's aside gate; and the
// hardened segment gate refuses the new ways a manifest could misbehave.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { liveAsideFor } from "../../../app/dev/sk-player/asides";
import { validateAside } from "../../aside";
import { checkpointFor, hitBox, hitTargets, SegmentError, validateHitMap, validateSegment, type HitMap, type Segment } from "../engine";

const UNITS = ["s1", "s2", "s3", "s4", "s5", "s6"];
const read = <T,>(p: string) => JSON.parse(readFileSync(new URL(`../../../../public/sk-s1/${p}`, import.meta.url), "utf-8")) as T;
const unit = (u: string) => ({ seg: read<Segment>(`ch02/${u}/explain-main/segment.json`), hm: read<HitMap>(`ch02/${u}/explain-main/hitmap.json`) });
const U4 = read<Segment>("u4/segment.json");

describe("the packager's Chapter 2 units", () => {
  it.each(UNITS)("%s: manifest and hit map validate; clip, audio and hit map are local paths", (u) => {
    const { seg, hm } = unit(u);
    const v = validateSegment(seg);
    expect(v.clip?.uri).toBe("clip.mp4");
    expect(v.audio.uri).toBe("audio.mp3");
    expect(v.hitmap).toBe("hitmap.json");
    expect(v.voice_gender).toBe("female");
    expect(v.actions).toEqual([]); // the clip carries the board
    const h = validateHitMap(hm);
    expect(Math.abs(h.duration_ms - (seg.clip?.duration_ms ?? 0))).toBeLessThan(50);
  });
  it.each(UNITS)("%s: every gesture target resolves in the hit map, every checkpoint is a timeline start", (u) => {
    const { seg, hm } = unit(u);
    const h = validateHitMap(hm);
    const targets = hitTargets(h);
    for (const g of seg.gestures) expect(targets, `${u} gesture ${g.kind}→${g.target}`).toContain(g.target);
    const starts = new Set([0, ...h.timeline.map((t) => t.start_ms)]);
    for (const c of seg.checkpoints) expect(starts.has(c), `${u} checkpoint ${c}`).toBe(true);
    expect(checkpointFor(seg.checkpoints, 25_000)).toBeLessThanOrEqual(25_000);
  });
  it.each(UNITS)("%s: the harness's live aside passes the aside gate at the start, middle and end", (u) => {
    const { seg, hm } = unit(u);
    const h = validateHitMap(hm);
    for (const t of [0, h.duration_ms / 2, h.duration_ms]) {
      const aside = liveAsideFor(u, h, t, u === "s2" ? U4.aside : null);
      const program = validateAside({ tal: "0.2-aside", ...aside.program }, validateSegment(seg), hitTargets(h));
      expect(program.actions.length).toBeGreaterThan(0);
      for (const a of program.actions) if ("target" in a) expect(hitBox(h, a.target)).not.toBeNull();
    }
  });
  it("s2 reuses the S1 spoken aside, re-targeted from mic to ill", () => {
    const { hm } = unit("s2");
    const aside = liveAsideFor("s2", validateHitMap(hm), 30_000, U4.aside);
    expect(aside.speech?.uri).toBe("/sk-s1/u4/aside1.mp3");
    expect(aside.program.actions.every((a) => !("target" in a) || a.target.startsWith("ill"))).toBe(true);
  });
});

describe("the hardened segment gate", () => {
  const clone = (s: Segment): Segment => JSON.parse(JSON.stringify(s));
  const refuses = (mutate: (s: Segment) => void, from: Segment = unit("s3").seg) => {
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
    expect(() => validateSegment(clone(U4))).not.toThrow();
  });
});
