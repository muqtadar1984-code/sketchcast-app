/**
 * SK B9 — the Polly adapter without Polly: the speech-mark parser over the
 * JSON-lines format (byte offsets → string indices through the SSML
 * escaping), SSML escaping, the look → voice mapping, the viseme table, and
 * the provider over a stubbed `send` (two requests per line, both SSML, never
 * a live call).
 */
import { describe, expect, it } from "vitest";
import { escapeSsml, mapViseme, MAX_SPEAK_CHARS, parseSpeechMarks, POLLY_VOICES, pollyVoiceFor, pollyVoiceName, spokenWordSpan, ssmlFor, voiceForLook } from "@/sk/speech/polly-marks";
import { PollySpeechProvider, type PollyRequest } from "@/sk/speech/polly";
import { sanitiseMarks } from "@/sk/speech/polly-client";

const enc = new TextEncoder();
const lines = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";

describe("SSML escaping", () => {
  it("escapes the five XML characters and nothing else", () => {
    expect(escapeSsml(`a & b < c > "d" 'e' é`)).toBe("a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos; é");
  });
  it("a student's text can never open a tag", () => {
    const { ssml } = ssmlFor(`<break time="10s"/> hi <speak>`);
    expect(ssml).toBe("<speak>&lt;break time=&quot;10s&quot;/&gt; hi &lt;speak&gt;</speak>");
    expect(ssml.slice(7, -8)).not.toMatch(/[<>]/);
  });
  it("maps document byte offsets back to original string indices", () => {
    const text = "A & B";
    const { ssml, charAtByte } = ssmlFor(text);
    // <speak> = 7 bytes; "A" at 7, " " 8, "&amp;" 9..13, " " 14, "B" 15
    expect(ssml).toBe("<speak>A &amp; B</speak>");
    expect(charAtByte(7)).toBe(0);
    expect(charAtByte(9)).toBe(2);
    expect(charAtByte(12)).toBe(2); // inside the entity: still the '&'
    expect(charAtByte(15)).toBe(4);
    expect(charAtByte(3)).toBeNull(); // in the wrapper
    expect(charAtByte(16)).toBeNull(); // the closing tag
  });
  it("multi-byte characters shift bytes but not indices", () => {
    const text = "café ok 😀 go";
    const { charAtByte } = ssmlFor(text);
    const bytesBefore = (s: string) => 7 + enc.encode(s).length;
    expect(charAtByte(bytesBefore("café "))).toBe("café ".length);
    expect(charAtByte(bytesBefore("café ok 😀 "))).toBe("café ok 😀 ".length); // 😀 is two UTF-16 units
  });
});

describe("speech marks", () => {
  it("parses the documented JSON-lines format into words and visemes", () => {
    const text = "Mary had a little lamb.";
    const doc = ssmlFor(text);
    const b = (s: string) => 7 + enc.encode(s).length;
    const raw = lines(
      { time: 0, type: "sentence", start: b(""), end: b(text), value: text },
      { time: 6, type: "word", start: b(""), end: b("Mary"), value: "Mary" },
      { time: 6, type: "viseme", value: "p" },
      { time: 73, type: "viseme", value: "E" },
      { time: 373, type: "word", start: b("Mary "), end: b("Mary had"), value: "had" },
      { time: 373, type: "viseme", value: "k" },
      { time: 604, type: "word", start: b("Mary had "), end: b("Mary had a"), value: "a" },
      { time: 643, type: "word", start: b("Mary had a "), end: b("Mary had a little"), value: "little" },
      { time: 882, type: "word", start: b("Mary had a little "), end: b("Mary had a little lamb"), value: "lamb" },
      { time: 882, type: "viseme", value: "t" },
      { time: 1200, type: "viseme", value: "sil" },
    );
    const m = parseSpeechMarks(raw, doc);
    expect(m.words.map((w) => [w.i, w.text, w.t0, w.t1])).toEqual([
      [0, "Mary", 6, 373],
      [5, "had", 373, 604],
      [9, "a", 604, 643],
      [11, "little", 643, 882],
      [18, "lamb", 882, 1200], // the last word ends at the closing sil, not an invented duration
    ]);
    expect(m.visemes).toEqual([
      { t: 6, v: "PP" },
      { t: 73, v: "E" },
      { t: 373, v: "kk" },
      { t: 882, v: "DD" },
      { t: 1200, v: "sil" },
    ]);
  });
  it("a word after an escaped character still lands on the right index", () => {
    const text = "Tom & Jerry";
    const doc = ssmlFor(text);
    // "Jerry" starts after "<speak>Tom &amp; " = 7 + 4 + 5 + 1 = 17 bytes
    const raw = lines({ time: 10, type: "word", start: 7, end: 10, value: "Tom" }, { time: 300, type: "word", start: 17, end: 22, value: "Jerry" });
    const m = parseSpeechMarks(raw, doc);
    expect(m.words.map((w) => [w.i, w.text])).toEqual([
      [0, "Tom"],
      [6, "Jerry"],
    ]);
  });
  it("drops junk lines, foreign types, tag-words and negative times; last word's t1 is never below t0", () => {
    const doc = ssmlFor("hi there");
    const raw = "not json\n" + lines({ time: 5, type: "word", start: 7, end: 9, value: "hi" }, { time: -1, type: "word", start: 10, end: 15, value: "there" }, { time: 40, type: "word", start: 3, end: 5, value: "<speak>" }, { time: 50, type: "ssml", value: "x" });
    const m = parseSpeechMarks(raw, doc);
    expect(m.words).toEqual([{ i: 0, t0: 5, t1: 50, text: "hi" }]);
    expect(m.visemes).toEqual([]);
  });
  it("an empty body is empty marks, not a throw", () => {
    expect(parseSpeechMarks("", ssmlFor("x"))).toEqual({ words: [], visemes: [] });
  });
  it("maps every Polly en-US viseme into the board's set; unknown → sil", () => {
    const polly = ["p", "t", "S", "T", "f", "k", "i", "r", "s", "u", "@", "a", "e", "E", "o", "O", "sil"];
    const board = new Set(["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "ih", "oh", "ou"]);
    for (const v of polly) expect(board.has(mapViseme(v)), v).toBe(true);
    expect(mapViseme("zz")).toBe("sil");
  });
});

describe("voices", () => {
  it("look A is the female voice, B (and anything else) the male", () => {
    expect(voiceForLook("A")).toBe(`polly:${POLLY_VOICES.female}`);
    expect(voiceForLook("B")).toBe(`polly:${POLLY_VOICES.male}`);
    expect(voiceForLook(undefined)).toBe(`polly:${POLLY_VOICES.male}`);
    expect(voiceForLook("<script>")).toBe(`polly:${POLLY_VOICES.male}`);
    expect(pollyVoiceFor("female")).toBe("polly:Joanna");
    expect(pollyVoiceFor("male")).toBe("polly:Matthew");
  });
  it("only our two voice names ever reach AWS", () => {
    expect(pollyVoiceName("polly:Joanna")).toBe("Joanna");
    expect(pollyVoiceName("polly:Matthew")).toBe("Matthew");
    expect(pollyVoiceName("polly:Brian")).toBe("Matthew");
    expect(pollyVoiceName("browser:default")).toBe("Matthew");
    expect(pollyVoiceName("polly:../x")).toBe("Matthew");
  });
});

describe("PollySpeechProvider over a stubbed send", () => {
  const stub = () => {
    const calls: PollyRequest[] = [];
    const send = async (req: PollyRequest): Promise<Uint8Array> => {
      calls.push(req);
      if (req.OutputFormat === "json") return enc.encode(lines({ time: 0, type: "word", start: 7, end: 12, value: "Hello" }, { time: 0, type: "viseme", value: "k" }, { time: 400, type: "viseme", value: "sil" }));
      return new Uint8Array([0x49, 0x44, 0x33]); // "ID3"
    };
    return { calls, provider: new PollySpeechProvider({ send }) };
  };
  it("asks for mp3 and marks in two neural SSML requests with the mapped voice, and returns bytes + marks", async () => {
    const { calls, provider } = stub();
    const r = await provider.synthesize("Hello  there", "polly:Joanna", { marks: ["word", "viseme"] });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.Engine).toBe("neural");
      expect(c.TextType).toBe("ssml");
      expect(c.VoiceId).toBe("Joanna");
      expect(c.Text).toBe("<speak>Hello there</speak>"); // whitespace folded
    }
    expect(calls.map((c) => c.OutputFormat).sort()).toEqual(["json", "mp3"]);
    expect(calls.find((c) => c.OutputFormat === "json")!.SpeechMarkTypes).toEqual(["word", "viseme"]);
    expect(r.format).toBe("mp3");
    expect(r.audio).toEqual(new Uint8Array([0x49, 0x44, 0x33]));
    expect(r.marks.words).toEqual([{ i: 0, t0: 0, t1: 400, text: "Hello" }]);
    expect(r.marks.visemes).toEqual([
      { t: 0, v: "kk" },
      { t: 400, v: "sil" },
    ]);
    expect(provider.chars).toBe("Hello there".length * 2); // both requests are billed
  });
  it("with no marks requested, one request and empty marks (never fabricated)", async () => {
    const { calls, provider } = stub();
    const r = await provider.synthesize("Hi", "polly:Matthew", { marks: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.OutputFormat).toBe("mp3");
    expect(r.marks).toEqual({ words: [], visemes: [] });
    expect(provider.chars).toBe(2);
  });
  it("escapes the line before it goes to Polly", async () => {
    const { calls, provider } = stub();
    await provider.synthesize(`say <break time="9s"/> & go`, "polly:Matthew", { marks: [] });
    expect(calls[0]!.Text).toBe("<speak>say &lt;break time=&quot;9s&quot;/&gt; &amp; go</speak>");
  });
  it("refuses a line over the cap and says nothing for an empty one", async () => {
    const { calls, provider } = stub();
    await expect(provider.synthesize("x".repeat(MAX_SPEAK_CHARS + 1), "polly:Matthew", { marks: [] })).rejects.toThrow(/exceeds/);
    const r = await provider.synthesize("   ", "polly:Matthew", { marks: ["word"] });
    expect(r.audio).toEqual(new Uint8Array(0));
    expect(calls).toHaveLength(0);
  });
});

describe("client-side helpers", () => {
  it("sanitiseMarks keeps only finite, well-formed marks, sorted by time", () => {
    const m = sanitiseMarks({
      words: [
        { i: 5, t0: 300, t1: 400, text: "b" },
        { i: 0, t0: 0, t1: 300, text: "a" },
        { i: "x", t0: 1, t1: 2, text: "bad" },
        { i: 1, t0: Number.NaN, t1: 2, text: "bad" },
        null,
      ],
      visemes: [{ t: 10, v: "aa" }, { t: 0, v: "PP" }, { t: -1, v: "x" }, { v: "x" }, "sil"],
    });
    expect(m.words.map((w) => w.text)).toEqual(["a", "b"]);
    expect(m.visemes).toEqual([
      { t: 0, v: "PP" },
      { t: 10, v: "aa" },
    ]);
    expect(sanitiseMarks(null)).toEqual({ words: [], visemes: [] });
    expect(sanitiseMarks("junk")).toEqual({ words: [], visemes: [] });
  });
  it("spokenWordSpan finds the whitespace-delimited word around an index", () => {
    const t = "Let's carry on.";
    expect(spokenWordSpan(t, 0)).toEqual({ start: 0, end: 5 });
    expect(spokenWordSpan(t, 8)).toEqual({ start: 6, end: 11 });
    expect(spokenWordSpan(t, 12)).toEqual({ start: 12, end: 15 });
    expect(spokenWordSpan(t, 5)).toBeNull(); // on the space
    expect(spokenWordSpan(t, -1)).toBeNull();
    expect(spokenWordSpan(t, 99)).toBeNull();
    expect(spokenWordSpan(t, 1.5)).toBeNull();
  });
});
