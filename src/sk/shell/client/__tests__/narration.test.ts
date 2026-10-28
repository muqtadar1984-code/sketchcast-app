/**
 * SK-narrated onboarding (§4.6): the script's order and sources, the runner's
 * pacing/abort behaviour, and the once-per-version gate it shares with the
 * driver.js tours.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/narration.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { runNarration, skIntroScript, type NarrationSpeaker } from "../narration";
import { SK_INTRO_TOUR } from "../../tour";
import { tourForRole, type TourCopy } from "@/tour/definitions";
import { shouldAutoStart } from "@/tour/logic";
import en from "@/i18n/messages/en.json";

const copy = { introHello: "Hi, I'm SK.", introFirstTask: "Shall we upload a book?" };

function fakeSpeaker() {
  const pushed: string[] = [];
  const flush = vi.fn<() => void>();
  const stop = vi.fn<() => void>();
  const s: NarrationSpeaker = {
    push: (t) => {
      pushed.push(t);
    },
    flush,
    stop,
  };
  return { ...s, pushed, flush, stop };
}
const immediate = () => Promise.resolve();

describe("skIntroScript", () => {
  it("is intro → every teacher step body in tour order → first-task offer, from the real English copy", () => {
    const tourCopy = en.app.tour as TourCopy;
    const steps = tourForRole("teacher")!.steps;
    const lines = skIntroScript({ copy, tourCopy, steps, role: "teacher" });
    const bodies = steps.map((s) => tourCopy.teacher_onboarding![s.id]!.body);
    expect(lines).toEqual([copy.introHello, ...bodies, copy.introFirstTask]);
    expect(lines).toHaveLength(steps.length + 2);
    // The order is the tour's `order`, which is how the steps come out of tourForRole.
    expect(steps.map((s) => s.id)).toEqual(["library", "generate", "output", "assign", "assistant", "classes"]);
  });
  it("reads the words for the ROLE's tour key, falling back to the teacher tour for an unknown role", () => {
    const tourCopy: TourCopy = {
      teacher_onboarding: { a: { title: "", body: "teacher body" } },
      parent_onboarding: { a: { title: "", body: "parent body" } },
    };
    expect(skIntroScript({ copy, tourCopy, steps: [{ id: "a" }], role: "parent" })).toEqual([copy.introHello, "parent body", copy.introFirstTask]);
    expect(skIntroScript({ copy, tourCopy, steps: [{ id: "a" }], role: "alien" })).toEqual([copy.introHello, "teacher body", copy.introFirstTask]);
  });
  it("a step the dictionary does not cover is silent, never the word 'undefined'", () => {
    const lines = skIntroScript({ copy, tourCopy: { teacher_onboarding: {} }, steps: [{ id: "ghost" }], role: "teacher" });
    expect(lines).toEqual([copy.introHello, copy.introFirstTask]);
  });
  it("never imports the client TourProvider (node can load it)", () => {
    // If narration.ts pulled in TourProvider (React + next/navigation), this
    // test file would already have failed to import. Pin it anyway.
    expect(typeof skIntroScript).toBe("function");
  });
});

describe("runNarration", () => {
  it("speaks every line in order, flushes each, reports each line, completes", async () => {
    const sp = fakeSpeaker();
    const seen: Array<[string, number]> = [];
    const r = await runNarration(["One.", "Two", "Three?"], sp, { onLine: (l, i) => seen.push([l, i]), pace: immediate });
    expect(r).toEqual({ completed: true, spoken: 3 });
    expect(seen).toEqual([["One.", 0], ["Two", 1], ["Three?", 2]]);
    // A line without terminal punctuation gets a full stop so the speaker's sentence splitter flushes it.
    expect(sp.pushed).toEqual(["One. ", "Two. ", "Three? "]);
    expect(sp.flush).toHaveBeenCalledTimes(3);
    expect(sp.stop).not.toHaveBeenCalled();
  });

  it("stops at the abort and reports how far it got (→ 'skipped')", async () => {
    const sp = fakeSpeaker();
    const ac = new AbortController();
    const r = await runNarration(["a", "b", "c", "d"], sp, {
      onLine: (_l, i) => {
        if (i === 1) ac.abort();
      },
      signal: ac.signal,
      pace: immediate,
    });
    expect(r).toEqual({ completed: false, spoken: 2 });
    expect(sp.stop).toHaveBeenCalledTimes(1);
  });

  it("an abort during the pace wait ends the wait early with the default pacer", async () => {
    const sp = fakeSpeaker();
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runNarration(["a very long line of many many words to hold for seconds and seconds more"], sp, { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(1000); // default pace would be ≥ 1.2 s
    expect(r.completed).toBe(false);
  });

  it("an already-aborted signal speaks nothing", async () => {
    const sp = fakeSpeaker();
    const ac = new AbortController();
    ac.abort();
    const r = await runNarration(["a"], sp, { signal: ac.signal, pace: immediate });
    expect(r).toEqual({ completed: false, spoken: 0 });
    expect(sp.pushed).toEqual([]);
  });

  it("an empty script completes trivially", async () => {
    const sp = fakeSpeaker();
    expect(await runNarration([], sp, { pace: immediate })).toEqual({ completed: true, spoken: 0 });
  });
});

describe("once per version — the same gate as the driver.js tours", () => {
  it("SK_INTRO_TOUR is the key /api/tour/seen is posted with", () => {
    expect(SK_INTRO_TOUR).toEqual({ key: "sk-intro", version: 1 });
  });
  it("plays when never seen, is silent once this version is recorded, plays again after a bump", () => {
    expect(shouldAutoStart(null, SK_INTRO_TOUR.version)).toBe(true);
    expect(shouldAutoStart({ version: null, status: null }, SK_INTRO_TOUR.version)).toBe(true);
    expect(shouldAutoStart({ version: SK_INTRO_TOUR.version, status: "completed" }, SK_INTRO_TOUR.version)).toBe(false);
    expect(shouldAutoStart({ version: SK_INTRO_TOUR.version, status: "skipped" }, SK_INTRO_TOUR.version)).toBe(false);
    expect(shouldAutoStart({ version: SK_INTRO_TOUR.version, status: "skipped" }, SK_INTRO_TOUR.version + 1)).toBe(true);
  });
});
