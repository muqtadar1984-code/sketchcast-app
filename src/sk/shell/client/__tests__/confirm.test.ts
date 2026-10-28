/**
 * Confirm cards on the client (§9.2): the spoken-yes table across the ten
 * locales, the "exactly one card" rule, and the countdown.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/confirm.test.ts
 */
import { describe, expect, it } from "vitest";
import { decideWithCards, secondsLeft, spokenAnswer } from "../confirm";

describe("spokenAnswer — short affirmatives and negatives per locale", () => {
  const yes: Array<[string, string]> = [
    ["yes", "en"],
    ["Yes.", "en"],
    ["ok", "en"],
    ["okay!", "en"],
    ["confirm", "en"],
    ["go ahead", "en"],
    ["ya", "ms"],
    ["baik", "ms"],
    ["boleh", "ms"],
    ["يا", "ms-arab"],
    ["باءيق", "ms-arab"],
    ["نعم", "ar"],
    ["حسناً", "ar"],
    ["تمام", "ar"],
    ["oui", "fr"],
    ["d'accord", "fr"],
    ["sí", "es"],
    ["vale", "es"],
    ["sim", "pt"],
    ["está bem", "pt"],
    ["అవును", "te"],
    ["సరే", "te"],
    ["हो", "mr"],
    ["ठीक आहे", "mr"],
    ["हाँ", "hi"],
    ["ठीक है", "hi"],
    // English works in every locale.
    ["yes", "ms"],
    ["ok", "ar"],
  ];
  it.each(yes)("%s (%s) → yes", (text, locale) => {
    expect(spokenAnswer(text, locale)).toBe("yes");
  });
  const no: Array<[string, string]> = [
    ["no", "en"],
    ["cancel", "en"],
    ["no thanks", "en"],
    ["tidak", "ms"],
    ["batal", "ms"],
    ["تيدق", "ms-arab"],
    ["لا", "ar"],
    ["إلغاء", "ar"],
    ["non", "fr"],
    ["annuler", "fr"],
    ["no", "es"],
    ["não", "pt"],
    ["కాదు", "te"],
    ["नाही", "mr"],
    ["नहीं", "hi"],
  ];
  it.each(no)("%s (%s) → no", (text, locale) => {
    expect(spokenAnswer(text, locale)).toBe("no");
  });
  it("anything with more content is not an answer", () => {
    expect(spokenAnswer("yes, assign it to 7B for Friday", "en")).toBeNull();
    expect(spokenAnswer("yes but make it Monday", "en")).toBeNull();
    expect(spokenAnswer("open the board", "en")).toBeNull();
    expect(spokenAnswer("", "en")).toBeNull();
    expect(spokenAnswer("   ", "en")).toBeNull();
    expect(spokenAnswer("maybe", "en")).toBeNull();
  });
  it("an unknown locale falls back to the English table", () => {
    expect(spokenAnswer("yes", "xx")).toBe("yes");
    expect(spokenAnswer("ya", "xx")).toBeNull();
  });
});

describe("decideWithCards — §9.2 (a) one card, (b) intentional mic, (c) bare answer", () => {
  it("exactly one active card + bare yes → confirm; bare no → dismiss; anything else → turn", () => {
    expect(decideWithCards({ activeCards: 1, modality: "voice", text: "yes", locale: "en" })).toEqual({ kind: "confirm" });
    expect(decideWithCards({ activeCards: 1, modality: "voice", text: "نعم", locale: "ar" })).toEqual({ kind: "confirm" });
    expect(decideWithCards({ activeCards: 1, modality: "voice", text: "no", locale: "en" })).toEqual({ kind: "dismiss" });
    expect(decideWithCards({ activeCards: 1, modality: "voice", text: "tidak", locale: "ms" })).toEqual({ kind: "dismiss" });
    expect(decideWithCards({ activeCards: 1, modality: "voice", text: "yes and open analytics", locale: "en" })).toEqual({ kind: "turn" });
  });
  it("no card, or more than one, → always an ordinary turn", () => {
    expect(decideWithCards({ activeCards: 0, modality: "voice", text: "yes", locale: "en" })).toEqual({ kind: "turn" });
    expect(decideWithCards({ activeCards: 2, modality: "voice", text: "yes", locale: "en" })).toEqual({ kind: "turn" });
  });
  it("a typed yes with one card is also an answer to the card (the panel reports it as a click)", () => {
    expect(decideWithCards({ activeCards: 1, modality: "text", text: "yes", locale: "en" })).toEqual({ kind: "confirm" });
  });
});

describe("secondsLeft", () => {
  it("rounds up, never negative, 0 for a bad date", () => {
    const now = Date.parse("2026-10-28T10:00:00Z");
    expect(secondsLeft("2026-10-28T10:00:09.200Z", now)).toBe(10);
    expect(secondsLeft("2026-10-28T10:10:00Z", now)).toBe(600);
    expect(secondsLeft("2026-10-28T09:59:00Z", now)).toBe(0);
    expect(secondsLeft("nope", now)).toBe(0);
  });
});
