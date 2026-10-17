/**
 * The Kit Translator's sweep (plan §5.8, D7): which current English kits are
 * ready to be translated into a language, why the others are held back, and
 * the order a short sweep takes them in (subjects alternate, oldest first).
 * Pure: the route reads the rows, this module decides.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-translate-sweep.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  JUDGE_REVIEW_THRESHOLD,
  SWEEP_DEFAULT_LIMIT,
  SWEEP_MAX_LIMIT,
  judgeScoreOf,
  orderForSweep,
  readyForTranslation,
  translationIsLive,
  type SweepCandidate,
  type SweepInput,
  type SweepKit,
  type SweepPublication,
} from "@/utils/catalogue/translate-sweep";

const topic = (id: string, title: string, subject: string | null, over: Partial<SweepInput["topics"][number]> = {}) => ({ id, title, subject, status: "published", bank_maturity: "good", ...over });
const kit = (id: string, topic_id: string, over: Partial<SweepKit> = {}): SweepKit => ({
  id,
  topic_id,
  language: "en",
  status: "approved",
  source_kit_id: null,
  translation_status: null,
  supersede_reason: null,
  judge_score: null,
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});
const pub = (topic_kit_id: string, over: Partial<SweepPublication> = {}): SweepPublication => ({ topic_kit_id, part: 1, privacy: "public", youtube_video_id: `v-${topic_kit_id}`, superseded_by: null, ...over });

/** SweepInput with mutable rows, so a case can push or replace. */
type Fixture = { -readonly [P in keyof SweepInput]: SweepInput[P] extends readonly (infer U)[] ? U[] : SweepInput[P] };

/** Three current kits — two maths (circle older than angles), one science. */
function fixture(): Fixture {
  return {
    current: [
      { topic_id: "t-angles", language: "en", topic_kit_id: "k-angles" },
      { topic_id: "t-circle", language: "en", topic_kit_id: "k-circle" },
      { topic_id: "t-cells", language: "en", topic_kit_id: "k-cells" },
      // a current TRANSLATION row is not a source
      { topic_id: "t-cells", language: "ms", topic_kit_id: "k-cells-ms" },
    ],
    topics: [topic("t-angles", "Angles", "Mathematics"), topic("t-circle", "Area of a circle", "Mathematics"), topic("t-cells", "Cells", "Science")],
    kits: [kit("k-angles", "t-angles", { created_at: "2026-10-05T00:00:00Z" }), kit("k-circle", "t-circle", { created_at: "2026-10-02T00:00:00Z" }), kit("k-cells", "t-cells", { created_at: "2026-10-03T00:00:00Z" })],
    publications: [pub("k-angles"), pub("k-circle"), pub("k-cells")],
    jobs: [],
  };
}

const ids = (rows: readonly SweepCandidate[]) => rows.map((r) => r.kitId);

describe("readyForTranslation", () => {
  it("lists every current English kit as ready when nothing holds it back, alternating subjects and oldest first", () => {
    const r = readyForTranslation(fixture(), "ar");
    expect(r.notReady).toEqual([]);
    // maths first (circle is the older maths kit), then science, then the other maths kit
    expect(ids(r.ready)).toEqual(["k-circle", "k-cells", "k-angles"]);
    expect(r.ready[0]).toMatchObject({ topicId: "t-circle", title: "Area of a circle", subject: "Mathematics", bankMaturity: "good", createdAt: "2026-10-02T00:00:00Z" });
  });

  it("ignores catalogue_current_kits rows of other languages and a duplicate kit id", () => {
    const f = fixture();
    f.current.push({ topic_id: "t-circle", language: "en", topic_kit_id: "k-circle" });
    const r = readyForTranslation(f, "ar");
    expect(ids(r.ready)).toEqual(["k-circle", "k-cells", "k-angles"]);
  });

  it("holds a kit whose topic row is missing, retired, or has no approved bank", () => {
    const f = fixture();
    f.topics = [topic("t-angles", "Angles", "Mathematics", { status: "retired" }), topic("t-circle", "Area of a circle", "Mathematics", { bank_maturity: "none" })];
    const r = readyForTranslation(f, "ar");
    expect(ids(r.ready)).toEqual([]);
    expect(r.notReady.map((n) => [n.kitId, n.code])).toEqual([
      ["k-angles", "topic_retired"],
      ["k-circle", "bank_none"],
      ["k-cells", "topic_missing"],
    ]);
    expect(r.notReady[1].reason).toMatch(/no approved items/);
    // the maturity gate also holds a null maturity (the RPC's <> 'none' is null there too)
    f.topics[1].bank_maturity = null;
    expect(readyForTranslation(f, "ar").notReady[1].code).toBe("bank_none");
  });

  it("holds a kit that is not approved, or that was superseded", () => {
    const f = fixture();
    f.kits = [kit("k-angles", "t-angles", { status: "in_review" }), kit("k-circle", "t-circle", { supersede_reason: "correction" }), kit("k-cells", "t-cells")];
    const r = readyForTranslation(f, "ar");
    expect(ids(r.ready)).toEqual(["k-cells"]);
    expect(r.notReady.map((n) => [n.kitId, n.code])).toEqual([
      ["k-angles", "kit_not_approved"],
      ["k-circle", "kit_superseded"],
    ]);
    expect(r.notReady[0].reason).toBe("The English kit is in review, not approved.");
    expect(r.notReady[1].reason).toMatch(/superseded \(correction\)/);
    // a current row whose kit row did not come back
    f.kits = [];
    expect(readyForTranslation(f, "ar").notReady.every((n) => n.code === "kit_missing")).toBe(true);
  });

  it("needs the PART-1 video public on YouTube and not superseded", () => {
    const f = fixture();
    f.publications = [
      pub("k-angles", { part: 2 }), // part 2 only
      pub("k-circle", { privacy: "unlisted" }),
      pub("k-cells", { superseded_by: "newer" }),
    ];
    const r = readyForTranslation(f, "ar");
    expect(ids(r.ready)).toEqual([]);
    expect(Object.fromEntries(r.notReady.map((n) => [n.kitId, n.code]))).toEqual({ "k-angles": "video_missing", "k-circle": "video_not_public", "k-cells": "video_superseded" });
    expect(r.notReady.find((n) => n.kitId === "k-circle")!.reason).toBe("The part-1 video is unlisted, not public.");
    // a publication without a video id is not a video
    f.publications = [pub("k-angles", { youtube_video_id: null })];
    expect(readyForTranslation(f, "ar").notReady.find((n) => n.kitId === "k-angles")!.code).toBe("video_missing");
    // a superseded part-1 row beside a live public one: the live one counts
    f.publications = [pub("k-angles", { superseded_by: "old" }), pub("k-angles", { youtube_video_id: "v2" })];
    expect(ids(readyForTranslation(f, "ar").ready)).toContain("k-angles");
  });

  it("treats a null judge score as passing and a score below the threshold as not ready", () => {
    const f = fixture();
    f.kits = [kit("k-angles", "t-angles", { judge_score: { score: JUDGE_REVIEW_THRESHOLD - 1 } }), kit("k-circle", "t-circle", { judge_score: { score: JUDGE_REVIEW_THRESHOLD } }), kit("k-cells", "t-cells", { judge_score: { notes: "unscored" } })];
    const r = readyForTranslation(f, "ar");
    expect(ids(r.ready).sort()).toEqual(["k-cells", "k-circle"]);
    expect(r.notReady[0]).toMatchObject({ kitId: "k-angles", code: "judge_below_threshold" });
    expect(r.notReady[0].reason).toMatch(new RegExp(`scored the English kit ${JUDGE_REVIEW_THRESHOLD - 1}, below the review threshold of ${JUDGE_REVIEW_THRESHOLD}`));
    expect(judgeScoreOf(null)).toBeNull();
    expect(judgeScoreOf(6.5)).toBe(6.5);
    expect(judgeScoreOf({ overall: 8 })).toBe(8);
    expect(judgeScoreOf({ total: 3, score: 9 })).toBe(9);
    expect(judgeScoreOf({ score: "9" })).toBeNull();
    expect(judgeScoreOf(Number.NaN)).toBeNull();
  });

  it("holds a topic whose translation in that language is live, and lets a stale / blocked / failed one through", () => {
    const f = fixture();
    const ar = (id: string, topic_id: string, over: Partial<SweepKit>) => kit(id, topic_id, { language: "ar", source_kit_id: `k-${topic_id.slice(2)}`, ...over });
    f.kits.push(
      ar("ar-angles", "t-angles", { status: "generating", translation_status: "staged" }),
      ar("ar-circle", "t-circle", { status: "in_review", translation_status: "in_review" }),
      ar("ar-cells-old", "t-cells", { status: "approved", translation_status: "stale" }),
      ar("ar-cells-blocked", "t-cells", { status: "approved", translation_status: "blocked" }),
      ar("ar-cells-failed", "t-cells", { status: "failed", translation_status: "failed" }),
      ar("ar-cells-rejected", "t-cells", { status: "rejected", translation_status: "in_review" }),
      // a translation of the SAME topic into another language never counts
      kit("ms-cells", "t-cells", { language: "ms", status: "approved", translation_status: "approved" }),
    );
    const r = readyForTranslation(f, "ar");
    expect(ids(r.ready)).toEqual(["k-cells"]);
    expect(r.notReady.map((n) => [n.kitId, n.code, n.reason])).toEqual([
      ["k-angles", "translation_live", "A translation is already being built."],
      ["k-circle", "translation_live", "A translation is already in review."],
    ]);
  });

  it("an approved translation of an OLDER English kit still blocks, and says so", () => {
    const f = fixture();
    f.kits.push(kit("ar-cells", "t-cells", { language: "ar", source_kit_id: "k-cells-v1", status: "approved", translation_status: "approved" }));
    const r = readyForTranslation(f, "ar");
    expect(r.notReady[0]).toMatchObject({ kitId: "k-cells", code: "translation_live" });
    expect(r.notReady[0].reason).toBe("A translation is already approved (of an older English kit — supersede it to mark the translation stale).");
  });

  it("reads a translation's liveness by translation_status, and by kit status before 0134", () => {
    expect(translationIsLive({ status: "generating", translation_status: null })).toBe(true);
    expect(translationIsLive({ status: "in_review", translation_status: undefined })).toBe(true);
    expect(translationIsLive({ status: "approved", translation_status: null })).toBe(true);
    expect(translationIsLive({ status: "approved", translation_status: "stale" })).toBe(false);
    expect(translationIsLive({ status: "approved", translation_status: "blocked" })).toBe(false);
    expect(translationIsLive({ status: "failed", translation_status: "failed" })).toBe(false);
    // a rejected kit is history whatever its translation column still says
    expect(translationIsLive({ status: "rejected", translation_status: "in_review" })).toBe(false);
    expect(translationIsLive({ status: "failed", translation_status: "approved" })).toBe(false);
  });

  it("reports a kit whose translate job is queued or running as `queued`, keyed on (source kit, language)", () => {
    const f = fixture();
    f.jobs = [
      { status: "queued", params: { source_kit_id: "k-circle", language: "ar" } },
      { status: "processing", params: { source_kit_id: "k-cells", language: "ms" } }, // another language
      { status: "done", params: { source_kit_id: "k-angles", language: "ar" } }, // finished
      { status: "queued", params: null },
    ];
    const r = readyForTranslation(f, "ar");
    expect(ids(r.ready)).toEqual(["k-angles", "k-cells"]);
    expect(r.notReady).toEqual([expect.objectContaining({ kitId: "k-circle", code: "queued", reason: "A translate job is already queued or running." })]);
  });

  it("sorts the not-ready list by subject then title", () => {
    const f = fixture();
    f.topics.push(topic("t-zebra", "Zebras", null, { bank_maturity: "none" }), topic("t-hist", "Rome", "History", { bank_maturity: "none" }));
    f.current.push({ topic_id: "t-zebra", language: "en", topic_kit_id: "k-zebra" }, { topic_id: "t-hist", language: "en", topic_kit_id: "k-hist" });
    f.kits = [];
    const r = readyForTranslation(f, "ar");
    expect(r.notReady.map((n) => n.title)).toEqual(["Angles", "Area of a circle", "Cells", "Rome", "Zebras"]);
  });
});

describe("orderForSweep", () => {
  const c = (kitId: string, subject: string | null, createdAt: string): SweepCandidate => ({ kitId, topicId: `t-${kitId}`, title: kitId, subject, bankMaturity: "good", createdAt });

  it("alternates Mathematics, Science, then the rest, oldest kit of each first", () => {
    const out = orderForSweep([c("m2", "Mathematics", "2026-10-02"), c("s1", "Science", "2026-10-01"), c("h1", "History", "2026-09-01"), c("m1", "Mathematics", "2026-10-01"), c("s2", "Science", "2026-10-03"), c("m3", "Mathematics", "2026-10-03")]);
    expect(out.map((o) => o.kitId)).toEqual(["m1", "s1", "h1", "m2", "s2", "m3"]);
  });

  it("keeps going when one subject runs out, and puts a missing subject last", () => {
    const out = orderForSweep([c("x", null, "2026-01-01"), c("s1", "Science", "2026-10-01"), c("s2", "Science", "2026-10-02"), c("s3", "Science", "2026-10-03")]);
    expect(out.map((o) => o.kitId)).toEqual(["s1", "x", "s2", "s3"]);
    expect(orderForSweep([])).toEqual([]);
  });

  it("exposes the sweep's limits", () => {
    expect(SWEEP_DEFAULT_LIMIT).toBe(5);
    expect(SWEEP_MAX_LIMIT).toBeGreaterThanOrEqual(48);
  });
});
