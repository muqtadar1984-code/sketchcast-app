import Link from "next/link";
import { canOn } from "@/utils/books-access";
import { getChapter, listAnnotations, listApprovals, listArtifacts, listChapterSummaries, listFindings, listRuns } from "@/utils/books/store";
import { listReleases } from "@/utils/books/releases";
import { runnableStage } from "@/utils/books/stages";
import { anyLive, defaultChapter, latestPlan, nextStep, stages, workChapters, type ApprovalLite, type ChapterRow, type RunLite } from "@/utils/books/workbench";
import type { ChapterRevision } from "@/utils/books/types";
import { loadBook, pickRevision } from "./load";
import { BlockView, ExerciseView, type FigureCtx } from "./blocks";
import Spine from "./workbench/spine";
import Changes, { type ChangeItem } from "./workbench/changes";
import Live from "./workbench/live";
import Selection from "./workbench/selection";
import { listEdits } from "@/utils/books/edits";
import { frontChangedAt, frontMatter } from "@/utils/books/front-matter";
import Front from "./workbench/front";
import ChapterBar from "./workbench/chapters";
import ActionButton from "./workbench/action";

export const dynamic = "force-dynamic";

// /books/[slug]?ch=N | ?view=book [&printed=1] — the book's single workbench (founder 2026-10-30, direction C):
// the stage spine on the left, the reader in the middle, the changes and the approval on the right. Everything
// technical (runs, logs, costs, files, history) is in Records, owner only.
export default async function Workbench({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { member, work, revisions } = await loadBook(slug);
  const rev = revisions.length ? pickRevision(work, revisions, undefined) : null;
  const [runs, approvals, summaries, findings, releases, annotations, artifacts, edits] = await Promise.all([
    listRuns(work.uid),
    listApprovals(work.uid),
    listChapterSummaries(work.uid),
    listFindings(work.uid),
    listReleases(work.uid),
    listAnnotations(work.uid),
    listArtifacts(work.uid),
    listEdits(work.uid),
  ]);
  const rows: (ChapterRow & { source_path?: string | null })[] = rev ? summaries.filter((c) => c.revision_key === rev.key) : [];
  const runLite = runs as unknown as RunLite[];
  const aps = approvals as unknown as ApprovalLite[];
  const plan = latestPlan(runLite);
  const fallbackPlan = plan.length ? plan : Array.from({ length: work.facts?.chapters ?? 0 }, (_, i) => ({ chapter: i + 1, title: `Chapter ${i + 1}` }));
  const chapters = workChapters(fallbackPlan, rows, aps, runLite, summaries as unknown as ChapterRow[]);
  const stageList = stages({
    chapters,
    runs: runLite,
    approvals: aps,
    releases,
    draftUsd: runnableStage("draft_chapter")?.measuredPerChapterUsd ?? 2.5,
    auditUsd: runnableStage("academic_audit")?.measuredPerChapterUsd ?? 0.58,
    frontChangedAt: frontChangedAt(edits),
    planKnown: plan.length > 0 || (work.facts?.chapters ?? 0) > 0,
  });
  const next = nextStep(stageList);
  const frontView = sp.view === "front";
  const bookView = sp.view === "book" || frontView;
  const wanted = Number(sp.ch);
  const active = bookView ? null : Number.isInteger(wanted) && chapters.some((c) => c.chapter === wanted) ? wanted : defaultChapter(chapters);
  const printed = sp.printed === "1";

  const showRows = rev && !frontView ? (bookView ? rows : rows.filter((r) => r.chapter === active)) : [];
  const bodies = (await Promise.all(showRows.map((r) => getChapter(work.uid, rev!.key, r.chapter)))).filter(Boolean) as ChapterRevision[];
  const figCtx = (n: number, figures: FigureCtx["figures"]): FigureCtx => ({
    src: (ref) => `/api/pub/figure?book=${encodeURIComponent(slug)}&rev=${encodeURIComponent(rev?.key ?? "")}&ch=${n}&ref=${encodeURIComponent(ref)}`,
    figures,
    annotations: new Map(annotations.map((a) => [a.figure_ref, a.body])),
  });

  // "As printed": the chapter's own laid-out PDF (its run folder), or the latest compile for the whole book
  const folder = (r?: { source_path?: string | null }) => (r?.source_path ?? "").split("/").slice(0, -1).join("/");
  const activeRow = rows.find((r) => r.chapter === active);
  const compile = runs.filter((r) => r.stage_key === "compile_book" && r.status === "done").sort((a, b) => b.id - a.id)[0];
  const printedRel = bookView
    ? compile && `runs/run-${compile.id}/${(compile.detail?.summary as { pdf?: string } | undefined)?.pdf ?? ""}`
    : activeRow && folder(activeRow) && `${folder(activeRow)}/ch${String(active).padStart(2, "0")}.pdf`;
  const printedArtifact = printedRel ? artifacts.find((a) => a.rel_path === printedRel) : undefined;
  const fileHref = (id: number) => `/api/pub/file?book=${encodeURIComponent(slug)}&id=${id}`;

  const chapterEdits = edits.filter((e) => !bookView && e.chapter === active && (e.status === "accepted" || e.status === "open"));
  const editItems: ChangeItem[] = chapterEdits.map((e) => e.kind === "image" ? {
    id: `e${e.id}`,
    tone: "edit",
    text: e.meta?.caption ? `New picture: ${e.meta.caption}` : "New picture",
    before: null,
    where: bodies[0]?.body.figures?.[e.unit ?? ""]?.caption ?? null,
    thumb: `/api/pub/edits/image?book=${encodeURIComponent(slug)}&id=${e.id}`,
    editId: e.id,
    decide: "rejected",
  } : {
    id: `e${e.id}`,
    tone: e.kind === "note" ? "note" : "edit",
    text: e.kind === "note" ? (e.instruction ?? "") : (e.after_text ?? ""),
    before: e.kind === "note" ? null : e.before_text,
    where: e.kind === "note" ? `“${(e.before_text ?? "").slice(0, 60)}”` : e.kind === "reword" && e.instruction ? `AI · ${e.instruction}` : null,
    editId: e.id,
    decide: e.kind === "note" ? "resolved" : "rejected",
  });
  const toApply = chapterEdits.filter((e) => e.status === "accepted" && e.revision_key === rev?.key).length;
  const findingItems: ChangeItem[] = findings
    .filter((f) => f.status === "open" && (bookView || f.chapter === active) && (!rev || f.revision_key === rev.key))
    .map((f) => ({
      id: String(f.id),
      tone: f.severity === "P0" ? "must" : f.severity === "P1" ? "should" : "note",
      text: f.problem ?? f.quote ?? "Finding",
      where: bookView ? `Chapter ${f.chapter}` : f.location,
    }));
  const pieces = frontView ? await frontMatter(slug, runs, artifacts, edits) : [];
  const frontItems: ChangeItem[] = pieces
    .filter((p) => p.edit && p.text !== p.printed)
    .map((p) => ({ id: `f${p.edit!.id}`, tone: "edit", text: p.label, where: `${p.edit!.by} · prints at the next compile`, editId: p.edit!.id, decide: "rejected" }));
  const items = frontView ? frontItems : [...editItems, ...findingItems];
  const activeChapter = chapters.find((c) => c.chapter === active);
  const approval = activeRow
    ? aps.filter((a) => (a.kind === "gate_d" && a.chapter === activeRow.chapter && a.content_sha256 === activeRow.content_sha256) || (a.kind === "book" && summaries.some((t) => t.revision_key === a.revision_key && t.chapter === activeRow.chapter && t.content_sha256 === activeRow.content_sha256))).pop()
    : undefined;
  const base = `/books/${slug}${bookView ? "?view=book" : `?ch=${active ?? ""}`}`;

  return (
    <div className="grid gap-5 lg:grid-cols-[11.5rem_minmax(0,1fr)_9rem]">
      <Live on={anyLive(runLite)} />
      <Spine
        slug={slug}
        title={work.title}
        stages={stageList}
        next={next}
        approved={chapters.filter((c) => c.state === "approved").length}
        total={chapters.length}
        active={frontView ? "front" : bookView ? "book" : active}
        canRun={canOn(member, work.uid, "run")}
        canApprove={canOn(member, work.uid, "approve")}
        isOwner={canOn(member, work.uid, "grant")}
      />

      <main className="min-w-0">
        <div className="mx-auto max-w-[44rem]">
          <div className="mb-3 flex items-center justify-between text-xs text-[#7A7363]">
            <ChapterBar slug={slug} chapters={chapters} active={active} view={frontView ? "front" : bookView ? "book" : "chapter"} />
            {printedArtifact && !frontView && (
              <span className="flex gap-1">
                <Link href={base} className={`rounded-md px-2 py-0.5 ${printed ? "" : "bg-[#F4EEDF] text-[#1F2A24]"}`}>Reading</Link>
                <Link href={`${base}&printed=1`} className={`rounded-md px-2 py-0.5 ${printed ? "bg-[#F4EEDF] text-[#1F2A24]" : ""}`}>As printed</Link>
              </span>
            )}
          </div>

          {frontView ? (
            <Front slug={slug} pieces={pieces} canEdit={canOn(member, work.uid, "edit")} />
          ) : printed && printedArtifact ? (
            <iframe src={fileHref(printedArtifact.id)} title="As printed" className="h-[80vh] w-full rounded-lg border border-[#E4DCC8] bg-white" />
          ) : bodies.length === 0 ? (
            <div className="py-24 text-center text-[#7A7363]">
              <p className="font-display text-2xl text-[#1F2A24]">{activeChapter ? activeChapter.title : work.title}</p>
              <p className="mt-2 text-sm">{activeChapter?.state === "drafting" ? "Being drafted…" : "Not drafted yet."}</p>
              {activeChapter?.state === "not_drafted" && next?.action?.kind === "run" && next.action.stage === "draft_chapter" && (
                next.action.params.chapter === activeChapter.chapter ? (
                  <div className="mt-5">
                    <ActionButton slug={slug} action={next.action} allowed={canOn(member, work.uid, "run")} />
                  </div>
                ) : (
                  <p className="mt-2 text-xs">Chapters are drafted in order: chapter {next.action.params.chapter} is next.</p>
                )
              )}
            </div>
          ) : !bookView && activeRow && rev && canOn(member, work.uid, "edit") ? (
            <Selection slug={slug} chapter={activeRow.chapter} rev={rev.key}>
              {renderBodies()}
            </Selection>
          ) : (
            renderBodies()
          )}
        </div>
      </main>
      <Changes
        slug={slug}
        chapter={activeRow?.chapter ?? null}
        rev={rev?.key ?? null}
        items={items}
        toApply={toApply}
        approved={activeChapter?.state === "approved"}
        approvedOn={approval?.approved_on ?? null}
        canApprove={canOn(member, work.uid, "approve")}
        canEdit={canOn(member, work.uid, "edit")}
        bookView={bookView}
      />
    </div>
  );

  function renderBodies() {
    return bodies.map((c) => (
              <article key={c.chapter} className="pb-12">
                <p className="text-xs text-[#A39C8C]">{bookView ? `Chapter ${c.chapter}` : ""}</p>
                <h1 className="font-display text-[2rem] leading-tight text-[#1F2A24]">{c.title}</h1>
                {c.body.sections.map((s) => (
                  <section key={s.sid} className="mt-7 font-serif text-[17px] leading-[1.75]">
                    <h2 className="font-display text-xl text-[#1F2A24]">{s.heading}</h2>
                    {s.blocks.map((b, i) => (
                      <div key={i} data-unit={`${s.sid}.b${i}`}>
                        <BlockView b={b} ctx={figCtx(c.chapter, c.body.figures ?? {})} />
                      </div>
                    ))}
                  </section>
                ))}
                {c.body.exercises?.length ? (
                  <section className="mt-9">
                    <h2 className="font-display text-xl text-[#1F2A24]">Practice</h2>
                    {c.body.exercises.map((x, i) => (
                      <div key={x.xid} data-unit={x.xid}>
                        <ExerciseView x={x} n={i + 1} ctx={figCtx(c.chapter, c.body.figures ?? {})} />
                      </div>
                    ))}
                  </section>
                ) : null}
              </article>
    ));
  }
}
