/**
 * The Translations tab's YouTube view (/library/translations/youtube): each
 * translated kit's posting state from the raw rows — one test per precedence
 * rule, the in-between cases (removed, partial, no channel, stale poll), the
 * selection rule bulk posting shares, and the filters and totals. Pure — the
 * page reads the rows. Also the channel rule the publish route and the Post
 * button share (youtube-channels.ts).
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-youtube-videos.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  buildVideoRows,
  filterVideoRows,
  needsAttention,
  parseVideoFilters,
  scopeRows,
  videoFiltersHref,
  videoTotals,
  viewCounts,
  type VideoInput,
  type VideoKit,
  type VideoPublication,
  type VideoStat,
} from "@/utils/catalogue/youtube-videos";
import { channelAccepts, channelsFromStats, hasOwnChannel, noChannelWhy, pollIsLate, pollMinutes } from "@/utils/catalogue/youtube-channels";

const NOW = Date.parse("2026-10-20T02:00:00Z");
const LAST_POLL = "2026-10-20T01:54:00Z";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const AR = "aaaaaaaa-0000-4000-8000-000000000001";
const MS = "aaaaaaaa-0000-4000-8000-000000000002";

const topic = (id: string, title: string, subject: string | null = "Mathematics", over: Record<string, unknown> = {}) => ({ id, title, subject, status: "video_approved", bank_maturity: "good", ...over });
const kit = (id: string, language: string, over: Partial<VideoKit> = {}): VideoKit => ({
  id,
  topic_id: T1,
  language,
  status: "approved",
  translation_status: "approved",
  created_at: "2026-10-18T00:00:00Z",
  part_plan: [{}],
  ...over,
});
const pub = (topic_kit_id: string, over: Partial<VideoPublication> = {}): VideoPublication => ({
  topic_kit_id,
  part: 1,
  channel_language: "ar",
  youtube_video_id: "yt-ar-1",
  privacy: "public",
  thumbnail_set: true,
  published_at: "2026-10-18T04:00:00Z",
  error: null,
  superseded_by: null,
  ...over,
});
const stat = (video_id: string, over: Partial<VideoStat> = {}): VideoStat => ({ video_id, channel_language: "ar", captured_at: LAST_POLL, privacy: "public", views: 12, ...over });
const channels = (langs = ["en", "ar"], at = LAST_POLL) => channelsFromStats(langs.map((l) => ({ channel_language: l, title: l, captured_at: at })), NOW);

function input(over: Partial<VideoInput> = {}): VideoInput {
  return {
    current: [
      { topic_id: T1, language: "ar", topic_kit_id: AR },
      { topic_id: T1, language: "ms", topic_kit_id: MS },
    ],
    topics: [topic(T1, "Circle"), topic(T2, "Cells", "Science")],
    kits: [kit(AR, "ar"), kit(MS, "ms")],
    publications: [pub(AR)],
    stats: [stat("yt-ar-1")],
    channels: channels(),
    jobs: [],
    nowMs: NOW,
    ...over,
  };
}
const rowOf = (inp: VideoInput, kitId: string) => buildVideoRows(inp).find((r) => r.kitId === kitId);

describe("youtube-channels: which languages have a channel of their own", () => {
  it("counts a channel polled within a day, newest snapshot wins", () => {
    const cs = channelsFromStats(
      [
        { channel_language: "ar", title: "old", captured_at: "2026-10-19T00:00:00Z" },
        { channel_language: "ar", title: "SketchCast بالعربية", captured_at: LAST_POLL },
        { channel_language: "en", title: "Sketchcast-AI", captured_at: LAST_POLL },
        { channel_language: "fr", title: "gone", captured_at: "2026-10-18T00:00:00Z" },
      ],
      NOW,
    );
    expect(cs.map((c) => [c.language, c.live])).toEqual([
      ["en", true],
      ["ar", true],
      ["fr", false],
    ]);
    expect(cs[1].title).toBe("SketchCast بالعربية");
    expect(hasOwnChannel("ar", ["en", "ar"])).toBe(true);
    expect(hasOwnChannel("ms", ["en", "ar"])).toBe(false);
  });

  it("English always posts; a translation needs its own channel", () => {
    expect(channelAccepts("en", "English", [])).toEqual({ ok: true });
    expect(channelAccepts("ar", "Arabic", ["en", "ar"])).toEqual({ ok: true });
    const ms = channelAccepts("ms", "Malay", ["en", "ar"]);
    expect(ms.ok).toBe(false);
    if (!ms.ok) expect(ms.why).toBe(noChannelWhy("Malay"));
    expect(noChannelWhy("Malay")).toMatch(/no Malay YouTube channel yet/);
  });

  it("reads the worker's poll interval and calls a poll late after two of them", () => {
    expect(pollMinutes(undefined)).toBe(60);
    expect(pollMinutes("30")).toBe(30);
    expect(pollMinutes("0")).toBe(60);
    expect(pollMinutes("x")).toBe(60);
    expect(pollIsLate(LAST_POLL, NOW, 60)).toBe(false);
    expect(pollIsLate("2026-10-19T23:59:00Z", NOW, 60)).toBe(true);
    expect(pollIsLate(null, NOW, 60)).toBe(true);
  });
});

describe("buildVideoRows: one row per translated kit, first rule wins", () => {
  it("today's shape: Arabic public on its own channel, Malay blocked for want of a channel", () => {
    const rows = buildVideoRows(input());
    expect(rows.map((r) => [r.language, r.state, r.category])).toEqual([
      ["ar", "public", "posted"],
      ["ms", "no_channel", "not_posted"],
    ]);
    const ar = rows[0];
    expect(ar.parts[0]).toMatchObject({ videoId: "yt-ar-1", privacy: "public", checkedAt: LAST_POLL, views: 12, missing: false });
    expect(ar.channel).toMatchObject({ language: "ar", exists: true });
    expect(ar.inboxHref).toBe(`/library/topics/${T1}?lang=ar`);
    const ms = rows[1];
    expect(ms.channel).toMatchObject({ language: "ms", exists: false });
    expect(ms.postable.ok).toBe(false);
    if (!ms.postable.ok) expect(ms.postable.why).toBe(noChannelWhy("Malay"));
  });

  it("an approved kit whose language HAS a channel is ready, and selectable", () => {
    const r = rowOf(input({ channels: channels(["en", "ar", "ms"]) }), MS)!;
    expect(r.state).toBe("ready");
    expect(r.postable).toEqual({ ok: true });
  });

  it("a live publish job beats everything, including a failed part", () => {
    const r = rowOf(input({ publications: [pub(AR, { youtube_video_id: null, error: "quota" })], jobs: [{ id: "j1", status: "queued", params: { kit_id: AR } }] }), AR)!;
    expect(r.state).toBe("posting");
    expect(r.liveJob).toEqual({ id: "j1", status: "queued" });
    expect(r.postable.ok).toBe(false);
  });

  it("a live re-word job is not a post", () => {
    const r = rowOf(input({ jobs: [{ id: "j2", status: "processing", params: { kit_id: AR, action: "rewords" } }] }), AR)!;
    expect(r.state).toBe("public");
    expect(r.liveJob).toBeNull();
  });

  it("removed: missing from its channel's on-time newest poll, uploaded before it", () => {
    expect(rowOf(input({ stats: [] }), AR)!.state).toBe("removed");
    expect(rowOf(input({ stats: [stat("yt-ar-1", { captured_at: "2026-10-20T00:54:00Z" })] }), AR)!.state).toBe("removed");
  });

  it("not removed when the poll is late (flagged stale instead) or ran before the upload", () => {
    const late = rowOf(input({ stats: [], channels: channels(["en", "ar"], "2026-10-19T20:00:00Z") }), AR)!;
    expect(late.state).toBe("public");
    expect(late.flags).toContain("status_stale");
    const fresh = rowOf(input({ stats: [], publications: [pub(AR, { published_at: "2026-10-20T01:58:00Z" })] }), AR)!;
    expect(fresh.state).toBe("public");
    expect(fresh.parts[0].checkedAt).toBeNull();
  });

  it("partial: one of two parts posted", () => {
    const r = rowOf(input({ kits: [kit(AR, "ar", { part_plan: [{}, {}] }), kit(MS, "ms")] }), AR)!;
    expect(r.state).toBe("partial");
    expect(r.category).toBe("posted");
    expect(r.parts.map((p) => !!p.videoId)).toEqual([true, false]);
    expect(needsAttention(r)).toBe(true);
  });

  it("the least public part names the row: unlisted, private", () => {
    const two = [kit(AR, "ar", { part_plan: [{}, {}] })];
    const unlisted = rowOf(input({ kits: two, publications: [pub(AR), pub(AR, { part: 2, youtube_video_id: "yt-2", privacy: "unlisted" })], stats: [stat("yt-ar-1"), stat("yt-2")] }), AR)!;
    expect(unlisted.state).toBe("unlisted");
    const priv = rowOf(input({ publications: [pub(AR, { privacy: "private" })] }), AR)!;
    expect(priv.state).toBe("private");
    expect(priv.category).toBe("posted");
  });

  it("post_failed: the last upload failed and nothing is up", () => {
    const r = rowOf(input({ publications: [pub(AR, { youtube_video_id: null, error: "HttpError 403" })] }), AR)!;
    expect(r.state).toBe("post_failed");
    expect(r.parts[0].error).toBe("HttpError 403");
    expect(r.postable).toEqual({ ok: true }); // Retry finishes it
  });

  it("awaiting approval: an in-review translation is listed, never selectable", () => {
    const r = rowOf(input({ kits: [kit(MS, "ms", { status: "in_review", translation_status: "in_review" })], current: [], publications: [] }), MS)!;
    expect(r.state).toBe("awaiting_approval");
    expect(r.flags).toEqual([]); // not current yet by design, not "superseded"
    expect(r.postable.ok).toBe(false);
  });

  it("flags: no thumbnail, posted with notes, superseded", () => {
    const r = rowOf(input({ publications: [pub(AR, { thumbnail_set: false, error: "thumbnail failed (HttpError 403)" })] }), AR)!;
    expect(r.state).toBe("public");
    expect(r.flags).toEqual(["thumbnail_missing", "posted_with_notes"]);
    const old = rowOf(input({ current: [] }), AR)!;
    expect(old.flags).toContain("superseded");
    expect(old.postable.ok).toBe(false);
  });

  it("leaves out English kits, rejected / failed / generating translations, and unposted non-current kits", () => {
    const rows = buildVideoRows(
      input({
        kits: [
          kit("en-1", "en", { translation_status: null }),
          kit("rej", "ms-arab", { status: "rejected", translation_status: "failed" }),
          kit("gen", "hi", { status: "generating", translation_status: "staged" }),
          kit("old", "fr"),
        ],
        current: [],
        publications: [],
      }),
    );
    expect(rows).toEqual([]);
  });

  it("refuses posting on an empty bank or an unapproved topic, in that order after approval", () => {
    const ms3 = (over: Record<string, unknown>) => rowOf(input({ topics: [topic(T1, "Circle", "Mathematics", over)], channels: channels(["en", "ar", "ms"]) }), MS)!;
    const bank = ms3({ bank_maturity: "none" }).postable;
    expect(bank.ok).toBe(false);
    if (!bank.ok) expect(bank.why).toMatch(/question bank is empty/);
    const topicGen = ms3({ status: "generating" }).postable;
    expect(topicGen.ok).toBe(false);
    if (!topicGen.ok) expect(topicGen.why).toMatch(/not video approved/);
  });

  it("orders rows by the translator's language order, then subject, then title", () => {
    const rows = buildVideoRows(
      input({
        current: [],
        kits: [kit("m1", "ms", { topic_id: T2 }), kit("a2", "ar", { topic_id: T2 }), kit("a1", "ar")],
        publications: [pub("m1", { channel_language: "ms", youtube_video_id: "v3" }), pub("a2", { youtube_video_id: "v2" }), pub("a1", { youtube_video_id: "v1" })],
        stats: [stat("v1"), stat("v2"), stat("v3", { channel_language: "ms" })],
        channels: channels(["en", "ar", "ms"]),
      }),
    );
    expect(rows.map((r) => `${r.language}:${r.title}`)).toEqual(["ar:Circle", "ar:Cells", "ms:Cells"]);
  });
});

describe("filters, counts and totals", () => {
  const rows = buildVideoRows(input());

  it("parses the URL and drops what it does not know", () => {
    expect(parseVideoFilters({ view: "public", lang: "AR", subject: "Mathematics", q: " circ " }, ["ar", "ms"])).toEqual({ view: "public", lang: "ar", subject: "Mathematics", q: "circ" });
    expect(parseVideoFilters({ view: "nope", lang: "xx" }, ["ar"])).toEqual({ view: "all", lang: "", subject: "", q: "" });
    expect(videoFiltersHref({ view: "attention", lang: "ms" })).toBe("/library/translations/youtube?view=attention&lang=ms");
    expect(videoFiltersHref({ view: "all" })).toBe("/library/translations/youtube");
  });

  it("each category chip counts what it would show", () => {
    const c = viewCounts(rows);
    expect(c).toMatchObject({ all: 2, posted: 1, public: 1, private: 0, not_posted: 1, ready: 0, attention: 1 });
    expect(filterVideoRows(rows, { view: "posted", lang: "", subject: "", q: "" }).map((r) => r.language)).toEqual(["ar"]);
    expect(filterVideoRows(rows, { view: "attention", lang: "", subject: "", q: "" }).map((r) => r.language)).toEqual(["ms"]);
    expect(scopeRows(rows, { lang: "ms", subject: "", q: "" })).toHaveLength(1);
    expect(scopeRows(rows, { lang: "", subject: "Science", q: "" })).toHaveLength(0);
    expect(scopeRows(rows, { lang: "", subject: "", q: "CIRC" })).toHaveLength(2);
  });

  it("totals per language say how many are posted and whether a channel exists", () => {
    expect(videoTotals(rows, channels())).toEqual([
      { language: "ar", name: "Arabic", total: 1, posted: 1, public: 1, unlisted: 0, private: 0, notPosted: 0, ready: 0, awaiting: 0, attention: 0, channel: true },
      { language: "ms", name: "Malay", total: 1, posted: 0, public: 0, unlisted: 0, private: 0, notPosted: 1, ready: 0, awaiting: 0, attention: 1, channel: false },
    ]);
  });
});
