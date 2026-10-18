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
  MAX_SAMPLES,
  clockText,
  fmtMinutes,
  median,
  queuePosition,
  translationClock,
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
