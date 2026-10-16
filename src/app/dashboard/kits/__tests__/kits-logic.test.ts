/**
 * /dashboard/kits — the shaping behind the Ready-made kits page (Phase C).
 * Pinned: the public/private join (slug + language), piece order and the
 * assignable subset, the allowance button rule, the upgrade rule by tier, and
 * the `?topic=` slug filter.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/kits
 */
import { describe, expect, it } from "vitest";
import {
  assignablePieces,
  buildKits,
  canUnlockMore,
  lessonPageUrl,
  piecesOf,
  showsUpgrade,
  topicParam,
  youtubeUrl,
  type Allowance,
  type PublicRow,
} from "../logic";

const pub = (over: Partial<PublicRow>): PublicRow => ({
  slug: "types-of-angles",
  title: "Types of Angles",
  subject: "Mathematics",
  summary: "Acute, right, obtuse…",
  language: "en",
  approved_at: "2026-10-15T06:00:00Z",
  videos: [
    { part: 2, youtube_video_id: "PART2" },
    { part: 1, youtube_video_id: "PART1" },
  ],
  question_count: 42,
  has_online_assessment: true,
  ...over,
});

const kitRow = {
  id: "kit-1",
  presentation_generation_id: "g-lesson",
  doc_generation_ids: { worksheet: "g-ws", case_study: "g-cs", lesson_plan: "g-plan", deck: "g-deck", activity: "", exam_paper: null },
};

describe("buildKits", () => {
  it("joins public rows with the private ids on (slug, language), newest first, and marks unlocks", () => {
    const kits = buildKits(
      [pub({}), pub({ slug: "pythagoras", title: "Pythagoras", approved_at: "2026-10-16T06:00:00Z" })],
      [
        { topic_id: "t-angles", language: "en", topic_kit_id: "kit-1" },
        { topic_id: "t-pyth", language: "en", topic_kit_id: "kit-2" },
      ],
      [
        { id: "t-angles", slug: "types-of-angles" },
        { id: "t-pyth", slug: "pythagoras" },
      ],
      [kitRow, { id: "kit-2", presentation_generation_id: "g2", doc_generation_ids: { worksheet: "g2-ws" } }],
      [{ topic_id: "t-angles", unlocked_at: "2026-10-16T07:00:00Z" }],
    );
    expect(kits.map((k) => k.slug)).toEqual(["pythagoras", "types-of-angles"]);
    const angles = kits[1];
    expect(angles).toMatchObject({ topicId: "t-angles", kitId: "kit-1", unlocked: true, questionCount: 42, youtubeId: "PART1" });
    expect(kits[0].unlocked).toBe(false);
  });

  it("drops a public row with no current kit, and a current kit whose topic has no slug", () => {
    const kits = buildKits(
      [pub({}), pub({ slug: "orphan" })],
      [
        { topic_id: "t-angles", language: "en", topic_kit_id: "kit-1" },
        { topic_id: "t-noslug", language: "en", topic_kit_id: "kit-3" },
      ],
      [
        { id: "t-angles", slug: "types-of-angles" },
        { id: "t-noslug", slug: null },
      ],
      [kitRow, { id: "kit-3", presentation_generation_id: "g3", doc_generation_ids: {} }],
      [],
    );
    expect(kits.map((k) => k.slug)).toEqual(["types-of-angles"]);
  });

  it("keeps languages apart: an Arabic kit of the same topic is its own card", () => {
    const kits = buildKits(
      [pub({}), pub({ language: "ar", title: "أنواع الزوايا" })],
      [
        { topic_id: "t-angles", language: "en", topic_kit_id: "kit-1" },
        { topic_id: "t-angles", language: "ar", topic_kit_id: "kit-ar" },
      ],
      [{ id: "t-angles", slug: "types-of-angles" }],
      [kitRow, { id: "kit-ar", presentation_generation_id: "g-ar", doc_generation_ids: {} }],
      [],
    );
    expect(kits.map((k) => [k.language, k.kitId])).toEqual([
      ["en", "kit-1"],
      ["ar", "kit-ar"],
    ]);
  });
});

describe("pieces", () => {
  it("orders the lesson first, then deck, plan, activity, worksheet, case study — and drops blanks", () => {
    expect(piecesOf(kitRow).map((p) => p.kind)).toEqual(["presentation", "deck", "lesson_plan", "worksheet", "case_study"]);
  });
  it("assignable pieces exclude the teacher's plan and the printable question bank", () => {
    expect(assignablePieces(piecesOf(kitRow)).map((p) => p.kind)).toEqual(["presentation", "deck", "worksheet", "case_study"]);
    const withBank = piecesOf({ ...kitRow, doc_generation_ids: { ...kitRow.doc_generation_ids, question_bank: "g-qb" } });
    expect(withBank.map((p) => p.kind).at(-1)).toBe("question_bank");
    expect(assignablePieces(withBank).map((p) => p.kind)).not.toContain("question_bank");
  });
  it("the online quiz (Phase D) sorts after the worksheet and IS assignable", () => {
    const withQuiz = piecesOf({ ...kitRow, doc_generation_ids: { ...kitRow.doc_generation_ids, quiz: "g-quiz", question_bank: "g-qb" } });
    expect(withQuiz.map((p) => p.kind)).toEqual(["presentation", "deck", "lesson_plan", "worksheet", "quiz", "case_study", "question_bank"]);
    expect(assignablePieces(withQuiz).map((p) => p.generationId)).toContain("g-quiz");
  });
  it("an unknown future kind sorts last rather than vanishing", () => {
    const p = piecesOf({ id: "k", presentation_generation_id: null, doc_generation_ids: { glossary: "g-x", worksheet: "g-ws" } });
    expect(p.map((x) => x.kind)).toEqual(["worksheet", "glossary"]);
  });
});

describe("allowance", () => {
  const a = (over: Partial<Allowance>): Allowance => ({ eligible: true, reason: null, tier: "pro", cap: 5, used: 0, resets_at: "2026-10-19T00:00:00Z", ...over });
  it("a capped tier may unlock while it has allowance; unlimited always; ineligible never", () => {
    expect(canUnlockMore(a({ used: 4 }))).toBe(true);
    expect(canUnlockMore(a({ used: 5 }))).toBe(false);
    expect(canUnlockMore(a({ tier: "school", cap: null, used: 99 }))).toBe(true);
    expect(canUnlockMore(a({ eligible: false, reason: "coming_soon" }))).toBe(false);
  });
  it("shows the pricing link to personal capped tiers only — never to a school account or an unlimited one", () => {
    expect(showsUpgrade(a({ tier: "trial", cap: 1 }))).toBe(true);
    expect(showsUpgrade(a({ tier: "pro_plus", cap: 10 }))).toBe(true);
    expect(showsUpgrade(a({ tier: "school_expired", cap: 1 }))).toBe(false);
    expect(showsUpgrade(a({ tier: "school", cap: null }))).toBe(false);
  });
});

describe("links and params", () => {
  it("accepts a slug and nothing else", () => {
    expect(topicParam("types-of-angles")).toBe("types-of-angles");
    expect(topicParam(["pythagoras", "x"])).toBe("pythagoras");
    expect(topicParam("Types Of Angles")).toBeNull();
    expect(topicParam("../etc")).toBeNull();
    expect(topicParam(undefined)).toBeNull();
    expect(topicParam("a".repeat(81))).toBeNull();
  });
  it("public URLs are encoded", () => {
    expect(lessonPageUrl("types-of-angles")).toBe("https://sketchcast.app/topics/types-of-angles");
    expect(youtubeUrl("a b")).toBe("https://www.youtube.com/watch?v=a%20b");
  });
});
