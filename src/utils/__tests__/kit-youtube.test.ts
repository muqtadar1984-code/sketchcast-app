// Where a catalogue kit's lesson video lives on YouTube (founder 2026-10-30:
// "the video should be pulled from youtube to avoid egress cost").
// Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/kit-youtube.test.ts
import { describe, expect, it } from "vitest";
import { bundleVideoId, loadKitYoutubeIds, topicKitIdOf, videoSource, youtubeIdsByKit, youtubeWatchUrl } from "@/utils/catalogue/kit-youtube";

const KIT = "b0000001-0000-4000-8000-000000000000";
const OTHER = "b0000002-0000-4000-8000-000000000000";
const pub = (o: Record<string, unknown>) => ({ topic_kit_id: KIT, part: 1, youtube_video_id: "AAAAAAAAAA1", privacy: "public", superseded_by: null, channel_language: "en", ...o });

describe("youtubeIdsByKit", () => {
  it("one id per part, in part order; only live, embeddable, well-formed ids", () => {
    const m = youtubeIdsByKit([
      pub({ part: 2, youtube_video_id: "AAAAAAAAAA2" }),
      pub({ part: 1 }),
      pub({ part: 3, youtube_video_id: "AAAAAAAAAA3", privacy: "private" }),
      pub({ part: 4, youtube_video_id: "AAAAAAAAAA4", superseded_by: "x" }),
      pub({ part: 5, youtube_video_id: "AAAAAAAAAA5", youtube_missing_since: "2026-10-01" }),
      pub({ part: 6, youtube_video_id: "not an id" }),
      pub({ topic_kit_id: OTHER, part: null, youtube_video_id: "CCCCCCCCCC1", privacy: "unlisted" }),
    ]);
    expect(m.get(KIT)).toEqual(["AAAAAAAAAA1", "AAAAAAAAAA2"]);
    expect(m.get(OTHER)).toEqual(["CCCCCCCCCC1"]);
  });

  it("a part posted twice keeps the public one", () => {
    const m = youtubeIdsByKit([pub({ youtube_video_id: "UUUUUUUUUU1", privacy: "unlisted", channel_language: "ar" }), pub({ youtube_video_id: "PPPPPPPPPP1", channel_language: "ms" })]);
    expect(m.get(KIT)).toEqual(["PPPPPPPPPP1"]);
  });
});

describe("topicKitIdOf / bundleVideoId / videoSource", () => {
  it("finds the kit through catalogue_ref, then product_ref; nothing for an uploaded book's lesson", () => {
    expect(topicKitIdOf({ catalogue_ref: { topic_kit_id: KIT } })).toBe(KIT);
    expect(topicKitIdOf({ product_ref: { topic_kit_id: OTHER } })).toBe(OTHER);
    expect(topicKitIdOf({ part: 1, language: "en" })).toBeNull();
    expect(topicKitIdOf(null)).toBeNull();
  });

  it("reads the bundle's video:<id> entries", () => {
    expect(bundleVideoId("video:AAAAAAAAAA1")).toBe("AAAAAAAAAA1");
    expect(bundleVideoId("AAAAAAAAAA1")).toBe("AAAAAAAAAA1");
    expect(bundleVideoId("video:../etc")).toBeNull();
    expect(bundleVideoId(3)).toBeNull();
  });

  it("YouTube when it covers every stored part; storage otherwise; none when there is nothing", () => {
    expect(videoSource(["a"], 1)).toBe("youtube");
    expect(videoSource(["a"], 0)).toBe("youtube");
    expect(videoSource(["a"], 2)).toBe("storage");
    expect(videoSource([], 1)).toBe("storage");
    expect(videoSource([], 0)).toBe("none");
    expect(youtubeWatchUrl("AAAAAAAAAA1")).toBe("https://www.youtube.com/watch?v=AAAAAAAAAA1");
  });
});

describe("loadKitYoutubeIds", () => {
  it("one read for every kit; a failed read is an empty map (callers fall back to storage)", async () => {
    const calls: unknown[] = [];
    const db = {
      from: (t: string) => ({
        select: () => ({
          in: async (col: string, ids: string[]) => {
            calls.push([t, col, ids]);
            return { data: [pub({})], error: null };
          },
        }),
      }),
    };
    expect((await loadKitYoutubeIds(db, [KIT, KIT, ""])).get(KIT)).toEqual(["AAAAAAAAAA1"]);
    expect(calls).toEqual([["topic_publications", "topic_kit_id", [KIT]]]);
    const broken = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: "nope" } }) }) }) };
    expect((await loadKitYoutubeIds(broken, [KIT])).size).toBe(0);
    expect((await loadKitYoutubeIds(db, [])).size).toBe(0);
  });
});
