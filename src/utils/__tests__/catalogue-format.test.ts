/**
 * The video-format facts (0122): which published videos predate the format
 * the worker renders now, and which older video a re-rendered kit may
 * supersede. Pure — the route enqueues a `topic_supersede` job and the
 * WORKER (sketchcast-ai catalogue/supersede.py) does the YouTube side and
 * re-checks the pair with the same sentences.
 */
import { describe, expect, it } from "vitest";
import {
  canQueueSupersede,
  changesSince,
  formatLabel,
  formatVersionOf,
  isOutdatedPublication,
  outdatedPublications,
  parseVideoFormat,
  supersedeCandidates,
} from "@/utils/catalogue/format";
import type { TopicPublication } from "@/utils/catalogue/types";

const pub = (over: Partial<TopicPublication>): TopicPublication => ({
  id: "p",
  topic_kit_id: "kit",
  part: 1,
  channel_language: "en",
  youtube_video_id: "vid",
  privacy: "public",
  playlist_ids: [],
  captions_uploaded: [],
  thumbnail_set: true,
  published_at: "2026-09-20T00:00:00Z",
  error: null,
  format_version: null,
  superseded_by: null,
  superseded_at: null,
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
  ...over,
});

const SETTING = { version: 2, changes: { "1": "The original scene engine.", "2": "Labels anchored to parts." }, recorded_at: null };

describe("parseVideoFormat", () => {
  it("reads what the worker wrote and refuses junk", () => {
    expect(parseVideoFormat({ version: 2, changes: { "1": "a", "2": "b" }, recorded_at: "t" })).toEqual({ version: 2, changes: { "1": "a", "2": "b" }, recorded_at: "t" });
    expect(parseVideoFormat({ version: "two" })).toBeNull();
    expect(parseVideoFormat(null)).toBeNull();
    expect(parseVideoFormat({ version: 3, changes: { "3": 7 } })).toEqual({ version: 3, changes: {}, recorded_at: null });
  });
});

describe("outdated", () => {
  it("a row posted before the stamp is format 1", () => {
    expect(formatVersionOf(pub({ format_version: null }))).toBe(1);
    expect(formatVersionOf(pub({ format_version: 2 }))).toBe(2);
  });
  it("live and older than current", () => {
    expect(isOutdatedPublication(pub({ format_version: 1 }), 2)).toBe(true);
    expect(isOutdatedPublication(pub({ format_version: 2 }), 2)).toBe(false);
    expect(isOutdatedPublication(pub({ format_version: 1, superseded_by: "x" }), 2)).toBe(false);
    expect(isOutdatedPublication(pub({ format_version: 1, youtube_video_id: null }), 2)).toBe(false);
    expect(outdatedPublications([pub({ id: "a", format_version: 1 }), pub({ id: "b", format_version: 2 })], 2).map((r) => r.id)).toEqual(["a"]);
  });
  it("labels the chip", () => {
    expect(formatLabel(pub({ format_version: 1 }), 2)).toBe("format v1 · current v2");
    expect(formatLabel(pub({ format_version: 2 }), 2)).toBe("format v2");
    expect(formatLabel(pub({ format_version: 1 }), null)).toBe("format v1");
    expect(formatLabel(pub({ youtube_video_id: null }), 2)).toBeNull();
  });
  it("lists what changed since", () => {
    expect(changesSince(SETTING, 1)).toEqual(["v2: Labels anchored to parts."]);
    expect(changesSince(SETTING, 2)).toEqual([]);
  });
});

describe("supersede", () => {
  const mine = [pub({ id: "new1", topic_kit_id: "kit-new", part: 1, youtube_video_id: "v-new" }), pub({ id: "new2", topic_kit_id: "kit-new", part: 2, youtube_video_id: null })];
  const others = [
    pub({ id: "old1", topic_kit_id: "kit-old", part: 1, youtube_video_id: "v-old", published_at: "2026-09-10T00:00:00Z" }),
    pub({ id: "old1b", topic_kit_id: "kit-older", part: 1, youtube_video_id: "v-older", published_at: "2026-09-01T00:00:00Z" }),
    pub({ id: "old2", topic_kit_id: "kit-old", part: 2, youtube_video_id: "v-old2" }),
    pub({ id: "gone", topic_kit_id: "kit-old", part: 1, youtube_video_id: "v-gone", superseded_by: "new1" }),
  ];
  it("pairs each posted part with the older live videos of the same part, oldest first", () => {
    const c = supersedeCandidates(mine, others, "kit-new");
    expect(c.map((x) => [x.part, x.old.id, x.replacement.id])).toEqual([
      [1, "old1b", "new1"],
      [1, "old1", "new1"],
    ]);
  });
  it("accepts a sound pair and refuses the rest in the worker's words", () => {
    const old = others[0];
    expect(canQueueSupersede(old, mine[0])).toEqual({ ok: true });
    expect(canQueueSupersede(null, mine[0])).toMatchObject({ ok: false });
    expect(canQueueSupersede(old, null)).toMatchObject({ ok: false, why: expect.stringContaining("post it first") });
    expect(canQueueSupersede(old, pub({ id: "x", part: 2, youtube_video_id: "v2" }))).toMatchObject({ ok: false, why: expect.stringContaining("parts differ") });
    expect(canQueueSupersede(pub({ id: "o", youtube_video_id: "same" }), pub({ id: "n", youtube_video_id: "same" }))).toMatchObject({ ok: false, why: expect.stringContaining("same YouTube video") });
    expect(canQueueSupersede(pub({ id: "o", superseded_by: "other" }), mine[0])).toMatchObject({ ok: false, why: expect.stringContaining("already superseded") });
    expect(canQueueSupersede(pub({ id: "o", superseded_by: "new1" }), mine[0])).toMatchObject({ ok: false, why: expect.stringContaining("already points") });
    expect(canQueueSupersede(pub({ id: "o", channel_language: "hi" }), mine[0])).toMatchObject({ ok: false, why: expect.stringContaining("different channels") });
  });
});
