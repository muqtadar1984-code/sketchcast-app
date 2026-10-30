// SketchCast books as Library books — the planning behind
// scripts/sk-product-kits.ts: the chapter → kit MAP built from the release
// bundle's topics and the catalogue kits that already exist (founder
// 2026-10-30: nothing is generated). Biology's real topic layout: chapters 3
// and 7 reuse the "cells" kit, chapters 6, 8 and 10 carry several kits.
// Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/product-kits-plan.test.ts
import { describe, expect, it } from "vitest";
import { bundleChapterTopics, mapRows, planCatalogueMap, staleMapRows, type MapRow } from "../product-kits-plan";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const id = (n: number, p = "a") => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;

// slug → [topic id, kit id, presentation id]
const SLUGS = [
  "cells",
  "using-a-microscope-and-calculating-magnification",
  "plant-and-animal-cells-compared",
  "specialised-cells-and-tissues",
  "states-of-matter-and-particle-model",
  "diffusion-in-living-cells",
  "blood-and-its-components",
  "the-human-respiratory-system",
  "transport-in-plants",
  "inheritance-and-variation",
];
const ref = (slug: string) => {
  const i = SLUGS.indexOf(slug);
  return { topic: id(i, "a"), kit: id(i, "b"), pres: id(i, "c") };
};
const T = (slug: string) => ({ slug, title: slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()) });

function bundle() {
  return {
    chapters: [
      { chapter: 1, title: "Cells", topics: [T("cells")], videos: ["video:AAAAAAAAAA1"] },
      { chapter: 2, title: "Using a Microscope", topics: [T("using-a-microscope-and-calculating-magnification")], videos: [] },
      { chapter: 3, title: "Cell Membranes", topics: [T("cells")], videos: ["video:AAAAAAAAAA1"] },
      { chapter: 4, title: "Plant and Animal Cells", topics: [T("plant-and-animal-cells-compared")], videos: [] },
      { chapter: 5, title: "Specialised Cells", topics: [T("specialised-cells-and-tissues")], videos: [] },
      { chapter: 6, title: "Diffusion", topics: [T("states-of-matter-and-particle-model"), T("diffusion-in-living-cells")], videos: [] },
      { chapter: 7, title: "Cell Division", topics: [T("cells")], videos: [] },
      { chapter: 8, title: "Transport", topics: [T("blood-and-its-components"), T("the-human-respiratory-system"), T("transport-in-plants")], videos: [] },
      { chapter: 9, title: "Inheritance", topics: [T("inheritance-and-variation")], videos: [] },
      // a review chapter over earlier topics, one of them listed twice and one unknown
      { chapter: 10, title: "Review", topics: [T("cells"), T("diffusion-in-living-cells"), T("cells"), T("no-such-topic")], videos: [] },
    ],
  };
}

function world(over: { missingKit?: string; lessonNotDone?: string } = {}) {
  const topics = SLUGS.map((s) => ({ id: ref(s).topic, slug: s, title: `DB ${s}` }));
  const current = SLUGS.filter((s) => s !== over.missingKit).map((s) => ({ topic_id: ref(s).topic, language: "en", topic_kit_id: ref(s).kit }));
  // a Malay kit of the same topic must not be picked for an English book
  current.push({ topic_id: ref("cells").topic, language: "ms", topic_kit_id: id(99, "b") });
  const kits = SLUGS.map((s) => ({ id: ref(s).kit, topic_id: ref(s).topic, presentation_generation_id: ref(s).pres }));
  const lessons = SLUGS.map((s) => ({ id: ref(s).pres, kind: "presentation", status: s === over.lessonNotDone ? "processing" : "done", removed_at: null, withdrawn_at: null }));
  const publications = [
    { topic_kit_id: ref("cells").kit, part: 1, youtube_video_id: "AAAAAAAAAA1", privacy: "public", superseded_by: null, channel_language: "en" },
    { topic_kit_id: ref("transport-in-plants").kit, part: 1, youtube_video_id: "BBBBBBBBBB1", privacy: "private", superseded_by: null, channel_language: "en" },
  ];
  return { topics, current, kits, lessons, publications };
}

const OLD: MapRow[] = [
  { product_id: PRODUCT, chapter_ref: "1", sort: 0, generation_id: ref("cells").pres, label: "Cells" },
  { product_id: PRODUCT, chapter_ref: "3", sort: 0, generation_id: id(50, "d"), label: "an old master" },
  { product_id: "22222222-2222-4222-8222-222222222222", chapter_ref: "1", sort: 0, generation_id: id(51, "d"), label: "another product" },
];

describe("bundleChapterTopics", () => {
  it("reads chapters in order with their topic slugs, titles and video ids; drops malformed entries", () => {
    const out = bundleChapterTopics({
      chapters: [
        { chapter: 2, title: "Two", topics: [{ slug: "Diffusion-In-Living-Cells", title: "Diffusion" }, { slug: "bad slug!" }, null], videos: ["video:AAAAAAAAAA1", "video:short", 7] },
        { chapter: 1, title: "", topics: "nope" },
        { chapter: 0, title: "Front matter" },
      ],
    });
    expect(out).toEqual([
      { chapter: 1, title: "Chapter 1", topics: [], videos: [] },
      { chapter: 2, title: "Two", topics: [{ slug: "diffusion-in-living-cells", title: "Diffusion" }], videos: ["AAAAAAAAAA1"] },
    ]);
    expect(bundleChapterTopics(null)).toEqual([]);
  });
});

describe("planCatalogueMap — Biology", () => {
  const plan = () => planCatalogueMap({ productId: PRODUCT, language: "en", chapters: bundleChapterTopics(bundle()), ...world(), currentMap: OLD });

  it("maps every chapter to its topics' CURRENT catalogue kits (the presentation), in the chapter's order, 1-based release chapters", () => {
    const m = plan();
    const at = (ch: number) => m.after.filter((r) => r.chapter_ref === String(ch)).map((r) => [r.sort, r.generation_id]);
    expect(at(1)).toEqual([[0, ref("cells").pres]]);
    expect(at(6)).toEqual([
      [0, ref("states-of-matter-and-particle-model").pres],
      [1, ref("diffusion-in-living-cells").pres],
    ]);
    expect(at(8).map(([, g]) => g)).toEqual([ref("blood-and-its-components").pres, ref("the-human-respiratory-system").pres, ref("transport-in-plants").pres]);
    expect(new Set(m.after.map((r) => r.product_id))).toEqual(new Set([PRODUCT]));
    // never the Malay kit of "cells"
    expect(m.after.some((r) => r.topicKitId === id(99, "b"))).toBe(false);
  });

  it("labels: the topic's title; a one-topic chapter whose kit an earlier chapter uses gets the chapter's OWN title and sharedWith", () => {
    const m = plan();
    const row = (ch: number, slug: string) => m.after.find((r) => r.chapter_ref === String(ch) && r.slug === slug)!;
    expect(row(1, "cells")).toMatchObject({ label: "Cells", sharedWith: null });
    expect(row(3, "cells")).toMatchObject({ label: "Cell Membranes", sharedWith: 1, generation_id: ref("cells").pres });
    expect(row(7, "cells")).toMatchObject({ label: "Cell Division", sharedWith: 1 });
    expect(row(6, "diffusion-in-living-cells")).toMatchObject({ label: "Diffusion in living cells", sharedWith: null });
    // a several-topic (review) chapter keeps the topic titles, so its kits stay distinguishable
    expect(row(10, "diffusion-in-living-cells")).toMatchObject({ label: "Diffusion in living cells", sharedWith: 6 });
    expect(row(10, "cells")).toMatchObject({ label: "Cells", sharedWith: 1 });
  });

  it("a topic listed twice in a chapter maps once; an unknown slug is reported, not mapped", () => {
    const m = plan();
    expect(m.after.filter((r) => r.chapter_ref === "10").map((r) => r.slug)).toEqual(["cells", "diffusion-in-living-cells"]);
    expect(m.unresolved).toEqual([{ chapter: 10, slug: "no-such-topic", reason: "unknown_topic" }]);
  });

  it("carries each kit's WATCHABLE YouTube ids and sets them beside the bundle's videos", () => {
    const m = plan();
    expect(m.after.find((r) => r.chapter_ref === "1")!.youtube).toEqual(["AAAAAAAAAA1"]);
    // a private publication does not embed: no id
    expect(m.after.find((r) => r.slug === "transport-in-plants")!.youtube).toEqual([]);
    expect(m.videos.find((v) => v.chapter === 1)).toEqual({ chapter: 1, bundle: ["AAAAAAAAAA1"], kits: ["AAAAAAAAAA1"] });
  });

  it("a topic with no current kit, or whose lesson is not done, is unresolved with the reason", () => {
    const m = planCatalogueMap({
      productId: PRODUCT,
      language: "en",
      chapters: bundleChapterTopics(bundle()),
      ...world({ missingKit: "inheritance-and-variation", lessonNotDone: "specialised-cells-and-tissues" }),
      currentMap: [],
    });
    expect(m.unresolved).toEqual(
      expect.arrayContaining([
        { chapter: 9, slug: "inheritance-and-variation", reason: "no_current_kit" },
        { chapter: 5, slug: "specialised-cells-and-tissues", reason: "lesson_not_ready" },
      ]),
    );
    expect(m.after.some((r) => r.chapter_ref === "9" || r.chapter_ref === "5")).toBe(false);
  });

  it("before = only this product's rows; stale = before minus after; mapRows = the table's own columns", () => {
    const m = plan();
    expect(m.before.map((r) => r.generation_id)).toEqual([ref("cells").pres, id(50, "d")]);
    expect(staleMapRows(m)).toEqual([OLD[1]]);
    expect(Object.keys(mapRows(m)[0]).sort()).toEqual(["chapter_ref", "generation_id", "label", "product_id", "sort"]);
  });
});
