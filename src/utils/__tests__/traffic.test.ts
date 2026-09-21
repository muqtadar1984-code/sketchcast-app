import { describe, expect, it } from "vitest";
import {
  cleanPath, compact, dailySeries, deviceOf, hostTotals, isBotUserAgent, lastDays, minuteSeries,
  refHost, sumSeries, visitorHash,
} from "../traffic";

const NOW = new Date("2026-09-21T10:30:00Z");

describe("what a visit is", () => {
  it("drops crawlers, previews and tools, and an empty user agent", () => {
    for (const ua of ["Googlebot/2.1", "facebookexternalhit/1.1", "curl/8.0", "Mozilla/5.0 (compatible; AhrefsBot/7.0)", "", null])
      expect(isBotUserAgent(ua)).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1")).toBe(false);
    expect(isBotUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0")).toBe(false);
  });

  it("stores the path without query, fragment or trailing slash", () => {
    expect(cleanPath("/pricing?ref=chatgpt#faq")).toBe("/pricing");
    expect(cleanPath("/schools/")).toBe("/schools");
    expect(cleanPath("")).toBe("/");
    expect(cleanPath("dashboard//x")).toBe("/dashboard/x");
    expect(cleanPath("/" + "a".repeat(300)).length).toBe(200);
  });

  it("keeps the referrer's host only and forgets our own", () => {
    expect(refHost("https://www.google.com/search?q=sketchcast")).toBe("google.com");
    expect(refHost("https://chatgpt.com/c/123")).toBe("chatgpt.com");
    expect(refHost("https://sketchcast.app/pricing")).toBeNull();
    expect(refHost("https://app.sketchcast.app/login")).toBeNull();
    expect(refHost("android-app://com.google.android.gm/")).toBeNull();
    expect(refHost("")).toBeNull();
    expect(refHost("t.co")).toBe("t.co");
  });

  it("hashes the visitor with a daily salt and never stores the address", () => {
    const a = visitorHash("s", "203.0.113.5", "UA", "2026-09-21");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(visitorHash("s", "203.0.113.5", "UA", "2026-09-21")).toBe(a);
    expect(visitorHash("s", "203.0.113.5", "UA", "2026-09-22")).not.toBe(a);
    expect(visitorHash("s", "203.0.113.6", "UA", "2026-09-21")).not.toBe(a);
    expect(a).not.toContain("203");
  });

  it("splits devices coarsely", () => {
    expect(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148")).toBe("mobile");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0)")).toBe("desktop");
  });
});

describe("shaping for the console", () => {
  const rows = [
    { day: "2026-09-21", host: "sketchcast.app", visits: 10, visitors: 7 },
    { day: "2026-09-21", host: "app.sketchcast.app", visits: 4, visitors: 3 },
    { day: "2026-09-21", host: "console.sketchcast.app", visits: 30, visitors: 1 },
    { day: "2026-09-19", host: "sketchcast.app", visits: 2, visitors: 2 },
  ];

  it("fills the gaps and leaves staff hosts out by default", () => {
    const s = dailySeries(rows, 3, undefined, NOW);
    expect(s.map((p) => p.day)).toEqual(["2026-09-19", "2026-09-20", "2026-09-21"]);
    expect(s.map((p) => p.visits)).toEqual([2, 0, 14]);
    expect(s.map((p) => p.visitors)).toEqual([2, 0, 10]);
    expect(sumSeries(s)).toEqual({ visits: 16, visitors: 12 });
  });

  it("can be narrowed to one host", () => {
    expect(dailySeries(rows, 1, new Set(["app.sketchcast.app"]), NOW)[0].visits).toBe(4);
  });

  it("lists hosts busiest first with staff last", () => {
    const t = hostTotals(rows);
    expect(t.map((h) => h.host)).toEqual(["sketchcast.app", "app.sketchcast.app", "console.sketchcast.app"]);
    expect(t[0]).toMatchObject({ label: "Website", visits: 12, visitors: 9, staff: false });
    expect(t[2].staff).toBe(true);
  });

  it("builds a gap-free minute strip ending now", () => {
    const m = minuteSeries([{ minute: "2026-09-21T10:29:00Z", visits: 3, visitors: 2 }, { minute: "2026-09-21T09:00:00Z", visits: 9, visitors: 9 }], 5, NOW);
    expect(m).toHaveLength(5);
    expect(m[m.length - 1]).toEqual({ minute: "2026-09-21T10:30:00.000Z", visits: 0 });
    expect(m[m.length - 2].visits).toBe(3);
    expect(m.reduce((a, p) => a + p.visits, 0)).toBe(3);
  });

  it("formats compactly", () => {
    expect(compact(999)).toBe("999");
    expect(compact(1234)).toBe("1.2k");
    expect(compact(12345)).toBe("12k");
    expect(compact(2_500_000)).toBe("2.5m");
    expect(lastDays(2, NOW)).toEqual(["2026-09-20", "2026-09-21"]);
  });
});
