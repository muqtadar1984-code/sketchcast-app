import { describe, expect, it } from "vitest";
import { channelDelta, deltaSince, latestChannel, latestPerVideo, viewsPerDay, youtubeUrl, type VideoSnap } from "../youtube-stats";

const snap = (video_id: string, captured_at: string, views: number, likes = 0, comments = 0): VideoSnap => ({
  video_id, captured_at, title: "T", privacy: "public", published_at: null, views, likes, comments,
});
const NOW = new Date("2026-09-21T12:00:00Z");

describe("snapshots into readings", () => {
  const snaps = [
    snap("a", "2026-09-18T10:00:00Z", 100, 5, 1),
    snap("a", "2026-09-19T10:00:00Z", 130, 6, 1),
    snap("a", "2026-09-20T10:00:00Z", 160, 8, 2),
    snap("a", "2026-09-21T10:00:00Z", 200, 9, 2),
    snap("b", "2026-09-21T10:00:00Z", 10),
  ];

  it("takes the newest snapshot per video", () => {
    const m = latestPerVideo(snaps);
    expect(m.get("a")?.views).toBe(200);
    expect(m.get("b")?.views).toBe(10);
  });

  it("measures a delta against the snapshot at or before the window start", () => {
    expect(deltaSince(snaps, "a", new Date("2026-09-20T12:00:00Z"))).toEqual({ views: 40, likes: 1, comments: 0, partial: false });
    expect(deltaSince(snaps, "a", new Date("2026-09-19T12:00:00Z"))).toEqual({ views: 70, likes: 3, comments: 1, partial: false });
  });

  it("flags a window older than the first snapshot as partial, and needs two snapshots", () => {
    expect(deltaSince(snaps, "a", new Date("2026-09-01T00:00:00Z"))).toEqual({ views: 100, likes: 4, comments: 1, partial: true });
    expect(deltaSince(snaps, "b", new Date("2026-09-20T00:00:00Z"))).toBeNull();
  });

  it("never reports a negative delta when YouTube revises a count down", () => {
    const s = [snap("c", "2026-09-20T10:00:00Z", 50), snap("c", "2026-09-21T10:00:00Z", 45)];
    expect(deltaSince(s, "c", new Date("2026-09-20T00:00:00Z"))?.views).toBe(0);
  });

  it("sums views gained per day across videos, skipping each video's first day", () => {
    const d = viewsPerDay(snaps, 4, NOW);
    expect(d.map((p) => p.day)).toEqual(["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21"]);
    expect(d.map((p) => p.views)).toEqual([0, 30, 30, 40]);
  });

  it("carries a gap day forward rather than inventing a zero", () => {
    const s = [snap("d", "2026-09-18T10:00:00Z", 0), snap("d", "2026-09-21T10:00:00Z", 90)];
    const d = viewsPerDay(s, 4, NOW);
    expect(d.map((p) => p.views)).toEqual([0, 0, 0, 90]);
  });

  it("reads the channel", () => {
    const ch = [
      { channel_id: "UC", captured_at: "2026-09-14T00:00:00Z", title: "S", subscribers: 10, views: 1000, videos: 8 },
      { channel_id: "UC", captured_at: "2026-09-21T00:00:00Z", title: "S", subscribers: 14, views: 1400, videos: 9 },
    ];
    expect(latestChannel(ch)?.subscribers).toBe(14);
    expect(channelDelta(ch, new Date("2026-09-10T00:00:00Z"))).toEqual({ subscribers: 4, views: 400, partial: true });
    expect(channelDelta(ch, new Date("2026-09-15T00:00:00Z"))).toEqual({ subscribers: 4, views: 400, partial: false });
    expect(channelDelta(ch.slice(1), new Date())).toBeNull();
    expect(youtubeUrl("IJgImFsWrME")).toBe("https://www.youtube.com/watch?v=IJgImFsWrME");
  });
});
