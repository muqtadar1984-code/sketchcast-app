import { describe, expect, it } from "vitest";
import { ago, compact, dailySeries, lastDays, lifetime, sumPoints, topCountries, type DailyRow } from "../cloudflare-stats";

const NOW = new Date("2026-09-21T10:30:00Z");
const row = (day: string, page_views: number, uniques: number, requests = page_views * 3, countries: Array<[string, number]> = []): DailyRow =>
  ({ day, zone: "sketchcast.app", page_views, uniques, requests, countries: countries.map(([country, r]) => ({ country, requests: r })) });

describe("daily series", () => {
  it("fills quiet days with zero and ends today", () => {
    const s = dailySeries([row("2026-09-19", 30, 12), row("2026-09-21", 40, 15)], 3, NOW);
    expect(s.map((p) => p.day)).toEqual(["2026-09-19", "2026-09-20", "2026-09-21"]);
    expect(s.map((p) => p.uniques)).toEqual([12, 0, 15]);
    expect(sumPoints(s)).toEqual({ pageViews: 70, uniques: 27, requests: 210 });
  });

  it("lastDays is oldest first and UTC", () => {
    expect(lastDays(2, new Date("2026-09-21T23:59:59Z"))).toEqual(["2026-09-20", "2026-09-21"]);
    expect(lastDays(1, new Date("2026-09-22T00:00:01Z"))).toEqual(["2026-09-22"]);
  });
});

describe("lifetime", () => {
  it("is the first day on record and the sum of every day", () => {
    expect(lifetime([row("2026-09-21", 40, 15), row("2026-08-01", 10, 4), row("2026-09-01", 20, 8)]))
      .toEqual({ firstDay: "2026-08-01", days: 3, pageViews: 70, uniques: 27, requests: 210 });
    expect(lifetime([])).toEqual({ firstDay: null, days: 0, pageViews: 0, uniques: 0, requests: 0 });
  });
});

describe("countries", () => {
  it("adds up requests per code across days, largest first, with a share", () => {
    const top = topCountries([row("2026-09-20", 10, 4, 30, [["MY", 20], ["IN", 5]]), row("2026-09-21", 10, 4, 30, [["IN", 25], ["US", 10]])]);
    expect(top.map((c) => [c.code, c.requests])).toEqual([["IN", 30], ["MY", 20], ["US", 10]]);
    expect(top[0].share).toBeCloseTo(0.5);
    expect(top[1].label).toBe("Malaysia");
  });
  it("tolerates rows without a country map", () => {
    expect(topCountries([{ ...row("2026-09-21", 1, 1), countries: null }])).toEqual([]);
  });
});

describe("formatting", () => {
  it("compacts thousands and millions", () => {
    expect(compact(999)).toBe("999");
    expect(compact(1234)).toBe("1.2k");
    expect(compact(12_345)).toBe("12k");
    expect(compact(2_500_000)).toBe("2.5M");
  });
  it("says how long ago the last poll was", () => {
    expect(ago(null)).toBe("never");
    expect(ago("2026-09-21T10:29:30Z", NOW)).toBe("just now");
    expect(ago("2026-09-21T09:30:00Z", NOW)).toBe("60 min ago".replace("60 min", "1 h"));
    expect(ago("2026-09-18T10:30:00Z", NOW)).toBe("3 d ago");
  });
});
