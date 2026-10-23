/**
 * The translation clock (founder, 2026-10-18: "can we add a timer or time
 * left for kits under translation?"): the typical run from past runs, a
 * queued job's wait on the one-at-a-time lane, a running translation's time
 * left, and the words on the screen. Pure — the server measures, the client
 * ticks.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-translation-eta.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSLATION_MINUTES,
  MAX_RUNNING_PCT,
  MAX_SAMPLES,
  STAGING_SHARE,
  clockText,
  fmtMinutes,
  leadProgress,
  median,
  queuePosition,
  translationClock,
  translationProgress,
  typicalFor,
  typicalTranslation,
} from "@/utils/catalogue/translation-eta";

const NOW = Date.parse("2026-10-18T10:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();
const maths = (minutes: number) => ({ subject: "Mathematics", minutes });
const science = (minutes: number) => ({ subject: "Biology", minutes });

describe("the typical run", () => {
  it("is the median, so a retried run does not drag it (the 2026-10-18 Arabic runs)", () => {
    const runs = [12, 12, 11, 417, 33, 14, 111, 15].map((m, i) => (i === 4 || i === 3 || i === 6 ? science(m) : maths(m)));
    const t = typicalTranslation(runs);
    expect(t.typicalMin).toBe(15); // median of 11,12,12,14,15,33,111,417 = 14.5 → 15
    expect(t.samples).toBe(8);
    expect(t.bySubject.mathematics).toBe(12);
    expect(t.bySubject.biology).toBe(111);
  });

  it("falls back to the default with fewer than three runs, and ignores impossible ones", () => {
    expect(typicalTranslation([]).typicalMin).toBe(DEFAULT_TRANSLATION_MINUTES);
    expect(typicalTranslation([maths(5), maths(7)]).typicalMin).toBe(DEFAULT_TRANSLATION_MINUTES);
    expect(typicalTranslation([maths(-3), maths(0), maths(3000), maths(9), maths(10), maths(11)]).typicalMin).toBe(10);
  });

  it("counts only the newest runs", () => {
    const old = Array.from({ length: 20 }, () => maths(100));
    expect(typicalTranslation([...Array.from({ length: MAX_SAMPLES }, () => maths(10)), ...old]).typicalMin).toBe(10);
  });

  it("uses the subject's own figure when it has one, else everything together", () => {
    const t = typicalTranslation([maths(10), maths(10), maths(10), science(30)]);
    expect(typicalFor(t, " mathematics ")).toBe(10);
    expect(typicalFor(t, "Biology")).toBe(t.typicalMin);
    expect(typicalFor(t, null)).toBe(t.typicalMin);
  });

  it("median of an even list is the mean of the middle two", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("the clock", () => {
  it("a running translation: elapsed and time left against the typical run", () => {
    const c = translationClock({ phase: "translating", since: ago(6), typicalMin: 15, nowMs: NOW });
    expect(Math.round(c.elapsedMin)).toBe(6);
    expect(Math.round(c.leftMin!)).toBe(9);
    expect(c.overdue).toBe(false);
    expect(clockText(c).short).toBe("6 min · ~9 min left");
    expect(clockText(c).tiny).toBe("~9 min left");
  });

  it("past the typical run: no time left, marked longer than usual", () => {
    const c = translationClock({ phase: "building", since: ago(40), typicalMin: 15, nowMs: NOW });
    expect(c.leftMin).toBeNull();
    expect(c.overdue).toBe(true);
    expect(clockText(c).short).toBe("40 min · longer than usual");
    expect(clockText(c).long).toMatch(/past the typical 15 min/);
  });

  it("a queued job waits for what is left of the running one plus one run per job ahead", () => {
    const c = translationClock({ phase: "queued", since: ago(3), typicalMin: 15, nowMs: NOW, ahead: 2, runningSince: ago(5) });
    expect(Math.round(c.startsInMin!)).toBe(10 + 30);
    expect(Math.round(c.leftMin!)).toBe(55);
    expect(clockText(c).tiny).toBe("in ~40 min");
  });

  it("a queued job next on an idle lane starts now; an overdue runner counts as finishing", () => {
    const idle = translationClock({ phase: "queued", since: ago(1), typicalMin: 15, nowMs: NOW, ahead: 0, runningSince: null });
    expect(idle.startsInMin).toBe(0);
    expect(clockText(idle).tiny).toBe("next up");
    const late = translationClock({ phase: "queued", since: ago(1), typicalMin: 15, nowMs: NOW, ahead: 0, runningSince: ago(50) });
    expect(late.startsInMin).toBe(0);
  });

  it("a missing or bad start reads zero elapsed, never NaN", () => {
    const c = translationClock({ phase: "translating", since: null, typicalMin: 15, nowMs: NOW });
    expect(c.elapsedMin).toBe(0);
    expect(translationClock({ phase: "translating", since: "not a date", typicalMin: 15, nowMs: NOW }).elapsedMin).toBe(0);
  });

  it("the queue position is the job's index among the queued, oldest first", () => {
    const lane = { runningSince: null, queued: [{ id: "a", created_at: ago(9) }, { id: "b", created_at: ago(5) }] };
    expect(queuePosition(lane, "a")).toBe(0);
    expect(queuePosition(lane, "b")).toBe(1);
    expect(queuePosition(lane, "gone")).toBe(2);
  });
});

describe("minutes on the screen", () => {
  it("rounds elapsed down and time left up, and goes to hours past sixty", () => {
    expect(fmtMinutes(0.4)).toBe("<1 min");
    expect(fmtMinutes(8.9)).toBe("8 min");
    expect(fmtMinutes(8.1, "up")).toBe("9 min");
    expect(fmtMinutes(65)).toBe("1 h 05 min");
  });
});

describe("the progress bar (Totals → Translating)", () => {
  it("staging maps the job's own progress into the first part of the bar; minutes left are the clock's", () => {
    const p = translationProgress({ phase: "translating", since: ago(3), typicalMin: 15, nowMs: NOW, jobProgress: 50 })!;
    expect(p.pct).toBe(Math.round(STAGING_SHARE / 2));
    expect(p.leftMin).toBeCloseTo(12, 5);
    expect(p.finishing).toBe(false);
    expect(p.text).toBe(`${Math.round(STAGING_SHARE / 2)}% · ~12 min left`);
    expect(translationProgress({ phase: "translating", since: ago(3), typicalMin: 15, nowMs: NOW, jobProgress: 100 })!.pct).toBe(STAGING_SHARE);
    // not reported yet reads 0, not NaN
    expect(translationProgress({ phase: "translating", since: ago(1), typicalMin: 15, nowMs: NOW })!.pct).toBe(0);
  });

  it("building fills the rest from the typical run spent, never below the staging share", () => {
    // 9 of 15 min spent → 60 %
    const p = translationProgress({ phase: "building", since: ago(9), typicalMin: 15, nowMs: NOW })!;
    expect(p.pct).toBe(60);
    expect(p.text).toBe("60% · ~6 min left");
    // just started building: the staging part is already full
    expect(translationProgress({ phase: "building", since: ago(1), typicalMin: 15, nowMs: NOW })!.pct).toBe(STAGING_SHARE);
  });

  it("clamps: never above the cap or below zero, whatever the job reports", () => {
    expect(translationProgress({ phase: "translating", since: ago(1), typicalMin: 15, nowMs: NOW, jobProgress: 250 })!.pct).toBe(STAGING_SHARE);
    expect(translationProgress({ phase: "translating", since: ago(1), typicalMin: 15, nowMs: NOW, jobProgress: -20 })!.pct).toBe(0);
    expect(translationProgress({ phase: "translating", since: ago(1), typicalMin: 15, nowMs: NOW, jobProgress: Number.NaN })!.pct).toBe(0);
    expect(translationProgress({ phase: "building", since: ago(14.9), typicalMin: 15, nowMs: NOW })!.pct).toBeLessThanOrEqual(MAX_RUNNING_PCT);
    // a start in the future reads zero elapsed, not negative
    const future = translationProgress({ phase: "building", since: ago(-10), typicalMin: 15, nowMs: NOW })!;
    expect(future.pct).toBe(STAGING_SHARE);
    expect(future.leftMin).toBe(15);
  });

  it("past the typical run: finishing…, no minutes, never over 100 %", () => {
    const p = translationProgress({ phase: "building", since: ago(40), typicalMin: 15, nowMs: NOW })!;
    expect(p.finishing).toBe(true);
    expect(p.leftMin).toBeNull();
    expect(p.pct).toBe(MAX_RUNNING_PCT);
    expect(p.text).toBe(`${MAX_RUNNING_PCT}% · finishing…`);
    const staging = translationProgress({ phase: "translating", since: ago(20), typicalMin: 15, nowMs: NOW, jobProgress: 80 })!;
    expect(staging.finishing).toBe(true);
    expect(staging.text).toBe(`${Math.round(STAGING_SHARE * 0.8)}% · finishing…`);
  });

  it("minutes left round up, against the subject's typical run", () => {
    expect(translationProgress({ phase: "building", since: ago(10.5), typicalMin: 33, nowMs: NOW })!.text).toBe(
      `${Math.round(Math.max(STAGING_SHARE, (100 * 10.5) / 33))}% · ~23 min left`,
    );
  });

  it("a queued run has no bar", () => {
    expect(translationProgress({ phase: "queued", since: ago(1), typicalMin: 15, nowMs: NOW })).toBeNull();
  });

  it("several runs: the one furthest along leads, the rest are +N; queued ones are not runs", () => {
    const runs = [
      { phase: "translating" as const, since: ago(2), typicalMin: 15, jobProgress: 30 },
      { phase: "building" as const, since: ago(12), typicalMin: 15 },
      { phase: "queued" as const, since: ago(1), typicalMin: 15 },
    ];
    const r = leadProgress(runs, NOW)!;
    expect(r.lead).toBe(runs[1]);
    expect(r.progress.pct).toBe(80);
    expect(r.others).toBe(1);
    expect(leadProgress([runs[2]], NOW)).toBeNull();
    expect(leadProgress([], NOW)).toBeNull();
  });

  it("a tie on percent goes to the one with less time left", () => {
    const a = { phase: "building" as const, since: ago(1), typicalMin: 30 };
    const b = { phase: "building" as const, since: ago(1), typicalMin: 10 };
    expect(leadProgress([a, b], NOW)!.lead).toBe(b);
  });
});
