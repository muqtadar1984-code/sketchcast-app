import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { catalogueGenerateEnabled, catalogueOwnerId } from "@/utils/flags";
import { InkUnderline } from "@/components/ink-mark";
import { catalogueMissing } from "@/utils/catalogue/status";
import {
  ITEM_TYPES,
  ITEM_TYPE_LABEL,
  MATURITY_LADDER,
  QUESTION_STATUSES,
  applyQuestionFilters,
  duplicateGroups,
  nextRung,
  objectiveCoverage,
  parseQuestionFilters,
  type Blueprint,
  type QuestionSet,
  type TopicQuestion,
} from "@/utils/catalogue/questions";
import type { Topic } from "@/utils/catalogue/types";
import { docDownloadName } from "@/utils/download-name";
import { ErrorBanner, MaturityChip, MissingTablesBanner, ReadOnlyNote, StatusChip } from "../../../catalogue-ui";
import { QuestionsPanel, type ArticleRefsView, type JobRow, type SetView } from "./questions-panel";

// /library/topics/[id]/questions — one topic's question bank (Phase 3, spec
// decision 8): the maturity badge and the next rung, coverage per article
// objective, the items with filters (type / difficulty / status in the URL),
// inline editing and per-item review, Generate / Regenerate rejected, and the
// composer (blueprint + seed → a rendered worksheet) with the past sets. Reads
// with the service role; the panel decides what to render from the member's
// role and every control POSTs a route that re-checks it.

export const dynamic = "force-dynamic";

const LANGUAGE = "en";
/** Signed download links into the private `artifacts` bucket last an hour. */
const SIGN_TTL_SECONDS = 3600;
/** Items shown per topic — a bank past this is exam_ready five times over. */
const ITEM_LIMIT = 1000;
const SET_LIMIT = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUESTION_COLUMNS =
  "id, topic_id, article_id, objective_ref, claim_ref, language, source_question_id, item_type, answer_mode, difficulty, cognitive_level, marks, est_seconds, stem, options, distractor_rationale, answer, marking_scheme, explanation, tags, content_hash, status, reviewer_id, reviewed_at, notes, created_at, updated_at";
const BLUEPRINT_COLUMNS = "id, name, scope, curriculum_id, spec, min_maturity, status, created_by, created_at";
const SET_COLUMNS = "id, blueprint_id, topic_ids, language, question_ids, seed, rendered_generation_id, requested_by, created_at";
const JOB_COLUMNS = "id, status, progress, stage, error, created_at";

type GenRow = { id: string; status: string; created_at: string; artifacts: { kind: string; storage_path: string }[] | null };
type GenJob = { generation_id: string; status: string; progress: number | null; stage: unknown; error: string | null; created_at: string };

export default async function TopicQuestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const member = await requireLibraryMember();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const filters = parseQuestionFilters(await searchParams);
  const canEdit = libraryAllows(member.role, "edit_article");
  const canApprove = libraryAllows(member.role, "approve");
  // Generate / Regenerate rejected / Compose spend model calls and build
  // capacity: `generate`, the action the routes ask for (edit_article is the
  // items themselves). Today the same roles hold both.
  const canGenerate = libraryAllows(member.role, "generate");
  const admin = createAdminClient();

  const { data: topicRow, error: tErr } = await admin.from("topics").select("id, title, status, bank_maturity, subject").eq("id", id).maybeSingle();
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
  const topic = topicRow as unknown as Pick<Topic, "id" | "title" | "status" | "bank_maturity" | "subject">;

  const [artQ, itemsQ, jobQ, bpQ, setsQ] = await Promise.all([
    admin.from("topic_articles").select("id, version, objectives, claims, misconceptions").eq("topic_id", id).eq("language", LANGUAGE).eq("status", "approved").maybeSingle(),
    admin.from("topic_questions").select(QUESTION_COLUMNS).eq("topic_id", id).eq("language", LANGUAGE).order("created_at", { ascending: true }).limit(ITEM_LIMIT),
    admin
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("type", "topic_questions")
      .eq("params->>topic_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("question_set_blueprints").select(BLUEPRINT_COLUMNS).order("name"),
    admin.from("question_sets").select(SET_COLUMNS).contains("topic_ids", [id]).order("created_at", { ascending: false }).limit(SET_LIMIT),
  ]);
  const readError = itemsQ.error ?? artQ.error ?? bpQ.error ?? setsQ.error ?? null;
  if (catalogueMissing(readError)) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <MissingTablesBanner table="topic_questions" />
      </main>
    );
  }

  const items = (itemsQ.data ?? []) as unknown as TopicQuestion[];
  const rawArticle = artQ.data as { id: string; version: number; objectives: unknown; claims: unknown; misconceptions: unknown } | null;
  const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  // The approved article's RENDERED, labelled figures — what a diagram_label
  // edit is checked against in the browser (the worker's labelled_figures;
  // the route checks the item's own article version).
  const figQ = rawArticle ? await admin.from("article_figures").select("figure_key, caption, labels").eq("article_id", rawArticle.id).eq("status", "rendered") : { data: [], error: null };
  const figures = ((figQ.data ?? []) as { figure_key: string; caption: string | null; labels: unknown }[])
    .map((f) => ({
      figure_key: String(f.figure_key ?? ""),
      caption: f.caption ?? null,
      labels: list<{ label?: unknown }>(f.labels)
        .map((lb) => (lb && typeof lb === "object" && typeof lb.label === "string" ? lb.label.trim() : ""))
        .filter(Boolean),
    }))
    .filter((f) => f.figure_key && f.labels.length > 0);
  const article: ArticleRefsView | null = rawArticle
    ? {
        id: rawArticle.id,
        version: rawArticle.version,
        objectives: list<{ id: string; text: string }>(rawArticle.objectives).map((o) => ({ id: String(o?.id ?? ""), text: String(o?.text ?? "") })),
        claims: list<{ id: string; text: string }>(rawArticle.claims).map((c) => ({ id: String(c?.id ?? ""), text: String(c?.text ?? "") })),
        misconceptions: list<{ id: string; misconception: string; correction: string }>(rawArticle.misconceptions).map((m) => ({
          id: String(m?.id ?? ""),
          misconception: String(m?.misconception ?? ""),
          correction: String(m?.correction ?? ""),
        })),
        figures,
      }
    : null;
  const blueprints = (bpQ.data ?? []) as unknown as Blueprint[];
  const blueprintName = new Map(blueprints.map((b) => [b.id, b.name]));
  const setRows = (setsQ.data ?? []) as unknown as QuestionSet[];

  // The rendered generations behind the sets: status, the worker's job (for
  // progress / error) and signed links to the DOCX and its answer key.
  const genIds = setRows.map((s) => s.rendered_generation_id).filter((g): g is string => !!g);
  const [gensQ, genJobsQ] = genIds.length
    ? await Promise.all([
        admin.from("generations").select("id, status, created_at, artifacts(kind, storage_path)").in("id", genIds),
        admin.from("jobs").select("generation_id, status, progress, stage, error, created_at").in("generation_id", genIds).order("created_at", { ascending: false }),
      ])
    : [
        { data: [] as GenRow[], error: null },
        { data: [] as GenJob[], error: null },
      ];
  const gens = new Map(((gensQ.data ?? []) as unknown as GenRow[]).map((g) => [g.id, g]));
  const genJob = new Map<string, GenJob>();
  for (const j of (genJobsQ.data ?? []) as GenJob[]) if (!genJob.has(j.generation_id)) genJob.set(j.generation_id, j); // newest first
  const sign = async (path: string | null | undefined, download?: string): Promise<string | null> => {
    if (!path) return null;
    const { data } = await admin.storage.from("artifacts").createSignedUrl(path, SIGN_TTL_SECONDS, download ? { download } : undefined);
    return data?.signedUrl ?? null;
  };
  const sets: SetView[] = await Promise.all(
    setRows.map(async (s) => {
      const g = s.rendered_generation_id ? gens.get(s.rendered_generation_id) : undefined;
      const j = s.rendered_generation_id ? genJob.get(s.rendered_generation_id) : undefined;
      const artifacts = g?.artifacts ?? [];
      const docx = artifacts.find((a) => a.kind === "docx")?.storage_path ?? null;
      const key = artifacts.find((a) => a.kind === "answer_key_docx")?.storage_path ?? null;
      return {
        ...s,
        blueprintName: blueprintName.get(s.blueprint_id) ?? "Blueprint",
        generation: g ? { id: g.id, status: g.status, error: j?.error ?? null, created_at: g.created_at, progress: j?.progress ?? null, stage: j?.stage ?? null } : null,
        // The download names are what a teacher's Downloads folder should say,
        // never the storage basename (download-name.ts).
        docx: await sign(docx, docDownloadName("worksheet", "docx")),
        answerKey: await sign(key, docDownloadName("worksheet", "answer_key_docx")),
      };
    }),
  );

  // Reviewer names for the table and the sets (profiles carries no e-mail).
  const personIds = [...new Set([...items.map((q) => q.reviewer_id), ...setRows.map((s) => s.requested_by)].filter((v): v is string => !!v))];
  const names: Record<string, string> = {};
  if (personIds.length) {
    const { data: people } = await admin.from("profiles").select("id, full_name").in("id", personIds);
    for (const p of (people ?? []) as { id: string; full_name: string | null }[]) if (p.full_name) names[p.id] = p.full_name;
  }

  const approvedCount = items.filter((q) => q.status === "approved").length;
  const rung = nextRung(approvedCount);
  const coverage = article ? objectiveCoverage(items, article.objectives) : [];
  const duplicates = duplicateGroups(items);
  const visible = applyQuestionFilters(items, filters);
  const byStatus = { draft: 0, approved: 0, rejected: 0, retired: 0 } as Record<string, number>;
  for (const q of items) byStatus[q.status] = (byStatus[q.status] ?? 0) + 1;

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <p className="mb-4 text-sm">
        <Link href={`/library/topics/${topic.id}`} className="text-[#5B6470] hover:underline">
          ← {topic.title}
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-3 mb-1">
        <h1 className="text-3xl font-display">Question bank</h1>
        <StatusChip status={topic.status} />
        <MaturityChip maturity={topic.bank_maturity} />
      </div>
      <InkUnderline className="block h-3 w-40 mb-3" color="#7FD8A8" />
      <p className="text-sm text-[#5B6470] mb-6">
        {approvedCount} approved · {byStatus.draft ?? 0} draft · {byStatus.rejected ?? 0} rejected · {byStatus.retired ?? 0} retired
        {rung.next ? (
          <>
            {" "}
            · next rung <span className="font-medium">{rung.next.replace(/_/g, " ")}</span>: {rung.needed} more approved item{rung.needed === 1 ? "" : "s"}
          </>
        ) : (
          <> · the bank is exam ready</>
        )}
        {article && (
          <>
            {" "}
            · from article v{article.version}
          </>
        )}
        {duplicates.length > 0 && <> · {duplicates.length} possible duplicate group{duplicates.length === 1 ? "" : "s"}</>}
      </p>
      {!canEdit && <ReadOnlyNote what="editing and composing" />}
      {readError && !catalogueMissing(readError) && <ErrorBanner message={`Could not read the bank: ${readError.message}`} />}
      {jobQ.error && <ErrorBanner message={`Could not read the question jobs: ${jobQ.error.message}`} />}
      {(gensQ.error || genJobsQ.error) && <ErrorBanner message={`Could not read the rendered sets: ${(gensQ.error ?? genJobsQ.error)?.message}`} />}

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-5">
          <form method="get" className="card p-4 grid gap-3 sm:grid-cols-4 text-sm">
            <select name="type" defaultValue={filters.type} className="field h-9 px-2" aria-label="Item type">
              <option value="">Any type</option>
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ITEM_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <select name="difficulty" defaultValue={filters.difficulty || ""} className="field h-9 px-2" aria-label="Difficulty">
              <option value="">Any difficulty</option>
              {[1, 2, 3, 4, 5].map((d) => (
                <option key={d} value={d}>
                  difficulty {d}
                </option>
              ))}
            </select>
            <select name="status" defaultValue={filters.status} className="field h-9 px-2" aria-label="Status">
              <option value="">Any status</option>
              {QUESTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className="flex items-center gap-2">
              <button type="submit" className="btn-primary h-9 px-4">
                Filter
              </button>
              {(filters.type || filters.difficulty || filters.status) && (
                <Link href={`/library/topics/${topic.id}/questions`} className="text-xs text-[#5B6470] underline">
                  clear
                </Link>
              )}
            </span>
          </form>

          <QuestionsPanel
            topicId={topic.id}
            maturity={topic.bank_maturity}
            article={article}
            items={items}
            visible={visible}
            duplicates={duplicates}
            job={(jobQ.data ?? null) as JobRow | null}
            blueprints={blueprints}
            sets={sets}
            names={names}
            canEdit={canEdit}
            canGenerate={canGenerate}
            canApprove={canApprove}
            generateOn={catalogueGenerateEnabled()}
            ownerConfigured={catalogueOwnerId() !== null}
          />
        </div>

        <div className="space-y-5">
          <div className="card p-5">
            <h2 className="font-medium mb-2">Coverage by objective</h2>
            {!article ? (
              <p className="text-sm text-[#98A0A9]">No approved article yet — the objectives come from it.</p>
            ) : coverage.length === 0 ? (
              <p className="text-sm text-[#98A0A9]">The article lists no objectives.</p>
            ) : (
              <ul className="space-y-2">
                {coverage.map((row) => {
                  const pct = row.total ? Math.round((row.approved / row.total) * 100) : 0;
                  const thin = row.id !== null && row.total < 2;
                  return (
                    <li key={row.id ?? "none"} className="text-xs">
                      <span className="flex items-center justify-between gap-2">
                        <span className={`truncate ${row.id === null ? "text-[#B3401F]" : ""}`} title={row.text}>
                          {row.id ? <span className="font-mono text-[#98A0A9]">{row.id} </span> : null}
                          {row.text}
                        </span>
                        <span className={`tabular whitespace-nowrap ${thin ? "text-[#9A6400]" : "text-[#5B6470]"}`} title={thin ? "Fewer than two live items — the next generate tops this objective up" : undefined}>
                          {row.approved}/{row.total}
                          {row.draft ? ` (${row.draft} draft)` : ""}
                        </span>
                      </span>
                      <span className="block h-1.5 rounded-full bg-[#EEF0EC] overflow-hidden mt-1" aria-hidden>
                        <span className="block h-full bg-[#7FD8A8]" style={{ width: `${pct}%` }} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-[#98A0A9] mt-3">approved / live items per objective; a thin objective (under two) is topped up by the next generate.</p>
          </div>
          <div className="card p-5">
            <h2 className="font-medium mb-2">Maturity ladder</h2>
            <ol className="text-xs text-[#5B6470] space-y-1">
              {MATURITY_LADDER.map(({ rung: r, min }) => {
                const here = r === rung.current;
                return (
                  <li key={r} className={here ? "text-[#14181F] font-medium" : ""}>
                    {here ? "▸ " : "· "}
                    {r.replace(/_/g, " ")} <span className="text-[#98A0A9]">({min}+ approved)</span>
                  </li>
                );
              })}
            </ol>
            <p className="text-xs text-[#98A0A9] mt-3">Counted from approved English items by a database trigger; blueprints name the rung they need.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
