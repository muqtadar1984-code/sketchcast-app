// SK narration tracks (founder, 2026-10-27: the look and the voice agree).
// The track choice is pure; the segment gate checks every track's media like
// the segment's own; and the Chapter 2 fixtures carry an aligned male track
// whose items land on the female cues the clip was rendered against.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SegmentError, validateSegment, type Segment } from "../engine";
import { availableGenders, segmentForVoice, trackFor } from "../voices";

const UNITS = ["s1", "s2", "s3", "s4", "s5", "s6"];
const read = <T,>(p: string) => JSON.parse(readFileSync(new URL(`../../../../public/sk-s1/${p}`, import.meta.url), "utf-8")) as T;
const fixture = (u: string) => read<Segment>(`ch02/${u}/explain-main/segment.json`);
const clone = (s: Segment): Segment => JSON.parse(JSON.stringify(s));

const marks = (t: number) => ({ words: [{ i: 0, t0: t, t1: t + 300, text: "hi" }], visemes: [] });
const TWO: Segment = {
  segment_id: "x",
  voice_gender: "female",
  audio: { uri: "audio.mp3", duration_ms: 1000 },
  clip: { uri: "clip.mp4", duration_ms: 1000 },
  marks: marks(100),
  voices: {
    female: { voice: "edge-aria", audio: { uri: "audio.mp3", duration_ms: 1000 }, clip: { uri: "clip.mp4", duration_ms: 1000 }, marks: marks(100) },
    male: { voice: "edge-guy", audio: { uri: "audio-male.mp3", duration_ms: 1000 }, clip: { uri: "clip-male.mp4", duration_ms: 1000 }, marks: marks(120) },
  },
  assets: {},
  actions: [],
  gestures: [],
  checkpoints: [0],
  narration: "hi",
};
const ONE: Segment = { ...TWO, voices: undefined };

describe("the track choice", () => {
  it("plays the track of the look's gender when the segment has it", () => {
    expect(trackFor(TWO, "male")).toMatchObject({ gender: "male", exact: true, track: { voice: "edge-guy" } });
    expect(trackFor(TWO, "female")).toMatchObject({ gender: "female", exact: true, track: { voice: "edge-aria" } });
    const m = segmentForVoice(TWO, "male");
    expect(m.clip?.uri).toBe("clip-male.mp4");
    expect(m.audio.uri).toBe("audio-male.mp3");
    expect(m.marks.words[0]!.t0).toBe(120);
    expect(m.voice_gender).toBe("male");
    // the rest of the manifest is untouched
    expect(m.hitmap).toBe(TWO.hitmap);
    expect(m.checkpoints).toBe(TWO.checkpoints);
  });
  it("falls back to the segment's own track when it has only one, whatever the look", () => {
    expect(trackFor(ONE, "male")).toMatchObject({ gender: "female", exact: false });
    expect(trackFor(ONE, "female")).toMatchObject({ gender: "female", exact: true });
    expect(segmentForVoice(ONE, "male")).toBe(ONE); // identity: nothing to swap
    const maleOnly: Segment = { ...ONE, voice_gender: "male" };
    expect(trackFor(maleOnly, "female")).toMatchObject({ gender: "male", exact: false });
    expect(segmentForVoice(maleOnly, "female").clip?.uri).toBe("clip.mp4");
  });
  it("treats a missing voice_gender as female (the historic default)", () => {
    const legacy: Segment = { ...ONE, voice_gender: undefined };
    expect(trackFor(legacy, "male")).toMatchObject({ gender: "female", exact: false });
    expect(availableGenders(legacy)).toEqual(["female"]);
    expect(availableGenders(TWO)).toEqual(["female", "male"]);
    expect(availableGenders({ ...TWO, voice_gender: "male" })).toEqual(["male", "female"]);
  });
  it("uses the rendered track's own marks when its voices entry carries none", () => {
    const thin: Segment = { ...TWO, voices: { male: { audio: TWO.voices!.male!.audio, clip: TWO.voices!.male!.clip } } };
    const m = segmentForVoice(thin, "male");
    expect(m.clip?.uri).toBe("clip-male.mp4");
    expect(m.marks).toBe(thin.marks);
  });
});

describe("the segment gate on voices", () => {
  const refuses = (mutate: (s: Segment) => void) => {
    const s = clone(TWO);
    mutate(s);
    expect(() => validateSegment(s)).toThrow(SegmentError);
  };
  it("accepts a two-track manifest and one without voices", () => {
    expect(validateSegment(clone(TWO)).voices?.male?.clip?.uri).toBe("clip-male.mp4");
    expect(validateSegment(clone(ONE)).voices).toBeUndefined();
  });
  it("refuses a gender it does not know, a remote clip, a bad voice id, too many words", () => {
    refuses((s) => ((s.voices as Record<string, unknown>).robot = s.voices!.male));
    refuses((s) => (s.voices!.male!.clip = { uri: "https://evil.example/clip.mp4", duration_ms: 1000 }));
    refuses((s) => (s.voices!.male!.audio = { uri: "../../audio.mp3", duration_ms: 1000 }));
    refuses((s) => (s.voices!.male!.voice = "<script>"));
    refuses((s) => (s.voices!.male!.marks = { words: new Array(5001).fill({ i: 0, t0: 0, t1: 1, text: "x" }), visemes: [] }));
    refuses((s) => ((s as unknown as { voices: unknown }).voices = ["male"]));
  });
});

describe("the Chapter 2 fixtures carry both voices", () => {
  it.each(UNITS)("%s: a female (rendered) and an aligned male track, same length as the clip", (u) => {
    const seg = validateSegment(fixture(u));
    expect(seg.voice_gender).toBe("female");
    expect(seg.voices?.female?.clip?.uri).toBe("clip.mp4");
    expect(seg.voices?.male?.clip?.uri).toBe("clip-male.mp4");
    expect(seg.voices?.male?.clip?.duration_ms).toBe(seg.clip?.duration_ms);
    expect(seg.voices?.male?.voice).toBe("edge-guy");
    const m = segmentForVoice(seg, "male");
    expect(m.clip?.uri).toBe("clip-male.mp4");
    const words = m.marks.words;
    expect(words.length).toBeGreaterThan(50);
    expect(words[0]!.t0).toBeGreaterThanOrEqual(0);
    expect(words[words.length - 1]!.t1).toBeLessThanOrEqual(seg.clip!.duration_ms);
    // the files the player will fetch exist beside the manifest
    expect(() => readFileSync(new URL(`../../../../public/sk-s1/ch02/${u}/explain-main/clip-male.mp4`, import.meta.url))).not.toThrow();
  });
  it.each(UNITS)("%s: the male narration items start where the female ones do (the clip's cues)", (u) => {
    const seg = fixture(u) as Segment & { narration_sentences: string[] };
    const female = seg.marks.words;
    const male = seg.voices!.male!.marks!.words;
    expect(male.length).toBe(female.length); // the same narration, word for word
    const tok = (s: string) => s.toLowerCase().replace(/[µμ]/g, "").match(/[a-z0-9]+/g) ?? [];
    // first word of each narration item, found by walking the tokens
    let wi = 0;
    for (const item of seg.narration_sentences) {
      const want = tok(item);
      let k = 0;
      const first = wi;
      while (k < want.length) {
        const got = tok(female[wi]!.text);
        expect(want.slice(k, k + got.length)).toEqual(got);
        k += got.length;
        wi += 1;
      }
      expect(Math.abs(male[first]!.t0 - female[first]!.t0), `${u} item "${item.slice(0, 30)}…"`).toBeLessThanOrEqual(120);
    }
  });
});
