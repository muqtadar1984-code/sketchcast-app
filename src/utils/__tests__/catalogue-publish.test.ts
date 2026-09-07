/**
 * The publish step's pure logic (Phase 4): the four refusals a publish must
 * pass (kit approved, topic video approved, the kit's article still the
 * approved version, the question bank not empty), the privacy rule that keeps
 * every upload private until the YouTube API project passes its compliance
 * audit, the per-part publication summary that decides Publish vs Retry, and
 * the title + description the worker will post.
 *
 * Nothing here can publish anything: the route enqueues a `topic_publish` job
 * and the WORKER re-checks every refusal before its first network call
 * (catalogue-routes.test.ts asserts the route's half).
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-publish.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  CATALOGUE_PUBLISH_MIGRATION,
  DEFAULT_PRIVACY,
  MIN_CHAPTER_MARKS,
  PRIVACY,
  PRIVACY_LABEL,
  PUBLISHABLE_PRIVACY,
  PUBLISH_OFF_NOTE,
  PUBLISH_TOPIC_STATUSES,
  SKETCHCAST_LINK,
  buildDescriptionPreview,
  canPublish,
  canQueuePublish,
  chapterLines,
  isPrivacy,
  publicationSummary,
  publishActionFor,
  publishPrivacyAccepts,
  publishTitle,
} from "@/utils/catalogue/publish";
import type { ChapterMark, PublishPrivacy, TopicPublication } from "@/utils/catalogue/types";

const pub = (part: number, over: Partial<TopicPublication> = {}): TopicPublication => ({
  id: `p${part}`,
  topic_kit_id: "kit",
  part,
  channel_language: "en",
  youtube_video_id: null,
  privacy: "private",
  playlist_ids: [],
  captions_uploaded: [],
  thumbnail_set: false,
  published_at: null,
  error: null,
  created_at: "2026-09-07T00:00:00Z",
  updated_at: "2026-09-07T00:00:00Z",
  ...over,
});

const mark = (t: number, labelText: string, part = 1): ChapterMark => ({ part, t, label: labelText, section_id: null });

describe("privacy", () => {
  it("knows youtube's three statuses and nothing else", () => {
    expect([...PRIVACY]).toEqual(["private", "unlisted", "public"]);
    for (const p of PRIVACY) expect(isPrivacy(p)).toBe(true);
    for (const bad of ["Private", "hidden", "", null, undefined, 1, {}]) expect(isPrivacy(bad)).toBe(false);
    expect(Object.keys(PRIVACY_LABEL).sort()).toEqual([...PRIVACY].sort());
  });

  it("queues PRIVATE only — an unaudited API project cannot make an unlisted or public video", () => {
    expect([...PUBLISHABLE_PRIVACY]).toEqual(["private"]);
    expect(DEFAULT_PRIVACY).toBe("private");
    expect(publishPrivacyAccepts("private")).toEqual({ ok: true });
    for (const p of ["unlisted", "public"] as PublishPrivacy[]) {
      const r = publishPrivacyAccepts(p);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.why).toContain("compliance audit");
        expect(r.why).toContain(p);
      }
    }
  });
});

describe("canPublish — the four refusals, mirrored by the worker", () => {
  const ok = () => canPublish("approved", "video_approved", "approved", "good");

  it("accepts an approved kit of a video-approved topic with an approved article and a non-empty bank", () => {
    expect(ok()).toEqual({ ok: true });
  });

  it("refuses a kit that is not approved — gate 2 first", () => {
    for (const s of ["generating", "in_review", "rejected", "failed"]) {
      const r = canPublish(s, "video_approved", "approved", "good");
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.why).toContain("gate 2");
    }
    // the kit's own status is checked BEFORE the topic's, so an in-review kit
    // of an in-review topic reads "not approved", not "not video approved"
    const r = canPublish("in_review", "in_review", "approved", "good");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("not approved");
  });

  it("accepts video_approved AND published topics — a capped run is finished, not restarted", () => {
    expect([...PUBLISH_TOPIC_STATUSES]).toEqual(["video_approved", "published"]);
    expect(canPublish("approved", "published", "approved", "basic")).toEqual({ ok: true });
    for (const s of ["candidate", "approved", "article_approved", "in_review", "retired"]) {
      expect(canPublish("approved", s, "approved", "good").ok, s).toBe(false);
    }
    // a topic generating a newer kit says so by name
    const r = canPublish("approved", "generating", "approved", "good");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("newer kit");
  });

  it("refuses a kit whose article is superseded, rejected or gone", () => {
    for (const s of ["superseded", "rejected", "draft", "in_review"]) {
      const r = canPublish("approved", "video_approved", s, "good");
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.why).toContain("regenerate the kit");
    }
    const gone = canPublish("approved", "video_approved", null, "good");
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.why).toContain("no longer exists");
  });

  it("refuses an empty question bank — a published video links to its worksheet", () => {
    for (const b of ["none", null, undefined, ""]) {
      const r = canPublish("approved", "video_approved", "approved", b as string | null);
      expect(r.ok, String(b)).toBe(false);
      if (!r.ok) expect(r.why).toContain("question bank is empty");
    }
    for (const b of ["basic", "good", "strong", "assessment", "exam_ready"]) {
      expect(canPublish("approved", "video_approved", "approved", b).ok, b).toBe(true);
    }
  });
});

describe("publicationSummary", () => {
  it("counts a part as published by its VIDEO ID, so a caption failure does not demote a live video", () => {
    const s = publicationSummary([pub(1, { youtube_video_id: "abc", error: "captions.insert failed" })], 1);
    expect(s.published).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.parts[0].state).toBe("published");
    expect(s.complete).toBe(true);
  });

  it("fills in the parts the plan names that no run has reached", () => {
    const s = publicationSummary([pub(1, { youtube_video_id: "abc" })], 3);
    expect(s.parts.map((p) => p.part)).toEqual([1, 2, 3]);
    expect(s.parts.map((p) => p.state)).toEqual(["published", "waiting", "waiting"]);
    expect(s.total).toBe(3);
    expect(s.published).toBe(1);
    expect(s.attempted).toBe(1);
    expect(s.known).toBe(true);
    expect(s.complete).toBe(false);
    expect(s.label).toBe("1/3 published · 2 not yet");
  });

  it("a row with an error and no id is failed, and is counted as attempted", () => {
    const s = publicationSummary([pub(1, { youtube_video_id: "a" }), pub(2, { error: "quotaExceeded" })], 2);
    expect(s.parts.map((p) => p.state)).toEqual(["published", "failed"]);
    expect(s.failed).toBe(1);
    expect(s.attempted).toBe(2);
    expect(s.label).toBe("1/2 published · 1 failed");
  });

  it("an unknown part count (no part_plan) describes only the rows that exist and never claims completeness", () => {
    const none = publicationSummary([], 0);
    expect(none.known).toBe(false);
    expect(none.total).toBe(0);
    expect(none.complete).toBe(false);
    expect(none.label).toBe("nothing published yet");
    const one = publicationSummary([pub(1, { youtube_video_id: "abc" })], 0);
    expect(one.known).toBe(false);
    expect(one.total).toBe(1);
    expect(one.published).toBe(1);
    // every KNOWN row is published, but the number of parts is not known, so
    // the kit is not declared finished
    expect(one.complete).toBe(false);
  });

  it("lists a row for a part outside the plan — the channel is the truth, not the plan", () => {
    const s = publicationSummary([pub(1, { youtube_video_id: "a" }), pub(4, { youtube_video_id: "d" })], 2);
    expect(s.parts.map((p) => p.part)).toEqual([1, 2, 4]);
    expect(s.total).toBe(3);
    expect(s.complete).toBe(false);
  });
});

describe("which action, and whether it may be queued", () => {
  it("offers Publish before any run and Retry once one has touched a part", () => {
    expect(publishActionFor(publicationSummary([], 2))).toBe("publish");
    expect(publishActionFor(publicationSummary([pub(1, { error: "boom" })], 2))).toBe("retry");
    expect(publishActionFor(publicationSummary([pub(1, { youtube_video_id: "a" })], 2))).toBe("retry");
  });

  it("refuses either action once every known part is on the channel", () => {
    const done = publicationSummary([pub(1, { youtube_video_id: "a" }), pub(2, { youtube_video_id: "b" })], 2);
    for (const a of ["publish", "retry"] as const) {
      const r = canQueuePublish(a, done);
      expect(r.ok, a).toBe(false);
      if (!r.ok) expect(r.why).toContain("already on YouTube");
    }
  });

  it("refuses a Retry with nothing uploaded yet, and allows the first Publish", () => {
    const fresh = publicationSummary([], 2);
    expect(canQueuePublish("publish", fresh)).toEqual({ ok: true });
    const r = canQueuePublish("retry", fresh);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("use Publish");
  });

  it("allows a Retry that finishes a capped or failed run", () => {
    const partial = publicationSummary([pub(1, { youtube_video_id: "a" }), pub(2, { error: "quotaExceeded" })], 3);
    expect(canQueuePublish("retry", partial)).toEqual({ ok: true });
    // and a plain Publish is still allowed: the job is idempotent
    expect(canQueuePublish("publish", partial)).toEqual({ ok: true });
  });
});

describe("what will be posted", () => {
  it("titles a single-part kit with the topic and a multi-part kit with Part k of N", () => {
    expect(publishTitle("Cells", 1, 1)).toBe("Cells");
    expect(publishTitle("Cells", 1, 0)).toBe("Cells");
    expect(publishTitle("  Cells  ", 2, 3)).toBe("Cells — Part 2 of 3");
    expect(publishTitle("", 1, 1)).toBe("Untitled topic");
  });

  it("emits a chapter list only when YouTube would read it: three or more marks starting at 0:00", () => {
    expect(MIN_CHAPTER_MARKS).toBe(3);
    expect(chapterLines([mark(0, "Intro"), mark(90, "Animal cells")])).toEqual([]);
    expect(chapterLines([mark(30, "Late"), mark(60, "Later"), mark(90, "Latest")])).toEqual([]);
    expect(chapterLines([mark(0, "Intro"), mark(90, "Animal cells"), mark(305, "Plant cells")])).toEqual([
      "0:00 Intro",
      "1:30 Animal cells",
      "5:05 Plant cells",
    ]);
    // unsorted input is sorted; an unlabelled mark is dropped, and dropping it
    // can take the list below the threshold
    expect(chapterLines([mark(90, "B"), mark(0, "A"), mark(45, "  ")])).toEqual([]);
    expect(chapterLines(null)).toEqual([]);
  });

  it("builds the description: summary, curriculum codes, timestamps, the next part, the tagged link", () => {
    const text = buildDescriptionPreview({
      topicTitle: "Cells",
      summary: "What cells are and how animal and plant cells differ.",
      curriculumHeader: ["Cambridge Lower Secondary Science 0893 · 7Bs.01, 7Bs.02", " "],
      chapters: [mark(0, "Intro"), mark(90, "Animal cells"), mark(305, "Plant cells")],
      part: 1,
      parts: 2,
    });
    const blocks = text.split("\n\n");
    expect(blocks[0]).toBe("What cells are and how animal and plant cells differ.");
    expect(blocks[1]).toBe("Cambridge Lower Secondary Science 0893 · 7Bs.01, 7Bs.02");
    expect(blocks[2]).toBe("0:00 Intro\n1:30 Animal cells\n5:05 Plant cells");
    expect(blocks[3]).toBe("Part 2 of 2 continues this lesson.");
    expect(blocks[4]).toContain(SKETCHCAST_LINK);
    expect(SKETCHCAST_LINK).toContain("utm_source=youtube");
    expect(SKETCHCAST_LINK).toContain("utm_campaign=topic_catalogue");
  });

  it("omits every block it has nothing for, and never a fabricated one", () => {
    const text = buildDescriptionPreview({
      topicTitle: "Cells",
      summary: null,
      curriculumHeader: [],
      chapters: [mark(0, "Intro")],
      part: 1,
      parts: 1,
    });
    const blocks = text.split("\n\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe("Cells — a SketchCast lesson.");
    expect(blocks[1]).toContain(SKETCHCAST_LINK);
    // one mark is not a chapter list, so no timestamps are posted at all
    expect(text).not.toContain("0:00");
    expect(text).not.toContain("Part 2");
  });

  it("points at the next part only from a part that has one", () => {
    const last = buildDescriptionPreview({ topicTitle: "Cells", summary: "s", curriculumHeader: [], chapters: [], part: 2, parts: 2 });
    expect(last).not.toContain("continues this lesson");
    const first = buildDescriptionPreview({ topicTitle: "Cells", summary: "s", curriculumHeader: [], chapters: [], part: 1, parts: 2 });
    expect(first).toContain("Part 2 of 2 continues this lesson.");
  });
});

describe("the dark note and the migration", () => {
  it("names the flag and the two things that are missing", () => {
    expect(PUBLISH_OFF_NOTE).toContain("FEATURE_CATALOGUE_PUBLISH");
    expect(PUBLISH_OFF_NOTE).toContain("channel");
    expect(PUBLISH_OFF_NOTE).toContain("compliance audit");
  });
  it("names 0116", () => {
    expect(CATALOGUE_PUBLISH_MIGRATION).toBe("supabase/migrations/0116_catalogue_publish.sql");
  });
});
