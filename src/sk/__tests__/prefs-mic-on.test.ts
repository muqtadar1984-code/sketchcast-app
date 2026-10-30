/**
 * The home hero's Mic switch as an SK preference (founder 2026-10-30): one
 * more workflow fact (kind "preference", key "mic_on"), defaulted by ROLE —
 * on for every adult, off for a student — with a saved choice always winning.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/prefs-mic-on.test.ts
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, PREF_FACT_KEY, PREF_KEYS, PREF_LOCAL_KEY, defaultMicOn, defaultsFor, pick, prefsFromFacts, resolvePrefs, withDefaults } from "../prefs";

describe("defaultMicOn: the role decides the default", () => {
  it("a student → off", () => {
    expect(defaultMicOn("student")).toBe(false);
  });
  it("every other role → on (teacher, parent, leaders, admin, unknown)", () => {
    for (const r of ["teacher", "parent", "principal", "coordinator", "school_admin", "admin", null, undefined]) expect(defaultMicOn(r)).toBe(true);
  });
  it("defaultsFor only changes micOn", () => {
    expect(defaultsFor("student")).toEqual({ ...DEFAULT_PREFS, micOn: false });
    expect(defaultsFor("teacher")).toEqual(DEFAULT_PREFS);
  });
});

describe("micOn persists like the other preferences", () => {
  it("is a known key with its fact key and its localStorage key", () => {
    expect(PREF_KEYS).toContain("micOn");
    expect(PREF_FACT_KEY.micOn).toBe("mic_on");
    expect(PREF_LOCAL_KEY.micOn).toBe("sk.micOn");
    expect(pick({ micOn: false, junk: true })).toEqual({ micOn: false });
    expect(pick({ micOn: "off" })).toEqual({});
  });
  it("is read back from a mic_on preference fact", () => {
    expect(prefsFromFacts([{ kind: "preference", key: "mic_on", value: { on: false } }])).toEqual({ micOn: false });
  });
});

describe("a saved choice always wins over the role default", () => {
  it("never chosen: a teacher / parent / leader gets ON, a student OFF", () => {
    for (const r of ["teacher", "parent", "principal", "coordinator"]) expect(resolvePrefs({}, {}, false, r).prefs.micOn).toBe(true);
    expect(resolvePrefs({}, {}, false, "student").prefs.micOn).toBe(false);
    expect(withDefaults({}, "student").micOn).toBe(false);
  });
  it("a teacher who switched it OFF stays off", () => {
    expect(resolvePrefs({ micOn: false }, {}, true, "teacher").prefs.micOn).toBe(false);
    expect(withDefaults({ micOn: false }, "teacher").micOn).toBe(false);
  });
  it("a student who switched it ON stays on", () => {
    expect(resolvePrefs({ micOn: true }, {}, true, "student").prefs.micOn).toBe(true);
    expect(withDefaults({ micOn: true }, "student").micOn).toBe(true);
  });
  it("a choice only this browser holds wins once and is migrated up", () => {
    expect(resolvePrefs({}, { micOn: true }, false, "student")).toEqual({ prefs: { ...DEFAULT_PREFS, micOn: true }, migrate: { micOn: true } });
    expect(resolvePrefs({}, { micOn: false }, false, "teacher")).toEqual({ prefs: { ...DEFAULT_PREFS, micOn: false }, migrate: { micOn: false } });
  });
  it("the server unreadable: the browser's choice, else the role default", () => {
    expect(resolvePrefs(null, {}, false, "student").prefs.micOn).toBe(false);
    expect(resolvePrefs(null, { micOn: true }, false, "student").prefs.micOn).toBe(true);
    expect(resolvePrefs(null, {}, false, "teacher").prefs.micOn).toBe(true);
  });
  it("the server's saved value beats a different browser value", () => {
    expect(resolvePrefs({ micOn: false }, { micOn: true }, false, "teacher").prefs.micOn).toBe(false);
  });
});
