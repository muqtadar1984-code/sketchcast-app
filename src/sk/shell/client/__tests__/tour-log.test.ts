/**
 * The tour's stops reach the function log (2026-10-30: "the tour skipped the
 * readymade kits section. probably because it was taking too long to load" —
 * the reason was only ever written to the browser console). One "tour" event
 * per stop: shown (and how long its page took), or skipped and why, through
 * the same voice log and the same server-side cleaning.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/tour-log.test.ts
 */
import { describe, expect, it } from "vitest";
import { cleanVoiceEvents, createVoiceLog, skipOutcome, tourEvent, tourPageState, type VoiceEvent } from "../voice-log";
import { SETTLE_CAP_MS } from "../walkthrough";

describe("skipOutcome — why the settled-page wait gave up", () => {
  it("before the cap it only ever skips a settled page; at the cap it is the cap", () => {
    expect(skipOutcome(1_200, SETTLE_CAP_MS)).toBe("missing");
    expect(skipOutcome(SETTLE_CAP_MS, SETTLE_CAP_MS)).toBe("cap");
    expect(skipOutcome(20_350, SETTLE_CAP_MS)).toBe("cap");
  });
});

describe("tourPageState — what the page looked like", () => {
  const p = (over: Partial<{ pathOk: boolean; ready: boolean; loading: string | null }> = {}) => ({ pathOk: true, ready: true, loading: null, ...over });
  it("names the loading UI still on screen", () => {
    expect(tourPageState(p({ loading: "aria-busy" }), "cap")).toBe("still-loading:aria-busy");
    expect(tourPageState(p({ loading: "data-sk-loading" }), "missing")).toBe("still-loading:data-sk-loading");
  });
  it("off the stop's route, or not loaded, says so first", () => {
    expect(tourPageState(p({ pathOk: false, loading: "aria-busy" }), "cap")).toBe("off-route");
    expect(tourPageState(p({ ready: false }), "cap")).toBe("not-ready");
  });
  it("a settled page without the anchor is 'settled'; a cap with nothing visible is a page that never went quiet", () => {
    expect(tourPageState(p(), "missing")).toBe("settled");
    expect(tourPageState(p(), "shown")).toBe("settled");
    expect(tourPageState(p(), "cap")).toBe("never-quiet");
  });
});

describe("tourEvent — one line per stop, no text", () => {
  it("a skipped stop: kind tour, the stop id, why, the route and page state, the wait", () => {
    expect(tourEvent({ stop: "kits", route: "/dashboard/kits", outcome: "cap", ms: 20_012.6, page: "still-loading:aria-busy" })).toEqual({
      k: "tour",
      provider: "kits",
      ok: false,
      why: "cap",
      error: "/dashboard/kits still-loading:aria-busy",
      ms: 20_013,
    });
    expect(tourEvent({ stop: "kits", route: "/dashboard/kits", outcome: "missing", ms: 3_400, page: "settled" })).toMatchObject({ ok: false, why: "missing", error: "/dashboard/kits settled" });
  });

  it("a shown stop is ok, with the time from the navigation to the highlight", () => {
    expect(tourEvent({ stop: "library", route: "/dashboard", outcome: "shown", ms: 1_850, page: "settled" })).toEqual({
      k: "tour",
      provider: "library",
      ok: true,
      why: "shown",
      error: "/dashboard settled",
      ms: 1_850,
    });
  });

  it("a long route is shortened so the page state survives the 60-character cleaning", () => {
    const route = `/dashboard/classes/${"0123456789abcdef".repeat(4)}?tab=assignments`;
    const e = tourEvent({ stop: "class", route, outcome: "cap", ms: 20_000, page: "still-loading:data-sk-loading" });
    expect(e.error!.length).toBeLessThanOrEqual(60);
    expect(e.error!.endsWith(" still-loading:data-sk-loading")).toBe(true);
    expect(e.error!.startsWith("/dashboard/classes/")).toBe(true);
    // negative waits (a clock step) never go below zero
    expect(tourEvent({ stop: "x", route: "/x", outcome: "away", ms: -5, page: "left-for:/y" }).ms).toBe(0);
  });

  it("survives the server's cleaning unchanged, through the client log", () => {
    const sent: VoiceEvent[][] = [];
    const log = createVoiceLog({ send: (ev) => sent.push(ev), now: () => 1000, setTimer: () => 1, clearTimer: () => {} });
    log.push(tourEvent({ stop: "kits", route: "/dashboard/kits", outcome: "cap", ms: 20_004, page: "still-loading:aria-busy" }));
    log.push(tourEvent({ stop: "library", route: "/dashboard", outcome: "shown", ms: 900, page: "settled" }));
    log.flush();
    expect(sent).toHaveLength(1);
    const cleaned = cleanVoiceEvents(JSON.parse(JSON.stringify(sent[0])));
    expect(cleaned).toEqual(sent[0]);
    expect(cleaned.map((e) => [e.k, e.provider, e.ok, e.why])).toEqual([
      ["tour", "kits", false, "cap"],
      ["tour", "library", true, "shown"],
    ]);
  });
});
