import { describe, expect, it } from "vitest";
import {
  FALLBACK_RATES,
  MIN_BUCKETS,
  backloggedRates,
  etaDisplay,
  etaRange,
  type JobSample,
} from "../generate-all-estimate";

const NOW = new Date("2026-10-22T12:00:00Z");
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString();

/** A backlog of `n` worksheets queued `start` min ago, one claimed and done
 *  every `every` minutes. */
function drain(n: number, start: number, every: number): JobSample[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "worksheet",
    status: "done",
    created_at: at(start),
    claimed_at: at(start - i * every),
    updated_at: at(start - i * every - 1),
  }));
}

describe("backloggedRates", () => {
  it("measures the drain rate only while the kind had a backlog", () => {
    // 40 worksheets draining at 1 per 4 min over ~160 min (16 buckets) —
    // 0.25 jobs/min — then a quiet week, which must NOT dilute the rate.
    const r = backloggedRates(drain(40, 600, 4), NOW).worksheet;
    expect(r.buckets).toBeGreaterThanOrEqual(MIN_BUCKETS);
    expect(r.mean).toBeGreaterThan(0.2);
    expect(r.mean).toBeLessThan(0.3);
    expect(r.p75).toBeGreaterThanOrEqual(r.mean);
  });

  it("falls back when a kind had too little backlog to measure", () => {
    const r = backloggedRates(drain(3, 600, 4), NOW);
    expect(r.worksheet).toEqual(FALLBACK_RATES.worksheet);
    expect(r.presentation).toEqual(FALLBACK_RATES.presentation);
  });

  it("ignores jobs older than the window", () => {
    const old = drain(40, 9 * 24 * 60, 4);
    expect(backloggedRates(old, NOW).worksheet).toEqual(FALLBACK_RATES.worksheet);
  });
});

describe("etaRange", () => {
  it("is set by the slowest kind: queue ahead plus mine, over its drain rate", () => {
    // Sara's click: 37 of each kind behind an empty queue. Video at 0.06–0.1/min
    // is the slow lane: 370–617 min.
    const mine = { presentation: 37, worksheet: 37, deck: 37 };
    const r = etaRange({}, mine, FALLBACK_RATES)!;
    expect(r.lowMin).toBe(370);
    expect(r.highMin).toBe(617);
  });

  it("counts the jobs already ahead", () => {
    const alone = etaRange({}, { worksheet: 10 }, FALLBACK_RATES)!;
    const behind = etaRange({ worksheet: 50 }, { worksheet: 10 }, FALLBACK_RATES)!;
    expect(behind.highMin).toBe(alone.highMin * 6);
  });

  it("never promises less than one job's work time", () => {
    expect(etaRange({}, { presentation: 1 }, FALLBACK_RATES)!.lowMin).toBeGreaterThanOrEqual(13);
  });

  it("is null for a run that queues nothing", () => {
    expect(etaRange({ worksheet: 9 }, {}, FALLBACK_RATES)).toBeNull();
  });
});

describe("etaDisplay", () => {
  it("shows minutes under 90, rounded to 5", () => {
    expect(etaDisplay({ lowMin: 33, highMin: 52 })).toEqual({ unit: "min", low: 30, high: 55 });
  });

  it("shows half hours above that, low down and high up", () => {
    expect(etaDisplay({ lowMin: 370, highMin: 617 })).toEqual({ unit: "h", low: 6, high: 10.5 });
  });

  it("never prints the two ends equal", () => {
    const d = etaDisplay({ lowMin: 120, highMin: 120 });
    expect(d.high).toBeGreaterThan(d.low);
  });
});
