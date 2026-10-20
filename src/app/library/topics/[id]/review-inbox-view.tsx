import Link from "next/link";
import AutoRefresh from "@/components/auto-refresh";
import { kitProgress, type HeaderMapping } from "@/utils/catalogue/kit";
import { TOPIC_STATUSES } from "@/utils/catalogue/status";
import { KIT_TRANSLATOR_MIGRATION, filterQueueRows, flagCount, inboxHref, neighboursOf, precheckVerdict, timeInReview, type InboxParams, type QueueRow, type ReviewQueue } from "@/utils/catalogue/review-queue";
import { languageLabel } from "@/utils/narration";
import type { Curriculum, Topic, TopicAlias, TopicArticle, TopicHit } from "@/utils/catalogue/types";
import { ErrorBanner, KitStatusChip, MaturityChip, MissingTablesBanner, StatusChip, fmtDate } from "../../catalogue-ui";
import { AliasPanel, MappingPanel, PrereqPanel, TopicActions, TopicHeaderEditor, type MappingRow } from "./topic-panels";
import { ArticlePanel, type ArticleVersion, type JobRow } from "./article-panel";
import { KitPanel, VideoParts, type KitView } from "./kit-panel";
import { Findings, PrecheckLine, TranslationChip, TranslationsPanel, type TranslateJobRow } from "./translations-panel";
import type { TranslationClockData } from "@/utils/catalogue/translation-eta";
import { Drawer, InboxFilters, InboxPanes, QueueKeys, ReviewVerdict } from "./review-inbox";
import { TranslateSweepButton } from "./translate-sweep";

// The review inbox's layout (layout D, 2026-10-17) — a Server Component with
// no reads of its own: page.tsx loads the topic and hands everything over as
// props, and /preview/review-inbox (dev only) renders the same component on
// fixtures so the layout can be looked at without a library login. What the
// page shows and why is described at the top of page.tsx.
//
// Second round (founder, 2026-10-17, on the live page): the Topics tab opens
// this view; the left pane is as wide as the reviewer drags it (InboxPanes)
// and titles wrap instead of truncating; it carries filters (subject, kit
// language or topic status, search); the right pane has a shortcut bar —
// Prev / Next through the pane's list (j / k keys too) and jumps to Video,
// Review, Pieces, Translations; Pre-check findings, History and Topic
// details moved from folds at the bottom to buttons at the top (drawers,
// like the article); the greyed "not checked" chip is gone for an English
// kit, which the checks never apply to.

export type AuditRow = { action: string; detail: Record<string, unknown> | null; created_at: string; actor_id: string | null };
export type AllTopicRow = { id: string; title: string; subject: string | null; status: string; updated_at: string };

export type ReviewInboxProps = {
  topic: Topic;
  /** the view the URL asked for (parseInboxParams) */
  view: InboxParams;
  queue: ReviewQueue;
  /** the left pane's rows when view.queue is "all" (already filtered by the server) */
  allTopics: AllTopicRow[];
  /** every subject in the catalogue, for the left pane's filter */
  subjects: string[];
  /** re-fetch while a kit or an article is building */
  buildInFlight: boolean;
  openCandidates: number;
  // the article
  versions: ArticleVersion[];
  /** the approved English article (what a kit is generated from), and its status */
  approvedArticle: Pick<TopicArticle, "id" | "version"> | null;
  approvedArticleStatus: string | null;
  articleJob: JobRow | null;
  articleTablesMissing: boolean;
  articleError: string | null;
  articleMigration: string | null;
  figuresError: string | null;
  jobsError: string | null;
  /** every article version's status / number by id (kitAcceptsApprove, kitRegenerateSource) */
  articleStatuses: Record<string, string>;
  articleVersions: Record<string, number>;
  // the kits
  kits: KitView[];
  translationKits: KitView[];
  translateJobs: TranslateJobRow[];
  /** timing + lane for the clocks on a translation in flight; null when none is */
  translationClocks?: TranslationClockData | null;
  kitsError: string | null;
  gensError: string | null;
  publicationsError: string | null;
  kitMigrationNote: string | null;
  translationsMigration: string | null;
  curriculumHeader: string[];
  headerMappings: HeaderMapping[];
  // the topic's own details
  mappings: MappingRow[];
  aliases: TopicAlias[];
  prerequisites: TopicHit[];
  dependants: TopicHit[];
  curricula: Curriculum[];
  trail: AuditRow[];
  names: Record<string, string>;
  // the member's role (libraryAllows) and the deployment's switches
  canCurate: boolean;
  canApprove: boolean;
  canEditArticle: boolean;
  canGenerate: boolean;
  canPublish: boolean;
  auditPassed: boolean;
  /** the languages with a YouTube channel of their own; null = unknown */
  youtubeChannels?: string[] | null;
  generateEnabled: boolean;
  publishEnabled: boolean;
  ownerConfigured: boolean;
};

export function ReviewInboxView({
  topic,
  view,
  queue,
  allTopics,
  subjects,
  buildInFlight,
  openCandidates,
  versions,
  approvedArticle,
  approvedArticleStatus,
  articleJob,
  articleTablesMissing,
  articleError,
  articleMigration,
  figuresError,
  jobsError,
  articleStatuses,
  articleVersions,
  kits,
  translationKits,
  translateJobs,
  translationClocks = null,
  kitsError,
  gensError,
  publicationsError,
  kitMigrationNote,
  translationsMigration,
  curriculumHeader,
  headerMappings,
  mappings,
  aliases,
  prerequisites,
  dependants,
  curricula,
  trail,
  names,
  canCurate,
  canApprove,
  canEditArticle,
  canGenerate,
  canPublish,
  auditPassed,
  youtubeChannels = null,
  generateEnabled,
  publishEnabled,
  ownerConfigured,
}: ReviewInboxProps) {
  const id = topic.id;
  // The kit under review on the right: the English kit, or — with ?lang= —
  // that translation kit.
  const translationSubject = view.lang ? (translationKits.find((k) => k.kit.language === view.lang) ?? null) : null;
  const subject: { view: KitView; translation: boolean } | null = translationSubject
    ? { view: translationSubject, translation: true }
    : kits[0]
      ? { view: kits[0], translation: false }
      : null;
  const langMissing = view.lang && !translationSubject ? view.lang : null;
  const subjectVideos = subject
    ? subject.view.generations
        .filter((g) => g.gen.kind === "presentation" && (!subject.translation || g.gen.id === subject.view.kit.presentation_generation_id))
        .flatMap((g) => g.artifacts.filter((a) => a.kind === "video_mp4"))
        .sort((a, b) => a.part - b.part)
    : [];
  const subjectProgress = subject ? kitProgress(subject.view.generations.map((g) => g.gen)) : null;
  // Every link out of this page keeps the pane's mode and filters.
  const keep = { queue: view.queue, q: view.q, subject: view.subject, status: view.status, language: view.language };
  const href = (opts: { lang?: string | null; queue?: "review" | "all" } = {}) => inboxHref(id, { ...keep, lang: view.lang, ...opts });
  const reviewHrefs = Object.fromEntries(translationKits.map((k) => [k.kit.language, inboxHref(id, { ...keep, lang: k.kit.language })]));
  const personName = (pid: string | null) => (pid ? (names[pid] ?? pid.slice(0, 8)) : "—");
  const subjectKit = subject?.view.kit ?? null;
  const subjectFlags = flagCount(subjectKit?.precheck);
  const subjectBlocking = subjectKit?.precheck ? precheckVerdict(subjectKit.precheck).includes("blocking") : false;
  const selectedQueueKey = `${id}:${view.lang ?? "en"}`;
  const queueKey = (r: QueueRow) => `${r.topicId}:${r.translation ? r.language : "en"}`;
  const now = new Date();

  // The pane's list under its filters, and the selected row's neighbours —
  // what Prev / Next and j / k move to.
  const queueRows = filterQueueRows(queue.rows, view);
  const queueLanguages = [...new Set(queue.rows.map((r) => r.language))].sort().map((l) => ({ value: l, label: l === "en" ? "English" : (languageLabel(l) ?? l) }));
  const rowHref = (r: QueueRow) => inboxHref(r.topicId, { ...keep, lang: r.translation ? r.language : null });
  const topicHref = (t: AllTopicRow) => inboxHref(t.id, { ...keep, queue: "all" });
  const nav =
    view.queue === "review"
      ? (() => {
          const n = neighboursOf(queueRows, (r) => queueKey(r) === selectedQueueKey);
          return { prev: n.prev ? rowHref(n.prev) : null, next: n.next ? rowHref(n.next) : null, index: n.index, total: queueRows.length, prevTitle: n.prev?.title ?? null, nextTitle: n.next?.title ?? null };
        })()
      : (() => {
          const n = neighboursOf(allTopics, (t) => t.id === id);
          return { prev: n.prev ? topicHref(n.prev) : null, next: n.next ? topicHref(n.next) : null, index: n.index, total: allTopics.length, prevTitle: n.prev?.title ?? null, nextTitle: n.next?.title ?? null };
        })();

  const rowClass = (selected: boolean) => `block px-4 py-2.5 text-sm hover:bg-[#F8FAF7] ${selected ? "bg-[#EEF5F0] border-l-2 border-[#1F7A5A]" : "border-l-2 border-transparent"}`;

  const asidePane = (
    <>
      <div className="px-4 pt-4 pb-3 border-b border-[#EEF0EC]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">
            {view.queue === "review" ? "Review queue" : "Topics"}{" "}
            <span className="text-sm text-[#5B6470] font-normal" title={view.queue === "review" ? "Every kit a reviewer has not yet approved or rejected: English kits in review, and translations whose check and render are done" : "The newest sixty topics under the filters"}>
              ({view.queue === "review" ? queueRows.length : allTopics.length})
            </span>
          </h2>
          <span className="flex items-center gap-1 shrink-0">
            {/* the Kit Translator's sweep (D7): one language, the ready kits first */}
            {canGenerate && <TranslateSweepButton generateEnabled={generateEnabled} />}
            <Link href="/library/topics?view=list" className="text-xs text-[#1F5B99] hover:underline" title="The full topics list, with curriculum and article filters">
              Full list ↗
            </Link>
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1 text-xs">
          <Link href={href({ queue: "review" })} className={`rounded-md px-2 py-1 ${view.queue === "review" ? "bg-[#14241E] text-white" : "text-[#3F4752] hover:bg-[#F4F6F3]"}`} aria-current={view.queue === "review" ? "page" : undefined}>
            In review{queue.rows.length ? ` (${queue.rows.length})` : ""}
          </Link>
          <Link href={href({ queue: "all" })} className={`rounded-md px-2 py-1 ${view.queue === "all" ? "bg-[#14241E] text-white" : "text-[#3F4752] hover:bg-[#F4F6F3]"}`} aria-current={view.queue === "all" ? "page" : undefined}>
            Any topic
          </Link>
        </div>
        <InboxFilters topicId={id} view={view} subjects={subjects} languages={queueLanguages} statuses={TOPIC_STATUSES} />
      </div>
      <div className="overflow-y-auto min-h-0 grow">
        {queue.error && <p className="px-4 py-3 text-xs text-[#B3401F]">Could not read the queue: {queue.error}</p>}
        {queue.translationsMissing && <p className="px-4 py-2 text-xs text-[#9A6400]">Translations are not in the queue until {KIT_TRANSLATOR_MIGRATION} is applied.</p>}
        {view.queue === "review" ? (
          queueRows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[#3F4752]">{queue.rows.length ? "Nothing in the queue matches the filters." : "Nothing is waiting for review."}</p>
          ) : (
            <ul className="divide-y divide-[#EEF0EC]">
              {queueRows.map((r) => {
                const selected = queueKey(r) === selectedQueueKey;
                return (
                  <li key={r.kitId}>
                    <Link href={rowHref(r)} aria-current={selected ? "page" : undefined} className={rowClass(selected)}>
                      <span className="flex items-start justify-between gap-2">
                        <span className={`min-w-0 leading-snug line-clamp-2 ${selected ? "font-medium" : ""}`} title={r.title}>
                          {r.title}
                        </span>
                        <span className="chip bg-[#EEF0EC] text-[#3F4752] shrink-0 uppercase" title={r.translation ? `${languageLabel(r.language) ?? r.language} translation` : "English kit"}>
                          {r.language}
                        </span>
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#3F4752]">
                        {r.subject && <span>{r.subject}</span>}
                        <span title={`In review since ${fmtDate(r.since)}`}>{timeInReview(r.since, now)} in review</span>
                        {(r.flags > 0 || r.blocking > 0) && (
                          <span className={`chip ${r.blocking ? "bg-[#FFE9E3] text-[#B3401F]" : "bg-[#FFF1D6] text-[#9A6400]"}`} title="Pre-check findings (checks A and C)">
                            {r.blocking ? `${r.blocking} blocking` : `${r.flags} flag${r.flags === 1 ? "" : "s"}`}
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )
        ) : allTopics.length === 0 ? (
          <p className="px-4 py-6 text-sm text-[#3F4752]">{view.q || view.subject || view.status ? "No topic matches." : "No topics yet."}</p>
        ) : (
          <ul className="divide-y divide-[#EEF0EC]">
            {allTopics.map((t) => {
              const selected = t.id === id;
              return (
                <li key={t.id}>
                  <Link href={topicHref(t)} aria-current={selected ? "page" : undefined} className={rowClass(selected)}>
                    <span className={`block leading-snug line-clamp-2 ${selected ? "font-medium" : ""}`} title={t.title}>
                      {t.title}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#3F4752]">
                      <StatusChip status={t.status} />
                      {t.subject && <span>{t.subject}</span>}
                      <span className="ml-auto whitespace-nowrap">{fmtDate(t.updated_at)}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );

  return (
    <main className="max-w-[96rem] mx-auto px-4 sm:px-6 py-6">
      <AutoRefresh active={buildInFlight} />
      <QueueKeys prevHref={nav.prev} nextHref={nav.next} />
      <InboxPanes aside={asidePane}>
        {/* ── title, the doors (drawers), the explanation ── */}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-display min-w-0">{topic.title}</h1>
          <StatusChip status={topic.status} />
          <MaturityChip maturity={topic.bank_maturity} />
        </div>
        <div className="flex flex-wrap items-center gap-2 -mt-1">
          <Drawer
            title={`Article — ${topic.title}`}
            label={
              <>
                Article
                <span className="text-xs text-[#3F4752] font-normal">
                  {versions.length === 0 ? "none yet" : approvedArticle ? `approved v${approvedArticle.version}` : `${versions.length} version${versions.length === 1 ? "" : "s"}, none approved`}
                </span>
              </>
            }
          >
            {articleTablesMissing ? (
              <MissingTablesBanner table="topic_articles" />
            ) : articleError ? (
              <ErrorBanner message={`Could not read the article: ${articleError}`} />
            ) : (
              <div className="space-y-3">
                {articleMigration && <MissingTablesBanner table="article_figures.render_error" migration={articleMigration} />}
                {figuresError && <ErrorBanner message={`Could not read the figures: ${figuresError}`} />}
                {jobsError && <ErrorBanner message={`Could not read the article jobs: ${jobsError}`} />}
                <ArticlePanel topicId={topic.id} topicStatus={topic.status} versions={versions} articleJob={articleJob} names={names} canEdit={canEditArticle} canApprove={canApprove} />
              </div>
            )}
          </Drawer>
          <Link href={`/library/topics/${topic.id}/questions`} className="btn-ghost h-9 px-3 text-sm inline-flex items-center">
            Question bank
          </Link>
          <Drawer
            title={`Pre-check findings — ${subject?.translation ? (languageLabel(subjectKit?.language) ?? subjectKit?.language ?? "") : "English kit"}`}
            wide={false}
            label={
              <>
                Pre-check
                <span className={`text-xs font-normal ${subjectBlocking ? "text-[#B3401F]" : subjectFlags ? "text-[#9A6400]" : "text-[#3F4752]"}`}>
                  {subjectKit?.precheck ? `${subjectBlocking ? "blocking · " : ""}${subjectFlags} flag${subjectFlags === 1 ? "" : "s"}` : subject?.translation ? "not yet" : "n/a"}
                </span>
              </>
            }
          >
            {subjectKit?.precheck ? (
              <div className="space-y-3 text-sm">
                <PrecheckLine report={subjectKit.precheck} />
                <Findings report={subjectKit.precheck} open />
              </div>
            ) : (
              <p className="text-sm text-[#3F4752]">
                {subject?.translation
                  ? "Not checked yet — the worker writes check A when it translates and check C when it renders."
                  : "The English kit is not pre-checked: the checks compare a translation with its English. Open a translation from the queue or from Translations to read its findings."}
              </p>
            )}
          </Drawer>
          <Drawer
            title={`History — ${topic.title}`}
            wide={false}
            label={
              <>
                History<span className="text-xs text-[#3F4752] font-normal">{trail.length}</span>
              </>
            }
          >
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-[#3F4752]">Latest article job:</span>
                <JobSummaryLine job={articleJob} />
              </div>
              {trail.length === 0 ? (
                <p className="text-[#3F4752]">Nothing yet.</p>
              ) : (
                <ul className="text-xs text-[#3F4752] space-y-1.5">
                  {trail.map((a, i) => (
                    <li key={i}>
                      <span className="font-mono">{a.action.replace(/^library_/, "")}</span> · {fmtDate(a.created_at)}
                      {a.detail && Object.keys(a.detail).length > 0 && (
                        <span className="block text-[#5B6470] truncate" title={JSON.stringify(a.detail)}>
                          {JSON.stringify(a.detail).slice(0, 120)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Drawer>
          <Drawer
            title={`Topic details — ${topic.title}`}
            label={
              <>
                Topic details
                <span className="text-xs text-[#3F4752] font-normal">
                  {mappings.length} mapping{mappings.length === 1 ? "" : "s"} · {aliases.length} alias{aliases.length === 1 ? "" : "es"}
                </span>
              </>
            }
          >
            <div className="space-y-4">
              <TopicHeaderEditor topic={topic} canCurate={canCurate} />
              <TopicActions topic={topic} canCurate={canCurate} canApprove={canApprove} />
              <MappingPanel topic={topic} mappings={mappings} curricula={curricula} canCurate={canCurate} />
              <AliasPanel topicId={topic.id} aliases={aliases} canCurate={canCurate} />
              <PrereqPanel topicId={topic.id} prerequisites={prerequisites} dependants={dependants} canCurate={canCurate} />
            </div>
          </Drawer>
          <HowThisWorks topicStatus={topic.status} />
        </div>
        <p className="text-xs text-[#3F4752] -mt-2">
          {topic.subject ?? "No subject"} · key <span className="font-mono">{topic.canonical_key}</span> · created {fmtDate(topic.created_at)} · updated {fmtDate(topic.updated_at)}
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

        {/* ── shortcuts: through the list, and down the page ── */}
        <nav className="card px-3 py-2 flex flex-wrap items-center gap-2 text-sm lg:sticky lg:top-4 z-20" aria-label="Shortcuts">
          {nav.prev ? (
            <Link href={nav.prev} className="btn-ghost h-8 px-3 text-xs inline-flex items-center" title={`${nav.prevTitle ?? ""} (k)`}>
              ← Prev
            </Link>
          ) : (
            <span className="btn-ghost h-8 px-3 text-xs inline-flex items-center opacity-40" aria-disabled="true">
              ← Prev
            </span>
          )}
          {nav.next ? (
            <Link href={nav.next} className="btn-ghost h-8 px-3 text-xs inline-flex items-center" title={`${nav.nextTitle ?? ""} (j)`}>
              Next →
            </Link>
          ) : (
            <span className="btn-ghost h-8 px-3 text-xs inline-flex items-center opacity-40" aria-disabled="true">
              Next →
            </span>
          )}
          <span className="text-xs text-[#3F4752]" title="j / k (or ] / [) move through the list without touching the mouse">
            {nav.index >= 0 ? `${nav.index + 1} of ${nav.total}` : `not in the ${view.queue === "review" ? "queue" : "list"}`} · j / k
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-1 text-xs">
            <span className="text-[#3F4752] mr-1">Jump to</span>
            {[
              ["#video", "Video"],
              ["#review", "Review"],
              ["#pieces", "Pieces"],
              ["#translations", "Translations"],
            ].map(([anchor, label]) => (
              <a key={anchor} href={anchor} className="rounded-md px-2 py-1 text-[#1F5B99] hover:bg-[#F4F6F3]">
                {label}
              </a>
            ))}
          </span>
        </nav>

        {kitsError && <ErrorBanner message={`Could not read the kits: ${kitsError}`} />}
        {gensError && <ErrorBanner message={`Could not read the kit's generations: ${gensError}`} />}
        {publicationsError && <ErrorBanner message={`Could not read the publications: ${publicationsError}`} />}
        {langMissing && (
          <p className="text-xs text-[#9A6400] bg-[#FFF9EE] rounded-lg px-3 py-2">
            There is no {languageLabel(langMissing) ?? langMissing} translation of this topic — showing the English kit.{" "}
            <Link href={inboxHref(id, keep)} className="underline">
              Clear
            </Link>
          </p>
        )}

        {/* ── the kit under review: video, one status line, the verdict ── */}
        {subject && subjectKit && subjectProgress ? (
          <div id="video" className="card p-5 space-y-3 scroll-mt-20">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{subject.translation ? `${languageLabel(subjectKit.language) ?? subjectKit.language} translation` : "English kit"}</span>
              <KitStatusChip status={subjectKit.status} />
              {subject.translation && <TranslationChip status={subjectKit.translation_status} />}
              {subject.translation && (
                <span
                  className={`chip ${subjectKit.precheck ? (subjectBlocking ? "bg-[#FFE9E3] text-[#B3401F]" : "bg-[#E6F6F2] text-[#0F7A68]") : "bg-[#FFF1D6] text-[#9A6400]"}`}
                  title="Pre-check A compares the translation with the English before the render; check C looks at the rendered timing. The findings are behind the Pre-check button above."
                >
                  pre-check {precheckVerdict(subjectKit.precheck)}
                  {subjectKit.precheck ? ` · ${subjectFlags} flag${subjectFlags === 1 ? "" : "s"}` : ""}
                </span>
              )}
              <span className="text-xs text-[#3F4752]">
                {subjectKit.teacher_avatar ?? "—"} teacher · {subjectProgress.label} · {fmtDate(subjectKit.created_at)}
                {subjectKit.reviewed_at && (
                  <>
                    {" "}
                    · reviewed by {personName(subjectKit.reviewer_id)} {fmtDate(subjectKit.reviewed_at)}
                  </>
                )}
              </span>
            </div>
            {subjectKit.notes && (
              <p className="text-xs text-[#3F4752] whitespace-pre-wrap">
                <span className="font-medium">Review notes:</span> {subjectKit.notes}
              </p>
            )}
            {subjectVideos.length > 0 ? (
              <VideoParts kit={subjectKit} videos={subjectVideos} />
            ) : (
              <p className="text-sm text-[#3F4752] rounded-lg border border-dashed border-[#E6E8E4] px-4 py-8 text-center">
                {subjectKit.status === "generating" ? `No video yet — ${subjectProgress.label}. The worker builds the kit in its off-peak window.` : subjectKit.status === "failed" ? "A piece failed — open Pieces to retry it." : "No video for this kit."}
              </p>
            )}
            <div id="review" className="scroll-mt-20">
              <ReviewVerdict
                topicId={topic.id}
                topicStatus={topic.status}
                kit={subjectKit}
                translation={subject.translation}
                kitArticleStatus={articleStatuses[subjectKit.article_id] ?? null}
                canApprove={canApprove}
                publications={subject.view.publications}
                bankMaturity={topic.bank_maturity}
                canPublish={canPublish}
                publishEnabled={publishEnabled}
                auditPassed={auditPassed}
                youtubeChannels={youtubeChannels}
              />
            </div>
          </div>
        ) : (
          <div id="video" className="card p-5 text-sm text-[#3F4752] scroll-mt-20">
            No kit yet.{" "}
            {approvedArticle ? "Generate one from the approved article under Pieces below." : versions.length ? "Approve an article version first (open Article)." : "Write and approve an article first (open Article)."}
          </div>
        )}

        {/* ── folded: pieces, translations ── */}
        <Fold id="pieces" title="Pieces" hint={kits.length ? `${kits.length} build${kits.length === 1 ? "" : "s"} · ${subject && !subject.translation ? subjectProgress!.label : kitProgress(kits[0]?.generations.map((g) => g.gen) ?? []).label}` : "no kit yet"} open={!kits.length}>
          <KitPanel
            topicId={topic.id}
            topicTitle={topic.title}
            topicSummary={topic.summary}
            topicStatus={topic.status}
            bankMaturity={topic.bank_maturity}
            curriculumHeader={curriculumHeader}
            headerMappings={headerMappings}
            topicSubject={topic.subject}
            auditPassed={auditPassed}
            articleStatus={approvedArticleStatus}
            approvedArticle={approvedArticle}
            articleStatuses={articleStatuses}
            articleVersions={articleVersions}
            kits={kits}
            names={names}
            canGenerate={canGenerate}
            canApprove={canApprove}
            canPublish={canPublish}
            generateEnabled={generateEnabled}
            publishEnabled={publishEnabled}
            ownerConfigured={ownerConfigured}
            migrationNote={kitMigrationNote}
            hideVideos={!!subject && !subject.translation}
            hideReview={!!subject && !subject.translation}
          />
        </Fold>

        <Fold id="translations" title="Translations" hint={translationKits.length ? `${translationKits.length} language${translationKits.length === 1 ? "" : "s"}` : "none"} open={!!subject?.translation}>
          <TranslationsPanel
            topicId={topic.id}
            topicStatus={topic.status}
            canApprove={canApprove}
            sourceKit={kits.find((k) => k.kit.status === "approved")?.kit ?? null}
            translations={translationKits}
            jobs={translateJobs}
            clocks={translationClocks}
            topicSubject={topic.subject}
            names={names}
            canGenerate={canGenerate}
            generateEnabled={generateEnabled}
            migrationNote={translationsMigration ? `The translation columns (topic_kits.translation_status) are not in this database yet — apply ${translationsMigration}.` : null}
            selectedLanguage={subject?.translation ? (subjectKit?.language ?? null) : null}
            reviewHrefs={reviewHrefs}
            canPublish={canPublish}
            publishEnabled={publishEnabled}
            auditPassed={auditPassed}
            youtubeChannels={youtubeChannels}
            bankMaturity={topic.bank_maturity}
          />
        </Fold>
      </InboxPanes>
    </main>
  );
}

// ── Page furniture (server-rendered, no state) ──────────────────────────────

/** A folded section: a native <details> so its open state is the browser's
 *  (it survives the page's AutoRefresh) and the summary is one line. `id`
 *  is the shortcut bar's jump target. */
function Fold({ id, title, hint, open = false, children }: { id?: string; title: string; hint?: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details id={id} className="card group scroll-mt-20" open={open || undefined}>
      <summary className="cursor-pointer select-none px-5 py-3 flex items-center gap-3 list-none [&::-webkit-details-marker]:hidden">
        <span className="text-[#98A0A9] text-xs transition-transform group-open:rotate-90">▶</span>
        <span className="font-medium">{title}</span>
        {hint && <span className="text-xs text-[#3F4752] truncate">{hint}</span>}
      </summary>
      <div className="px-5 pb-5 border-t border-[#EEF0EC] pt-4">{children}</div>
    </details>
  );
}

/** The pipeline and the sentences the panels used to carry, behind one link. */
function HowThisWorks({ topicStatus }: { topicStatus: string }) {
  const steps = ["candidate", "approved", "article_approved", "generating", "in_review", "video_approved", "published"];
  return (
    <details className="relative">
      <summary className="btn-ghost h-9 px-3 text-sm cursor-pointer list-none inline-flex items-center [&::-webkit-details-marker]:hidden">How this works</summary>
      <div className="absolute right-0 top-11 z-30 w-[30rem] max-w-[90vw] card p-4 text-xs text-[#3F4752] space-y-3">
        <div>
          <p className="font-medium text-[#14181F] mb-1">Pipeline</p>
          <ol className="flex flex-wrap gap-x-2 gap-y-1">
            {steps.map((s, i) => (
              <li key={s} className={s === topicStatus ? "text-[#14181F] font-medium" : ""}>
                {i > 0 && <span className="text-[#C9CFC8] mr-2">→</span>}
                {s.replace(/_/g, " ")}
              </li>
            ))}
            {topicStatus === "retired" && <li className="text-[#14181F] font-medium">▸ retired</li>}
          </ol>
        </div>
        <p>
          <span className="font-medium text-[#14181F]">Moving about.</span> The left pane lists the review queue or any topic; drag its edge to widen it. Prev / Next (or the j / k keys) walk the list; Jump to scrolls to the video, the verdict, the pieces or the translations. Article, Pre-check, History and Topic details open as drawers over the page.
        </p>
        <p>
          <span className="font-medium text-[#14181F]">Article.</span> The knowledge article is the single source of truth: every kit is generated from an approved version. Approving a version moves the topic to article approved and is a named reviewer&apos;s act, recorded.
        </p>
        <p>
          <span className="font-medium text-[#14181F]">Kit.</span> The video lesson, slide deck, lesson plan, activities, case study and worksheet generated from the approved article. Generate kit moves the topic to generating; the worker builds it in its off-peak window (never while a teacher&apos;s lesson is queued) and moves it to in review once every piece is done — the lesson plan follows the video, because it cites the clips.
        </p>
        <p>
          <span className="font-medium text-[#14181F]">Review (gate 2).</span> Watch every part and open every document. Approve video records your name and moves the topic to video approved; rejecting needs a reason (it steers the regeneration) and notes. Nothing reaches YouTube before it.
        </p>
        <p>
          <span className="font-medium text-[#14181F]">Translations.</span> The same lesson in another language: the English kit&apos;s words are translated and its scene plan re-rendered with new voices — the pictures, the figures and the maths stay as they are. Pre-check A compares the translation with the English before the render; check C looks at the rendered timing. A reviewer approves each translation on its own; the English kit and the topic are not touched. An approved translation posts to YouTube from its row.
        </p>
        <p>
          <span className="font-medium text-[#14181F]">Publish.</span> A platform admin&apos;s action on an approved kit, switched off until the YouTube channel exists and its API project has passed the compliance audit.
        </p>
      </div>
    </details>
  );
}

/** The latest observer job in one line (status, progress, error). */
function JobSummaryLine({ job }: { job: JobRow | null }) {
  if (!job) return <span className="text-xs text-[#3F4752]">none yet</span>;
  return (
    <span className="text-xs text-[#3F4752]">
      {job.status}
      {job.status === "processing" && job.progress != null ? ` ${Math.round(job.progress)}%` : ""} · {fmtDate(job.created_at)}
      {job.error && (
        <span className="text-[#B3401F] ml-1 max-w-md truncate inline-block align-bottom" title={job.error}>
          {job.error}
        </span>
      )}
    </span>
  );
}
