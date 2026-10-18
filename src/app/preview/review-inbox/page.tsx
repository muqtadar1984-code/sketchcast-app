import { notFound } from "next/navigation";
import { ReviewInboxView, type ReviewInboxProps } from "@/app/library/topics/[id]/review-inbox-view";
import type { KitView } from "@/app/library/topics/[id]/kit-panel";
import type { ArticleVersion } from "@/app/library/topics/[id]/article-panel";
import { parseInboxParams } from "@/utils/catalogue/review-queue";
import type { Topic, TopicArticle, TopicKit } from "@/utils/catalogue/types";
import LibraryHeader from "@/app/library/library-header";

// /preview/review-inbox — the Library's review inbox (layout D) on fixtures,
// for looking at the layout without a library login or a database. Dev only:
// production answers 404. ?lang=ar shows the Arabic translation under review;
// ?queue=all&q=… shows the all-topics pane. Nothing here posts anywhere a
// fixture id would be accepted.

export const dynamic = "force-dynamic";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";
const ART = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KIT_EN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const KIT_AR = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const topic: Topic = {
  id: T1,
  canonical_key: "area-of-a-circle",
  title: "Area of a circle",
  subject: "Mathematics",
  summary: "Why the area of a circle is πr², where the formula comes from, and how to use it with and without a calculator.",
  teacher_avatar: null,
  depth_node_id: null,
  prerequisites: [],
  status: "in_review",
  bank_maturity: "good",
  created_by: null,
  created_at: hoursAgo(200),
  updated_at: hoursAgo(3),
};

const article: TopicArticle = {
  id: ART,
  topic_id: T1,
  version: 2,
  language: "en",
  source_article_id: null,
  title: "Area of a circle",
  objectives: [
    { id: "o1", text: "State the formula for the area of a circle." },
    { id: "o2", text: "Find the area from the radius or the diameter." },
  ],
  sections: [
    { id: "s1", heading: "Where πr² comes from", body_md: "Cut a circle into thin sectors and lay them head to tail: the shape is nearly a rectangle of height r and width half the circumference, πr.", figure_keys: [], covers: ["o1"] },
    { id: "s2", heading: "Using the formula", body_md: "A circle of radius 7 cm has area π × 7² = 49π ≈ 153.9 cm².", figure_keys: [], covers: ["o2"] },
  ],
  glossary: [{ term: "radius", definition: "The distance from the centre to the edge." }],
  misconceptions: [{ id: "m1", misconception: "Area = πd²", correction: "Area = πr²; the diameter is twice the radius, so halve it first." }],
  worked_examples: [],
  claims: [],
  depth_node_id: null,
  depth_rationale: null,
  word_count: 640,
  status: "approved",
  author: "model",
  reviewer_id: "p1",
  reviewed_at: hoursAgo(40),
  approved_by: "p1",
  notes: null,
  created_at: hoursAgo(60),
  updated_at: hoursAgo(40),
};
const versions: ArticleVersion[] = [{ article, figures: [], renderJob: null }];

const kitBase: TopicKit = {
  id: KIT_EN,
  topic_id: T1,
  article_id: ART,
  language: "en",
  source_kit_id: null,
  teacher_avatar: "female",
  voice_pair: { teacher: "en-GB-Neural2-A", student: "en-GB-Neural2-B" },
  presentation_generation_id: "g-pres",
  doc_generation_ids: { deck: "g-deck", lesson_plan: "g-plan", activity: "g-act", case_study: "g-case", worksheet: "g-ws", quiz: "g-quiz" },
  chapters: [
    { part: 1, t: 0, label: "Why πr²", section_id: "s1" },
    { part: 1, t: 95, label: "Cutting the circle into sectors", section_id: "s1" },
    { part: 1, t: 210, label: "Using the formula", section_id: "s2" },
    { part: 1, t: 330, label: "Try it", section_id: "s2" },
  ],
  clips: [{ part: 1, start: 95, end: 210, label: "Sectors become a rectangle", purpose: "the derivation" }],
  part_plan: [{ part: 1, sections: ["s1", "s2"], minutes: 7 }],
  youtube_meta: null,
  status: "in_review",
  reject_reason: null,
  approved_by: null,
  reviewer_id: null,
  reviewed_at: null,
  notes: null,
  judge_score: null,
  created_at: hoursAgo(9),
  updated_at: hoursAgo(3),
};

const gen = (id: string, kind: string, title: string, status = "done") => ({
  gen: { id, kind, status, title, params: null, created_at: hoursAgo(8) },
  job: { id: `j-${id}`, status: status === "done" ? "done" : status, progress: status === "done" ? 100 : 40, stage: null, error: null, created_at: hoursAgo(8) },
  artifacts:
    kind === "presentation"
      ? [{ kind: "video_mp4", url: "/preview/review-inbox/sample.mp4", name: null, part: 1 }]
      : [{ kind: "docx", url: "#", name: `${title}.docx`, part: 1 }],
});

const englishKit: KitView = {
  kit: kitBase,
  generations: [
    gen("g-pres", "presentation", "Area of a circle"),
    gen("g-deck", "deck", "Area of a circle — slides"),
    gen("g-plan", "lesson_plan", "Lesson plan"),
    gen("g-act", "activity", "Activities"),
    gen("g-case", "case_study", "Case study"),
    gen("g-ws", "worksheet", "Worksheet"),
    gen("g-quiz", "quiz", "Online quiz"),
  ],
  publications: [],
  otherPublications: [],
  videoFormat: null,
};

const arabicKit: KitView = {
  kit: {
    ...kitBase,
    id: KIT_AR,
    language: "ar",
    source_kit_id: KIT_EN,
    voice_pair: { teacher: "ar-XA-Wavenet-A", student: "ar-XA-Wavenet-B" },
    presentation_generation_id: "g-pres-ar",
    doc_generation_ids: { deck: "g-deck-ar", worksheet: "g-ws-ar" },
    translation_status: "in_review",
    translation: { job_id: "j-translate" },
    precheck: {
      ok: true,
      blocking: [],
      flags: [
        { where: "s2", what: "number formatting differs", detail: "49π ≈ 153.9 rendered as ١٥٣٫٩" },
        { where: "glossary", what: "term kept in English", detail: "radius" },
      ],
      post_render: { ok: true, blocking: [], flags: [{ where: "part 1", what: "narration 8% longer than the English" }] },
    },
    created_at: hoursAgo(5),
    updated_at: hoursAgo(1),
  },
  generations: [gen("g-pres-ar", "presentation", "مساحة الدائرة"), gen("g-deck-ar", "deck", "الشرائح"), gen("g-ws-ar", "worksheet", "ورقة عمل")],
  publications: [],
  otherPublications: [],
  videoFormat: null,
};

const malayKit: KitView = {
  kit: {
    ...kitBase,
    id: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2",
    language: "ms",
    source_kit_id: KIT_EN,
    status: "approved",
    translation_status: "approved",
    approved_by: "p1",
    reviewer_id: "p1",
    reviewed_at: hoursAgo(20),
    presentation_generation_id: "g-pres-ms",
    doc_generation_ids: { deck: "g-deck-ms" },
    precheck: { ok: true, blocking: [], flags: [], post_render: { ok: true, blocking: [], flags: [] } },
    // the worker wrote the listing's words in Malay (worker PR #261 stamps
    // the language), so the review card shows them and offers a re-word
    youtube_meta: {
      title: "Luas Bulatan Dijelaskan | Jejari, Diameter, Pi | Cambridge Tahap 8 Matematik",
      intro: "Mengapa luas bulatan ialah πr², dari mana formula itu datang, dan cara menggunakannya dengan dan tanpa kalkulator.",
      key_terms: ["jejari", "diameter", "pi", "luas"],
      hashtags: ["LuasBulatan", "Jejari", "Matematik", "SketchCast"],
      source: "generated",
      language: "ms",
      generated_at: hoursAgo(19),
    },
    created_at: hoursAgo(30),
    updated_at: hoursAgo(20),
  },
  generations: [gen("g-pres-ms", "presentation", "Luas bulatan"), gen("g-deck-ms", "deck", "Slaid")],
  // posted (one part, the whole plan) — "Re-word on YouTube" is offered
  publications: [
    {
      id: "pub-ms-1",
      topic_kit_id: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2",
      part: 1,
      channel_language: "ms",
      youtube_video_id: "dQw4w9WgXcQ",
      privacy: "public",
      playlist_ids: [],
      captions_uploaded: ["ms"],
      thumbnail_set: true,
      published_at: hoursAgo(18),
      error: null,
      format_version: 2,
      created_at: hoursAgo(18),
      updated_at: hoursAgo(18),
    },
  ],
  otherPublications: [],
  videoFormat: null,
};

// Translations in flight, for the clocks (translation-eta.ts): a Hindi kit
// building its pieces, a Telugu translate job running, a French one queued
// behind it.
const serverNow = () => Date.now();
const minutesAgo = (m: number) => new Date(serverNow() - m * 60_000).toISOString();
const hindiBuilding = (): KitView => ({
  kit: {
    ...kitBase,
    id: "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3",
    language: "hi",
    source_kit_id: KIT_EN,
    status: "generating",
    translation_status: "staged",
    presentation_generation_id: null,
    doc_generation_ids: {},
    precheck: { ok: true, blocking: [], flags: [] },
    created_at: minutesAgo(6),
    updated_at: minutesAgo(6),
  },
  generations: [],
  publications: [],
  otherPublications: [],
  videoFormat: null,
});
const translateJob = (id: string, language: string, status: string, createdMin: number, claimedMin: number | null) => ({
  id,
  status,
  progress: status === "processing" ? 30 : 0,
  stage: null,
  error: null,
  created_at: minutesAgo(createdMin),
  claimed_at: claimedMin == null ? null : minutesAgo(claimedMin),
  params: { language, source_kit_id: KIT_EN, topic_id: T1 },
});

export default async function ReviewInboxPreview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const view = parseInboxParams(await searchParams);
  const props: ReviewInboxProps = {
    topic,
    view,
    queue: {
      rows: [
        { kitId: KIT_AR, topicId: T1, title: "Area of a circle", subject: "Mathematics", topicStatus: "in_review", language: "ar", translation: true, since: hoursAgo(1), flags: 3, blocking: 0 },
        { kitId: KIT_EN, topicId: T1, title: "Area of a circle", subject: "Mathematics", topicStatus: "in_review", language: "en", translation: false, since: hoursAgo(3), flags: 0, blocking: 0 },
        { kitId: "k-angles", topicId: T2, title: "Angles on a straight line and around a point", subject: "Mathematics", topicStatus: "in_review", language: "en", translation: false, since: hoursAgo(26), flags: 0, blocking: 0 },
        { kitId: "k-cells", topicId: T3, title: "Cells and organelles", subject: "Science", topicStatus: "in_review", language: "ms", translation: true, since: hoursAgo(70), flags: 1, blocking: 1 },
      ],
      error: null,
      translationsMissing: false,
    },
    allTopics:
      view.queue === "all"
        ? [
            { id: T1, title: "Area of a circle", subject: "Mathematics", status: "in_review", updated_at: hoursAgo(3) },
            { id: T2, title: "Angles on a straight line and around a point", subject: "Mathematics", status: "in_review", updated_at: hoursAgo(26) },
            { id: T3, title: "Cells and organelles", subject: "Science", status: "video_approved", updated_at: hoursAgo(70) },
            { id: "44444444-4444-4444-8444-444444444444", title: "Photosynthesis", subject: "Science", status: "article_approved", updated_at: hoursAgo(90) },
          ]
        : [],
    subjects: ["Mathematics", "Science"],
    buildInFlight: false,
    openCandidates: 2,
    versions,
    approvedArticle: { id: ART, version: 2 },
    approvedArticleStatus: "approved",
    articleJob: { id: "j-art", status: "done", progress: 100, stage: null, error: null, created_at: hoursAgo(60) },
    articleTablesMissing: false,
    articleError: null,
    articleMigration: null,
    figuresError: null,
    jobsError: null,
    articleStatuses: { [ART]: "approved" },
    articleVersions: { [ART]: 2 },
    kits: [englishKit],
    translationKits: [hindiBuilding(), arabicKit, malayKit],
    translateJobs: [translateJob("j-te", "te", "processing", 4, 3), translateJob("j-fr", "fr", "queued", 2, null)],
    translationClocks: {
      timing: { typicalMin: 15, bySubject: { mathematics: 12 }, samples: 8 },
      lane: { runningSince: minutesAgo(3), queued: [{ id: "j-fr", created_at: minutesAgo(2) }] },
      nowMs: serverNow(),
    },
    kitsError: null,
    gensError: null,
    publicationsError: null,
    kitMigrationNote: null,
    translationsMigration: null,
    curriculumHeader: ["Cambridge Lower Secondary Mathematics · Stage 8 · 8Gg.04"],
    headerMappings: [{ curriculum: { id: "c1", code: "CLSM", name: "Cambridge Lower Secondary Mathematics" }, node: { code: "8Gg.04", title: "Area and circumference of a circle", grade: "8" } }],
    mappings: [
      {
        id: "m1",
        node_id: "n1",
        coverage: "full",
        notes: null,
        node: { id: "n1", code: "8Gg.04", grade: "8", strand: "Geometry and measure", sub_strand: "Geometrical reasoning", title: "Area and circumference of a circle", curriculum_id: "c1" },
        curriculum: { id: "c1", code: "CLSM", name: "Cambridge Lower Secondary Mathematics" },
      },
    ],
    aliases: [{ id: "al1", topic_id: T1, alias: "Circle area", normalized: "circle-area", source: "book" }],
    prerequisites: [{ id: T2, title: "Angles on a straight line and around a point", subject: "Mathematics", status: "in_review", canonical_key: "angles-straight-line" }],
    dependants: [],
    curricula: [{ id: "c1", code: "CLSM", name: "Cambridge Lower Secondary Mathematics", kind: "international", country: null, edition: null, source_url: null }],
    trail: [
      { action: "library_kit_generate", detail: { kit_id: KIT_EN }, created_at: hoursAgo(9), actor_id: "p1" },
      { action: "library_article_approve", detail: { version: 2 }, created_at: hoursAgo(40), actor_id: "p1" },
    ],
    names: { p1: "Muqtadar Quraishi" },
    canCurate: true,
    canApprove: true,
    canEditArticle: true,
    canGenerate: true,
    canPublish: true,
    auditPassed: false,
    generateEnabled: true,
    publishEnabled: true,
    ownerConfigured: true,
  };
  return (
    <div className="min-h-screen bg-[#FBFCFA] text-[#14181F]">
      <LibraryHeader email="preview@sketchcast.app" role="admin" />
      <ReviewInboxView {...props} />
    </div>
  );
}
