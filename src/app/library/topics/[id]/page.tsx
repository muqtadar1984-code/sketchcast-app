import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { ARTICLE_JOBS_MIGRATION, catalogueColumnMissing, catalogueMissing } from "@/utils/catalogue/status";
import { CATALOGUE_KITS_MIGRATION, kitGenerationIds, sortKits, sortVideoArtifacts, videoPartOf } from "@/utils/catalogue/kit";
import { catalogueGenerateEnabled, catalogueOwnerId } from "@/utils/flags";
import { docDownloadName } from "@/utils/download-name";
import type { ArticleFigure, Curriculum, KitGenerationRow, Topic, TopicAlias, TopicArticle, TopicHit, TopicKit } from "@/utils/catalogue/types";
import { ErrorBanner, MaturityChip, MissingTablesBanner, StatusChip, fmtDate } from "../../catalogue-ui";
import { AliasPanel, MappingPanel, PrereqPanel, TopicActions, TopicHeaderEditor, type MappingRow } from "./topic-panels";
import { ArticlePanel, type ArticleVersion, type JobRow } from "./article-panel";
import { KitPanel, type KitArtifactView, type KitView } from "./kit-panel";

// /library/topics/[id] — one topic: header (editable), status actions, aliases,
// curriculum mappings with the depth-node selector, prerequisites, the
// knowledge article (versions, editor, figures, review, diff — Phase 2b), the
// kit (generate, pieces with their worker jobs, video parts, documents, part
// plan, chapters, clips, review, retry, regenerate, history — Phase 3) and the
// audit trail. The question bank has its own page (/questions); the publish
// panel arrives with its phase.

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

export default async function TopicDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requireLibraryMember();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
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
  const trail = (auditQ.data ?? []) as { action: string; detail: Record<string, unknown> | null; created_at: string; actor_id: string | null }[];

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
    const { data, error } = await admin.from("topic_kits").select(KIT_COLUMNS + ", part_plan").eq("topic_id", id).eq("language", KIT_LANGUAGE).order("created_at", { ascending: false });
    if (error && catalogueColumnMissing(error) && /part_plan/i.test(error.message ?? "")) {
      // 0115 not applied: the kits still show, with an empty plan.
      kitsMigration = CATALOGUE_KITS_MIGRATION;
      const again = await admin.from("topic_kits").select(KIT_COLUMNS).eq("topic_id", id).eq("language", KIT_LANGUAGE).order("created_at", { ascending: false });
      if (again.error && !catalogueMissing(again.error)) kitsError = again.error;
      kitRows = ((again.data ?? []) as unknown as Omit<TopicKit, "part_plan">[]).map((k) => ({ ...k, part_plan: [] }));
    } else if (error && !catalogueMissing(error)) {
      kitsError = error;
    } else {
      kitRows = (data ?? []) as unknown as TopicKit[];
    }
  }
  kitRows = sortKits(kitRows).map((k) => ({
    ...k,
    doc_generation_ids: k.doc_generation_ids ?? {},
    chapters: Array.isArray(k.chapters) ? k.chapters : [],
    clips: Array.isArray(k.clips) ? k.clips : [],
    part_plan: Array.isArray(k.part_plan) ? k.part_plan : [],
  }));
  const kitGenIds = [...new Set(kitRows.flatMap((k) => kitGenerationIds(k)))];
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
  const signKit = async (path: string, download?: string): Promise<string | null> => {
    const { data } = await admin.storage.from("artifacts").createSignedUrl(path, KIT_SIGN_TTL_SECONDS, download ? { download } : undefined);
    return data?.signedUrl ?? null;
  };
  const kits: KitView[] = await Promise.all(
    kitRows.map(async (kit) => ({
      kit,
      generations: await Promise.all(
        kitGenerationIds(kit)
          .map((gid) => gensById.get(gid))
          .filter((g): g is GenEmbed => !!g)
          .map(async (g) => {
            const jobs = [...(g.jobs ?? [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            const job = jobs.find((j) => j.type === g.kind) ?? jobs[0] ?? null;
            const videos = sortVideoArtifacts((g.artifacts ?? []).filter((a) => a.kind === "video_mp4"));
            const docs = (g.artifacts ?? []).filter((a) => a.kind !== "video_mp4" && a.kind !== "script_json");
            const artifacts: KitArtifactView[] = await Promise.all([
              ...videos.map(async (a) => ({ kind: a.kind, url: await signKit(a.storage_path), name: null, part: videoPartOf(a.storage_path) })),
              ...docs.map(async (a) => {
                const name = docDownloadName(g.kind, a.kind) ?? null;
                return { kind: a.kind, url: await signKit(a.storage_path, name ?? undefined), name: name ?? a.kind, part: 1 };
              }),
            ]);
            const gen: KitGenerationRow = { id: g.id, kind: g.kind, status: g.status, title: g.title, params: g.params, created_at: g.created_at };
            return { gen, job: job ? { id: job.id, status: job.status, progress: job.progress, stage: job.stage, error: job.error, created_at: job.created_at } : null, artifacts };
          }),
      ),
    })),
  );
  const approvedArticle = articles.find((a) => a.status === "approved") ?? null;
  // Every version's status by id: the kit panel refuses Approve on a kit whose
  // own article is no longer the approved version (kitAcceptsApprove).
  const articleStatuses: Record<string, string> = Object.fromEntries(articles.map((a) => [a.id, a.status]));
  const kitMigrationNote = kitsMigration
    ? `The part plan column (topic_kits.part_plan) is not in this database yet — apply ${kitsMigration}; kits show without their plan until then.`
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

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <p className="mb-4 text-sm">
        <Link href="/library/topics" className="text-[#5B6470] hover:underline">
          ← Topics
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-3 mb-1">
        <h1 className="text-3xl font-display">{topic.title}</h1>
        <StatusChip status={topic.status} />
        <MaturityChip maturity={topic.bank_maturity} />
      </div>
      <InkUnderline className="block h-3 w-40 mb-3" color="#7FD8A8" />
      <p className="text-sm text-[#5B6470] mb-6">
        Created {fmtDate(topic.created_at)} · updated {fmtDate(topic.updated_at)} ·{" "}
        <Link href={`/library/topics/${topic.id}/questions`} className="hover:underline text-[#1F5B99]">
          Question bank →
        </Link>
        {openCandidates > 0 && (
          <>
            {" "}
            ·{" "}
            <Link href="/library/candidates" className="hover:underline">
              {openCandidates} open candidate{openCandidates === 1 ? "" : "s"} suggest this topic
            </Link>
          </>
        )}
      </p>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-5">
          <TopicHeaderEditor topic={topic} canCurate={canCurate} />
          {catalogueMissing(artQ.error) ? (
            <MissingTablesBanner table="topic_articles" />
          ) : artQ.error ? (
            <ErrorBanner message={`Could not read the article: ${artQ.error.message}`} />
          ) : (
            <>
              {articleMigration && <MissingTablesBanner table="article_figures.render_error" migration={articleMigration} />}
              {figuresError && <ErrorBanner message={`Could not read the figures: ${figuresError.message}`} />}
              {jobsError && <ErrorBanner message={`Could not read the article jobs: ${jobsError.message}`} />}
              <ArticlePanel
                topicId={topic.id}
                topicStatus={topic.status}
                versions={versions}
                articleJob={articleJob}
                names={names}
                canEdit={canEditArticle}
                canApprove={canApprove}
              />
              {kitsError && <ErrorBanner message={`Could not read the kits: ${kitsError.message ?? "unknown error"}`} />}
              {gensError && <ErrorBanner message={`Could not read the kit's generations: ${gensError.message ?? "unknown error"}`} />}
              <KitPanel
                topicId={topic.id}
                topicStatus={topic.status}
                articleStatus={approvedArticle?.status ?? null}
                articleStatuses={articleStatuses}
                kits={kits}
                names={names}
                canGenerate={canGenerate}
                canApprove={canApprove}
                generateEnabled={catalogueGenerateEnabled()}
                ownerConfigured={catalogueOwnerId() !== null}
                migrationNote={kitMigrationNote}
              />
            </>
          )}
          <MappingPanel topic={topic} mappings={mappings} curricula={curricula} canCurate={canCurate} />
          <AliasPanel topicId={topic.id} aliases={aliases} canCurate={canCurate} />
          <PrereqPanel topicId={topic.id} prerequisites={prerequisites} dependants={dependants} canCurate={canCurate} />
        </div>
        <div className="space-y-5">
          <TopicActions topic={topic} canCurate={canCurate} canApprove={canApprove} />
          <div className="card p-5">
            <h2 className="font-medium mb-2">Pipeline</h2>
            <ol className="text-xs text-[#5B6470] space-y-1">
              {["candidate", "approved", "article_approved", "generating", "in_review", "video_approved", "published"].map((s) => (
                <li key={s} className={s === topic.status ? "text-[#14181F] font-medium" : ""}>
                  {s === topic.status ? "▸ " : "· "}
                  {s.replace(/_/g, " ")}
                </li>
              ))}
              {topic.status === "retired" && <li className="text-[#14181F] font-medium">▸ retired</li>}
            </ol>
            <p className="text-xs text-[#98A0A9] mt-3">
              Approving an article version moves the topic to article approved; Generate kit moves it to generating, the worker to in review once every
              piece is done, and Approve video (gate 2) to video approved. Publishing arrives with its phase.
            </p>
          </div>
          <div className="card p-5">
            <h2 className="font-medium mb-2">Audit trail</h2>
            {trail.length === 0 ? (
              <p className="text-sm text-[#98A0A9]">Nothing yet.</p>
            ) : (
              <ul className="text-xs text-[#5B6470] space-y-1.5">
                {trail.map((a, i) => (
                  <li key={i}>
                    <span className="font-mono">{a.action.replace(/^library_/, "")}</span> · {fmtDate(a.created_at)}
                    {a.detail && Object.keys(a.detail).length > 0 && (
                      <span className="block text-[#98A0A9] truncate" title={JSON.stringify(a.detail)}>
                        {JSON.stringify(a.detail).slice(0, 120)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
