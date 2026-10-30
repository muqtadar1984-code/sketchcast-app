/**
 * SK's character (look A: the woman teacher, female voice; look B: the man
 * teacher, male voice — the default) as a preference that follows the user
 * across devices: one more workflow fact (kind "preference", key "look_a"),
 * whose local copy is the rig's own key "sk:rig" ("A" / "B"). A browser that
 * already holds a look migrates it up once — even one that migrated the
 * other preferences before (its own marker).
 * Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/prefs-look.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFS,
  LOOK_MIGRATED_LOCAL_KEY,
  MIGRATED_LOCAL_KEYS,
  PREF_FACT_KEY,
  PREF_KEYS,
  PREF_LOCAL_KEY,
  PREFS_MIGRATED_LOCAL_KEY,
  applyLook,
  defaultsFor,
  localPrefValue,
  lookOf,
  migratedLocalKey,
  parseLocalPref,
  pick,
  pickLook,
  prefsFromFacts,
  resolvePrefs,
  withDefaults,
} from "../prefs";
import { savePrefs } from "../settings";
import { DEFAULT_RIG, RIG_CHOICE_KEY } from "../board/avatar";
import { workflowLine } from "@/app/dashboard/settings/lines";
import en from "@/i18n/messages/en.json";
import { s6World, TEACHER } from "./s6-fake-db";

const NOW = new Date("2026-10-29T02:00:00Z");

describe("lookA: look B by default, for every role", () => {
  it("the default is B (lookA false), matching the rig's DEFAULT_RIG", () => {
    expect(DEFAULT_PREFS.lookA).toBe(false);
    expect(lookOf(DEFAULT_PREFS.lookA)).toBe(DEFAULT_RIG);
    for (const r of ["teacher", "parent", "student", "school_admin", null]) expect(defaultsFor(r).lookA).toBe(false);
    expect(withDefaults({}).lookA).toBe(false);
    expect(resolvePrefs({}, {}, false, "student").prefs.lookA).toBe(false);
  });
});

describe("lookA persists like the other preferences", () => {
  it("a known key with its fact key; its local key is the rig's own", () => {
    expect(PREF_KEYS).toContain("lookA");
    expect(PREF_FACT_KEY.lookA).toBe("look_a");
    expect(PREF_LOCAL_KEY.lookA).toBe(RIG_CHOICE_KEY);
    expect(pick({ lookA: true, junk: 1 })).toEqual({ lookA: true });
    expect(pick({ lookA: "A" })).toEqual({});
    expect(prefsFromFacts([{ kind: "preference", key: "look_a", value: { on: true } }])).toEqual({ lookA: true });
  });
  it("the local value is the rig's letter: A → true, B → false, anything else → absent", () => {
    expect(["A", "a", "B", " b ", "on", "", null, undefined].map((v) => parseLocalPref("lookA", v))).toEqual([true, true, false, false, undefined, undefined, undefined, undefined]);
    expect([localPrefValue("lookA", true), localPrefValue("lookA", false)]).toEqual(["A", "B"]);
    // The other preferences keep "on" / "off".
    expect([parseLocalPref("micOn", "on"), parseLocalPref("micOn", "A"), localPrefValue("showText", true)]).toEqual([true, undefined, "on"]);
  });
  it("the server's value wins over the browser's", () => {
    expect(resolvePrefs({ lookA: false }, { lookA: true }, false).prefs.lookA).toBe(false);
    expect(resolvePrefs({ lookA: true }, {}, true).prefs.lookA).toBe(true);
  });
  it("the server cannot be read: this browser's look stays, nothing migrates", () => {
    expect(resolvePrefs(null, { lookA: true }, false)).toEqual({ prefs: { ...DEFAULT_PREFS, lookA: true }, migrate: {} });
  });
});

describe("migration: a browser that already holds sk:rig = A migrates up once", () => {
  it("first visit: the browser's look wins and is migrated", () => {
    expect(resolvePrefs({}, { lookA: true }, false, "teacher")).toEqual({ prefs: { ...DEFAULT_PREFS, lookA: true }, migrate: { lookA: true } });
  });
  it("even when the OTHER preferences were migrated before (its own marker)", () => {
    expect(migratedLocalKey("lookA")).toBe(LOOK_MIGRATED_LOCAL_KEY);
    expect(migratedLocalKey("micOn")).toBe(PREFS_MIGRATED_LOCAL_KEY);
    expect(MIGRATED_LOCAL_KEYS).toEqual([PREFS_MIGRATED_LOCAL_KEY, LOOK_MIGRATED_LOCAL_KEY]);
    const marks: Record<string, string> = { [PREFS_MIGRATED_LOCAL_KEY]: "1" };
    const done = (k: (typeof PREF_KEYS)[number]) => marks[migratedLocalKey(k)] === "1";
    const r = resolvePrefs({}, { lookA: true, readAloud: false }, done, "teacher");
    expect(r.prefs.lookA).toBe(true);
    expect(r.prefs.readAloud).toBe(true); // migrated before → the default, as ever
    expect(r.migrate).toEqual({ lookA: true });
  });
  it("once migrated and absent on the server (memory deleted): the default, not the stale copy", () => {
    expect(resolvePrefs({}, { lookA: true }, () => true, "teacher")).toEqual({ prefs: DEFAULT_PREFS, migrate: {} });
  });
});

describe("POST /api/sk/prefs accepts lookA (settings.ts savePrefs)", () => {
  it("stores a look_a preference fact on the owner's session", async () => {
    const db = s6World();
    expect(await savePrefs(db, TEACHER, { lookA: true }, NOW)).toEqual({ status: 200, body: { ok: true, saved: { lookA: true } } });
    expect(db.rows("sk_workflow_facts").map((r) => [r.owner_id, r.kind, r.key, r.value])).toEqual([[TEACHER, "preference", "look_a", { on: true }]]);
  });
  it("refuses a letter instead of a boolean, and names lookA in the 400", async () => {
    const db = s6World();
    const r = await savePrefs(db, TEACHER, { lookA: "A" }, NOW);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("lookA");
    expect(db.rows("sk_workflow_facts")).toEqual([]);
  });
});

describe("choosing and applying a look (prefs.ts pickLook / applyLook)", () => {
  it("picking a different look calls choose AND saves the preference", () => {
    const choose = vi.fn();
    const save = vi.fn(() => Promise.resolve(true));
    expect(pickLook("A", "B", choose, save)).toBe(true);
    expect(choose).toHaveBeenCalledWith("A");
    expect(save).toHaveBeenCalledWith({ lookA: true });
    expect(pickLook("B", "A", choose, save)).toBe(true);
    expect(choose).toHaveBeenLastCalledWith("B");
    expect(save).toHaveBeenLastCalledWith({ lookA: false });
  });
  it("picking the current look does nothing", () => {
    const choose = vi.fn();
    const save = vi.fn();
    expect(pickLook("B", "B", choose, save)).toBe(false);
    expect(choose).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it("the warm start applies the server's look to the rig only when it differs", () => {
    const choose = vi.fn();
    expect(applyLook({ lookA: true }, "B", choose)).toBe(true);
    expect(choose).toHaveBeenCalledWith("A");
    expect(applyLook({ lookA: false }, "A", choose)).toBe(true);
    expect(choose).toHaveBeenLastCalledWith("B");
    choose.mockClear();
    expect(applyLook({ lookA: false }, "B", choose)).toBe(false);
    expect(choose).not.toHaveBeenCalled();
  });
});

describe("the settings page's fact line", () => {
  it("names the look, not On / Off", () => {
    expect(workflowLine(en.settings, { kind: "preference", pref: "lookA", on: true, date: null })).toBe(`Your setting: ${en.settings.character} — ${en.settings.lookA}`);
    const b = workflowLine(en.settings, { kind: "preference", pref: "lookA", on: false, date: null });
    expect(b).toContain(en.settings.character);
    expect(b).toContain(en.settings.lookB);
    expect(b).not.toContain(en.settings.off);
  });
});
