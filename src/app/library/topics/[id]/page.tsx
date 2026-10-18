import { notFound } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { ARTICLE_JOBS_MIGRATION, catalogueColumnMissing, catalogueMissing } from "@/utils/catalogue/status";
import { CATALOGUE_KITS_MIGRATION, curriculumHeaderLines, kitGenerationIds, sortKits, sortVideoArtifacts, videoPartOf, type HeaderMapping } from "@/utils/catalogue/kit";
import { catalogueGenerateEnabled, cataloguePublishEnabled, catalogueOwnerId, youtubeAuditPassed } from "@/utils/flags";
import { docDownloadName } from "@/utils/download-name";
import type { ArticleFigure, Curriculum, KitGenerationRow, Topic, TopicAlias, TopicArticle, TopicHit, TopicKit, TopicPublication } from "@/utils/catalogue/types";
import { ErrorBanner, MissingTablesBanner } from "../../catalogue-ui";
import type { MappingRow } from "./topic-panels";
import type { ArticleVersion, JobRow } from "./article-panel";
import { YOUTUBE_META_MIGRATION } from "@/utils/catalogue/publish";
import type { KitArtifactView, KitView } from "./kit-panel";
import type { TranslateJobRow } from "./translations-panel";
import { ReviewInboxView, type AllTopicRow, type AuditRow } from "./review-inbox-view";
import { PUBLICATION_COLUMNS_0122, loadVideoFormat } from "@/utils/catalogue/format-server";
import { loadReviewQueue } from "@/utils/catalogue/review-queue-server";
import { loadTranslationTiming } from "@/utils/catalogue/translation-timing-server";
import { KIT_TRANSLATOR_MIGRATION, parseInboxParams } from "@/utils/catalogue/review-queue";
import { searchOr } from "@/utils/catalogue/status";

// /library/topics/[id] — the REVIEW INBOX (layout D, the founder's choice of
// 2026-10-16: "looks very clumsy … feels more like a newspaper"). Two panes:
//
//   LEFT  the review queue — every kit awaiting a reviewer (English kits in
//         in_review, translation kits whose translation_status is in_review),
//         newest first, with the language, the time in review and the flag
//         count; or, with ?queue=all, every topic with a search, so the page
//         still reaches a topic that is not under review.
//   RIGHT the selected topic — the kit under review's video at the top, ONE
//         status line (kit status, bank maturity, pre-check A/C verdict and
//         flag count), the Approve / Reject box, then everything else folded:
//         the article in a drawer (versions, editor, figures, review, diff —
//         Phase 2b), the pieces (the kit panel — generate, retry, regenerate,
//         documents, part plan, clips, question bank, quiz, publish — Phase 3
//         and 4), the pre-check findings, the translations (one row per
//         language with the same controls), the history (jobs and the audit
//         trail) and the topic's own details (header, actions, mappings,
//         aliases, prerequisites).
//
// The selection travels in the URL: the path is the topic (so every existing
// link still opens its page), ?lang= names a translation kit to review in
// place of the English one, ?queue=all&q= switches the left pane. The
// explanatory paragraphs the panels used to carry live in "How this works"
// and in hover help (title attributes). The question bank has its own page
// (/questions). Every write still goes through the three routes
// (/api/library/topics/[id], /article, /kit); this page only reads.

export const dynamic = "force-dynamic";

/** Figure previews: the worker's visual_assets live in the PRIVATE bucket;
 *  the page signs each asset's path once, for an hour (visual-library.ts). */
const FIGURE_SIGN_TTL_SECONDS = 3600;
const ARTICLE_LANGUAGE = "en";

const ARTICLE_COLUMNS =
  "id, topic_id, version, language, source_article_id, title, objectives, sections, glossary, misconceptions, worked_examples, claims, depth_node_id, depth_rationale, word_count, status, author, reviewer_id, reviewed_at, approved_by, notes, created_at, updated_at";
const FIGURE_COLUMNS = "id, article_id, figure_key, caption, spec, visual_asset_id, labels, sort, status, created_at";
const JOB_COLUMNS = "id, status, progress, stage, error, created_at, params";

/** Kit artifacts live in the PRIVATE `artifacts` bucket, signed for an hour
 *  like the figure previews. */
const KIT_SIGN_TTL_SECONDS = 3600;
const KIT_LANGUAGE = "en";
/** Without part_plan (0115): read separately so a database where 0115 is not
 *  applied still shows the kit. */
const KIT_COLUMNS =
  "id, topic_id, article_id, language, source_kit_id, teacher_avatar, voice_pair, presentation_generation_id, doc_generation_ids, chapters, clips, status, reject_reason, approved_by, reviewer_id, reviewed_at, notes, judge_score, created_at, updated_at";

/** 0112 topic_publications — what the Phase 4 worker put on YouTube per part. */
const PUBLICATION_COLUMNS =
  "id, topic_kit_id, part, channel_language, youtube_video_id, privacy, playlist_ids, captions_uploaded, thumbnail_set, published_at, error, created_at, updated_at" +
  PUBLICATION_COLUMNS_0122;

const TOPIC_COLUMNS =
  "id, canonical_key, title, subject, summary, teacher_avatar, depth_node_id, prerequisites, status, bank_maturity, created_by, created_at, updated_at";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RawMapping = {
  id: string;
  node_id: string;
  coverage: "full" | "partial";
  notes: string | null;
  curriculum_nodes:
    | {
        id: string;
        code: string;
        grade: string | null;
        strand: string | null;
        sub_strand: string | null;
        title: string;
        curriculum_id: string;
        curricula: { id: string; code: string; name: string } | { id: string; code: string; name: string }[] | null;
      }
    | null;
};

export default async function TopicDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const member = await requireLibraryMember();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const view = parseInboxParams(await searchParams);
  const canCurate = libraryAllows(member.role, "curate");
  const canApprove = libraryAllows(member.role, "approve");
  const admin = createAdminClient();

  const { data: topicRow, error: tErr } = await admin.from("topics").select(TOPIC_COLUMNS).eq("id", id).maybeSingle();
  if (catalogueMissing(tErr)) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <MissingTablesBanner table="topics" />
      </main>
    );
  }
  if (tErr) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <ErrorBanner message={`Could not read the topic: ${tErr.message}`} />
      </main>
    );
  }
  if (!topicRow) notFound();
  const topic = topicRow as unknown as Topic;
  const prereqIds = Array.isArray(topic.prerequisites) ? topic.prerequisites : [];

  const [aliasQ, mapQ, currQ, prereqQ, depQ, candQ, auditQ, artQ, artJobQ] = await Promise.all([
    admin.from("topic_aliases").select("id, topic_id, alias, normalized, source").eq("topic_id", id).order("alias"),
    admin
      .from("topic_curriculum_map")
      .select("id, node_id, coverage, notes, curriculum_nodes(id, code, grade, strand, sub_strand, title, curriculum_id, curricula(id, code, name))")
      .eq("topic_id", id),
    admin.from("curricula").select("id, code, name, kind, country, edition, source_url").order("name"),
    prereqIds.length
      ? admin.from("topics").select("id, title, subject, status, canonical_key").in("id", prereqIds)
      : Promise.resolve({ data: [] as TopicHit[] }),
    admin.from("topics").select("id, title, subject, status, canonical_key").contains("prerequisites", [id]).limit(50),
    admin.from("topic_candidates").select("id", { count: "exact", head: true }).eq("suggested_topic_id", id).eq("status", "open"),
    admin.from("platform_audit_log").select("action, detail, created_at, actor_id").eq("target_id", id).order("created_at", { ascending: false }).limit(15),
    admin.from("topic_articles").select(ARTICLE_COLUMNS).eq("topic_id", id).eq("language", ARTICLE_LANGUAGE).order("version", { ascending: false }),
    admin
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("type", "topic_article")
      .eq("params->>topic_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const aliases = (aliasQ.data ?? []) as TopicAlias[];
  const mappings: MappingRow[] = ((mapQ.data ?? []) as unknown as RawMapping[])
    .map((m) => {
      const n = m.curriculum_nodes;
      const c = n?.curricula ? (Array.isArray(n.curricula) ? n.curricula[0] ?? null : n.curricula) : null;
      return {
        id: m.id,
        node_id: m.node_id,
        coverage: m.coverage,
        notes: m.notes,
        node: n
          ? { id: n.id, code: n.code, grade: n.grade, strand: n.strand, sub_strand: n.sub_strand, title: n.title, curriculum_id: n.curriculum_id }
          : null,
        curriculum: c,
      };
    })
    .sort((a, b) => (a.node?.code ?? "").localeCompare(b.node?.code ?? "", undefined, { numeric: true }));
  const curricula = (currQ.data ?? []) as Curriculum[];
  const byId = new Map(((prereqQ.data ?? []) as TopicHit[]).map((t) => [t.id, t]));
  const prerequisites = prereqIds.map((p) => byId.get(p)).filter((t): t is TopicHit => !!t);
  const dependants = (depQ.data ?? []) as TopicHit[];
  const openCandidates = candQ.count ?? 0;
  const trail = (auditQ.data ?? []) as AuditRow[];

  // ── The article: every version (en), its figures with signed previews, the
  // latest render job per version, and the latest article job for the topic.
  const articles = (artQ.data ?? []) as unknown as TopicArticle[];
  const articleIds = articles.map((a) => a.id);
  let articleMigration: string | null = null;
  const [figQ, renderQ] = articleIds.length
    ? await Promise.all([
        admin
          .from("article_figures")
          .select(FIGURE_COLUMNS + ", render_error")
          .in("article_id", articleIds)
          .order("sort", { ascending: true })
          .order("figure_key", { ascending: true }),
        admin.from("jobs").select(JOB_COLUMNS).eq("type", "figure_render").in("params->>article_id", articleIds).order("created_at", { ascending: false }).limit(200),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ];
  let figureRows = (figQ.data ?? []) as unknown as ArticleFigure[];
  if (figQ.error && catalogueColumnMissing(figQ.error) && /render_error/i.test(figQ.error.message ?? "")) {
    // 0114 not applied: the figures still show, without their render errors.
    articleMigration = ARTICLE_JOBS_MIGRATION;
    const again = await admin.from("article_figures").select(FIGURE_COLUMNS).in("article_id", articleIds).order("sort", { ascending: true });
    figureRows = ((again.data ?? []) as unknown as Omit<ArticleFigure, "render_error">[]).map((f) => ({ ...f, render_error: null }));
  }
  const figuresError = figQ.error && !articleMigration ? figQ.error : null;
  // jobs.params is a 0113 column; the catalogue layer is live, so an error
  // here is shown, not swallowed.
  const jobsError = artJobQ.error ?? renderQ.error ?? null;

  // Sign the assets behind rendered figures in ONE call (visual-library.ts).
  const assetIds = [...new Set(figureRows.map((f) => f.visual_asset_id).filter((v): v is string => !!v))];
  const assetUrl = new Map<string, string>();
  if (assetIds.length) {
    const { data: assets } = await admin.from("visual_assets").select("id, storage_path").in("id", assetIds);
    const rows = (assets ?? []) as { id: string; storage_path: string | null }[];
    const paths = rows.map((r) => r.storage_path).filter((p): p is string => !!p);
    if (paths.length) {
      const { data: urls } = await admin.storage.from("visual-assets").createSignedUrls(paths, FIGURE_SIGN_TTL_SECONDS);
      const byPath = new Map<string, string>();
      for (const u of urls ?? []) if (u?.path && u.signedUrl && !u.error) byPath.set(u.path, u.signedUrl);
      for (const r of rows) {
        const url = r.storage_path ? byPath.get(r.storage_path) : undefined;
        if (url) assetUrl.set(r.id, url);
      }
    }
  }
  const latestRender = new Map<string, JobRow>();
  for (const j of (renderQ.data ?? []) as unknown as (JobRow & { params: { article_id?: string } | null })[]) {
    const aid = j.params?.article_id;
    if (aid && !latestRender.has(aid)) latestRender.set(aid, j); // newest first
  }
  const versions: ArticleVersion[] = articles.map((a) => ({
    article: a,
    figures: figureRows
      .filter((f) => f.article_id === a.id)
      .map((f) => ({ ...f, url: f.visual_asset_id ? (assetUrl.get(f.visual_asset_id) ?? null) : null })),
    renderJob: latestRender.get(a.id) ?? null,
  }));
  const articleJob = (artJobQ.data ?? null) as JobRow | null;

  // ── The kit (Phase 3): every kit of the topic (newest first), the
  // generations they reference with the latest BUILDER job per generation
  // (an observer job — support_diagnose — may also point at a generation; it
  // is not the build) and their artifacts signed for an hour: videos ordered
  // by part with a bare URL (a download disposition would break in-tab
  // playback), documents with docDownloadName's filename baked in.
  let kitsMigration: string | null = null;
  let kitsError: { message?: string } | null = null;
  let kitRows: TopicKit[] = [];
  {
    const { data, error } = await admin.from("topic_kits").select(KIT_COLUMNS + ", part_plan, youtube_meta").eq("topic_id", id).eq("language", KIT_LANGUAGE).order("created_at", { ascending: false });
    if (error && catalogueColumnMissing(error) && /part_plan|youtube_meta/i.test(error.message ?? "")) {
      // 0115 / 0121 not applied: the kits still show, with an empty plan and
      // no YouTube words.
      kitsMigration = /youtube_meta/i.test(error.message ?? "") ? YOUTUBE_META_MIGRATION : CATALOGUE_KITS_MIGRATION;
      const again = await admin.from("topic_kits").select(KIT_COLUMNS).eq("topic_id", id).eq("language", KIT_LANGUAGE).order("created_at", { ascending: false });
      if (again.error && !catalogueMissing(again.error)) kitsError = again.error;
      kitRows = ((again.data ?? []) as unknown as Omit<TopicKit, "part_plan" | "youtube_meta">[]).map((k) => ({ ...k, part_plan: [], youtube_meta: null }));
    } else if (error && !catalogueMissing(error)) {
      kitsError = error;
    } else {
      kitRows = (data ?? []) as unknown as TopicKit[];
    }
  }
  const normaliseKit = (k: TopicKit): TopicKit => ({
    ...k,
    doc_generation_ids: k.doc_generation_ids ?? {},
    youtube_meta: k.youtube_meta && typeof k.youtube_meta === "object" ? k.youtube_meta : null,
    chapters: Array.isArray(k.chapters) ? k.chapters : [],
    clips: Array.isArray(k.clips) ? k.clips : [],
    part_plan: Array.isArray(k.part_plan) ? k.part_plan : [],
  });
  kitRows = sortKits(kitRows).map(normaliseKit);
  // The Kit Translator's kits (0134): every kit of this topic in a language
  // other than English, with the three translation columns. Read separately
  // so a database without 0134 still shows the English kit; the panel then
  // says which migration is missing.
  let translationRows: TopicKit[] = [];
  let translationsMigration: string | null = null;
  {
    const { data, error } = await admin
      .from("topic_kits")
      .select(KIT_COLUMNS + ", part_plan, youtube_meta, translation_status, translation, precheck")
      .eq("topic_id", id)
      .neq("language", KIT_LANGUAGE)
      .order("created_at", { ascending: false });
    if (error && catalogueColumnMissing(error)) translationsMigration = KIT_TRANSLATOR_MIGRATION;
    else if (error && !catalogueMissing(error)) kitsError = kitsError ?? error;
    else translationRows = sortKits((data ?? []) as unknown as TopicKit[]).map(normaliseKit);
  }
  const kitGenIds = [...new Set([...kitRows, ...translationRows].flatMap((k) => kitGenerationIds(k)))];
  type GenEmbed = KitGenerationRow & {
    artifacts: { kind: string; storage_path: string }[] | null;
    jobs: (JobRow & { type: string })[] | null;
  };
  let gensError: { message?: string } | null = null;
  const gensById = new Map<string, GenEmbed>();
  if (kitGenIds.length) {
    const { data, error } = await admin
      .from("generations")
      .select("id, kind, status, title, params, created_at, artifacts(kind, storage_path), jobs(id, type, status, progress, stage, error, created_at)")
      .in("id", kitGenIds);
    if (error) gensError = error;
    for (const g of (data ?? []) as unknown as GenEmbed[]) gensById.set(g.id, g);
  }
  // What reached YouTube (Phase 4, 0112 topic_publications): one row per (kit,
  // part, channel). Empty everywhere until the publish phase is switched on;
  // read for every kit of the topic — the English ones, because a regenerated
  // kit's history includes what its predecessor published, and the
  // translations (app PR #88), whose video may sit on the English channel
  // until the language has one: a kit has one language, so the kit id alone
  // names its publications (never the channel_language).
  let publicationsError: { message?: string } | null = null;
  const publicationsByKit = new Map<string, TopicPublication[]>();
  const allKitRows = [...kitRows, ...translationRows];
  if (allKitRows.length) {
    const { data, error } = await admin
      .from("topic_publications")
      .select(PUBLICATION_COLUMNS)
      .in(
        "topic_kit_id",
        allKitRows.map((k) => k.id),
      )
      .order("part", { ascending: true });
    if (error && !catalogueMissing(error)) publicationsError = error;
    for (const p of (data ?? []) as unknown as TopicPublication[]) {
      const list = publicationsByKit.get(p.topic_kit_id) ?? [];
      list.push(p);
      publicationsByKit.set(p.topic_kit_id, list);
    }
  }

  const signKit = async (path: string, download?: string): Promise<string | null> => {
    const { data } = await admin.storage.from("artifacts").createSignedUrl(path, KIT_SIGN_TTL_SECONDS, download ? { download } : undefined);
    return data?.signedUrl ?? null;
  };
  // The format the worker renders now (0122 platform_settings): the publish
  // block says which posted videos predate it, and which older video a
  // re-rendered kit may supersede.
  const videoFormat = await loadVideoFormat(admin);
  const allPublications = [...publicationsByKit.values()].flat();
  // The older videos a kit's may supersede are the topic's OTHER kits' in the
  // SAME language — an Arabic video on the English channel is not an older
  // English part.
  const languageOfKit = new Map(allKitRows.map((k) => [k.id, k.language]));
  const viewOf = async (kit: TopicKit): Promise<KitView> => ({
      kit,
      publications: publicationsByKit.get(kit.id) ?? [],
      otherPublications: allPublications.filter((p) => p.topic_kit_id !== kit.id && languageOfKit.get(p.topic_kit_id) === kit.language),
      videoFormat,
      generations: await Promise.all(
        kitGenerationIds(kit)
          .map((gid) => gensById.get(gid))
          .filter((g): g is GenEmbed => !!g)
          .map(async (g) => {
            const jobs = [...(g.jobs ?? [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            const job = jobs.find((j) => j.type === g.kind) ?? jobs[0] ?? null;
            const videos = sortVideoArtifacts((g.artifacts ?? []).filter((a) => a.kind === "video_mp4"));
            // the card the worker drew for each part (0121), shown in the publish block
            const thumbs = (g.artifacts ?? []).filter((a) => a.kind === "thumbnail_png");
            const docs = (g.artifacts ?? []).filter((a) => a.kind !== "video_mp4" && a.kind !== "script_json" && a.kind !== "thumbnail_png");
            const artifacts: KitArtifactView[] = await Promise.all([
              ...videos.map(async (a) => ({ kind: a.kind, url: await signKit(a.storage_path), name: null, part: videoPartOf(a.storage_path) })),
              ...thumbs.map(async (a) => ({ kind: a.kind, url: await signKit(a.storage_path), name: null, part: videoPartOf(a.storage_path) })),
              ...docs.map(async (a) => {
                const name = docDownloadName(g.kind, a.kind) ?? null;
                return { kind: a.kind, url: await signKit(a.storage_path, name ?? undefined), name: name ?? a.kind, part: 1 };
              }),
            ]);
            const gen: KitGenerationRow = { id: g.id, kind: g.kind, status: g.status, title: g.title, params: g.params, created_at: g.created_at };
            return { gen, job: job ? { id: job.id, status: job.status, progress: job.progress, stage: job.stage, error: job.error, created_at: job.created_at } : null, artifacts };
          }),
      ),
  });
  const kits: KitView[] = await Promise.all(kitRows.map(viewOf));
  const translationKits: KitView[] = await Promise.all(translationRows.map(viewOf));
  // The translate jobs of this topic's kits (0134): a queued or failed job
  // has no kit row yet, so the panel reads the jobs themselves.
  let translateJobs: TranslateJobRow[] = [];
  if (kitRows.length) {
    const { data } = await admin
      .from("jobs")
      .select("id, status, progress, stage, error, created_at, claimed_at, params")
      .eq("type", "kit_translate")
      .in("params->>source_kit_id", kitRows.map((k) => k.id))
      .order("created_at", { ascending: false })
      .limit(50);
    translateJobs = ((data ?? []) as unknown as TranslateJobRow[]).map((j) => ({ ...j, params: j.params ?? {} }));
  }
  // The clocks on a translation in flight (translation-eta.ts): read only
  // when this topic has a translation building or a translate job live.
  const translationLive = translationRows.some((k) => k.status === "generating") || translateJobs.some((j) => j.status === "queued" || j.status === "processing");
  const translationClocks = translationLive ? await loadTranslationTiming(admin) : null;
  const approvedArticle = articles.find((a) => a.status === "approved") ?? null;
  // Every version's status by id: the kit panel refuses Approve on a kit whose
  // own article is no longer the approved version (kitAcceptsApprove).
  const articleStatuses: Record<string, string> = Object.fromEntries(articles.map((a) => [a.id, a.status]));
  // …and every version's number: Regenerate on such a kit builds from the
  // approved version, and the panel names both (kitRegenerateSource).
  const articleVersions: Record<string, number> = Object.fromEntries(articles.map((a) => [a.id, a.version]));
  const kitMigrationNote = kitsMigration
    ? `A kit column (topic_kits.part_plan / youtube_meta) is not in this database yet — apply ${kitsMigration}; kits show without it until then.`
    : null;

  // Reviewer / approver names for the version list and the kit history
  // (profiles carries no e-mail).
  const personIds = [...new Set([...articles.flatMap((a) => [a.reviewer_id, a.approved_by]), ...kitRows.flatMap((k) => [k.reviewer_id, k.approved_by])].filter((v): v is string => !!v))];
  const names: Record<string, string> = {};
  if (personIds.length) {
    const { data: people } = await admin.from("profiles").select("id, full_name").in("id", personIds);
    for (const p of (people ?? []) as { id: string; full_name: string | null }[]) if (p.full_name) names[p.id] = p.full_name;
  }
  const canEditArticle = libraryAllows(member.role, "edit_article");
  const canGenerate = libraryAllows(member.role, "generate");
  // Publishing to YouTube stays with platform admins (plan §7.1).
  const canPublish = libraryAllows(member.role, "publish");
  // The header block every catalogue document carries, composed from the same
  // mappings this page shows — the YouTube description repeats it verbatim, so
  // the reviewer reads the codes that will be posted.
  // Re-fetch while anything is still building, so a reviewer watching a kit
  // does not have to press refresh to see it move. The page is
  // force-dynamic, so router.refresh() re-runs this component and every
  // status, progress bar and freshly signed download link updates in place.
  //
  // Read from the JOBS, not only from the statuses: `topics.status` and
  // `topic_kits.status` say "generating" for the whole build, but a kit whose
  // worker died leaves them saying that forever, and a page that polls
  // forever on a dead kit is worse than one that never polls. A job in
  // queued/processing is the claim that something is actually moving, and the
  // stale reaper clears it.
  const kitJobsInFlight = [...gensById.values()].some((g) =>
    (g.jobs ?? []).some((j) => j.status === "queued" || j.status === "processing"),
  );
  const articleJobsInFlight =
    (articleJob != null && (articleJob.status === "queued" || articleJob.status === "processing")) ||
    [...latestRender.values()].some((j) => j.status === "queued" || j.status === "processing");
  // a translate job runs before its kit's pieces exist — poll through it too
  const translateJobsInFlight = translateJobs.some((j) => j.status === "queued" || j.status === "processing");
  const buildInFlight = kitJobsInFlight || articleJobsInFlight || translateJobsInFlight;

  const headerMappings: HeaderMapping[] = mappings.map(
    (m): HeaderMapping => ({
      curriculum: m.curriculum,
      node: m.node ? { code: m.node.code, title: m.node.title, grade: m.node.grade } : null,
    }),
  );
  const curriculumHeader = curriculumHeaderLines(headerMappings);

  // ── The review inbox's two panes (layout D). The queue is every kit awaiting
  // a reviewer across the catalogue; "all topics" is the newest sixty (or a
  // search) so the page reaches any topic. The kit under review on the right
  // is the English kit, or — with ?lang= — that translation kit.
  const queue = await loadReviewQueue(admin);
  let allTopics: AllTopicRow[] = [];
  if (view.queue === "all") {
    let q = admin.from("topics").select("id, title, subject, status, updated_at").order("updated_at", { ascending: false }).limit(60);
    const search = searchOr(view.q, ["title", "canonical_key", "summary"]);
    if (search) q = q.or(search);
    if (view.subject) q = q.eq("subject", view.subject);
    if (view.status) q = q.eq("status", view.status);
    allTopics = ((await q).data ?? []) as typeof allTopics;
  }
  // The subjects for the left pane's filter (the topics list's facet, one
  // cheap column read).
  const { data: subjRows } = await admin.from("topics").select("subject").not("subject", "is", null).limit(2000);
  const subjects = [...new Set(((subjRows ?? []) as { subject: string | null }[]).map((r) => (r.subject ?? "").trim()).filter(Boolean))].sort();
  return (
    <ReviewInboxView
      topic={topic}
      view={view}
      queue={queue}
      allTopics={allTopics}
      subjects={subjects}
      buildInFlight={buildInFlight}
      openCandidates={openCandidates}
      versions={versions}
      approvedArticle={approvedArticle ? { id: approvedArticle.id, version: approvedArticle.version } : null}
      approvedArticleStatus={approvedArticle?.status ?? null}
      articleJob={articleJob}
      articleTablesMissing={catalogueMissing(artQ.error)}
      articleError={artQ.error && !catalogueMissing(artQ.error) ? artQ.error.message : null}
      articleMigration={articleMigration}
      figuresError={figuresError?.message ?? null}
      jobsError={jobsError?.message ?? null}
      articleStatuses={articleStatuses}
      articleVersions={articleVersions}
      kits={kits}
      translationKits={translationKits}
      translateJobs={translateJobs}
      translationClocks={translationClocks}
      kitsError={kitsError ? (kitsError.message ?? "unknown error") : null}
      gensError={gensError ? (gensError.message ?? "unknown error") : null}
      publicationsError={publicationsError ? (publicationsError.message ?? "unknown error") : null}
      kitMigrationNote={kitMigrationNote}
      translationsMigration={translationsMigration}
      curriculumHeader={curriculumHeader}
      headerMappings={headerMappings}
      mappings={mappings}
      aliases={aliases}
      prerequisites={prerequisites}
      dependants={dependants}
      curricula={curricula}
      trail={trail}
      names={names}
      canCurate={canCurate}
      canApprove={canApprove}
      canEditArticle={canEditArticle}
      canGenerate={canGenerate}
      canPublish={canPublish}
      auditPassed={youtubeAuditPassed()}
      generateEnabled={catalogueGenerateEnabled()}
      publishEnabled={cataloguePublishEnabled()}
      ownerConfigured={catalogueOwnerId() !== null}
    />
  );
}
