import { describe, it, expect } from "vitest";
import { overviewAudience } from "../console-audience";
import type { ChannelSnap } from "../youtube-stats";
import type { DailyRow } from "../cloudflare-stats";

const snap = (captured_at: string, subscribers: number | null, views: number | null): ChannelSnap => ({
  channel_id: "UC1",
  captured_at,
  title: "SketchCast AI",
  subscribers,
  views,
  videos: 3,
});
const day = (d: string, uniques: number): DailyRow => ({ day: d, zone: "sketchcast.app", requests: uniques * 4, page_views: uniques * 2, uniques });

// A fixed "now" so the 30-day window is deterministic: 2026-10-08 12:00 UTC
// → the window is 2026-09-09 .. 2026-10-08 inclusive.
const NOW = new Date("2026-10-08T12:00:00Z");

describe("overviewAudience — the Overview's YouTube and traffic cards", () => {
  it("reads subscribers and lifetime views from the NEWEST channel snapshot", () => {
    const a = overviewAudience(
      [snap("2026-10-01T00:00:00Z", 10, 500), snap("2026-10-08T06:00:00Z", 12, 640), snap("2026-10-05T00:00:00Z", 11, 600)],
      [],
      NOW,
    );
    expect(a.subscribers).toBe(12);
    expect(a.channelViews).toBe(640);
  });

  it("shows a dash (null) with no snapshot, and 0 for a snapshot whose counter is unknown", () => {
    expect(overviewAudience([], [], NOW)).toMatchObject({ subscribers: null, channelViews: null });
    expect(overviewAudience([snap("2026-10-08T00:00:00Z", null, null)], [], NOW)).toMatchObject({ subscribers: 0, channelViews: 0 });
  });

  it("sums unique visitors over the last 30 UTC days and over every day on record, like the Traffic tab", () => {
    const a = overviewAudience(
      [],
      [
        day("2026-09-08", 100), // the day BEFORE the window: lifetime only
        day("2026-09-09", 5), // first day of the window
        day("2026-10-01", 7),
        day("2026-10-08", 9), // today
      ],
      NOW,
    );
    expect(a.visitors30).toBe(21);
    expect(a.visitorsAll).toBe(121);
  });

  it("shows a dash (null) for traffic when Cloudflare has written no rows yet", () => {
    const a = overviewAudience([], [], NOW);
    expect(a.visitors30).toBeNull();
    expect(a.visitorsAll).toBeNull();
  });
});
