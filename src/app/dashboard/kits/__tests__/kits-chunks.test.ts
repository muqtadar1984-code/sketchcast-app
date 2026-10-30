/**
 * /dashboard/kits is fast enough for SK's tour (2026-10-30: "the tour skipped
 * the readymade kits section. probably because it was taking too long to
 * load"). Pinned:
 *   · the chunked rendering rule (visibleKits): filters and the find box run
 *     over EVERY kit, only the first `count` render, a `?topic=` highlight is
 *     never cut off;
 *   · what the cards now derive in the browser instead of shipping it
 *     (downloadsOf, storageVideo) — the same links the server used to build;
 *   · the page's wiring (source pins; vitest collects no .tsx): one wave of
 *     reads, the allowance line (the tour's anchor) outside the Suspense, the
 *     gallery behind a busy <Pending>, and no anchor left in the gallery.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/kits
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  KIT_CHUNK,
  assignablePieces,
  catalogueFileHref,
  downloadsOf,
  kitMatches,
  storageVideo,
  visibleKits,
  type FilterableKit,
  type KitFilters,
} from "../logic";

const kit = (i: number, over: Partial<FilterableKit> = {}): FilterableKit => ({
  slug: `topic-${i}`,
  title: `Topic ${i}`,
  subject: i % 2 ? "Biology" : "Mathematics",
  language: i % 5 === 0 ? "ms" : "en",
  unlocked: i % 7 === 0,
  ...over,
});
const ALL = Array.from({ length: 610 }, (_, i) => kit(i));
const NONE: KitFilters = { query: "", subject: "all", language: "all" };

describe("visibleKits — the gallery renders in chunks", () => {
  it("renders the first chunk of ~610, and says there is more", () => {
    const v = visibleKits(ALL, NONE, null, KIT_CHUNK);
    expect(KIT_CHUNK).toBe(24);
    expect(v.shown).toHaveLength(24);
    expect(v.shown[0]).toBe(ALL[0]); // the same objects: memoised cards keep their props
    expect(v.matched).toBe(610);
    expect(v.more).toBe(true);
  });

  it("each 'more' adds a chunk; the last chunk ends it", () => {
    expect(visibleKits(ALL, NONE, null, 48).shown).toHaveLength(48);
    const end = visibleKits(ALL, NONE, null, 624);
    expect(end.shown).toHaveLength(610);
    expect(end.more).toBe(false);
  });

  it("the find box searches EVERY kit, not just the rendered ones", () => {
    const v = visibleKits(ALL, { ...NONE, query: "  topic 609 " }, null, KIT_CHUNK);
    expect(v.shown.map((k) => k.slug)).toEqual(["topic-609"]);
    expect(v.matched).toBe(1);
    expect(v.more).toBe(false);
    // the subject matches too, any case
    expect(visibleKits(ALL, { ...NONE, query: "BIOLOGY" }, null, 1000).matched).toBe(305);
  });

  it("subject, unlocked and language chips filter over all kits before the cut", () => {
    expect(visibleKits(ALL, { ...NONE, subject: "Mathematics" }, null, 1000).shown.every((k) => k.subject === "Mathematics")).toBe(true);
    const unlocked = visibleKits(ALL, { ...NONE, subject: "unlocked" }, null, KIT_CHUNK);
    expect(unlocked.matched).toBe(ALL.filter((k) => k.unlocked).length);
    expect(unlocked.shown.every((k) => k.unlocked)).toBe(true);
    const ms = visibleKits(ALL, { ...NONE, language: "ms" }, null, KIT_CHUNK);
    expect(ms.matched).toBe(122);
    expect(ms.shown.every((k) => k.language === "ms")).toBe(true);
  });

  it("a ?topic= highlight past the first chunk is still rendered (so it can be scrolled to)", () => {
    const v = visibleKits(ALL, NONE, "topic-500", KIT_CHUNK);
    expect(v.shown).toHaveLength(501);
    expect(v.shown.at(-1)!.slug).toBe("topic-500");
    expect(v.more).toBe(true);
    // inside the first chunk it changes nothing
    expect(visibleKits(ALL, NONE, "topic-3", KIT_CHUNK).shown).toHaveLength(24);
    // filtered out by a chip, it does not force itself back in
    const other = visibleKits(ALL, { ...NONE, subject: "Biology" }, "topic-500", KIT_CHUNK);
    expect(other.shown).toHaveLength(24);
    expect(other.shown.some((k) => k.slug === "topic-500")).toBe(false);
    // an unknown slug is ignored
    expect(visibleKits(ALL, NONE, "nope", KIT_CHUNK).shown).toHaveLength(24);
  });

  it("nothing matching: empty, no more", () => {
    expect(visibleKits(ALL, { ...NONE, query: "zzz" }, null, KIT_CHUNK)).toEqual({ shown: [], matched: 0, more: false });
    expect(visibleKits([], NONE, null, KIT_CHUNK)).toEqual({ shown: [], matched: 0, more: false });
  });

  it("kitMatches is the same rule the gallery used inline", () => {
    const k = kit(1, { title: "Cell Division", subject: null });
    expect(kitMatches(k, { ...NONE, query: "cell" })).toBe(true);
    expect(kitMatches(k, { ...NONE, query: "bio" })).toBe(false);
    expect(kitMatches(k, { ...NONE, subject: "Biology" })).toBe(false);
  });
});

describe("what a card derives in the browser", () => {
  it("download links: the deck its .pptx, a document its .docx, + the answer key for the kinds that carry one, the presentation none", () => {
    expect(downloadsOf("presentation", "g0")).toEqual([]);
    expect(downloadsOf("deck", "g1")).toEqual([{ label: "download", href: "/api/catalogue/file?gen=g1&kind=deck_pptx" }]);
    expect(downloadsOf("lesson_plan", "g2")).toEqual([{ label: "download", href: "/api/catalogue/file?gen=g2&kind=docx" }]);
    for (const kind of ["worksheet", "quiz", "activity", "case_study", "question_bank"])
      expect(downloadsOf(kind, "g3").map((d) => d.label), kind).toEqual(["download", "answerKey"]);
    expect(downloadsOf("worksheet", "g3")[1]!.href).toBe("/api/catalogue/file?gen=g3&kind=answer_key_docx");
  });

  it("hrefs are encoded", () => {
    expect(catalogueFileHref("a b", "docx")).toBe("/api/catalogue/file?gen=a%20b&kind=docx");
  });

  it("a kit with no YouTube video plays from storage; one with a video (or no presentation) does not", () => {
    expect(storageVideo(null, "p1")).toEqual({ videoHref: "/api/catalogue/file?gen=p1&kind=video_mp4", posterHref: "/api/catalogue/file?gen=p1&kind=thumbnail_png" });
    expect(storageVideo("yt1", "p1")).toBeNull();
    expect(storageVideo(null, null)).toBeNull();
  });

  it("assignable pieces are still derived from the pieces (no plan, no question bank)", () => {
    const pieces = ["presentation", "lesson_plan", "worksheet", "question_bank"].map((kind, i) => ({ kind, generationId: `g${i}` }));
    expect(assignablePieces(pieces).map((p) => p.kind)).toEqual(["presentation", "worksheet"]);
  });
});

const read = (f: string) => readFileSync(resolve(__dirname, "..", f), "utf8");
/** Code only: comments may name what the code must not do. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const page = code(read("page.tsx"));
const gallery = code(read("kits-gallery.tsx"));

/** The source of one top-level function in page.tsx, up to the next one. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  expect(at, name).toBeGreaterThan(0);
  const ends = [src.indexOf("\nasync function ", at + 1), src.indexOf("\nfunction ", at + 1)].filter((n) => n > 0);
  return src.slice(at, ends.length ? Math.min(...ends) : undefined);
}

describe("the page streams (source pins)", () => {
  it("one verified user (React-cached), and the profile, allowance and catalogue reads start together", () => {
    expect(page).toMatch(/currentUser\(\)/);
    expect(page).not.toMatch(/auth\.getUser\(\)/);
    const main = fnBody(page, "KitsPage");
    const profile = main.indexOf("const profileP = started(");
    const allowance = main.indexOf('const allowanceP = started(supabase.rpc("my_catalogue_allowance"))');
    const catalogue = main.indexOf("const catalogueP = started(readCatalogue(supabase))");
    const firstAwait = main.indexOf("await profileP");
    for (const at of [profile, allowance, catalogue]) {
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(firstAwait);
    }
    // the assignment targets start before the hat check is awaited
    expect(main.indexOf("const targetsP = started(assignTargets(")).toBeLessThan(main.indexOf("await enforceHat("));
  });

  it("keeps every gate: student redirect, the hat, then the eligibility branches", () => {
    const main = fnBody(page, "KitsPage");
    expect(main).toMatch(/if \(role === "student"\) redirect\("\/dashboard"\);/);
    expect(main).toMatch(/if \(hatAway\) redirect\(hatAway\);/);
    for (const r of ["coming_soon", "forbidden_role", "suspended"]) expect(main).toContain(`reason === "${r}"`);
    expect(main).toMatch(/if \(allowanceError \|\| !allowance\) return shell/);
  });

  it("the allowance line (the tour's anchor) renders with the page, the gallery behind a busy <Pending>", () => {
    const main = fnBody(page, "KitsPage");
    const anchor = main.indexOf('data-tour="kits-allowance"');
    const suspense = main.indexOf("<Suspense fallback={<Pending />}>");
    expect(anchor).toBeGreaterThan(0);
    expect(suspense).toBeGreaterThan(anchor);
    expect(main.slice(suspense)).toMatch(/<KitsSection /);
    const pending = fnBody(page, "Pending");
    expect(pending).toMatch(/aria-busy="true"/);
    expect(pending).toMatch(/data-sk-loading=""/);
    expect(pending).not.toMatch(/data-tour/);
    // the gallery no longer carries the anchor (it would render twice)
    expect(gallery).not.toMatch(/kits-allowance/);
  });

  it("the cards ship no resolved labels or links — the browser derives them", () => {
    const section = fnBody(page, "KitsSection");
    expect(section).not.toMatch(/downloads:|label:|videoHref|posterHref|assignableIds/);
    expect(gallery).toMatch(/downloadsOf\(p\.kind, p\.generationId\)/);
    expect(gallery).toMatch(/storageVideo\(kit\.youtubeId, kit\.videoGenerationId\)/);
  });

  it("the gallery renders visibleKits in chunks: a sentinel IntersectionObserver plus a Show more button", () => {
    expect(gallery).toMatch(/visibleKits\(kits, \{ query, subject, language \}, highlight, count\)/);
    expect(gallery).toMatch(/new IntersectionObserver\(/);
    expect(gallery).toMatch(/ref=\{sentinelRef\}/);
    expect(gallery).toMatch(/fmt\(t\.showMore,/);
    // the highlight is scrolled to
    expect(gallery).toMatch(/document\.getElementById\(`kit-\$\{highlight\}`\)/);
  });
});
