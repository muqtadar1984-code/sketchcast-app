import Link from "next/link";
import { canOn } from "@/utils/books-access";
import { getChapter, listAnnotations, listApprovals, listArtifacts, listChapterSummaries, listFindings, listRuns } from "@/utils/books/store";
import { listReleases } from "@/utils/books/releases";
import { runnableStage } from "@/utils/books/stages";
import { anyLive, defaultChapter, latestPlan, stages, workChapters, type ApprovalLite, type ChapterRow, type RunLite } from "@/utils/books/workbench";
import type { ChapterRevision } from "@/utils/books/types";
import { loadBook, pickRevision } from "./load";
import { BlockView, ExerciseView, type FigureCtx } from "./blocks";
import Spine from "./workbench/spine";
import Changes, { type ChangeItem } from "./workbench/changes";
import Live from "./workbench/live";

// /books/[slug]?ch=N | ?view=book [&printed=1] — the book's single workbench (founder 2026-10-30, direction C):
// the stage spine on the left, the reader in the middle, the changes and the approval on the right. Everything
// technical (runs, logs, costs, files, history) is in Records, owner only.
export default async function Workbench({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { member, work, revisions } = await loadBook(slug);
  const rev = revisions.length ? pickRevision(work, revisions, undefined) : null;
  const [runs, approvals, summaries, findings, releases, annotations, artifacts] = await Promise.all([
    listRuns(work.uid),
    listApprovals(work.uid),
    listChapterSummaries(work.uid),
    listFindings(work.uid),
    listReleases(work.uid),
    listAnnotations(work.uid),
    listArtifacts(work.uid),
  ]);
  const rows: (ChapterRow & { source_path?: string | null })[] = rev ? summaries.filter((c) => c.revision_key === rev.key) : [];
  const runLite = runs as unknown as RunLite[];
  const aps = approvals as unknown as ApprovalLite[];
  const plan = latestPlan(runLite);
  const fallbackPlan = plan.length ? plan : Array.from({ length: work.facts?.chapters ?? 0 }, (_, i) => ({ chapter: i + 1, title: `Chapter ${i + 1}` }));
  const chapters = workChapters(fallbackPlan, rows, aps, runLite);
  const stageList = stages({
    chapters,
    runs: runLite,
    approvals: aps,
    releases,
    draftUsd: runnableStage("draft_chapter")?.measuredPerChapterUsd ?? 2.5,
    auditUsd: runnableStage("academic_audit")?.measuredPerChapterUsd ?? 0.58,
  });
  const bookView = sp.view === "book";
  const wanted = Number(sp.ch);
  const active = bookView ? null : Number.isInteger(wanted) && chapters.some((c) => c.chapter === wanted) ? wanted : defaultChapter(chapters);
  const printed = sp.printed === "1";

  const showRows = rev ? (bookView ? rows : rows.filter((r) => r.chapter === active)) : [];
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

  const items: ChangeItem[] = findings
    .filter((f) => f.status === "open" && (bookView || f.chapter === active) && (!rev || f.revision_key === rev.key))
    .map((f) => ({
      id: String(f.id),
      tone: f.severity === "P0" ? "must" : f.severity === "P1" ? "should" : "note",
      text: f.problem ?? f.quote ?? "Finding",
      where: bookView ? `Chapter ${f.chapter}` : f.location,
    }));
  const activeChapter = chapters.find((c) => c.chapter === active);
  const approval = activeRow
    ? aps.filter((a) => (a.kind === "gate_d" && a.chapter === activeRow.chapter && a.content_sha256 === activeRow.content_sha256) || (a.kind === "book" && a.revision_key === activeRow.revision_key)).pop()
    : undefined;
  const base = `/books/${slug}${bookView ? "?view=book" : `?ch=${active ?? ""}`}`;

  return (
    <div className="grid gap-5 lg:grid-cols-[11.5rem_minmax(0,1fr)_9rem]">
      <Live on={anyLive(runLite)} />
      <Spine
        slug={slug}
        title={work.title}
        stages={stageList}
        chapters={chapters}
        active={bookView ? "book" : active}
        canRun={canOn(member, work.uid, "run")}
        canApprove={canOn(member, work.uid, "approve")}
        isOwner={canOn(member, work.uid, "grant")}
      />

      <main className="min-w-0">
        <div className="mx-auto max-w-[44rem]">
          <div className="mb-3 flex items-center justify-between text-xs text-[#7A7363]">
            <span>{bookView ? "Whole book" : activeChapter ? `Chapter ${activeChapter.chapter}` : ""}</span>
            {printedArtifact && (
              <span className="flex gap-1">
                <Link href={base} className={`rounded-md px-2 py-0.5 ${printed ? "" : "bg-[#F4EEDF] text-[#1F2A24]"}`}>Reading</Link>
                <Link href={`${base}&printed=1`} className={`rounded-md px-2 py-0.5 ${printed ? "bg-[#F4EEDF] text-[#1F2A24]" : ""}`}>As printed</Link>
              </span>
            )}
          </div>

          {printed && printedArtifact ? (
            <iframe src={fileHref(printedArtifact.id)} title="As printed" className="h-[80vh] w-full rounded-lg border border-[#E4DCC8] bg-white" />
          ) : bodies.length === 0 ? (
            <div className="py-24 text-center text-[#7A7363]">
              <p className="font-display text-2xl text-[#1F2A24]">{activeChapter ? activeChapter.title : work.title}</p>
              <p className="mt-2 text-sm">{activeChapter?.state === "drafting" ? "Being drafted…" : "Not drafted yet."}</p>
            </div>
          ) : (
            bodies.map((c) => (
              <article key={c.chapter} className="pb-12">
                <p className="text-xs text-[#A39C8C]">{bookView ? `Chapter ${c.chapter}` : ""}</p>
                <h1 className="font-display text-[2rem] leading-tight text-[#1F2A24]">{c.title}</h1>
                {c.body.sections.map((s) => (
                  <section key={s.sid} className="mt-7 font-serif text-[17px] leading-[1.75]">
                    <h2 className="font-display text-xl text-[#1F2A24]">{s.heading}</h2>
                    {s.blocks.map((b, i) => (
                      <BlockView key={i} b={b} ctx={figCtx(c.chapter, c.body.figures ?? {})} />
                    ))}
                  </section>
                ))}
                {c.body.exercises?.length ? (
                  <section className="mt-9">
                    <h2 className="font-display text-xl text-[#1F2A24]">Practice</h2>
                    {c.body.exercises.map((x, i) => (
                      <ExerciseView key={x.xid} x={x} n={i + 1} ctx={figCtx(c.chapter, c.body.figures ?? {})} />
                    ))}
                  </section>
                ) : null}
              </article>
            ))
          )}
        </div>
      </main>

      <Changes
        slug={slug}
        chapter={activeRow?.chapter ?? null}
        rev={rev?.key ?? null}
        items={items}
        approved={activeChapter?.state === "approved"}
        approvedOn={approval?.approved_on ?? null}
        canApprove={canOn(member, work.uid, "approve")}
        bookView={bookView}
      />
    </div>
  );
}
