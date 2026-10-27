// SK's look (founder, 2026-10-27): one tutor identity, two looks, default B.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RIG, parseRigChoice, pickBrowserVoice, readRigChoice, RIG_CHOICE_KEY, rigBaseForChoice, storeRigChoice, voiceGenderForChoice } from "../avatar";

// The suite runs in node: a minimal localStorage stands in for the browser's.
const store = new Map<string, string>();
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) };
const g = globalThis as unknown as { localStorage?: unknown };
let hadStorage: unknown;
beforeAll(() => {
  hadStorage = g.localStorage;
  g.localStorage = fakeStorage;
});
afterAll(() => {
  if (hadStorage === undefined) delete g.localStorage;
  else g.localStorage = hadStorage;
});

describe("the tutor's look", () => {
  it("defaults to B (male voice) and parses only A or B", () => {
    expect(DEFAULT_RIG).toBe("B");
    expect(parseRigChoice(null)).toBe("B");
    expect(parseRigChoice("")).toBe("B");
    expect(parseRigChoice("a")).toBe("A");
    expect(parseRigChoice(" B ")).toBe("B");
    expect(parseRigChoice("C")).toBe("B");
    expect(parseRigChoice("female")).toBe("B");
  });
  it("maps each look to its rig folder and voice", () => {
    expect(rigBaseForChoice("A")).toBe("/sk-s1/sk-a/");
    expect(rigBaseForChoice("B")).toBe("/sk-s1/sk-b/");
    expect(voiceGenderForChoice("A")).toBe("female");
    expect(voiceGenderForChoice("B")).toBe("male");
  });
  it("remembers the choice per browser and falls back to the default", () => {
    store.clear();
    expect(readRigChoice()).toBe("B");
    storeRigChoice("A");
    expect(store.get(RIG_CHOICE_KEY)).toBe("A");
    expect(readRigChoice()).toBe("A");
    store.set(RIG_CHOICE_KEY, "garbage");
    expect(readRigChoice()).toBe("B");
  });
  it("is safe when storage throws (private mode): default, no error", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    g.localStorage = broken;
    try {
      expect(readRigChoice()).toBe("B");
      expect(() => storeRigChoice("A")).not.toThrow();
    } finally {
      g.localStorage = fakeStorage;
    }
  });
  it("picks a browser voice by the look's gender, English first, or none", () => {
    const voices = [
      { name: "Microsoft Zira - English (United States)", lang: "en-US", voiceURI: "zira" },
      { name: "Microsoft David - English (United States)", lang: "en-US", voiceURI: "david" },
      { name: "Google Bahasa Indonesia", lang: "id-ID", voiceURI: "id" },
    ];
    expect(pickBrowserVoice(voices, "female")).toMatch(/Zira/);
    expect(pickBrowserVoice(voices, "male")).toMatch(/David/);
    expect(pickBrowserVoice([{ name: "Voice 1", lang: "en-GB", voiceURI: "v1" }], "male")).toBeNull();
    expect(pickBrowserVoice([], "female")).toBeNull();
  });
});
