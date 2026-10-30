/**
 * "Show text by default" (founder 2026-10-30): SK is a corner avatar with a
 * speech bubble, and the conversation's text stays HIDDEN unless she asks for
 * it. One more workflow fact (kind "preference", key "show_text"), default
 * off for every role, persisted like micOn, and on the settings page.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/prefs-show-text.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PREFS, PREF_FACT_KEY, PREF_KEYS, PREF_LOCAL_KEY, defaultsFor, pick, prefsFromFacts, resolvePrefs, withDefaults } from "../prefs";
import { workflowLine } from "@/app/dashboard/settings/lines";
import en from "@/i18n/messages/en.json";

describe("showText: off by default, for every role", () => {
  it("the default", () => {
    expect(DEFAULT_PREFS.showText).toBe(false);
    for (const r of ["teacher", "parent", "student", "school_admin", null]) expect(defaultsFor(r).showText).toBe(false);
    expect(withDefaults({}).showText).toBe(false);
    expect(resolvePrefs({}, {}, false, "teacher").prefs.showText).toBe(false);
  });
});

describe("showText persists like the other preferences", () => {
  it("is a known key next to micOn, with its fact key and its localStorage key", () => {
    expect(PREF_KEYS).toEqual(["readAloud", "handsFree", "suggestions", "micOn", "showText"]);
    expect(PREF_FACT_KEY.showText).toBe("show_text");
    expect(PREF_LOCAL_KEY.showText).toBe("sk.showText");
    expect(pick({ showText: true, junk: 1 })).toEqual({ showText: true });
    expect(pick({ showText: "on" })).toEqual({});
  });
  it("is read back from a show_text preference fact; the saved value wins", () => {
    expect(prefsFromFacts([{ kind: "preference", key: "show_text", value: { on: true } }])).toEqual({ showText: true });
    expect(withDefaults({ showText: true }, "student").showText).toBe(true);
    expect(resolvePrefs({ showText: true }, { showText: false }, false, "teacher").prefs.showText).toBe(true);
  });
  it("a choice only this browser holds wins once and is migrated up", () => {
    expect(resolvePrefs({}, { showText: true }, false, "teacher")).toEqual({ prefs: { ...DEFAULT_PREFS, showText: true }, migrate: { showText: true } });
    expect(resolvePrefs({}, { showText: true }, true, "teacher").prefs.showText).toBe(false);
  });
});

describe("the settings page shows it", () => {
  it("a switch next to the Mic switch, and its plain-language fact line", () => {
    const src = readFileSync(resolve(__dirname, "..", "..", "app", "dashboard", "settings", "sk-privacy.tsx"), "utf8");
    expect(src).toContain('<Switch id="pref-text" label={t.showText} hint={t.showTextHint} {...sw(prefs.showText)}');
    expect(src.indexOf('id="pref-mic"')).toBeLessThan(src.indexOf('id="pref-text"'));
    expect(workflowLine(en.settings, { kind: "preference", pref: "showText", on: true, date: null })).toContain(en.settings.showText);
  });
});
