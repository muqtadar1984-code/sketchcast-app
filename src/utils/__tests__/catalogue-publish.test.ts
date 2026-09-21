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
  AUDIT_NOTE,
  CATALOGUE_PUBLISH_MIGRATION,
  DEFAULT_PRIVACY,
  MIN_CHAPTER_MARKS,
  PRIVACY,
  PRIVACY_LABEL,
  PUBLISHABLE_PRIVACY,
  PUBLISH_OFF_NOTE,
  PUBLISH_TOPIC_STATUSES,
  SKETCHCAST_LINE,
  SKETCHCAST_LINK,
  TITLE_MAX,
  YOUTUBE_META_MIGRATION,
  audienceTag,
  boardLabel,
  boardsOf,
  buildDescriptionPreview,
  canPublish,
  canQueuePublish,
  chapterLines,
  cleanHashtags,
  composeTitle,
  defaultHashtags,
  defaultPrivacy,
  headline,
  isPrivacy,
  publicationSummary,
  publishActionFor,
  publishPrivacyAccepts,
  publishTitle,
  publishablePrivacies,
  termsFromSummary,
  validateYouTubeMeta,
} from "@/utils/catalogue/publish";
import type { HeaderMapping } from "@/utils/catalogue/kit";
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

  it("queues PRIVATE only until the audit is passed — an unaudited API project cannot make an unlisted or public video", () => {
    expect([...PUBLISHABLE_PRIVACY]).toEqual(["private"]);
    expect(DEFAULT_PRIVACY).toBe("private");
    expect([...publishablePrivacies(false)]).toEqual(["private"]);
    expect(defaultPrivacy(false)).toBe("private");
    expect(publishPrivacyAccepts("private")).toEqual({ ok: true });
    for (const p of ["unlisted", "public"] as PublishPrivacy[]) {
      const r = publishPrivacyAccepts(p, false);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.why).toContain("compliance audit");
        expect(r.why).toContain(p);
      }
    }
    expect(AUDIT_NOTE).toContain("YOUTUBE_COMPLIANCE_AUDIT_PASSED");
  });

  it("with the audit passed every privacy is queueable and PUBLIC is the default — the library is the review, Post is the release", () => {
    expect([...publishablePrivacies(true)]).toEqual(["private", "unlisted", "public"]);
    expect(defaultPrivacy(true)).toBe("public");
    for (const p of PRIVACY) expect(publishPrivacyAccepts(p, true)).toEqual({ ok: true });
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

const MAPPINGS: HeaderMapping[] = [
  { curriculum: { id: "c1", code: "cbse_science_086", name: "CBSE Science (Class 6-10)" }, node: { code: "cbse:9:U2:01", title: "Cell - Basic Unit of life", grade: "9" } },
  { curriculum: { id: "c2", code: "cambridge_ls_science_0893", name: "Cambridge Lower Secondary Science 0893" }, node: { code: "7Bs.04", title: "Plant and animal cells", grade: "7" } },
];
const SUMMARY = "Cell membrane, cytoplasm, nucleus, mitochondria, cell wall, chloroplasts and vacuole — what plant and animal cells share and where they differ.";

describe("the audience, the terms and the tags (mirrors the worker's youtube_meta.py)", () => {
  it("labels each board in its own idiom and joins them into the audience tag", () => {
    expect(boardLabel("CBSE Science (Class 6-10)", "9")).toBe("CBSE Class 9");
    expect(boardLabel("Cambridge Lower Secondary Science 0893", "7")).toBe("Cambridge Stage 7");
    expect(boardLabel("Ontario Science", "Grade 8")).toBe("Ontario Grade 8");
    expect(boardLabel("IB Middle Years", null)).toBe("IB");
    expect(boardsOf(MAPPINGS)).toEqual([
      ["CBSE Science (Class 6-10)", "9"],
      ["Cambridge Lower Secondary Science 0893", "7"],
    ]);
    expect(audienceTag(boardsOf(MAPPINGS), "Science")).toBe("CBSE Class 9 & Cambridge Stage 7 Science");
    expect(audienceTag([], "Biology")).toBe("Biology");
    expect(audienceTag([], null)).toBe("");
  });

  it("reads the terms off the summary's enumeration, not its clause", () => {
    expect(termsFromSummary(SUMMARY)).toEqual(["cell membrane", "cytoplasm", "nucleus", "mitochondria", "cell wall", "chloroplasts", "vacuole"]);
    expect(termsFromSummary("Every living thing is made of cells.")).toEqual([]);
  });

  it("default hashtags are the terms, the boards, the subject and the channel; tags are CamelCase and distinct", () => {
    expect(defaultHashtags(["plant cell", "animal cell"], boardsOf(MAPPINGS), "Science")).toEqual([
      "PlantCell",
      "AnimalCell",
      "CBSE",
      "Class9Science",
      "Cambridge",
      "Stage7Science",
      "Science",
      "SketchCast",
    ]);
    expect(cleanHashtags(["#plant cell", "Plant-Cell", "cbse", "x".repeat(50), "", 7, "42"])).toEqual(["PlantCell", "Cbse"]);
  });
});

describe("what will be posted", () => {
  const aud = audienceTag(boardsOf(MAPPINGS), "Science");

  it("titles: topic, key terms, audience — terms dropped before the audience, the part label never cut", () => {
    expect(headline("Plant and Animal Cells Compared")).toBe("Plant and Animal Cells Compared");
    expect(headline("Photosynthesis")).toBe("Photosynthesis Explained");
    expect(composeTitle({ topicTitle: "Photosynthesis", keyTerms: ["chlorophyll", "glucose", "stomata"], audience: "CBSE Class 10 Science", part: 1, parts: 1 })).toBe(
      "Photosynthesis Explained | Chlorophyll, Glucose, Stomata | CBSE Class 10 Science",
    );
    const t = composeTitle({ topicTitle: "Plant and Animal Cells Compared", keyTerms: ["prokaryotes", "eukaryotes", "organelles"], audience: aud, part: 1, parts: 1 });
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(t.endsWith(" | " + aud)).toBe(true);
    expect(t).toContain("Prokaryotes, Eukaryotes");
    expect(t).not.toContain("Organelles");
    const long = "The Structure and Function of Eukaryotic and Prokaryotic Cells in Living Organisms Everywhere";
    const p2 = composeTitle({ topicTitle: long, keyTerms: ["a", "b"], audience: "CBSE Class 9 Science", part: 2, parts: 3 });
    expect(p2.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(p2.endsWith(" — Part 2 of 3")).toBe(true);
    // the stored title wins and still takes the part label
    expect(composeTitle({ topicTitle: "Cells", meta: { title: "Cells for Beginners | Nucleus | CBSE Class 9 Science" }, keyTerms: ["x"], audience: "ignored", part: 2, parts: 2 })).toBe(
      "Cells for Beginners | Nucleus | CBSE Class 9 Science — Part 2 of 2",
    );
    // no terms and no audience: the bare topic, as before
    expect(publishTitle("Cells", 1, 1)).toBe("Cells");
    expect(publishTitle("  Cells  ", 2, 3)).toBe("Cells — Part 2 of 3");
    expect(publishTitle("", 1, 1)).toBe("Topic");
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
    expect(chapterLines([mark(90, "B"), mark(0, "A"), mark(45, "  ")])).toEqual([]);
    expect(chapterLines(null)).toEqual([]);
  });

  it("builds the description in the fixed order: hook, Aligned to, Chapters, Key terms, the part, the SketchCast line + link, hashtags", () => {
    const text = buildDescriptionPreview({
      topicTitle: "Plant and Animal Cells Compared",
      summary: SUMMARY,
      subject: "Science",
      curriculumHeader: ["CBSE Science (Class 6-10) · Class 9 · Cell - Basic Unit of life", " "],
      mappings: MAPPINGS,
      chapters: [mark(0, "Intro"), mark(90, "Animal cells"), mark(305, "Plant cells")],
      part: 1,
      parts: 2,
    });
    const blocks = text.split("\n\n");
    expect(blocks[0]).toBe(SUMMARY); // no stored intro: the summary opens
    expect(blocks[1]).toBe("Aligned to\nCBSE Science (Class 6-10) · Class 9 · Cell - Basic Unit of life");
    expect(blocks[2]).toBe("Chapters\n0:00 Intro\n1:30 Animal cells\n5:05 Plant cells");
    expect(blocks[3]).toBe("Key terms: cell membrane, cytoplasm, nucleus, mitochondria, cell wall, chloroplasts, vacuole.");
    expect(blocks[4]).toMatch(/^Part 1 of 2\. Next: Plant and Animal Cells Compared \| .* — Part 2 of 2$/);
    expect(blocks[5]).toBe(`${SKETCHCAST_LINE}\n${SKETCHCAST_LINK}`);
    expect(blocks[6]).toBe("#CellMembrane #Cytoplasm #Nucleus #Mitochondria #CellWall #Chloroplasts #CBSE #Class9Science #Cambridge #Stage7Science #Science #SketchCast");
    expect(SKETCHCAST_LINK).toContain("utm_source=youtube");
  });

  it("the stored words replace the defaults: intro, terms, tags", () => {
    const text = buildDescriptionPreview({
      topicTitle: "Cells",
      summary: SUMMARY,
      subject: "Science",
      curriculumHeader: [],
      mappings: [],
      meta: { intro: "What do a plant cell and an animal cell share?", key_terms: ["nucleus"], hashtags: ["Cells"] },
      chapters: [],
      part: 1,
      parts: 1,
    });
    const blocks = text.split("\n\n");
    expect(blocks[0]).toBe("What do a plant cell and an animal cell share?");
    expect(blocks[1]).toBe("Key terms: nucleus.");
    expect(blocks[3]).toBe("#Cells");
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
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toBe("Cells — a SketchCast lesson.");
    expect(blocks[1]).toContain(SKETCHCAST_LINK);
    expect(blocks[2]).toBe("#Science #SketchCast");
    expect(text).not.toContain("0:00");
    expect(text).not.toContain("Key terms");
    expect(text).not.toContain("Part 2");
  });

  it("points at the next part only from a part that has one", () => {
    const summary = "Every living thing is made of cells.";
    const last = buildDescriptionPreview({ topicTitle: "Cells", summary, curriculumHeader: [], chapters: [], part: 2, parts: 2 });
    expect(last).toContain("Part 2 of 2.");
    expect(last).not.toContain("Next:");
    const first = buildDescriptionPreview({ topicTitle: "Cells", summary, curriculumHeader: [], chapters: [], part: 1, parts: 2 });
    expect(first).toContain("Part 1 of 2. Next: Cells — Part 2 of 2");
  });
});

describe("the editable words (validateYouTubeMeta)", () => {
  it("accepts blanks as 'use the default', lists or comma-separated strings, and cleans terms and tags", () => {
    const r = validateYouTubeMeta({ title: "  T ", intro: " a\n b ", key_terms: "Nucleus, cell wall", hashtags: ["#one two", "one-two"] });
    expect(r).toEqual({ ok: true, meta: { title: "T", intro: "a b", key_terms: ["nucleus", "cell wall"], hashtags: ["OneTwo"] } });
    expect(validateYouTubeMeta({})).toEqual({ ok: true, meta: { title: "", intro: "", key_terms: [], hashtags: [] } });
  });

  it("refuses a title over 100, an intro over 700, and a term or tag that is not one — with a sentence each", () => {
    const r = validateYouTubeMeta({ title: "x".repeat(101), intro: "y".repeat(701), key_terms: ["a sentence that is far too long to be a term"], hashtags: ["42"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(4);
      expect(r.errors[0]).toContain("100");
      expect(r.errors[1]).toContain("700");
      expect(r.errors[2]).toContain("a sentence that is far too long");
      expect(r.errors[3]).toContain("42");
    }
    // a duplicate is folded, not refused
    expect(validateYouTubeMeta({ hashtags: ["Cells", "cells"] })).toEqual({ ok: true, meta: { title: "", intro: "", key_terms: [], hashtags: ["Cells"] } });
  });
});

describe("the dark note and the migration", () => {
  it("names the 0121 migration", () => {
    expect(YOUTUBE_META_MIGRATION).toBe("supabase/migrations/0121_youtube_meta_and_thumbnails.sql");
  });

  it("names the flag and the two things that are missing", () => {
    expect(PUBLISH_OFF_NOTE).toContain("FEATURE_CATALOGUE_PUBLISH");
    expect(PUBLISH_OFF_NOTE).toContain("channel");
    expect(PUBLISH_OFF_NOTE).toContain("compliance audit");
  });
  it("names 0116", () => {
    expect(CATALOGUE_PUBLISH_MIGRATION).toBe("supabase/migrations/0116_catalogue_publish.sql");
  });
});
