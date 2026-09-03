import { describe, expect, it } from "vitest";
import { kitRows } from "../kit";

// The voice a kit click SENDS. Since the Google TTS migration the app sends the
// `auto` sentinel unless the teacher picked a voice: the worker resolves it per
// generation (lesson language, the account's plan, the active premium
// provider). A concrete default here would freeze the choice at click time and
// no paid account could ever receive the premium default.

const base = { bookId: "b", schoolId: null, userId: "u", chapterNum: 3 };
const lesson = (rows: ReturnType<typeof kitRows>) => rows.find((r) => r.kind === "presentation")!;

describe("kitRows — the voice that is sent", () => {
  it("sends `auto` when no voice was picked, for every language", () => {
    expect(lesson(kitRows(base)).params.tts_voice).toBe("auto");
    expect(lesson(kitRows({ ...base, language: "ms" })).params.tts_voice).toBe("auto");
    expect(lesson(kitRows({ ...base, language: "ar", part: 2 })).params.tts_voice).toBe("auto");
  });

  it("sends the teacher's explicit pick unchanged", () => {
    expect(lesson(kitRows({ ...base, ttsVoice: "edge-guy" })).params.tts_voice).toBe("edge-guy");
    expect(lesson(kitRows({ ...base, ttsVoice: "g-ar-m" })).params.tts_voice).toBe("g-ar-m");
  });

  it("documents carry no voice at all", () => {
    for (const r of kitRows(base).filter((r) => r.kind !== "presentation")) {
      expect(r.params).not.toHaveProperty("tts_voice");
    }
  });

  it("the language still travels with every row, so `auto` can be resolved in it", () => {
    for (const r of kitRows({ ...base, language: "ms" })) expect(r.params.language).toBe("ms");
  });
});
