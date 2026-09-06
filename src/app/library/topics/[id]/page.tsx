import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { ARTICLE_JOBS_MIGRATION, catalogueColumnMissing, catalogueMissing } from "@/utils/catalogue/status";
import type { ArticleFigure, Curriculum, Topic, TopicAlias, TopicArticle, TopicHit } from "@/utils/catalogue/types";
import { ErrorBanner, MaturityChip, MissingTablesBanner, StatusChip, fmtDate } from "../../catalogue-ui";
import { AliasPanel, MappingPanel, PrereqPanel, TopicActions, TopicHeaderEditor, type MappingRow } from "./topic-panels";
import { ArticlePanel, type ArticleVersion, type JobRow } from "./article-panel";

// /library/topics/[id] — one topic: header (editable), status actions, aliases,
// curriculum mappings with the depth-node selector, prerequisites, the
// knowledge article (versions, editor, figures, review, diff — Phase 2b) and
// the audit trail. Kit review and publish panels arrive with their phases.

export const dynamic = "force-dynamic";

/** Figure previews: the worker's visual_assets live in the PRIVATE bucket;
 *  the page signs each asset's path once, for an hour (visual-library.ts). */
const FIGURE_SIGN_TTL_SECONDS = 3600;
const ARTICLE_LANGUAGE = "en";

const ARTICLE_COLUMNS =
  "id, topic_id, version, language, source_article_id, title, objectives, sections, glossary, misconceptions, worked_examples, claims, depth_node_id, depth_rationale, word_count, status, author, reviewer_id, reviewed_at, approved_by, notes, created_at, updated_at";
const FIGURE_COLUMNS = "id, article_id, figure_key, caption, spec, visual_asset_id, labels, sort, status, created_at";
const JOB_COLUMNS = "id, status, progress, stage, error, created_at, params";

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
  // Reviewer / approver names for the version list (profiles carries no e-mail).
  const personIds = [...new Set(articles.flatMap((a) => [a.reviewer_id, a.approved_by]).filter((v): v is string => !!v))];
  const names: Record<string, string> = {};
  if (personIds.length) {
    const { data: people } = await admin.from("profiles").select("id, full_name").in("id", personIds);
    for (const p of (people ?? []) as { id: string; full_name: string | null }[]) if (p.full_name) names[p.id] = p.full_name;
  }
  const canEditArticle = libraryAllows(member.role, "edit_article");

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
        Created {fmtDate(topic.created_at)} · updated {fmtDate(topic.updated_at)}
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
              Approving an article version moves the topic to article approved. Kit and publish steps arrive with their phases.
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
