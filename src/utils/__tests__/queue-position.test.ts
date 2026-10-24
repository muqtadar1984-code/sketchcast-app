import { describe, expect, it } from "vitest";
import { aheadOf, etaText, finishRate, queueSpot } from "../queue-position";

const T = { minutes: "~{n} min", hours: "~{h} h", hoursMinutes: "~{h} h {m} min" };

describe("queue position", () => {
  const queued = ["2026-10-22T06:48:56Z", "2026-10-22T06:48:57Z", "2026-10-22T06:49:00Z", "2026-10-22T06:52:53Z"];

  it("counts only jobs queued before this one", () => {
    expect(aheadOf("2026-10-22T06:48:56Z", queued)).toBe(0);
    expect(aheadOf("2026-10-22T06:49:00Z", queued)).toBe(2);
    expect(aheadOf("2026-10-22T07:00:00Z", queued)).toBe(4);
  });

  it("estimates start time from the measured finish rate", () => {
    // Sara's burst: ~200 ahead at the measured ~1.7 jobs/min ≈ 2 h.
    const many = Array.from({ length: 200 }, (_, i) => `2026-10-22T06:${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`);
    expect(queueSpot("2026-10-22T07:00:00Z", many, 1.7)).toEqual({ ahead: 200, etaMin: 118 });
  });

  it("never says 0 min, and a quiet hour can't divide by zero", () => {
    expect(queueSpot("2026-10-22T06:48:56Z", queued, 5).etaMin).toBe(1);
    expect(finishRate(0, 60)).toBe(0.2);
    expect(finishRate(102, 60)).toBeCloseTo(1.7);
  });

  it("speaks whole minutes and hours", () => {
    expect(etaText(40, T)).toBe("~40 min");
    expect(etaText(118, T)).toBe("~2 h");
    expect(etaText(135, T)).toBe("~2 h 15 min");
    expect(etaText(60, T)).toBe("~1 h");
  });
});
