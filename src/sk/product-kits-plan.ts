// SketchCast books as Library books — the pure planning behind the
// founder-only scripts/sk-product-kits.ts: the product's chapter → kit MAP.
//
// Founder 2026-10-30: "why do we need to generate the 10 chapter kits. we
// already have those generated as part of the catalogue." NOTHING IS
// GENERATED. Each chapter's kits are the EXISTING catalogue kits of the topics
// the release bundle lists for it (`chapters[].topics = [{slug, title,
// article}]`), resolved slug → topic → its CURRENT kit in the book's language
// (catalogue_current_kits(): approved, the topic not retired, the English
// video public on YouTube) → that kit's presentation, which must be done and
// live (not removed, not withdrawn).
//
// sk_product_kits gets one row per (chapter, kit):
//   chapter_ref = the RELEASE chapter (1-based: /sk/[product]/[chapter], the
//                 Library's "Chapter N", the Board's num + 1)
//   sort        = the topic's position in the chapter (the bundle's order)
//   generation_id = the kit's presentation (what 0170 maps and canOpenKit opens)
//   label       = the topic's title — EXCEPT a one-topic chapter whose kit an
//                 earlier chapter already uses (Biology's "cells" in chapters
//                 1, 3 and 7): that row is labelled with the chapter's OWN
//                 title, and the Library notes "shared with Chapter 1". In a
//                 several-topic chapter (a review) a shared kit keeps its
//                 topic's title, so its kits stay distinguishable.
// A topic listed twice in one chapter maps once. A topic that does not
// resolve is reported (with why) and left out; --apply refuses while any is
// unresolved unless the founder passes --allow-missing.
//
// Pure: rows in, decisions out. The script reads and writes; the tests pin this.

import { bundleVideoId, youtubeIdsByKit, type PublicationRow } from "@/utils/catalogue/kit-youtube";

export type BundleTopic = { slug: string; title: string | null };
export type BundleChapterTopics = { chapter: number; title: string; topics: BundleTopic[]; videos: string[] };

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The bundle's chapters with their topics (in order) and video ids. Tolerant of shape: bad entries are dropped. */
export function bundleChapterTopics(bundle: { chapters?: unknown } | null | undefined): BundleChapterTopics[] {
  const chapters = Array.isArray(bundle?.chapters) ? (bundle!.chapters as Record<string, unknown>[]) : [];
  return chapters
    .filter((c) => c && Number.isInteger(Number(c.chapter)) && Number(c.chapter) >= 1)
    .map((c) => {
      const n = Number(c.chapter);
      const topics = (Array.isArray(c.topics) ? (c.topics as Record<string, unknown>[]) : [])
        .map((t) => ({ slug: str(t?.slug).toLowerCase(), title: str(t?.title) || null }))
        .filter((t) => SLUG.test(t.slug));
      const videos = (Array.isArray(c.videos) ? c.videos : []).map(bundleVideoId).filter((v): v is string => !!v);
      return { chapter: n, title: str(c.title) || `Chapter ${n}`, topics, videos };
    })
    .sort((a, b) => a.chapter - b.chapter);
}

export type TopicRow = { id: string; slug: string | null; title: string | null };
/** A row of catalogue_current_kits(). */
export type CurrentKitRow = { topic_id: string; language: string; topic_kit_id: string };
export type TopicKitRow = { id: string; topic_id: string; presentation_generation_id: string | null };
export type LessonRow = { id: string; kind: string; status: string; removed_at?: string | null; withdrawn_at?: string | null };

export type MapRow = { product_id: string; chapter_ref: string; sort: number; generation_id: string; label: string | null };

export type Unresolved = { chapter: number; slug: string; reason: "unknown_topic" | "no_current_kit" | "no_lesson" | "lesson_not_ready" };
export type PlannedRow = MapRow & { slug: string; topicKitId: string; sharedWith: number | null; youtube: string[] };

export type MapPlan = {
  before: MapRow[];
  after: PlannedRow[];
  unresolved: Unresolved[];
  /** per chapter: the bundle's video ids beside the YouTube ids of the kits it resolved to */
  videos: { chapter: number; bundle: string[]; kits: string[] }[];
};

const byChapterThenSort = (a: MapRow, b: MapRow) => Number(a.chapter_ref) - Number(b.chapter_ref) || a.sort - b.sort;

export function planCatalogueMap(input: {
  productId: string;
  language: string;
  chapters: BundleChapterTopics[];
  topics: TopicRow[];
  current: CurrentKitRow[];
  kits: TopicKitRow[];
  lessons: LessonRow[];
  publications?: PublicationRow[];
  currentMap: MapRow[];
}): MapPlan {
  const lang = (input.language || "en").toLowerCase();
  const topicBySlug = new Map(input.topics.filter((t) => t.slug).map((t) => [String(t.slug).toLowerCase(), t]));
  const currentByTopic = new Map(input.current.filter((c) => (c.language ?? "").toLowerCase() === lang).map((c) => [c.topic_id, c.topic_kit_id]));
  const kitById = new Map(input.kits.map((k) => [k.id, k]));
  const lessonById = new Map(input.lessons.map((g) => [g.id, g]));
  const youtube = youtubeIdsByKit(input.publications ?? []);

  const after: PlannedRow[] = [];
  const unresolved: Unresolved[] = [];
  const videos: MapPlan["videos"] = [];
  const firstChapterOf = new Map<string, number>();

  for (const c of input.chapters) {
    const seen = new Set<string>();
    const oneTopic = new Set(c.topics.map((t) => t.slug)).size === 1;
    const kitsHere: string[] = [];
    c.topics.forEach((t, sort) => {
      const topic = topicBySlug.get(t.slug);
      if (!topic) return void unresolved.push({ chapter: c.chapter, slug: t.slug, reason: "unknown_topic" });
      const kitId = currentByTopic.get(topic.id);
      const kit = kitId ? kitById.get(kitId) : undefined;
      if (!kit) return void unresolved.push({ chapter: c.chapter, slug: t.slug, reason: "no_current_kit" });
      const pres = kit.presentation_generation_id;
      if (!pres) return void unresolved.push({ chapter: c.chapter, slug: t.slug, reason: "no_lesson" });
      const lesson = lessonById.get(pres);
      if (!lesson || lesson.kind !== "presentation" || lesson.status !== "done" || lesson.removed_at || lesson.withdrawn_at)
        return void unresolved.push({ chapter: c.chapter, slug: t.slug, reason: "lesson_not_ready" });
      if (seen.has(pres)) return;
      seen.add(pres);
      const first = firstChapterOf.get(pres);
      const sharedWith = first !== undefined && first !== c.chapter ? first : null;
      if (first === undefined) firstChapterOf.set(pres, c.chapter);
      const ids = youtube.get(kit.id) ?? [];
      kitsHere.push(...ids);
      after.push({
        product_id: input.productId,
        chapter_ref: String(c.chapter),
        sort,
        generation_id: pres,
        label: sharedWith !== null && oneTopic ? c.title : t.title || topic.title || t.slug,
        slug: t.slug,
        topicKitId: kit.id,
        sharedWith,
        youtube: ids,
      });
    });
    videos.push({ chapter: c.chapter, bundle: c.videos, kits: kitsHere });
  }

  const before = input.currentMap.filter((r) => r.product_id === input.productId).slice().sort(byChapterThenSort);
  return { before, after: after.sort(byChapterThenSort), unresolved, videos };
}

/** The bare rows to upsert (sk_product_kits' own columns). */
export const mapRows = (plan: MapPlan): MapRow[] =>
  plan.after.map(({ product_id, chapter_ref, sort, generation_id, label }) => ({ product_id, chapter_ref, sort, generation_id, label }));

/** The map rows to delete once `after` is written: everything of the product that is not in `after`. */
export function staleMapRows(plan: MapPlan): MapRow[] {
  const keep = new Set(plan.after.map((r) => `${r.chapter_ref}|${r.generation_id}`));
  return plan.before.filter((r) => !keep.has(`${r.chapter_ref}|${r.generation_id}`));
}
